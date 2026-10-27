/**
 * Refill the shop floor (27 Oct): the list of what to carry from the back room to the floor.
 *
 * A throwaway shop with two floor shelves and three back-room shelves, and one item for every case
 * the list has to get right: emptied by a sale (goes back to the floor shelf it was last on), short by
 * one (comes off the first back shelf on the walk), never on the floor (no shelf named), enough on the
 * floor (not listed), every back-room piece held for an order (not listed), an archived product (not
 * listed). Then the walk order, the split across shelves, carrying a line with the ordinary move, the
 * rule/ledger/legs check, and the refusals.
 *
 *   VERIFY_API_URL=http://localhost:4016/api/v1 npx tsx src/scripts/verify-shelves-refill.ts
 */
import axios, { AxiosInstance } from 'axios';
import { prisma } from '../lib/prisma';
import { AuthService } from '../services/auth.service';
import { seedRolesForClient } from '../services/rbac-seed.service';
import { platformAdminService } from '../services/platform-admin.service';
import { inventoryMutationService } from '../services/inventory-mutation.service';

const BASE = process.env.VERIFY_API_URL || 'http://localhost:4006/api/v1';
const STAMP = Date.now();
const SHOP = `refill-${STAMP}`;
const OTHER = `refill-other-${STAMP}`;

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
async function person(clientId: string, name: string, roleId: string) {
  const u = await prisma.user.create({ data: { clientId, email: `refill-${name.toLowerCase()}-${clientId}@example.com`, name, password: 'unused', status: 'ACTIVE' } });
  await prisma.userRole.create({ data: { userId: u.id, roleId } });
  return AuthService.generateToken({ userId: u.id, clientId });
}

async function agree(label: string) {
  const rule = await prisma.$queryRaw<{ n: bigint }[]>`
    SELECT COUNT(*) AS n FROM (
      SELECT ss.variant_id, ss.location_id FROM spot_stocks ss
      LEFT JOIN inventory_stocks s ON s.variant_id = ss.variant_id AND s.location_id = ss.location_id
      WHERE ss.client_id = ${SHOP} GROUP BY ss.variant_id, ss.location_id
      HAVING SUM(ss.quantity) > COALESCE(MAX(s.quantity), 0) OR MIN(ss.quantity) < 0) t`;
  const legs = await prisma.$queryRaw<{ n: bigint }[]>`
    SELECT COUNT(*) AS n FROM (SELECT spot_id, variant_id, SUM(quantity) AS legs FROM inventory_transaction_spots WHERE client_id = ${SHOP} AND spot_id IS NOT NULL GROUP BY spot_id, variant_id) l
    FULL OUTER JOIN (SELECT spot_id, variant_id, quantity FROM spot_stocks WHERE client_id = ${SHOP}) ss ON ss.spot_id = l.spot_id AND ss.variant_id = l.variant_id
    WHERE COALESCE(l.legs, 0) <> COALESCE(ss.quantity, 0)`;
  check(`${label}: shelf rule holds and shelf legs add up`, Number(rule[0].n) === 0 && Number(legs[0].n) === 0, `rule ${rule[0].n}, legs ${legs[0].n}`);
}

