/**
 * Admin-слухач: панель моніторингу й керування на ОКРЕМОМУ порту (3001).
 *
 * Окремий порт, а не маршрути поруч із /v1, — щоб межа між «продукти кличуть
 * моделі» і «людина керує шлюзом» була мережевою: Traefik веде домен панелі
 * лише сюди, а порт 3000 лишився тим самим, що й був, без жодного нового
 * маршруту.
 *
 * Кожен запит — з Basic (другий шар після Traefik; чому — `basic.ts`). Зміни —
 * лише з `X-Requested-With` і Origin свого ж хоста: браузер шле Basic сам на
 * будь-який запит до домену, тож без цього чужа сторінка могла б змусити
 * браузер власника зберегти реєстр (CSRF). Кастомний заголовок змушує браузер
 * питати дозволу (preflight), якого цей сервер не дає нікому.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import type { BasicAuth } from './basic.js';
import type { Changes, ChangeKind } from './changes.js';
import { ChangeRejected, CHANGE_KINDS } from './changes.js';
import type { Queries, RangeKey } from './queries.js';
import { RANGES } from './queries.js';
import type { UpstreamAdmin } from './upstream.js';
import type { CatalogHandle } from '../catalog/index.js';
import type { PoolHealth } from '../pools/health.js';
import type { Budget } from '../accounting/budget.js';
import type { Journal } from '../journal/journal.js';
import type { Settings } from '../settings/settings.js';
import { capsFor } from '../settings/settings.js';
import type { StubHandle } from '../stub/config.js';
import { describeRoutes } from '../stub/config.js';
import { SCENARIOS } from '../stub/run.js';
import { runComplete, type CompleteDeps } from '../http/complete.js';

export interface AdminDeps {
  auth: BasicAuth;
  version: string;
  products: readonly string[];
  catalog: CatalogHandle;
  stubConfig: StubHandle;
  pools: PoolHealth;
  budget: Budget;
  settings: Settings;
  changes: Changes;
  queries: Queries;
  journal: Journal;
  upstream: UpstreamAdmin;
  /** Посилання на Management Center двигуна, якщо для нього є адреса. */
  upstreamPanelUrl: string | null;
  health: { ready(): Promise<Response> | Response };
  /** Те саме ядро, що й /v1/complete, — для пісочниці. */
  complete: CompleteDeps;
  retention: { purge(): Promise<{ contentCleared: number; rowsDeleted: number }> };
  /** Тека зі зібраною SPA; немає — лише API. */
  webRoot: string | null;
  startedAt: Date;
  logInfo?: (event: string, fields?: Record<string, unknown>) => void;
  logWarn?: (event: string, fields?: Record<string, unknown>) => void;
}

const MAX_BODY = 2_000_000;

class HttpError extends Error {
  constructor(readonly status: number, readonly body: Record<string, unknown>) {
    super(String(body['error']));
  }
}

export function createAdminServer(deps: AdminDeps) {
  return createServer((req, res) => {
    void handle(req, res, deps).catch((err) => {
      if (err instanceof HttpError) return json(res, err.status, err.body);
      if (err instanceof ChangeRejected) return json(res, 422, { error: 'rejected', problems: err.problems });
      deps.logWarn?.('admin.unhandled', { error: (err as Error).message, url: req.url });
      json(res, 500, { error: 'internal', detail: (err as Error).message });
    });
  });
}

function sourceOf(req: IncomingMessage): string {
  const xff = req.headers['x-forwarded-for'];
  const first = (Array.isArray(xff) ? xff[0] : xff)?.split(',')[0]?.trim();
  return first || req.socket.remoteAddress || 'unknown';
}

