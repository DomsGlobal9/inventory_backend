# ScaleEzy WhatsApp Service

> Lives in the **inventory_backend** repo as `whatsapp-service/`, and is **deployed separately** on Render (Blueprint path `whatsapp-service/render.yaml`). It shares no code, settings or database with the Inventory backend.

One service owns every WhatsApp number ScaleEzy uses and sends through the WhatsApp engine
(Evolution API). Modules (Inventory now; CRM and Marketing later) never talk to the engine; they
call this service with their own key.

- **ScaleEzy's own number** messages ScaleEzy's clients only (logins, "your WhatsApp is
  disconnected", daily snapshots, Day Book).
- **Each client links its own number** and sends to its own customers and suppliers, on button
  press only.

Background and decisions: `SPEC.md` (this repo) and `PLAN-whatsapp.md` in the Inventory repo.

```
 Inventory ─┐                                             ┌─ ScaleEzy number
 CRM later ─┼─► whatsapp-service ──► whatsapp-engine ─────┤
            │   (this repo, service/)  (engine/, private)  └─ each shop's number
            └─◄── signed webhooks: ticks, disconnects, STOP
```

## What is in here

| Path | What |
|---|---|
| `engine/` | Our engine image: Evolution API 2.3.7 (pinned by digest) + `patch-pairing.cjs`, the QR-linking fix. The build **fails** if the patch no longer fits. `docker-compose.local.yml` runs engine + Postgres + Redis on this PC. |
| `service/` | The WhatsApp Service (Node 22, TypeScript, Express, Prisma/Postgres). |
| `render.yaml` | Render Blueprint for all four pieces (not deployed yet). |
| `../.github/workflows/whatsapp-ci.yml` | Every push that touches `whatsapp-service/`: typecheck, all tests, build, and build **both** Docker images. (At the repo root, where GitHub reads it.) |
| `../.github/workflows/whatsapp-upstream-watch.yml` | Weekly: opens an issue when Evolution or Baileys release something (incl. the pairing fix). |

### Service layout (`service/src`)

| Folder | Concern |
|---|---|
| `config.ts` | Every setting, checked at start (zod). Missing or malformed secret = refuses to start, naming it. |
| `engine/client.ts` | The only code that calls the engine. Classifies errors (engine down, 5xx, timeout, not connected, not on WhatsApp). |
| `accounts/` | Numbers: adopt the ScaleEzy number, link a client (QR or pairing code), disconnect, status changes + alerts. |
| `messages/` | Outbox rules (idempotency, 60 s double-click rule, PDF checks, STOP list) and the one place statuses change. |
| `worker/` | Sender (one message at a time per number, 4-9 s gaps, daily caps, retries, expiry, crash recovery), leader lock, runner. |
| `events/` | Engine webhook handler, and the module-webhook outbox (signed, retried, at-least-once). |
| `health/` | 5-minute health watch, daily canary. |
| `http/` | Routes, auth, plain-English errors. |
| `lib/` | Phone numbers, crypto, PDF check, log scrubbing. |

## API (JSON, `/v1`)

**Adding WhatsApp to another module (CRM, Marketing, Billing): read [docs/USING-FROM-A-MODULE.md](docs/USING-FROM-A-MODULE.md).**

Module calls carry `x-module-key`; the platform console uses `x-admin-key`. Every error is
`{ "error": { "code", "message" } }` with a plain-English message; never a stack trace.

| Method | Path | Notes |
|---|---|---|
| POST | `/v1/accounts/client/:clientId/link` | `{ method: 'qr' \| 'code', phone? }` → `{ status, qr?, pairingCode? }`. Never touches a connected number. |
| GET | `/v1/accounts/client/:clientId` | `{ status, phone (masked), linkedAt, lastSeenAt }` |
| POST | `/v1/accounts/client/:clientId/disconnect` | Logs the number out → `LOGGED_OUT`. |
| POST | `/v1/messages` | `{ from: 'scaleezy' \| { clientId }, to, text?, document?: { fileName, mimeType: 'application/pdf', base64 }, kind, reference?, idempotencyKey }` → `202 { id, status }` (`duplicate: true` when an earlier message is returned). |
| GET | `/v1/messages/:id` | Status and times (`sentAt`, `engineConfirmedAt`, `deliveredAt`, `readAt`, `failReason`). Own messages only. |
| POST | `/v1/numbers/check` | `{ from, to }` → `{ onWhatsApp }` (cached 7 days). |
| POST | `/engine/events/:secret` | The engine's webhook (secret compared in constant time). |
| GET | `/admin/accounts`, `/admin/accounts/verify`, `/admin/messages?status=&since=`, `/admin/canary` | Console views. No message text, full numbers masked. |
| POST | `/admin/accounts/:id/reconnect`, `/admin/canary/run`, `/admin/health-watch/run` | Console actions. |
| GET | `/health` (no detail), `/ready` (database + engine) | |

Refusals (4xx, plain English): number not linked / disconnected, invalid `to`, person replied
STOP, PDF over 5 MB or not a PDF (`%PDF-` check), a module sending as ScaleEzy without
`canSendAsScaleEzy`, a module acting for a client it may not (hook: `src/auth/allow.ts`).

### Module webhooks

Each event is `POST`ed to the module's `webhookUrl` as
`{ id, type, occurredAt, data }` with headers `x-event-id`, `x-event-type` and
`x-signature: sha256=<hex HMAC-SHA256(webhook secret, raw body)>`. Delivery is at-least-once
(3 tries: now, +10 s, +60 s, then recorded as failed): **dedupe by `id`**.

| type | when |
|---|---|
| `message.status` | a message moved forward: SENT, DELIVERED, READ, FAILED, EXPIRED (never backwards, one event per real change) |
| `account.disconnected` | a number went CONNECTED → DISCONNECTED / LOGGED_OUT (confirmed, not on a blip) |
| `account.connected`, `account.status` | other status changes |
| `contact.opted_out` | someone replied STOP |

### Ticks, and messages to yourself

`SENT` = the engine sent it; `engineConfirmedAt` = the engine's own event about it (its send
event or any WhatsApp tick) reached the service; `DELIVERED`/`READ` = the recipient's phone.
Checked on the real engine: **a message to one's own number gets no delivered tick**, and even
the server tick only arrives when the phone next syncs (minutes to hours later). So the canary,
when sent to the ScaleEzy number itself, passes once it is sent and confirmed by the engine; set
`CANARY_TO` to a second phone (spare SIM) for a real delivered check.

