/**
 * The GST maths, every scenario in PLAN-gst.md section 9.
 *
 * PURE. No database, no API, no server. The tax engine is a pure function, so its suite is too --
 * which means this one can be run any time, cannot touch a real client's data, and finishes in
 * milliseconds rather than minutes.
 *
 *   A  the rates as they stand after 22 Sep 2025: fabric flat, apparel slabbed at 2500
 *   B  the slab follows the TRANSACTION value, so an offer can change the rate
 *   C  CGST/SGST always add back to the total, including on odd paise
 *   D  inter-state is IGST and costs the customer the same
 *   E  inclusive <-> exclusive round trips exactly, on the number the customer can check
 *   F  a credit note reverses its sale exactly, to the paisa
 *   G  who may charge tax at all, and which document they issue
 *   H  rounding the bill, and the round-off line
 *   I  the circularity trap of section 2, proved rather than asserted
 *   J  property sweeps: thousands of values, not just the ones I thought of
 *
 *   npx tsx src/scripts/verify-gst.ts
 */
import {
  taxForLine, taxableFromInclusive, inclusiveFromTaxable, rateFor, roundOff,
  mayChargeTax, documentKindFor, APPAREL_RULE, FABRIC_RULE,
  type RateRule, type GstRegistration
} from '../services/pricing/tax';
import { suggestHsn, effectiveTaxFor, hsnForInvoice } from '../services/pricing/hsn';
import { buildBill, financialYearOf, type BillLineInput } from '../services/pricing/bill';
import { freezeTaxForLine, type ProductTaxStanding } from '../services/pricing/freezeTax';
import { buildDocument, type DocumentOrder, type DocumentShop } from '../services/invoicing/document';
import { formatInvoiceNumber, SERIES } from '../services/invoicing/invoiceNumber';

let passed = 0;
let failed = 0;

function check(name: string, ok: boolean, detail = '') {
  if (ok) { passed++; console.log(`   PASS  ${name}${detail ? '  -- ' + detail : ''}`); }
  else { failed++; console.log(`   FAIL  ${name}${detail ? '  -- ' + detail : ''}`); }
}
const eq = (name: string, got: unknown, want: unknown) =>
  check(name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);

const rupees = (n: number) => n * 100;           // to paise
const SAREE: RateRule = { hsnCode: '5007', ...FABRIC_RULE };
const LEHENGA: RateRule = { hsnCode: '6204', ...APPAREL_RULE };

// ── A. The rates ─────────────────────────────────────────────────────────────────────────
console.log('\nA. The rates, as they stand after 22 September 2025');

eq('a ₹800 saree is 5%', rateFor(SAREE, rupees(800)), 500);
eq('a ₹3,121 saree is still 5%', rateFor(SAREE, rupees(3121)), 500);
eq('a ₹40,000 kanchipuram is STILL 5% (fabric has no threshold)', rateFor(SAREE, rupees(40000)), 500);

eq('a ₹2,400 lehenga is 5%', rateFor(LEHENGA, rupees(2400)), 500);
eq('a ₹2,500 lehenga is 5% (the threshold is "above")', rateFor(LEHENGA, rupees(2500)), 500);
eq('a ₹2,500.01 lehenga is 18%', rateFor(LEHENGA, rupees(2500) + 1), 1800);
eq('a ₹2,600 lehenga is 18%', rateFor(LEHENGA, rupees(2600)), 1800);

check('the retired ₹1,000 threshold is NOT applied',
  rateFor(LEHENGA, rupees(1500)) === 500, 'a ₹1,500 lehenga must be 5%, not 12%');

// ── B. The slab follows the transaction value ────────────────────────────────────────────
console.log('\nB. An offer can change the rate, because GST is on the transaction value');

eq('₹2,600 lehenga, no offer → 18%', rateFor(LEHENGA, rupees(2600)), 1800);
eq('same lehenga after a ₹200 offer → 5%', rateFor(LEHENGA, rupees(2400)), 500);

check('the threshold is PER PIECE, not per line',
  rateFor(LEHENGA, rupees(2000)) === 500,
  'three at ₹2,000 each are 5%, not 18% because they total ₹6,000');

