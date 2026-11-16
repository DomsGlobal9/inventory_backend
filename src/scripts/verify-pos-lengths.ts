/**
 * Cloth by the metre AT THE TILL (16 Nov 2026, PLAN-fabrics.md 4.5). LOCAL database and LOCAL server only, through
 * the real /api/v1/pos/v1 routes with a real till key and the real queue worker (POS_QUEUE_IN_DEV=true).
 *
 * A till that sends `X-Pos-Units: 1` sees metre products (qty in cm, price per cm) and may sell, exchange and return
 * them; a till that does not is exactly as before (pieces only, a metre line refused in words). Each answer is the
 * one it SHOULD be, worked out by hand:
 *   Maroon silk Rs 450/m, shop cut 25 cm: 2.25 m = 225 cm x 450 paise = Rs 1,012.50
 *   Kanchi silk Rs 1,200/m, its own cut 50 cm: 2.25 m refused (2.00 or 2.50), 2.50 m = Rs 3,000
 * A throwaway shop, removed at the end.
 *
 *   DATABASE_URL=<local> DIRECT_URL=<local> VERIFY_API_URL=http://localhost:4036/api/v1 npx tsx src/scripts/verify-pos-lengths.ts
 */
import { prisma } from '../lib/prisma';
import { AuthService } from '../services/auth.service';
import { seedRolesForClient } from '../services/rbac-seed.service';
import { inventoryMutationService } from '../services/inventory-mutation.service';
import { posConnectionService } from '../services/pos/pos-connection.service';
import { tick } from '../services/pos/pos-queue.service';
import { dayBookService } from '../services/daybook.service';
import { platformAdminService } from '../services/platform-admin.service';
import { storedPrice } from '../lib/units';
import { storefrontCatalogueService } from '../services/storefront-catalogue.service';

