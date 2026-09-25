/**
 * Клієнт admin-API. Кожен запит — той самий origin, Basic браузер шле сам
 * (він його запам'ятав після першого 401). Зміни несуть `X-Requested-With`:
 * без нього сервер відмовить (CSRF, `src/admin/server.ts`).
 */

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly detail: string | null,
    readonly problems: string[],
  ) {
    super(detail ?? code);
    this.name = 'ApiError';
  }
}

export async function api<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const method = init.method ?? 'GET';
  const headers: Record<string, string> = {};
  if (method !== 'GET') headers['X-Requested-With'] = 'blackgate-panel';
  if (init.body !== undefined) headers['Content-Type'] = 'application/json';
  let res: Response;
  try {
    res = await fetch(`/admin/api${path}`, {
      method,
      headers,
      credentials: 'same-origin',
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    });
  } catch {
    throw new ApiError(0, 'network', 'сервер не відповідає', []);
  }
  const text = await res.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  if (!res.ok) {
    const b = (body ?? {}) as { error?: unknown; detail?: unknown; problems?: unknown };
    throw new ApiError(
      res.status,
      typeof b.error === 'string' ? b.error : `http_${res.status}`,
      typeof b.detail === 'string' ? b.detail : null,
      Array.isArray(b.problems) ? b.problems.map(String) : [],
    );
  }
  return body as T;
}

// ── типи відповідей (дзеркало src/admin/*.ts) ────────────────────────────

export interface Me {
  user: string;
  version: string;
  startedAt: string;
}

export type PoolState = 'healthy' | 'exhausted' | 'down' | 'unknown';

export interface PoolStatus {
  pool: string;
  state: PoolState;
  checkedAt: string | null;
  cooldownUntil: string | null;
  latencyMs: number | null;
  detail: string | null;
}

export interface TodayRow {
  product: string;
  requests: number;
  ok: number;
  refused: number;
  failed: number;
  stubbed: number;
  tokens: number;
}

export interface Overview {
  ready: {
    status: number;
    version?: string;
    checks?: Record<string, string>;
    upstream?: { state: string; detail: string | null; since: string | null };
  };
  pools: PoolStatus[];
  penalties: Array<{ model: string; until: string; why: string }>;
  tiers: Array<{ tier: string; rungs: Array<{ rung: number; model: string; pool: string; timeoutMs: number }> }>;
  stub: string[];
  caps: Array<{ product: string; used: number | null; cap: number; subjectCap: number; custom: boolean }>;
  today: TodayRow[] | null;
  journal: { storeContent: boolean; contentDays: number; retentionDays: number };
}

export interface Facets {
  products: string[];
  keyProducts: string[];
  tiers: string[];
  catalogTiers: string[];
  scenarios: string[];
}

export interface CallBucket {
  t: string;
  answers: number;
  failedAttempts: number;
  skipped: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  p50: number | null;
  p95: number | null;
  rung0: number;
  rung1: number;
  rung2: number;
}

export interface RequestBucket {
  t: string;
  requests: number;
  ok: number;
  rejected: number;
  capped: number;
  failed: number;
  p50: number | null;
  p95: number | null;
}

export interface Metrics {
  range: string;
  unit: 'hour' | 'day';
  journalSince: string | null;
  calls: CallBucket[];
  requests: RequestBucket[];
  byModel: Array<{ model: string; pool: string; answers: number; failed: number; skipped: number; tokens: number; p50: number | null }>;
  byProduct: Array<{ product: string; answers: number; promptTokens: number; completionTokens: number; tokens: number }>;
  byOutcome: Array<{ outcome: string; n: number }>;
}

export interface JournalRow {
  id: number;
  at: string;
  source: 'api' | 'console';
  product: string | null;
  subject: string | null;
  request_id: string | null;
  trace_id: string | null;
  session_id: string | null;
  tier: string | null;
  stub: boolean;
  status: number;
  error: string | null;
  error_detail: string | null;
  model: string | null;
  pool: string | null;
  rung: number | null;
  attempts: number;
  total_tokens: number | null;
  latency_ms: number;
  content_stored: boolean;
  content_purged_at: string | null;
  input_preview: string | null;
  output_preview: string | null;
}

export interface AttemptRow {
  id: number;
  at: string;
  rung: number;
  model: string;
  pool: string;
  outcome: string;
  http_status: number | null;
  latency_ms: number;
  tries: number;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  total_tokens: number | null;
  cost_usd: string | null;
  detail: string | null;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface JournalDetail extends Omit<JournalRow, 'input_preview' | 'output_preview'> {
  parent_span_id: string | null;
  metadata: Record<string, unknown> | null;
  params: { max_tokens: number; temperature: number } | null;
  input: unknown;
  output: string | null;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  attemptRows: AttemptRow[];
}

export type DocKind = 'settings' | 'catalog' | 'stub';

export interface ChangeSummary {
  id: number;
  at: string;
  actor: string;
  kind: DocKind;
  action: 'update' | 'restore';
  restored_from: number | null;
  note: string | null;
  diff: string;
}

export interface ChangeRow extends ChangeSummary {
  before: string | null;
  after: string;
}

export interface CheckResult {
  ok: boolean;
  problems: string[];
  diff: string;
  unchanged: boolean;
}

export interface Overrides {
  caps?: { product?: number; subject?: number; products?: Record<string, { product?: number; subject?: number }> };
  journal?: { storeContent?: boolean; contentDays?: number; retentionDays?: number };
}

export interface EffectiveSettings {
  caps: { product: number; subject: number; products: Record<string, { product: number; subject: number }> };
  journal: { storeContent: boolean; contentDays: number; retentionDays: number };
}

export interface DocView {
  kind: DocKind;
  text: string;
  drift: boolean;
  lastChange: ChangeSummary | null;
  overrides?: Overrides;
  effective?: EffectiveSettings;
  defaults?: { capProduct: number; capSubject: number; storeContent: boolean; contentDays: number; retentionDays: number };
  products?: string[];
}

export type UpstreamView = { panelUrl: string | null } & (
  | { state: 'no_key' }
  | { state: 'disabled'; detail: string }
  | { state: 'key_rejected'; until: string }
  | { state: 'error'; detail: string }
  | { state: 'ok'; authFiles: unknown; usage: unknown }
);

export interface SandboxResult {
  status: number;
  body: Record<string, unknown>;
  journalId: number | null;
}
