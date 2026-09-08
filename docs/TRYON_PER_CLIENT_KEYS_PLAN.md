# Per-client keys and usage metering for Try-On

Status: proposed, nothing built. Current shared key stays working throughout.

## The gap, precisely

Try-on generates four views per garment. Today the inventory module calls it like this:

```
merchant → inventory backend → gateway → catalog-tryon service
                               ^
                        ONE shared key
                        CATALOG_TRYON_API_KEY
```

`catalog-tryon.service.ts` sends `env.CATALOG_TRYON_API_KEY` for every request from every
merchant. Its own comment says the gateway "resolves our tenant from CATALOG_TRYON_API_KEY" --
and it does, to **one** tenant. Every generation from all 37 shops is attributed to a single
customer. Nothing is broken. Nothing is measurable either.

## The operating model, as decided

```
1. A client is onboarded
2. A platform admin generates that client's key IN THE GATEWAY
3. The admin pastes it into that client's page in the Platform Console
4. Inventory stores it encrypted, against that clientId
5. Every try-on call for that client sends THAT client's key
6. The merchant sees, under Settings -> APIs & Services, that Try-On is active
   and a masked fingerprint of the key -- never the key itself
```

The gateway keeps ownership of identity, quota and metering; inventory holds a copy of the key
purely so it can present it on the client's behalf. That division is the point: there is one
place a key is issued and one place it is revoked.

## Most of this already exists in the gateway — do not rebuild it

| Already there | What it gives us |
|---|---|
| `ApiKey` | per-client keys, hashed, with status, expiry, `requestCount`, `lastUsedAt` |
| `ApiKeyModuleAccess` | which modules a key may reach |
| `ClientAccess` | per-client, per-microservice enable/disable and `rateLimit` (per day) |
| `RequestLog` | every call: clientId, apiKeyId, endpoint, status, latency, sizes |

This is not "build an API key system". It is "stop sending the same key for everyone, and start
counting the thing we would bill for". Building a second key system inside the inventory module
would mean two places to revoke a key, and eventually a key revoked in only one of them.

What is genuinely missing is an **aggregated usage record**. `RequestLog` is a raw log -- right
for debugging, wrong for "how many generations did this shop use in September". That question
gets slower every month and raw logs get pruned.

## Should the key be appended to the login credentials? No.

It is a fair question, because both arrive at onboarding and both are secrets. They are not the
same kind of thing, and joining them creates problems that are hard to undo:

| | Login credentials | API key |
|---|---|---|
| Held by | a person | a machine |
| Shown to | that person, deliberately | nobody -- explicitly not the merchant |
| Rotated when | someone leaves, or suspicion | quota abuse, a leak, a schedule |
| Blast radius if leaked | one workspace, behind a login screen | metered spend on GPU work |

Bundling them means rotating one forces rotating the other -- so a staff member leaving would
either break try-on or leave a key that should have been rotated. And the credential email is
the one message in this product that deliberately puts a secret in an inbox; adding a machine
credential to it doubles what a compromised mailbox is worth.

They share only a moment in time. That is not a reason to share a lifecycle.

## How real gateways do this, and what is worth copying

Kong, Apigee and AWS API Gateway converge on the same shape, and three parts of it are worth
taking:

**The key is opaque and stored hashed.** It identifies a consumer; it carries no meaning and
cannot be reversed. The gateway's `ApiKey.keyHash` already does this. Note `rawKey` also exists
there "for display purposes" -- that is a deliberate weakening, and if per-client keys are going
to be a real product it is worth deciding whether that column should keep being written.

**Quota and rate attach to the key, not to the code.** `ClientAccess.rateLimit` is already that.
The application should not be enforcing per-client limits itself; if it does, the limit lives in
two places and they will disagree.

**Rotation overlaps.** A consumer can hold two valid keys briefly, so a key can be replaced
without a gap. With one key per client, rotation is: paste the new one, and every request
between the gateway issuing it and the console saving it fails. Supporting a short overlap turns
a small outage into a non-event, and it is much easier to design in now than to retrofit.

## Where the key lives on our side

A table rather than a column, because try-on will not be the only service:

```
ClientServiceCredential
  clientId          which shop
  service           'CATALOG_TRYON' for now
  keyEncrypted      AES-256-GCM, the same facility as Shopify tokens
  keyPrefix         first few characters, for display and for logs
  status            ACTIVE | REVOKED
  addedByAdmin      who pasted it, for the audit trail
  addedAt, lastUsedAt
  @@unique([clientId, service, status]) -- one active key per service per client
```

Encrypted rather than hashed, for the same reason as the Shopify token: it has to be replayed on
every call. That does mean the inventory database now holds N replayable secrets, which raises
what it is worth stealing. Mitigated by: encrypted at rest, never returned by any merchant-facing
endpoint, masked in every log line, and revocable from the gateway independently of us.

