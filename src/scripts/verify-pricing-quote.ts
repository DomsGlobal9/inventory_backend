/**
 * The question a till asks, answered once and held to.
 *
 * verify-pricing-engine proves the arithmetic. This proves the world around it: that the right
 * offers are loaded, that a scheduled one is not, that channel and location scoping work, that
 * per-customer limits are counted from redemptions, and above all that a quoted price is FROZEN.
 *
 * Freezing is the property worth defending. Without it an offer ending at midnight prices a
 * basket at 23:59:58 and charges a different amount when the customer presses pay at 00:00:03.
 *
 * Throwaway tenant, deleted at the end.
 *
 *   npx tsx src/scripts/verify-pricing-quote.ts
 */
import { prisma } from '../lib/prisma';
import { pricingQuoteService, fingerprint } from '../services/pricing';
import { offerService } from '../services/offers';

let passed = 0, failed = 0;
const failures: string[] = [];
const check = (name: string, ok: boolean, detail?: string) => {
  if (ok) { passed++; console.log(`  [PASS] ${name}`); }
  else { failed++; failures.push(name); console.log(`  [FAIL] ${name}${detail ? `  -> ${detail}` : ''}`); }
};

const CLIENT = `quote-${Date.now()}`;
const USER = 'quoter';
const num = (v: any) => Number(v);

let locationId = '';
let otherLocationId = '';
let customerId = '';
const V: Record<string, string> = {};

const yesterday = new Date(Date.now() - 86400000);

/** A live offer, created and started in one go. */
async function liveOffer(over: any = {}) {
  const offer: any = await offerService.create(CLIENT, {
    name: 'Offer', trigger: 'AUTOMATIC', level: 'LINE', valueType: 'PERCENTAGE',
    value: 10, scope: 'ALL', startsAt: yesterday, endsAt: null, ...over
  } as any, USER);
  await offerService.setStatus(CLIENT, offer.id, 'ACTIVE', USER);
  return offer;
}

const quote = (over: any = {}) => pricingQuoteService.quote(CLIENT, {
  locationId, channel: 'POS', lines: [{ variantId: V.saree, quantity: 1 }], ...over
});

async function refuses(name: string, fragment: string, fn: () => Promise<any>) {
  try { await fn(); check(name, false, 'it was accepted'); }
  catch (e: any) {
    const msg = String(e?.message ?? e);
    check(name, msg.toLowerCase().includes(fragment.toLowerCase()), `"${msg}"`);
  }
}

