/**
 * Round two of the products-and-stock fixes, proved against a running server.
 *
 *   A. A stock count can be cancelled by the shop's super admin only -- an ADMIN and a manager are
 *      refused in words. DRAFT and IN_PROGRESS can be; COMPLETED and CANCELLED cannot. Cancelling
 *      moves no stock, lets go of the count's lines, and a count cancelled cannot be typed into,
 *      started or completed. Completing and cancelling at the same moment: exactly one wins.
 *   B. Import Updates re-checks stock alerts at once: reorder level 0 clears a low alert, raising a
 *      level raises one, and the alert list reads the item's current reorder level.
 *   1. The ledger's USER / SYSTEM column is a name or "System", never an id.
 *   3. A count below zero or in part pieces is refused in words; zero is a count.
 *   6. Money goes to the paisa: 12.345 and 1499.999 are refused, 12.35 is not.
 *   5/7. A store price is refused in { message }; Issue Stock needs a reason and never SALE.
 *
 * Builds its own shop and deletes it at the end, whatever happens in between.
 *
 *   npx ts-node --transpile-only src/scripts/verify-stock-round2.ts
 */
import { prisma } from '../lib/prisma';
import { AuthService } from '../services/auth.service';
import { seedRolesForClient } from '../services/rbac-seed.service';
import { seedCatalogDefaultsForClient } from '../services/catalog-seed.service';
import { inventoryMutationService } from '../services/inventory-mutation.service';
import { platformAdminService } from '../services/platform-admin.service';
import { InventoryAlertService } from '../services/inventory-alert.service';

const BASE = process.env.TEST_API_URL || 'http://localhost:4006/api/v1';
const STAMP = Date.now();
const SHOP = `verify-stock-r2-${STAMP}`;

