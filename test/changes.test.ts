import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, readFile, rm, stat, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Db } from '@exo/kit/infra';
import { loadCatalog } from '../src/catalog/index.js';
import { loadStub } from '../src/stub/config.js';
import { capsFor, createSettings, effective, overridesText, parseOverrides, SettingsError } from '../src/settings/settings.js';
import { createChanges, ChangeRejected, type ChangeRow } from '../src/admin/changes.js';
import { diffLines, unifiedDiff } from '../src/admin/diff.js';
import { writeAtomic } from '../src/admin/files.js';

const DEFAULTS = { capProduct: 2000, capSubject: 300, storeContent: true, contentDays: 90, retentionDays: 365 };

describe('налаштування', () => {
  it('перекриття поверх дефолтів; продукт — своє, інакше спільне', () => {
    const s = effective(DEFAULTS, parseOverrides({ caps: { subject: 50, products: { exopost: { product: 10 } } } }));
    expect(capsFor(s, 'exopost')).toEqual({ product: 10, subject: 50 });
    expect(capsFor(s, 'teamself')).toEqual({ product: 2000, subject: 50 });
    expect(s.journal).toEqual({ storeContent: true, contentDays: 90, retentionDays: 365 });
  });

  it('друкарська помилка в ключі — відмова з переліком', () => {
    expect(() => parseOverrides({ caps: { prodcut: 1 } })).toThrow(SettingsError);
    expect(() => parseOverrides({ journal: { contentDays: -1 } })).toThrow(SettingsError);
    expect(() => parseOverrides({ caps: { product: 0 } })).toThrow(SettingsError);
  });

  it('текст перекриття — стабільний порядок ключів', () => {
    expect(overridesText({ journal: { storeContent: false }, caps: { subject: 1, product: 2 } }))
      .toBe(overridesText({ caps: { product: 2, subject: 1 }, journal: { storeContent: false } }));
  });
});

describe('різниця', () => {
  it('однакові — порожньо; одна правка посередині — з контекстом', () => {
    expect(unifiedDiff('a\nb\n', 'a\nb\n')).toBe('');
    const text = Array.from({ length: 20 }, (_, i) => `r${i}`).join('\n') + '\n';
    const d = unifiedDiff(text, text.replace('r10', 'R10'));
    expect(d).toContain('-r10\n+R10');
    expect(d).toContain('@@ пропущено 7 незмінених рядків @@');
    expect(d.split('\n').filter((l) => l.startsWith(' '))).toHaveLength(6);
  });

  it('вставка і видалення', () => {
    expect(diffLines('a\nc\n', 'a\nb\nc\n').map((o) => o.op + o.line)).toEqual([' a', '+b', ' c']);
    expect(diffLines('a\nb\nc\n', 'a\nc\n').map((o) => o.op + o.line)).toEqual([' a', '-b', ' c']);
    expect(diffLines('', 'x\n').map((o) => o.op + o.line)).toEqual(['+x']);
  });
});

const CATALOG = `version: 1
pools:
  a: { upstream: x, probe: a1 }
  b: { upstream: x, probe: b1 }
models:
  - { id: a1, pool: a }
  - { id: b1, pool: b }
tiers:
  fast: [a1, b1]
`;

