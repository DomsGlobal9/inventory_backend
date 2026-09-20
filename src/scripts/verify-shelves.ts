/**
 * Racks and shelves, end to end through the API, against throwaway shops.
 *
 *   A  the rack tree: quick create, mixed depths, refusals, same address in another location
 *   B  put away, find, move, take off; refusals in words
 *   C  till sales (a real counter sale): floor first in walking order, one ledger row with legs
 *   D  everything else that moves stock: stock-out, damage with a shelf, transfer, stock count,
 *      purchase-style stock-in, sale beyond the floor (back room issue)
 *   E  a move is invisible to the day book, reports, dashboard, ledger and the item's last movement
 *   F  concurrency: last pieces sold twice at once; one shelf emptied twice at once; sale vs put-away
 *   G  the database guard: raw writes that break the rule are refused at commit
 *   H  changing the tree: new address keeps labels working, switch off / delete refused while stocked
 *   I  who may do what, and another shop's ids
 *   J  shelf issues: listed, resolved once
 *   K  deleting a location with an empty tree, and the whole shop
 *
 * After every step that moves stock the rule is checked straight from the database:
 *   shelf total <= location quantity, and no shelf below zero.
 *
 * Run against the high-limit config (it sends several hundred requests):
 *   npx tsx src/scripts/verify-shelves.ts
 */
import axios, { AxiosInstance } from 'axios';
import crypto from 'crypto';
import { prisma } from '../lib/prisma';
import { AuthService } from '../services/auth.service';
import { seedRolesForClient } from '../services/rbac-seed.service';
import { platformAdminService } from '../services/platform-admin.service';
import { inventoryMutationService } from '../services/inventory-mutation.service';
import { stockCountService } from '../services/stock-count.service';

const BASE = process.env.VERIFY_API_URL || 'http://localhost:4006/api/v1';
const STAMP = Date.now();
const SHOP = `shelves-${STAMP}`;
const OTHER = `shelves-other-${STAMP}`;

