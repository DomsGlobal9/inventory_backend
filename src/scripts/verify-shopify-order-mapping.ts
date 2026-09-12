/**
 * A Shopify order, read correctly, before any of it touches a database.
 *
 * `mapping.ts` is pure, which is the whole reason Phase 1 is testable today: Shopify's
 * protected-customer-data approval is a human review that gates live orders on real stores, and
 * none of these checks need it, a webhook, or a tenant.
 *
 * The payloads below are Shopify's own shapes -- `price` is the unit price BEFORE discounts and
 * `discount_allocations` carry what actually came off, which is the single most common thing to
 * get backwards in this integration.
 *
 *   npx tsx src/scripts/verify-shopify-order-mapping.ts
 */
import { mapShopifyOrder, statusFor, MappingContext } from '../services/shopify-orders/mapping';

let passed = 0, failed = 0;
const failures: string[] = [];
const check = (name: string, ok: boolean, detail?: string) => {
  if (ok) { passed++; console.log(`  [PASS] ${name}`); }
  else { failed++; failures.push(name); console.log(`  [FAIL] ${name}${detail ? `  -> ${detail}` : ''}`); }
};

const ctx: MappingContext = {
  locationId: 'loc-main',
  currency: 'INR',
  variants: new Map([
    ['9001', { variantId: 'our-saree', averageCostMinor: 700000, sku: 'SAREE-RED-FS' }],
    ['9002', { variantId: 'our-blouse', averageCostMinor: 30000, sku: 'BLOUSE-RED-M' }],
    ['9003', { variantId: 'our-gift', averageCostMinor: 12000, sku: 'GIFT-BOX' }]
  ])
};

/** A Shopify order with sensible defaults, so each test states only what it is about. */
const order = (over: any = {}) => ({
  id: 5001,
  currency: 'INR',
  updated_at: '2026-09-12T10:00:00Z',
  financial_status: 'paid',
  fulfillment_status: null,
  total_tax: '0.00',
  total_discounts: '0.00',
  total_price: '12000.00',
  line_items: [
    { variant_id: 9001, sku: 'SAREE-RED-FS', quantity: 1, price: '12000.00', discount_allocations: [] }
  ],
  discount_applications: [],
  customer: { id: 7001, first_name: 'Akshaya', last_name: 'R', email: 'a@example.com', phone: '9990001111' },
  ...over
});

const ok = (r: any) => { if (!r.ok) throw new Error('expected a mapped order, got ' + r.reason + ': ' + r.detail); return r.order; };

