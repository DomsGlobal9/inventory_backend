/**
 * One saree sale, followed through every screen it is supposed to change.
 *
 * Every other suite proves one part. This proves they are CONNECTED -- that when a salesperson
 * sells a discounted saree, the offer's usage count moves, the order shows why it was cheaper,
 * reserved stock moves, shipping takes it off the shelf, the dashboard's low-stock tile and the
 * inventory filters change at the right moments, the alerts fire, the day book books the money
 * actually taken, a return refunds what was paid and puts it back, and a cancellation gives the
 * offer's allowance back. A break anywhere in that chain is invisible to a suite that tests one
 * link.
 *
 * All over HTTP, as the screens call it, with three people whose roles come from the real role
 * templates -- an owner, a salesperson, a warehouse hand -- so the permissions are tested as a
 * new shop would actually receive them.
 *
 * Throwaway tenant, deleted at the end. Needs the API running.
 *
 *   npx tsx src/scripts/verify-offer-to-books-e2e.ts
 */
import axios, { AxiosInstance } from 'axios';
import jwt from 'jsonwebtoken';
import { prisma } from '../lib/prisma';
import { seedRolesForClient } from '../services/rbac-seed.service';
import { inventoryMutationService } from '../services/inventory-mutation.service';
import { generateCredential } from '../utils/storefrontCredential';
import { todayKey } from '../utils/businessDay';

const BASE = process.env.VERIFY_API_URL || 'http://localhost:4006/api/v1';

let passed = 0, failed = 0;
const failures: string[] = [];
const check = (name: string, ok: boolean, detail?: string) => {
  if (ok) { passed++; console.log(`  [PASS] ${name}`); }
  else { failed++; failures.push(name); console.log(`  [FAIL] ${name}${detail ? `  -> ${detail}` : ''}`); }
};

const STAMP = Date.now();
const CLIENT = `e2e-books-${STAMP}`;
const OTHER = `e2e-books-other-${STAMP}`;
const num = (v: any) => Number(v ?? 0);
const un = (r: any) => (r?.data?.data !== undefined ? r.data.data : r?.data);
const brief = (r: any) => `${r.status} ${JSON.stringify(r.data).slice(0, 220)}`;

async function person(clientId: string, role: string, email: string, roleIds: Record<string, string>): Promise<AxiosInstance> {
  const user = await prisma.user.create({ data: { clientId, email, name: role, password: 'unused', status: 'ACTIVE' } });
  await prisma.userRole.create({ data: { userId: user.id, roleId: roleIds[role] } });
  const token = jwt.sign({ sub: user.id, clientId, iss: 'scal_easy_auth', aud: 'scal_easy_inventory' }, process.env.JWT_SECRET!, { expiresIn: '1h' });
  return axios.create({ baseURL: BASE, headers: { Authorization: `Bearer ${token}` }, validateStatus: () => true });
}

