/**
 * exo-ai — шлюз до моделей: пули, драбина запасних ходів, облік.
 *
 * Стоїть ПЕРЕД VibeConduit, а не замість нього. Шлюз лишається виходом до
 * провайдерів (там автентифікація до Google і Vertex), exo-ai бере політику:
 * реєстр моделей, здоров'я пулів, драбину, ретраї, стелі, облік.
 */
import { createDb, createRedis } from '@exo/kit/infra';
import { createHealth } from '@exo/kit/health';
import { createLogger } from '@exo/kit/log';
import { loadEnv } from './env.js';
import { loadCatalog, CatalogError } from './catalog/index.js';
import { createGateway } from './upstream/gateway.js';
import { createPoolHealth } from './pools/health.js';
import { createLadder } from './ladder/run.js';
import { createBudget } from './accounting/budget.js';
import { createLedger } from './accounting/ledger.js';
import { parseProductKeys, KeyConfigError } from './http/auth.js';
import { createHttpServer } from './http/server.js';

async function main(): Promise<void> {
  const env = loadEnv();
  // `@exo/kit/log` уже віддає рівно ту пару, якої тут треба, — подія плюс поля.
  const { logInfo, logWarn, logError } = createLogger({ service: 'exo-ai', level: env.LOG_LEVEL });

  const keys = parseProductKeys(env.PRODUCT_KEYS);
  logInfo('boot.keys', { products: keys.products });

  /**
   * Реєстр читається ПЕРШИМ і на старті падає голосно.
   *
   * Саме тут спрацьовує інваріант, заради якого існує сервіс: конфіг, у якому
   * наступна сходинка драбини лежить у пулі попередньої, сюди не проходить.
   * Не «логується попередження» і не «береться дефолт» — процес не стартує, і
   * повідомлення називає обидві сходинки. Мовчазне прийняття такого конфігу
   * і є сьогоднішній дефект teamself; перевірка мусить стояти там, де її не
   * можна оминути, а не там, де про неї треба пам'ятати.
   */
  const catalog = await loadCatalog({
    path: env.CATALOG_PATH,
    watchIntervalMs: env.CATALOG_WATCH_MS,
    logInfo,
    logWarn,
  });
  const cat = catalog.current();
  logInfo('boot.catalog', {
    path: env.CATALOG_PATH,
    pools: cat.poolNames,
    models: cat.models.size,
    tiers: cat.tierNames,
  });

  const db = createDb({
    url: env.DATABASE_URL,
    reportError: (err, ctx) => logError('db.error', err, { ...ctx }),
  });
  const redis = createRedis({
    url: env.REDIS_URL,
    reportError: (err, ctx) => logError('redis.error', err, { ...ctx }),
  });

  const gateway = createGateway({ baseUrl: env.GATEWAY_URL, apiKey: env.GATEWAY_API_KEY });

  const pools = createPoolHealth({
    gateway,
    catalog: () => catalog.current(),
    intervalMs: env.POOL_PROBE_INTERVAL_MS,
    cooldownMs: env.POOL_COOLDOWN_MS,
    logInfo,
    logWarn,
  });

  const ladder = createLadder({ gateway, pools, retries: env.LADDER_RETRIES, logWarn });
  const budget = createBudget({ redis, logWarn });
  const ledger = createLedger({ db, catalog: () => catalog.current(), logWarn });

  const health = createHealth({
    version: env.APP_VERSION,
    checks: {
      // Реєстр у пам'яті — те, без чого сервіс не може ухвалити жодного
      // рішення. Він є завжди (інакше процес не стартував би), тож перевірка
      // тут стереже не старт, а перечитування: відхилений reload лишає
      // попередній реєстр, і ця перевірка каже, що він на місці.
      catalog: () => catalog.current().tierNames.length > 0,
      // Облік. БД не налаштована — це стан, а не поломка.
      database: async () => {
        if (!env.DATABASE_URL) return 'skip';
        return (await db.query((sql) => sql`SELECT 1`)) !== null;
      },
      // Лічильники стель.
      redis: async () => {
        if (!env.REDIS_URL) return 'skip';
        if (!redis.client) return false;
        try { return (await redis.client.ping()) === 'PONG'; } catch { return false; }
      },
      /**
       * Хоч один пул придатний.
       *
       * НЕ «шлюз відповідає» і НЕ «всі пули здорові». Вичерпаний пул — не
       * поломка сервісу: він рівно те, заради чого сервіс написаний, і
       * монітор, що червонів би на кожен 429 в Antigravity, навчив би читача
       * себе ігнорувати. А от коли придатного не лишилось ЖОДНОГО, драбині
       * нема куди йти, і це вже наша непридатність.
       */
      pools: () => catalog.current().poolNames.some((p) => pools.usable(p)),
    },
    required: ['catalog', 'pools'],
    reportError: (err, ctx) => logError('health.error', err, { ...ctx }),
  });

  const server = createHttpServer({
    keys, catalog, pools, ladder, budget, ledger, health,
    caps: { product: env.DAILY_CAP_PER_PRODUCT, subject: env.DAILY_CAP_PER_SUBJECT },
    version: env.APP_VERSION,
    logWarn,
  });

  server.listen(env.PORT, '0.0.0.0', () => {
    logInfo('boot.listening', { port: env.PORT, version: env.APP_VERSION });
  });

  // Перший обхід пулів одразу, далі за розкладом. Без нього перші хвилини
  // життя сервіс ходив би в мертвий пул за рахунок клієнта — рівно те, від
  // чого мав би рятувати.
  void pools.sweep().then(() => pools.start());

  const shutdown = (signal: string) => {
    logInfo('shutdown', { signal });
    pools.stop();
    catalog.stop();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5_000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  // Поганий реєстр і погані ключі друкуються списком проблем, а не одним
  // рядком: оператор має побачити все, що не так, за один запуск.
  if (err instanceof CatalogError) {
    console.error(`exo-ai: реєстр непридатний — сервіс не стартує\n  - ${err.problems.join('\n  - ')}`);
  } else if (err instanceof KeyConfigError) {
    console.error(`exo-ai: ${err.message}`);
  } else {
    console.error('exo-ai: старт не вдався', err);
  }
  process.exit(1);
});
