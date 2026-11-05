/**
 * Loading a shop's earlier customers and bills (scripts/import-past-customers.ts).
 *
 * One number, one customer, always the shop's real row:
 *  - a number the shop already has keeps its customer, untouched (name, groups, consent): only the bills are added;
 *  - a new number becomes an ordinary customer, with the next CUS code, WhatsApp offers OFF and no consent recorded;
 *  - nothing is ever sent, and no sale, stock, Day Book, GST, points or credit row is written.
 *
 * Safe to stop and run again: chunks are all-or-nothing and bill numbers are unique per load. Once a load
 * has finished, running it again changes nothing, so a customer the owner has since deleted stays deleted.
 */
import crypto from 'crypto';
import { randomUUID } from 'crypto';
import { prisma } from '../../lib/prisma';
import { normalisePhone } from '../../lib/phone';
import { generateSequentialCodes } from '../../utils/codeGenerator';
import { PastLine } from './index';

export type ImportBill = { billNo: string | number; billedOn?: string | null; net: number; paidBy?: string | null; lines: PastLine[] };
export type ImportCustomer = { phone: string; name?: string | null; bills: ImportBill[] };
export type ImportFile = { customers: ImportCustomer[] };

type Clean = { phone: string; name: string; bills: { billNo: string; billedOn: Date | null; net: number; paidBy: string | null; lines: PastLine[] }[] };

const CHUNK = 200;
const LOOKUP = 1000;

export class ImportRefused extends Error {}
const chunks = <T>(a: T[], n: number) => Array.from({ length: Math.ceil(a.length / n) }, (_, i) => a.slice(i * n, i * n + n));
export const hashOf = (text: string) => crypto.createHash('sha256').update(text).digest('hex');

/**
 * The file made safe, or refused outright. Bad money or a bill under two customers means the file is
 * wrong, so nothing loads; a number that cannot be a phone is only left out, and counted.
 */
export function cleanFile(file: ImportFile) {
  if (!file || !Array.isArray(file.customers) || !file.customers.length) throw new ImportRefused('The file has no customers.');
  const byPhone = new Map<string, Clean>();
  const seenBills = new Set<string>();
  let badPhones = 0, badPhoneBills = 0, noName = 0;
  for (const c of file.customers) {
    const n = normalisePhone(c.phone);
    if (!n.ok) { badPhones++; badPhoneBills += c.bills?.length ?? 0; continue; }
    if (byPhone.has(n.value)) throw new ImportRefused('The same number is in the file twice (written two ways). Fix the file so each number is one customer.');
    const name = String(c.name ?? '').replace(/\s+/g, ' ').trim();
    if (!name) noName++;
    const bills = (c.bills ?? []).map(b => {
      const billNo = String(b.billNo ?? '').trim();
      if (!billNo) throw new ImportRefused('A bill in the file has no number.');
      if (seenBills.has(billNo)) throw new ImportRefused(`Bill ${billNo} is in the file twice.`);
      seenBills.add(billNo);
      if (!Array.isArray(b.lines) || !b.lines.length) throw new ImportRefused(`Bill ${billNo} has no lines.`);
      for (const l of b.lines) {
        if (typeof l.kind !== 'string' || !l.kind.trim() || !Number.isFinite(l.quantity) || !Number.isFinite(l.amount)) throw new ImportRefused(`Bill ${billNo} has a line that cannot be read.`);
      }
      const net = Number(b.net);
      const sum = b.lines.reduce((t, l) => t + l.amount, 0);
      if (!Number.isFinite(net) || Math.abs(sum - net) > 0.01) throw new ImportRefused(`Bill ${billNo}: its lines do not add up to its total.`);
      let billedOn: Date | null = null;
      if (b.billedOn) {
        billedOn = new Date(b.billedOn);
        if (Number.isNaN(billedOn.getTime())) throw new ImportRefused(`Bill ${billNo} has a date that cannot be read.`);
      }
      return { billNo, billedOn, net, paidBy: b.paidBy ? String(b.paidBy) : null, lines: b.lines.map(l => ({ kind: l.kind, fabric: l.fabric ?? null, quantity: l.quantity, amount: l.amount })) };
    });
    byPhone.set(n.value, { phone: n.value, name: name || `Customer ${n.value.slice(-4)}`, bills });
  }
  return { customers: [...byPhone.values()], badPhones, badPhoneBills, noName };
}

