# Per-client keys and usage metering for Try-On

Status: proposed, nothing built.

## The gap, precisely

Try-on generates four views per garment. Today the inventory module calls it like this:

```
merchant → inventory backend → gateway → catalog-tryon service
                               ^
                        ONE shared key
                        CATALOG_TRYON_API_KEY
```

`catalog-tryon.service.ts` sends `env.CATALOG_TRYON_API_KEY` for every request, from every
merchant. Its own comment says the gateway "resolves our tenant from CATALOG_TRYON_API_KEY" --
and it does, to **one** tenant. So every generation from every shop on the platform is
attributed to a single customer.

Nothing is broken. Nothing is measurable either.

## Most of this already exists — do not rebuild it

The gateway already has the machinery:

| Already there | What it gives us |
|---|---|
| `ApiKey` | per-client keys, hashed, with status, expiry, `requestCount`, `lastUsedAt` |
| `ApiKeyModuleAccess` | which modules a key may reach |
| `ClientAccess` | per-client, per-microservice enable/disable and `rateLimit` (per day) |
| `RequestLog` | every call: clientId, apiKeyId, endpoint, status, latency, sizes |

So this is not "build an API key system". It is "stop sending the same key for everyone, and
start counting the thing we would bill for".

What is genuinely missing is one thing: **an aggregated usage record**. `RequestLog` is a raw
log — right for debugging, wrong for "how many generations did this shop use in September".
Answering that by scanning raw logs gets slower every month, and raw logs get pruned.

## Decision 1 — where the per-client key lives

Three ways to give each merchant their own key. They are not equally good.

**A. Inventory stores one key per client, encrypted, and sends the right one.**
Uses the gateway exactly as designed; `RequestLog` and `ApiKey.requestCount` become correct
with no gateway change. Cost: the inventory service now holds N replayable secrets, and needs
issuing, rotation and revocation to stay in step with the gateway.

**B. Inventory authenticates as a service and names the client it is acting for.**
It already has `INVENTORY_PRIVATE_KEY_PATH`, and the gateway already understands a signed
service assertion plus `x-active-client-id`. No secrets stored per tenant at all. Cost:
attribution is by clientId rather than by ApiKey, so `ApiKey.requestCount` stays meaningless
and metering must key on clientId.

**C. The merchant's own website calls try-on directly with their own key.**
Necessary eventually if try-on is sold as an API in its own right. Not needed for the
in-product flow, and it is a different product decision.

**Recommendation: B now, A when a merchant needs a key of their own.**

The reason is that today the merchant never sees this key — try-on is reached by pressing a
button inside the inventory app. A per-client key that no client ever holds is a secret we have
taken on the duty of protecting, rotating and revoking, in exchange for an attribution we can
get from a clientId we already have. Option A's real value appears the day a merchant wants to
call try-on from their own site, and it can be added then without changing the metering.

If the intent is specifically to *sell try-on as an API*, that reverses the recommendation and
A should be first.

## Decision 2 — meter generations, not requests

A generation produces four views. The billable unit is the **generation**, and it must be
counted on completion, not on request. Otherwise:

- a job that fails halfway is billed as if it worked
- a cancelled job (`/cancel-job` already exists) is billed
- a client retrying after a timeout is billed twice for one garment

The try-on service is the only party that knows a generation actually finished and how many
views came out. It should report that, and the meter should record it.

Recording `viewsGenerated` rather than assuming four also handles a partial result honestly --
three views out of four is a real outcome and should be visible rather than rounded up.

## Decision 3 — what happens at the limit

`ClientAccess.rateLimit` exists and is per-day. Before it is enforced, decide what "over the
limit" means, because the wrong answer here is a merchant unable to work:

| Policy | Fits |
|---|---|
| Block, tell them, offer more | A hard plan allowance |
| Allow and record the overage | Pay-as-you-go billing |
| Allow, warn at 80%, block at 200% | A soft allowance with a safety net |

Whichever is chosen, **the merchant must be able to see their own usage before they hit it.**
Being blocked by a number you were never shown is the worst version of this feature.

Try-on is GPU work, so the cost of an unmetered client is real money, not just load. That
argues for a default limit on every client rather than unlimited-until-someone-notices.

## What to build

### Phase 1 — attribution (no behaviour change)
1. Inventory sends a service assertion plus the acting `clientId` instead of the shared key.
2. Gateway records the real `clientId` in `RequestLog` for try-on calls.
3. A `TryOnUsage` record: `clientId`, `date`, `generations`, `viewsGenerated`, `failures`,
   `cancellations`. One row per client per day -- small, exact, and answers "this month" with
   a single aggregate rather than a log scan.

**Done when:** the console can show generations per client per day, and the numbers match what
the try-on service actually produced.

### Phase 2 — visibility
4. Merchant-facing usage on their own Settings screen: used this month, allowance, what is left.
5. Platform console: usage by client, so a heavy user is noticed before the bill is.

**Done when:** a merchant can answer "how much have I used" without asking anyone.

### Phase 3 — limits
6. Enforce `ClientAccess.rateLimit` with the policy chosen in Decision 3.
7. Warn approaching it, in the app, before it bites.

**Done when:** a client at their limit gets a clear message naming the limit and what to do,
not a generic failure.

### Phase 4 — keys of their own (only if try-on is sold as an API)
8. Issue per-client keys through the console, using the gateway's existing `ApiKey`.
9. Show, rotate and revoke them, exactly as the storefront connection screen does.

## Scenarios worth deciding now

These are the ones that turn into arguments with a customer later:

- **A failed generation** -- not billed, but recorded, or a broken run looks like no usage.
- **A cancelled job** -- the cancel endpoint exists; cancelling after the GPU work is done is
  different from cancelling before it starts.
- **A retry after a timeout** -- the same garment must not count twice. Needs an idempotency
  key from the caller, decided now rather than after someone is double-charged.
- **Partial results** -- three views of four. Recorded as three.
- **The 37 existing tenants** -- all currently sharing one key. Their historical usage cannot
  be split apart afterwards; metering starts from the day this ships and the console should say
  so rather than implying the earlier months were zero.
- **Concurrency** -- one shop generating a thousand garments should not starve everyone else.
  A per-client concurrent-job cap is a separate control from a daily count, and GPU work needs
  both.
- **Suspended and deleted clients** -- a suspended client should stop generating. A deleted one
  takes its usage rows with it, which conflicts with keeping billing history; decide whether
  usage is billing data that outlives the tenant.

## Honest assessment

Phase 1 is small, because the gateway already has the identity and logging. The real work is
the decisions above, not the code -- particularly what a generation costs and what happens at
the limit, because those are commercial choices that the implementation has to encode.

The one thing I would not do is build a second API-key system inside the inventory module. The
gateway owns tenancy and keys for this platform; duplicating that here means two places to
revoke a key and, eventually, a key revoked in one of them.