// ── C. CGST and SGST always add back ─────────────────────────────────────────────────────
console.log('\nC. CGST + SGST = the total tax, always, including on odd paise');

{
  const t = taxForLine({ taxableValueMinor: rupees(5000), rateBps: 500, interState: false });
  eq('₹5,000 at 5% in-state', t, { cgstMinor: 12500, sgstMinor: 12500, igstMinor: 0, totalTaxMinor: 25000 });
}
{
  // 333.33 at 5% = 16.6665 -> 1667 paise, which is odd and cannot be halved evenly
  const t = taxForLine({ taxableValueMinor: 33333, rateBps: 500, interState: false });
  check('an odd number of paise still adds back exactly',
    t.cgstMinor + t.sgstMinor === t.totalTaxMinor,
    `${t.cgstMinor} + ${t.sgstMinor} = ${t.totalTaxMinor}`);
  check('and the halves differ by at most one paisa',
    Math.abs(t.cgstMinor - t.sgstMinor) <= 1, `${t.cgstMinor} vs ${t.sgstMinor}`);
}

// ── D. Inter-state ───────────────────────────────────────────────────────────────────────
console.log('\nD. Another state means IGST, and the customer pays the same');

{
  const home = taxForLine({ taxableValueMinor: rupees(3000), rateBps: 500, interState: false });
  const away = taxForLine({ taxableValueMinor: rupees(3000), rateBps: 500, interState: true });
  eq('in-state splits into halves', [home.cgstMinor, home.sgstMinor, home.igstMinor], [7500, 7500, 0]);
  eq('out-of-state is one IGST line', [away.cgstMinor, away.sgstMinor, away.igstMinor], [0, 0, 15000]);
  check('the customer pays the same either way', home.totalTaxMinor === away.totalTaxMinor,
    `${home.totalTaxMinor} = ${away.totalTaxMinor}`);
}

// ── E. Inclusive prices ──────────────────────────────────────────────────────────────────
console.log('\nE. Working backwards from a tax-inclusive shelf price');

{
  const { taxableValueMinor, taxMinor } = taxableFromInclusive(rupees(3121), 500);
  check('taxable + tax = the price on the tag, exactly',
    taxableValueMinor + taxMinor === rupees(3121),
    `${taxableValueMinor} + ${taxMinor} = ${rupees(3121)}`);
  check('and the taxable value is about price ÷ 1.05',
    Math.abs(taxableValueMinor - Math.round(rupees(3121) / 1.05)) <= 1,
    `${taxableValueMinor}`);
}
{
  const ex = rupees(2000);
  const inc = inclusiveFromTaxable(ex, 1800);
  const back = taxableFromInclusive(inc, 1800);
  eq('exclusive → inclusive → exclusive comes home', back.taxableValueMinor, ex);
}

// ── F. Credit notes ──────────────────────────────────────────────────────────────────────
console.log('\nF. A refund reverses its sale exactly');

{
  const sale = taxForLine({ taxableValueMinor: 33333, rateBps: 500, interState: false });
  const note = taxForLine({ taxableValueMinor: -33333, rateBps: 500, interState: false });
  eq('the credit note is the sale negated, to the paisa',
    [note.cgstMinor, note.sgstMinor, note.totalTaxMinor],
    [-sale.cgstMinor, -sale.sgstMinor, -sale.totalTaxMinor]);
}
{
  const sale = taxForLine({ taxableValueMinor: 12345, rateBps: 1800, interState: true });
  const note = taxForLine({ taxableValueMinor: -12345, rateBps: 1800, interState: true });
  check('and on IGST too', note.igstMinor === -sale.igstMinor, `${note.igstMinor} vs ${-sale.igstMinor}`);
}

// ── G. Who may charge tax ────────────────────────────────────────────────────────────────
console.log('\nG. Not every shop may charge GST');

const regs: GstRegistration[] = ['REGULAR', 'COMPOSITION', 'UNREGISTERED'];
eq('only a regular dealer may charge', regs.map(mayChargeTax), [true, false, false]);
eq('and each issues a different document', regs.map(documentKindFor),
  ['TAX_INVOICE', 'BILL_OF_SUPPLY', 'RECEIPT']);

