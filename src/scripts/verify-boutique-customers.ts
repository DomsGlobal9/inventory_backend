/**
 * The boutique app's (CRM-B) customers in ScaleEzy (17 Nov 2026, services/boutique/customers.ts), end to end against
 * the REAL local server with signed boutique passes:
 *   linking (new, by phone, by the boutique id with no phone, names written differently, a family phone, a new phone
 *   moving them, retries and races, bad details), the bulk first load, nothing boutique kept (no measurements, no
 *   link: they are CRM-B's alone), CRM's change feed, and removal (the boutique unlinks; Inventory erases or
 *   deletes the customer -> every boutique person on them wiped, listed for the boutique to wipe its copy), another
 *   shop never seeing any of it, and who may do what.
 *
 * Throwaway shops only (boutique-btqtest-*), removed at the end. Local database and server only.
 *   DATABASE_URL=<local> DIRECT_URL=<local> VERIFY_API_URL=http://localhost:4036/api/v1 \
 *   BOUTIQUE_KEY_DIR=<dir with private.pem> npx tsx src/scripts/verify-boutique-customers.ts
 */
import fs from 'node:fs';
import axios from 'axios';
import jwt from 'jsonwebtoken';
import { prisma } from '../lib/prisma';
import { enableForClient, disableForClient } from '../services/boutique';
import * as customerImport from '../services/customer-import';

const BASE = process.env.VERIFY_API_URL || 'http://localhost:4036/api/v1';
for (const k of ['DATABASE_URL', 'DIRECT_URL']) {
  if (!/localhost:55433/.test(process.env[k] ?? '')) { console.error(`Refusing: ${k} is not the local database.`); process.exit(2); }
}
if (!/localhost|127\.0\.0\.1/.test(BASE)) { console.error('Refusing: VERIFY_API_URL is not a local server.'); process.exit(2); }
const privateKey = fs.readFileSync(`${process.env.BOUTIQUE_KEY_DIR}/private.pem`, 'utf8');

