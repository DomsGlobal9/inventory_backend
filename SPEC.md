# ScaleEzy WhatsApp Service: build spec (Phase 1)

Read also: `D:\villy\inventory\PLAN-whatsapp.md` (sections 0, 0b, 1–5). This spec wins where they differ.

## What it is
One service that owns every WhatsApp number ScaleEzy uses and sends through the WhatsApp engine (Evolution API, `engine/`). Modules (Inventory now; CRM, Marketing later) never talk to the engine; they call this service.

- **ScaleEzy's own number** (8142424642) messages ScaleEzy's clients only: logins, "your WhatsApp is disconnected", daily snapshots, Day Book.
- **Each client links its own number** and sends to its own customers and suppliers, on button press only.

## Current local state (do not break)
- `engine/`: our image `scaleezy/whatsapp-engine:2.3.7-pairfix` (Evolution 2.3.7 + QR-linking fix, build fails if the patch no longer fits). Compose: `engine/docker-compose.local.yml`, env `engine/.env.local` (engine API key, Postgres password). Engine at `http://127.0.0.1:18080` (Windows reserves 8080).
- Instance **`phase0-test` is LINKED to the ScaleEzy number 918142424642**. Never delete it, log it out, or restart it into a new QR. The service adopts it as the ScaleEzy account through config (`SCALEEZY_INSTANCE=phase0-test` locally).
- Docker Desktop is running.

## Hard rules
- **Messages go only to 918142424642 (the linked number itself; shows as "Message yourself").** Nothing to any other number, ever, during build and test. Keep test sends to ≤ 10 in total and spaced out (ban risk).
- Do not link, unlink or scan anything. Creating a throwaway instance to prove the link endpoints return a QR / pairing code is fine; delete it afterwards.
- No secrets in git. `.env*` ignored; provide `.env.example`.
- Never log message text, phone numbers (mask to last 4), document contents, or keys.
- Plain English in every error a person may see ("This shop's WhatsApp is not linked. Link it in Settings → WhatsApp.").
- Code style: TypeScript strict, small modules, comments explain why. Separate module per concern.
- `git init` this folder (no remote yet); commit your work locally with clear messages, no Co-Authored-By line. Do not push.

