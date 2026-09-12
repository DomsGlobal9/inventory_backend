/**
 * A Shopify store set up from nothing, and the orders that arrived before it was.
 *
 * verify-shopify-order-ingestion wrote its location pairing and product matches straight into the
 * database, because nothing in the application could create them. So Phase 1 passed its tests
 * and could not have placed a single real order. This suite starts where a merchant starts: a
 * store connected, NOTHING paired, and orders already arriving.
 *
 * The story it walks through, in the order a shop would live it:
 *
 *   1. orders arrive -- created, updated, shipped, twice refunded -- and all of it parks
 *   2. the inbox shows ONE order with ONE reason, not five rows
 *   3. the merchant pairs a location; the order moves on to the next thing it needs
 *   4. the merchant matches products; the order is placed from its NEWEST payload, then shipped,
 *      then refunded -- in that order, each exactly once
 *
 * and then the ways it goes wrong: ambiguous SKUs, a location already taken, two retries racing,
 * a dismissal with no reason, a store nobody has claimed, an uninstall, another tenant.
 *
 * No Shopify account: the store is a fake that answers GraphQL with whatever this file imagines.
 *
 *   npx tsx src/scripts/verify-shopify-inbox.ts
 */
import { prisma } from '../lib/prisma';
import {
  shopifyOrderIngestService, shopifyFulfilmentService, shopifyRefundService, shopifyInboxService
} from '../services/shopify-orders';
import {
  shopifyLocationPairingService, shopifyVariantMatchingService, planMatches, ShopifyAdminApi, numericShopifyId
} from '../services/shopify-mapping';
import { shopifyInstallationService } from '../services/shopify-installation.service';

let passed = 0, failed = 0;
const failures: string[] = [];
const check = (name: string, ok: boolean, detail?: string) => {
  if (ok) { passed++; console.log(`  [PASS] ${name}`); }
  else { failed++; failures.push(name); console.log(`  [FAIL] ${name}${detail ? `  -> ${detail}` : ''}`); }
};

async function refuses(name: string, fragment: string, fn: () => Promise<any>) {
  try { await fn(); check(name, false, 'it was accepted'); }
  catch (e: any) {
    const msg = String(e?.message ?? e);
    check(name, msg.toLowerCase().includes(fragment.toLowerCase()), `"${msg}"`);
  }
}

const STAMP = Date.now();
const CLIENT = `inbox-${STAMP}`;
const OTHER = `inbox-other-${STAMP}`;
const SHOP = `inbox-${STAMP}.myshopify.com`;
const ORPHAN = `inbox-orphan-${STAMP}.myshopify.com`;
const num = (v: any) => Number(v);

let shopId = '';
let godownId = '';
const V: Record<string, string> = {};

/** Shopify's side of the store: its locations and its variants, as GraphQL returns them. */
const STORE = {
  locations: [
    { id: 'gid://shopify/Location/7001', name: 'Chirala shop', isActive: true, fulfillsOnlineOrders: true, address: { city: 'Chirala' } },
    { id: 'gid://shopify/Location/7002', name: 'Back room', isActive: true, fulfillsOnlineOrders: false, address: { city: null } }
  ],
  variants: [
    { id: 'gid://shopify/ProductVariant/9001', sku: `sar-${STAMP} `, title: 'Maroon', product: { id: 'gid://shopify/Product/4001', title: 'Kanchipuram Saree' }, inventoryItem: { id: 'gid://shopify/InventoryItem/3001' } },
    { id: 'gid://shopify/ProductVariant/9002', sku: `BLS-${STAMP}`, title: 'Default Title', product: { id: 'gid://shopify/Product/4002', title: 'Blouse' }, inventoryItem: { id: 'gid://shopify/InventoryItem/3002' } },
    // Two Shopify variants, one SKU -- must never be guessed.
    { id: 'gid://shopify/ProductVariant/9003', sku: `DUP-${STAMP}`, title: 'Red', product: { id: 'gid://shopify/Product/4003', title: 'Dupatta' }, inventoryItem: null },
    { id: 'gid://shopify/ProductVariant/9004', sku: `DUP-${STAMP}`, title: 'Blue', product: { id: 'gid://shopify/Product/4003', title: 'Dupatta' }, inventoryItem: null },
    // Only in Shopify.
    { id: 'gid://shopify/ProductVariant/9005', sku: `ONLY-SHOPIFY-${STAMP}`, title: 'Default Title', product: { id: 'gid://shopify/Product/4004', title: 'Stole' }, inventoryItem: null },
    // No SKU at all.
    { id: 'gid://shopify/ProductVariant/9006', sku: '', title: 'Default Title', product: { id: 'gid://shopify/Product/4005', title: 'Gift card' }, inventoryItem: null }
  ]
};

