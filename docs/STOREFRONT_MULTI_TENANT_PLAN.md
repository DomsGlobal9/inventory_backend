# Connecting each shop to its own storefront

Every tenant has a different website. This is the plan for making that work, written after
reading the code rather than the existing docs, which are stale in places.

The companion document `STOREFRONT_SHOPIFY_INTEGRATION_PLAN.md` covers a Shopify-specific
version of the read API and order ingestion. This one is the generic "any website" path and
the multi-tenant foundation both would sit on.

---

## What exists today

There is one outbound mechanism: an outbox table (`InventoryEvent`) and a poller
(`WebhookDispatcherService`), started on boot in `src/server.ts:87-93`. It is genuinely
running. It has never delivered anything.

Measured on the live database, 7 September 2026:

```
inventory_events rows: 747
by status: PROCESSING=747      <- every row, none PROCESSED
distinct tenants with events: 21
oldest undelivered: 2026-08-21
```

**Every event ever created is stranded.** The poller claims a batch
(`PENDING -> PROCESSING`, `webhook-dispatcher.service.ts:11-28`) and only *then* checks
whether a destination is configured (lines 43-48). `STOREFRONT_WEBHOOK_URL` is not set in
this environment, so it returns — leaving the rows claimed. Nothing ever selects
`PROCESSING` again. Two and a half weeks of 21 tenants' stock movements sit in a table that
only grows.

Beyond that, five things block a merchant even if the URL were set:

| | |
|---|---|
| **One global destination** | `STOREFRONT_WEBHOOK_URL` is a single env var. The poller's query has no tenant filter (`where: { status: 'PENDING' }`), so every shop's stock would post to the same website. |
| **No tenant in the payload** | The body carries `eventId`, `eventType`, `variant {id, barcode}`, `location`, `stock`. No `clientId`. A receiver cannot tell whose stock changed. |
| **No product data** | No SKU, title, price, image, category. A website cannot build a catalogue from this — only adjust stock for products it already has, which it has no way to receive. |
| **No product events** | Only stock movements emit. Creating, publishing, repricing or photographing a product sends nothing. So "add a product in inventory, see it on the website" is not something this can do even in principle. |
| **No UI, no read API** | Nothing in `frontend/src` to configure an integration; the Settings "API" tab was removed as empty. Every route sits behind a login cookie (`api.routes.ts:62`), so a website cannot fetch anything. |

### A security issue to fix regardless of this plan

The outgoing webhook authenticates with `INTERNAL_SERVICE_KEY`
(`webhook-dispatcher.service.ts:52`) — the same secret that guards inbound internal
service-to-service calls (`serviceAuth.middleware.ts:12`). **Sending a webhook hands every
merchant the key that authenticates internal traffic.** It is also sent as a static header
named `x-inventory-event-signature` when it is not a signature: no HMAC over the body, no
timestamp, no replay protection.

This should be separated whether or not the rest of this plan is built.

---

## The shape that makes per-tenant storefronts work

Two tables, not one. This is the central design decision.

**A connection** — one row per storefront a shop has connected. Keyed by `clientId` (there is
no `Client` model in this database; tenancy is owned by the gateway, so a plain `clientId`
column is the right join, as `ClientSettings` already does). Holds the address, its own
secret, an enabled flag and a name.

A shop can have **more than one**: a website and a marketplace, or staging and live. That
falls out for free rather than needing a second design later.

**A delivery** — one row per *event × connection*. The event records what happened in the
warehouse, once. The delivery records the attempt to tell one particular storefront, with its
own status, attempt count and last error.

Why this matters concretely:

- Shop A's site being down cannot affect shop B's.
- "Delivered to the website, still failing to the marketplace" is representable. Today it is
  not — there is one `status` on the event, so a second destination has nowhere to record a
  different outcome.
- The 747 stuck rows are the direct consequence of trying to express a multi-destination
  problem with a single status column.

### Three rules that follow

