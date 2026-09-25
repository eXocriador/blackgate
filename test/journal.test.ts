import { describe, it, expect, afterEach } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import type { Db } from '@exo/kit/infra';
import { parseCatalog } from '../src/catalog/index.js';
import { createPoolHealth } from '../src/pools/health.js';
import { createLadder, type Attempt } from '../src/ladder/run.js';
import { parseProductKeys } from '../src/http/auth.js';
import { createHttpServer } from '../src/http/server.js';
import type { Budget } from '../src/accounting/budget.js';
import { createLedger } from '../src/accounting/ledger.js';
import { createJournal, sumTokens, type JournalEntry } from '../src/journal/journal.js';
import type { CallResult, Gateway } from '../src/upstream/gateway.js';

const catalog = parseCatalog(`
version: 1
pools:
  a: { upstream: x, probe: a1 }
  b: { upstream: x, probe: b1 }
models:
  - { id: a1, pool: a }
  - { id: b1, pool: b }
tiers:
  fast: [a1, b1]
`);

const KEY = 'exopost-secret-0000001';
const usage = (n: number | null) => ({ promptTokens: n, completionTokens: n, totalTokens: n === null ? null : 2 * n });

function gateway(script: Record<string, CallResult['outcome']>): Gateway {
  return {
    async call(req) {
      const outcome = script[req.model] ?? 'ok';
      return {
        outcome, content: outcome === 'ok' ? `відповідь ${req.model}` : null,
        httpStatus: outcome === 'ok' ? 200 : outcome === 'exhausted' ? 429 : 500,
        latencyMs: 5, retryAfterMs: null, error: outcome === 'ok' ? null : outcome,
        unreachable: false, usage: usage(outcome === 'ok' ? 10 : 3),
      };
    },
    async listModels() { return null; },
  };
}

let server: Server | undefined;
afterEach(() => { server?.close(); server = undefined; });

async function start(opts: { script?: Record<string, CallResult['outcome']>; allowed?: boolean } = {}) {
  const gw = gateway(opts.script ?? {});
  const pools = createPoolHealth({ gateway: gw, catalog: () => catalog });
  const ladder = createLadder({ gateway: gw, pools, retries: 0, sleep: async () => {} });
  const entries: JournalEntry[] = [];
  const budget = {
    async consume() {
      return opts.allowed === false
        ? { allowed: false, scope: 'product', used: 101, cap: 100 }
        : { allowed: true, scope: null, used: 1, cap: 100 };
    },
    async used() { return 0; },
  } as unknown as Budget;

  server = createHttpServer({
    keys: parseProductKeys(`exopost:${KEY}`),
    catalog: { current: () => catalog, reload: async () => false, stop: () => {} },
    pools, ladder, budget,
    journal: { async record(e) { entries.push(e); return entries.length; } },
    health: { live: () => new Response('{}'), ready: () => new Response('{}') },
    caps: () => ({ product: 100, subject: 10 }),
    version: 'test',
  });
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
  const port = (server!.address() as AddressInfo).port;

  async function post(body: string, key: string | null = KEY) {
    const res = await fetch(`http://127.0.0.1:${port}/v1/complete`, {
      method: 'POST',
      headers: { ...(key ? { Authorization: `Bearer ${key}` } : {}), 'Content-Type': 'application/json' },
      body,
    });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  }
  return { post, entries };
}

