/**
 * What a basket costs.
 *
 * Pure, so none of this needs a tenant, a clock or a database -- which is exactly why the awkward
 * cases can be written down honestly: two offers competing for one line, a discount that does not
 * divide by three, a condition missed only BECAUSE another offer applied first.
 *
 * The worked example from the plan is in section D, and it is the one merchants get caught by.
 *
 *   npx tsx src/scripts/verify-pricing-engine.ts
 */
import { priceBasket, BasketLine, CandidateOffer } from '../services/pricing';

let passed = 0, failed = 0;
const failures: string[] = [];
const check = (name: string, ok: boolean, detail?: string) => {
  if (ok) { passed++; console.log(`  [PASS] ${name}`); }
  else { failed++; failures.push(name); console.log(`  [FAIL] ${name}${detail ? `  -> ${detail}` : ''}`); }
};

const rupees = (minor: number) => (minor / 100).toFixed(2);

const line = (over: Partial<BasketLine> = {}): BasketLine => ({
  variantId: 'v-saree', productId: 'p-saree', category: 'WOMEN',
  quantity: 1, listUnitPriceMinor: 1200000, sku: 'SAREE', title: 'Saree',
  ...over
});

let seq = 0;
const offer = (over: Partial<CandidateOffer> = {}): CandidateOffer => ({
  id: `o${++seq}`, versionId: `ver${seq}`, name: `Offer ${seq}`,
  trigger: 'AUTOMATIC', couponCode: null, level: 'LINE',
  valueType: 'PERCENTAGE', value: 10, maxDiscount: null,
  scope: 'ALL', targets: [],
  minSubtotalMinor: null, minQuantity: null,
  priority: 0, stackable: false, createdAt: new Date(2026, 0, 1),
  ...over
});

