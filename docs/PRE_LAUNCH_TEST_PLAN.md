# Pre-Launch Test Plan

The final pass before this goes to market. Written to be executed, not admired: every row is a
thing someone can do, an expected result, and a verdict.

**What is under test — the deployed system, not the working copy.**

| Piece | Address |
|---|---|
| Inventory API | `https://inventory-backend-6vk5.onrender.com` |
| Inventory UI | `https://inventory.scaleezy.com` |
| Try-On (shopper) | `https://www.tryon2buy.com` |
| Try-On API | `https://tryon2buy-backend.onrender.com` |
| Gateway | `https://api-super-admin.onrender.com` |
| Database | Supabase `aws-0-ap-southeast-2` (Sydney) |

**Verdicts:** `PASS` · `FAIL` · `BLOCKED` (needs something I cannot do) · `—` (not yet run)

---

## 0. The question behind the whole exercise

> Will this hold up with a million clients, without breaking, overloading, or getting slow?

That is not answered by any single test, so it is broken into four properties, each of which
has its own section below:

| Property | Why it is the one that matters | Section |
|---|---|---|
| **Latency floor** | If one query costs a second, no amount of good code makes a page fast | §7 |
| **Work per request is bounded** | One tenant must not be able to queue unbounded work on a shared pool | §7 |
| **Cost per tenant is flat** | A screen that does one query per row gets slower as customers succeed | §7 |
| **Tenant isolation** | At a million clients, a leak is not a bug, it is an incident | §8 |

---

## 1. Deployment and configuration

Nothing below is meaningful if the wrong build is live.

| # | Scenario | Expected | Verdict |
|---|---|---|---|
| 1.1 | `/health` responds | 200, no database touched | PASS |
| 1.2 | `/ready` responds | 200, database reachable | PASS |
| 1.3 | The deployed build contains the new scan routes | `/api/v1/public/tryon/...` is not 401 | PASS |
| 1.4 | The migration applied | `tryon_usage.service` column exists | PASS |
| 1.5 | `SHOPPER_TRYON_GATEWAY_URL` is set in Render | generation reaches the gateway, not a 503 | PASS |
| 1.6 | `SHOPPER_TRYON_APP_URL` is set | product page renders a QR rather than hiding it | — |
| 1.7 | Frontend points at the right API | `inventory.scaleezy.com` reaches `6vk5` | PASS |
| 1.8 | Git default branch is not 68 commits behind | `master` is not the default | **FAIL** |

---

## 2. Public surfaces — the shopper, who has no account

The most exposed part of the system. Anyone with a phone can reach it.

| # | Scenario | Expected | Verdict |
|---|---|---|---|
| 2.1 | Scan a published garment | 200, title + image + category | PASS |
| 2.2 | Scan an unknown code | 404 | PASS |
| 2.3 | Scan a code under the wrong shop | 404 | PASS |
| 2.4 | Scan a draft product | 404, byte-identical to 2.2 | PASS |
| 2.5 | Scan a product with no photograph | 404, refused before a selfie is asked for | PASS |
| 2.6 | Response leaks nothing else | no price, cost, stock, supplier, internal id | PASS |
| 2.7 | Generate with a valid selfie | 200, image URL that loads | PASS |
| 2.8 | Generate with no selfie | 400, nothing sent to the gateway | PASS |
| 2.9 | Generate with a non-https selfie URL | 400 — the gateway fetches this URL | PASS |
| 2.10 | Generate with a localhost URL | 400 — must not aim the gateway at internals | PASS |
| 2.11 | Garment supplied in the request body | ignored; the code decides the garment | PASS |
| 2.12 | Rate limit on generate | refused after 8 in 10 minutes per address | — |
| 2.13 | The shop's key never appears in any response | absent from body and headers | PASS |

---

## 3. The QR flow, end to end, through the UI

