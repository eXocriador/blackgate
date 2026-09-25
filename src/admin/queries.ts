/**
 * Читання для панелі: облік у часі, журнал, сьогоднішній день по продуктах.
 *
 * Два джерела, і в них різна глибина. `ai_call` — спроби моделей з 2026-09-13:
 * відповіді, токени, латентність моделі, сходинки. `ai_request` — запити з
 * 2026-09-25: відмови (400, 401, 429 стелі), які до драбини не доходять і в
 * `ai_call` слідів не лишають, і вміст. Графік відмов тому починається з дня
 * появи журналу, а не з 13-го, — і панель це каже, а не малює нулі.
 */
import type { Db } from '@exo/kit/infra';

export const RANGES = {
  '24h': { hours: 24, unit: 'hour' },
  '7d': { hours: 24 * 7, unit: 'hour' },
  '30d': { hours: 24 * 30, unit: 'day' },
  '90d': { hours: 24 * 90, unit: 'day' },
} as const;
export type RangeKey = keyof typeof RANGES;

export interface MetricsFilter {
  range: RangeKey;
  product: string | null;
  tier: string | null;
  /** Рахувати відповіді заглушки (`pool LIKE 'stub-%'`). За замовчуванням — ні: вони нічого не коштували. */
  includeStub: boolean;
}

export interface JournalFilter {
  product: string | null;
  /** `ok` (200), `error` (≥400), або точний код. */
  status: string | null;
  source: string | null;
  tier: string | null;
  /** Пошук у вмісті, гаманці, request_id, трейсі. */
  q: string | null;
  beforeId: number | null;
  limit: number;
}

