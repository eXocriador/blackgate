import { describe, it, expect, afterEach } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { parseCatalog } from '../src/catalog/index.js';
import { createPoolHealth } from '../src/pools/health.js';
import { createLadder } from '../src/ladder/run.js';
import { parseProductKeys } from '../src/http/auth.js';
import { createHttpServer } from '../src/http/server.js';
import type { Budget } from '../src/accounting/budget.js';
import type { JournalEntry } from '../src/journal/journal.js';
import type { CallResult, Gateway } from '../src/upstream/gateway.js';
import { parseStub, routeFor, StubConfigError, EMPTY_STUB, type StubConfig } from '../src/stub/config.js';
import { findSchema, instanceOf } from '../src/stub/schema-json.js';
import {
  answerFor, createStub, readScenario, StubScenarioError, STUB_FALLBACK, STUB_PRIMARY,
  type StubRequest,
} from '../src/stub/run.js';

const noSleep = async () => {};

describe('stub.yaml', () => {
  it('порожній файл — вимкнено, як і відсутній', () => {
    expect(parseStub('')).toEqual(EMPTY_STUB);
  });

  it('друкарська помилка в ключі — відмова, а не тихо вимкнена заглушка', () => {
    expect(() => parseStub('version: 1\nroutes:\n  - { product: exopost, mod: always }')).toThrow(StubConfigError);
    expect(() => parseStub('version: 1\nroutes:\n  - { product: exopost, mode: sometimes }')).toThrow(StubConfigError);
  });

  it('маршрут: продукт, точний гаманець, префікс, перший виграє', () => {
    const cfg = parseStub(`
version: 1
routes:
  - { product: teamself, subject: sandbox, mode: always }
  - { product: teamself, subject: "teamself:user:42", mode: fallback }
  - { product: exointel, subject: "exointel:user:*", mode: always }
  - { product: exopost, mode: always }
`);
    expect(routeFor(cfg, 'teamself', 'sandbox')?.mode).toBe('always');
    expect(routeFor(cfg, 'teamself', 'teamself:user:42')?.mode).toBe('fallback');
    // Нічні задачі teamself шлють subject: null — їх заглушка не чіпає.
    expect(routeFor(cfg, 'teamself', null)).toBeNull();
    expect(routeFor(cfg, 'teamself', 'teamself:user:7')).toBeNull();
    expect(routeFor(cfg, 'exointel', 'exointel:user:1')?.mode).toBe('always');
    expect(routeFor(cfg, 'exointel', 'exointel:conv:1')).toBeNull();
    // Маршрут без subject — увесь продукт, і без гаманця теж.
    expect(routeFor(cfg, 'exopost', null)?.mode).toBe('always');
    expect(routeFor(cfg, 'exopost', 'exopost:stage:classify')?.mode).toBe('always');
  });
});

describe('мітка сценарію', () => {
  const msg = (content: string) => ({ role: 'user' as const, content });

  it('немає мітки — немає сценарію', () => {
    expect(readScenario([msg('привіт')])).toBeNull();
  });

  it('найсвіжіше повідомлення з міткою виграє', () => {
    expect(readScenario([msg('[stub:500]'), msg('а тепер [stub:429]'), msg('без мітки')])).toBe('429');
  });

  it('невідома мітка — помилка запиту, а не мовчазна відповідь', () => {
    expect(() => readScenario([msg('[stub:4299]')])).toThrow(StubScenarioError);
  });
});

/** Схема, як її віддає pydantic `model_json_schema()` для стадії classify. */
const PYDANTIC_SCHEMA = {
  $defs: {
    Kind: { enum: ['news', 'tutorial', 'meme'], title: 'Kind', type: 'string' },
    Tag: {
      properties: { name: { maxLength: 12, type: 'string' }, weight: { exclusiveMinimum: 0, maximum: 1, type: 'number' } },
      required: ['name', 'weight'],
      type: 'object',
    },
  },
  properties: {
    kind: { $ref: '#/$defs/Kind' },
    title: { minLength: 20, type: 'string' },
    score: { minimum: 1, maximum: 10, type: 'integer' },
    tags: { items: { $ref: '#/$defs/Tag' }, minItems: 2, type: 'array' },
    note: { anyOf: [{ type: 'string' }, { type: 'null' }], default: null },
    at: { format: 'date-time', type: 'string' },
    draft: { type: 'boolean' },
  },
  required: ['kind', 'title', 'score', 'tags', 'at', 'draft'],
  title: 'Classification',
  type: 'object',
};