| # | Scenario | Expected | Verdict |
|---|---|---|---|
| 3.1 | Product page shows a QR code | present, and encodes `/try/<client>/<code>` | PASS (local) |
| 3.2 | The QR points at a live page | scanning resolves, not a redirect to the landing page | PASS |
| 3.3 | Scanned page shows the right garment | the one on the tag, named | PASS |
| 3.4 | Shopper uploads a photo | accepted, preview shown | PASS |
| 3.5 | Generate from the UI | result image rendered | PASS |
| 3.6 | Styling tools are absent | no background change, no sleeve/neck | PASS |
| 3.7 | Draft product warns on the product page | "works once published" | — |
| 3.8 | Mobile (375px) | no horizontal scroll, garment visible first | PASS |
| 3.9 | Tablet (768px) | no horizontal scroll | PASS |
| 3.10 | Desktop (1440px) | two-column, no overflow | PASS |
| 3.11 | Not-found state | branded, explains, offers a way out | PASS |
| 3.12 | Safari / iPhone, real hardware | camera opens; HEIC upload succeeds | **BLOCKED** |

---

## 4. Platform console

| # | Scenario | Expected | Verdict |
|---|---|---|---|
| 4.1 | Client list loads | all clients, with usage | — |
| 4.2 | Both try-on services are listed per client | Catalog and Shopper, separately | — |
| 4.3 | **Paste a dummy try-on key** | refused at save, or saved then fails at use | — |
| 4.4 | Generation with the dummy key | error surfaced; recorded as *failed*, not completed | — |
| 4.5 | **Delete the dummy key** | removed; screen shows "shared key" | — |
| 4.6 | Generation after deletion | succeeds on the platform's shared key | — |
| 4.7 | Usage after all of the above | failures and successes counted separately | — |
| 4.8 | Set a monthly limit | saved; screen reflects it | — |
| 4.9 | Generate while over the limit | 429, nothing sent to the gateway, not charged | PASS (API) |
| 4.10 | Raise the limit | generation immediately allowed again | PASS (API) |
| 4.11 | The key is never returned to the browser | only a prefix, on every route | PASS |
| 4.12 | Platform admin create / deactivate / activate | each confirms, each shows progress | — |
| 4.13 | Suspend a client | their users cannot sign in | — |
| 4.14 | Delete a client | every row removed; self-check passes | — |

---

## 5. Merchant flows — the existing product

Every one of these must work for a **brand new client** exactly as for an old one (§6).

| # | Area | Scenario | Verdict |
|---|---|---|---|
| 5.1 | Catalogue config | Colours: add, rename, disable, delete | — |
| 5.2 | Catalogue config | Delete is refused for an entry in use, and says why | — |
| 5.3 | Catalogue config | Sizes / materials / dress types / categories behave the same | — |
| 5.4 | Catalogue config | Invalid hex is refused with a reason | — |
| 5.5 | Products | Create, publish, edit, archive, trash, restore | — |
| 5.6 | Variants | Add, edit, SKU uniqueness | — |
| 5.7 | Import | CSV import updates quantities and prices | — |
| 5.8 | Import | Oversized file refused with a clear message | PASS |
| 5.9 | Inventory | Adjust stock; movement recorded | — |
| 5.10 | Transfers | Between locations, both sides update | — |
| 5.11 | Purchase orders | Create, send, receive, partial receive | — |
| 5.12 | **Purchase order email** | supplier receives it | — |
| 5.13 | Suppliers | Create, link to variants | — |
| 5.14 | Customers / sales orders | Create, dispatch, return | — |
| 5.15 | Day book | Opening, closing, movements agree | — |
| 5.16 | Reports | Load, and match the dashboard | — |
| 5.17 | Dashboard | Every panel populates; no zeros where there is data | — |
| 5.18 | Storefront | Connection, publish, webhook delivery | — |
| 5.19 | Team | Invite staff, role permissions enforced | — |
| 5.20 | **Staff invite email** | recipient receives credentials | — |
| 5.21 | Settings | Profile, password change, timezone | — |
| 5.22 | APIs & Services | Both services shown with correct usage | PASS |

---

## 6. A brand new client must behave identically

