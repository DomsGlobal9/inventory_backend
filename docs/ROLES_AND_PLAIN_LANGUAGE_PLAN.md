# Two plans: roles a shop can shape, and words a shopkeeper already knows

No code has been written for either. This is the thinking.

---

# Part 1 — Letting each shop decide what a role can do

## What we have already

Better than expected. The data model is finished:

| Table | Shape | Meaning |
|---|---|---|
| `Permission` | `key` unique, **no clientId** | one catalogue, owned by the platform |
| `Role` | `clientId` + unique `[clientId, name]` | **already per client** |
| `RolePermission` | join | which role holds which permission |

So a shop can already have roles nobody else has, holding any mix of permissions. Nothing
needs a migration.

## What is missing

1. **No way to edit a role.** `rbac-seed.service.ts` writes the same fixed set at onboarding —
   `SUPER_ADMIN` with `*`, plus a few fixed others — and nothing ever changes them again.
2. **No API.** There is no endpoint to create a role, rename one, or change what it holds.
3. **No screen.** `TeamManager` only *assigns* an existing role to a person.
4. **37 permission keys with no human names.** `purchase_order:receive` is a key, not a label.

So today every shop gets identical roles whether it is one person with a till or four branches
with a buying team.

## How Shopify does it, and what is worth copying

**The catalogue is Shopify's, not the merchant's.** A merchant chooses which permissions to
grant; they cannot invent new ones. This is the right call and it is what our schema already
does — `Permission` has no `clientId`. A permission is a promise the *server* enforces, so a
shop inventing one would be inventing a promise nothing keeps.

**Permissions are grouped by area, with a select-all per group.** Orders, Products, Customers,
Inventory, Settings. Nobody reads 37 checkboxes in a flat list.

**They are written as sentences, not keys.** "View and manage orders", never `orders:write`.

**Dependencies are enforced.** You cannot grant *edit orders* without *view orders*. Shopify
resolves this silently rather than showing an error.

**The owner cannot be restricted.** There is always one account that cannot lock itself out.

**Plus adds reusable named roles** so you stop re-ticking boxes per person — which is what we
already have and Shopify's non-Plus tier does not.

Worth knowing about the alternatives: Odoo exposes read/write/create/delete per database model,
which is complete and unusable by a shopkeeper. Zoho gives module-level toggles on top of
preset roles. Shopify's grouped-checkbox model sits between them and is the one to follow.

## The plan

### Stage 1 — Give every permission a name and a home

A table, in code, mapping each of the 37 keys to a group, a sentence, and its dependencies:

```
inventory:receive  →  group: "Stock"
                      label: "Receive stock into the shop"
                      needs: inventory:view
```

Nothing else in this plan can be built before this exists, and it is also the thing that makes
the current 37 keys reviewable — writing the sentences will expose keys that overlap or that
nobody can explain.

**Grouping proposed** (from the keys that exist today):

- **Products** — `product:*`
- **Stock** — `inventory:*`, `stock_count:*`
- **Buying** — `purchase_order:*`, `supplier:*`
- **Selling** — `sales_order:*`, `dispatch:create`, `return:*`, `customer:*`
- **The shop** — `admin:users`, `admin:catalog`, `admin:locations`, `dashboard:view`

### Stage 2 — The API

```
GET    /roles                    what this shop has, with counts of people in each
GET    /permissions              the catalogue, grouped and named
POST   /roles                    create, optionally copying an existing one
PATCH  /roles/:id                rename, re-describe
PUT    /roles/:id/permissions    replace the set
DELETE /roles/:id                refused while anyone still holds it
```

All under `admin:users`, all tenant-scoped. Four rules the server must enforce, not the screen:

1. **`SUPER_ADMIN` cannot be edited or deleted.** It holds `*` and it is the way back in.
2. **You cannot remove your own `admin:users`.** The one action that locks the door behind you.
3. **A role in use cannot be deleted** — reassign the people first, and the error should say
   how many there are.
