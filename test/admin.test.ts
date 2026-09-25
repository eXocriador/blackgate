import { describe, it, expect, afterEach, beforeAll, afterAll } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import bcrypt from 'bcryptjs';
import { apr1, createBasicAuth, parseHtpasswd, verifyPassword, HtpasswdError } from '../src/admin/basic.js';
import { createAdminServer, type AdminDeps } from '../src/admin/server.js';
import { createUpstreamAdmin } from '../src/admin/upstream.js';
import { parseCatalog } from '../src/catalog/index.js';
import { createPoolHealth } from '../src/pools/health.js';
import { createLadder } from '../src/ladder/run.js';
import { createStub } from '../src/stub/run.js';
import { parseStub } from '../src/stub/config.js';
import type { Budget } from '../src/accounting/budget.js';
import type { JournalEntry } from '../src/journal/journal.js';
import type { Changes } from '../src/admin/changes.js';
import type { Queries } from '../src/admin/queries.js';
import type { Settings } from '../src/settings/settings.js';
import { effective } from '../src/settings/settings.js';

describe('apr1 — вектори з `openssl passwd -apr1`', () => {
  it.each([
    ['secret', 'abcdefgh', '$apr1$abcdefgh$h9FWgUz3n9YxylKLlR5SQ/'],
    ['пароль з пробілом', 'x/y.Z9', '$apr1$x/y.Z9$eQ3cFuPFAtMs1ElvUGXT7/'],
    ['a', '12345678', '$apr1$12345678$68ZQVfPkWX/wcXr/41VxQ.'],
  ])('%s', async (pw, salt, expected) => {
    expect(apr1(pw, salt)).toBe(expected);
    expect(await verifyPassword(pw, expected)).toBe(true);
    expect(await verifyPassword(`${pw}x`, expected)).toBe(false);
  });

  it('bcrypt теж', async () => {
    const hash = bcrypt.hashSync('secret', 4);
    expect(await verifyPassword('secret', hash)).toBe(true);
    expect(await verifyPassword('nope', hash)).toBe(false);
  });
});

describe('ADMIN_HTPASSWD', () => {
  it('кома або новий рядок; лапки з .env знімаються', () => {
    expect(parseHtpasswd(`'admin:$apr1$abcdefgh$h9FWgUz3n9YxylKLlR5SQ/'`)).toEqual([
      { user: 'admin', hash: '$apr1$abcdefgh$h9FWgUz3n9YxylKLlR5SQ/' },
    ]);
    expect(parseHtpasswd('a:$2y$04$xxxxxxxxxxxxxxxxxxxxxx,b:$apr1$s$h')).toHaveLength(2);
  });
  it('порожній чи не той формат — відмова без секрету в тексті', () => {
    expect(() => parseHtpasswd('')).toThrow(HtpasswdError);
    expect(() => parseHtpasswd('admin:plaintext')).toThrow(/не bcrypt і не apr1/);
    expect(() => parseHtpasswd('admin:plaintext')).not.toThrow(/plaintext/);
  });
});

const HASH = '$apr1$abcdefgh$h9FWgUz3n9YxylKLlR5SQ/'; // secret
const basic = (u: string, p: string) => `Basic ${Buffer.from(`${u}:${p}`).toString('base64')}`;

describe('Basic', () => {
  it('добрий, поганий, невідомий, без заголовка', async () => {
    const auth = createBasicAuth({ entries: [{ user: 'admin', hash: HASH }] });
    expect(await auth.check(basic('admin', 'secret'), 'ip')).toEqual({ ok: true, user: 'admin' });
    expect(await auth.check(basic('admin', 'wrong'), 'ip')).toMatchObject({ ok: false, reason: 'invalid' });
    expect(await auth.check(basic('root', 'secret'), 'ip')).toMatchObject({ ok: false, reason: 'invalid' });
    expect(await auth.check(undefined, 'ip')).toMatchObject({ ok: false, reason: 'missing' });
    expect(await auth.check('Bearer x', 'ip')).toMatchObject({ ok: false, reason: 'missing' });
  });

  it('після N невдач — блок джерела до кінця вікна, сусід не страждає', async () => {
    let t = 0;
    const auth = createBasicAuth({ entries: [{ user: 'admin', hash: HASH }], maxFailures: 3, windowMs: 1000, now: () => t });
    for (let i = 0; i < 3; i++) await auth.check(basic('admin', 'x'), 'a');
    expect(await auth.check(basic('admin', 'secret'), 'a')).toMatchObject({ ok: false, reason: 'locked' });
    expect(await auth.check(basic('admin', 'secret'), 'b')).toMatchObject({ ok: true });
    t = 1500;
    expect(await auth.check(basic('admin', 'secret'), 'a')).toMatchObject({ ok: true });
  });
});

