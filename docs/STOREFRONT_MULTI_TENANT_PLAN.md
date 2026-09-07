# Connecting each shop to its own storefront

Every tenant has a different website. This is the plan for making that work, written after
reading the code rather than the existing docs, which are stale in places.

The companion `STOREFRONT_SHOPIFY_INTEGRATION_PLAN.md` (repo root, untracked) covers a
Shopify-specific version of the read API and order ingestion. This is the generic "any
website" path and the multi-tenant foundation both would sit on.

**The promise being designed for:** connect once, and the storefront stays synchronised with
no further merchant action. No exports, no CSVs, no "press sync". That promise is what
forces most of the decisions below — particularly initial sync and reconciliation, because
webhooks alone cannot keep it.

## Two constraints that bound everything below

**Inventory is authoritative. The storefront is a projection of it, never a second source of
truth.** Stock, price, availability and publication state are decided here and replicated
outward; the website's copy is a cache that must converge on ours. This is what justifies
absolute-state events — a message saying `available = 6` is a statement of truth that any
number of retries and reorderings cannot corrupt, whereas `decrease by 1` compounds every
time it is redelivered. It also forecloses a tempting future request: syncing an edited title
or price *back* from a storefront would make two systems authoritative over one field, and
there is no correct resolution when they disagree. If that is ever wanted, it needs its own
design and its own conflict rules, not a quiet addition here.

**Billing and payments stay outside this integration.** They are a separate module of the
platform. This integration carries catalogue, stock and orders. An order arriving from a
storefront records what was sold and reserves the stock; what was charged, by whom, and
whether it settled belongs elsewhere. Pulling payment state in here would couple two modules
that currently have no reason to know about each other.

---

## Part I — What exists today

One outbound mechanism: an outbox (`InventoryEvent`) and a poller
(`WebhookDispatcherService`), started on boot at `src/server.ts:87-93`. It runs. It has never
delivered anything.

Measured on the live database, 7 September 2026:

```
inventory_events rows: 747
by status: PROCESSING=747      <- every row, none PROCESSED
distinct tenants: 21
oldest undelivered: 2026-08-21
```

**Every event ever created is stranded.** The poller claims a batch (`PENDING -> PROCESSING`,
lines 11-28) and only *then* checks whether a destination exists (lines 43-48).
`STOREFRONT_WEBHOOK_URL` is unset, so it returns with the rows already claimed, and nothing
selects `PROCESSING` again.

Five further blockers even if the URL were set:

| | |
|---|---|
| **One global destination** | A single env var; the query has no tenant filter, so every shop's stock posts to the same website. |
| **No tenant in the payload** | No `clientId`. A receiver cannot tell whose stock changed. |
| **No product data** | Only `variant {id, barcode}` and quantities. No SKU, title, price, image. A website cannot build a catalogue from this. |
| **No product events** | Only stock movements emit. Creating, publishing, repricing or photographing a product sends nothing — so "add a product, see it on the website" is impossible in principle. |
| **No UI, no read API** | Nothing to configure an integration; every route sits behind a login cookie. |

### Security issue to fix independently of this plan

The webhook authenticates with `INTERNAL_SERVICE_KEY` (`webhook-dispatcher.service.ts:52`) —
the same secret guarding inbound internal service calls. **Sending a webhook hands every
merchant the key that authenticates internal traffic.** It is sent as a static header named
`x-inventory-event-signature` when it is not a signature: no HMAC, no timestamp, no replay
protection.

---

## Part II — Design decisions

### 1. Connections have their own identity and their own credential

```
StorefrontConnection
  id, clientId, name
  type            GENERIC | SHOPIFY | ...
  baseUrl
  status          ACTIVE | DISABLED | REVOKED
  credentialHash        <- never the raw secret
  credentialPrefix      <- to identify it in the UI and logs
  locationScope         <- see decision 4; this is not optional here
  lastDeliveryAt, createdAt, updatedAt

  @@index([clientId])
  @@index([clientId, status])
```

The secret is shown once and stored hashed. A shop may have several connections — website,
marketplace, staging — each independently revocable. `REVOKED` is terminal: the credential can
never be reused, and delivery history survives it.

Credentials are therefore **connection-scoped with tenant authorisation**, not "an API key for
a tenant". The chain is credential → connection → clientId → what that connection may read.

### 2. The event is not the delivery

```
InventoryEvent (immutable)
      |
      +-- Delivery -> Connection A
      +-- Delivery -> Connection B
      +-- Delivery -> Connection C
```

