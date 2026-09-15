/**
 * Shopify's privacy webhooks, end to end: signed, recorded, and doing what they say.
 *
 *   A  the signature still guards the route, and a redelivered request is recorded once
 *   B  a customer asks what is held: recorded with counts only, exported by the merchant with
 *      everything we hold, and refused to anyone who may not read customers
 *   C  a customer asks to be erased: their record, the copies on their orders and the webhook
 *      bodies lose the person; orders, money and other customers are untouched; a customer the
 *      shop also knows outside Shopify is kept
 *   D  a store asks to be erased: refused while the app is installed again; after uninstall that
 *      store's customers, order copies, parked bodies and installation go -- the other store's stay
 *   E  an unclaimed store, a request that failed part-way, and orders arriving with their store
 *
 * Fixtures on demo-client under two made-up store domains, all removed at the end. Nothing is
 * created with stock held: fixture orders are drafts, and the ingested order is unpaid.
 *
 * Needs the API on :4006 started with the same SHOPIFY_API_SECRET this script signs with
 * (default 'verify-local-secret'); the local .env leaves it empty, which makes the route 503.
 *
 *   npx tsx src/scripts/verify-shopify-privacy.ts
 */
import crypto from 'crypto';
import axios, { AxiosInstance } from 'axios';
import { prisma } from '../lib/prisma';
import { AuthService } from '../services/auth.service';
import { shopifyOrderIngestService, mapShopifyOrder } from '../services/shopify-orders';
import { shopifyPrivacyService, scrubShopifyPayload, ERASED_NAME } from '../services/shopify-privacy';

const BASE = process.env.VERIFY_API_URL || 'http://localhost:4006/api/v1';
const SECRET = process.env.SHOPIFY_API_SECRET || 'verify-local-secret';
const CLIENT = 'demo-client';

let passed = 0, failed = 0;
const failures: string[] = [];
const check = (name: string, ok: boolean, detail?: string) => {
  if (ok) { passed++; console.log(`  [PASS] ${name}`); }
  else { failed++; failures.push(name); console.log(`  [FAIL] ${name}${detail ? `  -> ${detail}` : ''}`); }
};
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const un = (r: any) => (r?.data?.data !== undefined ? r.data.data : r?.data);
const brief = (r: any) => `${r.status} ${JSON.stringify(r.data).slice(0, 200)}`;
/** Postgres keeps JSONB keys in its own order, so compare what the summary says, not how it is spelled. */
const sameCounts = (actual: unknown, expected: Record<string, number>) =>
  !!actual && typeof actual === 'object'
  && Object.keys(actual as object).length === Object.keys(expected).length
  && Object.entries(expected).every(([k, v]) => (actual as any)[k] === v);

const STAMP = Date.now();
const SHOP_A = `privacy-a-${STAMP}.myshopify.com`;
const SHOP_B = `privacy-b-${STAMP}.myshopify.com`;
const SHOP_U = `privacy-unclaimed-${STAMP}.myshopify.com`;
const SHOPS = [SHOP_A, SHOP_B, SHOP_U];
const ID = (n: number) => String(STAMP * 10 + n);   // Shopify-looking ids unique to this run

const created = {
  customers: [] as string[], orders: [] as string[], users: [] as string[], roles: [] as string[],
  installations: [] as string[]
};

// ── Webhooks, signed the way Shopify signs them ─────────────────────────────────────────────

let webhookSeq = 0;
async function webhook(topic: string, shop: string, body: any, opts: { id?: string; badSignature?: boolean } = {}) {
  const raw = JSON.stringify(body);
  const hmac = crypto.createHmac('sha256', opts.badSignature ? 'wrong-secret' : SECRET).update(raw).digest('base64');
  const id = opts.id ?? `privacy-verify-${STAMP}-${++webhookSeq}`;
  const res = await axios.post(`${BASE}/shopify/webhooks`, raw, {
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Hmac-Sha256': hmac,
      'X-Shopify-Topic': topic,
      'X-Shopify-Webhook-Id': id,
      'X-Shopify-Shop-Domain': shop
    },
    validateStatus: () => true
  });
  return { res, id };
}