describe('JSON зі схеми', () => {
  const now = new Date('2026-09-25T10:00:00Z');

  it('знаходить схему в промпті серед прози й прикладів', () => {
    const system = [
      'Класифікуй допис. Приклад: {"kind": "news"} — не схема.',
      '',
      'Відповідай **тільки** JSON за цією схемою:',
      JSON.stringify(PYDANTIC_SCHEMA, null, 2),
    ].join('\n');
    expect(findSchema([system])).toEqual(PYDANTIC_SCHEMA);
  });

  it('немає схеми — null', () => {
    expect(findSchema(['просто текст {не json}\n{"a": 1}'])).toBeNull();
  });

  it('екземпляр задовольняє обмеження схеми', () => {
    const v = instanceOf(PYDANTIC_SCHEMA, now) as Record<string, unknown>;
    expect(v['kind']).toBe('news');
    expect((v['title'] as string).length).toBeGreaterThanOrEqual(20);
    expect(v['title']).toContain('[stub]');
    expect(v['score']).toBe(1);
    const tags = v['tags'] as Array<{ name: string; weight: number }>;
    expect(tags).toHaveLength(2);
    expect(tags[0]!.name.length).toBeLessThanOrEqual(12);
    expect(tags[0]!.weight).toBeGreaterThan(0);
    expect(tags[0]!.weight).toBeLessThanOrEqual(1);
    expect(v['note']).toContain('[stub]');
    expect(v['at']).toBe('2026-09-25T10:00:00.000Z');
    expect(v['draft']).toBe(false);
  });

  it('самопосилання не зациклює', () => {
    const tree = { $defs: { Node: { type: 'object', properties: { child: { $ref: '#/$defs/Node' } } } }, $ref: '#/$defs/Node' };
    expect(() => instanceOf(tree)).not.toThrow();
  });
});

function request(overrides: Partial<StubRequest> = {}): StubRequest {
  return {
    product: 'exopost', subject: null, tier: 'fast',
    messages: [{ role: 'user', content: 'Скажи щось' }],
    maxTokens: 100, temperature: 0, scenario: null,
    ...overrides,
  };
}

describe('відповідь заглушки', () => {
  it('без схеми — текст із позначкою', () => {
    expect(answerFor(EMPTY_STUB, request())).toMatch(/^\[stub\] .*«Скажи щось»/);
  });

  it('зі схемою в системному повідомленні — JSON', () => {
    const r = request({
      messages: [
        { role: 'system', content: `Схема:\n${JSON.stringify(PYDANTIC_SCHEMA, null, 2)}` },
        { role: 'user', content: 'допис' },
      ],
    });
    expect(JSON.parse(answerFor(EMPTY_STUB, r))['kind']).toBe('news');
  });

  it('готова відповідь зі stub.yaml має перевагу над схемою', () => {
    const cfg = parseStub(`
version: 1
responses:
  - { product: exopost, subject: "exopost:stage:*", content: '{"kind":"meme"}' }
`);
    const r = request({
      subject: 'exopost:stage:classify',
      messages: [{ role: 'system', content: `\n${JSON.stringify(PYDANTIC_SCHEMA)}` }],
    });
    expect(answerFor(cfg, r)).toBe('{"kind":"meme"}');
    expect(answerFor(cfg, { ...r, subject: 'exopost:bot:x' })).not.toBe('{"kind":"meme"}');
  });

  it('готова відповідь за назвою схеми: одна форма на гаманець не одна', () => {
    const cfg = parseStub(`
version: 1
responses:
  - { product: exopost, subject: "exopost:stage:generate", schema: Batch, content: batch }
  - { product: exopost, subject: "exopost:stage:generate", schema: Classification, content: single }
`);
    const r = request({
      subject: 'exopost:stage:generate',
      messages: [{ role: 'system', content: `\n${JSON.stringify(PYDANTIC_SCHEMA)}` }],
    });
    expect(answerFor(cfg, r)).toBe('single');
    // Промпт без схеми з назвою — правило зі `schema` не підходить.
    expect(answerFor(cfg, { ...r, messages: [{ role: 'user', content: 'x' }] })).toMatch(/^\[stub\]/);
  });
});

