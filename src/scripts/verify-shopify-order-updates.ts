/**
 * Telling Shopify about the orders Logistics ships (29 Oct): fulfilled with tracking, tracking
 * corrected, delivery progress, cancelled, paid on delivery; Shopify's echo of our own fulfilment;
 * an order fulfilled by hand in Shopify; and every way the sending can go wrong.
 *
 * The order is ingested from a Shopify payload, packed with Logistics' own pack(), and moved by
 * Logistics' own updates (fromLogistics) -- the real paths. Shopify itself is a stand-in that keeps a
 * store's fulfilment orders, fulfilments and payment state and refuses what Shopify would refuse; the
 * real round trip needs the app's new permissions released and a test store (see the owner's steps).
 *
 * Throwaway shop, removed at the end. LOCAL DATABASE ONLY.
 *   DATABASE_URL=… DIRECT_URL=… npx tsx src/scripts/verify-shopify-order-updates.ts
 */
const LOCAL = 'localhost:55433';
if (!String(process.env.DATABASE_URL || '').includes(LOCAL) || !String(process.env.DIRECT_URL || '').includes(LOCAL)) {
  console.error(`Refusing to run: DATABASE_URL and DIRECT_URL must both point at the local copy (${LOCAL}).`);
  process.exit(2);
}

let passed = 0, failed = 0;
const failures: string[] = [];
const check = (name: string, ok: boolean, detail?: unknown) => {
  if (ok) { passed++; console.log(`  [PASS] ${name}`); }
  else { failed++; failures.push(name); console.log(`  [FAIL] ${name}${detail === undefined ? '' : `  -> ${JSON.stringify(detail).slice(0, 400)}`}`); }
};
const eq = (name: string, got: unknown, want: unknown) => check(name, JSON.stringify(got) === JSON.stringify(want), { got, want });

const STAMP = Date.now();
const C = `shopupd-${STAMP}`;
const SHOP = `upd-${STAMP}.myshopify.com`;
const ALL_SCOPES = 'read_orders,write_merchant_managed_fulfillment_orders,write_fulfillments,write_orders';
const SV = { saree: '7101', blouse: '7102' };
const EVENT_STATUSES = new Set(['ATTEMPTED_DELIVERY', 'CARRIER_PICKED_UP', 'CONFIRMED', 'DELAYED', 'DELIVERED', 'FAILURE', 'IN_TRANSIT', 'LABEL_PRINTED', 'LABEL_PURCHASED', 'OUT_FOR_DELIVERY', 'PICKED_UP', 'READY_FOR_PICKUP']);

