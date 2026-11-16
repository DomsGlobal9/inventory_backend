/**
 * Racks and shelves for the boutique (CRM-B checklist section 3, 16 Nov), against the REAL local server and database,
 * on ScaleEzy's own shelves: set up in one go (preview first, again adds nothing), labels, put away cloth in METRES
 * and saris in pieces, scan by label and by address, where is it, move, take off, whole shelf, count a shelf (a
 * problem raised, then fixed), the count queue, stock leaving with no shelf named (not-shelved first, then shelves
 * in walking order), retries, refusals and permissions. Throwaway boutique only (racktest-*). Local only.
 *   DATABASE_URL=<local> DIRECT_URL=<local> VERIFY_API_URL=http://localhost:4036/api/v1 \
 *   BOUTIQUE_KEY_DIR=<dir with private.pem> npx tsx src/scripts/verify-boutique-racks.ts
 */
import fs from 'node:fs';
import axios from 'axios';
import jwt from 'jsonwebtoken';
import { prisma } from '../lib/prisma';

const BASE = process.env.VERIFY_API_URL || 'http://localhost:4036/api/v1';
for (const k of ['DATABASE_URL', 'DIRECT_URL']) {
  if (!/localhost:55433/.test(process.env[k] ?? '')) { console.error(`Refusing: ${k} is not the local database.`); process.exit(2); }
}
if (!/localhost|127\.0\.0\.1/.test(BASE)) { console.error('Refusing: VERIFY_API_URL is not a local server.'); process.exit(2); }
const privateKey = fs.readFileSync(`${process.env.BOUTIQUE_KEY_DIR}/private.pem`, 'utf8');