describe('журнал: рядок на КОЖЕН /v1/complete', () => {
  it('200 — вміст, модель, спроби, параметри', async () => {
    const s = await start({ script: { a1: 'exhausted' } });
    const r = await s.post(JSON.stringify({ tier: 'fast', prompt: 'привіт', subject: 'exopost:stage:x', request_id: 'r-1', max_tokens: 99999 }));
    expect(r.status).toBe(200);
    expect(s.entries).toHaveLength(1);
    const e = s.entries[0]!;
    expect(e).toMatchObject({
      status: 200, product: 'exopost', subject: 'exopost:stage:x', requestId: 'r-1', tier: 'fast',
      model: 'b1', pool: 'b', rung: 1, output: 'відповідь b1', error: null, source: 'api',
      params: { max_tokens: 32_000, temperature: 0.3 },
      input: [{ role: 'user', content: 'привіт' }],
    });
    expect(e.attempts.map((a) => a.outcome)).toEqual(['exhausted', 'ok']);
  });

  it('400 на зламаний JSON — сире тіло у вході', async () => {
    const s = await start();
    const r = await s.post('{"tier": ');
    expect(r.status).toBe(400);
    expect(s.entries[0]).toMatchObject({ status: 400, error: 'bad_request', input: '{"tier": ', product: 'exopost' });
  });

  it('400 без tier і невідомий тир', async () => {
    const s = await start();
    await s.post(JSON.stringify({ prompt: 'x' }));
    await s.post(JSON.stringify({ tier: 'turbo', prompt: 'x' }));
    expect(s.entries.map((e) => [e.status, e.error])).toEqual([[400, 'bad_request'], [400, 'unknown_tier']]);
    expect(s.entries[1]!.input).toEqual([{ role: 'user', content: 'x' }]);
  });

  it('429 стелі — відмова в журналі, спроб немає', async () => {
    const s = await start({ allowed: false });
    const r = await s.post(JSON.stringify({ tier: 'fast', prompt: 'x' }));
    expect(r.status).toBe(429);
    expect(s.entries[0]).toMatchObject({ status: 429, error: 'budget_exhausted', attempts: [] });
  });

  it('503 — причина останньої справжньої спроби в error_detail', async () => {
    const s = await start({ script: { a1: 'exhausted', b1: 'error' } });
    const r = await s.post(JSON.stringify({ tier: 'fast', prompt: 'x' }));
    expect(r.status).toBe(503);
    expect(s.entries[0]).toMatchObject({ status: 503, error: 'all_rungs_failed', model: null });
    expect(s.entries[0]!.errorDetail).toContain('b1: error');
  });

  it('401 — рядок без продукту і без вмісту', async () => {
    const s = await start();
    const r = await s.post(JSON.stringify({ tier: 'fast', prompt: 'секрет' }), 'wrong-key-000000000000');
    expect(r.status).toBe(401);
    expect(s.entries[0]).toMatchObject({ status: 401, product: null, input: null });
  });

  it('інші маршрути журнал не пишуть', async () => {
    const s = await start();
    await fetch(`http://127.0.0.1:${(server!.address() as AddressInfo).port}/v1/pools`, { headers: { Authorization: `Bearer ${KEY}` } });
    expect(s.entries).toHaveLength(0);
  });
});

describe('sumTokens', () => {
  const at = (p: number | null): Attempt => ({
    rung: 0, model: 'm', pool: 'p', outcome: 'ok', httpStatus: 200, latencyMs: 1, tries: 1,
    promptTokens: p, completionTokens: p, totalTokens: p, detail: null,
  });
  it('сума по всіх спробах; жодна не назвала — null, не нуль', () => {
    expect(sumTokens([at(3), at(null), at(10)])).toEqual({ prompt: 13, completion: 13, total: 13 });
    expect(sumTokens([at(null)])).toEqual({ prompt: null, completion: null, total: null });
    expect(sumTokens([])).toEqual({ prompt: null, completion: null, total: null });
  });
});

/**
 * Підробка postgres.js рівно на те, що кличе журнал: `begin`, шаблонний виклик
 * і `tx(object)` як хелпер вставки.
 */