The single most common way a multi-tenant product fails: it works for the tenant it was built
against and not for the next one.

| # | Scenario | Expected | Verdict |
|---|---|---|---|
| 6.1 | Sign up a new client | account, workspace, default location created | — |
| 6.2 | Default catalogue seeded | colours, sizes, types present | — |
| 6.3 | Dashboard on day zero | empty states, not errors or zeros-that-mean-broken | — |
| 6.4 | First product end to end | create → publish → QR → scan → try on | — |
| 6.5 | Try-on with no key of their own | falls back to the shared key, still metered to them | PASS |
| 6.6 | Their usage is theirs alone | invisible to any other client | PASS |
| 6.7 | Every §5 flow repeated | same behaviour as an established client | — |

---

## 7. Scale and speed — the million-client question

| # | Property | Measurement | Verdict |
|---|---|---|---|
| 7.1 | Database round-trip cost | `/ready` − `/health` = **~0.96s per query** | **FAIL** |
| 7.2 | Scan endpoint | ~2.0s, dominated by 7.1 | **FAIL** |
| 7.3 | Inventory UI first byte | 0.26s | PASS |
| 7.4 | Try-on page first byte | 0.53s | PASS |
| 7.5 | Generation | ~22s (gateway work, not ours) | PASS |
| 7.6 | Catalogue settings screen | was 72 queries per load, now 7 | PASS |
| 7.7 | Bulk import concurrency | was unbounded, now batches of 8 | PASS |
| 7.8 | Bulk import request size | was unbounded, now capped at 2000 | PASS |
| 7.9 | Any remaining per-row query loops | audited; none outstanding | PASS |
| 7.10 | Connection pool headroom | not set explicitly; Prisma default on a small instance | **GAP** |
| 7.11 | Behaviour under concurrent tenants | **load tested — see below** | **FAIL** |

### 7.12 Load test, measured against production

A ramp against `/ready`, which runs one `SELECT 1`. It sits outside `/api` so it is not rate
limited, which makes it a clean probe for the connection pool — the thing that gives way first
at scale, long before CPU.

| Concurrent | p50 | p95 | Failed |
|---|---|---|---|
| 1 | 1.4s | — | 0 |
| 40 | 2.1s | 3.1s | 0 |
| 60 | 3.1s | 4.4s | 0 |
| 100 | 4.0s | 6.7s | 0 |
| 150 | 5.2s | 9.6s | 0 |
| **250** | **6.8s** | **11.7s** | **58 of 250 (23%)** |

The same ramp against `/health`, which touches nothing, stays at ~330ms p50 all the way to 40
concurrent with no errors. **So the Node process is not the bottleneck. The database is.**

The failures are ours, not the platform's: the body is `{"status":"not_ready"}`, which `/ready`
returns only when `prisma.$queryRaw` throws. At 250 concurrent, roughly a fifth of database
queries fail outright rather than merely queueing.

**What this means in plain terms.** One trivial query takes four seconds at a hundred
simultaneous requests. A real page makes five to eight queries, so it would take twenty to
forty. The service stops answering reliably somewhere between 150 and 250 concurrent requests —
perhaps a few thousand active users, depending on how often each one clicks.

**A million clients is not close.** Three things in order:

1. **Move the app to the database's region.** ~1s per round trip is the multiplier under
   everything else; nothing else matters until this is fixed.
2. **Raise the connection limit.** `DATABASE_URL` sets no `connection_limit`, so Prisma uses a
   default sized for the instance's CPU count — single digits. pgbouncer is already in front,
   so this can go considerably higher.
3. **Run more than one instance.** One Render service is a single point of both failure and
   capacity.

None of these is a code change. The code-level hazards found in this audit — the 72-query
settings screen, the unbounded bulk import — are real and now fixed, but they were never the
ceiling. The ceiling is where the database is and how many connections reach it.

---

## 8. Tenant isolation — a leak here is an incident, not a bug