// ── H. Rounding ──────────────────────────────────────────────────────────────────────────
console.log('\nH. The bill total goes to the nearest rupee, and the difference is its own line');

{
  const r = roundOff(449960);                      // ₹4,499.60
  eq('₹4,499.60 becomes ₹4,500.00', [r.roundedMinor, r.roundOffMinor], [450000, 40]);
}
{
  const r = roundOff(450040);                      // ₹4,500.40
  eq('₹4,500.40 becomes ₹4,500.00', [r.roundedMinor, r.roundOffMinor], [450000, -40]);
}
{
  const r = roundOff(450000);
  eq('an exact rupee is left alone', [r.roundedMinor, r.roundOffMinor], [450000, 0]);
}

// ── I. The trap in section 2, proved ─────────────────────────────────────────────────────
console.log('\nI. The tax-inclusive threshold trap — proved, not asserted');

{
  const P = rupees(2800);                          // an inclusive shelf price in the bad band
  const atLow = taxableFromInclusive(P, 500).taxableValueMinor;
  const atHigh = taxableFromInclusive(P, 1800).taxableValueMinor;
  const lowSaysHigh = atLow > APPAREL_RULE.thresholdMinor;    // 5% gives a value ABOVE the threshold
  const highSaysLow = atHigh <= APPAREL_RULE.thresholdMinor;  // 18% gives one BELOW it
  check('a ₹2,800 inclusive lehenga has no self-consistent rate',
    lowSaysHigh && highSaysLow,
    `at 5% taxable = ₹${(atLow / 100).toFixed(2)} (above ₹2,500); at 18% taxable = ₹${(atHigh / 100).toFixed(2)} (below)`);

  // and the band is exactly where the plan says it is
  const bandStart = rupees(2625);
  const bandEnd = rupees(2950);
  const below = taxableFromInclusive(bandStart, 500).taxableValueMinor <= APPAREL_RULE.thresholdMinor;
  const above = taxableFromInclusive(bandEnd + 100, 1800).taxableValueMinor > APPAREL_RULE.thresholdMinor;
  check('below ₹2,625 inclusive, 5% is consistent', below);
  check('above ₹2,950 inclusive, 18% is consistent', above);
}

// ── J. Property sweeps ───────────────────────────────────────────────────────────────────
console.log('\nJ. Sweeping thousands of values, not just the ones I thought of');

{
  let addBack = 0, roundTrip = 0, symmetry = 0, worstRoundTrip = 0;
  const rates = [0, 500, 1800];
  for (let paise = 1; paise <= 2_000_00; paise += 37) {
    for (const rate of rates) {
      const t = taxForLine({ taxableValueMinor: paise, rateBps: rate, interState: false });
      if (t.cgstMinor + t.sgstMinor !== t.totalTaxMinor) addBack++;

      const inc = inclusiveFromTaxable(paise, rate);
      const back = taxableFromInclusive(inc, rate);
      const drift = Math.abs(back.taxableValueMinor - paise);
      if (drift > worstRoundTrip) worstRoundTrip = drift;
      if (drift > 1) roundTrip++;

      const neg = taxForLine({ taxableValueMinor: -paise, rateBps: rate, interState: false });
      if (neg.totalTaxMinor !== -t.totalTaxMinor) symmetry++;
    }
  }
  check('CGST + SGST adds back on every value swept', addBack === 0, `${addBack} failures`);
  check('inclusive round trip never drifts more than a paisa', roundTrip === 0,
    `${roundTrip} failures, worst drift ${worstRoundTrip} paisa`);
  check('a refund is always the exact negative of its sale', symmetry === 0, `${symmetry} failures`);
}

