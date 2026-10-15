/**
 * The Customer card (Customers → Customer card), on a throwaway shop built here and removed at the
 * end. Known bills go in; the card must come out with exactly the sizes, colours, spend and picks a
 * salesperson would work out by hand.
 *
 *   npx tsx src/scripts/verify-customer-card.ts
 */
import { prisma } from '../lib/prisma';
import { customerCard, spendBand, sizeKey } from '../services/customer-card';

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
  check('colours most bought first: Blue (3 pieces), then Maroon', JSON.stringify(card.dna.colours) === JSON.stringify(['Blue', 'Maroon']), card.dna.colours);
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
}

main().catch(e => { failed++; console.error(e); }).finally(async () => {
  const w = { clientId: C };
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
