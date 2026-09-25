-- migrate:up

-- Налаштування, які панель міняє без релізу: стелі (на продукт і гаманець, з
-- перекриттям на продукт) і журнал (зберігати вміст, строки). Рядок —
-- ПЕРЕКРИТТЯ: чого тут немає, те береться з .env, тож дефолт лишається там, де
-- був, а панель показує, що саме перекрито.
CREATE TABLE setting (
  key         text        PRIMARY KEY,
  value       jsonb       NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  updated_by  text        NOT NULL
);

-- Аудит дій і версії з відкатом — одна таблиця. Кожна зміна налаштувань,
-- реєстру моделей або заглушки з панелі: хто, коли, повний вміст ДО і ПІСЛЯ,
-- різниця. «До» читається з диска в мить запису, тож правка руками (vim) між
-- двома змінами з панелі теж видна — як частина різниці наступної.
CREATE TABLE config_change (
  id             bigserial   PRIMARY KEY,
  at             timestamptz NOT NULL DEFAULT now(),
  actor          text        NOT NULL,
  kind           text        NOT NULL CHECK (kind IN ('settings', 'catalog', 'stub')),
  -- `update` — правка; `restore` — повернення до вмісту іншої зміни.
  action         text        NOT NULL DEFAULT 'update' CHECK (action IN ('update', 'restore')),
  restored_from  bigint      REFERENCES config_change (id) ON DELETE SET NULL,
  note           text,
  before         text,
  after          text        NOT NULL,
  diff           text        NOT NULL
);

CREATE INDEX config_change_kind_at_idx ON config_change (kind, at DESC);

-- migrate:down
DROP TABLE config_change;
DROP TABLE setting;
