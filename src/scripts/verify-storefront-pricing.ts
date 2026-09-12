/**
 * The two doors a merchant's own website knocks on.
 *
 * Everything else in the pricing suite calls the services directly. This calls the HTTP API the
 * way an integrator actually would -- with a storefront credential, in product codes rather than
 * our internal ids, over the wire -- because that is where the mistakes live that a service test
 * cannot see: a route that is not mounted, a credential that authenticates but is not scoped, an
 * error that hands a website our file paths.
 *
 * The property being defended is the reason the Offers project exists: the website never
 * implements a discount rule. It cannot. It is told what a basket COMES TO, not how. A rule
 * implemented twice is a rule implemented differently, and the difference is a customer charged
 * a price the shop never agreed to.
 *
 * Needs the API running.  Throwaway tenant, deleted at the end.
 *
 *   npx tsx src/scripts/verify-storefront-pricing.ts
 */
import { prisma } from '../lib/prisma';
import { offerService } from '../services/offers';
import { generateCredential } from '../utils/storefrontCredential';

const BASE = process.env.VERIFY_API_URL || 'http://localhost:4006/api/v1';

let passed = 0, failed = 0;
const failures: string[] = [];
const check = (name: string, ok: boolean, detail?: string) => {
  if (ok) { passed++; console.log(`  [PASS] ${name}`); }
  else { failed++; failures.push(name); console.log(`  [FAIL] ${name}${detail ? `  -> ${detail}` : ''}`); }
};

const CLIENT = `sf-price-${Date.now()}`;
const USER = 'shopkeeper';
const yesterday = new Date(Date.now() - 86400000);

let secret = '';
let shopLocationId = '';