async function handle(req: IncomingMessage, res: ServerResponse, deps: AdminDeps): Promise<void> {
  const verdict = await deps.auth.check(req.headers.authorization, sourceOf(req));
  if (!verdict.ok) {
    if (verdict.reason === 'locked') return json(res, 429, { error: 'too_many_failures' });
    if (verdict.reason === 'invalid') deps.logWarn?.('admin.auth_failed', { source: sourceOf(req) });
    res.setHeader('WWW-Authenticate', 'Basic realm="blackgate", charset="UTF-8"');
    return json(res, 401, { error: 'unauthorized' });
  }
  const user = verdict.user;

  const url = new URL(req.url ?? '/', 'http://localhost');
  const path = url.pathname.replace(/\/+$/, '') || '/';
  const method = req.method ?? 'GET';

  if (!path.startsWith('/admin/api/') && path !== '/admin/api') {
    if (method !== 'GET' && method !== 'HEAD') return json(res, 405, { error: 'method_not_allowed' });
    return serveStatic(res, deps.webRoot, url.pathname);
  }

  if (method !== 'GET' && method !== 'HEAD') assertSameOrigin(req);

  const route = path.slice('/admin/api'.length);
  const q = url.searchParams;

  // ── читання ─────────────────────────────────────────────────────────────
  if (method === 'GET' && route === '/me') {
    return json(res, 200, { user, version: deps.version, startedAt: deps.startedAt.toISOString() });
  }
  if (method === 'GET' && route === '/overview') return json(res, 200, await overview(deps));
  if (method === 'GET' && route === '/facets') {
    const cat = deps.catalog.current();
    const f = await deps.queries.facets().catch(() => ({ products: [], tiers: [] }));
    return json(res, 200, {
      products: [...new Set([...deps.products, ...f.products])].sort(),
      keyProducts: deps.products,
      tiers: [...new Set([...cat.tierNames, ...f.tiers])].sort(),
      catalogTiers: cat.tierNames,
      scenarios: SCENARIOS,
    });
  }
  if (method === 'GET' && route === '/metrics') {
    const range = (q.get('range') ?? '24h') as RangeKey;
    if (!(range in RANGES)) throw new HttpError(400, { error: 'bad_range', ranges: Object.keys(RANGES) });
    return json(res, 200, await deps.queries.metrics({
      range,
      product: q.get('product') || null,
      tier: q.get('tier') || null,
      includeStub: q.get('stub') === '1',
    }));
  }
  if (method === 'GET' && route === '/requests') {
    return json(res, 200, {
      items: await deps.queries.journal({
        product: q.get('product') || null,
        status: q.get('status') || null,
        source: q.get('source') || null,
        tier: q.get('tier') || null,
        q: q.get('q')?.trim() || null,
        beforeId: intOrNull(q.get('before')),
        limit: intOrNull(q.get('limit')) ?? 50,
      }),
    });
  }
  let m = /^\/requests\/(\d+)$/.exec(route);
  if (method === 'GET' && m) {
    const row = await deps.queries.request(Number(m[1]));
    return row ? json(res, 200, row) : json(res, 404, { error: 'not_found' });
  }
  if (method === 'GET' && route === '/upstream') {
    return json(res, 200, { ...(await deps.upstream.status()), panelUrl: deps.upstreamPanelUrl });
  }

  // ── документи: налаштування, реєстр, заглушка ─────────────────────────
  m = /^\/docs\/(settings|catalog|stub)(\/check)?$/.exec(route);
  if (m) {
    const kind = m[1] as ChangeKind;
    if (method === 'GET' && !m[2]) return json(res, 200, await docView(deps, kind));
    if (method === 'POST' && m[2]) {
      const body = await readJson(req);
      return json(res, 200, await deps.changes.check(kind, textOf(body)));
    }
    if (method === 'PUT' && !m[2]) {
      const body = await readJson(req);
      const out = await deps.changes.apply(kind, textOf(body), user, noteOf(body));
      return json(res, 200, { ...out, doc: await docView(deps, kind) });
    }
  }

  // ── аудит дій і відкат ──────────────────────────────────────────────────
  if (method === 'GET' && route === '/history') {
    const kind = q.get('kind');
    if (kind && !CHANGE_KINDS.includes(kind as ChangeKind)) throw new HttpError(400, { error: 'bad_kind' });
    return json(res, 200, {
      items: await deps.changes.list({
        ...(kind ? { kind: kind as ChangeKind } : {}),
        ...(intOrNull(q.get('before')) !== null ? { beforeId: intOrNull(q.get('before'))! } : {}),
        limit: intOrNull(q.get('limit')) ?? 50,
      }),
    });
  }
  m = /^\/history\/(\d+)(?:\/(preview|restore))?$/.exec(route);
  if (m) {
    const id = Number(m[1]);
    if (method === 'GET' && !m[2]) {
      const row = await deps.changes.get(id);
      return row ? json(res, 200, row) : json(res, 404, { error: 'not_found' });
    }
    if (method === 'POST' && m[2]) {
      const body = await readJson(req);
      const which = body['which'] === 'after' ? 'after' : body['which'] === 'before' ? 'before' : null;
      if (!which) throw new HttpError(400, { error: 'bad_request', detail: 'which: before | after' });
      if (m[2] === 'preview') return json(res, 200, await deps.changes.previewRestore(id, which));
      return json(res, 200, await deps.changes.restore(id, which, user));
    }
  }

  // ── пісочниця ───────────────────────────────────────────────────────────
  if (method === 'POST' && route === '/sandbox') return json(res, 200, await sandbox(deps, req, user));

  if (method === 'POST' && route === '/journal/purge') {
    const out = await deps.retention.purge();
    deps.logInfo?.('admin.purge', { user, ...out });
    return json(res, 200, out);
  }

  json(res, 404, { error: 'not_found' });
}

