/**
 * Shopify orders: the money and the GST, end to end.
 *
 * The owner's rules of 26 Oct 2026 (memory: project-shopify-gst-authority):
 *   - a paid order gets ONE payment row (gateway -> ONLINE, COD/manual -> CASH, bank -> BANK_TRANSFER),
 *     however many times Shopify delivers it;
 *   - cash on delivery is CONFIRMED (stock held) with nothing paid, and one CASH row once Shopify says paid;
 *   - a Shopify refund is ONE REFUND row per refund id;
 *   - GST is worked out by ScaleEzy, never copied from Shopify: CGST+SGST in the shop's state, IGST
 *     outside, none for a shop that charges no GST, the shop's own rate (the slab rule only warns),
 *     delivery at the highest rate on the order, all INSIDE what the customer paid;
 *   - a GST-registered shop's Shopify bills take numbers from its own SHP series;
 *   - products go to Shopify with taxable:false and the final (GST-inclusive) price.
 *
 * Orders, shipments and refunds go in as SIGNED WEBHOOKS to the running local server, the same door
 * Shopify uses, so redelivery is tested at the door as well as past it. The product push runs the
 * real push service with a stand-in for Shopify's API that records what it was sent (the live store
 * is never called).
 *
 * LOCAL DATABASE ONLY. Needs the backend-localdb-jobs server (port 4016, SHOPIFY_API_SECRET=verify-local-secret):
 *   DATABASE_URL=...55433/inventory DIRECT_URL=...55433/inventory VERIFY_API_URL=http://localhost:4016/api/v1 \
 *   npx tsx src/scripts/verify-shopify-money.ts
 */
import crypto from 'crypto';
import { prisma } from '../lib/prisma';
import { shopifyProductPushService } from '../services/shopify-products';

const API = process.env.VERIFY_API_URL ?? 'http://localhost:4016/api/v1';
const SECRET = process.env.SHOPIFY_WEBHOOK_TEST_SECRET ?? 'verify-local-secret';

if (!/localhost:55433|127\.0\.0\.1:55433/.test(process.env.DATABASE_URL ?? '')) {
  console.error('Refusing to run: DATABASE_URL is not the local test database (port 55433).');
  process.exit(2);
}

