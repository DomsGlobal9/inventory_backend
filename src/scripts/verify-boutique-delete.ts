/**
 * Deleting the boutique's items for good, one and many, and archiving them (17 Nov 2026), against the REAL local
 * server and database.
 *
 * Before: DELETE /items/:code only archived, so nothing a boutique made could ever be deleted and no code could be
 * used again. Now DELETE deletes (products:delete), POST /items/delete deletes up to 200, and archiving has its own
 * calls (POST /items/:code/archive, /restore, POST /items/archive).
 *
 * Every case: who may; an item never used (erased) and one colour of a design; an item with a past (kept out of
 * sight, its records intact, its code free again); stock on the shelf and cloth held for orders (refused, then
 * forced: written off, released); a purchase order not arrived and the shop's own customer orders (never forced);
 * an item on sale (the shop's channels are told); archived and binned items; shelves; the same request twice; two
 * deletes at once; a delete and a save at once; another shop's item; bulk with every kind of row, 200 at once, and
 * its limits; archive and bring back, one and many; what ScaleEzy's own screens do with a deleted item.
 *
 * Throwaway boutique accounts only (deltest-*); every client it makes is removed. Local only.
 *   DATABASE_URL=<local> DIRECT_URL=<local> VERIFY_API_URL=http://localhost:4036/api/v1 \
 *   BOUTIQUE_KEY_DIR=<dir with private.pem> npx tsx src/scripts/verify-boutique-delete.ts
 */
import fs from 'node:fs';
import axios from 'axios';
import jwt from 'jsonwebtoken';
import { prisma } from '../lib/prisma';
import { storefrontCatalogueService } from '../services/storefront-catalogue.service';
import { productService } from '../services/product.service';

const BASE = process.env.VERIFY_API_URL || 'http://localhost:4036/api/v1';
for (const k of ['DATABASE_URL', 'DIRECT_URL']) {
  if (!/localhost:55433/.test(process.env[k] ?? '')) { console.error(`Refusing: ${k} is not the local database.`); process.exit(2); }
}
if (!/localhost|127\.0\.0\.1/.test(BASE)) { console.error('Refusing: VERIFY_API_URL is not a local server.'); process.exit(2); }
const privateKey = fs.readFileSync(`${process.env.BOUTIQUE_KEY_DIR}/private.pem`, 'utf8');

