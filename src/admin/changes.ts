/**
 * Зміни, які панель вносить у три документи, — і аудит кожної з них.
 *
 *   settings  перекриття налаштувань (рядок `setting`)
 *   catalog   реєстр моделей (`config/catalog.yaml`)
 *   stub      заглушка (`config/stub.yaml`)
 *
 * Одне правило на всі три: зміна без рядка аудиту не стається. Рядок
 * `config_change` і сама зміна — одна транзакція: файл пишеться ВСЕРЕДИНІ неї,
 * і якщо запис файла впав, рядок відкочується; недоступна база — відмова ще до
 * запису файла. Документ перевіряється тими самими `parseCatalog`/`parseStub`,
 * що й на старті, тож панель не може зберегти те, на чому процес не стартував
 * би.
 *
 * Версія — це `after` будь-якого рядка. Відкат — нова зміна з вмістом
 * `before` чи `after` іншого рядка, а не переписування історії.
 */
import { readFile } from 'node:fs/promises';
import type { Db } from '@exo/kit/infra';
import { CatalogError, parseCatalog, type CatalogHandle } from '../catalog/index.js';
import { parseStub, StubConfigError, type StubHandle } from '../stub/config.js';
import { overridesText, parseOverrides, SettingsError, SETTINGS_KEY, type Settings } from '../settings/settings.js';
import { unifiedDiff } from './diff.js';
import { writeAtomic } from './files.js';

export type ChangeKind = 'settings' | 'catalog' | 'stub';
export const CHANGE_KINDS: readonly ChangeKind[] = ['settings', 'catalog', 'stub'];

export class ChangeRejected extends Error {
  constructor(readonly problems: string[]) {
    super(problems.join('; '));
    this.name = 'ChangeRejected';
  }
}

export interface ChangeRow {
  id: number;
  at: string;
  actor: string;
  kind: ChangeKind;
  action: 'update' | 'restore';
  restored_from: number | null;
  note: string | null;
  before: string | null;
  after: string;
  diff: string;
}

export interface ChangesConfig {
  db: Db;
  catalogPath: string;
  stubPath: string;
  catalog: CatalogHandle;
  stub: StubHandle;
  settings: Settings;
  write?: (path: string, text: string) => Promise<void>;
  logInfo?: (event: string, fields?: Record<string, unknown>) => void;
}

export interface CheckResult {
  ok: boolean;
  problems: string[];
  diff: string;
  unchanged: boolean;
}

