/**
 * Налаштування, які панель міняє без релізу.
 *
 * У базі лежить ПЕРЕКРИТТЯ, а не повний документ: чого там немає, те береться з
 * `.env`. Так дефолт лишається в одному місці, а панель показує, що саме
 * перекрито, і вміє скинути поле назад до дефолту.
 *
 * Читання — синхронне і з пам'яті: стелі потрібні на кожному /v1/complete, і
 * похід у Постгрес там був би новою точкою відмови. Кеш оновлюється раз на
 * `ttlMs` у фоні й одразу після запису; недоступна база лишає останнє відоме.
 */
import type { Db } from '@exo/kit/infra';
import { z } from 'zod';

const CAP = z.number().int().min(1).max(10_000_000);
const DAYS = z.number().int().min(0).max(36_500);

const productCaps = z.strictObject({
  product: CAP.optional(),
  subject: CAP.optional(),
});

export const overridesSchema = z.strictObject({
  caps: z
    .strictObject({
      /** Денна стеля продукту, якщо в `products` йому не задано своєї. */
      product: CAP.optional(),
      /** Денна стеля одного гаманця (`subject`), так само. */
      subject: CAP.optional(),
      /** Перекриття на продукт — обидві стелі або одна. */
      products: z.record(z.string().min(1).max(64), productCaps).optional(),
    })
    .optional(),
  journal: z
    .strictObject({
      storeContent: z.boolean().optional(),
      /** Через скільки днів вміст запиту стає NULL. 0 — ніколи. */
      contentDays: DAYS.optional(),
      /** Через скільки днів рядок журналу видаляється. 0 — ніколи. */
      retentionDays: DAYS.optional(),
    })
    .optional(),
});

export type Overrides = z.infer<typeof overridesSchema>;

export interface EffectiveSettings {
  caps: { product: number; subject: number; products: Record<string, { product: number; subject: number }> };
  journal: { storeContent: boolean; contentDays: number; retentionDays: number };
}

export interface Defaults {
  capProduct: number;
  capSubject: number;
  storeContent: boolean;
  contentDays: number;
  retentionDays: number;
}

export class SettingsError extends Error {
  constructor(readonly problems: string[]) {
    super(`налаштування непридатні: ${problems.join('; ')}`);
    this.name = 'SettingsError';
  }
}

/** Розібрати перекриття; поганий документ — список проблем, як у реєстру. */
export function parseOverrides(raw: unknown): Overrides {
  const parsed = overridesSchema.safeParse(raw ?? {});
  if (!parsed.success) {
    throw new SettingsError(parsed.error.issues.map((i) => `${i.path.join('.') || '(корінь)'}: ${i.message}`));
  }
  return parsed.data;
}

export function effective(defaults: Defaults, o: Overrides): EffectiveSettings {
  const product = o.caps?.product ?? defaults.capProduct;
  const subject = o.caps?.subject ?? defaults.capSubject;
  const products: EffectiveSettings['caps']['products'] = {};
  for (const [name, c] of Object.entries(o.caps?.products ?? {})) {
    products[name] = { product: c.product ?? product, subject: c.subject ?? subject };
  }
  return {
    caps: { product, subject, products },
    journal: {
      storeContent: o.journal?.storeContent ?? defaults.storeContent,
      contentDays: o.journal?.contentDays ?? defaults.contentDays,
      retentionDays: o.journal?.retentionDays ?? defaults.retentionDays,
    },
  };
}

/** Стелі одного продукту: його перекриття, інакше спільні. */
export function capsFor(s: EffectiveSettings, product: string): { product: number; subject: number } {
  return s.caps.products[product] ?? { product: s.caps.product, subject: s.caps.subject };
}

/** Канонічний текст перекриття — для версій і різниці: ключі в стабільному порядку. */
export function overridesText(o: Overrides): string {
  return `${JSON.stringify(sortKeys(o), null, 2)}\n`;
}

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object') {
    return Object.fromEntries(
      Object.keys(v as object).sort().map((k) => [k, sortKeys((v as Record<string, unknown>)[k])]),
    );
  }
  return v;
}

/** Ключ рядка `setting` з перекриттям. */
export const SETTINGS_KEY = 'overrides';

export interface SettingsConfig {
  db: Db;
  defaults: Defaults;
  ttlMs?: number;
  logWarn?: (event: string, fields?: Record<string, unknown>) => void;
}

export function createSettings(config: SettingsConfig) {
  let overrides: Overrides = {};
  let current = effective(config.defaults, overrides);
  let loadedAt: number | null = null;

  async function refresh(): Promise<boolean> {
    const out = await config.db.tryQuery((sql) => sql<{ value: unknown }[]>`SELECT value FROM setting WHERE key = ${SETTINGS_KEY}`);
    if (!out.ok) return false;
    try {
      overrides = parseOverrides(out.rows[0]?.value ?? {});
    } catch (err) {
      // Рядок у базі хтось поправив руками і зламав — лишити останнє відоме,
      // а не впасти в дефолти посеред дня (стелі раптом інші).
      config.logWarn?.('settings.invalid_row', { problems: (err as SettingsError).problems });
      return false;
    }
    current = effective(config.defaults, overrides);
    loadedAt = Date.now();
    return true;
  }

  /**
   * Прийняти щойно записане перекриття в пам'ять — без чекання наступного
   * оновлення кешу. Сам запис (і рядок аудиту про нього — однією транзакцією)
   * робить `admin/changes.ts`.
   */
  function adopt(next: Overrides): void {
    overrides = parseOverrides(next);
    current = effective(config.defaults, overrides);
    loadedAt = Date.now();
  }

  let timer: ReturnType<typeof setInterval> | undefined;
  function start(): void {
    if (timer) return;
    timer = setInterval(() => void refresh(), config.ttlMs ?? 10_000);
    timer.unref();
  }
  function stop(): void {
    if (timer) clearInterval(timer);
    timer = undefined;
  }

  return {
    current: () => current,
    overrides: () => overrides,
    defaults: () => config.defaults,
    loadedAt: () => loadedAt,
    refresh,
    adopt,
    start,
    stop,
  };
}

export type Settings = ReturnType<typeof createSettings>;
