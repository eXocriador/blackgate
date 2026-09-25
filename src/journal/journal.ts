/**
 * Журнал запитів: один рядок `ai_request` на кожен /v1/complete — і відповідь,
 * і відмову, — плюс його спроби в `ai_call` з посиланням назад.
 *
 * Як і облік, журнал НЕ тримає відповідь: запис іде після `send`, а падіння
 * Постгресу коштує рядка журналу, не відповіді продукту. Але облік спроб
 * важливіший за журнал — він старший і на ньому стоять звіти, — тож якщо запит
 * у журнал не ліг, спроби все одно пишуться окремо, без посилання.
 */
import type { Db } from '@exo/kit/infra';
import type { Attempt } from '../ladder/run.js';
import type { Ledger, LedgerRow } from '../accounting/ledger.js';
import type { ChatMessage } from '../upstream/types.js';

export type RequestSource = 'api' | 'console';

export interface TraceContext {
  traceId: string | null;
  parentSpanId: string | null;
  sessionId: string | null;
  metadata: Record<string, unknown> | null;
}

export interface JournalEntry {
  at: Date;
  source: RequestSource;
  product: string | null;
  subject: string | null;
  requestId: string | null;
  trace: TraceContext | null;
  tier: string | null;
  stub: boolean;
  params: { max_tokens: number; temperature: number } | null;
  /** Що прийшло: розібрані повідомлення, а якщо не розібрались — сире поле тіла. */
  input: ChatMessage[] | unknown | null;
  output: string | null;
  status: number;
  error: string | null;
  errorDetail: string | null;
  model: string | null;
  pool: string | null;
  rung: number | null;
  attempts: Attempt[];
  latencyMs: number;
}

export interface JournalConfig {
  db: Db;
  ledger: Ledger;
  /** Чи писати вміст — читається на кожен запис: перемикач у панелі діє одразу. */
  storeContent: () => boolean;
  logWarn?: (event: string, fields?: Record<string, unknown>) => void;
}

export interface Journal {
  /** id рядка `ai_request`, або null — журнал не записався (облік спроб усе одно пишеться). */
  record(entry: JournalEntry): Promise<number | null>;
}

/** Текст помилки в журналі — не безрозмірний: у ньому бувають тіла відповідей шлюзу. */
const DETAIL_MAX = 2000;

export function createJournal(config: JournalConfig): Journal {
  async function record(entry: JournalEntry): Promise<number | null> {
    const store = config.storeContent();
    const tokens = sumTokens(entry.attempts);
    const row = {
      at: entry.at,
      source: entry.source,
      product: entry.product,
      subject: entry.subject,
      request_id: entry.requestId,
      trace_id: entry.trace?.traceId ?? null,
      parent_span_id: entry.trace?.parentSpanId ?? null,
      session_id: entry.trace?.sessionId ?? null,
      metadata: entry.trace?.metadata ? config.db.jsonb(entry.trace.metadata) : null,
      tier: entry.tier,
      stub: entry.stub,
      params: entry.params ? config.db.jsonb(entry.params) : null,
      input: store && entry.input !== null && entry.input !== undefined ? config.db.jsonb(entry.input) : null,
      output: store ? entry.output : null,
      content_stored: store,
      status: entry.status,
      error: entry.error,
      error_detail: entry.errorDetail ? entry.errorDetail.slice(0, DETAIL_MAX) : null,
      model: entry.model,
      pool: entry.pool,
      rung: entry.rung,
      attempts: entry.attempts.filter((a) => a.outcome !== 'skipped').length,
      prompt_tokens: tokens.prompt,
      completion_tokens: tokens.completion,
      total_tokens: tokens.total,
      latency_ms: Math.max(0, Math.round(entry.latencyMs)),
    };

    const ledgerRows: LedgerRow[] = entry.product && entry.tier
      ? entry.attempts.map((attempt) => ({
          product: entry.product!, subject: entry.subject, requestId: entry.requestId, tier: entry.tier!, attempt,
        }))
      : [];

    const out = await config.db.tryQuery((sql) =>
      sql.begin(async (tx) => {
        const [inserted] = await tx<{ id: string }[]>`INSERT INTO ai_request ${tx(row as unknown as Record<string, unknown>)} RETURNING id`;
        const id = Number(inserted!.id);
        if (ledgerRows.length > 0) {
          await tx`INSERT INTO ai_call ${tx(config.ledger.payload(ledgerRows, id) as unknown as Record<string, unknown>[])}`;
        }
        return id;
      }),
    );
    if (out.ok) return out.rows;

    config.logWarn?.('journal.write_failed', { reason: out.reason, error: out.error?.message, status: entry.status });
    // Облік спроб — окремо, без посилання: він старший за журнал і важливіший.
    await config.ledger.record(ledgerRows);
    return null;
  }

  return { record };
}

/**
 * Сума токенів по спробах; `null`, якщо жодна спроба їх не назвала (заглушка,
 * відмова до драбини) — нуль тут збрехав би, що запит нічого не коштував.
 */
export function sumTokens(attempts: readonly Attempt[]): { prompt: number | null; completion: number | null; total: number | null } {
  const add = (acc: number | null, v: number | null) => (v === null ? acc : (acc ?? 0) + v);
  let prompt: number | null = null;
  let completion: number | null = null;
  let total: number | null = null;
  for (const a of attempts) {
    prompt = add(prompt, a.promptTokens);
    completion = add(completion, a.completionTokens);
    total = add(total, a.totalTokens);
  }
  return { prompt, completion, total };
}