4. **Dependencies are closed server-side.** Granting `inventory:receive` grants
   `inventory:view` whether or not the screen remembered to tick it.

### Stage 3 — The screen

Under Settings → Team, beside the existing people list.

- Roles down the left, each with how many people hold it
- Permissions grouped, checkboxes, select-all per group
- A live sentence at the bottom: *"Someone with this role can receive stock, raise purchase
  orders and see costs. They cannot change prices or manage the team."* — because a wall of
  ticks does not tell you what you have just built
- **Start from a template**: Shop floor, Stock room, Buyer, Manager. Most shops want one of
  four things and should not compose from scratch.
- Changing a role tells you how many people it affects **before** saving

### Stage 4 — Two things this makes possible

Once roles are editable, two gaps become fixable that are currently not:

- **`cost:view` does not exist.** Today anyone who can open a product sees what it cost and
  what the margin is. Some shops will not want the counter staff to see the buying price. This
  is also a claim the landing page currently makes and the product does not keep — see the
  audit.
- **A per-location role.** "Manager, Chirala only" is a real thing to want and the model has no
  way to say it. Worth deciding whether it is in scope; it is a bigger change than the rest of
  this plan combined, because every query would have to honour it.

## What I need decided

1. **Can a shop create roles, or only edit the ones they were given?** Creating is more useful
   and more rope.
2. **Do we ship `cost:view`?** It changes what the marketing page may claim.
3. **Per-location roles: in or out?** Recommend out, for now, and stated as a known gap.

---

# Part 2 — Words a shopkeeper already uses

## The problem

The variant table reads:

```
STATUS   COST   PROFIT %   SELLING PRICE   MARGIN %
```

Four of those five are accounting words. A shopkeeper who has never used inventory software
knows what they *paid* and what they *sell it for*; "margin" and "cost" are terms they may
associate with a chartered accountant, and "profit %" and "margin %" sitting in adjacent
columns are two different percentages of two different things — which is exactly the confusion
the landing page was written to avoid.

The landing page already solved this. It says **you pay**, **you sell at**, **you keep**. The
app should not use harder words than its own marketing.

## Proposed

| Now | Proposed | Why |
|---|---|---|
| `COST` | **YOU PAY** | what leaves the till when you buy it |
| `PROFIT %` | **ADD PROFIT** | it is an input that fills the price, not a readout |
| `SELLING PRICE` | **YOU SELL AT** | plain, and matches the tag in the shop |
| `MARGIN %` | **YOU KEEP** | the money that stays with you, said as money would be said |

Shorter than what is there now, so nothing needs re-laying-out.

The helper text underneath should follow:

| Now | Proposed |
|---|---|
| "No cost data yet" | "Tell us what you paid" |
| "need a cost" | "needs what you paid" |
| "using ₹45000.00 (your cost)" | "based on ₹45,000 — what you told us you paid" |
| "Set a price" | "Set what you sell it for" |

## Everywhere else the same words appear

Changing one table and leaving the rest is worse than changing nothing, because then two
screens disagree. The same pass covers:

- **Add Product** — "Base Price" and "Cost Price" beside each other, which is the first place a
  new shop meets both words
- **Purchase order** — "COST" and "SELLS AT" column heads
- **Inventory list** — "AVG COST", "TOTAL VALUE"
- **CSV export headers** — these are read outside the app, so they matter more, not less
- **Reports and the day book** — "cost of goods", "gross profit"

## The one place to keep the accounting word

Reports and the day book are read by whoever does the shop's books, and *they* want "cost of
goods sold" and "gross profit" because those are the words on the return. Proposal: plain
language everywhere a shopkeeper works, accounting language in the reports, and the two
labelled clearly enough that nobody has to guess which is which.

## What I need decided

1. **Is "YOU PAY / YOU SELL AT / YOU KEEP" right**, or is there wording that suits a saree shop
   better in practice?
2. **Should the reports keep the accounting words?** Recommend yes.
3. **Do the CSV headers change?** They may be feeding someone's spreadsheet already.