function fakeDb(opts: { fail?: boolean } = {}) {
  const inserted: Array<{ table: string; value: unknown }> = [];
  const direct: unknown[] = [];
  const helper = (v: unknown) => ({ __values: v });
  const tag = (strings: TemplateStringsArray | unknown, ...vals: unknown[]) => {
    if (!Array.isArray(strings) || !('raw' in (strings as object))) return helper(strings);
    const text = (strings as unknown as string[]).join('?');
    const table = /INSERT INTO (\w+)/.exec(text)?.[1] ?? '?';
    const v = (vals[0] as { __values: unknown }).__values;
    inserted.push({ table, value: v });
    return Promise.resolve(table === 'ai_request' ? [{ id: '42' }] : []);
  };
  const sql = Object.assign(tag, {
    begin: async (cb: (tx: typeof tag) => Promise<unknown>) => cb(tag),
  });
  const db = {
    sql: null,
    async query() { return null; },
    async tryQuery(fn: (s: unknown) => Promise<unknown>) {
      if (opts.fail) return { ok: false, reason: 'error', error: new Error('boom') };
      return { ok: true, rows: await fn(sql) };
    },
    jsonb: (v: unknown) => ({ json: v }),
  } as unknown as Db;
  const ledgerDb = {
    ...db,
    async tryQuery(fn: (s: unknown) => Promise<unknown>) {
      const capture = Object.assign((s: TemplateStringsArray | unknown, ...vals: unknown[]) => {
        if (!Array.isArray(s) || !('raw' in (s as object))) return helper(s);
        direct.push((vals[0] as { __values: unknown }).__values);
        return Promise.resolve([]);
      }, {});
      return { ok: true, rows: await fn(capture) };
    },
  } as unknown as Db;
  return { db, ledgerDb, inserted, direct };
}

function entry(over: Partial<JournalEntry> = {}): JournalEntry {
  const attempt: Attempt = {
    rung: 0, model: 'a1', pool: 'a', outcome: 'ok', httpStatus: 200, latencyMs: 7, tries: 1,
    promptTokens: 4, completionTokens: 6, totalTokens: 10, detail: null,
  };
  return {
    at: new Date('2026-09-25T10:00:00Z'), source: 'api', product: 'exopost', subject: 's', requestId: 'r',
    trace: null, tier: 'fast', stub: false, params: { max_tokens: 10, temperature: 0 },
    input: [{ role: 'user', content: 'привіт' }], output: 'відповідь', status: 200, error: null, errorDetail: null,
    model: 'a1', pool: 'a', rung: 0, attempts: [attempt], latencyMs: 12, ...over,
  };
}

describe('journal.record', () => {
  it('запит і його спроби — однією транзакцією, спроба несе request_ref', async () => {
    const f = fakeDb();
    const ledger = createLedger({ db: f.db, catalog: () => catalog });
    const journal = createJournal({ db: f.db, ledger, storeContent: () => true });
    expect(await journal.record(entry())).toBe(42);
    expect(f.inserted.map((x) => x.table)).toEqual(['ai_request', 'ai_call']);
    const req = f.inserted[0]!.value as Record<string, unknown>;
    expect(req).toMatchObject({ output: 'відповідь', content_stored: true, total_tokens: 10, attempts: 1 });
    expect(req['input']).toEqual({ json: [{ role: 'user', content: 'привіт' }] });
    const calls = f.inserted[1]!.value as Array<Record<string, unknown>>;
    expect(calls[0]).toMatchObject({ request_ref: 42, model: 'a1', total_tokens: 10 });
  });

  it('«не зберігати вміст» — ні входу, ні виходу, решта на місці', async () => {
    const f = fakeDb();
    const journal = createJournal({ db: f.db, ledger: createLedger({ db: f.db, catalog: () => catalog }), storeContent: () => false });
    await journal.record(entry());
    expect(f.inserted[0]!.value).toMatchObject({ input: null, output: null, content_stored: false, status: 200, total_tokens: 10 });
  });

  it('журнал не ліг — спроби все одно в обліку, без посилання', async () => {
    const f = fakeDb({ fail: true });
    const ledger = createLedger({ db: f.ledgerDb, catalog: () => catalog });
    const journal = createJournal({ db: f.db, ledger, storeContent: () => true });
    expect(await journal.record(entry())).toBeNull();
    const rows = f.direct[0] as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ request_ref: null, model: 'a1' });
  });

  it('відмова без тиру — рядків обліку немає', async () => {
    const f = fakeDb();
    const journal = createJournal({ db: f.db, ledger: createLedger({ db: f.db, catalog: () => catalog }), storeContent: () => true });
    await journal.record(entry({ tier: null, attempts: [], status: 400, error: 'bad_request' }));
    expect(f.inserted.map((x) => x.table)).toEqual(['ai_request']);
  });
});

