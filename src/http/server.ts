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
import { UnknownTierError } from '../ladder/run.js';
import type { Budget } from '../accounting/budget.js';
import type { createLedger } from '../accounting/ledger.js';
import type { ChatMessage } from '../upstream/types.js';

export interface ServerDeps {
  keys: ProductKeys;
  catalog: CatalogHandle;
  pools: PoolHealth;
  ladder: Ladder;
  budget: Budget;
  ledger: ReturnType<typeof createLedger>;
  health: { live(): Promise<Response> | Response; ready(): Promise<Response> | Response };
  caps: { product: number; subject: number };
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
    return send(res, 200, { product, usedToday: used, cap: deps.caps.product });
  }

  if (req.method === 'POST' && path === '/v1/complete') {
    return complete(req, res, deps, product);
  }

  send(res, 404, { error: 'not_found' });
}

interface CompleteBody {
  tier?: unknown;
  messages?: unknown;
  prompt?: unknown;
  max_tokens?: unknown;
  temperature?: unknown;
  subject?: unknown;
  request_id?: unknown;
}

async function complete(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ServerDeps,
  product: string,
): Promise<void> {
  let body: CompleteBody;
  try {
    body = JSON.parse(await readBody(req)) as CompleteBody;
  } catch (err) {
    return send(res, 400, { error: 'bad_request', detail: (err as Error).message });
  }

  const tier = typeof body.tier === 'string' ? body.tier : null;
  if (!tier) return send(res, 400, { error: 'bad_request', detail: 'потрібен tier' });

  const messages = readMessages(body);
  if (!messages) {
    return send(res, 400, { error: 'bad_request', detail: 'потрібен messages[] або prompt' });
  }

  const subject = typeof body.subject === 'string' && body.subject ? body.subject.slice(0, 200) : null;
  const requestId = typeof body.request_id === 'string' ? body.request_id.slice(0, 100) : null;
  const maxTokens = clampInt(body.max_tokens, 1, 32_000, 512);
  const temperature = clampFloat(body.temperature, 0, 2, 0.3);

  // Стеля рахується ПЕРЕД викликом: обірваний на півдорозі запит спалив ті
  // токени, які спалив.
  const verdict = await deps.budget.consume({
    product,
    productCap: deps.caps.product,
    subject,
    subjectCap: deps.caps.subject,
  });

  if (!verdict.allowed) {
    // 429, а не 402. Стеля тут — не білінг: продукт мусить деградувати в
    // передачу людині, а не виставити клієнтові рахунок. Ця властивість
    // перенесена з обох копій spend.ts свідомо.
    return send(res, 429, {
      error: 'budget_exhausted',
      scope: verdict.scope,
      used: verdict.used,
      cap: verdict.cap,
      degrade: 'human_handoff',
    });
  }

  const catalog = deps.catalog.current();
  let result;
  try {
    result = await deps.ladder.run(catalog, { tier, messages, maxTokens, temperature });
  } catch (err) {
    if (err instanceof UnknownTierError) {
      return send(res, 400, { error: 'unknown_tier', detail: err.message, tiers: catalog.tierNames });
    }
    throw err;
  }

  // Облік не тримає відповідь: продукт, якому підтримка потрібна зараз, не має
  // чекати на insert.
  void deps.ledger.record(
    result.attempts.map((attempt) => ({ product, subject, requestId, tier, attempt })),
  );

  if (!result.ok) {
    return send(res, 503, {
      error: 'all_rungs_failed',
      tier,
      attempts: result.attempts,
      totalLatencyMs: result.totalLatencyMs,
    });
  }

  send(res, 200, {
    content: result.content,
    model: result.model,
    pool: result.pool,
    rung: result.rung,
    tier,
    // Спроби віддаються клієнтові теж: продукт має бачити, що відповіла не
    // основна модель, — інакше деградація знову стає невидимою.
    attempts: result.attempts,
    totalLatencyMs: result.totalLatencyMs,
  });
}

function readMessages(body: CompleteBody): ChatMessage[] | null {
  if (typeof body.prompt === 'string' && body.prompt.trim()) {
    return [{ role: 'user', content: body.prompt }];
  }
  if (!Array.isArray(body.messages) || body.messages.length === 0) return null;

  const out: ChatMessage[] = [];
  for (const raw of body.messages) {
    if (typeof raw !== 'object' || raw === null) return null;
    const { role, content } = raw as { role?: unknown; content?: unknown };
    if (role !== 'system' && role !== 'user' && role !== 'assistant') return null;
    if (typeof content !== 'string') return null;
    out.push({ role, content });
  }
  return out;
}

function clampInt(v: unknown, min: number, max: number, fallback: number): number {
  const n = typeof v === 'number' ? Math.trunc(v) : NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function clampFloat(v: unknown, min: number, max: number, fallback: number): number {
  const n = typeof v === 'number' ? v : NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
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
