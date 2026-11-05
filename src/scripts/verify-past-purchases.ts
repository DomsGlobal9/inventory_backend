/**
 * A shop's earlier customers and bills (services/past-purchases): the load, the pattern, and every real flow
 * those customers then meet. Made-up numbers only. Real data never goes in this file.
 *
 * Over real HTTP on the local server (4016), signed in by token cookie, with the service functions for the load.
 * LOCAL DATABASE ONLY, shop verify-suites-tenant. Removes what it made.
 *
 *   DATABASE_URL=… DIRECT_URL=… node run-local src/scripts/verify-past-purchases.ts
 */
const LOCAL = 'localhost:55433';
if (!String(process.env.DATABASE_URL || '').includes(LOCAL) || !String(process.env.DIRECT_URL || '').includes(LOCAL)) {
  console.error(`Refusing to run: DATABASE_URL and DIRECT_URL must both point at the local copy (${LOCAL}).`);
  process.exit(2);
}
import fs from 'node:fs';
import http from 'node:http';
import jwt from 'jsonwebtoken';
import { prisma } from '../lib/prisma';
import { AuthService } from '../services/auth.service';
import { analyse, PastBill } from '../services/past-purchases';
import { applyImport, cleanFile, hashOf, ImportFile, ImportRefused, plan, undoImport } from '../services/past-purchases/importer';
import { customerService } from '../services/customer.service';
import { posConnectionService } from '../services/pos/pos-connection.service';
import { applySale } from '../services/pos/pos-events.service';
import { deleteCustomer } from '../services/customer-delete';
import { setOffersConsent } from '../services/campaigns';
import { salesOrderService } from '../services/sales-order.service';
import { inventoryMutationService } from '../services/inventory-mutation.service';

let passed = 0, failed = 0;
const failures: string[] = [];
const check = (name: string, ok: boolean, detail?: unknown) => {
  if (ok) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; failures.push(name); console.log(`  FAIL ${name}${detail === undefined ? '' : ` -> ${JSON.stringify(detail)?.slice(0, 400)}`}`); }
};
const eq = (name: string, got: unknown, want: unknown) => check(name, JSON.stringify(got) === JSON.stringify(want), { got, want });
const refuses = (name: string, fn: () => unknown, words: RegExp) => {
  try { fn(); check(name, false, 'was accepted'); }
  catch (e: any) { check(name, e instanceof ImportRefused && words.test(e.message), e?.message); }
};

const C = 'verify-suites-tenant', OTHER = 'welcome-test-silks-716252';
const API = 'http://localhost:4016/api/v1';
const STAMP = String(Date.now()).slice(-6);
const SOURCE = `verify-${STAMP}`;
const phone = (n: number) => `9${STAMP}${String(n).padStart(3, '0')}`;
const e164 = (n: number) => `+91${phone(n)}`;

const silk = (amount: number, quantity = 1) => ({ kind: 'Pattu', fabric: 'Silk', quantity, amount });
const fancy = (amount: number, quantity = 1) => ({ kind: 'Fancy', fabric: null, quantity, amount });
const bill = (billNo: number | string, lines: any[], paidBy: string | null = 'CARD') => ({ billNo, net: lines.reduce((t, l) => t + l.amount, 0), paidBy, lines });
const kindIn = (p: any, name: string) => p.byKind.find((k: any) => k.name === name);
const asBill = (b: any): PastBill => ({ billNo: String(b.billNo), billedOn: null, net: b.net, paidBy: b.paidBy, lines: b.lines });

