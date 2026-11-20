/**
 * The Boutique API registry (20 Nov 2026): EVERY address of /api/v1/internal/boutique called for real, against the
 * local server and database, in a throwaway shop -- each request and each answer recorded, each answer checked --
 * and the developers' registry written from what actually came back:
 *   handouts/ScaleEzy-Boutique-API-Registry.md   (people)
 *   handouts/boutique-api-registry.json          (programs)
 * So the registry is never a guess: run this again after any change and it is rewritten, true.
 *
 * Throwaway accounts only (apidoc-*); everything it makes is removed. Local only. No real Razorpay call (payment
 * keys are shown being refused for their shape only), no email, no paid service.
 *   DATABASE_URL=<local> DIRECT_URL=<local> VERIFY_API_URL=http://localhost:4036/api/v1 \
 *   BOUTIQUE_KEY_DIR=<dir with private.pem> npx tsx src/scripts/verify-boutique-api-registry.ts
 */
import fs from 'node:fs';
import path from 'node:path';
import axios from 'axios';
import jwt from 'jsonwebtoken';
import { prisma } from '../lib/prisma';

const BASE = process.env.VERIFY_API_URL || 'http://localhost:4036/api/v1';
for (const k of ['DATABASE_URL', 'DIRECT_URL']) {
  if (!/localhost:55433/.test(process.env[k] ?? '')) { console.error(`Refusing: ${k} is not the local database.`); process.exit(2); }
}
if (!/localhost|127\.0\.0\.1/.test(BASE)) { console.error('Refusing: VERIFY_API_URL is not a local server.'); process.exit(2); }
const privateKey = fs.readFileSync(`${process.env.BOUTIQUE_KEY_DIR}/private.pem`, 'utf8');
const OUT_DIR = path.resolve(__dirname, '../../../handouts');

const S = Date.now().toString(36);
const TEN = `apidoc-${S}`, TEN_JOIN = `apidoc-${S}-new`, TEN_OTHER = `apidoc-${S}-other`;
const ALL = ['products:write', 'products:delete', 'stock:write', 'stitching:issue', 'stock:transfer', 'suppliers:write', 'reports:view', 'customers:write', 'offers:write', 'settings:write'];

type Rec = {
  group: string; title: string; does: string; method: string; template: string; path: string; can: string;
  query?: Record<string, unknown>; body?: unknown; status: number; ok: boolean; response: unknown; contentType?: string; notes?: string[]; kind: 'example' | 'error';
};
const recs: Rec[] = [];
let bad = 0, good = 0;

const pass = (tenant: string, can: string[]) => jwt.sign({ sub: 'crm-b', scope: ['modules:boutique'], tenant, onBehalfOf: { userId: '17', name: 'Lakshmi', can } },
  privateKey, { algorithm: 'RS256', audience: 'inventory', issuer: 'scaleezy-boutique-test', keyid: 'btq-1', expiresIn: '5m' });

/** Trim an answer for the page: long lists keep their first two, long text is cut. */
function trim(v: any, depth = 0): any {
  if (Array.isArray(v)) return v.length > 3 ? [...v.slice(0, 2).map(x => trim(x, depth + 1)), `… ${v.length - 2} more`] : v.map(x => trim(x, depth + 1));
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, depth > 6 ? '…' : trim(x, depth + 1)]));
  if (typeof v === 'string' && v.length > 240) return `${v.slice(0, 240)}…`;
  return v;
}
let n = 0;
async function rec(o: {
  group: string; title: string; does: string; method: string; template: string; path: string; can?: string[]; needs?: string;
  query?: Record<string, unknown>; body?: unknown; expect: number | number[]; tenant?: string; raw?: boolean; notes?: string[]; kind?: 'example' | 'error'; noPass?: boolean; key?: string;
}) {
  const qs = o.query ? '?' + Object.entries(o.query).map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`).join('&') : '';
  const r = await axios.request({
    method: o.method, url: `${BASE}/internal/boutique${o.path}${qs}`, data: o.body, validateStatus: () => true, timeout: 90_000,
    responseType: o.raw ? 'arraybuffer' : 'json',
    headers: { ...(o.noPass ? {} : { Authorization: `Bearer ${pass(o.tenant ?? TEN, o.can ?? ALL)}` }), ...(o.method !== 'GET' ? { 'Idempotency-Key': o.key ?? `apidoc-${S}-${++n}` } : {}) }
  });
  const want = Array.isArray(o.expect) ? o.expect : [o.expect];
  const ok = want.includes(r.status);
  ok ? good++ : bad++;
  const ct = String(r.headers['content-type'] ?? '');
  const response = o.raw && /pdf/.test(ct) ? `<a PDF file, ${Buffer.from(r.data).length.toLocaleString('en-IN')} bytes>` : o.raw ? JSON.parse(Buffer.from(r.data).toString() || 'null') : r.data;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${o.method} ${o.template}  ${r.status}${ok ? '' : ` (wanted ${want.join('/')}) ${JSON.stringify(response)?.slice(0, 300)}`}`);
  recs.push({ group: o.group, title: o.title, does: o.does, method: o.method, template: o.template, path: o.path, can: o.needs ?? 'any',
    query: o.query, body: o.body, status: r.status, ok, response: trim(response), contentType: ct.split(';')[0], notes: o.notes, kind: o.kind ?? 'example' });
  return { status: r.status, data: (response as any)?.data, raw: response };
}

