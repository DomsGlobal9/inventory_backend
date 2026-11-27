/**
 * Boutique items can be changed on ScaleEzy's own screens too (27 Nov 2026, owner: "when we shifted to boutique to
 * manage Swathy Reddy we are unable to change in inventory -- in ours also can able to change"), and the boutique app
 * hears about every change (GET /internal/boutique/items/changed). Against the REAL local server and database:
 *
 *  A. A boutique item, changed by the owner (the same service calls the screens make):
 *     name, price, GST, HSN, colour, size, purchase price, reorder level -> saved, each noted with the boutique's
 *     field names; saving the form unchanged notes nothing; a bulk price change and the bin/archive/restore are noted;
 *     a new colour gets its item code and is noted ADDED; a colour with no history can be deleted (noted DELETED),
 *     one with stock cannot (usual rule), one with cloth held for a stitching order cannot (409 in words).
 *     The boutique app's own save afterwards wins and is never noted. A retail item of the same shop notes nothing.
 *  B. The feed: oldest first, the item as it is now, null for a deleted one, a cursor that never repeats or skips,
 *     nothing younger than settleSeconds, nothing of another shop, `after` checked.
 *  C. A shop handed to the boutique app: the hand-over is remembered; a product the owner adds later (any way) is
 *     the boutique's item at once, priced by the boutique app, listed and noted; a whole product deleted is noted.
 *     The migration's back-fill recognises a shop handed over before the column existed. Module off: nothing shared.
 *
 * Throwaway shops only (bothedit-*); everything is removed. Local only.
 *   DATABASE_URL=<local> DIRECT_URL=<local> VERIFY_API_URL=http://localhost:4046/api/v1 \
 *   BOUTIQUE_KEY_DIR=<dir with private.pem> npx tsx src/scripts/verify-boutique-both-edit.ts
 */
import fs from 'node:fs';
import { execSync } from 'node:child_process';
import axios from 'axios';
import jwt from 'jsonwebtoken';
import { prisma } from '../lib/prisma';
import { productService } from '../services/product.service';
import { variantService } from '../services/variant.service';

const BASE = process.env.VERIFY_API_URL || 'http://localhost:4036/api/v1';
for (const k of ['DATABASE_URL', 'DIRECT_URL']) {
  if (!/localhost:55433/.test(process.env[k] ?? '')) { console.error(`Refusing: ${k} is not the local database.`); process.exit(2); }
}
if (!/localhost|127\.0\.0\.1/.test(BASE)) { console.error('Refusing: VERIFY_API_URL is not a local server.'); process.exit(2); }
const privateKey = fs.readFileSync(`${process.env.BOUTIQUE_KEY_DIR}/private.pem`, 'utf8');
const CONSOLE = execSync('npx tsx src/scripts/print-local-console-token.ts', { env: process.env, encoding: 'utf8' }).match(/eyJ[A-Za-z0-9._-]+/)![0];

