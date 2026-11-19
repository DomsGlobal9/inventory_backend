import type { RequestHandler, Router } from 'express';

/**
 * Inventory as a service (19 Nov 2026, the owner: "every feature should be a service through APIs, so in future
 * any other module can use it"). The door is /api/v1/service/<area>/...; this file is its ONE published list.
 *
 * Each entry is a route the Inventory app itself serves, reached through the SAME router, so a module gets
 * exactly what the app gets: the same checks, the same words, the same records. The list does three jobs, so it
 * can never disagree with itself:
 *   - only the routes listed here can be reached through the door (anything else: 404 naming the menu);
 *   - each route's permission, checked again at the door;
 *   - the menu, GET /api/v1/service/openapi.json, written from this list.
 *
 * Read only for now: the app's write paths record a real member of staff as the one who did it, and a module is
 * not one. Writes for a module are added area by area, each with its own suite, never by widening this blindly.
 */
export type DoorRoute = {
  method: 'GET';
  /** Inside the area, Express style: /:id is one path segment. */
  path: string;
  /** The Inventory permission a module's pass must hold (the same key the app checks). */
  scope: string;
  summary: string;
  /** Query parameters worth knowing (documentation only; the app's route reads them). */
  query?: Record<string, string>;
};

export type DoorArea = {
  /** /api/v1/service/<at>/... */
  at: string;
  title: string;
  routes: DoorRoute[];
  /** The router the app uses for this area, and anything the app puts in front of it (hiding cost prices). */
  load: () => { router: Router; before?: RequestHandler[] };
};

const get = (path: string, scope: string, summary: string, query?: Record<string, string>): DoorRoute => ({ method: 'GET', path, scope, summary, query });

export const AREAS: DoorArea[] = [
  {
    at: '/customers', title: 'Customers',
    routes: [
      get('/', 'customer:view', 'The shop\'s customers, a page at a time.', { page: 'page number (from 1)', limit: 'up to 100', search: 'name, phone or code', group: 'a customer group' }),
      get('/by-phone/:phone', 'customer:view', 'The customer with this phone number, or null.'),
      get('/:id', 'customer:view', 'One customer.'),
      get('/:id/past-purchases', 'customer:view', 'What they bought before the shop came to ScaleEzy (read only).')
    ],
    load: () => ({ router: require('../../routes/customer.routes').default, before: [costHidden()] })
  },
  {
    at: '/loyalty', title: 'Loyalty points',
    routes: [
      get('/settings', 'customer:view', 'The shop\'s points rules.'),
      get('/customers/:id', 'customer:view', 'One customer\'s points and their history.')
    ],
    load: () => ({ router: require('../../routes/loyalty.routes').default })
  },
  {
    at: '/products', title: 'Products',
    routes: [
      get('/', 'product:view', 'The shop\'s products, a page at a time.', { page: 'page number', limit: 'page size', search: 'title or code', status: 'ACTIVE, DRAFT, ...' }),
      get('/:id', 'product:view', 'One product.'),
      get('/:productId/variants', 'product:view', 'A product\'s colours and sizes.'),
      get('/:productId/images', 'product:view', 'A product\'s photos.')
    ],
    load: () => ({ router: require('../../routes/product.routes').default, before: [costHidden()] })
  },
  {
    at: '/variants', title: 'Variants',
    routes: [get('/search', 'product:view', 'Find colours and sizes by name, code or SKU.', { q: 'what to look for' })],
    load: () => ({ router: require('../../routes/variant.routes').default, before: [costHidden()] })
  },
  {
    at: '/stock', title: 'Stock',
    routes: [
      get('/variants', 'inventory:view', 'Stock on hand for each colour and size (a store with the x-location-id header).'),
      get('/metadata', 'inventory:view', 'The lists the stock screens filter by.')
    ],
    load: () => ({ router: require('../../routes/inventory.routes').default, before: [costHidden()] })
  },
  {
    at: '/locations', title: 'Stores and warehouses',
    routes: [get('/', 'inventory:view', 'The shop\'s stores, warehouses and online locations.')],
    load: () => ({ router: require('../../routes/location.routes').default })
  }
];

function costHidden(): RequestHandler {
  // The app hides cost prices from anyone without cost:view; a module never has it through the door.
  return require('../../middleware/cost-visibility.middleware').hideCostUnlessPermitted();
}

/** Every permission the door can grant, from the list above. */
export const DOOR_SCOPES = [...new Set(AREAS.flatMap(a => a.routes.map(r => r.scope)))].sort();

/**
 * The route this request is for, or null: matched by method and path. An id parameter must look like an id (a
 * uuid) -- otherwise "/customers/card" would match "/:id" and reach a route of the app's router that is NOT on the
 * list. A :phone is any one segment (the app's route says if it is not a number).
 */
const ID = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';
export function matchRoute(area: DoorArea, method: string, path: string): DoorRoute | null {
  const p = path === '' ? '/' : path.length > 1 ? path.replace(/\/+$/, '') : path;
  for (const r of area.routes) {
    if (r.method !== method) continue;
    if (r.path === '/') { if (p === '/') return r; continue; }
    const re = new RegExp('^' + r.path.replace(/:([A-Za-z]+)/g, (_m, name) => (name === 'phone' ? '[^/]+' : ID)) + '$');
    if (re.test(p)) return r;
  }
  return null;
}
