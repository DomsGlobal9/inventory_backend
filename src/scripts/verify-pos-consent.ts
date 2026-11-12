/**
 * A yes to WhatsApp offers ticked on the ScaleEzy POS till (12 Nov 2026): sale.completed and
 * sale.exchanged carry customer.whatsappOffers = true, and Inventory records it on the customer.
 * Applied in-process with the real code (as verify-pos-handover does), on a throwaway shop. LOCAL only.
 *
 *   A  a yes on a bill: recorded, at the bill's own time, by "POS till" (what the customer page and CRM read)
 *   B  no field, false, or "yes" as text: nothing changes
 *   C  a customer who replied STOP stays stopped; an earlier yes keeps its first record
 *   D  a walk-in (no phone): nothing to record, the sale still goes in
 *   E  an exchange with a yes records it; a bill from the future is recorded at now
 *
 *   DATABASE_URL=<local> DIRECT_URL=<local> npx tsx src/scripts/verify-pos-consent.ts
 */
import { prisma } from '../lib/prisma';
import { inventoryMutationService } from '../services/inventory-mutation.service';
import { applySale } from '../services/pos/pos-events.service';
import { applyExchange } from '../services/pos/pos-exchange.service';
import { offersState, POS_TILL_CONSENT } from '../services/campaigns/consent';

for (const k of ['DATABASE_URL', 'DIRECT_URL']) {
  if (!/localhost:55433/.test(process.env[k] ?? '')) { console.error(`Refusing: ${k} is not the local database.`); process.exit(2); }
}
const STAMP = Date.now();
const CLIENT = `pos-consent-${STAMP}`;
const PRICE = 150000;
let passed = 0, failed = 0;
const check = (name: string, ok: boolean, detail = '') => {
  if (ok) { passed++; console.log(`  ok   ${name}`); } else { failed++; console.log(`  FAIL ${name} -- ${detail}`); }
};

async function teardown() {
  const w = { clientId: CLIENT };
  const steps: [string, () => Promise<unknown>][] = [
    ['pos events', () => prisma.posInboundEvent.deleteMany({ where: w })],
    ['return items', () => prisma.salesReturnItem.deleteMany({ where: { salesReturn: w } })],
    ['returns', () => prisma.salesReturn.deleteMany({ where: w })],
    ['payments', () => prisma.salesOrderPayment.deleteMany({ where: w })],
    ['dispatch items', () => prisma.dispatchItem.deleteMany({ where: { dispatch: w } })],
    ['dispatches', () => prisma.dispatch.deleteMany({ where: w })],
    ['orders', () => prisma.salesOrder.deleteMany({ where: w })],
    ['transactions', () => prisma.inventoryTransaction.deleteMany({ where: w })],
    ['module events', () => prisma.moduleEvent.deleteMany({ where: w })],
    ['customers', () => prisma.customer.deleteMany({ where: w })],
    ['stock', () => prisma.inventoryStock.deleteMany({ where: w })],
    ['variants', () => prisma.productVariant.deleteMany({ where: w })],
    ['products', () => prisma.product.deleteMany({ where: w })],
    ['settings', () => prisma.clientSettings.deleteMany({ where: w })],
    ['locations', () => prisma.stockLocation.deleteMany({ where: w })]
  ];
  const left: string[] = [];
  for (const [label, run] of steps) { try { await run(); } catch (e: any) { left.push(`${label}: ${String(e.message).split('\n')[0]}`); } }
  const customersLeft = await prisma.customer.count({ where: w });
  check('nothing left behind', left.length === 0 && customersLeft === 0, left.join('; '));
}

