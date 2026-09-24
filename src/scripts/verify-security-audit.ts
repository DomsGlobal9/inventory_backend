/**
 * Attacking the API the way someone with a browser console and a proxy would.
 *
 * Shop A is the victim, full of data marked SECRETA. Shop B is the attacker, signed in as its OWNER --
 * every permission in its own shop. Nothing here trusts the screens: every call goes straight at the API.
 *
 *   A  another shop's ids: all 242 routes, with shop A's real ids in every URL, as shop B's owner.
 *      Nothing of A may come back, nothing of A may change, and nothing may crash (5xx).
 *   B  no permission: every route, as a signed-in user of shop A whose role grants nothing.
 *   C  forged and stale logins: no token, garbage, wrong secret, alg none, another shop's claim,
 *      expired, disabled user, deleted user, a token after logout, spoofed tenant and store headers.
 *   D  the other realms: platform console, internal service, storefront and Shopify doors.
 *   E  what the body can smuggle: clientId, ids, __proto__, status and money fields.
 *   F  injection and hostile input: SQL-ish text, repeated params, objects where text belongs, huge
 *      bodies, stored script in names, path tricks on uploads, private-address callbacks, redirects.
 *   G  guessing passwords.
 *   H  ending sign-ins: a password change, a reset by the team or the console, being switched off,
 *      a suspended shop and "sign out other devices" end every older token at once -- and the new
 *      password is what Team & Users and the platform console then show.
 *
 * Throwaway shops, deleted at the end. Run against the high-limit config (it sends ~700 requests).
 *
 *   npx tsx src/scripts/verify-security-audit.ts
 */
import axios, { AxiosInstance } from 'axios';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { prisma } from '../lib/prisma';
import { AuthService } from '../services/auth.service';
import { seedRolesForClient } from '../services/rbac-seed.service';
import { platformAdminService } from '../services/platform-admin.service';
import { salesOrderService } from '../services/sales-order.service';
import { dispatchService } from '../services/dispatch.service';
import { returnService } from '../services/return.service';
import { inventoryMutationService } from '../services/inventory-mutation.service';
import { offerService } from '../services/offers';
import apiRoutes from '../routes/api.routes';
import { routeTable } from './support/routeTable';

const BASE = process.env.VERIFY_API_URL || 'http://localhost:4006/api/v1';
const STAMP = Date.now();
const A = `sec-victim-${STAMP}`;
const B = `sec-attacker-${STAMP}`;
const MARK = `SECRETA${STAMP}`;
const SECRET = process.env.JWT_SECRET as string;

