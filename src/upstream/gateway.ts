/**
 * Клієнт до VibeConduit — OpenAI-сумісного шлюзу, що стоїть перед Antigravity,
 * Vertex і gpt-oss.
 *
 * exo-ai стоїть ПЕРЕД шлюзом, а не замість нього: у шлюзі живе автентифікація
 * до Google і Vertex, переписувати її — окрема велика робота без вигоди. Шлюз
 * лишається виходом до провайдерів, exo-ai бере політику — бо політики в
 * шлюзі немає взагалі: ні мапінгу моделей, ні обліку, ні ретраїв, ні лімітів,
 * ні поняття пулу.
 *
 * Цей файл — тільки транспорт: один запит, одна відповідь, класифікація.
 * Ретраї і драбина — у `../ladder`.
 */
import type { ChatMessage } from './types.js';

export type Outcome =
  /** Відповідь є, і вона справжня. */
  | 'ok'
  /** 429: пул вичерпаний. */
  | 'exhausted'
  /** 400: модель відхиляє форму запиту. Ретраїти нема сенсу. */
  | 'rejected'
  /** HTTP 200 із текстом-надгробком замість відповіді — див. нижче. */
  | 'retired'
  /** 5xx або мережа: варте ретраю. */
  | 'error'
  /** Свій таймаут моделі вийшов. */
  | 'timeout'
  /** 401/403 від шлюзу. */
  | 'unauthorized';

export interface Usage {
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
}

export interface CallResult {
  outcome: Outcome;
  content: string | null;
  usage: Usage;
  httpStatus: number | null;
  latencyMs: number;
  /** Скільки чекати перед наступною спробою, якщо апстрім сказав. */
  retryAfterMs: number | null;
  error: string | null;
  /**
   * До шлюзу не дійшли взагалі: відмова з'єднання, DNS, скидання. Властивість
   * ШЛЮЗУ, спільна для всіх моделей і пулів, — на відміну від таймауту, який
   * каже лише, що ця модель не встигла (див. `call`).
   */
  unreachable: boolean;
}

export interface GatewayConfig {
  baseUrl: string;
  apiKey: string;
  fetchImpl?: typeof fetch;
  /**
   * Кожна відповідь шлюзу — і драбини, і проби пулів. Сюди дивиться стан входу
   * апстріму (`./login.ts`): це єдині двері назовні, тож свідок на них бачить
   * усе, хоч би хто стукав.
   */
  onResult?: (req: CallRequest, res: CallResult) => void;
}

export interface CallRequest {
  model: string;
  messages: ChatMessage[];
  maxTokens: number;
  temperature: number;
  timeoutMs: number;
}

/**
 * Підроблений 200.
 *
 * Знахідка живої проби 2026-09-13, і найдорожча з усіх: три моделі
 * (`gemini-3.5-flash-low`, `gemini-3.5-flash-extra-low`, `gemini-3-flash-agent`)
 * виведені апстрімом з експлуатації, але шлюз віддає на них HTTP **200** —
 * не 404 і не 400 — з тілом, де `model: "model"`, `usage: null`, а в
 * `choices[0].message.content` лежить «Gemini 3.5 Flash is no longer
 * available. Please switch to…».
 *
 * Наслідки, якби цього детектора не було, обидва тихі:
 *   1. проба здоров'я, що дивиться на код статусу, назве пул здоровим;
 *   2. продукт, що читає `content`, покаже цей текст користувачеві ЯК
 *      ВІДПОВІДЬ МОДЕЛІ.
 *
 * Позначка `retired:` у реєстрі закриває три відомі id. Детектор закриває
 * четвертий, якого ще ніхто не бачив: ознака структурна (шлюз не зміг назвати
 * модель і не має чого рахувати), тож ловиться без списку.
 */
export function isCounterfeit(body: unknown): boolean {
  if (typeof body !== 'object' || body === null) return false;
  const b = body as Record<string, unknown>;
  // Ехо моделі буквально "model" — шлюз не знав, що відповідає, бо відповідав
  // не апстрім, а сам шлюз.
  const echoIsPlaceholder = b['model'] === 'model';
  // Справжня відповідь ЗАВЖДИ несе usage: перевірено на всіх живих моделях
  // усіх чотирьох пулів (gemini, claude через Vertex, gpt-oss).
  const noUsage = b['usage'] === null || b['usage'] === undefined;
  return echoIsPlaceholder && noUsage;
}