describe('сценарії крізь справжню драбину', () => {
  const stub = createStub({ config: () => EMPTY_STUB, retries: 2, sleep: noSleep });

  it('без сценарію — основна сходинка', async () => {
    const r = await stub.run(request());
    expect(r).toMatchObject({ ok: true, model: STUB_PRIMARY, pool: 'stub-a', rung: 0 });
    expect(r.content).toMatch(/^\[stub\]/);
  });

  it.each([
    ['429', 'exhausted', 1],
    ['retired', 'retired', 1],
    ['rejected', 'rejected', 1],
    ['500', 'error', 3],
    ['slow', 'timeout', 3],
  ] as const)('%s — спуск на запасну, основна: %s після %i спроб', async (scenario, outcome, tries) => {
    const r = await stub.run(request({ scenario }));
    expect(r).toMatchObject({ ok: true, model: STUB_FALLBACK, pool: 'stub-b', rung: 1 });
    expect(r.attempts[0]).toMatchObject({ model: STUB_PRIMARY, outcome, tries });
  });

  it('empty — відповідь, а не збій', async () => {
    const r = await stub.run(request({ scenario: 'empty' }));
    expect(r).toMatchObject({ ok: true, content: null, rung: 0 });
  });

  it('all-fail — жодна сходинка', async () => {
    const r = await stub.run(request({ scenario: 'all-fail' }));
    expect(r.ok).toBe(false);
    expect(r.attempts.map((a) => a.outcome)).toEqual(['error', 'error']);
  });

  it('стан пулів не переходить з запиту в запит', async () => {
    await stub.run(request({ scenario: '429' }));
    const next = await stub.run(request());
    expect(next.rung).toBe(0);
  });
});

// ── HTTP: заглушка в тому самому шляху, що й моделі ─────────────────────────

const catalog = parseCatalog(`
version: 1
pools:
  hot:  { upstream: a, probe: a1 }
  cold: { upstream: b, probe: b1 }
models:
  - { id: a1, pool: hot,  timeout_ms: 1000 }
  - { id: b1, pool: cold, timeout_ms: 1000 }
tiers:
  fast: [a1, b1]
`);

const KEYS = { exopost: 'exopost-secret-0000001', teamself: 'teamself-secret-000001' };

function deadGateway(): { gw: Gateway; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    gw: {
      async call(req) {
        calls.push(req.model);
        return {
          outcome: 'exhausted', content: null, httpStatus: 429, latencyMs: 1, retryAfterMs: null,
          error: '429', unreachable: false, usage: { promptTokens: null, completionTokens: null, totalTokens: null },
        } satisfies CallResult;
      },
      async listModels() { return null; },
    },
  };
}

let server: Server | undefined;
afterEach(() => { server?.close(); server = undefined; });

async function start(stubCfg: StubConfig) {
  const { gw, calls } = deadGateway();
  const pools = createPoolHealth({ gateway: gw, catalog: () => catalog });
  const ladder = createLadder({ gateway: gw, pools, retries: 0, sleep: noSleep });
  const entries: JournalEntry[] = [];
  let consumed = 0;
  const budget = {
    async consume() { consumed++; return { allowed: true, scope: null, used: consumed, cap: 100 }; },
    async used() { return consumed; },
  } as unknown as Budget;

  server = createHttpServer({
    keys: parseProductKeys(`exopost:${KEYS.exopost},teamself:${KEYS.teamself}`),
    catalog: { current: () => catalog, reload: async () => false, stop: () => {} },
    pools, ladder, budget,
    journal: { async record(e: JournalEntry) { entries.push(e); return entries.length; } },
    stub: createStub({ config: () => stubCfg, retries: 0, sleep: noSleep }),
    health: { live: () => new Response('{}'), ready: () => new Response('{}') },
    caps: () => ({ product: 100, subject: 10 }),
    version: 'test',
  });
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
  const port = (server!.address() as AddressInfo).port;

  async function complete(product: keyof typeof KEYS, body: Record<string, unknown>) {
    const res = await fetch(`http://127.0.0.1:${port}/v1/complete`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${KEYS[product]}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ tier: 'fast', prompt: 'привіт', ...body }),
    });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  }
  // Рядки обліку — спроби кожного запиту журналу, як їх пише journal.record.
  const ledgerRows = () => entries.flatMap((e) => e.attempts.map((attempt) => ({ tier: e.tier, attempt })));
  return { complete, calls, entries, ledgerRows, consumed: () => consumed };
}

