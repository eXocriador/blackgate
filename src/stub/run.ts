/**
 * Заглушка — фальшивий апстрім, а не фальшивий blackgate.
 *
 * Підмінюється рівно одне: ТРАНСПОРТ до моделей. Ключ продукту, стелі,
 * драбина з ретраями й відступами, класифікація відмов, коди відповіді й
 * облік в `ai_call` лишаються справжніми — заглушка проходить крізь ту саму
 * `createLadder`, що й моделі. Інакше перевірка з нею доводила б лише, що
 * продукт уміє читати заглушку.
 *
 * Два фальшиві пули (`stub-a`, `stub-b`) і по моделі в кожному: драбині є
 * куди спуститись, і інваріант реєстру «сусідні сходинки — різні пули»
 * виконується, як і для справжніх тирів.
 *
 * Сценарій вибирається міткою в тексті повідомлення — `[stub:429]` тощо, — бо
 * це єдине, що будь-який продукт уже вміє передати без правок коду.
 */
import { parseCatalog, type ResolvedCatalog } from '../catalog/index.js';
import { createPoolHealth } from '../pools/health.js';
import { createLadder, type LadderResult } from '../ladder/run.js';
import type { CallRequest, CallResult, Gateway } from '../upstream/gateway.js';
import type { ChatMessage } from '../upstream/types.js';
import { cannedFor, routeFor, type StubConfig, type StubRoute } from './config.js';
import { findSchema, instanceOf } from './schema-json.js';

export const STUB_TIER = 'stub';
export const STUB_PRIMARY = 'stub-primary';
export const STUB_FALLBACK = 'stub-fallback';

/**
 * `timeout_ms: 1000` — найменше, що пропускає схема реєстру: сценарій `slow`
 * справді чекає таймаут моделі, і з ретраями це кілька секунд, а не хвилина.
 */
const STUB_CATALOG = `
version: 1
pools:
  stub-a: { upstream: stub, probe: ${STUB_PRIMARY} }
  stub-b: { upstream: stub, probe: ${STUB_FALLBACK} }
models:
  - { id: ${STUB_PRIMARY},  pool: stub-a, timeout_ms: 1000 }
  - { id: ${STUB_FALLBACK}, pool: stub-b, timeout_ms: 1000 }
tiers:
  ${STUB_TIER}: [${STUB_PRIMARY}, ${STUB_FALLBACK}]
`;

/**
 * Що робить основна сходинка заглушки. Запасна відповідає завжди, крім `all-fail`.
 *
 *   429       пул вичерпаний → спуск на `stub-b`
 *   500       5xx → ретраї з відступом, далі спуск
 *   slow      таймаут моделі → ретраї, далі спуск
 *   retired   підроблений 200 (модель виведена) → спуск
 *   rejected  400 на форму запиту → спуск без ретраїв
 *   empty     200 з порожньою відповіддю — відповідь, а не збій
 *   all-fail  обидві сходинки 5xx → 503 all_rungs_failed
 *   budget    стеля «вичерпана» → 429 budget_exhausted, моделі не питаються
 */
export const SCENARIOS = ['429', '500', 'slow', 'retired', 'rejected', 'empty', 'all-fail', 'budget'] as const;
export type Scenario = (typeof SCENARIOS)[number];

export class StubScenarioError extends Error {
  constructor(name: string) {
    super(`невідомий сценарій заглушки [stub:${name}]; є: ${SCENARIOS.join(', ')}`);
    this.name = 'StubScenarioError';
  }
}

const MARKER = /\[stub:([a-z0-9-]+)\]/gi;

/**
 * Мітка з НАЙСВІЖІШОГО повідомлення, що її має. Друкарська помилка в мітці —
 * помилка запиту, а не тиха відповідь без сценарію: інакше тест «спуск
 * драбиною» зеленів би, нічого не перевіривши.
 */
export function readScenario(messages: readonly ChatMessage[]): Scenario | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const found = [...messages[i]!.content.matchAll(MARKER)];
    if (found.length === 0) continue;
    const name = found[found.length - 1]![1]!.toLowerCase();
    if (!(SCENARIOS as readonly string[]).includes(name)) throw new StubScenarioError(name);
    return name as Scenario;
  }
  return null;
}

