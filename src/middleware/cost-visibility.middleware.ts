import { Request, Response, NextFunction, RequestHandler } from 'express';
import { grants, holdsEverything } from '../config/permissions';

/**
 * What the business paid, taken out of a response for anyone without `cost:view`.
 *
 * `cost:view` is `fieldLevel`: it never decides whether a request reaches a handler, only whether
 * the cost numbers survive in what comes back. It was declared that way and then enforced
 * nowhere -- a salesperson opening a product's sizes, or searching for a variant, received
 * `costPrice`, `averageCost` and `lastPurchaseCost` in the JSON, and the sales orders they take
 * came back with each line's cost and gross profit. Hiding a column in React would leave all of
 * that in the network tab, so the server stops sending it.
 *
 * Mounted on the routers a person without cost access genuinely uses (products, variants, stock,
 * search, orders, the dashboard, operational reports). NOT on the ones whose permission
 * `exposesCost` by definition -- a purchase order or a supplier's agreed price with the money
 * removed is not a purchase order -- nor on routes that already require `report:financial`,
 * which confers `cost:view`.
 *
 * By key name, at any depth, because the same variant object is nested inside transactions,
 * order lines and dashboard tiles, and a list of paths would miss the next place it is embedded.
 * The names are the ones cost can be read OR worked back from: a stock value is quantity times
 * average cost, and a gross profit is price minus cost -- redacting cost while returning either
 * leaks it to anyone with a calculator.
 */
export const COST_FIELDS: ReadonlySet<string> = new Set([
  'costPrice',
  'averageCost',
  'lastPurchaseCost',
  'lastCostUpdatedAt',   // when cost last changed says a receipt happened at a price
  'previousAverageCost',
  'newAverageCost',
  'inventoryValue',      // quantity x average cost
  'totalValue',          // the same, summed (movement-aging)
  'unitCost',            // per unit on a movement or an order line
  'totalCost',
  'grossProfit',         // price - cost
  'costOfGoods',
  'marginPercent',
  'profitPercent',
  'averageCostMinor',
  'unitCostMinor',
  'totalCostMinor'
]);

/** True for the account owner, and for anyone whose role confers `cost:view` directly or by implication. */
export function canSeeCost(user: { permissions?: string[]; roles?: string[] } | undefined): boolean {
  if (!user) return false;
  return holdsEverything(user.permissions ?? [], user.roles ?? []) || grants(user.permissions ?? [], 'cost:view');
}

/**
 * A copy of `value` without the given keys, at any depth.
 *
 * Only plain objects and arrays are walked. A Prisma Decimal or a Date is an object too, and
 * rebuilding one from its enumerable fields turns 1200.00 into `{ d: [...], e: 3, s: 1 }` --
 * those are passed through untouched for `res.json` to serialise as it always has.
 */
export function withoutKeys(value: unknown, keys: ReadonlySet<string>): unknown {
  if (Array.isArray(value)) return value.map(v => withoutKeys(v, keys));
  if (value === null || typeof value !== 'object') return value;

  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return value;

  const out: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
    if (keys.has(key)) continue;
    out[key] = withoutKeys(inner, keys);
  }
  return out;
}

type Options = {
  /** Keys that are cost on THIS router only, where the same name elsewhere means a selling price. */
  alsoHide?: string[];
  /** Permissions that see these figures anyway, because they already expose what was paid. */
  alsoVisibleTo?: string[];
  /**
   * Paths under this mount that belong to a router mounted elsewhere.
   *
   * Express runs a mount's middleware for every path beneath it, including ones the mounted router
   * does not handle and passes on. `/variants/:id/suppliers` falls through `/variants` to the
   * supplier-product router -- a supplier's agreed price, which `supplier:view` shows by design.
   */
  except?: RegExp;
};

/**
 * Wraps `res.json` so the body is filtered at the moment it is sent. The user is read then, not
 * when the middleware runs, so it works wherever it is mounted relative to `authenticate`.
 */
export function hideCostUnlessPermitted(options: Options = {}): RequestHandler {
  const keys = options.alsoHide?.length ? new Set([...COST_FIELDS, ...options.alsoHide]) : COST_FIELDS;

  return (req: Request, res: Response, next: NextFunction) => {
    if (options.except?.test(req.path)) return next();
    const send = res.json.bind(res);
    res.json = (body?: any) => {
      const user = (req as any).user;
      const permitted = canSeeCost(user)
        || (options.alsoVisibleTo ?? []).some(p => grants(user?.permissions ?? [], p));
      return send(permitted ? body : withoutKeys(body, keys));
    };
    next();
  };
}