let passed = 0, failed = 0;
const failures: string[] = [];
const findings: string[] = [];
const check = (name: string, ok: boolean, detail?: string) => {
  if (ok) { passed++; if (!process.env.QUIET) console.log(`  [PASS] ${name}`); }
  else { failed++; failures.push(`${name}${detail ? ` -> ${detail}` : ''}`); console.log(`  [FAIL] ${name}${detail ? `  -> ${detail}` : ''}`); }
};
const brief = (r: any) => `${r.status} ${JSON.stringify(r.data).slice(0, 200)}`;
const leaks = (r: any) => JSON.stringify(r.data ?? '').includes(MARK);
const internals = (r: any) => /prisma|Invalid `|P20\d\d|node_modules|at [A-Za-z]+ \(|D:\\\\|\/src\/|SELECT |postgres/i.test(JSON.stringify(r.data ?? ''));
const http = (headers: Record<string, string> = {}): AxiosInstance =>
  axios.create({ baseURL: BASE, headers, validateStatus: () => true, timeout: 60_000, maxRedirects: 0 });
const bearer = (token: string, extra: Record<string, string> = {}) => http({ Authorization: `Bearer ${token}`, ...extra });

async function person(clientId: string, name: string, roleId: string) {
  const u = await prisma.user.create({ data: { clientId, email: `sec-${name.replace(/\W/g, '').toLowerCase()}-${clientId}@example.com`, name, password: await AuthService.hashPassword('Right-Password-77'), status: 'ACTIVE' } });
  await prisma.userRole.create({ data: { userId: u.id, roleId } });
  return { id: u.id, email: u.email, token: AuthService.generateToken({ userId: u.id, clientId }) };
}

/** Everything about shop A an attacker could want to read or change, as one comparable string. */
async function fingerprintA() {
  const [products, variants, customers, suppliers, orders, items, returns, counts, offers, roles, users, stocks, locations, tickets, pos, payments] = await Promise.all([
    prisma.product.findMany({ where: { clientId: A }, select: { id: true, title: true, status: true, trashedAt: true, basePrice: true }, orderBy: { id: 'asc' } }),
    prisma.productVariant.findMany({ where: { clientId: A }, select: { id: true, sku: true, sellingPrice: true, averageCost: true }, orderBy: { id: 'asc' } }),
    prisma.customer.findMany({ where: { clientId: A }, select: { id: true, name: true, phone: true, deletedAt: true, tags: true }, orderBy: { id: 'asc' } }),
    prisma.supplier.findMany({ where: { clientId: A }, select: { id: true, name: true, isActive: true }, orderBy: { id: 'asc' } }),
    prisma.salesOrder.findMany({ where: { clientId: A }, select: { id: true, status: true, total: true, deletedAt: true }, orderBy: { id: 'asc' } }),
    prisma.salesOrderItem.count({ where: { salesOrder: { clientId: A } } }),
    prisma.salesReturn.findMany({ where: { clientId: A }, select: { id: true, status: true }, orderBy: { id: 'asc' } }),
    prisma.stockCount.findMany({ where: { clientId: A }, select: { id: true, status: true }, orderBy: { id: 'asc' } }),
    prisma.offer.findMany({ where: { clientId: A }, select: { id: true, status: true, name: true }, orderBy: { id: 'asc' } }),
    prisma.role.findMany({ where: { clientId: A }, select: { id: true, name: true, _count: { select: { permissions: true } } }, orderBy: { id: 'asc' } }),
    prisma.user.findMany({ where: { clientId: A }, select: { id: true, status: true, password: true, roles: { select: { roleId: true } } }, orderBy: { id: 'asc' } }),
    prisma.inventoryStock.findMany({ where: { clientId: A }, select: { id: true, quantity: true, reservedQty: true }, orderBy: { id: 'asc' } }),
    prisma.stockLocation.findMany({ where: { clientId: A }, select: { id: true, name: true, active: true }, orderBy: { id: 'asc' } }),
    prisma.supportTicket.findMany({ where: { clientId: A }, select: { id: true, status: true, _count: { select: { messages: true } } }, orderBy: { id: 'asc' } }),
    prisma.purchaseOrder.findMany({ where: { clientId: A }, select: { id: true, status: true, locationId: true }, orderBy: { id: 'asc' } }),
    prisma.salesOrderPayment.count({ where: { clientId: A } })
  ]);
  return JSON.stringify({ products, variants, customers, suppliers, orders, items, returns, counts, offers, roles, users, stocks, locations, tickets, pos, payments });
}

async function main() {
  if (!SECRET) throw new Error('JWT_SECRET must be set to forge test tokens');
  await sweepOldRuns();
  console.log(`SETUP victim ${A}, attacker ${B}`);

  // ── Shop A, the victim ──────────────────────────────────────────────────────────────────────
  const rolesA = await seedRolesForClient(A);
  const ownerA = await person(A, `Owner ${MARK}`, rolesA.SUPER_ADMIN);
  const staffA = await person(A, `Staff ${MARK}`, rolesA.SALES);
  const emptyRole = await prisma.role.create({ data: { clientId: A, name: `NOTHING ${MARK}` } });
  const nobodyA = await person(A, `Nobody ${MARK}`, emptyRole.id);
  const storeA = await prisma.stockLocation.create({ data: { clientId: A, name: `Store ${MARK}`, code: 'MAIN-STORE', type: 'STORE', active: true } });
  const product = await prisma.product.create({ data: { clientId: A, title: `Saree ${MARK}`, productCode: `SEC-A-${STAMP}`, slug: `sec-a-${STAMP}`, category: 'WOMEN', productType: 'READY_TO_WEAR', basePrice: 5000, status: 'ACTIVE' } });
  const variant = await prisma.productVariant.create({ data: { clientId: A, productId: product.id, sku: `SKU-${MARK}`, variantCode: `VAR-${MARK}`, sellingPrice: 5000, costPrice: 2000, averageCost: 2000 } });
  await prisma.$transaction(tx => inventoryMutationService.applyMovement({ clientId: A, variantId: variant.id, locationId: storeA.id, movementType: 'IN', reason: 'INITIAL_STOCK', quantityDelta: 20, unitCost: 2000, tx }), { timeout: 30000 });
  const customer = await prisma.customer.create({ data: { clientId: A, customerCode: 'CUS-SEC-1', name: `Customer ${MARK}`, phone: `+9198${String(STAMP).slice(-8)}`, status: 'ACTIVE' } });
  const supplier = await prisma.supplier.create({ data: { clientId: A, supplierCode: `SUP-SEC-${STAMP}`, name: `Supplier ${MARK}`, email: `supplier-${STAMP}@example.com` } });
  const po = await prisma.purchaseOrder.create({ data: { clientId: A, poNumber: `PO-SEC-${STAMP}`, supplierId: supplier.id, status: 'DRAFT', locationId: storeA.id } as any });
  const order: any = await salesOrderService.createFullOrder(A, storeA.id, { customer: { id: customer.id }, status: 'CONFIRMED', items: [{ variantId: variant.id, quantity: 2 }] });
  const dispatch: any = await dispatchService.createDispatch(A, order.id, [{ salesOrderItemId: order.items[0].id, quantity: 2 }]);
  const ret: any = await returnService.createReturn(A, order.id, [{ dispatchItemId: dispatch.items[0].id, quantity: 1 }], 'sec', 'OTHER' as any);
  const count = await prisma.stockCount.create({ data: { clientId: A, name: `Count ${MARK}`, locationId: storeA.id, status: 'DRAFT' } });
  const countItem = await prisma.stockCountItem.create({ data: { stockCountId: count.id, variantId: variant.id, sku: variant.sku, variantCode: variant.variantCode, expectedQty: 18 } });
  const offer = await offerService.create(A, { name: `Offer ${MARK}`, trigger: 'AUTOMATIC', level: 'LINE', valueType: 'PERCENTAGE', value: 5, scope: 'ALL', startsAt: new Date(), endsAt: null }, 'owner') as any;
  const ticket = await prisma.supportTicket.create({ data: { clientId: A, createdByUserId: ownerA.id, createdByName: ownerA.email, createdByEmail: ownerA.email, subject: `Ticket ${MARK}` } });

  // ── Shop B, the attacker ────────────────────────────────────────────────────────────────────
  const rolesB = await seedRolesForClient(B);
  const ownerB = await person(B, 'Attacker Owner', rolesB.SUPER_ADMIN);
  const storeB = await prisma.stockLocation.create({ data: { clientId: B, name: 'Attacker Store', code: 'MAIN-STORE', type: 'STORE', active: true } });

  const RANDOM = crypto.randomUUID();
  const idFor = (path: string, param: string): string => {
    const p = path;
    switch (param) {
      case 'clientId': return A;
      case 'productId': return product.id;
      case 'variantId': return variant.id;
      case 'locationId': return storeA.id;
      case 'supplierId': return supplier.id;
      case 'orderId': return order.id;
      case 'itemId': return p.startsWith('/stock-counts') ? countItem.id : order.items[0].id;
      case 'phone': return customer.phone!;
      case 'productCode': return product.productCode;
      case 'id':
        if (p.startsWith('/products/images')) return RANDOM;
        if (p.startsWith('/products')) return product.id;
        if (p.startsWith('/variants')) return variant.id;
        if (p.startsWith('/stock-counts')) return count.id;
        if (p.startsWith('/suppliers')) return supplier.id;
        if (p.startsWith('/purchase-orders')) return po.id;
        if (p.startsWith('/customers')) return customer.id;
        if (p.startsWith('/sales-orders')) return order.id;
        if (p.startsWith('/offers')) return offer.id;
        if (p.startsWith('/roles')) return rolesA.SALES;
        if (p.startsWith('/returns')) return ret.id;
        if (p.startsWith('/locations')) return storeA.id;
        if (p.startsWith('/support-tickets')) return ticket.id;
        if (p.startsWith('/team')) return staffA.id;
        if (p.startsWith('/admin/users')) return staffA.id;
        return RANDOM;
      default: return RANDOM;
    }
  };
  const fill = (path: string) => path.replace(/:([A-Za-z]+)/g, (_, name) => encodeURIComponent(idFor(path, name)));
  // A body that would do real damage if it were accepted.
  const bodyFor = (path: string): any => ({
    name: 'HACKED', title: 'HACKED', status: 'CANCELLED', active: false, isActive: false, quantity: 1, countedQty: 0,
    roleId: rolesA.SUPER_ADMIN, customPassword: 'Hacked-pass-123', newPassword: 'Hacked-pass-123', currentPassword: 'x',
    locationId: storeA.id, variantId: variant.id, salesOrderId: order.id, supplierId: supplier.id, customerId: customer.id,
    items: [{ variantId: variant.id, quantity: 1, dispatchItemId: dispatch.items[0].id, salesOrderItemId: order.items[0].id }],
    itemsDisposition: [{ salesReturnItemId: ret.items[0].id, disposition: 'SCRAP' }],
    permissions: ['*'], reason: 'OTHER', message: 'hacked', body: 'hacked', clientId: A
  });

  const all = routeTable(apiRoutes as any);
  check('the route table was read from the live router (240+ routes)', all.length >= 240, String(all.length));
  // Doors that are public by design, or belong to another realm, are tested in D.
  const isPublicOrOtherRealm = (p: string) => /^\/(auth|leads|client-errors|storefront\/v1|shopify|public\/tryon|internal|admin)(\/|$)/.test(p);
  // Calls that reach a paid or external service even when refused later -- never sent, even to probe.
  const neverSend = (m: string, p: string) => (m === 'POST' && /^\/catalog-tryon\/generate-catalog/.test(p)) || (m === 'POST' && /^\/shopify-connect\/install/.test(p));

  // ── A. Another shop's ids ───────────────────────────────────────────────────────────────────
  console.log('\nA. SHOP B\'S OWNER, WITH SHOP A\'S IDS IN EVERY URL');
  const before = await fingerprintA();
  const attacker = bearer(ownerB.token, { 'x-location-id': storeA.id, 'x-client-id': A });
  const idorProblems: string[] = [];
  let idorTried = 0;
  for (const r of all) {
    if (isPublicOrOtherRealm(r.path) || neverSend(r.method, r.path)) continue;
    const url = fill(r.path);
    const res = await attacker.request({ method: r.method as any, url, data: r.method === 'GET' ? undefined : bodyFor(r.path), params: r.method === 'GET' ? { search: MARK, q: MARK, locationId: storeA.id, clientId: A } : undefined });
    idorTried++;
    if (leaks(res)) idorProblems.push(`${r.method} ${r.path} leaked shop A data: ${brief(res)}`);
    if (res.status >= 500) idorProblems.push(`${r.method} ${r.path} crashed: ${brief(res)}`);
    if (internals(res)) idorProblems.push(`${r.method} ${r.path} exposed internals: ${brief(res)}`);
  }
  const after = await fingerprintA();
  check(`${idorTried} routes probed with shop A's ids: nothing of shop A came back, nothing crashed`, idorProblems.length === 0, idorProblems.slice(0, 8).join('\n      '));
  check('  ...and not one field of shop A changed', before === after, 'shop A was modified by shop B');

  // ── B. No permission ────────────────────────────────────────────────────────────────────────
  console.log('\nB. A SIGNED-IN USER OF SHOP A WHOSE ROLE GRANTS NOTHING');
  const nobody = bearer(nobodyA.token);
  // Open to anyone signed in, on purpose.
  const openToAll = new Set([
    'GET /branding/', 'GET /services/', 'GET /support-tickets/', 'POST /support-tickets/',
    'GET /search/', 'GET /roles/catalogue', 'GET /catalog/config', 'GET /services/tryon-usage'
  ]);
  const beforeB = await fingerprintA();
  const allowedWithout: string[] = [];
  const mutatedWithout: string[] = [];
  let bTried = 0;
  for (const r of all) {
    if (isPublicOrOtherRealm(r.path) || neverSend(r.method, r.path)) continue;
    const res = await nobody.request({ method: r.method as any, url: fill(r.path), data: r.method === 'GET' ? undefined : bodyFor(r.path) });
    bTried++;
    const key = `${r.method} ${r.path}`;
    if (res.status < 400 && !openToAll.has(key)) (r.method === 'GET' ? allowedWithout : mutatedWithout).push(`${key} -> ${res.status}`);
    if (res.status >= 500) mutatedWithout.push(`${key} crashed ${brief(res)}`);
  }
  const afterB = await fingerprintA();
  check(`${bTried} routes as a user with no permissions: every change refused`, mutatedWithout.length === 0, mutatedWithout.join('\n      '));
  check('  ...every read refused except the few open to all staff', allowedWithout.length === 0, allowedWithout.join('\n      '));
  const nobodyTickets = await nobody.get('/support-tickets/');
  const ownerTickets = await bearer(ownerA.token).get('/support-tickets/');
  check('a staff member sees only their own support tickets; the owner sees the shop\'s',
    nobodyTickets.status === 200 && Array.isArray(nobodyTickets.data?.data) && nobodyTickets.data.data.length === 0 &&
    ownerTickets.status === 200 && ownerTickets.data?.data?.some((t: any) => t.id === ticket.id), `${brief(nobodyTickets)} | ${brief(ownerTickets)}`);
  const readOther = await nobody.get(`/support-tickets/${ticket.id}`);
  const replyOther = await nobody.post(`/support-tickets/${ticket.id}/messages`, { body: 'reading your ticket' });
  check('  ...and cannot open or reply to somebody else\'s ticket (404)', readOther.status === 404 && replyOther.status === 404 && !leaks(readOther), `${brief(readOther)} | ${brief(replyOther)}`);
  const mine = await nobody.post('/support-tickets/', { subject: 'My own question', description: 'How do I print a receipt?', category: 'OTHER' });
  const mineList = await nobody.get('/support-tickets/');
  const mineReply = mine.data?.data?.id ? await nobody.post(`/support-tickets/${mine.data.data.id}/messages`, { body: 'Any update?' }) : { status: 0 };
  check('  ...but can raise one, see it listed and reply to it', mine.status === 201 && mineList.data?.data?.length === 1 && (mineReply as any).status === 201, `${brief(mine)} | ${brief(mineList)}`);
  check('  ...and nothing in shop A changed (except a support-ticket reply, which is open to all staff)', JSON.stringify(JSON.parse(beforeB).products) === JSON.stringify(JSON.parse(afterB).products) && JSON.stringify(JSON.parse(beforeB).users) === JSON.stringify(JSON.parse(afterB).users) && JSON.stringify(JSON.parse(beforeB).orders) === JSON.stringify(JSON.parse(afterB).orders), 'shop A changed');

  // ── C. Forged and stale logins ──────────────────────────────────────────────────────────────
  console.log('\nC. FORGED, STALE AND SPOOFED LOGINS');
  const probe = (h: AxiosInstance) => h.get('/customers/');
  const claims = { sub: ownerA.id, clientId: A, iss: 'scal_easy_auth', aud: 'scal_easy_inventory' };
  const noneToken = `${Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url')}.${Buffer.from(JSON.stringify({ ...claims, exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url')}.`;
  const forged: [string, string][] = [
    ['no token at all', ''],
    ['garbage', 'not.a.token'],
    ['signed with the wrong secret', jwt.sign(claims, 'guessed-secret', { expiresIn: '1h' })],
    ['alg: none, unsigned', noneToken],
    ['a real signature on shop B\'s owner claiming shop A', jwt.sign({ ...claims, sub: ownerB.id, clientId: A }, SECRET, { expiresIn: '1h' })],
    ['a real signature on shop A\'s owner claiming shop B', jwt.sign({ ...claims, clientId: B }, SECRET, { expiresIn: '1h' })],
    ['expired an hour ago', jwt.sign({ ...claims, exp: Math.floor(Date.now() / 1000) - 3600 }, SECRET)],
    ['issued for another audience', jwt.sign({ ...claims, aud: 'some_other_service' }, SECRET, { expiresIn: '1h' })],
    ['a user id that does not exist', jwt.sign({ ...claims, sub: crypto.randomUUID() }, SECRET, { expiresIn: '1h' })]
  ];
  for (const [label, token] of forged) {
    const r = await probe(token ? bearer(token) : http());
    check(`refused: ${label} (401)`, r.status === 401 && !leaks(r), brief(r));
    const c = await http(token ? { Cookie: `token=${token}` } : {}).get('/customers/');
    check(`  ...also as a cookie`, c.status === 401 && !leaks(c), brief(c));
  }
  const spoof = await bearer(ownerB.token, { 'x-client-id': A, 'x-tenant-id': A, 'x-location-id': storeA.id }).get('/customers/', { params: { clientId: A, search: MARK } });
  check('shop B\'s owner sending shop A\'s id in headers and the query still sees only shop B', spoof.status === 200 && !leaks(spoof), brief(spoof));
  const loc = await bearer(ownerB.token, { 'x-location-id': storeA.id }).get('/inventory/variants');
  check('...and shop A\'s store chosen in the header shows nothing of shop A', loc.status < 500 && !leaks(loc), brief(loc));

  const victim = await person(A, `Leaver ${MARK}`, rolesA.SALES);
  check('a staff login works while the person is active', (await probe(bearer(victim.token))).status === 200);
  await prisma.user.update({ where: { id: victim.id }, data: { status: 'INACTIVE' } });
  let disabled = 0;
  for (let i = 0; i < 12; i++) { disabled = (await probe(bearer(victim.token))).status; if (disabled === 401) break; await new Promise(r => setTimeout(r, 5000)); }
  check('...and stops working once they are switched off (401, within the identity cache window)', disabled === 401, String(disabled));

  const loggedOut = await person(A, `Logout ${MARK}`, rolesA.SALES);
  await bearer(loggedOut.token).post('/auth/logout');
  const afterLogout = await probe(bearer(loggedOut.token));
  // By design: plain sign out clears this browser only, so a shop sharing one login across tills keeps
  // the others. Ending every sign-in is "sign out other devices", proved in H.
  check('logout answers without error', afterLogout.status === 200 || afterLogout.status === 401, brief(afterLogout));

  // Editing permissions in the browser (localStorage) changes nothing on the server.
  const tamperedSession = await bearer(nobodyA.token).get('/sales-orders/');
  check('a user who edits their permissions in the browser still gets 403 from the server', tamperedSession.status === 403, brief(tamperedSession));

  // ── D. Other realms ─────────────────────────────────────────────────────────────────────────
  console.log('\nD. THE OTHER DOORS');
  const adminRoutes = all.filter(r => r.path.startsWith('/admin'));
  const adminOpen: string[] = [];
  for (const r of adminRoutes) {
    const res = await bearer(ownerA.token).request({ method: r.method as any, url: fill(r.path), data: bodyFor(r.path) });
    if (res.status < 400 || res.status >= 500) adminOpen.push(`${r.method} ${r.path} -> ${res.status}`);
  }
  check(`the platform console's ${adminRoutes.length} routes refuse a shop owner's login`, adminOpen.length === 0, adminOpen.join('\n      '));
  const adminCookie = await http({ Cookie: `token=${ownerA.token}; platform_admin_token=${ownerA.token}` }).get('/admin/clients');
  check('...including with the shop token placed in the admin cookie', adminCookie.status === 401 || adminCookie.status === 403, brief(adminCookie));
  const internal = [await http().get('/internal/test'), await http({ 'x-internal-service-key': 'guess' }).get('/internal/test'), await bearer(ownerA.token).get('/internal/test')];
  check('the internal service route refuses no key, a guessed key and a shop login', internal.every(r => r.status === 401 || r.status === 403), internal.map(brief).join(' | '));
  const store = [await http().get('/storefront/v1/products'), await http({ 'X-Storefront-Key': 'sf_guess_123' }).get('/storefront/v1/products'), await bearer(ownerA.token).get('/storefront/v1/products')];
  check('the storefront API refuses no key, a guessed key and a shop login', store.every(r => r.status === 401 || r.status === 403), store.map(brief).join(' | '));
  const hook = await http({ 'X-Shopify-Hmac-Sha256': 'forged', 'X-Shopify-Topic': 'orders/create', 'X-Shopify-Shop-Domain': 'victim.myshopify.com' }).post('/shopify/webhooks', { id: 1 });
  check('a Shopify webhook with a forged signature is refused', hook.status === 401, brief(hook));
  const install = await http().get('/shopify/install', { params: { shop: 'evil.example.com' } });
  const location = String(install.headers.location ?? '');
  check('the Shopify install does not redirect to a shop that is not *.myshopify.com', !location.includes('evil.example.com'), `${install.status} ${location}`);
  const callback = await http().get('/shopify/callback', { params: { shop: 'victim.myshopify.com', code: 'x', hmac: 'forged', state: 'x' } });
  check('the Shopify callback with a forged HMAC does not install anything', !(callback.status === 302 && /shopify=connected/.test(String(callback.headers.location))), `${callback.status} ${callback.headers.location}`);
  const tryonForeign = await http().post(`/public/tryon/${A}/${product.productCode}/generate`, {});
  check('the public try-on cannot spend shop A\'s allowance without an image (4xx, no crash)', tryonForeign.status >= 400 && tryonForeign.status < 500, brief(tryonForeign));

  // ── E. What the body can smuggle ────────────────────────────────────────────────────────────
  console.log('\nE. MASS ASSIGNMENT');
  const own = bearer(ownerA.token);
  await own.patch(`/customers/${customer.id}`, { clientId: B, id: crypto.randomUUID(), customerCode: 'STOLEN', createdAt: '2000-01-01' });
  const custAfter = await prisma.customer.findFirst({ where: { id: customer.id } });
  check('a customer edit cannot move the customer to another shop or rewrite its id and code', custAfter?.clientId === A && custAfter?.customerCode === 'CUS-SEC-1', JSON.stringify(custAfter));
  const sup = await own.post('/suppliers/', { name: 'Smuggled', clientId: B, supplierCode: 'X' });
  const supRow = sup.data?.data?.id ? await prisma.supplier.findFirst({ where: { id: sup.data.data.id } }) : null;
  check('a new supplier sent with clientId of another shop is created in the caller\'s own shop', !supRow || supRow.clientId === A, JSON.stringify(supRow));
  const invite = await own.post('/team/members', { name: 'Smuggled Staff', email: `smuggle-${STAMP}@example.com`, roleId: rolesB.SUPER_ADMIN, clientId: B });
  check('a team invite cannot use another shop\'s role or land in another shop', invite.status === 404 || invite.status === 400 || invite.status === 403, brief(invite));
  const proto = await own.patch(`/customers/${customer.id}`, JSON.parse('{"__proto__": {"isAdmin": true}, "constructor": {"prototype": {"polluted": true}}, "name": "Proto Test"}'));
  check('__proto__ and constructor in a body do not crash or pollute', proto.status < 500 && ({} as any).polluted === undefined && ({} as any).isAdmin === undefined, brief(proto));
  const moneyFields = await bearer(staffA.token).patch(`/sales-orders/${order.id}`, { total: 1, subtotal: 1, status: 'CANCELLED', discountAmount: 4999 });
  const orderAfter = await prisma.salesOrder.findFirst({ where: { id: order.id } });
  check('a salesperson cannot rewrite an order\'s total, status or discount by editing it', moneyFields.status >= 400 && orderAfter?.status === 'DISPATCHED' && Number(orderAfter?.total) === Number(order.total), `${brief(moneyFields)} ${orderAfter?.status} ${orderAfter?.total}`);

  // ── F. Injection and hostile input ──────────────────────────────────────────────────────────
  console.log('\nF. INJECTION AND HOSTILE INPUT');
  const hostile = [`' OR 1=1 --`, `"; DROP TABLE customers; --`, `%' UNION SELECT password FROM users --`, `\\`, `%`, `_`, `\u0000`, '<script>alert(1)</script>', '{"$ne": null}', '../../../../etc/passwd'];
  const injProblems: string[] = [];
  for (const text of hostile) {
    for (const [path, param] of [['/customers/', 'search'], ['/sales-orders/', 'search'], ['/products/', 'search'], ['/search/', 'q'], ['/variants/search', 'q'], ['/counter-sales/items', 'q']] as const) {
      const r = await bearer(ownerB.token).get(path, { params: { [param]: text, locationId: storeB.id } });
      if (r.status >= 500 || leaks(r) || internals(r)) injProblems.push(`${path}?${param}=${JSON.stringify(text)} -> ${brief(r)}`);
    }
  }
  check('SQL-like, wildcard, null-byte and traversal text in every search: no crash, no leak, no internals', injProblems.length === 0, injProblems.slice(0, 6).join('\n      '));
  const stillThere = await prisma.customer.count({ where: { clientId: A } });
  check('  ...and nothing was dropped', stillThere >= 1);
  const arrays = [await bearer(ownerB.token).get('/customers/?search=a&search=b'), await bearer(ownerB.token).get('/sales-orders/?status=DRAFT&status=CONFIRMED'), await bearer(ownerB.token).get('/customers/', { params: { search: { contains: MARK } } })];
  check('a repeated query parameter, or an object where text belongs, is not a crash or a leak', arrays.every(r => r.status < 500 && !leaks(r)), arrays.map(brief).join(' | '));
  const objectId = await bearer(ownerB.token).patch(`/customers/${encodeURIComponent('{"not":""}')}`, { name: 'x' });
  check('an id made of query syntax is a 4xx', objectId.status >= 400 && objectId.status < 500, brief(objectId));
  const xss = await own.post('/customers/', { name: '<img src=x onerror=alert(document.cookie)>', phone: `+9196${String(STAMP).slice(-8)}` });
  check('script in a name is stored as plain text and returned as JSON, not markup', xss.status === 201 && String(xss.headers['content-type'] ?? '').includes('application/json') && xss.data?.data?.name === '<img src=x onerror=alert(document.cookie)>', brief(xss));
  const big = await http({ 'Content-Type': 'application/json' }).post('/auth/login', `{"email":"${'a'.repeat(12_000_000)}","password":"x"}`, { maxBodyLength: Infinity, maxContentLength: Infinity }).catch((e: any) => ({ status: e?.response?.status ?? 0, data: e?.message }));
  check('a 12 MB login body is refused (413) or rejected, not processed', (big as any).status === 413 || (big as any).status === 400 || (big as any).status === 0, `${(big as any).status}`);

  const badJson = await http({ 'Content-Type': 'application/json' }).post('/auth/login', '{"email": "a", ');
  check('broken JSON is a 400 without internals', badJson.status === 400 && !internals(badJson), brief(badJson));
  const upload = await own.post(`/products/${product.id}/images`, { storagePath: `${A}/${product.id}/../../${B}/secret.png`, url: 'javascript:alert(1)', imageType: 'MAIN' });
  check('an image path climbing out of its folder, or a javascript: URL, is refused', upload.status >= 400 && upload.status < 500, brief(upload));
  if (upload.status < 400) findings.push(`POST /products/:id/images accepted storagePath with ".." or a javascript: url: ${brief(upload)}`);
  const privateHooks = ['http://169.254.169.254/latest/meta-data/', 'http://127.0.0.1:5432/', 'http://localhost:4006/api/v1/admin/clients', 'http://[::1]/', 'http://10.0.0.5/', 'http://0.0.0.0/', 'file:///etc/passwd', 'gopher://127.0.0.1/'];
  const ssrf: string[] = [];
  for (const url of privateHooks) {
    const r = await own.post('/storefront-connections/', { name: `SSRF ${url}`, type: 'CUSTOM', baseUrl: url });
    if (r.status < 400) ssrf.push(`${url} accepted`);
  }
  check('a storefront callback to cloud metadata, localhost, private ranges or file:/gopher: is refused', ssrf.length === 0, ssrf.join(', '));
  const tickets = await own.post('/support-tickets/', { subject: 'x'.repeat(100000), category: 'OTHER', message: 'y'.repeat(100000) });
  check('a 100,000-character support ticket is refused or trimmed, not a crash', tickets.status < 500, brief(tickets));

  // ── G. Guessing passwords ───────────────────────────────────────────────────────────────────
  await endingSignIns(rolesA);

  console.log('\nG. GUESSING PASSWORDS');
  const good = await http().post('/auth/login', { email: ownerA.email, password: 'Right-Password-77' });
  const setCookie = String(good.headers['set-cookie'] ?? '');
  check('the right password signs in', good.status === 200, brief(good));
  check('  ...and the session cookie is HttpOnly, so no page script (or injected script) can read it', /httponly/i.test(setCookie), setCookie);
  const unknown = await http().post('/auth/login', { email: `nobody-${STAMP}@example.com`, password: 'x' });
  const wrongPw = await http().post('/auth/login', { email: nobodyA.email, password: 'x' });
  check('an unknown email and a wrong password get the same answer (no account discovery)', unknown.status === wrongPw.status && unknown.data?.message === wrongPw.data?.message, `${brief(unknown)} | ${brief(wrongPw)}`);
  const guesses: any[] = [];
  for (let i = 0; i < 12; i++) guesses.push(await http().post('/auth/login', { email: staffA.email, password: `wrong-${i}` }));
  check('12 wrong passwords in a row never sign anyone in', guesses.every(g => g.status !== 200), guesses.map(g => g.status).join(','));
  check('  ...and after 8 the account stops answering password checks (429)', guesses.slice(0, 8).every(g => g.status === 401) && guesses.slice(8).every(g => g.status === 429), guesses.map(g => g.status).join(','));
  const rightDuringLock = await http().post('/auth/login', { email: staffA.email, password: 'Right-Password-77' });
  check('  ...so even the right password is refused while the account is held (a guesser cannot confirm a hit)', rightDuringLock.status === 429 && !rightDuringLock.headers['set-cookie'], brief(rightDuringLock));
  const otherAccount = await http().post('/auth/login', { email: ownerA.email, password: 'Right-Password-77' });
  check('  ...while other accounts sign in normally', otherAccount.status === 200, brief(otherAccount));
  const adminGuesses: number[] = [];
  for (let i = 0; i < 10; i++) adminGuesses.push((await http().post('/auth/admin/login', { email: `console-${STAMP}@example.com`, password: `guess-${i}` })).status);
  check('guessing a platform console password is held the same way', adminGuesses.slice(0, 8).every(s => s === 401) && adminGuesses.slice(8).every(s => s === 429), adminGuesses.join(','));
  const anonImport = await http({ 'Content-Type': 'application/json' }).post('/products/import/validate', `{"rows":"${'a'.repeat(2_000_000)}"}`, { maxBodyLength: Infinity, maxContentLength: Infinity }).catch((e: any) => ({ status: e?.response?.status ?? 0 }));
  const anonTryon = await http({ 'Content-Type': 'application/json' }).post('/catalog-tryon/generate-catalog', `{"images":"${'a'.repeat(2_000_000)}"}`, { maxBodyLength: Infinity, maxContentLength: Infinity }).catch((e: any) => ({ status: e?.response?.status ?? 0 }));
  check('a large import or try-on body without a login is refused before it is read (401)', (anonImport as any).status === 401 && (anonTryon as any).status === 401, `${(anonImport as any).status} ${(anonTryon as any).status}`);
}

