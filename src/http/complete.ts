/**
 * Ядро /v1/complete — без HTTP: тіло запиту на вході, статус, тіло відповіді й
 * запис журналу на виході.
 *
 * Виділено з двох причин. Кожна гілка — і відповідь, і відмова — мусить дати
 * рядок журналу, а коли їх вісім і кожна робила `send` сама, одна неминуче
 * забула б. І пісочниця панелі кличе рівно це ядро від імені продукту: запит
 * звідти проходить ту саму стелю, заглушку й драбину, що й справжній, — інакше
 * перевірка в пісочниці доводила б лише, що працює пісочниця.
 */
import type { CatalogHandle } from '../catalog/index.js';
import type { Ladder, LadderResult } from '../ladder/run.js';
import { UnknownTierError } from '../ladder/run.js';
import type { Budget } from '../accounting/budget.js';
import type { ChatMessage } from '../upstream/types.js';
import type { JournalEntry, RequestSource, TraceContext } from '../journal/journal.js';
import { readScenario, StubScenarioError, type Scenario, type Stub } from '../stub/run.js';

export interface Caps {
  product: number;
  subject: number;
}

export interface CompleteDeps {
  catalog: CatalogHandle;
  ladder: Ladder;
  budget: Budget;
  stub?: Stub;
  /** Стелі цього продукту — з перекриттям у налаштуваннях. */
  caps: (product: string) => Caps;
}

export interface CompleteInput {
  product: string;
  source: RequestSource;
  /** Тіло як рядок (з мережі) або вже розібране (пісочниця). */
  body: string | Record<string, unknown>;
  trace?: TraceContext | null;
  /** Пісочниця платить зі свого гаманця, хоч би що написали в тілі. */
  subjectOverride?: string;
}

export interface CompleteOutcome {
  status: number;
  body: Record<string, unknown>;
  entry: JournalEntry;
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

export async function runComplete(deps: CompleteDeps, input: CompleteInput): Promise<CompleteOutcome> {
  const started = Date.now();
  const entry: JournalEntry = {
    at: new Date(started),
    source: input.source,
    product: input.product,
    subject: null,
    requestId: null,
    trace: input.trace ?? null,
    tier: null,
    stub: false,
    params: null,
    input: null,
    output: null,
    status: 0,
    error: null,
    errorDetail: null,
    model: null,
    pool: null,
    rung: null,
    attempts: [],
    latencyMs: 0,
  };

  const done = (status: number, body: Record<string, unknown>): CompleteOutcome => {
    entry.status = status;
    if (status >= 400) {
      entry.error = typeof body['error'] === 'string' ? body['error'] : `http_${status}`;
      entry.errorDetail = typeof body['detail'] === 'string' ? body['detail'] : null;
    }
    if (body['stub'] === true) entry.stub = true;
    entry.latencyMs = Date.now() - started;
    return { status, body, entry };
  };

  try {
    return await handle(deps, input, entry, done);
  } catch (err) {
    // Непередбачене — теж рядок журналу: 500 без сліду і є та невидима
    // деградація, від якої журнал заводився.
    const out = done(500, { error: 'internal' });
    entry.errorDetail = (err as Error).message;
    return out;
  }
}

async function handle(
  deps: CompleteDeps,
  input: CompleteInput,
  entry: JournalEntry,
  done: (status: number, body: Record<string, unknown>) => CompleteOutcome,
): Promise<CompleteOutcome> {
  let body: CompleteBody;
  if (typeof input.body === 'string') {
    try {
      body = JSON.parse(input.body) as CompleteBody;
    } catch (err) {
      // Сире тіло, що не розібралось, — теж вхід: без нього не видно, що саме
      // продукт надіслав. Обрізане: це вже не JSON, і розміру тут ніхто не стеріг.
      entry.input = input.body.slice(0, 10_000);
      return done(400, { error: 'bad_request', detail: (err as Error).message });
    }
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      entry.input = body;
      return done(400, { error: 'bad_request', detail: 'тіло має бути JSON-об’єктом' });
    }
  } else {
    body = input.body as CompleteBody;
  }

  entry.subject = input.subjectOverride
    ?? (typeof body.subject === 'string' && body.subject ? body.subject.slice(0, 200) : null);
  entry.requestId = typeof body.request_id === 'string' ? body.request_id.slice(0, 100) : null;

  const messages = readMessages(body);
  entry.input = messages ?? body.messages ?? body.prompt ?? null;

  const tier = typeof body.tier === 'string' ? body.tier : null;
  entry.tier = tier;
  if (!tier) return done(400, { error: 'bad_request', detail: 'потрібен tier' });
  if (!messages) return done(400, { error: 'bad_request', detail: 'потрібен messages[] або prompt' });

  const subject = entry.subject;
  const maxTokens = clampInt(body.max_tokens, 1, 32_000, 512);
  const temperature = clampFloat(body.temperature, 0, 2, 0.3);
  entry.params = { max_tokens: maxTokens, temperature };

