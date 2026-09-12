/**
 * A Shopify order arriving, in a throwaway shop that is deleted at the end.
 *
 * verify-shopify-order-mapping proves the reading. This proves the writing: idempotency, the
 * decisions that must be parked rather than guessed, the guest customer, reservations, and the
 * money landing on the line as the net price.
 *
 * No webhook and no Shopify account -- the service is called directly with the payloads Shopify
 * sends. Shopify's protected-customer-data approval gates live orders on a real store; it does
 * not gate any of this.
 *
 *   npx tsx src/scripts/verify-shopify-order-ingestion.ts
 */
import { prisma } from '../lib/prisma';
import { shopifyOrderIngestService, shopifyOrderCancelService } from '../services/shopify-orders';

let passed = 0, failed = 0;
const failures: string[] = [];
const check = (name: string, ok: boolean, detail?: string) => {
  if (ok) { passed++; console.log(`  [PASS] ${name}`); }
  else { failed++; failures.push(name); console.log(`  [FAIL] ${name}${detail ? `  -> ${detail}` : ''}`); }
};

const STAMP = Date.now();
const CLIENT = `shopify-${STAMP}`;
const SHOP = `test-${STAMP}.myshopify.com`;
const ORPHAN_SHOP = `unclaimed-${STAMP}.myshopify.com`;
const num = (v: any) => Number(v);

let installationId = '';
let locationId = '';
const variantIds: Record<string, string> = {};
const SHOPIFY_VARIANT = { saree: '9001', blouse: '9002' };

let nextOrderId = 6000;
const order = (over: any = {}) => ({
  id: ++nextOrderId,
  currency: 'INR',
  updated_at: '2026-09-12T10:00:00Z',
  financial_status: 'paid',
  fulfillment_status: null,
  total_tax: '0.00',
  total_discounts: '0.00',
  total_price: '12000.00',
  line_items: [{ variant_id: Number(SHOPIFY_VARIANT.saree), quantity: 1, price: '12000.00', discount_allocations: [] }],
  discount_applications: [],
  customer: { id: 7001, first_name: 'Akshaya', last_name: 'R', email: `a${STAMP}@example.com` },
  ...over
});

const ingest = (payload: any, topic = 'orders/create') =>
  shopifyOrderIngestService.ingest(SHOP, payload, topic);

const readOrder = (id: string) => prisma.salesOrder.findUniqueOrThrow({
  where: { id }, include: { items: { orderBy: { createdAt: 'asc' } }, discounts: true }
});