let passed = 0, failed = 0;
const failures: string[] = [];
const check = (name: string, ok: boolean, detail?: unknown) => {
  if (ok) { passed++; console.log(`  [PASS] ${name}`); }
  else { failed++; failures.push(name); console.log(`  [FAIL] ${name}${detail !== undefined ? `  -> ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`); }
};
const paise = (v: any) => (v === null || v === undefined ? null : Math.round(Number(v) * 100));
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

const STAMP = Date.now();
type ShopKey = 'A' | 'B' | 'C';
const CLIENTS: Record<ShopKey, string> = { A: `shopmoney-a-${STAMP}`, B: `shopmoney-b-${STAMP}`, C: `shopmoney-c-${STAMP}` };
const DOMAINS: Record<ShopKey, string> = { A: `money-a-${STAMP}.myshopify.com`, B: `money-b-${STAMP}.myshopify.com`, C: `money-c-${STAMP}.myshopify.com` };

/** Per shop: our ids, and the Shopify variant id of each product. */
const shops: Record<ShopKey, { locationId: string; installationId: string; variant: Record<string, string>; shopifyVariant: Record<string, string>; productId: Record<string, string> }> = {} as any;

const PRODUCTS = [
  // key, title, hsn, rate, slabbed, exclusive, price
  ['saree', 'Kanchi silk saree', '5007', 500, false, false, 10500],
  ['leh5', 'Silk lehenga', '6204', 500, true, false, 2625],
  ['leh18', 'Bridal lehenga', '6204', 1800, true, false, 3540],
  ['lehx', 'Party lehenga', '6204', 500, true, true, 2000]
] as const;

let seq = 0;
async function setupShop(k: ShopKey, gst: { registration: string; gstNumber: string | null; state: string | null }) {
  const clientId = CLIENTS[k];
  await prisma.clientSettings.create({
    data: { clientId, businessName: `Money test ${k}`, gstRegistration: gst.registration, gstNumber: gst.gstNumber, gstStateCode: gst.state }
  });
  const loc = await prisma.stockLocation.create({ data: { clientId, name: 'Main Store', code: 'MAIN', type: 'STORE', active: true } });
  const inst = await prisma.shopifyInstallation.create({
    data: { shopDomain: DOMAINS[k], clientId, source: 'SCALEEZY', accessTokenEncrypted: 'x', scopes: 'read_orders' }
  });
  await prisma.shopifyLocationMap.create({ data: { installationId: inst.id, clientId, locationId: loc.id, shopifyLocationId: `77${k.charCodeAt(0)}${STAMP % 100000}` } });
  const out = { locationId: loc.id, installationId: inst.id, variant: {} as Record<string, string>, shopifyVariant: {} as Record<string, string>, productId: {} as Record<string, string> };
  for (const [key, title, hsn, rate, slabbed, exclusive, price] of PRODUCTS) {
    const code = `PRD-${key.toUpperCase()}-${k}-${STAMP}`;
    const p = await prisma.product.create({
      data: {
        clientId, productCode: code, title, slug: `${key}-${k}-${STAMP}`, category: 'WOMEN', basePrice: price,
        status: 'ACTIVE', productType: 'READY_TO_WEAR', dressType: key === 'saree' ? 'Saree' : 'Lehenga',
        hsnCode: hsn, taxRateBps: rate, taxSlabbed: slabbed, priceIsExclusive: exclusive
      }
    });
    const sku = `SKU-${key.toUpperCase()}-${k}-${STAMP}`;
    const v = await prisma.productVariant.create({
      data: { clientId, productId: p.id, sku, variantCode: `VAR-${key.toUpperCase()}-${k}-${STAMP}`, size: 'Free Size', colorName: 'Red', sellingPrice: price, averageCost: Math.round(price / 2) }
    });
    await prisma.inventoryStock.create({ data: { clientId, variantId: v.id, locationId: loc.id, quantity: 50, reservedQty: 0 } });
    const sv = `${STAMP % 1000000}${k.charCodeAt(0)}${++seq}`;
    if (key !== 'lehx') {
      await prisma.shopifyIdMap.create({
        data: { installationId: inst.id, clientId, variantId: v.id, sku, shopifyProductId: `${sv}0`, shopifyVariantId: sv, origin: 'CREATED' }
      });
    }
    out.variant[key] = v.id; out.shopifyVariant[key] = sv; out.productId[key] = p.id;
  }
  shops[k] = out;
}

/** A Shopify order payload, the way Shopify sends it to an Indian store (prices include tax). */
let nextOrderId = Number(String(STAMP).slice(-7)) * 100;
function order(k: ShopKey, o: {
  lines: { key: string; qty: number; price: string }[]; shipping?: string; gateway?: string; financial?: string;
  outstanding?: string; province?: { code: string; name: string } | null; updatedAt?: string; fulfillment?: string | null;
  id?: number; taxesIncluded?: boolean; totalTax?: string; lineTax?: string[];
}) {
  const goods = o.lines.reduce((s, l) => s + Math.round(Number(l.price) * 100) * l.qty, 0);
  const ship = Math.round(Number(o.shipping ?? '0') * 100);
  const tax = Math.round(Number(o.totalTax ?? '0') * 100);
  const total = goods + ship + (o.taxesIncluded === false ? tax : 0);
  const fin = o.financial ?? 'paid';
  const province = o.province === undefined ? { code: 'TN', name: 'Tamil Nadu' } : o.province;
  return {
    id: o.id ?? ++nextOrderId, name: `#${nextOrderId}`, currency: 'INR',
    updated_at: o.updatedAt ?? '2026-10-28T10:00:00Z', processed_at: '2026-10-28T10:00:00Z',
    financial_status: fin, fulfillment_status: o.fulfillment ?? null,
    taxes_included: o.taxesIncluded ?? true, total_tax: o.totalTax ?? '0.00', total_discounts: '0.00',
    total_price: (total / 100).toFixed(2),
    total_outstanding: o.outstanding ?? (fin === 'paid' ? '0.00' : (total / 100).toFixed(2)),
    payment_gateway_names: [o.gateway ?? 'razorpay'],
    line_items: o.lines.map((l, i) => ({
      id: 900000 + i, variant_id: Number(shops[k].shopifyVariant[l.key]), quantity: l.qty, price: l.price, discount_allocations: [],
      tax_lines: o.lineTax?.[i] ? [{ title: 'IGST', price: o.lineTax[i], rate: 0.05 }] : []
    })),
    discount_applications: [],
    total_shipping_price_set: { shop_money: { amount: o.shipping ?? '0.00', currency_code: 'INR' } },
    shipping_address: province ? { first_name: 'Asha', address1: '1 Main Road', city: 'City', province: province.name, province_code: province.code, country: 'India', country_code: 'IN', zip: '600001' } : null,
    customer: { id: 4400 + seq, first_name: 'Asha', last_name: 'K', email: `asha${STAMP}@example.com` }
  };
}

let hookNo = 0;
async function hook(k: ShopKey, topic: string, payload: any, webhookId = `wh-${STAMP}-${++hookNo}`) {
  const raw = JSON.stringify(payload);
  const hmac = crypto.createHmac('sha256', SECRET).update(raw).digest('base64');
  const res = await fetch(`${API}/shopify/webhooks`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json', 'x-shopify-topic': topic, 'x-shopify-webhook-id': webhookId,
      'x-shopify-shop-domain': DOMAINS[k], 'x-shopify-hmac-sha256': hmac
    },
    body: raw
  });
  for (let i = 0; i < 240; i++) {
    const rec = await prisma.shopifyWebhookReceipt.findFirst({ where: { webhookId, topic } });
    if (rec?.processedAt) return { http: res.status, outcome: rec.outcome, error: rec.error, webhookId };
    await sleep(250);
  }
  return { http: res.status, outcome: 'TIMEOUT', error: null, webhookId };
}

