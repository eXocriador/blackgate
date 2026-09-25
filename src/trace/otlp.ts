/**
 * Експорт спанів OTLP/HTTP (JSON) за семантичними конвенціями OpenTelemetry
 * GenAI (`gen_ai.*`) — вимкнений, доки не задано `OTEL_EXPORTER_OTLP_ENDPOINT`.
 *
 * Без SDK навмисно: SDK OpenTelemetry — десяток пакетів і власний життєвий
 * цикл заради одного POST раз на кілька секунд у сервісі, через який ходять
 * ключі продуктів. Формат — стабільний OTLP JSON; будь-який приймач (Collector,
 * Langfuse, Jaeger, Tempo) його читає.
 *
 * Спан на запит (`chat <tier>`) і дочірній на кожну справжню спробу драбини
 * (`chat <model>`). Вміст (`gen_ai.input.messages` / `gen_ai.output.messages`)
 * — лише за опт-іном `OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT=true`,
 * як і велять конвенції: повідомлення клієнтів не мають самі поїхати в чужий
 * сервіс через те, що хтось підключив переглядач трейсів.
 */
import { randomBytes } from 'node:crypto';
import type { JournalEntry } from '../journal/journal.js';

export interface OtlpConfig {
  endpoint: string;
  headers?: Record<string, string>;
  serviceName: string;
  serviceVersion: string;
  captureContent: boolean;
  flushMs?: number;
  maxBatch?: number;
  fetchImpl?: typeof fetch;
  logWarn?: (event: string, fields?: Record<string, unknown>) => void;
}

type AnyValue = { stringValue: string } | { intValue: string } | { doubleValue: number } | { boolValue: boolean };
interface KeyValue { key: string; value: AnyValue }

interface OtlpSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: number;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: KeyValue[];
  status: { code: number; message?: string };
}

/** Рядок `k=v,k2=v2` з `OTEL_EXPORTER_OTLP_HEADERS`. */
export function parseHeaders(raw: string | null | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pair of (raw ?? '').split(',')) {
    const at = pair.indexOf('=');
    if (at > 0) out[decodeURIComponent(pair.slice(0, at).trim())] = decodeURIComponent(pair.slice(at + 1).trim());
  }
  return out;
}

function attr(key: string, v: string | number | boolean | null | undefined): KeyValue | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string') return { key, value: { stringValue: v } };
  if (typeof v === 'boolean') return { key, value: { boolValue: v } };
  return Number.isInteger(v) ? { key, value: { intValue: String(v) } } : { key, value: { doubleValue: v } };
}

const hex = (bytes: number) => randomBytes(bytes).toString('hex');
const nanos = (ms: number) => `${BigInt(Math.round(ms)) * 1_000_000n}`;

/**
 * Спани одного запиту. Час спроб — послідовно від початку запиту: драбина
 * йде сходинками по черзі, а точних відміток старту спроб облік не тримає.
 */
