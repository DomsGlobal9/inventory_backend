# Roles a shop can shape, and words a shopkeeper already knows

Decisions are made. This is the plan that follows from them. No code has been written.

Two principles run through both halves:

> **The platform defines what can be done. Each shop decides who is allowed to do it.**
>
> **The platform speaks accounting language to accountants, and shop language to shopkeepers.**

---

# Part 1 — Roles

## Decided

| | |
|---|---|
| Merchant creates roles | **Yes** |
| Merchant edits roles | **Yes** |
| Merchant creates permissions | **No** — the catalogue is the platform's |
| Templates at onboarding | **Yes** — Shop Floor, Stock Room, Buyer, Manager |
| `cost:view` | **Yes**, enforced on the server |
| Per-location roles | **No** — documented as unsupported |
| Delete a role someone holds | **No** — `409 ROLE_IN_USE` |
| Dependency closure | **Server**, not the screen |
| `SUPER_ADMIN` | Protected, cannot be edited or deleted |

## What already exists

The data model is finished and needs no migration:

| Table | Shape | Meaning |
|---|---|---|
| `Permission` | `key` unique, **no clientId** | one catalogue, platform-owned |
| `Role` | `clientId`, unique `[clientId, name]` | **already per shop** |
| `RolePermission` | join | what a role holds |

```
Platform  →  37 permissions  →  Merchant  →  creates and edits roles  →  assigns to people
```

Missing: an API, a screen, human names for the keys, and `cost:view` itself.

## Stage 1 — Name the permissions

A table in code mapping every key to a group, a sentence and its dependencies:

```
inventory:receive  group  "Stock"
                   label  "Receive stock into the shop"
                   needs  inventory:view
```

Everything else depends on this, and writing the sentences is itself a review — a key nobody
can write a sentence for is a key that should not exist.

**Groups**, from the keys that exist today:

- **Products** — `product:*`
- **Stock** — `inventory:*`, `stock_count:*`
- **Buying** — `purchase_order:*`, `supplier:*`
- **Selling** — `sales_order:*`, `dispatch:create`, `return:*`, `customer:*`
- **Money** — `cost:view` (new)
- **The shop** — `admin:users`, `admin:catalog`, `admin:locations`, `dashboard:view`

## Stage 2 — `cost:view`, and why it is the hard part

A salesperson should see:

```
Silk saree          ₹2,499
```

and not:

```
Silk saree          ₹2,499     you paid ₹1,350     46% margin
```

### It cannot be a hidden column

Hiding it in React leaves the number in the JSON the browser already received. Anyone who
opens the network tab has it. The server must not send what the person may not see.

### Two mechanisms, not one

**Gate** the routes that exist only to show money. A person without `cost:view` has no business
on them at all, and an empty screen is a clearer answer than a redacted one:

- purchase orders, and the supplier spend report
- inventory valuation and dead stock reports
- the day book's cost and profit figures

**Redact** the routes a salesperson genuinely needs, which merely happen to carry cost:

- product and variant lists
- inventory list
- stock movement history
- search

One redaction function at the serialiser boundary, driven by the permission — not twelve
patches at twelve call sites, which is how one gets missed.

### The subtle part: margin gives cost away

```
cost = price × (1 − margin)
```

Redacting `costPrice` while returning `marginPercent` leaks the cost to anyone with a
calculator. The redaction must remove **everything cost can be recovered from**:

`costPrice` · `averageCost` · `lastPurchaseCost` · `inventoryValue` · `marginPercent` ·
`profitPercent` · `totalCost` · `unitCost` on movements · `costOfGoods` · `grossProfit` ·
`totalSpend` on suppliers · `deadStockValue`

A test that receives every one of these endpoints as a user *without* the permission, and
fails if any cost-derived field survives, is the only way this stays true after the next
feature is added.

### Surfaces to cover

Products · variants · inventory list · stock movements · purchase orders (and their PDF) ·
suppliers · reports · day book · dashboard tiles · exports.

## Stage 3 — The API

```
GET    /roles                    this shop's roles, each with how many people hold it
GET    /permissions              the catalogue, grouped and named
POST   /roles                    create, optionally copied from another
PATCH  /roles/:id                rename, re-describe
PUT    /roles/:id/permissions    replace the set
GET    /roles/:id/impact         who this change would affect      ← new
DELETE /roles/:id                refused while anyone holds it
```

All under `admin:users`, all tenant-scoped.

### Preview before saving

`GET /roles/:id/impact` answers *before* a change is committed:

```json
{ "roleId": "...", "peopleAffected": 4,
  "people": [{ "name": "Ravi", "email": "r@..." }, ...] }
```

The screen says **"This change affects 4 team members."** The server stays authoritative — the
count is not computed in the browser, because the browser's copy of who holds what is already
stale by the time someone reads it.

### Deleting

```
DELETE /roles/:id   →   409  ROLE_IN_USE
{ "message": "This role is assigned to 4 people. Reassign them before deleting the role.",
  "peopleAffected": 4 }
```