const CFG = parseStub(`
version: 1
routes:
  - { product: exopost, mode: always }
  - { product: teamself, subject: sandbox, mode: always }
  - { product: teamself, subject: "teamself:*", mode: fallback }
`);

describe('HTTP із заглушкою', () => {
  it('always: моделі не питаються, облік і стеля справжні', async () => {
    const s = await start(CFG);
    const r = await s.complete('exopost', {});
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ stub: true, model: STUB_PRIMARY, pool: 'stub-a', rung: 0, tier: 'fast' });
    expect(s.calls).toEqual([]);
    expect(s.consumed()).toBe(1);
    expect(s.ledgerRows().map((x) => [x.tier, x.attempt.pool])).toEqual([['fast', 'stub-a']]);
  });

  it('always: сценарій 429 спускає драбиною заглушки', async () => {
    const s = await start(CFG);
    const r = await s.complete('exopost', { prompt: 'тест [stub:429]' });
    expect(r.body).toMatchObject({ stub: true, model: STUB_FALLBACK, rung: 1 });
  });

  it('always: all-fail — 503 тієї самої форми', async () => {
    const s = await start(CFG);
    const r = await s.complete('exopost', { prompt: '[stub:all-fail]' });
    expect(r.status).toBe(503);
    expect(r.body).toMatchObject({ error: 'all_rungs_failed', stub: true });
  });

  it('always: budget — 429 budget_exhausted, лічильник не чіпається', async () => {
    const s = await start(CFG);
    const r = await s.complete('exopost', { prompt: '[stub:budget]' });
    expect(r.status).toBe(429);
    expect(r.body).toMatchObject({ error: 'budget_exhausted', degrade: 'human_handoff', stub: true });
    expect(s.consumed()).toBe(0);
  });

  it('always: невідома мітка — 400', async () => {
    const s = await start(CFG);
    expect((await s.complete('exopost', { prompt: '[stub:nope]' })).status).toBe(400);
  });

  it('невідомий тир — 400 і з заглушкою', async () => {
    const s = await start(CFG);
    const r = await s.complete('exopost', { tier: 'turbo' });
    expect(r.status).toBe(400);
    expect(r.body['error']).toBe('unknown_tier');
    expect(s.consumed()).toBe(0);
  });

  it('fallback: справжні спроби лишаються, заглушка — після них', async () => {
    const s = await start(CFG);
    const r = await s.complete('teamself', { subject: 'teamself:user:1' });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ stub: true, model: STUB_PRIMARY, rung: 2 });
    expect(s.calls).toEqual(['a1', 'b1']);
    const attempts = r.body['attempts'] as Array<{ rung: number; model: string; outcome: string }>;
    expect(attempts.map((a) => [a.rung, a.model, a.outcome])).toEqual([
      [0, 'a1', 'exhausted'],
      [1, 'b1', 'exhausted'],
      [2, STUB_PRIMARY, 'ok'],
    ]);
    expect(s.ledgerRows()).toHaveLength(3);
  });

  it('fallback: мітки не діють — це текст для моделі', async () => {
    const s = await start(CFG);
    const r = await s.complete('teamself', { subject: 'teamself:user:1', prompt: '[stub:all-fail]' });
    expect(r.status).toBe(200);
  });

  it('без маршруту — чесний 503, заглушка мовчить', async () => {
    const s = await start(CFG);
    const r = await s.complete('teamself', {});
    expect(r.status).toBe(503);
    expect(r.body['stub']).toBeUndefined();
  });

  it('гаманець sandbox — always', async () => {
    const s = await start(CFG);
    const r = await s.complete('teamself', { subject: 'sandbox' });
    expect(r.body).toMatchObject({ stub: true, rung: 0 });
    expect(s.calls).toEqual([]);
  });
});
