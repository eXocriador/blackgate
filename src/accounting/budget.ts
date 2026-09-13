/**
 * Денні лічильники — спадкоємець ДВОХ копій `spend.ts` (exointel і teamself).
 *
 * Копії розійшлись на 36 рядків при ідентичній логіці, і кожна властивість
 * нижче перенесена свідомо, а не успадкована за інерцією:
 *
 *   • INCR + EXPIRE NX, а не SET+INCR. Голий EXPIRE на наявному ключі
 *     зсував би вікно вперед на кожному виклику, і лічильник не скидався б
 *     ніколи. NX прикріплює TTL до моменту першого за день виклику.
 *   • TTL 48 годин на ключі з датою — щоб день дожив далеко за північ, а
 *     ключ сам обертався.
 *   • День у UTC, не в локальному часі: точку скидання не має рухати
 *     часовий пояс сервера.
 *   • Рахується ПЕРЕД викликом, не після. Обірваний на півдорозі запит
 *     спалив ті токени, які спалив, а сторож, що рахує лише успіхи,
 *     накручується довільно високо невдалими викликами.
 *   • Fail-OPEN. Недоступний Redis не має гасити підтримку. Оператор не може
 *     вимкнути НАШ Redis, щоб підняти собі стелю, тож зловживання це не
 *     полегшує; а fail-closed клав би підтримку на кожному моргу Redis —
 *     подія куди ймовірніша за зловживання.
 *
 * Що ДОДАНО проти обох копій: ліміт на ПРОДУКТ. Доти стеля була лише на
 * кінцевого клієнта, і продукт, який зійшов з розуму, не мав стелі взагалі.
 */
import type { RedisCache } from '@exo/kit/infra';

export const DEFAULT_DAILY_CAP = 300;

/** 48 год. */
const KEY_TTL_SECONDS = 172_800;

export type BudgetScope = 'product' | 'subject';

export interface BudgetVerdict {
  /** false — стеля вичерпана; продукт мусить деградувати, а не кликати модель. */
  allowed: boolean;
  /** Яка саме стеля закрилась. */
  scope: BudgetScope | null;
  used: number;
  cap: number;
}

/** Ключ із датою UTC. Форма навмисно та сама, що була, лише в своєму просторі імен. */
export function budgetKey(scope: BudgetScope, id: string, now: Date = new Date()): string {
  const day = now.toISOString().slice(0, 10).replace(/-/g, '');
  return `exoai:${scope}:${id}:${day}`;
}

export interface BudgetConfig {
  redis: RedisCache;
  logWarn?: (event: string, fields?: Record<string, unknown>) => void;
}

export interface ConsumeRequest {
  product: string;
  productCap: number;
  subject?: string | null;
  subjectCap?: number | null;
  now?: Date;
}

export function createBudget(config: BudgetConfig) {
  /**
   * Зарахувати один виклик і сказати, чи він у межах.
   *
   * Обидві стелі рахуються ЗАВЖДИ, навіть якщо перша вже закрилась: лічильник
   * має відповідати кількості спроб, а не кількості дозволів, інакше добова
   * картина бреше рівно на розмір зловживання, яке її й цікавить.
   */
  async function consume(req: ConsumeRequest): Promise<BudgetVerdict> {
    const now = req.now ?? new Date();

    const product = await bump(budgetKey('product', req.product, now));
    const subject =
      req.subject && req.subjectCap && req.subjectCap > 0
        ? await bump(budgetKey('subject', `${req.product}:${req.subject}`, now))
        : null;

    if (subject !== null && subject > req.subjectCap!) {
      return { allowed: false, scope: 'subject', used: subject, cap: req.subjectCap! };
    }
    if (product !== null && product > req.productCap) {
      return { allowed: false, scope: 'product', used: product, cap: req.productCap };
    }
    return { allowed: true, scope: null, used: product ?? 0, cap: req.productCap };
  }

  /** `null` — порахувати не вдалось; викликач тоді пропускає (fail-open). */
  async function bump(key: string): Promise<number | null> {
    const client = config.redis.client;
    if (!client || config.redis.breakerOpen()) return null;
    try {
      // `EXPIRE … NX` потребує Redis >= 7.0; у нас 8 (redis:8-alpine).
      const res = await client.multi().incr(key).expire(key, KEY_TTL_SECONDS, 'NX').exec();
      const used = Number(res?.[0]?.[1] ?? 0);
      return Number.isFinite(used) && used > 0 ? used : null;
    } catch {
      config.redis.reportFailure();
      config.logWarn?.('budget.counter_unavailable', { key });
      return null;
    }
  }

  /** Скільки вже зараховано сьогодні — для звіту, без інкременту. */
  async function used(scope: BudgetScope, id: string, now: Date = new Date()): Promise<number | null> {
    const client = config.redis.client;
    if (!client || config.redis.breakerOpen()) return null;
    try {
      const raw = await client.get(budgetKey(scope, id, now));
      const n = Number(raw);
      return Number.isFinite(n) ? n : 0;
    } catch {
      return null;
    }
  }

  return { consume, used };
}

export type Budget = ReturnType<typeof createBudget>;