const S = Date.now().toString(36);
let bad = 0, good = 0;
const check = (name: string, ok: boolean, detail: unknown = '') => {
  ok ? good++ : bad++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : ` :: ${typeof detail === 'string' ? detail : JSON.stringify(detail)?.slice(0, 600)}`}`);
};
let n = 0;
const shop = (tenant: string) => async (method: string, path: string, body?: unknown) => {
  const pass = jwt.sign({ sub: 'crm-b', scope: ['modules:boutique'], tenant, onBehalfOf: { userId: 'u1', name: 'Both', can: ['products:write', 'products:delete', 'stock:write', 'stitching:issue'] } },
    privateKey, { algorithm: 'RS256', audience: 'inventory', issuer: 'scaleezy-boutique-test', keyid: 'btq-1', expiresIn: '5m' });
  const r = await axios.request({ method, url: `${BASE}/internal/boutique${path}`, data: body, validateStatus: () => true, timeout: 120_000,
    headers: { Authorization: `Bearer ${pass}`, ...(method !== 'GET' ? { 'Idempotency-Key': `both-${S}-${++n}` } : {}) } });
  return { status: r.status, data: r.data?.data, message: r.data?.message as string | undefined };
};
async function consoleApi(method: string, path: string, body?: unknown) {
  const r = await axios.request({ method, url: `${BASE}/admin${path}`, data: body, validateStatus: () => true, timeout: 120_000,
    headers: { Cookie: `platform_admin_token=${CONSOLE}`, Origin: 'http://localhost:5183' } });
  return { status: r.status, data: r.data?.data, message: r.data?.message as string | undefined };
}
const owner = async (fn: () => Promise<unknown>) => { try { await fn(); return 'saved'; } catch (e: any) { return `${e.statusCode ?? e.status ?? '?'} ${e.message}`; } };
const notes = (clientId: string) => prisma.boutiqueShopEdit.findMany({ where: { clientId }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
/** The feed runs settleSeconds behind; the notes are aged instead of waiting two minutes. */
const brief = (d: any) => ({ rows: (d?.changes ?? []).map((c: any) => `${c.kind}:${c.itemCode}:${c.fields.join('+')}:${c.item ? c.item.name + '/' + c.item.sellingPrice : 'null'}`), hasMore: d?.hasMore, next: d?.next });
const age = (clientId: string) => prisma.$executeRaw`UPDATE boutique_shop_edits SET created_at = created_at - interval '3 minutes' WHERE client_id = ${clientId}`;
const clear = (clientId: string) => prisma.boutiqueShopEdit.deleteMany({ where: { clientId } });
/** The notes made by one owner action: what changed, by the boutique's names. */
async function noted(clientId: string, fn: () => Promise<unknown>) {
  await clear(clientId);
  const r = await owner(fn);
  const rows = await notes(clientId);
  return { r, rows, fields: [...new Set(rows.flatMap(x => (x.fields as string[] | null) ?? []))].sort(), kinds: [...new Set(rows.map(x => x.kind))] };
}

async function main() {
  const A = shop(`bothedit-a-${S}`), B = shop(`bothedit-b-${S}`);
  const cA = (await A('POST', '/link', { shopName: 'Both A' })).data.clientId as string;
  const cB = (await B('POST', '/link', { shopName: 'Both B' })).data.clientId as string;
  const KURTI = `KURTI-${S}`.toUpperCase();
  const put = await A('PUT', `/items/${KURTI}`, { name: 'Anarkali kurti', designGroup: `ANK-${S}`, category: 'FINISHED', unit: 'PIECE', color: 'Maroon', size: 'M', sellingPrice: 1200, purchasePrice: 700, gstPercent: 5, hsnCode: '6204', sellInShop: true, openingStock: [{ quantity: 3 }] });
  check('setup: the boutique app makes a kurti (1,200, 3 pieces)', put.status < 300, put);
  const v = (await prisma.productVariant.findFirst({ where: { clientId: cA, boutiqueRef: KURTI } }))!;
  const p = (await prisma.product.findUnique({ where: { id: v.productId } }))!;

  console.log('A. THE OWNER CHANGES A BOUTIQUE ITEM IN SCALEEZY');
  let x = await noted(cA, () => productService.updateProduct(p.id, cA, { title: 'Anarkali kurti, silk' }));
  check('renames it: saved, noted as "name"', x.r === 'saved' && x.fields.join() === 'name' && x.rows.length === 1 && x.rows[0].itemCode === KURTI, x);
  check('...the boutique app reads the new name', (await A('GET', `/items/${KURTI}`)).data?.name === 'Anarkali kurti, silk');
  x = await noted(cA, () => variantService.updateVariant(v.id, cA, { sellingPrice: 1100 }));
  check('changes its price to 1,100: saved, noted as "sellingPrice"', x.r === 'saved' && x.fields.join() === 'sellingPrice', x);
  check('...the boutique app reads 1,100', (await A('GET', `/items/${KURTI}`)).data?.sellingPrice === 1100);
  x = await noted(cA, () => productService.updateProduct(p.id, cA, { taxRateBps: 1200, hsnCode: '6211' }));
  check('changes its GST to 12% and its HSN: saved, noted as both', x.r === 'saved' && x.fields.join() === 'gstPercent,hsnCode', x);
  const after = (await A('GET', `/items/${KURTI}`)).data;
  check('...the boutique app reads GST 12, HSN 6211', after?.gstPercent === 12 && after?.hsnCode === '6211', after);
  x = await noted(cA, () => variantService.updateVariant(v.id, cA, { colorName: 'Wine', size: 'L', costPrice: 650, reorderLevel: 2 }));
  check('changes colour, size, purchase price and reorder level: saved, each noted', x.r === 'saved' && x.fields.join() === 'colour,purchasePrice,reorderLevel,size', x);
  const fresh = (await prisma.product.findUnique({ where: { id: p.id } }))!;
  x = await noted(cA, () => productService.updateProduct(p.id, cA, { title: fresh.title, description: '', hsnCode: fresh.hsnCode, taxRateBps: fresh.taxRateBps, basePrice: fresh.basePrice, sellInShop: true }));
  check('saving the form unchanged: saved, nothing noted', x.r === 'saved' && x.rows.length === 0, x);
  x = await noted(cA, async () => { const r: any = await variantService.bulkUpdateVariants(cA, [{ sku: v.sku, sellingPrice: 1050 }]); if (r.updated !== 1) throw new Error(JSON.stringify(r)); });
  check('a bulk price change (Import updates): applied, noted', x.r === 'saved' && x.fields.join() === 'sellingPrice', x);
  x = await noted(cA, () => productService.archiveProduct(p.id, cA));
  check('archived from the shop: noted as "status", the app reads ARCHIVED', x.r === 'saved' && x.fields.join() === 'status' && (await A('GET', `/items/${KURTI}`)).data?.status === 'ARCHIVED', x);
  await productService.restoreProduct(p.id, cA);
  x = await noted(cA, () => productService.trashProduct(p.id, cA));
  check('put in the bin: noted, the app reads IN_BIN', x.r === 'saved' && x.kinds.join() === 'CHANGED' && (await A('GET', `/items/${KURTI}`)).data?.status === 'IN_BIN', x);
  x = await noted(cA, () => productService.restoreProduct(p.id, cA));
  check('restored: noted again, the app reads it on sale', x.r === 'saved' && x.rows.length === 1 && (await A('GET', `/items/${KURTI}`)).data?.status === 'ACTIVE', x);

  console.log('\n   colours');
  const newSku = `${KURTI}-BLU`;
  x = await noted(cA, () => variantService.createVariant(p.id, cA, { colorName: 'Blue', size: 'M', sku: newSku, sellingPrice: 1050 }));
  const blue = await prisma.productVariant.findFirst({ where: { clientId: cA, sku: newSku } });
  check('adds a colour: saved, it gets its SKU as its item code, noted ADDED', x.r === 'saved' && blue?.boutiqueRef === newSku && x.kinds.join() === 'ADDED' && x.rows[0]?.itemCode === newSku, x);
  check('...the boutique app reads the new colour', (await A('GET', `/items/${encodeURIComponent(newSku)}`)).data?.colour === 'Blue');
  const bulkSku = `${KURTI}-GRN`;
  x = await noted(cA, () => variantService.bulkCreateVariants(p.id, cA, [{ colorName: 'Green', size: 'M', sku: bulkSku, sellingPrice: 1050, quantity: 0 }]));
  check('adds a colour from the "generate variants" panel: it is the boutique\'s too', x.r === 'saved' && (await prisma.productVariant.findFirst({ where: { clientId: cA, sku: bulkSku } }))?.boutiqueRef === bulkSku && x.kinds.join() === 'ADDED', x);
  x = await noted(cA, () => variantService.deleteVariant(blue!.id, cA));
  check('deletes the new colour (no stock, no history): deleted, noted DELETED', x.r === 'saved' && x.kinds.join() === 'DELETED' && x.rows[0]?.itemCode === newSku && !(await prisma.productVariant.findUnique({ where: { id: blue!.id } })), x);
  check('...the boutique app no longer finds it (404)', (await A('GET', `/items/${encodeURIComponent(newSku)}`)).status === 404);
  x = await noted(cA, () => variantService.deleteVariant(v.id, cA));
  check('deleting the colour with stock: refused by the usual rule, nothing noted', /stock|history/i.test(x.r) && x.r !== 'saved' && x.rows.length === 0, x);
  const grn = (await prisma.productVariant.findFirst({ where: { clientId: cA, sku: bulkSku } }))!;
  const loc = (await prisma.stockLocation.findFirst({ where: { clientId: cA } }))!;
  await prisma.boutiqueReservation.create({ data: { clientId: cA, variantId: grn.id, locationId: loc.id, quantity: 1, orderRef: `ST-${S}`, status: 'ACTIVE' } as any });
  x = await noted(cA, () => variantService.deleteVariant(grn.id, cA));
  check('deleting a colour with cloth held for a stitching order: 409 in words, still there', /^409 .*stitching order in your boutique app/.test(x.r) && !!(await prisma.productVariant.findUnique({ where: { id: grn.id } })), x);
  await prisma.boutiqueReservation.deleteMany({ where: { clientId: cA, variantId: grn.id } });

  console.log('\n   who wins');
  await clear(cA);
  await variantService.updateVariant(v.id, cA, { sellingPrice: 999 });
  const saveBack = await A('PUT', `/items/${KURTI}`, { sellingPrice: 1300 });
  check('owner sets 999, then the boutique app saves 1,300: the latest save wins (1,300 everywhere)', saveBack.status < 300 && (await A('GET', `/items/${KURTI}`)).data?.sellingPrice === 1300
    && Number((await prisma.productVariant.findUnique({ where: { id: v.id } }))?.sellingPrice) === 1300, saveBack);
  check('...the boutique app\'s own save is not noted (only the owner\'s one is)', (await notes(cA)).length === 1);
  await clear(cA);
  await A('PUT', `/items/${KURTI}`, { name: 'Anarkali kurti' });
  const ownerAfter = await owner(() => productService.updateProduct(p.id, cA, { title: 'Anarkali kurti, festive' }));
  check('and the other way: the owner saves after the app, the owner\'s name stands', ownerAfter === 'saved' && (await A('GET', `/items/${KURTI}`)).data?.name === 'Anarkali kurti, festive');

  console.log('\n   a retail item of the same shop');
  const rp = await prisma.product.create({ data: { clientId: cA, productCode: `RTL-${S}`, slug: `rtl-${S}`, title: 'Ready-made kurti', category: 'WOMEN' as any, productType: 'READY_TO_WEAR' as any, basePrice: 999, status: 'ACTIVE' as any } as any });
  const rv = await prisma.productVariant.create({ data: { clientId: cA, productId: rp.id, sku: `RTL-${S}-M`, variantCode: `RTL-${S}-M`, colorName: 'Blue', size: 'M', sellingPrice: 999 } as any });
  x = await noted(cA, async () => {
    await productService.updateProduct(rp.id, cA, { title: 'Cotton kurti', basePrice: 899 });
    await variantService.updateVariant(rv.id, cA, { colorName: 'Navy', size: 'L', costPrice: 400 });
    await variantService.createVariant(rp.id, cA, { colorName: 'Red', size: 'M', sku: `RTL-${S}-R`, sellingPrice: 899 });
    await variantService.deleteVariant(rv.id, cA);
  });
  check('renamed, repriced, a colour added and one deleted: all saved, nothing noted, not shared with the app', x.r === 'saved' && x.rows.length === 0
    && !(await prisma.productVariant.findFirst({ where: { clientId: cA, sku: `RTL-${S}-R` } }))?.boutiqueRef, x);

  console.log('\nB. THE BOUTIQUE APP READS WHAT CHANGED');
  await clear(cA);
  await productService.updateProduct(p.id, cA, { title: 'Kurti one' });
  await variantService.updateVariant(v.id, cA, { sellingPrice: 1400 });
  await variantService.createVariant(p.id, cA, { colorName: 'Pink', size: 'M', sku: `${KURTI}-PNK`, sellingPrice: 1400 });
  const pink = (await prisma.productVariant.findFirst({ where: { clientId: cA, sku: `${KURTI}-PNK` } }))!;
  await variantService.deleteVariant(pink.id, cA);
  const young = await A('GET', '/items/changed');
  check('changes younger than settleSeconds are not given yet (so a slow save is never skipped)', young.status === 200 && young.data?.changes?.length === 0 && young.data?.settleSeconds === 120, brief(young.data));
  await age(cA);
  // The rename is noted for BOTH colours of the kurti (Wine and Green), then the price, the new pink, its delete.
  const f1 = await A('GET', '/items/changed?limit=3');
  const r1 = brief(f1.data).rows;
  check('page 1 (limit 3): the rename for each colour, then the price; the item as it is now; hasMore', f1.status === 200 && r1.length === 3 && f1.data.hasMore === true
    && r1.filter((r: string) => /^CHANGED:.*:name:Kurti one\//.test(r)).length === 2 && new Set(f1.data.changes.slice(0, 2).map((c: any) => c.itemCode)).size === 2
    && r1[2] === `CHANGED:${KURTI}:sellingPrice:Kurti one/1400`, brief(f1.data));
  const f2 = await A('GET', `/items/changed?limit=3&after=${encodeURIComponent(f1.data.next)}`);
  check('page 2 from the cursor: ADDED pink, then DELETED pink (item null: it is gone); nothing repeated', f2.data?.changes?.length === 2 && f2.data.hasMore === false
    && f2.data.changes[0].kind === 'ADDED' && f2.data.changes[0].itemCode === `${KURTI}-PNK` && f2.data.changes[0].item === null
    && f2.data.changes[1].kind === 'DELETED' && f2.data.changes[1].item === null, brief(f2.data));
  const f3 = await A('GET', `/items/changed?after=${encodeURIComponent(f2.data.next)}`);
  check('asking again from the last cursor: nothing new, the same cursor back', f3.data?.changes?.length === 0 && f3.data.next === f2.data.next, brief(f3.data));
  check('another shop\'s boutique sees none of it', (await B('GET', '/items/changed')).data?.changes?.length === 0);
  check('a cursor that is not one: 400 in words', (await A('GET', '/items/changed?after=yesterday')).status === 400);

  console.log('\nC. A SHOP HANDED TO THE BOUTIQUE APP (LIKE SWATHY REDDY)');
  const SHOPC = `bothedit-c-${S}`, TENC = `bothedit-c-${S}`;
  await prisma.user.create({ data: { clientId: SHOPC, name: 'Owner', email: `${SHOPC}@example.invalid`, password: 'x', status: 'ACTIVE' } as any });
  await prisma.clientSettings.create({ data: { clientId: SHOPC, businessName: 'Handed shop' } as any });
  await prisma.stockLocation.create({ data: { clientId: SHOPC, code: 'MAIN-STORE', name: 'Main Store', type: 'STORE', active: true } });
  const old = await prisma.product.create({ data: { clientId: SHOPC, productCode: `PRD-${S}-1`, slug: `c-${S}-1`, title: 'Gold saree', category: 'WOMEN' as any, productType: 'READY_TO_WEAR' as any, basePrice: 9000, status: 'ACTIVE' as any } as any });
  await prisma.productVariant.create({ data: { clientId: SHOPC, productId: old.id, sku: `C-${S}-GOLD`.toUpperCase(), variantCode: `CV-${S}-1`, colorName: 'Gold', size: 'Free', sellingPrice: 9000 } as any });
  const C = shop(TENC);
  await C('POST', '/link', { shopName: 'Handed boutique' });
  const on = await consoleApi('PUT', `/clients/${SHOPC}/boutique`, { tenant: TENC, handOver: true });
  check('the Console hands the shop over: remembered (handed_over_at set)', on.status === 200 && !!(await prisma.boutiqueLink.findUnique({ where: { clientId: SHOPC } }))?.handedOverAt, on);
  await clear(SHOPC);
  const made: any = await productService.createProduct(SHOPC, { title: 'New lehenga', category: 'WOMEN', productType: 'READY_TO_WEAR', basePrice: 15000, status: 'DRAFT' });
  await variantService.bulkCreateVariants(made.id, SHOPC, [{ colorName: 'Red', size: 'M', sku: `NEW-${S}-RED`.toUpperCase(), sellingPrice: 15000, quantity: 0 }]);
  const nv = await prisma.productVariant.findFirst({ where: { clientId: SHOPC, productId: made.id } });
  const np = await prisma.product.findUnique({ where: { id: made.id } });
  check('the owner adds a product in ScaleEzy: it is the boutique\'s item at once (its SKU as item code, priced by the app)', nv?.boutiqueRef === `NEW-${S}-RED`.toUpperCase() && np?.priceOwner === 'BOUTIQUE' && np?.boutiqueCategory === 'FINISHED', { nv, np });
  check('...noted ADDED, and the app lists it', (await notes(SHOPC)).some(r => r.kind === 'ADDED' && r.itemCode === nv?.boutiqueRef) && (await C('GET', `/items/${nv?.boutiqueRef}`)).data?.name === 'New lehenga');
  check('...and the owner can still change it (price 14,000)', (await owner(() => variantService.updateVariant(nv!.id, SHOPC, { sellingPrice: 14000 }))) === 'saved' && (await C('GET', `/items/${nv?.boutiqueRef}`)).data?.sellingPrice === 14000);
  const other = await prisma.product.create({ data: { clientId: SHOPC, productCode: `PRD-${S}-9`, slug: `c-${S}-9`, title: 'Made any other way', category: 'WOMEN' as any, productType: 'READY_TO_WEAR' as any, basePrice: 500, status: 'ACTIVE' as any } as any });
  const ov = await prisma.productVariant.create({ data: { clientId: SHOPC, productId: other.id, sku: `ANY-${S}`.toUpperCase(), variantCode: `CV-${S}-9`, colorName: 'Blue', size: 'Free', sellingPrice: 500 } as any });
  const listed = await C('GET', '/items?limit=50');
  check('a product made any other way (not through these screens) is shared the next time the app reads its items', (listed.data?.items ?? []).some((i: any) => i.itemCode === `ANY-${S}`.toUpperCase())
    && (await prisma.productVariant.findUnique({ where: { id: ov.id } }))?.boutiqueRef === `ANY-${S}`.toUpperCase(), listed.data?.items?.map((i: any) => i.itemCode));
  const scanned = await C('GET', `/items/scan?code=${encodeURIComponent(`CV-${S}-9`)}`);
  check('...and a scan finds it too', scanned.status === 200, scanned);
  await clear(SHOPC);
  // The bin keeps a product 7 days before it can be deleted for good: its bin date is moved back instead of waiting.
  const gone = await owner(async () => {
    await productService.trashProduct(other.id, SHOPC);
    await prisma.product.update({ where: { id: other.id }, data: { trashedAt: new Date(Date.now() - 8 * 86400_000) } });
    await productService.hardDeleteProduct(other.id, SHOPC);
  });
  check('the owner deletes a whole product for good: noted DELETED for its colour', gone === 'saved' && (await notes(SHOPC)).some(r => r.kind === 'DELETED' && r.itemCode === `ANY-${S}`.toUpperCase()), gone);

  console.log('\n   the back-fill and the module off');
  await prisma.boutiqueLink.update({ where: { clientId: SHOPC }, data: { handedOverAt: null } });
  const sql = fs.readFileSync('prisma/migrations/20261127120000_boutique_shop_edits/migration.sql', 'utf8');
  const fill = sql.slice(sql.indexOf('UPDATE "boutique_links"'));
  await prisma.$executeRawUnsafe(fill.slice(0, fill.indexOf(');') + 2));
  check('the migration\'s back-fill marks a shop handed over before the column existed', !!(await prisma.boutiqueLink.findUnique({ where: { clientId: SHOPC } }))?.handedOverAt);
  check('...and never a boutique that only made its own items (A)', !(await prisma.boutiqueLink.findUnique({ where: { clientId: cA } }))?.handedOverAt);
  const off = await consoleApi('DELETE', `/clients/${SHOPC}/boutique`);
  const late = await prisma.product.create({ data: { clientId: SHOPC, productCode: `PRD-${S}-10`, slug: `c-${S}-10`, title: 'After off', category: 'WOMEN' as any, productType: 'READY_TO_WEAR' as any, basePrice: 500, status: 'ACTIVE' as any } as any });
  await variantService.createVariant(late.id, SHOPC, { colorName: 'Blue', size: 'Free', sku: `LATE-${S}`.toUpperCase(), sellingPrice: 500 });
  check('Boutique module switched off: a new product stays the shop\'s own (no item code)', off.status === 200 && !(await prisma.productVariant.findFirst({ where: { clientId: SHOPC, productId: late.id } }))?.boutiqueRef, off);
}

async function cleanup() {
  const ids = (await prisma.boutiqueLink.findMany({ where: { tenant: { startsWith: `bothedit-` } }, select: { clientId: true } })).map(l => l.clientId);
  ids.push(`bothedit-c-${S}`);
  const tables = await prisma.$queryRaw<{ table_name: string }[]>`SELECT DISTINCT table_name FROM information_schema.columns WHERE table_schema = 'public' AND column_name = 'client_id'`;
  await prisma.$executeRawUnsafe(`DELETE FROM inventory_product_images WHERE product_id IN (SELECT id FROM inventory_products WHERE client_id = ANY($1))`, ids).catch(() => undefined);
  for (let round = 0; round < 8; round++) {
    let left = 0;
    for (const t of tables) { try { await prisma.$executeRawUnsafe(`DELETE FROM "${t.table_name}" WHERE client_id = ANY($1)`, ids); } catch { left++; } }
    if (!left) break;
  }
  console.log(`\ncleaned up ${ids.length} shops`);
}

main()
  .catch(e => { bad++; console.error('CRASH', e); })
  .finally(async () => { await cleanup().catch(e => console.error('cleanup failed', e)); console.log(`${good} passed, ${bad} problems`); await prisma.$disconnect(); process.exit(bad ? 1 : 0); });
