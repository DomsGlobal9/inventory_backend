# The permission catalogue, audited

Every key read against the routes it actually guards and the roles that actually hold it. This
is architecture validation, not documentation: the point is what it turns up.

**Counts.** 39 keys in the catalogue, 38 guard at least one route, 1 guards nothing. No route
uses a key that is missing from the catalogue, which is the failure mode that makes a route
unreachable for everyone but `SUPER_ADMIN`.

---

## The finding that matters

> **`dashboard:view` is not a dashboard permission. It is the money permission, and every
> seeded role holds it — including `SALES`.**

It guards sixteen routes:

```
/dashboard/summary          inventory value
/daybook/                   cost of goods, gross profit
/report/inventory-value     what the whole shop is worth
/report/supplier-spend      what you pay each supplier
/report/dead-stock          value of what is not moving
/report/category-value      value by category
/report/inventory-summary   /report/dashboard-summary
/report/low-stock-value     /report/movement-aging
/report/open-po-value       /report/recent-transactions
/report/snapshots  (get, post)   /report/stock-movement
/location/                  a list of locations, which is not a report at all
```

And in `rbac-seed.service.ts`, **`SALES` holds `dashboard:view`.**

So today a shop-floor salesperson can open the reports and read the shop's total stock value,
its gross profit, and what it pays each supplier. `cost:view` is being designed to stop exactly
that, and it would not — because the exposure is not through a cost field on a product, it is
through a permission whose name sounds harmless.

**`cost:view` cannot ship without splitting this key.** Any redaction layer that leaves
`dashboard:view` as it is will be bypassed by anyone who clicks Reports.

### Proposed split

| New key | Guards | Who would hold it |
|---|---|---|
| `dashboard:view` | the dashboard's non-money tiles, `/location/` (or move that to `inventory:view`) | everyone |
| `report:view` | operational reports — stock movement, aging, recent transactions, snapshots | most roles |
| `report:financial` | inventory value, supplier spend, dead stock value, category value, the day book | managers and buyers |

`report:financial` then implies `cost:view`, and the two stay consistent by construction rather
than by being remembered.

---

## The full catalogue

Key → group → the sentence a shopkeeper would read → what it needs → notes.

### Products

| Key | Sentence | Needs | Notes |
|---|---|---|---|
| `product:view` | See products and their variants | — | also guards `/catalog/config`, `/catalog/items` and both searches |
| `product:create` | Add new products and variants | `product:view` | **also guards try-on generation** — see finding 3 |
| `product:update` | Change product details and prices | `product:view` | includes the per-location price override |
| `product:delete` | Trash, archive and permanently delete products | `product:view` | archive and restore live here too |

### Stock

| Key | Sentence | Needs | Notes |
|---|---|---|---|
| `inventory:view` | See stock levels and movement history | — | |
| `inventory:receive` | Bring stock in | `inventory:view` | **only** the manual stock-in; a PO receipt is `purchase_order:receive` |
| `inventory:adjust` | Correct stock counts and values | `inventory:view` | **too broad** — see finding 2 |
| `inventory:transfer` | Move stock between locations | `inventory:view` | two routes do the same thing |
| `stock_count:view` | See stock counts | `inventory:view` | |
| `stock_count:create` | Start a stock count | `stock_count:view` | |
| `stock_count:update` | Enter counted quantities | `stock_count:view` | |
| `stock_count:complete` | Finish a count and post its corrections | `stock_count:update` | **writes stock** — the real authority here |

### Buying

| Key | Sentence | Needs | Notes |
|---|---|---|---|
| `purchase_order:view` | See purchase orders | — | shows what you pay suppliers → implies `cost:view` |
| `purchase_order:create` | Raise a purchase order | `purchase_order:view` | reorder drafts too |
| `purchase_order:update` | Change and send a purchase order | `purchase_order:view` | **the only permission that sends something outside the company** |
| `purchase_order:receive` | Receive goods against an order | `purchase_order:view` | writes stock and cost |
| `supplier:view` | See suppliers and what they supply | — | supplier detail carries total spend → implies `cost:view` |
| `supplier:create` | Add a supplier | `supplier:view` | |
| `supplier:update` | Change a supplier and its items | `supplier:view` | agreed prices live here |
| `supplier:delete` | Remove a supplier | `supplier:view` | |

### Selling