const orderOf = (k: ShopKey, shopifyId: number) => prisma.salesOrder.findFirst({
  where: { clientId: CLIENTS[k], externalOrderId: String(shopifyId), sourceSystem: 'SHOPIFY' },
  include: { items: { orderBy: { createdAt: 'asc' } }, payments: { orderBy: { createdAt: 'asc' } } }
});
const stockOf = (k: ShopKey, key: string) => prisma.inventoryStock.findFirstOrThrow({
  where: { variantId: shops[k].variant[key], locationId: shops[k].locationId }, select: { quantity: true, reservedQty: true }
});
const lineTax = (i: any) => ({ rate: i.taxRateBps, hsn: i.hsnCode, taxable: paise(i.taxableValue), cgst: paise(i.cgst), sgst: paise(i.sgst), igst: paise(i.igst) });
const pay = (p: any) => ({ kind: p.kind, method: p.method, amount: paise(p.amount) });

async function main() {
  const health = await fetch(`${API.replace(/\/api\/v1$/, '')}/health`).then(r => r.ok).catch(() => false);
  if (!health) throw new Error(`The local server at ${API} is not answering.`);
  const door = await fetch(`${API}/shopify/webhooks`, { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } });
  if (door.status === 503) throw new Error(`The server at ${API} has no SHOPIFY_API_SECRET, so it takes no webhooks. Start it with SHOPIFY_API_SECRET=verify-local-secret.`);

  await setupShop('A', { registration: 'REGULAR', gstNumber: '33AAAAA0000A1Z5', state: '33' });
  await setupShop('B', { registration: 'UNREGISTERED', gstNumber: null, state: null });
  await setupShop('C', { registration: 'COMPOSITION', gstNumber: '33BBBBB0000B1Z5', state: '33' });

  // ── 1. A PAID ORDER: ONE PAYMENT, HOWEVER OFTEN IT ARRIVES ─────────────
  console.log('\n1. A PAID ORDER: ONE PAYMENT, HOWEVER OFTEN IT ARRIVES');
  const paid = order('A', { lines: [{ key: 'saree', qty: 1, price: '10500.00' }], gateway: 'razorpay' });
  const h1 = await hook('A', 'orders/create', paid);
  check('orders/create is accepted and placed', h1.http === 200 && h1.outcome === 'APPLIED', h1);
  let so = await orderOf('A', paid.id);
  check('the order is CONFIRMED', so?.status === 'CONFIRMED', so?.status);
  check('one PAYMENT row: ONLINE, Rs 10,500.00 exactly',
    so?.payments.length === 1 && JSON.stringify(pay(so.payments[0])) === JSON.stringify({ kind: 'PAYMENT', method: 'ONLINE', amount: 1050000 }), so?.payments.map(pay));

  const again = await hook('A', 'orders/create', paid, h1.webhookId);
  check('the SAME webhook redelivered is turned away at the door', again.http === 200, again);
  const fresh = await hook('A', 'orders/updated', paid);
  check('the same order under a new webhook id changes nothing', fresh.outcome === 'STALE', fresh);
  const later = await hook('A', 'orders/updated', { ...paid, updated_at: '2026-10-28T11:00:00Z' });
  check('a later orders/updated, still paid, is applied', later.outcome === 'APPLIED', later);
  so = await orderOf('A', paid.id);
  check('...and there is still exactly ONE payment of Rs 10,500.00',
    so?.payments.length === 1 && paise(so.payments[0].amount) === 1050000, so?.payments.map(pay));

  // orders/create and orders/updated together, as Shopify sends them.
  const race = order('A', { lines: [{ key: 'saree', qty: 1, price: '10500.00' }], gateway: 'razorpay' });
  await Promise.all([
    hook('A', 'orders/create', race),
    hook('A', 'orders/updated', { ...race, updated_at: '2026-10-28T10:00:01Z' })
  ]);
  const raced = await orderOf('A', race.id);
  check('create and update arriving together: one order, one payment of Rs 10,500.00',
    raced?.payments.length === 1 && paise(raced.payments[0].amount) === 1050000, raced?.payments.map(pay));

  const bank = order('A', { lines: [{ key: 'saree', qty: 1, price: '10500.00' }], gateway: 'Bank Deposit' });
  await hook('A', 'orders/create', bank);
  const manual = order('A', { lines: [{ key: 'saree', qty: 1, price: '10500.00' }], gateway: 'manual' });
  await hook('A', 'orders/create', manual);
  check('a bank deposit is BANK_TRANSFER', (await orderOf('A', bank.id))?.payments.map(p => p.method).join() === 'BANK_TRANSFER');
  check('"marked as paid" by hand (manual) is CASH', (await orderOf('A', manual.id))?.payments.map(p => p.method).join() === 'CASH');

  // ── 2. CASH ON DELIVERY ────────────────────────────────────────────────
  console.log('\n2. CASH ON DELIVERY');
  const reservedBefore = (await stockOf('A', 'saree')).reservedQty;
  const cod = order('A', { lines: [{ key: 'saree', qty: 1, price: '10500.00' }], gateway: 'Cash on Delivery (COD)', financial: 'pending' });
  const hc = await hook('A', 'orders/create', cod);
  so = await orderOf('A', cod.id);
  check('a COD order is CONFIRMED, not a draft', hc.outcome === 'APPLIED' && so?.status === 'CONFIRMED', [hc.outcome, so?.status]);
  check('...its piece is held', (await stockOf('A', 'saree')).reservedQty === reservedBefore + 1);
  check('...and NO payment yet', so?.payments.length === 0, so?.payments.map(pay));
  check('...yet it has its tax invoice number already (the goods are going)', so?.invoiceSeries === 'SHP' && so?.invoiceNumber != null, [so?.invoiceSeries, so?.invoiceNumber]);

  const shipped = await hook('A', 'orders/fulfilled', {
    ...cod, updated_at: '2026-10-28T12:00:00Z', fulfillment_status: 'fulfilled',
    fulfillments: [{ id: 7100 + seq, status: 'success', line_items: [{ variant_id: Number(shops.A.shopifyVariant.saree), quantity: 1 }] }]
  });
  check('it ships', shipped.outcome === 'APPLIED', shipped);
  const codPaid = { ...cod, updated_at: '2026-10-29T09:00:00Z', financial_status: 'paid', fulfillment_status: 'fulfilled', total_outstanding: '0.00' };
  const hp = await hook('A', 'orders/updated', codPaid);
  so = await orderOf('A', cod.id);
  check('Shopify marking the COD order paid is applied', hp.outcome === 'APPLIED', hp);
  check('...one CASH payment of Rs 10,500.00',
    so?.payments.length === 1 && JSON.stringify(pay(so.payments[0])) === JSON.stringify({ kind: 'PAYMENT', method: 'CASH', amount: 1050000 }), so?.payments.map(pay));
  check('...the order stays dispatched', so?.status === 'DISPATCHED', so?.status);
  const st = await stockOf('A', 'saree');
  check('...and the held piece was let go when it shipped, not held for ever', st.reservedQty === reservedBefore, [reservedBefore, st.reservedQty]);
  await hook('A', 'orders/updated', { ...codPaid, updated_at: '2026-10-29T09:05:00Z' });
  so = await orderOf('A', cod.id);
  check('a second "paid" update: still one payment', so?.payments.length === 1, so?.payments.map(pay));

  // ── 3. REFUNDS ─────────────────────────────────────────────────────────
  console.log('\n3. REFUNDS');
  const r1 = { id: 880000 + seq, order_id: paid.id, created_at: '2026-10-29T10:00:00Z', refund_line_items: [],
    transactions: [{ kind: 'refund', status: 'success', amount: '500.00', gateway: 'razorpay' }] };
  const hr = await hook('A', 'refunds/create', r1);
  so = await orderOf('A', paid.id);
  const refunds = (so?.payments ?? []).filter(p => p.kind === 'REFUND');
  check('a money-only refund (no goods) records ONE REFUND row: ONLINE, Rs 500.00',
    refunds.length === 1 && JSON.stringify(pay(refunds[0])) === JSON.stringify({ kind: 'REFUND', method: 'ONLINE', amount: 50000 }), [hr.outcome, refunds.map(pay)]);
  await hook('A', 'refunds/create', r1, hr.webhookId);
  await hook('A', 'refunds/create', r1);
  so = await orderOf('A', paid.id);
  check('the same refund redelivered (same and new webhook id): still ONE refund row',
    (so?.payments ?? []).filter(p => p.kind === 'REFUND').length === 1, so?.payments.map(pay));

  const r2 = { id: 880100 + seq, order_id: cod.id, created_at: '2026-10-30T10:00:00Z',
    refund_line_items: [{ line_item: { variant_id: Number(shops.A.shopifyVariant.saree) }, quantity: 1, subtotal: '10500.00', restock_type: 'return' }],
    transactions: [{ kind: 'refund', status: 'success', amount: '10500.00', gateway: 'Cash on Delivery (COD)' }] };
  const hr2 = await hook('A', 'refunds/create', r2);
  so = await orderOf('A', cod.id);
  const codRefunds = (so?.payments ?? []).filter(p => p.kind === 'REFUND');
  check('a refund with the goods coming back: ONE REFUND row, CASH, Rs 10,500.00',
    hr2.outcome === 'APPLIED' && codRefunds.length === 1 && JSON.stringify(pay(codRefunds[0])) === JSON.stringify({ kind: 'REFUND', method: 'CASH', amount: 1050000 }), [hr2, codRefunds.map(pay)]);
  const ret = await prisma.salesReturn.findFirst({ where: { clientId: CLIENTS.A, externalRefundId: String(r2.id) } });
  check('...linked to the return it paid back', !!ret && codRefunds[0]?.salesReturnId === ret.id, [ret?.id, codRefunds[0]?.salesReturnId]);
  await hook('A', 'refunds/create', r2);
  so = await orderOf('A', cod.id);
  check('...redelivered: still one refund row, and one return', (so?.payments ?? []).filter(p => p.kind === 'REFUND').length === 1
    && (await prisma.salesReturn.count({ where: { clientId: CLIENTS.A, externalRefundId: String(r2.id) } })) === 1);

  // ── 4. GST BY SCALEEZY'S ENGINE ────────────────────────────────────────
  console.log("\n4. GST, WORKED OUT BY SCALEEZY");
  so = await orderOf('A', paid.id);
  check('in-state saree Rs 10,500 at 5%: taxable 10,000.00, CGST 250.00 + SGST 250.00, no IGST',
    JSON.stringify(lineTax(so!.items[0])) === JSON.stringify({ rate: 500, hsn: '5007', taxable: 1000000, cgst: 25000, sgst: 25000, igst: 0 }), lineTax(so!.items[0]));
  check('...the order says tax Rs 500.00, inside the Rs 10,500.00 total (not added to it)',
    paise(so!.taxAmount) === 50000 && paise(so!.total) === 1050000, [so!.taxAmount, so!.total]);
  check('...a TAX_INVOICE, in-state, place of supply 33', so!.documentKind === 'TAX_INVOICE' && so!.interState === false && so!.placeOfSupplyStateCode === '33',
    [so!.documentKind, so!.interState, so!.placeOfSupplyStateCode]);

  const out = order('A', { lines: [{ key: 'saree', qty: 1, price: '10500.00' }], province: { code: 'KA', name: 'Karnataka' } });
  await hook('A', 'orders/create', out);
  so = await orderOf('A', out.id);
  check('delivered to Karnataka: IGST 500.00, no CGST/SGST, inter-state, place of supply 29',
    JSON.stringify(lineTax(so!.items[0])) === JSON.stringify({ rate: 500, hsn: '5007', taxable: 1000000, cgst: 0, sgst: 0, igst: 50000 })
      && so!.interState === true && so!.placeOfSupplyStateCode === '29', [lineTax(so!.items[0]), so!.interState, so!.placeOfSupplyStateCode]);

  const unreg = order('B', { lines: [{ key: 'saree', qty: 1, price: '10500.00' }] });
  await hook('B', 'orders/create', unreg);
  so = await orderOf('B', unreg.id);
  check('a shop that is not registered: no GST on the line, tax 0, a RECEIPT, no invoice number',
    JSON.stringify(lineTax(so!.items[0])) === JSON.stringify({ rate: null, hsn: null, taxable: null, cgst: null, sgst: null, igst: null })
      && paise(so!.taxAmount) === 0 && so!.documentKind === 'RECEIPT' && so!.invoiceNumber === null && paise(so!.total) === 1050000,
    [lineTax(so!.items[0]), so!.taxAmount, so!.documentKind, so!.invoiceNumber]);
  check('...but its money is still recorded: one ONLINE payment of Rs 10,500.00', so!.payments.length === 1 && paise(so!.payments[0].amount) === 1050000, so!.payments.map(pay));

  const comp = order('C', { lines: [{ key: 'saree', qty: 1, price: '10500.00' }] });
  await hook('C', 'orders/create', comp);
  so = await orderOf('C', comp.id);
  check('a composition shop: no GST, a BILL_OF_SUPPLY, numbered SHP/2026-27/1 from its own series',
    paise(so!.taxAmount) === 0 && so!.items[0].cgst === null && so!.documentKind === 'BILL_OF_SUPPLY'
      && so!.invoiceSeries === 'SHP' && so!.invoiceFinancialYear === '2026-27' && so!.invoiceNumber === 1,
    [so!.taxAmount, so!.documentKind, so!.invoiceSeries, so!.invoiceFinancialYear, so!.invoiceNumber]);

  // The Rs 2,500 slab: the shop's own rate is charged; the slab rule only warns when it looks low.
  const atLine = order('A', { lines: [{ key: 'leh5', qty: 1, price: '2625.00' }] });
  await hook('A', 'orders/create', atLine);
  so = await orderOf('A', atLine.id);
  check('lehenga at Rs 2,625 incl. 5% = Rs 2,500.00 a piece: 5%, CGST 62.50 + SGST 62.50',
    JSON.stringify(lineTax(so!.items[0])) === JSON.stringify({ rate: 500, hsn: '6204', taxable: 250000, cgst: 6250, sgst: 6250, igst: 0 }), lineTax(so!.items[0]));
  const atAlerts = await prisma.inventoryAlert.count({ where: { clientId: CLIENTS.A, title: { contains: so!.orderNumber }, severity: 'WARNING' } });
  check('...at the threshold itself: no GST warning', atAlerts === 0, atAlerts);
  const over = order('A', { lines: [{ key: 'leh5', qty: 1, price: '2626.00' }] });
  await hook('A', 'orders/create', over);
  so = await orderOf('A', over.id);
  check('one rupee over (Rs 2,500.95 a piece): still the 5% the shop set, taxable 2,500.95, tax 125.05',
    JSON.stringify(lineTax(so!.items[0])) === JSON.stringify({ rate: 500, hsn: '6204', taxable: 250095, cgst: 6253, sgst: 6252, igst: 0 }), lineTax(so!.items[0]));
  const overAlert = await prisma.inventoryAlert.findFirst({ where: { clientId: CLIENTS.A, title: { contains: so!.orderNumber }, severity: 'WARNING' } });
  check('...and the shop is told it is usually 18% above Rs 2,500', !!overAlert && /18%/.test(overAlert.message) && /2,500/.test(overAlert.message), overAlert?.message);

  // Delivery: composite supply at the highest rate on the order, inside the Rs 118.
  const mixed = order('A', { lines: [{ key: 'saree', qty: 1, price: '10500.00' }, { key: 'leh18', qty: 1, price: '3540.00' }], shipping: '118.00' });
  await hook('A', 'orders/create', mixed);
  so = await orderOf('A', mixed.id);
  check('mixed order: the saree line is its own 5% (taxable 10,000.00, tax 500.00)',
    JSON.stringify(lineTax(so!.items[0])) === JSON.stringify({ rate: 500, hsn: '5007', taxable: 1000000, cgst: 25000, sgst: 25000, igst: 0 }), lineTax(so!.items[0]));
  check('...the 18% line carries the delivery: 3,000.00 + 100.00 taxable, 270.00 + 9.00 each side',
    JSON.stringify(lineTax(so!.items[1])) === JSON.stringify({ rate: 1800, hsn: '6204', taxable: 310000, cgst: 27900, sgst: 27900, igst: 0 }), lineTax(so!.items[1]));
  const sumLines = so!.items.reduce((s, i) => s + paise(i.taxableValue)! + paise(i.cgst)! + paise(i.sgst)! + paise(i.igst)!, 0);
  check('...order tax Rs 1,058.00; total Rs 14,158.00 = every taxable value + every tax, to the paisa',
    paise(so!.taxAmount) === 105800 && paise(so!.total) === 1415800 && sumLines === 1415800, [so!.taxAmount, so!.total, sumLines]);

  // Shopify adding its own tax on top: the customer paid it, so it is in the money, and the shop is told.
  const onTop = order('A', { lines: [{ key: 'saree', qty: 1, price: '10500.00' }], taxesIncluded: false, totalTax: '525.00', lineTax: ['525.00'] });
  await hook('A', 'orders/create', onTop);
  so = await orderOf('A', onTop.id);
  check('Shopify tax added on top (Rs 525): total Rs 11,025.00 paid; our 5% carved out of it (taxable 10,500.00, tax 525.00)',
    paise(so!.total) === 1102500 && JSON.stringify(lineTax(so!.items[0])) === JSON.stringify({ rate: 500, hsn: '5007', taxable: 1050000, cgst: 26250, sgst: 26250, igst: 0 }),
    [so!.total, lineTax(so!.items[0])]);
  const topAlert = await prisma.inventoryAlert.findFirst({ where: { clientId: CLIENTS.A, title: { contains: so!.orderNumber }, severity: 'WARNING' } });
  check('...and the shop is told to switch off tax in Shopify', !!topAlert && /Charge tax/.test(topAlert.message), topAlert?.message);

  // ── 5. INVOICE NUMBERS ────────────────────────────────────────────────
  console.log('\n5. INVOICE NUMBERS');
  const numbered = await prisma.salesOrder.findMany({
    where: { clientId: CLIENTS.A, sourceSystem: 'SHOPIFY' }, orderBy: { createdAt: 'asc' },
    select: { orderNumber: true, invoiceSeries: true, invoiceNumber: true, invoiceFinancialYear: true, status: true }
  });
  const nums = numbered.map(n => n.invoiceNumber);
  check(`every one of the ${numbered.length} live orders of the registered shop has an SHP/2026-27 number`,
    numbered.every(n => n.invoiceSeries === 'SHP' && n.invoiceFinancialYear === '2026-27' && n.invoiceNumber != null), numbered);
  check('...unbroken, 1 to N, no number used twice',
    JSON.stringify([...nums].sort((a, b) => a! - b!)) === JSON.stringify(numbered.map((_, i) => i + 1)), nums);
  const pending = order('A', { lines: [{ key: 'saree', qty: 1, price: '10500.00' }], gateway: 'razorpay', financial: 'pending' });
  await hook('A', 'orders/create', pending);
  so = await orderOf('A', pending.id);
  check('an unpaid online order waiting (pending, not COD) is a DRAFT with no number and no payment',
    so?.status === 'DRAFT' && so.invoiceNumber === null && so.payments.length === 0, [so?.status, so?.invoiceNumber, so?.payments.length]);

  // ── 6. PRODUCTS GO TO SHOPIFY WITH THE FINAL PRICE AND NO SHOPIFY TAX ──
  console.log('\n6. PRODUCTS SENT TO SHOPIFY');
  const sent: Record<string, any[]> = {};
  let pushNo = 0;
  const fakeApiFor = (k: ShopKey) => async () => ({
    async graphql(query: string, vars: any = {}) {
      if (/ProductByTag/.test(query)) return { products: { nodes: [] } };
      if (/Publications/.test(query)) return { publications: { nodes: [] } };
      if (/ProductPush/.test(query)) {
        (sent[k] ??= []).push(vars.input);
        const n = `${STAMP % 100000}${k.charCodeAt(0)}${++pushNo}`;
        return { productSet: { userErrors: [], product: { id: `gid://shopify/Product/${n}`, status: 'ACTIVE',
          variants: { nodes: vars.input.variants.map((v: any, i: number) => ({ id: `gid://shopify/ProductVariant/${n}${i}`, sku: v.inventoryItem.sku, inventoryItem: { id: `gid://shopify/InventoryItem/${n}${i}` } })) } } } };
      }
      if (/StockSet/.test(query)) return { inventorySetQuantities: { userErrors: [] } };
      if (/StockActivate/.test(query)) return { inventoryActivate: { userErrors: [] } };
      throw new Error(`unexpected Shopify call: ${query.slice(0, 60)}`);
    }
  }) as any;

  for (const [k, key] of [['A', 'lehx'], ['A', 'saree'], ['B', 'lehx']] as const) {
    // Held by this run (lockedAt now) so the local server's own worker leaves it alone.
    const m = await prisma.shopifyProductMirror.create({
      data: { clientId: CLIENTS[k], installationId: shops[k].installationId, productId: shops[k].productId[key], origin: 'CREATED', wanted: true, status: 'PENDING', lockedAt: new Date() }
    });
    const outcome = await shopifyProductPushService.work(m.id, fakeApiFor(k));
    if (outcome !== 'SYNCED') console.log(`    push of ${k}/${key}: ${outcome}`, (await prisma.shopifyProductMirror.findUnique({ where: { id: m.id } }))?.problem);
  }
  const [aLehx, aSaree] = sent.A ?? [];
  const [bLehx] = sent.B ?? [];
  check('registered shop, lehenga entered at Rs 2,000 + 5%: Shopify gets the final price 2100.00',
    aLehx?.variants?.[0]?.price === '2100.00', aLehx?.variants?.map((v: any) => v.price));
  check('...with taxable:false, so Shopify adds no tax of its own', aLehx?.variants?.every((v: any) => v.taxable === false), aLehx?.variants);
  check('a saree priced with GST inside goes as it is: 10500.00, taxable:false',
    aSaree?.variants?.[0]?.price === '10500.00' && aSaree?.variants?.[0]?.taxable === false, aSaree?.variants);
  check('a shop that charges no GST adds none: 2000.00, taxable:false',
    bLehx?.variants?.[0]?.price === '2000.00' && bLehx?.variants?.[0]?.taxable === false, bLehx?.variants);
}

