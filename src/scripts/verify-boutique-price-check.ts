/**
 * The boutique price check (20 Nov 2026, PLAN-boutique-backend.md part 2), against the REAL local server and DB.
 *
 * POST /internal/boutique/price-check: a counter bill's exact total before it is made -- Inventory's one offer engine
 * and the shop's own GST settings. Proved: exact GST on an inclusive price; cloth by the metre (2.25 m) and the
 * round-off; boutique and retail items alike, by barcode or code; an automatic offer and a code; the customer's
 * offers by phone; a shop that charges no GST; an item with no HSN; materials, archived, unknown and other shops'
 * items never priced; a store's own price; nothing saved; and every bad input refused in words.
 *
 * Throwaway accounts only (pctest-*); everything it makes is removed. Local only.
 *   DATABASE_URL=<local> DIRECT_URL=<local> VERIFY_API_URL=http://localhost:4036/api/v1 \
 *   BOUTIQUE_KEY_DIR=<dir with private.pem> npx tsx src/scripts/verify-boutique-price-check.ts
 */
import fs from 'node:fs';
import axios from 'axios';
import jwt from 'jsonwebtoken';
import { prisma } from '../lib/prisma';
import { offerService } from '../services/offers';

const BASE = process.env.VERIFY_API_URL || 'http://localhost:4036/api/v1';
for (const k of ['DATABASE_URL', 'DIRECT_URL']) {
  if (!/localhost:55433/.test(process.env[k] ?? '')) { console.error(`Refusing: ${k} is not the local database.`); process.exit(2); }
}
if (!/localhost|127\.0\.0\.1/.test(BASE)) { console.error('Refusing: VERIFY_API_URL is not a local server.'); process.exit(2); }
const privateKey = fs.readFileSync(`${process.env.BOUTIQUE_KEY_DIR}/private.pem`, 'utf8');

