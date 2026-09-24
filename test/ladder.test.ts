import { describe, it, expect } from 'vitest';
import { parseCatalog } from '../src/catalog/index.js';
import { createPoolHealth } from '../src/pools/health.js';
import { createLadder, UnknownTierError } from '../src/ladder/run.js';
import type { CallRequest, CallResult, Gateway } from '../src/upstream/gateway.js';

const catalog = parseCatalog(`
version: 1
pools:
  hot:  { upstream: a, probe: a1 }
  cold: { upstream: b, probe: b1 }
  far:  { upstream: c, probe: c1 }
models:
  - { id: a1, pool: hot,  timeout_ms: 1000 }
  - { id: b1, pool: cold, timeout_ms: 1000 }
  - { id: c1, pool: far,  timeout_ms: 1000 }
tiers:
  fast: [a1, b1, c1]
`);

function gatewayOf(plan: Record<string, Partial<CallResult>[]>): { gw: Gateway; seen: string[] } {
  const seen: string[] = [];
  const cursor: Record<string, number> = {};
  const gw: Gateway = {
    async call(req: CallRequest): Promise<CallResult> {
      seen.push(req.model);
      const steps = plan[req.model] ?? [{ outcome: 'ok', content: 'hi' }];
      const i = Math.min(cursor[req.model] ?? 0, steps.length - 1);
      cursor[req.model] = (cursor[req.model] ?? 0) + 1;
      return {
        outcome: 'ok', content: null, httpStatus: 200, latencyMs: 1,
        retryAfterMs: null, error: null, unreachable: false,
        usage: { promptTokens: null, completionTokens: null, totalTokens: null },
        ...steps[i],
      } as CallResult;
    },
    async listModels() { return null; },
  };
  return { gw, seen };
}

function build(gw: Gateway, retries = 0) {
  const pools = createPoolHealth({ gateway: gw, catalog: () => catalog });
  const ladder = createLadder({ gateway: gw, pools, retries, sleep: async () => {} });
  return { ladder, pools };
}

const req = { tier: 'fast', messages: [{ role: 'user' as const, content: 'hi' }], maxTokens: 10, temperature: 0 };