export interface StubRequest {
  product: string;
  subject: string | null;
  tier: string;
  messages: ChatMessage[];
  maxTokens: number;
  temperature: number;
  scenario: Scenario | null;
}

/**
 * Текст відповіді: готовий із `stub.yaml` → JSON зі схеми в промпті → `[stub]`-текст.
 * Позначка `[stub]` є в кожному з трьох (у готовому — якщо її туди поклали).
 */
export function answerFor(cfg: StubConfig, req: StubRequest, now: Date = new Date()): string {
  const schema = findSchema(req.messages.filter((m) => m.role === 'system').map((m) => m.content));
  const title = typeof schema?.['title'] === 'string' ? schema['title'] : null;

  const canned = cannedFor(cfg, req.product, req.subject, req.tier, title);
  if (canned !== null) return canned;

  if (schema) return JSON.stringify(instanceOf(schema, now));

  const lastUser = [...req.messages].reverse().find((m) => m.role === 'user')?.content ?? '';
  const snippet = lastUser.replace(MARKER, '').replace(/\s+/g, ' ').trim().slice(0, 120);
  return `[stub] Відповідь заглушки blackgate (тир ${req.tier}) на «${snippet}».`;
}

export interface StubDeps {
  config: () => StubConfig;
  /** Ті самі ретраї, що й у справжньої драбини (`LADDER_RETRIES`). */
  retries: number;
  backoffMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

export function createStub(deps: StubDeps) {
  const catalog: ResolvedCatalog = parseCatalog(STUB_CATALOG);
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  function route(product: string, subject: string | null): StubRoute | null {
    return routeFor(deps.config(), product, subject);
  }

  async function run(req: StubRequest): Promise<LadderResult> {
    const content = answerFor(deps.config(), req);
    const gateway = scenarioGateway(req.scenario, content, sleep);
    // Здоров'я пулів СВОЄ на кожен запит: `[stub:429]` одного запиту не має
    // на десять хвилин класти `stub-a` усім наступним — сценарій мусить
    // повторюватись, а не залежати від того, хто питав перед тобою.
    const pools = createPoolHealth({ gateway, catalog: () => catalog });
    const ladder = createLadder({ gateway, pools, retries: deps.retries, backoffMs: deps.backoffMs, sleep });
    return ladder.run(catalog, {
      tier: STUB_TIER,
      messages: req.messages,
      maxTokens: req.maxTokens,
      temperature: req.temperature,
    });
  }

  return { route, run };
}

export type Stub = ReturnType<typeof createStub>;

function scenarioGateway(
  scenario: Scenario | null,
  content: string,
  sleep: (ms: number) => Promise<void>,
): Gateway {
  return {
    async call(req: CallRequest): Promise<CallResult> {
      const primary = req.model === STUB_PRIMARY;
      const fail = scenario === 'all-fail' || primary;
      switch (fail ? scenario : null) {
        case '429':
          return result('exhausted', null, 429, 'stub: 429 RESOURCE_EXHAUSTED');
        case '500':
        case 'all-fail':
          return result('error', null, 500, 'stub: 500 internal');
        case 'slow':
          await sleep(req.timeoutMs);
          return { ...result('timeout', null, null, 'stub: The operation was aborted due to timeout'), latencyMs: req.timeoutMs };
        case 'retired':
          return result('retired', null, 200, 'підроблений 200: stub: model is no longer available');
        case 'rejected':
          return result('rejected', null, 400, 'stub: 400 INVALID_ARGUMENT');
        case 'empty':
          return result('ok', null, 200, null);
        default:
          return result('ok', content, 200, null);
      }
    },
    async listModels() {
      return [STUB_PRIMARY, STUB_FALLBACK];
    },
  };
}

/**
 * Токени — `null`, не вигадані: `ai_call` рахує справжнє, а заглушка нічого не
 * спалила. Рядки заглушки в обліку відрізняє `pool LIKE 'stub-%'`.
 */
function result(
  outcome: CallResult['outcome'],
  content: string | null,
  httpStatus: number | null,
  error: string | null,
): CallResult {
  return {
    outcome, content, httpStatus, error,
    latencyMs: 0,
    retryAfterMs: null,
    unreachable: false,
    usage: { promptTokens: null, completionTokens: null, totalTokens: null },
  };
}