export function spansFor(entry: JournalEntry, journalId: number | null, captureContent: boolean): OtlpSpan[] {
  const traceId = entry.trace?.traceId ?? hex(16);
  const rootId = hex(8);
  const start = entry.at.getTime();
  const end = start + entry.latencyMs;
  const failed = entry.status >= 400;

  const tokensIn = entry.attempts.reduce<number | null>((s, a) => (a.promptTokens === null ? s : (s ?? 0) + a.promptTokens), null);
  const tokensOut = entry.attempts.reduce<number | null>((s, a) => (a.completionTokens === null ? s : (s ?? 0) + a.completionTokens), null);

  const rootAttrs = [
    attr('gen_ai.operation.name', 'chat'),
    attr('gen_ai.request.model', entry.tier),
    attr('gen_ai.response.model', entry.model),
    attr('gen_ai.request.max_tokens', entry.params?.max_tokens),
    attr('gen_ai.request.temperature', entry.params?.temperature),
    attr('gen_ai.usage.input_tokens', tokensIn),
    attr('gen_ai.usage.output_tokens', tokensOut),
    attr('gen_ai.conversation.id', entry.trace?.sessionId),
    attr('http.response.status_code', entry.status),
    attr('error.type', failed ? (entry.error ?? `http_${entry.status}`) : null),
    attr('blackgate.product', entry.product),
    attr('blackgate.subject', entry.subject),
    attr('blackgate.source', entry.source),
    attr('blackgate.tier', entry.tier),
    attr('blackgate.pool', entry.pool),
    attr('blackgate.rung', entry.rung),
    attr('blackgate.stub', entry.stub),
    attr('blackgate.request_id', entry.requestId),
    attr('blackgate.journal_id', journalId),
    ...(captureContent && entry.input !== null && entry.input !== undefined
      ? [attr('gen_ai.input.messages', JSON.stringify(entry.input))]
      : []),
    ...(captureContent && entry.output !== null
      ? [attr('gen_ai.output.messages', JSON.stringify([{ role: 'assistant', parts: [{ type: 'text', content: entry.output }] }]))]
      : []),
  ].filter((x): x is KeyValue => x !== null);

  const root: OtlpSpan = {
    traceId,
    spanId: rootId,
    ...(entry.trace?.parentSpanId ? { parentSpanId: entry.trace.parentSpanId } : {}),
    name: `chat ${entry.tier ?? 'unknown'}`,
    kind: 2, // SERVER: продукт кличе blackgate
    startTimeUnixNano: nanos(start),
    endTimeUnixNano: nanos(end),
    attributes: rootAttrs,
    status: failed ? { code: 2, message: entry.errorDetail ?? entry.error ?? '' } : { code: 1 },
  };

  let cursor = start;
  const children: OtlpSpan[] = [];
  for (const a of entry.attempts) {
    if (a.outcome === 'skipped') continue;
    const s = cursor;
    cursor += a.latencyMs;
    children.push({
      traceId,
      spanId: hex(8),
      parentSpanId: rootId,
      name: `chat ${a.model}`,
      kind: 3, // CLIENT: blackgate кличе шлюз
      startTimeUnixNano: nanos(s),
      endTimeUnixNano: nanos(cursor),
      attributes: [
        attr('gen_ai.operation.name', 'chat'),
        attr('gen_ai.request.model', a.model),
        attr('gen_ai.usage.input_tokens', a.promptTokens),
        attr('gen_ai.usage.output_tokens', a.completionTokens),
        attr('http.response.status_code', a.httpStatus),
        attr('error.type', a.outcome === 'ok' ? null : a.outcome),
        attr('blackgate.pool', a.pool),
        attr('blackgate.rung', a.rung),
        attr('blackgate.tries', a.tries),
      ].filter((x): x is KeyValue => x !== null),
      status: a.outcome === 'ok' ? { code: 1 } : { code: 2, message: a.detail ?? a.outcome },
    });
  }
  return [root, ...children];
}

export function createOtlpExporter(config: OtlpConfig) {
  const f = config.fetchImpl ?? fetch;
  const maxBatch = config.maxBatch ?? 200;
  const url = config.endpoint.replace(/\/+$/, '').endsWith('/v1/traces')
    ? config.endpoint
    : `${config.endpoint.replace(/\/+$/, '')}/v1/traces`;
  let queue: OtlpSpan[] = [];
  let lastWarn = 0;

  function export_(entry: JournalEntry, journalId: number | null): void {
    queue.push(...spansFor(entry, journalId, config.captureContent));
    // Приймач лежить довго — черга не росте без меж: старі спани злітають першими.
    if (queue.length > maxBatch * 10) queue = queue.slice(-maxBatch * 10);
    if (queue.length >= maxBatch) void flush();
  }

  async function flush(): Promise<void> {
    if (queue.length === 0) return;
    const batch = queue.splice(0, maxBatch);
    const body = {
      resourceSpans: [{
        resource: {
          attributes: [
            { key: 'service.name', value: { stringValue: config.serviceName } },
            { key: 'service.version', value: { stringValue: config.serviceVersion } },
          ],
        },
        scopeSpans: [{ scope: { name: 'blackgate', version: config.serviceVersion }, spans: batch }],
      }],
    };
    try {
      const res = await f(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...config.headers },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(5_000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    } catch (err) {
      // Трейси — не облік: спани, що не доїхали, губляться, а журнал у Постгресі
      // лишається повним. Попередження — не частіше разу на хвилину.
      if (Date.now() - lastWarn > 60_000) {
        lastWarn = Date.now();
        config.logWarn?.('otlp.export_failed', { url, error: (err as Error).message, dropped: batch.length });
      }
    }
  }

  const timer = setInterval(() => void flush(), config.flushMs ?? 5_000);
  timer.unref();

  return {
    export: export_,
    flush,
    stop: async () => { clearInterval(timer); await flush(); },
  };
}

export type OtlpExporter = ReturnType<typeof createOtlpExporter>;