/** The route answers before it works, so wait for the request row to settle. */
async function settled(webhookId: string, topic: string) {
  for (let i = 0; i < 40; i++) {
    const row = await prisma.shopifyPrivacyRequest.findUnique({
      where: { uq_privacy_request_webhook: { webhookId, topic } }
    });
    if (row && row.status !== 'RECEIVED') return row;
    await sleep(250);
  }
  return prisma.shopifyPrivacyRequest.findUnique({ where: { uq_privacy_request_webhook: { webhookId, topic } } });
}

const login = (userId: string): AxiosInstance => axios.create({
  baseURL: BASE,
  headers: { Authorization: `Bearer ${AuthService.generateToken({ userId, clientId: CLIENT })}` },
  validateStatus: () => true
});

// ── Fixtures ────────────────────────────────────────────────────────────────────────────────

let variantId = '';
let locationId = '';
let seq = 0;

async function customer(data: Record<string, any>) {
  const c = await prisma.customer.create({
    data: { clientId: CLIENT, customerCode: `CUS-PRIV-${STAMP}-${++seq}`, status: 'ACTIVE', ...data } as any
  });
  created.customers.push(c.id);
  return c;
}

async function order(customerId: string, data: Record<string, any>) {
  const o = await prisma.salesOrder.create({
    data: {
      clientId: CLIENT, orderNumber: `SO-PRIV-${STAMP}-${++seq}`, customerId, locationId,
      status: 'DRAFT', subtotal: 1200, total: 1200,
      items: { create: [{ variantId, quantity: 1, listUnitPrice: 1200, unitPrice: 1200, unitCost: 500, totalPrice: 1200 }] },
      ...data
    } as any
  });
  created.orders.push(o.id);
  return o;
}

const shopifyBody = (orderId: string, customerId: string, extra: any = {}) => ({
  id: Number(orderId),
  name: `#${orderId.slice(-4)}`,
  currency: 'INR',
  financial_status: 'pending',
  total_price: '1200.00',
  email: `buyer-${customerId}@example.com`,
  phone: '+919812345678',
  customer: { id: Number(customerId), first_name: 'Meera', last_name: 'Shah', email: `buyer-${customerId}@example.com`, phone: '+919812345678' },
  billing_address: { name: 'Meera Shah', address1: '12 MG Road', city: 'Pune', phone: '+919812345678' },
  shipping_address: { name: 'Meera Shah', address1: '12 MG Road', city: 'Pune', phone: '+919812345678' },
  client_details: { browser_ip: '203.0.113.9', user_agent: 'Mozilla' },
  note: 'Please gift wrap for Meera',
  line_items: [{ id: 1, variant_id: 555, quantity: 1, price: '1200.00', name: 'Silk saree', discount_allocations: [] }],
  discount_applications: [],
  ...extra
});

const PII = /Meera|12 MG Road|9812345678|buyer-|203\.0\.113\.9|gift wrap/;