for (const k of ['DATABASE_URL', 'DIRECT_URL']) {
  if (!/localhost:55433/.test(process.env[k] ?? '')) { console.error(`Refusing: ${k} is not the local database.`); process.exit(2); }
}
const BASE = process.env.VERIFY_API_URL || 'http://localhost:4036/api/v1';
if (!/localhost|127\.0\.0\.1/.test(BASE)) { console.error('Refusing: not a local server.'); process.exit(2); }
const STAMP = Date.now();
const SHOP = `till-cloth-${STAMP}`;
let passed = 0, failed = 0;
const check = (name: string, ok: boolean, detail: unknown = '') => {
  if (ok) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name} -- ${typeof detail === 'string' ? detail : JSON.stringify(detail)?.slice(0, 400)}`); }
};

async function main() {
  // ── a fabric shop with a till ──
  const roles = await seedRolesForClient(SHOP);
  const owner = await prisma.user.create({ data: { clientId: SHOP, email: `${SHOP}@example.com`, name: 'Cloth Owner', password: 'unused', status: 'ACTIVE' as any } });
  await prisma.userRole.create({ data: { userId: owner.id, roleId: roles.SUPER_ADMIN } });
  const token = AuthService.generateToken({ userId: owner.id, clientId: SHOP });
  const api = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(`${BASE}${path}`, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, Origin: 'http://localhost:5183' }, body: body ? JSON.stringify(body) : undefined });
    const j: any = await res.json().catch(() => ({}));
    return { status: res.status, data: j?.data, message: j?.message ?? '' };
  };
  await prisma.clientSettings.create({ data: { clientId: SHOP, businessName: 'Cloth House' } });
  const store = await prisma.stockLocation.create({ data: { clientId: SHOP, name: 'Main Store', code: 'MAIN-STORE', type: 'STORE' as any, active: true } });
  let r = await api('PUT', '/fabrics', { fabricsOn: true, fabricMinCut: 25 });
  check('fabrics on, smallest cut 25 cm', r.status === 200 && r.data?.fabricsOn === true, r);

  const make = async (body: Record<string, unknown>, sku: string, price: number | null) => {
    const p = await api('POST', '/products', { category: 'WOMEN', productType: 'UNSTITCHED', status: 'ACTIVE', ...body });
    const v = await api('POST', `/products/${p.data?.id}/variants`, { sku, colorName: 'Maroon', ...(price != null ? { sellingPrice: price } : {}) });
    return { product: p.data, variant: v.data, status: [p.status, v.status] };
  };
  const maroon = await make({ title: 'Maroon silk', soldBy: 'METRE', kind: 'FABRIC', widthCm: 112, basePrice: storedPrice(450, 'METRE') }, `MAR-${STAMP}`, storedPrice(450, 'METRE'));
  const kanchi = await make({ title: 'Kanchi silk', soldBy: 'METRE', kind: 'FABRIC', minCut: 50, basePrice: storedPrice(1200, 'METRE') }, `KAN-${STAMP}`, storedPrice(1200, 'METRE'));
  const saree = await make({ title: 'Ready saree', productType: 'READY_TO_WEAR', basePrice: 3000 }, `SAR-${STAMP}`, 3000);
  const thread = await make({ title: 'Gold thread', productType: 'READY_TO_WEAR', basePrice: 40, sellInShop: false }, `THR-${STAMP}`, 40);
  check('four products made through the real routes (2 by the metre, a saree, a material)',
    [maroon, kanchi, saree, thread].every(x => x.status[0] === 201 && x.status[1] === 201), [maroon, kanchi, saree, thread].map(x => x.status));
  for (const [v, q] of [[maroon.variant, 2500], [kanchi.variant, 1000], [saree.variant, 5], [thread.variant, 50]] as const) {
    await inventoryMutationService.applyMovement({ clientId: SHOP, variantId: v.id, locationId: store.id, movementType: 'IN' as any, reason: 'PURCHASE', quantityDelta: q, unitCost: 1 });
  }
  const { key } = await posConnectionService.create(SHOP, { locationId: store.id, name: 'Counter 1' } as any) as any;
  const till = (units: boolean) => async (method: string, path: string, body?: unknown) => {
    const res = await fetch(`${BASE}/pos/v1${path}`, { method, headers: { 'Content-Type': 'application/json', 'X-Storefront-Key': key, ...(units ? { 'X-Pos-Units': '1' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, body: (await res.json().catch(() => ({}))) as any };
  };
  const oldTill = till(false), newTill = till(true);
  const settle = async (t: ReturnType<typeof till>, body: any) => {
    const first = await t('POST', '/events', body);
    if (first.body?.data?.answer !== 'ACCEPTED') return first.body?.data ?? first.body;
    const number = body.kind === 'sale.exchanged' ? body.exchangeNo : (body.creditNoteNo ?? body.invoiceNo);
    for (const until = Date.now() + 120_000; Date.now() < until;) {
      const s = await t('GET', `/events/status?invoiceNo=${encodeURIComponent(number)}`);
      const d = s.body?.data;
      if (d && (d.status === 'APPLIED' || d.status === 'REJECTED')) return d;
      // The real worker, for this shop only, in case the server was started without POS_QUEUE_IN_DEV.
      await tick([SHOP]).catch(() => undefined);
      await new Promise(res => setTimeout(res, 300));
    }
    throw new Error(`${number} never settled: is the POS worker on (POS_QUEUE_IN_DEV=true)?`);
  };
  const free = async (v: any) => (await prisma.inventoryStock.findFirst({ where: { clientId: SHOP, variantId: v.id, locationId: store.id }, select: { quantity: true } }))?.quantity;
  const sale = (n: string, lines: any[], extra: any = {}) => ({
    kind: 'sale.completed', invoiceNo: `INV/${STAMP}/${n}`, occurredAt: new Date().toISOString(),
    lines, totals: { roundOffPaise: 0 }, payments: [{ method: 'CASH', amountPaise: lines.reduce((a, l) => a + l.lineTotalPaise, 0) }], ...extra
  });
  const M = maroon.variant.variantCode, K = kanchi.variant.variantCode, S = saree.variant.variantCode, T = thread.variant.variantCode;

  console.log('\nA. WHAT EACH TILL SEES');
  const all = async (t: ReturnType<typeof till>, q = '') => (await t('GET', `/catalogue?limit=200${q}`)).body?.data;
  const old = await all(oldTill);
  const codes = (page: any) => (page?.products ?? []).map((p: any) => p.title);
  check('a till that did not say "units": the saree only (no cloth, no material), as before', JSON.stringify(codes(old)) === JSON.stringify(['Ready saree']), codes(old));
  check('...and no lengths block in its catalogue', old && !('lengths' in old), Object.keys(old ?? {}));
  const neu = await all(newTill);
  check('a till that sent X-Pos-Units: 1: both cloths and the saree, never the material', JSON.stringify([...codes(neu)].sort()) === JSON.stringify(['Kanchi silk', 'Maroon silk', 'Ready saree']), codes(neu));
  check('...with the shop\'s lengths: on, smallest cut 25 cm', neu?.lengths?.on === true && neu?.lengths?.minCutCm === 25, neu?.lengths);
  const mv = neu?.products?.find((p: any) => p.title === 'Maroon silk')?.variants?.[0];
  check('Maroon silk: unit METRE in cm, factor 100, its own cut not set (the shop\'s 25 cm applies)',
    mv?.unit?.soldBy === 'METRE' && mv.unit.base === 'cm' && mv.unit.factor === 100 && mv.unit.minCut === null, mv?.unit);
  check('...and not returnable (the owner has not ticked "Cut cloth can be returned")', mv?.unit?.returnable === false, mv?.unit);
  check('...price 450 paise per cm, shown as Rs 450 / m (45000 paise)', mv?.pricePaise === 450 && mv?.pricePerUnitPaise === 45000, { pricePaise: mv?.pricePaise, perMetre: mv?.pricePerUnitPaise });
  const kv = neu?.products?.find((p: any) => p.title === 'Kanchi silk')?.variants?.[0];
  check('Kanchi silk carries its own cut of 50 cm, Rs 1,200 / m', kv?.unit?.minCut === 50 && kv?.pricePerUnitPaise === 120000, kv?.unit);
  const sv = neu?.products?.find((p: any) => p.title === 'Ready saree')?.variants?.[0];
  check('the saree has no unit block (pieces need none)', sv && !('unit' in sv) && sv.pricePaise === 300000, sv);
  const byQuery = await all(oldTill, '&units=1');
  check('?units=1 in the query works the same as the header', codes(byQuery).includes('Maroon silk'), codes(byQuery));
  const wrongWord = await (async () => { const res = await fetch(`${BASE}/pos/v1/catalogue?limit=200`, { headers: { 'X-Storefront-Key': key, 'X-Pos-Units': 'yes' } }); return (await res.json() as any)?.data; })();
  check('only "1" counts: X-Pos-Units: yes is an old till', !codes(wrongWord).includes('Maroon silk'), codes(wrongWord));

  console.log('\nB. AN OLD TILL IS REFUSED, IN WORDS');
  let a = await settle(oldTill, sale('OLD1', [{ itemCode: M, qty: 225, unitPricePaise: 450, lineTotalPaise: 101250 }]));
  check('a metre line from a till that did not say "units": UNKNOWN_ITEM, naming the cloth and what to do', a?.answer === 'UNKNOWN_ITEM' && /Maroon silk/.test(a.detail) && /Update the till/.test(a.detail) && !/Sell it in ScaleEzy/.test(a.detail), a);
  check('...and nothing left the shelf (25 m still)', await free(maroon.variant) === 2500, await free(maroon.variant));
  a = await settle(oldTill, sale('OLD2', [{ itemCode: S, qty: 1, unitPricePaise: 300000, lineTotalPaise: 300000 }]));
  check('the same old till still sells a saree (nothing changed for pieces)', a?.answer === 'APPLIED', a);

  console.log('\nC. A TILL THAT SELLS LENGTHS');
  a = await settle(newTill, sale('L1', [{ itemCode: M, qty: 225, unitPricePaise: 450, lineTotalPaise: 101250 }]));
  check('2.25 m of Maroon silk (225 cm x 450 paise = Rs 1,012.50): APPLIED', a?.answer === 'APPLIED', a);
  check('...25 m - 2.25 m = 22.75 m left (2275 cm)', await free(maroon.variant) === 2275, await free(maroon.variant));
  const o1 = await prisma.salesOrder.findFirst({ where: { clientId: SHOP, externalOrderId: `INV/${STAMP}/L1` }, select: { total: true, items: { select: { quantity: true, unitPrice: true, totalPrice: true } } } });
  check('the order: 225 cm at Rs 4.50 per cm, line and total Rs 1,012.50', o1?.items?.[0]?.quantity === 225 && Number(o1.items[0].unitPrice) === 4.5 && Number(o1.items[0].totalPrice) === 1012.5 && Number(o1.total) === 1012.5, o1);
  a = await settle(newTill, sale('L2', [{ itemCode: M, qty: 230, unitPricePaise: 450, lineTotalPaise: 103500 }]));
  check('2.30 m is not a step of 25 cm: BAD_PAYLOAD naming the cloth and the nearest lengths', a?.answer === 'BAD_PAYLOAD' && /Maroon silk/.test(a.detail) && /2\.25 m/.test(a.detail) && /2\.50 m/.test(a.detail), a);
  a = await settle(newTill, sale('L3', [{ itemCode: K, qty: 225, unitPricePaise: 1200, lineTotalPaise: 270000 }]));
  check('Kanchi silk\'s own 50 cm cut: 2.25 m refused (2.00 m or 2.50 m)', a?.answer === 'BAD_PAYLOAD' && /2\.00 m or 2\.50 m/.test(a.detail), a);
  a = await settle(newTill, sale('L4', [{ itemCode: K, qty: 250, unitPricePaise: 1200, lineTotalPaise: 300000 }]));
  check('Kanchi silk 2.50 m = Rs 3,000: APPLIED, 10 m - 2.5 m = 7.5 m left', a?.answer === 'APPLIED' && await free(kanchi.variant) === 750, [a, await free(kanchi.variant)]);
  a = await settle(newTill, sale('L5', [{ itemCode: M, qty: 100, unitPricePaise: 450, lineTotalPaise: 45000 }, { itemCode: S, qty: 2, unitPricePaise: 300000, lineTotalPaise: 600000 }]));
  check('one bill, 1 m of cloth and 2 sarees: APPLIED; cloth 2175 cm, sarees 5 - 1 - 2 = 2', a?.answer === 'APPLIED' && await free(maroon.variant) === 2175 && await free(saree.variant) === 2, [a, await free(maroon.variant), await free(saree.variant)]);
  a = await settle(newTill, sale('L6', [{ itemCode: M, qty: 300_00, unitPricePaise: 450, lineTotalPaise: 13_500_000 }]));
  check('more than is on the shelf (300 m): not refused (the till already sold it), a warning instead', a?.answer === 'APPLIED' && (a.warnings ?? []).length > 0, a);
  await inventoryMutationService.applyMovement({ clientId: SHOP, variantId: maroon.variant.id, locationId: store.id, movementType: 'IN' as any, reason: 'ADJUSTMENT' as any, quantityDelta: 300_00, unitCost: 1 }).catch(() => undefined);
  a = await settle(newTill, sale('L7', [{ itemCode: T, qty: 1, unitPricePaise: 4000, lineTotalPaise: 4000 }]));
  check('a material is still refused, even for a new till', a?.answer === 'UNKNOWN_ITEM' && /material/i.test(a.detail), a);
  a = await settle(oldTill, sale('L8', [{ itemCode: M, qty: 100, unitPricePaise: 450, lineTotalPaise: 45000 }], { units: 1 }));
  check('units: 1 in the event body (no header) counts too', a?.answer === 'APPLIED', a);

  console.log('\nD. RETURNS OF CUT CLOTH');
  a = await settle(newTill, { kind: 'sale.returned', creditNoteNo: `CN/${STAMP}/1`, againstInvoiceNo: `INV/${STAMP}/L1`, lines: [{ itemCode: M, qty: 100, lineTotalPaise: 45000 }], totals: {} });
  check('1 m back from the 2.25 m bill, while cut cloth is not returnable: refused, saying how to allow it', a?.answer !== 'APPLIED' && /not taken back|Cut cloth can be returned/i.test(JSON.stringify(a)), a);
  r = await api('PATCH', `/products/${maroon.product.id}`, { cutReturnable: true });
  if (r.status === 404) r = await api('PUT', `/products/${maroon.product.id}`, { cutReturnable: true });
  const after = (await all(newTill))?.products?.find((p: any) => p.title === 'Maroon silk')?.variants?.[0];
  check('the till\'s catalogue now says the cloth is returnable', r.status === 200 && after?.unit?.returnable === true, [r.status, after?.unit]);
  const before = await free(maroon.variant);
  a = await settle(newTill, { kind: 'sale.returned', creditNoteNo: `CN/${STAMP}/2`, againstInvoiceNo: `INV/${STAMP}/L1`, lines: [{ itemCode: M, qty: 100, lineTotalPaise: 45000 }], totals: {} });
  check('once "Cut cloth can be returned" is ticked: 1 m (Rs 450) comes back, +100 cm', a?.answer === 'APPLIED' && (await free(maroon.variant)) === (before ?? 0) + 100, [a, before, await free(maroon.variant)]);

  console.log('\nE. EXCHANGES');
  a = await settle(newTill, { kind: 'sale.exchanged', exchangeNo: `EX/${STAMP}/1`, againstInvoiceNo: `INV/${STAMP}/OLD2`, occurredAt: new Date().toISOString(),
    returned: [{ itemCode: S, qty: 1, lineTotalPaise: 300000 }], sold: [{ itemCode: T, qty: 1, unitPricePaise: 4000, lineTotalPaise: 4000 }], payments: [] });
  check('a material cannot go out in an exchange either (it could before 16 Nov)', a?.answer === 'UNKNOWN_ITEM' && /material/i.test(a.detail), a);
  a = await settle(oldTill, { kind: 'sale.exchanged', exchangeNo: `EX/${STAMP}/2`, againstInvoiceNo: `INV/${STAMP}/OLD2`, occurredAt: new Date().toISOString(),
    returned: [{ itemCode: S, qty: 1, lineTotalPaise: 300000 }], sold: [{ itemCode: M, qty: 200, unitPricePaise: 450, lineTotalPaise: 90000 }], payments: [] });
  check('an old till cannot sell cloth through an exchange', a?.answer === 'UNKNOWN_ITEM' && /metre/.test(a.detail), a);
  const clothBefore = await free(maroon.variant);
  a = await settle(newTill, { kind: 'sale.exchanged', exchangeNo: `EX/${STAMP}/3`, againstInvoiceNo: `INV/${STAMP}/OLD2`, occurredAt: new Date().toISOString(),
    returned: [{ itemCode: S, qty: 1, lineTotalPaise: 300000 }], sold: [{ itemCode: M, qty: 200, unitPricePaise: 450, lineTotalPaise: 90000 }], payments: [] });
  check('a new till swaps a saree for 2 m of cloth: APPLIED, cloth -200 cm', a?.answer === 'APPLIED' && (await free(maroon.variant)) === (clothBefore ?? 0) - 200, [a, clothBefore, await free(maroon.variant)]);

  console.log('\nF. PRICE QUOTE AND STOCK');
  const q = await newTill('POST', '/quote', { lines: [{ itemCode: M, qty: 225 }] });
  check('a quote for 2.25 m: Rs 1,012.50 (101250 paise)', q.status === 200 && q.body?.data?.totalPaise === 101250, q.body);
  const st = await newTill('GET', `/stock?codes=${M}`);
  check('stock for the cloth answers in cm', st.status === 200 && JSON.stringify(st.body).includes(String(await free(maroon.variant))), st.body);

  console.log('\nH. A PRODUCT THAT LEAVES REACHES THE TILL (found live on sphl, 17 Nov)');
  const full = await newTill('GET', '/catalogue?limit=200');
  const cursor = full.body?.data?.nextCursor;
  check('a full pull gives a cursor to ask "what changed since"', typeof cursor === 'string' && cursor.length > 0, full.body?.data?.nextCursor);
  const sareeId = saree.product.id;
  const since = async (t: ReturnType<typeof till>, c: string) => (await t('GET', `/catalogue?limit=200&cursor=${encodeURIComponent(c)}`)).body?.data;
  const findIn = (page: any, title: string) => page?.products?.find((p: any) => p.title === title);
  const setProduct = async (data: Record<string, unknown>) => {
    let res = await api('PATCH', `/products/${sareeId}`, data);
    if (res.status === 404) res = await api('PUT', `/products/${sareeId}`, data);
    return res;
  };
  await new Promise(res => setTimeout(res, 20));
  let res = await setProduct({ status: 'DRAFT' });
  let page = await since(newTill, cursor);
  let s1 = findIn(page, 'Ready saree');
  check('unpublished: the next incremental page HAS the saree, every variant eligible:false', res.status === 200 && !!s1 && s1.variants.every((v: any) => v.eligible === false), { status: res.status, found: !!s1, eligible: s1?.variants?.map((v: any) => v.eligible) });
  const fullAgain = (await newTill('GET', '/catalogue?limit=200')).body?.data;
  check('...and a full pull simply leaves it out (no ghost rows)', !findIn(fullAgain, 'Ready saree'));
  const c2 = page?.nextCursor ?? cursor;
  res = await setProduct({ status: 'ACTIVE' });
  page = await since(newTill, c2);
  s1 = findIn(page, 'Ready saree');
  check('published again: back on the incremental page, eligible:true', res.status === 200 && !!s1 && s1.variants.some((v: any) => v.eligible === true), s1?.variants?.map((v: any) => v.eligible));
  const c3 = page?.nextCursor ?? c2;
  await prisma.product.update({ where: { id: sareeId }, data: { sellInShop: false } });
  page = await since(newTill, c3);
  s1 = findIn(page, 'Ready saree');
  check('made a material (not for sale): eligible:false', !!s1 && s1.variants.every((v: any) => v.eligible === false), s1?.variants?.map((v: any) => v.eligible));
  await prisma.product.update({ where: { id: sareeId }, data: { sellInShop: true } });
  const c4 = page?.nextCursor ?? c3;
  await prisma.product.update({ where: { id: sareeId }, data: { trashedAt: new Date() } });
  page = await since(newTill, c4);
  s1 = findIn(page, 'Ready saree');
  check('put in the bin: eligible:false', !!s1 && s1.variants.every((v: any) => v.eligible === false), s1?.variants?.map((v: any) => v.eligible));
  await prisma.product.update({ where: { id: sareeId }, data: { trashedAt: null } });
  const oldCursor = (await oldTill('GET', '/catalogue?limit=200')).body?.data?.nextCursor;
  await prisma.product.update({ where: { id: maroon.product.id }, data: { title: 'Maroon silk' } });
  const oldPage = await since(oldTill, oldCursor);
  const m1 = findIn(oldPage, 'Maroon silk');
  check('an OLD till: cloth that changed comes as eligible:false, never as something to sell', !m1 || m1.variants.every((v: any) => v.eligible === false), m1?.variants?.map((v: any) => v.eligible));
  // Other websites read the same feed WITHOUT the leavers: their contract is unchanged.
  const webFull = await storefrontCatalogueService.listProducts({ clientId: SHOP, locationIds: [] }, { limit: 200 });
  await prisma.product.update({ where: { id: sareeId }, data: { status: 'DRAFT' } });
  const webSince = await storefrontCatalogueService.listProducts({ clientId: SHOP, locationIds: [] }, { limit: 200, cursor: webFull.nextCursor ?? undefined });
  check('other websites\' feed: an unpublished piece is still left out, even on a "changed since" page', !webSince.products.some((p: any) => p.title === 'Ready saree') && webSince.products.every((p: any) => !('listed' in p)), webSince.products.map((p: any) => p.title));
  await prisma.product.update({ where: { id: sareeId }, data: { status: 'ACTIVE' } });

  console.log('\nG. THE DAY BOOK');
  const day: any = await dayBookService.getToday(SHOP);
  // OLD2 3000 + L1 1012.50 + L4 3000 + L5 450+6000 + L6 135000 + L8 450 - CN2 450 (+ the exchange: 900 out, 3000 back)
  check('the day\'s sales include the till\'s cloth (revenue above Rs 13,000)', Number(day?.sales?.revenue) > 13_000, day?.sales);
}

main()
  .catch(e => { failed++; console.error('CRASHED', e); })
  .finally(async () => {
    await platformAdminService.deleteClientCompletely(SHOP, SHOP).catch(e => console.error('cleanup:', e?.message));
    console.log(`\n${passed} passed, ${failed} problems`);
    await prisma.$disconnect();
    process.exit(failed ? 1 : 0);
  });
