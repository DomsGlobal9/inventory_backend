/**
 * Offers, attacked from the customer's side.
 *
 * verify-offer-rules-b proves each rule does what it says. This tries to make them charge a
 * customer the wrong amount, hand out something twice, or fall over:
 *
 *   A  the website: badges that must not leak group or code offers, a known shopper in a group,
 *      a single-use code typed badly, the order placed ONLINE with its own quote, replayed, and
 *      sent twice at once
 *   B  the world changing between "this is your price" and "pay": offer paused, hours ended,
 *      customer taken out of the group, code spent at another till, allowance run out, quote
 *      expired -- each either honoured or refused cleanly, never half-written
 *   C  money that must always add up: 300 random baskets against random offers
 *   D  per piece and exclusions at their edges: an amount bigger than the price, everything
 *      excluded, paise that do not divide
 *   E  single-use codes under pressure: ten tills, three cards; the same card twice in one
 *      basket; another shop's card; a paused offer's card; cancelled after it shipped; returned
 *   F  the till limit at exactly the line, and junk sent where numbers belong
 *   G  duplicate: of a retired offer, of one whose product went to the bin, twice at once
 *   H  another shop cannot see or touch any of it
 *   I  junk over HTTP: never a 500, never our internals
 *
 * Throwaway tenants, deleted at the end. Needs the API running.
 *
 *   npx tsx src/scripts/verify-offers-worst-cases.ts
 */
import axios, { AxiosInstance } from 'axios';
import jwt from 'jsonwebtoken';
import { prisma } from '../lib/prisma';
import { seedRolesForClient } from '../services/rbac-seed.service';
import { inventoryMutationService } from '../services/inventory-mutation.service';
import { generateCredential } from '../utils/storefrontCredential';
import { pricingQuoteService, priceBasket } from '../services/pricing';
import { offerService, withinSchedule } from '../services/offers';
import { salesOrderService } from '../services/sales-order.service';
import { returnService } from '../services/return.service';
import { dispatchService } from '../services/dispatch.service';

const BASE = process.env.VERIFY_API_URL || 'http://localhost:4006/api/v1';

let passed = 0, failed = 0;
const failures: string[] = [];
const check = (name: string, ok: boolean, detail?: string) => {
  if (ok) { passed++; console.log(`  [PASS] ${name}`); }
  else { failed++; failures.push(name); console.log(`  [FAIL] ${name}${detail ? `  -> ${detail}` : ''}`); }
};
async function refuses(name: string, fragment: RegExp, fn: () => Promise<any>) {
  try { await fn(); check(name, false, 'it was accepted'); }
  catch (e: any) { check(name, fragment.test(String(e?.message ?? e)), `"${e?.message ?? e}"`); }
}

