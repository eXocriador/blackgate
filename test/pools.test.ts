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

  it('спостереження з живого запиту діє одразу, не чекаючи обходу', () => {
    const h = createPoolHealth({ gateway: gatewayOf({}), catalog: () => catalog });
    h.observe('hot', 'exhausted', null);
    expect(h.usable('hot')).toBe(false);
    h.observe('hot', 'ok', null);
    expect(h.usable('hot')).toBe(true);
  });
});
