import { defineEnv, str, num, url, bool } from '@exo/kit/env';

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
  // Заглушка замість моделей — кому і як (src/stub/config.ts). Та сама тека,
  // що й реєстр; файла немає — заглушка вимкнена для всіх.
  STUB_PATH: str({ default: '/app/config/stub.yaml' }),

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

  // Журнал запитів (ai_request). Дефолти — налаштування в панелі їх перекривають.
  // Вміст — повідомлення клієнтів і відповіді моделей; власник просив повний
  // аудит, тож за замовчуванням пишеться, а строк вмісту — 90 днів.
  JOURNAL_STORE_CONTENT: bool({ default: true }),
  JOURNAL_CONTENT_DAYS: num({ default: 90, min: 0 }),
  // Рядок журналу без вмісту (хто, коли, статус, токени). 0 — без строку.
  JOURNAL_RETENTION_DAYS: num({ default: 365, min: 0 }),

  // Панель керування — окремий слухач. Без ADMIN_HTPASSWD він не піднімається
  // зовсім: панель без пароля гірша за відсутню. Рядок той самий, що в Traefik
  // (`user:$apr1$…` або bcrypt), кілька — через кому.
  ADMIN_PORT: num({ default: 3001, min: 1, max: 65_535 }),
  ADMIN_HTPASSWD: str({ optional: true, secret: true, describe: 'htpasswd панелі: user:hash' }),
  ADMIN_WEB_ROOT: str({ default: '/app/web' }),

  // Management API двигуна під VibeConduit (лише читання стану акаунтів). Немає —
  // розділ «Підписки» каже, як увімкнути.
  UPSTREAM_MANAGEMENT_KEY: str({ optional: true, secret: true }),
  UPSTREAM_PANEL_URL: url({ optional: true, protocols: ['http', 'https'] }),

  APP_VERSION: str({ default: 'dev' }),
  SENTRY_DSN: str({ optional: true }),
  LOG_LEVEL: str({ default: 'info' }),
};

export type Env = ReturnType<typeof loadEnv>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env) {
  return defineEnv(schema, source as Record<string, string | undefined>);
}