```
StorefrontDelivery
  id, eventId, connectionId
  status, attempts
  nextAttemptAt, lastAttemptAt, lockedAt
  lastResponseStatus, lastError, deliveredAt
  @@unique([eventId, connectionId])
```

The delivery holds references and delivery-specific state — never a copy of the payload. The
unique constraint makes duplicate delivery rows impossible.

Explicit state machine, not free-form strings:

```
PENDING -> PROCESSING -> DELIVERED
                      -> RETRYING -> PROCESSING
                                  -> DEAD_LETTER
           (any)       -> CANCELLED        (connection disabled or revoked)
```

Only these transitions are legal. `InventoryEvent.eventType` and `.status` are currently plain
strings (`schema.prisma:1252,1258`); both become enums while the table is reworked.

### 3. Absolute state and a sequence, not deltas and timestamps

The existing event carries `previousQuantity` and `quantity`, which invites the receiver to
apply a delta. Deltas are neither idempotent nor order-insensitive: one duplicate or one
reordering corrupts the receiver permanently, and it has no way to notice.

**Events carry the entity's current absolute state, plus a monotonic per-tenant sequence.**
The receiver applies last-writer-wins on the sequence and discards anything older than what it
has already applied for that entity. Then a duplicate delivery is a no-op by construction, and
out-of-order arrival is self-correcting — which removes most of the pressure that would
otherwise fall on delivery guarantees.

A per-entity `entityVersion` is stronger still, but needs a counter maintained on every write
path for every entity. A single autoincrement sequence on the event gives total ordering per
tenant for a fraction of the work; the receiver keeps the highest sequence it has applied per
entity. Start there; per-entity versions can refine it later without changing the contract.

Every payload is versioned so the contract can evolve:

```json
{
  "eventVersion": 1,
  "sequence": 10432,
  "eventId": "...",
  "eventType": "product.updated",
  "clientId": "...",
  "occurredAt": "2026-09-07T09:14:03.221Z",
  "data": { }
}
```

`eventType` + `eventVersion` are the public contract. Old integrations must not break when
`data` grows.

### 4. Which location does the storefront sell from — the decision both earlier drafts missed

`VariantLocationProfile` (`schema.prisma:1095-1096`) carries **`isAvailable` and
`priceOverride` per location**. So in this product, *stock and price are both properties of a
variant at a location*, not of the variant alone.

A merchant with a warehouse and a shop therefore has no single answer to "what does the
website show". Without stating it, the integration silently guesses — and a back-office
warehouse's stock appears on the public site, or a shop-floor price override is published to
the web.

**Every connection declares its location scope.** One location, several, or all. From it
follow:

- the stock the storefront sees (summed across the scoped locations),
- the price it sees (the override for the scoped location, or the base price),
- which `isAvailable` flags decide whether an item is sellable there.

This is not a Stage 4 refinement. It changes what the read API returns and what an event
means, so it belongs in the schema from the first migration.

### 5. Storefront eligibility is a rule the API owns, not the website

A product existing in inventory does not mean it should be visible. Define it once, server
side, and return only storefront-ready data:

```
product.status = ACTIVE
AND product.publishedAt is set
AND variant is not archived
AND variant is available at a scoped location   (isAvailable)
AND a price resolves for that scope
```

Stock may be zero — that is a sellable-or-not decision for the merchant, not an eligibility
one. What must not happen is exposing every internal object and making each website
re-implement these rules; they would each get it slightly wrong.

### 6. Stock semantics stated, not inferred

`InventoryStock` already tracks `quantity` and `reservedQty`. The website must never have to
derive the difference:

```json
"stock": { "quantity": 10, "reserved": 4, "available": 6, "sellable": true }
```

`available = quantity - reserved`, summed over the connection's scoped locations.
`sellable` additionally accounts for availability flags. Both defined in the contract.

### 7. Public identifiers, not Prisma internals

External systems persist whatever identifier we give them. Expose a stable public identity —
SKU for variants and product code for products are already stable, human-meaningful and
unique per tenant — rather than coupling every merchant's database to our primary keys.

### 8. Authentication contract, defined now

Not built entirely in stage one, but defined now so no temporary scheme becomes permanent:

```
X-Inventory-Key: <credentialPrefix>
X-Inventory-Timestamp: <unix seconds>
X-Inventory-Delivery-Id: <delivery id, stable across retries>
X-Inventory-Signature: sha256=HMAC-SHA256(secret, timestamp + "." + rawBody)
```

