/**
 * The permission catalogue: what can be done in this product, and what each thing implies.
 *
 * This is the contract. Every module that talks to Inventory — POS, Shopify, Accounts — asks
 * the same question of it, and the answer must not depend on which caller is asking:
 *
 *     Does this identity have permission to do this, for this client?
 *
 * Three rules the shape of this file exists to enforce.
 *
 * **The platform owns this list.** A shop composes roles from it and cannot add to it, because
 * a permission is a promise the server keeps, and a shop inventing one would be inventing a
 * promise nothing enforces.
 *
 * **Implication lives here, not in role definitions.** `report:financial` implies `cost:view`.
 * If that were expressed by remembering to tick both boxes, the day somebody forgot would be
 * the day a financial report rendered with its numbers stripped — or worse, the day a role
 * granted the money without the means to read it. Stated once, closed automatically, provable.
 *
 * **A label nobody can write is a key that should not exist.** Every entry carries the sentence
 * a shopkeeper would read. Writing them is how three of the findings in PERMISSION_AUDIT.md
 * were noticed.
 */

export type PermissionGroup =
  | 'Products'
  | 'Stock'
  | 'Buying'
  | 'Selling'
  | 'Money'
  | 'The shop';

export type PermissionDef = {
  /** The key used in code and stored against a role. */
  key: string;
  group: PermissionGroup;
  /** What a shopkeeper reads on the roles screen. */
  label: string;
  /**
   * Permissions this one cannot be useful without, granted automatically with it.
   *
   * Not a convenience. Granting "receive stock" without "see stock" produces a person who can
   * change a number they cannot read, and the screen they land on is empty.
   */
  implies?: string[];
  /**
   * True when holding this necessarily exposes what the business paid.
   *
   * A purchase order with the prices taken out is not a purchase order, so these imply
   * `cost:view` rather than being redacted. Recorded explicitly because it is the question
   * asked of every new route that touches money.
   */
  exposesCost?: boolean;
  /** Flagged for the roles screen. Held by few, and worth a second thought before granting. */
  sensitive?: boolean;
  /**
   * Enforced on the response, not on the route.
   *
   * `cost:view` does not decide whether a request reaches a handler -- it decides whether the
   * cost numbers survive in what comes back. So it will never appear in a `requirePermission`
   * call, and the check that every key guards something has to know that. Stated here so the
   * reason lives with the key instead of as an exception in a test.
   */
  fieldLevel?: boolean;
};