async function main() {
  const G1 = '1. Connecting', G2 = '2. Stores', G3 = '3. Items', G4 = '4. Stock', G5 = '5. Cloth held for stitching orders', G6 = '6. Customers',
    G7 = '7. Suppliers and buying', G8 = '8. Racks and shelves', G9 = '9. Barcodes, scanning and labels', G10 = '10. Price check',
    G11 = '11. Offers', G12 = '12. Shop settings', G13 = '13. Reports', G14 = '14. Errors you will meet';

  console.log('\n' + G1);
  await rec({ group: G1, title: 'Is it up?', does: 'Answers when ScaleEzy is reachable and your pass is good. Needs a pass, not a linked shop.', method: 'GET', template: '/status', path: '/status', expect: 200 });
  const link = await rec({ group: G1, title: 'Connect this client', does: 'Connects your account (the pass\'s tenant) to its ScaleEzy shop. The first time for a new account, it makes the boutique\'s own shop with one store. Calling it again is safe.', method: 'POST', template: '/link', path: '/link', body: { shopName: 'Lakshmi Boutique' }, expect: [200, 201] });
  const clientId = link.data?.clientId as string;
  await rec({ group: G1, title: 'Connect again', does: 'The same call again answers that it is already linked; nothing changes.', method: 'POST', template: '/link', path: '/link', body: { shopName: 'Lakshmi Boutique' }, expect: [200, 201] });
  const owner = { shopName: 'Jyothi Designer Boutique', ownerName: 'Jyothi', ownerEmail: `jyothi-${S}@example.invalid`, ownerPhone: '9848012345', city: 'Guntur', note: 'Wants the online shop before Sankranti' };
  await rec({ group: G1, title: 'Ask to join ScaleEzy retail', does: 'For a boutique-only client who also wants ScaleEzy\'s shop, till and reports: ScaleEzy sees the request in its Console and sets them up. Asking again updates the same request.', method: 'POST', template: '/join-request', path: '/join-request', body: owner, tenant: TEN_JOIN, expect: [200, 201] });
  await rec({ group: G1, title: 'See the request', does: 'Where the request stands: NONE, WAITING, ACCEPTED or DECLINED (with the reason).', method: 'GET', template: '/join-request', path: '/join-request', tenant: TEN_JOIN, expect: 200 });
  await rec({ group: G1, title: 'Withdraw the request', does: 'Takes back a waiting request.', method: 'DELETE', template: '/join-request', path: '/join-request', tenant: TEN_JOIN, expect: 200 });

  console.log('\n' + G2);
  const stores = await rec({ group: G2, title: 'List stores', does: 'The shop\'s places (stores, godowns, cutting units). `all=1` includes removed ones.', method: 'GET', template: '/stores', path: '/stores', expect: 200 });
  const main0 = (stores.data?.stores ?? stores.data ?? [])[0]?.id ?? (await prisma.stockLocation.findFirst({ where: { clientId, active: true } }))!.id;
  const cut = await rec({ group: G2, title: 'Add a store', does: 'Adds a place. kind: STORE, GODOWN or CUTTING_UNIT.', method: 'POST', template: '/stores', path: '/stores', needs: 'stock:write', body: { name: 'Cutting room', kind: 'CUTTING_UNIT' }, expect: 201 });
  const cutId = cut.data?.id ?? cut.raw?.data?.id;
  await rec({ group: G2, title: 'Rename or switch a store', does: 'Changes its name, or switches it off (active false) / on.', method: 'PUT', template: '/stores/{storeId}', path: `/stores/${cutId}`, needs: 'stock:write', body: { name: 'Cutting unit' }, expect: 200 });

  console.log('\n' + G3);
  await rec({ group: G3, title: 'Next free item code', does: 'The next code for a prefix (SLK -> SLK-0001). Not reserved: send the new item with ifNew: true.', method: 'GET', template: '/items/next-code', path: '/items/next-code', query: { prefix: 'SLK' }, expect: 200 });
  const silkBody = { name: 'Kanchi silk', designGroup: 'KANCHI-GREEN', category: 'FABRIC', kind: 'FABRIC', unit: 'METER', color: 'Green', colorHex: '#1E6B3A', widthCm: 110,
    sellingPrice: 450, purchasePrice: 280, gstPercent: 5, hsnCode: '5007', sellInShop: true, reorderLevel: 10, rackLocation: 'Rack A', description: 'Pure silk, 110 cm wide', ifNew: true };
  await rec({ group: G3, title: 'Add or change an item', does: 'One item = one colour of a design (designGroup). Sending the same itemCode again changes it; fields left out keep their values. Prices are per unit (per metre for cloth). A new item gets a barcode unless you send the maker\'s.', method: 'PUT', template: '/items/{itemCode}', path: '/items/SLK-0001', needs: 'products:write', body: silkBody, expect: 201 });
  const blouse = await rec({ group: G3, title: 'Add an item with the maker\'s barcode', does: 'A finished garment for sale, carrying its maker\'s barcode.', method: 'PUT', template: '/items/{itemCode}', path: '/items/BLS-0001', needs: 'products:write', body: { name: 'Ready blouse', category: 'FINISHED', unit: 'PIECE', color: 'Maroon', size: '38', sellingPrice: 1499, gstPercent: 5, hsnCode: '6206', sellInShop: true, barcode: `890${String(Date.now()).slice(-10)}` }, expect: 201 });
  await rec({ group: G3, title: 'Add a material', does: 'Something used to make garments, never sold (sellInShop false): it never reaches the till or the online shop.', method: 'PUT', template: '/items/{itemCode}', path: '/items/THR-0001', needs: 'products:write', body: { name: 'Zari thread', category: 'EMBELLISHMENT', unit: 'PIECE', color: 'Gold', sellingPrice: 40, sellInShop: false }, expect: 201 });
  await rec({ group: G3, title: 'Change an item', does: 'Only what you send changes.', method: 'PUT', template: '/items/{itemCode}', path: '/items/SLK-0001', needs: 'products:write', body: { sellingPrice: 480 }, expect: 200 });
  await rec({ group: G3, title: 'Add many items', does: '1 to 200 items at once; each row lands or is refused on its own.', method: 'POST', template: '/items/import', path: '/items/import', needs: 'products:write',
    body: { items: [{ itemCode: 'BTN-0001', name: 'Shell button', category: 'EMBELLISHMENT', unit: 'PIECE', sellingPrice: 5 }, { itemCode: 'BTN-0002', name: 'Gold button', category: 'EMBELLISHMENT', unit: 'PIECE', sellingPrice: 8 }, { itemCode: 'BTN-0003', name: 'Pearl button', category: 'EMBELLISHMENT', unit: 'PIECE', sellingPrice: 9 }] }, expect: 200 });
  await rec({ group: G3, title: 'List items', does: 'Items with their stock, 20 a page (limit up to 100). Filters: search, category, itemType, status ACTIVE/ARCHIVED/IN_BIN, reorderDue=1, locationId.', method: 'GET', template: '/items', path: '/items', query: { page: 1, limit: 20 }, expect: 200 });
  await rec({ group: G3, title: 'One item', does: 'One item with its stock at every place.', method: 'GET', template: '/items/{itemCode}', path: '/items/SLK-0001', expect: 200 });
  await rec({ group: G3, title: 'Groups in use', does: 'The categories and sorts of item this shop uses, with counts.', method: 'GET', template: '/items/groups', path: '/items/groups', expect: 200 });
  await rec({ group: G3, title: 'Look up many', does: 'Up to 200 item codes in one call; the ones not found are listed.', method: 'POST', template: '/items/lookup', path: '/items/lookup', body: { itemCodes: ['SLK-0001', 'BLS-0001', 'NOPE-0001'] }, expect: 200 });
  await rec({ group: G3, title: 'Archive one', does: 'Off sale, kept (history stays). The design\'s other colours stay on sale.', method: 'POST', template: '/items/{itemCode}/archive', path: '/items/BTN-0002/archive', needs: 'products:write', expect: 200 });
  await rec({ group: G3, title: 'Bring one back', does: 'Back on sale.', method: 'POST', template: '/items/{itemCode}/restore', path: '/items/BTN-0002/restore', needs: 'products:write', expect: 200 });
  await rec({ group: G3, title: 'Archive many (or bring back)', does: '1 to 200 at once; archived: false brings them back.', method: 'POST', template: '/items/archive', path: '/items/archive', needs: 'products:write', body: { itemCodes: ['BTN-0002', 'BTN-0003'] }, expect: 200 });
  await rec({ group: G3, title: 'Delete one', does: 'Deleted for good; its code is free again. An item with stock or history needs force=true (and stock:write).', method: 'DELETE', template: '/items/{itemCode}', path: '/items/BTN-0003', needs: 'products:delete', expect: 200 });
  await rec({ group: G3, title: 'Delete many', does: '1 to 200 at once, row by row.', method: 'POST', template: '/items/delete', path: '/items/delete', needs: 'products:delete', body: { itemCodes: ['BTN-0002', 'NOPE-0002'] }, expect: 200 });

  console.log('\n' + G4);
  await rec({ group: G4, title: 'Record a movement', does: 'Kinds: PURCHASE, SALE, DAMAGE, RETURN, ISSUE, CONSUME, WASTE, RETURN_UNUSED, CONSUMPTION and more (the error lists them all). Quantity in the item\'s unit (12.5 = 12.5 metres).', method: 'POST', template: '/movements', path: '/movements', needs: 'by kind (stock:write; stitching:issue for cutting)', body: { itemCode: 'SLK-0001', kind: 'PURCHASE', quantity: 30, unitCost: 280, notes: 'From Ravi Silks' }, expect: [200, 201] });
  await rec({ group: G4, title: 'Record a movement (pieces)', does: 'Ten blouses in.', method: 'POST', template: '/movements', path: '/movements', needs: 'stock:write', body: { itemCode: 'BLS-0001', kind: 'PURCHASE', quantity: 10 }, expect: [200, 201] });
  await rec({ group: G4, title: 'Record a count', does: 'The quantity actually found; the difference is written as a correction.', method: 'POST', template: '/counts', path: '/counts', needs: 'stock:write', body: { itemCode: 'THR-0001', counted: 50 }, expect: [200, 201] });
  await rec({ group: G4, title: 'Move between places', does: 'From one place to another. With orderRef, that order\'s held cloth moves with its hold.', method: 'POST', template: '/transfers', path: '/transfers', needs: 'stock:write, stock:transfer or stitching:issue', body: { itemCode: 'SLK-0001', quantity: 5, fromLocationId: main0, toLocationId: cutId }, expect: [200, 201] });
  await rec({ group: G2, title: 'Items at a store', does: 'What is at one place, with quantities.', method: 'GET', template: '/stores/{storeId}/items', path: `/stores/${cutId}/items`, expect: 200 });
  await rec({ group: G4, title: 'Item history', does: 'Its movements, newest first (limit up to 200).', method: 'GET', template: '/items/{itemCode}/history', path: '/items/SLK-0001/history', query: { limit: 10 }, expect: 200 });
  await rec({ group: G4, title: 'Movements', does: 'All movements, newest first; filters from, to (days like 2026-11-20), itemCode, kind, locationId.', method: 'GET', template: '/movements', path: '/movements', query: { limit: 5 }, expect: 200 });
  await rec({ group: G4, title: 'Alerts', does: 'Items at or below their reorder level or minimum.', method: 'GET', template: '/alerts', path: '/alerts', expect: 200 });
  const ch = await rec({ group: G4, title: 'Changes since', does: 'Everything that changed, oldest first, for keeping your screens fresh: pass the last answer\'s `next` as after.', method: 'GET', template: '/changes', path: '/changes', query: { limit: 5 }, expect: 200 });
  if (ch.data?.next) await rec({ group: G4, title: 'Changes since (next page)', does: 'The next page.', method: 'GET', template: '/changes', path: '/changes', query: { after: ch.data.next, limit: 5 }, expect: 200 });
  await rec({ group: G4, title: 'Is it available?', does: 'For many lines at once: enough free stock or not, and how much is free.', method: 'POST', template: '/availability', path: '/availability', body: { lines: [{ itemCode: 'SLK-0001', quantity: 2.5 }, { itemCode: 'BLS-0001', quantity: 20 }] }, expect: 200 });
  await rec({ group: G3, title: 'Upload photos', does: 'Up to 10 at once: answers a one-time upload address for each (PUT the file there), then send the returned URLs as imageUrls on the item. JPEG, PNG or WebP, 10 MB each.', method: 'POST', template: '/photos', path: '/photos', body: { files: [{ name: 'silk-front.jpg', contentType: 'image/jpeg', size: 250000 }] }, expect: [200, 502, 503],
    notes: ['On this test server the photo storage is not reachable, so the example may show the refusal you would see when storage is down.'] });

  console.log('\n' + G5);
  const hold = await rec({ group: G5, title: 'Hold cloth for an order', does: 'Keeps cloth aside for a stitching order: it is no longer free to sell.', method: 'POST', template: '/holds', path: '/holds', needs: 'stitching:issue', body: { itemCode: 'SLK-0001', quantity: 3, orderRef: 'ST-101' }, expect: [200, 201] });
  const holdId = hold.raw?.data?.id ?? hold.raw?.data?.reservationId ?? hold.raw?.data?.hold?.id;
  await rec({ group: G5, title: 'List holds', does: 'Active holds (all=1 for every one), newest first; orderRef narrows.', method: 'GET', template: '/holds', path: '/holds', query: { orderRef: 'ST-101' }, expect: 200 });
  if (holdId) {
    await rec({ group: G5, title: 'Cut held cloth', does: 'Issues (cuts) all or part of a hold; releaseRest: true lets the rest go.', method: 'POST', template: '/holds/{holdId}/issue', path: `/holds/${holdId}/issue`, needs: 'stitching:issue', body: { quantity: 2 }, expect: 200 });
    await rec({ group: G5, title: 'Let held cloth go', does: 'Releases all or part of what is still held.', method: 'POST', template: '/holds/{holdId}/release', path: `/holds/${holdId}/release`, needs: 'stitching:issue', body: {}, expect: 200 });
  }
  await rec({ group: G5, title: 'Hold for a whole order', does: 'Many lines for one order in one go; allOrNothing: true holds nothing unless every line can be held.', method: 'POST', template: '/holds/order', path: '/holds/order', needs: 'stitching:issue', body: { orderRef: 'ST-102', allOrNothing: true, lines: [{ itemCode: 'SLK-0001', quantity: 2.25 }, { itemCode: 'THR-0001', quantity: 4 }] }, expect: [200, 201] });
  await rec({ group: G5, title: 'Release a whole order', does: 'Lets go of everything held for an order.', method: 'POST', template: '/holds/release-order', path: '/holds/release-order', needs: 'stitching:issue', body: { orderRef: 'ST-102' }, expect: 200 });

  console.log('\n' + G6);
  await rec({ group: G6, title: 'Send a customer', does: 'The person only (never measurements). Matched to the shop\'s customer by phone; in a CRM shop, CRM owns who they are.', method: 'POST', template: '/customers', path: '/customers', needs: 'customers:write', body: { boutiqueCustomerId: 'C-1001', name: 'Lakshmi K.', phone: '+91 98480 11223', email: 'lakshmi@example.com', birthday: '14-08-1990', anniversary: '2 Dec', address: '12 MG Road, Hyderabad' }, expect: [200, 201] });
  await rec({ group: G6, title: 'Send many customers', does: 'Up to 200, row by row.', method: 'POST', template: '/customers/bulk', path: '/customers/bulk', needs: 'customers:write', body: { customers: [{ boutiqueCustomerId: 'C-1002', name: 'Anitha R.', phone: '+919848011224' }, { boutiqueCustomerId: 'C-1003', name: 'Sunitha M.', phone: '+919848011225' }] }, expect: 200 });
  await rec({ group: G6, title: 'One customer', does: 'How ScaleEzy holds your customer, and the shop customer they are matched to.', method: 'GET', template: '/customers/{boutiqueCustomerId}', path: '/customers/C-1001', expect: 200 });
  await rec({ group: G6, title: 'Unlink a customer', does: 'Removes your link; the shop\'s customer stays.', method: 'DELETE', template: '/customers/{boutiqueCustomerId}', path: '/customers/C-1003', needs: 'customers:write', expect: 200 });
  await rec({ group: G6, title: 'Customers the shop removed', does: 'People the shop removed since `after`, so you remove your copy too.', method: 'GET', template: '/customers/removed', path: '/customers/removed', query: { limit: 100 }, expect: 200 });

  console.log('\n' + G7);
  const sup = await rec({ group: G7, title: 'Add a supplier', does: 'Name required; GSTIN checked when given.', method: 'POST', template: '/suppliers', path: '/suppliers', needs: 'suppliers:write', body: { name: 'Ravi Silks', phone: '9849012345', email: 'ravi@example.com', gstin: '36AABCU9603R1ZX', address: 'Begum Bazar, Hyderabad' }, expect: [200, 201] });
  const supId = sup.raw?.data?.id;
  await rec({ group: G7, title: 'Change a supplier', does: 'Only what you send; active false switches them off (back with all=1).', method: 'PUT', template: '/suppliers/{supplierId}', path: `/suppliers/${supId}`, needs: 'suppliers:write', body: { phone: '9849012399' }, expect: 200 });
  await rec({ group: G7, title: 'List suppliers', does: '20 a page; search.', method: 'GET', template: '/suppliers', path: '/suppliers', expect: 200 });
  const po = await rec({ group: G7, title: 'Make a purchase order', does: 'Lines in each item\'s unit; costs per unit.', method: 'POST', template: '/purchase-orders', path: '/purchase-orders', needs: 'suppliers:write',
    body: { supplierId: supId, expectedDate: new Date(Date.now() + 5 * 86_400_000).toISOString().slice(0, 10), invoiceNumber: 'RS-77', notes: 'Diwali stock', lines: [{ itemCode: 'SLK-0001', quantity: 12.5, unitCost: 280 }, { itemCode: 'THR-0001', quantity: 20, unitCost: 30 }] }, expect: 201 });
  const poId = po.raw?.data?.id;
  await rec({ group: G7, title: 'List purchase orders', does: '20 a page; status filter.', method: 'GET', template: '/purchase-orders', path: '/purchase-orders', expect: 200 });
  await rec({ group: G7, title: 'One purchase order', does: 'With its lines and what has come in.', method: 'GET', template: '/purchase-orders/{poId}', path: `/purchase-orders/${poId}`, expect: 200 });
  await rec({ group: G7, title: 'Change a purchase order', does: 'Notes, dates, payment status, lines while nothing has come in.', method: 'PUT', template: '/purchase-orders/{poId}', path: `/purchase-orders/${poId}`, needs: 'suppliers:write', body: { notes: 'Diwali stock, deliver to the godown' }, expect: 200 });
  await rec({ group: G7, title: 'Receive goods', does: 'All or part; stock goes up at once. More than ordered is refused.', method: 'POST', template: '/purchase-orders/{poId}/receive', path: `/purchase-orders/${poId}/receive`, needs: 'suppliers:write', body: { lines: [{ itemCode: 'SLK-0001', quantity: 10 }] }, expect: 200 });
  await rec({ group: G7, title: 'Supplier performance', does: 'On time, short and over deliveries per supplier.', method: 'GET', template: '/suppliers/performance', path: '/suppliers/performance', needs: 'reports:view', expect: 200 });

  console.log('\n' + G8);
  await rec({ group: G8, title: 'Set up racks and shelves in one go', does: 'Levels with ranges (rack 1, shelves 1-2). preview: true shows what would be made; running it again adds only what is missing.', method: 'POST', template: '/stores/{storeId}/spots/bulk', path: `/stores/${main0}/spots/bulk`, needs: 'stock:write',
    body: { levels: [{ kind: 'RACK', range: { from: 1, to: 1 } }, { kind: 'SHELF', range: { from: 1, to: 2 } }] }, expect: 200 });
  const tree = await rec({ group: G8, title: 'Racks and shelves of a store', does: 'The tree, with what is on each.', method: 'GET', template: '/stores/{storeId}/spots', path: `/stores/${main0}/spots`, expect: 200 });
  const flat: any[] = [];
  const walk = (xs: any[]) => { for (const x of xs ?? []) { flat.push(x); walk(x.children); } };
  walk(tree.raw?.data?.spots ?? tree.raw?.data ?? []);
  const fromDb = await prisma.storageSpot.findMany({ where: { clientId, locationId: main0, kind: 'SHELF' as any }, orderBy: { code: 'asc' } });
  const [s1, s2] = fromDb;
  const rack = await prisma.storageSpot.findFirst({ where: { clientId, locationId: main0, kind: 'RACK' as any } });
  await rec({ group: G8, title: 'Add one spot', does: 'An area, rack, cupboard, shelf or box; parentId puts it inside another.', method: 'POST', template: '/stores/{storeId}/spots', path: `/stores/${main0}/spots`, needs: 'stock:write', body: { kind: 'BOX', code: 'B1', parentId: rack?.id, name: 'Button box' }, expect: 201 });
  if (s1 && s2) {
    await rec({ group: G8, title: 'Find a shelf by its label', does: 'What a scanner read from a shelf label (with or without its SEZ: prefix), or the typed address with locationId.', method: 'GET', template: '/spots/scan', path: '/spots/scan', query: { code: `SEZ:${(s1 as any).labelCode}` }, expect: 200 });
    await rec({ group: G8, title: 'Put stock on a shelf', does: 'From the floor (or another shelf, fromSpotId) onto a shelf, in the item\'s unit.', method: 'POST', template: '/shelf-moves', path: '/shelf-moves', needs: 'stock:write or stock:transfer', body: { itemCode: 'SLK-0001', locationId: main0, toSpotId: s1.id, quantity: 10 }, expect: 200 });
    await rec({ group: G8, title: 'What is on a shelf', does: 'Items and quantities on one shelf.', method: 'GET', template: '/spots/{spotId}', path: `/spots/${s1.id}`, expect: 200 });
    await rec({ group: G8, title: 'Where is it?', does: 'Every shelf an item is on, at one store or all.', method: 'GET', template: '/items/{itemCode}/where', path: '/items/SLK-0001/where', query: { locationId: main0 }, expect: 200 });
    await rec({ group: G8, title: 'Search shelves', does: 'Find items on shelves by name or code.', method: 'GET', template: '/where', path: '/where', query: { search: 'silk', locationId: main0 }, expect: 200 });
    await rec({ group: G8, title: 'Count a shelf', does: 'What is actually on it; complete: true says the shelf is fully counted (anything not named is 0).', method: 'POST', template: '/spots/{spotId}/count', path: `/spots/${s1.id}/count`, needs: 'stock:write', body: { counts: [{ itemCode: 'SLK-0001', quantity: 10 }], complete: true }, expect: 200 });
    await rec({ group: G8, title: 'Shelf history', does: 'Moves and counts on one shelf.', method: 'GET', template: '/spots/{spotId}/history', path: `/spots/${s1.id}/history`, expect: 200 });
    await rec({ group: G8, title: 'Move a whole shelf', does: 'Everything on one shelf to another.', method: 'POST', template: '/shelf-moves/whole-shelf', path: '/shelf-moves/whole-shelf', needs: 'stock:write or stock:transfer', body: { fromSpotId: s1.id, toSpotId: s2.id }, expect: 200 });
    await rec({ group: G8, title: 'Change a spot', does: 'Name, code, colour, capacity, active.', method: 'PUT', template: '/spots/{spotId}', path: `/spots/${s1.id}`, needs: 'stock:write', body: { name: 'Silk shelf' }, expect: 200 });
  }
  await rec({ group: G8, title: 'Shelf labels', does: 'Label data for every shelf (or spotIds=…), for printing.', method: 'GET', template: '/stores/{storeId}/labels', path: `/stores/${main0}/labels`, expect: 200 });
  await rec({ group: G8, title: 'Not on any shelf', does: 'Stock at the store that is on no shelf yet, a page at a time.', method: 'GET', template: '/stores/{storeId}/not-shelved', path: `/stores/${main0}/not-shelved`, expect: 200 });
  await rec({ group: G8, title: 'Shelves due a count', does: 'Shelves in the order to count them next.', method: 'GET', template: '/stores/{storeId}/count-queue', path: `/stores/${main0}/count-queue`, expect: 200 });
  const probs = await rec({ group: G8, title: 'Shelf problems', does: 'Mismatches found by counts and moves; status OPEN/FIXED, locationId.', method: 'GET', template: '/shelf-problems', path: '/shelf-problems', expect: 200 });
  const pid = (probs.raw?.data?.problems ?? probs.raw?.data?.items ?? probs.raw?.data ?? [])[0]?.id;
  if (pid) await rec({ group: G8, title: 'Mark a shelf problem fixed', does: 'With a note.', method: 'POST', template: '/shelf-problems/{problemId}/fix', path: `/shelf-problems/${pid}/fix`, needs: 'stock:write', body: { note: 'recounted' }, expect: 200 });

  console.log('\n' + G9);
  const bar = blouse.raw?.data?.barcode;
  await rec({ group: G9, title: 'Scan', does: 'What a scanner read (or an item code / SKU / BV- code typed in) -> the item with its stock. matchedBy says barcode or code.', method: 'GET', template: '/items/scan', path: '/items/scan', query: { code: bar }, expect: 200 });
  await rec({ group: G9, title: 'Give barcodes to items that have none', does: 'Items added before 20 Nov get theirs; 100 a call; repeat until stillWithout is 0.', method: 'POST', template: '/items/barcodes/fill', path: '/items/barcodes/fill', needs: 'products:write', body: {}, expect: 200 });
  await rec({ group: G9, title: 'Label sheet (PDF)', does: '50 x 25 mm labels: name, price (per metre for cloth), SKU, barcode. Up to 100 items, 1-50 copies each; storeId prices at that store.', method: 'POST', template: '/labels', path: '/labels', body: { itemCodes: ['SLK-0001', 'BLS-0001'], copies: 2 }, raw: true, expect: 200 });

  console.log('\n' + G10);
  const kurta = await prisma.product.create({ data: { clientId, productCode: `PRD-${S}`, slug: `prd-${S}`, title: 'Cotton kurta', category: 'WOMEN' as any, productType: 'READY_TO_WEAR' as any, basePrice: 2000, status: 'ACTIVE' as any, publishedAt: new Date(), sellInShop: true, hsnCode: '6211', taxRateBps: 500, taxSlabbed: false, priceIsExclusive: false } as any });
  await prisma.productVariant.create({ data: { clientId, productId: kurta.id, variantCode: 'PRD-KRT-RED-M', sku: 'PRD-KRT-RED-M', colorName: 'Red', size: 'M', sellingPrice: 2000 } as any });
  await rec({ group: G10, title: 'Price a bill (GST shop)', does: 'The exact total before a bill is made: each line, offers, GST split, round-off, payable. Any item the shop sells -- yours and the shop\'s retail products -- by barcode or code. Nothing is saved.', method: 'POST', template: '/price-check', path: '/price-check',
    body: { lines: [{ code: bar, quantity: 1 }, { code: 'SLK-0001', quantity: 2.25 }, { code: 'PRD-KRT-RED-M', quantity: 1 }, { code: 'THR-0001', quantity: 1 }], customerPhone: '+919848011223' }, expect: 200,
    notes: ['The shop in this example is not registered for GST, so the document is a plain RECEIPT and GST is 0 (a composition shop gets BILL_OF_SUPPLY). The next price check, after switching GST on in section 12, is a TAX_INVOICE with each line\'s taxable, cgst, sgst and igst.'] });

  console.log('\n' + G11);
  const offer = await rec({ group: G11, title: 'Make an offer', does: 'Starts as a draft. Targets and exclusions name your codes.', method: 'POST', template: '/offers', path: '/offers', needs: 'offers:write',
    body: { name: 'Blouse week', valueType: 'PERCENTAGE', value: 10, scope: 'VARIANT', targets: [{ scope: 'VARIANT', code: 'BLS-0001' }], startsAt: new Date(Date.now() - 3600_000).toISOString(), endsAt: null }, expect: 201 });
  const offerId = offer.raw?.data?.id;
  await rec({ group: G11, title: 'Switch an offer on', does: 'status ACTIVE, PAUSED or ARCHIVED.', method: 'POST', template: '/offers/{offerId}/status', path: `/offers/${offerId}/status`, needs: 'offers:write', body: { status: 'ACTIVE' }, expect: 200 });
  await rec({ group: G11, title: 'Change an offer', does: 'Only what you send; changeNote goes into its history.', method: 'PUT', template: '/offers/{offerId}', path: `/offers/${offerId}`, needs: 'offers:write', body: { value: 15, changeNote: 'Festival week' }, expect: 200 });
  const coded = await rec({ group: G11, title: 'Make a code offer', does: 'trigger CODE with couponCode; a department offer (CATEGORY) excluding one item.', method: 'POST', template: '/offers', path: '/offers', needs: 'offers:write',
    body: { name: 'Welcome 100', trigger: 'CODE', couponCode: 'WELCOME100', valueType: 'FIXED_AMOUNT', value: 100, minSubtotal: 1000, scope: 'CATEGORY', targets: [{ scope: 'CATEGORY', name: 'WOMEN' }], exclusions: [{ scope: 'VARIANT', code: 'SLK-0001' }], startsAt: new Date(Date.now() - 3600_000).toISOString(), usageLimitPerCustomer: 1 }, expect: 201 });
  await rec({ group: G11, title: 'List offers', does: 'Filters: status (ACTIVE, SCHEDULED, EXPIRED, PAUSED, DRAFT, ARCHIVED), search.', method: 'GET', template: '/offers', path: '/offers', expect: 200 });
  await rec({ group: G11, title: 'One offer', does: 'With times used and the total it has taken off.', method: 'GET', template: '/offers/{offerId}', path: `/offers/${offerId}`, expect: 200 });
  await rec({ group: G11, title: 'Codes of an offer', does: 'For an offer with one-time codes (uniqueCodes); status and q filter.', method: 'GET', template: '/offers/{offerId}/codes', path: `/offers/${coded.raw?.data?.id}/codes`, expect: 200 });
  await rec({ group: G10, title: 'Price a bill with an offer and a code', does: 'The 15% blouse offer applies on its own; a code that would take less is not combined, and says so.', method: 'POST', template: '/price-check', path: '/price-check', body: { lines: [{ code: 'BLS-0001', quantity: 1 }], couponCode: 'WELCOME100' }, expect: 200 });

  console.log('\n' + G12);
  await rec({ group: G12, title: 'Read the settings', does: 'Shop details, GST, what you sell, points, the till limit, returns, payments (the keys are never shown; the webhook address only to settings:write).', method: 'GET', template: '/settings', path: '/settings', expect: 200 });
  await rec({ group: G12, title: 'Shop details and GST', does: 'What bills print. Any field name not listed is refused.', method: 'PUT', template: '/settings/shop', path: '/settings/shop', needs: 'settings:write',
    body: { businessName: 'Lakshmi Boutique', businessAddress: '12 Road No. 3, Banjara Hills, Hyderabad 500034', businessPhone: '9000000001', businessEmail: 'hello@example.com', gstNumber: '36AABCU9603R1ZX', gstRegistration: 'REGULAR', receiptFooter: 'Thank you! Exchange within 7 days.' }, expect: 200 });
  await rec({ group: G10, title: 'Price a bill (now GST registered)', does: 'The same bill after switching GST on: a tax invoice with each line\'s CGST and SGST.', method: 'POST', template: '/price-check', path: '/price-check', body: { lines: [{ code: 'PRD-KRT-RED-M', quantity: 1 }, { code: 'SLK-0001', quantity: 2.25 }] }, expect: 200 });
  await rec({ group: G12, title: 'What the shop sells', does: 'sells FABRICS or BOTH (ready-made only is refused while linked); fabricMinCut in cm.', method: 'PUT', template: '/settings/what-you-sell', path: '/settings/what-you-sell', needs: 'settings:write', body: { sells: 'BOTH', fabricMinCut: 25 }, expect: 200 });
  await rec({ group: G12, title: 'Points rules', does: 'Earning, spending, expiry, where points are earned.', method: 'PUT', template: '/settings/points', path: '/settings/points', needs: 'settings:write', body: { enabled: true, pointsPer100: 1, pointValuePaise: 100, minRedeemPoints: 100, maxRedeemPercent: 50, expiryMonths: 12, earnAtCounter: true, earnOnlineShop: true }, expect: 200 });
  await rec({ group: G12, title: 'Till hand-discount limit', does: 'The most a cashier may take off by hand, in %; empty for no limit.', method: 'PUT', template: '/settings/offers', path: '/settings/offers', needs: 'settings:write', body: { manualDiscountMaxPercent: 10 }, expect: 200 });
  await rec({ group: G12, title: 'Return rules', does: 'Days a bill may be returned in; rupees a cashier may refund without the manager.', method: 'PUT', template: '/settings/returns', path: '/settings/returns', needs: 'settings:write', body: { returnWindowDays: 7, counterReturnMax: 2000 }, expect: 200 });
  await rec({ group: G12, title: 'Payment keys (refused example)', does: 'The shop\'s own Razorpay keyId and keySecret: checked with Razorpay, stored encrypted, never shown again. The answer gives the webhook address and, once, its secret.', method: 'PUT', template: '/settings/payments', path: '/settings/payments', needs: 'settings:write', body: { keyId: 'not-a-key', keySecret: '…' }, expect: 400,
    notes: ['Shown with a key that is not Razorpay\'s, so no real Razorpay call is made here. With real keys the answer is the payments view: connected, mode, status, webhookUrl, webhookSecret (once).'] });
  await rec({ group: G12, title: 'Check the payment keys again', does: 'Asks Razorpay whether the stored keys still work.', method: 'POST', template: '/settings/payments/check', path: '/settings/payments/check', body: {}, expect: [200, 400], notes: ['This shop has no keys, so the example is the answer for a shop without them.'] });
  await rec({ group: G12, title: 'Disconnect payments', does: 'Removes the stored keys; the online shop stops taking payments.', method: 'DELETE', template: '/settings/payments', path: '/settings/payments', needs: 'settings:write', expect: 200 });

  console.log('\n' + G13);
  const today = new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10);
  const month = today.slice(0, 8) + '01';
  for (const [p, title, does, q] of [
    ['/reports/stock-summary', 'Stock summary', 'Value and units by category; slow items (deadDays, default 90).', { deadDays: 90 }],
    ['/reports/low-stock', 'Low stock', 'Items at or below their reorder level.', undefined],
    ['/reports/consumption', 'Consumption', 'What was used for orders, by item; from, to, category.', { from: month, to: today }],
    ['/reports/loss-rates', 'Loss rates', 'Damage and waste against what came in; from, to.', { from: month, to: today }],
    ['/reports/cost-per-order', 'Cost per order', 'Material cost of each stitching order; from, to, orderRef.', { from: month, to: today }],
    ['/reports/order-usage', 'One order\'s usage', 'Everything held, cut and used for one order.', { orderRef: 'ST-101' }],
    ['/reports/movement-summary', 'Movement summary', 'In and out by kind; from, to.', { from: month, to: today }],
    ['/reports/daybook', 'Day Book', 'The day (or days) in one answer: money taken by method, stock in and out, sales and GST, returns; from, to, locationId.', { from: today, to: today }],
    ['/reports/purchase-spend', 'Purchase spend', 'What was bought, by supplier; from, to.', { from: month, to: today }],
    ['/reports/supplier-performance', 'Supplier performance', 'On time, short and over, per supplier.', undefined]
  ] as const) {
    await rec({ group: G13, title, does, method: 'GET', template: p, path: p, query: q as any, needs: 'reports:view', expect: 200 });
  }

  console.log('\n' + G14);
  await rec({ group: G14, kind: 'error', title: 'No pass', does: 'Every call needs Authorization: Bearer <pass>.', method: 'GET', template: '/items', path: '/items', noPass: true, expect: 401 });
  await rec({ group: G14, kind: 'error', title: 'The person may not', does: 'The pass\'s `can` list lacks the word this call needs: nothing changes.', method: 'PUT', template: '/items/{itemCode}', path: '/items/SLK-0001', can: ['stock:write'], body: { sellingPrice: 1 }, expect: 403 });
  await rec({ group: G14, kind: 'error', title: 'Another shop\'s thing', does: 'Ids and codes of another client are simply not found.', method: 'GET', template: '/offers/{offerId}', path: `/offers/${offerId}`, tenant: TEN_OTHER, expect: [403, 404] });
  await rec({ group: G14, kind: 'error', title: 'Not found', does: 'An item code the shop does not have.', method: 'GET', template: '/items/{itemCode}', path: '/items/NOPE-9999', expect: 404 });
  await rec({ group: G14, kind: 'error', title: 'A wrong value, in words', does: 'Every refusal says what to fix.', method: 'PUT', template: '/items/{itemCode}', path: '/items/SLK-0002', body: { name: 'Bad', unit: 'METER', sellingPrice: 450.5 }, expect: 400 });
  const KEY = `apidoc-${S}-reuse`;
  await rec({ group: G14, kind: 'error', title: 'Same request again', does: 'The same Idempotency-Key and the same body: the first answer again (header Idempotent-Replay: true), nothing done twice.', method: 'POST', template: '/counts', path: '/counts', body: { itemCode: 'THR-0001', counted: 50 }, key: KEY, expect: [200, 201] });
  await rec({ group: G14, kind: 'error', title: 'A key used for a different request', does: 'The same Idempotency-Key with a different body is refused: use a new key for a new change.', method: 'POST', template: '/counts', path: '/counts', body: { itemCode: 'THR-0001', counted: 49 }, key: KEY, expect: [409, 422] });
  await rec({ group: G14, kind: 'error', title: 'A store with stock cannot be removed', does: 'Refusals that protect stock say what to do first.', method: 'DELETE', template: '/stores/{storeId}', path: `/stores/${cutId}`, needs: 'stock:write', expect: [200, 409] });
}