const STAMP = Date.now();
const CLIENT = `owc-${STAMP}`;
const OTHER = `owc-other-${STAMP}`;
const yesterday = new Date(Date.now() - 86400000);
const num = (v: any) => Number(v ?? 0);
const un = (r: any) => (r?.data?.data !== undefined ? r.data.data : r?.data);
const brief = (r: any) => `${r.status} ${JSON.stringify(r.data).slice(0, 200)}`;
const leaks = (t: string) => /(\\|\/)src(\\|\/)|node_modules|prisma\.|PrismaClient|Invalid `|postgres(ql)?:\/\/|at [A-Za-z]+ \(/i.test(t);
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

let shop = '';
let secret = '';
const V: Record<string, { id: string; code: string; product: string }> = {};
const C: Record<string, string> = {};

async function person(clientId: string, role: string, email: string, roleIds: Record<string, string>): Promise<AxiosInstance> {
  const user = await prisma.user.create({ data: { clientId, email, name: role, password: 'unused', status: 'ACTIVE' } });
  await prisma.userRole.create({ data: { userId: user.id, roleId: roleIds[role] } });
  const token = jwt.sign({ sub: user.id, clientId, iss: 'scal_easy_auth', aud: 'scal_easy_inventory' }, process.env.JWT_SECRET!, { expiresIn: '1h' });
  return axios.create({ baseURL: BASE, headers: { Authorization: `Bearer ${token}` }, validateStatus: () => true });
}

const website = (path: string, body?: any, key = secret) => axios.request({
  url: `${BASE}/storefront/v1${path}`, method: body ? 'POST' : 'GET', data: body,
  headers: { 'X-Storefront-Key': key }, validateStatus: () => true
});

const live = async (input: any) => {
  const o: any = await offerService.create(CLIENT, {
    trigger: 'AUTOMATIC', level: 'LINE', valueType: 'PERCENTAGE', scope: 'ALL', startsAt: yesterday, endsAt: null, ...input
  }, 'owner');
  if (input.uniqueCodes) await offerService.makeCodes(CLIENT, o.id, 'CARD', input.codeCount ?? 10);
  await offerService.setStatus(CLIENT, o.id, 'ACTIVE', 'owner');
  return o;
};
const pauseAll = async () => {
  for (const o of await prisma.offer.findMany({ where: { clientId: CLIENT, status: 'ACTIVE' } })) await offerService.setStatus(CLIENT, o.id, 'PAUSED', 'owner');
};
const codesOf = async (offerId: string) => (await prisma.offerCode.findMany({ where: { offerId, usedAt: null }, orderBy: { code: 'asc' } })).map(c => c.code);
const quote = (lines: any[], over: any = {}) => pricingQuoteService.quote(CLIENT, { locationId: shop, channel: 'POS', lines, ...over }) as Promise<any>;
const order = (q: any, lines: any[], over: any = {}) => salesOrderService.createFullOrder(CLIENT, shop, {
  customer: { id: over.customerId ?? C.meena }, quoteId: q?.quoteId ?? null, items: lines, couponCodes: over.couponCodes ?? [], ...(over.data ?? {})
}, over.channel ?? 'POS', over.caller) as Promise<any>;

async function product(key: string, title: string, dressType: string | null, price: number, stock = 200) {
  const p = await prisma.product.create({ data: { clientId: CLIENT, productCode: `P-${key}`, title, slug: `${key}-${STAMP}`, category: 'WOMEN', dressType, basePrice: price, status: 'ACTIVE', productType: 'READY_TO_WEAR' } });
  const v = await prisma.productVariant.create({ data: { clientId: CLIENT, productId: p.id, sku: `SKU-${key}-${STAMP}`, variantCode: `VC-${key}-${STAMP}`, size: 'Free', colorName: 'Red', sellingPrice: price } });
  await inventoryMutationService.applyMovement({ clientId: CLIENT, variantId: v.id, locationId: shop, movementType: 'IN', reason: 'PURCHASE_RECEIPT', quantityDelta: stock, unitCost: Math.round(price / 2) });
  V[key] = { id: v.id, code: v.variantCode, product: p.id };
}

async function main() {
  console.log(`SETUP: a shop with real role templates, a website, products and customers  (${BASE})`);
  const roleIds = await seedRolesForClient(CLIENT);
  const owner = await person(CLIENT, 'SUPER_ADMIN', `o-${STAMP}@example.com`, roleIds);
  const sales = await person(CLIENT, 'SALES', `s-${STAMP}@example.com`, roleIds);
  const otherRoles = await seedRolesForClient(OTHER);
  const outsider = await person(OTHER, 'SUPER_ADMIN', `x-${STAMP}@example.com`, otherRoles);

  shop = (await prisma.stockLocation.create({ data: { clientId: CLIENT, name: 'Store', code: 'ST', type: 'STORE', active: true } })).id;
  await product('silk', 'Silk Saree', 'Saree', 10000);
  await product('cotton', 'Cotton Saree', 'Saree', 999.99);
  await product('blouse', 'Blouse', 'Blouse', 333.33);
  await product('lehenga', 'Bridal Lehenga', 'Lehenga', 25000);
  C.meena = (await prisma.customer.create({ data: { clientId: CLIENT, customerCode: 'C1', name: 'Meena', status: 'ACTIVE', externalCustomerId: 'web-meena', tags: ['VIP'] } })).id;
  C.lakshmi = (await prisma.customer.create({ data: { clientId: CLIENT, customerCode: 'C2', name: 'Lakshmi', status: 'ACTIVE', externalCustomerId: 'web-lakshmi' } })).id;
  C.guest = (await prisma.customer.create({ data: { clientId: CLIENT, customerCode: 'C3', name: 'Walk-in', status: 'ACTIVE' } })).id;
  const cred = generateCredential();
  await prisma.storefrontConnection.create({ data: { clientId: CLIENT, name: 'Website', status: 'ACTIVE', baseUrl: 'https://example.invalid', credentialHash: cred.hash, credentialPrefix: cred.prefix, locationIds: [shop] } });
  secret = cred.plaintext;

  // ── A. THE WEBSITE ─────────────────────────────────────────────────────
  console.log('\nA. A SHOPPER ON THE WEBSITE');
  const everyone = await live({ name: 'Website 10%', value: 10, channels: ['ONLINE'] });
  const vipOnly = await live({ name: 'VIP 30%', value: 30, customerTags: ['vip'], stackable: false, priority: 5 });
  const nightOnly = await live({ name: 'Midnight', value: 50, schedule: { from: '03:00', to: '03:01' } });
  const cards = await live({ name: 'Card 500', trigger: 'CODE', uniqueCodes: true, level: 'ORDER', valueType: 'FIXED_AMOUNT', value: 500, stackable: true, codeCount: 20 });
  const cardCodes = await codesOf(cards.id);

  const badges = await website('/offers');
  const names = (un(badges)?.offers ?? []).map((o: any) => o.name);
  check('the website badges list the offer everyone gets', badges.status === 200 && names.includes('Website 10%'), brief(badges));
  check('  ...but not the VIP offer -- a stranger is not VIP', !names.includes('VIP 30%'), names.join(','));
  check('  ...nor the single-use card offer', !names.includes('Card 500'), names.join(','));
  const nowIst = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date());
  check('  ...nor an offer outside its hours', nowIst === '03:00' || !names.includes('Midnight'), `${nowIst} ${names.join(',')}`);

  const basket = [{ variantCode: V.silk.code, quantity: 1 }];
  const asStranger = un(await website('/pricing/quote', { lines: basket }));
  check('a stranger gets 10%', asStranger?.discountTotal === 1000, JSON.stringify(asStranger?.discountTotal));
  const asMeena = un(await website('/pricing/quote', { lines: basket, customerExternalId: 'web-meena' }));
  check('Meena, known to the website and VIP, gets the better 30%', asMeena?.discountTotal === 3000, JSON.stringify(asMeena?.discountTotal));
  const asUnknown = un(await website('/pricing/quote', { lines: basket, customerExternalId: 'web-nobody' }));
  check('an external id the shop has never seen is a guest, not an error', asUnknown?.discountTotal === 1000, JSON.stringify(asUnknown));

  const typedBadly = un(await website('/pricing/quote', { lines: basket, couponCodes: [`  ${cardCodes[0].toLowerCase()}  `] }));
  check('a card typed in lower case with spaces still works', typedBadly?.discountTotal === 1000 + 500, JSON.stringify({ d: typedBadly?.discountTotal, r: typedBadly?.rejected }));

  // The website places its order with the quote it was given.
  const webLines = [{ variantId: V.silk.id, quantity: 1 }];
  const wq = un(await website('/pricing/quote', { lines: basket, couponCodes: [cardCodes[0]] }));
  const placed = await sales.post('/sales-orders/full', {
    customer: { externalId: 'web-lakshmi', name: 'Lakshmi' }, locationId: shop, channel: 'ONLINE',
    quoteId: wq.quoteId, couponCodes: [cardCodes[0]], items: webLines, externalOrderId: `WEB-1-${STAMP}`, sourceSystem: 'website'
  });
  check('an ONLINE order with its ONLINE quote goes through', placed.status === 201, brief(placed));
  check('  ...at the price the shopper was shown', num(un(placed)?.total) === wq.total, `${un(placed)?.total} vs ${wq.total}`);
  check('  ...and spends the card', (await prisma.offerCode.findFirst({ where: { code: cardCodes[0] } }))?.usedAt != null);
  check('  ...and is recorded as an online sale', un(placed)?.channel === 'ONLINE', un(placed)?.channel);

  const replay = await sales.post('/sales-orders/full', {
    customer: { externalId: 'web-lakshmi' }, locationId: shop, channel: 'ONLINE', quoteId: wq.quoteId, couponCodes: [cardCodes[0]], items: webLines
  });
  check('the same quote sent again as a new order is refused', replay.status >= 400 && replay.status < 500, brief(replay));
  check('  ...in words, without our internals', !leaks(JSON.stringify(replay.data)), JSON.stringify(replay.data));

  const wq2 = un(await website('/pricing/quote', { lines: basket, couponCodes: [cardCodes[1]] }));
  const twice = await Promise.all([1, 2].map(() => sales.post('/sales-orders/full', {
    customer: { externalId: 'web-lakshmi' }, locationId: shop, channel: 'ONLINE', quoteId: wq2.quoteId, couponCodes: [cardCodes[1]], items: webLines,
    externalOrderId: `WEB-2-${STAMP}`, sourceSystem: 'website'
  })));
  const ids = twice.filter(r => r.status === 201).map(r => un(r)?.id);
  check('a checkout fired twice at once makes ONE order, and both calls are told it worked', ids.length === 2 && ids[0] === ids[1], twice.map(brief).join(' | '));
  check('  ...the card is spent once, on that order', (await prisma.offerCode.findFirst({ where: { code: cardCodes[1] } }))?.salesOrderId === ids[0]);
  check('  ...and the allowance counted once', (await prisma.offerRedemption.count({ where: { offerId: cards.id, salesOrderId: ids[0] } })) === 1);

  const wq3 = un(await website('/pricing/quote', { lines: basket, couponCodes: [cardCodes[2]] }));
  const dropped = await sales.post('/sales-orders/full', {
    customer: { externalId: 'web-lakshmi' }, locationId: shop, channel: 'ONLINE', quoteId: wq3.quoteId, items: webLines
  });
  check('an order that quietly drops the code it was quoted with is refused', dropped.status === 400 && /basket has changed/i.test(dropped.data?.message ?? ''), brief(dropped));
  check('  ...and the card is still good', (await prisma.offerCode.findFirst({ where: { code: cardCodes[2] } }))?.usedAt == null);
  const posQuoteOnline = un(await sales.post('/pricing/quote', { locationId: shop, channel: 'POS', lines: webLines }));
  const mismatch = await sales.post('/sales-orders/full', { customer: { id: C.guest }, locationId: shop, channel: 'ONLINE', quoteId: posQuoteOnline.quoteId, items: webLines });
  check('a till quote cannot be used to place a website order', mismatch.status === 400, brief(mismatch));
  await pauseAll();
  void everyone; void vipOnly; void nightOnly;

  // ── B. BETWEEN THE PRICE AND THE PAYMENT ───────────────────────────────
  console.log('\nB. THE WORLD CHANGES BETWEEN "YOUR PRICE" AND "PAY"');
  const lines1 = [{ variantId: V.cotton.id, quantity: 2 }];

  const paused = await live({ name: 'Paused mid-checkout', value: 20 });
  const qp = await quote(lines1);
  await offerService.setStatus(CLIENT, paused.id, 'PAUSED', 'owner');
  const op = await order(qp, lines1);
  check('an offer paused mid-checkout: the customer still pays what they were shown', num(op.total) === qp.total && qp.discountTotal > 0, `${op.total} vs ${qp.total}`);

  const groupOffer = await live({ name: 'VIP gift', valueType: 'FIXED_AMOUNT', level: 'ORDER', value: 100, customerTags: ['VIP'] });
  const qg = await quote(lines1, { customerId: C.meena });
  await prisma.customer.update({ where: { id: C.meena }, data: { tags: [] } });
  const og = await order(qg, lines1, { customerId: C.meena });
  check('taken out of VIP mid-checkout: still the quoted price', num(og.total) === qg.total && qg.discountTotal === 100, `${og.total} ${qg.discountTotal}`);
  check('  ...but the next basket is not VIP', (await quote(lines1, { customerId: C.meena })).discountTotal === 0);
  await prisma.customer.update({ where: { id: C.meena }, data: { tags: ['VIP'] } });
  await offerService.setStatus(CLIENT, groupOffer.id, 'PAUSED', 'owner');
  await offerService.setStatus(CLIENT, paused.id, 'PAUSED', 'owner').catch(() => {});

  const firstOne = await live({ name: 'First one only', value: 50, usageLimit: 1 });
  const qa = await quote(lines1, { customerId: C.meena });
  const qb = await quote(lines1, { customerId: C.lakshmi });
  await order(qa, lines1, { customerId: C.meena });
  const before = await prisma.salesOrder.count({ where: { clientId: CLIENT } });
  await refuses('"first one only": the second customer, quoted before it ran out, is refused', /used as many times/, () => order(qb, lines1, { customerId: C.lakshmi }));
  check('  ...and no order, reservation or redemption is left behind', (await prisma.salesOrder.count({ where: { clientId: CLIENT } })) === before);
  await offerService.setStatus(CLIENT, firstOne.id, 'PAUSED', 'owner');

  const single = await live({ name: 'Card 200', trigger: 'CODE', uniqueCodes: true, valueType: 'FIXED_AMOUNT', level: 'ORDER', value: 200, codeCount: 12 });
  const sCodes = await codesOf(single.id);
  const q1 = await quote(lines1, { couponCodes: [sCodes[0]] });
  const q2 = await quote(lines1, { couponCodes: [sCodes[0]], customerId: C.lakshmi });
  await order(q1, lines1, { couponCodes: [sCodes[0]] });
  const reservedBefore = (await prisma.inventoryStock.findFirstOrThrow({ where: { variantId: V.cotton.id, locationId: shop } })).reservedQty;
  await refuses('the same card spent at another till while this customer paid: refused', /already been used/, () =>
    order(q2, lines1, { couponCodes: [sCodes[0]], customerId: C.lakshmi, data: { status: 'CONFIRMED' } }));
  check('  ...nothing reserved for the refused order', (await prisma.inventoryStock.findFirstOrThrow({ where: { variantId: V.cotton.id, locationId: shop } })).reservedQty === reservedBefore);

  const qe = await quote(lines1, { couponCodes: [sCodes[1]] });
  await prisma.pricingQuote.update({ where: { id: qe.quoteId }, data: { expiresAt: new Date(Date.now() - 1000) } });
  await refuses('a quote left open past fifteen minutes is refused', /expired/, () => order(qe, lines1, { couponCodes: [sCodes[1]] }));
  check('  ...and its card is not spent', (await prisma.offerCode.findFirst({ where: { code: sCodes[1] } }))?.usedAt == null);

  const qarch = await quote(lines1, { couponCodes: [sCodes[2]] });
  await offerService.setStatus(CLIENT, single.id, 'ARCHIVED', 'owner');
  const oarch = await order(qarch, lines1, { couponCodes: [sCodes[2]] });
  check('an offer retired mid-checkout still honours the card the customer was quoted', num(oarch.total) === qarch.total && qarch.discountTotal === 200);
  const afterRetire = await quote(lines1, { couponCodes: [sCodes[3]] });
  check('  ...but a retired offer\'s card on a new basket says it is not valid now', afterRetire.discountTotal === 0 && /not valid for this order right now/.test(afterRetire.rejected?.[0]?.reason ?? ''), JSON.stringify(afterRetire.rejected));
  await refuses('  ...and a retired offer cannot be given new codes', /retired/, () => offerService.makeCodes(CLIENT, single.id, 'MORE', 5));

  // ── C. MONEY ALWAYS ADDS UP ────────────────────────────────────────────
  console.log('\nC. 300 RANDOM BASKETS AGAINST RANDOM OFFERS');
  let seed = 7;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const pick = <T,>(a: T[]) => a[Math.floor(rnd() * a.length)];
  const types = ['Saree', 'Blouse', 'Lehenga'];
  let broken = 0; let example = '';
  for (let i = 0; i < 300; i++) {
    const lines = Array.from({ length: 1 + Math.floor(rnd() * 4) }, (_, k) => ({
      variantId: `v${k}`, productId: `p${Math.floor(rnd() * 3)}`, category: 'WOMEN', dressType: pick(types),
      quantity: 1 + Math.floor(rnd() * 5), listUnitPriceMinor: 1 + Math.floor(rnd() * 3_000_00)
    }));
    const offers = Array.from({ length: Math.floor(rnd() * 5) }, (_, k) => {
      const valueType = pick(['PERCENTAGE', 'FIXED_AMOUNT', 'FIXED_PRICE'] as const);
      const level = valueType === 'FIXED_PRICE' ? 'LINE' : pick(['LINE', 'ORDER'] as const);
      return {
        id: `o${k}`, versionId: null, name: `o${k}`, trigger: 'AUTOMATIC' as const, couponCode: null, level,
        valueType, value: valueType === 'PERCENTAGE' ? 1 + Math.floor(rnd() * 100) : Math.round(rnd() * 5000 * 100) / 100,
        maxDiscount: rnd() < 0.3 ? 500 : null, scope: level === 'LINE' && rnd() < 0.5 ? 'DRESS_TYPE' as const : 'ALL' as const,
        targets: [{ scope: 'DRESS_TYPE', refId: pick(types) }], minSubtotalMinor: rnd() < 0.3 ? Math.floor(rnd() * 500000) : null,
        minQuantity: rnd() < 0.2 ? 1 + Math.floor(rnd() * 4) : null, priority: Math.floor(rnd() * 3), stackable: rnd() < 0.5,
        createdAt: new Date(STAMP - k), perPiece: rnd() < 0.5, exclusions: rnd() < 0.3 ? [{ scope: 'PRODUCT', refId: `p${Math.floor(rnd() * 3)}` }] : []
      };
    }).map(o => (o.scope === 'ALL' ? { ...o, targets: [] } : o));
    const r = priceBasket(lines as any, offers as any, []);
    const sum = r.lines.reduce((s, l) => s + l.lineTotalMinor, 0);
    const problems = [
      r.totalMinor < 0 && 'total below zero',
      sum !== r.totalMinor && `lines ${sum} != total ${r.totalMinor}`,
      r.discountTotalMinor < 0 && 'negative discount',
      r.discountTotalMinor > r.subtotalMinor && 'discount above subtotal',
      r.lines.some(l => l.lineTotalMinor < 0) && 'a line below zero',
      r.lines.some(l => !Number.isInteger(l.lineTotalMinor) || !Number.isInteger(l.discountMinor)) && 'fractional paise',
      r.lines.some((l, idx) => l.discountMinor !== lines[idx].listUnitPriceMinor * lines[idx].quantity - l.lineTotalMinor) && 'line discount does not explain the line',
      r.lines.some(l => l.appliedOffers.reduce((s, a) => s + a.amountMinor, 0) !== l.discountMinor) && 'applied offers do not add up to the line discount',
      r.lines.some((l, idx) => offers.some(o => (o.exclusions ?? []).some(e => e.refId === lines[idx].productId) && l.appliedOffers.some(a => a.offerId === o.id))) && 'an excluded line got the offer'
    ].filter(Boolean);
    if (problems.length) { broken++; if (!example) example = `${problems.join('; ')} :: ${JSON.stringify({ lines, offers }).slice(0, 400)}`; }
  }
  check('every basket: never below zero, lines add to the total, discounts explain every paisa, exclusions respected', broken === 0, `${broken} broken. ${example}`);

  // Two bill offers that do not combine: the customer gets the better one, and is told about the other.
  const billOffer = (id: string, value: number, created: number, extra: any = {}) => ({
    id, versionId: null, name: id, trigger: 'AUTOMATIC' as const, couponCode: null, level: 'ORDER' as const, valueType: 'FIXED_AMOUNT' as const,
    value, maxDiscount: null, scope: 'ALL' as const, targets: [], minSubtotalMinor: null, minQuantity: null, priority: 0, stackable: false,
    createdAt: new Date(created), ...extra
  });
  const bill = priceBasket([{ variantId: 'v', productId: 'p', category: 'WOMEN', quantity: 1, listUnitPriceMinor: 500000 }] as any,
    [billOffer('Old 100 off', 100, 1), billOffer('Newer 300 card', 300, 2, { trigger: 'CODE', couponCode: 'CARD300' })] as any, ['CARD300']);
  check('an older 100-off does not beat a newer 300-off card on the same bill: the customer gets 300', bill.discountTotalMinor === 30000, String(bill.discountTotalMinor));
  const lose = priceBasket([{ variantId: 'v', productId: 'p', category: 'WOMEN', quantity: 1, listUnitPriceMinor: 500000 }] as any,
    [billOffer('Big 500 off', 500, 1), billOffer('Card 300', 300, 2, { trigger: 'CODE', couponCode: 'CARD300' })] as any, ['CARD300']);
  check('a 300 card losing to a 500-off that does not combine is told why, not "nothing qualifies"', lose.discountTotalMinor === 50000 && /already takes money off this bill, and the two do not combine/.test(lose.rejected.find(r => r.code === 'CARD300')?.reason ?? ''), JSON.stringify(lose.rejected));

  // ── D. PER PIECE AND EXCLUSIONS AT THEIR EDGES ─────────────────────────
  console.log('\nD. PER PIECE AND EXCLUSIONS AT THE EDGES');
  await live({ name: '5,000 off each blouse', valueType: 'FIXED_AMOUNT', value: 5000, perPiece: true, scope: 'DRESS_TYPE', targets: [{ scope: 'DRESS_TYPE', refId: 'Blouse' }] });
  const huge = await quote([{ variantId: V.blouse.id, quantity: 7 }, { variantId: V.silk.id, quantity: 1 }]);
  const bl = huge.lines.find((l: any) => l.variantId === V.blouse.id);
  check('5,000 off each 333.33 blouse makes the blouses free, never a refund', bl.lineTotal === 0 && huge.total === 10000, JSON.stringify(bl));
  await pauseAll();

  await live({ name: 'Bill 100.01 off, not bridal', level: 'ORDER', valueType: 'FIXED_AMOUNT', value: 100.01, exclusions: [{ scope: 'PRODUCT', refId: V.lehenga.product }] });
  const onlyBridal = await quote([{ variantId: V.lehenga.id, quantity: 1 }]);
  check('a bill of nothing but excluded items: no discount, no error', onlyBridal.discountTotal === 0 && onlyBridal.total === 25000, JSON.stringify(onlyBridal.discountTotal));
  const odd = await quote([{ variantId: V.cotton.id, quantity: 1 }, { variantId: V.blouse.id, quantity: 1 }, { variantId: V.blouse.id === V.cotton.id ? V.silk.id : V.silk.id, quantity: 1 }, { variantId: V.lehenga.id, quantity: 1 }]);
  const shares = odd.lines.map((l: any) => l.discount);
  check('100.01 split over three lines to the paisa, the lehenga taking none', Math.abs(shares.reduce((s: number, d: number) => s + d, 0) - 100.01) < 0.0001 && odd.lines.find((l: any) => l.variantId === V.lehenga.id).discount === 0, JSON.stringify(shares));
  const oOdd = await order(odd, odd.lines.map((l: any) => ({ variantId: l.variantId, quantity: l.quantity })));
  const rows = await prisma.salesOrderItemDiscount.findMany({ where: { salesOrderItem: { salesOrderId: oOdd.id } } });
  check('  ...and the order\'s allocation rows add up to exactly 100.01', Math.abs(rows.reduce((s, r) => s + num(r.amount), 0) - 100.01) < 0.0001, JSON.stringify(rows.map(r => num(r.amount))));
  await pauseAll();

  // ── E. SINGLE-USE CODES UNDER PRESSURE ─────────────────────────────────
  console.log('\nE. TEN TILLS, THREE CARDS');
  const rush = await live({ name: 'Rush card', trigger: 'CODE', uniqueCodes: true, level: 'ORDER', valueType: 'FIXED_AMOUNT', value: 150, codeCount: 3 });
  const rCodes = await codesOf(rush.id);
  const tills = await Promise.all(Array.from({ length: 10 }, (_, i) => quote(lines1, { couponCodes: [rCodes[i % 3]] })));
  check('all ten tills are quoted a card', tills.every(q => q.discountTotal === 150));
  const outcome = await Promise.allSettled(tills.map((q, i) => order(q, lines1, { couponCodes: [rCodes[i % 3]] })));
  const ok = outcome.filter(o => o.status === 'fulfilled').length;
  check('exactly three orders get a card; the other seven are refused', ok === 3, `${ok} fulfilled; ${outcome.filter(o => o.status === 'rejected').map((o: any) => o.reason?.message).slice(0, 2).join(' | ')}`);
  check('  ...every refusal says the code was used, none crashed', outcome.every(o => o.status === 'fulfilled' || /already been used|already used/i.test(String((o as any).reason?.message))), outcome.filter(o => o.status === 'rejected').map((o: any) => o.reason?.message).join(' | '));
  check('  ...three codes, three orders, three redemptions', (await prisma.offerRedemption.count({ where: { offerId: rush.id } })) === 3 && (await prisma.offerCode.count({ where: { offerId: rush.id, usedAt: { not: null } } })) === 3);

  const batch = await live({ name: 'Two in one', trigger: 'CODE', uniqueCodes: true, level: 'ORDER', valueType: 'FIXED_AMOUNT', value: 100, codeCount: 4 });
  const bCodes = await codesOf(batch.id);
  const both = await quote(lines1, { couponCodes: [bCodes[0], bCodes[1], bCodes[0].toLowerCase()] });
  check('two cards of the same offer in one basket take off 100 once', both.discountTotal === 100, JSON.stringify(both.discountTotal));
  const oBoth = await order(both, lines1, { couponCodes: [bCodes[0], bCodes[1], bCodes[0].toLowerCase()] });
  check('  ...and spend exactly one card; the other stays good', (await prisma.offerCode.count({ where: { offerId: batch.id, salesOrderId: oBoth.id } })) === 1 && (await quote(lines1, { couponCodes: [bCodes[1]] })).discountTotal === 100);

  await offerService.setStatus(CLIENT, batch.id, 'PAUSED', 'owner');
  const pausedCard = await quote(lines1, { couponCodes: [bCodes[2]] });
  check('a card for a paused offer: nothing off, and told it is not valid right now -- not that it does not exist', pausedCard.discountTotal === 0 && /not valid for this order right now/.test(pausedCard.rejected?.[0]?.reason ?? ''), JSON.stringify(pausedCard.rejected));
  const made = await prisma.offerCode.findFirst({ where: { offerId: rush.id } });
  await prisma.customer.create({ data: { clientId: OTHER, customerCode: 'X1', name: 'Other', status: 'ACTIVE' } });
  const otherShop = await prisma.stockLocation.create({ data: { clientId: OTHER, name: 'Other', code: 'O', type: 'STORE', active: true } });
  const otherP = await prisma.product.create({ data: { clientId: OTHER, productCode: 'OP', title: 'x', slug: `op-${STAMP}`, category: 'WOMEN', basePrice: 100, status: 'ACTIVE', productType: 'READY_TO_WEAR' } });
  const otherV = await prisma.productVariant.create({ data: { clientId: OTHER, productId: otherP.id, sku: `OS-${STAMP}`, variantCode: `OV-${STAMP}`, size: 'F', colorName: 'R', sellingPrice: 100 } });
  const foreignCard: any = await pricingQuoteService.quote(OTHER, { locationId: otherShop.id, channel: 'POS', lines: [{ variantId: otherV.id, quantity: 1 }], couponCodes: [made!.code] });
  check("another shop's card is unknown in this shop", foreignCard.discountTotal === 0 && /no offer with that code/.test(foreignCard.rejected?.[0]?.reason ?? ''), JSON.stringify(foreignCard.rejected));

  // Spent, shipped, then cancelled: the card must NOT come back.
  await offerService.setStatus(CLIENT, batch.id, 'ACTIVE', 'owner');
  const shipQ = await quote(lines1, { couponCodes: [bCodes[3]] });
  const shipped = await order(shipQ, lines1, { couponCodes: [bCodes[3]], data: { status: 'CONFIRMED' } });
  const shippedItems = await prisma.salesOrderItem.findMany({ where: { salesOrderId: shipped.id } });
  await dispatchService.createDispatch(CLIENT, shipped.id, [{ salesOrderItemId: shippedItems[0].id, quantity: 1 }]);
  await salesOrderService.cancelOrder(CLIENT, shipped.id).catch(() => {});
  check('a card on an order that partly shipped and was then cancelled stays spent', (await prisma.offerCode.findFirst({ where: { code: bCodes[3] } }))?.usedAt != null);
  const dItem = await prisma.dispatchItem.findFirstOrThrow({ where: { salesOrderItemId: shippedItems[0].id } });
  const ret: any = await returnService.createReturn(CLIENT, shipped.id, [{ dispatchItemId: dItem.id, quantity: 1 }], 'size', 'SIZE_ISSUE' as any);
  const retRow = await prisma.salesReturn.findUniqueOrThrow({ where: { id: ret.id } });
  const paidEach = num(shippedItems[0].totalPrice) / shippedItems[0].quantity;
  check('  ...a return refunds what that piece actually cost after the card, not its tag', Math.abs(num(retRow.refundTotal) - paidEach) < 0.011, `${retRow.refundTotal} vs ${paidEach}`);
  check('  ...and the return does not give the card back either', (await prisma.offerCode.findFirst({ where: { code: bCodes[3] } }))?.usedAt != null);
  await pauseAll();

  const twoBatches = await Promise.all([offerService.makeCodes(CLIENT, rush.id, 'RUSH', 200), offerService.makeCodes(CLIENT, rush.id, 'RUSH', 200)]);
  const total = await prisma.offerCode.count({ where: { offerId: rush.id } });
  check('two batches made at the same instant: 400 more codes, all different', twoBatches[0].made === 200 && twoBatches[1].made === 200 && total === 403, `${twoBatches.map(b => b.made)} total ${total}`);
  const t0 = Date.now();
  await offerService.makeCodes(CLIENT, rush.id, 'BIG', 5000);
  const makeMs = Date.now() - t0;
  await offerService.setStatus(CLIENT, rush.id, 'ACTIVE', 'owner');
  const t1 = Date.now();
  const bigQuote = await quote(lines1, { couponCodes: [(await prisma.offerCode.findFirstOrThrow({ where: { offerId: rush.id, usedAt: null, code: { startsWith: 'BIG-' } } })).code] });
  const quoteMs = Date.now() - t1;
  check(`5,000 codes are made in reasonable time (${makeMs} ms)`, makeMs < 60000);
  check(`  ...and a basket still prices quickly with 5,400 codes on the offer (${quoteMs} ms)`, bigQuote.discountTotal === 150 && quoteMs < 8000, `${quoteMs} ms`);
  await pauseAll();

  // ── F. THE TILL LIMIT AT THE LINE ──────────────────────────────────────
  console.log('\nF. THE TILL LIMIT AT EXACTLY THE LINE');
  await offerService.setSettings(CLIENT, { manualDiscountMaxPercent: 10 });
  const cashier = { userId: 'cashier', mayExceedManualLimit: false };
  const hand = (amount: number) => [{ variantId: V.cotton.id, quantity: 1, manualDiscount: { amount, reason: 'Thread pulled on the pallu' } }];
  check('exactly 10% of 999.99 (99.99) is allowed', !!(await order(null, hand(99.99), { caller: cashier })).id);
  await refuses('one paisa more (100.00) is not', /more than the 10%/, () => order(null, hand(100), { caller: cashier }));
  const offerFirst = await live({ name: 'Half off cotton', value: 50, scope: 'PRODUCT', targets: [{ scope: 'PRODUCT', refId: V.cotton.product }] });
  const qHalf = await quote([{ variantId: V.cotton.id, quantity: 1 }]);
  await refuses('after an offer halves the price, the limit is 10% of what is left, not of the tag', /more than the 10%/, () => order(qHalf, hand(60), { caller: cashier }));
  await offerService.setStatus(CLIENT, offerFirst.id, 'PAUSED', 'owner');
  const badAmount = await sales.post('/sales-orders/full', { customer: { id: C.guest }, locationId: shop, items: [{ variantId: V.cotton.id, quantity: 1, manualDiscount: { amount: 'lots', reason: 'Because I said so' } }] });
  check('a manual discount of "lots" is refused before anything happens, with no crash', badAmount.status === 400 || badAmount.status === 403, brief(badAmount));
  await offerService.setSettings(CLIENT, { manualDiscountMaxPercent: null });

  // ── G. DUPLICATE AT ITS EDGES ──────────────────────────────────────────
  console.log('\nG. DUPLICATE AT THE EDGES');
  const retired: any = await offerService.create(CLIENT, { name: 'Old code offer', trigger: 'CODE', couponCode: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ123456', level: 'LINE', valueType: 'PERCENTAGE', value: 5, scope: 'PRODUCT', targets: [{ scope: 'PRODUCT', refId: V.silk.product }], startsAt: yesterday } as any, 'owner');
  await offerService.setStatus(CLIENT, retired.id, 'ARCHIVED', 'owner');
  await prisma.product.update({ where: { id: V.silk.product }, data: { status: 'TRASHED', trashedAt: new Date() } });
  const copies = await Promise.allSettled([1, 2, 3].map(() => offerService.duplicate(CLIENT, retired.id, 'owner')));
  const copyCodes = copies.filter(c => c.status === 'fulfilled').map((c: any) => c.value.couponCode);
  check('three copies at once of a retired 32-character-code offer whose product is now in the bin all succeed', copyCodes.length === 3, copies.map((c: any) => c.status === 'rejected' ? c.reason?.message : c.value.couponCode).join(' | '));
  check('  ...each with its own code, none longer than 32', new Set(copyCodes).size === 3 && copyCodes.every((c: string) => c.length <= 32), copyCodes.join(','));
  await prisma.product.update({ where: { id: V.silk.product }, data: { status: 'ACTIVE', trashedAt: null } });

  // ── H. ANOTHER SHOP ────────────────────────────────────────────────────
  console.log('\nH. ANOTHER SHOP CANNOT REACH ANY OF IT');
  check("another shop cannot list this shop's codes", [403, 404].includes((await outsider.get(`/offers/${rush.id}/codes`)).status));
  check('  ...or make codes on its offer', [403, 404].includes((await outsider.post(`/offers/${rush.id}/codes`, { prefix: 'HACK', count: 5 })).status));
  check('  ...or duplicate its offer', [400, 403, 404].includes((await outsider.post(`/offers/${rush.id}/duplicate`)).status));
  check("  ...or read this shop's till limit", un(await outsider.get('/offers/settings'))?.manualDiscountMaxPercent == null);
  check("  ...or see this shop's customer groups", !(un(await outsider.get('/offers/options'))?.customerTags ?? []).some((t: any) => t.value === 'VIP'));
  check("  ...or tag this shop's customer", [400, 403, 404].includes((await outsider.patch(`/customers/${C.meena}`, { tags: ['HACKED'] })).status));
  check('  ...and the customer is untouched', !(await prisma.customer.findUniqueOrThrow({ where: { id: C.meena } })).tags.includes('HACKED'));

  // ── J. CLOCKS ──────────────────────────────────────────────────────────
  console.log('\nJ. HAPPY HOURS ON OTHER CLOCKS');
  const ny = 'America/New_York';
  const nyEvening = { days: [0], from: '17:00', to: '19:00' };
  // 2026-03-08 is the Sunday clocks go forward in New York: 17:30 EDT is 21:30 UTC, not 22:30.
  check('a New York shop: Sunday 5:30 pm on the day clocks change is inside', withinSchedule(nyEvening, new Date('2026-03-08T21:30:00Z'), ny));
  check('  ...6:30 pm is inside and 7:30 pm is not, on the new clock', withinSchedule(nyEvening, new Date('2026-03-08T22:30:00Z'), ny) && !withinSchedule(nyEvening, new Date('2026-03-08T23:30:00Z'), ny));
  const saturdayNight = { days: [6], from: '22:00', to: '02:00' };
  // 2026-09-20 is a Sunday. 01:00 IST Sunday is 19:30 UTC Saturday.
  check('a Saturday 10 pm-2 am window is open at 1 am on Sunday', withinSchedule(saturdayNight, new Date('2026-09-19T19:30:00Z'), 'Asia/Kolkata'));
  check('  ...and closed at 1 am on the following Monday', !withinSchedule(saturdayNight, new Date('2026-09-20T19:30:00Z'), 'Asia/Kolkata'));
  check('  ...and exactly 2 am on Sunday is closed', !withinSchedule(saturdayNight, new Date('2026-09-19T20:30:00Z'), 'Asia/Kolkata'));
  check('  ...and exactly 10 pm on Saturday is open', withinSchedule(saturdayNight, new Date('2026-09-19T16:30:00Z'), 'Asia/Kolkata'));
  check('an unknown timezone does not crash the till -- it falls back to India time', (() => { try { withinSchedule(saturdayNight, new Date(), 'Mars/Olympus'); return true; } catch { return false; } })());

  // ── I. JUNK OVER HTTP ──────────────────────────────────────────────────
  console.log('\nI. JUNK WHERE DATA BELONGS: NEVER A 500, NEVER OUR INSIDES');
  await sleep(15000); // a breath for the rate limiter before a burst of bad requests
  const start = new Date().toISOString();
  const junk: [string, () => Promise<any>, boolean?][] = [
    ['schedule as a sentence', () => owner.post('/offers', { name: 'J1', valueType: 'PERCENTAGE', value: 5, startsAt: start, schedule: 'evenings' }), true],
    ['schedule with 4pm', () => owner.post('/offers', { name: 'J2', valueType: 'PERCENTAGE', value: 5, startsAt: start, schedule: { from: '4pm', to: '7pm' } }), true],
    ['days as words', () => owner.post('/offers', { name: 'J3', valueType: 'PERCENTAGE', value: 5, startsAt: start, schedule: { days: ['monday'], from: '16:00', to: '19:00' } }), true],
    ['exclusions as a string', () => owner.post('/offers', { name: 'J4', valueType: 'PERCENTAGE', value: 5, startsAt: start, exclusions: 'lehenga' }), true],
    ['exclusions with no refId', () => owner.post('/offers', { name: 'J5', valueType: 'PERCENTAGE', value: 5, startsAt: start, exclusions: [{ scope: 'PRODUCT' }] }), true],
    ['customer groups as an object', () => owner.post('/offers', { name: 'J6', valueType: 'PERCENTAGE', value: 5, startsAt: start, customerTags: { vip: true } }), true],
    ['customer groups with numbers', () => owner.post('/offers', { name: 'J7', valueType: 'PERCENTAGE', value: 5, startsAt: start, customerTags: [1, 2] }), true],
    ['single-use codes on an automatic offer', () => owner.post('/offers', { name: 'J8', valueType: 'PERCENTAGE', value: 5, startsAt: start, uniqueCodes: true }), true],
    ['perPiece as "yes"', () => owner.post('/offers', { name: 'J9', valueType: 'FIXED_AMOUNT', value: 5, startsAt: start, perPiece: 'yes' }), true],
    ['a code count of -5', () => owner.post(`/offers/${rush.id}/codes`, { prefix: 'NEG', count: -5 }), true],
    ['a code count of "all"', () => owner.post(`/offers/${rush.id}/codes`, { prefix: 'ALL', count: 'all' }), true],
    ['a prefix full of SQL', () => owner.post(`/offers/${rush.id}/codes`, { prefix: "'; DROP TABLE offers; --", count: 1 }), true],
    ['a till limit of "ten"', () => owner.put('/offers/settings', { manualDiscountMaxPercent: 'ten' }), true],
    ['customer tags as a string', () => owner.patch(`/customers/${C.lakshmi}`, { tags: 'VIP' }), true],
    ['21 customer tags', () => owner.patch(`/customers/${C.lakshmi}`, { tags: Array.from({ length: 21 }, (_, i) => `T${i}`) }), true],
    ['a 41-character tag', () => owner.patch(`/customers/${C.lakshmi}`, { tags: ['x'.repeat(41)] }), true],
    ['duplicate of an offer that does not exist', () => owner.post('/offers/00000000-0000-0000-0000-000000000000/duplicate'), true],
    ['codes of an offer that does not exist', () => owner.get('/offers/00000000-0000-0000-0000-000000000000/codes'), true],
    ['a code search full of regex', () => owner.get(`/offers/${rush.id}/codes`, { params: { q: '.*(' } })],
    ['website: couponCodes as a string', () => website('/pricing/quote', { lines: basket, couponCodes: 'SAVE' })],
    ['website: 300 codes', () => website('/pricing/quote', { lines: basket, couponCodes: Array.from({ length: 300 }, (_, i) => `C${i}`) })],
    ['website: a 5,000-character code', () => website('/pricing/quote', { lines: basket, couponCodes: ['x'.repeat(5000)] })],
    ['website: an emoji code', () => website('/pricing/quote', { lines: basket, couponCodes: ['🎉SALE'] })],
    ['order: channel "INSTAGRAM"', () => sales.post('/sales-orders/full', { customer: { id: C.guest }, locationId: shop, channel: 'INSTAGRAM', items: webLines }), true]
  ];
  for (const [label, fn, mustRefuse] of junk) {
    const r = await fn();
    const body = JSON.stringify(r.data ?? '');
    // Accepted is fine only where the junk is harmless (a regex search, an emoji code on a website).
    // What is never fine is a 500, a stack, our file paths -- or quietly saving something else.
    const refusedInWords = r.status >= 400 && r.status < 500 && typeof r.data?.message === 'string' && r.data.message.length > 0;
    check(`${label}: ${r.status}`, r.status < 500 && !leaks(body) && (!mustRefuse || refusedInWords), `${r.status} ${body.slice(0, 200)}`);
  }
  const eightyNine = await prisma.offer.count({ where: { clientId: CLIENT, name: { startsWith: 'J' } } });
  check('none of the junk offers was saved', eightyNine === 0, String(eightyNine));
  check('the SQL prefix made no codes and dropped nothing', (await prisma.offer.count({ where: { clientId: CLIENT } })) > 0 && (await prisma.offerCode.count({ where: { code: { startsWith: "'" } } })) === 0);
  check('the lakshmi tags are untouched by the junk', (await prisma.customer.findUniqueOrThrow({ where: { id: C.lakshmi } })).tags.length === 0);
}

main()
  .catch(e => { failed++; failures.push(`crashed: ${e?.message ?? e}`); console.error(e); })
  .finally(async () => {
    for (const c of [CLIENT, OTHER]) {
      await prisma.inventoryAlert.deleteMany({ where: { clientId: c } }).catch(() => {});
      await prisma.salesReturnItem.deleteMany({ where: { salesReturn: { clientId: c } } });
      await prisma.salesReturn.deleteMany({ where: { clientId: c } });
      await prisma.salesLedger.deleteMany({ where: { clientId: c } }).catch(() => {});
      await prisma.dispatchItem.deleteMany({ where: { dispatch: { clientId: c } } });
      await prisma.dispatch.deleteMany({ where: { clientId: c } });
      await prisma.salesOrderItemDiscount.deleteMany({ where: { salesOrderItem: { salesOrder: { clientId: c } } } });
      await prisma.salesOrderDiscount.deleteMany({ where: { salesOrder: { clientId: c } } });
      await prisma.inventoryReservation.deleteMany({ where: { clientId: c } });
      await prisma.salesOrderItem.deleteMany({ where: { salesOrder: { clientId: c } } });
      await prisma.salesOrder.deleteMany({ where: { clientId: c } });
      await prisma.pricingQuote.deleteMany({ where: { clientId: c } });
      await prisma.offerRedemption.deleteMany({ where: { clientId: c } });
      await prisma.offerCode.deleteMany({ where: { clientId: c } });
      await prisma.offerVersion.deleteMany({ where: { offer: { clientId: c } } });
      await prisma.offer.deleteMany({ where: { clientId: c } });
      await prisma.storefrontDelivery.deleteMany({ where: { clientId: c } }).catch(() => {});
      await prisma.storefrontEvent.deleteMany({ where: { clientId: c } }).catch(() => {});
      await prisma.storefrontConnection.deleteMany({ where: { clientId: c } });
      await prisma.inventoryTransaction.deleteMany({ where: { clientId: c } });
      await prisma.inventoryStock.deleteMany({ where: { clientId: c } });
      await prisma.productVariant.deleteMany({ where: { clientId: c } });
      await prisma.product.deleteMany({ where: { clientId: c } });
      await prisma.customer.deleteMany({ where: { clientId: c } });
      await prisma.stockLocation.deleteMany({ where: { clientId: c } });
      await prisma.userRole.deleteMany({ where: { user: { clientId: c } } });
      await prisma.user.deleteMany({ where: { clientId: c } });
      await prisma.rolePermission.deleteMany({ where: { role: { clientId: c } } });
      await prisma.role.deleteMany({ where: { clientId: c } });
      await prisma.dailyLocationSnapshot.deleteMany({ where: { clientId: c } }).catch(() => {});
      await prisma.dailyInventorySnapshot.deleteMany({ where: { clientId: c } }).catch(() => {});
      await prisma.clientSettings.deleteMany({ where: { clientId: c } }).catch(() => {});
      await prisma.clientSequence.deleteMany({ where: { clientId: c } });
    }
    await prisma.$disconnect();
    console.log(`\nRESULT: ${passed} passed | ${failed} failed`);
    if (failures.length) console.log('Failures:\n  - ' + failures.join('\n  - '));
    process.exit(failed ? 1 : 0);
  });
