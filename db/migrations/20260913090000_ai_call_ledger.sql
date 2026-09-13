-- migrate:up

-- Облік викликів моделей. Доти не писався НІДЕ і НІЧОГО: ні exointel, ні
-- teamself, ні exoanima, ні exopost не знали, скільки коштував день.
CREATE TABLE ai_call (
  id             bigserial PRIMARY KEY,
  at             timestamptz NOT NULL DEFAULT now(),

  -- Хто питав. Продукт — з ключа, тож підробити його клієнт не може.
  product        text        NOT NULL,
  -- Кого продукт обслуговував, якщо сказав (user:123, conv:456). Потрібен
  -- добовому ліміту на кінцевого клієнта — спадкоємцю spend.ts.
  subject        text,
  request_id     text,

  tier           text        NOT NULL,
  -- Номер сходинки драбини: 0 — основна. Стовпчик, заради якого варто було
  -- заводити таблицю: він показує, чи драбина взагалі працює і як часто
  -- основна модель не дає відповіді.
  rung           smallint    NOT NULL,
  model          text        NOT NULL,
  pool           text        NOT NULL,

  outcome        text        NOT NULL,
  http_status    integer,
  latency_ms     integer     NOT NULL,
  tries          smallint    NOT NULL DEFAULT 1,

  prompt_tokens      integer,
  completion_tokens  integer,
  total_tokens       integer,

  -- NULL означає «вартість невідома», і це не тимчасова діра, а чесний стан.
  -- Шлюз віддає токени (перевірено на всіх чотирьох пулах), але ціни за токен
  -- у цих каналів (Antigravity, Vertex через особистий акаунт) ми не знаємо.
  -- Вигадана цифра гірша за порожню: за нею ухвалювали б рішення.
  -- Заповнюється, щойно в реєстрі з'явиться price_*_per_mtok у моделі.
  cost_usd       numeric(12, 6),

  detail         text
);

-- «Скільки цей продукт спалив за день» і «як часто драбина сповзала» — два
-- питання, заради яких таблиця існує.
CREATE INDEX ai_call_at_idx          ON ai_call (at DESC);
CREATE INDEX ai_call_product_at_idx  ON ai_call (product, at DESC);
CREATE INDEX ai_call_pool_at_idx     ON ai_call (pool, at DESC);

-- migrate:down
DROP TABLE ai_call;
