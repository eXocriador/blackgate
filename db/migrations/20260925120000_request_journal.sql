-- migrate:up

-- Журнал запитів: один рядок на КОЖЕН /v1/complete, і відмови теж.
--
-- `ai_call` відповідає на «скільки і чим відповідали моделі» — рядок там є
-- лише у спроби драбини. Відмова до драбини (400 на форму, 429 стелі) у ньому
-- не лишала нічого, а вмісту — що спитали і що відповіли — там немає за
-- задумом. Власник 2026-09-25: повний аудит вводу й виводу в самому blackgate.
CREATE TABLE ai_request (
  id              bigserial   PRIMARY KEY,
  at              timestamptz NOT NULL DEFAULT now(),

  -- `api` — продукт через /v1/complete; `console` — пісочниця панелі.
  source          text        NOT NULL DEFAULT 'api',
  -- З ключа. NULL лише на 401: хто питав, невідомо, і вмісту тоді немає.
  product         text,
  subject         text,
  request_id      text,

  -- Трейси (OpenTelemetry): `traceparent` і `metadata` від продукту.
  trace_id        text,
  parent_span_id  text,
  session_id      text,
  metadata        jsonb,

  tier            text,
  stub            boolean     NOT NULL DEFAULT false,
  -- Ефективні max_tokens і temperature — те, що пішло моделі, а не те, що
  -- продукт написав (сервер їх обрізає до меж).
  params          jsonb,

  -- Вміст. Пишеться лише з увімкненим «зберігати вміст» (налаштування); строк
  -- вмісту спливає — стовпчики стають NULL, а рядок лишається для обліку.
  input           jsonb,
  output          text,
  content_stored  boolean     NOT NULL DEFAULT false,
  content_purged_at timestamptz,

  status          integer     NOT NULL,
  error           text,
  error_detail    text,

  -- Хто відповів (NULL — ніхто) і скільки спроб знадобилось. Самі спроби —
  -- рядки `ai_call` з `request_ref` = цей id.
  model           text,
  pool            text,
  rung            smallint,
  attempts        smallint    NOT NULL DEFAULT 0,

  -- Сума по всіх спробах, а не лише тій, що відповіла: невдала спроба теж
  -- палить токени, коли шлюз їх рахує.
  prompt_tokens      integer,
  completion_tokens  integer,
  total_tokens       integer,

  latency_ms      integer     NOT NULL
);

CREATE INDEX ai_request_at_idx         ON ai_request (at DESC);
CREATE INDEX ai_request_product_at_idx ON ai_request (product, at DESC);
CREATE INDEX ai_request_trace_idx      ON ai_request (trace_id) WHERE trace_id IS NOT NULL;
CREATE INDEX ai_request_request_id_idx ON ai_request (request_id) WHERE request_id IS NOT NULL;

-- Спроба знає свій запит. ON DELETE SET NULL: строк журналу спливає, а облік
-- спроб — ні; рядок `ai_call` лишається, втративши лише посилання.
ALTER TABLE ai_call ADD COLUMN request_ref bigint REFERENCES ai_request (id) ON DELETE SET NULL;
CREATE INDEX ai_call_request_ref_idx ON ai_call (request_ref) WHERE request_ref IS NOT NULL;

-- migrate:down
DROP INDEX ai_call_request_ref_idx;
ALTER TABLE ai_call DROP COLUMN request_ref;
DROP TABLE ai_request;