async function call(path: string, init: RequestInit = {}, key = secret) {
  const res = await fetch(`${BASE}/storefront/v1${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(key ? { 'X-Storefront-Key': key } : {}),
      ...(init.headers ?? {})
    }
  });
  let body: any = null;
  try { body = await res.json(); } catch { body = null; }
  return { status: res.status, body };
}

const post = (path: string, payload: any, key = secret) =>
  call(path, { method: 'POST', body: JSON.stringify(payload) }, key);

/**
 * Anything that names a file, a table, a driver or a machine.
 *
 * The same denylist idea as lib/safeMessage, applied from the outside: a website's developer
 * pasting an error into a support ticket must not be pasting our infrastructure with it.
 */
function leaksInternals(text: string): boolean {
  return /(\\|\/)src(\\|\/)|node_modules|prisma\.|PrismaClient|ECONNREFUSED|127\.0\.0\.1|postgres(ql)?:\/\/|at [A-Za-z]+ \(/i.test(text);
}

async function main() {
  console.log(`SETUP: a shop, a website connected to it, and one live offer  (${BASE})`);

  const shop = await prisma.stockLocation.create({
    data: { clientId: CLIENT, name: 'Chirala Showroom', code: 'CHIRALA', type: 'STORE', active: true }
  });
  shopLocationId = shop.id;
  const godown = await prisma.stockLocation.create({
    data: { clientId: CLIENT, name: 'Godown', code: 'GODOWN', type: 'WAREHOUSE', active: true }
  });

  const product = await prisma.product.create({
    data: {
      clientId: CLIENT, productCode: 'PRD-SF-1', title: 'Kanchipuram Silk Saree',
      slug: `sf-${Date.now()}`, category: 'WOMEN', basePrice: 12000, status: 'ACTIVE',
      productType: 'READY_TO_WEAR'
    }
  });
  const saree = await prisma.productVariant.create({
    data: {
      clientId: CLIENT, productId: product.id, sku: 'SKU-SF-SAREE', variantCode: 'VAR-SF-SAREE',
      size: 'Free Size', colorName: 'Maroon', sellingPrice: 12000, averageCost: 6000
    }
  });

  const credential = generateCredential();
  const connection = await prisma.storefrontConnection.create({
    data: {
      clientId: CLIENT, name: 'Their own website', status: 'ACTIVE',
      baseUrl: 'https://example.invalid',
      credentialHash: credential.hash, credentialPrefix: credential.prefix,
      locationIds: [shop.id]
    }
  });
  secret = credential.plaintext;

  const offer: any = await offerService.create(CLIENT, {
    name: 'Deepavali Sale', trigger: 'AUTOMATIC', level: 'LINE', valueType: 'PERCENTAGE',
    value: 20, scope: 'ALL', startsAt: yesterday, endsAt: null
  } as any, USER);
  await offerService.setStatus(CLIENT, offer.id, 'ACTIVE', USER);

  const secretCode: any = await offerService.create(CLIENT, {
    name: 'Staff code', trigger: 'CODE', couponCode: 'STAFF40', level: 'LINE',
    valueType: 'PERCENTAGE', value: 40, scope: 'ALL', startsAt: yesterday, stackable: true
  } as any, USER);
  await offerService.setStatus(CLIENT, secretCode.id, 'ACTIVE', USER);

  // ── A. THE DOOR IS LOCKED ──────────────────────────────────────────────
  console.log('\nA. NOTHING IS READABLE WITHOUT A CREDENTIAL');

  const noKey = await call('/offers', {}, '');
  check('no credential is refused', noKey.status === 401, String(noKey.status));

  const wrongKey = await call('/offers', {}, 'sk_aaaaaaaaaaaa_nonsense');
  check('a made-up credential is refused', wrongKey.status === 401, String(wrongKey.status));
  check('  ...without saying which half was wrong',
    !/prefix|hash|not found/i.test(String(wrongKey.body?.message)), String(wrongKey.body?.message));

  const quoteNoKey = await post('/pricing/quote', { lines: [] }, '');
  check('pricing is behind the same lock', quoteNoKey.status === 401, String(quoteNoKey.status));

  // ── B. BADGES ──────────────────────────────────────────────────────────
  console.log('\nB. WHAT TO PUT A BADGE ON');

  const badges = await call('/offers');
  check('the website can list what is running', badges.status === 200, String(badges.status));
  check('  ...finding the live one', badges.body?.data?.offers?.length === 1,
    JSON.stringify(badges.body?.data?.offers?.map((o: any) => o.name)));
  check('  ...named as a shopper would see it',
    badges.body?.data?.offers?.[0]?.name === 'Deepavali Sale');
  check('  ...with the rule, so a badge can say "20% off"',
    badges.body?.data?.offers?.[0]?.valueType === 'PERCENTAGE' &&
    badges.body?.data?.offers?.[0]?.value === 20);

  /*
   * The one that matters. A code is worth something because not everybody has it; an endpoint
   * that hands out every live code turns a targeted campaign into a public sale.
   */
  const serialised = JSON.stringify(badges.body);
  check('a coupon offer is NOT advertised', !serialised.includes('Staff code'), serialised);
  check('  ...and its code appears nowhere', !serialised.includes('STAFF40'));

  check('nothing internal is exposed with it',
    !/priority|stackable|usageCount|clientId|"id"/i.test(serialised), serialised.slice(0, 300));

  // ── C. PRICING A BASKET ────────────────────────────────────────────────
  console.log('\nC. WHAT DOES THIS BASKET COST');

  const priced = await post('/pricing/quote', {
    lines: [{ variantCode: 'VAR-SF-SAREE', quantity: 2 }]
  });
  check('a basket can be priced', priced.status === 200, JSON.stringify(priced.body));
  check('  ...at the discounted total', priced.body?.data?.total === 19200, String(priced.body?.data?.total));
  check('  ...saying what came off', priced.body?.data?.discountTotal === 4800);
  check('  ...naming the offer the customer will see',
    priced.body?.data?.discounts?.[0]?.title === 'Deepavali Sale');
  check('  ...and returning a quote the order can be held to', !!priced.body?.data?.quoteId);
  check('  ...that expires', !!priced.body?.data?.expiresAt);
  check('  ...in this shop\'s currency', priced.body?.data?.currency === 'INR');

  const withCode = await post('/pricing/quote', {
    lines: [{ variantCode: 'VAR-SF-SAREE', quantity: 1 }],
    couponCodes: ['staff40']
  });
  /*
   * 12,000 less 20% is 9,600; the stackable staff code then takes 40% of what is LEFT, not of
   * the list price. 5,760, not 4,800. Stacking on the running net is deliberate -- discounts
   * that each bite the original price can add up past 100% and hand money to the customer.
   */
  check('a code the shopper actually has still works', withCode.body?.data?.total === 5760,
    String(withCode.body?.data?.total));
  check('  ...matched however it was typed', withCode.body?.data?.discounts?.length === 2);

  const badCode = await post('/pricing/quote', {
    lines: [{ variantCode: 'VAR-SF-SAREE', quantity: 1 }],
    couponCodes: ['NOTACODE']
  });
  check('a code that is not a code is reported, not ignored',
    badCode.body?.data?.rejected?.[0]?.code === 'NOTACODE',
    JSON.stringify(badCode.body?.data?.rejected));
  check('  ...with a reason a shopper can act on',
    /no offer with that code/i.test(String(badCode.body?.data?.rejected?.[0]?.reason)));

  // ── D. BASKETS THAT ARE WRONG ──────────────────────────────────────────
  console.log('\nD. A BASKET THE WEBSITE GOT WRONG');

  const empty = await post('/pricing/quote', { lines: [] });
  check('an empty basket is refused', empty.status === 400, String(empty.status));
  check('  ...in plain words', /nothing in this basket/i.test(String(empty.body?.message)),
    String(empty.body?.message));

  const unknown = await post('/pricing/quote', { lines: [{ variantCode: 'NOPE-1', quantity: 1 }] });
  check('an item we do not have is a 404', unknown.status === 404, String(unknown.status));
  check('  ...named by the code the website knows',
    String(unknown.body?.message).includes('NOPE-1'), String(unknown.body?.message));

  const noCode = await post('/pricing/quote', { lines: [{ quantity: 1 }] });
  check('a line with no code at all is refused', noCode.status === 400, String(noCode.status));

  const zero = await post('/pricing/quote', { lines: [{ variantCode: 'VAR-SF-SAREE', quantity: 0 }] });
  check('a quantity of nothing is refused', zero.status === 400, String(zero.status));

  const fraction = await post('/pricing/quote', { lines: [{ variantCode: 'VAR-SF-SAREE', quantity: 1.5 }] });
  check('half a saree is refused', fraction.status === 400, String(fraction.status));

  const twice = await post('/pricing/quote', {
    lines: [{ variantCode: 'VAR-SF-SAREE', quantity: 1 }, { variantCode: 'VAR-SF-SAREE', quantity: 1 }]
  });
  check('the same item sent twice is refused rather than merged', twice.status === 400,
    String(twice.status));
  check('  ...telling the website what to send instead',
    /once, with its full quantity/i.test(String(twice.body?.message)), String(twice.body?.message));

  const everything = [empty, unknown, noCode, zero, fraction, twice]
    .map(r => JSON.stringify(r.body)).join(' ');
  check('no refusal leaks anything internal', !leaksInternals(everything), everything.slice(0, 300));

  // ── E. SCOPE ───────────────────────────────────────────────────────────
  console.log('\nE. A WEBSITE SELLS FROM WHERE IT WAS TOLD TO');

  const wrongLocation = await post('/pricing/quote', {
    locationCode: 'GODOWN',
    lines: [{ variantCode: 'VAR-SF-SAREE', quantity: 1 }]
  });
  check('it cannot sell from a location it was not given', wrongLocation.status === 400,
    String(wrongLocation.status));
  check('  ...and is told where it CAN sell from',
    String(wrongLocation.body?.message).includes('CHIRALA'), String(wrongLocation.body?.message));

  const rightLocation = await post('/pricing/quote', {
    locationCode: 'chirala',
    lines: [{ variantCode: 'VAR-SF-SAREE', quantity: 1 }]
  });
  check('its own location works, however it is capitalised', rightLocation.status === 200);

  // Two locations in scope and no code: it has to ask, because pricing needs one answer.
  await prisma.storefrontConnection.update({
    where: { id: connection.id }, data: { locationIds: [shop.id, godown.id] }
  });
  const ambiguous = await post('/pricing/quote', { lines: [{ variantCode: 'VAR-SF-SAREE', quantity: 1 }] });
  check('with two locations and no choice made, it asks', ambiguous.status === 400,
    String(ambiguous.status));
  check('  ...listing both by name',
    String(ambiguous.body?.message).includes('CHIRALA') &&
    String(ambiguous.body?.message).includes('GODOWN'), String(ambiguous.body?.message));
  await prisma.storefrontConnection.update({
    where: { id: connection.id }, data: { locationIds: [shop.id] }
  });

  /*
   * Another shop's item, through this shop's credential.
   *
   * The whole tenancy boundary in one request. It has to be a 404 rather than a 403: whether
   * another shop sells this code is not this website's business either way.
   */
  const otherClient = `sf-other-${Date.now()}`;
  const otherProduct = await prisma.product.create({
    data: {
      clientId: otherClient, productCode: 'PRD-OTHER', title: 'Someone else\'s saree',
      slug: `other-${Date.now()}`, category: 'WOMEN', basePrice: 900, status: 'ACTIVE',
      productType: 'READY_TO_WEAR'
    }
  });
  const otherVariant = await prisma.productVariant.create({
    data: {
      clientId: otherClient, productId: otherProduct.id, sku: 'SKU-OTHER',
      variantCode: 'VAR-SF-SAREE-OTHER', size: 'Free', colorName: 'Blue',
      sellingPrice: 900, averageCost: 100
    }
  });
  const crossTenant = await post('/pricing/quote', {
    lines: [{ variantCode: 'VAR-SF-SAREE-OTHER', quantity: 1 }]
  });
  check('another shop\'s item cannot be priced through this credential',
    crossTenant.status === 404, String(crossTenant.status));

  // ── F. A PAUSED CONNECTION ─────────────────────────────────────────────
  console.log('\nF. A CONNECTION THE SHOP OWNER TURNED OFF');

  await prisma.storefrontConnection.update({
    where: { id: connection.id }, data: { status: 'DISABLED' }
  });
  const disabled = await post('/pricing/quote', { lines: [{ variantCode: 'VAR-SF-SAREE', quantity: 1 }] });
  check('a paused website cannot price anything', disabled.status === 403, String(disabled.status));
  check('  ...and is told to ask the shop owner',
    /shop owner/i.test(String(disabled.body?.message)), String(disabled.body?.message));

  await prisma.storefrontConnection.update({
    where: { id: connection.id }, data: { status: 'REVOKED', credentialHash: 'revoked' }
  });
  const revoked = await post('/pricing/quote', { lines: [{ variantCode: 'VAR-SF-SAREE', quantity: 1 }] });
  check('a revoked credential is dead immediately', revoked.status === 401, String(revoked.status));

  // ── G. WHAT WAS WRITTEN ────────────────────────────────────────────────
  console.log('\nG. EVERY QUOTE IS KEPT, AND KEPT STRAIGHT');

  const quotes = await prisma.pricingQuote.findMany({ where: { clientId: CLIENT } });
  check('the quotes were recorded', quotes.length >= 4, String(quotes.length));
  check('  ...against the website\'s channel, not the till\'s',
    quotes.every(q => q.channel === 'ONLINE'), quotes.map(q => q.channel).join(','));
  check('  ...at the location it sells from',
    quotes.every(q => q.locationId === shopLocationId));
  check('  ...each one adding up',
    quotes.every(q => Number(q.subtotal) - Number(q.discount) === Number(q.total)));
  check('  ...and none of them spent by anybody',
    quotes.every(q => q.consumedAt === null));

  await prisma.productVariant.deleteMany({ where: { clientId: otherClient } });
  await prisma.product.deleteMany({ where: { clientId: otherClient } });
  void otherVariant;
  void saree;
}

main()
  .catch(e => { console.error('\nSUITE CRASHED:', e); failed++; failures.push('suite crashed'); })
  .finally(async () => {
    await prisma.pricingQuote.deleteMany({ where: { clientId: CLIENT } });
    await prisma.storefrontConnection.deleteMany({ where: { clientId: CLIENT } });
    await prisma.offerVersion.deleteMany({ where: { offer: { clientId: CLIENT } } });
    await prisma.offerTarget.deleteMany({ where: { offer: { clientId: CLIENT } } });
    await prisma.offer.deleteMany({ where: { clientId: CLIENT } });
    await prisma.productVariant.deleteMany({ where: { clientId: CLIENT } });
    await prisma.product.deleteMany({ where: { clientId: CLIENT } });
    await prisma.stockLocation.deleteMany({ where: { clientId: CLIENT } });
    await prisma.clientSequence.deleteMany({ where: { clientId: CLIENT } });
    await prisma.$disconnect();

    console.log(`\nRESULT: ${passed} passed | ${failed} failed`);
    if (failures.length) console.log('Failures:\n  - ' + failures.join('\n  - '));
    process.exit(failed ? 1 : 0);
  });