async function overview(deps: AdminDeps) {
  const readyRes = await deps.health.ready();
  const ready = (await readyRes.json()) as Record<string, unknown>;
  const settings = deps.settings.current();
  const today = await deps.queries.today().catch(() => null);
  const products = await Promise.all(
    deps.products.map(async (product) => {
      const caps = capsFor(settings, product);
      const used = await deps.budget.used('product', product);
      return { product, used, cap: caps.product, subjectCap: caps.subject, custom: product in settings.caps.products };
    }),
  );
  const cat = deps.catalog.current();
  return {
    ready: { status: readyRes.status, ...ready },
    pools: deps.pools.snapshot(),
    penalties: deps.pools.penalties(),
    tiers: [...cat.tiers].map(([tier, rungs]) => ({
      tier,
      rungs: rungs.map((mdl, i) => ({ rung: i, model: mdl.id, pool: mdl.pool, timeoutMs: mdl.timeout_ms })),
    })),
    stub: describeRoutes(deps.stubConfig.current()),
    caps: products,
    today,
    journal: settings.journal,
  };
}

async function docView(deps: AdminDeps, kind: ChangeKind) {
  const text = await deps.changes.currentText(kind);
  const last = await deps.changes.lastAfter(kind);
  const history = await deps.changes.list({ kind, limit: 1 }).catch(() => []);
  const base = {
    kind,
    text,
    // Файл змінено повз панель (vim, git) після останньої зміни з неї.
    drift: last !== null && last !== text,
    lastChange: history[0] ?? null,
  };
  if (kind !== 'settings') return base;
  return {
    ...base,
    overrides: deps.settings.overrides(),
    effective: deps.settings.current(),
    defaults: deps.settings.defaults(),
    products: deps.products,
  };
}

async function sandbox(deps: AdminDeps, req: IncomingMessage, user: string) {
  const body = await readJson(req);
  const product = typeof body['product'] === 'string' ? body['product'] : '';
  if (!deps.products.includes(product)) {
    throw new HttpError(400, { error: 'bad_request', detail: `невідомий продукт; є: ${deps.products.join(', ')}` });
  }
  // Пісочниця — від імені продукту, але з власного гаманця: її запити не
  // з'їдають денну стелю чийогось клієнта і видні в журналі окремо.
  const subject = `console:${user}`.slice(0, 200);
  const { product: _p, subject: _s, ...rest } = body;
  const out = await runComplete(deps.complete, { product, source: 'console', body: rest, subjectOverride: subject });
  const journalId = await deps.journal.record(out.entry);
  deps.logInfo?.('admin.sandbox', { user, product, status: out.status, journalId });
  return { status: out.status, body: out.body, journalId };
}