async function main() {
  // ── SETUP ──────────────────────────────────────────────────────────────
  const loc = await prisma.stockLocation.create({
    data: { clientId: CLIENT, name: 'Main Store', code: 'MAIN', type: 'STORE', active: true }
  });
  locationId = loc.id;
  const loc2 = await prisma.stockLocation.create({
    data: { clientId: CLIENT, name: 'Online', code: 'ONLINE', type: 'ONLINE', active: true }
  });
  otherLocationId = loc2.id;

  const customer = await prisma.customer.create({
    data: { clientId: CLIENT, customerCode: 'CUS-1', name: 'Regular', status: 'ACTIVE' }
  });
  customerId = customer.id;

  const women = await prisma.product.create({
    data: {
      clientId: CLIENT, productCode: 'PRD-W', title: 'Kanchipuram Silk Saree',
      slug: `w-${Date.now()}`, category: 'WOMEN', basePrice: 12000, status: 'ACTIVE',
      productType: 'READY_TO_WEAR'
    }
  });
  const men = await prisma.product.create({
    data: {
      clientId: CLIENT, productCode: 'PRD-M', title: 'Dhoti',
      slug: `m-${Date.now()}`, category: 'MEN', basePrice: 1500, status: 'ACTIVE',
      productType: 'READY_TO_WEAR'
    }
  });

  for (const [key, product, price] of [['saree', women, 12000], ['blouse', women, 800], ['dhoti', men, 1500]] as const) {
    const v = await prisma.productVariant.create({
      data: {
        clientId: CLIENT, productId: product.id, sku: `SKU-${key}`, variantCode: `VAR-${key}`,
        size: 'Free Size', colorName: 'Red', sellingPrice: price, averageCost: 100
      }
    });
    V[key] = v.id;
  }

  // ── A. NO OFFERS ───────────────────────────────────────────────────────
  console.log('\nA. A BASKET WITH NOTHING RUNNING');

  const plain = await quote({ lines: [{ variantId: V.saree, quantity: 2 }] });
  check('it prices from the catalogue', plain.total === 24000, String(plain.total));
  check('  ...and says so in the shop\'s currency', plain.currency === 'INR', plain.currency);
  check('  ...and keeps a quote to be held to', !!plain.quoteId);
  check('  ...that expires within fifteen minutes',
    new Date(plain.expiresAt).getTime() - Date.now() <= 15 * 60 * 1000 + 2000);

  // ── B. A LIVE OFFER ────────────────────────────────────────────────────
  console.log('\nB. A LIVE OFFER IS FOUND AND APPLIED');

  const twenty = await liveOffer({ name: 'Deepavali Sale', value: 20 });
  const discounted = await quote();
  check('it applies', discounted.total === 9600, String(discounted.total));
  check('  ...naming the offer the customer will see', discounted.discounts[0]?.title === 'Deepavali Sale');
  check('  ...and the version, so the order can explain itself later',
    !!discounted.discounts[0]?.offerVersionId);
  check('the line carries the same story', discounted.lines[0].netUnitPrice === 9600);

  // ── C. WHAT IS NOT LOADED ──────────────────────────────────────────────
  console.log('\nC. OFFERS THAT MUST NOT REACH THE BASKET');

  const draftOffer: any = await offerService.create(CLIENT, {
    name: 'Still a draft', valueType: 'PERCENTAGE', value: 50, startsAt: yesterday
  } as any, USER);
  check('a DRAFT offer is not applied', (await quote()).total === 9600, 'a draft leaked in');

  const future = await liveOffer({ name: 'Next week', value: 50, startsAt: new Date(Date.now() + 7 * 86400000) });
  check('an offer that starts next week is not applied', (await quote()).total === 9600, 'a scheduled offer leaked in');

  await offerService.setStatus(CLIENT, twenty.id, 'PAUSED', USER);
  check('a paused offer stops applying', (await quote()).total === 12000, 'a paused offer still applied');
  await offerService.setStatus(CLIENT, twenty.id, 'ACTIVE', USER);

  // ── D. WHERE AND HOW IT SELLS ──────────────────────────────────────────
  console.log('\nD. CHANNEL AND LOCATION');

  const onlineOnly = await liveOffer({ name: 'Online only', value: 5, channels: ['ONLINE'], stackable: true });
  check('an ONLINE offer does not apply at the till', (await quote()).total === 9600, 'channel scoping leaked');
  const online = await quote({ channel: 'ONLINE' });
  check('  ...and does online', online.total < 9600, String(online.total));

  const otherShop = await liveOffer({ name: 'Other shop only', value: 5, locationIds: [otherLocationId], stackable: true });
  check('an offer scoped to another location does not apply here',
    (await quote()).total === 9600, 'location scoping leaked');
  const there = await quote({ locationId: otherLocationId });
  check('  ...and does there', there.total < 12000, String(there.total));
  void onlineOnly; void otherShop; void future; void draftOffer;

  // ── E. TARGETING ───────────────────────────────────────────────────────
  console.log('\nE. WHAT AN OFFER APPLIES TO');

  await offerService.setStatus(CLIENT, twenty.id, 'PAUSED', USER);
  await liveOffer({
    name: 'Women 10%', value: 10, scope: 'CATEGORY',
    targets: [{ scope: 'CATEGORY', refId: 'WOMEN' }]
  });

  const mixed = await quote({
    lines: [{ variantId: V.saree, quantity: 1 }, { variantId: V.dhoti, quantity: 1 }]
  });
  check('a category offer catches the saree', mixed.lines[0].discount === 1200, String(mixed.lines[0].discount));
  check('  ...and leaves the dhoti alone', mixed.lines[1].discount === 0, String(mixed.lines[1].discount));
  check('  ...so the basket is 12,000 + 1,500 less 1,200', mixed.total === 12300, String(mixed.total));

  // ── F. CODES ───────────────────────────────────────────────────────────
  console.log('\nF. CODES');

  await liveOffer({ name: 'Code sale', value: 15, trigger: 'CODE', couponCode: 'EXTRA15', stackable: true });

  const noCode = await quote();
  check('a code offer does nothing until it is given', noCode.total === 10800, String(noCode.total));

  const withCode = await quote({ couponCodes: ['extra15'] });
  check('the code applies it, in any case', withCode.total < noCode.total, String(withCode.total));

  const typo = await quote({ couponCodes: ['EXTRA51'] });
  check('a code that matches nothing says so, rather than failing silently',
    typo.rejected.some((r: any) => /no offer with that code/i.test(r.reason)), JSON.stringify(typo.rejected));

  // ── G. CONDITIONS, AND THE NEAR MISS ───────────────────────────────────
  console.log('\nG. CONDITIONS, AND SAYING WHY');

  await liveOffer({
    name: '500 off over 20,000', level: 'ORDER', valueType: 'FIXED_AMOUNT',
    value: 500, minSubtotal: 20000
  });

  const short = await quote({ lines: [{ variantId: V.saree, quantity: 1 }] });
  check('a basket under the threshold does not get it',
    !short.discounts.some((d: any) => d.title === '500 off over 20,000'));
  check('  ...and is told how far short it is',
    short.nearMisses.some((n: any) => /Spend .* more/.test(n.reason)), JSON.stringify(short.nearMisses));

  const enough = await quote({ lines: [{ variantId: V.saree, quantity: 3 }] });
  check('a basket over it does get it',
    enough.discounts.some((d: any) => d.title === '500 off over 20,000'), JSON.stringify(enough.discounts));

  // ── H. THE PRICE IS FROZEN ─────────────────────────────────────────────
  console.log('\nH. THE PRICE IS FROZEN');

  const held = await quote({ lines: [{ variantId: V.saree, quantity: 1 }] });
  const heldTotal = held.total;

  // The world changes underneath it: the offer that priced this basket is switched off.
  const women10 = await prisma.offer.findFirstOrThrow({ where: { clientId: CLIENT, name: 'Women 10%' } });
  await offerService.setStatus(CLIENT, women10.id, 'PAUSED', USER);

  const stored = await prisma.pricingQuote.findUniqueOrThrow({ where: { id: held.quoteId } });
  check('THE QUOTE STILL SAYS WHAT IT SAID', num(stored.total) === heldTotal,
    `${stored.total} vs ${heldTotal}`);
  const fresh = await quote({ lines: [{ variantId: V.saree, quantity: 1 }] });
  check('  ...while a NEW quote reflects the change', fresh.total !== heldTotal,
    `${fresh.total} vs ${heldTotal}`);

  // ── I. A QUOTE IS GOOD ONCE ────────────────────────────────────────────
  console.log('\nI. A QUOTE IS GOOD ONCE');

  const consumed = await pricingQuoteService.consume(CLIENT, held.quoteId, 'order-1');
  check('it can be used for an order', !!consumed);

  await refuses('and not for a second one', 'already been used',
    () => pricingQuoteService.consume(CLIENT, held.quoteId, 'order-2'));

  const racedQuote = await quote();
  const attempts = await Promise.allSettled(
    Array.from({ length: 5 }, (_, i) => pricingQuoteService.consume(CLIENT, racedQuote.quoteId, `race-${i}`))
  );
  const won = attempts.filter(a => a.status === 'fulfilled').length;
  check('five orders racing for one quote: exactly one wins', won === 1, `${won} won`);

  await refuses('a quote that never existed', 'no longer available',
    () => pricingQuoteService.consume(CLIENT, '00000000-0000-0000-0000-000000000000', 'x'));

  const stale = await quote();
  await prisma.pricingQuote.update({
    where: { id: stale.quoteId }, data: { expiresAt: new Date(Date.now() - 1000) }
  });
  await refuses('an expired quote is refused, in words', 'expired',
    () => pricingQuoteService.consume(CLIENT, stale.quoteId, 'y'));

  // ── J. THE BASKET MUST MATCH ───────────────────────────────────────────
  console.log('\nJ. THE BASKET MUST BE THE ONE THAT WAS QUOTED');

  const forBasket = await quote({ lines: [{ variantId: V.saree, quantity: 1 }] });
  const sameBasket = fingerprint({ locationId, channel: 'POS', lines: [{ variantId: V.saree, quantity: 1 }] });
  const biggerBasket = fingerprint({ locationId, channel: 'POS', lines: [{ variantId: V.saree, quantity: 9 }] });

  await refuses('a quote cannot be spent on a different basket', 'basket has changed',
    () => pricingQuoteService.consume(CLIENT, forBasket.quoteId, 'z', biggerBasket));
  check('  ...but the right basket is accepted',
    !!(await pricingQuoteService.consume(CLIENT, forBasket.quoteId, 'z2', sameBasket)));

  const reordered = fingerprint({
    locationId, channel: 'POS',
    lines: [{ variantId: V.blouse, quantity: 1 }, { variantId: V.saree, quantity: 2 }]
  });
  const asTyped = fingerprint({
    locationId, channel: 'POS',
    lines: [{ variantId: V.saree, quantity: 2 }, { variantId: V.blouse, quantity: 1 }]
  });
  check('the same basket in a different order is the same basket', reordered === asTyped);

  // ── K. WHAT IT REFUSES ─────────────────────────────────────────────────
  console.log('\nK. WHAT IT REFUSES');

  await refuses('an empty basket', 'nothing in this basket', () => quote({ lines: [] }));
  await refuses('no location', 'which location', () => quote({ locationId: '' }));
  await refuses('an item that is not this shop\'s', 'no item here matches',
    () => quote({ lines: [{ variantId: 'not-ours', quantity: 1 }] }));
  await refuses('a quantity of nothing', 'whole number above zero',
    () => quote({ lines: [{ variantId: V.saree, quantity: 0 }] }));

  // ── L. PER-CUSTOMER LIMITS ─────────────────────────────────────────────
  console.log('\nL. AN OFFER ONE PERSON CAN ONLY USE ONCE');

  const oncePer = await liveOffer({
    name: 'One each', value: 25, usageLimitPerCustomer: 1, priority: 50
  });

  const firstTime = await quote({ customerId, lines: [{ variantId: V.saree, quantity: 1 }] });
  check('a customer who has never used it gets it',
    firstTime.discounts.some((d: any) => d.title === 'One each'), JSON.stringify(firstTime.discounts));

  const version = await prisma.offerVersion.findFirstOrThrow({ where: { offerId: oncePer.id } });
  await prisma.offerRedemption.create({
    data: {
      clientId: CLIENT, offerId: oncePer.id, offerVersionId: version.id,
      salesOrderId: 'used-once', customerId, amount: 100, status: 'COUNTED'
    }
  });

  const secondTime = await quote({ customerId, lines: [{ variantId: V.saree, quantity: 1 }] });
  check('  ...and does not get it twice',
    !secondTime.discounts.some((d: any) => d.title === 'One each'), JSON.stringify(secondTime.discounts));

  /*
   * A basket with nobody attached to it.
   *
   * A per-person limit cannot be honoured for somebody we cannot identify, and the safe side is to
   * withhold it: the alternative is an unlimited discount for anyone who checks out as a guest.
   */
  const anonymous = await quote({ lines: [{ variantId: V.saree, quantity: 1 }] });
  check('a basket with no customer does not get a per-person offer at all',
    !anonymous.discounts.some((d: any) => d.title === 'One each'), JSON.stringify(anonymous.discounts));

  // ── M. IT ALL ADDS UP ──────────────────────────────────────────────────
  console.log('\nM. IT ALL ADDS UP');

  const complex = await quote({
    customerId,
    lines: [
      { variantId: V.saree, quantity: 3 },
      { variantId: V.blouse, quantity: 2 },
      { variantId: V.dhoti, quantity: 1 }
    ],
    couponCodes: ['EXTRA15']
  });
  const lineSum = complex.lines.reduce((s: number, l: any) => s + l.lineTotal, 0);
  check('the lines add up to the total', Math.abs(lineSum - complex.total) < 0.005,
    `${lineSum} vs ${complex.total}`);
  check('what came off adds up too',
    Math.abs((complex.subtotal - complex.total) - complex.discountTotal) < 0.005,
    `${complex.subtotal - complex.total} vs ${complex.discountTotal}`);
  check('nothing is priced below nothing', complex.lines.every((l: any) => l.lineTotal >= 0));

  const quotes = await prisma.pricingQuote.findMany({ where: { clientId: CLIENT } });
  check('every quote recorded what it said',
    quotes.every(q => num(q.subtotal) - num(q.discount) === num(q.total)),
    String(quotes.length));
}

main()
  .catch(e => { console.error('\nSUITE CRASHED:', e); failed++; failures.push('suite crashed'); })
  .finally(async () => {
    await prisma.pricingQuote.deleteMany({ where: { clientId: CLIENT } });
    await prisma.offerRedemption.deleteMany({ where: { clientId: CLIENT } });
    await prisma.offerVersion.deleteMany({ where: { offer: { clientId: CLIENT } } });
    await prisma.offerTarget.deleteMany({ where: { offer: { clientId: CLIENT } } });
    await prisma.offer.deleteMany({ where: { clientId: CLIENT } });
    await prisma.productVariant.deleteMany({ where: { clientId: CLIENT } });
    await prisma.product.deleteMany({ where: { clientId: CLIENT } });
    await prisma.customer.deleteMany({ where: { clientId: CLIENT } });
    await prisma.stockLocation.deleteMany({ where: { clientId: CLIENT } });
    await prisma.clientSequence.deleteMany({ where: { clientId: CLIENT } });
    await prisma.$disconnect();

    console.log(`\nRESULT: ${passed} passed | ${failed} failed`);
    if (failures.length) console.log('Failures:\n  - ' + failures.join('\n  - '));
    process.exit(failed ? 1 : 0);
  });
