/**
 * Строк зберігання журналу — пакетами, раз на добу.
 *
 * Два строки, бо в них різна ціна. Вміст (повідомлення клієнтів і відповіді
 * моделей) — великий і чутливий: після `contentDays` він стає NULL, а рядок
 * лишається — у ньому статус, токени й хто питав, тобто облік відмов, якого
 * немає в `ai_call`. Сам рядок живе `journalDays` (0 — без строку).
 *
 * Пакетами по `batch` рядків із паузою: один DELETE на пів мільйона рядків
 * тримав би блокування й роздув би WAL спільного Постгресу посеред дня.
 */
import type { Db } from '@exo/kit/infra';

export interface RetentionConfig {
  db: Db;
  contentDays: () => number;
  journalDays: () => number;
  intervalMs?: number;
  batch?: number;
  pauseMs?: number;
  logInfo?: (event: string, fields?: Record<string, unknown>) => void;
  logWarn?: (event: string, fields?: Record<string, unknown>) => void;
}

export interface PurgeResult {
  contentCleared: number;
  rowsDeleted: number;
}

export function createRetention(config: RetentionConfig) {
  const batch = config.batch ?? 1000;
  const pause = config.pauseMs ?? 200;
  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

  async function loop(step: () => Promise<number | null>): Promise<number> {
    let total = 0;
    // Стеля проходів: навіть якщо щось пішло не так, чистка не крутиться вічно.
    for (let i = 0; i < 10_000; i++) {
      const n = await step();
      if (n === null) break;
      total += n;
      if (n < batch) break;
      await sleep(pause);
    }
    return total;
  }

  async function purge(): Promise<PurgeResult> {
    const contentDays = config.contentDays();
    const journalDays = config.journalDays();

    const contentCleared = contentDays > 0
      ? await loop(async () => {
          const out = await config.db.tryQuery((sql) => sql`
            UPDATE ai_request SET input = NULL, output = NULL, content_purged_at = now()
            WHERE id IN (
              SELECT id FROM ai_request
              WHERE at < now() - make_interval(days => ${contentDays})
                AND (input IS NOT NULL OR output IS NOT NULL)
              ORDER BY id LIMIT ${batch}
            )`);
          return out.ok ? out.rows.count : null;
        })
      : 0;

    const rowsDeleted = journalDays > 0
      ? await loop(async () => {
          const out = await config.db.tryQuery((sql) => sql`
            DELETE FROM ai_request
            WHERE id IN (
              SELECT id FROM ai_request
              WHERE at < now() - make_interval(days => ${journalDays})
              ORDER BY id LIMIT ${batch}
            )`);
          return out.ok ? out.rows.count : null;
        })
      : 0;

    config.logInfo?.('journal.purged', { contentDays, journalDays, contentCleared, rowsDeleted });
    return { contentCleared, rowsDeleted };
  }

  let timer: ReturnType<typeof setInterval> | undefined;
  let first: ReturnType<typeof setTimeout> | undefined;
  function start(): void {
    if (timer) return;
    const run = () => void purge().catch((err) => config.logWarn?.('journal.purge_failed', { error: (err as Error).message }));
    // Перша чистка — не на старті: деплой і так навантажує спільну базу міграцією.
    first = setTimeout(run, 10 * 60_000);
    first.unref();
    timer = setInterval(run, config.intervalMs ?? 24 * 60 * 60_000);
    timer.unref();
  }
  function stop(): void {
    if (first) clearTimeout(first);
    if (timer) clearInterval(timer);
    timer = undefined;
  }

  return { purge, start, stop };
}
