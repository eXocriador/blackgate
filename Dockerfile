# blackgate — один Node-процес. Контекст — корінь репо (git archive HEAD, §3).
# Стандарт §5: node:22-bookworm-slim, multi-stage, npm ci, фінальний образ без
# dev-залежностей, USER non-root.

# ── залежності ──────────────────────────────────────────────────────────────
FROM node:22-bookworm-slim AS deps
WORKDIR /app
# Лише маніфести, щоб шар install кешувався від змін коду.
COPY package.json package-lock.json ./
RUN npm ci

# ── збірка + ворота ─────────────────────────────────────────────────────────
FROM deps AS build
COPY . .
RUN npm run build
# Ворота тут, у стадії образу, а не на хості: на хості вони йшли б від іншого
# node_modules і від некоміченого дерева (урок ревізії — ворота tsc/тестів у
# стадії builder).
RUN npm run typecheck && npm test

# ── лише продові залежності ─────────────────────────────────────────────────
FROM node:22-bookworm-slim AS prod-deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# ── рантайм ─────────────────────────────────────────────────────────────────
FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app

# dbmate у ОБРАЗ ПРОДУКТУ — навмисно, і це перша така збірка в /srv.
#
# `exo-deploy` має вбудовану гілку `MIGRATE=dbmate`, яка запускає раннер САМЕ
# образом продукту (`docker run … blackgate-web dbmate …`). Досі гілка стояла
# невикористаною: у netwatch і filebrowser dbmate в образі немає, а `.env`
# зве рядок `POSTGRES_URL`, тоді як dbmate читає тільки `DATABASE_URL` — тож
# обидва лишили власні migrate.sh з окремим контейнером `amacneil/dbmate`
# (причина виписана в netwatch/deploy.conf). Новий продукт не має цього
# спадку: він бере канонічне ім'я `DATABASE_URL` (§5 C3, _template/.env.example)
# і несе бінарник. Разом це робить `MIGRATE=dbmate` уперше справді робочим,
# а migrate.sh у продукті не потрібним узагалі.
#
# Статичний бінарник з офіційного образу тієї ж версії, що в migrate.sh двох
# сусідів, — щоб схему котив один і той самий dbmate по всьому /srv.
COPY --from=ghcr.io/amacneil/dbmate:2.35.1 /usr/local/bin/dbmate /usr/local/bin/dbmate

COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=prod-deps /app/package.json ./package.json
COPY --from=build /app/dist ./dist
# Міграції їдуть у той самий образ, що й код: схема завжди та сама, що й той,
# хто її читає.
COPY db ./db
# Реєстр за замовчуванням — у теці, а не файлом у корені: у проді поверх неї
# монтується /srv/products/blackgate/config :ro. Саме ТЕКА, бо bind-монт одного
# файла прив'язує контейнер до inode, і правка через rename (sed -i, vim, mv)
# до нього вже ніколи не доїде — мовчки. Без монту образ лишається
# самодостатнім.
COPY catalog.yaml ./config/catalog.yaml

ARG APP_VERSION=dev
ENV APP_VERSION=$APP_VERSION

USER node
EXPOSE 3000
CMD ["node", "dist/index.js"]
