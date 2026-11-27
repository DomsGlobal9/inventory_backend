/**
 * Offers and shop settings through the boutique API (20 Nov 2026, PLAN-boutique-backend.md part 3), against the REAL
 * local server and database.
 *
 * Offers: made, changed, switched on and off by the boutique with items named by ITS codes; checked through the real
 * price check (the till's engine) -- an item offer, a design offer, a department offer, an exclusion, a code; another
 * shop's items and offers never reachable; replay safe; history says "<person> (Boutique)"; refusals in words.
 * Settings: read by anyone, changed only with settings:write; shop details and GST, what the shop sells and the
 * smallest cut, points rules, the till discount limit (a body without it never clears it), return rules; payment keys
 * refused when malformed and never shown (no real Razorpay call is made here).
 *
 * Throwaway accounts only (ostest-*); everything it makes is removed. Local only.
 *   DATABASE_URL=<local> DIRECT_URL=<local> VERIFY_API_URL=http://localhost:4036/api/v1 \
 *   BOUTIQUE_KEY_DIR=<dir with private.pem> npx tsx src/scripts/verify-boutique-offers-settings.ts
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
const TEN = `ostest-${S}`, TEN2 = `ostest-${S}-b`;
let bad = 0, good = 0;
const check = (name: string, ok: boolean, detail: unknown = '') => {
  ok ? good++ : bad++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : ` :: ${typeof detail === 'string' ? detail : JSON.stringify(detail)?.slice(0, 600)}`}`);
};
const OWNER = ['products:write', 'stock:write', 'offers:write', 'settings:write'];
const STAFF = ['products:write', 'stock:write'];
const pass = (tenant: string, can: string[]) => jwt.sign({ sub: 'crm-b', scope: ['modules:boutique'], tenant, onBehalfOf: { userId: 'u1', name: 'Lakshmi', can } },
  privateKey, { algorithm: 'RS256', audience: 'inventory', issuer: 'scaleezy-boutique-test', keyid: 'btq-1', expiresIn: '5m' });
let n = 0;
async function call(method: string, p: string, body?: unknown, o: { tenant?: string; can?: string[]; key?: string } = {}) {
  const r = await axios.request({ method, url: `${BASE}/internal/boutique${p}`, data: body, validateStatus: () => true, timeout: 90_000,
    headers: { Authorization: `Bearer ${pass(o.tenant ?? TEN, o.can ?? OWNER)}`, ...(method !== 'GET' ? { 'Idempotency-Key': o.key ?? `os-${S}-${++n}` } : {}) } });
  return { status: r.status, data: r.data?.data, message: r.data?.message as string | undefined, raw: r.data, replay: r.headers['idempotent-replay'] };
}
const payable = async (code: string, more: Record<string, unknown> = {}) => (await call('POST', '/price-check', { lines: [{ code, quantity: 1 }], ...more })).data?.totals?.payable;
const since = new Date(Date.now() - 3600_000).toISOString();

async function main() {
  const link = await call('POST', '/link', { shopName: 'Offers Test Boutique' });
  check('a throwaway boutique is linked', link.status === 201, link);
  const clientId = link.data.clientId as string;
  const B = `${S}-BL`, K = `${S}-KR`, SA = `${S}-SA`;
  await call('PUT', `/items/${B}`, { name: 'Ready blouse', category: 'FINISHED', unit: 'PIECE', sellingPrice: 1000, gstPercent: 5, hsnCode: '6206', sellInShop: true });
  await call('PUT', `/items/${K}`, { name: 'Kurta', category: 'FINISHED', unit: 'PIECE', sellingPrice: 2000, gstPercent: 5, hsnCode: '6211', sellInShop: true });
  await call('PUT', `/items/${SA}`, { name: 'Saree', category: 'FINISHED', unit: 'PIECE', sellingPrice: 5000, gstPercent: 5, hsnCode: '5007', sellInShop: true });
  const link2 = await call('POST', '/link', { shopName: 'Other' }, { tenant: TEN2 });
  const O2 = `${S}-O2`;
  await call('PUT', `/items/${O2}`, { name: 'Other blouse', category: 'FINISHED', unit: 'PIECE', sellingPrice: 900, sellInShop: true }, { tenant: TEN2 });

  console.log('\nOFFERS: WHO MAY');
  const noPerm = await call('POST', '/offers', { name: 'x', valueType: 'PERCENTAGE', value: 10, scope: 'ALL', startsAt: since }, { can: STAFF });
  check('without offers:write: 403, nothing made', noPerm.status === 403 && !(await prisma.offer.count({ where: { clientId } })), noPerm);
  check('anyone may list offers', (await call('GET', '/offers', undefined, { can: [] })).status === 200);

  console.log('\nAN ITEM OFFER, BY THE BOUTIQUE\'S CODE');
  const mk = await call('POST', '/offers', { name: `Blouse 10% ${S}`, valueType: 'PERCENTAGE', value: 10, scope: 'VARIANT', targets: [{ scope: 'VARIANT', code: B }], startsAt: since }, { key: `os-${S}-same` });
  const off = mk.data;
  check('made: 201, a draft, the target shown by its code and name', mk.status === 201 && off?.status === 'DRAFT' && off?.targets?.[0]?.code === B && off?.targets?.[0]?.name === 'Ready blouse' && /^OFR-/.test(off?.offerCode ?? ''), mk);
  const again = await call('POST', '/offers', { name: `Blouse 10% ${S}`, valueType: 'PERCENTAGE', value: 10, scope: 'VARIANT', targets: [{ scope: 'VARIANT', code: B }], startsAt: since }, { key: `os-${S}-same` });
  check('the same request again: the same answer, still one offer', again.status === 201 && again.replay === 'true' && again.data?.id === off?.id && (await prisma.offer.count({ where: { clientId } })) === 1, again.status);
  check('a draft takes nothing off', (await payable(B)) === 1000);
  const on = await call('POST', `/offers/${off.id}/status`, { status: 'ACTIVE' });
  check('switched on', on.status === 200 && on.data?.status === 'ACTIVE', on);
  check('...the blouse is 900 at the till price check', (await payable(B)) === 900);
  check('...the kurta is untouched (2,000)', (await payable(K)) === 2000);
  const ch = await call('PUT', `/offers/${off.id}`, { value: 20, changeNote: 'Festival week' });
  check('changed to 20%: the blouse is 800', ch.status === 200 && ch.data?.value === 20 && (await payable(B)) === 800, ch);
  const versions = await prisma.offerVersion.findMany({ where: { offerId: off.id }, select: { changedBy: true } });
  check('its history names the person: "Lakshmi (Boutique)"', versions.length >= 2 && versions.every(v => v.changedBy === 'Lakshmi (Boutique)'), versions);
  const { offerInsightService } = await import('../services/offers');
  const hist = await (offerInsightService as any).history?.(clientId, off.id).catch(() => null);
  if (hist) check('...and the Offers screen shows it that way, not "A former user"', JSON.stringify(hist).includes('Lakshmi (Boutique)') && !JSON.stringify(hist).includes('A former user'), hist);
  const paused = await call('POST', `/offers/${off.id}/status`, { status: 'PAUSED' });
  check('paused: back to 1,000', paused.data?.status === 'PAUSED' && (await payable(B)) === 1000);
  check('a status that is not one: 400', (await call('POST', `/offers/${off.id}/status`, { status: 'GONE' })).status === 400);

  console.log('\nDESIGNS, DEPARTMENTS, EXCLUSIONS, CODES');
  const prodCode = (await prisma.productVariant.findFirst({ where: { clientId, boutiqueRef: K }, select: { product: { select: { productCode: true } } } }))!.product.productCode;
  const design = await call('POST', '/offers', { name: `Kurta design ${S}`, valueType: 'FIXED_AMOUNT', value: 300, scope: 'PRODUCT', targets: [{ scope: 'PRODUCT', code: prodCode }], startsAt: since });
  await call('POST', `/offers/${design.data?.id}/status`, { status: 'ACTIVE' });
  check('a design offer by its product code: kurta 1,700, shown with the product code', design.status === 201 && design.data?.targets?.[0]?.code === prodCode && (await payable(K)) === 1700, design);
  await call('POST', `/offers/${design.data?.id}/status`, { status: 'PAUSED' });
  const dept = await call('POST', '/offers', { name: `Women 5% ${S}`, valueType: 'PERCENTAGE', value: 5, scope: 'CATEGORY', targets: [{ scope: 'CATEGORY', name: 'women' }], exclusions: [{ scope: 'VARIANT', code: SA }], startsAt: since });
  await call('POST', `/offers/${dept.data?.id}/status`, { status: 'ACTIVE' });
  check('a department offer (women, any case) excluding the saree: blouse 950, saree 5,000', dept.status === 201 && (await payable(B)) === 950 && (await payable(SA)) === 5000 && dept.data?.exclusions?.[0]?.code === SA, dept);
  await call('POST', `/offers/${dept.data?.id}/status`, { status: 'PAUSED' });
  const CODE = `OS${S}`.toUpperCase().slice(0, 12);
  const coded = await call('POST', '/offers', { name: `Code ${S}`, trigger: 'CODE', couponCode: CODE, valueType: 'FIXED_AMOUNT', value: 100, scope: 'ALL', startsAt: since });
  await call('POST', `/offers/${coded.data?.id}/status`, { status: 'ACTIVE' });
  check('a code offer: nothing without the code, 100 off with it', coded.status === 201 && (await payable(SA)) === 5000 && (await payable(SA, { couponCode: CODE })) === 4900, coded);

  console.log('\nOFFERS: REFUSED IN WORDS, AND KEPT APART');
  const unknown = await call('POST', '/offers', { name: 'u', valueType: 'PERCENTAGE', value: 10, scope: 'VARIANT', targets: [{ scope: 'VARIANT', code: 'NOPE-9' }], startsAt: since });
  check('a target code not in the shop: 404 naming it', unknown.status === 404 && /NOPE-9/.test(unknown.message ?? ''), unknown);
  const theirs = await call('POST', '/offers', { name: 't', valueType: 'PERCENTAGE', value: 10, scope: 'VARIANT', targets: [{ scope: 'VARIANT', code: O2 }], startsAt: since });
  check('another shop\'s item as a target: 404', theirs.status === 404, theirs);
  const silly = await call('POST', '/offers', { name: 's', valueType: 'PERCENTAGE', value: 150, scope: 'ALL', startsAt: since });
  check('150% off: 400 with a sentence', silly.status === 400 && (silly.message ?? '').length > 10, silly);
  check('a bad scope: 400', (await call('POST', '/offers', { name: 's', valueType: 'PERCENTAGE', value: 10, scope: 'VARIANT', targets: [{ scope: 'SHELF', code: B }], startsAt: since })).status === 400);
  const peek = await call('GET', `/offers/${off.id}`, undefined, { tenant: TEN2 });
  const poke = await call('PUT', `/offers/${off.id}`, { value: 99 }, { tenant: TEN2 });
  const flip = await call('POST', `/offers/${off.id}/status`, { status: 'ACTIVE' }, { tenant: TEN2 });
  check('another shop cannot read, change or switch on this shop\'s offer (404s)', link2.status === 201 && peek.status === 404 && poke.status === 404 && flip.status === 404 && (await call('GET', `/offers/${off.id}`)).data?.value === 20, [peek.status, poke.status, flip.status]);
  check('...nor see it in its list', !((await call('GET', '/offers', undefined, { tenant: TEN2 })).data ?? []).some((o: any) => o.id === off.id));

  console.log('\nSETTINGS: WHO MAY');
  const asStaff = await call('GET', '/settings', undefined, { can: STAFF });
  check('anyone may read the settings', asStaff.status === 200 && !!asStaff.data?.shop && !!asStaff.data?.points, asStaff);
  check('...but staff see payments only as connected/ready (no webhook address)', asStaff.data?.payments && !('webhookUrl' in asStaff.data.payments), asStaff.data?.payments);
  for (const [path, body] of [['/settings/shop', { businessName: 'X' }], ['/settings/what-you-sell', { sells: 'BOTH' }], ['/settings/points', { enabled: true }], ['/settings/offers', { manualDiscountMaxPercent: 10 }], ['/settings/returns', { returnWindowDays: 7 }], ['/settings/payments', { keyId: 'rzp_test_x', keySecret: 'y' }]] as const) {
    const r = await call('PUT', path, body, { can: STAFF });
    check(`${path} without settings:write: 403`, r.status === 403, r);
  }

  console.log('\nSETTINGS: SHOP DETAILS AND GST');
  const shop = await call('PUT', '/settings/shop', { businessName: 'Lakshmi Boutique', businessAddress: '12 Road No. 3, Banjara Hills, Hyderabad 500034', businessPhone: '9000000001', gstNumber: '36AABCU9603R1ZX', gstRegistration: 'REGULAR' });
  const st = await prisma.clientSettings.findUnique({ where: { clientId }, select: { businessName: true, businessAddress: true, gstNumber: true, gstRegistration: true, gstStateCode: true } });
  check('name, address and GSTIN saved; GST registered with state 36 from the GSTIN', shop.status === 200 && st?.businessName === 'Lakshmi Boutique' && /Banjara/.test(st?.businessAddress ?? '') && st?.gstNumber === '36AABCU9603R1ZX' && st?.gstStateCode === '36', [shop, st]);
  const typo = await call('PUT', '/settings/shop', { address: 'somewhere' });
  check('a field name that is not one (address): 400 naming the right ones, not silently dropped', typo.status === 400 && /businessAddress/.test(typo.message ?? ''), typo);
  const badGst = await call('PUT', '/settings/shop', { gstNumber: '36ABC' });
  check('a malformed GSTIN: 400 with a sentence, nothing changed', badGst.status === 400 && (badGst.message ?? '').length > 10 && (await prisma.clientSettings.findUnique({ where: { clientId } }))?.gstNumber === '36AABCU9603R1ZX', badGst);

  console.log('\nSETTINGS: WHAT THE SHOP SELLS');
  // What the shop sells is ScaleEzy's to set (27 Nov 2026); a boutique shop is "both" from the moment it is linked.
  const rm = await call('PUT', '/settings/what-you-sell', { sells: 'READY_MADE' });
  check('changing what the shop sells from the boutique app: 403, set by ScaleEzy, in words', rm.status === 403 && /set by ScaleEzy/.test(rm.message ?? ''), rm);
  const both = await call('PUT', '/settings/what-you-sell', { sells: 'BOTH', fabricMinCut: 50 });
  check('the same "both" again with the smallest cut 50 cm: saved (harmless)', both.status === 200 && both.data?.sells === 'BOTH' && both.data?.fabricMinCut === 50, both);
  const cut = await call('PUT', '/settings/what-you-sell', { fabricMinCut: 25 });
  check('only the smallest cut (25 cm): saved too, not silently ignored', cut.status === 200 && cut.data?.fabricMinCut === 25, cut);
  check('an empty body: 400', (await call('PUT', '/settings/what-you-sell', {})).status === 400);

  console.log('\nSETTINGS: POINTS, TILL LIMIT, RETURNS');
  const pts = await call('PUT', '/settings/points', { enabled: true, pointsPer100: 2, pointValuePaise: 100, minRedeemPoints: 50, maxRedeemPercent: 30, expiryMonths: 12 });
  check('points on, 2 per Rs 100: saved', pts.status === 200 && pts.data?.enabled === true && pts.data?.pointsPer100 === 2, pts);
  check('a negative rule: 400', (await call('PUT', '/settings/points', { pointsPer100: -1 })).status === 400);
  const lim = await call('PUT', '/settings/offers', { manualDiscountMaxPercent: 15 });
  check('till limit 15%: saved', lim.status === 200 && lim.data?.manualDiscountMaxPercent === 15, lim);
  const leftOut = await call('PUT', '/settings/offers', { somethingElse: 1 });
  check('a body without the limit: refused, the limit stays 15 (never cleared by accident)', leftOut.status === 400 && (await call('GET', '/settings')).data?.offers?.manualDiscountMaxPercent === 15, leftOut);
  check('a limit of 150%: 400', (await call('PUT', '/settings/offers', { manualDiscountMaxPercent: 150 })).status === 400);
  const ret = await call('PUT', '/settings/returns', { returnWindowDays: 7, counterReturnMax: 2000 });
  check('returns: 7 days, Rs 2,000 without the manager', ret.status === 200 && ret.data?.returnWindowDays === 7 && ret.data?.counterReturnMax === 2000, ret);
  check('a return window of -1 days: 400', (await call('PUT', '/settings/returns', { returnWindowDays: -1 })).status === 400);

  console.log('\nSETTINGS: PAYMENT KEYS (format only; no call to Razorpay)');
  const pk = await call('PUT', '/settings/payments', { keyId: 'not-a-key', keySecret: 'x' });
  check('a key id that is not Razorpay\'s: 400 saying where to find it', pk.status === 400 && /Razorpay Key ID/.test(pk.message ?? ''), pk);
  const ps = await call('PUT', '/settings/payments', { keyId: 'rzp_test_ABCDEFGHIJKLMN', keySecret: 'short' });
  check('a secret that is not one: 400', ps.status === 400 && /Key Secret/.test(ps.message ?? ''), ps);
  const all = await call('GET', '/settings');
  const text = JSON.stringify(all.raw);
  check('the settings never contain a key secret', all.status === 200 && !/keySecret|key_secret|secretEnc/i.test(text) && all.data?.payments?.connected === false, all.data?.payments);
}

async function cleanup() {
  const ids = (await prisma.boutiqueLink.findMany({ where: { tenant: { startsWith: 'ostest-' } }, select: { clientId: true } })).map(l => l.clientId);
  if (!ids.length) return;
  await prisma.$executeRawUnsafe(`DELETE FROM offers WHERE client_id = ANY($1)`, ids).catch(e => console.error('offers', e.message));
  const tables = await prisma.$queryRaw<{ table_name: string }[]>`SELECT DISTINCT table_name FROM information_schema.columns WHERE table_schema = 'public' AND column_name = 'client_id'`;
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