async function main() {
  const owner = await prisma.user.findFirstOrThrow({ where: { clientId: C, email: 'verify-suites@example.com' } });
  const seller = await prisma.user.findFirstOrThrow({ where: { clientId: C, status: 'ACTIVE', roles: { some: { role: { name: 'WAREHOUSE' } } } } });
  const stranger = await prisma.user.findFirst({ where: { clientId: OTHER, status: 'ACTIVE' } });
  const tokenOf = (u: { id: string; clientId: string | null; sessionVersion: number }) => AuthService.generateToken({ userId: u.id, clientId: u.clientId!, sessionVersion: u.sessionVersion });
  const call = (token: string, method: string, path: string, body?: unknown) =>
    fetch(`${API}${path}`, { method, headers: { 'content-type': 'application/json', origin: 'http://localhost:5183', cookie: `token=${token}` }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) })
      .then(async r => ({ status: r.status, body: await r.json().catch(() => null) as any }));
  const ownerToken = tokenOf(owner as any);
  const as = (method: string, path: string, body?: unknown) => call(ownerToken, method, path, body);

  console.log('\n1. THE PATTERN');
  eq('no bills: no pattern', analyse([]), null);
  let p = analyse([asBill(bill(100, [silk(30000), silk(18000)]))])!;
  eq('one kind', [p.topKind, p.billCount, p.netSpend, kindIn(p, 'Pattu').items, p.byKind.length, p.typicalItem, p.dearestItem, kindIn(p, 'Pattu').usual, p.byFabric.map((f: any) => f.name)], ['Pattu', 1, 48000, 2, 1, 24000, 30000, { from: 18000, to: 18000 }, ['Silk']]);
  p = analyse([asBill(bill(100, [silk(5000), fancy(2000), fancy(2000), fancy(2000)]))])!;
  eq('two kinds: the one with more money comes first, though the dearest item is the other', [p.topKind, kindIn(p, 'Pattu').spend, kindIn(p, 'Fancy').spend, p.items, p.dearestItem], ['Fancy', 5000, 6000, 4, 5000]);
  p = analyse([asBill(bill(100, [fancy(2500)]))])!;
  eq('no fabric in the records: none is claimed', [p.topKind, p.byFabric], ['Fancy', []]);
  p = analyse([asBill(bill(100, [fancy(2500), fancy(-2500, -1)]))])!;
  eq('sold and taken back on one bill: no bill, no item, no spend, nothing bought', [p.billCount, p.visits, p.items, p.netSpend, p.topKind, p.typicalItem, p.returnLines, p.allBills], [0, 0, 0, 0, null, null, 1, 1]);
  p = analyse([asBill(bill(100, [fancy(2500)])), asBill(bill(200, [fancy(-2500, -1)]))])!;
  eq('returned on a later bill: nets out, and that later bill is not a bill that counts', [p.billCount, p.items, p.netSpend, p.topKind], [1, 0, 0, null]);
  // A shop's own case: sold at 8,000, taken back bills later with 9,500 bought on that same bill (-8,000 + 9,500).
  p = analyse([asBill(bill(5360, [fancy(8000)])), asBill(bill(5851, [fancy(-8000, -1), fancy(9500)]))])!;
  eq('a -8,000 return on a later bill: spend, bills, the kept item', [p.netSpend, p.billCount, p.items, p.returnLines, p.returnsNotInRecords], [9500, 2, 1, 1, 0]);
  eq('...the item they gave back sets no budget and is not their dearest', [p.typicalItem, p.dearestItem, kindIn(p, 'Fancy').usual, kindIn(p, 'Fancy').spend], [9500, 9500, { from: 9500, to: 9500 }, 9500]);
  p = analyse([asBill(bill(10, [silk(70500), silk(30500), fancy(5000)])), asBill(bill(40, [silk(21000), silk(-70500, -1), silk(31500)]))])!;
  eq('their dearest item, returned later, stops being their dearest', [p.dearestItem, kindIn(p, 'Pattu').items, kindIn(p, 'Fancy').items, p.netSpend, p.billCount], [31500, 3, 1, 88000, 1]);
  p = analyse([asBill(bill(10, [fancy(5434.78), fancy(5434.78)])), asBill(bill(50, [fancy(-5435, -1)]))])!;
  eq('a return a few paise off the sale, from a discount spread over the bill, still finds its item', [p.items, p.returnsNotInRecords], [1, 0]);
  p = analyse([asBill(bill(20, [fancy(-16500, -1)])), asBill(bill(90, [fancy(7500), fancy(2700), fancy(2700), fancy(6100)]))])!;
  eq('returned something from before the records: the money comes off, their items stay', [p.netSpend, p.items, kindIn(p, 'Fancy').spend, p.returnsNotInRecords, p.topKind, p.dearestItem], [2500, 4, 19000, 1, 'Fancy', 7500]);
  p = analyse([asBill(bill(30, [fancy(-11987, -5), fancy(2000), fancy(2000), fancy(2000), fancy(2000), fancy(3801)]))])!;
  eq('an exchange that nets below zero: spend below zero shown, what they took is real', [p.netSpend, p.billCount, p.items, p.topKind], [-186, 0, 5, 'Fancy']);
  p = analyse([asBill(bill(10, [silk(9000)])), asBill(bill(50, [fancy(-9000, -1)]))])!;
  eq('a return of one kind does not take an item of another', [kindIn(p, 'Pattu').items, p.returnsNotInRecords], [1, 1]);
  p = analyse([asBill(bill(200, [silk(-9000, -1)]))])!;
  eq('only a return: spend below zero is shown, never a bill', [p.billCount, p.netSpend, p.byKind], [0, -9000, []]);
  p = analyse([asBill(bill(10, [fancy(1000)])), asBill(bill(15, [fancy(1000)])), asBill(bill(21, [fancy(1000)]))])!;
  eq('bills 5 apart are one visit, 6 apart are two', [p.billCount, p.visits], [3, 2]);
  p = analyse([asBill(bill(21, [fancy(1000)])), asBill(bill(10, [fancy(1000)]))])!;
  eq('the order bills arrive in does not matter', p.visits, 2);
  p = analyse([asBill(bill('A-1', [fancy(1000)])), asBill(bill('A-2', [fancy(1000)]))])!;
  eq('bill numbers that are not numbers: each is its own visit', p.visits, 2);
  p = analyse([asBill(bill(10, [fancy(3000, 3)]))])!;
  eq('three items on one line: the price of one, and three prices', [p.typicalItem, p.dearestItem, kindIn(p, 'Fancy').items], [1000, 1000, 3]);
  // Any shop: its own words, whatever its records hold, and nothing about what counts as dear.
  const line = (kind: string, amount: number, extra: any = {}) => ({ kind, quantity: amount < 0 ? -1 : 1, amount, ...extra });
  p = analyse([asBill(bill(1, [line('Kurti', 800, { fabric: 'Cotton', craft: 'Block print', colour: 'Blue', size: 'M' }), line('Kurti', 1200, { fabric: 'Cotton', craft: 'Block print', colour: 'Red', size: 'M' }), line('Lehenga', 2500, { fabric: 'Net', craft: 'Zardosi', colour: 'Red', size: 'L' })]))])!;
  eq('a kurti shop: its own kinds, fabrics, crafts, colours and sizes', [p.topKind, p.byKind.map((k: any) => k.name), p.byFabric.map((k: any) => k.name), p.byCraft.map((k: any) => [k.name, k.items, k.spend]), p.byColour.map((k: any) => [k.name, k.items]), p.bySize.map((k: any) => [k.name, k.items])], ['Lehenga', ['Lehenga', 'Kurti'], ['Net', 'Cotton'], [['Zardosi', 1, 2500], ['Block print', 2, 2000]], [['Red', 2], ['Blue', 1]], [['L', 1], ['M', 2]]]);
  check('...and no budget label: what is dear is the shop\'s to say', !('budgetTier' in p) && !('buys' in p) && !JSON.stringify(p).match(/silk|fancy/i), p);
  const datedBill = (no: number, on: string, lines: any[]) => ({ ...asBill(bill(no, lines)), billedOn: on });
  p = analyse([datedBill(1, '2024-01-05', [fancy(100)]), datedBill(2, '2024-01-05', [fancy(100)]), datedBill(900, '2024-03-01', [fancy(100)])])!;
  eq('with dates, a visit is a day, and not an estimate', [p.visits, p.visitsAreAnEstimate, p.datesKnown], [2, false, true]);
  p = analyse([asBill(bill(1, [fancy(100)])), asBill(bill(2, [fancy(100)]))])!;
  eq('with no dates, it says it is an estimate', [p.visits, p.visitsAreAnEstimate, p.datesKnown], [1, true, false]);
  p = analyse([datedBill(1, '2024-01-05', [fancy(100)]), asBill(bill(900, [fancy(100)]))])!;
  eq('some dates only: bill numbers again, still an estimate', [p.visits, p.visitsAreAnEstimate, p.datesKnown], [2, true, true]);
  p = analyse([asBill(bill(1, [fancy(1000)], 'CASH')), asBill(bill(2, [fancy(1000)], 'CARD')), asBill(bill(3, [fancy(1000)], 'CARD'))])!;
  eq('usually pays by the most used', p.usuallyPaysBy, 'CARD');
  p = analyse([asBill(bill(1, [fancy(1000), fancy(-1000, -1)], 'CASH'))])!;
  eq('a bill that does not count says nothing about how they pay', p.usuallyPaysBy, null);
  p = analyse([asBill(bill(1, [fancy(1234.5)]))])!;
  eq('paise', [p.netSpend, p.dearestItem], [1235, 1235]);

  console.log('\n2. A BAD FILE IS REFUSED BEFORE ANYTHING IS WRITTEN');
  const person = (n: number, bills: any[], name: string | null = `Person ${n}`) => ({ phone: phone(n), name, bills });
  refuses('no customers', () => cleanFile({ customers: [] }), /no customers/);
  refuses('the same number written two ways', () => cleanFile({ customers: [{ phone: phone(1), bills: [] }, { phone: `+91 ${phone(1)}`, bills: [] }] }), /twice/);
  refuses('one bill under two customers', () => cleanFile({ customers: [person(1, [bill(1, [fancy(1)])]), person(2, [bill(1, [fancy(1)])])] }), /Bill 1 is in the file twice/);
  refuses('lines that do not add up', () => cleanFile({ customers: [person(1, [{ billNo: 1, net: 5, lines: [fancy(1)] }])] }), /do not add up/);
  refuses('a bill with no lines', () => cleanFile({ customers: [person(1, [{ billNo: 1, net: 0, lines: [] }])] }), /no lines/);
  refuses('a bill with no number', () => cleanFile({ customers: [person(1, [{ billNo: ' ', net: 1, lines: [fancy(1)] }])] }), /no number/);
  refuses('an amount that is not a number', () => cleanFile({ customers: [person(1, [{ billNo: 1, net: 1, lines: [{ kind: 'Fancy', quantity: 1, amount: 'x' }] }])] } as any), /cannot be read/);
  const rich = cleanFile({ customers: [person(1, [{ billNo: 1, net: 500, lines: [{ kind: ' Kurti ', quantity: 1, amount: 500, craft: ' Block print ', colour: 'Blue', size: '', fabric: null, extra: 'x' } as any] }])] });
  eq('any shop\'s file: its words kept and tidied, blanks and unknown fields dropped', rich.customers[0].bills[0].lines[0], { kind: 'Kurti', quantity: 1, amount: 500, craft: 'Block print', colour: 'Blue' });
  refuses('a craft that is not words', () => cleanFile({ customers: [person(1, [{ billNo: 1, net: 1, lines: [{ kind: 'K', quantity: 1, amount: 1, craft: 5 } as any] }])] }), /craft/);
  refuses('a date that is not a date', () => cleanFile({ customers: [person(1, [{ ...bill(1, [fancy(1)]), billedOn: 'soon' }])] }), /date/);
  const cleaned = cleanFile({ customers: [person(1, [], '  '), { phone: '12345', name: 'Landline', bills: [bill(9, [fancy(1)])] }, { phone: '9999999999', name: 'Fake', bills: [] }] });
  eq('a number that cannot be a phone is left out and counted; no name gets the last 4 digits', [cleaned.customers.length, cleaned.badPhones, cleaned.badPhoneBills, cleaned.noName, cleaned.customers[0].name, cleaned.customers[0].phone], [1, 2, 1, 1, `Customer ${phone(1).slice(-4)}`, e164(1)]);

  console.log('\n3. THE LOAD');
  // Already a customer of this shop, with their own name, group and consent.
  const already = await customerService.createCustomer(C, { name: 'Their Own Name', phone: phone(2), tags: ['VIP'] });
  await setOffersConsent({ id: owner.id, clientId: C, permissions: ['*'], roles: ['SUPER_ADMIN'] } as any, already.id, true).catch(() => null);
  const consentBefore = await prisma.customer.findUniqueOrThrow({ where: { id: already.id }, select: { whatsappOffers: true, whatsappOffersAt: true, tags: true, name: true, customerCode: true, updatedAt: true, importSource: true } });
  // Deleted earlier: their old row must not be picked up, and the number is free.
  const gone = await customerService.createCustomer(C, { name: 'Left Earlier', phone: phone(3) });
  await deleteCustomer(C, gone.id, phone(3).slice(-4));
  // Another shop holds one of these numbers.
  const elsewhere = await prisma.customer.create({ data: { clientId: OTHER, customerCode: `PP-${STAMP}`, name: 'Other Shop Person', phone: e164(1) } });
  const file: ImportFile = { customers: [
    person(1, [bill(`${STAMP}01`, [silk(30000), silk(18000)]), bill(`${STAMP}02`, [fancy(3000), fancy(-3000, -1)])]),
    person(2, [bill(`${STAMP}03`, [fancy(2500), fancy(2500), fancy(2500)], 'PAYTM')], 'Name In The File'),
    person(3, [bill(`${STAMP}04`, [silk(9000)], 'CASH')]),
    person(4, [bill(`${STAMP}05`, [fancy(1000)])], null),
    { phone: '12345', name: 'Not A Phone', bills: [bill(`${STAMP}06`, [fancy(1000)])] }
  ] };
  const text = JSON.stringify(file), hash = hashOf(text);

  const shape = async () => {
    const w = { clientId: C };
    const [orders, ledger, moves, stock, points, credit, recipients, messages, customers] = await Promise.all([
      prisma.salesOrder.count({ where: w }), prisma.salesLedger.count({ where: w }), prisma.inventoryTransaction.count({ where: w }),
      prisma.inventoryStock.aggregate({ where: w, _sum: { quantity: true } }), prisma.loyaltyEntry.count({ where: w }), prisma.storeCreditEntry.count({ where: w }),
      prisma.campaignRecipient.count({ where: w }), prisma.whatsAppMessage.count({ where: w }), prisma.customer.count({ where: { ...w, deletedAt: null } })
    ]);
    return { orders, ledger, moves, stock: stock._sum.quantity, points, credit, recipients, messages, customers };
  };
  const before = await shape();
  const seqBefore = (await prisma.clientSequence.findFirst({ where: { clientId: C, entityType: 'CUSTOMER' } }))?.lastValue ?? 0;

  const dry = await plan(C, SOURCE, file, hash);
  eq('the dry run counts it right', [dry.customersInFile, dry.customersToCreate, dry.customersAlreadyHere, dry.billsInFile, dry.billsToAdd, dry.numbersLeftOut, dry.billsLeftOutWithThem, dry.customersWithNoName], [4, 3, 1, 5, 5, 1, 1, 1]);
  eq('...and writes nothing', await shape(), before);
  eq('...not even the record of a load', await prisma.pastPurchaseImport.count({ where: { clientId: C, source: SOURCE } }), 0);

  const offersBefore = (await as('POST', '/campaigns/preview', { audience: {} })).body?.data;
  const myDayBefore = (await as('GET', '/dashboard/my-day')).body?.data?.customersToday;
  const r = await applyImport(C, SOURCE, file, hash);
  eq('loaded', [r.already, r.created, r.matched, r.added], [false, 3, 1, 5]);

  const after = await shape();
  eq('no sale, stock, ledger, points, credit, campaign send or message was written', { ...after, customers: before.customers }, before);
  eq('three new customers, not four', after.customers - before.customers, 3);
  eq('"new customers today" did not move', (await as('GET', '/dashboard/my-day')).body?.data?.customersToday, myDayBefore);

  const row = (n: number) => prisma.customer.findFirstOrThrow({ where: { clientId: C, phone: e164(n), deletedAt: null } });
  const one = await row(1);
  check('a new customer is stored in the one phone form', one.phone === e164(1));
  eq('...offers off, no consent, active, with the load marked', [one.whatsappOffers, one.whatsappOffersAt, one.whatsappOffersBy, one.status, one.importSource, one.loyaltyPoints, one.tags], [false, null, null, 'ACTIVE', SOURCE, 0, []]);
  check('...with a normal code', /^CUS-\d{6}$/.test(one.customerCode), one.customerCode);
  const seqAfter = (await prisma.clientSequence.findFirstOrThrow({ where: { clientId: C, entityType: 'CUSTOMER' } })).lastValue;
  check('...from the shop\'s own numbering, moved past every code it used', seqAfter >= seqBefore + 3 && Number(one.customerCode.slice(4)) <= seqAfter, { seqBefore, seqAfter });
  eq('a customer the shop already had keeps everything', await prisma.customer.findUniqueOrThrow({ where: { id: already.id }, select: { whatsappOffers: true, whatsappOffersAt: true, tags: true, name: true, customerCode: true, updatedAt: true, importSource: true } }), consentBefore);
  eq('...and gets the bills', await prisma.pastPurchase.count({ where: { clientId: C, customerId: already.id, source: SOURCE } }), 1);
  const back = await row(3);
  check('a deleted customer\'s number comes back as a new customer, not on the old row', back.id !== gone.id && back.name === 'Person 3');
  eq('no name: the last 4 digits', (await row(4)).name, `Customer ${phone(4).slice(-4)}`);
  eq('another shop with the same number: not touched, no bills', [await prisma.pastPurchase.count({ where: { customerId: elsewhere.id } }), (await prisma.customer.findUniqueOrThrow({ where: { id: elsewhere.id } })).name], [0, 'Other Shop Person']);
  eq('the number that is not a phone made nobody', await prisma.pastPurchase.count({ where: { clientId: C, billNo: `${STAMP}06` } }), 0);
  eq('no date on any bill', await prisma.pastPurchase.count({ where: { clientId: C, source: SOURCE, billedOn: { not: null } } }), 0);

  console.log('\n3b. KEPT WITH A NAME AND NO NUMBER');
  refuses('no number and no name is refused: nobody could find them', () => cleanFile({ customers: [{ phone: null, key: 'k1', name: ' ', bills: [] }] }), /no name/);
  refuses('the same one twice is refused', () => cleanFile({ customers: [{ phone: null, key: 'k1', name: 'A', bills: [] }, { phone: null, key: 'k1', name: 'A', bills: [] }] }), /twice/);
  eq('no number and no key is only left out, as before', cleanFile({ customers: [{ phone: null, name: 'A', bills: [bill(`${STAMP}99`, [fancy(1)])] }, person(1, [])] }).badPhones, 1);
  const nn = `${SOURCE}-nonum`, sameNameFile: ImportFile = { customers: [
    { phone: null, key: `nn-${STAMP}`, name: 'Person 1', bills: [bill(`${STAMP}70`, [fancy(14500)], 'CASH')] }
  ] };
  const nnDry = await plan(C, nn, sameNameFile, hashOf('nn'));
  eq('the dry run says so', [nnDry.customersToCreate, nnDry.customersKeptWithoutNumber, nnDry.billsToAdd, nnDry.numbersLeftOut], [1, 1, 1, 0]);
  await applyImport(C, nn, sameNameFile, hashOf('nn'));
  const kept = await prisma.customer.findFirstOrThrow({ where: { clientId: C, externalCustomerId: `import:nn-${STAMP}` } });
  check('saved with no number, as a new customer, though someone else has that very name', kept.phone === null && kept.name === 'Person 1' && kept.id !== one.id, { phone: kept.phone, same: kept.id === one.id });
  eq('...their bill is on them and nobody else', [await prisma.pastPurchase.count({ where: { customerId: kept.id } }), await prisma.pastPurchase.count({ where: { customerId: one.id, billNo: `${STAMP}70` } })], [1, 0]);
  eq('...offers off', kept.whatsappOffers, false);
  const nnSeen = (await as('GET', `/customers/${kept.id}/past-purchases`)).body?.data;
  eq('...their page has it', [nnSeen?.bills?.length, nnSeen?.pattern?.netSpend, nnSeen?.pattern?.topKind], [1, 14500, 'Fancy']);
  await prisma.pastPurchaseImport.update({ where: { clientId_source: { clientId: C, source: nn } }, data: { finishedAt: null } });
  await applyImport(C, nn, sameNameFile, hashOf('nn'));
  eq('stopped and run again: the same row, no second copy', [await prisma.customer.count({ where: { clientId: C, externalCustomerId: `import:nn-${STAMP}` } }), await prisma.pastPurchase.count({ where: { clientId: C, source: nn } })], [1, 1]);
  const nnEdit = await as('PATCH', `/customers/${kept.id}`, { phone: phone(70) });
  eq('a number added later: their bills stay with them', [nnEdit.status, (await as('GET', `/customers/${kept.id}/past-purchases`)).body?.data?.bills?.length], [200, 1]);
  await prisma.customer.update({ where: { id: kept.id }, data: { phone: null } });
  const nnPrev = (await as('GET', `/customers/${kept.id}/delete-preview`)).body?.data;
  eq('the delete box asks for the name', [nnPrev?.mode, nnPrev?.phoneLast4, nnPrev?.pastBills], ['REMOVE', null, 1]);
  const nnDel = await as('DELETE', `/customers/${kept.id}`, { confirm: 'Person 1' });
  eq('...and removes them with their bill', [nnDel.status, await prisma.customer.count({ where: { id: kept.id } }), await prisma.pastPurchase.count({ where: { customerId: kept.id } })], [200, 0, 0]);

  console.log('\n4. RUNNING IT AGAIN');
  const shapeNow = await shape(), billsNow = await prisma.pastPurchase.count({ where: { clientId: C, source: SOURCE } });
  const again = await applyImport(C, SOURCE, file, hash);
  eq('finished: nothing changes', [again.already, await shape(), await prisma.pastPurchase.count({ where: { clientId: C, source: SOURCE } })], [true, shapeNow, billsNow]);
  let threw = '';
  try { await applyImport(C, SOURCE, { customers: [person(9, [])] }, 'other'); } catch (e: any) { threw = e.message; }
  check('a different file under the same load is refused', /different file/.test(threw), threw);
  eq('...and made nobody', await prisma.customer.count({ where: { clientId: C, phone: e164(9) } }), 0);

  // Stopped half way: the record says unfinished, part of it is missing. Running again finishes it, with no second copy.
  const half = `${SOURCE}-half`, halfFile: ImportFile = { customers: [person(20, [bill(`${STAMP}21`, [fancy(100)])]), person(21, [bill(`${STAMP}22`, [fancy(100)])])] };
  await applyImport(C, half, halfFile, hashOf('half'));
  await prisma.pastPurchase.deleteMany({ where: { clientId: C, source: half, billNo: `${STAMP}22` } });
  await prisma.customer.delete({ where: { id: (await row(21)).id } });
  await prisma.pastPurchaseImport.update({ where: { clientId_source: { clientId: C, source: half } }, data: { finishedAt: null } });
  const resumed = await applyImport(C, half, halfFile, hashOf('half'));
  eq('stopped half way: finishes the rest, once', [resumed.already, await prisma.customer.count({ where: { clientId: C, phone: { in: [e164(20), e164(21)] }, deletedAt: null } }), await prisma.pastPurchase.count({ where: { clientId: C, source: half } })], [false, 2, 2]);

  // Two runs at once, and the till saving one of the numbers at that very moment.
  const race = `${SOURCE}-race`, raceFile: ImportFile = { customers: Array.from({ length: 12 }, (_, i) => person(30 + i, [bill(`${STAMP}3${i}`, [fancy(100)])])) };
  const [a, b, till] = await Promise.allSettled([
    applyImport(C, race, raceFile, hashOf('race')), applyImport(C, race, raceFile, hashOf('race')),
    customerService.createCustomer(C, { name: 'At The Till', phone: phone(33) })
  ]);
  check('two runs at once both finish', a.status === 'fulfilled' && b.status === 'fulfilled', [a, b]);
  const racePhones = raceFile.customers.map((_, i) => e164(30 + i));
  const raced = await prisma.customer.findMany({ where: { clientId: C, phone: { in: racePhones }, deletedAt: null }, select: { phone: true, customerCode: true } });
  eq('...one customer per number, each with its own code, whichever got there first', [raced.length, new Set(raced.map(x => x.phone)).size, new Set(raced.map(x => x.customerCode)).size], [12, 12, 12]);
  eq('...one copy of every bill', await prisma.pastPurchase.count({ where: { clientId: C, source: race } }), 12);
  eq('...and the till\'s customer has their bill', till.status === 'fulfilled' ? await prisma.pastPurchase.count({ where: { customerId: (till.value as any).id } }) : 1, 1);

  console.log('\n5. THE SCREENS\' ANSWERS');
  const seen = (await as('GET', `/customers/${one.id}/past-purchases`)).body?.data;
  eq('the customer page gets the pattern and the bills, last number first', [seen?.pattern?.topKind, seen?.pattern?.netSpend, seen?.pattern?.billCount, seen?.pattern?.allBills, seen?.pattern?.datesKnown, seen?.bills?.map((x: any) => x.billNo)], ['Pattu', 48000, 1, 2, false, [`${STAMP}02`, `${STAMP}01`]]);
  eq('...each bill with no date', seen?.bills?.map((x: any) => x.billedOn), [null, null]);
  const plainCustomer = await customerService.createCustomer(C, { name: 'Never Imported', phone: phone(5) });
  eq('a customer with no past bills: no pattern, no bills', (await as('GET', `/customers/${plainCustomer.id}/past-purchases`)).body?.data, { pattern: null, bills: [] });
  eq('an unknown customer: the same, nothing to learn', (await as('GET', '/customers/00000000-0000-0000-0000-000000000000/past-purchases')).body?.data, { pattern: null, bills: [] });
  if (stranger) eq('another shop asking for this customer: nothing', (await call(tokenOf(stranger as any), 'GET', `/customers/${one.id}/past-purchases`)).body?.data ?? null, { pattern: null, bills: [] });
  const limitedRole = await call(tokenOf(seller as any), 'GET', `/customers/${one.id}/past-purchases`);
  check('someone who may not see customers cannot see these', [200, 403].includes(limitedRole.status) && (limitedRole.status === 403) === !(await (async () => { const me = await call(tokenOf(seller as any), 'GET', '/customers?limit=1'); return me.status === 200; })()), limitedRole.status);
  const detail = (await as('GET', `/customers/${one.id}`)).body;
  eq('their sales orders are still only sales orders', [detail.importSource, detail.salesOrders.length], [SOURCE, 0]);

  const list = (q: string) => as('GET', `/customers?${q}`);
  eq('a list asked for 5 gives 5', (await list('limit=5')).body.length, 5);
  const firstFive = (await list('limit=5')).body.map((x: any) => x.id), firstFiveAgain = (await list('limit=5')).body.map((x: any) => x.id);
  eq('...the same 5 each time, even with one load time', firstFive, firstFiveAgain);
  const everyone = (await list('')).body.length;
  for (const bad of ['limit=abc', 'limit=0', 'limit=-1', 'limit=99999', 'limit=1.5']) eq(`${bad} is ignored`, (await list(bad)).body.length, everyone);
  eq('search by number finds them', (await list(`search=${phone(1)}`)).body.map((x: any) => x.id), [one.id]);

  console.log('\n6. THE REAL FLOWS, NO SECOND COPY');
  let cardNow = (await as('GET', `/customers/card?phone=${phone(1)}`)).body?.data;
  eq('Customer card: finds them, no real bills, the pattern beside', [cardNow?.customer?.id, cardNow?.visits?.bills, cardNow?.visits?.lastVisit, cardNow?.past?.topKind, cardNow?.past?.allBills], [one.id, 0, null, 'Pattu', 2]);
  const dup = await as('POST', '/customers', { name: 'Typed Again', phone: phone(1) });
  eq('Add customer with their number: refused, and says who', [dup.status, dup.body?.existingCustomerId ?? dup.body?.details?.existingCustomerId], [409, one.id]);
  const byPhone = (await as('GET', `/customers/by-phone/${encodeURIComponent(e164(1))}`)).body;
  eq('by-phone finds the same row', byPhone?.data?.id ?? byPhone?.id, one.id);

  const store = await prisma.stockLocation.findFirstOrThrow({ where: { clientId: C, active: true, type: 'STORE' as any }, select: { id: true } });
  const variant = await prisma.productVariant.findFirstOrThrow({ where: { clientId: C, sellingPrice: { gt: 0 }, product: { status: 'ACTIVE', trashedAt: null } }, select: { id: true, variantCode: true, sellingPrice: true } });
  await inventoryMutationService.applyMovement({ clientId: C, variantId: variant.id, locationId: store.id, movementType: 'IN', reason: 'PURCHASE_RECEIPT', quantityDelta: 10, unitCost: 1, notes: 'verify-past-purchases top-up', createdBy: 'verify-past-purchases' } as any);

  // An order from the app: the screen finds them by number, then bills that row.
    const placed: any = await salesOrderService.createFullOrder(C, store.id, { customer: { id: byPhone?.data?.id ?? byPhone?.id }, channel: 'MANUAL', items: [{ variantId: variant.id, quantity: 1 }] } as any, 'MANUAL' as any);
  eq('a new order for them lands on the same customer', placed.customerId, one.id);
  eq('...their name is not replaced', (await row(1)).name, 'Person 1');

  // The online shop: the number proved with a code, a real order, on the test server that has the WhatsApp stand-in.
  if (process.env.SHOP_CODES) {
    const SLUG = 'localshop', CODES = process.env.SHOP_CODES;
    const shop = (path: string, body?: unknown) => new Promise<{ status: number; body: any }>((resolve, reject) => {
      const d = body === undefined ? undefined : JSON.stringify(body);
      const req = http.request({ host: '127.0.0.1', port: 4026, path: `/_api/shop/${SLUG}${path}`, method: d ? 'POST' : 'GET', headers: { host: 'shop.localhost:4006', ...(d ? { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(d)) } : {}) } }, (res) => {
        let t = ''; res.on('data', c => { t += c; }); res.on('end', () => { let b = null; try { b = JSON.parse(t); } catch { /* not json */ } resolve({ status: res.statusCode ?? 0, body: b }); });
      });
      req.on('error', reject); if (d) req.write(d); req.end();
    });
    const was = await prisma.onlineShop.findFirstOrThrow({ where: { clientId: C }, select: { id: true, acceptsOrders: true, payOnDelivery: true } });
    await prisma.onlineShop.update({ where: { id: was.id }, data: { acceptsOrders: true, payOnDelivery: true } });
    const prod = await prisma.product.create({ data: { clientId: C, productCode: `PP${STAMP}`, slug: `pp${STAMP}`, title: `Past shop test ${STAMP}`, category: 'WOMEN' as any, productType: 'READY_TO_WEAR' as any, dressType: 'Saree', basePrice: 1000, status: 'ACTIVE' as any, publishedAt: new Date() } as any });
    const shopVariant = await prisma.productVariant.create({ data: { productId: prod.id, clientId: C, colorName: 'Red', size: 'M', variantCode: `PPV${STAMP}`, sku: `PPS${STAMP}`, sellingPrice: 1000, costPrice: 1, reorderLevel: 0 } as any });
    const shopStore = (await prisma.onlineShop.findFirstOrThrow({ where: { clientId: C }, select: { locationIds: true } })).locationIds[0] ?? store.id;
    await prisma.inventoryStock.create({ data: { clientId: C, variantId: shopVariant.id, locationId: shopStore, quantity: 5, reservedQty: 0 } });
    const codesFor = () => fs.readFileSync(CODES, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)).filter(l => String(l.to).endsWith(phone(31)));
    const sentBefore = codesFor().length;
    await shop('/verify/send', { phone: phone(31), purpose: 'SIGNIN' });
    let code = '';
    for (let i = 0; i < 80 && !code; i++) { code = /(\d{6}) is your code/.exec(codesFor().slice(sentBefore).at(-1)?.text ?? '')?.[1] ?? ''; if (!code) await new Promise(res => setTimeout(res, 200)); }
    const proof = (await shop('/verify/check', { phone: phone(31), code })).body?.data?.token;
    const shopper = await row(31);
    const sale = await shop('/orders', { placementKey: `past-purchases-suite-${STAMP}`, lines: [{ variantCode: shopVariant.variantCode, quantity: 1 }], name: 'Typed At Checkout', phone: phone(31), token: proof, email: '', address: 'Flat 4, 12-3 Gandhi Road, Vijayawada', pincode: '520001', payWay: 'ON_DELIVERY' });
    const shopOrder = sale.body?.data?.token ? await prisma.onlineShopOrder.findUnique({ where: { token: sale.body.data.token }, select: { salesOrder: { select: { customerId: true } } } }) : null;
    if (!shopOrder) console.log('   shop said:', sale.status, JSON.stringify(sale.body)?.slice(0, 300), 'proof', !!proof, 'code', !!code);
    eq('an order on the online shop with their proved number lands on the same customer', shopOrder?.salesOrder?.customerId, shopper.id);
    eq('...still one row for that number, their name kept', [await prisma.customer.count({ where: { clientId: C, phone: e164(31), deletedAt: null } }), (await row(31)).name], [1, 'Person 31']);
    await prisma.onlineShop.update({ where: { id: was.id }, data: { acceptsOrders: was.acceptsOrders, payOnDelivery: was.payOnDelivery } });
  } else console.log('  (online shop order not run: set SHOP_CODES and start 4026)');

  // The till: the wallet and a real bill.
  const tillKey = await posConnectionService.create(C, { locationId: store.id, name: `Past ${STAMP}` });
  const wallet = await fetch(`${API}/pos/v1/wallet?customerRef=${encodeURIComponent(e164(4))}&billPaise=100000`, { headers: { 'X-Storefront-Key': tillKey.key } }).then(x => x.json()).catch(() => null) as any;
  eq('the till knows them by name', wallet?.data?.customerName, `Customer ${phone(4).slice(-4)}`);
  const pricePaise = Math.round(Number(variant.sellingPrice) * 100);
  const event = {
    kind: 'sale.completed', invoiceNo: `INV/PAST/${STAMP}`, occurredAt: new Date().toISOString(), customer: { name: 'Typed At Till', phone: e164(4) },
    lines: [{ itemCode: variant.variantCode, qty: 1, unitPricePaise: pricePaise, lineTotalPaise: pricePaise }], totals: {},
    payments: [{ method: 'CASH', amountPaise: pricePaise }]
  };
  const tillResult: any = await applySale(C, store.id, event as any);
  const tillOrder = await prisma.salesOrder.findFirst({ where: { clientId: C, externalOrderId: `INV/PAST/${STAMP}` }, select: { customerId: true } });
  check('the till bill was applied', !!tillOrder, tillResult);
  const four = await row(4);
  eq('a bill at the till lands on the same customer', tillOrder?.customerId, four.id);
  eq('...still one row for that number', await prisma.customer.count({ where: { clientId: C, phone: e164(4), deletedAt: null } }), 1);
  cardNow = (await as('GET', `/customers/card?phone=${phone(4)}`)).body?.data;
  check('...the card now has the real, dated bill and still the past one', cardNow?.visits?.bills === 1 && !!cardNow?.visits?.lastVisit && cardNow?.past?.allBills === 1, cardNow?.visits);
  eq('...and the past pattern did not change', cardNow?.past?.netSpend, 1000);

  // Editing them: bills stay with the person when the number changes.
  const moved = await as('PATCH', `/customers/${four.id}`, { phone: phone(6), name: 'Corrected Name' });
  eq('edit the number and the name', [moved.status, moved.body?.data?.importSource ?? moved.body?.importSource], [200, SOURCE]);
  eq('...the past bills follow the person', (await as('GET', `/customers/${four.id}/past-purchases`)).body?.data?.bills?.length, 1);

  console.log('\n7. MESSAGES');
  const reachable = await prisma.customer.count({ where: { clientId: C, importSource: { startsWith: SOURCE }, OR: [{ whatsappOffers: true }, { whatsappOffersAt: { not: null } }] } });
  eq('nobody from a load is reachable for offers', reachable, 0);
  const offersNow = (await as('POST', '/campaigns/preview', { audience: {} })).body?.data;
  check('a campaign preview answers', typeof offersNow?.agreedToOffers === 'number' && typeof offersBefore?.agreedToOffers === 'number', offersNow);
  eq('a campaign to everybody reaches exactly as many people as before the load', [offersNow?.agreedToOffers, offersNow?.count], [offersBefore?.agreedToOffers, offersBefore?.count]);
  check('...the numbers are there, waiting for a yes', offersNow?.customersWithPhone > offersBefore?.customersWithPhone, [offersBefore?.customersWithPhone, offersNow?.customersWithPhone]);
  check('...and none of them is in its sample', !(offersNow?.sample ?? []).some((c: any) => /^Person d+$/.test(c.name)), offersNow?.sample);
  eq('the campaign page counts their number but not their consent', await prisma.customer.count({ where: { id: one.id, whatsappOffers: true } }), 0);
  const yes = await setOffersConsent({ id: owner.id, clientId: C, permissions: ['*'], roles: ['SUPER_ADMIN'] } as any, one.id, true).then(() => true).catch(() => false);
  eq('when they say yes at the counter, it is recorded the normal way', [yes, (await row(1)).whatsappOffers], [true, true]);

  console.log('\n8. WHAT CRM HEARS');
  const hadSub = await prisma.moduleSubscription.findFirst({ where: { clientId: C, module: 'crm' } });
  if (!hadSub) await prisma.moduleSubscription.create({ data: { clientId: C, module: 'crm' } as any });
  const feedSource = `${SOURCE}-feed`, feedFile: ImportFile = { customers: [person(50, [bill(`${STAMP}50`, [silk(4000)]), bill(`${STAMP}51`, [fancy(1000)])])] };
  const since = (await prisma.moduleEvent.aggregate({ where: { clientId: C, module: 'crm' }, _max: { sequence: true } }))._max.sequence ?? 0n;
  await applyImport(C, feedSource, feedFile, hashOf('feed'));
  const feed = async () => prisma.moduleEvent.findMany({ where: { clientId: C, module: 'crm', sequence: { gt: since } }, orderBy: { sequence: 'asc' }, select: { kind: true, payload: true } });
  let events = await feed();
  eq('CRM is told of the customer and of each bill, once', events.map(e => e.kind).sort(), ['customer.created', 'past_purchase.created', 'past_purchase.created']);
  const created = events.find(e => e.kind === 'customer.created')!.payload as any;
  eq('...the customer says it came from a load, offers off', [created.import_source, created.whatsapp_offers], [feedSource, false]);
  const pastEvent = events.find(e => e.kind === 'past_purchase.created')!.payload as any;
  eq('...a bill says plainly it has no date', [pastEvent.billed_on, pastEvent.customer_id === created.id], [null, true]);
  const fifty = await row(50);
  // The two routes CRM reads, with a real service token, on the test server that trusts the test key.
  if (process.env.CRM_KEY) {
    const key = fs.readFileSync(process.env.CRM_KEY, 'utf8');
    const bearer = (scope: string[], clientId?: string) => ({ Authorization: `Bearer ${jwt.sign({ sub: 'scaleezy-crm-test', scope, ...(clientId ? { clientId } : {}) }, key, { algorithm: 'RS256', audience: 'inventory', issuer: 'scaleezy-crm-test', keyid: 'test-1', expiresIn: '5m' })}` });
    const crm = (path: string, headers: Record<string, string>) => fetch(`http://127.0.0.1:4026/api/v1/internal/modules/crm${path}`, { headers }).then(async x => ({ status: x.status, body: await x.json().catch(() => null) as any }));
    const mine = await crm(`/shops/${C}/customers/${fifty.id}/past-purchases`, bearer(['modules:crm']));
    eq('CRM gets one customer: the same pattern Inventory shows, and the bills', [mine.status, mine.body?.data?.pattern?.topKind, mine.body?.data?.pattern?.netSpend, mine.body?.data?.bills?.length, mine.body?.data?.bills?.[0]?.billedOn], [200, 'Pattu', 5000, 2, null]);
    const seenIds: string[] = []; let after = ''; let pages = 0;
    for (;;) {
      const page = await crm(`/shops/${C}/past-purchases?limit=3${after ? `&after=${after}` : ''}`, bearer(['modules:crm']));
      if (page.status !== 200) { check('CRM can page through every past bill', false, page); break; }
      seenIds.push(...page.body.data.bills.map((x: any) => x.id)); pages++;
      if (!page.body.data.next) break;
      after = page.body.data.next;
    }
    const allBills = await prisma.pastPurchase.count({ where: { clientId: C, customer: { deletedAt: null } } });
    eq('...and pages through every bill of the shop, each once', [seenIds.length, new Set(seenIds).size, pages > 1], [allBills, allBills, true]);
    const gotPatterns: any[] = []; let pAfter = ''; let pPages = 0;
    for (;;) {
      const page = await crm(`/shops/${C}/past-purchases/patterns?limit=2${pAfter ? `&after=${pAfter}` : ''}`, bearer(['modules:crm']));
      if (page.status !== 200) { check('CRM can page through the patterns', false, page); break; }
      gotPatterns.push(...page.body.data.customers); pPages++;
      if (!page.body.data.next) break;
      pAfter = page.body.data.next;
    }
    const withBills = await prisma.customer.count({ where: { clientId: C, deletedAt: null, pastPurchases: { some: {} } } });
    eq('...and pages through the pattern of every customer with past bills, each once', [gotPatterns.length, new Set(gotPatterns.map(x => x.customerId)).size, pPages > 1], [withBills, withBills, true]);
    eq('...the same pattern the one-customer route gives', gotPatterns.find(x => x.customerId === fifty.id)?.pattern, mine.body?.data?.pattern);
    eq('...another shop\'s token cannot read them', (await crm(`/shops/${C}/past-purchases/patterns`, bearer(['modules:crm'], OTHER))).status, 403);
    eq('a token without the CRM scope is refused', (await crm(`/shops/${C}/past-purchases`, bearer(['modules:logistics']))).status, 403);
    eq('a token for another shop is refused', (await crm(`/shops/${C}/past-purchases`, bearer(['modules:crm'], OTHER))).status, 403);
    eq('no token is refused', (await crm(`/shops/${C}/past-purchases`, {})).status, 401);
    eq('a shop with CRM off is refused', (await crm(`/shops/no-crm-${STAMP}/past-purchases`, bearer(["modules:crm"]))).status, 404);
  } else console.log('  (CRM routes not run: set CRM_KEY and start 4026)');
  await deleteCustomer(C, fifty.id, phone(50).slice(-4));
  events = await feed();
  eq('deleting them: CRM is told each bill and the customer went', events.map(e => e.kind).filter(k => k.endsWith('.deleted')).sort(), ['customer.deleted', 'past_purchase.deleted', 'past_purchase.deleted']);
  if (!hadSub) await prisma.moduleSubscription.delete({ where: { clientId_module: { clientId: C, module: 'crm' } } });
  await prisma.moduleEvent.deleteMany({ where: { clientId: C, module: 'crm', sequence: { gt: since } } });

  console.log('\n9. DELETING A CUSTOMER');
  const lone = await row(3);
  let prev = (await as('GET', `/customers/${lone.id}/delete-preview`)).body?.data;
  eq('only past bills: removed for good, and the box says the bills go too', [prev?.mode, prev?.bills, prev?.pastBills], ['REMOVE', 0, 1]);
  await as('DELETE', `/customers/${lone.id}`, { confirm: phone(3).slice(-4) });
  eq('...the row and the bill are gone', [await prisma.customer.count({ where: { id: lone.id } }), await prisma.pastPurchase.count({ where: { customerId: lone.id } })], [0, 0]);
  eq('...and running the load again does not bring them back', [(await applyImport(C, SOURCE, file, hash)).already, await prisma.customer.count({ where: { clientId: C, phone: e164(3), deletedAt: null } })], [true, 0]);

  const withBill = await row(1);
  await prisma.salesOrder.update({ where: { id: placed.id }, data: { status: 'DISPATCHED' as any } });
  prev = (await as('GET', `/customers/${withBill.id}/delete-preview`)).body?.data;
  eq('a real bill too: erased, with the real bill kept and the past ones gone', [prev?.mode, prev?.bills, prev?.pastBills], ['ERASE', 1, 2]);
  const erased = await as('DELETE', `/customers/${withBill.id}`, { confirm: phone(1).slice(-4) });
  eq('...done', erased.status, 200);
  const erasedRow = await prisma.customer.findUniqueOrThrow({ where: { id: withBill.id } });
  eq('...name and number gone, past bills gone, the real bill still there', [erasedRow.name, erasedRow.phone, await prisma.pastPurchase.count({ where: { customerId: withBill.id } }), await prisma.salesOrder.count({ where: { id: placed.id, customerId: withBill.id } })], ['Removed customer', null, 0, 1]);
  eq('...and their page has no past bills', (await as('GET', `/customers/${withBill.id}/past-purchases`)).body?.data, { pattern: null, bills: [] });

  console.log('\n10. TAKING A LOAD BACK OUT');
  const undoSource = `${SOURCE}-undo`, undoFile: ImportFile = { customers: [
    person(60, [bill(`${STAMP}60`, [fancy(100)])]), person(61, [bill(`${STAMP}61`, [fancy(100)])]),
    person(62, [bill(`${STAMP}62`, [fancy(100)])]), person(5, [bill(`${STAMP}63`, [fancy(100)])])
  ] };
  await applyImport(C, undoSource, undoFile, hashOf('undo'));
  const edited = await row(61);
  await as('PATCH', `/customers/${edited.id}`, { name: 'Somebody Fixed This' });
  const looked = await row(62);
  await as('GET', `/customers/card?phone=${phone(62)}`);
  for (let i = 0; i < 30 && !(await prisma.counterLookup.count({ where: { customerId: looked.id } })); i++) await new Promise(res => setTimeout(res, 100));
  const undone = await undoImport(C, undoSource);
  eq('all its bills go', [undone.billsRemoved, await prisma.pastPurchase.count({ where: { clientId: C, source: undoSource } })], [4, 0]);
  eq('an untouched customer it made goes; the edited one and the looked-up one stay', [undone.customersRemoved, undone.customersKept], [1, 2]);
  eq('...those are ordinary customers now', (await row(61)).importSource, null);
  eq('a customer the load only matched is not touched', (await row(5)).name, 'Never Imported');
  let noSuch = '';
  try { await undoImport(C, undoSource); } catch (e: any) { noSuch = e.message; }
  check('undoing it twice is refused in words', /no load called/.test(noSuch), noSuch);
  const reloaded = await applyImport(C, undoSource, undoFile, hashOf('undo'));
  eq('it can be loaded again, with no second copies', [reloaded.created, reloaded.matched, reloaded.added, await prisma.customer.count({ where: { clientId: C, phone: e164(61), deletedAt: null } })], [1, 3, 4, 1]);
  await undoImport(C, undoSource);

  return { placedId: placed.id, tillKeyId: (tillKey as any).id };
}