let passed = 0, failed = 0;
const check = (name: string, ok: boolean, detail?: unknown) => {
  if (ok) { passed++; console.log(`  [PASS] ${name}`); }
  else { failed++; console.log(`  [FAIL] ${name}${detail !== undefined ? `  -> ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`); }
};
/** A refusal a shopkeeper can read: not a crash, not a code. */
const readable = (said: unknown) => typeof said === 'string' && /[a-z]{3}/i.test(said)
  && !/Something went wrong|Validation (error|failed)|undefined|Invalid|Expected|_/i.test(said);

const tokens: Record<string, string> = {};
const names: Record<string, string> = {};
let storeId = '';
const call = async (who: string, method: string, path: string, body?: unknown, locationId = storeId) => {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(`${BASE}${path}`, {
        method,
        headers: { Authorization: `Bearer ${tokens[who]}`, 'Content-Type': 'application/json', 'x-location-id': locationId },
        body: body === undefined ? undefined : JSON.stringify(body)
      });
      let json: any = null;
      try { json = await res.json(); } catch { /* none */ }
      return { status: res.status, data: json?.data ?? json, said: json?.message || json?.error || '' };
    } catch (e) {
      // The dev server restarts when anyone saves a backend file; wait for it rather than fail.
      if (attempt >= 8) throw e;
      await new Promise(r => setTimeout(r, 5000));
    }
  }
};

async function main() {
  console.log(`\nVerifying against ${BASE} with shop ${SHOP}\n`);

  // ── The shop ────────────────────────────────────────────────────────────────────────────────
  const roles = await seedRolesForClient(SHOP);
  await seedCatalogDefaultsForClient(SHOP);
  await prisma.clientSettings.upsert({ where: { clientId: SHOP }, create: { clientId: SHOP, businessName: 'Round Two Stock' }, update: {} });
  for (const [key, name, role] of [['owner', 'Stock Owner', 'SUPER_ADMIN'], ['admin', 'Stock Admin', 'ADMIN'], ['manager', 'Stock Manager', 'INVENTORY_MANAGER']] as const) {
    const u = await prisma.user.create({ data: { clientId: SHOP, name, email: `${key}-${STAMP}@verify-stock.example`, password: 'unused', status: 'ACTIVE' } });
    await prisma.userRole.create({ data: { userId: u.id, roleId: (roles as any)[role] } });
    tokens[key] = AuthService.generateToken({ userId: u.id, clientId: SHOP });
    names[key] = name;
    (names as any)[`${key}Id`] = u.id;
  }
  const store = await prisma.stockLocation.create({ data: { clientId: SHOP, code: 'MAIN-STORE', name: 'Main Store', type: 'STORE', active: true } });
  const godown = await prisma.stockLocation.create({ data: { clientId: SHOP, code: 'GODOWN', name: 'Godown', type: 'WAREHOUSE', active: true } });
  storeId = store.id;

  const product = await prisma.product.create({
    data: { clientId: SHOP, productCode: `PRD-S2-${STAMP}`, title: 'Round Two Saree', slug: `s2-${STAMP}`, category: 'WOMEN', productType: 'READY_TO_WEAR', basePrice: 1000, status: 'ACTIVE' }
  });
  const mk = (sku: string, reorderLevel: number) => prisma.productVariant.create({
    data: { clientId: SHOP, productId: product.id, sku: `${sku}-${STAMP}`, variantCode: `VC-${sku}-${STAMP}`, size: 'Free', colorName: sku, sellingPrice: 1000, costPrice: 500, reorderLevel }
  });
  const A = await mk('A', 3), B = await mk('B', 3), C = await mk('C', 5);
  const receive = (v: { id: string }, qty: number, loc = store.id) => inventoryMutationService.applyMovement({
    clientId: SHOP, variantId: v.id, locationId: loc, movementType: 'IN', reason: 'PURCHASE_RECEIPT', quantityDelta: qty, unitCost: 500, notes: 'verify', createdBy: (names as any).ownerId
  } as any);
  await receive(A, 10);
  await receive(B, 2);      // low: 2 <= 3
  await receive(C, 8);      // healthy: 8 > 5
  await receive(C, 4, godown.id);
  const qtyAt = async (v: { id: string }) => (await prisma.inventoryStock.findFirst({ where: { variantId: v.id, locationId: store.id } }))?.quantity ?? 0;

  // ── A. Cancelling a stock count ─────────────────────────────────────────────────────────────
  console.log('A. cancelling a stock count');
  const draft = await call('owner', 'POST', '/stock-counts', { name: 'Draft to cancel', locationId: store.id });
  check('a count is created', draft.status === 201, draft);
  for (const who of ['admin', 'manager']) {
    const r = await call(who, 'POST', `/stock-counts/${draft.data.id}/cancel`);
    check(`${who} is refused cancelling, in words`, r.status === 403 && readable(r.said) && /super admin/i.test(r.said), r);
  }
  const stillDraft = await prisma.stockCount.findUnique({ where: { id: draft.data.id } });
  check('the refused cancels changed nothing', stillDraft?.status === 'DRAFT', stillDraft?.status);

  const before = await qtyAt(A);
  const cancelDraft = await call('owner', 'POST', `/stock-counts/${draft.data.id}/cancel`);
  check('the super admin cancels a DRAFT count', cancelDraft.status === 200 && cancelDraft.data?.status === 'CANCELLED', cancelDraft);
  check('who cancelled it is recorded', cancelDraft.data?.completedBy === names.owner, cancelDraft.data?.completedBy);
  const lines = await prisma.stockCountItem.count({ where: { stockCountId: draft.data.id } });
  check('its lines are kept as a record, and the number it held is stored', lines >= 3 && cancelDraft.data?.totalItems === lines, { lines, totalItems: cancelDraft.data?.totalItems });
  const again = await call('owner', 'POST', `/stock-counts/${draft.data.id}/cancel`);
  check('cancelling twice is refused in words', again.status === 409 && readable(again.said), again);
  const start = await call('owner', 'POST', `/stock-counts/${draft.data.id}/start`);
  check('a cancelled count cannot be started', start.status === 409 && /cancelled/i.test(start.said), start);
  const complete = await call('owner', 'POST', `/stock-counts/${draft.data.id}/complete`);
  check('a cancelled count cannot be completed', complete.status === 409 && /cancelled/i.test(complete.said), complete);
  const list = await call('owner', 'GET', '/stock-counts');
  check('the list shows it as CANCELLED', list.data?.find((c: any) => c.id === draft.data.id)?.status === 'CANCELLED');

  // IN_PROGRESS with typed counts: cancelling changes no stock.
  const running = await call('owner', 'POST', '/stock-counts', { name: 'Running to cancel', locationId: store.id });
  await call('owner', 'POST', `/stock-counts/${running.data.id}/start`);
  const detail = await call('owner', 'GET', `/stock-counts/${running.data.id}`);
  const lineA = detail.data.items.find((i: any) => i.variantId === A.id);
  const typed = await call('manager', 'PUT', `/stock-counts/${running.data.id}/items/${lineA.id}`, { countedQty: 4 });
  check('a manager types a count', typed.status === 200, typed);
  const cancelRunning = await call('owner', 'POST', `/stock-counts/${running.data.id}/cancel`);
  check('the super admin cancels an IN_PROGRESS count', cancelRunning.status === 200, cancelRunning);
  check('cancelling moved no stock', (await qtyAt(A)) === before, { before, after: await qtyAt(A) });
  const corrections = await prisma.inventoryTransaction.count({ where: { clientId: SHOP, reason: 'AUDIT_CORRECTION' } });
  check('and wrote no correction to the ledger', corrections === 0, corrections);
  const late = await call('manager', 'PUT', `/stock-counts/${running.data.id}/items/${lineA.id}`, { countedQty: 5 });
  check('a count typed after the cancel is refused in words', late.status >= 400 && late.status < 500 && readable(late.said), late);
  const kept = await call('owner', 'GET', `/stock-counts/${running.data.id}`);
  check('what was counted before the cancel can still be read (4)', kept.data?.items?.find((i: any) => i.id === lineA.id)?.countedQty === 4, kept.data?.items?.find((i: any) => i.id === lineA.id));

  // A binned product that only cancelled counts ever listed can still be deleted for good; one an
  // open count lists cannot. (Kept lines must not trap a product in the bin forever.)
  const binned = async (title: string) => {
    const p = await prisma.product.create({ data: { clientId: SHOP, title, productCode: `PRD-${title}-${STAMP}`, slug: `${title}-${STAMP}`, category: 'WOMEN', productType: 'READY_TO_WEAR', basePrice: 100, status: 'TRASHED', trashedAt: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000) } });
    const v = await prisma.productVariant.create({ data: { clientId: SHOP, productId: p.id, sku: `${title}-V-${STAMP}`, variantCode: `VC-${title}-${STAMP}`, size: 'Free', colorName: 'Red', sellingPrice: 100 } });
    return { p, v };
  };
  const onlyCancelled = await binned('BinA');
  await prisma.stockCountItem.create({ data: { stockCountId: running.data.id, variantId: onlyCancelled.v.id, sku: onlyCancelled.v.sku, variantCode: onlyCancelled.v.variantCode, expectedQty: 0 } });
  const goneForGood = await call('owner', 'DELETE', `/products/${onlyCancelled.p.id}/hard`);
  check('a binned product listed only by a cancelled count is deleted for good', goneForGood.status === 200 && !(await prisma.product.findUnique({ where: { id: onlyCancelled.p.id } })), goneForGood);
  check('its line in the cancelled count went with it, the other lines stayed', await prisma.stockCountItem.count({ where: { variantId: onlyCancelled.v.id } }) === 0
    && await prisma.stockCountItem.count({ where: { stockCountId: running.data.id } }) > 0);
  const openCount = await call('owner', 'POST', '/stock-counts', { name: 'Open one', locationId: store.id });
  const inOpen = await binned('BinB');
  await prisma.stockCountItem.create({ data: { stockCountId: openCount.data.id, variantId: inOpen.v.id, sku: inOpen.v.sku, variantCode: inOpen.v.variantCode, expectedQty: 0 } });
  const blocked = await call('owner', 'DELETE', `/products/${inOpen.p.id}/hard`);
  check('a binned product an open count lists is still kept, in words', blocked.status === 400 && readable(blocked.said) && !!(await prisma.product.findUnique({ where: { id: inOpen.p.id } })), blocked);
  await call('owner', 'POST', `/stock-counts/${openCount.data.id}/cancel`);

  // A completed count cannot be cancelled.
  const done = await call('owner', 'POST', '/stock-counts', { name: 'Completed one', locationId: store.id });
  await call('owner', 'POST', `/stock-counts/${done.data.id}/start`);
  await call('owner', 'POST', `/stock-counts/${done.data.id}/complete`);
  const cancelDone = await call('owner', 'POST', `/stock-counts/${done.data.id}/cancel`);
  check('a COMPLETED count cannot be cancelled, in words', cancelDone.status === 409 && readable(cancelDone.said) && /completed/i.test(cancelDone.said), cancelDone);

  // The race: complete and cancel pressed at the same moment, several times over.
  let completedWins = 0, cancelledWins = 0;
  for (let round = 1; round <= 4; round++) {
    const qBefore = await qtyAt(A);
    const race = await call('owner', 'POST', '/stock-counts', { name: `Race ${round}`, locationId: store.id });
    await call('owner', 'POST', `/stock-counts/${race.data.id}/start`);
    const d = await call('owner', 'GET', `/stock-counts/${race.data.id}`);
    const line = d.data.items.find((i: any) => i.variantId === A.id);
    await call('owner', 'PUT', `/stock-counts/${race.data.id}/items/${line.id}`, { countedQty: qBefore - 1 });
    // Completing reads the whole count before it claims it, so fired together the cancel tends to
    // land first. Odd rounds give the complete a head start of a second or so -- it claims the
    // count while the cancel is on its way -- so both winners are exercised.
    const late = (ms: number, f: () => Promise<any>) => new Promise<any>(r => setTimeout(() => r(f()), ms));
    const [comp, canc] = await Promise.all([
      call('owner', 'POST', `/stock-counts/${race.data.id}/complete`),
      late(round % 2 ? 1600 : 0, () => call('owner', 'POST', `/stock-counts/${race.data.id}/cancel`))
    ]);
    const wins = [comp, canc].filter(r => r.status === 200).length;
    const final = await prisma.stockCount.findUnique({ where: { id: race.data.id } });
    const qAfter = await qtyAt(A);
    const loser = [comp, canc].find(r => r.status !== 200);
    const consistent = final?.status === 'COMPLETED' ? qAfter === qBefore - 1 && comp.status === 200 : final?.status === 'CANCELLED' && qAfter === qBefore && canc.status === 200;
    check(`race ${round}: exactly one wins, the other is told in words, stock matches the winner`,
      wins === 1 && !!loser && loser.status === 409 && readable(loser.said) && consistent,
      { complete: [comp.status, comp.said], cancel: [canc.status, canc.said], final: final?.status, qBefore, qAfter });
    if (final?.status === 'COMPLETED') completedWins++; else cancelledWins++;
  }
  console.log(`    (complete won ${completedWins}, cancel won ${cancelledWins})`);
  check('both a complete and a cancel won at least one race', completedWins > 0 && cancelledWins > 0, { completedWins, cancelledWins });

  // Two cancels at once.
  const twice = await call('owner', 'POST', '/stock-counts', { name: 'Double cancel', locationId: store.id });
  const both = await Promise.all([call('owner', 'POST', `/stock-counts/${twice.data.id}/cancel`), call('owner', 'POST', `/stock-counts/${twice.data.id}/cancel`)]);
  check('two cancels at once: one succeeds, the other is told', both.filter(r => r.status === 200).length === 1 && both.some(r => r.status === 409 && readable(r.said)), both.map(r => [r.status, r.said]));

  // ── 3. Counts below zero or in part pieces ─────────────────────────────────────────────────
  console.log('\n3. what a count box accepts');
  const c3 = await call('owner', 'POST', '/stock-counts', { name: 'Box rules', locationId: store.id });
  await call('owner', 'POST', `/stock-counts/${c3.data.id}/start`);
  const d3 = await call('owner', 'GET', `/stock-counts/${c3.data.id}`);
  const l3 = d3.data.items[0];
  const neg = await call('owner', 'PUT', `/stock-counts/${c3.data.id}/items/${l3.id}`, { countedQty: -3 });
  check('-3 is refused in words', neg.status === 400 && readable(neg.said) && /less than 0/.test(neg.said), neg);
  const part = await call('owner', 'PUT', `/stock-counts/${c3.data.id}/items/${l3.id}`, { countedQty: 2.5 });
  check('2.5 is refused in words', part.status === 400 && readable(part.said) && /whole/.test(part.said), part);
  const zero = await call('owner', 'PUT', `/stock-counts/${c3.data.id}/items/${l3.id}`, { countedQty: 0 });
  check('0 is a count', zero.status === 200 && zero.data?.countedQty === 0, zero);
  await call('owner', 'POST', `/stock-counts/${c3.data.id}/cancel`);

  // ── B. Alerts after a bulk update ──────────────────────────────────────────────────────────
  console.log('\nB. alerts after Import Updates');
  const alertsNow = async () => (await call('owner', 'GET', `/inventory/alerts?locationId=${store.id}`)).data?.alerts ?? [];
  let alerts = await alertsNow();
  check('B starts with a low alert (2 left, level 3)', alerts.some((a: any) => a.variantId === B.id && a.type === 'LOW_STOCK' && a.reorderLevel === 3), alerts.map((a: any) => [a.sku, a.type, a.reorderLevel]));
  const bulk1 = await call('owner', 'POST', '/variants/bulk-update', { updates: [{ sku: B.sku, reorderLevel: 0 }, { sku: C.sku, reorderLevel: 9 }] });
  check('the file applies', bulk1.status === 200 && bulk1.data?.updated === 2, bulk1);
  alerts = await alertsNow();
  check('reorder level 0: the low alert goes at once', !alerts.some((a: any) => a.variantId === B.id), alerts.map((a: any) => [a.sku, a.type]));
  const openB = await prisma.inventoryAlert.count({ where: { variantId: B.id, isResolved: false } });
  check('and it is resolved in the database, not just hidden', openB === 0, openB);
  const cAlert = alerts.find((a: any) => a.variantId === C.id);
  check('raising a level to 9 raises a low alert for 8 left, with the new level', cAlert?.type === 'LOW_STOCK' && cAlert?.reorderLevel === 9 && /Reorder level is 9/.test(cAlert?.message), cAlert);
  const cGodown = (await call('owner', 'GET', `/inventory/alerts?locationId=${godown.id}`, undefined, godown.id)).data?.alerts?.find((a: any) => a.variantId === C.id);
  check('in every store the level applies to (godown: 4 left)', cGodown?.type === 'LOW_STOCK', cGodown);
  const bulk2 = await call('owner', 'POST', '/variants/bulk-update', { updates: [{ sku: C.sku, quantity: 20, reorderLevel: 9 }] });
  alerts = await alertsNow();
  check('stock raised above the level in the same file clears it', bulk2.status === 200 && !alerts.some((a: any) => a.variantId === C.id), alerts.map((a: any) => [a.sku, a.type]));
  // A snapshot left behind by the old code: the list reads the level as it is now.
  await prisma.productVariant.update({ where: { id: A.id }, data: { reorderLevel: 20 } });
  await prisma.inventoryAlert.create({ data: { clientId: SHOP, variantId: A.id, locationId: store.id, type: 'LOW_STOCK', severity: 'WARNING', title: 'Low Stock', message: 'Stock is low (10 remaining). Reorder level is 12.', currentQuantity: 10, threshold: 12 } });
  alerts = await alertsNow();
  const aAlert = alerts.find((a: any) => a.variantId === A.id);
  check('an old alert shows the current reorder level, not its snapshot', aAlert?.reorderLevel === 20 && /Reorder level is 20/.test(aAlert?.message), aAlert);
  await prisma.productVariant.update({ where: { id: A.id }, data: { reorderLevel: 0 } });
  alerts = await alertsNow();
  check('and is not listed once the item is no longer low by that level', !alerts.some((a: any) => a.variantId === A.id));
  await prisma.productVariant.update({ where: { id: A.id }, data: { reorderLevel: 3 } });

  // ── 1. Who, in the ledger ───────────────────────────────────────────────────────────────────
  console.log('\n1. the ledger names people');
  const adjust = await call('owner', 'POST', '/variants/bulk-update', { updates: [{ sku: A.sku, quantity: 7 }] });
  check('a bulk quantity change applies', adjust.status === 200 && adjust.data?.updated === 1, adjust);
  const transfer = await call('owner', 'POST', '/inventory-transfers', { originLocationId: store.id, destinationLocationId: godown.id, items: [{ variantId: A.id, quantity: 1 }] });
  check('a transfer applies', transfer.status === 200, transfer);
  // Rows as the old code wrote them: the shop's id, and a user id nobody has any more.
  await prisma.inventoryTransaction.updateMany({ where: { clientId: SHOP, variantId: B.id }, data: { createdBy: SHOP } });
  await prisma.inventoryTransaction.updateMany({ where: { clientId: SHOP, variantId: C.id, locationId: godown.id }, data: { createdBy: '00000000-0000-4000-8000-000000000000' } });
  const ledger = await call('owner', 'GET', '/inventory/transactions?limit=100');
  const rows: any[] = Array.isArray(ledger.data) ? ledger.data : (ledger.data?.data ?? []);
  const idLike = rows.filter(r => /^[0-9a-f]{8}-|verify-stock-r2/i.test(String(r.createdBy)));
  check('no row shows an id', rows.length > 0 && idLike.length === 0, idLike.map(r => r.createdBy));
  const bulkRow = rows.find(r => r.variantId === A.id && r.notes === 'Bulk CSV Update');
  check('a bulk update row names the person', bulkRow?.createdBy === names.owner, bulkRow?.createdBy);
  const transferRows = rows.filter(r => r.variantId === A.id && r.reason === 'TRANSFER');
  check('transfer rows name the person', transferRows.length === 2 && transferRows.every(r => r.createdBy === names.owner), transferRows.map(r => r.createdBy));
  check('a row the shop id was written on says System', rows.filter(r => r.variantId === B.id).every(r => r.createdBy === 'System'), rows.filter(r => r.variantId === B.id).map(r => r.createdBy));
  check('a person no longer on the team is said so', rows.some(r => r.createdBy === 'A former team member'));

  // ── 6. Money to the paisa ──────────────────────────────────────────────────────────────────
  console.log('\n6. money to the paisa');
  const p1 = await call('owner', 'POST', '/products', { title: `Paisa test ${STAMP}`, category: 'WOMEN', productType: 'READY_TO_WEAR', basePrice: 12.345, status: 'DRAFT' });
  check('base price 12.345 is refused in words', p1.status === 400 && /paisa/i.test(p1.said), p1);
  const p2 = await call('owner', 'POST', '/products', { title: `Paisa ok ${STAMP}`, category: 'WOMEN', productType: 'READY_TO_WEAR', basePrice: 12.35, status: 'DRAFT' });
  check('base price 12.35 is kept as 12.35', p2.status === 201 && Number(p2.data?.basePrice) === 12.35, p2);
  const v1 = await call('owner', 'PATCH', `/variants/${A.id}`, { sellingPrice: 1499.999 });
  check('variant price 1499.999 is refused in words', v1.status === 400 && /paisa/i.test(v1.said), v1);
  const v1db = await prisma.productVariant.findUnique({ where: { id: A.id } });
  check('and the old price is untouched', Number(v1db?.sellingPrice) === 1000, v1db?.sellingPrice);
  const v2 = await call('owner', 'PATCH', `/variants/${A.id}`, { sellingPrice: 1499.5, costPrice: 12.34 });
  check('1499.50 and a cost of 12.34 are accepted', v2.status === 200, v2);
  const b6 = await call('owner', 'POST', '/variants/bulk-update', { updates: [{ sku: A.sku, costPrice: 10.005 }] });
  check('a file with a cost of 10.005 is refused in words', b6.status === 400 && /paisa/i.test(b6.said), b6);

  // ── 5. Store price, 7. Issue Stock reason ──────────────────────────────────────────────────
  console.log('\n5 and 7. store price and Issue Stock');
  const sp = await call('owner', 'PATCH', `/products/${product.id}/variants/${A.id}/locations/${store.id}`, { isAvailable: true, priceOverride: -5 });
  check('a negative store price is refused in { message }', sp.status === 400 && sp.said === 'A price cannot be less than zero.', sp);
  const sp2 = await call('owner', 'PATCH', `/products/${product.id}/variants/${A.id}/locations/${store.id}`, { isAvailable: true, priceOverride: 99.999 });
  check('a store price of 99.999 is refused in words', sp2.status === 400 && /paisa/i.test(sp2.said), sp2);
  const noReason = await call('owner', 'POST', '/inventory/stock-out', { variantId: A.id, quantity: 1, locationId: store.id });
  check('Issue Stock without a reason is refused in words', noReason.status === 400 && readable(noReason.said) && /Choose why/.test(noReason.said), noReason);
  const sale = await call('owner', 'POST', '/inventory/stock-out', { variantId: A.id, quantity: 1, locationId: store.id, reason: 'SALE' });
  check('Issue Stock as SALE is refused, saying sales take stock off themselves', sale.status === 400 && /by themselves/.test(sale.said), sale);
  const damage = await call('owner', 'POST', '/inventory/stock-out', { variantId: A.id, quantity: 1, locationId: store.id, reason: 'DAMAGE' });
  check('Issue Stock as DAMAGE works', damage.status === 200, damage);

  // ── Review follow-ups ──────────────────────────────────────────────────────────────────────
  console.log('\nreview follow-ups');
  const adjSale = await call('owner', 'POST', '/inventory/adjustment', { variantId: A.id, quantity: -1, locationId: store.id, reason: 'SALE' });
  check('a stock correction marked SALE is refused in words', adjSale.status === 400 && readable(adjSale.said) && /not a sale/i.test(adjSale.said), adjSale);
  const txSale = await call('owner', 'POST', '/inventory/transactions', { variantId: A.id, type: 'ADJUSTMENT', quantity: -1, reason: 'SALE' });
  check('a movement of any type marked SALE is refused', txSale.status === 400 && /by themselves/.test(txSale.said), txSale);

  // Re-checking alerts while stock moves on the same item: never two open alerts for one item
  // and store. Five rounds, each a bulk re-check racing a stock-out that makes the item low.
  const R = await mk('R', 5);
  await receive(R, 20);
  let doubles = 0;
  for (let round = 0; round < 5; round++) {
    await prisma.productVariant.update({ where: { id: R.id }, data: { reorderLevel: 50 } });
    await Promise.all([
      InventoryAlertService.recheckVariants(prisma, SHOP, [R.id]),
      inventoryMutationService.applyMovement({ clientId: SHOP, variantId: R.id, locationId: store.id, movementType: 'OUT', reason: 'DAMAGE', quantityDelta: -1, notes: 'race', createdBy: (names as any).ownerId } as any)
    ]);
    const openNow = await prisma.inventoryAlert.count({ where: { clientId: SHOP, variantId: R.id, locationId: store.id, isResolved: false } });
    if (openNow > 1) doubles++;
    await prisma.inventoryAlert.updateMany({ where: { clientId: SHOP, variantId: R.id }, data: { isResolved: true } });
  }
  check('a re-check racing a stock movement never leaves two open alerts (5 rounds)', doubles === 0, `${doubles} rounds doubled`);
  const two = await Promise.all([
    InventoryAlertService.recheckVariants(prisma, SHOP, [R.id, A.id, B.id]),
    InventoryAlertService.recheckVariants(prisma, SHOP, [B.id, R.id, A.id])
  ]);
  const openR = await prisma.inventoryAlert.count({ where: { clientId: SHOP, variantId: R.id, locationId: store.id, isResolved: false } });
  check('two re-checks at once (items in any order) finish, with one open alert', two.length === 2 && openR === 1, `${openR} open`);

  const openCount2 = await call('owner', 'POST', '/stock-counts', { name: 'Line check', locationId: store.id });
  await call('owner', 'POST', `/stock-counts/${openCount2.data.id}/start`);
  const wrongLine = await call('owner', 'PUT', `/stock-counts/${openCount2.data.id}/items/00000000-0000-0000-0000-000000000000`, { countedQty: 1 });
  check('a line that is not on an open count says so (404), not "completed"', wrongLine.status === 404 && /not on this audit/.test(wrongLine.said), wrongLine);
  await call('owner', 'POST', `/stock-counts/${openCount2.data.id}/cancel`);
}

main()
  .catch(err => { failed++; console.error('\nCRASHED:', err); })
  .finally(async () => {
    try {
      await platformAdminService.deleteClientCompletely(SHOP, SHOP);
      const left = await prisma.stockCount.count({ where: { clientId: SHOP } }) + await prisma.productVariant.count({ where: { clientId: SHOP } }) + await prisma.user.count({ where: { clientId: SHOP } });
      console.log(`\nremoved ${SHOP}, rows left: ${left}`);
    } catch (e) {
      console.error(`\nCOULD NOT REMOVE ${SHOP}:`, e);
      failed++;
    }
    console.log(`\n${passed} passed, ${failed} failed`);
    await prisma.$disconnect();
    process.exit(failed ? 1 : 0);
  });