Receiver checks the timestamp is inside an allowed window, the signature matches, and the
connection is active. This closes secret reuse, body tampering, replay, and the confusion
between internal and external authentication in one contract.

`X-Inventory-Delivery-Id` is stable across retries of the same delivery, and the published
contract states that **processing the same delivery id twice must be safe**. Combined with
absolute-state events (decision 3), duplicate delivery becomes harmless rather than merely
discouraged.

### 9. Outbound requests are attacker-influenced

The merchant controls the destination URL, and our server makes the request. That is SSRF by
construction. Required: HTTPS only (a documented localhost exception for development),
rejection of private and link-local address ranges resolved at request time, no redirect
following, a response size cap, and a short timeout. Validate on save *and* at send time — DNS
can change between the two.

### 10. The dispatcher does not decide business questions

```
inventory operation -> InventoryEvent -> delivery engine -> HTTP
```

Whether a product should be visible belongs to the catalogue layer, which decides what goes
*into* the event. The delivery engine answers exactly one question: "this event must reach
this connection — deliver it reliably." Keeping that line clean is what keeps both sides
maintainable.

---

## Part III — Where I disagree: the 747 events

The instinct to preserve them is right in general and wrong here, for two reasons.

**The outbox is not the audit trail.** `InventoryTransaction` is: 780 rows against the
outbox's 747, immutable, carrying signed quantities, costs, reasons and actors, and already
the basis of the day book and the snapshot engine. `InventoryEvent` is a delivery queue that
happens to be durable. Discarding queue rows destroys no history; the ledger is untouched and
every one of those events is reconstructible from it.

**Replaying them would be actively wrong.** They are stock deltas from 21 August onward. A
storefront connecting today needs *current* state — which is exactly what initial sync
provides. Delivering three weeks of historical deltas on top of a freshly synced catalogue
would fight the sync and could leave the website permanently wrong. The right behaviour for a
new connection is: sync now, then receive events from this moment forward.

So Stage 0 is: **classify, record the decision, then clear the queue.** Count them, note why
(no connection existed, so no delivery was ever possible), write that to the log, and leave
`InventoryTransaction` alone. What must not happen is a `deleteMany` with no record of what
was removed.

The general principle stands and is worth encoding: **queue cleanup must never be able to
touch audit data.** Event-history retention and delivery-log retention are defined separately,
and neither is allowed to delete ledger rows.

---

## Part IV — Synchronisation

Webhooks alone cannot keep the promise. Three mechanisms, each covering the others' failure:

```
initial sync      catalogue exists at all
     +
webhooks          fast updates
     +
incremental read  recovery, and reconciliation
```

**Initial sync.** A merchant connecting with 2,500 products and 8,000 variants cannot be
populated by future events. On connect: validate, then the storefront pulls the catalogue,
paginated with a deterministic cursor, and the connection is not "live" until it completes. It
must be resumable — an interruption at product 1,900 continues from there rather than
restarting. Critically, **initial sync does not go through the delivery queue**; pushing
8,000 rows through the outbox would drown every other tenant's events.

**Incremental read.** `GET /storefront/v1/products?since=<cursor>` returning `nextCursor` and
`hasMore`. This is the same mechanism as initial sync with a non-empty cursor, which is what
makes recovery cheap: a storefront that missed thirty webhooks asks for everything since its
last cursor rather than resyncing from scratch.

**Reconciliation.** Periodically the storefront asks for changes since its cursor and corrects
drift. This is what stops the failure the merchant would otherwise never notice:

```
14:00  stock 10
14:01  stock 9   webhook delivered
14:02  stock 8   webhook lost
14:03  stock 7   webhook delivered
```

With absolute-state events (decision 3) the 14:03 event already carries `7`, so this
particular case self-heals. Reconciliation covers the rest: the last event being the lost one,
a storefront-side write failure, or a receiver bug.

---

## Part V — Scenarios to design against

Beyond the happy path. Each of these has bitten a real integration somewhere.

**Overselling.** The website shows one unit; two customers buy simultaneously. The inbound
contract must state what happens: whole-order rejection, partial acceptance, or acceptance
into backorder. `reserveStock` already exists and is the enforcement point, but the API's
answer to "there is not enough" is currently undefined. This is the single most common
complaint in retail integrations and needs deciding before code.

**Cancellation and refund.** A website order is cancelled; the reservation must be released
and stock re-advertised. Returns already exist in the app (`return.service.ts`) and emit stock
movements, so the outbound half works — the inbound half needs a cancel/refund route beside
order creation.

