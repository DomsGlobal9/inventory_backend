/**
 * Round two of the buying fixes, proved against a running server.
 *
 *   1. Reorder suggests an item that has run out at a store even when the store has no stock row
 *      for it, agrees with the Dashboard about it, and still leaves out what a store never carries.
 *   2. Recent Activity reads as sentences, and price quotes at the till are not recorded at all.
 *   7. A second supplier with the same name (any capitals or spacing) is refused, on create and on
 *      rename, and two people adding it at once still make only one.
 *   9. A price with more than two decimals is refused in words; PO lines keep the order they were
 *      added in, through a receipt.
 *
 * Builds its own shop and deletes it at the end, whatever happens in between.
 *
 *   npx ts-node --transpile-only src/scripts/verify-buying-round2.ts
 */
import { prisma } from '../lib/prisma';
import { AuthService } from '../services/auth.service';
import { seedRolesForClient } from '../services/rbac-seed.service';
import { seedCatalogDefaultsForClient } from '../services/catalog-seed.service';
import { inventoryMutationService } from '../services/inventory-mutation.service';
import { platformAdminService } from '../services/platform-admin.service';
import { describeActivity } from '../services/audit-feed.service';

const BASE = process.env.TEST_API_URL || 'http://localhost:4006/api/v1';
const STAMP = Date.now();
const SHOP = `verify-buying-r2-${STAMP}`;