describe('Management API апстріму', () => {
  it('немає ключа — no_key, без жодного запиту', async () => {
    let calls = 0;
    const up = createUpstreamAdmin({ baseUrl: 'http://x', key: null, fetchImpl: (async () => { calls++; return new Response(''); }) as typeof fetch });
    expect(await up.status()).toEqual({ state: 'no_key' });
    expect(calls).toBe(0);
  });

  it('404 — вимкнений; 401 — один запит і тиша (бан IP після 5)', async () => {
    let status = 404;
    let calls = 0;
    let t = 0;
    const up = createUpstreamAdmin({
      baseUrl: 'http://x', key: 'k', cacheMs: 0, lockMs: 1000, now: () => t,
      fetchImpl: (async () => { calls++; return new Response('{}', { status }); }) as typeof fetch,
    });
    expect((await up.status()).state).toBe('disabled');
    status = 401;
    expect((await up.status()).state).toBe('key_rejected');
    const before = calls;
    for (let i = 0; i < 10; i++) expect((await up.status()).state).toBe('key_rejected');
    expect(calls).toBe(before);
    t = 2000;
    status = 200;
    expect((await up.status()).state).toBe('ok');
  });
});

// ── HTTP ─────────────────────────────────────────────────────────────────

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

let web: string;
beforeAll(async () => {
  web = await mkdtemp(join(tmpdir(), 'blackgate-web-'));
  await mkdir(join(web, 'assets'));
  await writeFile(join(web, 'index.html'), '<!doctype html><title>blackgate</title>');
  await writeFile(join(web, 'assets', 'app-abc.js'), 'console.log(1)');
});
afterAll(async () => { await rm(web, { recursive: true, force: true }); });

let server: Server | undefined;
afterEach(() => { server?.close(); server = undefined; });

async function start() {
  const gw = {
    async call() {
      return {
        outcome: 'ok' as const, content: 'справжня', httpStatus: 200, latencyMs: 1, retryAfterMs: null, error: null,
        unreachable: false, usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      };
    },
    async listModels() { return null; },
  };
  const pools = createPoolHealth({ gateway: gw, catalog: () => catalog });
  const ladder = createLadder({ gateway: gw, pools, retries: 0, sleep: async () => {} });
  const stubCfg = parseStub('version: 1\nroutes:\n  - { product: exopost, mode: always }\n');
  const stub = createStub({ config: () => stubCfg, retries: 0, sleep: async () => {} });
  const entries: JournalEntry[] = [];
  const applied: Array<[string, string, string]> = [];
  const budget = {
    async consume() { return { allowed: true, scope: null, used: 1, cap: 10 }; },
    async used() { return 3; },
  } as unknown as Budget;
  const eff = effective({ capProduct: 10, capSubject: 5, storeContent: true, contentDays: 90, retentionDays: 365 }, {});
  const settings = {
    current: () => eff, overrides: () => ({}), defaults: () => ({}),
  } as unknown as Settings;

  const deps: AdminDeps = {
    auth: createBasicAuth({ entries: [{ user: 'admin', hash: HASH }] }),
    version: 'test',
    products: ['exopost', 'teamself'],
    catalog: { current: () => catalog, reload: async () => true, stop: () => {} },
    stubConfig: { current: () => stubCfg, reload: async () => true, stop: () => {} },
    pools,
    budget,
    settings,
    changes: {
      currentText: async () => 'text',
      lastAfter: async () => null,
      list: async () => [],
      check: async (_k: string, text: string) => ({ ok: true, problems: [], diff: `+${text}`, unchanged: false }),
      apply: async (kind: string, text: string, actor: string) => { applied.push([kind, text, actor]); return { id: 1, diff: '' }; },
    } as unknown as Changes,
    queries: { today: async () => [], facets: async () => ({ products: [], tiers: [] }) } as unknown as Queries,
    journal: { async record(e) { entries.push(e); return 77; } },
    upstream: { status: async () => ({ state: 'no_key' as const }) },
    upstreamPanelUrl: null,
    health: { ready: () => Response.json({ status: 'ok', checks: {} }) },
    complete: { catalog: { current: () => catalog, reload: async () => true, stop: () => {} }, ladder, budget, stub, caps: () => ({ product: 10, subject: 5 }) },
    retention: { purge: async () => ({ contentCleared: 0, rowsDeleted: 0 }) },
    webRoot: web,
    startedAt: new Date(),
  };
  server = createAdminServer(deps);
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
  const auth = { Authorization: basic('admin', 'secret') };
  return { base, auth, entries, applied };
}