function assertSameOrigin(req: IncomingMessage): void {
  if (req.headers['x-requested-with'] !== 'blackgate-panel') {
    throw new HttpError(403, { error: 'csrf', detail: 'потрібен X-Requested-With: blackgate-panel' });
  }
  const origin = req.headers.origin;
  if (origin) {
    let host: string;
    try {
      host = new URL(origin).host;
    } catch {
      throw new HttpError(403, { error: 'csrf', detail: 'Origin не розбирається' });
    }
    const forwarded = req.headers['x-forwarded-host'];
    const expected = (Array.isArray(forwarded) ? forwarded[0] : forwarded) ?? req.headers.host;
    if (host !== expected) throw new HttpError(403, { error: 'csrf', detail: 'Origin чужий' });
  }
}

function textOf(body: Record<string, unknown>): string {
  if (typeof body['text'] !== 'string') throw new HttpError(400, { error: 'bad_request', detail: 'потрібен text' });
  return body['text'];
}

function noteOf(body: Record<string, unknown>): string | null {
  return typeof body['note'] === 'string' && body['note'].trim() ? body['note'].trim().slice(0, 500) : null;
}

function intOrNull(v: string | null): number | null {
  if (v === null || v === '') return null;
  const n = Number(v);
  return Number.isInteger(n) ? n : null;
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > MAX_BODY) throw new HttpError(413, { error: 'too_large' });
    chunks.push(c as Buffer);
  }
  try {
    const v = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as unknown;
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new Error('не об’єкт');
    return v as Record<string, unknown>;
  } catch (err) {
    throw new HttpError(400, { error: 'bad_request', detail: (err as Error).message });
  }
}

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'same-origin',
  'X-Frame-Options': 'DENY',
};

function json(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    'Cache-Control': 'no-store',
  });
  res.end(text);
}

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  // Tailwind 4 і uPlot ставлять style-атрибути.
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'self'",
].join('; ');

/** Статика SPA; невідомий шлях — index.html (маршрути панелі живуть у браузері). */
async function serveStatic(res: ServerResponse, root: string | null, pathname: string): Promise<void> {
  if (!root) return json(res, 404, { error: 'no_web', detail: 'SPA не зібрана (ADMIN_WEB_ROOT)' });
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return json(res, 400, { error: 'bad_path' });
  }
  // `..` відмовляється ДО нормалізації: normalize від кореня і так не вийде за
  // нього, але запит з `..` — не помилка користувача, а спроба, і 400 це каже.
  if (decoded.split(/[/\\]/).includes('..') || decoded.includes('\0')) return json(res, 400, { error: 'bad_path' });
  const rel = normalize(decoded).replace(/^([/\\])+/, '');

  let file = rel ? join(root, rel) : join(root, 'index.html');
  let isIndex = !rel;
  const st = await stat(file).catch(() => null);
  if (!st || !st.isFile()) {
    // Файл з розширенням, якого немає, — справжній 404, а не сторінка:
    // інакше зламаний бандл виглядав би як порожній екран без помилки.
    if (extname(rel)) return json(res, 404, { error: 'not_found' });
    file = join(root, 'index.html');
    isIndex = true;
  }
  const body = await readFile(file).catch(() => null);
  if (!body) return json(res, 404, { error: 'not_found' });
  res.writeHead(200, {
    ...SECURITY_HEADERS,
    'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream',
    'Content-Length': body.length,
    // Хеші в іменах бандла Vite — їх можна тримати вічно; index — ніколи.
    'Cache-Control': isIndex || !rel.startsWith(`assets${sep}`) ? 'no-cache' : 'public, max-age=31536000, immutable',
    ...(isIndex ? { 'Content-Security-Policy': CSP } : {}),
  });
  res.end(body);
}