function num(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** `%` і `_` у пошуку — буквальні символи, а не шаблон. */
function likeEscape(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

export function createQueries(db: Db) {
  async function must<T>(fn: Parameters<Db['tryQuery']>[0]): Promise<T> {
    const out = await db.tryQuery(fn);
    if (!out.ok) throw new Error(`база недоступна: ${out.error?.message ?? out.reason}`);
    return out.rows as T;
  }

  /** Сьогодні (доба UTC — та сама, що в стелях) по продуктах: запити, відмови, токени. */
  async function today() {
    const rows = await must<Array<Record<string, unknown>>>((sql) => sql`
      SELECT coalesce(product, '(без ключа)') AS product,
             count(*)                                        AS requests,
             count(*) FILTER (WHERE status = 200)            AS ok,
             count(*) FILTER (WHERE status IN (400, 401, 429)) AS refused,
             count(*) FILTER (WHERE status >= 500)           AS failed,
             count(*) FILTER (WHERE stub)                    AS stubbed,
             coalesce(sum(total_tokens), 0)                  AS tokens
      FROM ai_request
      WHERE at >= date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
      GROUP BY 1 ORDER BY 2 DESC`);
    return rows.map((r) => ({
      product: String(r['product']),
      requests: num(r['requests']) ?? 0,
      ok: num(r['ok']) ?? 0,
      refused: num(r['refused']) ?? 0,
      failed: num(r['failed']) ?? 0,
      stubbed: num(r['stubbed']) ?? 0,
      tokens: num(r['tokens']) ?? 0,
    }));
  }

  async function metrics(f: MetricsFilter) {
    const { hours, unit } = RANGES[f.range];
    const product = f.product;
    const tier = f.tier;
    const stub = f.includeStub;

    const [calls, requests, byModel, byProduct, byOutcome, journalSince] = await Promise.all([
      must<Array<Record<string, unknown>>>((sql) => sql`
        SELECT date_trunc(${unit}, at) AS t,
               count(*) FILTER (WHERE outcome = 'ok')                        AS answers,
               count(*) FILTER (WHERE outcome NOT IN ('ok', 'skipped'))      AS failed_attempts,
               count(*) FILTER (WHERE outcome = 'skipped')                   AS skipped,
               coalesce(sum(prompt_tokens), 0)                               AS prompt_tokens,
               coalesce(sum(completion_tokens), 0)                           AS completion_tokens,
               coalesce(sum(total_tokens), 0)                                AS total_tokens,
               percentile_cont(0.5)  WITHIN GROUP (ORDER BY latency_ms) FILTER (WHERE outcome = 'ok') AS p50,
               percentile_cont(0.95) WITHIN GROUP (ORDER BY latency_ms) FILTER (WHERE outcome = 'ok') AS p95,
               count(*) FILTER (WHERE outcome = 'ok' AND rung = 0)           AS rung0,
               count(*) FILTER (WHERE outcome = 'ok' AND rung = 1)           AS rung1,
               count(*) FILTER (WHERE outcome = 'ok' AND rung >= 2)          AS rung2
        FROM ai_call
        WHERE at >= now() - make_interval(hours => ${hours})
          AND (${product}::text IS NULL OR product = ${product})
          AND (${tier}::text IS NULL OR tier = ${tier})
          AND (${stub} OR pool NOT LIKE 'stub-%')
        GROUP BY 1 ORDER BY 1`),
      must<Array<Record<string, unknown>>>((sql) => sql`
        SELECT date_trunc(${unit}, at) AS t,
               count(*)                                          AS requests,
               count(*) FILTER (WHERE status = 200)              AS ok,
               count(*) FILTER (WHERE status IN (400, 401))      AS rejected,
               count(*) FILTER (WHERE status = 429)              AS capped,
               count(*) FILTER (WHERE status >= 500)             AS failed,
               percentile_cont(0.5)  WITHIN GROUP (ORDER BY latency_ms) FILTER (WHERE status = 200) AS p50,
               percentile_cont(0.95) WITHIN GROUP (ORDER BY latency_ms) FILTER (WHERE status = 200) AS p95
        FROM ai_request
        WHERE at >= now() - make_interval(hours => ${hours})
          AND (${product}::text IS NULL OR product = ${product})
          AND (${tier}::text IS NULL OR tier = ${tier})
          AND (${stub} OR NOT stub)
        GROUP BY 1 ORDER BY 1`),
      must<Array<Record<string, unknown>>>((sql) => sql`
        SELECT model, pool,
               count(*) FILTER (WHERE outcome = 'ok')                   AS answers,
               count(*) FILTER (WHERE outcome NOT IN ('ok', 'skipped')) AS failed,
               count(*) FILTER (WHERE outcome = 'skipped')              AS skipped,
               coalesce(sum(total_tokens), 0)                           AS tokens,
               percentile_cont(0.5) WITHIN GROUP (ORDER BY latency_ms) FILTER (WHERE outcome = 'ok') AS p50
        FROM ai_call
        WHERE at >= now() - make_interval(hours => ${hours})
          AND (${product}::text IS NULL OR product = ${product})
          AND (${tier}::text IS NULL OR tier = ${tier})
          AND (${stub} OR pool NOT LIKE 'stub-%')
        GROUP BY 1, 2 ORDER BY 3 DESC, 4 DESC`),
      must<Array<Record<string, unknown>>>((sql) => sql`
        SELECT product,
               count(*) FILTER (WHERE outcome = 'ok') AS answers,
               coalesce(sum(prompt_tokens), 0)        AS prompt_tokens,
               coalesce(sum(completion_tokens), 0)    AS completion_tokens,
               coalesce(sum(total_tokens), 0)         AS tokens
        FROM ai_call
        WHERE at >= now() - make_interval(hours => ${hours})
          AND (${tier}::text IS NULL OR tier = ${tier})
          AND (${stub} OR pool NOT LIKE 'stub-%')
        GROUP BY 1 ORDER BY 2 DESC`),
      must<Array<Record<string, unknown>>>((sql) => sql`
        SELECT outcome, count(*) AS n
        FROM ai_call
        WHERE at >= now() - make_interval(hours => ${hours})
          AND (${product}::text IS NULL OR product = ${product})
          AND (${tier}::text IS NULL OR tier = ${tier})
          AND (${stub} OR pool NOT LIKE 'stub-%')
        GROUP BY 1 ORDER BY 2 DESC`),
      must<Array<{ since: Date | null }>>((sql) => sql`SELECT min(at) AS since FROM ai_request`),
    ]);

    return {
      range: f.range,
      unit,
      journalSince: journalSince[0]?.since ?? null,
      calls: calls.map((r) => ({
        t: r['t'],
        answers: num(r['answers']) ?? 0,
        failedAttempts: num(r['failed_attempts']) ?? 0,
        skipped: num(r['skipped']) ?? 0,
        promptTokens: num(r['prompt_tokens']) ?? 0,
        completionTokens: num(r['completion_tokens']) ?? 0,
        totalTokens: num(r['total_tokens']) ?? 0,
        p50: num(r['p50']),
        p95: num(r['p95']),
        rung0: num(r['rung0']) ?? 0,
        rung1: num(r['rung1']) ?? 0,
        rung2: num(r['rung2']) ?? 0,
      })),
      requests: requests.map((r) => ({
        t: r['t'],
        requests: num(r['requests']) ?? 0,
        ok: num(r['ok']) ?? 0,
        rejected: num(r['rejected']) ?? 0,
        capped: num(r['capped']) ?? 0,
        failed: num(r['failed']) ?? 0,
        p50: num(r['p50']),
        p95: num(r['p95']),
      })),
      byModel: byModel.map((r) => ({
        model: String(r['model']),
        pool: String(r['pool']),
        answers: num(r['answers']) ?? 0,
        failed: num(r['failed']) ?? 0,
        skipped: num(r['skipped']) ?? 0,
        tokens: num(r['tokens']) ?? 0,
        p50: num(r['p50']),
      })),
      byProduct: byProduct.map((r) => ({
        product: String(r['product']),
        answers: num(r['answers']) ?? 0,
        promptTokens: num(r['prompt_tokens']) ?? 0,
        completionTokens: num(r['completion_tokens']) ?? 0,
        tokens: num(r['tokens']) ?? 0,
      })),
      byOutcome: byOutcome.map((r) => ({ outcome: String(r['outcome']), n: num(r['n']) ?? 0 })),
    };
  }

  async function journal(f: JournalFilter) {
    const limit = Math.min(Math.max(f.limit, 1), 200);
    const exact = f.status && /^\d{3}$/.test(f.status) ? Number(f.status) : null;
    const cls = f.status === 'ok' || f.status === 'error' ? f.status : null;
    const q = f.q ? `%${likeEscape(f.q)}%` : null;
    const rows = await must<Array<Record<string, unknown>>>((sql) => sql`
      SELECT id::int, at, source, product, subject, request_id, trace_id, session_id, tier, stub,
             status, error, error_detail, model, pool, rung, attempts, total_tokens, latency_ms,
             content_stored, content_purged_at,
             left(CASE WHEN jsonb_typeof(input) = 'array'
                       THEN (SELECT e.m->>'content' FROM jsonb_array_elements(input) WITH ORDINALITY AS e(m, n)
                             WHERE e.m->>'role' = 'user' ORDER BY e.n DESC LIMIT 1)
                       ELSE input #>> '{}' END, 200) AS input_preview,
             left(output, 200) AS output_preview
      FROM ai_request
      WHERE (${f.product}::text IS NULL OR product = ${f.product})
        AND (${f.source}::text IS NULL OR source = ${f.source})
        AND (${f.tier}::text IS NULL OR tier = ${f.tier})
        AND (${exact}::int IS NULL OR status = ${exact})
        AND (${cls}::text IS NULL OR (${cls} = 'ok' AND status = 200) OR (${cls} = 'error' AND status >= 400))
        AND (${f.beforeId}::bigint IS NULL OR id < ${f.beforeId})
        AND (${q}::text IS NULL
             OR input::text ILIKE ${q} OR output ILIKE ${q} OR subject ILIKE ${q}
             OR request_id ILIKE ${q} OR trace_id ILIKE ${q} OR session_id ILIKE ${q})
      ORDER BY id DESC
      LIMIT ${limit}`);
    return rows;
  }

  async function request(id: number) {
    const [row] = await must<Array<Record<string, unknown>>>((sql) => sql`
      SELECT id::int, at, source, product, subject, request_id, trace_id, parent_span_id, session_id, metadata,
             tier, stub, params, input, output, content_stored, content_purged_at, status, error, error_detail,
             model, pool, rung, attempts, prompt_tokens, completion_tokens, total_tokens, latency_ms
      FROM ai_request WHERE id = ${id}`);
    if (!row) return null;
    const attempts = await must<Array<Record<string, unknown>>>((sql) => sql`
      SELECT id::int, at, rung, model, pool, outcome, http_status, latency_ms, tries,
             prompt_tokens, completion_tokens, total_tokens, cost_usd, detail
      FROM ai_call WHERE request_ref = ${id} ORDER BY rung, id`);
    return { ...row, attemptRows: attempts };
  }

  /** Що є в журналі — для фільтрів панелі. */
  async function facets() {
    const [products, tiers] = await Promise.all([
      must<Array<{ product: string }>>((sql) => sql`
        SELECT DISTINCT product FROM ai_call WHERE product IS NOT NULL ORDER BY 1`),
      must<Array<{ tier: string }>>((sql) => sql`SELECT DISTINCT tier FROM ai_call ORDER BY 1`),
    ]);
    return { products: products.map((r) => r.product), tiers: tiers.map((r) => r.tier) };
  }

  return { today, metrics, journal, request, facets };
}

export type Queries = ReturnType<typeof createQueries>;
