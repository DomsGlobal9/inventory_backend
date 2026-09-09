/**
 * Starting points, not fixed roles.
 *
 * A shop that has to compose a role from 44 checkboxes on its first day will either grant too
 * much (tick everything, it works) or too little (tick nothing, then grant one key at a time as
 * people complain). Both end somewhere bad. A template gives them a sensible shape they can
 * then change -- which is the point: these are copied into an ordinary editable role, never
 * referenced afterwards, so a shop is never stuck with our idea of what a job involves.
 *
 * Deliberately not the same list as the seeded roles. Those exist for a new tenant to have
 * something working on day one; these are the jobs merchants actually describe.
 */
export type RoleTemplate = {
  key: string;
  name: string;
  /** What this person does, in the words a shopkeeper would use. */
  description: string;
  /** Only what was deliberately chosen -- implied keys are added by the server. */
  permissions: string[];
};

export const ROLE_TEMPLATES: readonly RoleTemplate[] = [
  {
    key: 'shop_floor',
    name: 'Shop floor',
    description: 'Sells to customers. Cannot see what the shop paid or what it makes.',
    permissions: [
      'sales_order:create', 'sales_order:update', 'sales_order:confirm',
      'customer:create', 'customer:update',
      'product:view', 'inventory:view', 'dashboard:view'
    ]
  },
  {
    key: 'stock_room',
    name: 'Stock room',
    description: 'Receives, counts and moves stock. Sees quantities, not money.',
    permissions: [
      'inventory:receive', 'inventory:transfer', 'purchase_order:receive',
      'stock_count:create', 'stock_count:update', 'stock_count:complete',
      'return:create', 'return:receive', 'return:inspect', 'return:complete',
      'dispatch:create', 'product:view', 'dashboard:view', 'report:view'
    ]
  },
  {
    key: 'buyer',
    name: 'Buyer',
    description: 'Orders from suppliers and decides what things cost. Sees the money.',
    permissions: [
      'purchase_order:create', 'purchase_order:update', 'purchase_order:receive',
      'supplier:create', 'supplier:update',
      'product:create', 'product:update',
      'inventory:receive', 'inventory:adjust',
      'cost:manage', 'report:financial', 'dashboard:view'
    ]
  },
  {
    key: 'manager',
    name: 'Manager',
    description: 'Runs the shop day to day, including the team. Everything except owner-only settings.',
    permissions: [
      'sales_order:create', 'sales_order:update', 'sales_order:confirm', 'sales_order:cancel',
      'dispatch:create', 'customer:create', 'customer:update',
      'return:create', 'return:receive', 'return:inspect', 'return:complete',
      'inventory:receive', 'inventory:adjust', 'inventory:transfer',
      'product:create', 'product:update',
      'supplier:create', 'supplier:update',
      'purchase_order:create', 'purchase_order:update', 'purchase_order:receive',
      'stock_count:create', 'stock_count:update', 'stock_count:complete',
      'cost:manage', 'report:financial', 'dashboard:view', 'tryon:generate',
      'admin:locations', 'admin:catalog', 'admin:users'
    ]
  },
  {
    key: 'accounts',
    name: 'Accounts',
    description: 'Reads the numbers. Cannot move stock or change prices.',
    permissions: [
      'report:financial', 'dashboard:view',
      'sales_order:view', 'purchase_order:view', 'supplier:view', 'customer:view', 'inventory:view'
    ]
  },
  {
    key: 'read_only',
    name: 'Look, don’t touch',
    description: 'Sees stock and orders. Changes nothing, and sees no money.',
    permissions: ['product:view', 'inventory:view', 'sales_order:view', 'customer:view', 'dashboard:view']
  }
];

export function getTemplate(key: string): RoleTemplate | undefined {
  return ROLE_TEMPLATES.find(t => t.key === key);
}