async function main() {
  // The route has to be up and signing with our secret, or every result below is meaningless.
  const probe = await webhook('verify/ping', SHOP_A, { ping: true });
  if (probe.res.status !== 200) {
    console.log(`API not ready for signed webhooks (${probe.res.status}). Start it with SHOPIFY_API_SECRET=${SECRET}.`);
    process.exitCode = 1;
    return;
  }

  const variant = await prisma.productVariant.findFirstOrThrow({ where: { clientId: CLIENT }, orderBy: { createdAt: 'asc' } });
  variantId = variant.id;
  locationId = (await prisma.stockLocation.findFirstOrThrow({ where: { clientId: CLIENT, code: 'MAIN-STORE' } })).id;

  const instA = await prisma.shopifyInstallation.create({ data: { shopDomain: SHOP_A, clientId: CLIENT, accessTokenEncrypted: 'x', scopes: 'read_orders' } });
  const instB = await prisma.shopifyInstallation.create({ data: { shopDomain: SHOP_B, clientId: CLIENT, accessTokenEncrypted: 'x', scopes: 'read_orders' } });
  const instU = await prisma.shopifyInstallation.create({ data: { shopDomain: SHOP_U, clientId: null, accessTokenEncrypted: 'x', scopes: 'read_orders' } });
  created.installations.push(instA.id, instB.id, instU.id);
  await prisma.shopifyLocationMap.create({ data: { installationId: instA.id, clientId: CLIENT, locationId, shopifyLocationId: ID(90) } });

  // Store A: Meera, a Shopify customer with two orders.
  const X = ID(1);
  const meera = await customer({
    externalCustomerId: `shopify:${X}`, sourceStore: SHOP_A, name: 'Meera Shah', email: `buyer-${X}@example.com`,
    phone: '+919812345678', billingAddress: '12 MG Road, Pune', shippingAddress: '12 MG Road, Pune',
    notes: 'Likes silk', tags: ['VIP'], companyName: 'Shah Textiles', gstNumber: '27ABCDE1234F1Z5'
  });
  const snapshot = { customerName: 'Meera Shah', customerPhone: '+919812345678', billingAddress: '12 MG Road, Pune', shippingAddress: '12 MG Road, Pune' };
  const o1 = await order(meera.id, { sourceSystem: 'SHOPIFY', sourceStore: SHOP_A, externalOrderId: ID(11), ...snapshot });
  const o2 = await order(meera.id, { sourceSystem: 'SHOPIFY', sourceStore: SHOP_A, externalOrderId: ID(12), ...snapshot });

  // A record store A made from an email alone, for an order in the same request.
  const byEmail = await customer({ sourceStore: SHOP_A, name: 'Meera S', email: `buyer-${X}@example.com`, phone: '+919812345678' });
  const o3 = await order(byEmail.id, { sourceSystem: 'SHOPIFY', sourceStore: SHOP_A, externalOrderId: ID(13), ...snapshot });

  // A customer the shop knew at the till, whose email a Shopify order matched.
  const tillCustomer = await customer({ name: 'Meera at the till', email: `till-${STAMP}@example.com`, phone: '9876501234' });
  const o4 = await order(tillCustomer.id, { sourceSystem: 'SHOPIFY', sourceStore: SHOP_A, externalOrderId: ID(14), ...snapshot });
  const tillSale = await order(tillCustomer.id, { channel: 'POS', customerName: 'Meera at the till', customerPhone: '9876501234' });

  // Somebody else on store A, and somebody on store B.
  const Y = ID(2);
  const other = await customer({ externalCustomerId: `shopify:${Y}`, sourceStore: SHOP_A, name: 'Ravi Kumar', email: `ravi-${STAMP}@example.com`, phone: '+919700000001' });
  const oY = await order(other.id, { sourceSystem: 'SHOPIFY', sourceStore: SHOP_A, externalOrderId: ID(21), customerName: 'Ravi Kumar', customerPhone: '+919700000001' });
  const Z = ID(3);
  const storeB = await customer({ externalCustomerId: `shopify:${Z}`, sourceStore: SHOP_B, name: 'Anita B', email: `anita-${STAMP}@example.com`, phone: '+919700000002' });
  const oZ = await order(storeB.id, { sourceSystem: 'SHOPIFY', sourceStore: SHOP_B, externalOrderId: ID(31), customerName: 'Anita B', customerPhone: '+919700000002' });

  // Parked bodies: one of the requested orders, one of Meera's NOT named in the request, Ravi's, store B's.
  const inbox = async (shop: string, orderId: string, customerId: string, client: string | null = CLIENT) =>
    prisma.shopifyOrderInbox.create({
      data: { shopDomain: shop, clientId: client, shopifyOrderId: orderId, topic: 'orders/create', payload: shopifyBody(orderId, customerId), reason: 'UNMAPPED_VARIANT' }
    });
  const parked1 = await inbox(SHOP_A, ID(11), X);
  const parkedUnlisted = await inbox(SHOP_A, ID(15), X);
  const parkedRavi = await inbox(SHOP_A, ID(21), Y);
  const parkedB = await inbox(SHOP_B, ID(31), Z);

  // ── A. THE DOOR ───────────────────────────────────────────────────────────────────────────
  console.log('\nA. THE SIGNATURE STILL GUARDS THE ROUTE');

  const forged = await webhook('customers/redact', SHOP_A, { customer: { id: Number(X) }, orders_to_redact: [] }, { badSignature: true });
  check('a request signed with the wrong secret is refused with 401', forged.res.status === 401, brief(forged.res));
  await sleep(500);
  check('  ...and nothing is recorded or erased for it',
    (await prisma.shopifyPrivacyRequest.count({ where: { webhookId: forged.id } })) === 0
    && (await prisma.customer.findUniqueOrThrow({ where: { id: meera.id } })).name === 'Meera Shah');

  const unsigned = await axios.post(`${BASE}/shopify/webhooks`, '{}', {
    headers: { 'Content-Type': 'application/json', 'X-Shopify-Topic': 'shop/redact', 'X-Shopify-Webhook-Id': `nosig-${STAMP}`, 'X-Shopify-Shop-Domain': SHOP_A },
    validateStatus: () => true
  });
  check('a request with no signature at all is refused with 401', unsigned.status === 401, brief(unsigned));

  // ── B. A DATA REQUEST ─────────────────────────────────────────────────────────────────────
  console.log('\nB. A CUSTOMER ASKS WHAT IS HELD');

  const dataBody = { shop_domain: SHOP_A, customer: { id: Number(X), email: `buyer-${X}@example.com`, phone: '+919812345678' }, orders_requested: [Number(ID(11))], data_request: { id: 4242 } };
  const dr = await webhook('customers/data_request', SHOP_A, dataBody);
  check('a signed data request is acknowledged', dr.res.status === 200, brief(dr.res));
  const drRow = await settled(dr.id, 'customers/data_request');
  check('it is recorded against the workspace, waiting for the merchant', drRow?.clientId === CLIENT && drRow?.status === 'WAITING_FOR_MERCHANT', JSON.stringify(drRow));
  check('  ...with Shopify\'s request id and the orders asked about', drRow?.shopifyRequestId === '4242' && drRow?.shopifyOrderIds.join() === ID(11) && drRow?.shopifyCustomerId === X);
  check('  ...counting Meera\'s record, both her orders, and both bodies naming her',
    sameCounts(drRow?.summary, { customers: 1, orders: 2, shopifyMessages: 2 }), JSON.stringify(drRow?.summary));
  check('the request row holds no personal data', !PII.test(JSON.stringify(drRow)), JSON.stringify(drRow));

  const again = await webhook('customers/data_request', SHOP_A, dataBody, { id: dr.id });
  await sleep(800);
  check('Shopify sending the same request twice is acknowledged and recorded once',
    again.res.status === 200 && (await prisma.shopifyPrivacyRequest.count({ where: { webhookId: dr.id } })) === 1, brief(again.res));

  // People: an ADMIN, and someone who manages the Shopify connection but may not read customers.
  const adminRole = await prisma.role.findFirstOrThrow({ where: { clientId: CLIENT, name: 'ADMIN' } });
  const admin = await prisma.user.create({ data: { clientId: CLIENT, email: `privacy-admin-${STAMP}@example.com`, name: 'Privacy admin', password: 'unused', status: 'ACTIVE' } });
  created.users.push(admin.id);
  await prisma.userRole.create({ data: { userId: admin.id, roleId: adminRole.id } });
  const narrowRole = await prisma.role.create({ data: { clientId: CLIENT, name: `PRIVACY-VERIFY-${STAMP}` } });
  created.roles.push(narrowRole.id);
  const locPerm = await prisma.permission.findUniqueOrThrow({ where: { key: 'admin:locations' } });
  await prisma.rolePermission.create({ data: { roleId: narrowRole.id, permissionId: locPerm.id } });
  const narrow = await prisma.user.create({ data: { clientId: CLIENT, email: `privacy-narrow-${STAMP}@example.com`, name: 'Connection only', password: 'unused', status: 'ACTIVE' } });
  created.users.push(narrow.id);
  await prisma.userRole.create({ data: { userId: narrow.id, roleId: narrowRole.id } });
  const adminApi = login(admin.id);
  const narrowApi = login(narrow.id);

  const list = await adminApi.get('/shopify-connect/privacy-requests');
  const listed = (un(list) ?? []).find((r: any) => r.id === drRow?.id);
  check('the merchant sees the request in their list', list.status === 200 && !!listed && listed.canExport === true, brief(list));
  check('  ...and the list itself carries no personal data', !PII.test(JSON.stringify(un(list))));

  const narrowExport = await narrowApi.get(`/shopify-connect/privacy-requests/${drRow?.id}/export`);
  check('someone who may manage the store but not read customers cannot export it (403)', narrowExport.status === 403, brief(narrowExport));
  const narrowList = await narrowApi.get('/shopify-connect/privacy-requests');
  check('  ...though they can see that a request exists', narrowList.status === 200, brief(narrowList));

  const exp = await adminApi.get(`/shopify-connect/privacy-requests/${drRow?.id}/export`);
  const data = un(exp);
  check('the admin exports it', exp.status === 200, brief(exp));
  check('  ...with Meera\'s own record, in full', data?.customers?.length === 1 && data.customers[0].email === `buyer-${X}@example.com`
    && data.customers[0].phone === '+919812345678' && data.customers[0].gstNumber === '27ABCDE1234F1Z5', JSON.stringify(data?.customers));
  check('  ...both of her orders with what was on them', data?.orders?.length === 2
    && data.orders.every((o: any) => o.nameOnOrder === 'Meera Shah' && o.items.length === 1 && o.total === 1200), JSON.stringify(data?.orders)?.slice(0, 300));
  check('  ...and the personal parts of the two bodies we kept, not the whole order', data?.shopifyMessagesHeld?.length === 2
    && data.shopifyMessagesHeld.every((m: any) => m.personalDetails.customer && !('line_items' in m.personalDetails)), JSON.stringify(data?.shopifyMessagesHeld)?.slice(0, 300));
  check('  ...and nobody else: not Ravi, not store B, not the till customer',
    !/Ravi|Anita|at the till/.test(JSON.stringify(data)));
  const afterExport = await prisma.shopifyPrivacyRequest.findUniqueOrThrow({ where: { id: drRow!.id } });
  check('exporting marks it done and records who did it', afterExport.status === 'COMPLETED' && afterExport.exportedBy === admin.id && !!afterExport.exportedAt);
  check('the file names who holds the data in words a customer understands, never our workspace id',
    !!data?.about?.heldBy && data.about.heldBy !== CLIENT, String(data?.about?.heldBy));

  const nothing = await webhook('customers/data_request', SHOP_A, { customer: { id: Number(ID(99)) }, orders_requested: [] });
  const nothingRow = await settled(nothing.id, 'customers/data_request');
  check('a request about someone we hold nothing on is closed straight away, saying so',
    nothingRow?.status === 'COMPLETED' && /Nothing is held/.test(nothingRow?.detail ?? ''), JSON.stringify(nothingRow));

  // ── C. A CUSTOMER IS ERASED ───────────────────────────────────────────────────────────────
  console.log('\nC. A CUSTOMER ASKS TO BE ERASED');

  const redactBody = { shop_domain: SHOP_A, customer: { id: Number(X), email: `buyer-${X}@example.com` }, orders_to_redact: [ID(11), ID(12), ID(13), ID(14)].map(Number) };
  const before = await prisma.salesOrder.findUniqueOrThrow({ where: { id: o1.id }, include: { items: true } });
  const rd = await webhook('customers/redact', SHOP_A, redactBody);
  const rdRow = await settled(rd.id, 'customers/redact');
  check('the erase is acknowledged and completed', rd.res.status === 200 && rdRow?.status === 'COMPLETED', `${brief(rd.res)} ${JSON.stringify(rdRow)}`);
  check('  ...saying what it did', sameCounts(rdRow?.summary, { customersErased: 2, customersKept: 1, ordersCleared: 4, shopifyMessagesCleared: 2 }), JSON.stringify(rdRow?.summary));

  const m = await prisma.customer.findUniqueOrThrow({ where: { id: meera.id } });
  check('Meera\'s record has nobody left in it', m.name === ERASED_NAME && m.email === null && m.phone === null && m.billingAddress === null
    && m.shippingAddress === null && m.notes === null && m.companyName === null && m.gstNumber === null && m.tags.length === 0, JSON.stringify(m));
  check('  ...but keeps its number and Shopify id, so her orders still point somewhere and a repeat finds it',
    m.customerCode === meera.customerCode && m.externalCustomerId === `shopify:${X}`);
  const e = await prisma.customer.findUniqueOrThrow({ where: { id: byEmail.id } });
  check('the record store A made from her email alone is erased too', e.name === ERASED_NAME && e.email === null && e.phone === null);
  const t = await prisma.customer.findUniqueOrThrow({ where: { id: tillCustomer.id } });
  check('the customer the shop knows at the till is kept as they were', t.name === 'Meera at the till' && t.phone === '9876501234');

  const cleared = await prisma.salesOrder.findMany({ where: { id: { in: [o1.id, o2.id, o3.id, o4.id] } } });
  check('the copies on all four Shopify orders are cleared', cleared.every(o => !o.customerName && !o.customerPhone && !o.billingAddress && !o.shippingAddress), JSON.stringify(cleared.map(o => o.customerName)));
  const afterO1 = await prisma.salesOrder.findUniqueOrThrow({ where: { id: o1.id }, include: { items: true } });
  check('  ...and nothing else on them moved: status, total, lines, customer link',
    afterO1.status === before.status && Number(afterO1.total) === Number(before.total) && afterO1.customerId === before.customerId
    && afterO1.items.length === before.items.length && Number(afterO1.items[0].totalPrice) === Number(before.items[0].totalPrice));
  check('the till sale on the kept customer still shows who bought it',
    (await prisma.salesOrder.findUniqueOrThrow({ where: { id: tillSale.id } })).customerName === 'Meera at the till');

  const p1 = await prisma.shopifyOrderInbox.findUniqueOrThrow({ where: { id: parked1.id } });
  const pU = await prisma.shopifyOrderInbox.findUniqueOrThrow({ where: { id: parkedUnlisted.id } });
  check('the parked body for a requested order has no person left in it', !PII.test(JSON.stringify(p1.payload)), JSON.stringify(p1.payload).slice(0, 300));
  check('  ...nor does one naming her that the request did not list', !PII.test(JSON.stringify(pU.payload)));
  check('  ...but what a replay needs is still there', (p1.payload as any).id === Number(ID(11)) && (p1.payload as any).line_items?.length === 1
    && (p1.payload as any).name === `#${ID(11).slice(-4)}` && p1.resolvedAt === null);
  const replayable = mapShopifyOrder(p1.payload as any, { locationId, currency: 'INR', variants: new Map([['555', { variantId, averageCostMinor: 0, sku: 'x' }]]) });
  check('  ...and it still maps to an order, now with no identity (the guest)', replayable.ok && replayable.order.customer.isGuest === true, JSON.stringify(replayable).slice(0, 200));

  check('Ravi on the same store is untouched: record, order and parked body',
    (await prisma.customer.findUniqueOrThrow({ where: { id: other.id } })).name === 'Ravi Kumar'
    && (await prisma.salesOrder.findUniqueOrThrow({ where: { id: oY.id } })).customerName === 'Ravi Kumar'
    && PII.test(JSON.stringify((await prisma.shopifyOrderInbox.findUniqueOrThrow({ where: { id: parkedRavi.id } })).payload)));

  const rd2 = await webhook('customers/redact', SHOP_A, redactBody);
  const rd2Row = await settled(rd2.id, 'customers/redact');
  check('the same erase arriving again under a new id finishes cleanly and changes nothing more',
    rd2Row?.status === 'COMPLETED' && (await prisma.customer.findUniqueOrThrow({ where: { id: tillCustomer.id } })).name === 'Meera at the till', JSON.stringify(rd2Row));

  // ── D. A STORE IS ERASED ──────────────────────────────────────────────────────────────────
  console.log('\nD. A STORE IS ERASED');

  const early = await webhook('shop/redact', SHOP_A, { shop_domain: SHOP_A });
  const earlyRow = await settled(early.id, 'shop/redact');
  check('while the app is installed on the store, nothing is erased and the request says why',
    earlyRow?.status === 'SKIPPED' && /installed on this store again/.test(earlyRow?.detail ?? ''), JSON.stringify(earlyRow));
  check('  ...Ravi, his parked body and the installation are all still there',
    (await prisma.customer.findUniqueOrThrow({ where: { id: other.id } })).name === 'Ravi Kumar'
    && !!(await prisma.shopifyOrderInbox.findUnique({ where: { id: parkedRavi.id } }))
    && !!(await prisma.shopifyInstallation.findUnique({ where: { shopDomain: SHOP_A } })));

  await prisma.shopifyInstallation.update({ where: { id: instA.id }, data: { uninstalledAt: new Date() } });
  const shopGone = await webhook('shop/redact', SHOP_A, { shop_domain: SHOP_A });
  const goneRow = await settled(shopGone.id, 'shop/redact');
  check('48 hours after uninstall, the store is erased', goneRow?.status === 'COMPLETED' && goneRow?.clientId === CLIENT, JSON.stringify(goneRow));
  const r = await prisma.customer.findUniqueOrThrow({ where: { id: other.id } });
  check('  ...every customer that store sent is erased', r.name === ERASED_NAME && r.email === null && r.phone === null);
  check('  ...every order copy from it is cleared', !(await prisma.salesOrder.findUniqueOrThrow({ where: { id: oY.id } })).customerName);
  check('  ...its parked bodies are gone', (await prisma.shopifyOrderInbox.count({ where: { shopDomain: SHOP_A } })) === 0);
  check('  ...its installation and pairings are gone',
    !(await prisma.shopifyInstallation.findUnique({ where: { shopDomain: SHOP_A } }))
    && (await prisma.shopifyLocationMap.count({ where: { installationId: instA.id } })) === 0);
  check('  ...its orders are still there, with their money', (await prisma.salesOrder.count({ where: { id: { in: [o1.id, o2.id, o3.id, o4.id, oY.id] } } })) === 5);
  check('  ...the record of what was asked and done is kept', (await prisma.shopifyPrivacyRequest.count({ where: { shopDomain: SHOP_A } })) >= 5);
  check('  ...and the till customer, who never came from Shopify, is untouched',
    (await prisma.customer.findUniqueOrThrow({ where: { id: tillCustomer.id } })).phone === '9876501234');
  check('store B is untouched: customer, order copy, parked body, installation',
    (await prisma.customer.findUniqueOrThrow({ where: { id: storeB.id } })).name === 'Anita B'
    && (await prisma.salesOrder.findUniqueOrThrow({ where: { id: oZ.id } })).customerName === 'Anita B'
    && !!(await prisma.shopifyOrderInbox.findUnique({ where: { id: parkedB.id } }))
    && !!(await prisma.shopifyInstallation.findUnique({ where: { shopDomain: SHOP_B } })));

  // ── E. THE EDGES ──────────────────────────────────────────────────────────────────────────
  console.log('\nE. AN UNCLAIMED STORE, A FAILED REQUEST, AND WHERE ORDERS COME FROM');

  const U = ID(4);
  const parkedUnclaimed = await inbox(SHOP_U, ID(41), U, null);
  const ur = await webhook('customers/redact', SHOP_U, { customer: { id: Number(U) }, orders_to_redact: [Number(ID(41))] });
  const urRow = await settled(ur.id, 'customers/redact');
  check('an erase for a store nobody has claimed still clears the body we hold',
    urRow?.status === 'COMPLETED' && urRow?.clientId === null
    && !PII.test(JSON.stringify((await prisma.shopifyOrderInbox.findUniqueOrThrow({ where: { id: parkedUnclaimed.id } })).payload)), JSON.stringify(urRow));
  const udr = await webhook('customers/data_request', SHOP_U, { customer: { id: Number(U) }, orders_requested: [] });
  await settled(udr.id, 'customers/data_request');
  const attached = await shopifyPrivacyService.attachClaimed(SHOP_U, CLIENT);
  check('claiming the store hands its privacy requests to the workspace', attached === 2
    && (await prisma.shopifyPrivacyRequest.count({ where: { shopDomain: SHOP_U, clientId: CLIENT } })) === 2);

  const stuck = await prisma.shopifyPrivacyRequest.create({
    data: { shopDomain: SHOP_B, clientId: CLIENT, topic: 'customers/redact', webhookId: `stuck-${STAMP}`, shopifyCustomerId: Z, shopifyOrderIds: [ID(31)], status: 'FAILED', detail: 'connection reset' }
  });
  await prisma.$executeRaw`UPDATE shopify_privacy_requests SET updated_at = now() - interval '1 hour' WHERE id = ${stuck.id}`;
  const retried = await shopifyPrivacyService.retryUnfinished();
  const stuckAfter = await prisma.shopifyPrivacyRequest.findUniqueOrThrow({ where: { id: stuck.id } });
  check('a request that failed after Shopify was answered is finished by housekeeping', retried >= 1 && stuckAfter.status === 'COMPLETED', JSON.stringify(stuckAfter));
  check('  ...and it did the erase it was asked for', (await prisma.customer.findUniqueOrThrow({ where: { id: storeB.id } })).name === ERASED_NAME);

  check('scrubbing a body leaves the original object alone', (() => {
    const body = shopifyBody(ID(50), ID(51));
    const copy = scrubShopifyPayload(body);
    return PII.test(JSON.stringify(body)) && !PII.test(JSON.stringify(copy));
  })());
  check('  ...and removes a person wherever Shopify repeats them (a fulfilment destination)',
    !PII.test(JSON.stringify(scrubShopifyPayload({ fulfillments: [{ destination: { name: 'Meera Shah' }, line_items: [] }] }))));

  // A real order through ingestion records which store it came from. Unpaid, so it holds no stock.
  await prisma.shopifyIdMap.create({ data: { installationId: instB.id, clientId: CLIENT, variantId, sku: variant.sku, shopifyProductId: ID(60), shopifyVariantId: ID(61) } });
  await prisma.shopifyLocationMap.create({ data: { installationId: instB.id, clientId: CLIENT, locationId, shopifyLocationId: ID(62) } });
  const ingested: any = await shopifyOrderIngestService.ingest(SHOP_B, {
    ...shopifyBody(ID(63), ID(64)), updated_at: new Date().toISOString(), location_id: Number(ID(62)),
    line_items: [{ id: 1, variant_id: Number(ID(61)), quantity: 1, price: '1200.00', discount_allocations: [] }]
  }, 'orders/create');
  if (ingested.salesOrderId) created.orders.push(ingested.salesOrderId);
  const ing = ingested.salesOrderId ? await prisma.salesOrder.findUnique({ where: { id: ingested.salesOrderId }, include: { customer: true } }) : null;
  if (ing) created.customers.push(ing.customerId);
  check('an ingested Shopify order records the store it came from', ingested.status === 'APPLIED' && ing?.sourceStore === SHOP_B && ing?.status === 'DRAFT', JSON.stringify(ingested));
  check('  ...and so does the customer it created', ing?.customer.sourceStore === SHOP_B && ing?.customer.externalCustomerId === `shopify:${ID(64)}`);
}