export function createGateway(config: GatewayConfig) {
  const doFetch = config.fetchImpl ?? ((...a: Parameters<typeof fetch>) => globalThis.fetch(...a));
  const base = config.baseUrl.replace(/\/+$/, '');

  async function call(req: CallRequest): Promise<CallResult> {
    const res = await send(req);
    config.onResult?.(req, res);
    return res;
  }

  async function send(req: CallRequest): Promise<CallResult> {
    const started = Date.now();
    const blank: Usage = { promptTokens: null, completionTokens: null, totalTokens: null };

    let res: Response;
    try {
      res = await doFetch(`${base}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify({
          model: req.model,
          max_tokens: req.maxTokens,
          temperature: req.temperature,
          messages: req.messages,
        }),
        // Свій таймаут на модель, а не один на всіх. `@exo/kit/llm` зашив
        // 30_000 для будь-чого, і роздум `claude-opus-4-6-thinking` через це
        // невідрізненний від мертвого `flash-lite`.
        signal: AbortSignal.timeout(req.timeoutMs),
      });
    } catch (err) {
      /**
       * Таймаут і недосяжний шлюз — різні речі, хоч коду статусу немає в обох.
       *
       * Доти обидва йшли з `httpStatus: null`, і проба пулу читала це як
       * «шлюз недосяжний». 2026-09-23 14:35Z проба `gemini-premium` не
       * встигла за 15 с — і весь пул став `down`, хоч шлюз відповідав іншим
       * пулам у ту саму хвилину. Таймаут — це `AbortSignal.timeout` моделі:
       * з'єднання було, не було відповіді. Недосяжний — коли з'єднання не
       * вийшло або обірвалось: це вже шлюз, і він спільний для всіх.
       */
      const timedOut = isTimeout(err);
      return {
        outcome: timedOut ? 'timeout' : 'error',
        content: null,
        usage: blank,
        httpStatus: null,
        latencyMs: Date.now() - started,
        retryAfterMs: null,
        error: describe(err),
        unreachable: !timedOut,
      };
    }

    const latencyMs = Date.now() - started;
    const retryAfterMs = parseRetryAfter(res.headers.get('retry-after'));

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return {
        outcome: classifyStatus(res.status),
        content: null,
        usage: blank,
        httpStatus: res.status,
        latencyMs,
        retryAfterMs,
        error: text.slice(0, 500) || null,
        unreachable: false,
      };
    }

    let body: unknown;
    try {
      body = await res.json();
    } catch (err) {
      // Таймаут моделі спрацьовує й посеред тіла: заголовки прийшли, відповідь
      // ні. Це та сама повільна модель, а не зіпсоване тіло.
      if (isTimeout(err)) {
        return {
          outcome: 'timeout', content: null, usage: blank, httpStatus: res.status,
          latencyMs: Date.now() - started, retryAfterMs, error: describe(err), unreachable: false,
        };
      }
      return {
        outcome: 'error', content: null, usage: blank, httpStatus: res.status,
        latencyMs, retryAfterMs, error: `тіло не JSON: ${(err as Error).message}`, unreachable: false,
      };
    }

    if (isCounterfeit(body)) {
      return {
        outcome: 'retired',
        content: null,
        usage: blank,
        httpStatus: res.status,
        latencyMs,
        retryAfterMs,
        error: `підроблений 200: ${String(readContent(body)).slice(0, 200)}`,
        unreachable: false,
      };
    }

    const content = readContent(body);
    return {
      outcome: 'ok',
      content: content && content.trim() ? content.trim() : null,
      usage: readUsage(body),
      httpStatus: res.status,
      latencyMs,
      retryAfterMs,
      error: null,
      unreachable: false,
    };
  }

  async function listModels(timeoutMs = 5_000): Promise<string[] | null> {
    try {
      const res = await doFetch(`${base}/v1/models`, {
        headers: { Authorization: `Bearer ${config.apiKey}` },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) return null;
      const body = (await res.json()) as { data?: Array<{ id?: unknown }> };
      return (body.data ?? []).map((m) => String(m.id)).filter(Boolean);
    } catch {
      return null;
    }
  }

  return { call, listModels };
}

export type Gateway = ReturnType<typeof createGateway>;

function isTimeout(err: unknown): boolean {
  const name = (err as Error)?.name;
  return name === 'TimeoutError' || name === 'AbortError';
}

/**
 * `fetch failed` сам нічого не каже — причина лежить у `cause` undici
 * (`ECONNREFUSED`, `ENOTFOUND`, `ECONNRESET`, `UND_ERR_SOCKET`…), і саме вона
 * потрібна тому, хто читає `detail` у `ai_call` чи в стані пулу.
 */
function describe(err: unknown): string {
  const e = err as Error & { cause?: { code?: unknown; message?: unknown } };
  const message = e?.message ?? String(err);
  const code = e?.cause?.code;
  const cause = typeof code === 'string' ? code : typeof e?.cause?.message === 'string' ? e.cause.message : null;
  return cause && !message.includes(cause) ? `${message} (${cause})` : message;
}

function classifyStatus(status: number): Outcome {
  if (status === 429) return 'exhausted';
  if (status === 400) return 'rejected';
  if (status === 401 || status === 403) return 'unauthorized';
  if (status >= 500) return 'error';
  // 404 на неоголошену модель, 413 на завелике тіло — не варте ретраю тією
  // самою моделлю, але й не «вичерпано». Як і 400.
  return 'rejected';
}

/**
 * `Retry-After` за RFC 9110: або секунди, або HTTP-дата.
 *
 * Станом на 2026-09-13 шлюз цього заголовка НЕ шле — жодного з 429, перевірено
 * прямим `curl -D -`. Розбір лишається, бо єдине, що тут можна зробити, — не
 * вигадувати за апстрім: коли він почне казати, коли повертатись, ми його
 * послухаємо, а доки не каже — діє власний відступ.
 */
export function parseRetryAfter(raw: string | null): number | null {
  if (!raw) return null;
  const seconds = Number(raw.trim());
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const when = Date.parse(raw);
  if (Number.isFinite(when)) return Math.max(0, when - Date.now());
  return null;
}

function readContent(body: unknown): string | null {
  const choices = (body as { choices?: unknown })?.choices;
  if (!Array.isArray(choices) || choices.length === 0) return null;
  const msg = (choices[0] as { message?: { content?: unknown } })?.message;
  return typeof msg?.content === 'string' ? msg.content : null;
}

function readUsage(body: unknown): Usage {
  const u = (body as { usage?: Record<string, unknown> })?.usage;
  const n = (v: unknown): number | null =>
    typeof v === 'number' && Number.isFinite(v) ? v : null;
  if (!u || typeof u !== 'object') {
    return { promptTokens: null, completionTokens: null, totalTokens: null };
  }
  return {
    promptTokens: n(u['prompt_tokens']),
    completionTokens: n(u['completion_tokens']),
    totalTokens: n(u['total_tokens']),
  };
}