  const catalog = deps.catalog.current();
  // Тир звіряється ДО заглушки: помилка інтеграції лишається помилкою
  // інтеграції, хоч би хто відповідав. Драбина перевіряє те саме, але
  // заглушка в режимі `always` до неї не доходить.
  if (!catalog.tiers.has(tier)) {
    return done(400, {
      error: 'unknown_tier',
      detail: `тир "${tier}" не оголошений; є: ${catalog.tierNames.join(', ') || '(жодного)'}`,
      tiers: catalog.tierNames,
    });
  }

  const product = input.product;
  const caps = deps.caps(product);
  const stubRoute = deps.stub?.route(product, subject) ?? null;
  // Мітки сценаріїв діють лише там, де заглушка відповідає замість моделей:
  // у `fallback` і без заглушки `[stub:…]` — просто текст для моделі.
  let scenario: Scenario | null = null;
  if (stubRoute?.mode === 'always') {
    try {
      scenario = readScenario(messages);
    } catch (err) {
      if (err instanceof StubScenarioError) return done(400, { error: 'bad_request', detail: err.message, stub: true });
      throw err;
    }
    if (scenario === 'budget') {
      // Та сама форма, що й у справжньої стелі, — продукт має пройти ту саму
      // гілку «передати людині». Лічильник не чіпається: стеля не вичерпана.
      return done(429, {
        error: 'budget_exhausted', scope: 'product', used: caps.product, cap: caps.product,
        degrade: 'human_handoff', stub: true,
      });
    }
  }

  // Стеля рахується ПЕРЕД викликом: обірваний на півдорозі запит спалив ті
  // токени, які спалив.
  const verdict = await deps.budget.consume({
    product,
    productCap: caps.product,
    subject,
    subjectCap: caps.subject,
  });

  if (!verdict.allowed) {
    // 429, а не 402. Стеля тут — не білінг: продукт мусить деградувати в
    // передачу людині, а не виставити клієнтові рахунок. Ця властивість
    // перенесена з обох копій spend.ts свідомо.
    return done(429, {
      error: 'budget_exhausted',
      scope: verdict.scope,
      used: verdict.used,
      cap: verdict.cap,
      degrade: 'human_handoff',
    });
  }

  const stubRequest = { product, subject, tier, messages, maxTokens, temperature, scenario };
  let result: LadderResult;
  let stubbed = false;
  if (stubRoute?.mode === 'always') {
    result = await deps.stub!.run(stubRequest);
    stubbed = true;
  } else {
    try {
      result = await deps.ladder.run(catalog, { tier, messages, maxTokens, temperature });
    } catch (err) {
      if (err instanceof UnknownTierError) {
        return done(400, { error: 'unknown_tier', detail: err.message, tiers: catalog.tierNames });
      }
      throw err;
    }
    if (!result.ok && stubRoute?.mode === 'fallback') {
      // Справжні спроби лишаються в `attempts` і в обліку: те, що моделі
      // лежали, — факт, який заглушка не має ховати. Сходинки заглушки
      // йдуть номерами ПІСЛЯ справжніх.
      result = appendStub(result, await deps.stub!.run(stubRequest), catalog.tiers.get(tier)!.length);
      stubbed = true;
    }
  }

  entry.attempts = result.attempts;
  entry.stub = stubbed;
  entry.model = result.model;
  entry.pool = result.pool;
  entry.rung = result.rung;

  if (!result.ok) {
    const last = [...result.attempts].reverse().find((a) => a.outcome !== 'skipped') ?? result.attempts.at(-1);
    const outcome = done(503, {
      error: 'all_rungs_failed',
      tier,
      attempts: result.attempts,
      totalLatencyMs: result.totalLatencyMs,
      ...(stubbed ? { stub: true } : {}),
    });
    // Причина — остання справжня спроба: «all_rungs_failed» сам по собі не
    // каже, що саме лягло.
    entry.errorDetail = last ? `${last.model}: ${last.outcome}${last.detail ? ` — ${last.detail}` : ''}` : null;
    return outcome;
  }

  entry.output = result.content;
  return done(200, {
    content: result.content,
    model: result.model,
    pool: result.pool,
    rung: result.rung,
    tier,
    // Спроби віддаються клієнтові теж: продукт має бачити, що відповіла не
    // основна модель, — інакше деградація знову стає невидимою.
    attempts: result.attempts,
    totalLatencyMs: result.totalLatencyMs,
    ...(stubbed ? { stub: true } : {}),
  });
}

function appendStub(real: LadderResult, stub: LadderResult, offset: number): LadderResult {
  return {
    ...stub,
    rung: stub.rung === null ? null : stub.rung + offset,
    attempts: [...real.attempts, ...stub.attempts.map((a) => ({ ...a, rung: a.rung + offset }))],
    totalLatencyMs: real.totalLatencyMs + stub.totalLatencyMs,
  };
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