async function cleanup() {
  const orderIds = created.orders;
  await prisma.salesOrderItem.deleteMany({ where: { salesOrderId: { in: orderIds } } }).catch(e => console.log('cleanup items', e.message));
  await prisma.salesOrder.deleteMany({ where: { id: { in: orderIds } } }).catch(e => console.log('cleanup orders', e.message));
  await prisma.customer.deleteMany({ where: { id: { in: created.customers } } }).catch(e => console.log('cleanup customers', e.message));
  await prisma.shopifyOrderInbox.deleteMany({ where: { shopDomain: { in: SHOPS } } });
  await prisma.shopifyPrivacyRequest.deleteMany({ where: { shopDomain: { in: SHOPS } } });
  await prisma.shopifyWebhookReceipt.deleteMany({ where: { shopDomain: { in: SHOPS } } });
  await prisma.shopifyInstallation.deleteMany({ where: { shopDomain: { in: SHOPS } } });
  await prisma.userRole.deleteMany({ where: { userId: { in: created.users } } });
  await prisma.auditLog.deleteMany({ where: { userId: { in: created.users } } }).catch(() => undefined);
  await prisma.user.deleteMany({ where: { id: { in: created.users } } });
  await prisma.rolePermission.deleteMany({ where: { roleId: { in: created.roles } } });
  await prisma.role.deleteMany({ where: { id: { in: created.roles } } });

  const left = {
    customers: await prisma.customer.count({ where: { id: { in: created.customers } } }),
    orders: await prisma.salesOrder.count({ where: { id: { in: orderIds } } }),
    installs: await prisma.shopifyInstallation.count({ where: { shopDomain: { in: SHOPS } } }),
    requests: await prisma.shopifyPrivacyRequest.count({ where: { shopDomain: { in: SHOPS } } }),
    receipts: await prisma.shopifyWebhookReceipt.count({ where: { shopDomain: { in: SHOPS } } }),
    users: await prisma.user.count({ where: { id: { in: created.users } } })
  };
  const clean = Object.values(left).every(n => n === 0);
  check('cleanup left nothing behind on demo-client', clean, JSON.stringify(left));
}

main()
  .catch(error => { failed++; failures.push(`crashed: ${error?.message}`); console.error(error); })
  .finally(async () => {
    try { await cleanup(); } catch (error: any) { console.error('cleanup failed', error); failed++; }
    console.log(`\nRESULT: ${passed} passed, ${failed} failed`);
    if (failures.length) console.log('Failures:\n  - ' + failures.join('\n  - '));
    await prisma.$disconnect();
    process.exit(failed ? 1 : 0);
  });