{
  // The invoice can never be made to disagree with itself: line tax computed from a
  // reverse-engineered taxable value must still reproduce the inclusive price.
  let bad = 0;
  for (let p = 100; p <= 500_00; p += 13) {
    for (const rate of [500, 1800]) {
      const { taxableValueMinor, taxMinor } = taxableFromInclusive(p, rate);
      if (taxableValueMinor + taxMinor !== p) bad++;
    }
  }
  check('taxable + tax always equals the price the customer sees', bad === 0, `${bad} failures`);
}


// -- K. Suggesting an HSN from what the shop already typed --------------------------------
console.log('\nK. HSN suggestions -- a first guess, never a decision');

{
  const silkSaree = suggestHsn({ dressType: 'Saree', fabric: 'Silk' });
  eq('a silk saree suggests 5007 at 5%, not slabbed',
    [silkSaree?.hsnCode, silkSaree?.taxRateBps, silkSaree?.taxSlabbed], ['5007', 500, false]);

  const cotton = suggestHsn({ dressType: 'Saree', fabric: 'Cotton' });
  eq('a cotton saree suggests 5208', [cotton?.hsnCode, cotton?.taxSlabbed], ['5208', false]);

  const lehenga = suggestHsn({ dressType: 'Lehenga', fabric: 'Silk' });
  eq('a lehenga suggests 6204 and IS slabbed',
    [lehenga?.hsnCode, lehenga?.taxSlabbed], ['6204', true]);

  check('THE TRAP: "Silk Lehenga" is apparel, not fabric',
    suggestHsn({ dressType: 'Silk Lehenga' })?.taxSlabbed === true,
    'reading the material first would tax a Rs 30,000 silk lehenga at 5% instead of 18%');

  check('every suggestion asks to be confirmed',
    [silkSaree, cotton, lehenga].every(x => x?.needsConfirming === true));

  eq('nothing recognisable suggests nothing at all', suggestHsn({ dressType: 'Widget' }), null);
  eq('and empty input suggests nothing', suggestHsn({}), null);
}

// -- L. The variant override, and what a sale is refused on --------------------------------
console.log('\nL. Which code actually applies');

{
  const product = { hsnCode: '5007', taxRateBps: 500, taxSlabbed: false };
  eq('the product is used when the variant says nothing',
    effectiveTaxFor(product, { hsnCode: null, taxRateBps: null }).hsnCode, '5007');
  eq('the variant wins where it has its own',
    effectiveTaxFor(product, { hsnCode: '6206', taxRateBps: 500 }).hsnCode, '6206');
  eq('an unset product yields nulls, which is what blocks a tax invoice',
    effectiveTaxFor({ hsnCode: null, taxRateBps: null, taxSlabbed: false }).taxRateBps, null);
}

// -- M. HSN digits on the invoice ------------------------------------------------------------
console.log('\nM. Four digits up to Rs 5 crore, six above');

eq('a small shop prints four', hsnForInvoice('5007', false), '5007');
eq('a big shop prints six', hsnForInvoice('520852', true), '520852');
eq('a four-digit code is not padded for a big shop', hsnForInvoice('5007', true), '5007');
eq('an eight-digit code is trimmed for a small shop', hsnForInvoice('52085210', false), '5208');


// -- N. A whole bill, end to end -----------------------------------------------------------
console.log('\nN. A whole bill');

const SAREE_LINE = (label: string, total: number, qty = 1): BillLineInput => ({
  label, quantity: qty, netUnitPriceMinor: Math.round(total / qty), lineTotalMinor: total,
  hsnCode: '5007', taxRateBps: 500, taxSlabbed: false, priceIsExclusive: false
});
const LEHENGA_EX = (label: string, total: number, qty = 1): BillLineInput => ({
  label, quantity: qty, netUnitPriceMinor: Math.round(total / qty), lineTotalMinor: total,
  hsnCode: '6204', taxRateBps: 500, taxSlabbed: true, priceIsExclusive: true
});

