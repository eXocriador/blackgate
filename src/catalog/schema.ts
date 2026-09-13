import { z } from 'zod';

/**
 * Форма реєстру. Реєстр — дані, тож вимоги до нього живуть тут, а не в
 * розкиданих перевірках: файл або цілий, або сервіс каже, що саме в ньому не
 * так, і називає рядок.
 */

const ID = z.string().min(1).max(128);

export const poolSchema = z.object({
  /** Провайдер за пулом — суто довідково, у рішеннях не бере участі. */
  upstream: z.string().min(1),
  /**
   * Модель, якою міряють здоров'я пулу. Мусить належати цьому ж пулу і НЕ
   * бути `retired` — обидва правила перевіряються в `validateCatalog`.
   */
  probe: ID,
  note: z.string().optional(),
});

export const modelSchema = z.object({
  id: ID,
  pool: z.string().min(1),
  /**
   * Свій таймаут на модель. Один таймаут на всіх — це те, від чого тут
   * відмовляються: `@exo/kit/llm` зашив 30_000 для будь-чого, і роздум
   * opus-thinking не відрізнити від мертвого flash-lite.
   */
  timeout_ms: z.number().int().min(1000).max(600_000).default(30_000),
  /**
   * Апстрім вивів модель з експлуатації, але шлюз далі віддає на неї HTTP 200
   * з текстом-надгробком замість відповіді. Такої моделі не місце ні в
   * драбині, ні в пробі пулу.
   */
  retired: z.boolean().default(false),
  /**
   * Модель відхиляє форму запиту (400 INVALID_ARGUMENT). Не привід не пробувати
   * — привід не РЕТРАЇТИ і не дивуватись.
   */
  rejects_shape: z.boolean().default(false),
  /**
   * Ціна за мільйон токенів, якщо вона ВІДОМА. Немає — немає: порожнє поле
   * чесніше за вигадану цифру, і облік тоді пише cost_usd = NULL.
   */
  price_in_per_mtok: z.number().nonnegative().optional(),
  price_out_per_mtok: z.number().nonnegative().optional(),
  note: z.string().optional(),
});

export const catalogSchema = z.object({
  version: z.literal(1),
  pools: z.record(ID, poolSchema),
  models: z.array(modelSchema).min(1),
  /** Тир → драбина запасних ходів, зверху вниз. */
  tiers: z.record(ID, z.array(ID).min(2)),
});

export type PoolSpec = z.infer<typeof poolSchema>;
export type ModelSpec = z.infer<typeof modelSchema>;
export type CatalogFile = z.infer<typeof catalogSchema>;
