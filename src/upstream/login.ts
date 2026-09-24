/**
 * Вхід апстріму: чи пускає нас VibeConduit і чи має він сам вхід до Google.
 *
 * Окремо від здоров'я пулів, бо питання інше. Пул відповідає на «чи пускає
 * метр» (429), модель — на «чи жива ця модель» (5xx, 400, надгробок), а тут —
 * на «чи є в шлюзу вхід узагалі». Доти цього стану не було: протухла
 * автентифікація Google давала 5xx/401 кожній моделі окремо, кожна йшла в
 * штрафний ящик, пули ставали `unknown` — придатні, — і `/health/ready` та Kuma
 * лишались зеленими, поки продукти отримували 503 `all_rungs_failed`. Сигнал
 * жив лише в `ai_call` (connectors.md §6.2/§6.7 — вада, яку relic свідомо не
 * скопіював).
 *
 * Стани, як `checks.<адаптер>` у relic:
 *   ok       — шлюз відповідає, і хоч одна відповідь після останньої відмови
 *              входу пройшла через Google;
 *   expired  — вхід відхилено в КІЛЬКОХ пулах, і відтоді жодної відповіді:
 *              сам не полагодиться, потрібна людина (README, «Коли протухла
 *              автентифікація Google»);
 *   down     — до шлюзу не дійти (відмова з'єднання, DNS, скидання);
 *   unknown  — ще жодної відповіді (лише на старті, до першої проби).
 *
 * `expired` і `down` валять `/health/ready` (503). 429 і вичерпаний пул — НЕ
 * вирок: це метр, штатний стан, і він навіть доводить, що вхід живий.
 */
import type { ResolvedCatalog } from '../catalog/index.js';
import type { CallResult } from './gateway.js';

export type UpstreamState = 'ok' | 'expired' | 'down' | 'unknown';

/**
 * Ознаки відмови ВХОДУ — з реального `ai_call.detail` і живої відповіді
 * шлюзу, не вгадані:
 *
 *   500 `{"error":{"message":"auth_unavailable: no auth available",…}}`
 *       — у VibeConduit немає придатного файла автентифікації Google
 *         (`ai_call` 2, 736, 1173; 2026-09-13/15/16);
 *   401 `{"error":"Invalid API key"}` — шлюз не приймає наш `GATEWAY_API_KEY`
 *       (перевірено прямим запитом 2026-09-24, і на `/v1/models`, і на
 *       `/v1/chat/completions`); 403 — те саме іншими словами.
 *
 * Усі три рядки `auth_unavailable` в історії — ОДНА модель, поки сусіди
 * відповідали. Тому одна така відповідь лишається штрафом моделі (як і було),
 * а вироком входу стає лише тоді, коли її бачать кілька пулів.
 */
export function isLoginFailure(res: Pick<CallResult, 'outcome' | 'error'>): boolean {
  if (res.outcome === 'unauthorized') return true;
  return res.outcome === 'error' && /auth_unavailable|no auth available/i.test(res.error ?? '');
}

/**
 * Що доводить, що вхід живий: відповідь моделі або 429 метра. Обидва означають,
 * що шлюз нас пустив і запит дійшов до Google з чиїмсь входом. 400, 5xx без
 * ознаки входу, надгробок і таймаут — нейтральні: вони про модель, а не про вхід.
 */
function provesLogin(res: Pick<CallResult, 'outcome'>): boolean {
  return res.outcome === 'ok' || res.outcome === 'exhausted';
}

export interface UpstreamStatus {
  state: UpstreamState;
  /** Людською мовою: що саме не так і що робити. */
  detail: string | null;
  /** Коли стан став таким. */
  since: string | null;
}

export interface UpstreamHealthConfig {
  catalog: () => ResolvedCatalog;
  /**
   * Скільки пам'ятати відмову входу. Проба обходить усі пули кожні
   * `POOL_PROBE_INTERVAL_MS`, тож при справжній відмові свіжі докази
   * приходять щообходу; старіша за вікно відмова одного пулу не має
   * складатися з сьогоднішньою відмовою іншого у вирок.
   */
  windowMs: number;
  now?: () => number;
  logInfo?: (event: string, fields?: Record<string, unknown>) => void;
  logWarn?: (event: string, fields?: Record<string, unknown>) => void;
}

interface Failure {
  model: string;
  at: number;
  why: string;
}

