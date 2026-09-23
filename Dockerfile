# Inventory service.
#
#   docker build -t scaleezy-inventory-backend .
#   docker run --env-file .env -p 4006:4006 scaleezy-inventory-backend
#
# Three stages, so the image that runs holds only what running needs: the compiled server, the
# production packages, the Prisma client and its engine, and the migrations. No TypeScript
# sources, no dev packages, and never a secret -- settings come from the environment at run time
# (see .env.example), and .dockerignore keeps .env, keys and credential files out of the build.
#
# Debian slim rather than Alpine: Prisma's query engine is built against glibc and OpenSSL 3,
# which bookworm has as standard. On Alpine it needs a different engine and musl quirks.

ARG NODE_VERSION=22.16.0

# ── 1. Packages ─────────────────────────────────────────────────────────────────────────────
FROM node:${NODE_VERSION}-bookworm-slim AS deps
WORKDIR /app
# openssl for `prisma generate` to detect the right engine.
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
# Lockfile exactly; the postinstall of @prisma/client needs the schema, which comes next.
RUN npm ci --ignore-scripts

# ── 1b. The shopper-facing app ──────────────────────────────────────────────────────────────
# Its own stage, with its own packages: the shop app is a Vite build and shares nothing with the
# server's dependencies, so a change to one does not throw away the other's cached layer.
FROM node:${NODE_VERSION}-bookworm-slim AS shop
WORKDIR /shop
COPY shop/package.json shop/package-lock.json ./
RUN npm ci
COPY shop/index.html shop/vite.config.js ./
COPY shop/src ./src
RUN npm run build

# ── 2. Build ────────────────────────────────────────────────────────────────────────────────
FROM deps AS build
COPY prisma ./prisma
COPY tsconfig.json ./
COPY src ./src
# Not `npm run build`: that also runs `prisma migrate deploy`, which needs the database. An
# image is built once and run in many places; changing a database belongs to starting one.
RUN npx prisma generate && npx tsc
# Drop dev packages, keeping the generated client in node_modules/.prisma.
RUN npm prune --omit=dev

# ── 3. Run ──────────────────────────────────────────────────────────────────────────────────
FROM node:${NODE_VERSION}-bookworm-slim AS runtime
WORKDIR /app
# tini runs as PID 1 so `docker stop` reaches Node as a signal, instead of a ten-second wait
# and a kill that cuts off whatever request was in flight.
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates tini \
  && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    PORT=4006

COPY --from=build --chown=node:node /app/package.json ./package.json
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/prisma ./prisma
# Served by shop-page.routes.ts, which resolves it as ../../shop/dist from dist/routes.
COPY --from=shop --chown=node:node /shop/dist ./shop/dist
COPY --chown=node:node docker-entrypoint.sh ./docker-entrypoint.sh
# A checkout on Windows can give the script CRLF endings, and /bin/sh then reports it "not found".
RUN sed -i 's/\r$//' ./docker-entrypoint.sh && chmod +x ./docker-entrypoint.sh

# Not root: a hole in a dependency is then a hole in an unprivileged process.
USER node

EXPOSE 4006

# /health answers without touching the database, so a slow database does not get a healthy
# container restarted in a loop. /ready is the one that checks the database.
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4006)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/usr/bin/tini", "--", "./docker-entrypoint.sh"]
CMD ["node", "dist/server.js"]
