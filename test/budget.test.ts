import { describe, it, expect } from 'vitest';
import { createBudget, budgetKey } from '../src/accounting/budget.js';
import type { RedisCache } from '@exo/kit/infra';

/** Рівно стільки Redis, скільки лічильник справді торкається. */
function fakeRedis(opts: { broken?: boolean; breaker?: boolean } = {}): RedisCache {
  const store = new Map<string, number>();
  const client = {
    multi() {
      const ops: string[] = [];
      const chain = {
        incr(key: string) { ops.push(key); return chain; },
        expire() { return chain; },
        async exec() {
          if (opts.broken) throw new Error('redis впав');
          const key = ops[0]!;
          const next = (store.get(key) ?? 0) + 1;
          store.set(key, next);
          return [[null, next]];
        },
      };
      return chain;
    },
    async get(key: string) { return String(store.get(key) ?? 0); },
  };
  return {
    client: (opts.broken && false ? null : client) as never,
    breakerOpen: () => opts.breaker ?? false,
    reportFailure: () => {},
    cacheGet: async () => null, cacheSet: async () => {}, cacheDel: async () => {},
    acquireLock: async () => true, releaseLock: async () => {},
  };
}

const day = new Date('2026-09-13T23:59:00Z');

describe('ключ лічильника', () => {
  it('день у UTC, не в локальному часі', () => {
    expect(budgetKey('product', 'exointel', day)).toBe('exoai:product:exointel:20260913');
  });
  it('наступна доба UTC — інший ключ', () => {
    expect(budgetKey('product', 'exointel', new Date('2026-09-14T00:01:00Z')))
      .toBe('exoai:product:exointel:20260914');
  });
});

describe('стелі', () => {
  it('пускає в межах стелі й рахує зростання', async () => {
    const b = createBudget({ redis: fakeRedis() });
    const first = await b.consume({ product: 'p', productCap: 3, now: day });
    expect(first.allowed).toBe(true);
    expect(first.used).toBe(1);
    await b.consume({ product: 'p', productCap: 3, now: day });
    const third = await b.consume({ product: 'p', productCap: 3, now: day });
    expect(third.allowed).toBe(true);
    expect(third.used).toBe(3);
  });

  it('закриває продуктову стелю після перевищення', async () => {
    const b = createBudget({ redis: fakeRedis() });
    for (let i = 0; i < 2; i++) await b.consume({ product: 'p', productCap: 2, now: day });
    const over = await b.consume({ product: 'p', productCap: 2, now: day });
    expect(over.allowed).toBe(false);
    expect(over.scope).toBe('product');
  });

  it('стеля на кінцевого клієнта окрема від продуктової', async () => {
    const b = createBudget({ redis: fakeRedis() });
    const over = await b.consume({
      product: 'p', productCap: 1000, subject: 'user:7', subjectCap: 1, now: day,
    });
    expect(over.allowed).toBe(true);
    const second = await b.consume({
      product: 'p', productCap: 1000, subject: 'user:7', subjectCap: 1, now: day,
    });
    expect(second.allowed).toBe(false);
    expect(second.scope).toBe('subject');
    // Інший клієнт того ж продукту не зачеплений.
    const other = await b.consume({
      product: 'p', productCap: 1000, subject: 'user:8', subjectCap: 1, now: day,
    });
    expect(other.allowed).toBe(true);
  });

  it('продукти не діляться лічильником', async () => {
    const b = createBudget({ redis: fakeRedis() });
    await b.consume({ product: 'exointel', productCap: 1, now: day });
    const other = await b.consume({ product: 'teamself', productCap: 1, now: day });
    expect(other.allowed).toBe(true);
  });

  /**
   * Fail-open перенесений з обох копій spend.ts свідомо: недоступний Redis не
   * має гасити підтримку, а вимкнути НАШ Redis, щоб підняти собі стелю,
   * зловмисник не може.
   */
  it('Redis упав → пускає (fail-open)', async () => {
    const b = createBudget({ redis: fakeRedis({ broken: true }) });
    const v = await b.consume({ product: 'p', productCap: 1, now: day });
    expect(v.allowed).toBe(true);
  });

  it('запобіжник відкритий → пускає, не чекаючи таймаутів', async () => {
    const b = createBudget({ redis: fakeRedis({ breaker: true }) });
    expect((await b.consume({ product: 'p', productCap: 1, now: day })).allowed).toBe(true);
  });

  it('рахує спробу навіть коли стеля вже закрита', async () => {
    // Інакше добова картина брехала б рівно на розмір зловживання, яке її й
    // цікавить.
    const b = createBudget({ redis: fakeRedis() });
    await b.consume({ product: 'p', productCap: 1, now: day });
    await b.consume({ product: 'p', productCap: 1, now: day });
    const third = await b.consume({ product: 'p', productCap: 1, now: day });
    expect(third.used).toBe(3);
  });
});
