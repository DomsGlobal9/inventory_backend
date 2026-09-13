/**
 * Offers aimed at something: a type of garment, a department, a few products, the whole bill, one
 * shop, one channel, once per customer -- and the offer page that says how each one did.
 *
 * verify-offers proves an offer is kept honestly. This proves the choices a merchant now makes on
 * the screen really change what a customer pays, and that the screen cannot be used to aim an offer
 * at something that is not theirs:
 *
 *   - "20% off sarees" must reach a product somebody typed as "saree " and not a lehenga
 *   - 500 off a bill over 5,000 must not fire at 4,999, and must be split across the lines
 *   - "buy 3" counts pieces the offer covers, not the blouse beside them
 *   - a till-only offer must not reach the website, and a Chennai offer not Bengaluru
 *   - "once per customer" must refuse the second order, and a guest who cannot be counted
 *   - another shop's product id, a binned product, a closed shop are all refused by name
 *   - the offer page's numbers match the orders, and its history says what changed in words
 *
 * Throwaway tenant, deleted at the end.
 *
 *   npx tsx src/scripts/verify-offer-targeting.ts
 */
import { prisma } from '../lib/prisma';
import { pricingQuoteService } from '../services/pricing';
import { offerService, offerInsightService, describeChanges } from '../services/offers';
import { salesOrderService } from '../services/sales-order.service';
import { translateOffer } from '../services/shopify-discounts';

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
const CLIENT = `otg-${STAMP}`;
const OTHER = `otg-other-${STAMP}`;
const USER_ID = `otg-user-${STAMP}`;
const yesterday = new Date(Date.now() - 86400000);

let chennai = '';
let bengaluru = '';
let closedShop = '';
let otherShopLocation = '';
let customerId = '';
let secondCustomerId = '';
const P: Record<string, string> = {};
const V: Record<string, string> = {};

const base = (over: any = {}) => ({
  name: 'Offer', trigger: 'AUTOMATIC', level: 'LINE', valueType: 'PERCENTAGE',
  value: 10, scope: 'ALL', startsAt: yesterday, endsAt: null, ...over
});

const live = async (over: any = {}) => {
  const offer: any = await offerService.create(CLIENT, base(over) as any, USER_ID);
  await offerService.setStatus(CLIENT, offer.id, 'ACTIVE', USER_ID);
  return offer;
};

const quote = (lines: any[], over: any = {}) => pricingQuoteService.quote(CLIENT, {
  locationId: chennai, channel: 'POS', lines, ...over
}) as Promise<any>;

const order = (q: any, lines: any[], customer: string | null = customerId) =>
  salesOrderService.createFullOrder(CLIENT, chennai, {
    customer: customer ? { id: customer } : { name: 'Walk-in' },
    quoteId: q.quoteId,
    items: lines
  }) as Promise<any>;

const pauseAll = async () => {
  const offers = await prisma.offer.findMany({ where: { clientId: CLIENT, status: 'ACTIVE' } });
  for (const o of offers) await offerService.setStatus(CLIENT, o.id, 'PAUSED', USER_ID);
};

async function product(key: string, title: string, category: string, dressType: string | null, price: number, extra: any = {}) {
  const p = await prisma.product.create({
    data: {
      clientId: CLIENT, productCode: `PRD-${key}`, title, slug: `${key}-${STAMP}`,
      category: category as any, dressType, basePrice: price, status: 'ACTIVE', productType: 'READY_TO_WEAR', ...extra
    }
  });
  P[key] = p.id;
  const v = await prisma.productVariant.create({
    data: {
      clientId: CLIENT, productId: p.id, sku: `SKU-${key}-${STAMP}`, variantCode: `VAR-${key}`,
      size: 'Free Size', colorName: 'Red', sellingPrice: price, averageCost: 100
    }
  });
  V[key] = v.id;
  for (const loc of [chennai, bengaluru]) {
    await prisma.inventoryStock.create({ data: { clientId: CLIENT, variantId: v.id, locationId: loc, quantity: 500, reservedQty: 0 } });
  }
}

