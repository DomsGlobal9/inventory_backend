/**
 * Archiving one colour of a boutique design (16 Nov), against the REAL local server and database.
 *
 * Before: DELETE /items/:code archived only a design with no other colours, so a design with two or more colours
 * could never be archived -- the colour stayed on sale and the answer still said "archived". Now an archived colour
 * moves to a shelf (a one-colour archived copy of the design) and the last live colour archives the design itself.
 *
 * Every case: one colour of three, stock + holds + history + photos go with it, again (no-op), a PUT of an archived
 * colour (stays archived, design untouched), all colours one by one, bringing one back (the others stay archived),
 * a new colour on an archived design, archived:true on a new item, a bad archived value, a unit change on the way
 * back, a single-colour design, materials (no channel told), storefront events, replay, import rows, permission,
 * and two races (the last two colours at once; the last colour archived while a new one is added).
 *
 * Throwaway boutique accounts only (archtest-*); every client it makes is removed. Local only.
 *   DATABASE_URL=<local> DIRECT_URL=<local> VERIFY_API_URL=http://localhost:4036/api/v1 \
 *   BOUTIQUE_KEY_DIR=<dir with private.pem> npx tsx src/scripts/verify-boutique-archive.ts
 */
import fs from 'node:fs';
import axios from 'axios';
import jwt from 'jsonwebtoken';
import { prisma } from '../lib/prisma';
import { storefrontCatalogueService } from '../services/storefront-catalogue.service';

const BASE = process.env.VERIFY_API_URL || 'http://localhost:4036/api/v1';
for (const k of ['DATABASE_URL', 'DIRECT_URL']) {
  if (!/localhost:55433/.test(process.env[k] ?? '')) { console.error(`Refusing: ${k} is not the local database.`); process.exit(2); }
}
if (!/localhost|127\.0\.0\.1/.test(BASE)) { console.error('Refusing: VERIFY_API_URL is not a local server.'); process.exit(2); }
const privateKey = fs.readFileSync(`${process.env.BOUTIQUE_KEY_DIR}/private.pem`, 'utf8');

