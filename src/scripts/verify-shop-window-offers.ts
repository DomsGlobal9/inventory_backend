/**
 * What a shop window may honestly say about an offer.
 *
 * The rule this file exists to hold: a badge on a tile is a promise the bag has to keep. "15% off"
 * over a 6,400 saree, when the offer needs a 10,000 basket, is a promise the bag then breaks -- and
 * a shopper who feels tricked at the last step is worse off than one who was told nothing at all.
 * So the question is never "does an offer exist" but "buying JUST THIS ONE PIECE, what comes off?"
 *
 * Pure: no database, no clock, no tenant. Every case below is a shape.
 *
 *   npx ts-node src/scripts/verify-shop-window-offers.ts
 */
import {
  covers, savingOnOne, windowOfferFor, windowOfferForProduct,
  type PublicOffer, type ShopPiece
} from '../services/pricing';

let passed = 0, failed = 0;
const failures: string[] = [];
const check = (name: string, ok: boolean, detail?: string) => {
  if (ok) { passed++; console.log(`  [PASS] ${name}`); }
  else { failed++; failures.push(name); console.log(`  [FAIL] ${name}${detail ? `  -> ${detail}` : ''}`); }
};

const offer = (o: Partial<PublicOffer>): PublicOffer => ({
  name: 'An offer', valueType: 'PERCENTAGE', value: 10, maxDiscount: null,
  scope: 'ALL', appliesTo: null, minSubtotal: null, minQuantity: null, ...o
});

const piece = (p: Partial<ShopPiece> = {}): ShopPiece => ({
  productCode: 'PRD-1', variantCode: 'PRD-1-RED', category: 'WOMEN', dressType: 'Saree',
  price: 6400, ...p
});

console.log('WHAT A SHOP WINDOW MAY SAY\n');

// ── Who it covers ─────────────────────────────────────────────────────────────────────────────
console.log('WHO IT COVERS');

check('an offer on everything covers any piece', covers(offer({ scope: 'ALL' }), piece()));
check('a dress-type offer covers its own shelf',
  covers(offer({ scope: 'DRESS_TYPE', appliesTo: { dressTypes: ['Saree'] } }), piece()));
check('  ...however the shop typed it',
  covers(offer({ scope: 'DRESS_TYPE', appliesTo: { dressTypes: ['  SAREE '] } }), piece()),
  'a free-text field a person types must be matched the way a person reads it');
check('  ...and not another shelf',
  !covers(offer({ scope: 'DRESS_TYPE', appliesTo: { dressTypes: ['Lehenga'] } }), piece()));
check('a department offer covers its department',
  covers(offer({ scope: 'CATEGORY', appliesTo: { categories: ['WOMEN'] } }), piece()));
check('a product offer covers that product',
  covers(offer({ scope: 'PRODUCT', appliesTo: { productCodes: ['PRD-1'] } }), piece()));
check('a piece offer covers that piece only',
  covers(offer({ scope: 'VARIANT', appliesTo: { variantCodes: ['PRD-1-RED'] } }), piece())
  && !covers(offer({ scope: 'VARIANT', appliesTo: { variantCodes: ['PRD-1-BLUE'] } }), piece()));
check('an exclusion beats the target that named it',
  !covers(offer({ scope: 'ALL', excludes: { productCodes: ['PRD-1'] } }), piece()),
  'the engine lets an exclusion win; the window has to agree or it advertises what the bag refuses');

// ── The promise a tile makes ──────────────────────────────────────────────────────────────────
console.log('\nTHE PROMISE A TILE MAKES');

check('a plain 10% off one 6,400 piece saves 640',
  savingOnOne(offer({ value: 10 }), piece()) === 640);

check('an offer needing a 10,000 basket says NOTHING on a 6,400 piece',
  savingOnOne(offer({ minSubtotal: 10000 }), piece()) === 0,
  'this is the whole point: the bag would not honour it, so the window must not claim it');