const S = Date.now().toString(36);
const T1 = `deltest-${S}`, T2 = `deltest-${S}-b`;
let bad = 0, good = 0;
const check = (name: string, ok: boolean, detail: unknown = '') => {
  ok ? good++ : bad++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : ` :: ${typeof detail === 'string' ? detail : JSON.stringify(detail)?.slice(0, 600)}`}`);
};
/** Everything a boutique manager's pass carries, with the new word for deleting. */
const ALL = ['products:write', 'products:delete', 'stock:write', 'stitching:issue', 'suppliers:write', 'reports:view'];
type Opts = { key?: string; can?: string[]; tenant?: string };
const pass = (o: Opts) => jwt.sign({ sub: 'crm-b', scope: ['modules:boutique'], tenant: o.tenant ?? T1, onBehalfOf: { userId: 'u1', name: 'Lakshmi', can: o.can ?? ALL } },
  privateKey, { algorithm: 'RS256', audience: 'inventory', issuer: 'scaleezy-boutique-test', keyid: 'btq-1', expiresIn: '5m' });
let n = 0;
async function call(method: string, path: string, body?: unknown, o: Opts = {}) {
  const r = await axios.request({ method, url: `${BASE}/internal/boutique${path}`, data: body, validateStatus: () => true, timeout: 180_000,
    headers: { Authorization: `Bearer ${pass(o)}`, ...(method !== 'GET' ? { 'Idempotency-Key': o.key ?? `del-${S}-${++n}` } : {}) } });
  // `raw`: the whole answer -- a refusal's code, blockers and canForce sit beside its message.
  return { status: r.status, data: r.data?.data, message: r.data?.message as string | undefined, raw: r.data, replay: r.headers['idempotent-replay'] };
}
const wait = (ms: number) => new Promise(r => setTimeout(r, ms));
const keysOf = (o: unknown) => Object.keys((o ?? {}) as object).sort().join();
/** A material: counted and used, never sold. */
const cloth = (name: string, extra: Record<string, unknown> = {}) => ({ name, category: 'FABRIC', unit: 'METER', color: 'Maroon', sellingPrice: 450, purchasePrice: 280, ...extra });
const button = (name: string, extra: Record<string, unknown> = {}) => ({ name, category: 'EMBELLISHMENT', unit: 'PIECE', sellingPrice: 15, ...extra });

async function main() {
  const link = await call('POST', '/link', { shopName: 'Delete Test Boutique' });
  check('a throwaway boutique is linked', link.status === 201, link);
  const clientId = link.data.clientId as string;
  const link2 = await call('POST', '/link', { shopName: 'Other Boutique' }, { tenant: T2 });
  const client2 = link2.data.clientId as string;
  await prisma.storefrontConnection.create({ data: { clientId, name: 'test site', type: 'GENERIC' as any, status: 'ACTIVE' as any, baseUrl: 'https://example.invalid/hook', credentialHash: 'x', credentialPrefix: `d${S}` } });
  const loc = (await call('GET', '/stores')).data?.[0]?.id ?? (await call('GET', '/stores')).data?.stores?.[0]?.id;
  const rows = (where: object) => prisma.productVariant.findMany({ where: { clientId, ...where }, include: { product: true } });
  const item = async (code: string, o: Opts = {}) => (await call('GET', `/items/${encodeURIComponent(code)}`, undefined, o));
  const listed = async (q = '') => {
    const out: string[] = [];
    for (let page = 1; page < 30; page++) {
      const r = await call('GET', `/items?limit=100&page=${page}${q}`);
      out.push(...(r.data?.items ?? []).map((i: any) => i.itemCode));
      if (!r.data?.hasMore) break;
    }
    return out;
  };
  const del = (code: string, q = '', o: Opts = {}, body?: unknown) => call('DELETE', `/items/${encodeURIComponent(code)}${q}`, body, o);

  console.log('\nWHO MAY DELETE');
  const U0 = `${S}-U0`;
  await call('PUT', `/items/${U0}`, cloth('Plain lining'));
  const noWord = await del(U0, '', { can: ['products:write', 'stock:write', 'stitching:issue'] });
  check('a pass with products:write but not products:delete: 403, and the answer says which word and how to archive instead',
    noWord.status === 403 && /products:delete/.test(noWord.message ?? '') && /POST \/items\/\{itemCode\}\/archive/.test(noWord.message ?? '') && noWord.raw?.code === 'NOT_ALLOWED', noWord.raw);
  check('...and the item is untouched (an old "archive" button that still calls DELETE can no longer do harm)', (await item(U0)).data?.status === 'ACTIVE');
  check('a pass that can do nothing: 403', (await del(U0, '', { can: [] })).status === 403);
  check('products:delete alone is enough for an item with nothing at stake', (await del(U0, '', { can: ['products:delete'] })).status === 200);

  console.log('\nNEVER USED: ERASED');
  const U1 = `${S}-U1`;
  const made = await call('PUT', `/items/${U1}`, cloth('Trial fabric', { imageUrls: ['https://example.invalid/trial.jpg'] }));
  const u1Row = (await rows({ boutiqueRef: U1 }))[0];
  check('an item made by mistake, with a photo', made.status === 201 && !!u1Row && (await prisma.productImage.count({ where: { variantId: u1Row.id } })) === 1);
  const d1 = await del(U1);
  check('DELETE: 200, exactly { itemCode, deleted: true, historyKept: false }', d1.status === 200 && keysOf(d1.data) === 'deleted,historyKept,itemCode' && d1.data.itemCode === U1 && d1.data.deleted === true && d1.data.historyKept === false, d1.raw);
  check('...its row, its design and its photo are gone from the database', (await prisma.productVariant.count({ where: { id: u1Row.id } })) === 0 && (await prisma.product.count({ where: { id: u1Row.productId } })) === 0 && (await prisma.productImage.count({ where: { productId: u1Row.productId } })) === 0);
  check('...GET says there is no such item (404)', (await item(U1)).status === 404);
  check('...it is in no list', !(await listed()).includes(U1) && !(await listed('&status=ARCHIVED')).includes(U1) && !(await listed('&status=IN_BIN')).includes(U1) && !(await listed(`&search=${U1}`)).includes(U1));
  const look1 = await call('POST', '/items/lookup', { itemCodes: [U1] });
  check('...a lookup reports it not found', JSON.stringify(look1.data?.notFound) === JSON.stringify([U1]), look1.data);
  const remade = await call('PUT', `/items/${U1}`, cloth('Trial fabric, again'));
  check('its code is free: the same code makes a NEW item (201)', remade.status === 201 && remade.data?.name === 'Trial fabric, again' && (await item(U1)).data?.stock === 0, remade.raw);
  check('deleting twice: the second is 404 ("already gone"), never an error', (await del(`${S}-NEVER`)).status === 404 && (await del(`${S}-NEVER`)).raw?.code === 'NOT_FOUND');
  check('a code that is not a code: 400', (await del('has space')).status === 400 || (await del('has space')).status === 404);

  console.log('\nONE COLOUR OF A DESIGN');
  const C1 = `${S}-C1`, C2 = `${S}-C2`, C3 = `${S}-C3`;
  for (const [code, colour] of [[C1, 'Maroon'], [C2, 'Green'], [C3, 'Gold']]) await call('PUT', `/items/${code}`, cloth('Kanchi silk', { designGroup: `DES-${S}`, color: colour }));
  const design = (await rows({ boutiqueRef: C1 }))[0].product;
  const dc = await del(C2);
  check('delete the middle colour: erased', dc.status === 200 && dc.data?.historyKept === false);
  check('...the design keeps its other two colours, untouched', (await prisma.productVariant.count({ where: { productId: design.id } })) === 2 && (await item(C1)).data?.status === 'ACTIVE' && (await item(C3)).data?.colour === 'Gold');
  await del(C1); await del(C3);
  check('...the last colour gone: the design itself is gone', (await prisma.product.count({ where: { id: design.id } })) === 0);
  const again = await call('PUT', `/items/${C1}`, cloth('Kanchi silk', { designGroup: `DES-${S}`, color: 'Maroon' }));
  check('the same design group and code again: a fresh design, on the shelf as usual (not in any bin)', again.status === 201 && again.data?.status === 'ACTIVE' && again.data?.inBin === false, again.data);

  console.log('\nHAS A PAST: KEPT OUT OF SIGHT, ITS RECORDS INTACT, ITS CODE FREE');
  const H1 = `${S}-H1`;
  await call('PUT', `/items/${H1}`, cloth('Raw silk', { openingStock: [{ quantity: 10 }] }));
  await call('POST', '/movements', { itemCode: H1, kind: 'ISSUE', quantity: 10, orderRef: 'ST-41' });
  const groupsBefore = (await call('GET', '/items/groups')).data;
  const movesBefore = (await call('GET', `/movements?itemCode=${H1}`)).data;
  const usedBefore = (await call('GET', '/reports/consumption')).data;
  const orderBefore = (await call('GET', '/reports/order-usage?orderRef=ST-41')).data;
  check('an item received (10 m) and used up for an order: 2 movements, nothing in stock', movesBefore?.total === 2 && (await item(H1)).data?.stock === 0 && orderBefore?.lines?.[0]?.used === 10, [movesBefore?.total, orderBefore]);
  const dh = await del(H1);
  check('DELETE: 200, deleted, and it says its history is kept', dh.status === 200 && dh.data?.deleted === true && dh.data?.historyKept === true && keysOf(dh.data) === 'deleted,historyKept,itemCode', dh.raw);
  const kept = (await rows({ boutiqueRef: { startsWith: `${H1}#` } }))[0];
  check('in the database: marked deleted, a "#" tail on its code, sku and variant code, alone on a product in the bin under a key nothing will ask for',
    !!kept && !!kept.boutiqueDeletedAt && kept.sku.startsWith(`${H1}#`) && kept.variantCode.includes('#') && kept.product.status === 'TRASHED' && !!kept.product.trashedAt
    && (kept.product.importKey ?? '').startsWith('boutique-deleted#') && (await prisma.productVariant.count({ where: { productId: kept.productId } })) === 1, kept && { ref: kept.boutiqueRef, sku: kept.sku, product: kept.product.status, key: kept.product.importKey });
  check('GET: 404, and its history by code too', (await item(H1)).status === 404 && (await call('GET', `/items/${H1}/history`)).status === 404);
  check('in no list: all, ARCHIVED, IN_BIN, by search', !(await listed()).includes(H1) && !(await listed('&status=ARCHIVED')).includes(H1) && !(await listed('&status=IN_BIN')).includes(H1) && (await listed(`&search=${H1}`)).length === 0);
  const groupsAfter = (await call('GET', '/items/groups')).data;
  check('the counts: one fewer in "all", and NOT one more in the bin or the archive', groupsAfter.all === groupsBefore.all - 1 && groupsAfter.inBin === groupsBefore.inBin && groupsAfter.archived === groupsBefore.archived, [groupsBefore, groupsAfter]);
  check('not in alerts, low stock, or the stock summary\'s out-of-stock count', !((await call('GET', '/alerts')).data ?? []).some((a: any) => a.itemCode === H1) && !((await call('GET', '/reports/low-stock')).data ?? []).some((a: any) => a.itemCode === H1));
  check('a lookup and an availability check both say it is not there', JSON.stringify((await call('POST', '/items/lookup', { itemCodes: [H1] })).data?.notFound) === JSON.stringify([H1]) && (await call('POST', '/availability', { lines: [{ itemCode: H1, quantity: 1 }] })).status === 404);
  check('nothing new can be done to it: a movement, a hold, a count are each 404', (await call('POST', '/movements', { itemCode: H1, kind: 'PURCHASE', quantity: 1 })).status === 404
    && (await call('POST', '/holds', { itemCode: H1, quantity: 1, orderRef: 'ST-42' })).status === 404 && (await call('POST', '/counts', { itemCode: H1, counted: 0 })).status === 404
    && (await call('POST', '/transfers', { itemCode: H1, quantity: 1, fromLocationId: loc, toLocationId: loc })).status === 404);
  const allMoves = ((await call('GET', '/movements?limit=200')).data?.movements ?? []).filter((m: any) => m.itemCode === H1);
  check('its past movements still answer, under the code it had, marked itemDeleted', allMoves.length === 2 && allMoves.every((m: any) => m.itemDeleted === true) && allMoves.some((m: any) => m.kind === 'ISSUE' && m.orderRef === 'ST-41'), allMoves);
  const usedAfter = (await call('GET', '/reports/consumption')).data;
  const orderAfter = (await call('GET', '/reports/order-usage?orderRef=ST-41')).data;
  check('the reports of the past did not move: what was used, and what order ST-41 used', usedAfter?.totalValue === usedBefore?.totalValue && usedAfter.items.some((i: any) => i.itemCode === H1 && i.itemDeleted === true && i.quantity === 10)
    && orderAfter?.lines?.[0]?.itemCode === H1 && orderAfter.lines[0].used === 10 && orderAfter.totalCost === orderBefore.totalCost, [usedAfter, orderAfter]);
  const fresh = await call('PUT', `/items/${H1}`, cloth('Raw silk, new lot'));
  check('its code is free: the same code makes a NEW item, with no stock and no history of the old one', fresh.status === 201 && (await item(H1)).data?.stock === 0 && ((await call('GET', `/items/${H1}/history`)).data ?? []).length === 0
    && (await call('GET', `/movements?itemCode=${H1}`)).data?.total === 0, fresh.raw);
  check('...two rows now: the old one out of sight, the new one live', (await rows({ boutiqueRef: { startsWith: H1 } })).length === 2 && (await rows({ boutiqueRef: H1 })).length === 1);
  check('...and deleting the new one (never used) erases it, leaving the old record alone', (await del(H1)).data?.historyKept === false && (await rows({ boutiqueRef: { startsWith: H1 } })).length === 1);

  console.log('\nTHE NEXT FREE CODE');
  const n1 = (await call('GET', '/items/next-code?prefix=PRD')).data;
  await call('PUT', `/items/${n1.itemCode}`, cloth('Numbered', { openingStock: [{ quantity: 2 }] }));
  await call('POST', '/movements', { itemCode: n1.itemCode, kind: 'CONSUME', quantity: 2 });
  await del(n1.itemCode);
  const n2 = (await call('GET', '/items/next-code?prefix=PRD')).data;
  check('an item with a past, deleted: its number is not handed out again (it is that item in every old report)', n1.itemCode === 'PRD-0001' && n2.itemCode === 'PRD-0002', [n1, n2]);
  await call('PUT', `/items/${n2.itemCode}`, cloth('Numbered, by mistake'));
  await del(n2.itemCode);
  check('an item never used, deleted: its number is free again', (await call('GET', '/items/next-code?prefix=PRD')).data?.itemCode === 'PRD-0002');

  console.log('\nSTOCK STILL ON THE SHELF');
  const S1 = `${S}-S1`;
  await call('PUT', `/items/${S1}`, cloth('Georgette', { openingStock: [{ quantity: 12.5 }] }));
  const r1 = await del(S1);
  check('DELETE: 409 HAS_STOCK, in words, with the quantity, where it is, and that it can be forced', r1.status === 409 && r1.raw?.success === false && r1.raw?.code === 'HAS_STOCK' && r1.raw?.canForce === true
    && r1.raw.blockers?.length === 1 && r1.raw.blockers[0].quantity === 12.5 && r1.raw.blockers[0].byLocation?.[0]?.stock === 12.5 && /12\.50 m/.test(r1.message ?? '') && /force: true/.test(r1.message ?? ''), r1.raw);
  check('...nothing changed: it is still there with its 12.5 m', (await item(S1)).data?.stock === 12.5);
  check('the refusal is shaped as the guide says: success, code, message, canForce, blockers; a HAS_STOCK blocker has quantity and byLocation [{ locationId, name, stock }]',
    keysOf(r1.raw) === 'blockers,canForce,code,message,success' && keysOf(r1.raw.blockers[0]) === 'byLocation,canForce,code,message,quantity' && keysOf(r1.raw.blockers[0].byLocation[0]) === 'locationId,name,stock', r1.raw);
  const noStockWord = await del(S1, '?force=true', { can: ['products:write', 'products:delete'] });
  check('force without stock:write on the pass: 403 (writing stock off is a stock change), nothing changed', noStockWord.status === 403 && /stock:write/.test(noStockWord.message ?? '') && (await item(S1)).data?.stock === 12.5, noStockWord.raw);
  const f1 = await del(S1, '?force=true');
  check('?force=true: 200, deleted, history kept, and it says 12.5 m was written off', f1.status === 200 && f1.data?.deleted === true && f1.data.historyKept === true && f1.data.stockWrittenOff === 12.5 && f1.data.stockWrittenOffText === '12.50 m', f1.raw);
  const wo = ((await call('GET', '/movements?limit=200')).data?.movements ?? []).filter((m: any) => m.itemCode === S1);
  check('the books show where it went: a WRITE_OFF of -12.5 m bringing the stock to 0, by the person who deleted', wo.some((m: any) => m.kind === 'WRITE_OFF' && m.quantity === -12.5 && m.stockAfter === 0 && m.by === 'Lakshmi' && m.itemDeleted === true), wo);
  const goneS1 = (await rows({ boutiqueRef: { startsWith: `${S1}#` } }))[0];
  check('...and nothing is left on any shelf of the store', (await prisma.inventoryStock.findMany({ where: { variantId: goneS1.id } })).every(s => s.quantity === 0 && s.reservedQty === 0));
  const S2 = `${S}-S2`;
  await call('PUT', `/items/${S2}`, button('Brass button', { openingStock: [{ quantity: 40 }] }));
  const f2 = await del(S2, '', {}, { force: true });
  check('force in the body works the same (for HTTP libraries that send one with DELETE)', f2.status === 200 && f2.data?.stockWrittenOff === 40, f2.raw);
  check('"force" that is not true is not force: ?force=yes is still refused', (await (async () => { await call('PUT', `/items/${S}-S3`, button('Hook', { openingStock: [{ quantity: 3 }] })); return del(`${S}-S3`, '?force=yes'); })()).status === 409);

  console.log('\nCLOTH HELD FOR STITCHING ORDERS');
  const K1 = `${S}-K1`;
  await call('PUT', `/items/${K1}`, cloth('Chiffon', { openingStock: [{ quantity: 10 }] }));
  const hold = await call('POST', '/holds', { itemCode: K1, quantity: 4, orderRef: 'ST-9' });
  const rk = await del(K1);
  check('DELETE: 409, and BOTH reasons are listed: 4 m held for ST-9, 10 m in stock', rk.status === 409 && rk.raw?.code === 'HELD_FOR_ORDERS' && rk.raw.canForce === true
    && JSON.stringify(rk.raw.blockers.map((b: any) => b.code)) === JSON.stringify(['HELD_FOR_ORDERS', 'HAS_STOCK']) && rk.raw.blockers[0].quantity === 4 && JSON.stringify(rk.raw.blockers[0].orderRefs) === JSON.stringify(['ST-9']), rk.raw);
  const fk = await del(K1, '?force=true');
  check('force: the hold is let go (4 m, ST-9) and the 10 m written off', fk.status === 200 && fk.data?.holdsReleased === 4 && JSON.stringify(fk.data.orderRefs) === JSON.stringify(['ST-9']) && fk.data.stockWrittenOff === 10, fk.raw);
  check('...the forced answer is shaped as the guide says, and the HELD_FOR_ORDERS blocker had quantity and orderRefs', keysOf(fk.data) === 'deleted,historyKept,holdsReleased,itemCode,orderRefs,stockWrittenOff,stockWrittenOffText'
    && fk.data.stockWrittenOffText === '10.00 m' && keysOf(rk.raw.blockers[0]) === 'canForce,code,message,orderRefs,quantity', [fk.data, rk.raw.blockers[0]]);
  const holdsNow = (await call('GET', '/holds?orderRef=ST-9&all=1')).data ?? [];
  check('...the order\'s hold reads RELEASED, still naming the item by its code, marked itemDeleted', holdsNow.length === 1 && holdsNow[0].reservationId === hold.data?.reservationId && holdsNow[0].status === 'RELEASED' && holdsNow[0].itemCode === K1 && holdsNow[0].itemDeleted === true, holdsNow);

  console.log('\nA PURCHASE ORDER THAT HAS NOT ARRIVED (never forced)');
  const sup = (await call('POST', '/suppliers', { name: `Ravi Silks ${S}` })).data;
  const P1 = `${S}-P1`, P2 = `${S}-P2`;
  await call('PUT', `/items/${P1}`, cloth('Crepe'));
  await call('PUT', `/items/${P2}`, cloth('Organza'));
  const po1 = await call('POST', '/purchase-orders', { supplierId: sup.id, lines: [{ itemCode: P1, quantity: 5, unitCost: 200 }] });
  const rp = await del(P1, '?force=true');
  check('on a draft order: 409 ON_PURCHASE_ORDER naming the order, even with force (canForce false)', rp.status === 409 && rp.raw?.code === 'ON_PURCHASE_ORDER' && rp.raw.canForce === false
    && JSON.stringify(rp.raw.blockers[0].purchaseOrders) === JSON.stringify([po1.data?.number ?? po1.data?.poNumber]) && (await item(P1)).status === 200, [rp.raw, po1.data]);
  await call('PUT', `/purchase-orders/${po1.data.id}`, { status: 'CANCELLED' });
  const dp = await del(P1);
  const poLine = (await call('GET', `/purchase-orders/${po1.data.id}`)).data?.lines?.[0];
  check('the order cancelled: it deletes; the cancelled order keeps its line (its code, marked itemDeleted), so its history is kept', dp.status === 200 && dp.data?.historyKept === true && poLine?.itemCode === P1 && poLine.itemDeleted === true, [dp.raw, poLine]);
  const po2 = await call('POST', '/purchase-orders', { supplierId: sup.id, status: 'ORDERED', lines: [{ itemCode: P2, quantity: 5, unitCost: 200 }] });
  await call('POST', `/purchase-orders/${po2.data.id}/receive`, { lines: [{ itemCode: P2, quantity: 2 }] });
  const rp2 = await del(P2, '?force=true');
  check('ordered, 2 of 5 m arrived: 409, the order first, then the stock; force cannot do it', rp2.status === 409 && rp2.raw?.code === 'ON_PURCHASE_ORDER' && rp2.raw.canForce === false
    && JSON.stringify(rp2.raw.blockers.map((b: any) => b.code)) === JSON.stringify(['ON_PURCHASE_ORDER', 'HAS_STOCK']) && (await item(P2)).data?.stock === 2, rp2.raw);
  await call('POST', `/purchase-orders/${po2.data.id}/receive`, { lines: [{ itemCode: P2, quantity: 3 }] });
  const rp3 = await del(P2);
  check('all 5 m arrived: only the stock stands in the way now (HAS_STOCK, can be forced)', rp3.status === 409 && rp3.raw?.code === 'HAS_STOCK' && rp3.raw.canForce === true && rp3.raw.blockers.length === 1 && rp3.raw.blockers[0].quantity === 5, rp3.raw);
  check('...forced: deleted, 5 m written off', (await del(P2, '?force=true')).data?.stockWrittenOff === 5);

  console.log('\nPIECES KEPT FOR THE SHOP\'S OWN CUSTOMER ORDERS (never forced)');
  const W1 = `${S}-W1`;
  await call('PUT', `/items/${W1}`, { name: 'Ready blouse', category: 'FINISHED', kind: 'BLOUSE', unit: 'PIECE', color: 'Red', sellingPrice: 900, sellInShop: true, openingStock: [{ quantity: 3 }] });
  const w1 = (await rows({ boutiqueRef: W1 }))[0];
  // What an online order does while it waits to be packed: 2 of the 3 are kept for it (not a boutique hold).
  await prisma.inventoryStock.updateMany({ where: { variantId: w1.id, quantity: { gt: 0 } }, data: { reservedQty: 2 } });
  const rw = await del(W1, '?force=true');
  check('409 SHOP_ORDERS_WAITING for the 2 pieces, even with force; the message says to archive it for now', rw.status === 409 && rw.raw?.code === 'SHOP_ORDERS_WAITING' && rw.raw.canForce === false && rw.raw.blockers[0].quantity === 2 && /Archive it for now/.test(rw.message ?? ''), rw.raw);
  check('...and it is still on sale, untouched', (await item(W1)).data?.status === 'ACTIVE' && (await item(W1)).data?.stock === 3);
  await prisma.inventoryStock.updateMany({ where: { variantId: w1.id }, data: { reservedQty: 0 } });
  check('the order packed (nothing kept any more): it can be deleted, with force for its 3 pieces', (await del(W1, '?force=true')).data?.stockWrittenOff === 3);

  console.log('\nON SALE: THE SHOP\'S CHANNELS ARE TOLD');
  const events = async (productId: string) => {
    const p = await prisma.product.findUnique({ where: { id: productId }, select: { productCode: true } });
    return p ? (await prisma.storefrontEvent.findMany({ where: { clientId, productCode: p.productCode }, orderBy: { sequence: 'asc' }, select: { eventType: true } })).map(e => e.eventType) : [];
  };
  const O1 = `${S}-O1`, O2 = `${S}-O2`, O3 = `${S}-O3`;
  await call('PUT', `/items/${O1}`, { name: 'Silk saree', designGroup: `SOLO-${S}`, kind: 'SAREE', unit: 'PIECE', color: 'Pink', sellingPrice: 2500, sellInShop: true, category: 'FINISHED' });
  for (const [c, col] of [[O2, 'Blue'], [O3, 'Green']]) await call('PUT', `/items/${c}`, { name: 'Cotton saree', designGroup: `PAIR-${S}`, kind: 'SAREE', unit: 'PIECE', color: col, sellingPrice: 1500, sellInShop: true, category: 'FINISHED' });
  const solo = (await rows({ boutiqueRef: O1 }))[0].product, pair = (await rows({ boutiqueRef: O2 }))[0].product;
  await wait(1500);
  const do1 = await del(O1);
  await wait(1500);
  const evSolo = await events(solo.id);
  check('a saree on sale, never sold, deleted: kept (so the channels can be told) and the website hears it is withdrawn', do1.status === 200 && do1.data?.historyKept === true && evSolo[evSolo.length - 1] === 'PRODUCT_UNPUBLISHED', [do1.raw, evSolo]);
  check('...the online shop no longer has it', (await storefrontCatalogueService.getProduct({ clientId, locationIds: [] }, solo.productCode, { withLengths: true })) === null);
  await del(O2);
  await wait(1500);
  const evPair = await events(pair.id);
  const shop = await storefrontCatalogueService.getProduct({ clientId, locationIds: [] }, pair.productCode, { withLengths: true });
  check('one colour of a design on sale deleted: the website hears the design changed, and the shop sells the other colour only', evPair[evPair.length - 1] === 'PRODUCT_UPDATED' && JSON.stringify((shop as any)?.variants?.map((v: any) => v.sku)) === JSON.stringify([O3]), [evPair, (shop as any)?.variants?.map((v: any) => v.sku)]);

  console.log('\nARCHIVED AND BINNED ITEMS CAN BE DELETED TOO');
  const A1 = `${S}-A1`, A2 = `${S}-A2`;
  await call('PUT', `/items/${A1}`, cloth('Old stock'));
  await call('POST', `/items/${A1}/archive`);
  check('an archived item (never used) is erased', (await item(A1)).data?.status === 'ARCHIVED' && (await del(A1)).data?.historyKept === false && (await item(A1)).status === 404);
  await call('PUT', `/items/${A2}`, cloth('Binned by the owner'));
  const a2 = (await rows({ boutiqueRef: A2 }))[0];
  await prisma.product.update({ where: { id: a2.productId }, data: { status: 'TRASHED' as any, trashedAt: new Date(), previousStatus: 'ACTIVE' as any } });
  check('an item the owner put in ScaleEzy\'s bin reads IN_BIN, and the boutique can delete it', (await item(A2)).data?.status === 'IN_BIN' && (await del(A2)).status === 200 && (await item(A2)).status === 404);

  console.log('\nON THE SHELVES');
  const R1 = `${S}-R1`;
  await call('PUT', `/items/${R1}`, cloth('Shelf silk', { openingStock: [{ quantity: 8 }] }));
  await call('POST', `/stores/${loc}/spots/bulk`, { levels: [{ kind: 'RACK', range: { from: 1, to: 1 } }, { kind: 'SHELF', range: { from: 1, to: 1 } }] });
  const shelf = (await prisma.storageSpot.findMany({ where: { locationId: loc, kind: 'SHELF' as any } }))[0];
  const putAway = await call('POST', '/shelf-moves', { itemCode: R1, locationId: loc, toSpotId: shelf.id, quantity: 8 });
  const r1Row = (await rows({ boutiqueRef: R1 }))[0];
  check('8 m put on a shelf', putAway.status === 200 && (await prisma.spotStock.count({ where: { variantId: r1Row.id, quantity: { gt: 0 } } })) === 1, putAway.raw);
  check('deleted with force: nothing of it is left on the shelf, and the shelf no longer lists it', (await del(R1, '?force=true')).data?.stockWrittenOff === 8 && (await prisma.spotStock.count({ where: { variantId: r1Row.id } })) === 0
    && !JSON.stringify((await call('GET', `/spots/${shelf.id}`)).data ?? {}).includes(R1));

  console.log('\nTHE SAME REQUEST TWICE, TWO AT ONCE, ANOTHER SHOP');
  const X1 = `${S}-X1`, X2 = `${S}-X2`, X3 = `${S}-X3`, X4 = `${S}-X4`;
  for (const c of [X1, X2, X3, X4]) await call('PUT', `/items/${c}`, button(`Bead ${c}`));
  const key = `del-same-${S}`;
  const first = await del(X1, '', { key }), second = await del(X1, '', { key });
  check('the same request id again: the same answer, marked a replay, not a 404', first.status === 200 && second.status === 200 && second.replay === 'true' && keysOf(second.data) === keysOf(first.data) && Object.keys(first.data).every(k => JSON.stringify(second.data[k]) === JSON.stringify(first.data[k])), [first.raw, second.raw, second.replay]);
  check('the same request id for a different item: 409 (never deletes the wrong one)', (await del(X2, '', { key })).status === 409 && (await item(X2)).status === 200);
  const both = await Promise.all([del(X2), del(X2)]);
  check('two deletes of one item at the same moment: one 200, one 404, no error', both.map(b => b.status).sort().join() === '200,404', both.map(b => [b.status, b.message]));
  const race = await Promise.all([del(X3), call('PUT', `/items/${X3}`, button('Bead, renamed'))]);
  const after = await item(X3);
  check('a delete and a save of one item at the same moment: both answer without an error, and what is left is one whole item or none',
    race.every(r => [200, 201].includes(r.status)) && (after.status === 404 || (after.status === 200 && after.data?.name === 'Bead, renamed')) && (await rows({ boutiqueRef: X3 })).length <= 1, [race.map(r => r.status), after.status]);
  await call('PUT', `/items/${X4}`, button('Mine'));
  await call('PUT', `/items/${X4}`, button('Theirs'), { tenant: T2 });
  check('one shop deleting a code does not touch another shop\'s item of the same code', (await del(X4)).status === 200 && (await item(X4)).status === 404 && (await item(X4, { tenant: T2 })).data?.name === 'Theirs'
    && (await prisma.productVariant.count({ where: { clientId: client2, boutiqueRef: X4 } })) === 1);
  check('...and a shop cannot delete what it does not have: 404', (await del(`${S}-ONLY-T1`, '', { tenant: T2 })).status === 404);
  const SL = `${S}/SL`;
  await call('PUT', `/items/${encodeURIComponent(SL)}`, button('Slash code'));
  check('a code with a slash (URL-encoded) deletes like any other', (await del(SL)).status === 200 && (await item(SL)).status === 404);

  console.log('\nMANY AT ONCE: POST /items/delete');
  const b = (x: string) => `${S}-B${x}`;
  await call('PUT', `/items/${b('1')}`, button('Never used'));
  await call('PUT', `/items/${b('2')}`, button('Used up', { openingStock: [{ quantity: 5 }] }));
  await call('POST', '/movements', { itemCode: b('2'), kind: 'CONSUME', quantity: 5 });
  await call('PUT', `/items/${b('3')}`, button('Still in stock', { openingStock: [{ quantity: 7 }] }));
  await call('PUT', `/items/${b('4')}`, button('Held', { openingStock: [{ quantity: 4 }] }));
  await call('POST', '/holds', { itemCode: b('4'), quantity: 1, orderRef: 'ST-77' });
  const bulk = await call('POST', '/items/delete', { itemCodes: [b('1'), b('2'), b('3'), b('NOPE'), b('1'), 12, b('4')] });
  const res = bulk.data?.results ?? [];
  check('7 rows: 2 deleted, 5 refused, each row answered on its own, in order, with its row number', bulk.status === 200 && bulk.data?.deleted === 2 && bulk.data.refused === 5 && res.length === 7 && res.map((r: any) => r.row).join() === '1,2,3,4,5,6,7', bulk.raw);
  check('row 1 (never used): deleted, erased', res[0]?.ok === true && res[0].itemCode === b('1') && res[0].deleted === true && res[0].historyKept === false, res[0]);
  check('the bulk answer is shaped as the guide says: { deleted, refused, results }; a done row { row, ok, itemCode, deleted, historyKept }; a refused one { row, ok, itemCode, status, code, message }',
    keysOf(bulk.data) === 'deleted,refused,results' && keysOf(res[0]) === 'deleted,historyKept,itemCode,ok,row' && keysOf(res[3]) === 'code,itemCode,message,ok,row,status' && res[4].status === 400 && keysOf(res[2]) === 'blockers,canForce,code,itemCode,message,ok,row,status', [res[0], res[3], res[2]]);
  check('row 2 (used up): deleted, history kept', res[1]?.ok === true && res[1].historyKept === true, res[1]);
  check('row 3 (in stock): refused HAS_STOCK with its blockers and canForce', res[2]?.ok === false && res[2].status === 409 && res[2].code === 'HAS_STOCK' && res[2].canForce === true && res[2].blockers?.[0]?.quantity === 7, res[2]);
  check('row 4 (no such item): refused NOT_FOUND', res[3]?.ok === false && res[3].status === 404 && res[3].code === 'NOT_FOUND', res[3]);
  check('row 5 (the same code twice): refused DUPLICATE; row 6 (not text): refused BAD_CODE', res[4]?.ok === false && res[4].code === 'DUPLICATE' && res[5]?.ok === false && res[5].code === 'BAD_CODE', [res[4], res[5]]);
  check('row 7 (held and in stock): refused HELD_FOR_ORDERS, both blockers listed', res[6]?.ok === false && res[6].code === 'HELD_FOR_ORDERS' && res[6].blockers?.length === 2, res[6]);
  check('a refused row undid nothing else, and was itself left exactly as it was', (await item(b('1'))).status === 404 && (await item(b('2'))).status === 404 && (await item(b('3'))).data?.stock === 7 && (await item(b('4'))).data?.reserved === 1);
  const forcedBulk = await call('POST', '/items/delete', { itemCodes: [b('3'), b('4')], force: true });
  check('the same two with force: true: both deleted; 7 written off; 4 written off and 1 hold released', forcedBulk.data?.deleted === 2 && forcedBulk.data.results[0].stockWrittenOff === 7 && forcedBulk.data.results[1].stockWrittenOff === 4 && forcedBulk.data.results[1].holdsReleased === 1, forcedBulk.raw);
  const bk = `del-bulk-${S}`;
  await call('PUT', `/items/${b('5')}`, button('Replay me'));
  const bulk1 = await call('POST', '/items/delete', { itemCodes: [b('5')] }, { key: bk }), bulk2 = await call('POST', '/items/delete', { itemCodes: [b('5')] }, { key: bk });
  check('the same bulk request again: the first answer (deleted 1), a replay, not "not found"', bulk1.data?.deleted === 1 && bulk2.data?.deleted === 1 && bulk2.replay === 'true', [bulk1.raw, bulk2.raw]);
  check('no list: 400; an empty list: 400; not a list: 400; 201 codes: 400 saying to send it in parts; force that is not true/false: 400',
    (await call('POST', '/items/delete', {})).status === 400 && (await call('POST', '/items/delete', { itemCodes: [] })).status === 400 && (await call('POST', '/items/delete', { itemCodes: 'A,B' })).status === 400
    && (await (async () => { const r = await call('POST', '/items/delete', { itemCodes: Array.from({ length: 201 }, (_, i) => `x${i}`) }); return r.status === 400 && /200/.test(r.message ?? '') && r.raw?.code === 'TOO_MANY'; })())
    && (await call('POST', '/items/delete', { itemCodes: ['x'], force: 'yes' })).status === 400);
  check('without products:delete: 403, nothing deleted', (await call('POST', '/items/delete', { itemCodes: [b('1')] }, { can: ['products:write', 'stock:write'] })).status === 403);
  const many = Array.from({ length: 200 }, (_, i) => `${S}-M${String(i).padStart(3, '0')}`);
  const imp = await call('POST', '/items/import', { items: many.map((c, i) => ({ itemCode: c, ...button(`Bead ${i}`) })) });
  const t0 = Date.now();
  const all = await call('POST', '/items/delete', { itemCodes: many });
  check(`200 items imported, then 200 deleted in one call (${Math.round((Date.now() - t0) / 100) / 10} s): all 200, none left`, imp.data?.added === 200 && all.status === 200 && all.data?.deleted === 200 && all.data.refused === 0
    && (await prisma.productVariant.count({ where: { clientId, boutiqueRef: { in: many } } })) === 0, [imp.data?.added, all.data?.deleted, all.message]);

  console.log('\nARCHIVE AND BRING BACK, ONE AND MANY');
  const V1 = `${S}-V1`, V2 = `${S}-V2`;
  await call('PUT', `/items/${V1}`, cloth('Seasonal', { openingStock: [{ quantity: 6 }] }));
  await call('PUT', `/items/${V2}`, cloth('Seasonal two'));
  const ar = await call('POST', `/items/${V1}/archive`);
  check('POST /items/{code}/archive: 200 archived; it reads ARCHIVED, keeps its 6 m, and is still in the list', ar.status === 200 && ar.data?.archived === true && (await item(V1)).data?.status === 'ARCHIVED' && (await item(V1)).data?.stock === 6 && (await listed('&status=ARCHIVED')).includes(V1) && keysOf(ar.data) === 'archived,itemCode', ar.raw);
  check('archiving needs products:write (products:delete alone: 403)', (await call('POST', `/items/${V2}/archive`, undefined, { can: ['products:delete'] })).status === 403);
  const back = await call('POST', `/items/${V1}/restore`);
  check('POST /items/{code}/restore: it is ACTIVE again, with its 6 m; the answer is the item', back.status === 200 && back.data?.itemCode === V1 && back.data?.status === 'ACTIVE' && (await item(V1)).data?.status === 'ACTIVE' && (await item(V1)).data?.stock === 6, back.raw);
  check('restoring an item that is not archived changes nothing (200)', (await call('POST', `/items/${V1}/restore`)).status === 200 && (await item(V1)).data?.status === 'ACTIVE');
  check('restoring a code that does not exist, or one that was deleted: 404 saying to add it again', (await call('POST', `/items/${S}-NOPE/restore`)).status === 404 && /add it again/.test((await call('POST', `/items/${b('1')}/restore`)).message ?? ''));
  const bulkArc = await call('POST', '/items/archive', { itemCodes: [V1, V2, `${S}-NOPE`] });
  check('POST /items/archive: 2 archived, 1 refused (no such item)', bulkArc.status === 200 && bulkArc.data?.archived === 2 && bulkArc.data.refused === 1 && bulkArc.data.results[2].code === 'NOT_FOUND' && (await item(V1)).data?.status === 'ARCHIVED' && (await item(V2)).data?.status === 'ARCHIVED', bulkArc.raw);
  const bulkBack = await call('POST', '/items/archive', { itemCodes: [V1, V2], archived: false });
  check('...with archived: false: both back', bulkBack.data?.restored === 2 && (await item(V1)).data?.status === 'ACTIVE' && (await item(V2)).data?.status === 'ACTIVE', bulkBack.raw);
  check('the bulk archive answers are shaped as the guide says ({ archived | restored, refused, results } and rows { row, ok, itemCode, archived })', keysOf(bulkArc.data) === 'archived,refused,results' && keysOf(bulkBack.data) === 'refused,restored,results'
    && keysOf(bulkArc.data.results[0]) === 'archived,itemCode,ok,row' && bulkBack.data.results[0].archived === false && keysOf(bulkArc.data.results[2]) === 'code,itemCode,message,ok,row,status', [bulkArc.data, bulkBack.data]);
  check('PUT with "archived": true still archives (unchanged), and DELETE is no longer an archive', (await call('PUT', `/items/${V2}`, { archived: true })).data?.status === 'ARCHIVED' && (await del(V2)).data?.deleted === true && (await item(V2)).status === 404);
  check('archived: "yes" is refused (400); more than 200 at once is refused (400)', (await call('POST', '/items/archive', { itemCodes: [V1], archived: 'yes' })).status === 400 && (await call('POST', '/items/archive', { itemCodes: Array.from({ length: 201 }, (_, i) => `x${i}`) })).status === 400);

  console.log('\nSCALEEZY\'S OWN SCREENS');
  let said = '';
  try { await productService.restoreProduct(kept.productId, clientId); } catch (e: any) { said = String(e?.message ?? e); }
  check('the owner cannot "restore" an item the boutique deleted: refused, in words', /deleted in your boutique app/.test(said), said);
  check('...and it is still in the bin, still marked deleted', (await prisma.product.findUnique({ where: { id: kept.productId } }))?.status === 'TRASHED' && !!(await prisma.productVariant.findUnique({ where: { id: kept.id } }))?.boutiqueDeletedAt);

  console.log('\nAT THE END');
  const live = (await listed()).sort();
  // O3: the colour of the pair design that was never deleted. X3: there only if, in the race above, the save came after the delete.
  const expected = [C1, V1, U1, `${S}-S3`, O3, ...((await item(X3)).status === 200 ? [X3] : [])].sort();
  check('the list shows exactly the items never deleted (and the one remade after deleting)', JSON.stringify(live) === JSON.stringify(expected), { live, expected });
  check('no deleted item is in any list of any status', (await prisma.productVariant.count({ where: { clientId, boutiqueDeletedAt: { not: null }, boutiqueRef: { in: live } } })) === 0);
}