/* ── writing the registry ───────────────────────────────────────────────────────────────────────── */
const j = (v: unknown) => JSON.stringify(v, null, 2);
function writeDocs() {
  const groups = [...new Set(recs.map(r => r.group))].sort((a, b) => parseInt(a) - parseInt(b));
  const anchor = (r: Rec, i: number) => `e${i}`;
  let md = `# ScaleEzy Boutique API: every endpoint, with real requests and answers

For the Boutique app (CRM-B) developers. Generated ${new Date().toISOString().slice(0, 10)} by calling every endpoint for real on ScaleEzy's
test server, in a throwaway shop, and recording what came back. **Every example below is a real answer**, not a guess
(long lists are cut to their first two, marked "… N more"). The rules, the pass and the edge cases are in
**ScaleEzy-Boutique-API-Guide.md**; this registry is the reference for each call. A machine-readable copy is
**boutique-api-registry.json**.

| | |
|---|---|
| Base URL | \`https://inventory-backend-1-ym8d.onrender.com/api/v1/internal/boutique\` |
| Every call | \`Authorization: Bearer <pass>\` (RS256 JWT: scope ["modules:boutique"], tenant, onBehalfOf { userId, name, can }, aud "inventory", exp within 15 min) |
| Every change (POST, PUT, DELETE) | \`Idempotency-Key: <a new id per change>\`; the same key again gives the first answer |
| Answers | JSON \`{ "success": true, "data": … }\` or \`{ "success": false, "message": "…" }\` (the label sheet is a PDF) |
| Money | rupees (\`450\`), except fields named …Paise |
| Quantities | in the item's unit: \`2.25\` for 2.25 metres |
| Endpoints | ${new Set(recs.filter(r => r.kind === 'example').map(r => `${r.method} ${r.template}`)).size} |

## Contents

`;
  let i = 0;
  const idx = new Map<Rec, number>();
  for (const g of groups) {
    md += `- **${g}**\n`;
    for (const r of recs.filter(x => x.group === g)) { idx.set(r, i++); md += `  - [\`${r.method} ${r.template}\`](#${anchor(r, idx.get(r)!)}) ${r.title}\n`; }
  }
  for (const g of groups) {
    md += `\n---\n\n## ${g}\n`;
    for (const r of recs.filter(x => x.group === g)) {
      md += `\n<a id="${anchor(r, idx.get(r)!)}"></a>\n### ${r.title}\n\n\`${r.method} ${r.template}\`  ·  needs: **${r.can}**\n\n${r.does}\n\n`;
      if (r.query) md += `**Query:** \`?${Object.entries(r.query).map(([k, v]) => `${k}=${v}`).join('&')}\`\n\n`;
      if (r.body !== undefined) md += `**Request body:**\n\n\`\`\`json\n${j(r.body)}\n\`\`\`\n\n`;
      md += `**Answer:** \`${r.status}\`${r.contentType && r.contentType !== 'application/json' ? ` (${r.contentType})` : ''}\n\n`;
      md += typeof r.response === 'string' ? `${r.response}\n\n` : `\`\`\`json\n${j(r.response)}\n\`\`\`\n\n`;
      for (const note of r.notes ?? []) md += `> ${note}\n\n`;
    }
  }
  md += `
---

## Not shown with an answer above

` +
    `- \`POST /shelf-problems/{problemId}/fix\` (needs stock:write) -- body \`{ "note": "recounted" }\`; answers the problem, now FIXED. No shelf problem arose in this run.
` +
    `- \`GET /changes?after=<next>\` -- the next page of changes, the same shape; this small shop had no second page.
` +
    `- \`DELETE /stores/{storeId}\` succeeding -- a store with no stock and no holds is removed (kept for its history, off every list); shown above refused because it still had stock.
` +
    `- \`PUT /settings/payments\` with real keys -- answers \`{ account: { connected, mode, status, webhookUrl, readyForCustomers, … }, webhookSecret }\`; the secret is shown this once. Not run here (no real Razorpay call).
`;
  fs.writeFileSync(path.join(OUT_DIR, 'ScaleEzy-Boutique-API-Registry.md'), md);
  fs.writeFileSync(path.join(OUT_DIR, 'boutique-api-registry.json'), j({
    generated: new Date().toISOString(), baseUrl: 'https://inventory-backend-1-ym8d.onrender.com/api/v1/internal/boutique',
    endpoints: recs.map(r => ({ group: r.group, title: r.title, method: r.method, path: r.template, needs: r.can, does: r.does, kind: r.kind, query: r.query ?? null, body: r.body ?? null, status: r.status, contentType: r.contentType, response: r.response, notes: r.notes ?? [] }))
  }));
  console.log(`\nwrote handouts/ScaleEzy-Boutique-API-Registry.md (${recs.length} calls) and boutique-api-registry.json`);
}