/** Shopify, as far as these updates can tell: per order its fulfilment orders, fulfilments and payment. */
class StandInShopify {
  orders = new Map<string, { financial: string; fos: { id: string; status: string; lines: { id: string; variant: string; remaining: number }[] }[]; fulfillments: any[] }>();
  calls: { op: string; vars: any }[] = [];
  down = false;
  /** What the store has really approved, as Shopify itself would say. */
  granted = ALL_SCOPES.split(',');
  private n = 1;
  addOrder(numericId: string, lines: { variant: string; qty: number }[], financial = 'PENDING') {
    this.orders.set(`gid://shopify/Order/${numericId}`, {
      financial, fulfillments: [],
      fos: [{ id: `gid://shopify/FulfillmentOrder/${this.n++}`, status: 'OPEN', lines: lines.map(l => ({ id: `gid://shopify/FulfillmentOrderLineItem/${this.n++}`, variant: `gid://shopify/ProductVariant/${l.variant}`, remaining: l.qty })) }]
    });
  }
  /** Shopify's orders/fulfilled webhook for that order, from what it now holds. */
  webhook(numericId: string) {
    const o = this.orders.get(`gid://shopify/Order/${numericId}`)!;
    return { id: Number(numericId), fulfillments: o.fulfillments.map(f => ({ id: f.id, status: f.status === 'CANCELLED' ? 'cancelled' : 'success', line_items: f.lines.map((l: any) => ({ variant_id: Number(l.variant.split('/').pop()), quantity: l.quantity })) })) };
  }
  fulfilByHand(numericId: string, variant: string, qty: number) {
    const o = this.orders.get(`gid://shopify/Order/${numericId}`)!;
    const line = o.fos[0].lines.find(l => l.variant.endsWith(`/${variant}`))!;
    line.remaining -= qty;
    o.fulfillments.push({ id: `gid://shopify/Fulfillment/${this.n++}`, status: 'SUCCESS', lines: [{ variant: line.variant, quantity: qty }], events: [], byHand: true });
  }
  async graphql(query: string, vars: any = {}): Promise<any> {
    const op = /(fulfillmentCreate|fulfillmentTrackingInfoUpdate|fulfillmentEventCreate|fulfillmentCancel|orderMarkAsPaid|currentAppInstallation|order\(id)/.exec(query)?.[1] ?? 'unknown';
    this.calls.push({ op, vars });
    if (this.down) { const { ShopifyApiError } = await import('../services/shopify-mapping'); throw new ShopifyApiError('Could not reach the store. Try again in a moment.', 504); }
    const fulfilment = (id: string) => [...this.orders.values()].flatMap(o => o.fulfillments).find(f => f.id === id);
    switch (op) {
      case 'currentAppInstallation': return { currentAppInstallation: { accessScopes: this.granted.map(handle => ({ handle })) } };
      case 'order(id': {
        const o = this.orders.get(vars.id);
        return { order: o ? { id: vars.id, displayFinancialStatus: o.financial, fulfillmentOrders: { nodes: o.fos.map(fo => ({ id: fo.id, status: fo.status, lineItems: { nodes: fo.lines.map(l => ({ id: l.id, remainingQuantity: l.remaining, lineItem: { variant: { id: l.variant } } })) } })) } } : null };
      }
      case 'fulfillmentCreate': {
        const f = vars.f;
        const lines: any[] = [];
        for (const group of f.lineItemsByFulfillmentOrder ?? []) {
          const fo = [...this.orders.values()].flatMap(o => o.fos).find(x => x.id === group.fulfillmentOrderId);
          if (!fo || !['OPEN', 'IN_PROGRESS'].includes(fo.status)) return { fulfillmentCreate: { fulfillment: null, userErrors: [{ field: ['fulfillment'], message: 'Fulfillment order is not open.' }] } };
          for (const li of group.fulfillmentOrderLineItems) {
            const line = fo.lines.find(l => l.id === li.id);
            if (!line || li.quantity > line.remaining || li.quantity < 1) return { fulfillmentCreate: { fulfillment: null, userErrors: [{ field: ['fulfillment'], message: 'Invalid fulfillment order line item quantity requested.' }] } };
          }
          for (const li of group.fulfillmentOrderLineItems) { const line = fo.lines.find(l => l.id === li.id)!; line.remaining -= li.quantity; lines.push({ variant: line.variant, quantity: li.quantity }); }
        }
        const order = [...this.orders.values()].find(o => o.fos.some(fo => (f.lineItemsByFulfillmentOrder ?? []).some((g: any) => g.fulfillmentOrderId === fo.id)))!;
        const made = { id: `gid://shopify/Fulfillment/${this.n++}`, status: 'SUCCESS', lines, tracking: f.trackingInfo ?? null, notify: f.notifyCustomer, events: [] as any[] };
        order.fulfillments.push(made);
        return { fulfillmentCreate: { fulfillment: { id: made.id, status: made.status }, userErrors: [] } };
      }
      case 'fulfillmentTrackingInfoUpdate': {
        const f = fulfilment(vars.id);
        if (!f) return { fulfillmentTrackingInfoUpdate: { fulfillment: null, userErrors: [{ field: ['fulfillmentId'], message: 'Fulfillment does not exist.' }] } };
        f.tracking = vars.t; return { fulfillmentTrackingInfoUpdate: { fulfillment: { id: f.id }, userErrors: [] } };
      }
      case 'fulfillmentEventCreate': {
        const f = fulfilment(vars.e.fulfillmentId);
        if (!f) return { fulfillmentEventCreate: { fulfillmentEvent: null, userErrors: [{ field: ['fulfillmentId'], message: 'Fulfillment does not exist.' }] } };
        if (!EVENT_STATUSES.has(vars.e.status)) return { fulfillmentEventCreate: { fulfillmentEvent: null, userErrors: [{ field: ['status'], message: `Expected a valid FulfillmentEventStatus, got ${vars.e.status}` }] } };
        f.events.push(vars.e); return { fulfillmentEventCreate: { fulfillmentEvent: { id: `e${this.n++}`, status: vars.e.status }, userErrors: [] } };
      }
      case 'fulfillmentCancel': {
        const f = fulfilment(vars.id);
        if (!f || f.status === 'CANCELLED') return { fulfillmentCancel: { fulfillment: null, userErrors: [{ field: ['id'], message: 'Fulfillment cannot be cancelled.' }] } };
        f.status = 'CANCELLED';
        const o = [...this.orders.values()].find(x => x.fulfillments.includes(f))!;
        for (const l of f.lines) { const line = o.fos[0].lines.find(x => x.variant === l.variant)!; line.remaining += l.quantity; }
        return { fulfillmentCancel: { fulfillment: { id: f.id, status: 'CANCELLED' }, userErrors: [] } };
      }
      case 'orderMarkAsPaid': {
        const o = this.orders.get(vars.input.id);
        if (!o) return { orderMarkAsPaid: { order: null, userErrors: [{ field: ['id'], message: 'Order does not exist.' }] } };
        if (o.financial === 'PAID') return { orderMarkAsPaid: { order: { id: vars.input.id, displayFinancialStatus: 'PAID' }, userErrors: [{ field: ['id'], message: 'Order cannot be marked as paid.' }] } };
        o.financial = 'PAID'; return { orderMarkAsPaid: { order: { id: vars.input.id, displayFinancialStatus: 'PAID' }, userErrors: [] } };
      }
    }
    throw new Error(`stand-in Shopify does not know ${op}`);
  }
}

(async () => {
  const { prisma } = await import('../lib/prisma');
  const { shopifyOrderIngestService, shopifyFulfilmentService, shopifyOrderUpdates } = await import('../services/shopify-orders');
  const parcels = await import('../services/logistics/parcels');
  const shopify = new StandInShopify();
  const run = () => shopifyOrderUpdates.runOnce(async () => shopify as any);
  const rows = (salesOrderId: string) => prisma.shopifyOrderUpdate.findMany({ where: { salesOrderId }, orderBy: { createdAt: 'asc' } });
  const due = () => prisma.shopifyOrderUpdate.updateMany({ where: { clientId: C, state: { in: ['PENDING', 'WAITING_PERMISSION'] } }, data: { nextAt: new Date(Date.now() - 1000) } });
  const by = { id: null, name: 'Packer' };
  let nextOrder = 880000;

  try {
    // ── A shop that sells on Shopify and ships through Logistics ───────────────────────────────
    const loc = await prisma.stockLocation.create({ data: { clientId: C, name: 'Main Store', code: 'MAIN', type: 'STORE', active: true, address: '12 MG Road, Vijayawada 520010', phone: '+919900011122' } as any });
    const product = await prisma.product.create({ data: { clientId: C, productCode: 'PRD-UPD', title: 'Kanchipuram Silk Saree', slug: `upd-${STAMP}`, category: 'WOMEN', basePrice: 12000, status: 'ACTIVE', productType: 'READY_TO_WEAR' } });
    const variantIds: Record<string, string> = {};
    for (const [key, price] of [['saree', 12000], ['blouse', 800]] as const) {
      const v = await prisma.productVariant.create({ data: { clientId: C, productId: product.id, sku: `UPD-${key}-${STAMP}`, variantCode: `VU-${key}-${STAMP}`, size: 'Free Size', colorName: 'Red', sellingPrice: price, averageCost: 100 } });
      variantIds[key] = v.id;
      await prisma.inventoryStock.create({ data: { clientId: C, variantId: v.id, locationId: loc.id, quantity: 50, reservedQty: 0 } });
    }
    const inst = await prisma.shopifyInstallation.create({ data: { shopDomain: SHOP, clientId: C, source: 'SCALEEZY', accessTokenEncrypted: 'x', scopes: ALL_SCOPES } });
    await prisma.shopifyLocationMap.create({ data: { installationId: inst.id, clientId: C, locationId: loc.id, shopifyLocationId: '6601' } });
    for (const key of ['saree', 'blouse'] as const) {
      await prisma.shopifyIdMap.create({ data: { installationId: inst.id, clientId: C, variantId: variantIds[key], sku: `UPD-${key}-${STAMP}`, shopifyProductId: '5100', shopifyVariantId: SV[key], origin: 'CREATED' } });
    }
    await prisma.moduleSubscription.create({ data: { clientId: C, module: 'logistics' } });

    /** A Shopify order, ingested the real way, and the same order in the stand-in store. */
    const newOrder = async (o: { cod?: boolean; lines?: { variant: string; qty: number; price: number }[] } = {}) => {
      const id = ++nextOrder;
      const lines = o.lines ?? [{ variant: SV.saree, qty: 2, price: 12000 }];
      const total = lines.reduce((s, l) => s + l.qty * l.price, 0);
      const payload = {
        id, name: `#${id}`, currency: 'INR', updated_at: '2026-10-29T10:00:00Z', created_at: '2026-10-29T10:00:00Z',
        financial_status: o.cod ? 'pending' : 'paid', fulfillment_status: null, total_tax: '0.00', total_discounts: '0.00', total_price: total.toFixed(2),
        total_outstanding: o.cod ? total.toFixed(2) : '0.00',
        payment_gateway_names: [o.cod ? 'Cash on Delivery (COD)' : 'Razorpay'],
        line_items: lines.map(l => ({ variant_id: Number(l.variant), quantity: l.qty, price: l.price.toFixed(2), discount_allocations: [] })),
        discount_applications: [],
        customer: { id: 9100, first_name: 'Meena', last_name: 'Iyer', email: `m${STAMP}@example.com`, phone: '+919848011122' },
        shipping_address: { address1: '4 Temple Street', city: 'Guntur', zip: '522001', province: 'Andhra Pradesh', country: 'India', phone: '+919848011122' }
      };
      const ing: any = await shopifyOrderIngestService.ingest(SHOP, payload, 'orders/create');
      shopify.addOrder(String(id), lines.map(l => ({ variant: l.variant, qty: l.qty })), o.cod ? 'PENDING' : 'PAID');
      const order = await prisma.salesOrder.findUniqueOrThrow({ where: { id: ing.salesOrderId }, include: { items: { orderBy: { createdAt: 'asc' } } } });
      return { id: String(id), payload, order, ing };
    };
    const pack = async (orderId: string, items?: { salesOrderItemId: string; quantity: number }[]) => {
      const o = await prisma.salesOrder.findUniqueOrThrow({ where: { id: orderId }, include: { items: true } });
      return parcels.pack(C, by, { salesOrderId: orderId, weightKg: 0.8, box: 'Small', items: items ?? o.items.map(i => ({ salesOrderItemId: i.id, quantity: i.quantity - i.fulfilledQty })) });
    };
    const logistics = (parcelId: string, status: string, extra: Record<string, unknown> = {}, minutes = 0) =>
      parcels.fromLogistics(C, parcelId, { status, at: new Date(Date.now() - 60 * 60_000 + minutes * 60_000).toISOString(), ...extra });

    console.log('\nA. BOOKED BY LOGISTICS -> SHOPIFY SEES IT SHIPPED, WITH TRACKING');
    const one = await newOrder();
    check('the Shopify order is in', one.ing.status === 'APPLIED', one.ing);
    const p1: any = await pack(one.order.id);
    eq('packing queues nothing for Shopify yet (the courier is not booked)', (await rows(one.order.id)).length, 0);
    await logistics(p1.id, 'BOOKED', { courier: 'Delhivery', awb: 'DL123456789IN', tracking_url: 'https://track.example.com/DL123456789IN' }, 1);
    let r = await rows(one.order.id);
    eq('booked: one shipment queued, with the tracking', r.map(x => [x.kind, x.state, (x.detail as any).number]), [['FULFIL', 'PENDING', 'DL123456789IN']]);
    eq('the worker sends it', await run(), ['DONE']);
    const shop1 = shopify.orders.get(`gid://shopify/Order/${one.id}`)!;
    const f1 = shop1.fulfillments[0];
    eq('Shopify has one fulfilment for both sarees', f1?.lines, [{ variant: `gid://shopify/ProductVariant/${SV.saree}`, quantity: 2 }]);
    eq('... with the tracking number and link, no courier name', f1?.tracking, { number: 'DL123456789IN', url: 'https://track.example.com/DL123456789IN' });
    eq('... and Shopify tells the customer', f1?.notify, true);
    r = await rows(one.order.id);
    eq('the row remembers Shopify\'s fulfilment id', r[0].shopifyFulfillmentId, f1.id);

    console.log('\nB. THE SAME NEWS TWICE');
    await logistics(p1.id, 'BOOKED', { courier: 'Delhivery', awb: 'DL123456789IN', tracking_url: 'https://track.example.com/DL123456789IN' }, 1);
    await shopifyOrderUpdates.fromParcelUpdate(C, p1.id, 'BOOKED');
    eq('a repeated Logistics update queues nothing more', (await rows(one.order.id)).length, 1);
    eq('and nothing is sent', await run(), []);

    console.log('\nC. SHOPIFY ECHOES OUR FULFILMENT BACK');
    const dispatchesBefore = await prisma.dispatch.count({ where: { salesOrderId: one.order.id } });
    eq('orders/fulfilled for our own fulfilment is an echo', await shopifyFulfilmentService.apply(SHOP, shopify.webhook(one.id)), 'ECHO');
    eq('no second dispatch', await prisma.dispatch.count({ where: { salesOrderId: one.order.id } }), dispatchesBefore);
    eq('no "fulfilled in Shopify" warning for our own', (await rows(one.order.id)).filter(x => x.kind === 'FULFILLED_IN_SHOPIFY').length, 0);
    const stock = await prisma.inventoryStock.findFirstOrThrow({ where: { variantId: variantIds.saree, locationId: loc.id } });
    eq('the stock went down once (2), not twice', stock.quantity, 48);

    console.log('\nD. ON ITS WAY, THEN DELIVERED');
    await logistics(p1.id, 'PICKED_UP', {}, 2);
    await logistics(p1.id, 'IN_TRANSIT', {}, 3);
    await logistics(p1.id, 'OUT_FOR_DELIVERY', {}, 4);
    await logistics(p1.id, 'FAILED_ATTEMPT', { note: 'door locked' }, 5);
    await logistics(p1.id, 'DELIVERED', {}, 6);
    eq('five updates sent', await run(), ['DONE', 'DONE', 'DONE', 'DONE', 'DONE']);
    eq('Shopify\'s timeline, in order', f1.events.map((e: any) => e.status), ['CARRIER_PICKED_UP', 'IN_TRANSIT', 'OUT_FOR_DELIVERY', 'ATTEMPTED_DELIVERY', 'DELIVERED']);
    check('the missed delivery says what happens next', /try again/.test(f1.events[3]?.message ?? ''), f1.events[3]);
    check('each event says when it happened', f1.events.every((e: any) => !Number.isNaN(Date.parse(e.happenedAt))), f1.events.map((e: any) => e.happenedAt));

    console.log('\nE. A NEW TRACKING NUMBER AFTER IT WAS SENT');
    const two = await newOrder();
    const p2: any = await pack(two.order.id);
    await logistics(p2.id, 'BOOKED', { awb: 'OLD111', tracking_url: 'https://track.example.com/OLD111' }, 1);
    await run();
    await logistics(p2.id, 'IN_TRANSIT', { awb: 'NEW222', tracking_url: 'https://track.example.com/NEW222' }, 2);
    eq('the correction and the event are queued', (await rows(two.order.id)).map(x => x.kind), ['FULFIL', 'TRACKING', 'EVENT']);
    await run();
    const f2 = shopify.orders.get(`gid://shopify/Order/${two.id}`)!.fulfillments[0];
    eq('Shopify now shows the new tracking', f2.tracking, { number: 'NEW222', url: 'https://track.example.com/NEW222' });

    console.log('\nF. BOOKED WITHOUT A NUMBER, THE NUMBER LATER, BEFORE SHOPIFY WAS TOLD');
    const three = await newOrder();
    const p3: any = await pack(three.order.id);
    shopify.down = true;
    await logistics(p3.id, 'BOOKED', {}, 1);
    eq('Shopify unreachable: tried again later', await run(), ['RETRY']);
    let f3row = (await rows(three.order.id))[0];
    check('... the order says why, in words', /Could not reach/.test(f3row.lastError ?? '') && f3row.attempts === 1 && f3row.nextAt > new Date(), f3row);
    await logistics(p3.id, 'IN_TRANSIT', { awb: 'LATE333', tracking_url: 'https://track.example.com/LATE333' }, 2);
    eq('the waiting shipment simply takes the number (no separate correction)', (await rows(three.order.id)).map(x => [x.kind, (x.detail as any).number ?? null]), [['FULFIL', 'LATE333'], ['EVENT', null]]);
    shopify.down = false;
    await due();
    eq('the event waits for the shipment, then both go', await run(), ['DONE', 'DONE']);
    const f3 = shopify.orders.get(`gid://shopify/Order/${three.id}`)!.fulfillments[0];
    eq('one fulfilment, with the late number, then the event', [f3.tracking, f3.events.map((e: any) => e.status)], [{ number: 'LATE333', url: 'https://track.example.com/LATE333' }, ['IN_TRANSIT']]);
    // An event with its shipment still waiting is not counted as a try.
    const four = await newOrder();
    const p4: any = await pack(four.order.id);
    shopify.down = true;
    await logistics(p4.id, 'BOOKED', { awb: 'W4' }, 1);
    await run();
    shopify.down = false;
    await logistics(p4.id, 'IN_TRANSIT', {}, 2);
    const ev4 = (await rows(four.order.id)).find(x => x.kind === 'EVENT')!;
    eq('an event whose shipment is still waiting', [await shopifyOrderUpdates.runOnce(async () => shopify as any).then(x => x)], [['NOT_YET']]);
    eq('... is not counted as a failed try', (await prisma.shopifyOrderUpdate.findUniqueOrThrow({ where: { id: ev4.id } })).attempts, 0);
    await due(); await run();
    eq('... and goes after it', (await rows(four.order.id)).map(x => x.state), ['DONE', 'DONE']);

    console.log('\nG. SHOPIFY DOWN FOR GOOD, THEN "TRY AGAIN"');
    const five = await newOrder();
    const p5: any = await pack(five.order.id);
    shopify.down = true;
    await logistics(p5.id, 'BOOKED', { awb: 'G5' }, 1);
    for (let i = 0; i < 8; i++) { await due(); await run(); }
    let g = (await rows(five.order.id))[0];
    check('after 8 tries it stops, saying so and what to press', g.state === 'FAILED' && /Gave up after 8 tries; press Try again/.test(g.lastError ?? ''), g);
    shopify.down = false;
    await due();
    eq('nothing more happens on its own', await run(), []);
    const refusedOther = await shopifyOrderUpdates.retry(C, one.order.id, g.id).then(() => 'ok', (e: any) => e.statusCode);
    eq('"Try again" with another order\'s id is refused', refusedOther, 404);
    eq('"Try again" on its own order', await shopifyOrderUpdates.retry(C, five.order.id, g.id), { queued: true });
    eq('... is sent', await run(), ['DONE']);
    eq('"Try again" on one that is done is refused', await shopifyOrderUpdates.retry(C, five.order.id, g.id).then(() => 'ok', (e: any) => e.statusCode), 409);

    console.log('\nH. THE STORE HAS NOT APPROVED THE NEW PERMISSIONS');
    const OLD_SCOPES = 'read_orders,write_products';
    await prisma.shopifyInstallation.update({ where: { id: inst.id }, data: { scopes: OLD_SCOPES } });
    shopify.granted = OLD_SCOPES.split(',');
    const six = await newOrder();
    const p6: any = await pack(six.order.id);
    await logistics(p6.id, 'BOOKED', { awb: 'H6' }, 1);
    eq('waits for the permission (Shopify itself confirms it is not granted)', await run(), ['WAITING_PERMISSION']);
    const h = (await rows(six.order.id))[0];
    check('... and the order says what to do', /approve the app's new permissions/.test(h.lastError ?? ''), h.lastError);
    eq('nothing reached Shopify', shopify.orders.get(`gid://shopify/Order/${six.id}`)!.fulfillments.length, 0);
    check('... and it is looked at again later, not every 15 seconds', h.nextAt.getTime() > Date.now() + 5 * 60_000, h.nextAt);
    // Approved inside Shopify, and the webhook missed: the worker asks Shopify, and goes.
    shopify.granted = ALL_SCOPES.split(',');
    await due();
    eq('approved in Shopify, webhook never came: the worker asks Shopify and it goes', await run(), ['DONE']);
    eq('... and the saved permissions are brought up to date', (await prisma.shopifyInstallation.findUniqueOrThrow({ where: { id: inst.id } })).scopes, ALL_SCOPES);
    // The webhook way: Shopify's app/scopes_update, signed, through the local server's real route.
    await prisma.shopifyInstallation.update({ where: { id: inst.id }, data: { scopes: OLD_SCOPES } });
    shopify.granted = OLD_SCOPES.split(',');
    const seven = await newOrder();
    const p7: any = await pack(seven.order.id);
    await logistics(p7.id, 'BOOKED', { awb: 'H7' }, 1);
    await run();
    const crypto = await import('node:crypto');
    const hookBody = Buffer.from(JSON.stringify({ id: 1, previous: OLD_SCOPES.split(','), current: ALL_SCOPES.split(','), updated_at: new Date().toISOString() }));
    const secret = process.env.SHOPIFY_API_SECRET ?? 'verify-local-secret';
    const send = (sig: string, id: string) => fetch('http://localhost:4016/api/v1/shopify/webhooks', { method: 'POST', body: hookBody, headers: {
      'Content-Type': 'application/json', 'X-Shopify-Topic': 'app/scopes_update', 'X-Shopify-Shop-Domain': SHOP, 'X-Shopify-Webhook-Id': id, 'X-Shopify-Hmac-Sha256': sig
    } });
    eq('a forged app/scopes_update is refused', (await send('not-it', `forged-${STAMP}`)).status, 401);
    eq('... and changes nothing', (await prisma.shopifyInstallation.findUniqueOrThrow({ where: { id: inst.id } })).scopes, OLD_SCOPES);
    eq('Shopify\'s signed app/scopes_update is accepted', (await send(crypto.createHmac('sha256', secret).update(hookBody).digest('base64'), `scopes-${STAMP}`)).status, 200);
    // The route answers Shopify first and handles it straight after: waited for, as Shopify would not.
    for (let i = 0; i < 40; i++) {
      const rec = await prisma.shopifyWebhookReceipt.findFirst({ where: { webhookId: `scopes-${STAMP}` }, select: { processedAt: true, outcome: true } });
      if (rec?.processedAt) { eq('... and handled (APPLIED)', rec.outcome, 'APPLIED'); break; }
      await new Promise(r => setTimeout(r, 250));
    }
    eq('... the store\'s permissions are saved', (await prisma.shopifyInstallation.findUniqueOrThrow({ where: { id: inst.id } })).scopes, ALL_SCOPES);
    const r7 = (await rows(seven.order.id))[0];
    check('... and the waiting update is due now, not in 10 minutes', r7.nextAt.getTime() <= Date.now() + 1000, r7.nextAt);
    shopify.granted = ALL_SCOPES.split(',');
    eq('... and goes on the next pass', await run(), ['DONE']);

    console.log('\nI. CASH ON DELIVERY COLLECTED -> SHOPIFY MARKED PAID -> THE MONEY HERE ONCE');
    const cod = await newOrder({ cod: true });
    check('a COD order is confirmed with nothing paid', cod.order.payOnDelivery === true, cod.order);
    const pc: any = await pack(cod.order.id);
    eq('Logistics is told to collect the full 24,000 at the door', ((await prisma.logisticsParcel.findUniqueOrThrow({ where: { id: pc.id } })).payload as any)?.payment, { method: 'COD', cod_amount: 24000 });
    await logistics(pc.id, 'BOOKED', { awb: 'COD1' }, 1);
    await logistics(pc.id, 'DELIVERED', { cod_collected: 24000 }, 2);
    const codRows = await rows(cod.order.id);
    eq('shipment, delivered and "mark paid" queued', codRows.map(x => x.kind), ['FULFIL', 'EVENT', 'MARK_PAID']);
    const paidHere = async () => (await prisma.salesOrder.findUniqueOrThrow({ where: { id: cod.order.id }, include: { payments: true } })).payments.reduce((s, p) => s + (p.kind === 'PAYMENT' ? Number(p.amount) : -Number(p.amount)), 0);
    eq('the money is not recorded here directly (Shopify\'s paid webhook does that)', await paidHere(), 0);
    await run();
    eq('Shopify shows it paid', shopify.orders.get(`gid://shopify/Order/${cod.id}`)!.financial, 'PAID');
    const paidWebhook = { ...cod.payload, financial_status: 'paid', total_outstanding: '0.00', updated_at: '2026-10-29T12:00:00Z' };
    await shopifyOrderIngestService.ingest(SHOP, paidWebhook, 'orders/paid');
    eq('Shopify\'s paid webhook records the 24,000 here', await paidHere(), 24000);
    await shopifyOrderIngestService.ingest(SHOP, { ...paidWebhook, updated_at: '2026-10-29T12:05:00Z' }, 'orders/updated');
    eq('... once, however often Shopify says it', await paidHere(), 24000);
    await logistics(pc.id, 'DELIVERED', { cod_collected: 24000 }, 2);
    eq('the courier\'s cash reported again queues nothing more', (await rows(cod.order.id)).length, 3);

    console.log('\nJ. THE COURIER COLLECTED LESS THAN IS OWED');
    const short = await newOrder({ cod: true });
    const ps: any = await pack(short.order.id);
    await logistics(ps.id, 'BOOKED', { awb: 'S1' }, 1);
    await logistics(ps.id, 'DELIVERED', { cod_collected: 20000 }, 2);
    const sr = await rows(short.order.id);
    eq('no "mark paid" (Shopify can only mark the whole balance)', sr.filter(x => x.kind === 'MARK_PAID').length, 0);
    check('a note on the order with both amounts and what to do', sr.some(x => x.kind === 'COD_SHORT' && /₹20,000 of ₹24,000/.test(x.lastError ?? '') && /mark it paid in Shopify/.test(x.lastError ?? '')), sr.map(x => x.lastError));

    console.log('\nK. ALREADY MARKED PAID IN SHOPIFY BY HAND');
    const k = await newOrder({ cod: true });
    const pk: any = await pack(k.order.id);
    await logistics(pk.id, 'BOOKED', { awb: 'K1' }, 1);
    await logistics(pk.id, 'DELIVERED', { cod_collected: 24000 }, 2);
    shopify.orders.get(`gid://shopify/Order/${k.id}`)!.financial = 'PAID';
    await run();
    const kp = (await rows(k.order.id)).find(x => x.kind === 'MARK_PAID')!;
    check('done, noting Shopify already showed it paid (not an error)', kp.state === 'DONE' && /already showed it paid/.test(kp.lastError ?? ''), kp);

    console.log('\nL. CANCELLED BY LOGISTICS');
    const l = await newOrder();
    const pl: any = await pack(l.order.id);
    await logistics(pl.id, 'BOOKED', { awb: 'L1' }, 1);
    await run();
    await logistics(pl.id, 'CANCELLED', {}, 2);
    await run();
    const fl = shopify.orders.get(`gid://shopify/Order/${l.id}`)!;
    eq('the Shopify fulfilment is cancelled, the pieces open again there', [fl.fulfillments[0].status, fl.fos[0].lines[0].remaining], ['CANCELLED', 2]);
    const l2 = await newOrder();
    const pl2: any = await pack(l2.order.id);
    await logistics(pl2.id, 'CANCELLED', {}, 1);
    await run();
    const lr = await rows(l2.order.id);
    check('cancelled before it was ever booked: nothing to cancel in Shopify, said plainly', lr.length === 1 && lr[0].kind === 'CANCEL' && lr[0].state === 'DONE' && /nothing to cancel/.test(lr[0].lastError ?? ''), lr);
    eq('... and Shopify was not asked to cancel anything', shopify.calls.filter(c => c.op === 'fulfillmentCancel').length, 1);

    console.log('\nM. FULFILLED BY HAND IN SHOPIFY, ON A SHOP THAT SHIPS THROUGH LOGISTICS');
    const m = await newOrder({ lines: [{ variant: SV.saree, qty: 1, price: 12000 }, { variant: SV.blouse, qty: 1, price: 800 }] });
    shopify.fulfilByHand(m.id, SV.saree, 1);
    eq('Shopify\'s fulfilment is still recorded (the saree did go)', await shopifyFulfilmentService.apply(SHOP, shopify.webhook(m.id)), 'APPLIED');
    const mr = await rows(m.order.id);
    check('the order says it was fulfilled in Shopify, not through Logistics', mr.some(x => x.kind === 'FULFILLED_IN_SHOPIFY' && x.state === 'NOTICE' && /not sent through ScaleEzy Logistics/.test(x.lastError ?? '')), mr);
    const alert = await prisma.inventoryAlert.findFirst({ where: { clientId: C, title: { contains: 'was fulfilled in Shopify' } } });
    check('and the bell says so too', !!alert && /1 piece was marked fulfilled in Shopify by hand/.test(alert.message ?? ''), alert);
    // The blouse is still to go, through Logistics.
    const mOrder = await prisma.salesOrder.findUniqueOrThrow({ where: { id: m.order.id }, include: { items: true } });
    const blouse = mOrder.items.find(i => i.variantId === variantIds.blouse)!;
    const pm: any = await pack(m.order.id, [{ salesOrderItemId: blouse.id, quantity: 1 }]);
    await logistics(pm.id, 'BOOKED', { awb: 'M1' }, 1);
    await run();
    const fm = shopify.orders.get(`gid://shopify/Order/${m.id}`)!.fulfillments;
    eq('the blouse goes to Shopify as its own fulfilment', fm.map((f: any) => [f.byHand ? 'by hand' : 'ours', f.lines.map((x: any) => x.variant.split('/').pop())]), [['by hand', [SV.saree]], ['ours', [SV.blouse]]]);
    eq('and its echo changes nothing', await shopifyFulfilmentService.apply(SHOP, shopify.webhook(m.id)), 'ECHO');

    console.log('\nN. SHOPIFY WON\'T: ON HOLD, OR ALREADY FULFILLED THERE');
    const n1 = await newOrder();
    shopify.orders.get(`gid://shopify/Order/${n1.id}`)!.fos[0].status = 'ON_HOLD';
    const pn1: any = await pack(n1.order.id);
    await logistics(pn1.id, 'BOOKED', { awb: 'N1' }, 1);
    await run();
    let nr = (await rows(n1.order.id))[0];
    check('on hold: skipped, saying to release the hold in Shopify', nr.state === 'SKIPPED' && /on hold in Shopify/.test(nr.lastError ?? ''), nr);
    await logistics(pn1.id, 'DELIVERED', {}, 2);
    await run();
    nr = (await rows(n1.order.id))[1];
    check('its later events are skipped too, saying why (not retried for ever)', nr.state === 'SKIPPED' && /never told this parcel was shipped/.test(nr.lastError ?? ''), nr);
    const n2 = await newOrder();
    shopify.orders.get(`gid://shopify/Order/${n2.id}`)!.fos[0].lines[0].remaining = 0;
    const pn2: any = await pack(n2.order.id);
    await logistics(pn2.id, 'BOOKED', { awb: 'N2' }, 1);
    await run();
    const n2r = (await rows(n2.order.id))[0];
    check('already fulfilled there: skipped, saying so', n2r.state === 'SKIPPED' && /already shows these pieces as fulfilled/.test(n2r.lastError ?? ''), n2r);
    const n3 = await newOrder();
    shopify.orders.delete(`gid://shopify/Order/${n3.id}`);
    const pn3: any = await pack(n3.order.id);
    await logistics(pn3.id, 'BOOKED', { awb: 'N3' }, 1);
    await run();
    check('an order Shopify no longer has: skipped', /no longer has this order/.test((await rows(n3.order.id))[0].lastError ?? ''));

    console.log('\nO. NOT A SHOPIFY ORDER');
    const walkIn = await prisma.customer.create({ data: { clientId: C, customerCode: `CU-${STAMP}`, name: 'Ravi Kumar', phone: '+919848000001' } });
    const own = await prisma.salesOrder.create({ data: {
      clientId: C, customerId: walkIn.id, orderNumber: `SO-UPD-${STAMP}`, channel: 'ONLINE' as any, status: 'CONFIRMED' as any, locationId: loc.id,
      customerName: 'Walk-in', customerPhone: '+919848000001', shippingAddress: '1 Main Rd, Guntur 522001', subtotal: 800, total: 800,
      items: { create: [{ variantId: variantIds.blouse, quantity: 1, unitPrice: 800, listUnitPrice: 800, unitCost: 100, totalPrice: 800 }] }
    } as any }).catch((e: any) => { check('an own-shop order could be made for this check', false, e.message.split('\n').pop()); return null; });
    if (own) {
      await prisma.inventoryStock.updateMany({ where: { variantId: variantIds.blouse, locationId: loc.id }, data: { reservedQty: { increment: 1 } } });
      const ownItem = await prisma.salesOrderItem.findFirstOrThrow({ where: { salesOrderId: own.id } });
      await prisma.inventoryReservation.create({ data: { clientId: C, variantId: variantIds.blouse, salesOrderItemId: ownItem.id, locationId: loc.id, reservedQty: 1 } });
      const po: any = await pack(own.id).catch((e: any) => ({ error: e.message }));
      if (po.id) {
        await logistics(po.id, 'BOOKED', { awb: 'O1' }, 1);
        await logistics(po.id, 'DELIVERED', { cod_collected: 800 }, 2);
        eq('our own order queues nothing for Shopify', (await rows(own.id)).length, 0);
      } else check('our own order could be packed', false, po);
    }

    console.log('\nP. THE STORE DISCONNECTED');
    const pdis = await newOrder();
    const pp: any = await pack(pdis.order.id);
    await logistics(pp.id, 'BOOKED', { awb: 'P1' }, 1);
    await prisma.shopifyInstallation.update({ where: { id: inst.id }, data: { uninstalledAt: new Date() } });
    await run();
    check('skipped, saying the store is no longer connected', /no longer connected/.test((await rows(pdis.order.id))[0].lastError ?? ''));
    await prisma.shopifyInstallation.update({ where: { id: inst.id }, data: { uninstalledAt: null } });

    console.log('\nQ. WHAT THE ORDER PAGE IS GIVEN');
    const { getOrderById } = await import('../controllers/sales-order.controller');
    let sent: any = null;
    await getOrderById({ clientId: C, params: { id: one.order.id } } as any, { json: (x: any) => { sent = x; }, status: () => ({ json: (x: any) => { sent = x; } }) } as any);
    const lines = (sent?.data ?? sent)?.shopifyUpdates;
    eq('a Shopify order carries what Shopify was told', lines?.map((x: any) => [x.kind, x.event, x.state]), [['FULFIL', null, 'DONE'], ['EVENT', 'CARRIER_PICKED_UP', 'DONE'], ['EVENT', 'IN_TRANSIT', 'DONE'], ['EVENT', 'OUT_FOR_DELIVERY', 'DONE'], ['EVENT', 'ATTEMPTED_DELIVERY', 'DONE'], ['EVENT', 'DELIVERED', 'DONE']]);
    eq('... with the tracking number on the shipment', lines?.[0]?.tracking, 'DL123456789IN');
    if (own) {
      sent = null;
      await getOrderById({ clientId: C, params: { id: own.id } } as any, { json: (x: any) => { sent = x; }, status: () => ({ json: (x: any) => { sent = x; } }) } as any);
      check('our own order carries no Shopify lines', (sent?.data ?? sent)?.shopifyUpdates === undefined, Object.keys(sent?.data ?? sent ?? {}).slice(0, 5));
    }
  } catch (e: any) {
    check(`the suite reached the end (stopped at: ${String(e?.message ?? e).split('\n')[0]})`, false);
    console.log(e?.stack?.split('\n').slice(0, 4).join('\n'));
  } finally {
    await cleanup(prisma);
    await prisma.$disconnect();
    console.log(`\nRESULT: ${passed} passed, ${failed} failed`);
    if (failures.length) console.log(failures.map(x => `  - ${x}`).join('\n'));
    process.exit(failed ? 1 : 0);
  }
})();

async function cleanup(prisma: any) {
  const q = async (sql: string) => prisma.$executeRawUnsafe(sql).catch((e: any) => console.log('cleanup:', sql.slice(0, 60), e.message.split('\n').pop()));
  const tables: string[] = (await prisma.$queryRawUnsafe(`SELECT table_name FROM information_schema.columns WHERE column_name='client_id' AND table_schema='public' AND table_name NOT LIKE '%backup%'`)).map((r: any) => r.table_name);
  // Several passes: child rows first, whichever order the foreign keys need.
  for (let pass = 0; pass < 4; pass++) for (const t of tables) await prisma.$executeRawUnsafe(`DELETE FROM "${t}" WHERE client_id = $1`, C).catch(() => null);
  await q(`DELETE FROM shopify_webhook_receipts WHERE shop_domain = '${SHOP}'`);
  await q(`DELETE FROM shopify_installations WHERE shop_domain = '${SHOP}'`);
  const left = await prisma.$queryRawUnsafe(`SELECT count(*)::int AS n FROM inventory_products WHERE client_id = $1`, C);
  console.log(`cleanup: throwaway shop removed (${left[0].n} products left)`);
}