let passed = 0;
const failures: string[] = [];
const check = (name: string, ok: boolean, detail = '') => {
  if (ok) { passed++; if (!process.env.QUIET) console.log(`  ok   ${name}`); }
  else { failures.push(`${name} :: ${detail}`); console.log(`  FAIL ${name} :: ${detail}`); }
};
const brief = (r: any) => `${r.status} ${JSON.stringify(r.data).slice(0, 240)}`;
const leaks = (r: any) => /prisma|Invalid `|constraint|P20\d\d|storage_spot_tree|shelf_stock_exceeds|spot_stock:|at [A-Za-z]+ \(/i.test(JSON.stringify(r.data ?? ''));
const api = (token: string): AxiosInstance => axios.create({ baseURL: BASE, headers: { Authorization: `Bearer ${token}` }, validateStatus: () => true, timeout: 120_000 });

async function person(clientId: string, name: string, roleId: string) {
  const u = await prisma.user.create({ data: { clientId, email: `shelves-${name.toLowerCase()}-${clientId}@example.com`, name, password: 'unused', status: 'ACTIVE' } });
  await prisma.userRole.create({ data: { userId: u.id, roleId } });
  return { id: u.id, http: api(AuthService.generateToken({ userId: u.id, clientId })) };
}

/** The rule, read straight from the database, for every variant and location of the shop. */
async function ruleHolds(clientId = SHOP): Promise<string> {
  const rows = await prisma.$queryRaw<{ variant_id: string; location_id: string; shelved: bigint; official: number | null; negative: bigint }[]>`
    SELECT ss.variant_id, ss.location_id, SUM(ss.quantity) AS shelved, MAX(s.quantity) AS official, SUM(CASE WHEN ss.quantity < 0 THEN 1 ELSE 0 END) AS negative
    FROM spot_stocks ss LEFT JOIN inventory_stocks s ON s.variant_id = ss.variant_id AND s.location_id = ss.location_id
    WHERE ss.client_id = ${clientId}
    GROUP BY ss.variant_id, ss.location_id`;
  const bad = rows.filter(r => Number(r.shelved) > (r.official ?? 0) || Number(r.negative) > 0);
  return bad.map(b => `${b.variant_id}@${b.location_id}: shelves ${b.shelved} > ${b.official}`).join('; ');
}
const onShelf = async (spotId: string, variantId: string) => (await prisma.spotStock.findUnique({ where: { spotId_variantId: { spotId, variantId } } }))?.quantity ?? 0;
const official = async (variantId: string, locationId: string) => (await prisma.inventoryStock.findUnique({ where: { variantId_locationId: { variantId, locationId } } }))?.quantity ?? 0;
const setShelves = async (variantId: string, locationId: string, total: number, shelves: Record<string, number>) => {
  // Test set-up only: stock in the location and on shelves, written in one transaction the rule accepts.
  await prisma.$transaction(async tx => {
    await tx.spotStock.deleteMany({ where: { variantId, locationId } });
    await tx.inventoryStock.upsert({ where: { variantId_locationId: { variantId, locationId } }, update: { quantity: total, reservedQty: 0 }, create: { clientId: SHOP, variantId, locationId, quantity: total } });
    for (const [spotId, quantity] of Object.entries(shelves)) {
      if (quantity > 0) await tx.spotStock.create({ data: { clientId: SHOP, locationId, spotId, variantId, quantity } });
    }
  });
};

async function main() {
  console.log(`SETUP ${SHOP}`);
  const roles = await seedRolesForClient(SHOP);
  const rolesB = await seedRolesForClient(OTHER);
  await prisma.clientSettings.create({ data: { clientId: SHOP, businessName: 'Shelf Test Sarees' } });
  const owner = await person(SHOP, 'Owner', roles.SUPER_ADMIN);
  const manager = await person(SHOP, 'InvManager', roles.INVENTORY_MANAGER);
  const warehouse = await person(SHOP, 'Warehouse', roles.WAREHOUSE);
  const sales = await person(SHOP, 'Sales', roles.SALES);
  const empty = await prisma.role.create({ data: { clientId: SHOP, name: 'NOTHING' } });
  const nobody = await person(SHOP, 'Nobody', empty.id);
  const intruder = await person(OTHER, 'Intruder', rolesB.SUPER_ADMIN);

  const store = await prisma.stockLocation.create({ data: { clientId: SHOP, name: 'Main Store', code: 'MAIN-STORE', type: 'STORE', active: true } });
  const godown = await prisma.stockLocation.create({ data: { clientId: SHOP, name: 'Godown', code: 'GODOWN', type: 'WAREHOUSE', active: true } });
  const spare = await prisma.stockLocation.create({ data: { clientId: SHOP, name: 'Pop-up', code: 'POPUP', type: 'STORE', active: true } });
  const product = await prisma.product.create({ data: { clientId: SHOP, title: 'Silk Saree', productCode: `SH-${STAMP}`, slug: `sh-${STAMP}`, category: 'WOMEN', productType: 'READY_TO_WEAR', basePrice: 1000, status: 'ACTIVE' } });
  const mk = (sku: string, color: string) => prisma.productVariant.create({ data: { clientId: SHOP, productId: product.id, sku: `${sku}-${STAMP}`, variantCode: `V-${sku}-${STAMP}`, colorName: color, size: 'Free', sellingPrice: 1000, costPrice: 600, averageCost: 600, barcode: `77${sku}${STAMP}` } });
  const red = await mk('RED', 'Red');
  const blue = await mk('BLUE', 'Blue');
  const green = await mk('GREEN', 'Green');
  const gold = await mk('GOLD', 'Gold');
  for (const v of [red, blue, green, gold]) {
    await inventoryMutationService.applyMovement({ clientId: SHOP, variantId: v.id, locationId: store.id, movementType: 'IN', reason: 'INITIAL_STOCK', quantityDelta: 9, unitCost: 600 });
  }

  // ── A. The rack tree ──────────────────────────────────────────────────────────────────────────
  console.log('\nA. THE RACK TREE');
  const own = owner.http;
  const preview = await own.post(`/shelves/locations/${store.id}/spots/bulk`, { isShopFloor: true, levels: [{ kind: 'AREA', range: { codes: ['floor'] } }, { kind: 'CUPBOARD', range: { from: 1, to: 2, prefix: 'C' } }, { kind: 'SHELF', range: { from: 1, to: 2 } }], preview: true });
  check('quick create preview: FLOOR, C1-C2, shelves 1-2 = 7 spots, nothing saved', preview.status === 200 && preview.data.data.create === 7 && preview.data.data.saved === false && (await prisma.storageSpot.count({ where: { clientId: SHOP } })) === 0, brief(preview));
  const made = await own.post(`/shelves/locations/${store.id}/spots/bulk`, { isShopFloor: true, levels: [{ kind: 'AREA', range: { codes: ['floor'] } }, { kind: 'CUPBOARD', range: { from: 1, to: 2, prefix: 'C' } }, { kind: 'SHELF', range: { from: 1, to: 2 } }] });
  check('  ...saved: 7 created (201)', made.status === 201 && made.data.data.create === 7 && made.data.data.saved === true, brief(made));
  const again = await own.post(`/shelves/locations/${store.id}/spots/bulk`, { isShopFloor: true, levels: [{ kind: 'AREA', range: { codes: ['FLOOR'] } }, { kind: 'CUPBOARD', range: { from: 1, to: 3, prefix: 'C' } }] });
  check('  ...running it again with C1-C3 reuses FLOOR, C1, C2 and makes only C3', again.status === 201 && again.data.data.create === 1 && again.data.data.alreadyThere === 3, brief(again));
  const back = await own.post(`/shelves/locations/${store.id}/spots/bulk`, { isShopFloor: false, levels: [{ kind: 'AREA', range: { codes: ['STORE'] } }, { kind: 'RACK', range: { from: 4, to: 4, pad: 2, prefix: 'R' } }, { kind: 'SHELF', range: { from: 1, to: 2 } }, { kind: 'BOX', range: { letterFrom: 'A', letterTo: 'B' } }] });
  check('back room: STORE-R04-1..2-A..B, 4 levels deep', back.status === 201 && back.data.data.create === 1 + 1 + 2 + 4, brief(back));
  const spot = async (address: string, locationId = store.id) => prisma.storageSpot.findFirstOrThrow({ where: { clientId: SHOP, locationId, address } });
  const c1s1 = await spot('FLOOR-C1-1'), c1s2 = await spot('FLOOR-C1-2'), c2s1 = await spot('FLOOR-C2-1'), c2s2 = await spot('FLOOR-C2-2'), c3 = await spot('FLOOR-C3');
  const boxA = await spot('STORE-R04-1-A'), boxB = await spot('STORE-R04-1-B'), box2A = await spot('STORE-R04-2-A');
  check('shop floor is inherited by everything under FLOOR, back room by everything under STORE', c1s1.isShopFloor && c3.isShopFloor && !boxA.isShopFloor && !box2A.isShopFloor);
  const floor = await spot('FLOOR');
  const rail = await own.post(`/shelves/locations/${store.id}/spots`, { parentId: floor.id, kind: 'RAIL', code: 'r1', name: 'Kurtis rail' });
  const railM = rail.status === 201 ? await own.post(`/shelves/locations/${store.id}/spots`, { parentId: rail.data.data.id, kind: 'RAIL_SECTION', code: 'M' }) : rail;
  check('mixed depth: a rail with a size section beside cupboards with shelves (FLOOR-R1-M)', rail.status === 201 && railM.status === 201 && railM.data.data.address === 'FLOOR-R1-M' && railM.data.data.isShopFloor === true, `${brief(rail)} | ${brief(railM)}`);
  const mannequin = await own.post(`/shelves/locations/${store.id}/spots`, { parentId: floor.id, kind: 'DISPLAY', code: 'M1', capacity: 1 });
  check('a display at depth 2 holding stock directly (FLOOR-M1, capacity 1)', mannequin.status === 201 && mannequin.data.data.address === 'FLOOR-M1', brief(mannequin));

  const refusals: [string, any, any, number][] = [
    ['depth 5', `/shelves/locations/${store.id}/spots`, { parentId: boxA.id, kind: 'OTHER', code: 'X' }, 400],
    ['a code with a dash', `/shelves/locations/${store.id}/spots`, { parentId: floor.id, kind: 'RACK', code: 'R-9' }, 400],
    ['a code of 13 characters', `/shelves/locations/${store.id}/spots`, { parentId: floor.id, kind: 'RACK', code: 'ABCDEFGHIJKLM' }, 400],
    ['a duplicate address', `/shelves/locations/${store.id}/spots`, { parentId: floor.id, kind: 'CUPBOARD', code: 'c1' }, 409],
    ['shop floor set on a shelf', `/shelves/locations/${store.id}/spots`, { parentId: floor.id, kind: 'RACK', code: 'R7', isShopFloor: false }, 400],
    ['an unknown field (clientId)', `/shelves/locations/${store.id}/spots`, { kind: 'AREA', code: 'Z', clientId: OTHER }, 400],
    ['a parent in another location', `/shelves/locations/${godown.id}/spots`, { parentId: floor.id, kind: 'RACK', code: 'R1' }, 404],
    ['a bulk create over 2000', `/shelves/locations/${store.id}/spots/bulk`, { levels: [{ kind: 'AREA', range: { codes: ['BIG'] } }, { kind: 'RACK', range: { from: 1, to: 50 } }, { kind: 'SHELF', range: { from: 1, to: 50 } }] }, 400],
    ['a bulk create 5 levels deep', `/shelves/locations/${store.id}/spots/bulk`, { levels: [1, 2, 3, 4, 5].map(() => ({ kind: 'OTHER', range: { codes: ['A'] } })) }, 400]
  ];
  for (const [label, url, body, status] of refusals) {
    const r = await own.post(url, body);
    check(`refused: ${label} (${status}), in words`, r.status === status && typeof r.data?.message === 'string' && !leaks(r), brief(r));
  }
  const godownFloor = await own.post(`/shelves/locations/${godown.id}/spots`, { kind: 'AREA', code: 'FLOOR' });
  check('the same address FLOOR in another location is fine', godownFloor.status === 201, brief(godownFloor));
  const tree = await own.get(`/shelves/locations/${store.id}/spots`);
  const roots = tree.data?.data?.spots ?? [];
  check('the tree comes back in walking order: FLOOR before STORE, C1 before C2 before C3, then R1, M1', roots.map((r: any) => r.address).join() === 'FLOOR,STORE' && roots[0].children.map((c: any) => c.address).join() === 'FLOOR-C1,FLOOR-C2,FLOOR-C3,FLOOR-R1,FLOOR-M1', JSON.stringify(roots.map((r: any) => [r.address, r.children.map((c: any) => c.address)])));

  // ── A2. Describe your shop: one plan behind preview and save ──────────────────────
  console.log('\nA2. DESCRIBE YOUR SHOP (perParent, conflicts, preview = save)');
  {
    const bulk = (body: any) => own.post(`/shelves/locations/${godown.id}/spots/bulk`, body);
    const spec = (racks: number, perParent?: number[]) => ({
      levels: [
        { kind: 'AREA', range: { codes: ['BACK'] } },
        { kind: 'RACK', range: { from: 1, to: racks, prefix: 'R', pad: 2 } },
        { kind: 'SHELF', range: { from: 1, to: 6 }, perParent }
      ],
      isShopFloor: false
    });

    const pv = await bulk({ ...spec(5, [6, 4, 4, 5, 3]), preview: true });
    check('each rack its own number of shelves: preview says 1 + 5 + 22 = 28, nothing saved', pv.status === 200 && pv.data.data.create === 28 && pv.data.data.saved === false && (await prisma.storageSpot.count({ where: { clientId: SHOP, locationId: godown.id, address: { startsWith: 'BACK' } } })) === 0, brief(pv));
    const previewAddresses = pv.data.data.addresses;
    const saved = await bulk(spec(5, [6, 4, 4, 5, 3]));
    const reallyThere = (await prisma.storageSpot.findMany({ where: { clientId: SHOP, locationId: godown.id, address: { startsWith: 'BACK' } }, select: { address: true }, orderBy: { address: 'asc' } })).map(r => r.address);
    check('  ...saved: 28 created, and the shop really holds 28', saved.data.data.create === 28 && reallyThere.length === 28, brief(saved));
    check('  ...what preview showed is what save created (R3)', previewAddresses.every((a: string) => reallyThere.includes(a)) && saved.data.data.addresses.every((a: string) => previewAddresses.includes(a)), JSON.stringify({ previewAddresses: previewAddresses.length }));
    check('  ...R02 has 4 shelves and R05 has 3', reallyThere.filter(a => a.startsWith('BACK-R02-')).length === 4 && reallyThere.filter(a => a.startsWith('BACK-R05-')).length === 3, reallyThere.filter(a => a.startsWith('BACK-R05-')).join());

    const twice = await bulk(spec(5, [6, 4, 4, 5, 3]));
    check('answering the same again creates nothing (R2)', twice.data.data.create === 0 && twice.data.data.alreadyThere === 28, brief(twice));
    const fewer = await bulk(spec(3, [6, 4, 4]));
    check('answering with fewer racks removes nothing', fewer.data.data.create === 0 && (await prisma.storageSpot.count({ where: { clientId: SHOP, locationId: godown.id, address: { startsWith: 'BACK' } } })) === 28, brief(fewer));

    const badLength = await bulk(spec(5, [6, 4]));
    check('a per-rack list of the wrong length: 400, saying how many are needed', badLength.status === 400 && /one number for each of the 5/.test(badLength.data.message), brief(badLength));
    const badNumber = await bulk(spec(5, [6, 4, 4, 5, 99]));
    check('more shelves than codes named: 400, in words', badNumber.status === 400 && /more than the 6 codes/.test(badNumber.data.message), brief(badNumber));

    // P1: a rack the shop switched off. P3: it must not stop the other racks.
    const r03 = await prisma.storageSpot.findFirstOrThrow({ where: { clientId: SHOP, locationId: godown.id, address: 'BACK-R03' } });
    await prisma.storageSpot.updateMany({ where: { id: { in: [r03.id] } }, data: { active: false } });
    const withOff = await bulk({ levels: [{ kind: 'AREA', range: { codes: ['BACK'] } }, { kind: 'RACK', range: { from: 1, to: 6, prefix: 'R', pad: 2 } }, { kind: 'SHELF', range: { from: 1, to: 6 }, perParent: [6, 4, 6, 5, 3, 2] }], isShopFloor: false });
    check('a switched-off rack is left out and said so (P1)', withOff.data.data.conflictCount >= 1 && withOff.data.data.conflicts.some((c: any) => c.address === 'BACK-R03' && /switched off/.test(c.reason)), brief(withOff));
    check('  ...no new shelf is made inside it: the 6 asked for are skipped, and it keeps the 4 it had', withOff.data.data.skipped === 6 && !withOff.data.data.addresses.some((a: string) => a.startsWith('BACK-R03-')) && (await prisma.storageSpot.count({ where: { clientId: SHOP, locationId: godown.id, address: { startsWith: 'BACK-R03-' } } })) === 4, brief(withOff));
    check('  ...and the new rack R06 with its 2 shelves is still created (P3)', withOff.data.data.create === 3 && !!(await prisma.storageSpot.findFirst({ where: { clientId: SHOP, locationId: godown.id, address: 'BACK-R06-2' } })), brief(withOff));
    check('  ...the switched-off rack is still switched off afterwards (nothing was changed)', (await prisma.storageSpot.findUniqueOrThrow({ where: { id: r03.id } })).active === false);
    await prisma.storageSpot.updateMany({ where: { id: r03.id }, data: { active: true } });

    // P2: a rack renamed since. The answer must not build a second one beside it.
    const r05 = await prisma.storageSpot.findFirstOrThrow({ where: { clientId: SHOP, locationId: godown.id, address: 'BACK-R05' } });
    const renamed = await own.patch(`/shelves/spots/${r05.id}`, { code: 'SILK' });
    const afterRename = await bulk(spec(5, [6, 4, 4, 5, 3]));
    check('a rack renamed to SILK is not made a second time (P2)', renamed.status === 200 && !afterRename.data.data.addresses.includes('BACK-R05') && afterRename.data.data.conflicts.some((c: any) => c.address === 'BACK-R05' && /renamed to BACK-SILK/.test(c.reason)), brief(afterRename));
    check('  ...and no second R05 exists', (await prisma.storageSpot.count({ where: { clientId: SHOP, locationId: godown.id, address: 'BACK-R05' } })) === 0);

    // Two people pressing Create at the same moment: the location lock puts them in a queue.
    const both = await Promise.all([bulk(spec(8, [1, 1, 1, 1, 1, 1, 1, 1])), bulk(spec(8, [1, 1, 1, 1, 1, 1, 1, 1]))]);
    const wanted = ['BACK-R07', 'BACK-R08', 'BACK-R07-1', 'BACK-R08-1'];
    const rows = await prisma.storageSpot.findMany({ where: { clientId: SHOP, locationId: godown.id, address: { in: wanted } }, select: { address: true } });
    const createdBetweenThem = both.reduce((t, r) => t + (r.data?.data?.create ?? 0), 0);
    check('two answers at the same moment: each spot exists exactly once', rows.length === wanted.length && new Set(rows.map(r => r.address)).size === wanted.length, rows.map(r => r.address).join());
    check('  ...and between them they claim to have created it exactly once (the second one says "nothing new")', createdBetweenThem === wanted.length && both.every(r => r.status === 201 || r.status === 200), both.map(r => `${r.status}:${r.data?.data?.create}/${r.data?.data?.alreadyThere}`).join(' | '));
  }

  // ── B. Put away, find, move ───────────────────────────────────────────────────────────────────
  console.log('\nB. PUT AWAY, FIND, MOVE');
  const wh = warehouse.http;
  const notShelved0 = await wh.get(`/shelves/locations/${store.id}/not-shelved`);
  check('before anything is shelved, all 4 items are waiting to be put away (9 each)', notShelved0.status === 200 && notShelved0.data.data.total === 4 && notShelved0.data.data.items.every((i: any) => i.notShelved === 9), brief(notShelved0));
  const put1 = await wh.post('/shelves/putaway', { locationId: store.id, variantId: red.id, spotId: c1s1.id, quantity: 4 });
  const put2 = await wh.post('/shelves/putaway', { locationId: store.id, variantId: red.id, spotId: c2s1.id, quantity: 3 });
  check('put away 4 red on FLOOR-C1-1 and 3 on FLOOR-C2-1', put1.status === 200 && put2.status === 200 && await onShelf(c1s1.id, red.id) === 4 && await onShelf(c2s1.id, red.id) === 3, `${brief(put1)} | ${brief(put2)}`);
  check('  ...the location still holds 9 and Not shelved is 2', await official(red.id, store.id) === 9 && put2.data.data.item.places[0].notShelved === 2 && put2.data.data.item.places[0].onShelves === 7, brief(put2));
  const ledger = await prisma.inventoryTransaction.findMany({ where: { clientId: SHOP, variantId: red.id, reason: 'SHELF_MOVE' }, include: { spotLegs: true } });
  check('  ...each put-away is one SHELF_MOVE ledger row, quantity 0, balance unchanged, with one SCANNED leg', ledger.length === 2 && ledger.every(t => t.quantity === 0 && t.balanceBefore === 9 && t.balanceAfter === 9 && t.spotLegs.length === 1 && t.spotLegs[0].source === 'SCANNED'));
  const tooMany = await wh.post('/shelves/putaway', { locationId: store.id, variantId: red.id, spotId: c1s2.id, quantity: 3 });
  check('putting away 3 when 2 are not shelved: 409 "Only 2 pieces"', tooMany.status === 409 && /Only 2 pieces/.test(tooMany.data.message), brief(tooMany));
  const onCupboard = await wh.post('/shelves/putaway', { locationId: store.id, variantId: red.id, spotId: (await spot('FLOOR-C1')).id, quantity: 1 });
  check('putting away onto a cupboard that has shelves: 400', onCupboard.status === 400 && /inside it/.test(onCupboard.data.message), brief(onCupboard));
  const wrongPlace = await wh.post('/shelves/putaway', { locationId: godown.id, variantId: red.id, spotId: c1s1.id, quantity: 1 });
  check('a shelf in another location: 400, "use a transfer"', wrongPlace.status === 400 && /another location/.test(wrongPlace.data.message), brief(wrongPlace));
  const halfPiece = await wh.post('/shelves/putaway', { locationId: store.id, variantId: red.id, spotId: c1s2.id, quantity: 1.5 });
  const zero = await wh.post('/shelves/putaway', { locationId: store.id, variantId: red.id, spotId: c1s2.id, quantity: 0 });
  check('half a piece and zero pieces: 400', halfPiece.status === 400 && zero.status === 400, `${brief(halfPiece)} | ${brief(zero)}`);

  const findScan = await sales.http.get('/shelves/find', { params: { q: `77RED${STAMP}`, locationId: store.id } });
  const place = findScan.data?.data?.items?.[0]?.places?.[0];
  check('a salesperson scans the barcode: red at Main Store, FLOOR-C1-1 (4) then FLOOR-C2-1 (3), Not shelved 2', findScan.status === 200 && findScan.data.data.items.length === 1 && place?.shelves.map((s: any) => `${s.address}:${s.quantity}`).join() === 'FLOOR-C1-1:4,FLOOR-C2-1:3' && place.notShelved === 2, brief(findScan));
  const findWords = await sales.http.get('/shelves/find', { params: { q: 'silk blue' } });
  check('search by words "silk blue" finds the blue saree', findWords.status === 200 && findWords.data.data.items.length === 1 && findWords.data.data.items[0].colorName === 'Blue', brief(findWords));
  const findPercent = await sales.http.get('/shelves/find', { params: { q: '%' } });
  check('a "%" search matches nothing, not everything', findPercent.status === 200 && findPercent.data.data.items.length === 0, brief(findPercent));
  check('  ...and no cost appears in what a salesperson sees', !/averageCost|costPrice|unitCost|inventoryValue/.test(JSON.stringify(findScan.data)));

  const move = await wh.post('/shelves/move', { locationId: store.id, variantId: red.id, fromSpotId: c2s1.id, toSpotId: boxA.id, quantity: 2 });
  check('move 2 red from FLOOR-C2-1 to STORE-R04-1-A', move.status === 200 && await onShelf(c2s1.id, red.id) === 1 && await onShelf(boxA.id, red.id) === 2, brief(move));
  const moveTx = await prisma.inventoryTransaction.findFirst({ where: { clientId: SHOP, variantId: red.id, reason: 'SHELF_MOVE' }, orderBy: { createdAt: 'desc' }, include: { spotLegs: true } });
  check('  ...one ledger row with two legs: -2 and +2', moveTx?.spotLegs.length === 2 && moveTx.spotLegs.map(l => l.quantity).sort().join() === '-2,2');
  const overMove = await wh.post('/shelves/move', { locationId: store.id, variantId: red.id, fromSpotId: c2s1.id, toSpotId: boxA.id, quantity: 2 });
  check('moving 2 off a shelf holding 1: 409 "Only 1 piece"', overMove.status === 409 && /Only 1 piece /.test(overMove.data.message), brief(overMove));
  const sameShelf = await wh.post('/shelves/move', { locationId: store.id, variantId: red.id, fromSpotId: boxA.id, toSpotId: boxA.id, quantity: 1 });
  check('moving onto the same shelf: 400', sameShelf.status === 400, brief(sameShelf));
  const takeOff = await wh.post('/shelves/move', { locationId: store.id, variantId: red.id, fromSpotId: boxA.id, quantity: 1 });
  check('take 1 off STORE-R04-1-A back to Not shelved', takeOff.status === 200 && await onShelf(boxA.id, red.id) === 1 && takeOff.data.data.item.places[0].notShelved === 3, brief(takeOff));
  const mann = await wh.post('/shelves/putaway', { locationId: store.id, variantId: gold.id, spotId: mannequin.data.data.id, quantity: 2 });
  check('putting 2 on a mannequin meant for 1: saved, with a capacity warning (not a refusal)', mann.status === 200 && /more than the 1/.test(mann.data.data.warning ?? ''), brief(mann));
  const label = await wh.get('/shelves/spots/scan', { params: { code: `sez:${c1s1.labelCode.toLowerCase()}` } });
  check('scanning a shelf label (any case) opens that shelf with red 4 on it', label.status === 200 && label.data.data.spot.address === 'FLOOR-C1-1' && label.data.data.items[0]?.quantity === 4, brief(label));
  const typed = await wh.get('/shelves/spots/scan', { params: { code: 'floor - c1 - 1', locationId: store.id } });
  check('typing the address "floor - c1 - 1" opens the same shelf', typed.status === 200 && typed.data.data.spot.id === c1s1.id, brief(typed));
  check('the rule holds after section B', !(await ruleHolds()), await ruleHolds());

  // ── C. Till sales ─────────────────────────────────────────────────────────────────────────────
  console.log('\nC. TILL SALES');
  // The plan's worked example on blue: FLOOR-C1-2 4 (walked first), FLOOR-C2-2 3, Not shelved 2.
  await setShelves(blue.id, store.id, 9, { [c1s2.id]: 4, [c2s2.id]: 3 });
  const quote = await sales.http.post('/pricing/quote', { locationId: store.id, channel: 'POS', lines: [{ variantId: blue.id, quantity: 5 }] });
  const sale = quote.status === 200 ? await sales.http.post('/counter-sales', {
    saleId: crypto.randomUUID(), locationId: store.id, quoteId: quote.data.data.quoteId,
    customer: { phone: `9${String(STAMP).slice(-9)}`, name: 'Shelf Customer' },
    items: [{ variantId: blue.id, quantity: 5 }], payments: [{ method: 'CASH', amount: quote.data.data.total }]
  }) : quote;
  check('a real counter sale of 5 blue goes through', sale.status === 201, brief(sale));
  check('  ...FLOOR-C1-2 -4 (to 0), FLOOR-C2-2 -1 (to 2), Not shelved still 2, location 4', await onShelf(c1s2.id, blue.id) === 0 && await onShelf(c2s2.id, blue.id) === 2 && await official(blue.id, store.id) === 4);
  const saleTx = await prisma.inventoryTransaction.findMany({ where: { clientId: SHOP, variantId: blue.id, reason: 'SALE' }, include: { spotLegs: true } });
  check('  ...ONE sale row (-5) with TWO legs, both AUTO', saleTx.length === 1 && saleTx[0].quantity === -5 && saleTx[0].spotLegs.length === 2 && saleTx[0].spotLegs.every(l => l.source === 'AUTO') && saleTx[0].spotLegs.map(l => `${l.address}:${l.quantity}`).sort().join() === 'FLOOR-C1-2:-4,FLOOR-C2-2:-1', JSON.stringify(saleTx.map(t => [t.quantity, t.spotLegs.map(l => [l.address, l.quantity])])));
  check('  ...no shelf issue for an ordinary floor sale', (await prisma.shelfIssue.count({ where: { clientId: SHOP, variantId: blue.id } })) === 0);
  check('  ...an emptied shelf row is deleted, not left at 0', !(await prisma.spotStock.findUnique({ where: { spotId_variantId: { spotId: c1s2.id, variantId: blue.id } } })));

  // Back room: green 2 on the floor, 5 in STORE-R04-1-B, 1 not shelved (8). Sell 6.
  await setShelves(green.id, store.id, 8, { [c1s1.id]: 2, [boxB.id]: 5 });
  await inventoryMutationService.applyMovement({ clientId: SHOP, variantId: green.id, locationId: store.id, movementType: 'OUT', reason: 'SALE', quantityDelta: -6, referenceType: 'TEST' });
  const greenIssues = await prisma.shelfIssue.findMany({ where: { clientId: SHOP, variantId: green.id } });
  check('a sale beyond floor + Not shelved takes 3 from STORE-R04-1-B', await onShelf(c1s1.id, green.id) === 0 && await onShelf(boxB.id, green.id) === 2 && await official(green.id, store.id) === 2);
  check('  ...and raises one SOLD_FROM_BACK_ROOM issue for 3, plus an alert', greenIssues.length === 1 && greenIssues[0].kind === 'SOLD_FROM_BACK_ROOM' && greenIssues[0].quantity === 3 && (await prisma.inventoryAlert.count({ where: { clientId: SHOP, type: 'STOCK_DISCREPANCY', variantId: green.id } })) === 1, JSON.stringify(greenIssues));
  const oversell = await sales.http.post('/pricing/quote', { locationId: store.id, channel: 'POS', lines: [{ variantId: green.id, quantity: 3 }] });
  const oversale = oversell.status === 200 ? await sales.http.post('/counter-sales', { saleId: crypto.randomUUID(), locationId: store.id, quoteId: oversell.data.data.quoteId, customer: { phone: `9${String(STAMP).slice(-9)}` }, items: [{ variantId: green.id, quantity: 3 }], payments: [{ method: 'CASH', amount: oversell.data.data.total }] }) : oversell;
  check('selling more than the location holds is still refused as before, shelves untouched', oversale.status >= 400 && oversale.status < 500 && await onShelf(boxB.id, green.id) === 2, brief(oversale));
  check('the rule holds after section C', !(await ruleHolds()), await ruleHolds());

  // ── D. Every other way stock moves ────────────────────────────────────────────────────────────
  console.log('\nD. OTHER STOCK MOVEMENTS');
  await setShelves(gold.id, store.id, 9, { [c1s1.id]: 3, [boxA.id]: 4 });
  const adminHeaders = { headers: { 'x-location-id': store.id } };
  const out2 = await own.post('/inventory/stock-out', { variantId: gold.id, quantity: 2, reason: 'DAMAGE', locationId: store.id }, adminHeaders);
  check('damage of 2 with 2 not shelved: no shelf touched, no issue', out2.status < 300 && await onShelf(c1s1.id, gold.id) === 3 && await onShelf(boxA.id, gold.id) === 4 && (await prisma.shelfIssue.count({ where: { clientId: SHOP, variantId: gold.id } })) === 0, brief(out2));
  const out3 = await own.post('/inventory/stock-out', { variantId: gold.id, quantity: 3, reason: 'DAMAGE', locationId: store.id }, adminHeaders);
  const goldIssues = await prisma.shelfIssue.findMany({ where: { clientId: SHOP, variantId: gold.id } });
  check('damage of 3 more with none not shelved: 3 off shelves in walking order (FLOOR-C1-1 first), flagged', out3.status < 300 && await onShelf(c1s1.id, gold.id) === 0 && await onShelf(boxA.id, gold.id) === 4 && goldIssues.length === 1 && goldIssues[0].kind === 'AUTO_TAKEN_FROM_SHELF' && goldIssues[0].quantity === 3, `${brief(out3)} ${JSON.stringify(goldIssues)}`);
  const inStock = await own.post('/inventory/stock-in', { variantId: gold.id, quantity: 5, reason: 'PURCHASE', unitCost: 600, locationId: store.id }, adminHeaders);
  check('stock-in of 5 lands in Not shelved: shelves unchanged, put-away list shows gold 5', inStock.status < 300 && await onShelf(boxA.id, gold.id) === 4 && (await wh.get(`/shelves/locations/${store.id}/not-shelved`)).data.data.items.some((i: any) => i.variantId === gold.id && i.notShelved === 5), brief(inStock));
  const shelfMoveByHand = await own.post('/inventory/adjustment', { variantId: gold.id, quantity: 0, reason: 'SHELF_MOVE', locationId: store.id }, adminHeaders);
  const shelfMoveTx = await own.post('/inventory/transactions', { variantId: gold.id, type: 'ADJUSTMENT', reason: 'SHELF_MOVE', quantity: 1 }, adminHeaders);
  check('SHELF_MOVE cannot be chosen by hand on stock adjustments or the ledger API', shelfMoveByHand.status >= 400 && shelfMoveTx.status >= 400 && !leaks(shelfMoveByHand) && !leaks(shelfMoveTx), `${brief(shelfMoveByHand)} | ${brief(shelfMoveTx)}`);
  const metadata = await own.get('/inventory/metadata');
  check('  ...and it is not offered in the reasons list', metadata.status === 200 && !metadata.data.data.inventoryReasons.includes('SHELF_MOVE'), brief(metadata));

  // Transfer: gold 9 at store (4 on STORE-R04-1-A, 5 not shelved). Send 7 to the godown: 5 not shelved + 2 off R04-1-A.
  const transfer = await own.post('/inventory-transfers', { originLocationId: store.id, destinationLocationId: godown.id, items: [{ variantId: gold.id, quantity: 7 }] });
  check('a transfer of 7 out: 5 from Not shelved, 2 off STORE-R04-1-A with an issue; arrives at the godown not shelved', transfer.status < 300 && await onShelf(boxA.id, gold.id) === 2 && await official(gold.id, godown.id) === 7 && (await prisma.shelfIssue.count({ where: { clientId: SHOP, variantId: gold.id, kind: 'AUTO_TAKEN_FROM_SHELF' } })) === 2 && (await prisma.spotStock.count({ where: { variantId: gold.id, locationId: godown.id } })) === 0, brief(transfer));

  // Stock count: red at store is 9 with shelves C1-1 4, C2-1 1, R04-1-A 1 (6 shelved). The count finds 4.
  const count = await stockCountService.createCount(SHOP, `Shelf count ${STAMP}`, store.id, undefined, owner.id);
  await stockCountService.startCount(SHOP, count.id);
  const items = await prisma.stockCountItem.findMany({ where: { stockCountId: count.id } });
  for (const item of items) await stockCountService.updateItemCount(SHOP, count.id, item.id, item.variantId === red.id ? 4 : item.expectedQty);
  await stockCountService.completeCount(SHOP, count.id, owner.id);
  const countIssues = await prisma.shelfIssue.findMany({ where: { clientId: SHOP, variantId: red.id, kind: 'COUNT_BELOW_SHELVES' } });
  check('a stock count finding 4 red (shelves said 6): location 4, 2 taken off shelves from the back room first', await official(red.id, store.id) === 4 && await onShelf(boxA.id, red.id) === 0 && await onShelf(c2s1.id, red.id) === 0 && await onShelf(c1s1.id, red.id) === 4, `${await official(red.id, store.id)} ${await onShelf(boxA.id, red.id)} ${await onShelf(c2s1.id, red.id)} ${await onShelf(c1s1.id, red.id)}`);
  check('  ...and every piece taken is a COUNT_BELOW_SHELVES issue (2 shelves, 2 pieces)', countIssues.length === 2 && countIssues.reduce((t, i) => t + i.quantity, 0) === 2, JSON.stringify(countIssues.map(i => [i.address, i.quantity])));
  check('the rule holds after section D', !(await ruleHolds()), await ruleHolds());

  // ── E. A move is invisible to everything that counts stock ────────────────────────────────────
  console.log('\nE. A MOVE CHANGES NOTHING ANY REPORT COUNTS');
  const today = new Date().toISOString().slice(0, 10);
  const snap = async () => {
    const [daybook, ledgerList, recent, movement, dashboard, variant] = await Promise.all([
      own.get('/daybook', { params: { date: today, locationId: store.id } }),
      own.get('/inventory/transactions', { params: { variantId: red.id } }),
      own.get('/reports/recent-transactions', { params: { limit: 50 } }),
      own.get('/reports/stock-movement', { params: { days: 1 } }),
      own.get('/dashboard/summary'),
      prisma.productVariant.findUniqueOrThrow({ where: { id: red.id }, select: { lastMovementAt: true, averageCost: true, inventoryValue: true } })
    ]);
    const strip = (x: any) => JSON.stringify(x?.data ?? x, (k, v) => (k === 'generatedAt' || k === 'asOf' || k === 'computedAt' ? undefined : v));
    return { daybook: strip(daybook.data), ledger: strip(ledgerList.data), recent: strip(recent.data), movement: strip(movement.data), dashboard: strip(dashboard.data), variant: JSON.stringify(variant), statuses: [daybook.status, ledgerList.status, recent.status, movement.status, dashboard.status].join() };
  };
  const before = await snap();
  const invisibleMove = await wh.post('/shelves/move', { locationId: store.id, variantId: red.id, fromSpotId: c1s1.id, toSpotId: c2s2.id, quantity: 3 });
  const after = await snap();
  check('a move between shelves went through', invisibleMove.status === 200, brief(invisibleMove));
  check('  ...the reads all answered 200', before.statuses === '200,200,200,200,200', before.statuses);
  check('  ...the day book is identical', before.daybook === after.daybook, `${before.daybook.slice(0, 200)} vs ${after.daybook.slice(0, 200)}`);
  check('  ...the stock ledger list is identical', before.ledger === after.ledger);
  check('  ...recent transactions and the movement report are identical', before.recent === after.recent && before.movement === after.movement);
  check('  ...the dashboard is identical', before.dashboard === after.dashboard);
  check("  ...the item's last movement date, average cost and value are unchanged", before.variant === after.variant, `${before.variant} vs ${after.variant}`);
  const history = await wh.get(`/shelves/spots/${c2s2.id}/history`);
  check('  ...but the shelf history shows it', history.status === 200 && history.data.data.movements.some((m: any) => m.quantity === 3 && m.reason === 'SHELF_MOVE'), brief(history));

  // ── F. Concurrency ────────────────────────────────────────────────────────────────────────────
  console.log('\nF. AT THE SAME MOMENT');
  let raceProblems = '';
  for (let round = 1; round <= 10; round++) {
    await setShelves(blue.id, store.id, 5, { [c1s1.id]: 3, [boxA.id]: 2 });
    const results = await Promise.allSettled([1, 2].map(() => inventoryMutationService.applyMovement({ clientId: SHOP, variantId: blue.id, locationId: store.id, movementType: 'OUT', reason: 'SALE', quantityDelta: -5, referenceType: 'RACE' })));
    const ok = results.filter(r => r.status === 'fulfilled').length;
    const shelvesNow = (await prisma.spotStock.aggregate({ where: { variantId: blue.id, locationId: store.id }, _sum: { quantity: true } }))._sum.quantity ?? 0;
    if (ok !== 1 || await official(blue.id, store.id) !== 0 || shelvesNow !== 0) raceProblems += ` round ${round}: ${ok} succeeded, location ${await official(blue.id, store.id)}, shelves ${shelvesNow};`;
  }
  check('two tills sell the last 5 at the same moment, 10 rounds: exactly one succeeds each time, shelves and location both 0', !raceProblems, raceProblems);

  let moveRace = '';
  for (let round = 1; round <= 5; round++) {
    await setShelves(blue.id, store.id, 6, { [c1s1.id]: 4 });
    const results = await Promise.all([1, 2].map(() => wh.post('/shelves/move', { locationId: store.id, variantId: blue.id, fromSpotId: c1s1.id, toSpotId: boxB.id, quantity: 4 })));
    const ok = results.filter(r => r.status === 200).length;
    const refused = results.filter(r => r.status === 409).length;
    if (ok !== 1 || refused !== 1 || await onShelf(c1s1.id, blue.id) !== 0 || await onShelf(boxB.id, blue.id) !== 4 || results.some(leaks)) moveRace += ` round ${round}: ${results.map(r => r.status).join('/')} c1s1=${await onShelf(c1s1.id, blue.id)} boxB=${await onShelf(boxB.id, blue.id)};`;
  }
  check('two people move the same 4 pieces off one shelf at once, 5 rounds: one moves them, the other is told (409)', !moveRace, moveRace);

  let mixRace = '';
  for (let round = 1; round <= 5; round++) {
    await setShelves(blue.id, store.id, 6, { [c1s1.id]: 3 });
    const [putaway, saleResult] = await Promise.allSettled([
      wh.post('/shelves/putaway', { locationId: store.id, variantId: blue.id, spotId: boxB.id, quantity: 3 }),
      inventoryMutationService.applyMovement({ clientId: SHOP, variantId: blue.id, locationId: store.id, movementType: 'OUT', reason: 'SALE', quantityDelta: -4, referenceType: 'RACE' })
    ]);
    const problem = await ruleHolds();
    if (problem || saleResult.status !== 'fulfilled') mixRace += ` round ${round}: ${problem} sale ${saleResult.status} putaway ${putaway.status === 'fulfilled' ? putaway.value.status : 'rejected'};`;
  }
  check('a sale racing a put-away of the same item, 5 rounds: the sale always succeeds and the rule holds', !mixRace, mixRace);

  // ── G. The database guard ─────────────────────────────────────────────────────────────────────
  console.log('\nG. THE DATABASE REFUSES WHAT THE CODE WOULD NEVER DO');
  await setShelves(blue.id, store.id, 6, { [c1s1.id]: 4 });
  const raw = async (fn: () => Promise<unknown>) => { try { await fn(); return 'saved'; } catch (e: any) { return String(e?.message ?? e); } };
  const r1 = await raw(() => prisma.spotStock.update({ where: { spotId_variantId: { spotId: c1s1.id, variantId: blue.id } }, data: { quantity: 7 } }));
  const r2 = await raw(() => prisma.inventoryStock.update({ where: { variantId_locationId: { variantId: blue.id, locationId: store.id } }, data: { quantity: 3 } }));
  const cupboardC1 = await spot('FLOOR-C1');
  const r3 = await raw(() => prisma.spotStock.create({ data: { clientId: SHOP, locationId: store.id, spotId: cupboardC1.id, variantId: green.id, quantity: 1 } }));
  const r4 = await raw(() => prisma.spotStock.create({ data: { clientId: SHOP, locationId: godown.id, spotId: c2s1.id, variantId: gold.id, quantity: 1 } }));
  check('a raw write putting 7 on shelves of a location holding 6 is refused at commit', /shelf_stock_exceeds_location/.test(r1), r1);
  check('a raw write lowering the location to 3 below 4 on shelves is refused', /shelf_stock_exceeds_location/.test(r2), r2);
  check('raw stock on a cupboard with shelves, and on a shelf of another location, are refused', /cannot hold stock/.test(r3) && /another location/.test(r4), `${r3} | ${r4}`);
  check('  ...and nothing changed', await onShelf(c1s1.id, blue.id) === 4 && await official(blue.id, store.id) === 6);

  // ── H. Changing the tree ──────────────────────────────────────────────────────────────────────
  console.log('\nH. CHANGING THE TREE');
  const c1 = await spot('FLOOR-C1');
  const oldLabel = c1s1.labelCode;
  const readdress = await own.patch(`/shelves/spots/${c1.id}`, { code: 'c01' });
  check('cupboard C1 becomes C01: it and its shelves get new addresses', readdress.status === 200 && readdress.data.data.address === 'FLOOR-C01' && !!(await prisma.storageSpot.findFirst({ where: { id: c1s1.id, address: 'FLOOR-C01-1' } })), brief(readdress));
  const scanOld = await wh.get('/shelves/spots/scan', { params: { code: `SEZ:${oldLabel}` } });
  check('  ...the old printed label still opens the shelf, now FLOOR-C01-1', scanOld.status === 200 && scanOld.data.data.spot.address === 'FLOOR-C01-1', brief(scanOld));
  const hist = await own.get(`/shelves/spots/${c1s1.id}/history`);
  check('  ...the address history says FLOOR-C1-1 -> FLOOR-C01-1', hist.data?.data?.addresses?.[0]?.oldAddress === 'FLOOR-C1-1' && hist.data.data.addresses[0].newAddress === 'FLOOR-C01-1', brief(hist));
  const oldLegs = await prisma.inventoryTransactionSpot.count({ where: { spotId: c1s1.id, address: 'FLOOR-C1-1' } });
  check('  ...ledger legs keep the address they were written with', oldLegs > 0, String(oldLegs));
  const clash = await own.patch(`/shelves/spots/${(await spot('FLOOR-C2')).id}`, { code: 'C01' });
  check('renaming C2 to C01 (taken): 409', clash.status === 409 && !leaks(clash), brief(clash));
  const offStocked = await own.patch(`/shelves/spots/${c1.id}`, { active: false });
  const delStocked = await own.delete(`/shelves/spots/${c1.id}`);
  check('switching off or deleting a cupboard whose shelf holds stock: 409, with the piece count', offStocked.status === 409 && delStocked.status === 409 && /holds? \d+ pieces?|hold \d+ pieces?/.test(offStocked.data.message), `${brief(offStocked)} | ${brief(delStocked)}`);
  const childUnderStocked = await own.post(`/shelves/locations/${store.id}/spots`, { parentId: c1s1.id, kind: 'BOX', code: 'A' });
  check('adding a box inside a shelf that holds stock: 409, "move them off it first"', childUnderStocked.status === 409 && /Move them off/.test(childUnderStocked.data.message), brief(childUnderStocked));
  const everything = await wh.post('/shelves/move-all', { fromSpotId: c1s1.id, toSpotId: c2s1.id });
  check('move everything from FLOOR-C01-1 to FLOOR-C2-1', everything.status === 200 && everything.data.data.failed.length === 0 && (await prisma.spotStock.count({ where: { spotId: c1s1.id } })) === 0, brief(everything));
  const offEmpty = await own.patch(`/shelves/spots/${c3.id}`, { active: false });
  const putOnOff = await wh.post('/shelves/putaway', { locationId: store.id, variantId: blue.id, spotId: c3.id, quantity: 1 });
  check('switch off an empty cupboard, and nothing can be put on it (400)', offEmpty.status === 200 && offEmpty.data.data.active === false && putOnOff.status === 400, `${brief(offEmpty)} | ${brief(putOnOff)}`);
  const railSpot = await spot('FLOOR-R1');
  const delEmpty = await own.delete(`/shelves/spots/${railSpot.id}`);
  check('delete the empty rail FLOOR-R1 and its section', delEmpty.status === 200 && delEmpty.data.data.removed === 2 && !(await prisma.storageSpot.findFirst({ where: { clientId: SHOP, address: { startsWith: 'FLOOR-R1' } } })), brief(delEmpty));
  const floorToggleChild = await own.patch(`/shelves/spots/${c2s1.id}`, { isShopFloor: false });
  const floorToggleArea = await own.patch(`/shelves/spots/${(await spot('STORE')).id}`, { isShopFloor: true });
  check('shop floor is changed on the area only, and reaches every spot inside it', floorToggleChild.status === 400 && floorToggleArea.status === 200 && (await spot('STORE-R04-2-A')).isShopFloor === true, `${brief(floorToggleChild)} | ${brief(floorToggleArea)}`);
  await own.patch(`/shelves/spots/${(await spot('STORE')).id}`, { isShopFloor: false });
  const labels = await own.get(`/shelves/locations/${store.id}/labels`);
  check('labels: every active spot in walking order with its QR payload "SEZ:<code>"', labels.status === 200 && labels.data.data.length > 5 && labels.data.data.every((l: any) => l.qr === `SEZ:${l.labelCode}`) && !labels.data.data.some((l: any) => l.address === 'FLOOR-C3'), brief(labels));
  check('the rule holds after section H', !(await ruleHolds()), await ruleHolds());

  // ── I. Who may do what, and another shop's ids ────────────────────────────────────────────────
  console.log('\nI. PERMISSIONS AND OTHER SHOPS');
  const salesPut = await sales.http.post('/shelves/putaway', { locationId: store.id, variantId: blue.id, spotId: c2s1.id, quantity: 1 });
  const salesSetup = await sales.http.post(`/shelves/locations/${store.id}/spots`, { kind: 'AREA', code: 'SALESAREA' });
  check('a salesperson can find but not put away or set up (403, 403)', salesPut.status === 403 && salesSetup.status === 403, `${brief(salesPut)} | ${brief(salesSetup)}`);
  const whSetup = await wh.post(`/shelves/locations/${store.id}/spots`, { kind: 'AREA', code: 'WHAREA' });
  const whResolve = await wh.post(`/shelves/issues/${greenIssues[0].id}/resolve`, {});
  check('warehouse staff can put away but not set up racks or resolve issues (403)', whSetup.status === 403 && whResolve.status === 403, `${brief(whSetup)} | ${brief(whResolve)}`);
  const mgrSetup = await manager.http.post(`/shelves/locations/${spare.id}/spots`, { kind: 'AREA', code: 'POPUP' });
  check('an inventory manager can set up racks', mgrSetup.status === 201, brief(mgrSetup));
  const nobodyAll = await Promise.all([nobody.http.get('/shelves/find', { params: { q: 'silk' } }), nobody.http.get(`/shelves/locations/${store.id}/spots`), nobody.http.post('/shelves/move', { locationId: store.id, variantId: blue.id, fromSpotId: c2s1.id, quantity: 1 })]);
  check('someone with no permissions gets 403 everywhere', nobodyAll.every(r => r.status === 403), nobodyAll.map(r => r.status).join());

  const theirs = intruder.http;
  const attempts = await Promise.all([
    theirs.get(`/shelves/locations/${store.id}/spots`),
    theirs.post(`/shelves/locations/${store.id}/spots`, { kind: 'AREA', code: 'HACK' }),
    theirs.post(`/shelves/locations/${store.id}/spots/bulk`, { levels: [{ kind: 'AREA', range: { codes: ['HACK'] } }], preview: true }),
    theirs.get(`/shelves/locations/${store.id}/labels`),
    theirs.get(`/shelves/locations/${store.id}/not-shelved`),
    theirs.get(`/shelves/spots/${c2s1.id}`),
    theirs.get(`/shelves/spots/${c2s1.id}/history`),
    theirs.get('/shelves/spots/scan', { params: { code: `SEZ:${c2s1.labelCode}` } }),
    theirs.get('/shelves/spots/scan', { params: { code: 'FLOOR-C2-1', locationId: store.id } }),
    theirs.patch(`/shelves/spots/${c2s1.id}`, { name: 'hacked' }),
    theirs.delete(`/shelves/spots/${c3.id}`),
    theirs.get(`/shelves/variants/${blue.id}`),
    theirs.get('/shelves/find', { params: { q: `77BLUE${STAMP}` } }),
    theirs.post('/shelves/putaway', { locationId: store.id, variantId: blue.id, spotId: c2s1.id, quantity: 1 }),
    theirs.post('/shelves/move', { locationId: store.id, variantId: blue.id, fromSpotId: c2s1.id, toSpotId: c2s2.id, quantity: 1 }),
    theirs.post('/shelves/move-all', { fromSpotId: c2s1.id, toSpotId: c2s2.id }),
    theirs.post(`/shelves/issues/${greenIssues[0].id}/resolve`, {}),
    theirs.get('/shelves/issues')
  ]);
  const secret = JSON.stringify(attempts.map(a => a.data));
  const exposed = [c2s1.labelCode, 'FLOOR-C2-1', `77BLUE${STAMP}`, 'Main Store'].filter(s => secret.includes(s));
  check("another shop's owner with this shop's ids on all 18 shelf routes: 404/400, nothing leaks, nothing changes",
    // /find (index 12) searches the caller's own shop: another shop's barcode simply finds nothing there.
    attempts.slice(0, 17).every((a, i) => i === 12 ? a.status === 200 && a.data.data.items.length === 0 : a.status === 404 || a.status === 400) && exposed.length === 0 && attempts.every(a => !leaks(a)) && attempts[17].status === 200 && attempts[17].data.data.total === 0,
    `${attempts.map(a => a.status).join()} exposed=${exposed.join()}`);
  check('  ...and the spot was not renamed, deleted or moved', (await spot('FLOOR-C2-1')).name === null && !!(await prisma.storageSpot.findUnique({ where: { id: c3.id } })) && (await prisma.storageSpot.count({ where: { clientId: OTHER } })) === 0);
  const bodySmuggle = await own.patch(`/shelves/spots/${c2s1.id}`, { name: 'Ok', clientId: OTHER, locationId: godown.id, labelCode: 'AAAAAAAAAA', address: 'X' });
  check('a body carrying clientId, locationId, labelCode or address is refused (400), not half-applied', bodySmuggle.status === 400 && (await spot('FLOOR-C2-1')).name === null, brief(bodySmuggle));

  // ── J. Shelf issues ───────────────────────────────────────────────────────────────────────────
  console.log('\nJ. SHELF ISSUES');
  const list = await own.get('/shelves/issues');
  check('the owner sees every open issue (back room, auto-taken, count), newest first', list.status === 200 && list.data.data.open >= 5 && list.data.data.issues.every((i: any) => i.status === 'OPEN' && i.message && i.item.title === 'Silk Saree'), brief(list));
  const res1 = await own.post(`/shelves/issues/${greenIssues[0].id}/resolve`, { note: 'Moved 2 from the godown box to the floor' });
  const res2 = await own.post(`/shelves/issues/${greenIssues[0].id}/resolve`, { note: 'again' });
  check('resolving records the note; resolving it again is 409', res1.status === 200 && res1.data.data.status === 'RESOLVED' && res1.data.data.resolutionNote.startsWith('Moved') && res2.status === 409, `${brief(res1)} | ${brief(res2)}`);
  check('  ...and resolving changed no stock', await onShelf(boxB.id, green.id) === 2 && await official(green.id, store.id) === 2);

  // ── L. Phase 2 and 3: naming shelves, picking, counting, importing ──────────────────────────────
  console.log('\nL. NAMING SHELVES, PICKING, COUNTING, IMPORTING');
  const boxAL = await spot('STORE-R04-1-A');
  const c2s1L = await spot('FLOOR-C2-1');
  const c2s2L = await spot('FLOOR-C2-2');
  const boxBL = await spot('STORE-R04-1-B');
  const c01s1 = await spot('FLOOR-C01-1');
  const issuesBefore = await prisma.shelfIssue.count({ where: { clientId: SHOP } });

  // Write-off from a chosen shelf.
  await setShelves(red.id, store.id, 10, { [c2s1L.id]: 3, [boxAL.id]: 4 });
  const damageNamed = await own.post('/inventory/stock-out', { variantId: red.id, quantity: 2, reason: 'DAMAGE', locationId: store.id, fromSpots: [{ spotId: boxAL.id, quantity: 2 }] }, adminHeaders);
  const damageTx = await prisma.inventoryTransaction.findFirst({ where: { clientId: SHOP, variantId: red.id, reason: 'DAMAGE' }, orderBy: { createdAt: 'desc' }, include: { spotLegs: true } });
  check('damage written off from a chosen shelf: exactly that shelf, a SCANNED leg, no issue', damageNamed.status < 300 && await onShelf(boxAL.id, red.id) === 2 && damageTx?.spotLegs.length === 1 && damageTx.spotLegs[0].source === 'SCANNED' && (await prisma.shelfIssue.count({ where: { clientId: SHOP } })) === issuesBefore, brief(damageNamed));
  const tooMuchNamed = await own.post('/inventory/stock-out', { variantId: red.id, quantity: 1, reason: 'DAMAGE', locationId: store.id, fromSpots: [{ spotId: boxAL.id, quantity: 2 }] }, adminHeaders);
  const dupNamed = await own.post('/inventory/stock-out', { variantId: red.id, quantity: 2, reason: 'DAMAGE', locationId: store.id, fromSpots: [{ spotId: boxAL.id, quantity: 1 }, { spotId: boxAL.id, quantity: 1 }] }, adminHeaders);
  const overShelf = await own.post('/inventory/stock-out', { variantId: red.id, quantity: 5, reason: 'DAMAGE', locationId: store.id, fromSpots: [{ spotId: boxAL.id, quantity: 5 }] }, adminHeaders);
  check('refused in words: shelves adding up to more than going out, a shelf listed twice, more than a shelf holds', tooMuchNamed.status === 400 && dupNamed.status === 400 && overShelf.status === 409 && ![tooMuchNamed, dupNamed, overShelf].some(leaks) && await official(red.id, store.id) === 8, `${brief(tooMuchNamed)} | ${brief(dupNamed)} | ${brief(overShelf)}`);

  // Transfer from a chosen shelf.
  const transferNamed = await own.post('/inventory-transfers', { originLocationId: store.id, destinationLocationId: godown.id, items: [{ variantId: red.id, quantity: 3, fromSpots: [{ spotId: c2s1L.id, quantity: 3 }] }] });
  check('a transfer naming its shelf takes from that shelf only; it arrives not shelved', transferNamed.status < 300 && await onShelf(c2s1L.id, red.id) === 0 && await onShelf(boxAL.id, red.id) === 2 && await official(red.id, store.id) === 5, brief(transferNamed));

  // Picking.
  await setShelves(blue.id, store.id, 6, { [c2s2L.id]: 2, [boxBL.id]: 3 });
  const picker = await prisma.customer.create({ data: { clientId: SHOP, customerCode: `CUS-PICK-${STAMP}`, name: 'Picker Test', phone: `+918${String(STAMP).slice(-9)}`, status: 'ACTIVE' } });
  const confirmOrder = async (quantity: number) => {
    const q = await own.post('/pricing/quote', { locationId: store.id, channel: 'POS', customerId: picker.id, lines: [{ variantId: blue.id, quantity }] });
    return own.post('/sales-orders/full', { locationId: store.id, quoteId: q.data?.data?.quoteId, customer: { id: picker.id }, items: [{ variantId: blue.id, quantity }], status: 'CONFIRMED' });
  };
  const orderA = await confirmOrder(5);
  const orderB = await confirmOrder(1);
  check('two orders for blue confirmed (5 and 1)', orderA.status === 201 && orderB.status === 201, `${brief(orderA)} | ${brief(orderB)}`);
  // This route answers with the order itself, not wrapped in { data }.
  const orderAId = orderA.data?.id ?? orderA.data?.data?.id, orderBId = orderB.data?.id ?? orderB.data?.data?.id;
  const pickOrders = await wh.get('/shelves/pick/orders', { params: { locationId: store.id } });
  check('the pick screen lists both, with pieces still to send', pickOrders.status === 200 && [orderAId, orderBId].every(id => pickOrders.data.data.orders.some((o: any) => o.id === id)), brief(pickOrders));
  const pickList = await wh.get('/shelves/pick/list', { params: { locationId: store.id, orderIds: `${orderAId},${orderBId}` } });
  const stops = pickList.data?.data?.stops ?? [];
  check('one walk for both: FLOOR-C2-2 (2) then STORE-R04-1-B (3), and 1 from Not shelved; nothing short', pickList.status === 200 && stops.map((s: any) => `${s.address}:${s.picks.reduce((t: number, p: any) => t + p.quantity, 0)}`).join() === 'FLOOR-C2-2:2,STORE-R04-1-B:3' && pickList.data.data.notShelved.reduce((t: number, p: any) => t + p.quantity, 0) === 1 && pickList.data.data.short.length === 0, String(JSON.stringify(pickList.data)).slice(0, 400));
  check('  ...and suggesting a walk moved nothing', await onShelf(c2s2L.id, blue.id) === 2 && await onShelf(boxBL.id, blue.id) === 3);
  const itemA = (await prisma.salesOrderItem.findFirstOrThrow({ where: { salesOrderId: orderAId } })).id;
  const fromShelves = stops.flatMap((s: any) => s.picks.filter((p: any) => p.orderId === orderAId).map((p: any) => ({ spotId: s.spotId, quantity: p.quantity })));
  const dispatched = await wh.post('/dispatches', { salesOrderId: orderAId, items: [{ salesOrderItemId: itemA, quantity: 5, fromSpots: fromShelves }] });
  const dispatchId = dispatched.data?.id ?? dispatched.data?.data?.id;
  check('dispatching order A with the picked shelves takes exactly those (the back room too) and raises no issue', dispatched.status === 201 && await onShelf(c2s2L.id, blue.id) === 0 && await onShelf(boxBL.id, blue.id) === 0 && (await prisma.shelfIssue.count({ where: { clientId: SHOP, variantId: blue.id, kind: 'SOLD_FROM_BACK_ROOM', createdAt: { gte: new Date(Date.now() - 60_000) } } })) === 0, brief(dispatched));
  const used = await own.get('/shelves/movements', { params: { referenceType: 'DISPATCH', referenceIds: dispatchId } });
  check('  ...and the order can show which shelves it came from', used.status === 200 && used.data.data.length === 1 && used.data.data[0].legs.map((l: any) => `${l.address}:${l.quantity}:${l.source}`).sort().join() === 'FLOOR-C2-2:-2:SCANNED,STORE-R04-1-B:-3:SCANNED', brief(used));
  const salesPick = await sales.http.get('/shelves/pick/orders', { params: { locationId: store.id } });
  check('a salesperson cannot open pick lists (403)', salesPick.status === 403, brief(salesPick));

  const notFoundR = await wh.post('/shelves/not-found', { spotId: boxAL.id, variantId: red.id, missing: 1 });
  check('"not found on the shelf" records an issue and changes no stock', notFoundR.status === 201 && (await prisma.shelfIssue.count({ where: { clientId: SHOP, kind: 'NOT_FOUND_ON_SHELF', spotId: boxAL.id } })) === 1 && await onShelf(boxAL.id, red.id) === 2 && await official(red.id, store.id) === 5, brief(notFoundR));

  // Counting one shelf.
  await setShelves(gold.id, store.id, 6, { [c01s1.id]: 2 });
  const count1 = await wh.post(`/shelves/spots/${c01s1.id}/count`, { counts: [{ variantId: gold.id, counted: 5 }] });
  check('counting 5 gold where 2 were recorded takes 3 from Not shelved, no issue', count1.status === 200 && await onShelf(c01s1.id, gold.id) === 5 && count1.data.data.issues === 0, brief(count1));
  const count2 = await wh.post(`/shelves/spots/${c01s1.id}/count`, { counts: [{ variantId: gold.id, counted: 9 }] });
  check('counting 9 when the location only has 1 more: shelf 6, and 3 raised as COUNT_BELOW_SHELVES', count2.status === 200 && await onShelf(c01s1.id, gold.id) === 6 && count2.data.data.issues === 1 && (await prisma.shelfIssue.findFirst({ where: { clientId: SHOP, variantId: gold.id, kind: 'COUNT_BELOW_SHELVES' }, orderBy: { createdAt: 'desc' } }))?.quantity === 3, brief(count2));
  const count3 = await wh.post(`/shelves/spots/${c01s1.id}/count`, { counts: [], complete: true });
  check('a complete count finding nothing: shelf 0, the 6 go to Not shelved, a NOT_FOUND_ON_SHELF issue; the location still has 6', count3.status === 200 && await onShelf(c01s1.id, gold.id) === 0 && await official(gold.id, store.id) === 6 && count3.data.data.issues === 1, brief(count3));
  const countBad = await Promise.all([
    wh.post(`/shelves/spots/${c01s1.id}/count`, { counts: [{ variantId: gold.id, counted: -1 }] }),
    wh.post(`/shelves/spots/${c01s1.id}/count`, { counts: [{ variantId: gold.id, counted: 1 }, { variantId: gold.id, counted: 1 }] }),
    wh.post(`/shelves/spots/${(await spot('FLOOR-C01')).id}/count`, { counts: [{ variantId: gold.id, counted: 1 }] }),
    wh.post(`/shelves/spots/${c01s1.id}/count`, { counts: [{ variantId: gold.id, counted: 1 }], clientId: OTHER })
  ]);
  check('count refusals: negative, twice, a cupboard with shelves, a smuggled field (all 400)', countBad.every(r => r.status === 400 && !leaks(r)), countBad.map(brief).join(' | '));

  // Importing addresses.
  const importPreview = await own.post(`/shelves/locations/${godown.id}/spots/import`, { rows: [{ address: 'wh - a1 - 1', name: 'Blue box', shopFloor: 'no' }, { address: 'WH-A1-2', capacity: '30' }, { address: 'bad address!' }], preview: true });
  check('import preview: row 3 is not an address, nothing saved', importPreview.status === 200 && importPreview.data.data.errors.length === 1 && importPreview.data.data.errors[0].row === 3 && importPreview.data.data.saved === false && !(await prisma.storageSpot.findFirst({ where: { locationId: godown.id, address: 'WH' } })), brief(importPreview));
  const importSave = await own.post(`/shelves/locations/${godown.id}/spots/import`, { rows: [{ address: 'wh - a1 - 1', name: 'Blue box', shopFloor: 'no', kind: 'box' }, { address: 'WH-A1-2', capacity: '30' }] });
  const whSpots = await prisma.storageSpot.findMany({ where: { locationId: godown.id, address: { startsWith: 'WH' } }, orderBy: { depth: 'asc' } });
  check('import saves WH, WH-A1, WH-A1-1 (a box named "Blue box") and WH-A1-2 (capacity 30), back room', importSave.status === 201 && whSpots.map(s => `${s.address}:${s.kind}`).join() === 'WH:AREA,WH-A1:RACK,WH-A1-1:BOX,WH-A1-2:SHELF' && whSpots.find(s => s.address === 'WH-A1-1')?.name === 'Blue box' && whSpots.find(s => s.address === 'WH-A1-2')?.capacity === 30 && whSpots.every(s => !s.isShopFloor), `${brief(importSave)} ${JSON.stringify(whSpots.map(s => s.address))}`);
  const importAgain = await own.post(`/shelves/locations/${godown.id}/spots/import`, { rows: [{ address: 'WH-A1-1' }, { address: 'WH-A1-3' }] });
  const importClash = await own.post(`/shelves/locations/${godown.id}/spots/import`, { rows: [{ address: 'WH-B1-1', shopFloor: 'yes' }], preview: true });
  const importUnderStock = await own.post(`/shelves/locations/${store.id}/spots/import`, { rows: [{ address: 'STORE-R04-1-A-X' }], preview: true });
  check('import again: existing kept, only WH-A1-3 added; an area can\'t change floor from a file; nothing under a stocked shelf', importAgain.status === 201 && importAgain.data.data.create === 1 && importAgain.data.data.alreadyThere === 1 && importClash.data.data.errors.length === 1 && importUnderStock.data.data.errors.length === 1, `${brief(importAgain)} | ${brief(importClash)} | ${brief(importUnderStock)}`);

  // New sale search shows where it is.
  await setShelves(green.id, store.id, 4, { [c2s1L.id]: 3 });
  const saleSearch = await sales.http.get('/counter-sales/items', { params: { q: `77GREEN${STAMP}`, locationId: store.id } });
  check('New sale search tells the salesperson the shelf (FLOOR-C2-1, 3) and still shows no cost', saleSearch.status === 200 && saleSearch.data.data.items[0]?.shelves?.[0]?.address === 'FLOOR-C2-1' && saleSearch.data.data.items[0].shelves[0].quantity === 3 && !/costPrice|averageCost|unitCost/.test(JSON.stringify(saleSearch.data)), brief(saleSearch));

  // Other shops on the new routes.
  const theirsL = await Promise.all([
    intruder.http.get('/shelves/pick/orders', { params: { locationId: store.id } }),
    intruder.http.get('/shelves/pick/list', { params: { locationId: store.id, orderIds: orderBId } }),
    intruder.http.post('/shelves/not-found', { spotId: boxAL.id, variantId: red.id, missing: 1 }),
    intruder.http.post(`/shelves/spots/${c01s1.id}/count`, { counts: [{ variantId: gold.id, counted: 50 }] }),
    intruder.http.post(`/shelves/locations/${store.id}/spots/import`, { rows: [{ address: 'HACK-1' }] }),
    intruder.http.get('/shelves/movements', { params: { referenceType: 'DISPATCH', referenceIds: dispatchId } })
  ]);
  check("another shop's owner on pick lists, not-found, counts, import and movements: 404 or nothing, no change", theirsL.slice(0, 5).every(r => r.status === 404) && theirsL[5].status === 200 && theirsL[5].data.data.length === 0 && !theirsL.some(leaks) && await onShelf(c01s1.id, gold.id) === 0 && !(await prisma.storageSpot.findFirst({ where: { clientId: SHOP, address: 'HACK-1' } })), theirsL.map(r => r.status).join());
  check('the rule holds after section L', !(await ruleHolds()), await ruleHolds());

  // ── K. Deleting ───────────────────────────────────────────────────────────────────────────────
  console.log('\nK. DELETING');
  const delLocation = await own.delete(`/locations/${spare.id}`);
  check('a location with an empty rack tree can be deleted, tree and all', delLocation.status === 200 && (await prisma.storageSpot.count({ where: { locationId: spare.id } })) === 0, brief(delLocation));
  check('the rule holds at the end', !(await ruleHolds()), await ruleHolds());
}

async function cleanup() {
  for (const id of [SHOP, OTHER]) {
    await platformAdminService.deleteClientCompletely(id, id).catch((e: any) => { if (!/No such client/.test(e?.message)) console.log('cleanup', id, e?.message); });
  }
  const left = await prisma.storageSpot.count({ where: { clientId: { in: [SHOP, OTHER] } } })
    + await prisma.spotStock.count({ where: { clientId: { in: [SHOP, OTHER] } } })
    + await prisma.shelfIssue.count({ where: { clientId: { in: [SHOP, OTHER] } } })
    + await prisma.user.count({ where: { clientId: { in: [SHOP, OTHER] } } });
  check('deleting the whole shop removes its racks, shelf stock, legs and issues too', left === 0, String(left));
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