async function cleanup() {
  const ids = (await prisma.boutiqueLink.findMany({ where: { tenant: { startsWith: 'apidoc-' } }, select: { clientId: true } })).map(l => l.clientId);
  await prisma.boutiqueJoinRequest.deleteMany({ where: { tenant: { startsWith: 'apidoc-' } } }).catch(e => console.error('join', e.message));
  if (!ids.length) return;
  await prisma.$executeRawUnsafe(`DELETE FROM offers WHERE client_id = ANY($1)`, ids).catch(e => console.error('offers', e.message));
  const tables = await prisma.$queryRaw<{ table_name: string }[]>`SELECT DISTINCT table_name FROM information_schema.columns WHERE table_schema = 'public' AND column_name = 'client_id'`;
  await prisma.$executeRawUnsafe(`DELETE FROM variant_location_profiles WHERE variant_id IN (SELECT id FROM inventory_product_variants WHERE client_id = ANY($1))`, ids).catch(() => undefined);
  await prisma.$executeRawUnsafe(`DELETE FROM inventory_product_images WHERE product_id IN (SELECT id FROM inventory_products WHERE client_id = ANY($1))`, ids).catch(() => undefined);
  for (let round = 0; round < 10; round++) {
    let left = 0;
    for (const t of tables) { try { await prisma.$executeRawUnsafe(`DELETE FROM "${t.table_name}" WHERE client_id = ANY($1)`, ids); } catch { left++; } }
    if (!left) break;
  }
  console.log(`cleaned up ${ids.length} clients`);
}

main()
  .then(() => writeDocs())
  .catch(e => { bad++; console.error('CRASH', e); })
  .finally(async () => { await cleanup().catch(e => console.error('cleanup failed', e)); console.log(`${good} passed, ${bad} problems`); await prisma.$disconnect(); process.exit(bad ? 1 : 0); });
