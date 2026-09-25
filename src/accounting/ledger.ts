/**
 * Облік: кожен виклик лишає рядок.
 *
 * Запис НЕ блокує відповідь клієнтові. Облік — це звітність, а не частина
 * відповіді: продукт, якому підтримка потрібна зараз, не має чекати на insert,
 * і вже тим паче не має її не отримати, якщо Постгрес моргнув. `kit`-івський
 * `query` і так повертає null замість кидати, тож найгірше, що станеться, —
 * день недорахується.
 */
import type { Db } from '@exo/kit/infra';
import type { Attempt } from '../ladder/run.js';
import type { ResolvedCatalog } from '../catalog/index.js';

export interface LedgerRow {
  product: string;
  subject: string | null;
  requestId: string | null;
  tier: string;
  attempt: Attempt;
}

export interface LedgerConfig {
  db: Db;
  catalog: () => ResolvedCatalog;
  logWarn?: (event: string, fields?: Record<string, unknown>) => void;
}

export function createLedger(config: LedgerConfig) {
  /**
   * Записати ВСІ спроби одного запиту, включно з пропущеними сходинками.
   *
   * Пропущена сходинка — теж факт обліку: саме з неї видно, що пул лежав і
   * скільки разів драбина його оминула. Рядки з `outcome='skipped'` мають
   * latency 0, тож у підсумках часу вони не заважають.
   */
  async function record(rows: LedgerRow[]): Promise<void> {
    if (rows.length === 0) return;
    const out = await config.db.tryQuery(
      (sql) => sql`INSERT INTO ai_call ${sql(payload(rows) as unknown as Record<string, unknown>[])}`,
    );
    if (!out.ok) {
      config.logWarn?.('ledger.write_failed', { reason: out.reason, rows: rows.length });
    }
  }

  /**
   * Рядки `ai_call` — як їх пише `record`, плюс посилання на запит журналу.
   * Виділено, щоб журнал писав запит і його спроби однією транзакцією.
   */
  function payload(rows: LedgerRow[], requestRef: number | null = null) {
    const cat = config.catalog();
    return rows.map((r) => ({
      product: r.product,
      subject: r.subject,
      request_id: r.requestId,
      tier: r.tier,
      rung: r.attempt.rung,
      model: r.attempt.model,
      pool: r.attempt.pool,
      outcome: r.attempt.outcome,
      http_status: r.attempt.httpStatus,
      latency_ms: r.attempt.latencyMs,
      tries: r.attempt.tries,
      prompt_tokens: r.attempt.promptTokens,
      completion_tokens: r.attempt.completionTokens,
      total_tokens: r.attempt.totalTokens,
      cost_usd: estimateCost(cat, r.attempt),
      detail: r.attempt.detail ? r.attempt.detail.slice(0, 2000) : null,
      request_ref: requestRef,
    }));
  }

  return { record, payload };
}

export type Ledger = ReturnType<typeof createLedger>;

/**
 * Вартість — лише якщо реєстр знає ціну. Інакше `null`.
 *
 * Ціни в реєстрі сьогодні немає в жодної моделі, і це навмисно: канали, через
 * які ходить шлюз (Antigravity, Vertex на особистому акаунті), не мають ціни
 * за токен, яку ми могли б назвати чесно. Стовпчик у схемі є, місце під ціну в
 * реєстрі є, а цифра з'явиться тоді, коли з'явиться підстава.
 */
export function estimateCost(cat: ResolvedCatalog, a: Attempt): number | null {
  const m = cat.models.get(a.model);
  if (!m) return null;
  const { price_in_per_mtok: pin, price_out_per_mtok: pout } = m;
  if (pin === undefined && pout === undefined) return null;
  if (a.promptTokens === null && a.completionTokens === null) return null;

  const inCost = ((a.promptTokens ?? 0) / 1_000_000) * (pin ?? 0);
  const outCost = ((a.completionTokens ?? 0) / 1_000_000) * (pout ?? 0);
  return Number((inCost + outCost).toFixed(6));
}
