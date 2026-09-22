/**
 * The second round of offer rules, as a shop would use them.
 *
 *   per piece      "200 off each saree" on three sarees is 600, not 200
 *   exclusions     "everything except bridal" -- and on a whole bill, the excluded piece neither
 *                  counts towards the minimum nor takes a share of the discount
 *   customer groups  VIP only; a guest is in no group
 *   happy hours    weekdays 4-7 pm on the SHOP's clock, including a window across midnight
 *   single-use codes  good once; two tills with the same card at the same moment -- one wins;
 *                  a cancelled order gives the code back
 *   duplicate      a draft copy, never the original's codes or uses
 *   till limit     10% by hand; more needs a manager; a system order is not a person
 *
 * Throwaway tenant, deleted at the end. Section H needs the API running.
 *
 *   npx tsx src/scripts/verify-offer-rules-b.ts
 */
import axios from 'axios';
import jwt from 'jsonwebtoken';
import { prisma } from '../lib/prisma';
import { pricingQuoteService } from '../services/pricing';
import {
  offerService, offerInsightService, withinSchedule, validateSchedule, describeSchedule,
  describeChanges, CODE_ALPHABET
} from '../services/offers';
import { salesOrderService } from '../services/sales-order.service';
import { customerService } from '../services/customer.service';
import { translateOffer } from '../services/shopify-discounts';
import { getPermission } from '../config/permissions';
import { forgetShopSettings } from '../lib/clientSettings';

const BASE = process.env.VERIFY_API_URL || 'http://localhost:4006/api/v1';

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
const CLIENT = `orb-${STAMP}`;
const OTHER = `orb-other-${STAMP}`;
const USER = `orb-user-${STAMP}`;
const yesterday = new Date(Date.now() - 86400000);

let shop = '';
let meena = '';
let lakshmi = '';
const P: Record<string, string> = {};
const V: Record<string, string> = {};

const base = (over: any = {}) => ({
  name: 'Offer', trigger: 'AUTOMATIC', level: 'LINE', valueType: 'PERCENTAGE',
  value: 10, scope: 'ALL', startsAt: yesterday, endsAt: null, ...over
});
const live = async (over: any = {}) => {
  const o: any = await offerService.create(CLIENT, base(over) as any, USER);
  await offerService.setStatus(CLIENT, o.id, 'ACTIVE', USER);
  return o;
};
const pauseAll = async () => {
  for (const o of await prisma.offer.findMany({ where: { clientId: CLIENT, status: 'ACTIVE' } })) {
    await offerService.setStatus(CLIENT, o.id, 'PAUSED', USER);
  }
};
const quote = (lines: any[], over: any = {}) =>
  pricingQuoteService.quote(CLIENT, { locationId: shop, channel: 'POS', lines, ...over }) as Promise<any>;
const order = (q: any, lines: any[], over: any = {}, caller?: any) =>
  salesOrderService.createFullOrder(CLIENT, shop, {
    customer: { id: over.customerId ?? meena }, quoteId: q?.quoteId, items: lines,
    couponCodes: over.couponCodes ?? [], ...(over.data ?? {})
  }, 'POS', caller) as Promise<any>;

const mirrorable = (over: any) => ({
  id: 'x', name: 'X', status: 'ACTIVE', trigger: 'AUTOMATIC', couponCode: null, level: 'LINE', valueType: 'PERCENTAGE',
  value: 10, maxDiscount: null, scope: 'ALL', targets: [], minSubtotal: null, minQuantity: null, channels: [], locationIds: [],
  startsAt: yesterday, endsAt: null, usageLimit: null, usageLimitPerCustomer: null, stackable: false, ...over
});
const mirrorCtx: any = { now: new Date(), shopCurrency: 'INR', storeCurrency: 'INR', shopifyVariantOf: new Map(), shopifyProductsOf: new Map(), sellingLocationIds: [] };
const reasons = (r: any) => (r.ok ? '(accepted)' : r.reasons.join(' '));

