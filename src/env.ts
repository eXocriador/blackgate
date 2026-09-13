import { defineEnv, str, num, url } from '@exo/kit/env';

/**
 * Середовище читається один раз і валідується на старті — єдине місце в
 * сервісі, де торкаються `process.env`.
 */
export const schema = {
  NODE_ENV: str({ default: 'production' }),
  PORT: num({ default: 3000, min: 1, max: 65_535 }),

  // Шлюз, перед яким ми стоїмо.
  GATEWAY_URL: url({ default: 'http://172.17.0.1:8318', protocols: ['http', 'https'] }),
  GATEWAY_API_KEY: str({ describe: 'ключ до VibeConduit', secret: true, min: 8 }),

  // Реєстр моделей. Монтується з теки продукту :ro, тож правиться без релізу.
  CATALOG_PATH: str({ default: '/app/config/catalog.yaml' }),
  CATALOG_WATCH_MS: num({ default: 15_000, min: 0 }),

  // Ключі продуктів: "<продукт>:<секрет>", через кому. Ключ на продукт — те,
  // чого не було: exointel і teamself ходили кожен зі своїм ключем до шлюзу,
  // але шлюз їх не розрізняв і не рахував.
  PRODUCT_KEYS: str({ describe: 'ключі продуктів: exointel:SECRET,teamself:SECRET', secret: true }),

  DATABASE_URL: url({ optional: true, protocols: ['postgres', 'postgresql'] }),
  REDIS_URL: url({ optional: true, protocols: ['redis', 'rediss'] }),

  DAILY_CAP_PER_PRODUCT: num({ default: 2000, min: 1 }),
  DAILY_CAP_PER_SUBJECT: num({ default: 300, min: 1 }),

  POOL_PROBE_INTERVAL_MS: num({ default: 300_000, min: 0 }),
  POOL_COOLDOWN_MS: num({ default: 600_000, min: 1_000 }),

  LADDER_RETRIES: num({ default: 2, min: 0, max: 5 }),

  APP_VERSION: str({ default: 'dev' }),
  SENTRY_DSN: str({ optional: true }),
  LOG_LEVEL: str({ default: 'info' }),
};

export type Env = ReturnType<typeof loadEnv>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env) {
  return defineEnv(schema, source as Record<string, string | undefined>);
}