async function main() {
  console.log('SETUP: two shops, sarees typed three ways, a lehenga, a kurta, a blouse');

  chennai = (await prisma.stockLocation.create({ data: { clientId: CLIENT, name: 'Chennai Store', code: 'CHN', type: 'STORE', active: true } })).id;
  bengaluru = (await prisma.stockLocation.create({ data: { clientId: CLIENT, name: 'Bengaluru Store', code: 'BLR', type: 'STORE', active: true } })).id;
  closedShop = (await prisma.stockLocation.create({ data: { clientId: CLIENT, name: 'Old Godown', code: 'OLD', type: 'WAREHOUSE', active: false } })).id;
  otherShopLocation = (await prisma.stockLocation.create({ data: { clientId: OTHER, name: 'Someone else', code: 'X', type: 'STORE', active: true } })).id;

  customerId = (await prisma.customer.create({ data: { clientId: CLIENT, customerCode: 'CUS-1', name: 'Meena', status: 'ACTIVE' } })).id;
  secondCustomerId = (await prisma.customer.create({ data: { clientId: CLIENT, customerCode: 'CUS-2', name: 'Lakshmi', status: 'ACTIVE' } })).id;
  await prisma.user.create({ data: { id: USER_ID, clientId: CLIENT, name: 'Priya Manager', email: `otg-${STAMP}@example.com`, password: 'x' } as any });

  await prisma.clientCatalogItem.create({ data: { clientId: CLIENT, type: 'DRESS_TYPE', value: 'saree', label: 'Saree', isSystem: false } });
  await prisma.clientCatalogItem.create({ data: { clientId: CLIENT, type: 'DRESS_TYPE', value: 'anarkali', label: 'Anarkali', isSystem: false } });

  await product('silk', 'Kanchipuram Silk Saree', 'WOMEN', 'Saree', 10000);
  await product('cotton', 'Cotton Saree', 'WOMEN', 'saree ', 2000);
  await product('banarasi', 'Banarasi Saree', 'WOMEN', 'SAREE', 6000);
  await product('lehenga', 'Bridal Lehenga', 'WOMEN', 'Lehenga', 20000);
  await product('kurta', 'Linen Kurta', 'MEN', 'Kurta', 1500);
  await product('blouse', 'Ready Blouse', 'WOMEN', null, 800);
  await product('binned', 'Old Stock Saree', 'WOMEN', 'Saree', 900, { status: 'TRASHED', trashedAt: new Date() });

  const foreign = await prisma.product.create({
    data: { clientId: OTHER, productCode: 'PRD-F', title: 'Not yours', slug: `f-${STAMP}`, category: 'WOMEN', basePrice: 100, status: 'ACTIVE', productType: 'READY_TO_WEAR' }
  });

  // ── A. WHAT IS REFUSED ─────────────────────────────────────────────────
  console.log('\nA. AN OFFER CANNOT BE AIMED AT SOMETHING THAT IS NOT THERE');

  await refuses('a type of garment with no types', 'types of garment', () => offerService.create(CLIENT, base({ scope: 'DRESS_TYPE', targets: [] }) as any));
  await refuses('a blank type', 'types of garment', () => offerService.create(CLIENT, base({ scope: 'DRESS_TYPE', targets: [{ scope: 'DRESS_TYPE', refId: '   ' }] }) as any));
  await refuses('a type name longer than 60', '60 characters', () => offerService.create(CLIENT, base({ scope: 'DRESS_TYPE', targets: [{ scope: 'DRESS_TYPE', refId: 'x'.repeat(61) }] }) as any));
  await refuses('a department that does not exist', 'Women, Men, Kids or Unisex', () => offerService.create(CLIENT, base({ scope: 'CATEGORY', targets: [{ scope: 'CATEGORY', refId: 'SAREES' }] }) as any));
  await refuses('a scope that does not exist', 'what the offer applies to', () => offerService.create(CLIENT, base({ scope: 'BRAND', targets: [{ scope: 'BRAND', refId: 'x' }] }) as any));
  await refuses('a whole bill set to one price', 'whole bill cannot be set', () => offerService.create(CLIENT, base({ level: 'ORDER', valueType: 'FIXED_PRICE', value: 999 }) as any));
  await refuses('a whole-bill offer on sarees only', 'whole order has to apply to everything', () => offerService.create(CLIENT, base({ level: 'ORDER', scope: 'DRESS_TYPE', targets: [{ scope: 'DRESS_TYPE', refId: 'Saree' }] }) as any));
  await refuses('once per customer, more than the total allowance', 'more times than the offer can be used', () => offerService.create(CLIENT, base({ usageLimit: 2, usageLimitPerCustomer: 3 }) as any));
  await refuses('a channel that does not exist', 'till, the online store', () => offerService.create(CLIENT, base({ channels: ['INSTAGRAM'] }) as any));
  await refuses('min items of zero', 'whole number above zero', () => offerService.create(CLIENT, base({ minQuantity: 0 }) as any));
  await refuses("another shop's product", 'no longer exists', () => offerService.create(CLIENT, base({ scope: 'PRODUCT', targets: [{ scope: 'PRODUCT', refId: foreign.id }] }) as any));
  await refuses('a product in the bin', 'in the bin', () => offerService.create(CLIENT, base({ scope: 'PRODUCT', targets: [{ scope: 'PRODUCT', refId: P.binned }] }) as any));
  await refuses('an item id that is not an item', 'no longer exists', () => offerService.create(CLIENT, base({ scope: 'VARIANT', targets: [{ scope: 'VARIANT', refId: P.silk }] }) as any));
  await refuses('a closed location', 'Old Godown is closed', () => offerService.create(CLIENT, base({ locationIds: [closedShop] }) as any));
  await refuses("another shop's location", 'no longer exists', () => offerService.create(CLIENT, base({ locationIds: [otherShopLocation] }) as any));

  const dupes: any = await offerService.create(CLIENT, base({
    name: 'Dupes', scope: 'DRESS_TYPE',
    targets: [{ scope: 'DRESS_TYPE', refId: 'Saree' }, { scope: 'DRESS_TYPE', refId: ' saree' }, { scope: 'DRESS_TYPE', refId: 'Lehenga' }]
  }) as any, USER_ID);
  check('the same type typed twice is kept once', dupes.targets.length === 2, JSON.stringify(dupes.targets.map((t: any) => t.refId)));

  // A product that goes to the bin AFTER the offer named it must not freeze the offer.
  const namesKurta: any = await offerService.create(CLIENT, base({ name: 'Kurta offer', scope: 'PRODUCT', targets: [{ scope: 'PRODUCT', refId: P.kurta }] }) as any, USER_ID);
  await prisma.product.update({ where: { id: P.kurta }, data: { status: 'TRASHED', trashedAt: new Date() } });
  let renamed = false;
  try { await offerService.update(CLIENT, namesKurta.id, { name: 'Kurta offer (renamed)' } as any, USER_ID); renamed = true; } catch (e: any) { void e; }
  check('an offer whose product was later binned can still be renamed', renamed);
  await prisma.product.update({ where: { id: P.kurta }, data: { status: 'ACTIVE', trashedAt: null } });

  // ── B. TYPES OF GARMENT ────────────────────────────────────────────────
  console.log('\nB. "20% OFF SAREES" REACHES EVERY SAREE, HOWEVER IT WAS TYPED, AND NOTHING ELSE');

  const sarees = await live({ name: 'Saree week', value: 20, scope: 'DRESS_TYPE', targets: [{ scope: 'DRESS_TYPE', refId: 'Saree' }] });
  const q1 = await quote([
    { variantId: V.silk, quantity: 1 }, { variantId: V.cotton, quantity: 1 }, { variantId: V.banarasi, quantity: 1 },
    { variantId: V.lehenga, quantity: 1 }, { variantId: V.blouse, quantity: 1 }
  ]);
  // Sarees 10,000 + 2,000 + 6,000 = 18,000 -> 3,600 off. Lehenga 20,000 and blouse 800 untouched.
  check('three sarees typed "Saree", "saree " and "SAREE" all get 20% off', q1.discountTotal === 3600, String(q1.discountTotal));
  check('  ...the bill is 38,800 - 3,600', q1.total === 35200, String(q1.total));
  const lehengaLine = q1.lines.find((l: any) => l.variantId === V.lehenga);
  check('  ...and the lehenga is not touched', lehengaLine?.discount === 0 && lehengaLine?.lineTotal === 20000, JSON.stringify(lehengaLine));

  const pub: any[] = await pricingQuoteService.publicOffers(CLIENT, 'ONLINE', chennai) as any;
  const pubSaree = pub.find(o => o.name === 'Saree week');
  check('the website offer list says which types it covers', pubSaree?.scope === 'DRESS_TYPE' && pubSaree?.appliesTo?.dressTypes?.[0] === 'Saree', JSON.stringify(pubSaree));

  const mirrored = translateOffer({
    id: sarees.id, name: 'Saree week', status: 'ACTIVE', trigger: 'AUTOMATIC', couponCode: null, level: 'LINE', valueType: 'PERCENTAGE',
    value: 20, maxDiscount: null, scope: 'DRESS_TYPE', targets: [{ scope: 'DRESS_TYPE', refId: 'Saree' }], minSubtotal: null, minQuantity: null,
    channels: [], locationIds: [], startsAt: yesterday, endsAt: null, usageLimit: null, usageLimitPerCustomer: null, stackable: false
  } as any, { now: new Date(), shopCurrency: 'INR', storeCurrency: 'INR', shopifyVariantOf: new Map(), shopifyProductsOf: new Map(), sellingLocationIds: [chennai] } as any);
  check('Shopify is told honestly it has no garment types', !mirrored.ok && /garment types/i.test((mirrored as any).reasons.join(' ')), JSON.stringify(mirrored));
  await pauseAll();

  // ── C. DEPARTMENTS AND PRODUCTS ────────────────────────────────────────
  console.log('\nC. A DEPARTMENT, AND A HANDFUL OF PRODUCTS');

  await live({ name: 'Menswear', value: 50, scope: 'CATEGORY', targets: [{ scope: 'CATEGORY', refId: 'MEN' }] });
  const q2 = await quote([{ variantId: V.kurta, quantity: 2 }, { variantId: V.silk, quantity: 1 }]);
  check('a department offer takes 50% off the kurtas only', q2.discountTotal === 1500, String(q2.discountTotal));
  await pauseAll();

  await live({ name: 'Two products', valueType: 'FIXED_AMOUNT', value: 300, scope: 'PRODUCT', targets: [{ scope: 'PRODUCT', refId: P.cotton }, { scope: 'PRODUCT', refId: P.blouse }] });
  const q3 = await quote([{ variantId: V.cotton, quantity: 2 }, { variantId: V.blouse, quantity: 1 }, { variantId: V.silk, quantity: 1 }]);
  check('300 off chosen products comes off each chosen line once', q3.discountTotal === 600, String(q3.discountTotal));
  const silkLine3 = q3.lines.find((l: any) => l.variantId === V.silk);
  check('  ...and not off the product that was not chosen', silkLine3?.lineTotal === 10000, JSON.stringify(silkLine3));
  await pauseAll();

  // ── D. THE WHOLE BILL ──────────────────────────────────────────────────
  console.log('\nD. 500 OFF A BILL OF 5,000 OR MORE');

  const bill = await live({ name: 'Big bill', level: 'ORDER', valueType: 'FIXED_AMOUNT', value: 500, minSubtotal: 5000 });
  const under = await quote([{ variantId: V.cotton, quantity: 2 }, { variantId: V.blouse, quantity: 1 }]); // 4,800
  check('a bill of 4,800 gets nothing', under.discountTotal === 0, String(under.discountTotal));
  const over = await quote([{ variantId: V.cotton, quantity: 2 }, { variantId: V.blouse, quantity: 2 }]); // 5,600
  check('a bill of 5,600 gets 500 off', over.discountTotal === 500 && over.total === 5100, `${over.discountTotal} / ${over.total}`);
  const linesSum = over.lines.reduce((s: number, l: any) => s + Number(l.lineTotal), 0);
  check('  ...split across the lines, so the lines still add up to the bill', Math.abs(linesSum - over.total) < 0.001, `${linesSum} vs ${over.total}`);

  const billOrder = await order(over, [{ variantId: V.cotton, quantity: 2 }, { variantId: V.blouse, quantity: 2 }]);
  check('the order is charged the quoted 5,100', Number(billOrder.total) === 5100, String(billOrder.total));
  await pauseAll();

  // ── E. MINIMUM ITEMS ───────────────────────────────────────────────────
  console.log('\nE. "BUY 3 SAREES, 15% OFF" COUNTS SAREES, NOT BLOUSES');

  await live({ name: 'Buy three', value: 15, minQuantity: 3, scope: 'DRESS_TYPE', targets: [{ scope: 'DRESS_TYPE', refId: 'saree' }] });
  const two = await quote([{ variantId: V.cotton, quantity: 2 }, { variantId: V.blouse, quantity: 5 }]);
  check('two sarees and five blouses do not qualify', two.discountTotal === 0, String(two.discountTotal));
  const three = await quote([{ variantId: V.cotton, quantity: 2 }, { variantId: V.banarasi, quantity: 1 }]);
  check('three sarees across two lines do', three.discountTotal === 1500, String(three.discountTotal));
  await pauseAll();

  // ── F. WHERE IT RUNS ───────────────────────────────────────────────────
  console.log('\nF. TILL ONLY, ONLINE ONLY, ONE SHOP ONLY');

  const tillOnly = await live({ name: 'Till only', value: 10, channels: ['POS'] });
  check('a till-only offer applies at the till', (await quote([{ variantId: V.cotton, quantity: 1 }])).discountTotal === 200);
  check('  ...and not on the website', (await quote([{ variantId: V.cotton, quantity: 1 }], { channel: 'ONLINE' })).discountTotal === 0);
  await offerService.setStatus(CLIENT, tillOnly.id, 'PAUSED', USER_ID);

  const chennaiOnly = await live({ name: 'Chennai only', value: 10, locationIds: [chennai] });
  check('a Chennai offer applies in Chennai', (await quote([{ variantId: V.cotton, quantity: 1 }])).discountTotal === 200);
  check('  ...and not in Bengaluru', (await quote([{ variantId: V.cotton, quantity: 1 }], { locationId: bengaluru })).discountTotal === 0);

  // The shop closes: the offer keeps the location it had; it is new choices that are checked.
  await prisma.stockLocation.update({ where: { id: bengaluru }, data: { active: false } });
  await refuses('choosing a location after it closed', 'Bengaluru Store is closed', () =>
    offerService.update(CLIENT, chennaiOnly.id, { locationIds: [chennai, bengaluru] } as any, USER_ID));
  await prisma.stockLocation.update({ where: { id: bengaluru }, data: { active: true } });
  await pauseAll();

  // ── G. ONCE PER CUSTOMER ───────────────────────────────────────────────
  console.log('\nG. ONCE PER CUSTOMER');

  const once = await live({ name: 'Welcome gift', valueType: 'FIXED_AMOUNT', value: 250, level: 'ORDER', usageLimitPerCustomer: 1, usageLimit: 100 });
  const lines = [{ variantId: V.cotton, quantity: 1 }];
  const first = await quote(lines, { customerId });
  check("Meena's first bill gets 250 off", first.discountTotal === 250, String(first.discountTotal));
  const firstOrder = await order(first, lines, customerId);
  const second = await quote(lines, { customerId });
  check("  ...Meena's second bill does not", second.discountTotal === 0, String(second.discountTotal));
  const lakshmi = await quote(lines, { customerId: secondCustomerId });
  check('Lakshmi still gets it', lakshmi.discountTotal === 250, String(lakshmi.discountTotal));
  const lakshmiOrder = await order(lakshmi, lines, secondCustomerId);
  const guest = await quote(lines, { customerId: null });
  check('a guest, who cannot be counted, does not', guest.discountTotal === 0, String(guest.discountTotal));

  await salesOrderService.cancelOrder(CLIENT, firstOrder.id);
  const again = await quote(lines, { customerId });
  check("cancelling Meena's order gives her use back", again.discountTotal === 250, String(again.discountTotal));

  // ── H. THE OFFER PAGE ──────────────────────────────────────────────────
  console.log('\nH. THE OFFER PAGE SAYS WHAT HAPPENED');

  const detail: any = await offerInsightService.detail(CLIENT, once.id);
  check('times used counts the order that stood', detail.stats.timesUsed === 1, String(detail.stats.timesUsed));
  check('  ...and the cancelled one as given back', detail.stats.givenBack === 1, String(detail.stats.givenBack));
  check('  ...discount given is 250', Number(detail.stats.totalDiscounted) === 250, String(detail.stats.totalDiscounted));
  check('  ...sales made is the surviving order', Number(detail.stats.salesMade) === Number(lakshmiOrder.total), `${detail.stats.salesMade} vs ${lakshmiOrder.total}`);
  check('  ...one customer', detail.stats.customers === 1, String(detail.stats.customers));
  check('recent uses list both orders, newest first', detail.recentUses.length === 2 && detail.recentUses[0].orderId === lakshmiOrder.id, JSON.stringify(detail.recentUses.map((u: any) => u.orderId)));
  check('  ...with their order numbers', detail.recentUses.every((u: any) => !!u.orderNumber));
  check('  ...and the cancelled one marked released', detail.recentUses.some((u: any) => u.status === 'RELEASED'));

  // The usage-left figure has one right answer. Pin it.
  const row = await prisma.offer.findUniqueOrThrow({ where: { id: once.id } });
  check('uses left is limit minus what the column counts', detail.stats.usesLeft === 100 - row.usageCount, `${detail.stats.usesLeft} vs 100-${row.usageCount}`);

  const productOffer: any = await offerService.create(CLIENT, base({
    name: 'History', scope: 'PRODUCT', targets: [{ scope: 'PRODUCT', refId: P.silk }], locationIds: [chennai]
  }) as any, USER_ID);
  await offerService.update(CLIENT, productOffer.id, {
    value: 25, targets: [{ scope: 'PRODUCT', refId: P.silk }, { scope: 'PRODUCT', refId: P.banarasi }],
    locationIds: [], minQuantity: 2, usageLimitPerCustomer: 1
  } as any, USER_ID, 'Diwali extension');
  const hist: any = await offerInsightService.detail(CLIENT, productOffer.id);
  check('targets arrive named', hist.targets.map((t: any) => t.label).join('|') === 'Kanchipuram Silk Saree|Banarasi Saree' ||
    hist.targets.map((t: any) => t.label).sort().join('|') === 'Banarasi Saree|Kanchipuram Silk Saree', JSON.stringify(hist.targets));
  check('history has two versions, newest first', hist.history.length === 2 && hist.history[0].version === 2, JSON.stringify(hist.history.map((h: any) => h.version)));
  check('  ...naming who changed it', hist.history[0].changedBy === 'Priya Manager', hist.history[0].changedBy);
  check('  ...and the note they left', hist.history[0].note === 'Diwali extension');
  const said = hist.history[0].changes.join(' ');
  check('  ...saying the value changed in words', /from 10% off to 25% off/.test(said), said);
  check('  ...naming the product added', /Added Banarasi Saree/.test(said), said);
  check('  ...that it now runs everywhere', /every location/.test(said), said);
  check('  ...that it needs 2 items', /at least 2 items/.test(said), said);
  check('  ...and the per-customer limit', /1 per customer/.test(said), said);
  check('  ...and nothing that did not change', !/Start moved|priority/i.test(said), said);

  // A product that is later deleted still has a name in history rather than an id.
  const pure = describeChanges(
    { valueType: 'PERCENTAGE', value: '10', scope: 'PRODUCT', targets: [{ scope: 'PRODUCT', refId: 'gone' }], startsAt: yesterday },
    { valueType: 'PERCENTAGE', value: '10', scope: 'PRODUCT', targets: [], startsAt: yesterday },
    { targets: new Map(), locations: new Map() }
  );
  check('a deleted product reads as removed, not as an id', pure.join(' ') === 'Removed an item that was removed.', pure.join(' '));

  // ── I. PICKERS ─────────────────────────────────────────────────────────
  console.log('\nI. WHAT THE PICKERS OFFER');

  const opts: any = await offerInsightService.options(CLIENT);
  const saree = opts.dressTypes.find((t: any) => t.value === 'Saree');
  check('"Saree", "saree " and "SAREE" are one type in the list', opts.dressTypes.filter((t: any) => t.value.toLowerCase().trim() === 'saree').length === 1, JSON.stringify(opts.dressTypes));
  check('  ...counting the three sarees on sale, not the binned one', saree?.count === 3, JSON.stringify(saree));
  check('  ...spelt as the catalogue spells it', saree?.value === 'Saree');
  check('a catalogue type with no products yet is still offered', opts.dressTypes.some((t: any) => t.value === 'Anarkali' && t.count === 0));
  check('a typed type not in the catalogue is offered too', opts.dressTypes.some((t: any) => t.value === 'Lehenga' && t.count === 1));
  check('departments come with counts', opts.departments.find((d: any) => d.value === 'WOMEN')?.count === 5, JSON.stringify(opts.departments));
  check('closed locations are not offered', !opts.locations.some((l: any) => l.id === closedShop) && opts.locations.length === 2, JSON.stringify(opts.locations));

  const bySku = await offerInsightService.search(CLIENT, 'PRODUCT', `SKU-banarasi-${STAMP}`);
  check('a product can be found by its SKU', bySku.length === 1 && bySku[0].label === 'Banarasi Saree', JSON.stringify(bySku));
  const binned = await offerInsightService.search(CLIENT, 'PRODUCT', 'Old Stock');
  check('  ...but not one in the bin', binned.length === 0, JSON.stringify(binned));
  const items = await offerInsightService.search(CLIENT, 'VARIANT', 'lehenga');
  check('items are found by product name and say their SKU', items.length === 1 && items[0].sub.includes('SKU-lehenga'), JSON.stringify(items));
  const theirs = await offerInsightService.search(CLIENT, 'PRODUCT', 'Not yours');
  check("another shop's products never appear", theirs.length === 0);
  await refuses('searching departments is not a thing', 'Search products or items', () => offerInsightService.search(CLIENT, 'CATEGORY', 'x'));

  void bill; void dupes;
}

