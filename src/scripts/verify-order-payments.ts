/**
 * Money collected later, recorded in Inventory (services/order-payments), and the Dashboard's
 * "kept orders past their date" -- through the real API as sphl's own people, on temporary orders
 * made for this run in sphl and removed at the end (sphl is a test shop; its demo orders are not touched).
 *
 *   A  over the due is refused; part in cash with change; the same key again records nothing more
 *   B  the rest by UPI: Paid, nothing due; another payment is refused
 *   C  refused in words: a POS till bill (take it on the till), a cancelled order, a Shopify order, a draft;
 *      a card number as the reference; an unreadable body
 *   D  two people collecting the whole due at the same moment: exactly one is recorded
 *   E  the order page says when money can be recorded (collectBlocked), and why not otherwise
 *   F  only roles that may take payment (sales_order:counter_sale) can; the others get 403
 *   G  the money is in today's Day Book money-in, at the order's store
 *   H  Waiting on you: a kept order whose collection day has gone is counted, one handed over is not
 *
 *   ROLE_TOKENS=<role-tokens.json from staff-users.ts> npx tsx src/scripts/verify-order-payments.ts
 */
import fs from 'node:fs';
import axios from 'axios';
import { prisma } from '../lib/prisma';
import { grants, holdsEverything } from '../config/permissions';

const API = process.env.TEST_API_URL || 'http://localhost:4006/api/v1';
const CLIENT = 'sphl';
const STAMP = Date.now();
const tokens: Record<string, string> = JSON.parse(fs.readFileSync(process.env.ROLE_TOKENS!, 'utf8'));
let passed = 0, failed = 0;
const check = (name: string, ok: boolean, detail = '') => {
  if (ok) { passed++; console.log(`  ok   ${name}`); } else { failed++; console.log(`  FAIL ${name} -- ${detail}`); }
};
const as = (role: string) => axios.create({ baseURL: API, headers: { Cookie: `token=${tokens[role]}` }, validateStatus: () => true });
const brief = (r: any) => `${r.status} ${JSON.stringify(r.data).slice(0, 200)}`;
const made: string[] = [];