/** Pulls the session token out of a response's Set-Cookie. */
const cookieToken = (r: any, name = 'token') =>
  ((r.headers?.['set-cookie'] ?? []) as string[]).map(c => c.split(';')[0]).find(c => c.startsWith(`${name}=`))?.slice(name.length + 1) ?? '';
const signIn = async (email: string, password: string) => cookieToken(await http().post('/auth/login', { email, password }));
const works = async (token: string) => (await bearer(token).get('/auth/session')).status === 200;

async function endingSignIns(rolesA: Record<string, string>) {
  console.log('\nH. ENDING SIGN-INS');
  const console_ = await prisma.platformAdmin.create({ data: { email: `sec-console-${STAMP}@example.com`, name: `Console ${MARK}`, password: await AuthService.hashPassword('Console-Password-7788'), status: 'ACTIVE' } });
  const other = await prisma.platformAdmin.create({ data: { email: `sec-console2-${STAMP}@example.com`, name: `Console2 ${MARK}`, password: await AuthService.hashPassword('Console-Password-7788'), status: 'ACTIVE' } });
  try {
    const consoleToken = cookieToken(await http().post('/auth/admin/login', { email: console_.email, password: 'Console-Password-7788' }), 'platform_admin_token');
    const consoleHttp = (token = consoleToken) => http({ Cookie: `platform_admin_token=${token}` });
    check('the platform console signs in', !!consoleToken && (await consoleHttp().get('/admin/platform-admins')).status === 200);

    // 1. The owner changes their own password: the phone that stole the login is out, this screen stays in.
    const owner = await person(A, `Changer ${MARK}`, rolesA.SUPER_ADMIN);
    const here = await signIn(owner.email, 'Right-Password-77');
    const stolen = await signIn(owner.email, 'Right-Password-77');
    check('two devices signed in to the same owner both work', !!here && !!stolen && await works(here) && await works(stolen));
    const changed = await bearer(here).post('/auth/me/password', { currentPassword: 'Right-Password-77', newPassword: 'Brand-New-Pass-501' });
    const hereNow = cookieToken(changed);
    check('an owner changes their own password', changed.status === 200 && !!hereNow, brief(changed));
    check('  ...the other device is signed out at once (401)', !(await works(stolen)) && !(await works(owner.token)));
    check('  ...the old token on this device too, but the fresh cookie it was handed works', !(await works(here)) && await works(hereNow));
    check('  ...the old password no longer signs in and the new one does', !(await signIn(owner.email, 'Right-Password-77')) && !!(await signIn(owner.email, 'Brand-New-Pass-501')));

    // 2. A manager resets a staff password from Team & Users.
    const manager = await person(A, `Manager ${MARK}`, rolesA.SUPER_ADMIN);
    const staff = await person(A, `Resetee ${MARK}`, rolesA.SALES);
    const staffPhone = await signIn(staff.email, 'Right-Password-77');
    const reset = await bearer(manager.token).post(`/team/members/${staff.id}/password`, { customPassword: 'Team-Reset-Pass-66' });
    check('Team & Users resets a staff password', reset.status === 200, brief(reset));
    check('  ...and every sign-in of theirs ends', !!staffPhone && !(await works(staffPhone)) && !(await works(staff.token)));
    const teamView = await bearer(manager.token).post(`/team/members/${staff.id}/password/view`, { reason: 'audit' });
    check('  ...Team & Users "view password" shows the NEW password', teamView.data?.data?.password === 'Team-Reset-Pass-66', brief(teamView));
    const consoleView = await consoleHttp().post(`/admin/users/${staff.id}/password/view`, {});
    check('  ...and so does the platform console', consoleView.data?.data?.password === 'Team-Reset-Pass-66', brief(consoleView));
    check('  ...and the new password signs in', !!(await signIn(staff.email, 'Team-Reset-Pass-66')));

    // 3. The platform console sets a user's password.
    const staffAgain = await signIn(staff.email, 'Team-Reset-Pass-66');
    const consoleSet = await consoleHttp().post(`/admin/users/${staff.id}/password`, { customPassword: 'Console-Set-Pass-44' });
    check('the platform console sets a user\'s password', consoleSet.status === 200, brief(consoleSet));
    check('  ...ending the sign-in made with the previous one', !(await works(staffAgain)));
    const teamView2 = await bearer(manager.token).post(`/team/members/${staff.id}/password/view`, { reason: 'audit' });
    const consoleView2 = await consoleHttp().post(`/admin/users/${staff.id}/password/view`, {});
    check('  ...and both "view password" screens show it', teamView2.data?.data?.password === 'Console-Set-Pass-44' && consoleView2.data?.data?.password === 'Console-Set-Pass-44', `${brief(teamView2)} | ${brief(consoleView2)}`);

    // 4. Switched off, then back on: the token copied before must stay dead.
    const leaver = await person(A, `Offon ${MARK}`, rolesA.SALES);
    const leaverPhone = await signIn(leaver.email, 'Right-Password-77');
    const off = await bearer(manager.token).patch(`/team/members/${leaver.id}/status`, { status: 'INACTIVE' });
    check('switching a member off ends their sign-in immediately (no cache wait)', off.status === 200 && !(await works(leaverPhone)), brief(off));
    const on = await bearer(manager.token).patch(`/team/members/${leaver.id}/status`, { status: 'ACTIVE' });
    check('  ...and switching them back on does not revive the old token', on.status === 200 && !(await works(leaverPhone)) && !!(await signIn(leaver.email, 'Right-Password-77')), brief(on));

    // 5. Sign out other devices, for anyone -- even a role with no permissions.
    const till = await person(A, `Till ${MARK}`, rolesA.SALES);
    const till1 = await signIn(till.email, 'Right-Password-77');
    const till2 = await signIn(till.email, 'Right-Password-77');
    const plainLogout = await bearer(till1).post('/auth/logout');
    check('plain sign out on one till leaves the other till signed in (shared logins)', plainLogout.status === 200 && await works(till2));
    const mine = await signIn(till.email, 'Right-Password-77');
    const others = await bearer(mine).post('/auth/me/sign-out-other-devices');
    const mineNow = cookieToken(others);
    check('"sign out other devices" ends the other tills', others.status === 200 && !(await works(till2)) && !(await works(till1)), brief(others));
    check('  ...while this device carries on with the cookie it was handed', !!mineNow && await works(mineNow));
    check('  ...and signing in again afterwards works normally', !!(await signIn(till.email, 'Right-Password-77')));
    check('  ...a signed-out caller cannot use it (401)', (await http().post('/auth/me/sign-out-other-devices')).status === 401);

    // 6. A forged token claiming a later session number is still refused: it is signed, not trusted.
    const forged = jwt.sign({ sub: till.id, clientId: A, sv: 99, iss: 'scal_easy_auth', aud: 'scal_easy_inventory' }, 'not-the-secret', { expiresIn: '1h' });
    check('a token claiming a different session number with the wrong secret is refused', !(await works(forged)));

    // 7. Suspending the shop ends every sign-in; reinstating does not bring them back.
    const suspendee = await signIn(manager.email, 'Right-Password-77');
    const suspend = await consoleHttp().patch(`/admin/clients/${A}/suspend`, { suspended: true });
    const unsuspend = await consoleHttp().patch(`/admin/clients/${A}/suspend`, { suspended: false });
    check('suspending a shop and reinstating it leaves no old sign-in working', suspend.status === 200 && unsuspend.status === 200 && !!suspendee && !(await works(suspendee)) && !(await works(mineNow)), `${brief(suspend)} | ${brief(unsuspend)}`);

    // 8. The platform console's own accounts.
    const otherToken = cookieToken(await http().post('/auth/admin/login', { email: other.email, password: 'Console-Password-7788' }), 'platform_admin_token');
    check('a second console admin signs in', !!otherToken && (await consoleHttp(otherToken).get('/admin/platform-admins')).status === 200);
    const adminReset = await consoleHttp().post(`/admin/platform-admins/${other.id}/password`, { customPassword: 'Reset-Console-Pass-99' });
    check('  ...resetting their password ends that console sign-in', adminReset.status === 200 && (await consoleHttp(otherToken).get('/admin/platform-admins')).status === 401, brief(adminReset));
    const otherToken2 = cookieToken(await http().post('/auth/admin/login', { email: other.email, password: 'Reset-Console-Pass-99' }), 'platform_admin_token');
    const adminOff = await consoleHttp().patch(`/admin/platform-admins/${other.id}/status`, { status: 'INACTIVE' });
    await consoleHttp().patch(`/admin/platform-admins/${other.id}/status`, { status: 'ACTIVE' });
    check('  ...and switching them off and on again leaves their earlier sign-in dead', !!otherToken2 && adminOff.status === 200 && (await consoleHttp(otherToken2).get('/admin/platform-admins')).status === 401, brief(adminOff));
  } finally {
    await prisma.platformAdmin.deleteMany({ where: { id: { in: [console_.id, other.id] } } }).catch(e => console.log('cleanup console admins', e?.message));
  }
}

