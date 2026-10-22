/**
 * "Customers who bought this also bought" and "Looked at online lately", on a throwaway shop built
 * here and removed at the end. Also the shop sign-in clean-up, which used to sign shoppers out after a day.
 *
 *   npx tsx src/scripts/verify-also-bought-and-views.ts
 */
import crypto from 'node:crypto';
import { prisma } from '../lib/prisma';
import { alsoBought, alsoBoughtCodes } from '../services/also-bought';
import { seen, lookedAt, forgetOldViews } from '../services/shop-views';
import { forgetOldCodes, whoIs } from '../services/online-shop/otp';
import { customerCard } from '../services/customer-card';

const STAMP = Date.now();
const C = `ab-${STAMP}`;
const OTHER = `ab-other-${STAMP}`;
const DAY = 86_400_000;
let passed = 0, failed = 0;
const check = (name: string, ok: boolean, detail?: unknown) => {
  if (ok) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name}${detail !== undefined ? ` -- ${JSON.stringify(detail).slice(0, 400)}` : ''}`); }
};

async function main() {
  const store = await prisma.stockLocation.create({ data: { clientId: C, name: 'Main', code: `M-${STAMP}`, type: 'STORE' as any, active: true } });
  let n = 0;
  const product = async (title: string, dressType: string, extra: any = {}) => prisma.product.create({ data: { clientId: C, productCode: `P${STAMP}-${++n}`, slug: `p${STAMP}-${n}`, title, category: 'WOMEN' as any, productType: 'READY_TO_WEAR' as any, dressType, basePrice: 1000, status: 'ACTIVE' as any, ...extra } });
  const variant = async (productId: string, colorName: string, size: string, price = 1000) => prisma.productVariant.create({ data: { productId, clientId: C, colorName, size, variantCode: `V${STAMP}-${++n}`, sku: `S${STAMP}-${n}`, sellingPrice: price } });
  const person = async (name: string, phone: string | null, extra: any = {}) => prisma.customer.create({ data: { clientId: C, customerCode: `C-${STAMP}-${++n}`, name, phone, ...extra } });
  const bill = async (who: any, variants: any[], o: { daysAgo?: number; status?: string; customerPhone?: string; clientId?: string; deleted?: boolean } = {}) => prisma.salesOrder.create({ data: {
    clientId: o.clientId ?? C, orderNumber: `SO-${STAMP}-${++n}`, customerId: who.id, customerPhone: o.customerPhone ?? null, channel: 'POS' as any, locationId: store.id,
    status: (o.status ?? 'DISPATCHED') as any, subtotal: 1000, discountAmount: 0, taxAmount: 0, shippingAmount: 0, total: 1000 * variants.length,
    createdAt: new Date(Date.now() - (o.daysAgo ?? 3) * DAY), deletedAt: o.deleted ? new Date() : null,
    items: { create: variants.map(v => ({ variantId: v.id, quantity: 1, listUnitPrice: 1000, unitPrice: 1000, unitCost: 0, totalPrice: 1000 })) }
  } as any });

  // The catalogue: a saree, the blouse people buy with it, and things around them.
  const saree = await product('Kanchi Saree', 'Saree'), sareeV = await variant(saree.id, 'Maroon', 'Free');
  const blouse = await product('Zari Blouse', 'Blouse'), blouseM = await variant(blouse.id, 'Gold', 'M'), blouseL = await variant(blouse.id, 'Gold', 'L');
  const jewel = await product('Temple Jewellery', 'Jewellery'), jewelV = await variant(jewel.id, 'Gold', 'Free');
  const fall = await product('Saree Fall', 'Accessory'), fallV = await variant(fall.id, 'Maroon', 'Free');
  const odd = await product('Odd Thing', 'Accessory'), oddV = await variant(odd.id, 'Black', 'Free');
  const walkinOnly = await product('Walk-in Pick', 'Accessory'), walkinV = await variant(walkinOnly.id, 'Red', 'Free');
  const cancelledOnly = await product('Cancelled Pick', 'Accessory'), cancelledV = await variant(cancelledOnly.id, 'Red', 'Free');
  const oldOnly = await product('Old Pick', 'Accessory'), oldV = await variant(oldOnly.id, 'Red', 'Free');
  const twoRecords = await product('Dupatta', 'Dupatta'), twoRecordsV = await variant(twoRecords.id, 'Gold', 'Free');
  const retired = await product('Retired Belt', 'Accessory', { status: 'ARCHIVED' }), retiredV = await variant(retired.id, 'Gold', 'Free');

  const a = await person('Anu', '+919000000101'), b = await person('Bina', '+919000000102'), c = await person('Chitra', '+919000000103');
  const d = await person('Divya', '+919000000104'), e = await person('Esha', '+919000000105');
  const walkIn = await person('Walk-in', null, { externalCustomerId: 'POS:WALK-IN' });

  console.log('\nA. WHAT GOES TOGETHER, FROM THE BILLS');
  // Three different people bought the saree with the blouse.
  await bill(a, [sareeV, blouseM]); await bill(b, [sareeV, blouseM]); await bill(c, [sareeV]); await bill(c, [blouseL]);   // Chitra: on two bills, still "both"
  // Only one person bought the saree with the jewellery.
  await bill(a, [jewelV]);
  // One person bought the saree and the fall five times over: still one person.
  for (let i = 0; i < 5; i++) await bill(d, [sareeV, fallV]);
  await bill(b, [fallV]);   // ...and one more person: now two
  // The shared walk-in record "bought" the saree with Walk-in Pick on three bills: that is nobody.
  for (let i = 0; i < 3; i++) await bill(walkIn, [sareeV, walkinV]);
  // Cancelled and deleted bills, and a bill three years old, do not count.
  await bill(a, [cancelledV], { status: 'CANCELLED' }); await bill(b, [cancelledV], { deleted: true });
  await bill(a, [oldV], { daysAgo: 1100 }); await bill(b, [oldV], { daysAgo: 1100 });
  // An online shopper whose number was not proved ends up on two customer records, but the number
  // they typed is on both orders: one person, so with Esha that is two who bought saree + dupatta.
  const unproved1 = await person('Online shopper', null), unproved2 = await person('Online shopper', null);
  await bill(unproved1, [sareeV], { customerPhone: '+919000000199' });
  await bill(unproved2, [twoRecordsV], { customerPhone: '+91 90000 00199' });
  await bill(e, [sareeV, twoRecordsV]);
  // Another shop's bills never count here, even with the same products.
  const stranger = await prisma.customer.create({ data: { clientId: OTHER, customerCode: `CO-${STAMP}`, name: 'Elsewhere', phone: '+919000000150' } });
  await bill(stranger, [sareeV, oddV], { clientId: OTHER }); await bill(stranger, [sareeV, oddV], { clientId: OTHER });
  // A retired (archived) product bought with the saree by two people.
  await bill(a, [retiredV]); await bill(b, [retiredV]);

  const withSaree = await alsoBought(C, [saree.id]);
  const got = Object.fromEntries(withSaree.map(t => [t.productId, t.buyers]));
  check('the blouse: 3 different people bought it with the saree (one of them on separate bills)', got[blouse.id] === 3, withSaree);
  check('jewellery bought with it by only 1 person is not shown (2 needed)', !(jewel.id in got), withSaree);
  check('one person buying saree + fall five times counts once; with one more person the fall shows, at 2', got[fall.id] === 2, got[fall.id]);
  check('the shared walk-in record is nobody: three walk-in bills with the saree add nothing', !(walkinOnly.id in got));
  check('cancelled and deleted bills do not count', !(cancelledOnly.id in got));
  check('bills over two years old do not count', !(oldOnly.id in got));
  check('one number on two customer records is one person: the dupatta shows, at 2', got[twoRecords.id] === 2, got[twoRecords.id]);
  check('another shop\'s bills never count here', !(odd.id in got));
  check('never the product itself', !(saree.id in got));
  check('most shared buyers first', withSaree[0]?.productId === blouse.id, withSaree.map(t => t.buyers));
  const codes = await alsoBoughtCodes(C, saree.productCode);
  check('for the online shop, by code: the retired (archived) product is left out, live ones in', !codes.includes(retired.productCode) && codes.includes(blouse.productCode), codes);
  check('an unknown product code gives nothing, not an error', (await alsoBoughtCodes(C, 'NOPE-1')).length === 0);
  check('no products asked about gives nothing', (await alsoBought(C, [])).length === 0);

  console.log('\nB. ON THE CUSTOMER CARD: OTHERS WHO BOUGHT WHAT SHE BOUGHT');
  // Fatima bought the saree only. The blouse in M is here (her size from her own blouse? she has none,
  // so any size), the fall is here, the jewellery is here but only 1 person bought it with the saree.
  const fatima = await person('Fatima', '+919000000106');
  await bill(fatima, [sareeV]);
  for (const v of [blouseM, fallV, jewelV]) await prisma.inventoryStock.create({ data: { clientId: C, variantId: v.id, locationId: store.id, quantity: 4, reservedQty: 0 } });
  await prisma.inventoryStock.create({ data: { clientId: C, variantId: twoRecordsV.id, locationId: store.id, quantity: 2, reservedQty: 2 } });   // all of it reserved
  const f: any = await customerCard.lookup(C, '9000000106', store.id);
  const also = (f.othersAlsoBought ?? []).map((p: any) => `${p.title}:${p.buyers}`);
  check('Fatima: the blouse (3) then the fall (2) -- in stock here, most shared buyers first', JSON.stringify(also) === JSON.stringify(['Zari Blouse:3', 'Saree Fall:2']), also);
  check('...not the jewellery (only 1 buyer), not the dupatta (all of it reserved), not the walk-in pick', !also.some((x: string) => /Temple|Dupatta|Walk-in/.test(x)));
  // Anu has a blouse in M already: her own blouse size is M, so an L would be wrong for her.
  const anu: any = await customerCard.lookup(C, '9000000101', store.id);
  check('never something she already bought (Anu has the blouse and the jewellery)', !(anu.othersAlsoBought ?? []).some((p: any) => /Zari Blouse|Temple/.test(p.title)), anu.othersAlsoBought);
  const noStore: any = await customerCard.lookup(C, '9000000106');
  check('with no store chosen there is nothing to fetch, so no list (and no error)', Array.isArray(noStore.othersAlsoBought) && noStore.othersAlsoBought.length === 0);

  console.log('\nC. LOOKED AT ONLINE: ONLY A PROVED NUMBER, ONLY 30 DAYS');
  const now = new Date();
  const session = async (clientId: string, phone: string, alive = true) => {
    const token = crypto.randomBytes(24).toString('base64url');
    await prisma.onlineShopPhoneCode.create({ data: { clientId, phone, codeHash: 'x', expiresAt: new Date(now.getTime() - 2 * DAY), verifiedAt: new Date(now.getTime() - 2 * DAY), sessionToken: token, sessionExpiresAt: new Date(now.getTime() + (alive ? DAY : -DAY)) } as any });
    return token;
  };
  const fToken = await session(C, '+919000000106');
  check('no token: nothing recorded', (await seen(C, undefined, blouse.productCode, 'VIEW')) === false);
  check('a made-up token: nothing recorded', (await seen(C, 'x'.repeat(32), blouse.productCode, 'VIEW')) === false);
  const otherShopToken = await session(OTHER, '+919000000106');
  check('a token earned at another shop: nothing recorded here', (await seen(C, otherShopToken, blouse.productCode, 'VIEW')) === false);
  const expired = await session(C, '+919000000107', false);
  check('an expired session: nothing recorded', (await seen(C, expired, blouse.productCode, 'VIEW')) === false);
  check('an unknown product, or a retired one: nothing recorded', (await seen(C, fToken, 'NOPE-1', 'VIEW')) === false && (await seen(C, fToken, retired.productCode, 'VIEW')) === false);
  check('nothing at all was written by any of those', (await prisma.shopProductView.count({ where: { clientId: C } })) === 0);

  check('Fatima (proved) opens the blouse: recorded', (await seen(C, fToken, blouse.productCode, 'VIEW', blouseM.variantCode, now)) === true);
  await seen(C, fToken, blouse.productCode, 'VIEW', undefined, new Date(now.getTime() + 2 * 60_000));   // a refresh two minutes later
  await seen(C, fToken, blouse.productCode, 'VIEW', undefined, new Date(now.getTime() + 20 * 60_000));  // back twenty minutes later
  await seen(C, fToken, blouse.productCode, 'TRYON', blouseM.variantCode, new Date(now.getTime() + 21 * 60_000));
  const row = await prisma.shopProductView.findFirst({ where: { clientId: C, productId: blouse.id } });
  check('a refresh within 10 minutes is the same look: 2 views (not 3), 1 try-on, the colour remembered', row?.views === 2 && row?.tryOns === 1 && row?.variantId === blouseM.id, row);
  check('stored against the proved number in the shop\'s own format, not anything the page said', row?.phone === '+919000000106');
  // A look 31 days ago, at the jewellery.
  await prisma.shopProductView.create({ data: { clientId: C, phone: '+919000000106', productId: jewel.id, views: 4, lastAt: new Date(now.getTime() - 31 * DAY), firstAt: new Date(now.getTime() - 40 * DAY) } });
  // And the saree, which she has since bought.
  await prisma.shopProductView.create({ data: { clientId: C, phone: '+919000000106', productId: saree.id, views: 1 } });

  const card: any = await customerCard.lookup(C, '9000000106', store.id);
  const looked = (card.lookedOnline ?? []).map((l: any) => `${l.title}:${l.views}v:${l.tryOns}t:${l.colour}:${l.inStock}`);
  check('the card: the blouse, Gold, viewed 2, tried on 1, 4 here', JSON.stringify(looked) === JSON.stringify(['Zari Blouse:2v:1t:Gold:4']), looked);
  check('...not the jewellery looked at 31 days ago, not the saree she has since bought', !looked.some((x: string) => /Temple|Kanchi/.test(x)));
  check('lookedAt reads only the last 30 days', (await lookedAt(C, '+919000000106')).every(l => l.productId !== jewel.id));
  const gone = await forgetOldViews(now);
  check('housekeeping forgets the 31-day-old look and keeps the rest', gone >= 1 && !(await prisma.shopProductView.findFirst({ where: { clientId: C, productId: jewel.id } })) && !!(await prisma.shopProductView.findFirst({ where: { clientId: C, productId: blouse.id } })), gone);
  const someoneElse: any = await customerCard.lookup(C, '9000000101', store.id);
  check('another customer\'s card shows none of Fatima\'s looks', (someoneElse.lookedOnline ?? []).length === 0);

  console.log('\nD. THE SHOP SIGN-IN NO LONGER EXPIRES AFTER A DAY');
  const liveToken = await session(C, '+919000000108', true);
  const deadToken = await session(C, '+919000000109', false);
  await prisma.onlineShopPhoneCode.create({ data: { clientId: C, phone: '+919000000110', codeHash: 'x', expiresAt: new Date(now.getTime() - 2 * DAY) } as any });
  await forgetOldCodes(new Date(now.getTime() - DAY), now);
  check('a spent code whose browser session still lives is kept: the shopper is still recognised', (await whoIs(C, liveToken)) === '+919000000108');
  check('a spent code whose session ended is removed', !(await prisma.onlineShopPhoneCode.findFirst({ where: { clientId: C, phone: '+919000000109' } })) && (await whoIs(C, deadToken)) === null);
  check('a spent code that never became a session is removed', !(await prisma.onlineShopPhoneCode.findFirst({ where: { clientId: C, phone: '+919000000110' } })));
}

main().catch(e => { failed++; console.error(e); }).finally(async () => {
  const w = { clientId: { in: [C, OTHER] } };
  await prisma.shopProductView.deleteMany({ where: w }).catch(e => console.log('left views', e.message));
  await prisma.onlineShopPhoneCode.deleteMany({ where: w }).catch(e => console.log('left codes', e.message));
  await prisma.salesOrderItem.deleteMany({ where: { salesOrder: w } }).catch(e => console.log('left items', e.message));
  await prisma.salesOrder.deleteMany({ where: w }).catch(e => console.log('left orders', e.message));
  await prisma.inventoryStock.deleteMany({ where: w }).catch(e => console.log('left stock', e.message));
  await prisma.productVariant.deleteMany({ where: w }).catch(e => console.log('left variants', e.message));
  await prisma.product.deleteMany({ where: w }).catch(e => console.log('left products', e.message));
  await prisma.customer.deleteMany({ where: w }).catch(e => console.log('left customers', e.message));
  await prisma.stockLocation.deleteMany({ where: w }).catch(e => console.log('left locations', e.message));
  console.log(`\n${passed} passed, ${failed} failed`);
  await prisma.$disconnect();
  process.exit(failed ? 1 : 0);
});