async function main() {
  // ── SET UP A THROWAWAY SHOP AND A CONNECTED STORE ──────────────────────
  const location = await prisma.stockLocation.create({
    data: { clientId: CLIENT, name: 'Main Store', code: 'MAIN', type: 'STORE', active: true }
  });
  locationId = location.id;

  const product = await prisma.product.create({
    data: {
      clientId: CLIENT, productCode: 'PRD-SHOP', title: 'Kanchipuram Silk Saree',
      slug: `kanchi-${STAMP}`, category: 'WOMEN', basePrice: 12000, status: 'ACTIVE',
      productType: 'READY_TO_WEAR'
    }
  });

  for (const [key, price, cost] of [['saree', 12000, 7000], ['blouse', 800, 300]] as const) {
    const v = await prisma.productVariant.create({
      data: {
        clientId: CLIENT, productId: product.id, sku: `SKU-${key.toUpperCase()}-${STAMP}`,
        variantCode: `VAR-${key.toUpperCase()}-${STAMP}`, size: 'Free Size', colorName: 'Red',
        sellingPrice: price, averageCost: cost
      }
    });
    variantIds[key] = v.id;
    await prisma.inventoryStock.create({
      data: { clientId: CLIENT, variantId: v.id, locationId, quantity: 100, reservedQty: 0 }
    });
  }

  const installation = await prisma.shopifyInstallation.create({
    data: {
      shopDomain: SHOP, clientId: CLIENT, source: 'SCALEEZY',
      accessTokenEncrypted: 'not-a-real-token', scopes: 'read_orders,read_products'
    }
  });
  installationId = installation.id;

  await prisma.shopifyLocationMap.create({
    data: { installationId, clientId: CLIENT, locationId, shopifyLocationId: '5500' }
  });

  for (const key of ['saree', 'blouse'] as const) {
    await prisma.shopifyIdMap.create({
      data: {
        installationId, clientId: CLIENT, variantId: variantIds[key],
        sku: `SKU-${key.toUpperCase()}-${STAMP}`,
        shopifyProductId: '4000', shopifyVariantId: SHOPIFY_VARIANT[key], origin: 'CREATED'
      }
    });
  }

  // ── A. AN ORDINARY ONLINE SALE ─────────────────────────────────────────
  console.log('\nA. AN ORDINARY ONLINE SALE');

  const plain: any = await ingest(order());
  check('it is ingested', plain.status === 'APPLIED', JSON.stringify(plain));
  const plainOrder = await readOrder(plain.salesOrderId);
  check('recorded against the online channel', plainOrder.channel === 'ONLINE');
  check('and the shop it sold from', plainOrder.locationId === locationId);
  check('priced as EXTERNAL, not re-priced from our catalogue',
    plainOrder.items[0].priceSource === 'EXTERNAL');
  check('confirmed, so the stock is held', plainOrder.status === 'CONFIRMED', plainOrder.status);

  const stock = await prisma.inventoryStock.findFirstOrThrow({ where: { variantId: variantIds.saree, locationId } });
  check('  ...and it really is reserved', stock.reservedQty === 1, String(stock.reservedQty));
  check('physical stock has not moved yet', stock.quantity === 100, String(stock.quantity));

  /*
   * An ONLINE order carries no location_id -- Shopify sets that on POS orders only. A rule that
   * demanded one would park every single web sale, which is the whole point of this phase.
   */
  check('an order naming no Shopify location still finds the shop',
    plainOrder.locationId === locationId);

  // ── B. WHAT THE CUSTOMER ACTUALLY PAID ─────────────────────────────────
  console.log('\nB. WHAT THE CUSTOMER ACTUALLY PAID');

  const discounted: any = await ingest(order({
    total_discounts: '2400.00', total_price: '9600.00',
    line_items: [{
      variant_id: Number(SHOPIFY_VARIANT.saree), quantity: 1, price: '12000.00',
      discount_allocations: [{ amount: '2400.00', discount_application_index: 0 }]
    }],
    discount_applications: [{ title: 'Deepavali Sale', code: 'DEEPAVALI' }]
  }));
  const d = await readOrder(discounted.salesOrderId);
  check('the gross is remembered', num(d.items[0].listUnitPrice) === 12000);
  check('the discount is remembered', num(d.items[0].lineDiscount) === 2400);
  check('the net is what was charged', num(d.items[0].totalPrice) === 9600);
  check('GROSS PROFIT IS FROM THE NET', num(d.items[0].grossProfit) === 9600 - 7000,
    `${d.items[0].grossProfit}`);
  check('the order total is the discounted one', num(d.total) === 9600, String(d.total));
  check("the discount is recorded under Shopify's name for it",
    d.discounts.length === 1 && d.discounts[0].title === 'Deepavali Sale');
  check('  ...marked as theirs, not one of ours',
    d.discounts[0].source === 'SHOPIFY' && d.discounts[0].offerId === null);
  const allocs = await prisma.salesOrderItemDiscount.findMany({
    where: { salesOrderItem: { salesOrderId: d.id } }
  });
  check('  ...and divided across the line it came off',
    allocs.length === 1 && num(allocs[0].amount) === 2400);

  // ── C. THE SAME ORDER, AGAIN AND AGAIN ─────────────────────────────────
  console.log('\nC. THE SAME ORDER, AGAIN AND AGAIN');

  const repeatable = order({ id: 6500 });
  const first: any = await ingest(repeatable);
  const second: any = await ingest(repeatable);
  // STALE, not APPLIED: the identical payload carries the identical `updated_at`, so there is
  // nothing newer to apply. That is the right answer and it is what makes redelivery free --
  // the work is skipped rather than redone.
  check('a redelivered webhook is recognised as nothing new',
    second.status === 'STALE', JSON.stringify(second));

  const rowCount = await prisma.salesOrder.count({
    where: { clientId: CLIENT, externalOrderId: '6500', sourceSystem: 'SHOPIFY' }
  });
  check('  ...and exactly one row exists', rowCount === 1, String(rowCount));

  const older: any = await ingest({ ...repeatable, updated_at: '2026-09-12T09:00:00Z', total_price: '1.00' },
    'orders/updated');
  check('an OLDER version of an order is dropped, not applied',
    older.status === 'STALE', JSON.stringify(older));
  const unchanged = await readOrder(first.salesOrderId);
  check('  ...so the order still says what it said', num(unchanged.total) === 12000, String(unchanged.total));

  const newer: any = await ingest({
    ...repeatable, updated_at: '2026-09-12T11:00:00Z',
    total_discounts: '1000.00', total_price: '11000.00',
    line_items: [{
      variant_id: Number(SHOPIFY_VARIANT.saree), quantity: 1, price: '12000.00',
      discount_allocations: [{ amount: '1000.00', discount_application_index: 0 }]
    }],
    discount_applications: [{ title: 'Late discount' }]
  }, 'orders/updated');
  check('a NEWER version is applied', newer.status === 'APPLIED', JSON.stringify(newer));
  const updated = await readOrder(first.salesOrderId);
  check('  ...and the money follows it', num(updated.total) === 11000, String(updated.total));
  check('  ...without duplicating the lines', updated.items.length === 1, String(updated.items.length));
  check('  ...or the discounts', updated.discounts.length === 1, String(updated.discounts.length));

  // ── D. THINGS THAT NEED A PERSON ───────────────────────────────────────
  console.log('\nD. THINGS THAT NEED A PERSON TO DECIDE');

  const foreign: any = await ingest(order({ currency: 'USD' }));
  check('a foreign currency is parked, never converted',
    foreign.status === 'PARKED' && foreign.reason === 'CURRENCY_MISMATCH', JSON.stringify(foreign));

  const unknown: any = await ingest(order({
    line_items: [{ variant_id: 8888, sku: 'NEVER-SEEN', quantity: 1, price: '500.00' }]
  }));
  check('a product we do not have is parked', unknown.status === 'PARKED' && unknown.reason === 'UNMAPPED_VARIANT');

  const phantom = await prisma.product.count({ where: { clientId: CLIENT } });
  check('  ...and NO product was invented for it', phantom === 1, `${phantom} products exist`);

  const badLocation: any = await ingest(order({ location_id: 9999 }));
  check('an unpaired Shopify location is parked',
    badLocation.status === 'PARKED' && badLocation.reason === 'UNMAPPED_LOCATION', JSON.stringify(badLocation));

  const parked = await prisma.shopifyOrderInbox.findMany({ where: { clientId: CLIENT, resolvedAt: null } });
  check('every parked order is waiting in the inbox', parked.length === 3, `${parked.length} parked`);
  check('  ...each with the payload needed to replay it',
    parked.every(p => p.payload && typeof p.payload === 'object'));
  check('  ...and a reason a person can act on',
    parked.every(p => (p.detail ?? '').length > 10), JSON.stringify(parked.map(p => p.detail)));

  // The same unmapped order delivered twice must not queue twice.
  await ingest(order({ id: 7777, location_id: 9999 }));
  await ingest(order({ id: 7777, location_id: 9999 }));
  const twice = await prisma.shopifyOrderInbox.findMany({ where: { clientId: CLIENT, shopifyOrderId: '7777' } });
  check('a redelivered unmapped order updates its row, it does not queue again',
    twice.length === 1 && twice[0].attempts === 2, `${twice.length} rows, attempts ${twice[0]?.attempts}`);

  // ── E. PARKED, THEN FIXED ──────────────────────────────────────────────
  console.log('\nE. PARKED, THEN FIXED');

  // A SECOND of our locations, paired with the Shopify one the parked order named. It has to be
  // a different location of ours: ShopifyLocationMap is unique on (installation, location) in
  // both directions, so one shop floor pairs with exactly one Shopify location.
  const online = await prisma.stockLocation.create({
    data: { clientId: CLIENT, name: 'Online Store', code: 'ONLINE', type: 'ONLINE', active: true }
  });
  for (const key of ['saree', 'blouse'] as const) {
    await prisma.inventoryStock.create({
      data: { clientId: CLIENT, variantId: variantIds[key], locationId: online.id, quantity: 100, reservedQty: 0 }
    });
  }
  await prisma.shopifyLocationMap.create({
    data: { installationId, clientId: CLIENT, locationId: online.id, shopifyLocationId: '9999' }
  });
  const replayed: any = await ingest(order({ id: 7777, location_id: 9999 }));
  check('replaying after the mapping exists places the order', replayed.status === 'APPLIED', JSON.stringify(replayed));
  const cleared = await prisma.shopifyOrderInbox.findFirstOrThrow({
    where: { clientId: CLIENT, shopifyOrderId: '7777' }
  });
  check('  ...and the inbox row closes itself', cleared.resolvedAt !== null);
  check('  ...pointing at the order it became', cleared.salesOrderId === replayed.salesOrderId);

  // With TWO Shopify locations now paired, an order that names none is genuinely ambiguous --
  // and every web sale names none. This is the case that would have parked a real shop's entire
  // online trade, so it is checked both ways round.
  const ambiguous: any = await ingest(order({ id: 7800 }));
  check('with two locations paired and none named, it parks rather than guessing',
    ambiguous.status === 'PARKED' && ambiguous.reason === 'UNMAPPED_LOCATION', JSON.stringify(ambiguous));

  await prisma.storefrontConnection.create({
    data: {
      clientId: CLIENT, name: 'Shopify', type: 'SHOPIFY', status: 'ACTIVE',
      baseUrl: `https://${SHOP}`, credentialHash: 'x', credentialPrefix: 'sk_test',
      locationIds: [online.id]
    }
  });
  const resolved: any = await ingest(order({ id: 7800 }));
  check('saying which location the store sells from settles it',
    resolved.status === 'APPLIED', JSON.stringify(resolved));
  const settled = await readOrder(resolved.salesOrderId);
  check('  ...and the order lands there', settled.locationId === online.id);

  // ── F. WHO BOUGHT IT ───────────────────────────────────────────────────
  console.log('\nF. WHO BOUGHT IT');

  await ingest(order({ id: 8001, customer: null, email: null }));
  await ingest(order({ id: 8002, customer: null, email: null }));
  const guests = await prisma.customer.findMany({ where: { clientId: CLIENT, externalCustomerId: 'shopify:guest' } });
  check('two guest checkouts share ONE guest customer', guests.length === 1, `${guests.length} guest rows`);
  check('  ...called something a merchant will understand', guests[0].name === 'Online guest');
  check('  ...and marked as a walk-in', guests[0].customerType === 'WALK_IN');

  const known = await prisma.customer.findMany({
    where: { clientId: CLIENT, externalCustomerId: 'shopify:7001' }
  });
  check('a returning Shopify customer is matched, not duplicated', known.length === 1, `${known.length} rows`);

  await ingest(order({ id: 8003, customer: { id: 7001, first_name: 'Akshaya', last_name: 'Renamed', email: 'new@example.com' } }));
  const stillOne = await prisma.customer.count({ where: { clientId: CLIENT, externalCustomerId: 'shopify:7001' } });
  check('  ...even after they change their email', stillOne === 1, `${stillOne} rows`);

  // ── G. AN UNCLAIMED STORE ──────────────────────────────────────────────
  console.log('\nG. A STORE NOBODY HAS CLAIMED');

  await prisma.shopifyInstallation.create({
    data: { shopDomain: ORPHAN_SHOP, clientId: null, source: 'SHOPIFY',
            accessTokenEncrypted: 'not-a-real-token', scopes: 'read_orders' }
  });
  const orphan: any = await shopifyOrderIngestService.ingest(ORPHAN_SHOP, order({ id: 9100 }), 'orders/create');
  check('an order for an unclaimed store is parked, not guessed at',
    orphan.status === 'PARKED' && orphan.reason === 'UNCLAIMED_INSTALL', JSON.stringify(orphan));
  const orphanOrders = await prisma.salesOrder.count({ where: { externalOrderId: '9100' } });
  check('  ...and no tenant got somebody else\'s sale', orphanOrders === 0, String(orphanOrders));

  // ── H. CALLED OFF ──────────────────────────────────────────────────────
  console.log('\nH. CALLED OFF');

  const live: any = await ingest(order({ id: 9200 }));
  // Read the stock at the location the order ACTUALLY used. By this point the store has been
  // told which location it sells from, so that is Online Store, not the one this suite started
  // with -- asserting against the wrong shelf would have passed for the wrong reason.
  const liveOrder = await readOrder(live.salesOrderId);
  const soldFrom = liveOrder.locationId;
  const beforeCancel = await prisma.inventoryStock.findFirstOrThrow({
    where: { variantId: variantIds.saree, locationId: soldFrom }, select: { reservedQty: true }
  });

  const outcome = await shopifyOrderCancelService.cancel(SHOP, { id: 9200 });
  check('cancelling in Shopify cancels it here', outcome === 'APPLIED', outcome);
  const cancelled = await readOrder(live.salesOrderId);
  check('  ...the order says so', cancelled.status === 'CANCELLED', cancelled.status);

  const afterCancel = await prisma.inventoryStock.findFirstOrThrow({
    where: { variantId: variantIds.saree, locationId: soldFrom }, select: { reservedQty: true }
  });
  check('  ...and the stock goes back on sale',
    afterCancel.reservedQty === beforeCancel.reservedQty - 1,
    `${beforeCancel.reservedQty} -> ${afterCancel.reservedQty}`);

  check('cancelling it twice is harmless',
    (await shopifyOrderCancelService.cancel(SHOP, { id: 9200 })) === 'DUPLICATE');
  check('cancelling an order we never had is harmless',
    (await shopifyOrderCancelService.cancel(SHOP, { id: 999999 })) === 'IGNORED');

  // ── I. EVERY ORDER THIS SUITE MADE, RECONCILED ─────────────────────────
  console.log('\nI. EVERY ORDER THIS SUITE MADE, RECONCILED');

  const all = await prisma.salesOrder.findMany({ where: { clientId: CLIENT }, include: { items: true } });
  const off = all.filter(o => {
    const net = o.items.reduce((s, i) => s + num(i.totalPrice), 0);
    return Math.abs(net + num(o.taxAmount) + num(o.shippingAmount) - num(o.total)) > 0.005;
  });
  check(`all ${all.length} ingested orders balance`, off.length === 0, off.map(o => o.orderNumber).join(', '));
  check('every one is marked as coming from Shopify',
    all.every(o => o.sourceSystem === 'SHOPIFY' && o.channel === 'ONLINE'));
  check('and none was priced from our own catalogue',
    all.every(o => o.items.every(i => i.priceSource === 'EXTERNAL')));
}