## Stack
Node 20 + TypeScript + Express, Prisma + Postgres (its own database `whatsapp`, alongside the engine's `evolution` DB in the same Postgres server locally and on Render), zod validation, pino logging with redaction, vitest for tests. Dockerfile for the service. `render.yaml` blueprint for all four Render pieces.

## Data (Prisma)
- `Account`: id, kind `SCALEEZY|CLIENT`, clientId (null for SCALEEZY; unique for CLIENT), instanceName (unique), phone (digits, set when linked), displayName, status `NOT_LINKED|LINKING|CONNECTED|DISCONNECTED|LOGGED_OUT`, linkedAt, lastSeenAt, statusChangedAt, dailyCap, createdAt.
- `ModuleClient`: id, name (`inventory`…), keyHash (sha256 of the key; key shown once when created by a CLI script), webhookUrl, webhookSecretEncrypted (AES-256-GCM, key from env), canSendAsScaleEzy (bool), active.
- `Message` (outbox): id, accountId, moduleId, toDigits, kind (`S1..S8`, `C1..C7`, `TEST`), reference (e.g. PO id), idempotencyKey (unique per module), text, document (bytea, nullable) + fileName + mimeType, status `QUEUED|SENDING|SENT|DELIVERED|READ|FAILED|EXPIRED`, failReason (plain English), tries, engineMessageId (unique, nullable), queuedAt, sentAt, deliveredAt, readAt, failedAt. Document bytes are wiped once SENT/FAILED/EXPIRED.
- `OptOut`: accountId + toDigits unique (STOP replies).
- `CanaryRun`: at, messageId, outcome, detail.

## API (JSON, versioned `/v1`)
Module auth: header `x-module-key`. Admin auth (platform console): header `x-admin-key` (env). Constant-time comparisons.
- `POST /v1/accounts/client/:clientId/link` `{ method: 'qr' | 'code', phone? }` → creates/reuses the client's instance; returns `{ status, qr?: dataUrl, pairingCode? }`. `code` needs phone (normalise to digits, India default +91 for 10 digits).
- `GET /v1/accounts/client/:clientId` → `{ status, phone (masked), linkedAt, lastSeenAt }`.
- `POST /v1/accounts/client/:clientId/disconnect` → logs the instance out, status LOGGED_OUT.
- `POST /v1/messages` `{ from: 'scaleezy' | { clientId }, to, text?, document?: { fileName, mimeType: 'application/pdf', base64 }, kind, reference?, idempotencyKey }` → `202 { id, status }`. Refusals (plain English, 4xx): not linked / disconnected, `to` not a valid number, opted out, document too large (> 5 MB decoded) or not a PDF (check `%PDF-` magic), same document to same person within 60 s (return the earlier message instead), a module sending as ScaleEzy without `canSendAsScaleEzy`, a module sending from a client it is not allowed to (Inventory may send from any Inventory client — keep an allow-rule hook).
- `GET /v1/messages/:id` → status + times + failReason (only the calling module's messages).
- `POST /v1/numbers/check` `{ from, to }` → `{ onWhatsApp }` (cached 7 days).
- `POST /engine/events/:secret` — Evolution webhook (connection.update, qrcode.updated, messages.update, send.message, messages.upsert for STOP). Secret in path compared constant-time. Updates Account/Message; forwards to the owning module's webhook, signed `x-signature: sha256=HMAC(body)`, with retries (3 tries, backoff) and at-least-once semantics (module must dedupe by event id).
- Admin: `GET /admin/accounts`, `GET /admin/messages?status=&since=`, `POST /admin/accounts/:id/reconnect`, `GET /admin/canary`.
- `GET /health` (no auth, no detail) and `GET /ready` (DB + engine reachable).

## Worker (in-process, one per service instance; design so only one instance sends — Postgres advisory lock)
- One message at a time per account, human-like gap (random 4–9 s), daily cap per account (new number: 40/day for its first 14 days, then 200; ScaleEzy number: env-configurable). Over cap → stays queued until next day, never dropped silently.
- Before the first send to a number, check it is on WhatsApp; if not → FAILED "This number is not on WhatsApp."
- Transient engine errors → retry with backoff (max 3); account not connected → leave queued and wait; messages older than 24 h → EXPIRED "Not sent within a day, so it was not sent late."
- Crash-safe: SENDING rows older than 2 min without an engineMessageId go back to QUEUED on start (but never resend one that has an engineMessageId).

## Health watch and canary
- Every 5 min: engine connection state for every account; changes recorded; CONNECTED→DISCONNECTED/LOGGED_OUT fires a module webhook `account.disconnected` (Inventory will tell the owner in-app, by email and from the ScaleEzy number).
- Daily canary (config `CANARY_TO`, default the ScaleEzy number itself; off unless `CANARY_ENABLED=true`): ScaleEzy number sends a short text, expects DELIVERED within 10 min; result stored and shown at `/admin/canary`. For this build run it at most once.

## Engine config for events
Set the engine's global webhook (env in compose) to the service: locally `http://host.docker.internal:<port>/engine/events/<secret>`, on Render the service's private address. Update `engine/docker-compose.local.yml` accordingly (keep everything else).

## Render (`render.yaml`, do not deploy)
- `whatsapp-engine`: private service, Docker from `engine/`, 2 GB plan, disk not needed (sessions in Postgres), env from group.
- `whatsapp-service`: web service, Docker from `service/`, health check `/ready`.
- `whatsapp-db`: Postgres (databases `evolution` and `whatsapp`; document the one-time `CREATE DATABASE`).
- `whatsapp-cache`: Key Value (Redis).
- Region placeholder `singapore` with a comment: must equal the Inventory backend's region (to confirm).
- `README.md`: local run, env vars table, creating a module key, deploying, and the upgrade/rollback procedure (staging engine first; remove the patch when Evolution ships the fix).

## Tests (must pass, report output)
- Unit (vitest): phone normalisation, idempotency, 60 s duplicate rule, daily cap maths, expiry, PDF check, size limit, HMAC signing, key hashing/constant-time, log redaction (a test that proves text and full numbers never reach the logger), status mapping from engine events (incl. out-of-order: DELIVERED arriving before SENT must not go backwards).
- Integration script against the local engine: ScaleEzy account CONNECTED; send 1 text + 1 small PDF **to 918142424642 only**; see SENT then DELIVERED via engine events; idempotent resend returns the same id; a throwaway client instance returns a QR and a pairing code, then is deleted; a module without `canSendAsScaleEzy` is refused; wrong keys 401; worker survives a service restart mid-queue.
- `npm run build` and `npm test` green.

Report: what was built, files, test output, anything unresolved.