const S = Date.now().toString(36);
const TEN = `archtest-${S}`;
let bad = 0, good = 0;
const check = (name: string, ok: boolean, detail: unknown = '') => {
  ok ? good++ : bad++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : ` :: ${typeof detail === 'string' ? detail : JSON.stringify(detail)?.slice(0, 500)}`}`);
};
const ALL = ['products:write', 'stock:write', 'stitching:issue'];
const pass = (can = ALL) => jwt.sign({ sub: 'crm-b', scope: ['modules:boutique'], tenant: TEN, onBehalfOf: { userId: 'u1', name: 'Lakshmi', can } },
  privateKey, { algorithm: 'RS256', audience: 'inventory', issuer: 'scaleezy-boutique-test', keyid: 'btq-1', expiresIn: '5m' });
let n = 0;
async function call(method: string, path: string, body?: unknown, o: { key?: string; can?: string[] } = {}) {
  const r = await axios.request({ method, url: `${BASE}/internal/boutique${path}`, data: body, validateStatus: () => true, timeout: 90_000,
    headers: { Authorization: `Bearer ${pass(o.can)}`, ...(method !== 'GET' ? { 'Idempotency-Key': o.key ?? `arch-${S}-${++n}` } : {}) } });
  return { status: r.status, data: r.data?.data, message: r.data?.message as string | undefined, replay: r.headers['idempotent-replay'] };
}
const D = `DES-${S}`;
const silk = (code: string, colour: string, extra: Record<string, unknown> = {}) => ({ name: 'Kanchi silk', designGroup: D, kind: 'FABRIC', unit: 'METER', color: colour, sellingPrice: 450, sellInShop: true, ...extra });
const item = async (code: string) => (await call('GET', `/items/${code}`)).data;
const homeOf = async (code: string, clientId: string) => (await prisma.productVariant.findFirst({ where: { clientId, boutiqueRef: code }, include: { product: true } }))!;
const wait = (ms: number) => new Promise(r => setTimeout(r, ms));

async function main() {
  const link = await call('POST', '/link', { shopName: 'Archive Test Boutique' });
  check('a throwaway boutique is linked', link.status === 201, link);
  const clientId = link.data.clientId as string;
  // A website connection, so the events the shop channels are sent can be read back.
  await prisma.storefrontConnection.create({ data: { clientId, name: 'test site', type: 'GENERIC' as any, status: 'ACTIVE' as any, baseUrl: 'https://example.invalid/hook', credentialHash: 'x', credentialPrefix: `t${S}` } });
  const events = async (productId: string) => {
    const p = await prisma.product.findUnique({ where: { id: productId }, select: { productCode: true } });
    return (await prisma.storefrontEvent.findMany({ where: { clientId, productCode: p!.productCode }, orderBy: { sequence: 'asc' }, select: { eventType: true } })).map(e => e.eventType);
  };

  console.log('\nONE COLOUR OF THREE');
  const A = `${S}-A`, B = `${S}-B`, C = `${S}-C`;
  for (const [code, colour] of [[A, 'Maroon'], [B, 'Green'], [C, 'Gold']]) {
    await call('PUT', `/items/${code}`, silk(code, colour, code === A ? { imageUrls: ['https://example.invalid/maroon.jpg'] } : {}));
  }
  await call('POST', '/movements', { itemCode: A, kind: 'PURCHASE', quantity: 10 });
  const hold = await call('POST', '/holds', { itemCode: A, quantity: 2, orderRef: 'ST-1' });
  const design = (await homeOf(A, clientId)).product;
  check('three colours, one design, on sale', design.status === 'ACTIVE' && (await prisma.productVariant.count({ where: { productId: design.id } })) === 3);
  await wait(1500);
  const before = (await events(design.id)).length;

  const del = await call('DELETE', `/items/${A}`);
  check('DELETE one colour: 200 archived', del.status === 200 && del.data?.archived === true, del);
  const a1 = await item(A);
  check('...it reads back ARCHIVED, with its stock and its hold', a1?.status === 'ARCHIVED' && a1.stock === 10 && a1.reserved === 2, a1);
  check('...the other two colours are still on sale', (await item(B))?.status === 'ACTIVE' && (await item(C))?.status === 'ACTIVE');
  const homeA = await homeOf(A, clientId);
  check('...it sits on a shelf of its own: archived, boutique-priced, same name', homeA.productId !== design.id && homeA.product.status === 'ARCHIVED'
    && homeA.product.importKey === `boutique-archived:${A}` && homeA.product.priceOwner === 'BOUTIQUE' && homeA.product.title === 'Kanchi silk', homeA.product);
  check('...its photo went with it', (await prisma.productImage.count({ where: { variantId: homeA.id, productId: homeA.productId } })) === 1);
  check('...its history is still there (the purchase)', ((await call('GET', `/items/${A}/history`)).data ?? []).some((h: any) => h.quantity === 10));
  const shop = await storefrontCatalogueService.getProduct({ clientId, locationIds: [] }, design.productCode, { withLengths: true });
  const colours = (shop as any)?.variants?.map((v: any) => v.sku) ?? [];
  check('the online shop sells the design with 2 colours, not the archived one', !!shop && colours.length === 2 && !colours.includes(A), colours);
  // Websites take only what is sold by the piece (the feed rule), so their events are proved on a saree design.
  const P1 = `${S}-P1`, P2 = `${S}-P2`;
  for (const p of [P1, P2]) await call('PUT', `/items/${p}`, { name: 'Saree', designGroup: `SAREE-${S}`, kind: 'SAREE', unit: 'PIECE', color: p, sellingPrice: 2500, sellInShop: true, category: 'FINISHED' });
  const saree = (await homeOf(P1, clientId)).product;
  await wait(1500);
  const sareeBefore = (await events(saree.id)).length;
  await call('DELETE', `/items/${P1}`);
  await wait(1500);
  const ev1 = await events(saree.id);
  check('a saree colour archived: the website is told the design changed', ev1.length > sareeBefore && ev1[ev1.length - 1] === 'PRODUCT_UPDATED', ev1);
  await call('DELETE', `/items/${P2}`);
  await wait(1500);
  const ev1b = await events(saree.id);
  check('...its last colour archived: the website is told it is withdrawn', ev1b[ev1b.length - 1] === 'PRODUCT_UNPUBLISHED', ev1b);

  const again = await call('DELETE', `/items/${A}`);
  check('DELETE it again: same answer, nothing changes, still one shelf', again.status === 200 && (await prisma.product.count({ where: { clientId, importKey: `boutique-archived:${A}` } })) === 1 && (await item(A))?.status === 'ARCHIVED', again);
  const issue = await call('POST', `/holds/${hold.data?.reservationId}/issue`, {});
  check('a hold on the archived colour can still be cut (the order goes on)', issue.status === 200, issue);
  const putArch = await call('PUT', `/items/${A}`, silk(A, 'Maroon', { name: 'Kanchi silk, old maroon' }));
  check('PUT the archived colour (no "archived"): changed, still ARCHIVED', putArch.status === 200 && putArch.data?.status === 'ARCHIVED' && putArch.data?.name === 'Kanchi silk, old maroon', putArch);
  check('...and the live design kept its own name', (await prisma.product.findUnique({ where: { id: design.id } }))!.title === 'Kanchi silk');

  console.log('\nALL COLOURS, THEN ONE BACK');
  await call('DELETE', `/items/${B}`);
  const lastOne = await call('DELETE', `/items/${C}`);
  const designNow = await prisma.product.findUnique({ where: { id: design.id } });
  check('the last colour archives the design itself (no shelf for it)', lastOne.status === 200 && designNow!.status === 'ARCHIVED' && (await homeOf(C, clientId)).productId === design.id);
  check('...no colour of it is on sale anywhere', !(await storefrontCatalogueService.getProduct({ clientId, locationIds: [] }, design.productCode, { withLengths: true })));
  await wait(1500);
  const ev2 = await events(design.id);
  check('...and the website is told it is withdrawn', ev2[ev2.length - 1] === 'PRODUCT_UNPUBLISHED', ev2);

  const back = await call('PUT', `/items/${B}`, silk(B, 'Green', { archived: false }));
  check('PUT B with archived:false: it is back on sale', back.status === 200 && back.data?.status === 'ACTIVE', back);
  check('...in its design, which is live again', (await homeOf(B, clientId)).productId === design.id && (await prisma.product.findUnique({ where: { id: design.id } }))!.status === 'ACTIVE');
  check('...and ONLY B: A and C are still archived', (await item(A))?.status === 'ARCHIVED' && (await item(C))?.status === 'ARCHIVED');
  check('...C moved to a shelf of its own', (await homeOf(C, clientId)).product.importKey === `boutique-archived:${C}`);
  const bShelf = await prisma.product.findFirst({ where: { clientId, importKey: `boutique-archived:${B}` } });
  check('...B\'s empty shelf went to the bin', !!bShelf?.trashedAt, bShelf);
  const shop2 = await storefrontCatalogueService.getProduct({ clientId, locationIds: [] }, design.productCode, { withLengths: true });
  check('...the online shop sells the design with B only', ((shop2 as any)?.variants ?? []).map((v: any) => v.sku).join() === B, (shop2 as any)?.variants);

  console.log('\nNEW COLOURS AND ARCHIVED ONES');
  await call('DELETE', `/items/${B}`);
  const E = `${S}-E`;
  const newE = await call('PUT', `/items/${E}`, silk(E, 'Blue'));
  check('a new colour added to an archived design: 201 and on sale', newE.status === 201 && newE.data?.status === 'ACTIVE', newE);
  check('...B stays archived, back on its old shelf (taken out of the bin, not a second one)', (await item(B))?.status === 'ARCHIVED'
    && (await prisma.product.count({ where: { clientId, importKey: `boutique-archived:${B}` } })) === 1 && !(await homeOf(B, clientId)).product.trashedAt);
  const F = `${S}-F`;
  const newF = await call('PUT', `/items/${F}`, silk(F, 'Pink', { archived: true }));
  check('a new item sent with archived:true: 201, archived, the design stays on sale', newF.status === 201 && newF.data?.status === 'ARCHIVED' && (await item(E))?.status === 'ACTIVE', newF);
  const odd = await call('PUT', `/items/${F}`, silk(F, 'Pink', { archived: 'yes' }));
  check('archived:"yes" is refused in words', odd.status === 400 && /true or false/.test(odd.message ?? ''), odd);
  const unit = await call('PUT', `/items/${A}`, silk(A, 'Maroon', { archived: false, unit: 'PIECE', kind: 'OTHER' }));
  check('bringing A back as pieces while it has metres of stock: 409', unit.status === 409 && /stock in metres/.test(unit.message ?? ''), unit);
  check('...and nothing moved', (await item(A))?.status === 'ARCHIVED');
  const aBack = await call('PUT', `/items/${A}`, silk(A, 'Maroon', { archived: false }));
  check('A back in metres: on sale, with its 8 m', aBack.status === 200 && aBack.data?.status === 'ACTIVE' && (await item(A))?.stock === 8, aBack);

  console.log('\nOTHER DESIGNS');
  const SOLO = `${S}-SOLO`;
  await call('PUT', `/items/${SOLO}`, { name: 'Banarasi', designGroup: `SOLO-${S}`, kind: 'FABRIC', unit: 'METER', sellingPrice: 900, sellInShop: true });
  await call('DELETE', `/items/${SOLO}`);
  const solo = await homeOf(SOLO, clientId);
  check('a one-colour design: archived in place, no shelf', solo.product.status === 'ARCHIVED' && solo.product.importKey === `boutique:SOLO-${S}`);
  const soloBack = await call('PUT', `/items/${SOLO}`, { name: 'Banarasi', designGroup: `SOLO-${S}`, kind: 'FABRIC', unit: 'METER', sellingPrice: 900, sellInShop: true, archived: false });
  check('...and archived:false brings it back', soloBack.data?.status === 'ACTIVE', soloBack);
  const M1 = `${S}-M1`, M2 = `${S}-M2`;
  for (const m of [M1, M2]) await call('PUT', `/items/${m}`, { name: 'Lining', designGroup: `LIN-${S}`, category: 'LINING', color: m });
  const lining = (await homeOf(M1, clientId)).product;
  await call('DELETE', `/items/${M1}`);
  await wait(1500);
  check('a material colour archived: archived, and no website is told (it was never on sale)', (await item(M1))?.status === 'ARCHIVED' && (await events(lining.id)).length === 0, await events(lining.id));

  console.log('\nRETRIES, IMPORT, PERMISSION');
  const key = `arch-replay-${S}`;
  const r1 = await call('DELETE', `/items/${E}`, undefined, { key });
  const r2 = await call('DELETE', `/items/${E}`, undefined, { key });
  check('the same request id twice: the second is a replay', r1.status === 200 && r2.status === 200 && r2.replay === 'true', [r1.replay, r2.replay]);
  const G = `${S}-G`, H = `${S}-H`;
  const imp = await call('POST', '/items/import', { items: [{ itemCode: G, ...silk(G, 'Teal') }, { itemCode: H, ...silk(H, 'Rust', { archived: true }) }] }, { key: `arch-import-${S}` });
  check('import: a row with archived:true lands archived, the other on sale', imp.data?.added === 2 && (await item(G))?.status === 'ACTIVE' && (await item(H))?.status === 'ARCHIVED', imp);
  const no = await call('DELETE', `/items/${G}`, undefined, { can: ['stock:write'] });
  check('archiving without products:write: 403, nothing changes', no.status === 403 && (await item(G))?.status === 'ACTIVE', no);
  const missing = await call('DELETE', `/items/NOPE-${S}`);
  check('archiving an unknown code: 404', missing.status === 404, missing);

  console.log('\nRACES');
  const R1 = `${S}-R1`, R2 = `${S}-R2`;
  for (const r of [R1, R2]) await call('PUT', `/items/${r}`, { ...silk(r, r), designGroup: `RACE-${S}` });
  const raceDesign = (await homeOf(R1, clientId)).productId;
  const both = await Promise.all([call('DELETE', `/items/${R1}`), call('DELETE', `/items/${R2}`)]);
  const left = await prisma.productVariant.count({ where: { productId: raceDesign } });
  const rd = await prisma.product.findUnique({ where: { id: raceDesign } });
  check('the last two colours archived at the same moment: both archived, no empty design on sale',
    both.every(b => b.status === 200) && (await item(R1))?.status === 'ARCHIVED' && (await item(R2))?.status === 'ARCHIVED' && rd!.status === 'ARCHIVED' && left === 1, { left, status: rd?.status });
  const R3 = `${S}-R3`, R4 = `${S}-R4`;
  await call('PUT', `/items/${R3}`, { ...silk(R3, 'x'), designGroup: `RACE2-${S}` });
  await Promise.all([call('DELETE', `/items/${R3}`), call('PUT', `/items/${R4}`, { ...silk(R4, 'y'), designGroup: `RACE2-${S}` })]);
  check('the last colour archived while a new one is added: the new one is on sale, the old one archived',
    (await item(R4))?.status === 'ACTIVE' && (await item(R3))?.status === 'ARCHIVED', [await item(R3), await item(R4)]);

  const list = await call('GET', '/items?limit=100');
  const live = (list.data?.items ?? []).filter((i: any) => i.status === 'ACTIVE').map((i: any) => i.itemCode).sort();
  check('the list at the end shows exactly the live items', live.join() === [A, G, M2, R4, SOLO].sort().join(), live);
}

async function cleanup() {
  const ids = (await prisma.boutiqueLink.findMany({ where: { tenant: { startsWith: 'archtest-' } }, select: { clientId: true } })).map(l => l.clientId);
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