async function holders(clientId: string, phones: string[]) {
  const out = new Map<string, string>();
  for (const part of chunks(phones, LOOKUP)) {
    const rows = await prisma.customer.findMany({ where: { clientId, phone: { in: part }, deletedAt: null }, select: { id: true, phone: true } });
    for (const r of rows) out.set(r.phone!, r.id);
  }
  return out;
}

/** What loading would do. Writes nothing, and says counts only: this is real people's data. */
export async function plan(clientId: string, source: string, file: ImportFile, fileHash: string) {
  const clean = cleanFile(file);
  const [users, liveCustomers, crm, marker, loaded] = await Promise.all([
    prisma.user.count({ where: { clientId } }),
    prisma.customer.count({ where: { clientId, deletedAt: null } }),
    prisma.moduleSubscription.findUnique({ where: { clientId_module: { clientId, module: 'crm' } }, select: { clientId: true } }),
    prisma.pastPurchaseImport.findUnique({ where: { clientId_source: { clientId, source } } }),
    prisma.pastPurchase.findMany({ where: { clientId, source }, select: { billNo: true } })
  ]);
  const have = await holders(clientId, clean.customers.map(c => c.phone));
  const done = new Set(loaded.map(b => b.billNo));
  const bills = clean.customers.flatMap(c => c.bills);
  return {
    clientId, source, users, liveCustomers, crmOn: !!crm,
    finishedAt: marker?.finishedAt ?? null,
    sameFile: marker ? marker.fileHash === fileHash : null,
    customersInFile: clean.customers.length,
    customersToCreate: clean.customers.filter(c => !have.has(c.phone)).length,
    customersAlreadyHere: clean.customers.filter(c => have.has(c.phone)).length,
    billsInFile: bills.length,
    billsToAdd: bills.filter(b => !done.has(b.billNo)).length,
    billsAlreadyHere: bills.filter(b => done.has(b.billNo)).length,
    numbersLeftOut: clean.badPhones,
    billsLeftOutWithThem: clean.badPhoneBills,
    customersWithNoName: clean.noName
  };
}

/** One chunk, all or nothing. Returns who was made and which bills went in. */
async function loadChunk(clientId: string, source: string, part: Clean[], now: Date) {
  return prisma.$transaction(async tx => {
    const phones = part.map(c => c.phone);
    const known = async () => new Map((await tx.customer.findMany({
      where: { clientId, phone: { in: phones }, deletedAt: null }, select: { id: true, phone: true }
    })).map(r => [r.phone!, r.id]));

    let ids = await known();
    let created = 0;
    // A till can save one of these numbers, or take a code, at this very moment: such a row is simply skipped
    // here (the database's own unique indexes), and the look-up below finds whoever holds the number.
    for (let attempt = 0; attempt < 3; attempt++) {
      const missing = part.filter(c => !ids.has(c.phone));
      if (!missing.length) break;
      const codes = await generateSequentialCodes(clientId, 'CUS', 'CUSTOMER', missing.length, tx);
      const taken = new Set((await tx.customer.findMany({ where: { clientId, customerCode: { in: codes } }, select: { customerCode: true } })).map(r => r.customerCode));
      const free = codes.filter(code => !taken.has(code));
      const made = await tx.customer.createMany({
        data: missing.slice(0, free.length).map((c, i) => ({
          clientId, customerCode: free[i], name: c.name, phone: c.phone, status: 'ACTIVE' as const,
          whatsappOffers: false, importSource: source, createdAt: now, updatedAt: now
        })),
        skipDuplicates: true
      });
      created += made.count;
      ids = await known();
    }
    const stillMissing = part.filter(c => !ids.has(c.phone)).length;
    if (stillMissing) throw new Error(`${stillMissing} customers could not be saved after three tries. Nothing in this part was kept. Run it again.`);

    const added = await tx.pastPurchase.createMany({
      data: part.flatMap(c => c.bills.map(b => ({
        id: randomUUID(), clientId, customerId: ids.get(c.phone)!, source,
        billNo: b.billNo, billedOn: b.billedOn, net: b.net, paidBy: b.paidBy, lines: b.lines as any
      }))),
      skipDuplicates: true
    });
    return { created, added: added.count };
  }, { maxWait: 30000, timeout: 180000 });
}