const S = Date.now().toString(36);
const TEN = `racktest-${S}`;
let bad = 0, good = 0;
const check = (name: string, ok: boolean, detail: unknown = '') => {
  ok ? good++ : bad++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : ` :: ${typeof detail === 'string' ? detail : JSON.stringify(detail)?.slice(0, 700)}`}`);
};
const ALL = ['products:write', 'stock:write', 'stitching:issue'];
const pass = (can = ALL) => jwt.sign({ sub: 'crm-b', scope: ['modules:boutique'], tenant: TEN, onBehalfOf: { userId: 'u1', name: 'Lakshmi', can } },
  privateKey, { algorithm: 'RS256', audience: 'inventory', issuer: 'scaleezy-boutique-test', keyid: 'btq-1', expiresIn: '5m' });
let n = 0;
async function call(method: string, path: string, body?: unknown, o: { can?: string[]; key?: string } = {}) {
  const r = await axios.request({ method, url: `${BASE}/internal/boutique${path}`, data: body, validateStatus: () => true, timeout: 120_000,
    headers: { Authorization: `Bearer ${pass(o.can)}`, ...(method !== 'GET' ? { 'Idempotency-Key': o.key ?? `rack-${S}-${++n}` } : {}) } });
  return { status: r.status, data: r.data?.data, message: r.data?.message as string | undefined, replay: r.headers['idempotent-replay'] };
}
const where = async (code: string, loc: string) => (await call('GET', `/items/${code}/where?locationId=${loc}`)).data?.places?.find((p: any) => p.locationId === loc);

async function main() {
  const link = await call('POST', '/link', { shopName: 'Rack Test Boutique' });
  check('a throwaway boutique is linked', link.status === 201, link);
  const loc = (await call('GET', '/stores')).data[0].id as string;
  const SILK = `SILK-${S}`, SAREE = `SAR-${S}`;
  await call('PUT', `/items/${SILK}`, { name: 'Kanchi silk', category: 'FABRIC', unit: 'METER', color: 'Maroon', sellingPrice: 450, openingStock: [{ quantity: 20 }] });
  await call('PUT', `/items/${SAREE}`, { name: 'Banarasi saree', category: 'FINISHED', kind: 'SAREE', sellingPrice: 9000, sellInShop: true, openingStock: [{ quantity: 6 }] });

  console.log('\nSET UP THE RACKS IN ONE GO');
  const spec = { isShopFloor: true, levels: [{ kind: 'AREA', range: { codes: ['FLOOR'] } }, { kind: 'RACK', range: { from: 1, to: 2 } }, { kind: 'SHELF', range: { from: 1, to: 3 } }] };
  const pv = await call('POST', `/stores/${loc}/spots/bulk`, { ...spec, preview: true });
  check('preview: 1 area + 2 racks + 6 shelves = 9 would be made, nothing saved', pv.data?.create === 9 && pv.data.saved === false && (await prisma.storageSpot.count({ where: { locationId: loc } })) === 0, pv.data);
  const made = await call('POST', `/stores/${loc}/spots/bulk`, spec);
  check('made: 9 spots', made.data?.saved === true && (await prisma.storageSpot.count({ where: { locationId: loc } })) === 9, made.data);
  const again = await call('POST', `/stores/${loc}/spots/bulk`, spec);
  check('run again: nothing new, 9 already there', again.data?.create === 0 && again.data.alreadyThere === 9, again.data);
  check('a kind that is not one: 400 in words', (await call('POST', `/stores/${loc}/spots`, { kind: 'BASKET', code: 'X1' })).status === 400);
  const spots = await prisma.storageSpot.findMany({ where: { locationId: loc, kind: 'SHELF' }, orderBy: { address: 'asc' } });
  const [s11, s12] = spots;
  const labels = (await call('GET', `/stores/${loc}/labels`)).data;
  const lab = JSON.stringify(labels ?? '');
  check('labels: every shelf has its fixed label code', spots.every(s => lab.includes(s.labelCode)), labels);
  check('the tree reads back', (await call('GET', `/stores/${loc}/spots`)).status === 200);

  console.log('\nPUT AWAY, IN METRES AND PIECES');
  const ns = (await call('GET', `/stores/${loc}/not-shelved`)).data;
  const nsSilk = JSON.stringify(ns).includes(SILK);
  check('not shelved: the silk and the saris are waiting', nsSilk && JSON.stringify(ns).includes(SAREE), ns);
  const key = `rack-put-${S}`;
  const put = await call('POST', '/shelf-moves', { itemCode: SILK, locationId: loc, toSpotId: s11.id, quantity: 12.5 }, { key });
  check('put away 12.5 m of silk on the first shelf', put.status === 200, put);
  check('...the same press again: a replay, not 25 m', (await call('POST', '/shelf-moves', { itemCode: SILK, locationId: loc, toSpotId: s11.id, quantity: 12.5 }, { key })).replay === 'true');
  await call('POST', '/shelf-moves', { itemCode: SAREE, locationId: loc, toSpotId: s11.id, quantity: 4 });
  const w1 = await where(SILK, loc);
  check('where is the silk: 12.5 m on that shelf, 7.5 m not shelved, in metres', w1?.shelves?.[0]?.quantity === 12.5 && w1.notShelved === 7.5 && w1.total === 20, w1);
  const on = (await call('GET', `/spots/${s11.id}`)).data;
  check('the shelf: silk 12.5 METRE and saris 4 PIECE, totals per unit', on?.items?.find((i: any) => i.itemCode === SILK)?.quantity === 12.5 && on.items.find((i: any) => i.itemCode === SAREE)?.unit === 'PIECE' && on.totalByUnit?.METRE === 12.5 && on.totalByUnit.PIECE === 4, on);
  check('12.505 m: 400', (await call('POST', '/shelf-moves', { itemCode: SILK, locationId: loc, toSpotId: s11.id, quantity: 12.505 })).status === 400);
  const tooMuch = await call('POST', '/shelf-moves', { itemCode: SILK, locationId: loc, toSpotId: s11.id, quantity: 8 });
  check('putting away 8 m when 7.5 m is not shelved: refused in words', tooMuch.status >= 400 && tooMuch.status < 500 && !!tooMuch.message, tooMuch);

  console.log('\nSCAN, MOVE, TAKE OFF, WHOLE SHELF');
  check('scan the label (with its SEZ: prefix): that shelf', (await call('GET', `/spots/scan?code=SEZ:${s11.labelCode}`)).data?.spot?.id === s11.id);
  check('type the address: that shelf', (await call('GET', `/spots/scan?code=${encodeURIComponent(s11.address)}&locationId=${loc}`)).data?.spot?.id === s11.id);
  check('a label nobody has: 404', (await call('GET', '/spots/scan?code=ZZZZZZZZ')).status === 404);
  await call('POST', '/shelf-moves', { itemCode: SILK, locationId: loc, fromSpotId: s11.id, toSpotId: s12.id, quantity: 2.5 });
  await call('POST', '/shelf-moves', { itemCode: SILK, locationId: loc, fromSpotId: s12.id, quantity: 1 });
  const w2 = await where(SILK, loc);
  check('moved 2.5 m to the next shelf, took 1 m off: 10 + 1.5 on shelves, 8.5 not shelved', w2?.shelves?.find((s: any) => s.spotId === s11.id)?.quantity === 10 && w2.shelves.find((s: any) => s.spotId === s12.id)?.quantity === 1.5 && w2.notShelved === 8.5, w2);
  check('the same shelf as from and to: 400', (await call('POST', '/shelf-moves', { itemCode: SILK, locationId: loc, fromSpotId: s11.id, toSpotId: s11.id, quantity: 1 })).status === 400);
  await call('POST', '/shelf-moves/whole-shelf', { fromSpotId: s12.id, toSpotId: s11.id });
  check('whole shelf moved: everything on the first shelf, 11.5 m', (await where(SILK, loc))?.shelves?.find((s: any) => s.spotId === s11.id)?.quantity === 11.5);
  const renamed = await call('PUT', `/spots/${s11.id}`, { name: 'Silk shelf' });
  check('renaming a shelf keeps its label', renamed.status === 200 && (await prisma.storageSpot.findUnique({ where: { id: s11.id } }))?.labelCode === s11.labelCode, renamed);

  console.log('\nCOUNT A SHELF, PROBLEMS, THE QUEUE');
  const q0 = (await call('GET', `/stores/${loc}/count-queue`)).data ?? [];
  check('the count queue: shelves never counted first', q0.length === 6 && q0.every((s: any) => s.lastCountedAt === null), q0.length);
  const cnt = await call('POST', `/spots/${s11.id}/count`, { counts: [{ itemCode: SILK, quantity: 10 }], complete: true });
  check('count: 10 m silk found (11.5 on record), saris not counted on a complete count', cnt.status === 200, cnt);
  const probs = (await call('GET', '/shelf-problems')).data;
  check('...problems to check were raised', (probs?.total ?? probs?.items?.length ?? 0) > 0 || JSON.stringify(probs).includes(SILK), probs);
  const q1 = (await call('GET', `/stores/${loc}/count-queue`)).data ?? [];
  check('...and that shelf is now last in the queue', q1[q1.length - 1]?.id === s11.id, q1.map((s: any) => s.address));
  const firstProblem = (probs?.items ?? probs?.issues ?? [])[0];
  if (firstProblem) {
    const fx = await call('POST', `/shelf-problems/${firstProblem.id}/fix`, { note: 'recounted' });
    check('a problem is fixed with a note', fx.status === 200, fx);
  } else check('a problem is fixed with a note', false, probs);
  check('a problem status that is not one: 400', (await call('GET', '/shelf-problems?status=LOST')).status === 400);

  console.log('\nSTOCK LEAVING FOLLOWS THE SHELVES');
  const before = await where(SILK, loc);
  await call('POST', '/movements', { itemCode: SILK, kind: 'CONSUME', quantity: before.notShelved + 1 });
  const after = await where(SILK, loc);
  check(`CONSUME ${before.notShelved + 1} m with no shelf named: not-shelved first, then 1 m off the shelf`, after.notShelved === 0 && after.onShelves === before.onShelves - 1, [before, after]);

  console.log('\nREFUSALS AND PERMISSIONS');
  check('removing a shelf that holds stock: refused', (await call('DELETE', `/spots/${s11.id}`)).status >= 400);
  check('removing an empty shelf: done', (await call('DELETE', `/spots/${spots[5].id}`)).status === 200);
  check('a shelf of another shop: 404', (await call('GET', '/spots/00000000-0000-0000-0000-000000000000')).status === 404);
  check('a cutter (stitching only) may not put away: 403', (await call('POST', '/shelf-moves', { itemCode: SILK, locationId: loc, toSpotId: s12.id, quantity: 1 }, { can: ['stitching:issue'] })).status === 403);
  check('...nor set up racks: 403', (await call('POST', `/stores/${loc}/spots`, { kind: 'BOX', code: 'B9' }, { can: ['stock:transfer'] })).status === 403);
  check('searching "maroon" finds the silk on its shelf', JSON.stringify((await call('GET', `/where?search=maroon&locationId=${loc}`)).data).includes(SILK));
}

async function cleanup() {
  const ids = (await prisma.boutiqueLink.findMany({ where: { tenant: { startsWith: 'racktest-' } }, select: { clientId: true } })).map(l => l.clientId);
  if (!ids.length) return;
  const tables = await prisma.$queryRaw<{ table_name: string }[]>`SELECT DISTINCT table_name FROM information_schema.columns WHERE table_schema = 'public' AND column_name = 'client_id'`;
  await prisma.$executeRawUnsafe(`DELETE FROM inventory_transaction_spots WHERE transaction_id IN (SELECT id FROM inventory_transactions WHERE client_id = ANY($1))`, ids).catch(() => undefined);
  await prisma.$executeRawUnsafe(`UPDATE storage_spots SET parent_id = NULL WHERE client_id = ANY($1)`, ids).catch(() => undefined);
  for (let round = 0; round < 10; round++) {
    let left = 0;
    for (const t of tables) { try { await prisma.$executeRawUnsafe(`DELETE FROM "${t.table_name}" WHERE client_id = ANY($1)`, ids); } catch { left++; } }
    if (!left) break;
  }
  console.log(`\ncleaned up ${ids.length} clients`);
}

main()
  .catch(e => { bad++; console.error('CRASH', e); })
  .finally(async () => { await cleanup().catch(e => console.error('cleanup failed', e)); console.log(`${good} passed, ${bad} problems`); await prisma.$disconnect(); process.exit(bad ? 1 : 0); });