describe('драбина', () => {
  it('основна відповіла — далі не йде', async () => {
    const { gw, seen } = gatewayOf({ a1: [{ outcome: 'ok', content: 'перша' }] });
    const { ladder } = build(gw);
    const r = await ladder.run(catalog, req);
    expect(r.ok).toBe(true);
    expect(r.model).toBe('a1');
    expect(r.rung).toBe(0);
    expect(seen).toEqual(['a1']);
  });

  /** Ядро: 429 на основній не має гасити запит. */
  it('429 на основній → відповідає наступний ПУЛ', async () => {
    const { gw, seen } = gatewayOf({
      a1: [{ outcome: 'exhausted', httpStatus: 429 }],
      b1: [{ outcome: 'ok', content: 'друга' }],
    });
    const { ladder } = build(gw);
    const r = await ladder.run(catalog, req);
    expect(r.ok).toBe(true);
    expect(r.content).toBe('друга');
    expect(r.pool).toBe('cold');
    expect(seen).toEqual(['a1', 'b1']);
  });

  it('429 не ретраїться тією самою моделлю', async () => {
    const { gw, seen } = gatewayOf({
      a1: [{ outcome: 'exhausted', httpStatus: 429 }],
      b1: [{ outcome: 'ok', content: 'друга' }],
    });
    const { ladder } = build(gw, 3);
    await ladder.run(catalog, req);
    expect(seen.filter((m) => m === 'a1')).toHaveLength(1);
  });

  it('400 INVALID_ARGUMENT не ретраїться і не зупиняє драбину', async () => {
    const { gw, seen } = gatewayOf({
      a1: [{ outcome: 'rejected', httpStatus: 400 }],
      b1: [{ outcome: 'ok', content: 'друга' }],
    });
    const { ladder } = build(gw, 3);
    const r = await ladder.run(catalog, req);
    expect(r.ok).toBe(true);
    expect(seen).toEqual(['a1', 'b1']);
  });

  it('5xx ретраїться тією самою моделлю, і вдала спроба лишається на своїй сходинці', async () => {
    const { gw, seen } = gatewayOf({
      a1: [{ outcome: 'error', httpStatus: 500 }, { outcome: 'ok', content: 'із другої спроби' }],
    });
    const { ladder } = build(gw, 2);
    const r = await ladder.run(catalog, req);
    expect(r.ok).toBe(true);
    expect(r.rung).toBe(0);
    expect(seen).toEqual(['a1', 'a1']);
    expect(r.attempts[0]!.tries).toBe(2);
  });

  it('таймаут ретраїться, далі — наступна сходинка', async () => {
    const { gw, seen } = gatewayOf({
      a1: [{ outcome: 'timeout' }],
      b1: [{ outcome: 'ok', content: 'друга' }],
    });
    const { ladder } = build(gw, 1);
    await ladder.run(catalog, req);
    expect(seen).toEqual(['a1', 'a1', 'b1']);
  });

  it('підроблений 200 не приймається за відповідь — драбина йде далі', async () => {
    const { gw } = gatewayOf({
      a1: [{ outcome: 'retired', content: null }],
      b1: [{ outcome: 'ok', content: 'справжня' }],
    });
    const { ladder } = build(gw);
    const r = await ladder.run(catalog, req);
    expect(r.content).toBe('справжня');
    expect(r.model).toBe('b1');
  });

  it('усі сходинки впали → ok:false, і кожна спроба видима у звіті', async () => {
    const { gw } = gatewayOf({
      a1: [{ outcome: 'exhausted', httpStatus: 429 }],
      b1: [{ outcome: 'exhausted', httpStatus: 429 }],
      c1: [{ outcome: 'exhausted', httpStatus: 429 }],
    });
    const { ladder } = build(gw);
    const r = await ladder.run(catalog, req);
    expect(r.ok).toBe(false);
    expect(r.attempts.map((a) => a.model)).toEqual(['a1', 'b1', 'c1']);
    expect(r.attempts.every((a) => a.outcome === 'exhausted')).toBe(true);
  });

  /**
   * Заради чого існує проба пулів: другий запит НЕ платить власним 429 за те,
   * що перший уже з'ясував.
   */
  it('відомо мертвий пул пропускається без запиту', async () => {
    const { gw, seen } = gatewayOf({
      a1: [{ outcome: 'exhausted', httpStatus: 429 }],
      b1: [{ outcome: 'ok', content: 'друга' }],
    });
    const { ladder } = build(gw);
    await ladder.run(catalog, req);
    seen.length = 0;

    const second = await ladder.run(catalog, req);
    expect(seen).toEqual(['b1']);              // до a1 більше не ходили
    expect(second.attempts[0]!.outcome).toBe('skipped');
    expect(second.ok).toBe(true);
  });

  it('мертва модель пропускається, хоч її пул живий', async () => {
    // Точний зліпок 2026-09-13: у пулі `gemini-lite` частина моделей віддавала
    // 5xx, частина — 200, одночасно. Драбина мусить оминути мертву СХОДИНКУ,
    // не викреслюючи її пул.
    //
    // (Фікстура тут триступенева навмисно: інваріант реєстру не дав би
    // покласти дві сходинки одного пулу поруч — що він і зробив, коли перша
    // версія цього тесту спробувала.)
    const { gw, seen } = gatewayOf({
      a1: [{ outcome: 'exhausted', httpStatus: 429 }],
      b1: [{ outcome: 'error', httpStatus: 503 }],
      c1: [{ outcome: 'ok', content: 'третя' }],
    });
    const { ladder, pools } = build(gw, 0);
    const first = await ladder.run(catalog, req);
    expect(first.content).toBe('третя');
    expect(pools.usable('cold')).toBe(true);      // пул живий…
    expect(pools.modelUsable('b1')).toBe(false);  // …а модель у ящику

    seen.length = 0;
    const second = await ladder.run(catalog, req);
    expect(seen).toEqual(['c1']);
    expect(second.attempts[0]!.detail).toContain('пул відомо вичерпаний');
    expect(second.attempts[1]!.detail).toContain('штрафному ящику');
    expect(second.ok).toBe(true);
  });

  it('невідомий тир — помилка з переліком відомих', async () => {
    const { gw } = gatewayOf({});
    const { ladder } = build(gw);
    await expect(ladder.run(catalog, { ...req, tier: 'nema' })).rejects.toThrow(UnknownTierError);
  });

  it('порожня відповідь моделі — це відповідь, а не привід сповзати', async () => {
    const { gw, seen } = gatewayOf({ a1: [{ outcome: 'ok', content: null }] });
    const { ladder } = build(gw);
    const r = await ladder.run(catalog, req);
    expect(r.ok).toBe(true);
    expect(r.content).toBeNull();
    expect(seen).toEqual(['a1']);
  });

  it('одночасні запити не змішують відповідей', async () => {
    // Сторож проти спільного стану в замиканні: `lastContent` колись був саме
    // таким, і два клієнти обмінялися б відповідями.
    const gw: Gateway = {
      async call(r: CallRequest): Promise<CallResult> {
        const who = r.messages[0]!.content;
        await new Promise((res) => setTimeout(res, who === 'A' ? 20 : 1));
        return {
          outcome: 'ok', content: `відповідь ${who}`, httpStatus: 200, latencyMs: 1,
          retryAfterMs: null, error: null,
          unreachable: false,
          usage: { promptTokens: null, completionTokens: null, totalTokens: null },
        };
      },
      async listModels() { return null; },
    };
    const { ladder } = build(gw);
    const [a, b] = await Promise.all([
      ladder.run(catalog, { ...req, messages: [{ role: 'user', content: 'A' }] }),
      ladder.run(catalog, { ...req, messages: [{ role: 'user', content: 'B' }] }),
    ]);
    expect(a.content).toBe('відповідь A');
    expect(b.content).toBe('відповідь B');
  });
});
