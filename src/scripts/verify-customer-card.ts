/**
 * The Customer card (Customers → Customer card), on a throwaway shop built here and removed at the
 * end. Known bills go in; the card must come out with exactly the sizes, colours, spend and picks a
 * salesperson would work out by hand.
 *
 *   npx tsx src/scripts/verify-customer-card.ts
 */
import { prisma } from '../lib/prisma';
import { customerCard, spendBand, sizeKey, weight } from '../services/customer-card';
import { colourFamily } from '../services/customer-card/colours';

const STAMP = Date.now();
const C = `card-${STAMP}`;
const OTHER = `card-other-${STAMP}`;
let passed = 0, failed = 0;
const check = (name: string, ok: boolean, detail?: unknown) => {
  if (ok) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name}${detail !== undefined ? ` -- ${JSON.stringify(detail).slice(0, 400)}` : ''}`); }
};

async function main() {
  console.log('\nA. THE ARITHMETIC');
  check('the usual spend is the middle half of their bills, to the nearest ₹100', JSON.stringify(spendBand([1000, 2950, 4000, 8040, 30000])) === JSON.stringify({ from: 3000, to: 8000 }), spendBand([1000, 2950, 4000, 8040, 30000]));
  check('...one bill gives that bill', JSON.stringify(spendBand([4321])) === JSON.stringify({ from: 4300, to: 4300 }));
  check('...no bills gives nothing, not ₹0', spendBand([]) === null);
  check('"Free", "Free Size" and "free-size" are one size; "M" and "m" too', sizeKey('Free') === sizeKey('Free Size') && sizeKey('free-size') === 'free' && sizeKey('M') === sizeKey('m') && sizeKey('M') !== sizeKey('L'));

  console.log('\nB. A REAL CUSTOMER\'S CARD');
  const store = await prisma.stockLocation.create({ data: { clientId: C, name: 'Main', code: `M-${STAMP}`, type: 'STORE' as any, active: true } });
  const other = await prisma.stockLocation.create({ data: { clientId: C, name: 'Branch', code: `B-${STAMP}`, type: 'STORE' as any, active: true } });
  let n = 0;
  const product = async (title: string, dressType: string, extra: any = {}) => prisma.product.create({ data: { clientId: C, productCode: `P${STAMP}-${++n}`, slug: `p${STAMP}-${n}`, title, category: 'WOMEN' as any, productType: 'READY_TO_WEAR' as any, dressType, basePrice: 1000, status: 'ACTIVE' as any, ...extra } });
  const variant = async (productId: string, colorName: string, size: string, price = 1000) => prisma.productVariant.create({ data: { productId, clientId: C, colorName, size, variantCode: `V${STAMP}-${++n}`, sku: `S${STAMP}-${n}`, sellingPrice: price } });
  const stock = (variantId: string, quantity: number, locationId = store.id, reservedQty = 0) => prisma.inventoryStock.create({ data: { clientId: C, variantId, locationId, quantity, reservedQty } });

  const kurti = await product('Cotton Kurti', 'Kurti');
  const kBlueM = await variant(kurti.id, 'Blue', 'M'), kBlueL = await variant(kurti.id, 'Blue', 'L'), kPinkM = await variant(kurti.id, 'Pink', 'M');
  const saree = await product('Silk Saree', 'Saree');
  const sMaroon = await variant(saree.id, 'Maroon', 'Free'), sBlue = await variant(saree.id, 'Blue', 'Free Size');
  const saree2 = await product('Crepe Saree', 'Saree');
  const s2Green = await variant(saree2.id, 'Green', 'Free Size');
  const archived = await product('Old Saree', 'Saree', { status: 'ARCHIVED' });
  const aBlue = await variant(archived.id, 'Blue', 'Free');
  const lehenga = await product('Lehenga', 'Lehenga');
  const lBlue = await variant(lehenga.id, 'Blue', 'M');
  const kurti2 = await product('Linen Kurti', 'Kurti');
  const k2BlueM = await variant(kurti2.id, 'Blue', 'M'), k2BlueM2 = await variant(kurti2.id, 'Blue', 'M ');

  await stock(kBlueM.id, 5);          // they already bought this one -- never a pick
  await stock(kBlueL.id, 5);          // wrong size
  await stock(kPinkM.id, 2);          // right size, not their colour
  await stock(sBlue.id, 3);           // "Free Size" must match their "Free"
  await stock(s2Green.id, 1, store.id, 1); // all of it reserved -- not really here
  await stock(aBlue.id, 4);           // archived product
  await stock(lBlue.id, 4);           // a garment they never buy
  await stock(k2BlueM.id, 0);         // none here
  await stock(k2BlueM.id, 6, other.id); // only in the other store
  await stock(k2BlueM2.id, 1);        // same product as above, a second variant in their size

  const customer = await prisma.customer.create({ data: { clientId: C, customerCode: `C-${STAMP}`, name: 'Meena Iyer', phone: '+919848011122', tags: ['vip'] } });
  const bill = async (items: { v: any; qty: number }[], total: number, daysAgo: number) => prisma.salesOrder.create({ data: {
    clientId: C, orderNumber: `SO-${STAMP}-${++n}`, customerId: customer.id, channel: 'POS' as any, locationId: store.id, status: 'DISPATCHED' as any,
    subtotal: total, discountAmount: 0, taxAmount: 0, shippingAmount: 0, total, createdAt: new Date(Date.now() - daysAgo * 86_400_000),
    items: { create: items.map(i => ({ variantId: i.v.id, quantity: i.qty, listUnitPrice: total / i.qty, unitPrice: total / i.qty, unitCost: 0, totalPrice: total })) }
  } as any });
  await bill([{ v: kBlueM, qty: 2 }], 2000, 40);
  await bill([{ v: kBlueM, qty: 1 }], 1000, 20);
  await bill([{ v: sMaroon, qty: 1 }], 8000, 10);
  const cancelled = await bill([{ v: lBlue, qty: 5 }], 50000, 5);
  await prisma.salesOrder.update({ where: { id: cancelled.id }, data: { status: 'CANCELLED' as any } });

  // Another shop with the same phone must never show here.
  await prisma.customer.create({ data: { clientId: OTHER, customerCode: `CO-${STAMP}`, name: 'Someone Else', phone: '+919848011122' } });

  const card: any = await customerCard.lookup(C, '98480 11122', store.id);
  check('found by the number however it was typed, in this shop only', card.customer?.name === 'Meena Iyer', card.customer);
  check('the group shows as a badge', JSON.stringify(card.customer?.groups) === JSON.stringify(['vip']), card.customer?.groups);
  check('3 bills (the cancelled one does not count), last visit 10 days ago', card.visits.bills === 3 && Math.round((Date.now() - new Date(card.visits.lastVisit).getTime()) / 86_400_000) === 10, card.visits);
  check('sizes per garment: Kurti M, Saree Free', JSON.stringify(card.dna.sizes) === JSON.stringify([{ kind: 'Kurti', size: 'M' }, { kind: 'Saree', size: 'Free' }]), card.dna.sizes);
  check('colours by family, most bought first: Blue (3 pieces), then Red (the Maroon saree)', JSON.stringify(card.dna.colours) === JSON.stringify(['Blue', 'Red']), card.dna.colours);
  check('garments: Kurti, Saree -- not the Lehenga on the cancelled bill', JSON.stringify(card.dna.kinds) === JSON.stringify(['Kurti', 'Saree']), card.dna.kinds);
  check('usual spend from the three real bills: ₹1,000 – ₹2,000', JSON.stringify(card.dna.spend) === JSON.stringify({ from: 1000, to: 2000 }), card.dna.spend);

  const picks = card.picks.map((p: any) => `${p.title}|${p.colour}|${p.size}`);
  check('picks: in this store, their size, their colour first -- exactly Silk Saree Blue (Free Size), Linen Kurti Blue M, Cotton Kurti Pink M',
    JSON.stringify(picks) === JSON.stringify(['Linen Kurti|Blue|M ', 'Silk Saree|Blue|Free Size', 'Cotton Kurti|Pink|M']), picks);
  check('...the one they already bought is never offered', !card.picks.some((p: any) => p.variantId === kBlueM.id));
  check('...nothing reserved-out, archived, never-bought garment or only-in-another-store', !card.picks.some((p: any) => [s2Green.id, aBlue.id, lBlue.id, k2BlueM.id].includes(p.variantId)), picks);
  check('..."their colour" is marked on the Blue ones only', card.picks.filter((p: any) => p.yourColour).length === 2 && !card.picks.find((p: any) => p.colour === 'Pink').yourColour);

  const elsewhere: any = await customerCard.lookup(C, '+919848011122', other.id);
  check('in the other store the picks are that store\'s stock', elsewhere.picks.length === 1 && elsewhere.picks[0].variantId === k2BlueM.id, elsewhere.picks);

  console.log('\nC. EDGES');
  check('an unknown number is "no customer", not an error', (await customerCard.lookup(C, '9000000001', store.id)).customer === null);
  const bad = await customerCard.lookup(C, '12345', store.id).then(() => null, e => e);
  check('a number that is not a phone is refused in words', bad?.statusCode === 400 && /10-digit|digits/i.test(bad.message), bad?.message);
  const newbie = await prisma.customer.create({ data: { clientId: C, customerCode: `CN-${STAMP}`, name: 'New Person', phone: '+919848011199' } });
  const empty: any = await customerCard.lookup(C, '9848011199', store.id);
  check('a customer with no bills: zero bills, nothing guessed, no picks', empty.visits.bills === 0 && empty.dna.sizes.length === 0 && empty.dna.spend === null && empty.picks.length === 0, empty);

  console.log('\nD. NOTES');
  await customerCard.addNote(C, customer.id, '  buys for   her daughter ', null);
  await customerCard.addNote(C, customer.id, 'prefers cotton in summer', null);
  const withNotes: any = await customerCard.lookup(C, '9848011122', store.id);
  check('notes are kept newest first, one dated line each, spaces tidied', withNotes.customer.notes.length === 2 && /prefers cotton in summer$/.test(withNotes.customer.notes[0]) && /: buys for her daughter$/.test(withNotes.customer.notes[1]), withNotes.customer.notes);
  const blank = await customerCard.addNote(C, customer.id, '   ', null).then(() => null, e => e);
  check('an empty note is refused', blank?.statusCode === 400);
  const long = await customerCard.addNote(C, customer.id, 'x'.repeat(301), null).then(() => null, e => e);
  check('a note over 300 characters is refused', long?.statusCode === 400);
  const wrongShop = await customerCard.addNote(OTHER, customer.id, 'sneaky', null).then(() => null, e => e);
  check('another shop cannot write on this customer', wrongShop?.statusCode === 404);
  check('...and the customer page sees the same notes field', ((await prisma.customer.findUnique({ where: { id: customer.id } }))?.notes ?? '').split('\n').length === 2);
  void newbie;

  console.log('\nE. ONLINE PURCHASES COUNT TOO');
  await prisma.customer.update({ where: { id: customer.id }, data: { email: 'meena@example.com' } });
  // An online-shop order where she typed her number but did not prove it: kept on its own record.
  const unproved = await prisma.customer.create({ data: { clientId: C, customerCode: `CU-${STAMP}`, name: 'Meena I', email: 'other@example.com' } });
  const onlineBill = (cust: string, phone: string | null, items: { v: any; qty: number }[], total: number, channel = 'ONLINE') => prisma.salesOrder.create({ data: {
    clientId: C, orderNumber: `SO-${STAMP}-${++n}`, customerId: cust, customerPhone: phone, channel: channel as any, locationId: store.id, status: 'CONFIRMED' as any,
    subtotal: total, discountAmount: 0, taxAmount: 0, shippingAmount: 0, total,
    items: { create: items.map(i => ({ variantId: i.v.id, quantity: i.qty, listUnitPrice: total / i.qty, unitPrice: total / i.qty, unitCost: 0, totalPrice: total })) }
  } as any });
  await onlineBill(unproved.id, '+919848011122', [{ v: lBlue, qty: 1 }], 3000);
  // A Shopify customer record with the same email, no phone.
  const shopify = await prisma.customer.create({ data: { clientId: C, customerCode: `CS-${STAMP}`, name: 'Meena Iyer', email: 'MEENA@example.com', externalCustomerId: `shopify:${STAMP}` } });
  await onlineBill(shopify.id, null, [{ v: kBlueM, qty: 1 }], 1500, 'MARKETPLACE');
  // A stranger online, another number: never hers.
  const stranger = await prisma.customer.create({ data: { clientId: C, customerCode: `CX-${STAMP}`, name: 'Stranger', email: 'x@example.com' } });
  await onlineBill(stranger.id, '+919848099999', [{ v: kPinkM, qty: 9 }], 90000);

  const all: any = await customerCard.lookup(C, '9848011122', store.id);
  check('her bills now include both online orders: 5 = 3 in store + 2 online', all.visits.bills === 5 && all.visits.inStore === 3 && all.visits.online === 2, all.visits);
  check('...the Lehenga she bought online is in her garments', JSON.stringify(all.dna.kinds) === JSON.stringify(['Kurti', 'Lehenga', 'Saree']), all.dna.kinds);
  check('...and is never offered back to her', !all.picks.some((p: any) => p.variantId === lBlue.id), all.picks);
  check('...the stranger\'s 9 pink kurtis count for nothing', all.dna.colours[0] === 'Blue' && all.dna.spend.to < 10000, all.dna);

  const onlyOnline = await prisma.customer.create({ data: { clientId: C, customerCode: `CO2-${STAMP}`, name: 'Ravi Online' } });
  await onlineBill(onlyOnline.id, '+919848011177', [{ v: sMaroon, qty: 1 }], 8000);
  const ravi: any = await customerCard.lookup(C, '9848011177', store.id);
  check('someone who has only bought online, number never proved, still has a card', ravi.customer?.name === 'Ravi Online' && ravi.visits.online === 1 && ravi.dna.kinds[0] === 'Saree', ravi);

  console.log('\nF. A LONG HISTORY');
  const regular = await prisma.customer.create({ data: { clientId: C, customerCode: `CR-${STAMP}`, name: 'Regular', phone: '+919848011188' } });
  await prisma.salesOrder.createMany({ data: Array.from({ length: 205 }, (_, i) => ({
    clientId: C, orderNumber: `SO-${STAMP}-R${i}`, customerId: regular.id, channel: 'POS', locationId: store.id, status: 'DISPATCHED',
    subtotal: 1000, discountAmount: 0, taxAmount: 0, shippingAmount: 0, total: 1000
  })) as any });
  const history: any = await customerCard.lookup(C, '9848011188', store.id);
  check('205 bills are all counted, not only the latest 200', history.visits.bills === 205, history.visits);

  console.log('\nG. EDGES');
  const ways = ['+91 98480 11122', '098480 11122', '919848011122', '9848011122'];
  const names = await Promise.all(ways.map(w => customerCard.lookup(C, w, store.id).then((r: any) => r.customer?.name)));
  check('the same number typed four ways finds the same customer', names.every(x => x === 'Meena Iyer'), names);
  const strangeStore: any = await customerCard.lookup(C, '9848011122', other.id.replace(/.$/, '0'));
  check('a store that is not this shop\'s gives no picks, and no error', strangeStore.customer?.name === 'Meena Iyer' && strangeStore.picks.length === 0);
  await customerCard.addNote(C, customer.id, 'line one\nline two\t<script>x</script>', null);
  const tidy: any = await customerCard.lookup(C, '9848011122', store.id);
  check('a note typed over several lines stays one line (and is kept as plain text)', /: line one line two <script>x<\/script>$/.test(tidy.customer.notes[0]), tidy.customer.notes[0]);
  const gone = await prisma.customer.create({ data: { clientId: C, customerCode: `CG-${STAMP}`, name: 'Deleted Person', phone: '+919848011133', deletedAt: new Date() } });
  check('a deleted customer is not shown', (await customerCard.lookup(C, '9848011133', store.id)).customer === null);
  void gone;

  console.log('\nH. SMARTER: COLOUR FAMILIES, RETURNS, RECENT BUYING, BUDGET');
  const names2 = ['Navy', 'Indigo', 'Peacock', 'Dodger Blue', 'Maroon', 'Firebrick', 'Medium Violet Red', 'Blue Violet', 'Goldenrod', 'Peach Puff', 'Dark Khaki', 'skyblue', 'Off White', 'Sea Green', 'Service'];
  const fams = names2.map(colourFamily);
  check('colour names from the real catalogue fall into families (Navy→Blue, Maroon→Red, Medium Violet Red→Pink, Blue Violet→Purple, skyblue→Blue…); an unknown name stays as typed',
    JSON.stringify(fams) === JSON.stringify(['Blue', 'Blue', 'Blue', 'Blue', 'Red', 'Red', 'Pink', 'Purple', 'Gold', 'Orange', 'Brown', 'Blue', 'White', 'Green', 'Service']), Object.fromEntries(names2.map((x, i) => [x, fams[i]])));
  check('a purchase a year old counts half; today\'s counts in full', Math.abs(weight(new Date(Date.now() - 365 * 86_400_000)) - 0.5) < 0.001 && weight(new Date()) === 1);

  // Asha: three Green kurtis in S four years ago; lately Navy and Indigo kurtis in M; a Pink XL she sent back;
  // and a return she only asked for (not back yet), which must change nothing.
  const asha = await prisma.customer.create({ data: { clientId: C, customerCode: `CA-${STAMP}`, name: 'Asha', phone: '+919848011144' } });
  const kurtiOld = await product('Mul Kurti', 'Kurti'), kurtiNavy = await product('Chanderi Kurti', 'Kurti'), kurtiInd = await product('Ikat Kurti', 'Kurti'), kurtiPink = await product('Party Kurti', 'Kurti');
  const vOldS = await variant(kurtiOld.id, 'Green', 'S'), vNavyM = await variant(kurtiNavy.id, 'Navy', 'M', 1500), vIndM = await variant(kurtiInd.id, 'Indigo', 'M', 1800), vPinkXL = await variant(kurtiPink.id, 'Pink', 'XL', 9000);
  const billFor = async (v: any, total: number, daysAgo: number) => prisma.salesOrder.create({ data: {
    clientId: C, orderNumber: `SO-${STAMP}-${++n}`, customerId: asha.id, channel: 'POS' as any, locationId: store.id, status: 'DISPATCHED' as any,
    subtotal: total, discountAmount: 0, taxAmount: 0, shippingAmount: 0, total, createdAt: new Date(Date.now() - daysAgo * 86_400_000),
    items: { create: [{ variantId: v.id, quantity: 1, listUnitPrice: total, unitPrice: total, unitCost: 0, totalPrice: total }] }
  } as any, include: { items: true } });
  const giveBack = async (o: any, status: string, refund: number) => {
    const d = await prisma.dispatch.create({ data: { clientId: C, salesOrderId: o.id, dispatchNumber: `D-${STAMP}-${++n}` } as any });
    const di = await prisma.dispatchItem.create({ data: { dispatchId: d.id, salesOrderItemId: o.items[0].id, quantity: 1 } as any });
    await prisma.salesReturn.create({ data: { clientId: C, returnNumber: `R-${STAMP}-${++n}`, salesOrderId: o.id, reason: 'SIZE_ISSUE', status, refundTotal: refund,
      items: { create: [{ dispatchItemId: di.id, salesOrderItemId: o.items[0].id, quantity: 1, refundAmount: refund }] } } as any });
  };
  for (const ago of [1460, 1470, 1480]) await billFor(vOldS, 900, ago);
  await billFor(vNavyM, 1500, 30);
  await billFor(vIndM, 1800, 20);
  await giveBack(await billFor(vPinkXL, 9000, 10), 'COMPLETED', 9000);
  await giveBack(await billFor(vNavyM, 1200, 5), 'REQUESTED', 0);
  // In the store, all Kurtis in M: a Royal Navy one in budget, a Green one in budget, a Blue one well over it.
  const pNavy = await product('Handloom Kurti', 'Kurti'), pGreen = await product('Khadi Kurti', 'Kurti'), pDear = await product('Zardozi Kurti', 'Kurti');
  const vRoyal = await variant(pNavy.id, 'Royal Navy', 'M', 1400), vGreenM = await variant(pGreen.id, 'Green', 'M', 1000), vDear = await variant(pDear.id, 'Blue', 'M', 6000);
  for (const v of [vRoyal, vGreenM, vDear]) await stock(v.id, 3);
  await stock(vPinkXL.id, 2);   // the one she sent back: never offered again

  const a: any = await customerCard.lookup(C, '9848011144', store.id);
  check('size: Kurti M (two recent) beats S (three, four years old), and never XL (sent back)', JSON.stringify(a.dna.sizes) === JSON.stringify([{ kind: 'Kurti', size: 'M' }]), a.dna.sizes);
  check('colours: Blue (Navy + Indigo, recent) before Green (old); not Pink (sent back)', JSON.stringify(a.dna.colours) === JSON.stringify(['Blue', 'Green']), a.dna.colours);
  check('usual spend from the last two years, after the refund: ₹1,200 – ₹1,500 (not the old ₹900s, not the ₹9,000 she got back)', JSON.stringify(a.dna.spend) === JSON.stringify({ from: 1200, to: 1500 }), a.dna.spend);
  check('every bill still counts as a visit (7)', a.visits.bills === 7, a.visits);
  const order2 = a.picks.map((p: any) => `${p.title}:${p.inBudget ? 'in' : 'over'}:${p.yourColour ? 'hers' : '-'}`);
  // Section B's Blue kurtis in M (Cotton, Linen) are in this store too, and are hers as well.
  check('picks: in budget first -- her Blues (Cotton, Royal Navy Handloom, Linen), then Green (Khadi) -- then the ₹6,000 Zardozi over budget; the sent-back Pink never',
    JSON.stringify(order2) === JSON.stringify(['Cotton Kurti:in:hers', 'Handloom Kurti:in:hers', 'Linen Kurti:in:hers', 'Khadi Kurti:in:hers', 'Zardozi Kurti:over:hers']), order2);
}

main().catch(e => { failed++; console.error(e); }).finally(async () => {
  const w = { clientId: C };
  await prisma.salesReturn.deleteMany({ where: w }).catch(e => console.log('left returns', e.message));
  await prisma.dispatchItem.deleteMany({ where: { dispatch: w } }).catch(e => console.log('left dispatch items', e.message));
  await prisma.dispatch.deleteMany({ where: w }).catch(e => console.log('left dispatches', e.message));
  await prisma.salesOrderItem.deleteMany({ where: { salesOrder: w } }).catch(e => console.log('left items', e.message));
  await prisma.salesOrder.deleteMany({ where: w }).catch(e => console.log('left orders', e.message));
  await prisma.inventoryStock.deleteMany({ where: w }).catch(e => console.log('left stock', e.message));
  await prisma.productVariant.deleteMany({ where: w }).catch(e => console.log('left variants', e.message));
  await prisma.product.deleteMany({ where: w }).catch(e => console.log('left products', e.message));
  await prisma.customer.deleteMany({ where: { clientId: { in: [C, OTHER] } } }).catch(e => console.log('left customers', e.message));
  await prisma.stockLocation.deleteMany({ where: w }).catch(e => console.log('left locations', e.message));
  console.log(`\n${passed} passed, ${failed} failed`);
  await prisma.$disconnect();
  process.exit(failed ? 1 : 0);
});