describe('admin-слухач', () => {
  it('без Basic — 401 з WWW-Authenticate і на API, і на статиці', async () => {
    const { base } = await start();
    for (const p of ['/', '/admin/api/overview', '/journal']) {
      const r = await fetch(base + p);
      expect(r.status).toBe(401);
      expect(r.headers.get('www-authenticate')).toMatch(/^Basic/);
    }
  });

  it('з Basic — огляд і статика; невідомий шлях SPA — index, невідомий файл — 404', async () => {
    const { base, auth } = await start();
    const o = await fetch(`${base}/admin/api/overview`, { headers: auth });
    expect(o.status).toBe(200);
    const body = (await o.json()) as { caps: Array<{ product: string; used: number; cap: number }>; stub: string[] };
    expect(body.caps[0]).toMatchObject({ product: 'exopost', used: 3, cap: 10 });
    expect(body.stub).toEqual(['exopost=always']);

    const idx = await fetch(`${base}/journal/42`, { headers: auth });
    expect(idx.status).toBe(200);
    expect(idx.headers.get('content-security-policy')).toContain("default-src 'self'");
    expect(await idx.text()).toContain('<title>blackgate');
    const asset = await fetch(`${base}/assets/app-abc.js`, { headers: auth });
    expect(asset.headers.get('cache-control')).toContain('immutable');
    expect((await fetch(`${base}/assets/nope.js`, { headers: auth })).status).toBe(404);
    expect((await fetch(`${base}/..%2f..%2fetc/passwd`, { headers: auth })).status).toBe(400);
  });

  it('зміна без X-Requested-With — 403; чужий Origin — 403; свій — 200', async () => {
    const { base, auth, applied } = await start();
    const put = (headers: Record<string, string>) => fetch(`${base}/admin/api/docs/catalog`, {
      method: 'PUT', headers: { ...auth, 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify({ text: 'version: 1', note: 'n' }),
    });
    expect((await put({})).status).toBe(403);
    expect((await put({ 'X-Requested-With': 'blackgate-panel', Origin: 'https://evil.example' })).status).toBe(403);
    const host = new URL(base).host;
    const ok = await put({ 'X-Requested-With': 'blackgate-panel', Origin: `http://${host}` });
    expect(ok.status).toBe(200);
    expect(applied).toEqual([['catalog', 'version: 1', 'admin']]);
  });

  it('пісочниця — від імені продукту, гаманець console:<користувач>, у журналі', async () => {
    const { base, auth, entries } = await start();
    const r = await fetch(`${base}/admin/api/sandbox`, {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json', 'X-Requested-With': 'blackgate-panel' },
      body: JSON.stringify({ product: 'teamself', tier: 'fast', prompt: 'привіт', subject: 'teamself:user:1' }),
    });
    const body = (await r.json()) as { status: number; journalId: number; body: { content: string } };
    expect(body).toMatchObject({ status: 200, journalId: 77, body: { content: 'справжня' } });
    expect(entries[0]).toMatchObject({ source: 'console', product: 'teamself', subject: 'console:admin' });

    // exopost у заглушці always — пісочниця бачить те саме, що й продукт.
    const s = await fetch(`${base}/admin/api/sandbox`, {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json', 'X-Requested-With': 'blackgate-panel' },
      body: JSON.stringify({ product: 'exopost', tier: 'fast', prompt: 'x' }),
    });
    expect(((await s.json()) as { body: { stub: boolean } }).body.stub).toBe(true);

    const bad = await fetch(`${base}/admin/api/sandbox`, {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json', 'X-Requested-With': 'blackgate-panel' },
      body: JSON.stringify({ product: 'chuzhyi', tier: 'fast', prompt: 'x' }),
    });
    expect(bad.status).toBe(400);
  });
});
