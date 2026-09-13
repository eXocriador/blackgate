/**
 * Здоров'я пулів — наперед, а не за рахунок клієнта.
 *
 * Сьогоднішній збій був дорогим саме тому, що стан пулу з'ясовувався запитом
 * користувача: кожна сходинка драбини платила власним 429, по черзі, і лише
 * остання з них поверталась ні з чим. Тут сервіс періодично пробує по одній
 * дешевій моделі з кожного пулу і тримає відповідь; драбина пропускає відомо
 * мертвий пул, не витрачаючи на нього чужий запит.
 *
 * Стан пулу, а не моделі. 429 у цих апстрімів — властивість метра, і перевірено,
 * що він спільний: 2026-09-13 десять id пулу `gemini-premium` віддали 429 в один
 * і той самий момент, поки `gemini-lite` відповідав 200.
 */
import type { Gateway } from '../upstream/gateway.js';
import type { ResolvedCatalog } from '../catalog/index.js';

export type PoolState = 'healthy' | 'exhausted' | 'down' | 'unknown';

export interface PoolStatus {
  pool: string;
  state: PoolState;
  /** Коли пробували востаннє. */
  checkedAt: string | null;
  /** Доки вважаємо вичерпаним — після цього драбина знову його спробує. */
  cooldownUntil: string | null;
  latencyMs: number | null;
  detail: string | null;
}

export interface PoolHealthConfig {
  gateway: Gateway;
  catalog: () => ResolvedCatalog;
  /** Пауза між обходами всіх пулів. Дефолт 5 хв. */
  intervalMs?: number;
  /**
   * Скільки тримати пул «вичерпаним» після 429, коли апстрім не сказав інакше.
   * Дефолт 10 хв.
   *
   * Квота цих апстрімів міряється не хвилинами: пул `gemini-premium` лежав
   * добами. Але й тримати його чорним на добу не можна — відновлення ми
   * побачимо лише пробою, і десять хвилин це компроміс між «одразу помітили»
   * і «не довбемо вичерпаний метр».
   */
  cooldownMs?: number;
  now?: () => number;
  logInfo?: (event: string, fields?: Record<string, unknown>) => void;
  logWarn?: (event: string, fields?: Record<string, unknown>) => void;
}

interface Entry {
  state: PoolState;
  checkedAt: number | null;
  cooldownUntil: number | null;
  latencyMs: number | null;
  detail: string | null;
}