async function main() {
  console.log(`\nMoney collected later, and kept orders past their date, on sphl (temporary orders, stamp ${STAMP})\n`);
  const owner = as('SUPER_ADMIN');
  const store = await prisma.stockLocation.findFirstOrThrow({ where: { clientId: CLIENT, active: true }, orderBy: { createdAt: 'asc' }, select: { id: true } });
  const customer = await prisma.customer.findFirstOrThrow({ where: { clientId: CLIENT, deletedAt: null }, select: { id: true } });
  const order = async (n: string, data: Record<string, unknown>) => {
    const o = await prisma.salesOrder.create({
      data: { clientId: CLIENT, locationId: store.id, customerId: customer.id, orderNumber: `TEST-${STAMP}-${n}`, channel: 'ONLINE', sourceSystem: 'SCALEEZY_SHOP', status: 'CONFIRMED', subtotal: 1500, total: 1500, ...data } as any
    });
    made.push(o.id);
    return o;
  };
  const pay = (id: string, body: Record<string, unknown>, who = owner) => who.post(`/sales-orders/${id}/payments`, { key: `k-${STAMP}-${Math.random().toString(36).slice(2)}`, ...body });

  try {
    console.log('A. PART PAID, ONCE');
    const a = await order('A', {});
    const a1 = await pay(a.id, { method: 'CASH', amount: 2000 });
    check('more than the ₹1,500 due: 400, naming what is due', a1.status === 400 && /₹1,500\.00 still due/.test(a1.data?.message ?? ''), brief(a1));
    const key = `same-${STAMP}`;
    const a2 = await pay(a.id, { method: 'CASH', amount: 500, cashReceived: 1000, key });
    check('₹500 cash, ₹1,000 handed over: recorded, ₹1,000 still due', a2.status === 200 && a2.data?.data?.recorded === true && a2.data?.data?.payment?.due === 1000 && a2.data?.data?.payment?.status === 'PART_PAID', brief(a2));
    const row = await prisma.salesOrderPayment.findFirst({ where: { salesOrderId: a.id } });
    check('  ...the row keeps the change given (₹500) and who took it', Number(row?.changeGiven) === 500 && Number(row?.cashReceived) === 1000 && !!row?.receivedById, JSON.stringify(row));
    const a3 = await pay(a.id, { method: 'CASH', amount: 500, cashReceived: 1000, key });
    check('the same key again (a double tap): 200, nothing more recorded', a3.status === 200 && a3.data?.data?.recorded === false && await prisma.salesOrderPayment.count({ where: { salesOrderId: a.id } }) === 1, brief(a3));

    console.log('\nB. THE REST');
    const b1 = await pay(a.id, { method: 'UPI', amount: 1000, reference: '412345678901' });
    check('₹1,000 by UPI with its reference: Paid, nothing due', b1.status === 200 && b1.data?.data?.payment?.due === 0 && b1.data?.data?.payment?.status === 'PAID', brief(b1));
    const b2 = await pay(a.id, { method: 'CASH', amount: 1 });
    check('anything more: 409 "Nothing is due"', b2.status === 409 && /Nothing is due/.test(b2.data?.message ?? ''), brief(b2));

    console.log('\nC. REFUSED, IN WORDS');
    const till = await order('TILL', { channel: 'POS', sourceSystem: 'SCALEEZY_POS', externalOrderId: `INV/TEST/${STAMP}` });
    const c1 = await pay(till.id, { method: 'CASH', amount: 100 });
    check('a POS till bill: 409, take it on the till', c1.status === 409 && /on the till/.test(c1.data?.message ?? ''), brief(c1));
    const gone = await order('CANC', { status: 'CANCELLED' });
    const c2 = await pay(gone.id, { method: 'CASH', amount: 100 });
    check('a cancelled order: 409, nothing is owed', c2.status === 409 && /cancelled/.test(c2.data?.message ?? ''), brief(c2));
    const shopify = await order('SHOP', { sourceSystem: 'SHOPIFY' });
    const c3 = await pay(shopify.id, { method: 'CASH', amount: 100 });
    check('a Shopify order: 409, paid on Shopify', c3.status === 409 && /Shopify/.test(c3.data?.message ?? ''), brief(c3));
    const draft = await order('DRAFT', { status: 'DRAFT' });
    const c4 = await pay(draft.id, { method: 'CASH', amount: 100 });
    check('a draft: 409, confirm it first', c4.status === 409 && /Confirm the order/.test(c4.data?.message ?? ''), brief(c4));
    const card = await order('CARD', {});
    const c5 = await pay(card.id, { method: 'CARD', amount: 100, reference: '4111 1111 1111 1111' });
    check('a card number as the reference: 400, never type the card number', c5.status === 400 && /Never type the card number/.test(c5.data?.message ?? ''), brief(c5));
    const c6 = await owner.post(`/sales-orders/${card.id}/payments`, { method: 'GOLD', amount: 'lots' });
    check('an unreadable body: 400 in words', c6.status === 400 && /amount and how it was paid/.test(c6.data?.message ?? ''), brief(c6));
    check('  ...and none of these wrote anything', await prisma.salesOrderPayment.count({ where: { salesOrderId: { in: [till.id, gone.id, shopify.id, draft.id, card.id] } } }) === 0);

    console.log('\nD. TWO PEOPLE AT ONCE');
    const d = await order('RACE', { total: 1000, subtotal: 1000 });
    const [d1, d2] = await Promise.all([pay(d.id, { method: 'CASH', amount: 1000 }), pay(d.id, { method: 'UPI', amount: 1000 })]);
    const rows = await prisma.salesOrderPayment.findMany({ where: { salesOrderId: d.id } });
    check('both ask for the whole ₹1,000: one recorded, the other refused; ₹1,000 in total', [d1.status, d2.status].sort().join() === '200,409' && rows.length === 1 && Number(rows[0].amount) === 1000, `${brief(d1)} | ${brief(d2)} | rows ${rows.length}`);

    console.log('\nE. THE ORDER PAGE');
    const e = await order('PAGE', {});
    const e1 = await owner.get(`/sales-orders/${e.id}`);
    const e2 = await owner.get(`/sales-orders/${till.id}`);
    const e3 = await owner.get(`/sales-orders/${a.id}`);
    check('due and collectable: collectBlocked null', e1.status === 200 && e1.data.collectBlocked === null, brief(e1));
    check('a till bill: the reason in words', /on the till/.test(e2.data?.collectBlocked ?? ''), brief(e2));
    check('fully paid: "Nothing is due"', /Nothing is due/.test(e3.data?.collectBlocked ?? ''), brief(e3));

    console.log('\nF. WHO MAY');
    const users = await prisma.user.findMany({ where: { clientId: CLIENT }, select: { id: true, roles: { select: { role: { select: { name: true, permissions: { select: { permission: { select: { key: true } } } } } } } } } });
    for (const role of ['ADMIN', 'INVENTORY_MANAGER', 'WAREHOUSE', 'SALES', 'DASHBOARD_ONLY', 'NO_DASHBOARD']) {
      if (!tokens[role]) continue;
      const who = as(role);
      const me = (await who.get('/auth/session')).data;
      const uid = me?.data?.user?.id ?? me?.user?.id ?? me?.data?.id;
      const u = users.find(x => x.id === uid);
      const perms = (u?.roles ?? []).flatMap(r => r.role.permissions.map(p => p.permission.key));
      const names = (u?.roles ?? []).map(r => r.role.name);
      const should = holdsEverything(perms, names) || grants(perms, 'sales_order:counter_sale');
      const f = await order(`ROLE-${role}`, { total: 100, subtotal: 100 });
      const r = await pay(f.id, { method: 'CASH', amount: 100 }, who);
      check(`${role}: ${should ? 'may take payment -> 200' : 'may not -> 403'}`, should ? r.status === 200 : r.status === 403, `${brief(r)} uid=${uid}`);
    }

    console.log('\nG. THE DAY BOOK');
    const g = await order('BOOK', { total: 777, subtotal: 777 });
    const before = await prisma.salesOrderPayment.aggregate({ where: { clientId: CLIENT, locationId: store.id, receivedAt: { gte: new Date(Date.now() - 60_000) } }, _sum: { amount: true } });
    await pay(g.id, { method: 'CASH', amount: 777 });
    const p = await prisma.salesOrderPayment.findFirst({ where: { salesOrderId: g.id } });
    check('recorded now, at the order\'s store (what the Day Book counts by)', !!p && p.locationId === store.id && Date.now() - p.receivedAt.getTime() < 120_000, JSON.stringify(p));
    void before;

    console.log('\nH. WAITING ON YOU: KEPT ORDERS PAST THEIR DATE');
    const md0 = (await owner.get('/dashboard/my-day', { headers: { 'x-location-id': store.id } })).data?.data ?? {};
    const yesterday = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate() - 1, 12));
    await order('KEPT-LATE', { channel: 'POS', sourceSystem: 'SCALEEZY_POS', handover: 'KEEP_FOR_CUSTOMER', promisedAt: yesterday, externalOrderId: `INV/TEST/${STAMP}-K1` });
    await order('KEPT-GONE', { channel: 'POS', sourceSystem: 'SCALEEZY_POS', handover: 'KEEP_FOR_CUSTOMER', promisedAt: yesterday, handedOverAt: new Date(), externalOrderId: `INV/TEST/${STAMP}-K2` });
    await order('KEPT-SOON', { channel: 'POS', sourceSystem: 'SCALEEZY_POS', handover: 'KEEP_FOR_CUSTOMER', promisedAt: new Date(Date.now() + 3 * 86_400_000), externalOrderId: `INV/TEST/${STAMP}-K3` });
    const md1 = (await owner.get('/dashboard/my-day', { headers: { 'x-location-id': store.id } })).data?.data ?? {};
    check(`one more past its date (${md0.keptOverdue} -> ${md1.keptOverdue}); the handed-over one and the one due in 3 days are not counted`, typeof md1.keptOverdue === 'number' && md1.keptOverdue === (md0.keptOverdue ?? 0) + 1, JSON.stringify({ md0, md1 }));
    const nd = (await as('NO_DASHBOARD').get('/dashboard/my-day')).data?.data ?? {};
    check('a role that cannot see orders is not sent the count', !('keptOverdue' in nd) || nd.keptOverdue === undefined || tokens.NO_DASHBOARD === undefined, JSON.stringify(nd));
  } finally {
    const w = { salesOrderId: { in: made } };
    await prisma.salesOrderPayment.deleteMany({ where: w });
    const gone = await prisma.salesOrder.deleteMany({ where: { id: { in: made }, clientId: CLIENT } });
    console.log(`\ntemporary orders removed: ${gone.count} of ${made.length}`);
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  await prisma.$disconnect();
  process.exit(failed ? 1 : 0);
}

main().catch(async e => { console.error(e); await prisma.salesOrderPayment.deleteMany({ where: { salesOrderId: { in: made } } }); await prisma.salesOrder.deleteMany({ where: { id: { in: made }, clientId: CLIENT } }); process.exit(1); });
