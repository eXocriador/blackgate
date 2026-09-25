/**
 * Реєстр заглушки: кому відповідає заглушка замість моделей, і чим.
 *
 * Заглушка вмикається ЛИШЕ записом тут — продукту або продукту з гаманцем
 * (`subject`). Автоматично для всіх не вмикається ніколи: клієнт teamself
 * чи exointel, що отримав би від неї відповідь-підробку замість чесного
 * fail-safe, — рівно те, від чого blackgate писався.
 *
 * Файл — дані, як і `catalog.yaml`: монтується тією самою текою, перечитується
 * за mtime без релізу. Файла немає — заглушка вимкнена для всіх; поганий
 * файл на старті валить процес, на перечитуванні відхиляється, а в роботі
 * лишається попередній.
 */
import { readFile, stat } from 'node:fs/promises';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

const ID = z.string().min(1).max(128);
/** Гаманець точно (`exopost:stage:classify`) або префіксом із `*` у кінці (`exopost:stage:*`). */
const SUBJECT = z.string().min(1).max(200);

const routeSchema = z.strictObject({
  product: ID,
  /** Не задано — будь-який гаманець цього продукту, і порожній теж. */
  subject: SUBJECT.optional(),
  /**
   * `always` — моделі не питаються зовсім; `fallback` — заглушка відповідає
   * лише тоді, коли справжня драбина не дала нічого (503).
   */
  mode: z.enum(['always', 'fallback']),
  note: z.string().optional(),
});

const responseSchema = z.strictObject({
  product: ID,
  subject: SUBJECT.optional(),
  tier: ID.optional(),
  /**
   * `title` JSON Schema у промпті — ім'я pydantic-моделі (`GeneratedTarget`).
   * Потрібне там, де під одним гаманцем ходять різні форми: пакет і точковий
   * перезапис generate в exopost — обидва `exopost:stage:generate`.
   */
  schema: ID.optional(),
  /** Текст відповіді дослівно — без `[stub]`, бо це буває JSON. */
  content: z.string(),
  note: z.string().optional(),
});

export const stubSchema = z.strictObject({
  version: z.literal(1),
  routes: z.array(routeSchema).default([]),
  responses: z.array(responseSchema).default([]),
});

export type StubConfig = z.infer<typeof stubSchema>;
export type StubRoute = z.infer<typeof routeSchema>;
export type StubMode = StubRoute['mode'];

export const EMPTY_STUB: StubConfig = { version: 1, routes: [], responses: [] };

export class StubConfigError extends Error {
  constructor(readonly problems: string[]) {
    super(`stub.yaml непридатний: ${problems.join('; ')}`);
    this.name = 'StubConfigError';
  }
}

export function parseStub(text: string): StubConfig {
  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch (err) {
    throw new StubConfigError([`YAML не розбирається: ${(err as Error).message}`]);
  }
  // Порожній файл = вимкнено, як і відсутній.
  if (raw === null || raw === undefined) return EMPTY_STUB;
  const parsed = stubSchema.safeParse(raw);
  if (!parsed.success) {
    throw new StubConfigError(
      parsed.error.issues.map((i) => `${i.path.join('.') || '(корінь)'}: ${i.message}`),
    );
  }
  return parsed.data;
}

export function subjectMatches(pattern: string | undefined, subject: string | null): boolean {
  if (pattern === undefined) return true;
  if (subject === null) return false;
  return pattern.endsWith('*') ? subject.startsWith(pattern.slice(0, -1)) : subject === pattern;
}

/** Перший маршрут, що підходить, — тож конкретніші пишуться вище. */
export function routeFor(cfg: StubConfig, product: string, subject: string | null): StubRoute | null {
  return cfg.routes.find((r) => r.product === product && subjectMatches(r.subject, subject)) ?? null;
}

export function cannedFor(
  cfg: StubConfig,
  product: string,
  subject: string | null,
  tier: string,
  schemaTitle: string | null = null,
): string | null {
  const hit = cfg.responses.find(
    (r) =>
      r.product === product &&
      subjectMatches(r.subject, subject) &&
      (r.tier === undefined || r.tier === tier) &&
      (r.schema === undefined || r.schema === schemaTitle),
  );
  return hit ? hit.content : null;
}

export interface StubHandle {
  current(): StubConfig;
  /**
   * Перечитати зараз, не чекаючи обходу за mtime. `true` — прийнято (або файла
   * немає — вимкнено); `false` — відхилено, у роботі лишився попередній.
   */
  reload(): Promise<boolean>;
  stop(): void;
}

export interface StubHandleConfig {
  path: string;
  /** Як часто звіряти mtime. 0 вимикає стеження. */
  watchIntervalMs?: number;
  logInfo?: (event: string, fields?: Record<string, unknown>) => void;
  logWarn?: (event: string, fields?: Record<string, unknown>) => void;
}

/**
 * Прочитати й тримати свіжим. Стеження — за mtime, з тієї самої причини, що
 * й у реєстру моделей (див. `loadCatalog`): монтується тека, не файл.
 */
export async function loadStub(config: StubHandleConfig): Promise<StubHandle> {
  const interval = config.watchIntervalMs ?? 15_000;
  let seenMtime = await mtimeOf(config.path);
  let current = seenMtime === null ? EMPTY_STUB : parseStub(await readFile(config.path, 'utf8'));

  async function reload(m: number | null): Promise<boolean> {
    seenMtime = m;
    if (m === null) {
      current = EMPTY_STUB;
      config.logInfo?.('stub.removed', { path: config.path });
      return true;
    }
    try {
      current = parseStub(await readFile(config.path, 'utf8'));
      config.logInfo?.('stub.reloaded', { path: config.path, routes: describeRoutes(current) });
      return true;
    } catch (err) {
      config.logWarn?.('stub.reload_rejected', {
        path: config.path,
        problems: err instanceof StubConfigError ? err.problems : [(err as Error).message],
      });
      return false;
    }
  }

  let timer: ReturnType<typeof setInterval> | undefined;
  if (interval > 0) {
    timer = setInterval(() => {
      void (async () => {
        const m = await mtimeOf(config.path);
        if (m === seenMtime) return;
        await reload(m);
      })();
    }, interval);
    timer.unref();
  }

  return {
    current: () => current,
    reload: async () => reload(await mtimeOf(config.path)),
    stop: () => { if (timer) clearInterval(timer); },
  };
}

/** Для логу: `exopost=always`, `teamself/sandbox=always`. */
export function describeRoutes(cfg: StubConfig): string[] {
  return cfg.routes.map((r) => `${r.product}${r.subject ? `/${r.subject}` : ''}=${r.mode}`);
}

async function mtimeOf(path: string): Promise<number | null> {
  try {
    return (await stat(path)).mtimeMs;
  } catch {
    return null;
  }
}
