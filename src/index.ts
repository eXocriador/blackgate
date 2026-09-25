/**
 * blackgate (до 2026-09-24 exo-ai) — шлюз до моделей: пули, драбина запасних ходів, облік.
 *
 * Стоїть ПЕРЕД VibeConduit, а не замість нього. Шлюз лишається виходом до
 * провайдерів (там автентифікація до Google і Vertex), blackgate бере політику:
 * реєстр моделей, здоров'я пулів, драбину, ретраї, стелі, облік.
 */
import { createDb, createRedis } from '@exo/kit/infra';
import { createHealth } from '@exo/kit/health';
import { createLogger } from '@exo/kit/log';
import { loadEnv } from './env.js';
import { loadCatalog, CatalogError } from './catalog/index.js';
import { createGateway } from './upstream/gateway.js';
import { createUpstreamHealth, withUpstream } from './upstream/login.js';
import { createPoolHealth } from './pools/health.js';
import { createLadder } from './ladder/run.js';
import { createBudget } from './accounting/budget.js';
import { createLedger } from './accounting/ledger.js';
import { createJournal } from './journal/journal.js';
import { createRetention } from './journal/retention.js';
import { capsFor, createSettings } from './settings/settings.js';
import { createBasicAuth, parseHtpasswd, HtpasswdError } from './admin/basic.js';
import { createChanges } from './admin/changes.js';
import { createQueries } from './admin/queries.js';
import { createUpstreamAdmin } from './admin/upstream.js';
import { createAdminServer } from './admin/server.js';
import { stat } from 'node:fs/promises';
import { parseProductKeys, KeyConfigError } from './http/auth.js';
import { createHttpServer } from './http/server.js';
import { loadStub, describeRoutes, StubConfigError } from './stub/config.js';
import { createStub } from './stub/run.js';

