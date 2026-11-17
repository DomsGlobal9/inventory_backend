/**
 * Import customers from a shop's own Excel or CSV file (17 Nov 2026, owner: "we can't import customers").
 *
 * One import for every shop, here in Inventory: Inventory holds the shop's one customer list (the till finds people
 * by number here) and CRM hears every new customer on the change feed, so a shop with CRM gets them there too, with
 * no second list to drift. CRM's own "Import customers" button opens this same screen.
 *
 * The browser reads the file and sends rows; nothing is added until the person has seen the check and agreed.
 *   check   what would happen: new / already in the list / cannot be added, row by row, with the reason
 *   apply   adds exactly the new ones (the check is run again here; if the list changed meanwhile, it refuses)
 *   list    the shop's imports from this screen
 *   take back   removes an import's customers who have not been used since (the same rule as the script's undo)
 *
 * Rules the owner chose:
 * - a number already in the list is left exactly as it is (never overwritten by an old sheet);
 * - nobody imported gets WhatsApp offers (a list is not a customer's yes);
 * - no points, credit or old bills from this screen (money and history go through the checked script load).
 */
import { randomUUID } from 'crypto';
import { prisma } from '../../lib/prisma';
import { normalisePhone } from '../../lib/phone';
import { generateSequentialCodes } from '../../utils/codeGenerator';
import { undoImport, undoPlan } from '../past-purchases/importer';

export const MAX_ROWS = 5000;
const CHUNK = 500;
const LOOKUP = 1000;

export class CustomerImportRefused extends Error {
  statusCode: number;
  constructor(message: string, statusCode = 400) { super(message); this.statusCode = statusCode; }
}

/** A row as the browser read it: the file's own text, by our field names. rowNumber is the sheet's row. */
export type ImportRow = {
  rowNumber: number;
  name?: unknown; phone?: unknown; email?: unknown; birthday?: unknown; anniversary?: unknown;
  address?: unknown; gstNumber?: unknown; companyName?: unknown; notes?: unknown;
};