**Only create work that has a destination.** Most tenants will never connect a storefront. If
a shop has no enabled connection, no delivery rows are created — the event remains as history
and nothing queues. Today every movement for all 21 tenants queues forever with nowhere to
go, which is how the table reached 747.

**Check before claiming.** Resolve the destination first and claim only what can actually be
attempted. The current order — claim, then discover you cannot send — is what stranded
everything.

**Be fair between tenants.** The poller takes the 50 oldest rows globally. One busy shop would
starve the rest. Cap per tenant per cycle, or round-robin across tenants with pending work.

---

## What the merchant sees

**Settings → Storefront**, beside Day Book.

- **Connect a storefront**: name it, paste the address, receive a secret shown once.
- **Send test event** — proves the connection before any real stock depends on it.
- **The list of connections**, each with enable/disable so one can be paused without deleting.
- **A delivery log**: what was sent, what failed, the reason, and a retry button.

That is the whole self-serve story, and it is the difference between a product and an `.env`
edit on the server.

---

## The guarantee that must hold

One shop's data must never reach another shop's storefront. Three things enforce it:

1. the tenant filter on the query that selects work,
2. `clientId` in the payload,
3. the connection lookup scoped to the event's own tenant.

This deserves an explicit test that a second tenant's storefront receives nothing, in the
same spirit as the tenant-isolation checks already in `verify-reports.ts`.

---

## Staging

Ordered so that each stage is shippable and the earlier ones are worth doing even if the
later ones are never built.

**Stage 0 — Stop the bleeding.**
Fix the claim-then-bail ordering and clear the 747 stranded rows. Separate the webhook
credential from `INTERNAL_SERVICE_KEY`. Neither depends on any of the below.

**Stage 1 — Per-shop connections.**
Connections and deliveries as described, the dispatcher rewritten to fan out per tenant,
`clientId` in the payload, and the Settings screen. This is "every user has their own
storefront".

**Stage 2 — A read API.**
Tenant-scoped API key, generated on the same screen. Read-only endpoints for published
products with variants, prices, images and availability. **This is the stage that actually
puts products on a website** — Stage 1 only announces changes.

**Stage 3 — Events worth sending.**
Product published, updated, unpublished; price changed; images changed. Plus two silent gaps
that exist today:

- `reservation.service.ts` changes `reservedQty` on lines 41, 50, 91 and 139 and emits
  nothing — a storefront order takes the last unit and the site never hears.
- `variant-location.service.ts:4-30` flips `isAvailable`, the one explicit "show this online"
  switch, and emits nothing.

**Stage 4 — Delivery you can trust.**
Attempt counter with backoff and a dead-letter queue (today a failing event would retry every
30s forever), a reaper for rows stranded mid-send, a real HMAC over the payload with a
timestamp, and manual retry from the log.

**Stage 5 — Inbound: their sale reduces our stock.**
The engine already exists and is good: `createFullOrder` has proper idempotency on
`[clientId, externalOrderId, sourceSystem]` (`schema.prisma:745`). It is only reachable
behind a login cookie, so no website can call it. Expose it behind the API key and let
`createFullOrderSchema` accept `channel` and `sourceSystem`, which the service already
supports but the validator rejects.

**Recommended first release: 0 → 1 → 2.** That is the smallest thing that lets a merchant
connect their own site, unaided, and see their products on it.

---

## Notes for whoever builds this

- `ClientSettings` (`schema.prisma:1393`) is the precedent for per-tenant configuration:
  `clientId String @unique`, no foreign key, because the tenant lives in another service.
  Connections follow the same pattern but without `@unique`, since a shop may have several.
- `InventoryEvent.eventType` and `.status` are plain strings, not enums
  (`schema.prisma:1252,1258`). Worth making enums while the table is being reworked.
- `serviceAuth.middleware.ts` is dead code — imported nowhere. Note that
  `auth.middleware.ts:16-23` records why its header-bypass approach was removed as a
  vulnerability; do not revive that pattern for storefront auth.
- `ProductImage` already stores real Supabase Storage URLs, which external systems accept
  directly. No image-hosting work is needed for the read API.