export function createUpstreamHealth(config: UpstreamHealthConfig) {
  const now = config.now ?? (() => Date.now());

  /** Відмови входу після останнього доказу живого входу — по одній на пул. */
  const failures = new Map<string, Failure>();
  let seenAny = false;
  /** Остання спроба не дійшла до шлюзу. Знімається першою ж відповіддю з кодом. */
  let unreachable: string | null = null;

  let current: UpstreamState = 'unknown';
  let since: number | null = null;

  function observe(model: string, res: CallResult): void {
    // Модель, якої вже немає в реєстрі (перечитали посеред запиту), — пул
    // невідомий; її слово про вхід нічого не варте.
    const pool = config.catalog().models.get(model)?.pool;

    if (res.unreachable) {
      unreachable = res.error ?? res.outcome;
    } else if (res.httpStatus !== null) {
      // Таймаут (без коду статусу, але й не `unreachable`) нічого не каже
      // про досяжність: з'єднання було, моделі забракло часу. Тому лише
      // відповідь з кодом знімає `down`.
      unreachable = null;
      seenAny = true;
      if (provesLogin(res)) {
        failures.clear();
      } else if (pool && isLoginFailure(res)) {
        failures.set(pool, {
          model,
          at: now(),
          why: `${res.httpStatus} ${(res.error ?? res.outcome).slice(0, 120)}`,
        });
      }
    }
    settle();
  }

  function fresh(): Array<[string, Failure]> {
    const cutoff = now() - config.windowMs;
    return [...failures].filter(([, f]) => f.at >= cutoff);
  }

  /**
   * Скільки пулів мусять бачити відмову. Два — бо одна модель із
   * `auth_unavailable` серед живих сусідів уже траплялась тричі й не була
   * протухлим входом. Реєстр з одним пулом інакше не дійшов би до вироку ніколи.
   */
  function threshold(): number {
    return Math.max(1, Math.min(2, config.catalog().poolNames.length));
  }

  function compute(): { state: UpstreamState; detail: string | null } {
    if (unreachable !== null) {
      return { state: 'down', detail: `шлюз недосяжний: ${unreachable}` };
    }
    const f = fresh();
    if (f.length >= threshold()) {
      return {
        state: 'expired',
        detail:
          `вхід відхилено в ${f.length} пулах: ` +
          f.map(([pool, x]) => `${pool}/${x.model} ${x.why}`).join('; ') +
          ' — перелогінити акаунт у VibeConduit або звірити GATEWAY_API_KEY (README, «Коли протухла автентифікація Google»)',
      };
    }
    return { state: seenAny ? 'ok' : 'unknown', detail: null };
  }

  function settle(): void {
    const next = compute();
    if (next.state === current) return;
    const log = next.state === 'ok' ? config.logInfo : config.logWarn;
    log?.('upstream.state', { from: current, to: next.state, detail: next.detail });
    current = next.state;
    since = now();
  }

  /** Стан рахується і під час читання: вікно відмов спливає без нових запитів. */
  function status(): UpstreamStatus {
    settle();
    const { detail } = compute();
    return { state: current, detail, since: since === null ? null : new Date(since).toISOString() };
  }

  return { observe, status };
}

export type UpstreamHealth = ReturnType<typeof createUpstreamHealth>;

/** Чи валить цей стан пробу готовності. `unknown` — лише до першої відповіді. */
export function failsReady(state: UpstreamState): boolean {
  return state === 'expired' || state === 'down';
}

/**
 * `/health/ready` kit плюс вхід апстріму — поруч з інфраструктурою, своїми
 * словами (`checks.upstream`: ok / expired / down / unknown), як
 * `checks.telegram-archive` у relic. Перевірки kit знають лише ok/fail/skip,
 * тому стан дописується поверх їхньої відповіді, а не стає ще однією з них.
 * Причина — поле `upstream.detail`: проба без ключа, але в ній лише імена
 * пулів і моделей та відповідь шлюзу, секретів там немає.
 */
export function withUpstream(
  infra: { live(): Response | Promise<Response>; ready(): Response | Promise<Response> },
  upstream: UpstreamHealth,
) {
  return {
    live: () => infra.live(),
    async ready(): Promise<Response> {
      const res = await infra.ready();
      const body = (await res.json()) as {
        status: string;
        version: string;
        checks: Record<string, string>;
        upstream?: UpstreamStatus;
      };
      const up = upstream.status();
      body.checks.upstream = up.state;
      body.upstream = up;
      const ok = res.status === 200 && !failsReady(up.state);
      body.status = ok ? 'ok' : 'fail';
      return Response.json(body, { status: ok ? 200 : 503, headers: { 'Cache-Control': 'no-store' } });
    },
  };
}