## Running locally

Needs Docker Desktop and Node 22 (`.nvmrc`).

```powershell
# 1. Engine + Postgres + Redis (keeps the linked ScaleEzy session: it lives in Postgres)
cd engine
copy .env.example .env.local   # fill in the three values once
docker compose -f docker-compose.local.yml --env-file .env.local up -d
# one time: the service's own databases on the same Postgres
docker exec scaleezy-whatsapp-local-db-1 psql -U evolution -d evolution -c "CREATE DATABASE whatsapp"
docker exec scaleezy-whatsapp-local-db-1 psql -U evolution -d evolution -c "CREATE DATABASE whatsapp_test"

# 2. The service (port 18081; the engine's webhook points at host.docker.internal:18081)
cd ..\service
copy .env.example .env         # fill in; ENGINE_API_KEY / ENGINE_WEBHOOK_SECRET = the engine's values
npm ci
npx prisma migrate deploy
npm run dev
```

Windows reserves port 8080: the engine is on **18080**, the service on **18081**.

### Tests

```powershell
npm run typecheck
npm test                                   # unit + resilience (needs TEST_DATABASE_URL, a *test* database; its tables are emptied)
npm run test:integration -- --no-send      # against the real local engine, sends nothing
npm run test:integration -- --skip-restart # + 3 real messages, ONLY to the ScaleEzy number itself
npm run test:integration                   # + 5 real messages (adds the restart test)
```

The resilience tests use a fake engine that misbehaves on purpose (down, 5xx, slow, not
connected), a real Postgres (cut off through a TCP proxy for the outage test), two service
instances on one database (single sender), and a module webhook that fails or never answers.

## Environment variables (service)

| Variable | Required | Meaning |
|---|---|---|
| `DATABASE_URL` | yes | Postgres URL of the `whatsapp` database. Time limits are added automatically. |
| `ENGINE_URL` | yes | Engine address; `host:port` is fine (Render hands over `hostport`). |
| `ENGINE_API_KEY` | yes | The engine's `AUTHENTICATION_API_KEY` (that name is also accepted). |
| `ENGINE_WEBHOOK_SECRET` | yes | Secret in the engine's webhook URL (min 24 chars). |
| `ADMIN_KEY` | yes | Console key, `x-admin-key` (min 24 chars). |
| `ENCRYPTION_KEY` | yes | 32 random bytes, base64. Encrypts module webhook secrets. **Never change it once modules exist.** |
| `SCALEEZY_INSTANCE` | yes | Engine instance of the ScaleEzy number (`phase0-test` locally, `scaleezy` on Render). |
| `SCALEEZY_DAILY_CAP` | no (150) | Messages per Indian day from the ScaleEzy number. |
| `MESSAGE_RETENTION_DAYS` | no (30) | Finished messages are deleted after this many days (7–3650). Module events go after 7 days, number checks after 7, connection history and canary runs after 90. STOPs and messages still waiting are never deleted. |
| `PORT` | no (18081; Render sets 10000) | |
| `LOG_LEVEL` | no (info) | Logs never contain message text, documents, keys, or full numbers (last 4 digits only). |
| `WORKER_ENABLED` | no (true) | Only one instance ever sends (Postgres advisory lock), so this can stay on everywhere. |
| `SEND_GAP_MIN_MS` / `SEND_GAP_MAX_MS` | no (4000 / 9000) | Human-like gap between two messages from one number. |
| `HEALTH_WATCH_INTERVAL_MS` | no (300000) | How often every number is checked with the engine. |
| `CANARY_ENABLED` | no (false) | Daily canary on/off. |
| `CANARY_TO` | no (the ScaleEzy number) | Where the canary goes. A second phone gives a real delivered check. |
| `CANARY_HOUR_IST` | no (9) | Hour (India) after which the day's canary runs. |
| `TEST_DATABASE_URL` | tests only | A throwaway database whose name contains `test`. |

