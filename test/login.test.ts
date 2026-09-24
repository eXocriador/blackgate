import { describe, it, expect } from 'vitest';
import { createHealth } from '@exo/kit/health';
import { parseCatalog } from '../src/catalog/index.js';
import type { CallResult } from '../src/upstream/gateway.js';
import { createUpstreamHealth, isLoginFailure, withUpstream } from '../src/upstream/login.js';

const catalog = parseCatalog(`
version: 1
pools:
  hot:  { upstream: a, probe: a1 }
  cold: { upstream: b, probe: b1 }
  far:  { upstream: c, probe: c1 }
models:
  - { id: a1, pool: hot }
  - { id: a2, pool: hot }
  - { id: b1, pool: cold }
  - { id: c1, pool: far }
tiers:
  fast: [a1, b1, c1]
`);

function r(partial: Partial<CallResult>): CallResult {
  return {
    outcome: 'ok', content: 'x', httpStatus: 200, latencyMs: 5, retryAfterMs: null, error: null,
    unreachable: false, usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    ...partial,
  };
}

/** Дослівні тіла зі шлюзу: `ai_call` 2/736/1173 і прямий запит з невірним ключем 2026-09-24. */
const authUnavailable = r({
  outcome: 'error', httpStatus: 500, content: null,
  error: '{"error":{"message":"auth_unavailable: no auth available","type":"server_error"}}',
});
const invalidKey = r({ outcome: 'unauthorized', httpStatus: 401, content: null, error: '{"error":"Invalid API key"}' });
const noCapacity = r({ outcome: 'error', httpStatus: 503, content: null, error: 'No capacity available for model gemini-2.5-flash' });
const exhausted = r({ outcome: 'exhausted', httpStatus: 429, content: null, error: 'RESOURCE_EXHAUSTED' });
const timeout = r({ outcome: 'timeout', httpStatus: null, content: null, error: 'The operation was aborted due to timeout' });
const refused = r({ outcome: 'error', httpStatus: null, content: null, unreachable: true, error: 'fetch failed (ECONNREFUSED)' });

function build(windowMs = 900_000) {
  let t = 1_000_000;
  const events: Array<[string, Record<string, unknown> | undefined]> = [];
  const up = createUpstreamHealth({
    catalog: () => catalog,
    windowMs,
    now: () => t,
    logInfo: (e, f) => events.push([e, f]),
    logWarn: (e, f) => events.push([e, f]),
  });
  return { up, events, advance: (ms: number) => { t += ms; } };
}

describe('ознаки відмови входу', () => {
  it('auth_unavailable 500 і 401/403 — вхід; решта — ні', () => {
    expect(isLoginFailure(authUnavailable)).toBe(true);
    expect(isLoginFailure(invalidKey)).toBe(true);
    expect(isLoginFailure(r({ outcome: 'unauthorized', httpStatus: 403 }))).toBe(true);
    expect(isLoginFailure(noCapacity)).toBe(false);
    expect(isLoginFailure(exhausted)).toBe(false);
    expect(isLoginFailure(timeout)).toBe(false);
  });
});

