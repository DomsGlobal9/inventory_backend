/**
 * Inventory's side of ScaleEzy CRM's features approved 20 Nov 2026 (A3 picks, C7 money owed, C8 bring a friend,
 * C9 levels, C10 parcel updates). LOCAL ONLY, against the real local server (4036) with CRM's test key.
 *
 *   1. C9 levels: the list is checked (keys, rates, twice, too many); a customer in "gold" earns gold's rate on a
 *      REAL till bill, someone in no level the shop's rate, a lower level never cuts the shop's rate.
 *   2. C8 points: added with the reason in the history; the same key again adds nothing; taking more than they
 *      have is refused; loyalty off, an unknown customer, a bad key: refused in words.
 *   3. A3 picks: only pieces in stock at the store, with a photo; a size; a search; another shop's store refused.
 *      The picks link: private (not in the shop's Reel links list nor on its reels page), its page works, it
 *      remembers the customer; another shop's piece or customer refused.
 *   4. A3 credit: an online order placed through the picks link carries its code on the sale (and in CRM's feed);
 *      another shop's code or nonsense is dropped, the order still placed.
 *   5. C7 dues: a till bill with money still owed shows, "pay at the till"; a fully paid one does not.
 *   6. C10: a parcel sent the older way (courier chosen from the list) still carries the courier's NAME in the feed.
 *
 *   DATABASE_URL/DIRECT_URL=local VERIFY_API_URL=http://localhost:4036/api/v1 CRM_KEY_DIR=<dir with private.pem>
 *   npx tsx src/scripts/verify-crm-next.ts      (4036 needs POS_QUEUE_IN_DEV for the till bills)
 */
import fs from 'node:fs';
import jwt from 'jsonwebtoken';
import { prisma } from '../lib/prisma';
import { AuthService } from '../services/auth.service';
import { seedRolesForClient } from '../services/rbac-seed.service';
import { platformAdminService } from '../services/platform-admin.service';
import { generateCredential } from '../utils/storefrontCredential';
import { POS_BASE_URL } from '../utils/posConnection';
import * as shopCheckout from '../services/online-shop/checkout';
import * as reelLinks from '../services/reel-links';

const BASE = process.env.VERIFY_API_URL || 'http://localhost:4036/api/v1';
const STAMP = Date.now();
const SHOP = `crmnext-${STAMP}`, OTHER = `crmnext-other-${STAMP}`;
for (const k of ['DATABASE_URL', 'DIRECT_URL']) {
  if (!/localhost:55433/.test(process.env[k] ?? '')) { console.error(`Refusing: ${k} is not the local database.`); process.exit(2); }
}
if (!/localhost|127\.0\.0\.1/.test(BASE)) { console.error('Refusing: VERIFY_API_URL is not a local server.'); process.exit(2); }
const KEY = fs.readFileSync(`${process.env.CRM_KEY_DIR}/private.pem`, 'utf8');