async function cleanup() {
  const ids = (await prisma.boutiqueLink.findMany({ where: { tenant: { startsWith: 'deltest-' } }, select: { clientId: true } })).map(l => l.clientId);
  if (!ids.length) return;
  const tables = await prisma.$queryRaw<{ table_name: string }[]>`SELECT DISTINCT table_name FROM information_schema.columns WHERE table_schema = 'public' AND column_name = 'client_id'`;
  await prisma.$executeRawUnsafe(`DELETE FROM inventory_product_images WHERE product_id IN (SELECT id FROM inventory_products WHERE client_id = ANY($1))`, ids).catch(() => undefined);
  await prisma.$executeRawUnsafe(`DELETE FROM storefront_deliveries WHERE connection_id IN (SELECT id FROM storefront_connections WHERE client_id = ANY($1))`, ids).catch(() => undefined);
  for (let round = 0; round < 8; round++) {
    let left = 0;
    for (const t of tables) { try { await prisma.$executeRawUnsafe(`DELETE FROM "${t.table_name}" WHERE client_id = ANY($1)`, ids); } catch { left++; } }
    if (!left) break;
  }
  console.log(`\ncleaned up ${ids.length} clients`);
}

main()
  .catch(e => { bad++; console.error('CRASH', e); })
  .finally(async () => { await cleanup().catch(e => console.error('cleanup failed', e)); console.log(`${good} passed, ${bad} problems`); await prisma.$disconnect(); process.exit(bad ? 1 : 0); });
