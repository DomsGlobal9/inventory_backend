# ScaleEzy WhatsApp Service. Node 20 pinned by version and digest.
FROM node:22.23.2-bookworm-slim@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5 AS build
WORKDIR /app
# Prisma's engines need OpenSSL.
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json .npmrc ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json tsconfig.build.json ./
COPY prisma ./prisma
COPY src ./src
COPY scripts ./scripts
RUN npm run build && npm prune --omit=dev --no-audit --no-fund

FROM node:22.23.2-bookworm-slim@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates tini && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/prisma ./prisma
USER node
EXPOSE 10000
# tini passes SIGTERM to node, so a deploy lets the send in progress finish (graceful shutdown).
ENTRYPOINT ["/usr/bin/tini", "--"]
# Database migrations first (safe to repeat), then the service.
CMD ["sh", "-c", "node_modules/.bin/prisma migrate deploy && exec node dist/src/main.js"]