export function createPoolHealth(config: PoolHealthConfig) {
  const intervalMs = config.intervalMs ?? 300_000;
  const cooldownMs = config.cooldownMs ?? 600_000;
  const now = config.now ?? (() => Date.now());
  const entries = new Map<string, Entry>();

  function entry(pool: string): Entry {
    let e = entries.get(pool);
    if (!e) {
      e = { state: 'unknown', checkedAt: null, cooldownUntil: null, latencyMs: null, detail: null };
      entries.set(pool, e);
    }
    return e;
  }

  /**
   * Чи варто зараз посилати запит у цей пул.
   *
   * `unknown` — ВАРТО. Пул, якого ще не пробували, не є мертвим, і сервіс, що
   * відмовляв би до першого обходу, був би непридатним перші п'ять хвилин
   * життя. Невідомість тут — привід спробувати, а не привід не пробувати.
   */
  function usable(pool: string): boolean {
    const e = entries.get(pool);
    if (!e) return true;
    if (e.state === 'healthy' || e.state === 'unknown') return true;
    return e.cooldownUntil !== null && now() >= e.cooldownUntil;
  }

  /**
   * Записати те, що дізнались зі СПРАВЖНЬОГО клієнтського запиту.
   *
   * Це важливіше за періодичну пробу і мусить діяти одразу: клієнт щойно
   * заплатив своїм часом за факт, який проба дізналась би через кілька хвилин.
   */
  function observe(pool: string, outcome: string, retryAfterMs: number | null): void {
    const e = entry(pool);
    if (outcome === 'exhausted') {
      e.state = 'exhausted';
      e.checkedAt = now();
      e.cooldownUntil = now() + (retryAfterMs ?? cooldownMs);
      e.detail = retryAfterMs !== null ? `429, retry-after ${retryAfterMs} мс` : '429';
      config.logWarn?.('pool.exhausted', { pool, cooldownMs: retryAfterMs ?? cooldownMs });
    } else if (outcome === 'ok') {
      e.state = 'healthy';
      e.checkedAt = now();
      e.cooldownUntil = null;
      e.detail = null;
    }
    // 'rejected' і 'retired' — властивості МОДЕЛІ, не пулу: сусід по пулу може
    // відповідати як ні в чому не бувало. Стан пулу вони не чіпають.
  }

  /**
   * Штрафний ящик на МОДЕЛЬ.
   *
   * Окремий від пулу, бо причини різні: пул вичерпується метром (429), а модель
   * буває недоступна сама по собі — `auth_unavailable`, «No capacity available
   * for model …», 400 на форму запиту. Без цього ящика драбина щоразу платила
   * б повним таймаутом за ту саму мертву сходинку, хоч уже знає про неї.
   */
  const modelPenalty = new Map<string, { until: number; why: string }>();

  function modelUsable(model: string): boolean {
    const p = modelPenalty.get(model);
    if (!p) return true;
    if (now() >= p.until) {
      modelPenalty.delete(model);
      return true;
    }
    return false;
  }

  function observeModel(model: string, outcome: string, httpStatus: number | null): void {
    if (outcome === 'ok') {
      modelPenalty.delete(model);
      return;
    }
    // 429 — це пул, не модель; сюди він не потрапляє.
    if (outcome === 'error' || outcome === 'unauthorized' || outcome === 'rejected' || outcome === 'retired') {
      modelPenalty.set(model, {
        until: now() + cooldownMs,
        why: `${outcome}${httpStatus ? ` (${httpStatus})` : ''}`,
      });
      config.logWarn?.('model.penalised', { model, outcome, httpStatus });
    }
  }

  function penalties(): Array<{ model: string; until: string; why: string }> {
    return [...modelPenalty].map(([model, p]) => ({
      model, until: new Date(p.until).toISOString(), why: p.why,
    }));
  }

  async function probePool(pool: string): Promise<void> {
    const cat = config.catalog();
    const spec = cat.pools.get(pool);
    if (!spec) return;
    const model = cat.models.get(spec.probe);
    if (!model) return;

    const res = await config.gateway.call({
      model: model.id,
      messages: [{ role: 'user', content: 'ping' }],
      // Найдешевша можлива проба: один токен відповіді. Здоров'я пулу — це
      // «чи пускає метр», а не «чи добре думає модель».
      maxTokens: 1,
      temperature: 0,
      timeoutMs: Math.min(model.timeout_ms, 15_000),
    });

    const e = entry(pool);
    e.checkedAt = now();
    e.latencyMs = res.latencyMs;

    switch (res.outcome) {
      case 'ok':
        e.state = 'healthy';
        e.cooldownUntil = null;
        e.detail = null;
        break;
      case 'exhausted':
        e.state = 'exhausted';
        e.cooldownUntil = now() + (res.retryAfterMs ?? cooldownMs);
        e.detail = '429 RESOURCE_EXHAUSTED';
        break;
      case 'error':
      case 'timeout':
      case 'unauthorized':
        /**
         * 5xx від ОДНІЄЇ моделі не є вироком пулу — і це не обережність, а
         * спостереження. 2026-09-13, в один і той самий момент:
         *
         *   gemini-2.5-flash-lite  500 auth_unavailable: no auth available
         *   gemini-2.5-flash       503 No capacity available for model …
         *   gemini-3.5-flash-lite  503 No capacity available for model …
         *   gemini-3.1-flash-lite  200
         *   gemini-3.1-flash-image 200
         *   tab_flash_lite_preview 200
         *
         * Шість моделей одного пулу, три мертві й три живі. Метр тут ні до
         * чого: це доступність КОНКРЕТНОЇ моделі. Пул, оголошений мертвим за
         * такою пробою, забрав би в драбини три робочі сходинки — рівно та
         * шкода, від якої сервіс мав рятувати, тільки з іншого боку.
         *
         * Тому проба каже «не знаю», а не «мертвий»: `unknown` придатний, і
         * драбина далі його пробує. Мертвою при цьому вважається сама модель
         * — це записує `observeModel` нижче.
         *
         * Недосяжний шлюз (httpStatus === null) — інша річ: він спільний для
         * всіх пулів, і тоді `down` чесний.
         */
        if (res.httpStatus === null) {
          e.state = 'down';
          e.cooldownUntil = now() + cooldownMs;
          e.detail = `шлюз недосяжний: ${res.outcome}`;
        } else {
          e.state = 'unknown';
          e.cooldownUntil = null;
          e.detail = `проба "${model.id}" віддала ${res.httpStatus} — це стан моделі, не пулу`;
          observeModel(model.id, res.outcome, res.httpStatus);
        }
        break;

      case 'retired':
        // Проба виведеною з експлуатації моделлю — це помилка РЕЄСТРУ, і
        // `resolveCatalog` її не пускає. Якщо вона сюди дійшла, апстрім вивів
        // модель уже після того, як реєстр пройшов перевірку. Пул при цьому не
        // мертвий — мертва проба, і казати про пул ми не маємо права.
        e.state = 'unknown';
        e.cooldownUntil = null;
        e.detail = `проба "${model.id}" віддає підроблений 200 — заміни probe у реєстрі`;
        config.logWarn?.('pool.probe_retired', { pool, probe: model.id });
        break;
      default:
        e.state = 'down';
        e.cooldownUntil = now() + cooldownMs;
        e.detail = `${res.outcome}${res.httpStatus ? ` (${res.httpStatus})` : ''}`;
        break;
    }
  }

  async function sweep(): Promise<void> {
    for (const pool of config.catalog().poolNames) {
      // По черзі, не паралельно: одночасні проби чотирьох пулів — це чотири
      // запити в той самий шлюз в один момент, і на вичерпаному метрі вони
      // лише пришвидшують наступний 429.
      await probePool(pool).catch((err) => {
        config.logWarn?.('pool.probe_failed', { pool, error: (err as Error).message });
      });
    }
    config.logInfo?.('pool.sweep_done', { pools: snapshot().map((p) => `${p.pool}:${p.state}`) });
  }

  function snapshot(): PoolStatus[] {
    return config.catalog().poolNames.map((pool) => {
      const e = entries.get(pool);
      return {
        pool,
        state: e?.state ?? 'unknown',
        checkedAt: e?.checkedAt ? new Date(e.checkedAt).toISOString() : null,
        cooldownUntil: e?.cooldownUntil ? new Date(e.cooldownUntil).toISOString() : null,
        latencyMs: e?.latencyMs ?? null,
        detail: e?.detail ?? null,
      };
    });
  }

  let timer: ReturnType<typeof setInterval> | undefined;
  function start(): void {
    if (timer) return;
    timer = setInterval(() => void sweep(), intervalMs);
    timer.unref();
  }
  function stop(): void {
    if (timer) clearInterval(timer);
    timer = undefined;
  }

  return { usable, observe, modelUsable, observeModel, penalties, probePool, sweep, snapshot, start, stop };
}

export type PoolHealth = ReturnType<typeof createPoolHealth>;