type Ready = {
  rowNumber: number; name: string; phone: string; email: string | null; birthday: string | null; anniversary: string | null;
  billingAddress: string | null; gstNumber: string | null; companyName: string | null; notes: string | null;
};
export type RowNote = { row: number; kind: 'BAD' | 'SKIP'; say: string };

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const MONTH_NAMES = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const DAYS_IN = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
const GSTIN = /^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
const EMAIL = /^[^\s@<>()[\],;:"]+@[^\s@<>()[\],;:"]+\.[^\s@<>()[\],;:"]{2,}$/;

const text = (v: unknown): string => (v === null || v === undefined ? '' : String(v)).replace(/\s+/g, ' ').trim();

/**
 * A birthday or anniversary as India writes it, kept as "MM-DD" like the rest of the app (the year is not kept).
 * Day first always ("14-08" is 14 August): 14-08, 14/08, 14.08, 14-08-1990, 14 Aug, 14 August 1990, and the
 * unambiguous 1990-08-14 an Excel date cell becomes. Returns the reason when it is not a date.
 */
export function dayOfYear(raw: unknown, what: string): { ok: true; value: string | null } | { ok: false; say: string } {
  const t = text(raw);
  if (!t) return { ok: true, value: null };
  let day: number | null = null, month: number | null = null;
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(t);
  if (m) { month = Number(m[2]); day = Number(m[3]); }
  else if ((m = /^(\d{1,2})[-/.](\d{1,2})(?:[-/.](\d{2}|\d{4}))?$/.exec(t))) { day = Number(m[1]); month = Number(m[2]); }
  else if ((m = /^(\d{1,2})(?:st|nd|rd|th)?[\s-]+([a-z]+)\.?(?:[\s,-]+(\d{4}))?$/i.exec(t))) {
    day = Number(m[1]);
    // "Aug", "August", "aug." -- three letters at least, and they must start a real month's name.
    const word = m[2].toLowerCase();
    const i = MONTHS.indexOf(word.slice(0, 3));
    month = i >= 0 && word.length >= 3 && MONTH_NAMES[i].startsWith(word) ? i + 1 : null;
  }
  if (!day || !month) return { ok: false, say: `${what} "${t}" is not a date. Write it day first, for example 14-08 or 14-08-1990.` };
  if (month < 1 || month > 12 || day < 1 || day > DAYS_IN[month - 1]) return { ok: false, say: `${what} ${t} is not a real day.` };
  return { ok: true, value: `${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}` };
}

/** One row checked on its own: the customer to add, or why it cannot be. */
function readRow(r: ImportRow): { ok: true; c: Ready } | { ok: false; say: string } {
  const name = text(r.name);
  const rawPhone = text(r.phone);
  if (!name && !rawPhone) return { ok: false, say: 'No name and no phone number.' };
  if (!name) return { ok: false, say: 'No name.' };
  if (name.length > 120) return { ok: false, say: 'The name is longer than 120 letters.' };
  // A cell starting with these is read as a formula when the list is opened in Excel again.
  if (/^[=+@]/.test(name)) return { ok: false, say: `The name "${name.slice(0, 30)}" starts with ${name[0]}, which Excel reads as a formula.` };
  if (!rawPhone) return { ok: false, say: 'No phone number.' };
  // Excel shortens a long number to "9.84802E+09" when the column is not text: the real digits are gone.
  if (/^\d+(\.\d+)?e\+?\d+$/i.test(rawPhone.replace(/\s/g, ''))) {
    return { ok: false, say: `Excel shortened this number to ${rawPhone}, so its last digits are lost. Set the Phone column to Text in Excel, type the numbers again, and choose the file again.` };
  }
  const phone = normalisePhone(rawPhone.replace(/^'/, ''));
  if (!phone.ok) {
    // "Has 9 digits" only when it is all digits: "98480 abcde" is about the letters, not about five digits.
    const digits = rawPhone.replace(/\D/g, '');
    const onlyDigits = /^[\d\s\-.()]+$/.test(rawPhone);
    const say = onlyDigits && digits.length && digits.length < 10 ? `Phone ${rawPhone} has ${digits.length} digits.` : `Phone ${rawPhone}: ${phone.reason}`;
    return { ok: false, say };
  }
  const email = text(r.email);
  if (email && (!EMAIL.test(email) || email.length > 200)) return { ok: false, say: `Email ${email.slice(0, 60)} is not an email address.` };
  const birthday = dayOfYear(r.birthday, 'Birthday');
  if (!birthday.ok) return { ok: false, say: birthday.say };
  const anniversary = dayOfYear(r.anniversary, 'Anniversary');
  if (!anniversary.ok) return { ok: false, say: anniversary.say };
  const address = text(r.address);
  if (address.length > 500) return { ok: false, say: 'The address is longer than 500 letters.' };
  const gst = text(r.gstNumber).replace(/\s/g, '').toUpperCase();
  if (gst && !GSTIN.test(gst)) return { ok: false, say: `GST number ${gst.slice(0, 20)} is not a GST number (15 letters and digits, like 36ABCDE1234F1Z5).` };
  const company = text(r.companyName);
  if (company.length > 120) return { ok: false, say: 'The company name is longer than 120 letters.' };
  // Notes keep their line breaks.
  const notes = (r.notes === null || r.notes === undefined ? '' : String(r.notes)).trim();
  if (notes.length > 1000) return { ok: false, say: 'The notes are longer than 1,000 letters.' };
  return {
    ok: true,
    c: {
      rowNumber: r.rowNumber, name, phone: phone.value, email: email || null, birthday: birthday.value, anniversary: anniversary.value,
      billingAddress: address || null, gstNumber: gst || null, companyName: company || null, notes: notes || null
    }
  };
}

const chunks = <T>(xs: T[], n: number) => Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, i * n + n));

function sane(rows: unknown): ImportRow[] {
  if (!Array.isArray(rows)) throw new CustomerImportRefused('Send the rows of the file.');
  if (!rows.length) throw new CustomerImportRefused('The file has no customers in it.');
  if (rows.length > MAX_ROWS) throw new CustomerImportRefused(`The file has ${rows.length.toLocaleString('en-IN')} rows. Up to ${MAX_ROWS.toLocaleString('en-IN')} can be imported at a time: split it into smaller files.`);
  return rows.map((r: any, i) => ({ ...(r && typeof r === 'object' ? r : {}), rowNumber: Number.isInteger(r?.rowNumber) ? r.rowNumber : i + 2 }));
}

/** What importing these rows would do. Writes nothing. */
export async function check(clientId: string, rawRows: unknown) {
  const rows = sane(rawRows);
  const notes: RowNote[] = [];
  const firstRowOf = new Map<string, number>();
  const candidates: Ready[] = [];
  for (const r of rows) {
    const read = readRow(r);
    if (!read.ok) { notes.push({ row: r.rowNumber, kind: 'BAD', say: read.say }); continue; }
    const seen = firstRowOf.get(read.c.phone);
    if (seen !== undefined) { notes.push({ row: r.rowNumber, kind: 'SKIP', say: `Same number as row ${seen}: only row ${seen} is added.` }); continue; }
    firstRowOf.set(read.c.phone, r.rowNumber);
    candidates.push(read.c);
  }
  const holders = new Map<string, string>();
  for (const part of chunks(candidates.map(c => c.phone), LOOKUP)) {
    const found = await prisma.customer.findMany({ where: { clientId, deletedAt: null, phone: { in: part } }, select: { phone: true, name: true } });
    for (const f of found) if (f.phone) holders.set(f.phone, f.name);
  }
  const toAdd: Ready[] = [];
  for (const c of candidates) {
    const who = holders.get(c.phone);
    if (who !== undefined) notes.push({ row: c.rowNumber, kind: 'SKIP', say: `${shown(c.phone)} is already ${who}: left as it is.` });
    else toAdd.push(c);
  }
  notes.sort((a, b) => a.row - b.row);
  return {
    rows: rows.length,
    toAdd,
    counts: {
      add: toAdd.length,
      existing: notes.filter(n => n.kind === 'SKIP' && /already/.test(n.say)).length,
      repeated: notes.filter(n => n.kind === 'SKIP' && /Same number/.test(n.say)).length,
      bad: notes.filter(n => n.kind === 'BAD').length
    },
    notes
  };
}

const shown = (stored: string) => { const m = /^\+91(\d{5})(\d{5})$/.exec(stored); return m ? `${m[1]} ${m[2]}` : stored; };

/** The check, as the screen shows it: counts and the rows that will not be added (never the people themselves). */
export async function checkForScreen(clientId: string, rows: unknown) {
  const r = await check(clientId, rows);
  return { rows: r.rows, counts: r.counts, notes: r.notes.slice(0, 500), moreNotes: Math.max(0, r.notes.length - 500) };
}

/**
 * Adds the new customers. `expected` is how many the person saw would be added: when the list has changed since
 * (a till saved one of these numbers meanwhile, say), it refuses and asks for the check again rather than add a
 * number the person did not agree to.
 */
export async function apply(clientId: string, by: { id: string; name: string }, fileName: unknown, rawRows: unknown, expected: unknown) {
  const r = await check(clientId, rawRows);
  if (!r.toAdd.length) throw new CustomerImportRefused('There is nobody new to add in this file.');
  if (Number(expected) !== r.toAdd.length) {
    throw new CustomerImportRefused(`Your customer list changed since the check (${r.toAdd.length} are new now, not ${expected}). Check the file again.`, 409);
  }
  const name = text(fileName).replace(/[\\/:*?"<>|]/g, '').slice(0, 120) || 'customers';
  const source = `upload:${randomUUID()}`;
  await prisma.pastPurchaseImport.create({
    data: { clientId, source, fileHash: source, kind: 'UPLOAD', fileName: name, madeBy: by.id, madeByName: by.name.slice(0, 120) }
  });
  const now = new Date();
  let created = 0;
  try {
    for (const part of chunks(r.toAdd, CHUNK)) created += await addChunk(clientId, source, part, now);
  } finally {
    await prisma.pastPurchaseImport.update({ where: { clientId_source: { clientId, source } }, data: { customersCreated: created, customersMatched: r.counts.existing, finishedAt: new Date() } });
  }
  return { source, fileName: name, created, existing: r.counts.existing, repeated: r.counts.repeated, bad: r.counts.bad };
}

/** One chunk, all or nothing. A number a till saves at this very moment is skipped by the database's own unique index. */
async function addChunk(clientId: string, source: string, part: Ready[], now: Date) {
  return prisma.$transaction(async tx => {
    let made = 0;
    let missing = part;
    for (let attempt = 0; attempt < 3 && missing.length; attempt++) {
      const codes = await generateSequentialCodes(clientId, 'CUS', 'CUSTOMER', missing.length, tx);
      const taken = new Set((await tx.customer.findMany({ where: { clientId, customerCode: { in: codes } }, select: { customerCode: true } })).map(x => x.customerCode));
      const free = codes.filter(c => !taken.has(c));
      const res = await tx.customer.createMany({
        data: missing.slice(0, free.length).map((c, i) => ({
          clientId, customerCode: free[i], name: c.name, phone: c.phone, email: c.email, birthday: c.birthday, anniversary: c.anniversary,
          billingAddress: c.billingAddress, gstNumber: c.gstNumber, companyName: c.companyName, notes: c.notes,
          status: 'ACTIVE' as const, whatsappOffers: false, importSource: source, createdAt: now, updatedAt: now
        })),
        skipDuplicates: true
      });
      made += res.count;
      const have = new Set((await tx.customer.findMany({ where: { clientId, deletedAt: null, phone: { in: missing.map(c => c.phone) } }, select: { phone: true } })).map(x => x.phone));
      missing = missing.filter(c => !have.has(c.phone));
    }
    if (missing.length) throw new Error(`${missing.length} customers could not be saved. Nothing in this part was kept. Try again.`);
    return made;
  }, { maxWait: 30000, timeout: 120000 });
}

/** The shop's imports from this screen, newest first, with how many of each are still in the list. */
export async function list(clientId: string) {
  const loads = await prisma.pastPurchaseImport.findMany({ where: { clientId, kind: 'UPLOAD' }, orderBy: { startedAt: 'desc' }, take: 50 });
  const still = loads.length
    ? await prisma.customer.groupBy({ by: ['importSource'], where: { clientId, deletedAt: null, importSource: { in: loads.map(l => l.source) } }, _count: { _all: true } })
    : [];
  const left = new Map(still.map(s => [s.importSource, s._count._all]));
  return loads.map(l => ({
    source: l.source, fileName: l.fileName, by: l.madeByName, at: l.startedAt, finished: !!l.finishedAt,
    added: l.customersCreated, stillHere: left.get(l.source) ?? 0
  }));
}

function ownUpload(source: unknown) {
  const s = String(source || '');
  if (!/^upload:[0-9a-f-]{36}$/.test(s)) throw new CustomerImportRefused('That import is not here.', 404);
  return s;
}

/** What taking an import back out would do: who goes, who stays because the shop has used them since. */
export async function takeBackPreview(clientId: string, source: unknown) {
  const s = ownUpload(source);
  const load = await prisma.pastPurchaseImport.findFirst({ where: { clientId, source: s, kind: 'UPLOAD' } });
  if (!load) throw new CustomerImportRefused('That import is not here. It may have been taken back already.', 404);
  const p = await undoPlan(clientId, s);
  return { fileName: load.fileName, willGo: p.untouched.length, willStay: p.kept.length };
}

export async function takeBack(clientId: string, source: unknown) {
  const s = ownUpload(source);
  const load = await prisma.pastPurchaseImport.findFirst({ where: { clientId, source: s, kind: 'UPLOAD' } });
  if (!load) throw new CustomerImportRefused('That import is not here. It may have been taken back already.', 404);
  const r = await undoImport(clientId, s);
  return { removed: r.customersRemoved, kept: r.customersKept };
}