const S = Date.now().toString(36);
const TEN = `pctest-${S}`, TEN2 = `pctest-${S}-b`;
let bad = 0, good = 0;
const check = (name: string, ok: boolean, detail: unknown = '') => {
  ok ? good++ : bad++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : ` :: ${typeof detail === 'string' ? detail : JSON.stringify(detail)?.slice(0, 600)}`}`);
};
const pass = (tenant: string, can = ['products:write', 'stock:write']) => jwt.sign({ sub: 'crm-b', scope: ['modules:boutique'], tenant, onBehalfOf: { userId: 'u1', name: 'Lakshmi', can } },
  privateKey, { algorithm: 'RS256', audience: 'inventory', issuer: 'scaleezy-boutique-test', keyid: 'btq-1', expiresIn: '5m' });
let n = 0;
async function call(method: string, p: string, body?: unknown, o: { tenant?: string; can?: string[] } = {}) {
  const r = await axios.request({ method, url: `${BASE}/internal/boutique${p}`, data: body, validateStatus: () => true, timeout: 90_000,
    headers: { Authorization: `Bearer ${pass(o.tenant ?? TEN, o.can)}`, ...(method !== 'GET' ? { 'Idempotency-Key': `pc-${S}-${++n}` } : {}) } });
  return { status: r.status, data: r.data?.data, message: r.data?.message as string | undefined };
}
const pc = (lines: unknown, more: Record<string, unknown> = {}, o: { tenant?: string; can?: string[] } = {}) => call('POST', '/price-check', { lines, ...more }, o);
const near = (a: number, b: number) => Math.abs(a - b) < 0.005;
const sum = (xs: number[]) => Math.round(xs.reduce((s, x) => s + x, 0) * 100) / 100;

async function main() {
  const link = await call('POST', '/link', { shopName: 'Price Check Boutique' });
  check('a throwaway boutique is linked', link.status === 201, link);
  const clientId = link.data.clientId as string;
  await prisma.clientSettings.update({ where: { clientId }, data: { gstRegistration: 'REGULAR', gstNumber: '36AABCU9603R1ZX', gstStateCode: '36' } as any });
  const B = `${S}-BL`, SILK = `${S}-SK`, TH = `${S}-TH`, AR = `${S}-AR`;
  const blouse = await call('PUT', `/items/${B}`, { name: 'Ready blouse', category: 'FINISHED', unit: 'PIECE', color: 'Maroon', sellingPrice: 1499, gstPercent: 5, hsnCode: '6206', sellInShop: true });
  await call('PUT', `/items/${SILK}`, { name: 'Kanchi silk', kind: 'FABRIC', unit: 'METER', color: 'Green', sellingPrice: 450, gstPercent: 5, hsnCode: '5007', sellInShop: true });
  await call('PUT', `/items/${TH}`, { name: 'Zari thread', category: 'EMBELLISHMENT', unit: 'PIECE', sellingPrice: 40, sellInShop: false });
  await call('PUT', `/items/${AR}`, { name: 'Old blouse', category: 'FINISHED', unit: 'PIECE', sellingPrice: 999, gstPercent: 5, hsnCode: '6206', sellInShop: true });
  await call('POST', `/items/${AR}/archive`);
  // The shop's own retail product (added in Inventory's app), with a barcode, and one with no HSN.
  const kurta = await prisma.product.create({ data: { clientId, productCode: `PRD-${S}`, slug: `prd-${S}`, title: 'Cotton kurta', category: 'WOMEN' as any, productType: 'READY_TO_WEAR' as any, basePrice: 2000, status: 'ACTIVE' as any, publishedAt: new Date(), sellInShop: true, hsnCode: '6211', taxRateBps: 500, taxSlabbed: false, priceIsExclusive: false } as any });
  await prisma.productVariant.create({ data: { clientId, productId: kurta.id, variantCode: `PRD-${S}-R`, sku: `PRD-${S}-R`, colorName: 'Red', size: 'M', sellingPrice: 2000, barcode: `SVM-PC${S}`.slice(0, 20).toUpperCase() } as any });
  const KB = `SVM-PC${S}`.slice(0, 20).toUpperCase();
  const nohsn = await prisma.product.create({ data: { clientId, productCode: `NOH-${S}`, slug: `noh-${S}`, title: 'Dupatta', category: 'WOMEN' as any, productType: 'READY_TO_WEAR' as any, basePrice: 500, status: 'ACTIVE' as any, publishedAt: new Date(), sellInShop: true, taxSlabbed: false, priceIsExclusive: false } as any });
  await prisma.productVariant.create({ data: { clientId, productId: nohsn.id, variantCode: `NOH-${S}-1`, sku: `NOH-${S}-1`, colorName: 'Pink', size: 'Free', sellingPrice: 500 } as any });
  const quotesBefore = await prisma.pricingQuote.count({ where: { clientId } });

  console.log('\nEXACT GST, NO OFFERS');
  const one = await pc([{ code: B, quantity: 1 }]);
  const l1 = one.data?.lines?.[0];
  check('blouse Rs 1,499 incl 5%: taxable 1,427.62, CGST 35.69 + SGST 35.69, payable 1,499', one.status === 200 && l1?.unitPrice === 1499 && near(l1.taxable, 1427.62) && near(l1.cgst, 35.69) && near(l1.sgst, 35.69) && l1.igst === 0 && one.data.totals.payable === 1499 && one.data.totals.roundOff === 0, one.data ?? one);
  check('...tax invoice, GST charged, can be billed', one.data?.document === 'TAX_INVOICE' && one.data?.chargesGst === true && one.data?.canBill === true, one.data);
  check('...the line names the item (code, BV- code, name, colour, HSN, 5%)', l1?.itemCode === B && l1?.variantCode === `BV-${B}` && l1?.name === 'Ready blouse' && l1?.colour === 'Maroon' && l1?.hsnCode === '6206' && l1?.gstPercent === 5, l1);
  const silk = await pc([{ code: SILK, quantity: 2.25 }]);
  const ls = silk.data?.lines?.[0];
  check('2.25 m silk at Rs 450 a metre: line 1,012.50, payable 1,013 (round-off 0.50)', ls?.quantity === 2.25 && ls?.unitPrice === 450 && ls?.lineTotal === 1012.5 && silk.data?.totals.payable === 1013 && silk.data?.totals.roundOff === 0.5 && ls?.unit === 'METRE', silk.data ?? silk);
  const byBar = await pc([{ code: blouse.data.barcode, quantity: 2 }, { code: KB, quantity: 1 }]);
  check('by barcode, boutique and retail together: 2 blouses + 1 kurta = 4,998', byBar.status === 200 && byBar.data?.lines?.length === 2 && byBar.data.totals.payable === 4998 && byBar.data.lines[1].variantCode === `PRD-${S}-R`, byBar.data ?? byBar);
  const t = byBar.data?.totals;
  check('...totals add up: taxable + GST = payable - round-off; lines sum to totals', t && near(t.taxable + t.gst, t.payable - t.roundOff) && near(sum(byBar.data.lines.map((l: any) => l.cgst)), t.cgst) && near(t.cgst + t.sgst, t.gst), t);
  check('...every line: taxable + CGST + SGST = its total (prices include GST)', (byBar.data?.lines ?? []).every((l: any) => near(l.taxable + l.cgst + l.sgst + l.igst, l.lineTotal)), byBar.data?.lines);
  check('the BV- code and the shop SKU work as codes too', (await pc([{ code: `BV-${B}`, quantity: 1 }, { code: `PRD-${S}-R`, quantity: 1 }])).data?.totals?.payable === 3499);

  console.log('\nNOT PRICED, SAID WHY');
  const mix = await pc([{ code: B, quantity: 1 }, { code: TH, quantity: 1 }, { code: AR, quantity: 1 }, { code: 'NOPE-1', quantity: 1 }]);
  const why = Object.fromEntries((mix.data?.notPriced ?? []).map((x: any) => [x.code, x.reason]));
  check('the blouse priced; thread, archived and unknown listed with reasons; cannot bill', mix.status === 200 && mix.data.lines.length === 1 && /not for sale/.test(why[TH] ?? '') && /not for sale/.test(why[AR] ?? '') && /Nothing in this shop/.test(why['NOPE-1'] ?? '') && mix.data.canBill === false, mix.data);
  const link2 = await call('POST', '/link', { shopName: 'Other' }, { tenant: TEN2 });
  const theirs = await pc([{ code: B, quantity: 1 }, { code: blouse.data.barcode, quantity: 1 }], {}, { tenant: TEN2 });
  check('another shop cannot price this shop\'s items (by code or barcode)', link2.status === 201 && theirs.status === 200 && theirs.data.lines.length === 0 && theirs.data.notPriced.length === 2, theirs.data ?? theirs);
  const noh = await pc([{ code: `NOH-${S}-1`, quantity: 1 }]);
  check('an item with no HSN in a GST shop: priced, but a problem says so and it cannot be billed', noh.status === 200 && noh.data.lines.length === 1 && noh.data.problems.length > 0 && noh.data.canBill === false, noh.data);

  console.log('\nBAD INPUT, REFUSED IN WORDS');
  for (const [lines, why2] of [
    [[], 'no lines'], [[{ quantity: 1 }], 'no code'], [[{ code: B, quantity: 0 }], 'quantity 0'], [[{ code: B, quantity: -1 }], 'quantity -1'],
    [[{ code: B, quantity: 'two' }], 'quantity a word'], [[{ code: B, quantity: 1.5 }], 'half a blouse'], [[{ code: SILK, quantity: 2.255 }], '2.255 m (below a cm)'],
    [[{ code: B, quantity: 1 }, { code: blouse.data.barcode, quantity: 1 }], 'the same item twice (code and barcode)'],
    [Array.from({ length: 101 }, (_, i) => ({ code: `C${i}`, quantity: 1 })), '101 lines'], ['nope', 'lines not a list']
  ] as const) {
    const r = await pc(lines);
    check(`${why2}: 400 with a sentence`, r.status === 400 && (r.message ?? '').length > 10, [r.status, r.message]);
  }
  const otherStore = await prisma.stockLocation.findFirst({ where: { clientId: link2.data.clientId } });
  const bs = await pc([{ code: B, quantity: 1 }], { storeId: otherStore!.id });
  check('another shop\'s store: 404', bs.status === 404, bs);

  console.log('\nOFFERS AND CODES');
  const auto = await offerService.create(clientId, { name: `Diwali 10% ${S}`, trigger: 'AUTOMATIC', valueType: 'PERCENTAGE', value: 10, scope: 'ALL', startsAt: new Date(Date.now() - 3600_000).toISOString(), endsAt: null } as any);
  await offerService.setStatus(clientId, auto.id, 'ACTIVE');
  const off = await pc([{ code: B, quantity: 1 }]);
  const lo = off.data?.lines?.[0];
  check('an automatic 10% offer: discount 149.90, line 1,349.10, the offer named', lo?.discount === 149.9 && lo?.lineTotal === 1349.1 && lo?.offers?.[0]?.name === `Diwali 10% ${S}` && off.data.totals.discount === 149.9, off.data);
  check('...GST is on the price after the offer', near(lo.taxable + lo.cgst + lo.sgst, 1349.1) && near(lo.taxable, 1284.86), lo);
  const CODE = `PC${S}`.toUpperCase().slice(0, 12);
  const coded = await offerService.create(clientId, { name: `Code ${S}`, trigger: 'CODE', couponCode: CODE, valueType: 'FIXED_AMOUNT', value: 100, scope: 'ALL', startsAt: new Date(Date.now() - 3600_000).toISOString(), endsAt: null } as any);
  await offerService.setStatus(clientId, coded.id, 'ACTIVE');
  const withCode = await pc([{ code: B, quantity: 1 }], { couponCode: CODE.toLowerCase() });
  check('a code while a bigger offer runs: not taken, and the reason says they do not combine', withCode.data?.coupon?.accepted === false && /do not combine/.test(withCode.data.coupon.reason ?? '') && withCode.data.totals.discount === 149.9, withCode.data?.coupon);
  await offerService.setStatus(clientId, auto.id, 'PAUSED');
  const codeOnly = await pc([{ code: B, quantity: 1 }], { couponCode: CODE.toLowerCase() });
  check('the same code (typed in small letters) on its own: accepted, Rs 100 off, line 1,399', codeOnly.data?.coupon?.accepted === true && codeOnly.data.lines[0].lineTotal === 1399 && codeOnly.data.totals.payable === 1399, codeOnly.data?.coupon ?? codeOnly);
  check('...without the code the code-offer does not apply', (await pc([{ code: B, quantity: 1 }])).data?.totals?.payable === 1499);
  await offerService.setStatus(clientId, auto.id, 'ACTIVE');  const wrong = await pc([{ code: B, quantity: 1 }], { couponCode: 'NOSUCHCODE' });
  check('an unknown code: not accepted, with a reason, the bill still priced', wrong.status === 200 && wrong.data?.coupon?.accepted === false && !!wrong.data.coupon.reason && wrong.data.lines.length === 1, wrong.data ?? wrong);
  const guest = await pc([{ code: B, quantity: 1 }], { customerPhone: '+919999999999' });
  check('a phone that is not a customer: priced as a guest', guest.status === 200 && guest.data?.customer?.found === false, guest.data);

  console.log('\nA STORE\'S OWN PRICE');
  const store = await prisma.stockLocation.findFirst({ where: { clientId, active: true }, orderBy: { createdAt: 'asc' } });
  const vS = await prisma.productVariant.findFirst({ where: { clientId, boutiqueRef: SILK } });
  await prisma.variantLocationProfile.create({ data: { variantId: vS!.id, locationId: store!.id, priceOverride: 5.2 } as any });
  await offerService.setStatus(clientId, auto.id, 'PAUSED');
  const st = await pc([{ code: SILK, quantity: 1 }], { storeId: store!.id });
  check('silk at a store that sells it at Rs 520 a metre: 520', st.data?.lines?.[0]?.unitPrice === 520 && st.data.lines[0].lineTotal === 520, st.data);

  console.log('\nA SHOP THAT CHARGES NO GST');
  await prisma.clientSettings.update({ where: { clientId }, data: { gstRegistration: 'UNREGISTERED', gstNumber: null } as any });
  const un = await pc([{ code: B, quantity: 1 }, { code: `NOH-${S}-1`, quantity: 1 }]);
  check('no GST lines, no problems for the missing HSN, can bill; payable is the price', un.status === 200 && un.data?.chargesGst === false && un.data.totals.gst === 0 && un.data.lines.every((l: any) => l.gstPercent === null) && un.data.problems.length === 0 && un.data.canBill === true && un.data.totals.payable === 1999 && un.data.document !== 'TAX_INVOICE', un.data);

  console.log('\nNOTHING SAVED, ANYONE MAY ASK');
  check('no quote rows were written by any price check', (await prisma.pricingQuote.count({ where: { clientId } })) === quotesBefore);
  check('a person with no permissions may still price a bill', (await pc([{ code: B, quantity: 1 }], {}, { can: [] })).status === 200);
}

async function cleanup() {
  const ids = (await prisma.boutiqueLink.findMany({ where: { tenant: { startsWith: 'pctest-' } }, select: { clientId: true } })).map(l => l.clientId);
  if (!ids.length) return;
  const tables = await prisma.$queryRaw<{ table_name: string }[]>`SELECT DISTINCT table_name FROM information_schema.columns WHERE table_schema = 'public' AND column_name = 'client_id'`;
  await prisma.$executeRawUnsafe(`DELETE FROM variant_location_profiles WHERE variant_id IN (SELECT id FROM inventory_product_variants WHERE client_id = ANY($1))`, ids).catch(() => undefined);
  await prisma.$executeRawUnsafe(`DELETE FROM inventory_product_images WHERE product_id IN (SELECT id FROM inventory_products WHERE client_id = ANY($1))`, ids).catch(() => undefined);
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