export async function applyImport(clientId: string, source: string, file: ImportFile, fileHash: string, onProgress?: (done: number, total: number) => void) {
  const clean = cleanFile(file);
  const marker = await prisma.pastPurchaseImport.findUnique({ where: { clientId_source: { clientId, source } } });
  if (marker && marker.fileHash !== fileHash) {
    throw new ImportRefused(`This load (${source}) was started from a different file. Use the same file, or undo it first.`);
  }
  if (marker?.finishedAt) return { already: true as const, finishedAt: marker.finishedAt, created: 0, matched: 0, added: 0 };
  // Two runs started together both land here; the chunks below cope with that, so this must not refuse the second.
  if (!marker) await prisma.pastPurchaseImport.createMany({ data: [{ clientId, source, fileHash }], skipDuplicates: true });

  const before = await holders(clientId, clean.customers.map(c => c.phone));
  const now = new Date();
  let created = 0, added = 0, done = 0;
  for (const part of chunks(clean.customers, CHUNK)) {
    const r = await loadChunk(clientId, source, part, now);
    created += r.created; added += r.added; done += part.length;
    onProgress?.(done, clean.customers.length);
  }
  const counts = await prisma.pastPurchaseImport.update({
    where: { clientId_source: { clientId, source } },
    data: {
      customersCreated: { increment: created }, billsAdded: { increment: added },
      // Matched is a fact about the first run: a resumed run also "matches" the ones it made itself.
      ...(marker ? {} : { customersMatched: before.size }), finishedAt: new Date()
    }
  });
  return { already: false as const, finishedAt: counts.finishedAt, created: counts.customersCreated, matched: counts.customersMatched, added: counts.billsAdded };
}

/**
 * Takes exactly one load back out. Its bills all go. A customer it made goes too, unless anything real has
 * happened to them since (an edit, a bill, points, a door scan, a look-up): those are the shop's customers now,
 * so they stay, as ordinary customers. Customers the load only matched are never touched.
 */
export async function undoImport(clientId: string, source: string) {
  const marker = await prisma.pastPurchaseImport.findUnique({ where: { clientId_source: { clientId, source } } });
  if (!marker) throw new ImportRefused(`There is no load called ${source} for this shop.`);

  const made = await prisma.customer.findMany({
    where: { clientId, importSource: source },
    select: {
      id: true, createdAt: true, updatedAt: true, deletedAt: true,
      _count: { select: { salesOrders: true, loyaltyEntries: true, storeCreditEntries: true, addresses: true } }
    }
  });
  const ids = made.map(c => c.id);
  const busy = new Set<string>();
  for (const part of chunks(ids, LOOKUP)) {
    const [checkins, lookups, offers, recipients, quotes, holds] = await Promise.all([
      prisma.storeCheckin.findMany({ where: { clientId, customerId: { in: part } }, select: { customerId: true } }),
      prisma.counterLookup.findMany({ where: { clientId, customerId: { in: part } }, select: { customerId: true } }),
      prisma.offerRedemption.findMany({ where: { customerId: { in: part } }, select: { customerId: true } }),
      prisma.campaignRecipient.findMany({ where: { customerId: { in: part } }, select: { customerId: true } }),
      prisma.pricingQuote.findMany({ where: { customerId: { in: part } }, select: { customerId: true } }),
      prisma.posHold.findMany({ where: { customerId: { in: part } }, select: { customerId: true } })
    ]);
    for (const r of [...checkins, ...lookups, ...offers, ...recipients, ...quotes, ...holds]) if (r.customerId) busy.add(r.customerId);
  }
  const untouched = made.filter(c => !c.deletedAt && c.updatedAt.getTime() === c.createdAt.getTime() && !busy.has(c.id)
    && !c._count.salesOrders && !c._count.loyaltyEntries && !c._count.storeCreditEntries && !c._count.addresses).map(c => c.id);
  const kept = ids.filter(id => !untouched.includes(id));

  let billsRemoved = 0;
  for (;;) {
    const page = await prisma.pastPurchase.findMany({ where: { clientId, source }, select: { id: true }, take: LOOKUP });
    if (!page.length) break;
    billsRemoved += (await prisma.pastPurchase.deleteMany({ where: { id: { in: page.map(p => p.id) } } })).count;
  }
  let customersRemoved = 0;
  for (const part of chunks(untouched, CHUNK)) customersRemoved += (await prisma.customer.deleteMany({ where: { clientId, id: { in: part } } })).count;
  for (const part of chunks(kept, CHUNK)) await prisma.customer.updateMany({ where: { clientId, id: { in: part } }, data: { importSource: null } });
  await prisma.pastPurchaseImport.delete({ where: { clientId_source: { clientId, source } } });
  return { billsRemoved, customersRemoved, customersKept: kept.length };
}
