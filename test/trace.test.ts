import { describe, it, expect, afterEach } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { parseTraceparent, readTrace } from '../src/trace/context.js';
import { createOtlpExporter, parseHeaders, spansFor } from '../src/trace/otlp.js';
import type { JournalEntry } from '../src/journal/journal.js';
import type { Attempt } from '../src/ladder/run.js';
import { parseCatalog } from '../src/catalog/index.js';
import { createPoolHealth } from '../src/pools/health.js';
import { createLadder } from '../src/ladder/run.js';
import { parseProductKeys } from '../src/http/auth.js';
import { createHttpServer } from '../src/http/server.js';
import type { Budget } from '../src/accounting/budget.js';

const TRACE = '4bf92f3577b34da6a3ce929d0e0e4736';
const SPAN = '00f067aa0ba902b7';

describe('traceparent (W3C)', () => {
  it('добрий', () => {
    expect(parseTraceparent(`00-${TRACE}-${SPAN}-01`)).toEqual({ traceId: TRACE, spanId: SPAN });
    expect(parseTraceparent(` 00-${TRACE.toUpperCase()}-${SPAN}-00 `)).toEqual({ traceId: TRACE, spanId: SPAN });
  });
  it('поганий — ігнорується, не валить', () => {
    expect(parseTraceparent(undefined)).toBeNull();
    expect(parseTraceparent('garbage')).toBeNull();
    expect(parseTraceparent(`ff-${TRACE}-${SPAN}-01`)).toBeNull();
    expect(parseTraceparent(`00-${'0'.repeat(32)}-${SPAN}-01`)).toBeNull();
    expect(parseTraceparent(`00-${TRACE}-${'0'.repeat(16)}-01`)).toBeNull();
  });
});

describe('readTrace', () => {
  it('заголовок виграє; сесія з metadata', () => {
    const t = readTrace({ traceparent: `00-${TRACE}-${SPAN}-01` }, { metadata: { session_id: 'conv:1', trace_id: 'a'.repeat(32) } });
    expect(t).toMatchObject({ traceId: TRACE, parentSpanId: SPAN, sessionId: 'conv:1' });
  });
  it('trace_id з metadata — лише справжній hex-32', () => {
    expect(readTrace({}, { metadata: { trace_id: 'b'.repeat(32) } })?.traceId).toBe('b'.repeat(32));
    expect(readTrace({}, { metadata: { trace_id: 'stage-42' } })).toMatchObject({ traceId: null, metadata: { trace_id: 'stage-42' } });
  });
  it('нічого — null; завелика metadata — позначка замість вмісту', () => {
    expect(readTrace({}, { tier: 'fast' })).toBeNull();
    expect(readTrace({}, null)).toBeNull();
    const big = readTrace({}, { metadata: { blob: 'x'.repeat(5000) } });
    expect(Object.keys(big!.metadata!)).toEqual(['_dropped']);
  });
});

function entry(over: Partial<JournalEntry> = {}): JournalEntry {
  const a = (rung: number, outcome: Attempt['outcome'], latencyMs: number): Attempt => ({
    rung, model: `m${rung}`, pool: `p${rung}`, outcome, httpStatus: outcome === 'ok' ? 200 : 429, latencyMs, tries: 1,
    promptTokens: 10, completionTokens: outcome === 'ok' ? 5 : 0, totalTokens: outcome === 'ok' ? 15 : 10, detail: null,
  });
  return {
    at: new Date(1_000_000), source: 'api', product: 'exopost', subject: 's', requestId: 'r',
    trace: { traceId: TRACE, parentSpanId: SPAN, sessionId: 'conv:1', metadata: null },
    tier: 'fast', stub: false, params: { max_tokens: 100, temperature: 0.3 },
    input: [{ role: 'user', content: 'секрет клієнта' }], output: 'відповідь', status: 200, error: null, errorDetail: null,
    model: 'm1', pool: 'p1', rung: 1, attempts: [a(0, 'exhausted', 20), { ...a(0, 'skipped', 0), rung: 2, promptTokens: null, completionTokens: null, totalTokens: null }, a(1, 'ok', 30)],
    latencyMs: 60, ...over,
  };
}