let passed = 0;
const failures: string[] = [];
const check = (name: string, ok: boolean, detail: unknown = '') => {
  if (ok) { passed++; console.log(`  ok   ${name}`); }
  else { failures.push(name); console.log(`  FAIL ${name} :: ${typeof detail === 'string' ? detail : JSON.stringify(detail)?.slice(0, 400)}`); }
};
const brief = (r: any) => `${r?.status} ${JSON.stringify(r?.data).slice(0, 300)}`;
const pass = (clientId: string) => `Bearer ${jwt.sign({ sub: 'scaleezy-crm-test', scope: ['modules:crm'], clientId }, KEY, { algorithm: 'RS256', audience: 'inventory', issuer: 'scaleezy-crm-test', keyid: 'test-1', expiresIn: '5m' })}`;
async function crm(method: string, path: string, body?: unknown, shop = SHOP) {
  const r = await fetch(`${BASE}/internal/modules/crm/shops/${shop}${path}`, { method, headers: { Authorization: pass(shop), ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, data: (await r.json().catch(() => null)) as any };
}
let tillKey = '';
async function tillSale(invoiceNo: string, customer: { name: string; phone: string }, itemCode: string, paidPaise: number, pricePaise = 300000) {
  const h = { 'content-type': 'application/json', 'x-storefront-key': tillKey };
  const body = { kind: 'sale.completed', invoiceNo, occurredAt: new Date().toISOString(), customer, lines: [{ itemCode, qty: 1, unitPricePaise: pricePaise, lineTotalPaise: pricePaise }], totals: { roundOffPaise: 0 }, payments: paidPaise ? [{ method: 'CASH', amountPaise: paidPaise }] : [] };
  await fetch(`${BASE}/pos/v1/events`, { method: 'POST', headers: h, body: JSON.stringify(body) });
  const end = Date.now() + 120_000;
  while (Date.now() < end) {
    const s = (await (await fetch(`${BASE}/pos/v1/events/status?invoiceNo=${encodeURIComponent(invoiceNo)}`, { headers: h })).json().catch(() => null) as any)?.data;
    if (s && (s.status === 'APPLIED' || s.status === 'REJECTED')) return s;
    await new Promise(r => setTimeout(r, 400));
  }
  return { status: 'NEVER' };
}
const phone = (n: number) => `+9195${String(STAMP).slice(-6)}${String(n).padStart(2, '0')}`;

(async () => {
  try {
    // ── The shop ──
    const roles = await seedRolesForClient(SHOP);
    await seedRolesForClient(OTHER);
    const owner = await prisma.user.create({ data: { clientId: SHOP, email: `crmnext-${STAMP}@example.invalid`, name: 'Next Owner', password: await AuthService.hashPassword(`x-${STAMP}`), status: 'ACTIVE' as any } as any });
    await prisma.userRole.create({ data: { userId: owner.id, roleId: roles.SUPER_ADMIN } });
    await prisma.user.create({ data: { clientId: OTHER, email: `crmnext-o-${STAMP}@example.invalid`, name: 'Other', password: 'x', status: 'ACTIVE' as any } as any });
    await prisma.moduleSubscription.create({ data: { clientId: SHOP, module: 'crm', enabledBy: 'verify-crm-next' } });
    await prisma.moduleSubscription.create({ data: { clientId: OTHER, module: 'crm', enabledBy: 'verify-crm-next' } });
    const store = await prisma.stockLocation.create({ data: { clientId: SHOP, code: 'MAIN', name: 'Main Store', type: 'STORE' } });
    const store2 = await prisma.stockLocation.create({ data: { clientId: SHOP, code: 'TWO', name: 'Second Store', type: 'STORE' } });
    const otherStore = await prisma.stockLocation.create({ data: { clientId: OTHER, code: 'MAIN', name: 'Their Store', type: 'STORE' } });
    const mkProduct = async (clientId: string, code: string, title: string) => prisma.product.create({ data: {
      clientId, productCode: code, slug: code.toLowerCase(), title, category: 'WOMEN' as any, productType: 'READY_TO_WEAR' as any,
      dressType: 'Saree', fabric: 'Silk', basePrice: 3000, status: 'ACTIVE' as any, publishedAt: new Date(), hsnCode: '5007', taxRateBps: 500, taxSlabbed: false, priceIsExclusive: false
    } as any });
    const silk = await mkProduct(SHOP, `NX-SILK-${STAMP}`, 'Kanchi silk saree');
    const cotton = await mkProduct(SHOP, `NX-COT-${STAMP}`, 'Cotton saree');
    const theirs = await mkProduct(OTHER, `NX-THEIR-${STAMP}`, 'Not yours');
    const v = async (productId: string, clientId: string, colour: string, size: string, code: string) =>
      prisma.productVariant.create({ data: { productId, clientId, colorName: colour, size, variantCode: code, sku: code, sellingPrice: 3000 } as any });
    const silkRedM = await v(silk.id, SHOP, 'Red', 'M', `NX-SRM-${STAMP}`);
    const silkRedL = await v(silk.id, SHOP, 'Red', 'L', `NX-SRL-${STAMP}`);
    const cotBlue = await v(cotton.id, SHOP, 'Blue', 'M', `NX-CBM-${STAMP}`);
    const theirV = await v(theirs.id, OTHER, 'Gold', 'M', `NX-TGM-${STAMP}`);
    for (const p of [silk, cotton, theirs]) await prisma.productImage.create({ data: { productId: p.id, url: `https://example.invalid/${p.productCode}.jpg`, isPrimary: true, imageType: 'COVER' } as any });
    await prisma.inventoryStock.create({ data: { clientId: SHOP, variantId: silkRedM.id, locationId: store.id, quantity: 10 } as any });
    await prisma.inventoryStock.create({ data: { clientId: SHOP, variantId: silkRedL.id, locationId: store.id, quantity: 0 } as any });
    await prisma.inventoryStock.create({ data: { clientId: SHOP, variantId: cotBlue.id, locationId: store2.id, quantity: 5 } as any });
    await prisma.inventoryStock.create({ data: { clientId: OTHER, variantId: theirV.id, locationId: otherStore.id, quantity: 5 } as any });
    const cred = generateCredential();
    await prisma.storefrontConnection.create({ data: { clientId: SHOP, name: 'Till', baseUrl: POS_BASE_URL, credentialHash: cred.hash, credentialPrefix: cred.prefix, status: 'ACTIVE', locationIds: [store.id] } as any });
    tillKey = cred.plaintext;
    await prisma.onlineShop.create({ data: { clientId: SHOP, slug: `crmnext-${STAMP}`, isLive: true, acceptsOrders: true, payOnDelivery: true, locationIds: [store.id], deliverPincodes: [] } as any });
    await prisma.loyaltySettings.create({ data: { clientId: SHOP, enabled: true, pointsPer100: 1 } as any });

    console.log('\n1. C9 LEVELS');
    let r = await crm('PUT', '/loyalty/level-rates', { rates: [{ groupKey: 'Gold', pointsPer100: 3 }, { groupKey: 'silver', pointsPer100: 0.5 }] });
    check('levels saved, keys in small letters', r.status === 200 && JSON.stringify(r.data?.data?.rates) === '[{"groupKey":"gold","pointsPer100":3},{"groupKey":"silver","pointsPer100":0.5}]', brief(r));
    r = await crm('GET', '/loyalty/level-rates');
    check('...read back with the shop\'s own rate beside them', r.status === 200 && r.data?.data?.normalPointsPer100 === 1 && r.data?.data?.rates?.length === 2, brief(r));
    for (const [what, body, word] of [
      ['not a list', { rates: 'gold' }, /rates/], ['the same group twice', { rates: [{ groupKey: 'gold', pointsPer100: 1 }, { groupKey: 'GOLD', pointsPer100: 2 }] }, /twice/],
      ['a rate of 101', { rates: [{ groupKey: 'x', pointsPer100: 101 }] }, /between 0 and 100/], ['no key', { rates: [{ pointsPer100: 1 }] }, /key/],
      ['21 levels', { rates: Array.from({ length: 21 }, (_, i) => ({ groupKey: `g${i}`, pointsPer100: 1 })) }, /At most 20/]
    ] as const) {
      r = await crm('PUT', '/loyalty/level-rates', body);
      check(`refused, ${what}: 400 in words`, r.status === 400 && word.test(r.data?.message), brief(r));
    }
    const gold = await prisma.customer.create({ data: { clientId: SHOP, customerCode: `NX-G-${STAMP}`, name: 'Gold Asha', phone: phone(1), tags: ['gold'] } as any });
    const silver = await prisma.customer.create({ data: { clientId: SHOP, customerCode: `NX-S-${STAMP}`, name: 'Silver Ravi', phone: phone(2), tags: ['silver'] } as any });
    const plain = await prisma.customer.create({ data: { clientId: SHOP, customerCode: `NX-P-${STAMP}`, name: 'Plain Meena', phone: phone(3) } as any });
    const sG = await tillSale(`INV/NX/${STAMP % 100000}G`, { name: gold.name, phone: gold.phone! }, silkRedM.variantCode, 300000);
    const sS = await tillSale(`INV/NX/${STAMP % 100000}S`, { name: silver.name, phone: silver.phone! }, silkRedM.variantCode, 300000);
    const sP = await tillSale(`INV/NX/${STAMP % 100000}P`, { name: plain.name, phone: plain.phone! }, silkRedM.variantCode, 300000);
    const pts = async (id: string) => (await prisma.customer.findUnique({ where: { id } }))!.loyaltyPoints;
    check('a REAL ₹3,000 till bill: gold earns 90 (3 per ₹100)', sG?.status === 'APPLIED' && await pts(gold.id) === 90, { sG, p: await pts(gold.id) });
    check('...silver\'s level is LOWER than the shop\'s rate: never a cut, earns the shop\'s 30', sS?.status === 'APPLIED' && await pts(silver.id) === 30, await pts(silver.id));
    check('...a customer in no level earns the shop\'s 30', sP?.status === 'APPLIED' && await pts(plain.id) === 30, await pts(plain.id));
    r = await crm('PUT', '/loyalty/level-rates', { rates: [] });
    check('an empty list ends the levels', r.status === 200 && r.data?.data?.rates?.length === 0, brief(r));

    console.log('\n2. C8 BRING A FRIEND');
    const k = `friend-${STAMP}`;
    r = await crm('POST', `/customers/${plain.id}/points`, { points: 50, reason: 'Bring a friend: Kavya joined', idempotencyKey: k });
    check('50 points added, the new balance answered', r.status === 200 && r.data?.data?.balance === 80 && r.data?.data?.already === false, brief(r));
    const line = await prisma.loyaltyEntry.findFirst({ where: { customerId: plain.id, kind: 'ADJUSTED' } });
    check('...the reason is in their points history', line?.note === 'Bring a friend: Kavya joined' && line?.points === 50, line);
    r = await crm('POST', `/customers/${plain.id}/points`, { points: 50, reason: 'Bring a friend: Kavya joined', idempotencyKey: k });
    check('the same key again: nothing added, "already"', r.status === 200 && r.data?.data?.already === true && await pts(plain.id) === 80, brief(r));
    r = await crm('POST', `/customers/${plain.id}/points`, { points: -500, reason: 'Taking back', idempotencyKey: `take-${STAMP}` });
    check('taking more than they have: refused, balance unchanged', r.status === 400 && await pts(plain.id) === 80, brief(r));
    for (const [what, id, body, st] of [
      ['an unknown customer', '00000000-0000-4000-8000-000000000000', { points: 5, reason: 'x', idempotencyKey: `u-${STAMP}` }, 404],
      ['no reason', plain.id, { points: 5, idempotencyKey: `n-${STAMP}` }, 400],
      ['a short key', plain.id, { points: 5, reason: 'x', idempotencyKey: 'abc' }, 400],
      ['zero points', plain.id, { points: 0, reason: 'x', idempotencyKey: `z-${STAMP}` }, 400]
    ] as const) {
      r = await crm('POST', `/customers/${id}/points`, body);
      check(`refused, ${what}: ${st} in words`, r.status === st && typeof r.data?.message === 'string', brief(r));
    }
    await prisma.loyaltySettings.update({ where: { clientId: SHOP }, data: { enabled: false } });
    r = await crm('POST', `/customers/${plain.id}/points`, { points: 5, reason: 'x', idempotencyKey: `off-${STAMP}` });
    check('loyalty switched off: 409 in words', r.status === 409 && /switched off/.test(r.data?.message), brief(r));
    await prisma.loyaltySettings.update({ where: { clientId: SHOP }, data: { enabled: true } });

    console.log('\n3. A3 PICKS');
    r = await crm('GET', `/picks?locationId=${store.id}`);
    const codes = (r.data?.data ?? []).map((x: any) => x.variantId);
    check('at the main store: the red silk in M (in stock), not in L (none), not the cotton (other store)', r.status === 200 && codes.includes(silkRedM.id) && !codes.includes(silkRedL.id) && !codes.includes(cotBlue.id), brief(r));
    const one = (r.data?.data ?? []).find((x: any) => x.variantId === silkRedM.id);
    check('...each with title, colour, size, price, photo and how many are free', one?.title === 'Kanchi silk saree' && one?.colour === 'Red' && one?.size === 'M' && one?.priceRupees === 3000 && /\.jpg$/.test(one?.photoUrl) && one?.inStock >= 1, one);
    r = await crm('GET', `/picks?locationId=${store.id}&size=l&all=1`);
    check('size L with all=1: the out-of-stock L shows (inStock 0), nothing in M', r.status === 200 && r.data?.data?.length === 1 && r.data.data[0].variantId === silkRedL.id && r.data.data[0].inStock === 0, brief(r));
    r = await crm('GET', '/picks?q=cotton');
    check('a search across every store: the cotton', r.status === 200 && r.data?.data?.length === 1 && r.data.data[0].variantId === cotBlue.id, brief(r));
    r = await crm('GET', `/picks?locationId=${otherStore.id}`);
    check('another shop\'s store: 400 in words', r.status === 400 && /stores/.test(r.data?.message), brief(r));
    r = await crm('GET', '/picks');
    check('...and another shop\'s pieces never appear', r.status === 200 && !(r.data?.data ?? []).some((x: any) => x.variantId === theirV.id), brief(r));

    r = await crm('POST', '/picks/link', { variantIds: [silkRedM.id, silkRedL.id, cotBlue.id], customerId: gold.id, sentBy: { userId: owner.id, name: 'Next Owner' } });
    const link = r.data?.data;
    check('a picks link for Gold Asha: made, "Picks for Gold", two pieces (both silk sizes are one red silk)', r.status === 200 && link?.title === 'Picks for Gold' && link?.pieces === 2 && typeof link?.code === 'string' && !!link?.url, brief(r));
    const row = await prisma.reelLink.findFirst({ where: { code: link?.code } });
    check('...remembers the customer and who sent it, marked PICKS', row?.purpose === 'PICKS' && row?.customerId === gold.id && row?.sentByName === 'Next Owner' && row?.createdById === owner.id, row);
    const listed = await reelLinks.list(SHOP);
    const bio = await reelLinks.bioForShopper(SHOP);
    check('...private: not in the shop\'s Reel links list, not on its reels page', !listed.some((x: any) => x.code === link?.code) && !bio.some((x: any) => x.code === link?.code), { listed: listed.length, bio: bio.length });
    const page = await reelLinks.forShopper(SHOP, link?.code);
    check('...but its own page works for the customer, with both pieces', page?.available === true && page.pieces.length === 2, page);
    r = await crm('POST', '/picks/link', { variantIds: [theirV.id] });
    check('another shop\'s piece: refused', r.status === 400, brief(r));
    const theirCust = await prisma.customer.create({ data: { clientId: OTHER, customerCode: `NX-T-${STAMP}`, name: 'Their Kiran', phone: phone(9) } as any });
    r = await crm('POST', '/picks/link', { variantIds: [silkRedM.id], customerId: theirCust.id });
    check('another shop\'s customer: refused', r.status === 400 && /not in this shop/.test(r.data?.message), brief(r));
    r = await crm('POST', '/picks/link', { variantIds: [] });
    check('no pieces: refused in words', r.status === 400 && /at least one/.test(r.data?.message), brief(r));

    console.log('\n4. A3 CREDIT ON AN ONLINE ORDER');
    const place = (n: number, fromLook: unknown) => shopCheckout.place(SHOP, {
      placementKey: `crmnext-${STAMP}-${n}-placement`, lines: [{ variantCode: silkRedM.variantCode, quantity: 1 }], name: 'Gold Asha', phone: phone(1).replace('+91', ''),
      email: '', address: 'Flat 4, 12-3 Gandhi Road, Vijayawada', pincode: '520001', payWay: 'ON_DELIVERY', fromLook
    } as any).then((x: any) => x, (e: any) => ({ error: e?.message }));
    const o1: any = await place(1, link?.code);
    const so1 = await prisma.salesOrder.findFirst({ where: { clientId: SHOP, externalOrderId: `crmnext-${STAMP}-1-placement` } });
    check('an order placed through the picks link carries its code on the sale', !o1?.error && so1?.reelLinkCode === link?.code, { o1, code: so1?.reelLinkCode });
    const fed = await prisma.moduleEvent.findFirst({ where: { clientId: SHOP, module: 'crm', sourceTable: 'sales_orders', rowId: so1?.id ?? '-' }, orderBy: { sequence: 'desc' } });
    check('...and CRM\'s feed sees it (reel_link_code on the sale)', (fed?.payload as any)?.reel_link_code === link?.code, fed?.payload ? Object.keys(fed.payload as any).length : null);
    const otherLink = await prisma.reelLink.create({ data: { clientId: OTHER, code: `NXO${STAMP % 1000000}`, title: 'Theirs' } });
    const o2: any = await place(2, otherLink.code);
    const so2 = await prisma.salesOrder.findFirst({ where: { clientId: SHOP, externalOrderId: `crmnext-${STAMP}-2-placement` } });
    check('another shop\'s link code: dropped, the order still placed', !o2?.error && !!so2 && so2.reelLinkCode === null, { o2, code: so2?.reelLinkCode });
    const o3: any = await place(3, '<script>');
    const so3 = await prisma.salesOrder.findFirst({ where: { clientId: SHOP, externalOrderId: `crmnext-${STAMP}-3-placement` } });
    check('nonsense: dropped, the order still placed', !o3?.error && !!so3 && so3.reelLinkCode === null, { o3 });

    console.log('\n5. C7 DUES');
    const owes = await prisma.customer.create({ data: { clientId: SHOP, customerCode: `NX-O-${STAMP}`, name: 'Owes Latha', phone: phone(4) } as any });
    const due = await tillSale(`INV/NX/${STAMP % 100000}D`, { name: owes.name, phone: owes.phone! }, silkRedM.variantCode, 100000);
    const paid = await tillSale(`INV/NX/${STAMP % 100000}F`, { name: plain.name, phone: plain.phone! }, silkRedM.variantCode, 300000);
    r = await crm('GET', `/customers/dues?ids=${owes.id},${plain.id}`);
    const d = (r.data?.data ?? []).find((x: any) => x.customerId === owes.id);
    check('a till bill with ₹2,000 still owed: listed, ₹2,000, "pay at the till"', due?.status === 'APPLIED' && r.status === 200 && d?.totalPaise === 200000 && d?.items?.[0]?.payAt === 'till' && d?.items?.[0]?.orderNumber === due.orderNumber, { due, d });
    const plainDue = (r.data?.data ?? []).find((x: any) => x.customerId === plain.id);
    check('...a customer whose till bills are paid owes nothing (their online order on delivery shows as "online")', paid?.status === 'APPLIED' && (!plainDue || plainDue.items.every((i: any) => i.payAt !== 'till')), plainDue);
    r = await crm('GET', '/customers/dues?ids=nope');
    check('not an id: 400 in words', r.status === 400, brief(r));

    console.log('\n6. C10 COURIER NAME IN THE FEED');
    const courier = await prisma.shopCourier.create({ data: { clientId: SHOP, name: 'DTDC', key: 'dtdc' } as any });
    const disp = await prisma.dispatch.create({ data: { clientId: SHOP, salesOrderId: so1!.id, dispatchNumber: `DSP-${STAMP}`, courierId: courier.id, status: 'SHIPPED', trackingUrl: 'https://track.example/1' } as any });
    const ev = await prisma.moduleEvent.findFirst({ where: { clientId: SHOP, module: 'crm', sourceTable: 'dispatches', rowId: disp.id }, orderBy: { sequence: 'desc' } });
    const pl = ev?.payload as any;
    check('a parcel with a courier chosen from the list: the feed carries courier_name "DTDC", the tracking link and SHIPPED', pl?.courier_name === 'DTDC' && pl?.tracking_url === 'https://track.example/1' && pl?.status === 'SHIPPED', pl && { courier_name: pl.courier_name, status: pl.status });
  } catch (e: any) { failures.push(`crashed: ${e?.message}`); console.error(e); }
  finally {
    for (const id of [SHOP, OTHER]) {
      await prisma.moduleSubscription.deleteMany({ where: { clientId: id } });
      await prisma.moduleEvent.deleteMany({ where: { clientId: id } });
      await platformAdminService.deleteClientCompletely(id, id).catch((e: any) => { if (!/No such client/.test(e?.message)) console.log('cleanup', id, e?.message); });
    }
    console.log(`\nRESULT: ${passed} passed | ${failures.length} failed`);
    if (failures.length) console.log('FAILED: ' + failures.join(' | '));
    await prisma.$disconnect();
    process.exit(failures.length ? 1 : 0);
  }
})();