## Two behaviours that decide whether this is pleasant or painful

**Validate the key when it is pasted, not when a merchant first uses it.**

A pasted key with a missing character saves fine and fails later -- and it fails in front of a
merchant pressing Generate, as a 401 they cannot interpret, hours after the admin who pasted it
has moved on. The console should call the gateway once with the key before saving it and refuse
to save one that does not work.

**Fall back to the shared key while there is one.**

A client with no key of their own keeps using `CATALOG_TRYON_API_KEY` exactly as today. That is
what makes this shippable in pieces: nothing breaks on the day it deploys, keys are pasted in as
clients are onboarded, and the fallback is removed only once every client has their own. Without
it, the day this ships is the day try-on stops for everyone who has not been migrated yet.

## What the two screens show

**Platform Console -> a client's page -> Services**

```
Virtual Try-On                                    [ Not connected ]
  Generate a key in the gateway, then paste it here.
  [ paste key ......................... ]  [ Connect ]

Virtual Try-On                                    [ Active ]
  Key ..... sk_live_a41f••••         added by platform-admin@scaleezy.com, 8 Sep
  Used ..... 214 generations this month
  [ Replace key ]  [ Disconnect ]
```

**Inventory Settings -> APIs & Services** (what the merchant sees)

```
Virtual Try-On                                    Active
  Four-view garment generation.
  Key ..... sk_live_a41f••••    (managed by Scaleezy)
  Used ..... 214 of 500 generations this month
```

The merchant sees enough to recognise the key in a support conversation, and to know where they
stand against their allowance. They cannot retrieve it. That has to be enforced at the API, not
by leaving it out of the markup: the endpoint serving this screen must return the prefix only
and must never decrypt.

## Meter generations, not requests

A generation produces four views. The billable unit is the **generation**, counted on
completion. Counting requests instead would bill:

- a job that failed halfway
- a job the merchant cancelled (`/cancel-job` already exists)
- a timeout retry -- twice, for one garment

Record `viewsGenerated` rather than assuming four, so three-of-four is visible rather than
rounded up. The try-on service is the only party that knows a generation finished and how many
views came out, so it has to report that.

## What to build

### Phase 1 — the key, end to end
1. `ClientServiceCredential`, encrypted, with the masked prefix.
2. Console: paste, validate against the gateway, save, replace, disconnect.
3. `catalog-tryon.service.ts` sends the client's key, falling back to the shared one.
4. Merchant-facing Settings -> APIs & Services, prefix only.

**Done when:** a client with a pasted key is attributed correctly in the gateway's own
`RequestLog`, and a client without one still works.

### Phase 2 — counting
5. `TryOnUsage`: one row per client per day -- `generations`, `viewsGenerated`, `failures`,
   `cancellations`. Small, exact, and answers "this month" with one aggregate.
6. Usage on both screens.

**Done when:** the console can show generations per client per day, and the figures match what
the try-on service actually produced.

### Phase 3 — limits
7. Enforce `ClientAccess.rateLimit` at the gateway, with the policy below.
8. Warn the merchant approaching it, in the app, before it bites.

### Phase 4 — keys merchants hold themselves
Only if try-on is sold as an API a merchant calls from their own site. Different product
decision; the metering above does not change.

## Decisions still open

**What happens at the limit.** Block and offer more, allow and record the overage, or warn at
80% and block at 200%. Try-on is GPU work, so an unmetered client is real money -- which argues
for a default limit on every client rather than unlimited until someone notices. Whichever is
chosen, the merchant must be able to see their usage *before* they hit it. Being blocked by a
number you were never shown is the worst version of this feature.

**Concurrency.** One shop generating a thousand garments should not starve everyone else. A
per-client concurrent-job cap is a separate control from a daily count, and GPU work needs both.

**Retries.** The same garment must not count twice after a timeout. Needs an idempotency key
from the caller, agreed now rather than after someone is double-charged.

**Deleting a client.** Erasing a tenant here removes its `ClientServiceCredential` row -- but
does **not** revoke the key in the gateway. That key stays valid, for a shop that no longer
exists. Either deletion calls the gateway to revoke, or the runbook says to revoke by hand, but
it cannot be left unstated.

**The 37 existing tenants.** All sharing one key today, so their history cannot be split apart
afterwards. Metering starts the day this ships, and the console should say so rather than
implying earlier months were zero.

## Honest assessment

Phase 1 is a small amount of code, because the gateway already owns identity and logging. The
real work is the decisions above -- what a generation costs and what happens at the limit are
commercial choices the implementation only encodes.

The two things worth insisting on: validate the key when it is pasted rather than when a
merchant meets a 401, and keep the shared-key fallback until every client has their own, so
this can ship in pieces instead of as one switchover.
