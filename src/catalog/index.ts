import { readFile, stat } from 'node:fs/promises';
import { parse as parseYaml } from 'yaml';
import { catalogSchema } from './schema.js';
import { CatalogError, resolveCatalog, type ResolvedCatalog } from './validate.js';

export { CatalogError, resolveCatalog };
export type { ResolvedCatalog, ResolvedModel } from './validate.js';
export type { CatalogFile, ModelSpec, PoolSpec } from './schema.js';

/** Розібрати текст реєстру. Виділено, щоб тести не ходили в файлову систему. */
export function parseCatalog(text: string): ResolvedCatalog {
  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch (err) {
    throw new CatalogError([`YAML не розбирається: ${(err as Error).message}`]);
  }

  const parsed = catalogSchema.safeParse(raw);
  if (!parsed.success) {
    throw new CatalogError(
      parsed.error.issues.map((i) => `${i.path.join('.') || '(корінь)'}: ${i.message}`),
    );
  }
  return resolveCatalog(parsed.data);
}

export interface CatalogHandle {
  current(): ResolvedCatalog;
  /**
   * Перечитати файл. Повертає `true`, якщо реєстр замінено.
   *
   * На СТАРТІ поганий реєстр — привід не стартувати (див. `loadCatalog`).
   * На ПЕРЕЧИТУВАННІ — ні: живий сервіс із робочим реєстром у пам'яті не має
   * лягати від того, що хтось зберіг файл посеред правки. Тому тут помилка
   * лише голосно записується, а в роботі лишається попередній реєстр.
   */
  reload(): Promise<boolean>;
  stop(): void;
}

export interface CatalogHandleConfig {
  path: string;
  /** Як часто звіряти mtime. 0 вимикає стеження. Дефолт 15 с. */
  watchIntervalMs?: number;
  logInfo?: (event: string, fields?: Record<string, unknown>) => void;
  logWarn?: (event: string, fields?: Record<string, unknown>) => void;
}

/**
 * Прочитати реєстр із диска і тримати його свіжим.
 *
 * Стеження — за mtime з інтервалом, а не `fs.watch`: inotify крізь bind-монт
 * не доходить надійно, а редактор, що пише через `rename`, лишає стеження на
 * старому inode. Опитування mtime коштує один `stat` на 15 секунд і бачить
 * підміну файла.
 *
 * УМОВА, без якої все вище марне: у контейнер монтується ТЕКА з реєстром, а не
 * сам файл. Монт одного файла прив'язує контейнер до inode, і після `sed -i`
 * чи `:w` у vim він назавжди лишається зі старим вмістом — `stat` при цьому
 * чесно повертає стару mtime, тож мовчить і цей код, і контейнер, і монітор.
 * Спіймано на живому деплої 2026-09-13; compose продукту монтує `./config`.
 */
export async function loadCatalog(config: CatalogHandleConfig): Promise<CatalogHandle> {
  const interval = config.watchIntervalMs ?? 15_000;
  let catalog = parseCatalog(await readFile(config.path, 'utf8'));
  let seenMtime = await mtimeOf(config.path);

  async function reload(): Promise<boolean> {
    try {
      const next = parseCatalog(await readFile(config.path, 'utf8'));
      catalog = next;
      config.logInfo?.('catalog.reloaded', {
        path: config.path,
        models: next.models.size,
        pools: next.pools.size,
        tiers: next.tierNames.length,
      });
      return true;
    } catch (err) {
      config.logWarn?.('catalog.reload_rejected', {
        path: config.path,
        // Список проблем, а не один рядок: оператор правив файл і має побачити
        // все, що в ньому не так, не перезаписуючи його ще раз наосліп.
        problems: err instanceof CatalogError ? err.problems : [(err as Error).message],
      });
      return false;
    }
  }

  let timer: ReturnType<typeof setInterval> | undefined;
  if (interval > 0) {
    timer = setInterval(() => {
      void (async () => {
        const m = await mtimeOf(config.path);
        if (m === null || m === seenMtime) return;
        seenMtime = m;
        await reload();
      })();
    }, interval);
    timer.unref();
  }

  return {
    current: () => catalog,
    reload: async () => {
      seenMtime = await mtimeOf(config.path);
      return reload();
    },
    stop: () => { if (timer) clearInterval(timer); },
  };
}

async function mtimeOf(path: string): Promise<number | null> {
  try {
    return (await stat(path)).mtimeMs;
  } catch {
    return null;
  }
}