describe('стан входу апстріму', () => {
  it('до першої відповіді — unknown, і це не вирок', () => {
    const { up } = build();
    expect(up.status().state).toBe('unknown');
  });

  it('відповідь моделі — ok', () => {
    const { up } = build();
    up.observe('a1', r({}));
    expect(up.status().state).toBe('ok');
  });

  /**
   * Усі три рядки `auth_unavailable` в історії `ai_call` — одна модель, поки
   * сусіди відповідали. Це штраф моделі, не протухлий вхід.
   */
  it('відмова входу в ОДНОМУ пулі — не вирок', () => {
    const { up } = build();
    up.observe('a1', r({}));
    up.observe('a1', authUnavailable);
    up.observe('a2', authUnavailable); // той самий пул — усе ще один
    expect(up.status().state).toBe('ok');
  });

  it('відмова входу в кількох пулах — expired, з причиною і що робити', () => {
    const { up, events } = build();
    up.observe('a1', authUnavailable);
    up.observe('b1', authUnavailable);
    const s = up.status();
    expect(s.state).toBe('expired');
    expect(s.detail).toContain('hot/a1');
    expect(s.detail).toContain('cold/b1');
    expect(s.detail).toContain('VibeConduit');
    expect(events.some(([e, f]) => e === 'upstream.state' && f?.to === 'expired')).toBe(true);
  });

  it('невірний ключ до шлюзу (401 на всіх пулах) — expired', () => {
    const { up } = build();
    for (const m of ['a1', 'b1', 'c1']) up.observe(m, invalidKey);
    expect(up.status().state).toBe('expired');
  });

  it('перша ж справжня відповідь після відмови повертає ok', () => {
    const { up } = build();
    up.observe('a1', invalidKey);
    up.observe('b1', invalidKey);
    expect(up.status().state).toBe('expired');
    up.observe('c1', r({}));
    expect(up.status().state).toBe('ok');
  });

  it('відповідь моделі між двома відмовами розриває ланцюжок', () => {
    const { up } = build();
    up.observe('a1', authUnavailable);
    up.observe('c1', r({}));
    up.observe('b1', authUnavailable);
    expect(up.status().state).toBe('ok');
  });

  it('429 — не вирок, і він доводить, що вхід живий', () => {
    const { up } = build();
    for (const m of ['a1', 'b1', 'c1']) up.observe(m, exhausted);
    expect(up.status().state).toBe('ok');
    up.observe('a1', invalidKey);
    up.observe('b1', exhausted);
    up.observe('c1', invalidKey);
    // a1 стерто 429 з b1; лишився лише c1.
    expect(up.status().state).toBe('ok');
  });

  it('503 «No capacity» у всіх пулах — стан моделей, не входу', () => {
    const { up } = build();
    for (const m of ['a1', 'b1', 'c1']) up.observe(m, noCapacity);
    expect(up.status().state).toBe('ok');
  });

  it('стара відмова одного пулу не складається зі свіжою іншого', () => {
    const { up, advance } = build(60_000);
    up.observe('a1', authUnavailable);
    advance(61_000);
    up.observe('b1', authUnavailable);
    expect(up.status().state).toBe('ok');
  });

  it('вирок спливає сам, коли доказів більше немає', () => {
    const { up, advance } = build(60_000);
    up.observe('a1', authUnavailable);
    up.observe('b1', authUnavailable);
    expect(up.status().state).toBe('expired');
    advance(61_000);
    expect(up.status().state).toBe('ok');
  });

  it('відмова з\'єднання — down; таймаут його не знімає і сам не ставить', () => {
    const { up } = build();
    up.observe('a1', r({}));
    up.observe('a1', timeout);
    expect(up.status().state).toBe('ok');
    up.observe('b1', refused);
    expect(up.status().state).toBe('down');
    expect(up.status().detail).toContain('ECONNREFUSED');
    up.observe('a1', timeout);
    expect(up.status().state).toBe('down');
    up.observe('a1', noCapacity); // будь-яка відповідь з кодом — шлюз досяжний
    expect(up.status().state).toBe('ok');
  });

  it('модель, якої немає в реєстрі, про вхід не свідчить', () => {
    const { up } = build();
    up.observe('ghost', authUnavailable);
    up.observe('b1', authUnavailable);
    expect(up.status().state).toBe('ok');
  });
});

describe('/health/ready з checks.upstream', () => {
  const infra = (ok: boolean) =>
    createHealth({ version: 't', checks: { pools: () => ok }, required: ['pools'] });

  it('ok → 200 і checks.upstream = ok', async () => {
    const { up } = build();
    up.observe('a1', r({}));
    const res = await withUpstream(infra(true), up).ready();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; checks: Record<string, string> };
    expect(body.status).toBe('ok');
    expect(body.checks).toEqual({ pools: 'ok', upstream: 'ok' });
  });

  it('expired → 503, хоч пули й придатні', async () => {
    const { up } = build();
    up.observe('a1', invalidKey);
    up.observe('b1', invalidKey);
    const res = await withUpstream(infra(true), up).ready();
    expect(res.status).toBe(503);
    const body = (await res.json()) as { status: string; checks: Record<string, string>; upstream: { detail: string } };
    expect(body.status).toBe('fail');
    expect(body.checks.upstream).toBe('expired');
    expect(body.checks.pools).toBe('ok');
    expect(body.upstream.detail).toContain('401');
  });

  it('down → 503', async () => {
    const { up } = build();
    up.observe('a1', refused);
    expect((await withUpstream(infra(true), up).ready()).status).toBe(503);
  });

  it('unknown на старті не валить пробу; впалі перевірки kit валять і далі', async () => {
    const { up } = build();
    expect((await withUpstream(infra(true), up).ready()).status).toBe(200);
    expect((await withUpstream(infra(false), up).ready()).status).toBe(503);
  });

  it('live не чіпає апстрім', async () => {
    const { up } = build();
    up.observe('a1', refused);
    expect((await withUpstream(infra(true), up).live()).status).toBe(200);
  });
});