async function main() {
  console.log(`\nWhatsApp offers yes from the till, on ${CLIENT}\n`);
  const store = await prisma.stockLocation.create({ data: { clientId: CLIENT, name: 'Counter', code: `PC-${STAMP}`, type: 'STORE' as any, active: true } });
  await prisma.clientSettings.create({ data: { clientId: CLIENT, businessName: 'Consent Test Shop', gstRegistration: 'UNREGISTERED' } as any });
  const product = await prisma.product.create({ data: { clientId: CLIENT, productCode: `PCP-${STAMP}`, slug: `pcp-${STAMP}`, title: 'Indigo saree', category: 'WOMEN' as any, productType: 'READY_TO_WEAR' as any, dressType: 'Saree', basePrice: 1500, status: 'ACTIVE' as any, publishedAt: new Date() } });
  const variant = await prisma.productVariant.create({ data: { productId: product.id, clientId: CLIENT, colorName: 'Indigo', size: 'Free', variantCode: `PCV-${STAMP}`, sku: `PCS-${STAMP}`, sellingPrice: 1500 } });
  await inventoryMutationService.applyMovement({ clientId: CLIENT, variantId: variant.id, locationId: store.id, movementType: 'IN', reason: 'PURCHASE', quantityDelta: 30, unitCost: 800, notes: 'verify-pos-consent setup', createdBy: 'verify-pos-consent' });

  const inv = (n: string) => `INV/PC/${STAMP}-${n}`;
  const at = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000).toISOString();
  const sale = (n: string, customer: Record<string, unknown> | null, occurredAt = at(30)) => applySale(CLIENT, store.id, {
    kind: 'sale.completed', invoiceNo: inv(n), occurredAt,
    lines: [{ itemCode: variant.variantCode, qty: 1, unitPricePaise: PRICE, lineTotalPaise: PRICE }], totals: {},
    payments: [{ method: 'CASH', amountPaise: PRICE }], ...(customer ? { customer } : {})
  } as any);
  const byPhone = (phone: string) => prisma.customer.findFirst({
    where: { clientId: CLIENT, phone: { contains: phone.slice(-10) } },
    select: { id: true, whatsappOffers: true, whatsappOffersAt: true, whatsappOffersBy: true, whatsappStoppedAt: true }
  });

  console.log('A. A YES ON A BILL');
  const billTime = at(42);
  let r: any = await sale('A1', { name: 'Lakshmi Iyer', phone: '+919000033001', whatsappOffers: true }, billTime);
  let c = await byPhone('9000033001');
  check('the sale goes in', r.answer === 'APPLIED', JSON.stringify(r));
  check('the customer now agrees to offers', c?.whatsappOffers === true, JSON.stringify(c));
  check('recorded at the bill\'s own time, not when it arrived', c?.whatsappOffersAt?.toISOString() === new Date(billTime).toISOString(), `${c?.whatsappOffersAt?.toISOString()} vs ${billTime}`);
  check('recorded as by the POS till', c?.whatsappOffersBy === POS_TILL_CONSENT, String(c?.whatsappOffersBy));
  const shown = await offersState(CLIENT, c!.id);
  check('the customer page and CRM read: agreed, changed by "POS till"', shown.agreed === true && shown.changedBy === 'POS till', JSON.stringify(shown));

  console.log('\nB. NOTHING ASKED, OR NOT A YES');
  for (const [n, extra, label] of [
    ['B1', {}, 'no field'],
    ['B2', { whatsappOffers: false }, 'false'],
    ['B3', { whatsappOffers: 'yes' }, '"yes" as text'],
    ['B4', { whatsappOffers: null }, 'null']
  ] as const) {
    const phone = `+91900003310${n.slice(1)}`;
    r = await sale(n, { name: `Customer ${n}`, phone, ...extra });
    c = await byPhone(phone);
    check(`${label}: the sale goes in, the customer is not marked as agreeing`, r.answer === 'APPLIED' && c?.whatsappOffers === false && c?.whatsappOffersBy === null, JSON.stringify({ r: r.answer, c }));
  }
  r = await sale('B5', { name: 'Lakshmi Iyer', phone: '+919000033001', whatsappOffers: false });
  c = await byPhone('9000033001');
  check('a later bill without a yes never takes an earlier yes away', r.answer === 'APPLIED' && c?.whatsappOffers === true, JSON.stringify(c));

  console.log('\nC. STOP, AND AN EARLIER YES');
  await sale('C0', { name: 'Stopped Devi', phone: '+919000033201' });
  const stopped = await byPhone('9000033201');
  await prisma.customer.update({ where: { id: stopped!.id }, data: { whatsappStoppedAt: new Date() } });
  r = await sale('C1', { name: 'Stopped Devi', phone: '+919000033201', whatsappOffers: true });
  c = await byPhone('9000033201');
  check('someone who replied STOP: the sale goes in, they stay stopped and not agreeing', r.answer === 'APPLIED' && c?.whatsappOffers === false && !!c?.whatsappStoppedAt, JSON.stringify(c));
  const first = (await byPhone('9000033001'))!.whatsappOffersAt?.toISOString();
  r = await sale('C2', { name: 'Lakshmi Iyer', phone: '+919000033001', whatsappOffers: true }, at(5));
  c = await byPhone('9000033001');
  check('a second yes keeps the first record (when and who)', r.answer === 'APPLIED' && c?.whatsappOffersAt?.toISOString() === first && c?.whatsappOffersBy === POS_TILL_CONSENT, `${c?.whatsappOffersAt?.toISOString()} vs ${first}`);
  r = await sale('C3', { name: 'Lakshmi Iyer', phone: '+919000033001', whatsappOffers: true });
  check('the same bill twice: already applied, nothing new', (await sale('C3', { name: 'Lakshmi Iyer', phone: '+919000033001', whatsappOffers: true })).answer === 'ALREADY_APPLIED', '');

  console.log('\nD. A WALK-IN');
  r = await sale('D1', { whatsappOffers: true });
  const walkIns = await prisma.customer.findMany({ where: { clientId: CLIENT, phone: null }, select: { whatsappOffers: true } });
  check('no phone: the sale goes in on the walk-in customer, nobody is marked as agreeing', r.answer === 'APPLIED' && walkIns.length === 1 && walkIns[0].whatsappOffers === false, JSON.stringify({ r: r.answer, walkIns }));

  console.log('\nE. AN EXCHANGE, AND A BILL FROM THE FUTURE');
  await sale('E0', { name: 'Exchange Rani', phone: '+919000033301' });
  r = await applyExchange(CLIENT, store.id, {
    exchangeNo: `EXC/PC/${STAMP}`, againstInvoiceNo: inv('E0'), occurredAt: at(3),
    returned: [{ itemCode: variant.variantCode, qty: 1, lineTotalPaise: PRICE }],
    sold: [{ itemCode: variant.variantCode, qty: 1, unitPricePaise: PRICE, lineTotalPaise: PRICE }],
    payments: [], customer: { name: 'Exchange Rani', phone: '+919000033301', whatsappOffers: true }
  } as any);
  c = await byPhone('9000033301');
  check('an exchange with a yes: applied and recorded by the POS till', r.answer === 'APPLIED' && c?.whatsappOffers === true && c?.whatsappOffersBy === POS_TILL_CONSENT, JSON.stringify({ r, c }));
  const future = new Date(Date.now() + 3 * 86_400_000).toISOString();
  const before = Date.now();
  r = await sale('E1', { name: 'Future Meera', phone: '+919000033401', whatsappOffers: true }, future);
  c = await byPhone('9000033401');
  const t = c?.whatsappOffersAt?.getTime() ?? 0;
  check('a bill dated in the future: the yes is recorded at now, never in the future', c?.whatsappOffers === true && t >= before - 1000 && t <= Date.now() + 1000, String(c?.whatsappOffersAt));

  console.log('\nF. WORST CASES');
  const longAgo = new Date(Date.now() - 30 * 86_400_000).toISOString();
  const beforeOld = Date.now();
  r = await sale('F1', { name: 'Old Bill Gita', phone: '+919000033501', whatsappOffers: true }, longAgo);
  c = await byPhone('9000033501');
  const tOld = c?.whatsappOffersAt?.getTime() ?? 0;
  check('a bill dated 30 days ago: recorded at now, the same rule as the bill\'s date (never backdated)', c?.whatsappOffers === true && tOld >= beforeOld - 1000, String(c?.whatsappOffersAt));
  r = await sale('F2', { name: 'Bad Time Usha', phone: '+919000033502', whatsappOffers: true }, 'not a date');
  c = await byPhone('9000033502');
  check('an unreadable bill time: the sale goes in, the yes is recorded at now', r.answer === 'APPLIED' && c?.whatsappOffers === true, JSON.stringify({ r: r.answer, at: c?.whatsappOffersAt }));

  // Two bills for the same new number at the same moment, both with a yes.
  const [x1, x2] = await Promise.all([
    sale('F3', { name: 'Twin Bills Rama', phone: '+919000033503', whatsappOffers: true }),
    sale('F4', { name: 'Twin Bills Rama', phone: '+919000033503', whatsappOffers: true })
  ]);
  const twins = await prisma.customer.findMany({ where: { clientId: CLIENT, phone: { contains: '9000033503' } }, select: { whatsappOffers: true } });
  check('two bills at once for one number, both saying yes: both go in, one customer, agreeing',
    [x1.answer, x2.answer].every(a => a === 'APPLIED') && twins.length === 1 && twins[0].whatsappOffers === true, JSON.stringify({ a: [x1.answer, x2.answer], twins }));

  // A customer the owner erased comes back to the till with the same number and says yes.
  await sale('F5', { name: 'Erased Leela', phone: '+919000033504' });
  const erased = await byPhone('9000033504');
  await prisma.customer.update({ where: { id: erased!.id }, data: { name: 'Removed customer', phone: null, deletedAt: new Date(), whatsappOffers: false } });
  r = await sale('F6', { name: 'Leela Again', phone: '+919000033504', whatsappOffers: true });
  const back = await prisma.customer.findMany({ where: { clientId: CLIENT, phone: { contains: '9000033504' }, deletedAt: null }, select: { id: true, name: true, whatsappOffers: true } });
  const stillErased = await prisma.customer.findUniqueOrThrow({ where: { id: erased!.id }, select: { whatsappOffers: true, phone: true, deletedAt: true } });
  check('an erased customer back at the till: a NEW customer agrees; the erased one stays erased with no yes',
    r.answer === 'APPLIED' && back.length === 1 && back[0].id !== erased!.id && back[0].whatsappOffers === true && stillErased.whatsappOffers === false && stillErased.phone === null && !!stillErased.deletedAt,
    JSON.stringify({ r: r.answer, back, stillErased }));
}

main()
  .catch(e => { failed++; console.error('CRASHED', e); })
  .finally(async () => {
    await teardown();
    console.log(`\n${passed} passed, ${failed} failed`);
    await prisma.$disconnect();
    process.exit(failed ? 1 : 0);
  });