| # | Scenario | Expected | Verdict |
|---|---|---|---|
| 8.1 | One client's products invisible to another | enforced server-side, not by the screen | — |
| 8.2 | Try-on keys isolated | one shop cannot see or use another's | PASS |
| 8.3 | Try-on usage isolated | counted per client | PASS |
| 8.4 | Catalogue entries isolated | per client | — |
| 8.5 | A scanned code under the wrong shop | 404 | PASS |
| 8.6 | Cross-origin: try-on app cannot read merchant data | CORS refuses the authenticated surface | PASS |
| 8.7 | Cached responses cannot cross a session switch | `Cache-Control: no-store` on `/api` | — |
| 8.8 | Images are stored under the tenant the server decides | not one the browser sent | — |

---

## 9. Mail

| # | Scenario | Expected | Verdict |
|---|---|---|---|
| 9.1 | SMTP configured in production | env present, connection succeeds | — |
| 9.2 | Staff invite email | delivered with working credentials | — |
| 9.3 | Password reset email | delivered; the new password works | — |
| 9.4 | Platform admin invite | delivered; link lands on the console, not the app | — |
| 9.5 | Purchase order email | supplier receives the order | — |
| 9.6 | A failed send does not fail the action | the staff member is still created | — |
| 9.7 | No open relay | no endpoint sends arbitrary mail to an arbitrary address | — |

---

## 10. Regression — the automated suites

27 suites, run one at a time because they share a tenant.

| Suite | Result |
|---|---|
| verify-audit-fixes | 16 / 16 |
| verify-auth-signup-leads | 16 / 36 — rate limit + missing local admin credentials, not a product failure |
| verify-business-day | 25 / 25 |
| verify-catalog-usage | 5 / 5 |
| verify-bulk-import-scale | 7 / 7 |
| *(remaining 23)* | running |

---

## 11. Known gaps, carried deliberately

Written down rather than left to be rediscovered.

| Gap | Consequence | Decision |
|---|---|---|
| App in Oregon, database in Sydney | ~1s per query; the ceiling on all performance | Open — needs a region move |
| Deleting a client does not revoke their gateway key | a revoked client's key still works at the gateway | Accepted by the user |
| Shopper selfies stored at permanent public URLs | the page promises images are not shared | Open — pre-existing in the try-on app |
| No record of *which* product was tried on | the most valuable signal for a boutique is discarded | Open — product decision |
| Styling tools disabled on the scan page | shoppers cannot change background or sleeves | Deliberate — they bypass metering |
| `master` is the GitHub default branch, 68 commits behind | a clone or a mis-targeted deploy gets nothing | Open — needs a settings change |
| No load testing | behaviour under real concurrency is unknown | Open |

---

## 12. The existing product, button by button

The new work is the smallest part of this system. Everything below predates it and is what a
merchant actually uses every day — so a regression here matters more than a gap in try-on.

The rule for every row: **the button must do what it says, tell you it is working, and leave
the screen showing the truth afterwards.** A button that succeeds silently and a button that
fails silently are the same bug from the user's chair.

### 12.1 Products and variants

| # | Scenario | Expected | Verdict |
|---|---|---|---|
| 12.1.1 | Create a product | appears in the list, gets a product code | — |
| 12.1.2 | Create with a duplicate title | slug stays unique, no collision error | — |
| 12.1.3 | Publish a draft | status changes, `publishedAt` stamped once | — |
| 12.1.4 | Re-save a live product | `publishedAt` does not move | — |
| 12.1.5 | Add a variant | SKU generated, unique within the tenant | — |
| 12.1.6 | Add a second variant, same colour and size | refused, or made unique — never silently duplicated | — |
| 12.1.7 | Edit a variant's price | saved, list reflects it immediately | — |
| 12.1.8 | Bulk price change | every selected row updates | — |
| 12.1.9 | Archive a product | leaves the active list, storefront told | — |
| 12.1.10 | Trash and restore | returns to its previous status, not always ACTIVE | — |
| 12.1.11 | Hard delete | blocked unless trashed first; images cleaned up | — |
| 12.1.12 | Delete a variant carrying stock | refused with a reason | — |