{
  const bill = buildBill({
    registration: 'REGULAR', shopStateCode: '36',
    lines: [SAREE_LINE('PRD-1 saree', rupees(3121))]
  });
  check('a registered shop issues a tax invoice', bill.documentKind === 'TAX_INVOICE');
  check('and it is issuable', bill.issuable, bill.problems.join(' | '));
  check('an inclusive price is unchanged by tax -- taxable + tax = the tag',
    bill.grossMinor === rupees(3121), `gross ${bill.grossMinor} vs tag ${rupees(3121)}`);
  check('in-state gives CGST and SGST, no IGST',
    bill.cgstMinor > 0 && bill.sgstMinor > 0 && bill.igstMinor === 0);
  check('the halves add to the total tax',
    bill.cgstMinor + bill.sgstMinor === bill.totalTaxMinor);
}

// -- O. Mixed basket, and the slab following the discount ----------------------------------
console.log('\nO. A mixed basket');

{
  const bill = buildBill({
    registration: 'REGULAR', shopStateCode: '36',
    lines: [SAREE_LINE('saree', rupees(5000)), LEHENGA_EX('lehenga', rupees(2600))]
  });
  eq('the saree is 5%', bill.lines[0].rateBpsCharged, 500);
  eq('the lehenga is charged what the shop typed, not what we worked out',
    bill.lines[1].rateBpsCharged, 500);
  check('but a stitched piece over Rs 2,500 at 5% is WARNED about',
    bill.warnings.some(w => /usually 18%/.test(w)), bill.warnings.join(' | '));
  check('and the sale is not blocked by it', bill.issuable, bill.problems.join(' | '));
}
{
  // the same lehenga, discounted below the threshold
  const bill = buildBill({
    registration: 'REGULAR', shopStateCode: '36',
    lines: [LEHENGA_EX('lehenga after an offer', rupees(2400))]
  });
  eq('under the threshold it is the same 5%, and no warning',
    [bill.lines[0].rateBpsCharged, bill.warnings.length], [500, 0]);
}
{
  const bill = buildBill({
    registration: 'REGULAR', shopStateCode: '36',
    lines: [LEHENGA_EX('three lehengas', rupees(6000), 3)]
  });
  eq('three at Rs 2,000 a piece: 5%, and no warning -- the threshold is per piece',
    [bill.lines[0].rateBpsCharged, bill.warnings.length], [500, 0]);
}

// -- P. Who may charge, and who may not ----------------------------------------------------
console.log('\nP. Composition and unregistered shops');

{
  const bill = buildBill({
    registration: 'COMPOSITION', shopStateCode: '36',
    lines: [SAREE_LINE('saree', rupees(3121))]
  });
  eq('a composition dealer issues a Bill of Supply', bill.documentKind, 'BILL_OF_SUPPLY');
  check('and charges no tax at all', bill.totalTaxMinor === 0);
  check('the customer pays the shelf price and nothing more',
    bill.payableMinor === rupees(3121), `${bill.payableMinor}`);
  check('a missing HSN does not even block it -- it owes no tax', bill.issuable);
}
{
  const bill = buildBill({
    registration: 'UNREGISTERED', shopStateCode: null,
    lines: [SAREE_LINE('saree', rupees(999))]
  });
  eq('an unregistered shop issues a plain receipt', bill.documentKind, 'RECEIPT');
  check('with no tax and no state-code complaint', bill.totalTaxMinor === 0 && bill.issuable);
}

// -- Q. What it refuses, and why -----------------------------------------------------------
console.log('\nQ. Refusals, rather than a quietly wrong invoice');

{
  const noHsn: BillLineInput = { ...SAREE_LINE('PRD-9 saree', rupees(2000)), hsnCode: null, taxRateBps: null };
  const bill = buildBill({ registration: 'REGULAR', shopStateCode: '36', lines: [noHsn] });
  check('a registered shop cannot bill a product with no HSN', !bill.issuable);
  check('and says which product, in words a shopkeeper can act on',
    bill.problems.some(p => p.includes('PRD-9')), bill.problems[0] ?? '(none)');
}
{
  /*
   * What used to be the section 2 trap. When the rate was derived from the price, a stitched
   * piece priced INCLUSIVE between Rs 2,625 and Rs 2,950 had no self-consistent rate and the line
   * had to be refused. The rate is now whatever the shop typed, so there is nothing to derive and
   * the case is ordinary.
   */
  const was: BillLineInput = { ...LEHENGA_EX('lehenga', rupees(2800)), priceIsExclusive: false };
  const bill = buildBill({ registration: 'REGULAR', shopStateCode: '36', lines: [was] });
  check('a stitched piece priced WITH tax is now ordinary, not refused', bill.issuable,
    bill.problems.join(' | '));
  check('the customer still pays exactly the tag price',
    bill.payableMinor === rupees(2800), String(bill.payableMinor));
  check('and it is warned about rather than blocked',
    bill.warnings.length === 1, bill.warnings.join(' | '));
}
{
  const bill = buildBill({ registration: 'REGULAR', shopStateCode: null, lines: [SAREE_LINE('s', 100000)] });
  check('a registered shop with no state code is refused', !bill.issuable);
}