describe('спани GenAI', () => {
  const attrs = (s: { attributes: Array<{ key: string; value: unknown }> }) =>
    Object.fromEntries(s.attributes.map((a) => [a.key, Object.values(a.value as object)[0]]));

  it('корінь — дочірній до спану продукту; спроби — дочірні до кореня, пропущені не йдуть', () => {
    const spans = spansFor(entry(), 42, false);
    expect(spans).toHaveLength(3);
    const [root, s0, s1] = spans;
    expect(root).toMatchObject({ traceId: TRACE, parentSpanId: SPAN, name: 'chat fast', kind: 2, status: { code: 1 } });
    expect(attrs(root!)).toMatchObject({
      'gen_ai.operation.name': 'chat', 'gen_ai.request.model': 'fast', 'gen_ai.response.model': 'm1',
      'gen_ai.usage.input_tokens': '20', 'gen_ai.usage.output_tokens': '5', 'blackgate.journal_id': '42',
      'gen_ai.conversation.id': 'conv:1',
    });
    expect(s0).toMatchObject({ parentSpanId: root!.spanId, name: 'chat m0', status: { code: 2 } });
    expect(BigInt(s1!.startTimeUnixNano)).toBe(BigInt(s0!.endTimeUnixNano));
  });

  it('вміст — лише за опт-іном', () => {
    const without = attrs(spansFor(entry(), 1, false)[0]!);
    expect(without['gen_ai.input.messages']).toBeUndefined();
    const withContent = attrs(spansFor(entry(), 1, true)[0]!);
    expect(String(withContent['gen_ai.input.messages'])).toContain('секрет клієнта');
  });

  it('без трейсу продукту — новий трейс, без батька; відмова — status error', () => {
    const [root] = spansFor(entry({ trace: null, status: 429, error: 'budget_exhausted', attempts: [] }), null, false);
    expect(root!.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(root!.parentSpanId).toBeUndefined();
    expect(root!.status.code).toBe(2);
    expect(attrs(root!)['error.type']).toBe('budget_exhausted');
  });
});

describe('експортер OTLP', () => {
  it('POST на /v1/traces пакетом, заголовки з OTEL_EXPORTER_OTLP_HEADERS', async () => {
    const posts: Array<{ url: string; headers: Record<string, string>; body: { resourceSpans: Array<{ scopeSpans: Array<{ spans: unknown[] }> }> } }> = [];
    const exp = createOtlpExporter({
      endpoint: 'http://collector:4318/', headers: parseHeaders('Authorization=Basic%20abc,x-a=1'),
      serviceName: 'blackgate', serviceVersion: 't', captureContent: false, flushMs: 1_000_000,
      fetchImpl: (async (url: string, init: RequestInit) => {
        posts.push({ url, headers: init.headers as Record<string, string>, body: JSON.parse(String(init.body)) });
        return new Response('{}');
      }) as unknown as typeof fetch,
    });
    exp.export(entry(), 1);
    exp.export(entry(), 2);
    await exp.stop();
    expect(posts).toHaveLength(1);
    expect(posts[0]!.url).toBe('http://collector:4318/v1/traces');
    expect(posts[0]!.headers).toMatchObject({ Authorization: 'Basic abc', 'x-a': '1' });
    expect(posts[0]!.body.resourceSpans[0]!.scopeSpans[0]!.spans).toHaveLength(6);
  });

  it('приймач лежить — спани губляться, процес живий', async () => {
    const exp = createOtlpExporter({
      endpoint: 'http://nowhere', serviceName: 'b', serviceVersion: 't', captureContent: false, flushMs: 1_000_000,
      fetchImpl: (async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch,
    });
    exp.export(entry(), 1);
    await expect(exp.flush()).resolves.toBeUndefined();
    await exp.stop();
  });
});

// ── трейс із HTTP-заголовка доходить до журналу ──────────────────────────

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
let server: Server | undefined;
afterEach(() => { server?.close(); server = undefined; });

describe('HTTP: traceparent і metadata → журнал', () => {
  it('контекст запиту лягає в запис', async () => {
    const gw = {
      async call() {
        return { outcome: 'ok' as const, content: 'x', httpStatus: 200, latencyMs: 1, retryAfterMs: null, error: null,
          unreachable: false, usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } };
      },
      async listModels() { return null; },
    };
    const pools = createPoolHealth({ gateway: gw, catalog: () => catalog });
    const entries: JournalEntry[] = [];
    const KEY = 'exopost-secret-0000001';
    server = createHttpServer({
      keys: parseProductKeys(`exopost:${KEY}`),
      catalog: { current: () => catalog, reload: async () => false, stop: () => {} },
      pools, ladder: createLadder({ gateway: gw, pools, retries: 0, sleep: async () => {} }),
      budget: { async consume() { return { allowed: true, scope: null, used: 1, cap: 9 }; }, async used() { return 0; } } as unknown as Budget,
      journal: { async record(e) { entries.push(e); return 1; } },
      health: { live: () => new Response('{}'), ready: () => new Response('{}') },
      caps: () => ({ product: 9, subject: 9 }),
      readTrace,
      version: 't',
    });
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
    const port = (server!.address() as AddressInfo).port;
    const r = await fetch(`http://127.0.0.1:${port}/v1/complete`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${KEY}`, traceparent: `00-${TRACE}-${SPAN}-01`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ tier: 'fast', prompt: 'x', metadata: { session_id: 'conv:9', stage: 'classify' } }),
    });
    expect(r.status).toBe(200);
    expect(entries[0]!.trace).toEqual({
      traceId: TRACE, parentSpanId: SPAN, sessionId: 'conv:9', metadata: { session_id: 'conv:9', stage: 'classify' },
    });
  });
});