export const PERMISSIONS: readonly PermissionDef[] = [
  // ── Products ──────────────────────────────────────────────────────────────
  { key: 'product:view',   group: 'Products', label: 'See products and their sizes and colours' },
  { key: 'product:create', group: 'Products', label: 'Add new products',                 implies: ['product:view'] },
  { key: 'product:update', group: 'Products', label: 'Change product details and selling prices', implies: ['product:view'] },
  { key: 'product:delete', group: 'Products', label: 'Trash, archive and delete products', implies: ['product:view'], sensitive: true },

  // ── Stock ─────────────────────────────────────────────────────────────────
  { key: 'inventory:view',     group: 'Stock', label: 'See stock levels and what has moved' },
  { key: 'inventory:receive',  group: 'Stock', label: 'Bring stock in by hand',        implies: ['inventory:view'] },
  { key: 'inventory:adjust',   group: 'Stock', label: 'Correct stock counts',          implies: ['inventory:view'] },
  { key: 'inventory:transfer', group: 'Stock', label: 'Move stock between your shops', implies: ['inventory:view'] },

  { key: 'stock_count:view',     group: 'Stock', label: 'See stock counts',                      implies: ['inventory:view'] },
  { key: 'stock_count:create',   group: 'Stock', label: 'Start a stock count',                   implies: ['stock_count:view'] },
  { key: 'stock_count:update',   group: 'Stock', label: 'Enter counted quantities',              implies: ['stock_count:view'] },
  { key: 'stock_count:complete', group: 'Stock', label: 'Finish a count and post its corrections', implies: ['stock_count:update'] },

  // ── Buying ────────────────────────────────────────────────────────────────
  // A purchase order IS what you pay. There is nothing left of one with the prices removed,
  // so these carry cost rather than hiding it.
  { key: 'purchase_order:view',    group: 'Buying', label: 'See purchase orders',                   exposesCost: true },
  { key: 'purchase_order:create',  group: 'Buying', label: 'Raise a purchase order',                implies: ['purchase_order:view'] },
  { key: 'purchase_order:update',  group: 'Buying', label: 'Change an order, and send it to the supplier', implies: ['purchase_order:view'] },
  { key: 'purchase_order:receive', group: 'Buying', label: 'Receive goods against an order',        implies: ['purchase_order:view', 'inventory:view'] },

  { key: 'supplier:view',   group: 'Buying', label: 'See suppliers and what they supply', exposesCost: true },
  { key: 'supplier:create', group: 'Buying', label: 'Add a supplier',                     implies: ['supplier:view'] },
  { key: 'supplier:update', group: 'Buying', label: 'Change a supplier and its agreed prices', implies: ['supplier:view'] },
  { key: 'supplier:delete', group: 'Buying', label: 'Remove a supplier',                  implies: ['supplier:view'], sensitive: true },

  // ── Selling ───────────────────────────────────────────────────────────────
  { key: 'sales_order:view',    group: 'Selling', label: 'See orders' },
  { key: 'sales_order:create',  group: 'Selling', label: 'Take an order',                       implies: ['sales_order:view', 'product:view'] },
  { key: 'sales_order:update',  group: 'Selling', label: "Change an order's lines",             implies: ['sales_order:view'] },
  { key: 'sales_order:confirm', group: 'Selling', label: 'Confirm an order and hold its stock', implies: ['sales_order:view'] },
  { key: 'sales_order:cancel',  group: 'Selling', label: 'Cancel an order and release its stock', implies: ['sales_order:view'] },

  // There is no dispatch:view. Dispatches have no read endpoint -- one is created, and then
  // seen through its sales order -- so the key would guard nothing while looking like it did.
  // If a dispatch list is ever built, add it back then and gate that route with it.
  { key: 'dispatch:create', group: 'Selling', label: 'Send goods out against an order', implies: ['sales_order:view'] },

  { key: 'return:view',     group: 'Selling', label: 'See returns' },
  { key: 'return:create',   group: 'Selling', label: 'Log a return',                          implies: ['return:view'] },
  { key: 'return:receive',  group: 'Selling', label: 'Mark a return as arrived',              implies: ['return:view'] },
  { key: 'return:inspect',  group: 'Selling', label: 'Decide whether a return goes back on the shelf', implies: ['return:view'] },
  { key: 'return:complete', group: 'Selling', label: 'Finish a return and put the stock back', implies: ['return:inspect'] },

  { key: 'customer:view',   group: 'Selling', label: 'See customers' },
  { key: 'customer:create', group: 'Selling', label: 'Add a customer',    implies: ['customer:view'] },
  { key: 'customer:update', group: 'Selling', label: 'Change a customer', implies: ['customer:view'] },

  // ── Money ─────────────────────────────────────────────────────────────────
  // The split that makes the rest of this meaningful. Before it, dashboard:view carried the
  // shop's whole financial position and every seeded role held it, including SALES.
  { key: 'cost:view',   group: 'Money', label: 'See what the business paid for its stock',
    fieldLevel: true, sensitive: true },
  { key: 'cost:manage', group: 'Money', label: 'Set and restate what stock cost',
    implies: ['cost:view', 'inventory:view'], sensitive: true },

  { key: 'report:view',      group: 'Money', label: 'See operational reports — movement, ageing, low stock' },
  { key: 'report:financial', group: 'Money', label: 'See money reports — stock value, profit, supplier spend',
    implies: ['report:view', 'cost:view'], exposesCost: true, sensitive: true },

  // ── The shop ──────────────────────────────────────────────────────────────
  { key: 'dashboard:view', group: 'The shop', label: 'See the dashboard' },

  // Metered, and therefore spends the shop's money. Independent of adding a product, which is
  // what it used to be bundled with. Whether the CLIENT may spend it at all is a separate
  // question -- see the note on entitlement at the bottom of this file.
  { key: 'tryon:generate', group: 'The shop', label: 'Generate try-on images (uses the shop’s allowance)' },

  { key: 'admin:users',     group: 'The shop', label: 'Manage the team and their roles', sensitive: true },
  { key: 'admin:locations', group: 'The shop', label: 'Add and change shops and warehouses' },
  { key: 'admin:catalog',   group: 'The shop', label: 'Manage sizes, colours and categories', implies: ['product:view'] },

  // Reading a colleague's password in plain text. Its own key, never implied by managing the
  // team, and every use is recorded -- see team.routes.
  { key: 'team:view_password', group: 'The shop', label: "Read a team member's password", sensitive: true }
];

/**
 * Total access, as a permission rather than as a role name.
 *
 * This deliberately is NOT in PERMISSIONS. Everything in that list is a box on the roles
 * screen, and "everything, forever" must not be a box a merchant can tick -- a shop that wants
 * a second full administrator composes one from the catalogue, which leaves a record of what
 * they granted. The wildcard belongs to the account owner and is issued once, when the client
 * is created.
 *
 * It exists at all because the alternative was worse. Authority used to be decided by the
 * string 'SUPER_ADMIN' appearing in a user's role names, which meant the stored permissions of
 * those roles were never read, drifted for months without anyone noticing, and any role that
 * came to be named SUPER_ADMIN by any path held everything.
 */