const STAMP = Date.now().toString(36);
const T1 = `btqtest-c1-${STAMP}`;
const T2 = `btqtest-c2-${STAMP}`;
const T3 = `btqtest-c3-${STAMP}`, T4 = `btqtest-c4-${STAMP}`, T5 = `btqtest-c5-${STAMP}`;   // boutique-only shops that join a retail shop
const R = `btqretail-c-${STAMP}`, R2 = `btqretail-c2-${STAMP}`;                                        // the retail shops
let bad = 0, good = 0;
const check = (name: string, ok: boolean, detail: unknown = '') => { ok ? good++ : bad++; console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : ` :: ${typeof detail === 'string' ? detail : JSON.stringify(detail)?.slice(0, 400)}`}`); };
const ALL = ['products:write', 'stock:write', 'customers:write'];

type PassOpts = { tenant?: string; can?: string[] };
const pass = (o: PassOpts = {}) => jwt.sign({
  sub: 'crm-b', scope: ['modules:boutique'], tenant: o.tenant ?? T1,
  onBehalfOf: { userId: 'staff-7', name: 'Meena (front desk)', can: o.can ?? ALL }
}, privateKey, { algorithm: 'RS256', audience: 'inventory', issuer: 'scaleezy-boutique-test', keyid: 'btq-1', expiresIn: '5m' });
let reqN = 0;
const rid = () => `c-${STAMP}-${++reqN}`;
async function call(method: string, path: string, body?: unknown, o: PassOpts & { requestId?: string } = {}) {
  const headers: Record<string, string> = { Authorization: `Bearer ${pass(o)}` };
  if (method !== 'GET') headers['Idempotency-Key'] = o.requestId ?? rid();
  const r = await axios.request({ method, url: `${BASE}/internal/boutique${path}`, headers, data: body, validateStatus: () => true, timeout: 120_000 });
  return { status: r.status, data: r.data?.data, message: r.data?.message as string | undefined, replay: r.headers['idempotent-replay'] };
}

// Numbers nobody local has.
const taken = new Set<string>();
const fresh = async () => {
  for (;;) {
    const n = `8${String(Math.floor(Math.random() * 1e9)).padStart(9, '0')}`;
    if (taken.has(n) || /^(\d)\1+$/.test(n)) continue;
    if (await prisma.customer.findFirst({ where: { phone: `+91${n}` }, select: { id: true } })) continue;
    taken.add(n); return n;
  }
};
const profileOf = (clientId: string, bid: string) => prisma.customerBoutiqueProfile.findUnique({ where: { clientId_boutiqueCustomerId: { clientId, boutiqueCustomerId: bid } } });

let C1 = '', C2 = '';
const EXTRA: string[] = [];
async function main() {
  console.log('SETUP: two boutique-only shops, the first on CRM');
  const l1 = await call('POST', '/link', { shopName: 'Customer Test Boutique' });
  C1 = l1.data?.clientId; check('shop 1 linked', !!C1, l1);
  const l2 = await call('POST', '/link', { shopName: 'Other Boutique' }, { tenant: T2 });
  C2 = l2.data?.clientId; check('shop 2 linked', !!C2, l2);
  if (!C1 || !C2) throw new Error('no shops');
  await prisma.moduleSubscription.create({ data: { clientId: C1, module: 'crm', enabledBy: 'verify' } });

  console.log('\nWHO MAY');
  const noWrite = await call('POST', '/customers', { boutiqueCustomerId: 'b-x', name: 'X', phone: await fresh() }, { can: ['products:write'] });
  check('a person without customers:write cannot add customers (403), and nothing is made', noWrite.status === 403 && !(await prisma.customer.count({ where: { clientId: C1 } })), noWrite);

  console.log('\nLINKING ONE PERSON');
  const nL = await fresh();
  const lak = await call('POST', '/customers', { boutiqueCustomerId: 'b-lak', name: 'Lakshmi K.', phone: `+91 ${nL}`, email: 'lak@example.com', birthday: '14-08-1990', anniversary: '2 Dec', address: '12 MG Road, Hyderabad' }, { requestId: `lak-${STAMP}` });
  check('a new person: 201 NEW, an Inventory customer made', lak.status === 201 && lak.data?.matched === 'NEW' && lak.data?.nameMatches === true, lak);
  const lc = await prisma.customer.findUnique({ where: { id: lak.data.inventoryCustomerId } });
  check('...with their name, number, email, birthday 08-14, anniversary 12-02 and address', lc?.name === 'Lakshmi K.' && lc?.phone === `+91${nL}` && lc?.email === 'lak@example.com' && lc?.birthday === '08-14' && lc?.anniversary === '12-02' && lc?.billingAddress === '12 MG Road, Hyderabad', lc);
  check('...and never offered WhatsApp', lc?.whatsappOffers === false);
  const again = await call('POST', '/customers', { boutiqueCustomerId: 'b-lak', name: 'Lakshmi K.', phone: `+91 ${nL}`, email: 'lak@example.com', birthday: '14-08-1990', anniversary: '2 Dec', address: '12 MG Road, Hyderabad' }, { requestId: `lak-${STAMP}` });
  check('the same request id again is a replay: same answer, no second customer', again.replay === 'true' && again.data?.inventoryCustomerId === lak.data.inventoryCustomerId && (await prisma.customer.count({ where: { clientId: C1 } })) === 1, again);
  const resend = await call('POST', '/customers', { boutiqueCustomerId: 'b-lak', name: 'LAKSHMI k', phone: nL });
  check('sent again (new request): the same customer (already linked), name still matches (case, spaces, dots)', resend.status === 200 && resend.data?.matched === 'BY_BOUTIQUE_ID' && resend.data?.inventoryCustomerId === lak.data.inventoryCustomerId && resend.data?.nameMatches === true && !resend.data?.moved, resend);
  check('...and the name in Inventory is not changed', (await prisma.customer.findUnique({ where: { id: lak.data.inventoryCustomerId } }))?.name === 'Lakshmi K.');

  console.log('\nA CUSTOMER THE SHOP ALREADY HAS');
  const nS = await fresh();
  const shopOwn = await prisma.customer.create({ data: { clientId: C1, customerCode: `CUS-T${STAMP}`.slice(0, 20), name: 'Sujatha Rao', phone: `+91${nS}`, email: 'own@shop.in' } });
  const suj = await call('POST', '/customers', { boutiqueCustomerId: 'b-suj', name: 'sujatha  rao', phone: nS, email: 'boutique@x.in', birthday: '01-01' });
  check('matched by number to the shop\'s own customer, name agrees', suj.status === 200 && suj.data?.matched === 'BY_PHONE' && suj.data?.inventoryCustomerId === shopOwn.id && suj.data?.nameMatches === true, suj);
  const sujRow = await prisma.customer.findUnique({ where: { id: shopOwn.id } });
  check('her email is NOT overwritten; her empty birthday IS filled', sujRow?.email === 'own@shop.in' && sujRow?.birthday === '01-01' && sujRow?.name === 'Sujatha Rao', sujRow);

  console.log('\nA FAMILY PHONE');
  const pri = await call('POST', '/customers', { boutiqueCustomerId: 'b-pri', name: 'Priya K', phone: nL, email: 'priya@x.in', birthday: '05-05' });
  check('Priya on Lakshmi\'s number: the same Inventory customer, nameMatches false', pri.status === 200 && pri.data?.inventoryCustomerId === lak.data.inventoryCustomerId && pri.data?.nameMatches === false, pri);
  const after = await prisma.customer.findUnique({ where: { id: lak.data.inventoryCustomerId } });
  check('...and nothing of Priya\'s lands on Lakshmi\'s record (name, email, birthday unchanged)', after?.name === 'Lakshmi K.' && after?.email === 'lak@example.com' && after?.birthday === '08-14', after);
  check('...two separate boutique rows on one customer', (await prisma.customerBoutiqueProfile.count({ where: { clientId: C1, customerId: lak.data.inventoryCustomerId } })) === 2);

  console.log('\nNO PHONE, AND A NEW PHONE');
  const noP = await call('POST', '/customers', { boutiqueCustomerId: 'b-nop', name: 'Grandma Kamala' });
  const npc = await prisma.customer.findUnique({ where: { id: noP.data?.inventoryCustomerId ?? '' } });
  check('no phone: a new customer keyed boutique:<id>, no number', noP.status === 201 && npc?.externalCustomerId === 'boutique:b-nop' && !npc?.phone, [noP, npc]);
  const noP2 = await call('POST', '/customers', { boutiqueCustomerId: 'b-nop', name: 'Grandma Kamala' });
  check('sent again with no phone: the same customer (by the boutique id), not a second one', noP2.data?.inventoryCustomerId === noP.data.inventoryCustomerId && noP2.data?.matched === 'BY_BOUTIQUE_ID', noP2);
  const nP = await fresh();
  const moved = await call('POST', '/customers', { boutiqueCustomerId: 'b-pri', name: 'Priya K', phone: nP });
  check('Priya gets her own number: she moves to a new customer of her own (moved: true)', moved.status === 201 && moved.data?.moved === true && moved.data?.inventoryCustomerId !== lak.data.inventoryCustomerId && moved.data?.nameMatches === true, moved);
  check('...her row now points at the new customer', (await profileOf(C1, 'b-pri'))?.customerId === moved.data.inventoryCustomerId);
  check('...and Lakshmi\'s customer is untouched', (await prisma.customer.findUnique({ where: { id: lak.data.inventoryCustomerId } }))?.name === 'Lakshmi K.');
  const keepNoPhone = await call('POST', '/customers', { boutiqueCustomerId: 'b-pri', name: 'Priya K' });
  check('sent later with no phone: she stays where she is', keepNoPhone.data?.inventoryCustomerId === moved.data.inventoryCustomerId && !keepNoPhone.data?.moved, keepNoPhone);

  console.log('\nSENT WITH NO NUMBER FIRST, AND THE NUMBER COMES LATER');
  const np1 = await call('POST', '/customers', { boutiqueCustomerId: 'b-np1', name: 'No Phone One' });
  const p1 = await fresh();
  const np1b = await call('POST', '/customers', { boutiqueCustomerId: 'b-np1', name: 'No Phone One', phone: p1 });
  const np1c = await prisma.customer.findUnique({ where: { id: np1.data.inventoryCustomerId } });
  check('nobody has the number: it becomes THEIR customer\'s number (same customer, not moved)', np1b.status === 200 && np1b.data?.inventoryCustomerId === np1.data.inventoryCustomerId && np1b.data?.moved === false && np1b.data?.matched === 'BY_BOUTIQUE_ID' && np1c?.phone === `+91${p1}`, [np1b, np1c?.phone]);
  check('...and she is in the shop\'s list once, not twice', (await prisma.customer.count({ where: { clientId: C1, name: 'No Phone One', deletedAt: null } })) === 1);
  const np2 = await call('POST', '/customers', { boutiqueCustomerId: 'b-np2', name: 'No Phone Two' });
  const p2 = await fresh();
  const shopTwo = await prisma.customer.create({ data: { clientId: C1, customerCode: `CUS-N${STAMP}`.slice(0, 20), name: 'No Phone Two', phone: `+91${p2}` } });
  const np2b = await call('POST', '/customers', { boutiqueCustomerId: 'b-np2', name: 'No Phone Two', phone: p2 });
  check('the shop already has that number: she moves onto the shop\'s customer (moved: true)', np2b.status === 200 && np2b.data?.inventoryCustomerId === shopTwo.id && np2b.data?.moved === true && np2b.data?.nameMatches === true, np2b);
  check('...and the empty no-number copy ScaleEzy had made for her is gone (once in the list)', !(await prisma.customer.count({ where: { id: np2.data.inventoryCustomerId } })) && (await prisma.customer.count({ where: { clientId: C1, name: 'No Phone Two', deletedAt: null } })) === 1);
  check('...without her being marked removed, or listed for the boutique to wipe', (await profileOf(C1, 'b-np2'))?.removed === false && !(await call('GET', '/customers/removed')).data?.removed?.some((r: any) => r.boutiqueCustomerId === 'b-np2'));
  const np3 = await call('POST', '/customers', { boutiqueCustomerId: 'b-np3', name: 'No Phone Three' });
  await prisma.customerAddress.create({ data: { clientId: C1, customerId: np3.data.inventoryCustomerId, name: 'No Phone Three', phone: '+919000000001', line: '1 Test Road', pincode: '500001' } as any });
  const p3 = await fresh();
  const shopThree = await prisma.customer.create({ data: { clientId: C1, customerCode: `CUS-M${STAMP}`.slice(0, 20), name: 'Someone Else', phone: `+91${p3}` } });
  const np3b = await call('POST', '/customers', { boutiqueCustomerId: 'b-np3', name: 'No Phone Three', phone: p3 });
  check('a no-number copy the shop has USED (an address on it) is kept when she moves', np3b.data?.inventoryCustomerId === shopThree.id && np3b.data?.moved === true && (await prisma.customer.count({ where: { id: np3.data.inventoryCustomerId, deletedAt: null } })) === 1, np3b);

  console.log('\nDETAILS THAT CANNOT BE TAKEN');
  const before = await prisma.customer.count({ where: { clientId: C1 } });
  const refusals: [string, unknown, RegExp][] = [
    ['no boutiqueCustomerId', { name: 'A', phone: await fresh() }, /boutiqueCustomerId/],
    ['an id with spaces', { boutiqueCustomerId: 'b 1', name: 'A' }, /boutiqueCustomerId/],
    ['the id "removed" (an address of the API)', { boutiqueCustomerId: 'removed', name: 'A' }, /removed.*bulk/],
    ['the id "Bulk"', { boutiqueCustomerId: 'Bulk', name: 'A' }, /removed.*bulk/],
    ['no name', { boutiqueCustomerId: 'b-n1', phone: await fresh() }, /name/],
    ['a 9-digit phone', { boutiqueCustomerId: 'b-n2', name: 'A', phone: '98480 2233' }, /Phone/],
    ['letters in the phone', { boutiqueCustomerId: 'b-n3', name: 'A', phone: 'abc' }, /Phone/],
    ['a bad email', { boutiqueCustomerId: 'b-n4', name: 'A', email: 'a@b' }, /email/i],
    ['30 February', { boutiqueCustomerId: 'b-n5', name: 'A', birthday: '30-02' }, /not a real day/],
    ['a 121-letter name', { boutiqueCustomerId: 'b-n6', name: 'x'.repeat(121) }, /120/],
  ];
  for (const [what, body, re] of refusals) {
    const r = await call('POST', '/customers', body);
    check(`${what}: refused in words`, r.status === 400 && re.test(r.message ?? ''), r);
  }
  check('...and none of that made anyone', (await prisma.customer.count({ where: { clientId: C1 } })) === before);
  check('an empty body is refused, not a crash', (await call('POST', '/customers', undefined)).status === 400);

  console.log('\nTWO AT ONCE');
  const nR = await fresh();
  const [ra, rb] = await Promise.all([
    call('POST', '/customers', { boutiqueCustomerId: 'b-race1', name: 'Race One', phone: nR }),
    call('POST', '/customers', { boutiqueCustomerId: 'b-race2', name: 'Race Two', phone: nR }),
  ]);
  check('two people sent at the same moment on one new number: ONE customer for the number', (await prisma.customer.count({ where: { clientId: C1, phone: `+91${nR}`, deletedAt: null } })) === 1 && ra.data?.inventoryCustomerId === rb.data?.inventoryCustomerId, [ra, rb]);
  const [s1, s2] = await Promise.all([
    call('POST', '/customers', { boutiqueCustomerId: 'b-same', name: 'Same Person', phone: await fresh() }),
    call('POST', '/customers', { boutiqueCustomerId: 'b-same', name: 'Same Person' }),
  ]);
  check('the same boutique person sent twice at once: one row, never a crash', [s1.status, s2.status].every(s => s === 200 || s === 201) && (await prisma.customerBoutiqueProfile.count({ where: { clientId: C1, boutiqueCustomerId: 'b-same' } })) === 1, [s1, s2]);

  console.log('\nTHE FIRST LOAD (BULK)');
  const people = await Promise.all(Array.from({ length: 5 }, async (_, i) => ({ boutiqueCustomerId: `b-bulk-${i}`, name: `Bulk ${i}`, phone: await fresh() })));
  const bulk = await call('POST', '/customers/bulk', { customers: [...people, { boutiqueCustomerId: 'b-bulk-bad', name: '' }, { ...people[0] }] });
  check('7 sent: 5 linked, 2 refused (no name; the same id twice), each named', bulk.status === 200 && bulk.data?.linked === 5 && bulk.data?.refused === 2
    && bulk.data.results.find((r: any) => r.index === 5)?.error?.includes('name') && bulk.data.results.find((r: any) => r.index === 6)?.error?.includes('twice'), bulk.data);
  check('more than 200 at once is refused', (await call('POST', '/customers/bulk', { customers: Array.from({ length: 201 }, (_, i) => ({ boutiqueCustomerId: `b-x${i}`, name: 'x' })) })).status === 400);
  check('an empty list is refused', (await call('POST', '/customers/bulk', { customers: [] })).status === 400);
  const big = await Promise.all(Array.from({ length: 200 }, async (_, i) => ({ boutiqueCustomerId: `b-200-${i}`, name: `Two Hundred ${i}`, phone: await fresh() })));
  const t0 = Date.now();
  const b200 = await call('POST', '/customers/bulk', { customers: big });
  check(`200 at once, all linked (${((Date.now() - t0) / 1000).toFixed(1)} s)`, b200.status === 200 && b200.data?.linked === 200, b200.message ?? b200.data?.refused);

  console.log('\nNOTHING BOUTIQUE IS KEPT (the owner, 17 Nov: measurements and stitching are CRM-B\'s alone)');
  const oldRoute = await call('PUT', '/customers/b-lak/profile', { snapshot: { measurementSets: [{ id: 'm' }] } });
  check('there is no measurements route (refused)', oldRoute.status >= 400, oldRoute.status);
  const extra = await call('POST', '/customers', { boutiqueCustomerId: 'b-lak', name: 'Lakshmi K.', phone: nL, measurements: { bust: 34 }, editUrl: 'https://x.example.com/1' });
  const lakRow = await prisma.customerBoutiqueProfile.findUnique({ where: { clientId_boutiqueCustomerId: { clientId: C1, boutiqueCustomerId: 'b-lak' } } });
  check('extra boutique fields sent with a customer (measurements, a link) are simply not kept', extra.status === 200 && !JSON.stringify(lakRow).includes('bust') && !JSON.stringify(lakRow).includes('x.example.com'), lakRow);
  check('GET one says only who is who', Object.keys((await call('GET', '/customers/b-lak')).data ?? {}).sort().join() === 'boutiqueCustomerId,inventoryCustomerId,nameMatches,removed,removedReason');

  console.log('\nTHE CHANGE FEED: ORDINARY CUSTOMERS ONLY');
  check('the matching rows are Inventory\'s own business: nothing about them goes to CRM', !(await prisma.moduleEvent.count({ where: { clientId: C1, sourceTable: 'customer_boutique_profiles' } })));
  const custEvents = await prisma.moduleEvent.findMany({ where: { clientId: C1, module: 'crm', sourceTable: 'customers' } });
  check('CRM hears a boutique person the ordinary way: customer.created for the new customer', custEvents.some(e => e.kind === 'customer.created' && e.rowId === lak.data.inventoryCustomerId), custEvents.length);
  check('...and nothing in those events says "boutique" except the no-phone key', !custEvents.some(e => /boutique_name|name_matches|sent_phone/.test(JSON.stringify(e.payload))));
  check('shop 2 (not on CRM) sends nothing to the feed', !(await prisma.moduleEvent.count({ where: { clientId: C2 } })));

  console.log('\nTHE SHOP CORRECTS A NUMBER IN SCALEEZY');
  const nA = await fresh(), nB = await fresh(), nC = await fresh();
  const fix = await call('POST', '/customers', { boutiqueCustomerId: 'b-fix', name: 'Fix Me', phone: nA });
  await prisma.customer.update({ where: { id: fix.data.inventoryCustomerId }, data: { phone: `+91${nB}` } });
  const same1 = await call('POST', '/customers', { boutiqueCustomerId: 'b-fix', name: 'Fix Me', phone: nA });
  check('the boutique sends the same person with its old number: they stay on their customer (no second one)', same1.status === 200 && same1.data?.inventoryCustomerId === fix.data.inventoryCustomerId && !same1.data?.moved
    && !(await prisma.customer.count({ where: { clientId: C1, phone: `+91${nA}` } })), same1);
  check('...and the number the shop corrected is not changed back', (await prisma.customer.findUnique({ where: { id: fix.data.inventoryCustomerId } }))?.phone === `+91${nB}`);
  const stranger = await prisma.customer.create({ data: { clientId: C1, customerCode: `CUS-S${STAMP}`.slice(0, 20), name: 'New Holder', phone: `+91${nA}` } });
  const same2 = await call('POST', '/customers', { boutiqueCustomerId: 'b-fix', name: 'Fix Me', phone: nA });
  check('...even when somebody else now holds that old number', same2.data?.inventoryCustomerId === fix.data.inventoryCustomerId && same2.data?.inventoryCustomerId !== stranger.id, same2);
  const really = await call('POST', '/customers', { boutiqueCustomerId: 'b-fix', name: 'Fix Me', phone: nC });
  check('the boutique really changes the number: now they move (moved: true)', really.status === 201 && really.data?.moved === true && really.data?.inventoryCustomerId !== fix.data.inventoryCustomerId, really);
  const stay = await call('POST', '/customers', { boutiqueCustomerId: 'b-fix', name: 'Fix Me', phone: nC });
  check('...and stay there on the next send', stay.data?.inventoryCustomerId === really.data.inventoryCustomerId && !stay.data?.moved, stay);

  console.log('\nA SHOP WHERE CRM CHANGES BIRTHDAYS');
  await prisma.moduleSubscription.update({ where: { clientId_module: { clientId: C1, module: 'crm' } }, data: { moved: { profile: true } } });
  const nD = await fresh();
  const datesOwn = await prisma.customer.create({ data: { clientId: C1, customerCode: `CUS-D${STAMP}`.slice(0, 20), name: 'Dates Owner', phone: `+91${nD}` } });
  await call('POST', '/customers', { boutiqueCustomerId: 'b-dates', name: 'Dates Owner', phone: nD, email: 'dates@x.in', birthday: '03-03', anniversary: '04-04' });
  const dRow = await prisma.customer.findUnique({ where: { id: datesOwn.id } });
  check('an existing customer: the empty email is filled, the birthday and anniversary are left to CRM', dRow?.email === 'dates@x.in' && dRow?.birthday === null && dRow?.anniversary === null, dRow);
  const fresher = await call('POST', '/customers', { boutiqueCustomerId: 'b-dates2', name: 'Brand New', phone: await fresh(), birthday: '05-05' });
  check('a customer made just now still takes the birthday sent with them', (await prisma.customer.findUnique({ where: { id: fresher.data.inventoryCustomerId } }))?.birthday === '05-05');
  await prisma.moduleSubscription.update({ where: { clientId_module: { clientId: C1, module: 'crm' } }, data: { moved: {} } });

  console.log('\nAN IMPORT TAKEN BACK OUT');
  const i1 = await fresh(), i2 = await fresh();
  const imp = await customerImport.apply(C1, { id: 'verify', name: 'Verify' }, 'take-back.xlsx', [{ rowNumber: 2, name: 'Imp One', phone: i1 }, { rowNumber: 3, name: 'Imp Two', phone: i2 }], 2);
  await call('POST', '/customers', { boutiqueCustomerId: 'b-imp', name: 'Imp One', phone: i1 });
  const tbp = await customerImport.takeBackPreview(C1, imp.source);
  check('the boutique has one of the two imported customers: the preview says 1 goes, 1 stays', tbp.willGo === 1 && tbp.willStay === 1, tbp);
  const tb = await customerImport.takeBack(C1, imp.source);
  const impRow = await profileOf(C1, 'b-imp');
  check('taken back: the boutique\'s customer stays, and the boutique is NOT told to wipe them', tb.removed === 1 && tb.kept === 1 && impRow?.removed === false && !!impRow.customerId
    && !(await call('GET', '/customers/removed')).data?.removed?.some((r: any) => r.boutiqueCustomerId === 'b-imp'), [tb, impRow]);

  console.log('\nTHE BOUTIQUE UNLINKS SOMEONE');
  const un = await call('DELETE', '/customers/b-nop');
  const unRow = await profileOf(C1, 'b-nop');
  check('unlinked: removed, reason UNLINKED, nothing personal kept (name, customer)', !!(un.status === 200 && unRow?.removed && unRow.removedReason === 'UNLINKED' && !unRow.boutiqueName && !unRow.customerId), unRow);
  check('...the Inventory customer itself stays (it is the shop\'s customer too)', !!(await prisma.customer.findFirst({ where: { id: noP.data.inventoryCustomerId, deletedAt: null } })));
  const relink = await call('POST', '/customers', { boutiqueCustomerId: 'b-nop', name: 'Grandma Kamala' });
  const rl = await profileOf(C1, 'b-nop');
  check('linked again later: back, with the name, not removed', relink.status === 200 && relink.data?.relinked === true && rl?.removed === false && rl.boutiqueName === 'Grandma Kamala', [relink, rl]);
  check('unlinking someone never linked: 404', (await call('DELETE', '/customers/b-never')).status === 404);

  console.log('\nINVENTORY REMOVES THE CUSTOMER');
  // Lakshmi's number carries Lakshmi and (until she moved) Priya. Add a cousin on it, then erase the customer.
  await call('POST', '/customers', { boutiqueCustomerId: 'b-cou', name: 'Cousin Devi', phone: nL });

  await prisma.customer.update({ where: { id: lak.data.inventoryCustomerId }, data: { deletedAt: new Date(), name: 'Removed customer', phone: null, email: null } });
  const [gl, gc] = [await profileOf(C1, 'b-lak'), await profileOf(C1, 'b-cou')];
  check('erased: EVERY boutique person on that customer is removed (Lakshmi and the cousin)', !!gl?.removed && !!gc?.removed && gl.removedReason === 'CUSTOMER_REMOVED' && gc!.removedReason === 'CUSTOMER_REMOVED', [gl, gc]);
  check('...with nothing personal kept: no name, no customer', [gl, gc].every(r => !r?.boutiqueName && !r?.customerId));
  check('...Priya, who moved to her own number earlier, is untouched', (await profileOf(C1, 'b-pri'))?.removed === false);
  check('nothing about the matching rows went to CRM; CRM hears the ordinary customer change', !(await prisma.moduleEvent.count({ where: { clientId: C1, sourceTable: 'customer_boutique_profiles' } }))
    && (await prisma.moduleEvent.count({ where: { clientId: C1, module: 'crm', sourceTable: 'customers', rowId: lak.data.inventoryCustomerId, kind: 'customer.updated' } })) > 0);
  const back = await call('POST', '/customers', { boutiqueCustomerId: 'b-lak', name: 'Lakshmi K.', phone: nL });
  check('AN ERASE STAYS AN ERASE: sending the removed person again is refused (410), saying what to do', back.status === 410 && /removed this customer/.test(back.message ?? '') && /new boutiqueCustomerId/.test(back.message ?? ''), back);
  check('...and nobody was made or brought back', (await profileOf(C1, 'b-lak'))?.removed === true && !(await prisma.customer.count({ where: { clientId: C1, phone: `+91${nL}`, deletedAt: null } })));
  const mixed = await call('POST', '/customers/bulk', { customers: [{ boutiqueCustomerId: 'b-cou', name: 'Cousin Devi', phone: nL }, { boutiqueCustomerId: 'b-after', name: 'After Erase', phone: await fresh() }] });
  check('in a bulk send the removed one is refused by name (gone: true) and the others still go in', mixed.status === 200 && mixed.data?.linked === 1 && mixed.data?.refused === 1 && mixed.data.results[0].gone === true && mixed.data.results[1].ok === true, mixed.data);
  const anew = await call('POST', '/customers', { boutiqueCustomerId: 'b-lak-2', name: 'Lakshmi K.', phone: nL });
  check('the same lady coming back as a NEW boutique customer (a new id) is a new customer, as at the till', anew.status === 201 && anew.data?.matched === 'NEW', anew);
  const hard = await call('POST', '/customers', { boutiqueCustomerId: 'b-hard', name: 'Hard Delete', phone: await fresh() });
  await prisma.customer.delete({ where: { id: hard.data.inventoryCustomerId } });
  const hr = await profileOf(C1, 'b-hard');
  check('a customer deleted outright (an import taken back): the boutique person is removed the same way', !!hr?.removed && hr.removedReason === 'CUSTOMER_REMOVED' && !hr.boutiqueName, hr);
  const rem = await call('GET', '/customers/removed?limit=2');
  check('the boutique can list who Inventory removed: ids only, oldest first, in pages', rem.status === 200 && rem.data?.removed?.length === 2 && rem.data.hasMore === true && rem.data.removed.every((r: any) => Object.keys(r).join() === 'boutiqueCustomerId,removedAt'), rem.data);
  const rem2 = await call('GET', `/customers/removed?after=${encodeURIComponent(rem.data.next)}`);
  const allRemoved = [...rem.data.removed, ...(rem2.data?.removed ?? [])].map((r: any) => r.boutiqueCustomerId).sort().join();
  check('...the next page carries on: b-cou, b-hard, b-lak in all, never the one the boutique unlinked itself', allRemoved === 'b-cou,b-hard,b-lak' && rem2.data.hasMore === false, allRemoved);
  check('GET one shows them removed', (await call('GET', '/customers/b-lak')).data?.removed === true);

  console.log('\nTHE GUIDE\'S OWN EXAMPLES (handouts/ScaleEzy-Boutique-API-Guide.md, "Customers: what you can send")');
  // Every way of writing one number the guide lists is the same customer, kept as +91...
  const g = await fresh();
  const forms = [g, `${g.slice(0, 5)} ${g.slice(5)}`, `${g.slice(0, 3)}-${g.slice(3, 6)}-${g.slice(6)}`, `(${g.slice(0, 5)}) ${g.slice(5)}`, `0${g}`, `+91 ${g.slice(0, 5)} ${g.slice(5)}`, `91${g}`, `0091 ${g}`];
  const landed: string[] = [];
  for (const [i, f] of forms.entries()) landed.push((await call('POST', '/customers', { boutiqueCustomerId: `g-ph-${i}`, name: 'Guide Phone', phone: f })).data?.inventoryCustomerId);
  check(`the ${forms.length} ways of writing one Indian number in the guide are one customer, kept as +91...`, landed.every(id => !!id && id === landed[0]) && (await prisma.customer.findUnique({ where: { id: landed[0] } }))?.phone === `+91${g}`, landed);
  const abroad = await call('POST', '/customers', { boutiqueCustomerId: 'g-ph-us', name: 'Guide Abroad', phone: '+1 415 555 0142' });
  check('"+1 415 555 0142" is kept as +14155550142', (await prisma.customer.findUnique({ where: { id: abroad.data?.inventoryCustomerId ?? '' } }))?.phone === '+14155550142', abroad);
  for (const badPhone of ['98480 2233', '984802233812', '5848022338', '98480 abcde', '9999999999', '9876543210']) {
    check(`the guide says "${badPhone}" is refused`, (await call('POST', '/customers', { boutiqueCustomerId: 'g-ph-bad', name: 'Guide Bad', phone: badPhone })).status === 400);
  }
  check('phone "" and phone null are "no phone"', (await call('POST', '/customers', { boutiqueCustomerId: 'g-ph-empty', name: 'Guide Empty', phone: '' })).status === 201 && (await call('POST', '/customers', { boutiqueCustomerId: 'g-ph-null', name: 'Guide Null', phone: null })).status === 201);
  const dates = ['14-08', '14/08', '14.08', '14-08-1990', '14 Aug', '14 August 1990', '14th Aug', '1990-08-14'];
  const kept: (string | null | undefined)[] = [];
  for (const [i, dt] of dates.entries()) {
    const r = await call('POST', '/customers', { boutiqueCustomerId: `g-dt-${i}`, name: `Guide Date ${i}`, birthday: dt });
    kept.push((await prisma.customer.findUnique({ where: { id: r.data?.inventoryCustomerId ?? '' } }))?.birthday);
  }
  check(`the ${dates.length} ways of writing 14 August in the guide are all kept as 08-14`, kept.every(b => b === '08-14'), kept);
  const leap = await call('POST', '/customers', { boutiqueCustomerId: 'g-dt-leap', name: 'Guide Leap', birthday: '29-02' });
  check('"29-02" is accepted', (await prisma.customer.findUnique({ where: { id: leap.data?.inventoryCustomerId ?? '' } }))?.birthday === '02-29', leap);
  for (const badDate of ['30-02', '31-04', '12-13', 'next week']) {
    check(`the guide says the date "${badDate}" is refused`, (await call('POST', '/customers', { boutiqueCustomerId: 'g-dt-bad', name: 'Guide Bad Date', birthday: badDate })).status === 400);
  }
  check('capital and small letters are different ids (C-1 and c-1 are two people)', (await call('POST', '/customers', { boutiqueCustomerId: 'G-Case', name: 'Guide Case One' })).data?.inventoryCustomerId
    !== (await call('POST', '/customers', { boutiqueCustomerId: 'g-case', name: 'Guide Case Two' })).data?.inventoryCustomerId);
  const blank = await call('POST', '/customers', { boutiqueCustomerId: 'g-blank', name: 'Guide Blank', phone: await fresh(), email: 'blank@example.com' });
  await call('POST', '/customers', { boutiqueCustomerId: 'g-blank', name: 'Guide Blank', email: '' });
  check('sending "" for a detail does not remove it', (await prisma.customer.findUnique({ where: { id: blank.data.inventoryCustomerId } }))?.email === 'blank@example.com');
  // The guide's two worked examples, word for word, in the other (empty) shop.
  const o2 = { tenant: T2 };
  const single = await call('POST', '/customers', { boutiqueCustomerId: 'C-1042', name: 'Lakshmi K', phone: '98480 22338', email: 'lakshmi@gmail.com', birthday: '14-08-1990', anniversary: '02-12', address: '12 MG Road, Hyderabad' }, o2);
  check('the guide\'s POST example answers 201 with exactly the fields it shows', single.status === 201 && Object.keys(single.data ?? {}).sort().join() === 'boutiqueCustomerId,inventoryCustomerId,matched,moved,nameMatches,relinked'
    && single.data.matched === 'NEW' && single.data.nameMatches === true && single.data.moved === false && single.data.relinked === false, single);
  const del = await call('DELETE', '/customers/C-1042', undefined, o2);
  check('the guide\'s DELETE answer: { boutiqueCustomerId, removed: true }, and the customer stays', del.status === 200 && Object.keys(del.data ?? {}).sort().join() === 'boutiqueCustomerId,removed' && del.data.removed === true
    && !!(await prisma.customer.findFirst({ where: { id: single.data.inventoryCustomerId, deletedAt: null } })), del);
  const back2 = await call('POST', '/customers', { boutiqueCustomerId: 'C-1042', name: 'Lakshmi K', phone: '98480 22338' }, o2);
  check('...and sending the id again links them again (relinked: true), as the guide says', back2.status === 200 && back2.data?.relinked === true && back2.data?.inventoryCustomerId === single.data.inventoryCustomerId, back2);
  const pg = await fresh();
  const gb = await call('POST', '/customers/bulk', { customers: [
    { boutiqueCustomerId: 'C-1', name: 'Lakshmi K', phone: pg },
    { boutiqueCustomerId: 'C-2', name: 'Priya K', phone: pg },
    { boutiqueCustomerId: 'C-3', name: '' },
    { boutiqueCustomerId: 'C-1', name: 'Lakshmi K' }
  ] }, o2);
  const gr = gb.data?.results ?? [];
  check('the guide\'s bulk example: linked 2, refused 2, each row as shown', gb.status === 200 && gb.data?.linked === 2 && gb.data?.refused === 2
    && gr[0]?.ok === true && gr[0].matched === 'NEW' && gr[0].nameMatches === true
    && gr[1]?.ok === true && gr[1].matched === 'BY_PHONE' && gr[1].nameMatches === false && gr[1].inventoryCustomerId === gr[0].inventoryCustomerId
    && gr[2]?.ok === false && gr[2].boutiqueCustomerId === 'C-3' && gr[2].error === 'Give the customer\'s name.'
    && gr[3]?.ok === false && gr[3].boutiqueCustomerId === 'C-1' && gr[3].error === 'This boutiqueCustomerId is in the list twice; it was taken once.', gb.data);
  const noList = await call('POST', '/customers/bulk', {}, o2);
  check('bulk with no list is refused (400), nothing saved', noList.status === 400, noList);
  const badAfter = await call('GET', '/customers/removed?after=nonsense', undefined, o2);
  check('a wrong "after" on the removed list is 400', badAfter.status === 400, badAfter);
  const lim = await call('GET', '/customers/removed?limit=99999', undefined, o2);
  check('a huge limit on the removed list is simply capped (200 OK)', lim.status === 200 && Array.isArray(lim.data?.removed), lim);
  check('reading needs no can word (GET with an empty can list)', (await call('GET', '/customers/C-1', undefined, { tenant: T2, can: [] })).status === 200);
  check('deleting without customers:write is refused (403)', (await call('DELETE', '/customers/C-1', undefined, { tenant: T2, can: ['products:write'] })).status === 403);

  console.log('\nANOTHER SHOP');
  check('shop 2 cannot read shop 1\'s person', (await call('GET', '/customers/b-pri', undefined, { tenant: T2 })).status === 404);
  check('...nor unlink them', (await call('DELETE', '/customers/b-pri', undefined, { tenant: T2 })).status === 404);
  check('...and shop 2\'s removed list is empty', (await call('GET', '/customers/removed', undefined, { tenant: T2 })).data?.removed?.length === 0);
  const same = await call('POST', '/customers', { boutiqueCustomerId: 'b-pri', name: 'Another Priya', phone: nP }, { tenant: T2 });
  check('the same boutique id and number in shop 2 is shop 2\'s own customer', same.status === 201 && same.data?.inventoryCustomerId !== moved.data.inventoryCustomerId, same);
}

async function joining() {
  console.log('\nA BOUTIQUE-ONLY SHOP JOINS A RETAIL SHOP (its customers must come along, nobody wiped)');
  const pA = await fresh(), pB = await fresh(), pO = await fresh();
  const l3 = await call('POST', '/link', { shopName: 'Joining Boutique' }, { tenant: T3 });
  const C3 = l3.data?.clientId as string; EXTRA.push(C3);
  const o = { tenant: T3 };
  const ba = await call('POST', '/customers', { boutiqueCustomerId: 'b-a', name: 'Asha Rao', phone: pA, email: 'asha@boutique.in' }, o);
  await call('POST', '/customers', { boutiqueCustomerId: 'b-d', name: 'Deepa (daughter)', phone: pA }, o);
  const bb = await call('POST', '/customers', { boutiqueCustomerId: 'b-b', name: 'Bindu', phone: pB }, o);
  const bc = await call('POST', '/customers', { boutiqueCustomerId: 'b-c', name: 'Chitra' }, o);
  check('(the boutique-only shop has 3 customers, numbered CUS-000001 to 3 like any shop)', (await prisma.customer.findMany({ where: { clientId: C3 }, orderBy: { customerCode: 'asc' } })).map(c => c.customerCode).join() === 'CUS-000001,CUS-000002,CUS-000003');
  // The retail shop already has Asha (same number) as CUS-000001 and another customer as CUS-000002.
  await prisma.stockLocation.create({ data: { clientId: R, name: 'Main shop', code: `MS-${STAMP}`, type: 'STORE' } as any });
  const ownAsha = await prisma.customer.create({ data: { clientId: R, customerCode: 'CUS-000001', name: 'Asha Rao', phone: `+91${pA}`, email: 'asha@shop.in', loyaltyPoints: 40 } });
  await prisma.customer.create({ data: { clientId: R, customerCode: 'CUS-000002', name: 'Only Retail', phone: `+91${pO}` } });
  await prisma.clientSequence.create({ data: { clientId: R, entityType: 'CUSTOMER', lastValue: 2 } });

  const joined = await enableForClient(R, T3).then(r => r, (e: any) => ({ error: e.message }));
  check('the boutique is switched on for the shop without an error', !(joined as any).error && (joined as any).linked === true, joined);
  const now = await prisma.customer.findMany({ where: { clientId: R }, orderBy: { customerCode: 'asc' } });
  check('the shop now has 4 customers: its own 2, plus Bindu and Chitra', now.length === 4 && now.map(c => c.name).sort().join() === 'Asha Rao,Bindu,Chitra,Only Retail', now.map(c => `${c.customerCode} ${c.name}`));
  check('...Bindu and Chitra took the shop\'s NEXT numbers (CUS-000003, CUS-000004), same customers as before', now.filter(c => ['Bindu', 'Chitra'].includes(c.name)).map(c => c.customerCode).sort().join() === 'CUS-000003,CUS-000004'
    && now.find(c => c.name === 'Bindu')?.id === bb.data.inventoryCustomerId && now.find(c => c.name === 'Chitra')?.id === bc.data.inventoryCustomerId);
  const ashaNow = now.find(c => c.name === 'Asha Rao');
  check('...the shop\'s own Asha is untouched (her number, email, points), and the boutique-only copy is gone', ashaNow?.id === ownAsha.id && ashaNow.customerCode === 'CUS-000001' && ashaNow.email === 'asha@shop.in' && ashaNow.loyaltyPoints === 40
    && !(await prisma.customer.count({ where: { id: ba.data.inventoryCustomerId } })), ashaNow);
  check('nothing is left under the boutique-only shop', !(await prisma.customer.count({ where: { clientId: C3 } })) && !(await prisma.customerBoutiqueProfile.count({ where: { clientId: C3 } })));
  const rows = await prisma.customerBoutiqueProfile.findMany({ where: { clientId: R }, orderBy: { boutiqueCustomerId: 'asc' } });
  check('all 4 boutique people came along, NOBODY marked removed', rows.length === 4 && rows.every(r => !r.removed && !!r.customerId), rows);
  check('...Asha and her daughter are on the shop\'s Asha (Asha matches by name, the daughter does not)', rows.find(r => r.boutiqueCustomerId === 'b-a')?.customerId === ownAsha.id && rows.find(r => r.boutiqueCustomerId === 'b-a')?.nameMatches === true
    && rows.find(r => r.boutiqueCustomerId === 'b-d')?.customerId === ownAsha.id && rows.find(r => r.boutiqueCustomerId === 'b-d')?.nameMatches === false);
  check('THE BOUTIQUE IS TOLD TO WIPE NOBODY', (await call('GET', '/customers/removed', undefined, o)).data?.removed?.length === 0);
  const again = await call('POST', '/customers', { boutiqueCustomerId: 'b-b', name: 'Bindu', phone: pB }, o);
  check('the boutique carries on as before: Bindu sent again is the same customer', again.status === 200 && again.data?.inventoryCustomerId === bb.data.inventoryCustomerId, again);
  const next = await call('POST', '/customers', { boutiqueCustomerId: 'b-new', name: 'Next One', phone: await fresh() }, o);
  check('...and the next new customer gets CUS-000005 (no number used twice)', (await prisma.customer.findUnique({ where: { id: next.data.inventoryCustomerId } }))?.customerCode === 'CUS-000005', next);

  console.log('\nA COPY THAT CANNOT BE JOINED BY GUESSWORK');
  const pZ = await fresh();
  const l4 = await call('POST', '/link', { shopName: 'Second Joining Boutique' }, { tenant: T4 });
  const C4 = l4.data?.clientId as string; EXTRA.push(C4);
  const bz = await call('POST', '/customers', { boutiqueCustomerId: 'b-z', name: 'Zara', phone: pZ }, { tenant: T4 });
  await prisma.customerAddress.create({ data: { clientId: C4, customerId: bz.data.inventoryCustomerId, name: 'Zara', phone: `+91${pZ}`, line: '1 Test Road', pincode: '500001' } as any });
  await prisma.stockLocation.create({ data: { clientId: R2, name: 'Main shop', code: `M2-${STAMP}`, type: 'STORE' } as any });
  await prisma.customer.create({ data: { clientId: R2, customerCode: 'CUS-000001', name: 'Zara', phone: `+91${pZ}` } });
  const refused = await enableForClient(R2, T4).then(() => 'enabled', (e: any) => e.message as string);
  check('a boutique copy with an address of its own on a number the shop also has: refused in words', /cannot be joined automatically/.test(refused) && /Nothing was changed/.test(refused), refused);
  const zNow = await prisma.customer.findUnique({ where: { id: bz.data.inventoryCustomerId } });
  check('...and nothing changed: the customer, their number CUS-000001, their link, the boutique-only shop', zNow?.clientId === C4 && zNow.customerCode === 'CUS-000001' && (await profileOf(C4, 'b-z'))?.removed === false
    && (await call('GET', '/customers/b-z', undefined, { tenant: T4 })).data?.inventoryCustomerId === zNow.id, zNow);

  console.log('\nTHE SHOP CHANGES TO ANOTHER BOUTIQUE');
  await disableForClient(R);
  const pN = await fresh();
  const l5 = await call('POST', '/link', { shopName: 'Another Boutique' }, { tenant: T5 });
  const C5 = l5.data?.clientId as string; EXTRA.push(C5);
  const anjali = await call('POST', '/customers', { boutiqueCustomerId: 'b-a', name: 'Anjali New', phone: pN }, { tenant: T5 });
  const swapped = await enableForClient(R, T5).then(r => r, (e: any) => ({ error: e.message }));
  check('another boutique is switched on for the shop (its "b-a" is a different lady)', !(swapped as any).error, swapped);
  const ba5 = await profileOf(R, 'b-a');
  check('"b-a" now means the NEW boutique\'s Anjali, never the old boutique\'s Asha', ba5?.boutiqueName === 'Anjali New' && ba5.customerId === anjali.data.inventoryCustomerId && ba5.customerId !== ownAsha.id, ba5);
  check('...the old boutique\'s other people are no longer matched (b-b, b-c, b-d gone)', (await prisma.customerBoutiqueProfile.count({ where: { clientId: R, boutiqueCustomerId: { in: ['b-b', 'b-c', 'b-d', 'b-new'] } } })) === 0);
  check('...but the shop keeps every customer (they are the shop\'s customers)', (await prisma.customer.count({ where: { clientId: R, deletedAt: null } })) === 6);
}

async function cleanup() {
  const ids = [C1, C2, R, R2, ...EXTRA].filter(Boolean);
  const tables = await prisma.$queryRaw<{ table_name: string }[]>`SELECT DISTINCT table_name FROM information_schema.columns WHERE table_schema = 'public' AND column_name = 'client_id'`;
  for (let round = 0; round < 6; round++) {
    let left = 0;
    for (const t of tables) { try { await prisma.$executeRawUnsafe(`DELETE FROM "${t.table_name}" WHERE client_id = ANY($1)`, ids); } catch { left++; } }
    if (!left) break;
  }
  await prisma.boutiqueLink.deleteMany({ where: { tenant: { in: [T1, T2, T3, T4, T5] } } }).catch(() => undefined);
  console.log(`\ncleaned up ${ids.length} throwaway shops`);
}

main().then(joining)
  .catch(e => { bad++; console.error('CRASH', e); })
  .finally(async () => { await cleanup().catch(e => console.error('cleanup failed', e)); console.log(`${good} passed, ${bad} problems`); await prisma.$disconnect(); process.exit(bad ? 1 : 0); });