/** Everything the suite made, orders included: nothing of it stays in the test shop for CRM to copy. */
async function cleanUp() {
  const made = await prisma.customer.findMany({ where: { OR: [{ phone: { startsWith: `+919${STAMP}` } }, { importSource: { startsWith: SOURCE } }, { customerCode: `PP-${STAMP}` }] }, select: { id: true } });
  const ids = made.map(c => c.id);
  const orders = (await prisma.salesOrder.findMany({ where: { clientId: C, customerId: { in: ids } }, select: { id: true } })).map(o => o.id);
  await prisma.salesLedger.deleteMany({ where: { clientId: C, salesOrderId: { in: orders } } });
  await prisma.dispatch.deleteMany({ where: { salesOrderId: { in: orders } } });
  await prisma.salesOrder.deleteMany({ where: { id: { in: orders } } });
  await prisma.pastPurchase.deleteMany({ where: { source: { startsWith: SOURCE } } });
  await prisma.pastPurchaseImport.deleteMany({ where: { source: { startsWith: SOURCE } } });
  await prisma.campaignRecipient.deleteMany({ where: { customerId: { in: ids } } });
  await prisma.counterLookup.deleteMany({ where: { customerId: { in: ids } } });
  await prisma.customer.deleteMany({ where: { id: { in: ids } } });
  const product = await prisma.product.findFirst({ where: { clientId: C, productCode: `PP${STAMP}` }, select: { id: true, variants: { select: { id: true } } } });
  if (product) {
    const variants = product.variants.map(v => v.id);
    await prisma.inventoryStock.deleteMany({ where: { clientId: C, variantId: { in: variants } } });
    await prisma.inventoryTransaction.deleteMany({ where: { clientId: C, variantId: { in: variants } } });
    await prisma.productVariant.deleteMany({ where: { clientId: C, id: { in: variants } } });
    await prisma.product.delete({ where: { id: product.id } });
  }
  await prisma.storefrontConnection.deleteMany({ where: { clientId: C, name: `Past ${STAMP}` } }).catch(() => null);
  const left = await prisma.customer.count({ where: { OR: [{ phone: { startsWith: `+919${STAMP}` } }, { importSource: { startsWith: SOURCE } }] } });
  console.log(`\n(cleaned up: ${ids.length} customers, ${orders.length} orders; left behind: ${left})`);
}

main()
  .catch(e => { failed++; failures.push(`stopped: ${e?.message ?? e}`); console.log(`  FAIL stopped: ${e?.stack ?? e}`); })
  .finally(async () => {
    await cleanUp().catch(e => { failed++; failures.push(`clean up: ${e?.message}`); });
    console.log(`\n${passed} passed, ${failed} failed`);
    if (failures.length) console.log(failures.map(f => ` - ${f}`).join('\n'));
    await prisma.$disconnect();
    process.exit(failed ? 1 : 0);
  });