let graphqlCalls = 0;
/** Pages variants two at a time, so pagination is exercised rather than assumed. */
const fakeStore: ShopifyAdminApi = {
  async graphql(query: string, variables: any = {}) {
    graphqlCalls++;
    if (query.includes('locations(')) {
      return { locations: { nodes: STORE.locations, pageInfo: { hasNextPage: false, endCursor: null } } } as any;
    }
    if (query.includes('productVariants(')) {
      const start = variables.after ? Number(variables.after) : 0;
      const page = STORE.variants.slice(start, start + 2);
      const next = start + 2;
      return {
        productVariants: {
          nodes: page,
          pageInfo: { hasNextPage: next < STORE.variants.length, endCursor: String(next) }
        }
      } as any;
    }
    throw new Error('the fake store was asked something it does not know');
  }
};

let nextOrder = 880000 + (STAMP % 1000);
const orderPayload = (over: any = {}) => ({
  id: ++nextOrder,
  name: `#${nextOrder % 10000}`,
  created_at: '2026-09-12T09:00:00Z',
  currency: 'INR',
  updated_at: '2026-09-12T10:00:00Z',
  financial_status: 'paid',
  fulfillment_status: null,
  location_id: 7001,
  total_tax: '0.00',
  total_discounts: '0.00',
  total_price: '12800.00',
  line_items: [
    { variant_id: 9001, quantity: 1, price: '12000.00', discount_allocations: [] },
    { variant_id: 9002, quantity: 1, price: '800.00', discount_allocations: [] }
  ],
  discount_applications: [],
  customer: { id: 5501, first_name: 'Lakshmi', last_name: 'D', email: `inbox${STAMP}@example.com`, phone: '+919000000009' },
  ...over
});

const stockOf = (variantId: string) =>
  prisma.inventoryStock.findFirstOrThrow({ where: { variantId, locationId: shopId }, select: { quantity: true, reservedQty: true } });