function main() {
  // ── A. STATUS ──────────────────────────────────────────────────────────
  console.log('\nA. TWO SHOPIFY STATUSES BECOME ONE OF OURS');

  check('paid and unfulfilled is CONFIRMED', statusFor('paid', null) === 'CONFIRMED');
  check('paid and partly fulfilled', statusFor('paid', 'partial') === 'PARTIALLY_DISPATCHED');
  check('paid and fulfilled', statusFor('paid', 'fulfilled') === 'DISPATCHED');
  check('refunded is cancelled', statusFor('refunded', 'fulfilled') === 'CANCELLED');
  check('voided is cancelled', statusFor('voided', null) === 'CANCELLED');
  check('restocked is cancelled whatever the money says',
    statusFor('paid', 'restocked') === 'CANCELLED');
  check('unpaid is a DRAFT and reserves nothing', statusFor('pending', null) === 'DRAFT');
  check('an authorised-but-uncaptured order reserves nothing either',
    statusFor('authorized', null) === 'DRAFT');
  check('a status we have never seen is treated as unpaid',
    statusFor('something_new', null) === 'DRAFT');

  // ── B. A PLAIN ORDER ───────────────────────────────────────────────────
  console.log('\nB. A PLAIN PAID ORDER');

  const plain = ok(mapShopifyOrder(order(), ctx));
  check('the Shopify id is kept as the external id', plain.externalOrderId === '5001');
  check('one line, matched to our variant', plain.lines.length === 1 && plain.lines[0].variantId === 'our-saree');
  check('list and net are the same when nothing came off',
    plain.lines[0].listUnitPriceMinor === 1200000 && plain.lines[0].totalPriceMinor === 1200000);
  check('our cost is used, not theirs', plain.lines[0].unitCostMinor === 700000);
  check('the totals agree with Shopify', plain.totalMinor === plain.shopifyTotalMinor);
  check('nothing to reconcile', plain.reconcileWarning === null, String(plain.reconcileWarning));
  check('the customer is identified, not a guest', plain.customer.isGuest === false);
  check('  ...by their Shopify id', plain.customer.shopifyCustomerId === '7001');

  // ── C. DISCOUNTS ───────────────────────────────────────────────────────
  console.log('\nC. WHAT ACTUALLY CAME OFF');

  const discounted = ok(mapShopifyOrder(order({
    total_discounts: '2400.00',
    total_price: '9600.00',
    line_items: [{
      variant_id: 9001, quantity: 1, price: '12000.00',
      discount_allocations: [{ amount: '2400.00', discount_application_index: 0 }]
    }],
    discount_applications: [{ title: 'Deepavali Sale', code: 'DEEPAVALI' }]
  }), ctx));

  check('Shopify `price` is the LIST price, not the net',
    discounted.lines[0].listUnitPriceMinor === 1200000, String(discounted.lines[0].listUnitPriceMinor));
  check('the allocation is the discount', discounted.lines[0].lineDiscountMinor === 240000);
  check('the net is what was charged', discounted.lines[0].totalPriceMinor === 960000);
  check('the order total matches Shopify exactly',
    discounted.totalMinor === 960000 && discounted.shopifyTotalMinor === 960000);
  check('the discount is recorded with the name the customer saw',
    discounted.discounts.length === 1 && discounted.discounts[0].title === 'Deepavali Sale');
  check('  ...and its code, for matching back later', discounted.discounts[0].externalId === 'DEEPAVALI');
  check('  ...and the amount it actually took off', discounted.discounts[0].amountMinor === 240000);

  const twoOnOneLine = ok(mapShopifyOrder(order({
    total_discounts: '3000.00', total_price: '9000.00',
    line_items: [{
      variant_id: 9001, quantity: 1, price: '12000.00',
      discount_allocations: [
        { amount: '2400.00', discount_application_index: 0 },
        { amount: '600.00', discount_application_index: 1 }
      ]
    }],
    discount_applications: [{ title: 'Deepavali Sale' }, { title: 'Loyalty' }]
  }), ctx));
  check('two discounts on one line are both counted',
    twoOnOneLine.lines[0].lineDiscountMinor === 300000, String(twoOnOneLine.lines[0].lineDiscountMinor));
  check('  ...and each is attributed to its own rule',
    twoOnOneLine.discounts[0].amountMinor === 240000 && twoOnOneLine.discounts[1].amountMinor === 60000);

  // ── D. WHEN SHOPIFY'S SUMS DO NOT ADD UP ───────────────────────────────
  console.log("\nD. WHEN SHOPIFY'S OWN SUMS DO NOT ADD UP");

  const unallocated = ok(mapShopifyOrder(order({
    total_discounts: '500.00', total_price: '12300.00',
    line_items: [
      { variant_id: 9001, quantity: 1, price: '12000.00', discount_allocations: [] },
      { variant_id: 9002, quantity: 1, price: '800.00', discount_allocations: [] }
    ]
  }), ctx));
  const spread = unallocated.lines.reduce((s, l) => s + l.allocatedDiscountMinor, 0);
  check('a discount Shopify did not allocate is spread across the lines',
    spread === 50000, String(spread));
  check('  ...and said out loud rather than absorbed',
    !!unallocated.reconcileWarning && /allocated/.test(unallocated.reconcileWarning!),
    String(unallocated.reconcileWarning));
  check('  ...leaving the lines adding up to the order',
    unallocated.lines.reduce((s, l) => s + l.totalPriceMinor, 0) === unallocated.totalMinor);

  const mismatched = ok(mapShopifyOrder(order({ total_price: '11999.00' }), ctx));
  check('a total that disagrees with ours is ingested anyway',
    mismatched.lines.length === 1);
  check('  ...and flagged with both figures',
    !!mismatched.reconcileWarning && /11999/.test(mismatched.reconcileWarning!),
    String(mismatched.reconcileWarning));

  const overAllocated = ok(mapShopifyOrder(order({
    total_discounts: '20000.00', total_price: '0.00',
    line_items: [{
      variant_id: 9001, quantity: 1, price: '12000.00',
      discount_allocations: [{ amount: '20000.00', discount_application_index: 0 }]
    }],
    discount_applications: [{ title: 'Oops' }]
  }), ctx));
  check('a discount larger than its line is clamped, not refused',
    overAllocated.lines[0].totalPriceMinor === 0, String(overAllocated.lines[0].totalPriceMinor));
  check('  ...and never goes negative',
    overAllocated.lines.every(l => l.totalPriceMinor >= 0));

  // ── E. ODD LINES ───────────────────────────────────────────────────────
  console.log('\nE. LINES A REAL SHOP PRODUCES');

  const withGift = ok(mapShopifyOrder(order({
    total_price: '12000.00',
    line_items: [
      { variant_id: 9001, quantity: 1, price: '12000.00', discount_allocations: [] },
      { variant_id: 9003, quantity: 1, price: '0.00', discount_allocations: [] }
    ]
  }), ctx));
  check('a free gift line is accepted',
    withGift.lines[1].totalPriceMinor === 0 && withGift.lines.length === 2);
  check('  ...and does not change the order total', withGift.totalMinor === 1200000);

  const uneven = ok(mapShopifyOrder(order({
    total_discounts: '41.68', total_price: '7458.32',
    line_items: [{
      variant_id: 9001, quantity: 3, price: '2500.00',
      discount_allocations: [{ amount: '41.68', discount_application_index: 0 }]
    }],
    discount_applications: [{ title: 'Small' }]
  }), ctx));
  check('a line with no whole-paisa unit price still totals exactly',
    uneven.lines[0].totalPriceMinor === 745832, String(uneven.lines[0].totalPriceMinor));
  check('  ...and its unit price is the rounded net',
    uneven.lines[0].unitPriceMinor === 248611, String(uneven.lines[0].unitPriceMinor));

  // ── F. TAX AND SHIPPING ────────────────────────────────────────────────
  console.log('\nF. TAX AND SHIPPING ARE RECORDED, NOT COMPUTED');

  const shippedNew = ok(mapShopifyOrder(order({
    total_tax: '540.00',
    total_shipping_price_set: { shop_money: { amount: '120.00', currency_code: 'INR' } },
    total_price: '12660.00'
  }), ctx));
  check('tax comes across untouched', shippedNew.taxMinor === 54000);
  check('shipping is read from total_shipping_price_set', shippedNew.shippingMinor === 12000);
  check('  ...and the total includes both', shippedNew.totalMinor === 1266000);

  const shippedOld = ok(mapShopifyOrder(order({
    shipping_lines: [{ price: '80.00' }, { price: '40.00' }],
    total_price: '12120.00'
  }), ctx));
  check('the older shipping_lines shape is read too',
    shippedOld.shippingMinor === 12000, String(shippedOld.shippingMinor));

  // ── G. WHO BOUGHT IT ───────────────────────────────────────────────────
  console.log('\nG. WHO BOUGHT IT');

  const guest = ok(mapShopifyOrder(order({ customer: null, email: null }), ctx));
  check('no customer and no email is a guest', guest.customer.isGuest === true);

  const byEmail = ok(mapShopifyOrder(order({ customer: null, email: 'walkin@example.com' }), ctx));
  check('an email alone is enough to not be a guest', byEmail.customer.isGuest === false);
  check('  ...and it is carried through', byEmail.customer.email === 'walkin@example.com');

  const addressed = ok(mapShopifyOrder(order({
    shipping_address: { first_name: 'A', last_name: 'R', address1: '12 Main St', city: 'Chennai', zip: '600001', country: 'India' }
  }), ctx));
  check('an address becomes one readable line',
    addressed.customer.shippingAddress === 'A R, 12 Main St, Chennai, 600001, India',
    String(addressed.customer.shippingAddress));

  // ── H. WHAT IT REFUSES ─────────────────────────────────────────────────
  console.log('\nH. WHAT IT REFUSES, AND WHY');

  const foreign = mapShopifyOrder(order({ currency: 'USD' }), ctx);
  check('a foreign currency is parked, never converted',
    !foreign.ok && foreign.reason === 'CURRENCY_MISMATCH', JSON.stringify(foreign));

  const unknownVariant = mapShopifyOrder(order({
    line_items: [{ variant_id: 8888, sku: 'NEVER-SEEN', quantity: 1, price: '500.00' }]
  }), ctx);
  check('a product we do not know is parked, not invented',
    !unknownVariant.ok && unknownVariant.reason === 'UNMAPPED_VARIANT', JSON.stringify(unknownVariant));
  check('  ...and the message names the SKU so it can be fixed',
    !unknownVariant.ok && /NEVER-SEEN/.test(unknownVariant.detail), JSON.stringify(unknownVariant));

  const noLines = mapShopifyOrder(order({ line_items: [] }), ctx);
  check('an order with no lines is refused', !noLines.ok && noLines.reason === 'FAILED');

  const noId = mapShopifyOrder({ currency: 'INR', line_items: [] }, ctx);
  check('a payload with no id is refused', !noId.ok && noId.reason === 'FAILED');

  const badQty = mapShopifyOrder(order({
    line_items: [{ variant_id: 9001, quantity: 0, price: '12000.00' }]
  }), ctx);
  check('a line with no quantity is refused', !badQty.ok && badQty.reason === 'FAILED');

  // ── I. THE SAME ORDER, TWICE ───────────────────────────────────────────
  console.log('\nI. THE SAME PAYLOAD MAPPED TWICE');

  const a = ok(mapShopifyOrder(order({ total_discounts: '500.00', total_price: '12300.00',
    line_items: [
      { variant_id: 9001, quantity: 1, price: '12000.00', discount_allocations: [] },
      { variant_id: 9002, quantity: 1, price: '800.00', discount_allocations: [] }
    ] }), ctx));
  const b = ok(mapShopifyOrder(order({ total_discounts: '500.00', total_price: '12300.00',
    line_items: [
      { variant_id: 9001, quantity: 1, price: '12000.00', discount_allocations: [] },
      { variant_id: 9002, quantity: 1, price: '800.00', discount_allocations: [] }
    ] }), ctx));
  check('mapping is deterministic, down to the allocation',
    JSON.stringify(a) === JSON.stringify(b));
}

try { main(); } catch (e: any) { console.error('\nSUITE CRASHED:', e?.message ?? e); failed++; failures.push('crashed'); }
console.log(`\nRESULT: ${passed} passed | ${failed} failed`);
if (failures.length) console.log('Failures:\n  - ' + failures.join('\n  - '));
process.exit(failed ? 1 : 0);