Daily caps per client number: 40/day for its first 14 days after linking, then 200 (override per
number with `Account.dailyCap`). Over the cap, messages stay queued until the next Indian day.
Queued messages older than 24 h expire ("Not sent within a day, so it was not sent late.").

## Creating a module key

```powershell
cd service
npm run module:create -- --name inventory --webhook-url https://<inventory-backend>/whatsapp/events --can-send-as-scaleezy
# on Render (Shell tab of whatsapp-service):
node dist/scripts/create-module.js --name inventory --webhook-url https://... --can-send-as-scaleezy
```

The key (`WHATSAPP_SERVICE_KEY`) and webhook secret are printed **once**; only the key's sha256
and the encrypted secret are stored. Put both in the module's own secret settings. To replace a
leaked key: `--name inventory --rotate-key` (the old key stops working at once).

## Deploying to Render (not done yet)

1. **Confirm the region** of the Inventory backend and set it on all four pieces in
   `render.yaml` (placeholder: `singapore`). They must share Render's private network.
2. Push this repo to GitHub, then Render → New → Blueprint → this repo.
3. Set the `sync: false` values in the dashboard:
   - `whatsapp-service` → `ENCRYPTION_KEY`:
     `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`
   - `whatsapp-engine` → `DATABASE_CONNECTION_URI`: whatsapp-db's **internal** URL with the
     database changed to `evolution` and `?schema=evolution_api` appended.
   - `whatsapp-engine` → `WEBHOOK_GLOBAL_URL`:
     `http://<whatsapp-service internal hostname>:10000/engine/events/<ENGINE_WEBHOOK_SECRET>`
     (hostname from the service's Connect → Internal tab; the secret from the `whatsapp-shared` group).
4. One time, create the engine's database (Render Shell or psql with the external URL):
   `CREATE DATABASE evolution;`
5. Create the module key for Inventory (above).
6. Link the ScaleEzy number to the `scaleezy` instance (console link flow), then set
   `CANARY_ENABLED=true`.
7. Run the **smoke test** (below).

### Smoke test: after every deploy

```powershell
cd service
$env:ADMIN_KEY="<the service's ADMIN_KEY>"
npm run smoke -- --base https://<whatsapp-service>.onrender.com
npm run smoke -- --base https://<whatsapp-service>.onrender.com --canary   # also sends the canary
```

It checks `/health`, `/ready` (database + engine), and that every number the service believes is
CONNECTED really is connected in the engine. Exit code 0 = good. Run it after **every** deploy
of the service or the engine, and after any Render maintenance.

## Upgrading the engine, and rolling back

Every engine change goes **staging → test → production**:

1. **Staging engine**: a second private service `whatsapp-engine-staging` from the same
   `engine/` folder (Render dashboard: New → Private Service, Docker, same env group, its own
   `DATABASE_CONNECTION_URI` pointing at an `evolution_staging` database) plus a staging copy of
   the service, or point a local service at it.
2. Change `engine/Dockerfile` (new pinned tag **and** digest:
   `docker buildx imagetools inspect evoapicloud/evolution-api:<tag>`). If the build fails, the
   patch no longer fits: read `patch-pairing.cjs`, decide whether the new version still needs it.
3. On staging: link a **test** number by QR **and** by pairing code, send a text and a PDF,
   see the ticks, restart the engine, confirm it stays linked.
4. Then production (merge → Render deploys), then the smoke test.
5. **Remove the patch** when an Evolution release ships a Baileys containing the
   `companion_reg_refresh` fix (Baileys#2765, evolution PR #2727): delete `patch-pairing.cjs`
   and its two Dockerfile lines, go through steps 3-4. The weekly `upstream-watch` workflow opens
   an issue when that happens; update `.github/whatsapp-upstream-baseline.json` (repo root) once handled.

**Rollback** = the previous image: in Render, *Rollback* to the previous deploy of
`whatsapp-engine` (or revert the Dockerfile commit). Sessions live in Postgres, so a rollback
keeps every number linked. Never delete the engine's database or an instance to "fix" something:
that unlinks the number and needs a new QR scan on the phone.

## Safety rules while building and testing

- Test messages only to the ScaleEzy number itself (or a spare test SIM), spaced out.
- Never log out, delete or re-QR a linked instance. A throwaway instance to prove the QR /
  pairing-code endpoints is fine; delete it afterwards (the integration script does).
- No secrets in git: `.env*` are ignored; `.env.example` files document them.