async function main() {
  console.log(`SETUP: a shop from the real role templates, two products, stock  (${BASE})`);

  const roleIds = await seedRolesForClient(CLIENT);
  const owner = await person(CLIENT, 'SUPER_ADMIN', `owner-${STAMP}@example.com`, roleIds);
  const sales = await person(CLIENT, 'SALES', `sales-${STAMP}@example.com`, roleIds);
  const warehouse = await person(CLIENT, 'WAREHOUSE', `wh-${STAMP}@example.com`, roleIds);
  const otherRoles = await seedRolesForClient(OTHER);
  const outsider = await person(OTHER, 'SUPER_ADMIN', `other-${STAMP}@example.com`, otherRoles);

  const shop = await prisma.stockLocation.create({ data: { clientId: CLIENT, name: 'Main Store', code: 'MAIN', type: 'STORE', active: true } });
  const product = await prisma.product.create({
    data: { clientId: CLIENT, productCode: 'PRD-E2E', title: 'Kanchipuram Silk Saree', slug: `e2e-${STAMP}`, category: 'WOMEN', basePrice: 10000, status: 'ACTIVE', productType: 'READY_TO_WEAR' }
  });
  const saree = await prisma.productVariant.create({
    data: { clientId: CLIENT, productId: product.id, sku: `E2E-SAREE-${STAMP}`, variantCode: `VAR-E2E-SAREE-${STAMP}`, size: 'Free', colorName: 'Maroon', sellingPrice: 10000, reorderLevel: 5 }
  });
  const blouse = await prisma.productVariant.create({
    data: { clientId: CLIENT, productId: product.id, sku: `E2E-BLOUSE-${STAMP}`, variantCode: `VAR-E2E-BLOUSE-${STAMP}`, size: 'M', colorName: 'Gold', sellingPrice: 1000, reorderLevel: 2 }
  });
  for (const [v, qty, cost] of [[saree, 10, 6000], [blouse, 10, 400]] as const) {
    await inventoryMutationService.applyMovement({
      clientId: CLIENT, variantId: v.id, locationId: shop.id, movementType: 'IN', reason: 'PURCHASE_RECEIPT', quantityDelta: qty, unitCost: cost
    });
  }
  const customer = await prisma.customer.create({ data: { clientId: CLIENT, customerCode: 'CUS-E2E', name: 'Lakshmi', status: 'ACTIVE' } });

  const stockOf = async (variantId: string) => {
    const r = await owner.get('/inventory/variants', { params: { search: variantId === saree.id ? saree.sku : blouse.sku, locationId: shop.id } });
    return (un(r)?.items ?? []).find((i: any) => i.variantId === variantId);
  };
  const reservedOf = async (variantId: string) =>
    (await prisma.inventoryStock.findFirst({ where: { variantId, locationId: shop.id } }))?.reservedQty ?? 0;
  const summary = async () => un(await owner.get('/reports/dashboard-summary', { params: { locationId: shop.id } }));
  const offerRow = async (id: string) => (un(await owner.get('/offers')) ?? []).find((o: any) => o.id === id);

  // ── A. WHO MAY DO WHAT, FROM THE TEMPLATES ─────────────────────────────
  console.log('\nA. THE ROLE TEMPLATES, AS A NEW SHOP RECEIVES THEM');

  check('the warehouse can see offers', (await warehouse.get('/offers')).status === 200);
  check('  ...but not write one', (await warehouse.post('/offers', { name: 'x', valueType: 'PERCENTAGE', value: 5, startsAt: new Date() })).status === 403);
  check('sales can see offers', (await sales.get('/offers')).status === 200);
  check('  ...but not write one', (await sales.post('/offers', { name: 'x', valueType: 'PERCENTAGE', value: 5, startsAt: new Date() })).status === 403);

  const created = await owner.post('/offers', {
    name: 'Deepavali Sale', trigger: 'AUTOMATIC', level: 'LINE', valueType: 'PERCENTAGE', value: 20, scope: 'ALL',
    startsAt: new Date(Date.now() - 3600_000).toISOString(), endsAt: new Date(Date.now() + 7 * 86400_000).toISOString(), stackable: false
  });
  check('the owner writes an offer', created.status === 201, brief(created));
  const offer = un(created);
  check('  ...which starts as a draft', offer?.status === 'DRAFT');
  check('a draft does not price anything',
    un(await sales.post('/pricing/quote', { locationId: shop.id, lines: [{ variantId: saree.id, quantity: 1 }] }))?.total === 10000);
  check('the owner starts it', (await owner.post(`/offers/${offer.id}/status`, { status: 'ACTIVE' })).status === 200);
  check('sales cannot put it on Shopify', (await sales.post(`/offers/${offer.id}/shopify`)).status === 403);
  check('warehouse cannot retire it', (await warehouse.post(`/offers/${offer.id}/status`, { status: 'ARCHIVED' })).status === 403);

  // ── B. A SALE AT THE COUNTER ───────────────────────────────────────────
  console.log('\nB. A SALESPERSON SELLS TWO SAREES AND A BLOUSE');

  const basket = [{ variantId: saree.id, quantity: 2 }, { variantId: blouse.id, quantity: 1 }];
  const quote = un(await sales.post('/pricing/quote', { locationId: shop.id, lines: basket }));
  check('the basket is priced with the offer', quote?.total === 16800, JSON.stringify(quote?.total));

  const sale = await sales.post('/sales-orders/full', {
    customer: { id: customer.id }, locationId: shop.id, quoteId: quote.quoteId,
    items: [
      { variantId: saree.id, quantity: 2 },
      { variantId: blouse.id, quantity: 1, manualDiscount: { amount: 100, reason: 'Loose hook, customer agreed' } }
    ]
  });
  check('sales can take the order, with a reasoned till discount', sale.status === 201, brief(sale));
  const order = un(sale);
  check('  ...at the quoted price less the till discount', num(order?.total) === 16700, String(order?.total));

  const detail = un(await sales.get(`/sales-orders/${order.id}`));
  check('the order explains the offer', detail?.discounts?.some((d: any) => d.source === 'OFFER' && d.title === 'Deepavali Sale'));
  check('  ...and the till discount, with its reason', detail?.discounts?.some((d: any) => d.source === 'MANUAL' && d.title === 'Loose hook, customer agreed'));
  check('the offer list counts one use', (await offerRow(offer.id))?.redemptionCount === 1, JSON.stringify((await offerRow(offer.id))?.redemptionCount));

  const warehouseManual = await warehouse.post('/sales-orders/full', {
    customer: { id: customer.id }, locationId: shop.id,
    items: [{ variantId: blouse.id, quantity: 1, manualDiscount: { amount: 50, reason: 'I felt like it' } }]
  });
  check('the warehouse cannot take an order at all', warehouseManual.status === 403, String(warehouseManual.status));

  // ── C. CONFIRMING HOLDS STOCK ──────────────────────────────────────────
  console.log('\nC. CONFIRMING HOLDS THE STOCK WITHOUT REMOVING IT');

  const confirms = await Promise.all([sales.post(`/sales-orders/${order.id}/confirm`), sales.post(`/sales-orders/${order.id}/confirm`)]);
  check('two confirm clicks: one succeeds', confirms.filter(r => r.status === 200 || r.status === 201).length === 1, confirms.map(r => r.status).join(','));
  check('  ...and only two sarees are held, not four', (await reservedOf(saree.id)) === 2, String(await reservedOf(saree.id)));
  const sareeStock = await stockOf(saree.id);
  check('the shelf still has ten', sareeStock?.quantity === 10, JSON.stringify(sareeStock?.quantity));

  // ── D. SHIPPING ────────────────────────────────────────────────────────
  console.log('\nD. SHIPPING TAKES IT OFF THE SHELF AND BOOKS THE MONEY');

  const items = detail.items;
  const sareeLine = items.find((i: any) => i.variantId === saree.id);
  const blouseLine = items.find((i: any) => i.variantId === blouse.id);

  const tooMany = await warehouse.post('/dispatches', { salesOrderId: order.id, items: [{ salesOrderItemId: sareeLine.id, quantity: 5 }] });
  check('shipping more than was ordered is refused', tooMany.status >= 400 && tooMany.status < 500, brief(tooMany));

  const partial = await warehouse.post('/dispatches', { salesOrderId: order.id, items: [{ salesOrderItemId: sareeLine.id, quantity: 1 }] });
  check('the warehouse ships one saree', partial.status === 201 || partial.status === 200, brief(partial));
  check('  ...the order says partly shipped', un(await owner.get(`/sales-orders/${order.id}`))?.status === 'PARTIALLY_DISPATCHED');
  check('  ...the shelf has nine', (await stockOf(saree.id))?.quantity === 9);
  check('  ...and one is still held', (await reservedOf(saree.id)) === 1);

  const rest = await warehouse.post('/dispatches', { salesOrderId: order.id, items: [
    { salesOrderItemId: sareeLine.id, quantity: 1 }, { salesOrderItemId: blouseLine.id, quantity: 1 }
  ] });
  check('the rest ships', rest.status === 201 || rest.status === 200, brief(rest));
  check('  ...the order is shipped', un(await owner.get(`/sales-orders/${order.id}`))?.status === 'DISPATCHED');
  check('  ...nothing is held any more', (await reservedOf(saree.id)) === 0 && (await reservedOf(blouse.id)) === 0);

  const tz = (await prisma.clientSettings.findUnique({ where: { clientId: CLIENT } }))?.timezone ?? 'Asia/Kolkata';
  const book = un(await owner.get('/daybook', { params: { date: todayKey(tz) } }));
  const revenue = num(book?.sales?.revenue ?? book?.revenue);
  check('the day book books what was charged, not the tag price', revenue === 16700, `${revenue} (tag price 21000)`);
  check('warehouse cannot read the day book\'s money', (await warehouse.get('/daybook')).status === 403);

  // ── E. STOCK RUNS LOW, THEN OUT ────────────────────────────────────────
  console.log('\nE. SELLING DOWN TO LOW, THEN TO NOTHING');

  const before = await summary();
  check('with eight sarees nothing is low', before?.lowStockCount === 0, JSON.stringify(before));

  const sellAndShip = async (qty: number) => {
    const q = un(await sales.post('/pricing/quote', { locationId: shop.id, lines: [{ variantId: saree.id, quantity: qty }] }));
    const o = un(await sales.post('/sales-orders/full', { customer: { id: customer.id }, locationId: shop.id, quoteId: q.quoteId, items: [{ variantId: saree.id, quantity: qty }], status: 'CONFIRMED' }));
    const d = un(await owner.get(`/sales-orders/${o.id}`));
    await warehouse.post('/dispatches', { salesOrderId: o.id, items: [{ salesOrderItemId: d.items[0].id, quantity: qty }] });
    return o;
  };

  await sellAndShip(4);
  const low = await summary();
  check('at four sarees (reorder at five) the dashboard counts one low', low?.lowStockCount === 1, JSON.stringify(low));
  check('  ...and nothing out', low?.outOfStockCount === 0);
  const lowList = un(await owner.get('/inventory/variants', { params: { status: 'LOW_STOCK', locationId: shop.id } }))?.items ?? [];
  check('  ...the Low Stock filter shows exactly that saree', lowList.length === 1 && lowList[0].variantId === saree.id, JSON.stringify(lowList.map((i: any) => i.sku)));
  const alertsLow = un(await owner.get('/inventory/alerts'));
  const alertListLow = Array.isArray(alertsLow) ? alertsLow : (alertsLow?.alerts ?? alertsLow?.items ?? []);
  check('  ...and a low-stock alert is raised', alertListLow.some((a: any) => a.type === 'LOW_STOCK' && a.variantId === saree.id), JSON.stringify(alertListLow.map((a: any) => a.type)));

  await sellAndShip(4);
  const out = await summary();
  check('sold out: it is no longer counted as low', out?.lowStockCount === 0, JSON.stringify(out));
  check('  ...it is counted as out of stock', out?.outOfStockCount === 1);
  const outList = un(await owner.get('/inventory/variants', { params: { status: 'OUT_OF_STOCK', locationId: shop.id } }))?.items ?? [];
  check('  ...the Out of Stock filter shows it', outList.some((i: any) => i.variantId === saree.id));
  const lowAfter = un(await owner.get('/inventory/variants', { params: { status: 'LOW_STOCK', locationId: shop.id } }))?.items ?? [];
  check('  ...and the Low Stock filter no longer does', !lowAfter.some((i: any) => i.variantId === saree.id));
  const alertsOut = un(await owner.get('/inventory/alerts'));
  const alertListOut = Array.isArray(alertsOut) ? alertsOut : (alertsOut?.alerts ?? alertsOut?.items ?? []);
  check('  ...the alert becomes out of stock', alertListOut.some((a: any) => a.type === 'OUT_OF_STOCK' && a.variantId === saree.id), JSON.stringify(alertListOut.map((a: any) => a.type)));

  const noStockQuote = await sales.post('/sales-orders/full', { customer: { id: customer.id }, locationId: shop.id, items: [{ variantId: saree.id, quantity: 1 }], status: 'CONFIRMED' });
  check('confirming a sale with nothing on the shelf is refused', noStockQuote.status >= 400, brief(noStockQuote));
  check('  ...and leaves no half-made order', (await prisma.salesOrder.count({ where: { clientId: CLIENT, status: 'CONFIRMED' } })) === 0);

  // ── F. A RETURN ────────────────────────────────────────────────────────
  console.log('\nF. ONE SAREE COMES BACK');

  const dispatchItem = await prisma.dispatchItem.findFirstOrThrow({ where: { salesOrderItemId: sareeLine.id } });
  const ret = await owner.post('/returns', { salesOrderId: order.id, items: [{ dispatchItemId: dispatchItem.id, quantity: 1 }], reason: 'SIZE_ISSUE' });
  check('a return is logged against the shipped saree', ret.status === 201, brief(ret));
  const retId = un(ret)?.id;
  const retRow = await prisma.salesReturn.findUniqueOrThrow({ where: { id: retId }, include: { items: true } });
  check('  ...refunding what was PAID for it, not the tag', num(retRow.refundTotal) === 8000, `${retRow.refundTotal} (tag 10000)`);
  check('  ...and nothing goes back on the shelf yet', (await stockOf(saree.id))?.quantity === 0);

  await owner.post(`/returns/${retId}/receive`);
  const inspected = await owner.post(`/returns/${retId}/inspect`, { itemsDisposition: [{ salesReturnItemId: retRow.items[0].id, disposition: 'RESTOCK' }] });
  check('it is inspected fit to sell', inspected.status === 200, brief(inspected));
  const completed = await owner.post(`/returns/${retId}/complete`);
  check('the return is completed', completed.status === 200, brief(completed));
  check('  ...the saree is back on the shelf', (await stockOf(saree.id))?.quantity === 1);
  const afterReturn = await summary();
  check('  ...the dashboard moves it from out of stock to low', afterReturn?.outOfStockCount === 0 && afterReturn?.lowStockCount === 1, JSON.stringify(afterReturn));
  check('  ...and the offer\'s use is NOT given back for a return', (await offerRow(offer.id))?.redemptionCount === 3, JSON.stringify((await offerRow(offer.id))?.redemptionCount));

  // Returns that should not work, and returns that must add up.
  const wrongOrder = await prisma.salesOrder.findFirstOrThrow({ where: { clientId: CLIENT, status: 'DISPATCHED', NOT: { id: order.id } } });
  const misfiled = await owner.post('/returns', { salesOrderId: wrongOrder.id, items: [{ dispatchItemId: dispatchItem.id, quantity: 1 }], reason: 'OTHER' });
  check('a saree shipped on one order cannot be returned against another', misfiled.status === 400, brief(misfiled));

  const overReturn = await owner.post('/returns', { salesOrderId: order.id, items: [{ dispatchItemId: dispatchItem.id, quantity: 5 }], reason: 'OTHER' });
  check('returning more than was shipped is refused', overReturn.status >= 400 && overReturn.status < 500, brief(overReturn));

  const blouseDispatch = await prisma.dispatchItem.findFirstOrThrow({ where: { salesOrderItemId: blouseLine.id } });
  const toReject = un(await owner.post('/returns', { salesOrderId: order.id, items: [{ dispatchItemId: blouseDispatch.id, quantity: 1 }], reason: 'OTHER' }));
  check('the blouse return owes what was paid after both discounts', num((await prisma.salesReturn.findUniqueOrThrow({ where: { id: toReject.id } })).refundTotal) === 700);
  await owner.post(`/returns/${toReject.id}/reject`);
  const rejected = await prisma.salesReturn.findUniqueOrThrow({ where: { id: toReject.id } });
  check('a rejected return owes nothing', num(rejected.refundTotal) === 0 && rejected.refundStatus === 'NONE', `${rejected.refundTotal} ${rejected.refundStatus}`);

  // Three blouses sold for 2,000 less 10% offer... sold here as a line whose total does not divide evenly.
  // Placed by the owner: a price below the catalogue sent by a salesperson is refused since the till
  // limit was extended to /full (verify-counter-sale F). This step is about refund rounding.
  const odd = un(await owner.post('/sales-orders/full', {
    customer: { id: customer.id }, locationId: shop.id, status: 'CONFIRMED',
    items: [{ variantId: blouse.id, quantity: 3, listUnitPrice: 1000, lineDiscount: 1000 }]
  }));
  const oddLine = un(await owner.get(`/sales-orders/${odd.id}`)).items[0];
  await warehouse.post('/dispatches', { salesOrderId: odd.id, items: [{ salesOrderItemId: oddLine.id, quantity: 3 }] });
  const oddDispatch = await prisma.dispatchItem.findFirstOrThrow({ where: { salesOrderItemId: oddLine.id } });
  let refundedSum = 0;
  for (let i = 0; i < 3; i++) {
    const r = un(await owner.post('/returns', { salesOrderId: odd.id, items: [{ dispatchItemId: oddDispatch.id, quantity: 1 }], reason: 'OTHER' }));
    refundedSum += num((await prisma.salesReturn.findUniqueOrThrow({ where: { id: r.id } })).refundTotal);
  }
  check('three returns of a 2,000 line, one at a time, refund exactly 2,000 -- not 1,999.99',
    Math.abs(refundedSum - 2000) < 0.001, String(refundedSum));

  // ── G. A CANCELLATION ──────────────────────────────────────────────────
  console.log('\nG. AN ORDER CANCELLED BEFORE IT SHIPS');

  await prisma.offer.update({ where: { id: offer.id }, data: { usageLimit: 5 } });
  const q2 = un(await sales.post('/pricing/quote', { locationId: shop.id, lines: [{ variantId: blouse.id, quantity: 2 }] }));
  const toCancel = un(await sales.post('/sales-orders/full', { customer: { id: customer.id }, locationId: shop.id, quoteId: q2.quoteId, items: [{ variantId: blouse.id, quantity: 2 }], status: 'CONFIRMED' }));
  check('a discounted order is placed and confirmed', toCancel?.status === 'CONFIRMED', JSON.stringify(toCancel?.status));
  check('  ...holding two blouses', (await reservedOf(blouse.id)) === 2);
  const usedBefore = (await prisma.offer.findUniqueOrThrow({ where: { id: offer.id } })).usageCount;
  const listedBefore = (await offerRow(offer.id))?.redemptionCount;

  const cancelled = await owner.post(`/sales-orders/${toCancel.id}/cancel`);
  check('it is cancelled', cancelled.status === 200, brief(cancelled));
  check('  ...the blouses are released', (await reservedOf(blouse.id)) === 0);
  check('  ...the offer\'s allowance is given back', (await prisma.offer.findUniqueOrThrow({ where: { id: offer.id } })).usageCount === usedBefore - 1);
  const listedAfter = (await offerRow(offer.id))?.redemptionCount;
  check('  ...and the Offers list stops counting that use', listedAfter === listedBefore - 1, `${listedBefore} -> ${listedAfter}`);
  check('a second cancel does not give it back twice',
    ((await owner.post(`/sales-orders/${toCancel.id}/cancel`)).status >= 400) &&
    (await prisma.offer.findUniqueOrThrow({ where: { id: offer.id } })).usageCount === usedBefore - 1);

  // ── H. PAUSING REACHES THE WEBSITE ─────────────────────────────────────
  console.log('\nH. PAUSING AN OFFER REACHES THE TILL AND THE WEBSITE');

  const cred = generateCredential();
  await prisma.storefrontConnection.create({
    data: { clientId: CLIENT, name: 'Website', status: 'ACTIVE', baseUrl: 'https://example.invalid', credentialHash: cred.hash, credentialPrefix: cred.prefix, locationIds: [shop.id] }
  });
  const site = axios.create({ baseURL: `${BASE}/storefront/v1`, headers: { 'X-Storefront-Key': cred.plaintext }, validateStatus: () => true });
  check('the website shows the badge', (un(await site.get('/offers'))?.offers ?? []).some((o: any) => o.name === 'Deepavali Sale'));

  await owner.post(`/offers/${offer.id}/status`, { status: 'PAUSED' });
  check('paused: the website badge is gone', !(un(await site.get('/offers'))?.offers ?? []).some((o: any) => o.name === 'Deepavali Sale'));
  check('  ...the website is quoted full price', un(await site.post('/pricing/quote', { lines: [{ variantCode: blouse.variantCode, quantity: 1 }] }))?.total === 1000);
  check('  ...and so is the till', un(await sales.post('/pricing/quote', { locationId: shop.id, lines: [{ variantId: blouse.id, quantity: 1 }] }))?.total === 1000);
  check('  ...and the list says paused', (await offerRow(offer.id))?.effectiveStatus === 'PAUSED');

  await owner.post(`/offers/${offer.id}/status`, { status: 'ACTIVE' });
  check('resumed: the badge is back', (un(await site.get('/offers'))?.offers ?? []).some((o: any) => o.name === 'Deepavali Sale'));
  check('  ...and the price is discounted again', un(await site.post('/pricing/quote', { lines: [{ variantCode: blouse.variantCode, quantity: 1 }] }))?.total === 800);

  await owner.patch(`/offers/${offer.id}`, { value: 30, changeNote: 'Last weekend' });
  check('editing the offer to 30% reaches the website immediately', un(await site.post('/pricing/quote', { lines: [{ variantCode: blouse.variantCode, quantity: 1 }] }))?.total === 700);
  check('  ...without changing what the earlier order was charged', num(un(await owner.get(`/sales-orders/${order.id}`))?.total) === 16700);

  // ── I. ANOTHER SHOP ────────────────────────────────────────────────────
  console.log('\nI. ANOTHER SHOP SEES NONE OF IT');

  check('another shop cannot open this order', (await outsider.get(`/sales-orders/${order.id}`)).status === 404);
  check('  ...or this offer', (await outsider.get(`/offers/${offer.id}`)).status === 404);
  check('  ...or pause it', (await outsider.post(`/offers/${offer.id}/status`, { status: 'PAUSED' })).status >= 400 &&
    (await prisma.offer.findUniqueOrThrow({ where: { id: offer.id } })).status === 'ACTIVE');
  check('  ...or price this shop\'s items', (await outsider.post('/pricing/quote', { locationId: shop.id, lines: [{ variantId: saree.id, quantity: 1 }] })).status === 404);
  check('  ...or spend this shop\'s quote', (await outsider.post('/sales-orders/full', {
    customer: { externalId: 'x', name: 'x' }, locationId: shop.id, quoteId: q2.quoteId, items: [{ variantId: blouse.id, quantity: 2 }]
  })).status >= 400);
  check('  ...or return this shop\'s goods', (await outsider.post('/returns', { salesOrderId: order.id, items: [{ dispatchItemId: dispatchItem.id, quantity: 1 }], reason: 'OTHER' })).status >= 400);
  check('  ...and its dashboard shows none of this stock', (un(await outsider.get('/reports/dashboard-summary'))?.lowStockCount ?? 0) === 0);

  // ── J. THE BOOKS BALANCE ───────────────────────────────────────────────
  console.log('\nJ. EVERYTHING ADDS UP');

  const allOrders = await prisma.salesOrder.findMany({ where: { clientId: CLIENT }, include: { items: true, discounts: { include: { allocations: true } } } });
  check('every order total equals its lines', allOrders.every(o => Math.abs(o.items.reduce((s, i) => s + num(i.totalPrice), 0) - num(o.total)) < 0.005));
  check('every discount is fully allocated', allOrders.every(o => o.discounts.every(d => Math.abs(d.allocations.reduce((s, a) => s + num(a.amount), 0) - num(d.amount)) < 0.005)));
  const ledger = await prisma.salesLedger.findMany({ where: { clientId: CLIENT } });
  const shippedNet = allOrders.filter(o => o.status === 'DISPATCHED').reduce((s, o) => s + num(o.total), 0);
  const ledgerRevenue = ledger.reduce((s, l) => s + num(l.revenue), 0);
  check('the sales ledger holds exactly what shipped orders charged', Math.abs(ledgerRevenue - shippedNet) < 0.01, `${ledgerRevenue} vs ${shippedNet}`);
  const stock = await prisma.inventoryStock.findMany({ where: { clientId: CLIENT } });
  check('no stock is negative, nothing is held for a finished order', stock.every(s => s.quantity >= 0 && s.reservedQty === 0), JSON.stringify(stock.map(s => [s.quantity, s.reservedQty])));
  const leaked = JSON.stringify([tooMany.data, noStockQuote.data, warehouseManual.data]);
  check('no refusal leaked a file path or a stack', !/(\\|\/)src(\\|\/)|node_modules|PrismaClient|at [A-Za-z]+ \(/.test(leaked), leaked.slice(0, 200));
}

main()
  .catch(e => { console.error('\nSUITE CRASHED:', e); failed++; failures.push('suite crashed'); })
  .finally(async () => {
    for (const c of [CLIENT, OTHER]) {
      await prisma.inventoryAlert.deleteMany({ where: { clientId: c } }).catch(() => {});
      await prisma.salesReturnItem.deleteMany({ where: { salesReturn: { clientId: c } } });
      await prisma.salesReturn.deleteMany({ where: { clientId: c } });
      await prisma.salesLedger.deleteMany({ where: { clientId: c } });
      await prisma.dispatchItem.deleteMany({ where: { dispatch: { clientId: c } } });
      await prisma.dispatch.deleteMany({ where: { clientId: c } });
      await prisma.salesOrderItemDiscount.deleteMany({ where: { salesOrderItem: { salesOrder: { clientId: c } } } });
      await prisma.salesOrderDiscount.deleteMany({ where: { salesOrder: { clientId: c } } });
      await prisma.inventoryReservation.deleteMany({ where: { clientId: c } });
      await prisma.salesOrderItem.deleteMany({ where: { salesOrder: { clientId: c } } });
      await prisma.salesOrder.deleteMany({ where: { clientId: c } });
      await prisma.pricingQuote.deleteMany({ where: { clientId: c } });
      await prisma.offerRedemption.deleteMany({ where: { clientId: c } });
      await prisma.offerVersion.deleteMany({ where: { offer: { clientId: c } } });
      await prisma.offerTarget.deleteMany({ where: { offer: { clientId: c } } });
      await prisma.offer.deleteMany({ where: { clientId: c } });
      await prisma.storefrontDelivery.deleteMany({ where: { clientId: c } });
      await prisma.storefrontEvent.deleteMany({ where: { clientId: c } });
      await prisma.storefrontConnection.deleteMany({ where: { clientId: c } });
      await prisma.inventoryTransaction.deleteMany({ where: { clientId: c } });
      await prisma.inventoryStock.deleteMany({ where: { clientId: c } });
      await prisma.productVariant.deleteMany({ where: { clientId: c } });
      await prisma.product.deleteMany({ where: { clientId: c } });
      await prisma.customer.deleteMany({ where: { clientId: c } });
      await prisma.stockLocation.deleteMany({ where: { clientId: c } });
      await prisma.userRole.deleteMany({ where: { user: { clientId: c } } });
      await prisma.user.deleteMany({ where: { clientId: c } });
      await prisma.rolePermission.deleteMany({ where: { role: { clientId: c } } });
      await prisma.role.deleteMany({ where: { clientId: c } });
      await prisma.dailyLocationSnapshot.deleteMany({ where: { clientId: c } }).catch(() => {});
      await prisma.dailyInventorySnapshot.deleteMany({ where: { clientId: c } }).catch(() => {});
      await prisma.clientSettings.deleteMany({ where: { clientId: c } }).catch(() => {});
      await prisma.clientSequence.deleteMany({ where: { clientId: c } });
    }
    await prisma.$disconnect();
    console.log(`\nRESULT: ${passed} passed | ${failed} failed`);
    if (failures.length) console.log('Failures:\n  - ' + failures.join('\n  - '));
    process.exit(failed ? 1 : 0);
  });