/** Підробка postgres.js під `apply`: транзакція, вставки, jsonb; відкат — кинутий виняток. */
function fakeDb() {
  const rows: ChangeRow[] = [];
  let setting: unknown = null;
  let failNext = false;
  const tag = (strings: TemplateStringsArray, ...vals: unknown[]) => {
    const text = strings.join('?');
    if (text.includes('INSERT INTO config_change')) {
      const [actor, kind, action, restored_from, note, before, after, diff] = vals as [
        string, ChangeRow['kind'], ChangeRow['action'], number | null, string | null, string, string, string,
      ];
      const id = rows.length + 1;
      rows.push({ id, at: new Date().toISOString(), actor, kind, action, restored_from, note, before, after, diff });
      return Promise.resolve([{ id: String(id) }]);
    }
    if (text.includes('INSERT INTO setting')) {
      setting = (vals[1] as { json: unknown }).json;
      return Promise.resolve([]);
    }
    if (text.includes('FROM config_change WHERE id')) return Promise.resolve(rows.filter((r) => r.id === vals[0]));
    if (text.includes('SELECT after FROM config_change')) {
      const last = [...rows].reverse().find((r) => r.kind === vals[0]);
      return Promise.resolve(last ? [{ after: last.after }] : []);
    }
    if (text.includes('FROM setting')) return Promise.resolve(setting ? [{ value: setting }] : []);
    return Promise.resolve([]);
  };
  const sql = Object.assign(tag, {
    json: (v: unknown) => ({ json: v }),
    // Транзакція: виняток усередині — рядки, додані в ній, знімаються.
    begin: async (cb: (tx: typeof sql) => Promise<unknown>) => {
      const mark = rows.length;
      try {
        return await cb(sql);
      } catch (err) {
        rows.length = mark;
        throw err;
      }
    },
  });
  const db = {
    sql,
    async query() { return null; },
    async tryQuery(fn: (s: unknown) => Promise<unknown>) {
      if (failNext) { failNext = false; return { ok: false, reason: 'unavailable' }; }
      try {
        return { ok: true, rows: await fn(sql) };
      } catch (error) {
        return { ok: false, reason: 'error', error };
      }
    },
    jsonb: (v: unknown) => ({ json: v }),
  } as unknown as Db;
  return { db, rows, failNextQuery: () => { failNext = true; }, setting: () => setting };
}