let passed = 0, failed = 0;
const check = (name: string, ok: boolean, detail?: unknown) => {
  if (ok) { passed++; console.log(`  [PASS] ${name}`); }
  else { failed++; console.log(`  [FAIL] ${name}${detail !== undefined ? `  -> ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`); }
};
/** A refusal a shopkeeper can read: not a crash, not a code. */
const readable = (said: unknown) => typeof said === 'string' && /[a-z]{3}/i.test(said)
  && !/Something went wrong|Validation (error|failed)|undefined|Invalid/i.test(said);

let token = '';
let storeId = '';
const call = async (method: string, path: string, body?: unknown, locationId = storeId) => {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'x-location-id': locationId },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  let json: any = null;
  try { json = await res.json(); } catch { /* none */ }
  return { status: res.status, data: json?.data ?? json, said: json?.message || json?.error || '' };
};

async function variant(productId: string, sku: string, reorderLevel: number, cost = 500) {
  return prisma.productVariant.create({
    data: { clientId: SHOP, productId, sku: `${sku}-${STAMP}`, variantCode: `VC-${sku}-${STAMP}`, size: 'Free', colorName: sku, sellingPrice: 1000, costPrice: cost, reorderLevel }
  });
}

async function main() {
  console.log(`\nVerifying against ${BASE} with shop ${SHOP}\n`);

  // ── The shop ────────────────────────────────────────────────────────────────────────────────
  await seedRolesForClient(SHOP);
  await seedCatalogDefaultsForClient(SHOP);
  await prisma.clientSettings.upsert({ where: { clientId: SHOP }, create: { clientId: SHOP, businessName: 'Round Two Silks' }, update: {} });
  const role = await prisma.role.findFirstOrThrow({ where: { clientId: SHOP, name: 'SUPER_ADMIN' } });
  const owner = await prisma.user.create({
    data: { clientId: SHOP, name: 'Round Two Owner', email: `owner-${STAMP}@verify-r2.example`, password: await AuthService.hashPassword(`x-${STAMP}-long`), status: 'ACTIVE' }
  });
  await prisma.userRole.create({ data: { userId: owner.id, roleId: role.id } });
  token = AuthService.generateToken({ userId: owner.id, clientId: SHOP });

  const store = await prisma.stockLocation.create({ data: { clientId: SHOP, code: 'MAIN-STORE', name: 'Main Store', type: 'STORE', active: true } });
  const godown = await prisma.stockLocation.create({ data: { clientId: SHOP, code: 'GODOWN', name: 'Godown', type: 'WAREHOUSE', active: true } });
  storeId = store.id;

  const product = await prisma.product.create({
    data: { clientId: SHOP, productCode: `PRD-R2-${STAMP}`, title: 'Round Two Saree', slug: `r2-saree-${STAMP}`, category: 'WOMEN', productType: 'READY_TO_WEAR', basePrice: 1000, status: 'ACTIVE' }
  });
  // A: tracked, never received anywhere.   B: tracked, held only at the store, plenty.
  // C: tracked, sold out at the store.     D: tracked, never received, not sold at the godown.
  // E: not tracked (reorder level 0), never received.
  const A = await variant(product.id, 'A', 3);
  const B = await variant(product.id, 'B', 3);
  const C = await variant(product.id, 'C', 3);
  const D = await variant(product.id, 'D', 3);
  const E = await variant(product.id, 'E', 0);
  const move = (v: { id: string }, delta: number) => inventoryMutationService.applyMovement({
    clientId: SHOP, variantId: v.id, locationId: store.id, movementType: delta > 0 ? 'IN' : 'OUT',
    reason: delta > 0 ? 'PURCHASE_RECEIPT' : 'DAMAGE', quantityDelta: delta, unitCost: 500, notes: 'verify', createdBy: owner.id
  } as any);
  await move(B, 10);
  await move(C, 2);
  await move(C, -2);
  await prisma.variantLocationProfile.create({ data: { variantId: D.id, locationId: godown.id, isAvailable: false } });

  // ── 1. Reorder and the Dashboard ────────────────────────────────────────────────────────────
  console.log('1. Reorder agrees with the Dashboard');
  const lineSkus = (r: any) => [...(r.data?.suppliers ?? []).flatMap((s: any) => s.lines), ...(r.data?.unassigned ?? [])].map((l: any) => l.sku);
  const atStore = await call('GET', '/reorder/suggestions');
  const storeSkus = lineSkus(atStore);
  check('an item never received anywhere is suggested at the store', storeSkus.includes(A.sku), storeSkus);
  check('an item sold out at the store is suggested', storeSkus.includes(C.sku), storeSkus);
  check('an item with plenty is not', !storeSkus.includes(B.sku), storeSkus);
  check('an untracked item is not', !storeSkus.includes(E.sku), storeSkus);
  const aLine = [...(atStore.data?.unassigned ?? [])].find((l: any) => l.sku === A.sku);
  check('  ...priced at the item\'s cost, not ₹0', Number(aLine?.unitPrice) === 500, aLine);

  const dashStore = await call('GET', '/reports/dashboard-summary');
  const trackedOutAtStore = [A, C, D].length;
  check('the Dashboard counts the same tracked items as out (plus the untracked one)',
    dashStore.data?.outOfStockCount === trackedOutAtStore + 1, dashStore.data);
  check('  ...and Reorder lists every tracked one of them', [A, C, D].every(v => storeSkus.includes(v.sku)), storeSkus);

  const atGodown = await call('GET', '/reorder/suggestions', undefined, godown.id);
  const godownSkus = lineSkus(atGodown);
  check('the godown is not told to reorder what only the store has ever held', !godownSkus.includes(B.sku) && !godownSkus.includes(C.sku), godownSkus);
  check('  ...and says how many it left out that way', atGodown.data?.summary?.neverStockedHere === 2, atGodown.data?.summary);
  check('an item switched off for the godown is not suggested there', !godownSkus.includes(D.sku), godownSkus);
  check('  ...and is counted as not sold there', atGodown.data?.summary?.notSoldHere === 1, atGodown.data?.summary);
  check('an item never received anywhere is still suggested at the godown', godownSkus.includes(A.sku), godownSkus);

  // Something on order for the store covers A; with enough coming it leaves the list, counted.
  const supplier = await call('POST', '/suppliers', { name: 'Round Two Weavers' });
  const po = await call('POST', '/purchase-orders', { supplierId: supplier.data?.id, locationId: store.id, items: [{ variantId: A.id, orderedQty: 5, unitPrice: 500 }] });
  check('a purchase order for the store saves', po.status === 201, po);
  const after = await call('GET', '/reorder/suggestions');
  check('once enough is on order the item leaves the list, and is counted as covered',
    !lineSkus(after).includes(A.sku) && after.data?.summary?.coveredByOpenOrders >= 1, after.data?.summary);

  // ── 9. Money to the paisa, and line order ───────────────────────────────────────────────────
  console.log('9. Prices to the paisa, lines in order');
  const threeDp = await call('POST', '/purchase-orders', { supplierId: supplier.data?.id, locationId: store.id, items: [{ variantId: B.id, orderedQty: 2, unitPrice: 10.555 }] });
  check('₹10.555 is refused in words', threeDp.status === 400 && readable(threeDp.said) && /2 digits/.test(threeDp.said), threeDp);
  const twoDp = await call('POST', '/purchase-orders', { supplierId: supplier.data?.id, locationId: store.id, items: [{ variantId: B.id, orderedQty: 3, unitPrice: 10.1 }] });
  check('₹10.10 saves', twoDp.status === 201, twoDp.said);
  check('  ...and its total is exact (30.30, not 30.299999)', Number(twoDp.data?.totalAmount) === 30.3, twoDp.data?.totalAmount);
  const draftBad = await call('POST', '/reorder/draft-orders', { locationId: store.id, groups: [{ supplierId: supplier.data?.id, items: [{ variantId: C.id, orderedQty: 1, unitPrice: 1.005 }] }] });
  check('Reorder refuses a price past the paisa in words too', draftBad.status === 400 && readable(draftBad.said), draftBad);
  const draftHuge = await call('POST', '/reorder/draft-orders', { locationId: store.id, groups: [{ supplierId: supplier.data?.id, items: [{ variantId: C.id, orderedQty: 2_000_000, unitPrice: 1 }] }] });
  check('Reorder refuses an impossible quantity in words, not a server error', draftHuge.status === 400 && readable(draftHuge.said), draftHuge);

  const order = [C, A, B, D]; // not alphabetical, on purpose
  const multi = await call('POST', '/purchase-orders', { supplierId: supplier.data?.id, locationId: store.id, items: order.map(v => ({ variantId: v.id, orderedQty: 4, unitPrice: 100 })) });
  const poId = multi.data?.id;
  const skusOf = (r: any) => (r.data?.items ?? []).map((i: any) => i.sku);
  const wanted = order.map(v => v.sku);
  const fresh = await call('GET', `/purchase-orders/${poId}`);
  check('a new order lists its lines in the order they were added', JSON.stringify(skusOf(fresh)) === JSON.stringify(wanted), skusOf(fresh));
  await call('PUT', `/purchase-orders/${poId}/status`, { status: 'SENT' });
  const second = fresh.data?.items?.[1];
  const got = await call('POST', `/purchase-orders/${poId}/receive`, { receivedByName: 'Verify Person', locationId: store.id, receipts: [{ poItemId: second?.id, quantityReceived: 2 }] });
  check('part of one line is received', got.status < 400, got.said);
  const afterReceipt = await call('GET', `/purchase-orders/${poId}`);
  check('  ...and the lines keep their order afterwards', JSON.stringify(skusOf(afterReceipt)) === JSON.stringify(wanted), skusOf(afterReceipt));

  // ── 7. Duplicate suppliers ──────────────────────────────────────────────────────────────────
  console.log('7. One supplier per name');
  const first = await call('POST', '/suppliers', { name: 'Surat Silk Mills', phone: '9876543210' });
  check('a supplier is added', first.status === 201, first.said);
  const again = await call('POST', '/suppliers', { name: '  surat   SILK mills ' });
  check('the same name with other capitals and spaces is refused (409), naming it', again.status === 409 && /Surat Silk Mills is already a supplier/.test(again.said), again);
  const other = await call('POST', '/suppliers', { name: 'Kanchi Looms' });
  const rename = await call('PUT', `/suppliers/${other.data?.id}`, { name: 'SURAT SILK MILLS' });
  check('renaming another supplier to that name is refused too', rename.status === 409 && readable(rename.said), rename);
  const self = await call('PUT', `/suppliers/${first.data?.id}`, { name: 'Surat Silk  Mills', phone: '9876543211' });
  check('a supplier can still be saved under its own name', self.status === 200 && self.data?.name === 'Surat Silk Mills', self);
  // A shop that already had two suppliers of one name, from before the rule: each must still be
  // editable (the form sends the name with every save), and neither can be renamed onto another.
  const twinA = await prisma.supplier.create({ data: { clientId: SHOP, supplierCode: `SUP-TW-A-${Date.now()}`, name: 'Old Twin Traders' } });
  const twinB = await prisma.supplier.create({ data: { clientId: SHOP, supplierCode: `SUP-TW-B-${Date.now()}`, name: 'Old Twin Traders' } });
  const twinEdit = await call('PUT', `/suppliers/${twinB.id}`, { name: 'Old Twin Traders', phone: '9876500000' });
  check('an old duplicate can still have its phone changed (name sent unchanged)', twinEdit.status === 200 && twinEdit.data?.phone === '9876500000', twinEdit);
  const twinOnto = await call('PUT', `/suppliers/${twinA.id}`, { name: 'Surat Silk Mills' });
  check('but it cannot be renamed onto another supplier', twinOnto.status === 409, twinOnto);
  await call('PUT', `/suppliers/${other.data?.id}`, { isActive: false });
  const switchedOff = await call('POST', '/suppliers', { name: 'kanchi looms' });
  check('a switched-off supplier\'s name is refused, saying to switch it back on', switchedOff.status === 409 && /switch it back on/i.test(switchedOff.said), switchedOff);
  const [p1, p2] = await Promise.all([
    call('POST', '/suppliers', { name: 'Madurai Cottons' }),
    call('POST', '/suppliers', { name: 'Madurai  Cottons' })
  ]);
  const made = await prisma.supplier.count({ where: { clientId: SHOP, name: 'Madurai Cottons' } });
  check('two people adding the same supplier at once make only one', made === 1 && [p1.status, p2.status].sort().join() === '201,409', { made, statuses: [p1.status, p2.status] });

  // ── 2. Recent Activity ──────────────────────────────────────────────────────────────────────
  console.log('2. Recent Activity');
  const quote = await call('POST', '/pricing/quote', { locationId: store.id, channel: 'POS', lines: [{ variantId: B.id, quantity: 1 }] });
  check('a price quote works', quote.status === 200, quote.said);
  await new Promise(r => setTimeout(r, 2500)); // the log is written after the response
  const quoteRows = await prisma.auditLog.count({ where: { clientId: SHOP, entityType: 'PRICING' } });
  check('a price quote is not recorded as activity', quoteRows === 0, quoteRows);

  // Rows as older versions of the app wrote them, before quotes were skipped.
  for (const [entityType, action] of [['PRICING', 'QUOTE'], ['USER_CREDENTIAL', 'PASSWORD_VIEWED'], ['BRANDING', 'LOGO'], ['OFFER', 'STATUS'], ['BRANDING', 'UPLOAD_URL']]) {
    await prisma.auditLog.create({ data: { clientId: SHOP, userId: owner.id, action, entityType, entityId: 'x' } });
  }
  const feed = await call('GET', '/team/activity');
  const titles: string[] = (feed.data ?? []).map((e: any) => e.title);
  check('the feed loads', feed.status === 200 && titles.length > 0, feed.said);
  check('no quote lines in the feed', !titles.some(t => /quote/i.test(t)), titles);
  check('no upload-address lines in the feed', !titles.some(t => /upload/i.test(t)), titles);
  check('a password view reads as a sentence', titles.includes("Round Two Owner viewed a team member's password"), titles);
  check('a logo change reads as a sentence', titles.includes('Round Two Owner changed the shop logo'), titles);
  check('adding a supplier reads as a sentence', titles.includes('Round Two Owner added a supplier'), titles);
  check('marking an order sent reads as a sentence', titles.includes('Round Two Owner marked a purchase order as sent'), titles);
  check('receiving reads as a sentence', titles.includes('Round Two Owner received goods on a purchase order'), titles);
  const machine = titles.filter(t => /[A-Z]{3,}|_| (status|logo|quote|pricing|credential) [a-z]+$/.test(t.replace(/^Round Two Owner /, '')));
  check('nothing in the feed reads like machine output', machine.length === 0, machine);
  check('an action nobody has named still reads as a sentence',
    describeActivity('Priya', 'GIFT_WRAP', 'FOLD') === 'Priya made a change in gift wrap', describeActivity('Priya', 'GIFT_WRAP', 'FOLD'));
}

main()
  .catch(err => { failed++; console.error('\nCRASHED:', err); })
  .finally(async () => {
    try {
      await platformAdminService.deleteClientCompletely(SHOP, SHOP);
      const left = await prisma.supplier.count({ where: { clientId: SHOP } }) + await prisma.productVariant.count({ where: { clientId: SHOP } });
      console.log(`\nremoved ${SHOP}, rows left: ${left}`);
    } catch (e) {
      console.error(`\nCOULD NOT REMOVE ${SHOP}:`, e);
      failed++;
    }
    console.log(`\n${passed} passed, ${failed} failed`);
    await prisma.$disconnect();
    process.exit(failed ? 1 : 0);
  });