### 12.2 Inventory

| # | Scenario | Expected | Verdict |
|---|---|---|---|
| 12.2.1 | Stock in | quantity rises, movement recorded with a reason | — |
| 12.2.2 | Stock out | quantity falls; cannot go below zero | — |
| 12.2.3 | Adjustment | difference recorded, not the absolute number | — |
| 12.2.4 | Stock in with a unit cost | average cost and inventory value both update | — |
| 12.2.5 | Stock in with no cost | dashboard says so rather than valuing at zero | PASS |
| 12.2.6 | Two receipts at once on one variant | arithmetic exact, no lost update | PASS |
| 12.2.7 | Transfer between locations | both sides move, in one transaction | — |
| 12.2.8 | Reserve stock for an order | available falls, on-hand does not | — |
| 12.2.9 | Low stock alert | fires at the reorder level, not before | — |
| 12.2.10 | Movement history | every change above appears, correctly attributed | — |

### 12.3 Suppliers and purchase orders

| # | Scenario | Expected | Verdict |
|---|---|---|---|
| 12.3.1 | Create a supplier | saved, appears in lists | — |
| 12.3.2 | Link a supplier to a variant with their SKU | shown from both sides | — |
| 12.3.3 | Create a PO | draft, with lines and totals | — |
| 12.3.4 | Send a PO | status SENT | — |
| 12.3.5 | **Email the PO to the supplier** | delivered, readable, correct lines | — |
| 12.3.6 | Receive in full | stock rises, status RECEIVED, cost updated | — |
| 12.3.7 | Receive partially | status PARTIALLY_RECEIVED, only received lines move | — |
| 12.3.8 | Receive more than ordered | refused, or recorded deliberately — never silently | — |
| 12.3.9 | Cancel a PO | no stock moves | — |
| 12.3.10 | Reorder suggestions | based on reorder level and supplier links | — |

### 12.4 The snapshot engine and day book

| # | Scenario | Expected | Verdict |
|---|---|---|---|
| 12.4.1 | Snapshot runs | one row per client per business day | — |
| 12.4.2 | Snapshot is idempotent | running twice does not double anything | — |
| 12.4.3 | Business day respects the shop's timezone | not UTC | PASS |
| 12.4.4 | Day boundary | a sale at 23:59 lands on the right day | PASS |
| 12.4.5 | Day book opening = previous closing | continuous across days | — |
| 12.4.6 | Day book movements agree with transactions | no drift | — |
| 12.4.7 | Dashboard agrees with the console for the same client | identical figures | PASS |
| 12.4.8 | Reports agree with the dashboard | same numbers, same period | — |

### 12.5 Every button, in every state

Not one screen — the pattern that must hold everywhere.

| # | Property | Expected | Verdict |
|---|---|---|---|
| 12.5.1 | A button that starts work shows it | spinner or label change, not a dead press | — |
| 12.5.2 | A destructive button confirms first | and names what it will destroy | — |
| 12.5.3 | A disabled button says why | never a greyed control with no reason | — |
| 12.5.4 | A failed action says what failed | not a silent return to the previous screen | — |
| 12.5.5 | A succeeded action updates the screen | no stale list needing a refresh | — |
| 12.5.6 | Double-clicking does not double-submit | one order, one adjustment, one email | — |
| 12.5.7 | A button the role cannot use is not offered | not offered then refused with a 403 | PASS |

### 12.6 Mail, live

| # | Scenario | Expected | Verdict |
|---|---|---|---|
| 12.6.1 | SMTP reachable from production | connection verified | — |
| 12.6.2 | Staff invite from the UI | delivered; the credentials work | — |
| 12.6.3 | Password reset from the UI | delivered; the new password works | — |
| 12.6.4 | Platform admin invite | delivered; lands on the console | — |
| 12.6.5 | PO email | delivered to the supplier | — |
| 12.6.6 | Mail failure does not fail the action | the staff member still exists | — |