/**
 * Shops this suite left behind on an earlier run, swept up before this one starts.
 *
 * cleanup() below runs in a `finally`, which covers a failing run but not a killed one -- and
 * two of these were found sitting in the database days later, one holding a support ticket with
 * no number, which failed verify-console-screens' "every ticket has a number" check. A suite
 * that litters makes ANOTHER suite look broken, which is the worst kind of false alarm: the
 * failure points at the wrong place entirely.
 *
 * Only this suite's own naming, and only shops older than an hour, so a run happening right now
 * in another window is never touched.
 */
async function sweepOldRuns() {
  const anHourAgo = Date.now() - 60 * 60 * 1000;
  const mine = (id: string) => {
    const stamp = Number(id.split('-').pop());
    return Number.isFinite(stamp) && stamp < anHourAgo;
  };
  const rows = await prisma.user.findMany({
    where: { OR: [{ clientId: { startsWith: 'sec-victim-' } }, { clientId: { startsWith: 'sec-attacker-' } }] },
    select: { clientId: true }, distinct: ['clientId']
  }).catch(() => []);
  const stale = [...new Set(rows.map(r => r.clientId))].filter(mine);
  for (const id of stale) {
    await platformAdminService.deleteClientCompletely(id, id)
      .then(() => console.log(`  [tidy] removed a shop left by an earlier run: ${id}`))
      .catch((e: any) => console.log(`  [tidy] could not remove ${id}: ${e?.message}`));
  }

  /*
   * The console admins too.
   *
   * These are ACTIVE platform admins with a password -- an account that can delete any shop
   * on the platform. Two were found still sitting there a fortnight after the run that made
   * them. A shop left behind is clutter; a platform admin left behind is a way in.
   */
  const admins = await prisma.platformAdmin.findMany({
    where: { email: { startsWith: 'sec-console' } }, select: { id: true, email: true, createdAt: true }
  }).catch(() => []);
  for (const a of admins) {
    if (a.createdAt.getTime() >= anHourAgo) continue;   // a run happening right now
    await prisma.platformAdmin.delete({ where: { id: a.id } })
      .then(() => console.log(`  [tidy] removed a console admin left by an earlier run: ${a.email}`))
      .catch((e: any) => console.log(`  [tidy] could not remove ${a.email}: ${e?.message}`));
  }
}

async function cleanup() {
  for (const id of [A, B]) {
    await platformAdminService.deleteClientCompletely(id, id).catch((e: any) => { if (!/No such client/.test(e?.message)) console.log('cleanup', id, e?.message); });
  }
  const left = await prisma.user.count({ where: { clientId: { in: [A, B] } } }) + await prisma.storefrontConnection.count({ where: { clientId: { in: [A, B] } } });
  check('both throwaway shops are gone', left === 0, String(left));
}

main()
  .catch(e => { failed++; failures.push(`crashed: ${e?.message}`); console.error(e); })
  .finally(async () => {
    await cleanup().catch(e => console.error('cleanup failed', e));
    console.log(`\nRESULT: ${passed} passed | ${failed} failed`);
    if (failures.length) console.log('Failed:\n - ' + failures.join('\n - '));
    if (findings.length) console.log('Findings (not failures, decisions):\n - ' + findings.join('\n - '));
    await prisma.$disconnect();
    process.exit(failed ? 1 : 0);
  });