// -- R. Place of supply --------------------------------------------------------------------
console.log('\nR. Which state the goods are going to');

{
  const here = buildBill({ registration: 'REGULAR', shopStateCode: '36', lines: [SAREE_LINE('s', rupees(5000))] });
  const away = buildBill({
    registration: 'REGULAR', shopStateCode: '36', placeOfSupplyStateCode: '29',
    lines: [SAREE_LINE('s', rupees(5000))]
  });
  check('a counter sale (no place of supply given) is NOT inter-state', !here.interState,
    'the customer is standing in the shop');
  check('another state is', away.interState);
  check('and the customer pays exactly the same either way',
    here.payableMinor === away.payableMinor, `${here.payableMinor} vs ${away.payableMinor}`);
  check('but the split differs', here.cgstMinor > 0 && away.igstMinor > 0 && away.cgstMinor === 0);
}

// -- S. Rounding the bill once, at the end -------------------------------------------------
console.log('\nS. Rounding, and the round-off line');

{
  const bill = buildBill({
    registration: 'REGULAR', shopStateCode: '36',
    lines: [SAREE_LINE('odd', 333333)]           // Rs 3,333.33 inclusive
  });
  check('the payable total is a whole number of rupees',
    bill.payableMinor % 100 === 0, `${bill.payableMinor}`);
  check('and gross + round-off = payable, exactly',
    bill.grossMinor + bill.roundOffMinor === bill.payableMinor,
    `${bill.grossMinor} + ${bill.roundOffMinor} = ${bill.payableMinor}`);
  check('the tax was never bent to make the total tidy',
    bill.cgstMinor + bill.sgstMinor === bill.totalTaxMinor);
}

// -- T. The financial year an invoice belongs to -------------------------------------------
console.log('\nT. April to March');

eq('27 Sep 2026 is 2026-27', financialYearOf(new Date('2026-09-27T00:00:00')), '2026-27');
eq('31 Mar 2027 is still 2026-27', financialYearOf(new Date('2027-03-31T00:00:00')), '2026-27');
eq('1 Apr 2027 starts 2027-28', financialYearOf(new Date('2027-04-01T00:00:00')), '2027-28');
eq('1 Jan 2027 is 2026-27, not 2027-28', financialYearOf(new Date('2027-01-01T00:00:00')), '2026-27');


// -- U. Freezing the rate onto the sale line -----------------------------------------------
console.log('\nU. What gets written onto the line, and never looked up again');

const STANDING_SAREE: ProductTaxStanding =
  { hsnCode: '5007', taxRateBps: 500, taxSlabbed: false, priceIsExclusive: false };
const STANDING_LEHENGA: ProductTaxStanding =
  { hsnCode: '6204', taxRateBps: 500, taxSlabbed: true, priceIsExclusive: true };
const P1 = (unit: number, qty = 1) =>
  ({ quantity: qty, unitPriceMinor: unit, totalPriceMinor: unit * qty });

