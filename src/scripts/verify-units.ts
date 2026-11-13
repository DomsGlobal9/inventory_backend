/**
 * The unit rules on their own (lib/units.ts, 13 Nov 2026, PLAN-fabrics.md). No database. Worst cases first.
 *   npx tsx src/scripts/verify-units.ts
 */
import { toBase, fromBase, formatQty, quantityProblem, lineAmount, minCutOf, factorOf, isMeasured, storedPrice, pricePerUnit, priceProblem } from '../lib/units';

let passed = 0, failed = 0;
const eq = (name: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) passed++; else failed++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : ` -- got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`}`);
};
const metre = { soldBy: 'METRE', minCut: null };
const metreHalf = { soldBy: 'METRE', minCut: 50 };
const piece = { soldBy: 'PIECE', minCut: null };
const packet = { soldBy: 'PACKET', minCut: null };

console.log('TYPED LENGTHS INTO CENTIMETRES');
eq('"2.25" m -> 225', toBase('2.25', 'METRE'), 225);
eq('"2,25" (comma) m -> 225', toBase('2,25', 'METRE'), 225);
eq('2.5 (number) m -> 250', toBase(2.5, 'METRE'), 250);
eq('"12" m -> 1200', toBase('12', 'METRE'), 1200);
eq('"2.255" m (not whole cm) -> refused', toBase('2.255', 'METRE'), null);
eq('"abc" -> refused', toBase('abc', 'METRE'), null);
eq('"" -> refused', toBase('', 'METRE'), null);
eq('"1e3" -> refused (no exponent tricks)', toBase('1e3', 'METRE'), null);
eq('"0.1" + float error: 0.29 m -> 29 (not 28.999)', toBase('0.29', 'METRE'), 29);
eq('"1.5" pieces -> refused (pieces are whole)', toBase('1.5', 'PIECE'), null);
eq('"3" pieces -> 3', toBase('3', 'PIECE'), 3);
eq('"1.250" kg -> 1250 g', toBase('1.250', 'KILOGRAM'), 1250);
eq('unknown unit behaves as PIECE', factorOf('YARD'), 1);

console.log('\nSHOWING');
eq('225 cm -> "2.25 m"', formatQty(225, 'METRE'), '2.25 m');
eq('1250 cm -> "12.50 m"', formatQty(1250, 'METRE'), '12.50 m');
eq('1 piece -> "1 piece"', formatQty(1, 'PIECE'), '1 piece');
eq('3 packets -> "3 packets"', formatQty(3, 'PACKET'), '3 packets');
eq('fromBase 225 cm = 2.25', fromBase(225, 'METRE'), 2.25);

console.log('\nWHAT A SALE MAY BE');
eq('0.03 m (3 cm) with 0.25 m smallest cut -> refused, suggests 0.25 m', quantityProblem(3, metre), '0.03 m is not a multiple of the smallest cut (0.25 m). Use 0.25 m.');
eq('2.30 m -> refused, suggests 2.25 or 2.50', quantityProblem(230, metre), '2.30 m is not a multiple of the smallest cut (0.25 m). Use 2.25 m or 2.50 m.');
eq('2.25 m -> fine', quantityProblem(225, metre), null);
eq('0 m -> refused', quantityProblem(0, metre), 'Enter more than 0 metres.');
eq('negative -> refused', quantityProblem(-25, metre), 'Enter more than 0 metres.');
eq('the product\'s own cut 0.5 m: 0.75 m refused', quantityProblem(75, metreHalf) !== null, true);
eq('the shop\'s default cut used when the product has none (0.10 m shop: 0.30 m fine)', quantityProblem(30, metre, 10), null);
eq('pieces: any whole number fine (smallest cut never applies)', quantityProblem(7, piece), null);
eq('1.5 (not whole) pieces -> refused', quantityProblem(1.5, piece), 'Enter a whole number of pieces.');
eq('packet: smallest cut is 1', minCutOf(packet), 1);
eq('measured: metre yes, piece no', [isMeasured('METRE'), isMeasured('PIECE')], [true, false]);

console.log('\nMONEY (prices stored per base unit)');
eq('₹450 per metre is stored as 4.50 per cm', storedPrice('450', 'METRE'), 4.5);
eq('₹333 per metre -> 3.33 per cm', storedPrice(333, 'METRE'), 3.33);
eq('₹450.50 per metre cannot be stored exactly -> refused', storedPrice('450.50', 'METRE'), null);
eq('...with a plain reason', priceProblem('450.50', 'METRE'), 'A price per metre must be in whole rupees, like 451.');
eq('₹1,200.50 per piece is fine (pieces keep paise)', storedPrice('1200.50', 'PIECE'), 1200.5);
eq('negative price refused', storedPrice(-1, 'METRE'), null);
eq('shown back per metre: 4.50 -> 450', pricePerUnit(4.5, 'METRE'), 450);
eq('3.33 per cm shows ₹333 per metre (no 332.99999)', pricePerUnit(3.33, 'METRE'), 333);
eq('2.25 m at ₹450/m = ₹1,012.50', lineAmount(225, storedPrice(450, 'METRE')!), 1012.5);
eq('0.25 m at ₹333/m = ₹83.25', lineAmount(25, storedPrice(333, 'METRE')!), 83.25);
eq('12.5 m at ₹99/m = ₹1,237.50', lineAmount(1250, storedPrice(99, 'METRE')!), 1237.5);
eq('3 pieces at ₹1,200 = ₹3,600 (exactly as before)', lineAmount(3, storedPrice(1200, 'PIECE')!), 3600);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