main()
  .catch(e => { failed++; failures.push(`crashed: ${e?.message ?? e}`); console.error(e); })
  .finally(async () => {
    for (const c of [CLIENT, OTHER]) {
      await prisma.salesOrderItemDiscount.deleteMany({ where: { salesOrderDiscount: { salesOrder: { clientId: c } } } });
      await prisma.salesOrderDiscount.deleteMany({ where: { salesOrder: { clientId: c } } });
      await prisma.inventoryReservation.deleteMany({ where: { clientId: c } });
      await prisma.salesOrderItem.deleteMany({ where: { salesOrder: { clientId: c } } });
      await prisma.salesOrder.deleteMany({ where: { clientId: c } });
      await prisma.pricingQuote.deleteMany({ where: { clientId: c } });
      await prisma.offerRedemption.deleteMany({ where: { clientId: c } });
      await prisma.offerVersion.deleteMany({ where: { offer: { clientId: c } } });
      await prisma.offerTarget.deleteMany({ where: { offer: { clientId: c } } });
      await prisma.offer.deleteMany({ where: { clientId: c } });
      await prisma.inventoryStock.deleteMany({ where: { clientId: c } });
      await prisma.productVariant.deleteMany({ where: { clientId: c } });
      await prisma.product.deleteMany({ where: { clientId: c } });
      await prisma.customer.deleteMany({ where: { clientId: c } });
      await prisma.clientCatalogItem.deleteMany({ where: { clientId: c } });
      await prisma.user.deleteMany({ where: { clientId: c } });
      await prisma.stockLocation.deleteMany({ where: { clientId: c } });
      await prisma.clientSequence.deleteMany({ where: { clientId: c } });
    }
    await prisma.$disconnect();
    console.log(`\nRESULT: ${passed} passed | ${failed} failed`);
    if (failures.length) console.log('Failures:\n  - ' + failures.join('\n  - '));
    process.exit(failed ? 1 : 0);
  });