**A product the website is selling gets archived or trashed.** Today archiving emits nothing.
It must produce `product.unpublished`, or the website keeps selling something the merchant
has withdrawn.

**A connection is disabled or revoked with deliveries queued.** They move to `CANCELLED`, not
retried forever. Revocation must also invalidate the read credential immediately, not at next
rotation.

**The merchant changes the URL, or rotates the secret, mid-flight.** Queued deliveries go to
the *current* URL and are signed with the *current* secret, resolved at send time rather than
captured when the delivery row was created.

**The storefront is slow or rate-limits us.** Per-connection concurrency cap so one slow
merchant cannot consume the worker pool, and honour `Retry-After` rather than the generic
backoff when the receiver supplies it.

**Clock skew.** The timestamp window must tolerate a few minutes in both directions, and the
tolerance must be documented — otherwise a merchant with a drifting server sees intermittent
signature failures and no way to diagnose them.

**Tenant offboarding.** A shop leaves the platform: connections revoked, queued deliveries
cancelled, credentials destroyed. Delivery history retained under its own retention rule.

**Image URL durability.** `ProductImage.url` is stored as plain text pointing at Supabase
Storage. If those URLs are signed with an expiry, every storefront that persists them shows
broken images later. **This needs checking before the read API ships** — if they are signed,
the API must return long-lived or re-signable URLs, or proxy them.

**Currency.** `ClientSettings.currency` exists and defaults to INR. Every price in the read
API and every price event states its currency explicitly; a website serving two tenants must
not have to assume.

---

## Part VI — Staging

Each stage is shippable, and the earlier ones are worth doing even if the later ones never
happen.

**Stage 0 — Stop the bleeding.**
Fix the claim-then-bail ordering. Classify and clear the 747 stranded rows with a written
record, leaving the ledger untouched. Separate the webhook credential from
`INTERNAL_SERVICE_KEY`. None of this depends on anything below.

**Stage 1 — Per-shop connections.**
Connections (with location scope and hashed credentials) and deliveries with the state
machine. Dispatcher rewritten to fan out per tenant with a per-tenant fairness cap. `clientId`,
`sequence` and `eventVersion` in the payload. The full HMAC contract from decision 8. SSRF and
HTTPS validation. Settings screen: connect, test, enable/disable, revoke, delivery log with
retry. This is "every user has their own storefront".

**Stage 2 — The read API and initial sync.**
Connection-scoped credentials, storefront eligibility rules, explicit stock semantics,
public identifiers, cursor pagination, resumable initial sync, and the incremental
`?since=<cursor>` endpoint that doubles as recovery. **This is the stage that actually puts
products on a website** — Stage 1 only announces changes.

**Stage 3 — Events worth sending.**
Product published, updated, unpublished; price changed; images changed. Plus the two silent
gaps that exist today: `reservation.service.ts` changes `reservedQty` (lines 41, 50, 91, 139)
and emits nothing, so a website order takes the last unit and the site never hears; and
`variant-location.service.ts:4-30` flips `isAvailable` — the one explicit "show this online"
switch — with no event.

**Stage 4 — Delivery you can trust, and reconciliation.**
Backoff with `Retry-After`, dead-letter, stale-claim reaper, per-connection concurrency,
observability (correlation id, attempt count, response status, duration, next retry —
never secrets or full bodies), and the periodic reconciliation loop.

**Stage 5 — Inbound: their sale reduces our stock.**
`createFullOrder` already has idempotency on `[clientId, externalOrderId, sourceSystem]`
(`schema.prisma:745`) and reserves stock. It is reachable only behind a login cookie. Expose
it behind connection credentials, let `createFullOrderSchema` accept `channel` and
`sourceSystem` (the service supports both, the validator rejects them), and define the
oversell, cancellation and refund contracts.

**Recommended first release: 0 → 1 → 2.** The smallest thing that lets a merchant connect
their own site unaided and see their products on it.

---

## Notes for whoever builds this

- `ClientSettings` (`schema.prisma:1393`) is the precedent for per-tenant configuration:
  `clientId String @unique`, no foreign key, because the tenant lives in another service.
  Connections follow that pattern without `@unique`, since a shop may have several.
- `serviceAuth.middleware.ts` is dead code, imported nowhere. `auth.middleware.ts:16-23`
  records why its header-bypass approach was removed as a vulnerability — do not revive that
  pattern for storefront auth.
- The day book and snapshot engine both read `InventoryTransaction` directly. Anything that
  touches that table affects reporting; the outbox rework must not.
- Verify whether Supabase image URLs are signed before designing the read API's image field.
