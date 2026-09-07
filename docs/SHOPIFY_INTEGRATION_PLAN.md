# Shopify Integration — Production Plan

Status: proposed, nothing built.
Companion to `STOREFRONT_MULTI_TENANT_PLAN.md`, which describes the generic storefront
pipeline this builds on.

---

## 1. What is agreed

Production architecture from the start, with the demo store as the first real installation.
No custom-app shortcut that gets thrown away. Specifically agreed:

| Decision | Position |
|---|---|
| App distribution | Public app with real OAuth, not a pasted token |
| Embedded in Shopify admin | **Off.** ScaleEzy is the management console |
| Shopify token storage | Reversible AES-256-GCM, never hashed, never returned to the browser |
| Inventory authority | ScaleEzy is the source of truth; Shopify is a projection |
| Inventory writes | Absolute (`set to 25`), never relative (`add 25`) |
| Existing Shopify catalogue | Match, preview, merchant confirms — then sync |
| Location mapping | Explicit, never inferred |
| Unpublish | Draft or unpublish in Shopify. **Never delete** |
| Rate limiting | Shopify-aware batching and per-shop budget, not the generic dispatcher |
| Uninstall | Revokes the connection and cancels queued deliveries |
| Webhook verification | Raw-body HMAC |

The phase order (A→E) is sound and this plan keeps it.

---

## 2. What I would change or add

### 2.1 The OAuth callback cannot live behind the gateway

This is the answer to the hostname question, and it needs deciding before anything is typed
into the Shopify app screen — **a redirect URL is effectively permanent**, because changing it
later means every already-installed merchant has to reinstall.

ScaleEzy is a multi-module SaaS behind a gateway at `api-super-admin.onrender.com`, which
proxies to modules via `/api/gateway/<slug>/<path>`. I read that proxy. Every request through
it must present **either** a super-admin session **or** an `x-api-key`, and it resolves the
tenant from an `x-active-client-id` header.

A Shopify OAuth callback is an **anonymous browser redirect**. No session, no API key, no
tenant header. Shopify webhooks are the same — anonymous POSTs authenticated only by their own
HMAC. Neither can pass the gateway as it stands.

So there are three options, and one of them is right:

| Option | Consequence |
|---|---|
| **A. Direct to the inventory service** — `https://<inventory-host>/api/v1/shopify/...` | Works today. Couples the permanent Shopify redirect URL to one module's hostname |
| **B. Gateway, with an unauthenticated Shopify path** | Keeps one public hostname for the platform, but requires opening a hole in the gateway's auth — that hole must then be defended by Shopify's HMAC alone |
| **C. A dedicated `shopify.scaleezy.com`** routed to the inventory service | Cleanest and most durable: the public identity is a name you own, and it can be repointed later without any merchant reinstalling |

**Recommendation: C**, with A as the interim if DNS is slow. The cost of getting this wrong is
paid by every merchant who has installed by then.

**Still needed from you:** the deployed inventory backend hostname. It is not in this repo —
`frontend/.env` points at `localhost:4006`, and the only deployed URL recorded anywhere is the
gateway's.

### 2.2 Installs that start on Shopify's side

The plan's flow is *merchant clicks Connect Shopify inside ScaleEzy* — so we know the
`clientId` before OAuth begins. That is the easy direction.

A public app can also be installed **from Shopify** — from a listing, a direct link, or a
partner's recommendation. In that direction the callback arrives with a shop domain and **no
idea which ScaleEzy tenant it belongs to**. The plan has no answer for this, and it is a
security boundary: whoever gets to claim a shop receives that shop's catalogue and inventory.

Needed: a **pending, unclaimed connection** state. The install completes, the token is stored,
nothing syncs, and the shop is claimed only when someone signs into ScaleEzy and confirms —
with the shop domain shown so it cannot be claimed blind.

### 2.3 Public does not have to mean listed

Worth knowing, because it resolves the tension between "production from day one" and "we do not
want to wait on Shopify's review": a public app can be distributed **unlisted**. Same OAuth,
same tokens, same architecture, same webhooks — merchants install by link rather than by
finding you in the App Store. Nothing is rewritten if you list it later.

This means production architecture *now* and App Store review *when you choose*, rather than
review being a gate in front of the first install.

### 2.4 Echo-loop suppression — pick the mechanism

The plan says an explicit mechanism is needed but does not choose one. Without it:

```
we set Shopify to 25
      ↓
Shopify fires inventory_levels/update
      ↓
we treat it as a merchant change and correct our own stock
      ↓
that raises an event
      ↓
we set Shopify again ...
```

Proposed: when the adapter writes a level, record what it wrote against
`(connection, inventory_item, location)`. An inbound webhook whose value **equals** what we last
wrote is our own echo and is dropped. Anything else is a genuine external change and is
surfaced — not silently applied, because ScaleEzy is the authority.

A time window alone is not enough; Shopify webhooks can be minutes late under load.

### 2.5 One shop, one tenant

Nothing currently stops the same `shop.myshopify.com` being connected to two ScaleEzy tenants,
which would have two inventories fighting over one storefront. Needs a uniqueness rule on the
active connection, and a clear error when the second one tries.

### 2.6 Orders are the risky half, and they are last

Phase D is where money and customers are. The failure modes there are worse than anything in
A–C, and they deserve their own decisions rather than being a bullet list:

- an order webhook arriving **before** the initial sync has finished
- Shopify overselling because our push was late — who absorbs it, and what does the merchant see
- partial cancellation and partial refund, which our reservation model handles but Shopify
  models differently
- the same order webhook delivered twice (Shopify does this) — idempotency by Shopify order id
- an order for a variant we do not have mapped

