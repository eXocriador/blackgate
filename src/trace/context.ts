/**
 * Трейс-контекст запиту — W3C `traceparent` і `metadata` від продукту.
 *
 * blackgate сам трейсів не починає: він ланка в чужому трейсі. Продукт, що
 * вже має трейс своєї стадії (exopost `classify`, розмова teamself), передає
 * `traceparent`, і запис журналу та спан OTLP стають дочірніми до його спану.
 * Хто трейсів не має — шле `metadata.trace_id` / `metadata.session_id` або
 * нічого; тоді в журналі порожньо, а спан OTLP отримує власний новий трейс.
 *
 * Чужий вхід: формат перевіряється, розмір metadata обмежений. Поганий
 * `traceparent` мовчки ігнорується (так велить W3C), а не валить запит.
 */
import type { TraceContext } from '../journal/journal.js';

const TRACEPARENT = /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;
const ZERO_TRACE = '0'.repeat(32);
const ZERO_SPAN = '0'.repeat(16);
/** metadata більше — не пишеться: журнал не смітник для довільних тіл. */
const METADATA_MAX_BYTES = 4096;

export function parseTraceparent(raw: string | undefined): { traceId: string; spanId: string } | null {
  if (!raw) return null;
  const m = TRACEPARENT.exec(raw.trim().toLowerCase());
  if (!m) return null;
  const [, version, traceId, spanId] = m;
  // Версія ff заборонена; нульові id — недійсні (W3C Trace Context §3.2).
  if (version === 'ff' || traceId === ZERO_TRACE || spanId === ZERO_SPAN) return null;
  return { traceId: traceId!, spanId: spanId! };
}

function str(v: unknown, max = 200): string | null {
  return typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null;
}

export function readTrace(headers: Record<string, string | string[] | undefined>, body: unknown): TraceContext | null {
  const header = headers['traceparent'];
  const parent = parseTraceparent(Array.isArray(header) ? header[0] : header);

  let metadata: Record<string, unknown> | null = null;
  const raw = body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>)['metadata'] : undefined;
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const size = Buffer.byteLength(JSON.stringify(raw));
    metadata = size <= METADATA_MAX_BYTES ? (raw as Record<string, unknown>) : { _dropped: `metadata ${size} Б > ${METADATA_MAX_BYTES} Б` };
  }

  // trace_id з metadata — лише якщо в ньому справжній id трейсу: інакше це
  // довільний рядок продукту, і в спан OTLP його класти не можна.
  const metaTrace = str(metadata?.['trace_id'] ?? metadata?.['traceId'], 64)?.toLowerCase() ?? null;
  const traceId = parent?.traceId ?? (metaTrace && /^[0-9a-f]{32}$/.test(metaTrace) && metaTrace !== ZERO_TRACE ? metaTrace : null);
  const sessionId = str(metadata?.['session_id'] ?? metadata?.['sessionId']);

  if (!traceId && !sessionId && !metadata) return null;
  return { traceId, parentSpanId: parent?.spanId ?? null, sessionId, metadata };
}
