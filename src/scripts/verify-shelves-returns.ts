/**
 * Returns back to their shelf (27 Oct): when a returned piece waits to be put away, Put away offers the
 * shelf it left the store from.
 *
 * Real orders, real dispatches from named shelves, real returns through returnService. Each item is one
 * case: the shelf it emptied (offered), a shelf that still holds it (not offered: it is already "kept
 * on"), a purchase after the return (not offered: the newest stock is not a return), a shelf switched
 * off since (not offered), a shelf move before the sale (the move is not where it left from), and the
 * dispatch that took from two shelves at once (the emptied one that gave most).
 *
 *   VERIFY_API_URL=http://localhost:4016/api/v1 npx tsx src/scripts/verify-shelves-returns.ts
 */
import axios, { AxiosInstance } from 'axios';
import { prisma } from '../lib/prisma';
import { AuthService } from '../services/auth.service';
import { seedRolesForClient } from '../services/rbac-seed.service';
import { platformAdminService } from '../services/platform-admin.service';
import { returnService } from '../services/return.service';

const BASE = process.env.VERIFY_API_URL || 'http://localhost:4006/api/v1';
const STAMP = Date.now();
const SHOP = `shelfret-${STAMP}`;

let passed = 0;
const failures: string[] = [];
const serverErrors: string[] = [];
const check = (name: string, ok: boolean, detail = '') => {
  if (ok) { passed++; console.log(`  ok   ${name}`); }
  else { failures.push(`${name} :: ${detail}`); console.log(`  FAIL ${name} :: ${detail}`); }
};
const brief = (r: any) => `${r?.status} ${JSON.stringify(r?.data).slice(0, 300)}`;

function api(token: string, locationId?: string): AxiosInstance {
  const a = axios.create({ baseURL: BASE, headers: { Authorization: `Bearer ${token}`, ...(locationId ? { 'x-location-id': locationId } : {}) }, validateStatus: () => true, timeout: 120_000 });
  a.interceptors.response.use(r => { if (r.status >= 500) serverErrors.push(`${r.config.method?.toUpperCase()} ${r.config.url} -> ${r.status} ${JSON.stringify(r.data).slice(0, 160)}`); return r; });
  return a;
}