### 2.7 Smaller things the plan misses

- **Scopes**: `read_publications` / `write_publications` are likely needed to control whether a
  product appears on the Online Store channel. `read_orders` for Phase D (`read_all_orders` if
  you need beyond 60 days). Confirm against the exact API version before the version is created.
- **Callback hardening**: validate the `state` parameter (CSRF), verify the callback `hmac`, and
  check the shop domain matches `*.myshopify.com` before doing anything with it.
- **API version**: `2026-07` needs a pinned constant and a calendar reminder — Shopify retires
  versions on a fixed schedule, and an unmaintained integration breaks quietly.
- **Reconciliation**: Shopify will drift. A periodic full compare is not optional in a system
  claiming to be the source of truth.
- **Billing**: ScaleEzy bills outside Shopify. That is generally fine for an unlisted app;
  App Store listing has stricter rules. Worth confirming before listing, not before building.

---

## 3. What is reused, and what is new

The event pipeline earns its keep here. What changes is only the last step.

```
product/stock/price changes in ScaleEzy
        │
        ▼
storefront-event.service        REUSED, unchanged
        │
        ▼
StorefrontEvent + StorefrontDelivery   REUSED, unchanged
        │
        ▼
storefront-dispatcher            REUSED for claim/lease/retry/backoff/dead-letter
        │
        ├── GENERIC   → signed POST to the merchant's URL      exists
        └── SHOPIFY   → Shopify adapter                        NEW
                          ├── decrypt token
                          ├── translate SKU → Shopify ids
                          ├── batch and throttle
                          └── call the Admin API
```

Everything above the branch is built, tested and running (64 checks). The adapter, the id
mapping, OAuth, and the Shopify webhook receiver are new.

### New tables

| Table | Why |
|---|---|
| `ShopifyInstallation` | shop domain, encrypted offline token, scopes granted, API version, install/uninstall timestamps. One per shop |
| `ShopifyIdMap` | our variant/product ↔ Shopify product id, variant id, inventory_item_id. Without this every push is a lookup by SKU, and creates duplicate products on retry |
| `ShopifyLocationMap` | our `StockLocation` ↔ Shopify location. Explicit, merchant-confirmed |
| `ShopifyWebhookReceipt` | inbound webhook id + topic, for idempotency and echo suppression |

`StorefrontConnection` gains a nullable link to the installation. `credentialHash` stays exactly
as it is for generic connections and is unused for Shopify ones — the two credential models do
not merge, and should not.

---

## 4. Phases

Each phase ends in something demonstrable on the demo store, not a code milestone.

### Phase A — Foundation
1. Decide the public hostname (§2.1) and create the Shopify app version against it
2. OAuth start + callback, with `state`, `hmac` and shop-domain validation
3. Encrypted token storage; never returned to the browser
4. Shop ↔ tenant binding, including the unclaimed-install path (§2.2)
5. `SHOPIFY` branch in the dispatcher — at first a stub that fails loudly rather than silently
   behaving like a generic connection, which is what would happen today

**Done when:** the demo store completes a real install from the ScaleEzy UI and shows as
connected, with no catalogue movement yet.

### Phase B — Safe first sync
6. Read the Shopify catalogue
7. Match by SKU; build `ShopifyIdMap`
8. Location mapping screen
9. **Preview**: matched / to create / unmatched, with the merchant confirming before any write
10. Resumable initial sync using the existing cursor design

**Done when:** the demo store's existing products are adopted rather than duplicated, and the
preview is accurate before anything is written.

### Phase C — Continuous sync
11. Product, price, image, publish/unpublish
12. Absolute inventory writes
13. Shopify-aware throttling, `Retry-After`, per-shop budget, batching
14. Echo suppression (§2.4)
15. Reconciliation sweep

**Done when:** a stock change in ScaleEzy is visible on the storefront within the target window,
and a burst of 500 changes does not trip Shopify's rate limit.

### Phase D — Shopify → ScaleEzy
16. Raw-body HMAC webhook receiver
17. `app/uninstalled` → connection REVOKED, queued deliveries CANCELLED
18. The three privacy webhooks
19. Order ingestion → `reserveStock`, idempotent by Shopify order id
20. Cancellation and refund
21. The failure modes in §2.6, each with a decided answer

**Done when:** an order placed on the demo store reduces ScaleEzy stock exactly once, and
replaying the same webhook changes nothing.

### Phase E — Verification
A `verify-shopify.ts` in the shape of `verify-storefront.ts`: real HTTP, real install, real
order, real uninstall, asserting the properties that would be expensive to discover in
production — tenant isolation, no duplicate products on retry, no echo loop, no oversell,
uninstall actually stops delivery.

---

## 5. Open decisions

These need answers from you, in roughly this order:

1. **The public hostname** — dedicated Shopify subdomain, gateway, or direct to the inventory
   service? Blocks the Shopify app configuration.
2. **Listed or unlisted** to begin with?
3. **When Shopify and ScaleEzy disagree on stock**, and it is not our echo — does ScaleEzy
   correct Shopify silently, or tell the merchant and wait?
4. **Products in Shopify that ScaleEzy has never heard of** — leave alone, or import into
   ScaleEzy? Leaving them alone is safer and probably right, but it means the storefront sells
   things the inventory does not know about.

---

## 6. Honest assessment of size

Phases A–B are a well-understood body of work. Phase C is where the Shopify-specific difficulty
lives — rate limits and echo loops are the two things that look fine in testing and misbehave
under real load. Phase D touches money.

This is not a week. Building it properly, in this order, with the demo store as the first real
tenant, is the right call — but it should be planned as a substantial piece of work rather than
an adapter bolted onto what exists.
