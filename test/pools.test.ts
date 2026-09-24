import { describe, it, expect } from 'vitest';
import { parseCatalog } from '../src/catalog/index.js';
import { createPoolHealth } from '../src/pools/health.js';
import type { CallResult, Gateway } from '../src/upstream/gateway.js';

const catalog = parseCatalog(`
version: 1
pools:
  hot:  { upstream: a, probe: a1 }
  cold: { upstream: b, probe: b1 }
models:
  - { id: a1, pool: hot }
  - { id: b1, pool: cold }
tiers:
  fast: [a1, b1]
`);

function gatewayOf(byModel: Record<string, Partial<CallResult>>): Gateway {
  return {
    async call(req) {
      return {
        outcome: 'ok', content: 'x', httpStatus: 200, latencyMs: 5, retryAfterMs: null, error: null,
        unreachable: false,
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        ...(byModel[req.model] ?? {}),
      } as CallResult;
    },
    async listModels() { return null; },
  };
}

describe('здоров\'я пулів', () => {
  it('пул, якого ще не пробували, придатний — невідомість не є смертю', () => {
    const h = createPoolHealth({ gateway: gatewayOf({}), catalog: () => catalog });
    expect(h.usable('hot')).toBe(true);
  });

  it('обхід позначає вичерпаний пул, лишаючи здоровий здоровим', async () => {
    const h = createPoolHealth({
      gateway: gatewayOf({ a1: { outcome: 'exhausted', httpStatus: 429 } }),
      catalog: () => catalog,
    });
    await h.sweep();
    expect(h.usable('hot')).toBe(false);
    expect(h.usable('cold')).toBe(true);
    const snap = Object.fromEntries(h.snapshot().map((p) => [p.pool, p.state]));
    expect(snap).toEqual({ hot: 'exhausted', cold: 'healthy' });
  });

  it('після охолодження пул знову придатний', async () => {
    let t = 1_000_000;
    const h = createPoolHealth({
      gateway: gatewayOf({ a1: { outcome: 'exhausted', httpStatus: 429 } }),
      catalog: () => catalog, cooldownMs: 60_000, now: () => t,
    });
    await h.sweep();
    expect(h.usable('hot')).toBe(false);
    t += 59_000;
    expect(h.usable('hot')).toBe(false);
    t += 2_000;
    expect(h.usable('hot')).toBe(true);
  });

  it('retry-after апстріму важливіший за власне охолодження', () => {
    let t = 0;
    const h = createPoolHealth({ gateway: gatewayOf({}), catalog: () => catalog, cooldownMs: 600_000, now: () => t });
    h.observe('hot', 'exhausted', 5_000);
    t = 6_000;
    expect(h.usable('hot')).toBe(true);
  });

  it('400 і підроблений 200 — властивості МОДЕЛІ, пулу не чіпають', () => {
    const h = createPoolHealth({ gateway: gatewayOf({}), catalog: () => catalog });
    h.observe('hot', 'rejected', null);
    h.observe('hot', 'retired', null);
    expect(h.usable('hot')).toBe(true);
    expect(h.snapshot().find((p) => p.pool === 'hot')!.state).toBe('unknown');
  });

  /**
   * Проба, що стала надгробком, НЕ має права оголосити пул здоровим: сусіди по
   * пулу можуть працювати. Вона оголошує невідомість і просить замінити себе.
   */
  it('проба, що віддає підроблений 200, лишає пул у стані unknown', async () => {
    const h = createPoolHealth({
      gateway: gatewayOf({ a1: { outcome: 'retired', content: null } }),
      catalog: () => catalog,
    });
    await h.sweep();
    const hot = h.snapshot().find((p) => p.pool === 'hot')!;
    expect(hot.state).toBe('unknown');
    expect(hot.detail).toContain('заміни probe');
    expect(h.usable('hot')).toBe(true);
  });

  /**
   * Спостереження 2026-09-13: у пулі `gemini-lite` три моделі віддали 500/503
   * (`auth_unavailable`, «No capacity available for model …»), а три інші —
   * 200, в один і той самий момент. Проба, що оголосила б такий пул мертвим,
   * забрала б у драбини три робочі сходинки.
   */
  it('5xx від однієї моделі НЕ вбиває пул — це стан моделі', async () => {
    const h = createPoolHealth({
      gateway: gatewayOf({ a1: { outcome: 'error', httpStatus: 503, content: null } }),
      catalog: () => catalog,
    });
    await h.sweep();
    const hot = h.snapshot().find((p) => p.pool === 'hot')!;
    expect(hot.state).toBe('unknown');
    expect(h.usable('hot')).toBe(true);
    // …але сама модель іде в штрафний ящик.
    expect(h.modelUsable('a1')).toBe(false);
  });

  it('недосяжний шлюз (відмова з\'єднання) — це вже down', async () => {
    const h = createPoolHealth({
      gateway: gatewayOf({ a1: { outcome: 'error', httpStatus: null, content: null, unreachable: true, error: 'fetch failed (ECONNREFUSED)' } }),
      catalog: () => catalog,
    });
    await h.sweep();
    const hot = h.snapshot().find((p) => p.pool === 'hot')!;
    expect(hot.state).toBe('down');
    expect(hot.detail).toContain('ECONNREFUSED');
    expect(h.usable('hot')).toBe(false);
    // Шлюз — не провина моделі: після його повернення сходинка має бути доступна.
    expect(h.modelUsable('a1')).toBe(true);
  });

  /**
   * 2026-09-23 14:35Z: проба `gemini-premium` не встигла за 15 с — і весь пул
   * став `down` з «шлюз недосяжний: timeout», хоч три інші пули в ту саму
   * хвилину відповідали через той самий шлюз.
   */
  it('таймаут проби — стан МОДЕЛІ: пул живий, модель у штрафному ящику', async () => {
    const h = createPoolHealth({
      gateway: gatewayOf({ a1: { outcome: 'timeout', httpStatus: null, content: null, latencyMs: 15_000 } }),
      catalog: () => catalog,
    });
    await h.sweep();
    const hot = h.snapshot().find((p) => p.pool === 'hot')!;
    expect(hot.state).toBe('unknown');
    expect(hot.detail).toContain('не відповіла за 15000 мс');
    expect(h.usable('hot')).toBe(true);
    expect(h.modelUsable('a1')).toBe(false);
  });

  it('недосяжний шлюз у живому запиті не карає модель', () => {
    const h = createPoolHealth({ gateway: gatewayOf({}), catalog: () => catalog });
    h.observeModel('a1', 'error', null);
    expect(h.modelUsable('a1')).toBe(true);
    h.observeModel('a1', 'timeout', null);
    expect(h.modelUsable('a1')).toBe(false);
  });

  it('штрафний ящик відпускає модель після охолодження, і успіх знімає штраф', () => {
    let t = 0;
    const h = createPoolHealth({ gateway: gatewayOf({}), catalog: () => catalog, cooldownMs: 1000, now: () => t });
    h.observeModel('a1', 'error', 503);
    expect(h.modelUsable('a1')).toBe(false);
    t = 1001;
    expect(h.modelUsable('a1')).toBe(true);

    h.observeModel('a1', 'error', 503);
    expect(h.modelUsable('a1')).toBe(false);
    h.observeModel('a1', 'ok', 200);
    expect(h.modelUsable('a1')).toBe(true);
  });

  it('429 карає пул, а не модель: сусіди по пулу не в штрафному ящику', () => {
    const h = createPoolHealth({ gateway: gatewayOf({}), catalog: () => catalog });
    h.observe('hot', 'exhausted', null);
    h.observeModel('a1', 'exhausted', 429);
    expect(h.usable('hot')).toBe(false);
    expect(h.modelUsable('a1')).toBe(true);
  });

  it('спостереження з живого запиту діє одразу, не чекаючи обходу', () => {
    const h = createPoolHealth({ gateway: gatewayOf({}), catalog: () => catalog });
    h.observe('hot', 'exhausted', null);
    expect(h.usable('hot')).toBe(false);
    h.observe('hot', 'ok', null);
    expect(h.usable('hot')).toBe(true);
  });
});