Never silently unassign. Someone would find out when a person could not do their job.

### Four rules the server enforces, not the screen

1. `SUPER_ADMIN` cannot be edited or deleted — it holds `*` and it is the way back in
2. You cannot remove your own `admin:users` — the one action that locks the door behind you
3. A role in use cannot be deleted
4. Dependencies close automatically: granting `inventory:receive` grants `inventory:view`
   whether or not the screen remembered

## Stage 4 — The screen

Settings → Team, beside the people list.

- Roles down the left, each with its headcount
- Permissions grouped, with select-all per group
- **A live sentence**: *"Someone with this role can receive stock, raise purchase orders and
  see what things cost. They cannot change prices or manage the team."* A wall of ticks does
  not tell you what you just built.
- **Templates** — Shop Floor, Stock Room, Buyer, Manager — because most shops want one of four
  things and should not compose from scratch
- **"Create a role"**, optionally copying an existing one: *Branch Cashier*, *Senior Buyer*,
  *Warehouse Staff*
- The impact count shown **before** saving

## Explicitly not supported

> **Permissions do not vary by location.** A role that can receive stock can receive it at
> every location the shop has. "Manager, Chirala only" cannot be expressed.

This is written down rather than left to be discovered, because a half-built version is worse
than none: it changes authorisation from `user → role → permission` to
`user → role → permission → location`, and every query, mutation, report, reservation and
purchase order would have to honour the scope. That is a separate capability, not part of this.

## One consequence outside the code

The landing page currently claims roles decide who can *"see costs"*. That is not true today.
It becomes true when `cost:view` ships — and until then the FAQ should say what the product
actually does. Either the claim moves or the feature does; they must not stay apart.

---

# Part 2 — Language

## Decided

| Where | Language |
|---|---|
| Product and inventory screens | **Merchant language** |
| Reports and day book | **Accounting language** |
| Database, API, schema | **Technical terms, unchanged** |
| Existing CSV headers | **Not changed** |

## The labels

| Now | New |
|---|---|
| `COST` | **YOU PAY** |
| `PROFIT %` | **ADD PROFIT** |
| `SELLING PRICE` | **YOU SELL AT** |
| `MARGIN %` | **YOUR SHARE %** |

`YOUR SHARE %` rather than `YOU KEEP`, because "you keep" reads as an amount and the value is a
percentage — *"keep what?"* is the question it invites. The `%` is part of the label, not
decoration.

All four are shorter than what they replace, so nothing needs re-laying-out.

### The line underneath

The percentage alone still leaves the rupees unsaid, so the cell carries both:

```
YOUR SHARE %
46.0%
₹1,125 of every ₹2,499 you sell
```

That is the sentence that makes the relationship land: a percentage of *what*, and how much
money that is.

### Helper text

| Now | New |
|---|---|
| "No cost data yet" | "Tell us what you paid" |
| "need a cost" | "needs what you paid" |
| "using ₹45000.00 (your cost)" | "based on ₹45,000 — what you told us you paid" |
| "Set a price" | "Set what you sell it for" |

## The names underneath do not change

```
UI            YOU PAY        YOU SELL AT        YOUR SHARE %
                 │                │                  │
API/DB      costPrice       sellingPrice       marginPercent
```

The translation happens at the edge. `costPrice` stays `costPrice` in the schema, the API and
every test — precise for engineers, and unaffected by a wording change. Renaming database
concepts to match UI copy would put the marketing team in charge of the migration list.

## Everywhere the same words appear

Changing one table and leaving the rest is worse than changing nothing, because then two
screens disagree about the same number. The same pass covers Add Product (where "Base Price"
and "Cost Price" sit side by side and are a new shop's first meeting with both words), the
purchase order columns, and the inventory list.

## Reports keep the accounting words

Two audiences, and they are not the same person.

| The shopkeeper, daily | Whoever does the books |
|---|---|
| You pay | Cost of goods sold |
| You sell at | Revenue |
| Your share % | Gross margin |

A bookkeeper reading "You Keep" in a report has to work out what it means. "Gross Profit" is
the term on the return. Reports are not dumbed down for consistency's sake.

## CSV is an interface, not copy

Exports are already feeding somebody's spreadsheet. `COST` → `YOU PAY` would break a formula
silently, on a file the merchant did not know had changed.

**Existing headers stay.** If merchant-friendly exports are wanted later they arrive as a
deliberate second format — a *Shopkeeper CSV* alongside the standard one, or a versioned export
schema — not as a rename of the contract that already exists.

---

# Order of work

1. Name the 37 permissions — everything else depends on it, and it is a review in itself
2. `cost:view`: the permission, the gates, the redaction layer, and the test that proves no
   cost-derived field escapes
3. The role API, including impact and the 409
4. The role screen, with templates and the live sentence
5. The language pass across product and inventory screens
6. Correct the landing page's roles claim to match what ships
