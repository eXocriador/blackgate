/**
 * HTTP-шар: `node:http` і власний маленький роутер.
 *
 * Без фреймворка навмисно. Маршрутів шість, тіло одне, а RAM на цій коробці —
 * вузьке місце (AGENTS.md): express чи fastify тут лише додали б дерево
 * залежностей до сервісу, через який ходять усі секрети продуктів.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { ProductKeys } from './auth.js';
import { readKey } from './auth.js';
import type { CatalogHandle } from '../catalog/index.js';
import type { PoolHealth } from '../pools/health.js';
import type { Ladder } from '../ladder/run.js';
import type { Budget } from '../accounting/budget.js';
import type { Journal, JournalEntry, TraceContext } from '../journal/journal.js';
import type { Stub } from '../stub/run.js';
import { runComplete, type Caps } from './complete.js';

export interface ServerDeps {
  keys: ProductKeys;
  catalog: CatalogHandle;
  pools: PoolHealth;
  ladder: Ladder;
  budget: Budget;
  /** Журнал запитів; пише і спроби в `ai_call`. */
  journal: Journal;
  /** Заглушка замість моделей — лише там, де її ввімкнув `stub.yaml`. */
  stub?: Stub;
  health: { live(): Promise<Response> | Response; ready(): Promise<Response> | Response };
  /** Стелі продукту — з перекриттям у налаштуваннях. */
  caps: (product: string) => Caps;
  /** Трейс-контекст запиту (заголовки + тіло); без нього — null. */
  readTrace?: (headers: IncomingMessage['headers'], body: unknown) => TraceContext | null;
  version: string;
  logWarn?: (event: string, fields?: Record<string, unknown>) => void;
}

const MAX_BODY_BYTES = 1_000_000;

export function createHttpServer(deps: ServerDeps) {
  return createServer((req, res) => {
    void handle(req, res, deps).catch((err) => {
      deps.logWarn?.('http.unhandled', { error: (err as Error).message });
      send(res, 500, { error: 'internal' });
    });
  });
}

async function handle(req: IncomingMessage, res: ServerResponse, deps: ServerDeps): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const path = url.pathname.replace(/\/+$/, '') || '/';

  // Проби — поза автентифікацією (AGENTS.md §6: роутер health поза
  // auth-middleware). Ключа продукту вони не потребують і секретів не носять.
  if (path === '/health/live') return fromWeb(res, await deps.health.live());
  if (path === '/health/ready') return fromWeb(res, await deps.health.ready());

  const product = deps.keys.resolve(readKey(req.headers as Record<string, string | undefined>));
  if (!product) {
    // Невпізнаний ключ на /v1/complete — теж рядок журналу, але без вмісту:
    // хто питав, невідомо, а чужий текст зберігати нема підстав.
    if (req.method === 'POST' && path === '/v1/complete') {
      void deps.journal.record(refusalEntry(null, 401, 'unauthorized', null));
    }
    // Той самий текст і на відсутній, і на невірний ключ: різниця між ними —
    // підказка тому, хто перебирає.
    return send(res, 401, { error: 'unauthorized' });
  }

  if (req.method === 'GET' && path === '/v1/pools') {
    return send(res, 200, { pools: deps.pools.snapshot() });
  }

  if (req.method === 'GET' && path === '/v1/tiers') {
    const cat = deps.catalog.current();
    return send(res, 200, {
      tiers: [...cat.tiers].map(([tier, rungs]) => ({
        tier,
        rungs: rungs.map((m, i) => ({ rung: i, model: m.id, pool: m.pool, timeoutMs: m.timeout_ms })),
      })),
    });
  }

  if (req.method === 'GET' && path === '/v1/usage') {
    const used = await deps.budget.used('product', product);
    return send(res, 200, { product, usedToday: used, cap: deps.caps(product).product });
  }

  if (req.method === 'POST' && path === '/v1/complete') {
    return complete(req, res, deps, product);
  }

  send(res, 404, { error: 'not_found' });
}

async function complete(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ServerDeps,
  product: string,
): Promise<void> {
  let raw: string;
  try {
    raw = await readBody(req);
  } catch (err) {
    void deps.journal.record(refusalEntry(product, 400, 'bad_request', (err as Error).message));
    return send(res, 400, { error: 'bad_request', detail: (err as Error).message });
  }

  const trace = deps.readTrace ? deps.readTrace(req.headers, safeParse(raw)) : null;
  const out = await runComplete(deps, { product, source: 'api', body: raw, trace });
  send(res, out.status, out.body);
  // Журнал (і облік спроб) не тримає відповідь: продукт, якому підтримка
  // потрібна зараз, не має чекати на insert.
  void deps.journal.record(out.entry);
}

function safeParse(raw: string): unknown {
  try { return JSON.parse(raw); } catch { return null; }
}

/** Відмова ще до ядра: невпізнаний ключ або тіло, яке не дочитали. */
function refusalEntry(product: string | null, status: number, error: string, detail: string | null): JournalEntry {
  return {
    at: new Date(), source: 'api', product, subject: null, requestId: null, trace: null,
    tier: null, stub: false, params: null, input: null, output: null,
    status, error, errorDetail: detail,
    model: null, pool: null, rung: null, attempts: [], latencyMs: 0,
  };
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('тіло завелике'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    'Cache-Control': 'no-store',
  });
  res.end(text);
}

/** `@exo/kit/health` віддає веб-стандартний Response — перекласти в node:http. */
async function fromWeb(res: ServerResponse, web: Response | Promise<Response>): Promise<void> {
  const r = await web;
  const text = await r.text();
  res.writeHead(r.status, {
    'Content-Type': r.headers.get('content-type') ?? 'application/json',
    'Content-Length': Buffer.byteLength(text),
    'Cache-Control': 'no-store',
  });
  res.end(text);
}