async function main() {
  console.log(`SETUP ${SHOP}`);
  const roles = await seedRolesForClient(SHOP);
  const rolesB = await seedRolesForClient(OTHER);
  await prisma.clientSettings.create({ data: { clientId: SHOP, businessName: 'Refill Test Sarees' } });
  const ownerT = await person(SHOP, 'Owner', roles.SUPER_ADMIN);
  const warehouseT = await person(SHOP, 'Warehouse', roles.WAREHOUSE);
  const salesT = await person(SHOP, 'Sales', roles.SALES);
  const intruderT = await person(OTHER, 'Intruder', rolesB.SUPER_ADMIN);
  const store = await prisma.stockLocation.create({ data: { clientId: SHOP, name: 'Main Store', code: 'MAIN', type: 'STORE', active: true } });
  const owner = api(ownerT, store.id), warehouse = api(warehouseT, store.id), sales = api(salesT, store.id), intruder = api(intruderT);
  const refill = (who: AxiosInstance, min?: number | string) => who.get(`/shelves/locations/${store.id}/refill`, { params: min === undefined ? {} : { min } });

  const product = await prisma.product.create({ data: { clientId: SHOP, title: 'Kanchi Silk', productCode: `RF-${STAMP}`, slug: `rf-${STAMP}`, category: 'WOMEN', productType: 'READY_TO_WEAR', basePrice: 1000, status: 'ACTIVE' } });
  const old = await prisma.product.create({ data: { clientId: SHOP, title: 'Old Cotton', productCode: `RFO-${STAMP}`, slug: `rfo-${STAMP}`, category: 'WOMEN', productType: 'READY_TO_WEAR', basePrice: 500, status: 'ACTIVE' } });
  const mk = (c: string, productId = product.id) => prisma.productVariant.create({ data: { clientId: SHOP, productId, sku: `RF-${c}-${STAMP}`, variantCode: `V-RF-${c}-${STAMP}`, colorName: c, size: 'Free Size', sellingPrice: 1000, costPrice: 600, averageCost: 600 } });
  const red = await mk('RED'), blue = await mk('BLUE'), gold = await mk('GOLD'), green = await mk('GREEN'), pink = await mk('PINK'), black = await mk('BLACK', old.id);

  // ── No shop floor yet ────────────────────────────────────────────────────────────────────
  console.log('\n1. BEFORE ANY SHELF IS SHOP FLOOR');
  const back1 = await owner.post(`/shelves/locations/${store.id}/spots/import`, { rows: [
    { address: 'BACK-R1-1', shopFloor: 'no' }, { address: 'BACK-R1-2', shopFloor: 'no' }, { address: 'BACK-R2-1', shopFloor: 'no' }
  ] });
  const none = await refill(owner);
  check('with only back-room shelves the list says the shop has no floor shelves (not an empty "all stocked")', none.status === 200 && none.data.data.usesFloorShelves === false && none.data.data.lines.length === 0, brief(none));
  const floor = await owner.post(`/shelves/locations/${store.id}/spots/import`, { rows: [{ address: 'FLOOR-A-1', shopFloor: 'yes' }, { address: 'FLOOR-A-2', shopFloor: 'yes' }] });
  check('layout created', back1.status === 201 && floor.status === 201, `${brief(back1)} | ${brief(floor)}`);

  // ── Stock and shelves ────────────────────────────────────────────────────────────────────
  console.log('\n2. STOCK ON THE SHELVES');
  const spot = async (address: string) => (await prisma.storageSpot.findFirstOrThrow({ where: { clientId: SHOP, locationId: store.id, address } })).id;
  const S = { F1: await spot('FLOOR-A-1'), F2: await spot('FLOOR-A-2'), B11: await spot('BACK-R1-1'), B12: await spot('BACK-R1-2'), B21: await spot('BACK-R2-1') };
  const stockIn = async (variantId: string, quantity: number) => {
    const r = await owner.post('/inventory/stock-in', { variantId, quantity, reason: 'PURCHASE', unitCost: 600, locationId: store.id });
    if (r.status >= 300) check(`stock in ${quantity}`, false, brief(r));
  };
  const put = async (variantId: string, spotId: string, quantity: number) => {
    const r = await warehouse.post('/shelves/putaway', { locationId: store.id, variantId, spotId, quantity });
    if (r.status !== 200) check(`put away ${quantity}`, false, brief(r));
  };
  // Red: 2 on FLOOR-A-2, 5 in the back; then the till sells the 2 on the floor.
  await stockIn(red.id, 7); await put(red.id, S.F2, 2); await put(red.id, S.B21, 5);
  await inventoryMutationService.applyMovement({ clientId: SHOP, variantId: red.id, locationId: store.id, movementType: 'OUT', reason: 'SALE', quantityDelta: -2, notes: 'verify-shelves-refill: till sale', createdBy: 'verify-shelves-refill' } as any);
  // Blue: 1 on the floor, 1 + 3 in the back. Gold: 2 on the floor (enough), 4 in the back.
  await stockIn(blue.id, 5); await put(blue.id, S.F1, 1); await put(blue.id, S.B11, 1); await put(blue.id, S.B12, 3);
  await stockIn(gold.id, 6); await put(gold.id, S.F1, 2); await put(gold.id, S.B12, 4);
  // Green: never on the floor. Pink: all 3 promised to orders. Black: its product is archived.
  await stockIn(green.id, 3); await put(green.id, S.B21, 3);
  await stockIn(pink.id, 3); await put(pink.id, S.B11, 3);
  await prisma.inventoryStock.update({ where: { variantId_locationId: { variantId: pink.id, locationId: store.id } }, data: { reservedQty: 3 } });
  await stockIn(black.id, 3); await put(black.id, S.B12, 3);
  await prisma.product.update({ where: { id: old.id }, data: { status: 'ARCHIVED' } });
  const redFloor = await prisma.spotStock.findFirst({ where: { variantId: red.id, spotId: S.F2 } });
  check('the till sale took red off the floor first (FLOOR-A-2 now empty, back room untouched)', (redFloor?.quantity ?? 0) === 0 && (await prisma.spotStock.findFirst({ where: { variantId: red.id, spotId: S.B21 } }))?.quantity === 5);
  await agree('after stocking');

  // ── The list ─────────────────────────────────────────────────────────────────────────────
  console.log('\n3. THE LIST (keep 2 on the floor)');
  const list = await refill(warehouse);
  const lines: any[] = list.data?.data?.lines ?? [];
  const of = (v: { id: string }) => lines.filter(l => l.variantId === v.id);
  check('the warehouse person gets the list', list.status === 200 && list.data.data.usesFloorShelves === true && list.data.data.minOnFloor === 2, brief(list));
  const r = of(red)[0];
  check('red (sold off the floor): carry 2 from BACK-R2-1 back to FLOOR-A-2, the shelf it was last on', of(red).length === 1 && r.quantity === 2 && r.from.address === 'BACK-R2-1' && r.to?.address === 'FLOOR-A-2' && r.onFloor === 0 && r.inBackRoom === 5, JSON.stringify(of(red)));
  check('red shows it sold 2 this week', r?.soldLast7Days === 2, String(r?.soldLast7Days));
  const b = of(blue)[0];
  check('blue (1 on the floor): carry 1 from BACK-R1-1, the first back shelf on the walk, to FLOOR-A-1 where it already is', of(blue).length === 1 && b.quantity === 1 && b.from.address === 'BACK-R1-1' && b.to?.address === 'FLOOR-A-1', JSON.stringify(of(blue)));
  const g = of(green)[0];
  check('green (never on the floor): carry 2, no floor shelf named, the person chooses', of(green).length === 1 && g.quantity === 2 && g.to === null, JSON.stringify(of(green)));
  check('gold (2 already on the floor) is not listed', of(gold).length === 0, JSON.stringify(of(gold)));
  check('pink (every back-room piece held for an order) is not listed', of(pink).length === 0, JSON.stringify(of(pink)));
  check('black (archived product) is not listed', of(black).length === 0, JSON.stringify(of(black)));
  check('one walk: BACK-R1-1 first, then BACK-R2-1', lines.map(l => l.from.address).join() === 'BACK-R1-1,BACK-R2-1,BACK-R2-1', lines.map(l => l.from.address).join());
  check('inside BACK-R2-1 the faster seller (red, sold 2) comes before green', lines[1]?.variantId === red.id && lines[2]?.variantId === green.id, lines.map(l => l.colorName).join());
  check('each line carries what the screen shows (title, sku, colour, size)', lines.every(l => l.title && l.sku && l.colorName && l.size && 'imageUrl' in l && !('walkKey' in l)), JSON.stringify(lines[0]));

  console.log('\n4. KEEP 4 ON THE FLOOR');
  const four = await refill(warehouse, 4);
  const blue4 = (four.data?.data?.lines ?? []).filter((l: any) => l.variantId === blue.id);
  check('blue needs 3: 1 from BACK-R1-1 and 2 from BACK-R1-2, split in walking order', blue4.map((l: any) => `${l.from.address}:${l.quantity}`).join() === 'BACK-R1-1:1,BACK-R1-2:2', JSON.stringify(blue4));
  const gold4 = (four.data?.data?.lines ?? []).filter((l: any) => l.variantId === gold.id);
  check('gold now needs 2 more from BACK-R1-2 to FLOOR-A-1', gold4.length === 1 && gold4[0].quantity === 2 && gold4[0].to?.address === 'FLOOR-A-1', JSON.stringify(gold4));
  const red4 = (four.data?.data?.lines ?? []).filter((l: any) => l.variantId === red.id);
  check('red needs 4 and the back room has 5: carry 4', red4.length === 1 && red4[0].quantity === 4, JSON.stringify(red4));
  const green4 = (four.data?.data?.lines ?? []).filter((l: any) => l.variantId === green.id);
  check('green needs 4 but only 3 exist: carry all 3, never more than there is', green4.length === 1 && green4[0].quantity === 3, JSON.stringify(green4));

  // ── Carrying ─────────────────────────────────────────────────────────────────────────────
  console.log('\n5. CARRYING WITH THE ORDINARY MOVE');
  const moveRed = await warehouse.post('/shelves/move', { locationId: store.id, variantId: red.id, fromSpotId: r.from.spotId, toSpotId: r.to.spotId, quantity: r.quantity });
  const moveGreen = await warehouse.post('/shelves/move', { locationId: store.id, variantId: green.id, fromSpotId: g.from.spotId, toSpotId: S.F1, quantity: 1 });
  check('red carried; green carried, but only 1 of 2 (found fewer)', moveRed.status === 200 && moveGreen.status === 200, `${brief(moveRed)} | ${brief(moveGreen)}`);
  const after = (await refill(warehouse)).data?.data?.lines ?? [];
  check('red leaves the list', !after.some((l: any) => l.variantId === red.id), JSON.stringify(after));
  const g2 = after.find((l: any) => l.variantId === green.id);
  check('green stays with 1 left, now going to FLOOR-A-1 where it is', g2?.quantity === 1 && g2?.to?.address === 'FLOOR-A-1', JSON.stringify(g2));
  const moveAgain = await warehouse.post('/shelves/move', { locationId: store.id, variantId: red.id, fromSpotId: r.from.spotId, toSpotId: r.to.spotId, quantity: 4 });
  check('pressing Moved for more than the back shelf holds is refused cleanly', moveAgain.status >= 400 && moveAgain.status < 500, brief(moveAgain));
  await agree('after carrying');

  // ── Refusals ─────────────────────────────────────────────────────────────────────────────
  console.log('\n6. REFUSALS');
  for (const bad of [0, -1, 'abc', 1.5, 5000]) {
    const res = await refill(owner, bad);
    check(`min=${bad} is refused with a plain sentence`, res.status === 400 && typeof res.data?.message === 'string' && !/prisma|NaN|undefined/i.test(res.data.message), brief(res));
  }
  const salesRes = await refill(sales);
  check('a sales person (shelf view only) cannot open the refill list', salesRes.status === 403, brief(salesRes));
  const intruderRes = await refill(intruder);
  check('another shop cannot read this shop\'s list', intruderRes.status === 404 || intruderRes.status === 403, brief(intruderRes));
  const unknown = await owner.get(`/shelves/locations/00000000-0000-0000-0000-000000000000/refill`);
  check('an unknown location is a 404, not a crash', unknown.status === 404, brief(unknown));

  check('no request produced a server error', serverErrors.length === 0, serverErrors.slice(0, 5).join(' | '));
}

async function cleanup() {
  for (const id of [SHOP, OTHER]) {
    await platformAdminService.deleteClientCompletely(id, id).catch((e: any) => { if (!/No such client/.test(e?.message)) console.log('cleanup', id, e?.message); });
  }
  const left = await prisma.storageSpot.count({ where: { clientId: { in: [SHOP, OTHER] } } }) + await prisma.user.count({ where: { clientId: { in: [SHOP, OTHER] } } });
  check('both throwaway shops are gone', left === 0, String(left));
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