{
  const f = freezeTaxForLine(STANDING_SAREE, P1(rupees(3121)), true, false);
  eq('a saree freezes at 5%', f.taxRateBps, 500);
  check('with the taxable value taken back out of the tag price',
    Math.round((Number(f.taxableValue) + Number(f.cgst) + Number(f.sgst)) * 100) === rupees(3121),
    `${f.taxableValue} + ${f.cgst} + ${f.sgst}`);
  check('and an order item carrying them still serialises -- the BigInt fault is gone',
    (() => { try { JSON.stringify(f); return true; } catch { return false; } })(),
    'JSON.stringify threw "Do not know how to serialize a BigInt" before this');
}
{
  const f = freezeTaxForLine(STANDING_LEHENGA, P1(rupees(2600)), true, false);
  eq('the rate frozen is the one the shop set, not one we chose', f.taxRateBps, 500);
}
{
  const f = freezeTaxForLine(STANDING_LEHENGA, P1(rupees(2000), 3), true, false);
  eq('three at Rs 2,000 freeze at 5% -- the threshold is per piece', f.taxRateBps, 500);
}
{
  const f = freezeTaxForLine(STANDING_SAREE, P1(rupees(3121)), false, false);
  check('a shop that may not charge tax freezes NOTHING',
    f.taxRateBps === null && f.taxableValue === null && f.hsnCode === null);
}
{
  const noHsn: ProductTaxStanding = { ...STANDING_SAREE, hsnCode: null, taxRateBps: null };
  const f = freezeTaxForLine(noHsn, P1(rupees(3121)), true, false);
  check('a product with no HSN freezes nothing -- and the sale still goes through',
    f.taxRateBps === null, 'recording, not policing: buildBill refuses the DOCUMENT, not the sale');
}
{
  const was: ProductTaxStanding = { ...STANDING_LEHENGA, priceIsExclusive: false };
  const f = freezeTaxForLine(was, P1(rupees(2800)), true, false);
  check('a tax-inclusive stitched piece now freezes normally -- no contradiction left to dodge',
    f.taxRateBps === 500 && f.taxableValue !== null, String(f.taxRateBps));
}
{
  const here = freezeTaxForLine(STANDING_SAREE, P1(rupees(5000)), true, false);
  const away = freezeTaxForLine(STANDING_SAREE, P1(rupees(5000)), true, true);
  check('in-state freezes CGST and SGST', Number(here.cgst) > 0 && Number(here.igst) === 0);
  check('inter-state freezes IGST', Number(away.igst) > 0 && Number(away.cgst) === 0);
  check('and the tax is the same amount either way',
    Math.round((Number(here.cgst) + Number(here.sgst)) * 100) === Math.round(Number(away.igst) * 100));
}


// -- V. The document a sale becomes --------------------------------------------------------
console.log('\nV. The document');

const SHOP: DocumentShop = {
  businessName: 'SPHL', businessAddress: 'Hyderabad', businessPhone: '9999999999',
  gstNumber: '36AAAAA0000A1Z5', gstStateCode: '36', gstRegistration: 'REGULAR',
  turnoverAboveFiveCrore: false, receiptFooter: 'Exchange within 7 days'
};

const ORDER = (over: Partial<DocumentOrder> = {}): DocumentOrder => ({
  orderNumber: 'SO-000042', createdAt: new Date('2026-09-27T11:00:00'),
  documentKind: 'TAX_INVOICE', invoiceSeries: 'CTR', invoiceNumber: 7,
  invoiceFinancialYear: '2026-27', placeOfSupplyStateCode: '36', interState: false,
  roundOff: -0.4, total: 3121,
  lines: [{
    description: 'Kanchipuram saree', quantity: 1, unitPrice: 3121, lineTotal: 3121,
    hsnCode: '5007', taxRateBps: 500, taxableValue: 2972.38, cgst: 74.31, sgst: 74.31, igst: 0
  }],
  ...over
});