export const WILDCARD_PERMISSION = '*';
export const WILDCARD_LABEL = 'Everything (account owner)';

/**
 * Role names that were the account owner's authority before the '*' grant existed.
 *
 * TRANSITIONAL. Delete this, and holdsEverything's second half, once every database has run
 * 20260909210000_split_money_permissions -- after which every owner holds '*' as a row.
 *
 * It exists because the alternative is a deployment that only works if the data changed first.
 * Removing the name check and adding the grant in one step meant a server pointed at a database
 * that had not migrated yet refused every account owner on the platform, which is exactly what
 * happened: an owner opening the dashboard was told she did not have permission to see it.
 * Code and data cannot be required to change in the same instant -- a rollback, a failed
 * migration or a developer's local server will always put them out of step.
 *
 * So: accept both signals, migrate, then remove this. During the window the exposure is
 * identical to what shipped for months, and it ends when the migration runs.
 */
export const LEGACY_OWNER_ROLE_NAMES: readonly string[] = ['SUPER_ADMIN'];

let warnedAboutLegacyOwner = false;

/**
 * Whether this identity is the account owner, and may do anything.
 *
 * The answer is the '*' grant. The role name is accepted only until the migration that issues
 * that grant has run everywhere -- and says so, loudly, once per process, so the window is
 * visible rather than permanent.
 */
export function holdsEverything(
  permissions: readonly string[] = [],
  roleNames: readonly string[] = []
): boolean {
  if (permissions.includes(WILDCARD_PERMISSION)) return true;

  const legacy = roleNames.some(name => LEGACY_OWNER_ROLE_NAMES.includes(name));
  if (legacy && !warnedAboutLegacyOwner) {
    warnedAboutLegacyOwner = true;
    console.warn(
      '[permissions] An account owner was authorised by ROLE NAME because their role does not ' +
      "hold the '*' grant. This database has not run 20260909210000_split_money_permissions. " +
      'Apply it: npx prisma migrate deploy'
    );
  }
  return legacy;
}

/** Fast lookup, built once. */
const BY_KEY = new Map(PERMISSIONS.map(p => [p.key, p]));

export const ALL_PERMISSION_KEYS: readonly string[] = PERMISSIONS.map(p => p.key);

export function getPermission(key: string): PermissionDef | undefined {
  return BY_KEY.get(key);
}

/**
 * Everything a set of grants actually confers, following `implies` all the way down.
 *
 * The closure is transitive and cycle-safe: `report:financial` implies `report:view` and
 * `cost:view`; `cost:manage` implies `cost:view` too, and a role holding both resolves once.
 *
 * This is the single place implication happens. A role stores what was ticked; every check
 * asks this what that means. Storing the expansion instead would freeze it — the day a new
 * implication is added, every existing role would still hold yesterday's answer.
 */
export function expandPermissions(granted: readonly string[]): Set<string> {
  const out = new Set<string>();
  const stack = [...granted];

  while (stack.length) {
    const key = stack.pop()!;
    if (out.has(key)) continue;
    out.add(key);
    const def = BY_KEY.get(key);
    if (def?.implies) stack.push(...def.implies);
  }
  return out;
}

/** Whether a set of grants satisfies one requirement, implications included. */
export function grants(granted: readonly string[], required: string): boolean {
  // The wildcard is SUPER_ADMIN's, and it is deliberately not expressible from the roles
  // screen -- see rbac-seed.
  if (granted.includes('*')) return true;
  return expandPermissions(granted).has(required);
}

/** The catalogue as the roles screen wants it: grouped, in the order defined above. */
export function catalogueByGroup(): { group: PermissionGroup; permissions: PermissionDef[] }[] {
  const order: PermissionGroup[] = ['Products', 'Stock', 'Buying', 'Selling', 'Money', 'The shop'];
  return order
    .map(group => ({ group, permissions: PERMISSIONS.filter(p => p.group === group) }))
    .filter(g => g.permissions.length > 0);
}

/**
 * Permission is not entitlement.
 *
 * `tryon:generate` answers "may this person do it". Whether the SHOP may — whether it has
 * allowance left this month, whether the service is switched on for them at all — is a
 * different question with a different answer, checked separately in the try-on usage service.
 *
 * Keeping them apart matters: a shop out of allowance has not lost a permission, and a person
 * without the permission is not out of allowance. Conflating them would make one look like the
 * other in the error the user reads, and in the fix an admin reaches for.
 */