async function main(): Promise<void> {
  const env = loadEnv();
  // `@exo/kit/log` уже віддає рівно ту пару, якої тут треба, — подія плюс поля.
  const { logInfo, logWarn, logError } = createLogger({ service: 'blackgate', level: env.LOG_LEVEL });

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

  // Заглушка — після реєстру і з тим самим правилом: поганий файл на старті
  // валить процес, бо тихо вимкнена заглушка, на яку хтось розраховує, так
  // само погана, як тихо ввімкнена.
  const stubConfig = await loadStub({
    path: env.STUB_PATH,
    watchIntervalMs: env.CATALOG_WATCH_MS,
    logInfo,
    logWarn,
  });
  logInfo('boot.stub', { path: env.STUB_PATH, routes: describeRoutes(stubConfig.current()) });

  const db = createDb({
    url: env.DATABASE_URL,
    reportError: (err, ctx) => logError('db.error', err, { ...ctx }),
  });
  const redis = createRedis({
    url: env.REDIS_URL,
    reportError: (err, ctx) => logError('redis.error', err, { ...ctx }),
  });

  // Вхід апстріму бачить кожну відповідь шлюзу — і драбини, і проб. Вікно —
  // три обходи пулів: при справжній відмові свіжі докази приходять щообходу.
  const upstream = createUpstreamHealth({
    catalog: () => catalog.current(),
    windowMs: Math.max(3 * env.POOL_PROBE_INTERVAL_MS, 15 * 60_000),
    logInfo,
    logWarn,
  });
  const gateway = createGateway({
    baseUrl: env.GATEWAY_URL,
    apiKey: env.GATEWAY_API_KEY,
    onResult: (req, res) => upstream.observe(req.model, res),
  });

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
  // Налаштування: .env — дефолти, рядок `setting` — перекриття з панелі.
  const settings = createSettings({
    db,
    defaults: {
      capProduct: env.DAILY_CAP_PER_PRODUCT,
      capSubject: env.DAILY_CAP_PER_SUBJECT,
      storeContent: env.JOURNAL_STORE_CONTENT,
      contentDays: env.JOURNAL_CONTENT_DAYS,
      retentionDays: env.JOURNAL_RETENTION_DAYS,
    },
    logWarn,
  });
  if (env.DATABASE_URL) {
    // Не вирок старту: без бази сервіс працює на дефолтах з .env, як і до панелі.
    if (!(await settings.refresh())) logWarn('boot.settings_unavailable', {});
    settings.start();
  }

  const ledger = createLedger({ db, catalog: () => catalog.current(), logWarn });
  const journal = createJournal({ db, ledger, storeContent: () => settings.current().journal.storeContent, logWarn });
  const retention = createRetention({
    db,
    contentDays: () => settings.current().journal.contentDays,
    journalDays: () => settings.current().journal.retentionDays,
    logInfo,
    logWarn,
  });
  const stub = createStub({ config: () => stubConfig.current(), retries: env.LADDER_RETRIES });

  const infra = createHealth({
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
  // `checks.upstream`: протухлий вхід до Google — 503, хоч пули й «придатні».
  const health = withUpstream(infra, upstream);

  const caps = (product: string) => capsFor(settings.current(), product);
  const server = createHttpServer({
    keys, catalog, pools, ladder, budget, journal, stub, health, caps,
    version: env.APP_VERSION,
    logWarn,
  });

  server.listen(env.PORT, '0.0.0.0', () => {
    logInfo('boot.listening', { port: env.PORT, version: env.APP_VERSION });
  });

  // Панель — лише з паролем. Поганий ADMIN_HTPASSWD валить старт так само, як
  // поганий реєстр: тихо вимкнена панель, на яку розраховують, — теж поломка.
  let admin: ReturnType<typeof createAdminServer> | null = null;
  if (env.ADMIN_HTPASSWD) {
    const webRoot = (await stat(env.ADMIN_WEB_ROOT).catch(() => null))?.isDirectory() ? env.ADMIN_WEB_ROOT : null;
    admin = createAdminServer({
      auth: createBasicAuth({ entries: parseHtpasswd(env.ADMIN_HTPASSWD) }),
      version: env.APP_VERSION,
      products: keys.products,
      catalog,
      stubConfig,
      pools,
      budget,
      settings,
      changes: createChanges({
        db, catalogPath: env.CATALOG_PATH, stubPath: env.STUB_PATH,
        catalog, stub: stubConfig, settings, logInfo,
      }),
      queries: createQueries(db),
      journal,
      upstream: createUpstreamAdmin({ baseUrl: env.GATEWAY_URL, key: env.UPSTREAM_MANAGEMENT_KEY }),
      upstreamPanelUrl: env.UPSTREAM_PANEL_URL ?? null,
      health,
      complete: { catalog, ladder, budget, stub, caps },
      retention,
      webRoot,
      startedAt: new Date(),
      logInfo,
      logWarn,
    });
    admin.listen(env.ADMIN_PORT, '0.0.0.0', () => {
      logInfo('boot.admin_listening', { port: env.ADMIN_PORT, web: webRoot });
    });
  } else {
    logWarn('boot.admin_disabled', { reason: 'ADMIN_HTPASSWD порожній' });
  }

  // Перший обхід пулів одразу, далі за розкладом. Без нього перші хвилини
  // життя сервіс ходив би в мертвий пул за рахунок клієнта — рівно те, від
  // чого мав би рятувати.
  void pools.sweep().then(() => pools.start());
  if (env.DATABASE_URL) retention.start();

  const shutdown = (signal: string) => {
    logInfo('shutdown', { signal });
    pools.stop();
    retention.stop();
    settings.stop();
    catalog.stop();
    stubConfig.stop();
    admin?.close();
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
    console.error(`blackgate: реєстр непридатний — сервіс не стартує\n  - ${err.problems.join('\n  - ')}`);
  } else if (err instanceof StubConfigError) {
    console.error(`blackgate: stub.yaml непридатний — сервіс не стартує\n  - ${err.problems.join('\n  - ')}`);
  } else if (err instanceof KeyConfigError || err instanceof HtpasswdError) {
    console.error(`blackgate: ${err.message}`);
  } else {
    console.error('blackgate: старт не вдався', err);
  }
  process.exit(1);
});