| Key | Sentence | Needs | Notes |
|---|---|---|---|
| `sales_order:view` | See orders | — | |
| `sales_order:create` | Take an order | `sales_order:view` | **`/sales-order/full` — the future POS entry point** |
| `sales_order:update` | Change an order's lines | `sales_order:view` | |
| `sales_order:confirm` | Confirm an order and reserve its stock | `sales_order:view` | first point stock is affected |
| `sales_order:cancel` | Cancel an order and release its stock | `sales_order:view` | delete routes here too |
| `dispatch:create` | Send goods out against an order | `sales_order:view` | **this is what removes stock** |
| `dispatch:view` | — | — | **dead: guards nothing** |
| `return:view` | See returns | — | |
| `return:create` | Log a return | `return:view` | |
| `return:receive` | Mark a return as arrived | `return:view` | |
| `return:inspect` | Decide restock, damaged or scrap | `return:view` | decides whether stock comes back |
| `return:complete` | Finish a return | `return:inspect` | **writes stock**; also guards reject |
| `customer:view` | See customers | — | |
| `customer:create` | Add a customer | `customer:view` | |
| `customer:update` | Change a customer | `customer:view` | **no `customer:delete` exists** |

### The shop

| Key | Sentence | Needs | Notes |
|---|---|---|---|
| `dashboard:view` | See the dashboard and reports | — | **see the finding above** |
| `admin:users` | Manage the team | — | **also gates reading a colleague's password** — finding 4 |
| `admin:locations` | Add and change shops and warehouses | — | |
| `admin:catalog` | Manage sizes, colours and categories | `product:view` | |

---

## Findings

### 1. `dashboard:view` is the money permission — **critical**

Covered above. It blocks `cost:view` from being meaningful and is held by every seeded role.

### 2. `inventory:adjust` is too broad — **high**

It guards five unrelated things:

```
/inventory/adjustment         correct a count
/inventory/stock-out          remove stock
/inventory/set-cost           restate what stock cost      ← money, not quantity
/inventory/reconcile-valuation  recompute values           ← money, not quantity
/variant/bulk-update          bulk edit, including SELLING PRICES
```

Two problems. Someone trusted to correct a miscount can also **restate what the stock cost** and
**change every selling price in the shop from a CSV**. Those are three different jobs.

**Proposed:** `inventory:adjust` keeps quantity corrections. `set-cost` and
`reconcile-valuation` move to a new `cost:manage` (which implies `cost:view`). Bulk update
splits by what the file contains — quantities under `inventory:adjust`, prices under
`product:update`.

### 3. `product:create` can spend money — **medium**

It guards `/catalog-tryon/generate-catalog` and `/catalog-tryon/cancel-job`. Try-on generation
is **metered and billed per use**. So anyone who can add a product can consume the shop's
try-on allowance.

**Proposed:** a `tryon:generate` key. It is also the first key a shop would want to give a
junior and then take away.

### 4. `admin:users` includes reading a colleague's password — **high**

`team.routes.ts` gates the whole router with `admin:users`, so listing the team and
`POST /members/:id/password/view` are the same permission. Reading someone's password in plain
text is not the same authority as inviting them.

**Proposed:** `team:view_password`, separate, and recorded when used — the same reasoning that
put an audit trail on the platform console's version of this.

### 5. `dispatch:view` is dead — **low**

In the catalogue and in `WAREHOUSE`'s permission list, guarding nothing. Either gate
`GET /dispatch` with it or remove it. A permission that grants nothing teaches people that
ticking boxes has no effect.

### 6. Asymmetric and missing keys — **low**

- `customer:create` and `customer:update` exist; **`customer:delete` does not**
- `inventory:receive` covers only manual stock-in. Bringing stock in via a purchase order needs
  `purchase_order:receive`. A "Stock Room" role needs **both**, which is not obvious from
  either name.
- `inventory:transfer` guards two routes that do the same job (`/inventory-transfer/` and
  `/inventory/transfer`) — a duplicate route, not a permission fault, but worth removing.

### 7. Where cost leaks indirectly

Beyond the fields a redaction layer would strip, these permissions expose cost by existing:

| Permission | How |
|---|---|
| `dashboard:view` | reports: inventory value, supplier spend, dead stock, day book |
| `purchase_order:view` | a purchase order is a list of what you pay |
| `supplier:view` | supplier detail carries total spend |
| `inventory:view` | movement history carries `unitCost` and `totalCost` |

The first three should **imply** `cost:view` rather than be redacted — a purchase order with the
prices removed is not a purchase order. The fourth needs redaction, because stock history is
genuinely useful without the money in it.

---

### 8. Authority was a role name, not a permission — **critical**

`requirePermission` returned early when a user's role *names* contained `SUPER_ADMIN`:

```ts
// SUPER_ADMIN bypasses all checks
if (user.roles && user.roles.includes('SUPER_ADMIN')) {
  return next();
}
```

43 of the platform's 71 users hold that role, so for most of the people using this product,
authorisation was a string comparison and their stored permissions were never consulted.

Three consequences, all measured rather than supposed:

1. **The stored permissions had drifted, invisibly.** Production `SUPER_ADMIN` holds 26 keys,
   seven of which (`dispatch:cancel`, `dispatch:execute`, `dispatch:view`, `user:view`,
   `user:create`, `user:update`, `user:disable`) guard no route at all, and it does **not** hold
   `dashboard:view`. Had the bypass ever been removed, every account owner would have lost the
   dashboard. Nothing surfaced this, because nothing read it.
2. **The name was the credential.** Any role that came to be called `SUPER_ADMIN`, by any path
   — a seed, a support script, a merchant naming their own role — held everything.
3. **It was in four places.** Twice in `permission.middleware.ts` (including a `requireRole`
   that nothing imported), once deciding who may read a colleague's password, once deciding who
   may change their own — plus four more copies in the browser. Each looked local.

Fixed: total access is the `'*'` grant. It is deliberately **not** in the catalogue, so it is
not a box a merchant can tick — a shop wanting a second full administrator composes one, which
leaves a record of what was granted. `verify-permissions.ts` fails if any role-name check
reappears anywhere under `src/middleware`, `src/controllers`, `src/services` or `src/routes`.

### 9. The browser had no implication closure — **medium**

Introduced by the fix to finding 1, and worth recording as a general rule. `report:financial`
confers `report:view` without storing it, so `permissions.includes('report:view')` is `false` in
the browser while the API serves the request behind it. Any UI gated on an implied key would
have been hidden from the very people meant to see it.

Fixed at the edge rather than duplicated: `/auth/login` and `/auth/session` now send the
*expanded* set. The definition of what a permission means stays in one file.

**The general rule:** anywhere permissions are consumed outside `config/permissions.ts` — the
browser today, POS and Accounts tomorrow — must receive the expansion, never the raw grants. A
second copy of the implication table is a second thing to forget to update.

## Live impact, measured before the migration ran

`npx ts-node src/scripts/permission-impact.ts`, against production:

| | |
|---|---|
| Users | 71 total, 68 active, all holding at least one role |
| Lose the ability to read costs, profit and supplier spend | **24** (23 WAREHOUSE, 1 SALES) |
| Keep it | 2 ADMIN, plus every account owner via `'*'` |
| Role names the migration's mapping did not know | `GUEST` (1 person), `STAFF` (1) — neither held `dashboard:view`, so neither loses anything |

The 24 is the point of the exercise, not a side effect. Those shops should be told.

## What a service identity would need

Designing the boundary once, before any module depends on it.

| Module | Permissions | Note |
|---|---|---|
| **POS** | `sales_order:create`, `sales_order:confirm`, `dispatch:create`, `product:view`, `inventory:view`, `customer:view`, `customer:create` | `/sales-order/full` is already the entry point, already idempotent |
| **Shopify / storefront** | `product:view`, `inventory:view`, `sales_order:create` | outbound sync mostly reads |
| **Accounts / GST** | `sales_order:view`, `purchase_order:view`, `report:financial`, `cost:view` | the one identity that *should* see money |

Two things this shows:

1. **A POS needs no cost permission at all.** It sells at the price on the tag. That is a good
   argument for the split: the identity that touches the most stock needs the least money.
2. **`report:financial` earns its place here too** — the accounts module wants exactly that set
   and nothing else, which is hard to express while it is bundled into `dashboard:view`.

---

## Recommended order

1. **Split `dashboard:view`** into `dashboard:view` / `report:view` / `report:financial`.
   Nothing else in the `cost:view` design is sound until this is done.
2. **Narrow `inventory:adjust`**; add `cost:manage`.
3. **Add `cost:view`**, with `report:financial`, `purchase_order:view` and `supplier:view`
   implying it.
4. **Add `tryon:generate`** and take it out of `product:create`.
5. **Split `team:view_password`** out of `admin:users`, and record its use.
6. ~~**Remove or wire `dispatch:view`**; drop the duplicate transfer route.~~ Done: `dispatch:view` is removed (there is no dispatch read endpoint to gate), and `POST /inventory/transfer` is gone -- it was a 501 stub answering "not yet enabled" while `POST /inventory-transfers`, which the app actually calls, did the work.
7. Then the naming table, the API, and the screen.

Steps 1 to 6 change what existing roles hold, so each needs a migration that maps the old grant
to the new keys — a role holding `dashboard:view` today should come out holding `dashboard:view`
and `report:view`, and **only** get `report:financial` if it is `ADMIN`, `INVENTORY_MANAGER` or
`SUPER_ADMIN`. `SALES` and `WAREHOUSE` should not.

That migration is the moment a live shop's salesperson stops being able to read the shop's
profit, so it is worth telling the shops it happens to.