check('  ...but does on a 12,000 piece, which meets it alone',
  savingOnOne(offer({ minSubtotal: 10000 }), piece({ price: 12000 })) === 1200);
check('an offer needing two pieces says nothing about one',
  savingOnOne(offer({ minQuantity: 2 }), piece()) === 0);
check('  ...and one needing exactly one is fine',
  savingOnOne(offer({ minQuantity: 1 }), piece()) === 640);

check('a cap limits what it may claim',
  savingOnOne(offer({ value: 50, maxDiscount: 500 }), piece()) === 500);
check('money off is money off',
  savingOnOne(offer({ valueType: 'FIXED_AMOUNT', value: 500 }), piece()) === 500);
check('  ...and never more than the piece is worth',
  savingOnOne(offer({ valueType: 'FIXED_AMOUNT', value: 900 }), piece({ price: 300 })) === 300,
  'a 500-off rule on a 300 blouse takes 300, not 500');
check('a fixed price saves the difference',
  savingOnOne(offer({ valueType: 'FIXED_PRICE', value: 4999 }), piece()) === 1401);
check('  ...and says nothing when it is dearer than the price',
  savingOnOne(offer({ valueType: 'FIXED_PRICE', value: 9999 }), piece()) === 0);
check('a piece with no price is never labelled',
  savingOnOne(offer({}), piece({ price: 0 })) === 0);

// ── Which one wins ────────────────────────────────────────────────────────────────────────────
console.log('\nWHICH ONE WINS');

const two = [offer({ name: 'Ten', value: 10 }), offer({ name: 'Twenty', value: 20 })];
check('the shopper is shown the better one', windowOfferFor(two, piece())?.name === 'Twenty');
check('  ...with the right words',
  windowOfferFor(two, piece())?.kind === 'PERCENT' && windowOfferFor(two, piece())?.value === 20);

const tie = [offer({ name: 'Zeta', value: 10 }), offer({ name: 'Alpha', value: 10 })];
check('two worth the same always pick the same one',
  windowOfferFor(tie, piece())?.name === 'Alpha' && windowOfferFor([...tie].reverse(), piece())?.name === 'Alpha',
  'otherwise the badge changes between page loads for no reason a shopper can see');

check('nothing applicable means no badge at all',
  windowOfferFor([offer({ scope: 'DRESS_TYPE', appliesTo: { dressTypes: ['Lehenga'] } })], piece()) === null);
check('no offers at all means no badge', windowOfferFor([], piece()) === null);

// ── One badge for a whole product ─────────────────────────────────────────────────────────────
console.log('\nONE BADGE FOR A WHOLE PRODUCT');

const small = piece({ variantCode: 'PRD-1-S', price: 6400 });
const large = piece({ variantCode: 'PRD-1-L', price: 6400 });

check('a product whose every size gets the same offer wears the badge',
  windowOfferForProduct([offer({ name: 'All 10%' })], [small, large])?.name === 'All 10%');

const onlySmall = offer({ name: 'Small only', scope: 'VARIANT', appliesTo: { variantCodes: ['PRD-1-S'] } });
check('a product where only ONE size qualifies wears nothing',
  windowOfferForProduct([onlySmall], [small, large]) === null,
  'a tile is one word about a whole product; "15% off" where three sizes of four miss out is three broken promises');
check('  ...though that size still says so on its own',
  windowOfferFor([onlySmall], small)?.name === 'Small only');

const dearer = piece({ variantCode: 'PRD-1-XL', price: 12000 });
check('sizes that qualify only because they are dearer do not make a tile badge',
  windowOfferForProduct([offer({ minSubtotal: 10000 })], [small, dearer]) === null);

check('a product with nothing to sell wears nothing', windowOfferForProduct([offer({})], []) === null);

console.log(`\n${passed} passed, ${failed} failed`);
if (failures.length) console.log(`failed: ${failures.join(' | ')}`);
process.exit(failed > 0 ? 1 : 0);