main()
  .catch(e => { console.error('\nSUITE CRASHED:', e); failed++; failures.push('suite crashed'); })
  .finally(async () => {
    await prisma.shopifyOrderInbox.deleteMany({ where: { shopDomain: { in: [SHOP, ORPHAN_SHOP] } } });
    await prisma.salesOrderItemDiscount.deleteMany({ where: { salesOrderItem: { salesOrder: { clientId: CLIENT } } } });
    await prisma.salesOrderDiscount.deleteMany({ where: { salesOrder: { clientId: CLIENT } } });
    await prisma.inventoryReservation.deleteMany({ where: { clientId: CLIENT } });
    await prisma.inventoryTransaction.deleteMany({ where: { clientId: CLIENT } });
    await prisma.inventoryStock.deleteMany({ where: { clientId: CLIENT } });
    await prisma.salesOrderItem.deleteMany({ where: { salesOrder: { clientId: CLIENT } } });
    await prisma.salesOrder.deleteMany({ where: { clientId: CLIENT } });
    await prisma.customer.deleteMany({ where: { clientId: CLIENT } });
    await prisma.storefrontConnection.deleteMany({ where: { clientId: CLIENT } });
    await prisma.shopifyIdMap.deleteMany({ where: { clientId: CLIENT } });
    await prisma.shopifyLocationMap.deleteMany({ where: { clientId: CLIENT } });
    await prisma.shopifyInstallation.deleteMany({ where: { shopDomain: { in: [SHOP, ORPHAN_SHOP] } } });
    await prisma.productVariant.deleteMany({ where: { clientId: CLIENT } });
    await prisma.product.deleteMany({ where: { clientId: CLIENT } });
    await prisma.stockLocation.deleteMany({ where: { clientId: CLIENT } });
    await prisma.clientSequence.deleteMany({ where: { clientId: CLIENT } });
    await prisma.$disconnect();

    console.log(`\nRESULT: ${passed} passed | ${failed} failed`);
    if (failures.length) console.log('Failures:\n  - ' + failures.join('\n  - '));
    process.exit(failed ? 1 : 0);
  });
