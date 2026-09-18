# ScaleEzy WhatsApp Service. Node 20 pinned by version and digest.
FROM node:20.20.2-bookworm-slim@sha256:2cf067cfed83d5ea958367df9f966191a942351a2df77d6f0193e162b5febfc0 AS build
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

FROM node:20.20.2-bookworm-slim@sha256:2cf067cfed83d5ea958367df9f966191a942351a2df77d6f0193e162b5febfc0
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