main()
  .catch(e => { console.error('\nSUITE CRASHED:', e); failed++; failures.push('suite crashed'); })
  .finally(async () => {
    // Everything this suite has ever made here, including a run that was stopped half way.
    const where = { clientId: { startsWith: 'shopmoney-' } };
    const domains = { startsWith: 'money-' };
    try {
      await prisma.salesOrderPayment.deleteMany({ where });
      await prisma.salesReturnItem.deleteMany({ where: { salesReturn: where } });
      await prisma.salesReturn.deleteMany({ where });
      await prisma.salesLedger.deleteMany({ where });
      await prisma.dispatchItem.deleteMany({ where: { dispatch: where } });
      await prisma.dispatch.deleteMany({ where });
      await prisma.salesOrderItemDiscount.deleteMany({ where: { salesOrderItem: { salesOrder: where } } });
      await prisma.salesOrderDiscount.deleteMany({ where: { salesOrder: where } });
      await prisma.inventoryReservation.deleteMany({ where });
      await prisma.inventoryTransaction.deleteMany({ where });
      await prisma.inventoryStock.deleteMany({ where });
      await prisma.salesOrderItem.deleteMany({ where: { salesOrder: where } });
      await prisma.salesOrder.deleteMany({ where });
      await prisma.customer.deleteMany({ where });
      await prisma.inventoryAlert.deleteMany({ where });
      await prisma.shopifyOrderInbox.deleteMany({ where: { shopDomain: domains } });
      await prisma.shopifyWebhookReceipt.deleteMany({ where: { shopDomain: domains } });
      await prisma.shopifyProductMirror.deleteMany({ where });
      await prisma.shopifyIdMap.deleteMany({ where });
      await prisma.shopifyLocationMap.deleteMany({ where });
      await prisma.shopifyInstallation.deleteMany({ where: { shopDomain: domains } });
      await prisma.productVariant.deleteMany({ where });
      await prisma.product.deleteMany({ where });
      await prisma.stockLocation.deleteMany({ where });
      await prisma.clientSequence.deleteMany({ where });
      await prisma.clientSettings.deleteMany({ where });
    } catch (e) {
      console.error('cleanup left something behind:', (e as Error).message);
    }
    await prisma.$disconnect();
    console.log(`\nRESULT: ${passed} passed | ${failed} failed`);
    if (failures.length) console.log('Failures:\n  - ' + failures.join('\n  - '));
    process.exit(failed ? 1 : 0);
  });