describe('зміни з панелі: аудит, запис, відкат', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'blackgate-changes-'));
    await writeFile(join(dir, 'catalog.yaml'), CATALOG);
  });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  async function setup(write?: (p: string, t: string) => Promise<void>) {
    const f = fakeDb();
    const catalog = await loadCatalog({ path: join(dir, 'catalog.yaml'), watchIntervalMs: 0 });
    const stub = await loadStub({ path: join(dir, 'stub.yaml'), watchIntervalMs: 0 });
    const settings = createSettings({ db: f.db, defaults: DEFAULTS });
    const changes = createChanges({
      db: f.db, catalogPath: join(dir, 'catalog.yaml'), stubPath: join(dir, 'stub.yaml'),
      catalog, stub, settings, ...(write ? { write } : {}),
    });
    return { f, catalog, stub, settings, changes };
  }

  it('реєстр: поганий — відмова з проблемами, файл не чіпається', async () => {
    const { changes, f } = await setup();
    const bad = CATALOG.replace('fast: [a1, b1]', 'fast: [a1, a1]');
    const check = await changes.check('catalog', bad);
    expect(check.ok).toBe(false);
    expect(check.problems.length).toBeGreaterThan(0);
    await expect(changes.apply('catalog', bad, 'owner', null)).rejects.toThrow(ChangeRejected);
    expect(await readFile(join(dir, 'catalog.yaml'), 'utf8')).toBe(CATALOG);
    expect(f.rows).toHaveLength(0);
  });

  it('реєстр: добрий — файл, рядок аудиту з різницею, перечитано одразу', async () => {
    const { changes, catalog, f } = await setup();
    const next = CATALOG.replace('- { id: b1, pool: b }', '- { id: b1, pool: b, timeout_ms: 5000 }');
    const r = await changes.apply('catalog', next, 'owner', 'таймаут b1');
    expect(r.id).toBe(1);
    expect(await readFile(join(dir, 'catalog.yaml'), 'utf8')).toBe(next);
    expect(catalog.current().models.get('b1')!.timeout_ms).toBe(5000);
    expect(f.rows[0]).toMatchObject({ actor: 'owner', kind: 'catalog', action: 'update', note: 'таймаут b1', before: CATALOG, after: next });
    expect(f.rows[0]!.diff).toContain('+  - { id: b1, pool: b, timeout_ms: 5000 }');
    // Без змін — без рядка.
    expect((await changes.apply('catalog', next, 'owner', null)).id).toBeNull();
    expect(f.rows).toHaveLength(1);
  });

  it('відкат: «до» зміни — нова зміна restore, історія не переписується', async () => {
    const { changes, catalog, f } = await setup();
    const next = CATALOG.replace('fast: [a1, b1]', 'fast: [b1, a1]');
    await changes.apply('catalog', next, 'owner', null);
    const preview = await changes.previewRestore(1, 'before');
    expect(preview.diff).toContain('-  fast: [b1, a1]');
    const r = await changes.restore(1, 'before', 'owner');
    expect(r).toMatchObject({ kind: 'catalog', id: 2 });
    expect(await readFile(join(dir, 'catalog.yaml'), 'utf8')).toBe(CATALOG);
    expect(catalog.current().tiers.get('fast')!.map((m) => m.id)).toEqual(['a1', 'b1']);
    expect(f.rows[1]).toMatchObject({ action: 'restore', restored_from: 1, note: 'відкат зміни #1' });
  });

  it('правка руками між змінами — видно в «до» наступної', async () => {
    const { changes, f } = await setup();
    await changes.apply('catalog', CATALOG.replace('probe: a1', 'probe: a1, note: x'), 'owner', null);
    const handEdited = CATALOG.replace('probe: b1', 'probe: b1, note: руками');
    await writeFile(join(dir, 'catalog.yaml'), handEdited);
    await changes.apply('catalog', CATALOG, 'owner', null);
    expect(f.rows[1]!.before).toBe(handEdited);
  });

  it('файл не записався — рядка аудиту немає', async () => {
    const { changes, f } = await setup(async () => { throw new Error('EACCES'); });
    await expect(changes.apply('catalog', CATALOG.replace('probe: a1', 'probe: a1, note: y'), 'owner', null))
      .rejects.toThrow(/EACCES/);
    expect(f.rows).toHaveLength(0);
  });

  it('заглушка: немає файла — «до» порожнє; запис вмикає маршрут одразу', async () => {
    const { changes, stub, f } = await setup();
    const text = 'version: 1\nroutes:\n  - { product: exopost, mode: always }\n';
    await changes.apply('stub', text, 'owner', null);
    expect(stub.current().routes).toHaveLength(1);
    expect(f.rows[0]!.before).toBe('');
    await expect(changes.apply('stub', 'version: 1\nroutes:\n  - { product: exopost, mode: maybe }\n', 'owner', null))
      .rejects.toThrow(ChangeRejected);
  });

  it('налаштування: рядок setting і аудит, кеш одразу; відкат повертає', async () => {
    const { changes, settings, f } = await setup();
    await changes.apply('settings', overridesText({ caps: { products: { exopost: { product: 5 } } } }), 'owner', null);
    expect(capsFor(settings.current(), 'exopost').product).toBe(5);
    expect(f.setting()).toEqual({ caps: { products: { exopost: { product: 5 } } } });
    await changes.restore(1, 'before', 'owner');
    expect(capsFor(settings.current(), 'exopost').product).toBe(2000);
    await expect(changes.apply('settings', '{"caps": {"product": "багато"}}', 'owner', null)).rejects.toThrow(ChangeRejected);
    await expect(changes.apply('settings', '{', 'owner', null)).rejects.toThrow(/JSON/);
  });
});

describe('атомарний запис', () => {
  it('0664, без тимчасових хвостів, новий inode', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'blackgate-atomic-'));
    try {
      const p = join(dir, 'x.yaml');
      await writeFile(p, 'old');
      const before = (await stat(p)).ino;
      await writeAtomic(p, 'new');
      const st = await stat(p);
      expect(await readFile(p, 'utf8')).toBe('new');
      expect(st.mode & 0o777).toBe(0o664);
      expect(st.ino).not.toBe(before);
      expect(await readdir(dir)).toEqual(['x.yaml']);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