export function createChanges(config: ChangesConfig) {
  const write = config.write ?? writeAtomic;

  /** Чинний текст документа — з диска, а не з пам'яті: так видно й правку руками. */
  async function currentText(kind: ChangeKind): Promise<string> {
    if (kind === 'settings') return overridesText(config.settings.overrides());
    const path = kind === 'catalog' ? config.catalogPath : config.stubPath;
    try {
      return await readFile(path, 'utf8');
    } catch (err) {
      // Заглушки може не бути — це «вимкнено», а не поломка.
      if ((err as NodeJS.ErrnoException).code === 'ENOENT' && kind === 'stub') return '';
      throw err;
    }
  }

  /** Перевірити документ тим самим розбором, що й на старті. Кидає ChangeRejected. */
  function validate(kind: ChangeKind, text: string): void {
    try {
      if (kind === 'catalog') parseCatalog(text);
      else if (kind === 'stub') parseStub(text);
      else parseOverrides(parseJson(text));
    } catch (err) {
      if (err instanceof CatalogError || err instanceof StubConfigError || err instanceof SettingsError) {
        throw new ChangeRejected(err.problems);
      }
      if (err instanceof ChangeRejected) throw err;
      throw new ChangeRejected([(err as Error).message]);
    }
  }

  /**
   * Налаштування — у канонічному тексті (ключі за абеткою, відступ 2), хоч би
   * як їх склала форма: інакше порядок ключів ставав би «різницею», а версії
   * одного й того самого вмісту — різними текстами. YAML лишається як є:
   * коментарі й порядок у ньому — частина документа.
   */
  function normalize(kind: ChangeKind, text: string): string {
    return kind === 'settings' ? overridesText(parseOverrides(parseJson(text))) : text;
  }

  async function check(kind: ChangeKind, text: string): Promise<CheckResult> {
    let doc = text;
    try {
      validate(kind, text);
      doc = normalize(kind, text);
    } catch (err) {
      const diff = unifiedDiff(await currentText(kind), text);
      return { ok: false, problems: (err as ChangeRejected).problems, diff, unchanged: diff === '' };
    }
    const diff = unifiedDiff(await currentText(kind), doc);
    return { ok: true, problems: [], diff, unchanged: diff === '' };
  }

  async function apply(
    kind: ChangeKind,
    rawText: string,
    actor: string,
    note: string | null,
    restoredFrom: number | null = null,
  ): Promise<{ id: number | null; diff: string }> {
    validate(kind, rawText);
    const text = normalize(kind, rawText);
    const before = await currentText(kind);
    const diff = unifiedDiff(before, text);
    if (diff === '') return { id: null, diff };

    const sqlClient = config.db.sql;
    if (!sqlClient) throw new ChangeRejected(['база недоступна — зміна без рядка аудиту не робиться']);

    const out = await config.db.tryQuery((sql) =>
      sql.begin(async (tx) => {
        const [row] = await tx<{ id: string }[]>`
          INSERT INTO config_change (actor, kind, action, restored_from, note, before, after, diff)
          VALUES (${actor}, ${kind}, ${restoredFrom === null ? 'update' : 'restore'}, ${restoredFrom},
                  ${note}, ${before}, ${text}, ${diff})
          RETURNING id`;
        if (kind === 'settings') {
          const value = parseOverrides(parseJson(text));
          await tx`
            INSERT INTO setting (key, value, updated_at, updated_by)
            VALUES (${SETTINGS_KEY}, ${tx.json(value as never)}, now(), ${actor})
            ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now(), updated_by = EXCLUDED.updated_by`;
        } else {
          // Файл — останнім кроком транзакції: впав запис — відкотився і рядок.
          await write(kind === 'catalog' ? config.catalogPath : config.stubPath, text);
        }
        return Number(row!.id);
      }),
    );
    if (!out.ok) throw new ChangeRejected([`зміна не записалась: ${out.error?.message ?? out.reason}`]);

    // Застосувати одразу, не чекаючи обходу за mtime (15 с) чи кешу (10 с).
    if (kind === 'settings') config.settings.adopt(parseOverrides(parseJson(text)));
    else if (kind === 'catalog') await config.catalog.reload();
    else await config.stub.reload();

    config.logInfo?.('admin.change', { id: out.rows, kind, actor, restoredFrom });
    return { id: out.rows, diff };
  }

  async function get(id: number): Promise<ChangeRow | null> {
    const out = await config.db.tryQuery((sql) => sql<ChangeRow[]>`
      SELECT id::int, at, actor, kind, action, restored_from::int, note, before, after, diff
      FROM config_change WHERE id = ${id}`);
    if (!out.ok) throw new Error(`аудит недоступний: ${out.reason}`);
    return out.rows[0] ?? null;
  }

  async function list(opts: { kind?: ChangeKind; beforeId?: number; limit?: number }) {
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
    const out = await config.db.tryQuery((sql) => sql<Array<Omit<ChangeRow, 'before' | 'after'>>>`
      SELECT id::int, at, actor, kind, action, restored_from::int, note, diff
      FROM config_change
      WHERE (${opts.kind ?? null}::text IS NULL OR kind = ${opts.kind ?? null})
        AND (${opts.beforeId ?? null}::bigint IS NULL OR id < ${opts.beforeId ?? null})
      ORDER BY id DESC LIMIT ${limit}`);
    if (!out.ok) throw new Error(`аудит недоступний: ${out.reason}`);
    return out.rows;
  }

  /** Останній відомий панелі вміст — щоб побачити правку руками з того часу. */
  async function lastAfter(kind: ChangeKind): Promise<string | null> {
    const out = await config.db.tryQuery((sql) => sql<{ after: string }[]>`
      SELECT after FROM config_change WHERE kind = ${kind} ORDER BY id DESC LIMIT 1`);
    return out.ok ? (out.rows[0]?.after ?? null) : null;
  }

  /** Повернути документ до вмісту ДО (`before`) або ПІСЛЯ (`after`) зміни `id`. */
  async function restore(id: number, which: 'before' | 'after', actor: string) {
    const row = await get(id);
    if (!row) throw new ChangeRejected([`зміни #${id} немає`]);
    const text = which === 'before' ? row.before : row.after;
    if (text === null) throw new ChangeRejected([`у зміни #${id} немає вмісту «до»`]);
    const note = which === 'before' ? `відкат зміни #${id}` : `повернення до версії #${id}`;
    return { kind: row.kind, ...(await apply(row.kind, text, actor, note, id)) };
  }

  /** Що вийде з відкатом — різниця з чинним, до запису. */
  async function previewRestore(id: number, which: 'before' | 'after'): Promise<CheckResult & { kind: ChangeKind }> {
    const row = await get(id);
    if (!row) throw new ChangeRejected([`зміни #${id} немає`]);
    const text = which === 'before' ? row.before : row.after;
    if (text === null) throw new ChangeRejected([`у зміни #${id} немає вмісту «до»`]);
    return { kind: row.kind, ...(await check(row.kind, text)) };
  }

  return { currentText, check, apply, get, list, lastAfter, restore, previewRestore };
}

export type Changes = ReturnType<typeof createChanges>;

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new ChangeRejected([`JSON не розбирається: ${(err as Error).message}`]);
  }
}