async function main() {
  // ── SETUP ──────────────────────────────────────────────────────────────
  console.log('SETUP: a connected Shopify store with nothing paired and nothing matched');

  shopId = (await prisma.stockLocation.create({
    data: { clientId: CLIENT, name: 'Chirala Showroom', code: 'CHIRALA', type: 'STORE', active: true }
  })).id;
  godownId = (await prisma.stockLocation.create({
    data: { clientId: CLIENT, name: 'Godown', code: 'GODOWN', type: 'WAREHOUSE', active: true }
  })).id;
  const closed = await prisma.stockLocation.create({
    data: { clientId: CLIENT, name: 'Old branch', code: 'OLD', type: 'STORE', active: false }
  });

  const product = await prisma.product.create({
    data: {
      clientId: CLIENT, productCode: 'PRD-IN', title: 'Kanchipuram Saree', slug: `in-${STAMP}`,
      category: 'WOMEN', basePrice: 12000, status: 'ACTIVE', productType: 'READY_TO_WEAR'
    }
  });
  for (const [key, sku, price] of [
    ['saree', `SAR-${STAMP}`, 12000], ['blouse', `bls-${STAMP}`, 800],
    ['dupatta', `DUP-${STAMP}`, 900], ['twinA', `TWIN-${STAMP}`, 100], ['twinB', ` twin-${STAMP}`, 100]
  ] as const) {
    const v = await prisma.productVariant.create({
      data: {
        clientId: CLIENT, productId: product.id, sku, variantCode: `VAR-${key}-${STAMP}`,
        size: 'Free', colorName: 'Red', sellingPrice: price, averageCost: 100
      }
    });
    V[key] = v.id;
    await prisma.inventoryStock.create({
      data: { clientId: CLIENT, variantId: v.id, locationId: shopId, quantity: 20, reservedQty: 0 }
    });
  }

  await prisma.shopifyInstallation.create({
    data: { shopDomain: SHOP, clientId: CLIENT, source: 'SCALEEZY', accessTokenEncrypted: 'unused', scopes: 'read_orders,read_products,read_locations' }
  });

  // ── A. THE DECISION, WITHOUT A STORE ───────────────────────────────────
  console.log('\nA. WHICH SKUS ARE UNMISTAKABLE (pure)');

  const sv = (id: string, sku: string, inv: string | null = null) =>
    ({ shopifyVariantId: id, shopifyProductId: '1', shopifyInventoryItemId: inv, sku, title: `v${id}` });

  const p1 = planMatches([sv('1', ' abc-1 ')], [{ id: 'o1', sku: 'ABC-1' }], []);
  check('a SKU matches however it is spaced or capitalised', p1.toCreate.length === 1 && p1.toCreate[0].variantId === 'o1');

  const p2 = planMatches([sv('1', 'X'), sv('2', 'x')], [{ id: 'o1', sku: 'X' }], []);
  check('two Shopify variants sharing a SKU are refused, not guessed', p2.toCreate.length === 0 && p2.problems.length === 1);

  const p3 = planMatches([sv('1', 'Y')], [{ id: 'o1', sku: 'Y' }, { id: 'o2', sku: ' y' }], []);
  check('two of ours sharing a SKU are refused, not guessed', p3.toCreate.length === 0 && p3.problems.length === 1);

  const p4 = planMatches([sv('1', '')], [], []);
  check('a Shopify variant with no SKU is counted, not matched', p4.blankSku === 1 && p4.toCreate.length === 0);

  const p5 = planMatches([sv('1', 'Z')], [{ id: 'o1', sku: 'Z' }], [{ variantId: 'o9', shopifyVariantId: '1', shopifyInventoryItemId: null }]);
  check('a Shopify variant already matched elsewhere is never re-pointed', p5.toCreate.length === 0 && p5.problems.length === 1);

  const p6 = planMatches([sv('1', 'Z')], [{ id: 'o1', sku: 'Z' }], [{ variantId: 'o1', shopifyVariantId: '2', shopifyInventoryItemId: null }]);
  check('one of ours already matched to another Shopify variant is never re-pointed', p6.toCreate.length === 0 && p6.problems.length === 1);

  const p7 = planMatches([sv('1', 'Z', '55')], [{ id: 'o1', sku: 'Z' }], [{ variantId: 'o1', shopifyVariantId: '1', shopifyInventoryItemId: null }]);
  check('an existing match is kept, and its inventory item refreshed', p7.alreadyMatched === 1 && p7.toRefresh.length === 1);

  check('gid://shopify/Location/7001 is stored as 7001, the webhook spelling',
    numericShopifyId('gid://shopify/Location/7001') === '7001' && numericShopifyId(7001) === '7001');

  // ── B. ORDERS ARRIVE BEFORE ANYTHING IS SET UP ─────────────────────────
  console.log('\nB. ORDERS ARRIVE BEFORE ANYTHING IS SET UP');

  const created = orderPayload();
  const first = await shopifyOrderIngestService.ingest(SHOP, created, 'orders/create');
  check('the first sale parks, because no location is paired', first.status === 'PARKED' && (first as any).reason === 'UNMAPPED_LOCATION',
    JSON.stringify(first));

  // The customer changed their mind about the blouse: two of them now.
  const updated = {
    ...created, updated_at: '2026-09-12T11:00:00Z', total_price: '13600.00',
    line_items: [created.line_items[0], { ...created.line_items[1], quantity: 2 }]
  };
  await shopifyOrderIngestService.ingest(SHOP, updated, 'orders/updated');

  const shipped = {
    ...updated, fulfillment_status: 'fulfilled',
    fulfillments: [{ id: 601, status: 'success', line_items: [{ variant_id: 9001, quantity: 1 }, { variant_id: 9002, quantity: 2 }] }]
  };
  const f = await shopifyFulfilmentService.apply(SHOP, shipped);
  check('its shipment is kept with it rather than dropped', f === 'PARKED', f);

  const refundA = { id: 71001 + (STAMP % 1000), order_id: created.id, refund_line_items: [{ quantity: 1, subtotal: '800.00', restock_type: 'return', line_item: { variant_id: 9002 } }] };
  const refundB = { id: 72001 + (STAMP % 1000), order_id: created.id, refund_line_items: [{ quantity: 1, subtotal: '800.00', restock_type: 'no_restock', line_item: { variant_id: 9002 } }] };
  check('its first refund is kept', (await shopifyRefundService.apply(SHOP, refundA)) === 'PARKED');
  check('  ...and its second, separately -- not written over the first',
    (await shopifyRefundService.apply(SHOP, refundB)) === 'PARKED');
  check('five events are waiting underneath',
    (await prisma.shopifyOrderInbox.count({ where: { shopDomain: SHOP, resolvedAt: null } })) === 5);

  const unrelatedShipment = await shopifyFulfilmentService.apply(SHOP, { ...orderPayload(), fulfillments: [] });
  check('a shipment for an order that is NOT waiting is ignored, not parked', unrelatedShipment === 'IGNORED', unrelatedShipment);

  // ── C. WHAT THE MERCHANT SEES ──────────────────────────────────────────
  console.log('\nC. THE INBOX SHOWS ONE ORDER, NOT FIVE ROWS');

  let inbox = await shopifyInboxService.list(CLIENT);
  check('one waiting order', inbox.total === 1, String(inbox.total));
  const entry = inbox.entries[0];
  check('  ...named as the customer saw it', entry?.orderName === created.name, entry?.orderName);
  check('  ...at its latest total', entry?.total === 13600, String(entry?.total));
  check('  ...with a reason in words', entry?.reasonLabel === 'Location not paired', entry?.reasonLabel);
  check('  ...and what to do about it', /pair your shopify locations/i.test(entry?.action ?? ''));
  check('  ...saying a shipment and two refunds wait behind it',
    entry?.alsoWaiting.shipment === true && entry?.alsoWaiting.refunds === 2, JSON.stringify(entry?.alsoWaiting));
  check('  ...and nothing about the customer beyond the order',
    !JSON.stringify(inbox).includes('+919000000009') && !JSON.stringify(inbox).includes('@example.com'));

  const summary = await shopifyInboxService.summary(CLIENT);
  check('the summary counts orders, not events', summary.waiting === 1, JSON.stringify(summary));

  const stillStuck = await shopifyInboxService.replay(CLIENT, entry.id, 'merchant');
  check('retrying before anything changed says it is still waiting, and why',
    stillStuck.status === 'WAITING' && (stillStuck as any).reason === 'UNMAPPED_LOCATION', JSON.stringify(stillStuck));
  check('  ...and places nothing', (await prisma.salesOrder.count({ where: { clientId: CLIENT } })) === 0);

  // ── D. PAIRING A LOCATION ──────────────────────────────────────────────
  console.log('\nD. PAIRING SHOPIFY LOCATIONS WITH OURS');

  const overview = await shopifyLocationPairingService.overview(CLIENT, fakeStore);
  check('both of the store\'s locations are listed', overview.shopifyLocations.length === 2);
  check('  ...unpaired', overview.shopifyLocations.every(l => l.pairedWith === null));
  check('  ...beside our ACTIVE locations only',
    overview.ourLocations.length === 2 && !overview.ourLocations.some(l => l.id === closed.id));

  await refuses('a Shopify location the store does not have is refused', 'no such location',
    () => shopifyLocationPairingService.pair(CLIENT, '99999', shopId, fakeStore));
  await refuses('an inactive location here cannot be paired', 'inactive',
    () => shopifyLocationPairingService.pair(CLIENT, '7001', closed.id, fakeStore));
  await refuses('another tenant\'s location cannot be paired', 'does not exist',
    () => shopifyLocationPairingService.pair(CLIENT, '7001', 'not-ours', fakeStore));

  const paired = await shopifyLocationPairingService.pair(CLIENT, 'gid://shopify/Location/7001', shopId, fakeStore);
  check('the shop floor is paired, from the GraphQL id', (paired as any).paired?.locationName === 'Chirala Showroom');
  const stored = await prisma.shopifyLocationMap.findFirst({ where: { clientId: CLIENT } });
  check('  ...and stored as the webhook spells it', stored?.shopifyLocationId === '7001', stored?.shopifyLocationId);

  await refuses('one of ours cannot be paired with a second Shopify location', 'already paired with shopify\'s chirala shop',
    () => shopifyLocationPairingService.pair(CLIENT, '7002', shopId, fakeStore));

  const again = await shopifyLocationPairingService.pair(CLIENT, '7001', shopId, fakeStore);
  check('pairing the same two again is harmless', !!(again as any).paired &&
    (await prisma.shopifyLocationMap.count({ where: { clientId: CLIENT } })) === 1);

  const afterPair = await shopifyInboxService.replayAll(CLIENT, 'merchant');
  check('retrying after pairing moves the order on', afterPair.placed === 0 && afterPair.stillWaiting === 1, JSON.stringify(afterPair));
  inbox = await shopifyInboxService.list(CLIENT);
  check('  ...to the next thing it needs: its products', inbox.entries[0]?.reason === 'UNMAPPED_VARIANT', inbox.entries[0]?.reason);

  // ── E. MATCHING PRODUCTS ───────────────────────────────────────────────
  console.log('\nE. MATCHING SHOPIFY PRODUCTS BY SKU');

  graphqlCalls = 0;
  const match = await shopifyVariantMatchingService.matchBySku(CLIENT, fakeStore);
  check('every page of the store was read', match.shopifyVariants === 6 && graphqlCalls === 3, `${match.shopifyVariants} variants, ${graphqlCalls} calls`);
  check('the saree and blouse are matched, despite spacing and capitals', match.newlyMatched === 2, String(match.newlyMatched));
  check('the duplicated SKU is reported, not matched',
    match.problems.examples.some(p => p.sku === `DUP-${STAMP}`), JSON.stringify(match.problems));
  check('the SKU that exists only in Shopify is listed', match.notHere.examples.some(n => n.sku === `ONLY-SHOPIFY-${STAMP}`));
  check('the variant with no SKU is counted', match.withoutSku === 1, String(match.withoutSku));

  const maps = await prisma.shopifyIdMap.findMany({ where: { clientId: CLIENT } });
  check('matches are stored in the webhook spelling, marked MATCHED',
    maps.some(m => m.shopifyVariantId === '9001' && m.variantId === V.saree && m.origin === 'MATCHED' && m.shopifyInventoryItemId === '3001'));

  const rerun = await shopifyVariantMatchingService.matchBySku(CLIENT, fakeStore);
  check('running it again changes nothing', rerun.newlyMatched === 0 && rerun.alreadyMatched === 2 &&
    (await prisma.shopifyIdMap.count({ where: { clientId: CLIENT } })) === 2, JSON.stringify({ n: rerun.newlyMatched, a: rerun.alreadyMatched }));

  // ── F. THE ORDER IS PLACED, THEN WHAT HAPPENED TO IT ───────────────────
  console.log('\nF. PLACED FROM ITS NEWEST STATE, THEN SHIPPED, THEN REFUNDED');

  const blouseBefore = await stockOf(V.blouse);
  const placed = await shopifyInboxService.replayAll(CLIENT, 'merchant');
  check('the order is placed', placed.placed === 1 && placed.stillWaiting === 0, JSON.stringify(placed));

  const so = await prisma.salesOrder.findFirstOrThrow({
    where: { clientId: CLIENT, externalOrderId: String(created.id) }, include: { items: true }
  });
  check('  ...exactly once', (await prisma.salesOrder.count({ where: { clientId: CLIENT } })) === 1);
  check('  ...from the UPDATED payload -- two blouses, not one',
    so.items.find(i => i.variantId === V.blouse)?.quantity === 2, String(so.items.find(i => i.variantId === V.blouse)?.quantity));
  check('  ...at the shop floor it was paired with', so.locationId === shopId);

  check('its waiting shipment was applied', so.status === 'DISPATCHED', so.status);
  check('  ...as a real dispatch', (await prisma.dispatch.count({ where: { clientId: CLIENT, salesOrderId: so.id } })) === 1);
  const blouseAfterShip = await stockOf(V.blouse);
  check('  ...leaving nothing reserved for a sale that has already shipped', blouseAfterShip.reservedQty === blouseBefore.reservedQty,
    `${blouseBefore.reservedQty} -> ${blouseAfterShip.reservedQty}`);

  const returns = await prisma.salesReturn.findMany({ where: { clientId: CLIENT }, orderBy: { createdAt: 'asc' } });
  check('both refunds were applied, once each', returns.length === 2 &&
    returns.some(r => r.externalRefundId === String(refundA.id)) && returns.some(r => r.externalRefundId === String(refundB.id)),
    returns.map(r => r.externalRefundId).join(','));
  // 20 on the shelf, two shipped, one refund restocked and one not: 19. Measured against the
  // start rather than a mid-point, because the shipment and both refunds all ran inside the one
  // retry and there is no moment in between to read.
  check('  ...the restocked one put a blouse back and the other did not',
    (await stockOf(V.blouse)).quantity === blouseBefore.quantity - 2 + 1,
    `${blouseBefore.quantity} -> ${(await stockOf(V.blouse)).quantity}`);

  check('nothing is left waiting', (await shopifyInboxService.list(CLIENT)).total === 0);
  const resolved = await shopifyInboxService.list(CLIENT, 'resolved');
  check('the settled order shows what it became', resolved.entries[0]?.orderNumber === so.orderNumber, resolved.entries[0]?.orderNumber ?? 'none');
  check('  ...and who settled it', resolved.entries[0]?.resolvedBy === 'merchant', resolved.entries[0]?.resolvedBy ?? 'none');

  await refuses('a settled order cannot be retried again', 'already been settled',
    () => shopifyInboxService.replay(CLIENT, entry.id, 'merchant'));

  // A webhook redelivering the refund after all this must not refund twice.
  check('a redelivered refund is recognised', (await shopifyRefundService.apply(SHOP, refundA)) === 'DUPLICATE');

  // ── G. TWO RETRIES AT ONCE ─────────────────────────────────────────────
  console.log('\nG. TWO PEOPLE PRESS RETRY AT THE SAME MOMENT');

  await prisma.shopifyLocationMap.deleteMany({ where: { clientId: CLIENT } });
  const raced = orderPayload({ line_items: [{ variant_id: 9001, quantity: 1, price: '12000.00', discount_allocations: [] }], total_price: '12000.00' });
  await shopifyOrderIngestService.ingest(SHOP, raced, 'orders/create');
  await shopifyLocationPairingService.pair(CLIENT, '7001', shopId, fakeStore);

  const racedRow = await prisma.shopifyOrderInbox.findFirstOrThrow({ where: { shopDomain: SHOP, shopifyOrderId: String(raced.id) } });
  const both = await Promise.allSettled([
    shopifyInboxService.replay(CLIENT, racedRow.id, 'a'),
    shopifyInboxService.replay(CLIENT, racedRow.id, 'b')
  ]);
  check('one order, not two', (await prisma.salesOrder.count({ where: { clientId: CLIENT, externalOrderId: String(raced.id) } })) === 1);
  check('  ...and no scary FAILED row left for the loser',
    (await prisma.shopifyOrderInbox.count({ where: { shopDomain: SHOP, shopifyOrderId: String(raced.id), reason: 'FAILED', resolvedAt: null } })) === 0,
    both.map(b => b.status === 'rejected' ? String((b.reason as any)?.message) : JSON.stringify((b as any).value)).join(' | '));

  // ── H. DISMISSING ──────────────────────────────────────────────────────
  console.log('\nH. AN ORDER THAT SHOULD NEVER BE PLACED');

  const dollars = orderPayload({ currency: 'USD' });
  const parkedUsd = await shopifyOrderIngestService.ingest(SHOP, dollars, 'orders/create');
  check('an order in dollars parks rather than being converted', (parkedUsd as any).reason === 'CURRENCY_MISMATCH', JSON.stringify(parkedUsd));
  const usdRow = (await shopifyInboxService.list(CLIENT)).entries.find(e => e.shopifyOrderId === String(dollars.id))!;

  await refuses('dismissing without a reason is refused', 'say why',
    () => shopifyInboxService.dismiss(CLIENT, usdRow.id, 'merchant', ''));
  await refuses('"na" is not a reason', 'say why',
    () => shopifyInboxService.dismiss(CLIENT, usdRow.id, 'merchant', 'na'));

  await shopifyInboxService.dismiss(CLIENT, usdRow.id, 'merchant', 'Test order from the Shopify theme preview');
  const dismissed = await prisma.shopifyOrderInbox.findUniqueOrThrow({ where: { id: usdRow.id } });
  check('it is settled with the reason kept', !!dismissed.resolvedAt && dismissed.detail === 'Dismissed: Test order from the Shopify theme preview', dismissed.detail ?? '');
  check('  ...and nothing was placed', (await prisma.salesOrder.count({ where: { clientId: CLIENT, externalOrderId: String(dollars.id) } })) === 0);

  // ── I. ANOTHER TENANT ──────────────────────────────────────────────────
  console.log('\nI. ANOTHER WORKSPACE CANNOT TOUCH THESE');

  const other = await shopifyOrderIngestService.ingest(SHOP, orderPayload({ currency: 'EUR' }), 'orders/create');
  const otherRow = await prisma.shopifyOrderInbox.findFirstOrThrow({ where: { shopDomain: SHOP, resolvedAt: null, reason: (other as any).reason } });
  check('another workspace sees none of them', (await shopifyInboxService.list(OTHER)).total === 0);
  await refuses('  ...cannot retry one by id', 'no longer here', () => shopifyInboxService.replay(OTHER, otherRow.id));
  await refuses('  ...cannot dismiss one by id', 'no longer here', () => shopifyInboxService.dismiss(OTHER, otherRow.id, 'x', 'Not mine at all'));
  await refuses('  ...and has no store to pair locations for', 'no shopify store',
    () => shopifyLocationPairingService.overview(OTHER, fakeStore));

  // ── J. A STORE NOBODY HAS CLAIMED ──────────────────────────────────────
  console.log('\nJ. ORDERS FOR A STORE NOBODY HAS CLAIMED YET');

  await prisma.shopifyInstallation.create({
    data: { shopDomain: ORPHAN, clientId: null, source: 'SHOPIFY', accessTokenEncrypted: 'unused', scopes: 'read_orders' }
  });
  const orphanOrder = orderPayload();
  const orphan = await shopifyOrderIngestService.ingest(ORPHAN, orphanOrder, 'orders/create');
  check('it parks as unclaimed', (orphan as any).reason === 'UNCLAIMED_INSTALL', JSON.stringify(orphan));
  check('  ...its refund is kept with it', (await shopifyRefundService.apply(ORPHAN, { ...refundA, id: 73001, order_id: orphanOrder.id })) === 'PARKED');
  const visibleBefore = (await shopifyInboxService.list(CLIENT)).entries.some(e => e.shopDomain === ORPHAN);
  check('  ...and no workspace can see it', !visibleBefore);

  await shopifyInstallationService.claim(ORPHAN, CLIENT, 'merchant');
  const attached = await shopifyInboxService.attachClaimed(ORPHAN, CLIENT);
  check('claiming the store gives its waiting events an owner', attached === 2, String(attached));
  check('  ...and they appear in that workspace\'s inbox as one order',
    (await shopifyInboxService.list(CLIENT)).entries.filter(e => e.shopDomain === ORPHAN).length === 1);

  // ── K. UNINSTALLED ─────────────────────────────────────────────────────
  console.log('\nK. THE APP IS UNINSTALLED');

  const closedCount = await shopifyInboxService.closeForUninstall(ORPHAN);
  check('everything waiting for that store is closed', closedCount === 2, String(closedCount));
  check('  ...with the reason said', (await prisma.shopifyOrderInbox.findFirstOrThrow({ where: { shopDomain: ORPHAN } })).detail?.includes('uninstalled') === true);
  check('  ...so no Retry button is left that could never work',
    !(await shopifyInboxService.list(CLIENT)).entries.some(e => e.shopDomain === ORPHAN));

  // ── L. UNPAIRING ───────────────────────────────────────────────────────
  console.log('\nL. UNPAIRING');
  const unpaired = await shopifyLocationPairingService.pair(CLIENT, '7001', null, fakeStore);
  check('a pairing can be removed', (unpaired as any).unpaired === true &&
    (await prisma.shopifyLocationMap.count({ where: { clientId: CLIENT } })) === 0);
}