async function product(key: string, title: string, dressType: string | null, price: number) {
  const p = await prisma.product.create({
    data: { clientId: CLIENT, productCode: `PRD-${key}`, title, slug: `${key}-${STAMP}`, category: 'WOMEN', dressType, basePrice: price, status: 'ACTIVE', productType: 'READY_TO_WEAR' }
  });
  P[key] = p.id;
  const v = await prisma.productVariant.create({
    data: { clientId: CLIENT, productId: p.id, sku: `SKU-${key}-${STAMP}`, variantCode: `VAR-${key}`, size: 'Free', colorName: 'Red', sellingPrice: price, averageCost: 100 }
  });
  V[key] = v.id;
  await prisma.inventoryStock.create({ data: { clientId: CLIENT, variantId: v.id, locationId: shop, quantity: 500, reservedQty: 0 } });
}

async function main() {
  console.log('SETUP: one shop, sarees, a lehenga, two customers');
  shop = (await prisma.stockLocation.create({ data: { clientId: CLIENT, name: 'Store', code: 'ST', type: 'STORE', active: true } })).id;
  meena = (await prisma.customer.create({ data: { clientId: CLIENT, customerCode: 'C1', name: 'Meena', status: 'ACTIVE' } })).id;
  lakshmi = (await prisma.customer.create({ data: { clientId: CLIENT, customerCode: 'C2', name: 'Lakshmi', status: 'ACTIVE' } })).id;
  await prisma.user.create({ data: { id: USER, clientId: CLIENT, name: 'Owner', email: `orb-${STAMP}@example.com`, password: 'x' } as any });
  await product('silk', 'Silk Saree', 'Saree', 10000);
  await product('cotton', 'Cotton Saree', 'Saree', 2000);
  await product('banarasi', 'Banarasi Saree', 'Saree', 6000);
  await product('lehenga', 'Bridal Lehenga', 'Lehenga', 20000);
  const foreign = await prisma.product.create({ data: { clientId: OTHER, productCode: 'F', title: 'Theirs', slug: `f-${STAMP}`, category: 'WOMEN', basePrice: 1, status: 'ACTIVE', productType: 'READY_TO_WEAR' } });

  // ── A. PER PIECE ───────────────────────────────────────────────────────
  console.log('\nA. "200 OFF EACH SAREE" IS PER PIECE');
  const each = await live({ name: 'Each piece', valueType: 'FIXED_AMOUNT', value: 200, perPiece: true, scope: 'DRESS_TYPE', targets: [{ scope: 'DRESS_TYPE', refId: 'Saree' }] });
  const q1 = await quote([{ variantId: V.cotton, quantity: 3 }, { variantId: V.lehenga, quantity: 1 }]);
  check('three sarees at 200 off each piece is 600 off', q1.discountTotal === 600, String(q1.discountTotal));
  check('  ...stored as per piece', (await prisma.offer.findUniqueOrThrow({ where: { id: each.id } })).perPiece === true);
  await offerService.update(CLIENT, each.id, { perPiece: false } as any, USER);
  const q2 = await quote([{ variantId: V.cotton, quantity: 3 }]);
  check('once per line instead: 200 off the line of three', q2.discountTotal === 200, String(q2.discountTotal));
  await pauseAll();

  const pct: any = await offerService.create(CLIENT, base({ name: 'Pct', perPiece: true }) as any, USER);
  check('per piece on a percentage is not stored -- it means nothing there', pct.perPiece === false);
  const bill: any = await offerService.create(CLIENT, base({ name: 'Bill', level: 'ORDER', valueType: 'FIXED_AMOUNT', value: 100, perPiece: true }) as any, USER);
  check('per piece on a whole bill is not stored either', bill.perPiece === false);

  check('Shopify takes a per-piece amount as "each item"', (() => { const r: any = translateOffer(mirrorable({ valueType: 'FIXED_AMOUNT', value: 200, perPiece: true }) as any, mirrorCtx); return r.ok && r.input.customerGets.value.discountAmount.appliesOnEachItem === true; })());
  check('  ...and still refuses once-per-line, saying what would work', /each piece, or off the whole bill/.test(reasons(translateOffer(mirrorable({ valueType: 'FIXED_AMOUNT', value: 200, perPiece: false }) as any, mirrorCtx))));

  // ── B. EXCLUSIONS ──────────────────────────────────────────────────────
  console.log('\nB. EVERYTHING EXCEPT...');
  await live({ name: 'Not bridal', value: 20, exclusions: [{ scope: 'PRODUCT', refId: P.lehenga }] });
  const q3 = await quote([{ variantId: V.cotton, quantity: 1 }, { variantId: V.lehenga, quantity: 1 }]);
  check('20% off everything except the lehenga takes 400, not 4,400', q3.discountTotal === 400, String(q3.discountTotal));
  const pub: any[] = await pricingQuoteService.publicOffers(CLIENT, 'ONLINE', shop) as any;
  check('the website is told what it leaves out, by product code', pub.find(o => o.name === 'Not bridal')?.excludes?.productCodes?.[0] === 'PRD-lehenga', JSON.stringify(pub.find(o => o.name === 'Not bridal')?.excludes));
  await pauseAll();

  await live({ name: 'Sarees but not Banarasi', value: 10, scope: 'DRESS_TYPE', targets: [{ scope: 'DRESS_TYPE', refId: 'saree' }], exclusions: [{ scope: 'PRODUCT', refId: P.banarasi }] });
  const q4 = await quote([{ variantId: V.silk, quantity: 1 }, { variantId: V.banarasi, quantity: 1 }]);
  check('sarees except the Banarasi: only the silk gets 10%', q4.discountTotal === 1000, String(q4.discountTotal));
  await pauseAll();

  await live({ name: '500 off big bills, not bridal', level: 'ORDER', valueType: 'FIXED_AMOUNT', value: 500, minSubtotal: 5000, exclusions: [{ scope: 'DRESS_TYPE', refId: 'Lehenga' }] });
  const q5 = await quote([{ variantId: V.cotton, quantity: 2 }, { variantId: V.lehenga, quantity: 1 }]);
  check('a 24,000 bill with a 20,000 lehenga does not reach 5,000 of everything else', q5.discountTotal === 0, String(q5.discountTotal));
  check('  ...and says how much more is needed of the rest', (q5.nearMisses ?? []).some((n: any) => /1000\.00 more/.test(n.reason)), JSON.stringify(q5.nearMisses));
  const q6 = await quote([{ variantId: V.cotton, quantity: 3 }, { variantId: V.lehenga, quantity: 1 }]);
  const lehengaLine = q6.lines.find((l: any) => l.variantId === V.lehenga);
  check('6,000 of sarees beside the lehenga gets the 500', q6.discountTotal === 500, String(q6.discountTotal));
  check('  ...and the lehenga takes no share of it', lehengaLine.discount === 0 && lehengaLine.lineTotal === 20000, JSON.stringify(lehengaLine));
  const o6 = await order(q6, [{ variantId: V.cotton, quantity: 3 }, { variantId: V.lehenga, quantity: 1 }]);
  check('  ...and the order is written that way', Number(o6.total) === 25500, String(o6.total));
  await pauseAll();

  await refuses('the same thing included and left out', 'both included and left out', () => offerService.create(CLIENT, base({ scope: 'DRESS_TYPE', targets: [{ scope: 'DRESS_TYPE', refId: 'Saree' }], exclusions: [{ scope: 'DRESS_TYPE', refId: ' saree' }] }) as any));
  await refuses('leaving out "everything"', 'Leave out departments', () => offerService.create(CLIENT, base({ exclusions: [{ scope: 'ALL', refId: 'x' }] }) as any));
  await refuses("leaving out another shop's product", 'no longer exists', () => offerService.create(CLIENT, base({ exclusions: [{ scope: 'PRODUCT', refId: foreign.id }] }) as any));
  check('Shopify is told it cannot leave items out', /cannot leave items out/.test(reasons(translateOffer(mirrorable({ exclusions: [{ scope: 'PRODUCT', refId: 'p' }] }) as any, mirrorCtx))));

  // ── C. CUSTOMER GROUPS ─────────────────────────────────────────────────
  console.log('\nC. VIP CUSTOMERS ONLY');
  const tagged: any = await customerService.updateCustomer(CLIENT, meena, { tags: [' vip ', 'VIP', 'Wedding  party'] });
  check('customer groups are tidied: trimmed, one VIP, spaces squeezed', JSON.stringify(tagged.tags) === JSON.stringify(['vip', 'Wedding party']), JSON.stringify(tagged.tags));
  await live({ name: 'VIP', value: 15, customerTags: ['VIP'] });
  check('Meena, tagged vip, gets the VIP offer', (await quote([{ variantId: V.cotton, quantity: 1 }], { customerId: meena })).discountTotal === 300);
  check('Lakshmi, in no group, does not', (await quote([{ variantId: V.cotton, quantity: 1 }], { customerId: lakshmi })).discountTotal === 0);
  check('a guest does not', (await quote([{ variantId: V.cotton, quantity: 1 }])).discountTotal === 0);
  check('the website list, which has no customer, leaves it out', !(await pricingQuoteService.publicOffers(CLIENT, 'ONLINE', shop) as any[]).some(o => o.name === 'VIP'));
  const opts: any = await offerInsightService.options(CLIENT);
  check('the picker lists the groups with how many customers are in each', opts.customerTags.some((t: any) => t.value === 'vip' && t.count === 1), JSON.stringify(opts.customerTags));
  check('Shopify is told it would give a group offer to everyone', /every/.test(reasons(translateOffer(mirrorable({ customerTags: ['VIP'] }) as any, mirrorCtx))));
  await refuses('a group name of 41 characters', 'up to 40 characters', () => offerService.create(CLIENT, base({ customerTags: ['x'.repeat(41)] }) as any));
  await pauseAll();

  // ── D. HAPPY HOURS ─────────────────────────────────────────────────────
  console.log('\nD. WEEKDAYS 4 TO 7 PM, ON THE SHOP\'S CLOCK');
  const tz = 'Asia/Kolkata';
  const weekday = { days: [1, 2, 3, 4, 5], from: '16:00', to: '19:00' };
  // 2026-09-16 is a Wednesday. 17:00 IST is 11:30 UTC.
  check('Wednesday 5 pm in Chennai is inside', withinSchedule(weekday, new Date('2026-09-16T11:30:00Z'), tz));
  check('  ...though the server clock says 11:30 am', new Date('2026-09-16T11:30:00Z').getUTCHours() === 11);
  check('Wednesday 7 pm exactly is outside -- the end is exclusive', !withinSchedule(weekday, new Date('2026-09-16T13:30:00Z'), tz));
  check('Wednesday 3:59 pm is outside', !withinSchedule(weekday, new Date('2026-09-16T10:29:00Z'), tz));
  check('Saturday 5 pm is outside', !withinSchedule(weekday, new Date('2026-09-19T11:30:00Z'), tz));
  const lateFriday = { days: [5], from: '22:00', to: '02:00' };
  check('a Friday 10 pm-2 am window is open at 1 am on Saturday', withinSchedule(lateFriday, new Date('2026-09-18T19:30:00Z'), tz));
  check('  ...and closed at 1 am on Friday (that is Thursday night)', !withinSchedule(lateFriday, new Date('2026-09-17T19:30:00Z'), tz));
  check('  ...and closed at 11 pm on Saturday', !withinSchedule(lateFriday, new Date('2026-09-19T17:30:00Z'), tz));
  check('described in words', describeSchedule(weekday) === 'Mon–Fri, 4 pm–7 pm', String(describeSchedule(weekday)));
  check('a start equal to the end is refused', validateSchedule({ from: '10:00', to: '10:00' }).length === 1);
  check('an hour of 25:00 is refused', validateSchedule({ from: '25:00', to: '10:00' }).length === 1);
  check('no days chosen is refused', validateSchedule({ days: [], from: '10:00', to: '11:00' }).length === 1);

  // Starts well before the fixed Wednesday checked below; "yesterday" stops being before it once the calendar moves on.
  const happy = await live({ name: 'Happy hour', value: 25, schedule: weekday, startsAt: new Date('2026-09-01T00:00:00Z') });
  const inside = await pricingQuoteService.liveOffers(CLIENT, 'POS', shop, null, [], new Date('2026-09-16T11:30:00Z'));
  const outside = await pricingQuoteService.liveOffers(CLIENT, 'POS', shop, null, [], new Date('2026-09-19T11:30:00Z'));
  check('the live offers at Wednesday 5 pm include the happy hour', inside.some(o => o.id === happy.id));
  check('  ...and on Saturday they do not', !outside.some(o => o.id === happy.id));
  const allWeek: any = await offerService.create(CLIENT, base({ name: 'All week', schedule: { days: [0, 1, 2, 3, 4, 5, 6], from: '09:00', to: '10:00' } }) as any, USER);
  check('all seven days are stored as every day', (allWeek.schedule as any).days === undefined, JSON.stringify(allWeek.schedule));
  check('Shopify is told it cannot keep hours', /certain hours/.test(reasons(translateOffer(mirrorable({ schedule: weekday }) as any, mirrorCtx))));
  await pauseAll();

  // ── E. SINGLE-USE CODES ────────────────────────────────────────────────
  console.log('\nE. SINGLE-USE CODES');
  await refuses('a single-use offer with a shared code as well', 'no shared code as well', async () => {
    // The service tidies the shared code away itself; the rule is checked on the draft directly.
    const { validateOffer } = await import('../services/offers');
    const p = validateOffer({ ...base({ trigger: 'CODE', couponCode: 'SHARED', uniqueCodes: true }) } as any);
    if (p.length) throw new Error(p.join(' '));
  });
  const single: any = await offerService.create(CLIENT, base({ name: 'Welcome card', trigger: 'CODE', uniqueCodes: true, valueType: 'FIXED_AMOUNT', level: 'ORDER', value: 300 }) as any, USER);
  check('a single-use offer saves with no shared code', single.uniqueCodes === true && single.couponCode === null, JSON.stringify({ u: single.uniqueCodes, c: single.couponCode }));
  await refuses('starting it before any codes exist', 'no unused codes yet', () => offerService.setStatus(CLIENT, single.id, 'ACTIVE', USER));
  await refuses('a prefix with a space', 'letters or numbers', () => offerService.makeCodes(CLIENT, single.id, 'WEL COME', 5));
  await refuses('5,001 codes at once', 'at most 5000', () => offerService.makeCodes(CLIENT, single.id, 'WELCOME', 5001));
  const made: any = await offerService.makeCodes(CLIENT, single.id, 'welcome', 25);
  check('25 codes are made', made.made === 25 && made.total === 25 && made.unused === 25, JSON.stringify(made));
  const listed: any = await offerService.listCodes(CLIENT, single.id, { all: true });
  const codes: string[] = listed.codes.map((c: any) => c.code);
  check('  ...all different', new Set(codes).size === 25);
  check('  ...shaped WELCOME-XXXXXXXX from the unambiguous alphabet', codes.every(c => new RegExp(`^WELCOME-[${CODE_ALPHABET}]{8}$`).test(c)), codes[0]);
  check('  ...with no 0, O, 1, I or L to misread', codes.every(c => !/[01OIL]/.test(c.slice(8))));
  await offerService.setStatus(CLIENT, single.id, 'ACTIVE', USER);

  const card = codes[0];
  const lines = [{ variantId: V.cotton, quantity: 1 }];
  const withCode = await quote(lines, { couponCodes: [card.toLowerCase()] });
  check('a code typed in lower case still works', withCode.discountTotal === 300, JSON.stringify({ d: withCode.discountTotal, r: withCode.rejected }));
  const spentOrder = await order(withCode, lines, { couponCodes: [card.toLowerCase()] });
  const row = await prisma.offerCode.findFirstOrThrow({ where: { clientId: CLIENT, code: card } });
  check('ordering spends the code against that order', row.usedAt != null && row.salesOrderId === spentOrder.id);
  const disc = await prisma.salesOrderDiscount.findFirst({ where: { salesOrderId: spentOrder.id, source: 'OFFER' } });
  check('  ...and the order says which code', disc?.code === card, String(disc?.code));
  const again = await quote(lines, { couponCodes: [card] });
  check('the same card again takes nothing off', again.discountTotal === 0);
  check('  ...and says it has already been used, not that it does not exist', again.rejected.some((r: any) => r.code === card && /already been used/.test(r.reason)), JSON.stringify(again.rejected));

  // Two tills, one card, the same moment.
  const racer = codes[1];
  const qa = await quote(lines, { couponCodes: [racer], customerId: meena });
  const qb = await quote(lines, { couponCodes: [racer], customerId: lakshmi });
  check('both tills are quoted the discount', qa.discountTotal === 300 && qb.discountTotal === 300);
  const results = await Promise.allSettled([
    order(qa, lines, { couponCodes: [racer], customerId: meena }),
    order(qb, lines, { couponCodes: [racer], customerId: lakshmi })
  ]);
  const won = results.filter(r => r.status === 'fulfilled');
  const lost = results.filter(r => r.status === 'rejected') as PromiseRejectedResult[];
  check('exactly one till gets the card', won.length === 1 && lost.length === 1, results.map(r => r.status).join(','));
  check('  ...the other is told the code was used', lost.length === 1 && /already been used/.test(String(lost[0].reason?.message)), String(lost[0]?.reason?.message));
  check('  ...and no half-written order is left behind', (await prisma.salesOrder.count({ where: { clientId: CLIENT, items: { none: {} } } })) === 0);

  await salesOrderService.cancelOrder(CLIENT, spentOrder.id);
  const back = await prisma.offerCode.findFirstOrThrow({ where: { clientId: CLIENT, code: card } });
  check('cancelling the order gives the code back', back.usedAt === null && back.salesOrderId === null);
  check('  ...and it works again', (await quote(lines, { couponCodes: [card] })).discountTotal === 300);

  const counts: any = await offerService.listCodes(CLIENT, single.id, { status: 'USED' });
  check('the code list counts one used of 25', counts.used === 1 && counts.unused === 24 && counts.codes.length === 1, JSON.stringify({ u: counts.used, n: counts.unused }));
  check('  ...and names the order it went on', !!counts.codes[0].orderNumber);
  const detail: any = await offerInsightService.detail(CLIENT, single.id);
  check('the offer page shows the code counts', detail.codes?.total === 25 && detail.codes?.used === 1, JSON.stringify(detail.codes));
  check('  ...and which code each order used', detail.recentUses.some((u: any) => u.code === racer), JSON.stringify(detail.recentUses.map((u: any) => u.code)));

  await refuses('a shared code that is already a single-use code', 'already one of your single-use codes', () => offerService.create(CLIENT, base({ trigger: 'CODE', couponCode: codes[5].toLowerCase() }) as any));
  await refuses('switching single-use codes off once they exist', 'would all stop working', () => offerService.update(CLIENT, single.id, { uniqueCodes: false, couponCode: 'SHAREDNOW' } as any, USER));
  check('Shopify is told single-use codes stay here', /stay with your till/.test(reasons(translateOffer(mirrorable({ trigger: 'CODE', uniqueCodes: true }) as any, mirrorCtx))));
  await pauseAll();

  // ── F. DUPLICATE ───────────────────────────────────────────────────────
  console.log('\nF. A COPY TO START FROM');
  // Last year's sale: already ended, so it stays a draft -- which is exactly what gets copied.
  const original: any = await offerService.create(CLIENT, base({
    name: 'Deepavali', trigger: 'CODE', couponCode: 'DEEPAVALI', value: 20,
    startsAt: new Date(Date.now() - 20 * 86400000), endsAt: new Date(Date.now() - 86400000),
    exclusions: [{ scope: 'PRODUCT', refId: P.lehenga }], customerTags: ['VIP'], schedule: weekday, locationIds: [shop]
  }) as any, USER);
  const copy: any = await offerService.duplicate(CLIENT, original.id, USER);
  check('the copy is a draft named "Copy of Deepavali"', copy.status === 'DRAFT' && copy.name === 'Copy of Deepavali');
  check('  ...with a code of its own', copy.couponCode === 'DEEPAVALI-COPY', copy.couponCode);
  check('  ...its rules copied: exclusions, groups, hours, locations', copy.exclusions.length === 1 && copy.customerTags[0] === 'VIP' && (copy.schedule as any).from === '16:00' && copy.locationIds[0] === shop);
  check('  ...but not its past dates: it starts now and has no end', new Date(copy.startsAt).getTime() > Date.now() - 60000 && copy.endsAt === null);
  check('  ...and nothing used', copy.usageCount === 0);
  const copy2: any = await offerService.duplicate(CLIENT, original.id, USER);
  check('a second copy gets DEEPAVALI-COPY2', copy2.couponCode === 'DEEPAVALI-COPY2', copy2.couponCode);
  const singleCopy: any = await offerService.duplicate(CLIENT, single.id, USER);
  check("a copy of a single-use offer does not take the original's codes", singleCopy.uniqueCodes === true && (await prisma.offerCode.count({ where: { offerId: singleCopy.id } })) === 0);

  // ── G. THE TILL LIMIT ──────────────────────────────────────────────────
  console.log('\nG. HOW MUCH THE TILL MAY TAKE OFF BY HAND');
  await refuses('a limit of 0%', 'above 0', () => offerService.setSettings(CLIENT, { manualDiscountMaxPercent: 0 }));
  await refuses('a limit of 101%', 'up to 100', () => offerService.setSettings(CLIENT, { manualDiscountMaxPercent: 101 }));
  await refuses('a limit of 10.125%', 'two decimal places', () => offerService.setSettings(CLIENT, { manualDiscountMaxPercent: 10.125 }));
  check('a limit of 10% saves', (await offerService.setSettings(CLIENT, { manualDiscountMaxPercent: 10 })).manualDiscountMaxPercent === 10);
  const cashier = { userId: USER, mayExceedManualLimit: false };
  const line = (amount: number) => [{ variantId: V.cotton, quantity: 1, manualDiscount: { amount, reason: 'Small mark on the hem' } }];
  const ok = await order(null, line(200), {}, cashier);
  check('200 off a 2,000 saree (10%) is allowed', !!ok.id);
  const manualRow = await prisma.salesOrderDiscount.findFirst({ where: { salesOrderId: ok.id, source: 'MANUAL' } });
  check('  ...and the order records who took it off', manualRow?.appliedBy === USER, String(manualRow?.appliedBy));
  await refuses('201 off it (10.05%) is not', 'more than the 10%', () => order(null, line(201), {}, cashier));
  check('a manager may take 500 off', !!(await order(null, line(500), {}, { userId: USER, mayExceedManualLimit: true })).id);
  check('an order written by a system, with no person, is not limited', !!(await order(null, line(500))).id);
  await refuses('11% off the whole bill by hand is not allowed either', 'this order', () =>
    order(null, [{ variantId: V.cotton, quantity: 1 }], { data: { manualDiscount: { amount: 220, reason: 'Loyal customer' } } }, cashier));
  await offerService.setSettings(CLIENT, { manualDiscountMaxPercent: null });
  check('clearing the limit lifts it at once', !!(await order(null, line(900), {}, cashier)).id);

  // ── H. OVER HTTP ───────────────────────────────────────────────────────
  console.log(`\nH. THE SAME RULES OVER HTTP  (${BASE})`);
  await offerService.setSettings(CLIENT, { manualDiscountMaxPercent: 10 });
  forgetShopSettings(CLIENT);
  const roleWith = async (name: string, keys: string[]) => {
    await prisma.permission.createMany({ data: keys.map(key => ({ key, description: getPermission(key)?.label ?? key })), skipDuplicates: true });
    const perms = await prisma.permission.findMany({ where: { key: { in: keys } } });
    const role = await prisma.role.create({ data: { clientId: CLIENT, name, description: name } });
    await prisma.rolePermission.createMany({ data: perms.map(p => ({ roleId: role.id, permissionId: p.id })), skipDuplicates: true });
    return role;
  };
  const userAs = async (email: string, roleId: string) => {
    const u = await prisma.user.create({ data: { clientId: CLIENT, email, name: email, password: 'x', status: 'ACTIVE' } });
    await prisma.userRole.create({ data: { userId: u.id, roleId } });
    const token = jwt.sign({ sub: u.id, clientId: CLIENT, iss: 'scal_easy_auth', aud: 'scal_easy_inventory' }, process.env.JWT_SECRET!, { expiresIn: '1h' });
    return axios.create({ baseURL: BASE, headers: { Authorization: `Bearer ${token}` }, validateStatus: () => true });
  };
  const till = ['sales_order:view', 'sales_order:create', 'product:view', 'offer:manual_discount', 'offer:view'];
  const cashierApi = await userAs(`cashier-${STAMP}@example.com`, (await roleWith('CASHIER', till)).id);
  const managerApi = await userAs(`manager-${STAMP}@example.com`, (await roleWith('MANAGER', [...till, 'offer:manual_discount_unlimited', 'offer:settings', 'offer:create', 'offer:update'])).id);
  const httpOrder = (amount: number) => ({ customer: { id: meena }, locationId: shop, items: line(amount) });

  const small = await cashierApi.post('/sales-orders/full', httpOrder(150));
  check('a cashier may take 7.5% off by hand', small.status === 201, `${small.status} ${small.data?.message}`);
  const big = await cashierApi.post('/sales-orders/full', httpOrder(600));
  check('a cashier taking 30% off is refused with 403', big.status === 403, `${big.status} ${big.data?.message}`);
  check('  ...in words that say what to do', /manager has to take this one off/.test(big.data?.message ?? ''), big.data?.message);
  const managed = await managerApi.post('/sales-orders/full', httpOrder(600));
  check('a manager taking 30% off is allowed', managed.status === 201, `${managed.status} ${managed.data?.message}`);
  const setByCashier = await cashierApi.put('/offers/settings', { manualDiscountMaxPercent: 90 });
  check('a cashier cannot raise the limit', setByCashier.status === 403, String(setByCashier.status));
  const setByManager = await managerApi.put('/offers/settings', { manualDiscountMaxPercent: 15 });
  check('the owner can', setByManager.status === 200 && setByManager.data?.data?.manualDiscountMaxPercent === 15, JSON.stringify(setByManager.data));
  const readBack = await cashierApi.get('/offers/settings');
  check('  ...and anyone who sees offers can read it', readBack.data?.data?.manualDiscountMaxPercent === 15);
  const dup = await managerApi.post(`/offers/${original.id}/duplicate`);
  check('duplicate over HTTP', dup.status === 201 && /^Copy of/.test(dup.data?.data?.name ?? ''), `${dup.status} ${dup.data?.message}`);
  const mk = await managerApi.post(`/offers/${single.id}/codes`, { prefix: 'CARD', count: 3 });
  check('making codes over HTTP', mk.status === 201 && mk.data?.data?.made === 3, `${mk.status} ${JSON.stringify(mk.data).slice(0, 120)}`);
  const mkCashier = await cashierApi.post(`/offers/${single.id}/codes`, { prefix: 'CARD', count: 3 });
  check('a cashier cannot make codes', mkCashier.status === 403, String(mkCashier.status));
  // Unspent codes are money: seeing them needs the same permission as making them.
  const lsCashier = await cashierApi.get(`/offers/${single.id}/codes`, { params: { status: 'unused', all: 1 } });
  check('a cashier cannot list or copy out the codes', lsCashier.status === 403, String(lsCashier.status));
  const ls = await managerApi.get(`/offers/${single.id}/codes`, { params: { status: 'unused', take: 5 } });
  check('the code list pages, five at a time', ls.status === 200 && ls.data?.data?.codes?.length === 5 && ls.data?.data?.unused === 27, JSON.stringify(ls.data?.data && { n: ls.data.data.codes.length, u: ls.data.data.unused }));

  // ── I. HISTORY ─────────────────────────────────────────────────────────
  console.log('\nI. THE HISTORY SAYS IT IN WORDS');
  const said = describeChanges(
    { valueType: 'FIXED_AMOUNT', value: '200', level: 'LINE', scope: 'ALL', perPiece: false, exclusions: [], customerTags: [], schedule: null, startsAt: yesterday },
    { valueType: 'FIXED_AMOUNT', value: '200', level: 'LINE', scope: 'ALL', perPiece: true, exclusions: [{ scope: 'DRESS_TYPE', refId: 'Lehenga' }], customerTags: ['VIP'], schedule: weekday, uniqueCodes: true, trigger: 'CODE', startsAt: yesterday },
    { targets: new Map(), locations: new Map() }
  ).join(' ');
  for (const [what, re] of [['per piece', /each piece/], ['left out', /leaves out Lehenga/], ['groups', /only for VIP customers/], ['hours', /Mon–Fri, 4 pm–7 pm/], ['codes', /single-use codes/]] as const) {
    check(`history mentions ${what}`, re.test(said), said);
  }
  check('  ...and never "needs the code null"', !/null/.test(said), said);
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
      await prisma.offerCode.deleteMany({ where: { clientId: c } });
      await prisma.offerVersion.deleteMany({ where: { offer: { clientId: c } } });
      await prisma.offer.deleteMany({ where: { clientId: c } });
      await prisma.inventoryStock.deleteMany({ where: { clientId: c } });
      await prisma.productVariant.deleteMany({ where: { clientId: c } });
      await prisma.product.deleteMany({ where: { clientId: c } });
      await prisma.customer.deleteMany({ where: { clientId: c } });
      await prisma.userRole.deleteMany({ where: { user: { clientId: c } } });
      await prisma.user.deleteMany({ where: { clientId: c } });
      await prisma.rolePermission.deleteMany({ where: { role: { clientId: c } } });
      await prisma.role.deleteMany({ where: { clientId: c } });
      await prisma.clientSettings.deleteMany({ where: { clientId: c } });
      await prisma.stockLocation.deleteMany({ where: { clientId: c } });
      await prisma.clientSequence.deleteMany({ where: { clientId: c } });
    }
    await prisma.$disconnect();
    console.log(`\nRESULT: ${passed} passed | ${failed} failed`);
    if (failures.length) console.log('Failures:\n  - ' + failures.join('\n  - '));
    process.exit(failed ? 1 : 0);
  });