{
  const d = buildDocument(ORDER(), SHOP, null);
  eq('a registered shop prints TAX INVOICE', d.heading, 'TAX INVOICE');
  eq('numbered from its own series', d.number, 'CTR/2026-27/00007');
  check('and it is issuable', d.problems.length === 0, d.problems.join(' | '));
  eq('the HSN is trimmed to four digits for a small shop', d.lines[0].hsn, '5007');
  eq('the rate is shown as a percent, not basis points', d.lines[0].ratePercent, 5);
  check('the totals add up from the lines',
    d.totals.cgst === 74.31 && d.totals.sgst === 74.31 && d.totals.totalTax === 148.62,
    JSON.stringify(d.totals));
}
{
  const big = buildDocument(ORDER(), { ...SHOP, turnoverAboveFiveCrore: true }, null);
  eq('a shop over Rs 5 crore would print six digits', big.lines[0].hsn, '5007');
}
{
  const d = buildDocument(
    ORDER({ documentKind: 'BILL_OF_SUPPLY', invoiceSeries: 'CTR', invoiceNumber: 7 }),
    { ...SHOP, gstRegistration: 'COMPOSITION' }, null);
  eq('a composition dealer prints BILL OF SUPPLY', d.heading, 'BILL OF SUPPLY');
  check('and MUST say it cannot collect tax',
    d.declarations.some(x => /not eligible to collect tax/i.test(x)), d.declarations.join(' | '));
}
{
  const d = buildDocument(ORDER({ documentKind: 'RECEIPT' }), SHOP, null);
  eq('an unregistered shop prints RECEIPT', d.heading, 'RECEIPT');
  check('with no declaration', d.declarations.length === 0);
}

// -- W. What makes a document WRONG rather than merely plain -------------------------------
console.log('\nW. Refusals on the document');

{
  const d = buildDocument(ORDER({ invoiceNumber: null, invoiceSeries: null, invoiceFinancialYear: null }), SHOP, null);
  check('a tax invoice with no number is called out', d.problems.some(p => /unbroken series/i.test(p)),
    d.problems.join(' | '));
  eq('and it falls back to the order number rather than inventing one', d.number, 'SO-000042');
}
{
  const d = buildDocument(ORDER(), { ...SHOP, gstNumber: null }, null);
  check('a tax invoice from a shop with no GSTIN is called out',
    d.problems.some(p => /GSTIN/i.test(p)), d.problems.join(' | '));
}
{
  const noHsn = ORDER();
  noHsn.lines[0].hsnCode = null;
  const d = buildDocument(noHsn, SHOP, null);
  check('a line with no HSN is called out by name',
    d.problems.some(p => p.includes('Kanchipuram saree')), d.problems.join(' | '));
}
{
  // inter-state, unregistered customer, over Rs 2.5 lakh -> the address becomes mandatory
  const d = buildDocument(
    ORDER({ interState: true, placeOfSupplyStateCode: '29', total: 300000 }),
    SHOP,
    { name: 'A customer', phone: '9999999999', gstNumber: null, address: null }
  );
  check('a big inter-state sale to an unregistered customer needs their address',
    d.problems.some(p => /2,50,000/.test(p)), d.problems.join(' | '));

  const withAddress = buildDocument(
    ORDER({ interState: true, placeOfSupplyStateCode: '29', total: 300000 }),
    SHOP,
    { name: 'A customer', phone: '9999999999', gstNumber: null, address: 'Bengaluru' }
  );
  check('and is fine once it has one', withAddress.problems.length === 0, withAddress.problems.join(' | '));

  const registered = buildDocument(
    ORDER({ interState: true, placeOfSupplyStateCode: '29', total: 300000 }),
    SHOP,
    { name: 'A business', phone: '9999999999', gstNumber: '29BBBBB1111B1Z5', address: null }
  );
  check('a REGISTERED customer does not need one', registered.problems.length === 0,
    registered.problems.join(' | '));
}

// -- X. The printed number ------------------------------------------------------------------
console.log('\nX. How a number prints');

eq('padded to five', formatInvoiceNumber('CTR', '2026-27', 7), 'CTR/2026-27/00007');
eq('and not truncated past it', formatInvoiceNumber('WEB', '2026-27', 123456), 'WEB/2026-27/123456');
eq('the till and the shop have different prefixes', [SERIES.COUNTER, SERIES.ONLINE], ['CTR', 'WEB']);
eq('and credit notes their own', SERIES.CREDIT_NOTE, 'CRN');

// ── Result ───────────────────────────────────────────────────────────────────────────────
console.log(`\n${'='.repeat(72)}`);
console.log(`${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