main()
  .catch(e => { console.error('\nSUITE CRASHED:', e); failed++; failures.push('suite crashed'); })
  .finally(async () => {
    for (const clientId of [CLIENT, OTHER]) {
      await prisma.salesReturnItem.deleteMany({ where: { salesReturn: { clientId } } });
      await prisma.salesReturn.deleteMany({ where: { clientId } });
      await prisma.salesLedger.deleteMany({ where: { clientId } });
      await prisma.dispatchItem.deleteMany({ where: { dispatch: { clientId } } });
      await prisma.dispatch.deleteMany({ where: { clientId } });
      await prisma.salesOrderItemDiscount.deleteMany({ where: { salesOrderItem: { salesOrder: { clientId } } } });
      await prisma.salesOrderDiscount.deleteMany({ where: { salesOrder: { clientId } } });
      await prisma.inventoryReservation.deleteMany({ where: { clientId } });
      await prisma.inventoryTransaction.deleteMany({ where: { clientId } });
      await prisma.inventoryStock.deleteMany({ where: { clientId } });
      await prisma.salesOrderItem.deleteMany({ where: { salesOrder: { clientId } } });
      await prisma.salesOrder.deleteMany({ where: { clientId } });
      await prisma.customer.deleteMany({ where: { clientId } });
      await prisma.shopifyIdMap.deleteMany({ where: { clientId } });
      await prisma.shopifyLocationMap.deleteMany({ where: { clientId } });
      await prisma.productVariant.deleteMany({ where: { clientId } });
      await prisma.product.deleteMany({ where: { clientId } });
      await prisma.stockLocation.deleteMany({ where: { clientId } });
      await prisma.clientSequence.deleteMany({ where: { clientId } });
    }
    await prisma.shopifyOrderInbox.deleteMany({ where: { shopDomain: { in: [SHOP, ORPHAN] } } });
    await prisma.shopifyInstallation.deleteMany({ where: { shopDomain: { in: [SHOP, ORPHAN] } } });
    await prisma.$disconnect();

    console.log(`\nRESULT: ${passed} passed | ${failed} failed`);
    if (failures.length) console.log('Failures:\n  - ' + failures.join('\n  - '));
    process.exit(failed ? 1 : 0);
  });