async function main() {
  console.log(`SETUP ${SHOP}`);
  const roles = await seedRolesForClient(SHOP);
  await prisma.clientSettings.create({ data: { clientId: SHOP, businessName: 'Return Test Sarees' } });
  const user = await prisma.user.create({ data: { clientId: SHOP, email: `ret-owner-${SHOP}@example.com`, name: 'Owner', password: 'unused', status: 'ACTIVE' } });
  await prisma.userRole.create({ data: { userId: user.id, roleId: roles.SUPER_ADMIN } });
  const store = await prisma.stockLocation.create({ data: { clientId: SHOP, name: 'Main Store', code: 'MAIN', type: 'STORE', active: true } });
  const owner = api(AuthService.generateToken({ userId: user.id, clientId: SHOP }), store.id);
  const customer = await prisma.customer.create({ data: { clientId: SHOP, customerCode: `CUS-RET-${STAMP}`, name: 'Asha', phone: `+918${String(STAMP).slice(-9)}`, status: 'ACTIVE' } });
  const product = await prisma.product.create({ data: { clientId: SHOP, title: 'Mysore Silk', productCode: `RET-${STAMP}`, slug: `ret-${STAMP}`, category: 'WOMEN', productType: 'READY_TO_WEAR', basePrice: 1000, status: 'ACTIVE' } });
  const mk = (c: string) => prisma.productVariant.create({ data: { clientId: SHOP, productId: product.id, sku: `RET-${c}-${STAMP}`, variantCode: `V-RET-${c}-${STAMP}`, colorName: c, size: 'Free Size', sellingPrice: 1000, costPrice: 600, averageCost: 600 } });
  const red = await mk('RED'), gold = await mk('GOLD'), blue = await mk('BLUE'), green = await mk('GREEN'), pink = await mk('PINK');

  const layout = await owner.post(`/shelves/locations/${store.id}/spots/import`, { rows: [
    { address: 'FL-1', shopFloor: 'yes' }, { address: 'FL-2', shopFloor: 'yes' }, { address: 'FL-3', shopFloor: 'yes' },
    { address: 'BK-1', shopFloor: 'no' }, { address: 'BK-2', shopFloor: 'no' }
  ] });
  check('layout created', layout.status === 201, brief(layout));
  const spot = async (a: string) => (await prisma.storageSpot.findFirstOrThrow({ where: { clientId: SHOP, locationId: store.id, address: a } })).id;
  const S = { FL1: await spot('FL-1'), FL2: await spot('FL-2'), FL3: await spot('FL-3'), BK1: await spot('BK-1'), BK2: await spot('BK-2') };
  const stockIn = async (variantId: string, quantity: number) => {
    const r = await owner.post('/inventory/stock-in', { variantId, quantity, reason: 'PURCHASE', unitCost: 600, locationId: store.id });
    if (r.status >= 300) check(`stock in ${quantity}`, false, brief(r));
  };
  const put = async (variantId: string, spotId: string, quantity: number) => {
    const r = await owner.post('/shelves/putaway', { locationId: store.id, variantId, spotId, quantity });
    if (r.status !== 200) check(`put away ${quantity}`, false, brief(r));
  };
  /** A real order, sent from the named shelves, then one piece brought back and restocked. */
  const sellAndReturn = async (variantId: string, fromSpots: { spotId: string; quantity: number }[], returnQty = 1) => {
    const quantity = fromSpots.reduce((t, f) => t + f.quantity, 0);
    const quote = await owner.post('/pricing/quote', { locationId: store.id, channel: 'POS', customerId: customer.id, lines: [{ variantId, quantity }] });
    const order = await owner.post('/sales-orders/full', { locationId: store.id, quoteId: quote.data?.data?.quoteId, customer: { id: customer.id }, items: [{ variantId, quantity }], status: 'CONFIRMED' });
    const orderId = order.data?.id ?? order.data?.data?.id;
    if (!orderId) { check('order created', false, `${brief(quote)} | ${brief(order)}`); return; }
    const item = await prisma.salesOrderItem.findFirstOrThrow({ where: { salesOrderId: orderId } });
    const sent = await owner.post('/dispatches', { salesOrderId: orderId, items: [{ salesOrderItemId: item.id, quantity, fromSpots }] });
    if (sent.status !== 201) { check('dispatched', false, brief(sent)); return; }
    const dispatch = await prisma.dispatch.findFirstOrThrow({ where: { salesOrderId: orderId }, include: { items: true } });
    const ret: any = await returnService.createReturn(SHOP, orderId, [{ dispatchItemId: dispatch.items[0].id, quantity: returnQty }], 'Wrong colour');
    await returnService.receiveReturn(SHOP, ret.id);
    await returnService.inspectReturn(SHOP, ret.id, ret.items.map((i: any) => ({ salesReturnItemId: i.id, disposition: 'RESTOCK' as const })));
    await returnService.completeReturn(SHOP, ret.id);
  };
  const whereIs = async (variantId: string) => {
    const r = await owner.get(`/shelves/variants/${variantId}`, { params: { locationId: store.id } });
    if (r.status !== 200) check('where is it', false, brief(r));
    return r.data?.data?.places?.[0];
  };

  // Red: 5 on FL-1, 3 on BK-1. One dispatch takes all 5 from FL-1 and 2 from BK-1 (1 stays there).
  await stockIn(red.id, 8); await put(red.id, S.FL1, 5); await put(red.id, S.BK1, 3);
  // Gold: 4 on FL-2, 2 sent, 2 stay.
  await stockIn(gold.id, 4); await put(gold.id, S.FL2, 4);
  // Blue: 2 on FL-3, both sent; a purchase arrives after the return.
  await stockIn(blue.id, 2); await put(blue.id, S.FL3, 2);
  // Green: 2 on BK-2, both sent; BK-2 is switched off before it comes back.
  await stockIn(green.id, 2); await put(green.id, S.BK2, 2);
  // Pink: 2 put on BK-1, moved to FL-2 by hand, then sold from FL-2.
  await stockIn(pink.id, 2); await put(pink.id, S.BK1, 2);
  const moved = await owner.post('/shelves/move', { locationId: store.id, variantId: pink.id, fromSpotId: S.BK1, toSpotId: S.FL2, quantity: 2 });
  check('pink moved BK-1 -> FL-2 by hand', moved.status === 200, brief(moved));

  console.log('\n1. A RETURN FROM A DISPATCH THAT EMPTIED ONE SHELF AND NOT THE OTHER');
  await sellAndReturn(red.id, [{ spotId: S.FL1, quantity: 5 }, { spotId: S.BK1, quantity: 2 }]);
  const r = await whereIs(red.id);
  check('red waits to be put away (1 not shelved)', r?.notShelved === 1, JSON.stringify(r));
  check('Put away offers FL-1: the shelf it left from, which no longer holds it', r?.cameOff?.address === 'FL-1' && r.cameOff.spotId === S.FL1 && r.cameOff.isShopFloor === true, JSON.stringify(r?.cameOff));
  check('...it says how it left (sent with an order, not a move)', typeof r?.cameOff?.leftAs === 'string' && r.cameOff.leftAs !== 'SHELF_MOVE' && !!r.cameOff.leftAt, JSON.stringify(r?.cameOff));
  check('BK-1, which still holds 1, stays under "already kept on", not as came-off', r?.shelves?.some((s: any) => s.address === 'BK-1' && s.quantity === 1), JSON.stringify(r?.shelves));
  const back = await owner.post('/shelves/putaway', { locationId: store.id, variantId: red.id, spotId: r.cameOff.spotId, quantity: 1 });
  const r2 = await whereIs(red.id);
  check('putting it back on FL-1 works, and then nothing is offered (nothing waiting)', back.status === 200 && r2?.notShelved === 0 && !r2?.cameOff, `${brief(back)} | ${JSON.stringify(r2)}`);

  console.log('\n2. THE SHELF STILL HOLDS SOME');
  await sellAndReturn(gold.id, [{ spotId: S.FL2, quantity: 2 }]);
  const g = await whereIs(gold.id);
  check('gold: FL-2 still holds 2, so it is offered as "already kept on", not twice', g?.notShelved === 1 && !g?.cameOff && g.shelves.some((s: any) => s.address === 'FL-2'), JSON.stringify(g));

  console.log('\n3. A PURCHASE ARRIVED AFTER THE RETURN');
  await sellAndReturn(blue.id, [{ spotId: S.FL3, quantity: 2 }]);
  const b1 = await whereIs(blue.id);
  check('blue right after the return: FL-3 offered', b1?.cameOff?.address === 'FL-3', JSON.stringify(b1?.cameOff));
  await stockIn(blue.id, 3);
  const b2 = await whereIs(blue.id);
  check('after a new delivery the newest stock is not a return: nothing offered as came-off', b2?.notShelved === 4 && !b2?.cameOff, JSON.stringify(b2));

  console.log('\n4. THE SHELF WAS SWITCHED OFF');
  await sellAndReturn(green.id, [{ spotId: S.BK2, quantity: 2 }]);
  const sentGreen = await whereIs(green.id);
  check('green before switching off: BK-2 offered', sentGreen?.cameOff?.address === 'BK-2', JSON.stringify(sentGreen?.cameOff));
  const off = await owner.patch(`/shelves/spots/${S.BK2}`, { active: false });
  const gr = await whereIs(green.id);
  check('BK-2 switched off: it is not offered any more', off.status === 200 && !gr?.cameOff, `${brief(off)} | ${JSON.stringify(gr?.cameOff)}`);

  console.log('\n5. A MOVE BETWEEN SHELVES IS NOT WHERE IT LEFT FROM');
  await sellAndReturn(pink.id, [{ spotId: S.FL2, quantity: 2 }]);
  const p = await whereIs(pink.id);
  check('pink: FL-2 (sold from) is offered, not BK-1 (moved off by hand earlier)', p?.cameOff?.address === 'FL-2', JSON.stringify(p?.cameOff));

  console.log('\n6. ONLY WITH A LOCATION');
  const noLoc = await owner.get(`/shelves/variants/${pink.id}`);
  check('asking without a location still answers, without came-off', noLoc.status === 200 && noLoc.data.data.places.every((pl: any) => !('cameOff' in pl)), brief(noLoc));

  check('no request produced a server error', serverErrors.length === 0, serverErrors.slice(0, 5).join(' | '));
}

async function cleanup() {
  await platformAdminService.deleteClientCompletely(SHOP, SHOP).catch((e: any) => { if (!/No such client/.test(e?.message)) console.log('cleanup', e?.message); });
  const left = await prisma.storageSpot.count({ where: { clientId: SHOP } }) + await prisma.user.count({ where: { clientId: SHOP } });
  check('the throwaway shop is gone', left === 0, String(left));
}

main()
  .catch(e => { failures.push(`crashed: ${e?.message}`); console.error(e); })
  .finally(async () => {
    await cleanup().catch(e => { failures.push(`cleanup crashed: ${e?.message}`); console.error(e); });
    console.log(`\nRESULT: ${passed} passed | ${failures.length} failed`);
    if (failures.length) console.log('Failed:\n - ' + failures.join('\n - '));
    await prisma.$disconnect();
    process.exit(failures.length ? 1 : 0);
  });
