/**
 * The boutique app's (CRM-B) customers in ScaleEzy (17 Nov 2026, services/boutique/customers.ts), end to end against
 * the REAL local server with signed boutique passes:
 *   linking (new, by phone, by the boutique id with no phone, names written differently, a family phone, a new phone
 *   moving them, retries and races, bad details), the bulk first load, the read-only snapshot (shape, order, every
 *   refusal, older snapshots, the 64 KB cap), CRM's change feed, and removal (the boutique unlinks; Inventory erases or
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

const BASE = process.env.VERIFY_API_URL || 'http://localhost:4036/api/v1';
for (const k of ['DATABASE_URL', 'DIRECT_URL']) {
  if (!/localhost:55433/.test(process.env[k] ?? '')) { console.error(`Refusing: ${k} is not the local database.`); process.exit(2); }
}
if (!/localhost|127\.0\.0\.1/.test(BASE)) { console.error('Refusing: VERIFY_API_URL is not a local server.'); process.exit(2); }
const privateKey = fs.readFileSync(`${process.env.BOUTIQUE_KEY_DIR}/private.pem`, 'utf8');

const STAMP = Date.now().toString(36);
const T1 = `btqtest-c1-${STAMP}`;
const T2 = `btqtest-c2-${STAMP}`;
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

const snapshot = (bid: string, over: Record<string, unknown> = {}) => ({
  snapshotAt: new Date().toISOString(),
  editUrl: `https://boutique.example.com/customers/${bid}`,
  lastOrderAt: '2026-11-10T10:00:00+05:30',
  measurementSets: [
    { id: 'ms-old', name: 'Blouse – everyday', garment: 'Blouse', takenAt: '2025-06-01T10:00:00+05:30', takenBy: 'Meena', unit: 'in', values: [{ label: 'Bust', value: '34' }, { label: 'Waist', value: '28.5' }], note: null },
    { id: 'ms-wed', name: 'Blouse – wedding', garment: 'Blouse', takenAt: '2026-11-01T10:00:00+05:30', takenBy: null, unit: 'in', values: [{ label: 'Bust', value: '34.5' }, { label: 'Shoulder', value: '14' }], note: 'Deep back' }
  ],
  orders: [
    { id: 'o-1', number: 'BT-101', title: 'Blouse with lining, maroon', measurementSetId: 'ms-wed', status: 'TRIAL', statusWords: 'Trial booked', bookedAt: '2026-11-02T10:00:00+05:30', trialAt: '2026-11-22T11:00:00+05:30', dueAt: '2026-11-28T18:00:00+05:30', readyAt: null, deliveredAt: null, total: 4500, advance: 2000, balance: 2500, storeName: 'Banjara Hills', staffName: 'Meena' },
    { id: 'o-0', number: 'BT-090', title: 'Salwar, cotton', measurementSetId: null, status: 'DELIVERED', statusWords: 'Delivered', bookedAt: '2026-09-01T10:00:00+05:30', trialAt: null, dueAt: null, readyAt: '2026-09-10T10:00:00+05:30', deliveredAt: '2026-09-12T10:00:00+05:30', total: 1800, advance: 1800, balance: 0, storeName: null, staffName: null }
  ],
  ...over
});

let C1 = '', C2 = '';
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
  check('sent again (new request): the same customer, by phone, name still matches (case, spaces, dots)', resend.status === 200 && resend.data?.matched === 'BY_PHONE' && resend.data?.inventoryCustomerId === lak.data.inventoryCustomerId && resend.data?.nameMatches === true && !resend.data?.moved, resend);
  check('...and the name in Inventory is not changed', (await prisma.customer.findUnique({ where: { id: lak.data.inventoryCustomerId } }))?.name === 'Lakshmi K.');

  console.log('\nA CUSTOMER THE SHOP ALREADY HAS');
  const nS = await fresh();
  const shopOwn = await prisma.customer.create({ data: { clientId: C1, customerCode: `CUS-T${STAMP}`.slice(0, 20), name: 'Sujatha Rao', phone: `+91${nS}`, email: 'own@shop.in' } });
  const suj = await call('POST', '/customers', { boutiqueCustomerId: 'b-suj', name: 'sujatha  rao', phone: nS, email: 'boutique@x.in', birthday: '01-01' });
  check('matched by number to the shop\'s own customer, name agrees', suj.status === 200 && suj.data?.inventoryCustomerId === shopOwn.id && suj.data?.nameMatches === true, suj);
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

  console.log('\nDETAILS THAT CANNOT BE TAKEN');
  const before = await prisma.customer.count({ where: { clientId: C1 } });
  const refusals: [string, unknown, RegExp][] = [
    ['no boutiqueCustomerId', { name: 'A', phone: await fresh() }, /boutiqueCustomerId/],
    ['an id with spaces', { boutiqueCustomerId: 'b 1', name: 'A' }, /boutiqueCustomerId/],
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

  console.log('\nTHE SNAPSHOT');
  const early = await call('PUT', '/customers/b-unknown/profile', { snapshot: snapshot('b-unknown') });
  check('a snapshot for someone not linked: 404, link them first', early.status === 404 && /POST \/customers/.test(early.message ?? ''), early);
  const put = await call('PUT', '/customers/b-lak/profile', { snapshot: snapshot('b-lak') });
  check('a snapshot is kept', put.status === 200 && put.data?.kept === true, put);
  const row = await profileOf(C1, 'b-lak');
  const s = row?.snapshot as any;
  check('stored exactly in CRM\'s shape, ids filled in by Inventory', s?.boutiqueCustomerId === 'b-lak' && s?.inventoryCustomerId === lak.data.inventoryCustomerId && s?.editUrl?.startsWith('https://') && Array.isArray(s?.measurementSets) && Array.isArray(s?.orders), s);
  check('measurement sets newest first', s?.measurementSets?.[0]?.id === 'ms-wed' && s?.measurementSets?.[1]?.id === 'ms-old');
  check('openOrders counted from the orders (1: the TRIAL one)', s?.openOrders === 1);
  check('values kept as text, in order', s?.measurementSets?.[0]?.values?.map((v: any) => `${v.label}=${v.value}`).join() === 'Bust=34.5,Shoulder=14');
  check('dates stored as ISO times', s?.orders?.[0]?.trialAt === new Date('2026-11-22T11:00:00+05:30').toISOString());
  check('nothing about WhatsApp offers is in it', !JSON.stringify(s).toLowerCase().includes('whatsapp'));
  const older = await call('PUT', '/customers/b-lak/profile', { snapshot: snapshot('b-lak', { snapshotAt: '2020-01-01T00:00:00Z', editUrl: 'https://old.example.com/x' }) });
  check('an older snapshot is answered but not kept', older.status === 200 && older.data?.kept === false && ((await profileOf(C1, 'b-lak'))?.snapshot as any)?.editUrl?.startsWith('https://boutique.'), older);
  const bads: [string, Record<string, unknown>, RegExp][] = [
    ['an http (not https) edit link', { editUrl: 'http://x.example.com/1' }, /https/],
    ['no snapshotAt', { snapshotAt: undefined }, /snapshotAt/],
    ['a garment not in the list', { measurementSets: [{ id: 'm', name: 'n', garment: 'Saree', takenAt: '2026-01-01', unit: 'in', values: [] }] }, /garment/],
    ['unit mm', { measurementSets: [{ id: 'm', name: 'n', garment: 'Blouse', takenAt: '2026-01-01', unit: 'mm', values: [] }] }, /unit/],
    ['status DONE', { orders: [{ id: 'o', number: '1', title: 't', status: 'DONE', bookedAt: '2026-01-01' }] }, /status/],
    ['an order pointing at a measurement set that is not there', { orders: [{ id: 'o', number: '1', title: 't', status: 'BOOKED', bookedAt: '2026-01-01', measurementSetId: 'nope' }] }, /measurement set/],
    ['two sets with one id', { measurementSets: [{ id: 'm', name: 'a', garment: 'Blouse', takenAt: '2026-01-01', unit: 'in', values: [] }, { id: 'm', name: 'b', garment: 'Kurti', takenAt: '2026-01-02', unit: 'cm', values: [] }] }, /same id/],
    ['4 closed orders', { orders: [0, 1, 2, 3].map(i => ({ id: `c${i}`, number: `${i}`, title: 't', status: 'DELIVERED', bookedAt: '2026-01-01' })) }, /last 3 closed/],
    ['a date that is not a date', { lastOrderAt: 'yesterday' }, /not a date/],
    ['a negative balance', { orders: [{ id: 'o', number: '1', title: 't', status: 'BOOKED', bookedAt: '2026-01-01', balance: -5 }] }, /amount/],
    ['a 70 KB snapshot', { measurementSets: [{ id: 'm', name: 'n', garment: 'Blouse', takenAt: '2026-01-01', unit: 'in', values: [], note: 'x'.repeat(70 * 1024) }] }, /64 KB/],
  ];
  const kept = JSON.stringify((await profileOf(C1, 'b-lak'))?.snapshot);
  for (const [what, over, re] of bads) {
    const r = await call('PUT', '/customers/b-lak/profile', { snapshot: snapshot('b-lak', over) });
    check(`${what}: refused in words`, r.status === 400 && re.test(r.message ?? ''), r);
  }
  check('...and the kept snapshot never changed (refused whole, never half)', JSON.stringify((await profileOf(C1, 'b-lak'))?.snapshot) === kept);
  check('a snapshot that is not an object is refused', (await call('PUT', '/customers/b-lak/profile', { snapshot: 'hello' })).status === 400);

  console.log('\nCRM\'S CHANGE FEED');
  const events = await prisma.moduleEvent.findMany({ where: { clientId: C1, module: 'crm', sourceTable: 'customer_boutique_profiles' }, orderBy: { sequence: 'asc' } });
  const lakEvents = events.filter(e => (e.payload as any).boutique_customer_id === 'b-lak');
  check('CRM hears customer_boutique_profile.created and .updated', lakEvents.some(e => e.kind === 'customer_boutique_profile.created') && lakEvents.some(e => e.kind === 'customer_boutique_profile.updated'), events.map(e => e.kind));
  const lastLak = lakEvents.at(-1)?.payload as any;
  check('...the event carries the current customer, the name, name_matches and the full snapshot', lastLak?.customer_id === lak.data.inventoryCustomerId && lastLak?.boutique_name && lastLak?.name_matches === true && lastLak?.snapshot?.orders?.length === 2, lastLak);
  const priMove = events.filter(e => (e.payload as any).boutique_customer_id === 'b-pri').map(e => (e.payload as any).customer_id);
  check('Priya\'s move to her own number is one event with the new customer', priMove.includes(moved.data.inventoryCustomerId));
  check('shop 2 (not on CRM) sends nothing to the feed', !(await prisma.moduleEvent.count({ where: { clientId: C2 } })));

  console.log('\nTHE BOUTIQUE UNLINKS SOMEONE');
  const un = await call('DELETE', '/customers/b-nop');
  const unRow = await profileOf(C1, 'b-nop');
  check('unlinked: removed, reason UNLINKED, nothing personal kept (name, snapshot, customer)', un.status === 200 && unRow?.removed && unRow.removedReason === 'UNLINKED' && !unRow.boutiqueName && !unRow.customerId && JSON.stringify(unRow.snapshot) === '{}', unRow);
  check('...the Inventory customer itself stays (it is the shop\'s customer too)', !!(await prisma.customer.findFirst({ where: { id: noP.data.inventoryCustomerId, deletedAt: null } })));
  check('a snapshot for an unlinked person: 404', (await call('PUT', '/customers/b-nop/profile', { snapshot: snapshot('b-nop') })).status === 404);
  const relink = await call('POST', '/customers', { boutiqueCustomerId: 'b-nop', name: 'Grandma Kamala' });
  const rl = await profileOf(C1, 'b-nop');
  check('linked again later: back, with the name, not removed', relink.status === 200 && relink.data?.relinked === true && rl?.removed === false && rl.boutiqueName === 'Grandma Kamala', [relink, rl]);
  check('unlinking someone never linked: 404', (await call('DELETE', '/customers/b-never')).status === 404);

  console.log('\nINVENTORY REMOVES THE CUSTOMER');
  // Lakshmi's number carries Lakshmi and (until she moved) Priya. Add a cousin on it, then erase the customer.
  await call('POST', '/customers', { boutiqueCustomerId: 'b-cou', name: 'Cousin Devi', phone: nL });
  await call('PUT', '/customers/b-cou/profile', { snapshot: snapshot('b-cou') });
  await prisma.customer.update({ where: { id: lak.data.inventoryCustomerId }, data: { deletedAt: new Date(), name: 'Removed customer', phone: null, email: null } });
  const [gl, gc] = [await profileOf(C1, 'b-lak'), await profileOf(C1, 'b-cou')];
  check('erased: EVERY boutique person on that customer is removed (Lakshmi and the cousin)', !!gl?.removed && !!gc?.removed && gl.removedReason === 'CUSTOMER_REMOVED' && gc!.removedReason === 'CUSTOMER_REMOVED', [gl, gc]);
  check('...with nothing personal kept: no name, no snapshot, no customer', [gl, gc].every(r => !r?.boutiqueName && !r?.customerId && JSON.stringify(r?.snapshot) === '{}' && !r?.snapshotAt));
  check('...Priya, who moved to her own number earlier, is untouched', (await profileOf(C1, 'b-pri'))?.removed === false);
  const gone = events.length;
  const evAfter = await prisma.moduleEvent.findMany({ where: { clientId: C1, module: 'crm', sourceTable: 'customer_boutique_profiles' }, orderBy: { sequence: 'asc' }, skip: gone });
  check('CRM hears an .updated with removed: true for each, with no name in it', ['b-lak', 'b-cou'].every(b => evAfter.some(e => (e.payload as any).boutique_customer_id === b && (e.payload as any).removed === true && !(e.payload as any).boutique_name)), evAfter.map(e => e.payload));
  const hard = await call('POST', '/customers', { boutiqueCustomerId: 'b-hard', name: 'Hard Delete', phone: await fresh() });
  await prisma.customer.delete({ where: { id: hard.data.inventoryCustomerId } });
  const hr = await profileOf(C1, 'b-hard');
  check('a customer deleted outright (an import taken back): the boutique person is removed the same way', !!hr?.removed && hr.removedReason === 'CUSTOMER_REMOVED' && !hr.boutiqueName, hr);
  const rem = await call('GET', '/customers/removed?limit=2');
  check('the boutique can list who Inventory removed: ids only, oldest first, in pages', rem.status === 200 && rem.data?.removed?.length === 2 && rem.data.hasMore === true && rem.data.removed.every((r: any) => Object.keys(r).join() === 'boutiqueCustomerId,removedAt'), rem.data);
  const rem2 = await call('GET', `/customers/removed?after=${encodeURIComponent(rem.data.next)}`);
  const allRemoved = [...rem.data.removed, ...(rem2.data?.removed ?? [])].map((r: any) => r.boutiqueCustomerId).sort().join();
  check('...the next page carries on: b-cou, b-hard, b-lak in all, never the one the boutique unlinked itself', allRemoved === 'b-cou,b-hard,b-lak' && rem2.data.hasMore === false, allRemoved);
  check('a snapshot for a removed person: 404', (await call('PUT', '/customers/b-lak/profile', { snapshot: snapshot('b-lak') })).status === 404);
  check('GET one shows them removed', (await call('GET', '/customers/b-lak')).data?.removed === true);

  console.log('\nANOTHER SHOP');
  check('shop 2 cannot read shop 1\'s person', (await call('GET', '/customers/b-pri', undefined, { tenant: T2 })).status === 404);
  check('...nor send them a snapshot', (await call('PUT', '/customers/b-pri/profile', { snapshot: snapshot('b-pri') }, { tenant: T2 })).status === 404);
  check('...nor unlink them', (await call('DELETE', '/customers/b-pri', undefined, { tenant: T2 })).status === 404);
  check('...and shop 2\'s removed list is empty', (await call('GET', '/customers/removed', undefined, { tenant: T2 })).data?.removed?.length === 0);
  const same = await call('POST', '/customers', { boutiqueCustomerId: 'b-pri', name: 'Another Priya', phone: nP }, { tenant: T2 });
  check('the same boutique id and number in shop 2 is shop 2\'s own customer', same.status === 201 && same.data?.inventoryCustomerId !== moved.data.inventoryCustomerId, same);
}

async function cleanup() {
  const ids = [C1, C2].filter(Boolean);
  const tables = await prisma.$queryRaw<{ table_name: string }[]>`SELECT DISTINCT table_name FROM information_schema.columns WHERE table_schema = 'public' AND column_name = 'client_id'`;
  for (let round = 0; round < 6; round++) {
    let left = 0;
    for (const t of tables) { try { await prisma.$executeRawUnsafe(`DELETE FROM "${t.table_name}" WHERE client_id = ANY($1)`, ids); } catch { left++; } }
    if (!left) break;
  }
  await prisma.boutiqueLink.deleteMany({ where: { tenant: { in: [T1, T2] } } }).catch(() => undefined);
  console.log(`\ncleaned up ${ids.length} throwaway shops`);
}

main()
  .catch(e => { bad++; console.error('CRASH', e); })
  .finally(async () => { await cleanup().catch(e => console.error('cleanup failed', e)); console.log(`${good} passed, ${bad} problems`); await prisma.$disconnect(); process.exit(bad ? 1 : 0); });