function main() {
  // ── A. NOTHING TO APPLY ────────────────────────────────────────────────
  console.log('\nA. A BASKET WITH NO OFFERS');

  const plain = priceBasket([line({ quantity: 2 })], []);
  check('the total is just the goods', plain.totalMinor === 2400000, rupees(plain.totalMinor));
  check('nothing came off', plain.discountTotalMinor === 0);
  check('and the line agrees with the basket',
    plain.lines[0].lineTotalMinor === plain.totalMinor);
  check('the net unit price is the list price', plain.lines[0].netUnitPriceMinor === 1200000);

  // ── B. ONE OFFER ───────────────────────────────────────────────────────
  console.log('\nB. ONE OFFER ON ONE LINE');

  const simple = priceBasket([line()], [offer({ value: 20, name: 'Deepavali Sale' })]);
  check('20% comes off', simple.discountTotalMinor === 240000, rupees(simple.discountTotalMinor));
  check('the total is what is left', simple.totalMinor === 960000, rupees(simple.totalMinor));
  check('the line names the offer that did it',
    simple.lines[0].appliedOffers[0]?.title === 'Deepavali Sale');
  check('  ...and the version it used, so the order can explain itself later',
    simple.lines[0].appliedOffers[0]?.offerVersionId === 'ver' + (seq));
  check('the basket sums it up per rule', simple.discounts.length === 1 && simple.discounts[0].amountMinor === 240000);

  const capped = priceBasket([line()], [offer({ value: 20, maxDiscount: 1000 })]);
  check('a cap holds a percentage back', capped.discountTotalMinor === 100000, rupees(capped.discountTotalMinor));

  // ── C. TWO OFFERS WANTING THE SAME LINE ────────────────────────────────
  console.log('\nC. TWO OFFERS WANTING THE SAME LINE');

  const competing = priceBasket([line()], [
    offer({ name: 'Twenty', value: 20, priority: 10 }),
    offer({ name: 'Ten', value: 10, priority: 5 })
  ]);
  check('only the best one applies', competing.lines[0].appliedOffers.length === 1);
  check('  ...and it is the higher priority', competing.lines[0].appliedOffers[0].title === 'Twenty');
  check('  ...so the line is discounted once', competing.discountTotalMinor === 240000,
    rupees(competing.discountTotalMinor));

  const stacked = priceBasket([line()], [
    offer({ name: 'Base', value: 20, priority: 10 }),
    offer({ name: 'Extra', value: 10, priority: 5, stackable: true })
  ]);
  check('a stackable offer applies on top', stacked.lines[0].appliedOffers.length === 2);
  check('  ...on what is LEFT, not the list price',
    stacked.discountTotalMinor === 240000 + 96000, rupees(stacked.discountTotalMinor));

  // ── D. THE CASE MERCHANTS GET CAUGHT BY ────────────────────────────────
  console.log('\nD. THE WORKED EXAMPLE FROM THE PLAN');

  /*
   * 2 sarees at 12,000 and a blouse at 800.
   *   A  20% off sarees        priority 10, exclusive
   *   B  10% off everything    priority 5,  exclusive
   *   C  500 off over 20,000   order level
   *
   * A beats B on the saree line. B still gets the blouse. The subtotal AFTER those is 19,920 --
   * so C does not qualify, by 80 rupees, BECAUSE the other offers applied.
   */
  const basket = priceBasket(
    [line({ quantity: 2 }), line({ variantId: 'v-blouse', productId: 'p-blouse', listUnitPriceMinor: 80000, sku: 'BLOUSE' })],
    [
      offer({ name: 'Sarees 20%', value: 20, priority: 10, scope: 'PRODUCT', targets: [{ scope: 'PRODUCT', refId: 'p-saree' }] }),
      offer({ name: 'Everything 10%', value: 10, priority: 5 }),
      offer({ name: '500 off over 20,000', level: 'ORDER', valueType: 'FIXED_AMOUNT', value: 500, minSubtotalMinor: 2000000 })
    ]
  );

  check('the saree line takes the saree offer',
    basket.lines[0].appliedOffers[0]?.title === 'Sarees 20%', basket.lines[0].appliedOffers[0]?.title);
  check('  ...leaving 19,200', basket.lines[0].lineTotalMinor === 1920000, rupees(basket.lines[0].lineTotalMinor));
  check('the blouse takes the everything offer',
    basket.lines[1].appliedOffers[0]?.title === 'Everything 10%');
  check('  ...leaving 720', basket.lines[1].lineTotalMinor === 72000, rupees(basket.lines[1].lineTotalMinor));
  check('THE ORDER OFFER DOES NOT APPLY', basket.totalMinor === 1992000, rupees(basket.totalMinor));
  check('  ...and the basket says why, with the shortfall',
    basket.nearMisses.some(n => /Spend 80\.00 more/.test(n.reason)),
    JSON.stringify(basket.nearMisses));

  // A basket just big enough.
  const qualifies = priceBasket(
    [line({ quantity: 2 }), line({ variantId: 'v-b', productId: 'p-b', listUnitPriceMinor: 200000 })],
    [offer({ name: '500 off over 20,000', level: 'ORDER', valueType: 'FIXED_AMOUNT', value: 500, minSubtotalMinor: 2000000 })]
  );
  check('a basket that does reach the threshold gets it',
    qualifies.discountTotalMinor === 50000, rupees(qualifies.discountTotalMinor));
  check('  ...divided across the lines',
    qualifies.lines.every(l => l.appliedOffers.some(a => a.level === 'ORDER')));
  check('  ...adding up to exactly the discount',
    qualifies.lines.reduce((s, l) => s + l.appliedOffers.filter(a => a.level === 'ORDER')
      .reduce((t, a) => t + a.amountMinor, 0), 0) === 50000);

  // ── E. SPLITS THAT DO NOT DIVIDE ───────────────────────────────────────
  console.log('\nE. SPLITS THAT DO NOT DIVIDE');

  const threeWay = priceBasket(
    [line({ variantId: 'a', listUnitPriceMinor: 10000 }),
     line({ variantId: 'b', listUnitPriceMinor: 10000 }),
     line({ variantId: 'c', listUnitPriceMinor: 10000 })],
    [offer({ level: 'ORDER', valueType: 'FIXED_AMOUNT', value: 100 })]
  );
  const shares = threeWay.lines.map(l => l.discountMinor);
  check('₹100 across three equal lines sums to exactly ₹100',
    shares.reduce((a, b) => a + b, 0) === 10000, JSON.stringify(shares));
  check('  ...and the lines still add up to the total',
    threeWay.lines.reduce((s, l) => s + l.lineTotalMinor, 0) === threeWay.totalMinor);

  const uneven = priceBasket(
    [line({ quantity: 3, listUnitPriceMinor: 250000 })],
    [offer({ valueType: 'FIXED_AMOUNT', value: 41.68 })]
  );
  check('a line with no whole-paisa unit price still totals exactly',
    uneven.lines[0].lineTotalMinor === 745832, rupees(uneven.lines[0].lineTotalMinor));
  check('  ...and its unit price is the rounded net',
    uneven.lines[0].netUnitPriceMinor === 248611, String(uneven.lines[0].netUnitPriceMinor));

  // ── F. NOTHING GOES BELOW NOTHING ──────────────────────────────────────
  console.log('\nF. NOTHING GOES BELOW NOTHING');

  const giveaway = priceBasket([line({ listUnitPriceMinor: 50000 })],
    [offer({ valueType: 'FIXED_AMOUNT', value: 5000 })]);
  check('a discount bigger than the line stops at the line',
    giveaway.lines[0].lineTotalMinor === 0 && giveaway.discountTotalMinor === 50000,
    rupees(giveaway.lines[0].lineTotalMinor));

  const stackedToZero = priceBasket([line({ listUnitPriceMinor: 10000 })], [
    offer({ valueType: 'FIXED_AMOUNT', value: 60, priority: 10 }),
    offer({ valueType: 'FIXED_AMOUNT', value: 80, priority: 5, stackable: true })
  ]);
  check('two offers cannot take a line past zero',
    stackedToZero.lines[0].lineTotalMinor === 0, rupees(stackedToZero.lines[0].lineTotalMinor));
  check('  ...and the total is never negative', stackedToZero.totalMinor >= 0);

  const freeLine = priceBasket(
    [line({ listUnitPriceMinor: 0, variantId: 'gift' }), line({ listUnitPriceMinor: 80000 })],
    [offer({ level: 'ORDER', valueType: 'FIXED_AMOUNT', value: 100 })]
  );
  check('an order discount skips a line worth nothing',
    freeLine.lines[0].discountMinor === 0 && freeLine.lines[1].discountMinor === 10000,
    JSON.stringify(freeLine.lines.map(l => l.discountMinor)));

  // ── G. CODES ───────────────────────────────────────────────────────────
  console.log('\nG. CODES, AND WHY ONE DID NOTHING');

  const coded = offer({ name: 'Deepavali', trigger: 'CODE', couponCode: 'DEEPAVALI', value: 20 });

  const withoutCode = priceBasket([line()], [coded]);
  check('a code offer does nothing until the code is given',
    withoutCode.discountTotalMinor === 0, rupees(withoutCode.discountTotalMinor));

  const withCode = priceBasket([line()], [coded], ['deepavali']);
  check('the code applies it, whatever case it was typed in',
    withCode.discountTotalMinor === 240000, rupees(withCode.discountTotalMinor));

  const typo = priceBasket([line()], [coded], ['DEEPAVLI']);
  check('a code that matches no offer says so',
    typo.rejected.some(r => /no offer with that code/i.test(r.reason)), JSON.stringify(typo.rejected));

  const wrongBasket = priceBasket(
    [line({ variantId: 'v-blouse', productId: 'p-blouse' })],
    [offer({ trigger: 'CODE', couponCode: 'SAREES', scope: 'PRODUCT', targets: [{ scope: 'PRODUCT', refId: 'p-saree' }] })],
    ['SAREES']
  );
  check('a real code that fits nothing in the basket says THAT instead',
    wrongBasket.rejected.some(r => /Nothing in this basket qualifies/i.test(r.reason)),
    JSON.stringify(wrongBasket.rejected));

  const tooSmall = priceBasket([line({ listUnitPriceMinor: 50000 })],
    [offer({ trigger: 'CODE', couponCode: 'BIG', minSubtotalMinor: 100000 })], ['BIG']);
  check('a code blocked by a condition says how far short the basket is',
    tooSmall.rejected.some(r => /Spend 500\.00 more/.test(r.reason)), JSON.stringify(tooSmall.rejected));

  // ── H. TARGETING ───────────────────────────────────────────────────────
  console.log('\nH. WHAT AN OFFER APPLIES TO');

  const twoLines = [line(), line({ variantId: 'v-blouse', productId: 'p-blouse', category: 'WOMEN', listUnitPriceMinor: 80000 })];

  const byCategory = priceBasket(twoLines,
    [offer({ scope: 'CATEGORY', targets: [{ scope: 'CATEGORY', refId: 'WOMEN' }], value: 10 })]);
  check('a category offer catches both lines in it',
    byCategory.lines.every(l => l.discountMinor > 0));

  const byVariant = priceBasket(twoLines,
    [offer({ scope: 'VARIANT', targets: [{ scope: 'VARIANT', refId: 'v-blouse' }], value: 10 })]);
  check('a variant offer catches only that one',
    byVariant.lines[0].discountMinor === 0 && byVariant.lines[1].discountMinor === 8000,
    JSON.stringify(byVariant.lines.map(l => l.discountMinor)));

  const wrongCategory = priceBasket(twoLines,
    [offer({ scope: 'CATEGORY', targets: [{ scope: 'CATEGORY', refId: 'MEN' }] })]);
  check('a category nothing is in takes nothing off', wrongCategory.discountTotalMinor === 0);

  // ── I. THE SAME BASKET, TWICE ──────────────────────────────────────────
  console.log('\nI. THE SAME BASKET PRICED TWICE');

  const same = new Date(2026, 0, 1);
  const twins = [
    offer({ id: 'z', name: 'Z', value: 10, priority: 5, createdAt: same }),
    offer({ id: 'a', name: 'A', value: 10, priority: 5, createdAt: same })
  ];
  const first = priceBasket([line()], twins);
  const second = priceBasket([line()], [...twins].reverse());
  check('two identical offers created at the same instant resolve the same way',
    first.lines[0].appliedOffers[0].offerId === second.lines[0].appliedOffers[0].offerId,
    `${first.lines[0].appliedOffers[0].offerId} vs ${second.lines[0].appliedOffers[0].offerId}`);
  check('  ...and the totals match', first.totalMinor === second.totalMinor);

  const repeated = priceBasket([line({ quantity: 2 }), line({ variantId: 'b', listUnitPriceMinor: 33333 })], [
    offer({ value: 17, priority: 3 }),
    offer({ level: 'ORDER', valueType: 'FIXED_AMOUNT', value: 111.11 })
  ]);
  const again = priceBasket([line({ quantity: 2 }), line({ variantId: 'b', listUnitPriceMinor: 33333 })], [
    offer({ value: 17, priority: 3 }),
    offer({ level: 'ORDER', valueType: 'FIXED_AMOUNT', value: 111.11 })
  ]);
  check('an awkward basket prices identically on two runs',
    JSON.stringify(repeated.lines.map(l => l.lineTotalMinor)) ===
    JSON.stringify(again.lines.map(l => l.lineTotalMinor)),
    JSON.stringify(repeated.lines.map(l => l.lineTotalMinor)));
  check('  ...and its lines add up to its total',
    repeated.lines.reduce((s, l) => s + l.lineTotalMinor, 0) === repeated.totalMinor);
  check('  ...and what came off adds up too',
    repeated.subtotalMinor - repeated.totalMinor === repeated.discountTotalMinor);

  // ── J. AN EMPTY BASKET ─────────────────────────────────────────────────
  console.log('\nJ. NOTHING IN THE BASKET');

  const empty = priceBasket([], [offer({ level: 'ORDER', valueType: 'FIXED_AMOUNT', value: 500 })]);
  check('an empty basket costs nothing and does not throw',
    empty.totalMinor === 0 && empty.discountTotalMinor === 0);
  check('  ...and no offer is claimed to have applied', empty.discounts.length === 0);

  // ── MINIMUMS COUNT THE ITEMS THE OFFER COVERS ──────────────────────────
  console.log('\nMINIMUMS COUNT ONLY THE ITEMS AN OFFER COVERS');

  const sareeLine = (q: number, price = 1000000) => line({ variantId: 'v-saree', productId: 'p-saree', category: 'SAREE', quantity: q, listUnitPriceMinor: price });
  const blouseLine = (q: number, price = 80000) => line({ variantId: 'v-blouse', productId: 'p-blouse', category: 'BLOUSE', quantity: q, listUnitPriceMinor: price, sku: 'BLOUSE' });
  const sareesOnly = { scope: 'CATEGORY' as const, targets: [{ scope: 'CATEGORY', refId: 'SAREE' }] };

  const buyTwo = offer({ name: 'Buy 2 sarees', ...sareesOnly, minQuantity: 2 });
  check('"buy 2 sarees" applies to two sarees', priceBasket([sareeLine(2)], [buyTwo]).discountTotalMinor === 200000);
  const oneOfEach = priceBasket([sareeLine(1), blouseLine(1)], [buyTwo]);
  check('  ...but NOT to one saree and one blouse', oneOfEach.discountTotalMinor === 0, rupees(oneOfEach.discountTotalMinor));
  check('  ...and says how many more sarees it needs', oneOfEach.nearMisses[0]?.reason === 'Add 1 more item(s) to get this.', oneOfEach.nearMisses[0]?.reason);

  const spendOnSarees = offer({ name: 'Spend 15k on sarees', ...sareesOnly, minSubtotalMinor: 1500000 });
  const mixed = priceBasket([sareeLine(1), blouseLine(1, 600000)], [spendOnSarees]);
  check('"spend 15,000 on sarees" is not met by 10,000 of sarees and 6,000 of blouses', mixed.discountTotalMinor === 0, rupees(mixed.discountTotalMinor));
  check('  ...and names the real shortfall', mixed.nearMisses[0]?.reason === 'Spend 5000.00 more to get this.', mixed.nearMisses[0]?.reason);
  check('  ...but is met by 15,000 of sarees', priceBasket([sareeLine(1, 1500000), blouseLine(1)], [spendOnSarees]).discountTotalMinor === 150000);

  const everything = offer({ name: 'Everything, 2 items', minQuantity: 2 });
  check('an offer on everything still counts the whole basket', priceBasket([sareeLine(1), blouseLine(1)], [everything]).discountTotalMinor === 108000);

  // The measure is the LIST price, so the order the lines are priced in cannot change the answer.
  const minimumGated = [offer({ id: 'deep', name: 'Deep cut', value: 50, stackable: true, priority: 9 }), offer({ id: 'gated', name: 'Gated', ...sareesOnly, stackable: true, minSubtotalMinor: 1500000 })];
  const forward = priceBasket([sareeLine(1, 1600000), blouseLine(1)], minimumGated);
  const backward = priceBasket([blouseLine(1), sareeLine(1, 1600000)], minimumGated);
  check('a minimum is measured before other offers cut the price, whatever the line order',
    forward.totalMinor === backward.totalMinor && forward.lines.some(l => l.appliedOffers.some(a => a.offerId === 'gated')),
    `${rupees(forward.totalMinor)} vs ${rupees(backward.totalMinor)}`);
}

try { main(); } catch (e: any) { console.error('\nSUITE CRASHED:', e?.stack ?? e); failed++; failures.push('crashed'); }
console.log(`\nRESULT: ${passed} passed | ${failed} failed`);
if (failures.length) console.log('Failures:\n  - ' + failures.join('\n  - '));
process.exit(failed ? 1 : 0);
