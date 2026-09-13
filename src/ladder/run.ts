/**
 * Драбина запасних ходів: спуститись тиром, доки хтось не відповість.
 *
 * Ретраї і коди зібрані ТУТ і більше ніде. Доти вони жили в трьох місцях і
 * різних: `@exo/kit/llm` умів рівно одну підміну моделі, рівно один раз і
 * тільки на 429; exointel і teamself не ретраїли взагалі; exopost мав власний
 * реєстр драйверів на Python. Жодне з трьох не знало про 400 INVALID_ARGUMENT,
 * хоч саме він роками мовчки гасив SMART у exointel.
 */
import type { Gateway, Outcome } from '../upstream/gateway.js';
import type { ResolvedCatalog, ResolvedModel } from '../catalog/index.js';
import type { PoolHealth } from '../pools/health.js';
import type { ChatMessage } from '../upstream/types.js';

export interface Attempt {
  rung: number;
  model: string;
  pool: string;
  outcome: Outcome | 'skipped';
  httpStatus: number | null;
  latencyMs: number;
  /** Скільки разів цю саму модель пробували в межах сходинки (1 = без ретраю). */
  tries: number;
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
  detail: string | null;
}

export interface LadderResult {
  ok: boolean;
  content: string | null;
  model: string | null;
  pool: string | null;
  rung: number | null;
  attempts: Attempt[];
  totalLatencyMs: number;
}

export interface LadderConfig {
  gateway: Gateway;
  pools: PoolHealth;
  /** Скільки разів повторювати ту саму модель на 5xx/мережі. Дефолт 2. */
  retries?: number;
  /** Перший відступ; далі подвоюється. Дефолт 500 мс. */
  backoffMs?: number;
  sleep?: (ms: number) => Promise<void>;
  logWarn?: (event: string, fields?: Record<string, unknown>) => void;
}

export interface LadderRequest {
  tier: string;
  messages: ChatMessage[];
  maxTokens: number;
  temperature: number;
}

export class UnknownTierError extends Error {
  constructor(tier: string, known: readonly string[]) {
    super(`тир "${tier}" не оголошений; є: ${known.join(', ') || '(жодного)'}`);
    this.name = 'UnknownTierError';
  }
}

export function createLadder(config: LadderConfig) {
  const retries = config.retries ?? 2;
  const backoffMs = config.backoffMs ?? 500;
  const sleep = config.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  async function run(catalog: ResolvedCatalog, req: LadderRequest): Promise<LadderResult> {
    const rungs = catalog.tiers.get(req.tier);
    if (!rungs) throw new UnknownTierError(req.tier, catalog.tierNames);

    const started = Date.now();
    const attempts: Attempt[] = [];

    for (const [rung, model] of rungs.entries()) {
      // Відомо мертвий пул пропускаємо, не питаючи. Саме ця перевірка робить
      // драбину дешевою: без неї кожна сходинка платить власним 429, і
      // користувач чекає стільки, скільки їх у тирі.
      if (!config.pools.usable(model.pool)) {
        attempts.push(skipped(rung, model, 'пул відомо вичерпаний'));
        continue;
      }

      const { attempt, content } = await tryRung(rung, model, req);
      attempts.push(attempt);

      if (attempt.outcome === 'ok') {
        return {
          ok: true,
          content,
          model: model.id,
          pool: model.pool,
          rung,
          attempts,
          totalLatencyMs: Date.now() - started,
        };
      }
    }

    return {
      ok: false, content: null, model: null, pool: null, rung: null,
      attempts, totalLatencyMs: Date.now() - started,
    };
  }

  /**
   * Одна сходинка з її ретраями.
   *
   * Текст відповіді повертається ПОРУЧ з `Attempt`, а не всередині нього і не
   * через змінну замикання. Причини дві, і обидві не косметичні:
   *   1. `Attempt` їде в Postgres як опис спроби — модель, пул, латентність,
   *      токени. Відповіді моделі там бути не може;
   *   2. змінна замикання — спільний стан на всі одночасні запити: два
   *      клієнти, що зайшли разом, обмінялися б відповідями.
   */
  async function tryRung(
    rung: number,
    model: ResolvedModel,
    req: LadderRequest,
  ): Promise<{ attempt: Attempt; content: string | null }> {
    let tries = 0;
    let latency = 0;

    for (let i = 0; i <= retries; i++) {
      tries++;
      const res = await config.gateway.call({
        model: model.id,
        messages: req.messages,
        maxTokens: req.maxTokens,
        temperature: req.temperature,
        timeoutMs: model.timeout_ms,
      });
      latency += res.latencyMs;

      config.pools.observe(model.pool, res.outcome, res.retryAfterMs);

      const base: Attempt = {
        rung, model: model.id, pool: model.pool,
        outcome: res.outcome, httpStatus: res.httpStatus, latencyMs: latency, tries,
        promptTokens: res.usage.promptTokens,
        completionTokens: res.usage.completionTokens,
        totalTokens: res.usage.totalTokens,
        detail: res.error,
      };

      switch (res.outcome) {
        case 'ok':
          // Порожня відповідь — це відповідь. Модель відпрацювала, токени
          // пораховані, і мовчання її власна думка, а не збій, який варто
          // латати наступною сходинкою.
          return { attempt: base, content: res.content };

        case 'exhausted':
          // Ретраїти вичерпаний метр тією самою моделлю безглуздо, а чекати
          // `retry-after` всередині запиту користувача — тим паче: пул
          // позначений хворим, і наступна сходинка з ІНШОГО пулу (інваріант
          // реєстру це гарантує) відповість швидше, ніж мине квота.
          return { attempt: base, content: null };

        case 'rejected':
          // 400 INVALID_ARGUMENT: модель відхиляє форму запиту. Не ретраїти —
          // друга така сама спроба дасть ту саму відповідь. Записати, що ця
          // модель у цій формі не працює, й іти далі.
          config.logWarn?.('ladder.model_rejects_shape', {
            model: model.id, status: res.httpStatus, detail: res.error?.slice(0, 200),
          });
          return { attempt: base, content: null };

        case 'retired':
          config.logWarn?.('ladder.model_retired', { model: model.id, detail: res.error });
          return { attempt: base, content: null };

        case 'unauthorized':
          // Ключ до шлюзу поганий — наступна модель не полагодить.
          return { attempt: base, content: null };

        case 'timeout':
        case 'error':
          if (i < retries) {
            await sleep(backoffMs * 2 ** i);
            continue;
          }
          return { attempt: base, content: null };
      }
    }
    // Недосяжно: цикл завжди повертає.
    return { attempt: skipped(rung, model, 'внутрішня помилка драбини'), content: null };
  }

  return { run };
}

function skipped(rung: number, model: ResolvedModel, why: string): Attempt {
  return {
    rung, model: model.id, pool: model.pool, outcome: 'skipped',
    httpStatus: null, latencyMs: 0, tries: 0,
    promptTokens: null, completionTokens: null, totalTokens: null, detail: why,
  };
}

export type Ladder = ReturnType<typeof createLadder>;
