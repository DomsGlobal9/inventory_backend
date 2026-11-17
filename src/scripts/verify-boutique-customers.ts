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

  console.log('\nNOTHING BOUTIQUE IS KEPT (the owner, 17 Nov: measurements and stitching are CRM-B\'s alone)');
  const oldRoute = await call('PUT', '/customers/b-lak/profile', { snapshot: { measurementSets: [{ id: 'm' }] } });
  check('there is no measurements route (refused), and nothing about measurements is kept', oldRoute.status >= 400 && JSON.stringify((await profileOf(C1, 'b-lak'))?.snapshot) === '{}', oldRoute.status);
  const extra = await call('POST', '/customers', { boutiqueCustomerId: 'b-lak', name: 'Lakshmi K.', phone: nL, measurements: { bust: 34 }, editUrl: 'https://x.example.com/1' });
  const lakRow = await prisma.customerBoutiqueProfile.findUnique({ where: { clientId_boutiqueCustomerId: { clientId: C1, boutiqueCustomerId: 'b-lak' } } });
  check('extra boutique fields sent with a customer (measurements, a link) are simply not kept', extra.status === 200 && !JSON.stringify(lakRow).includes('bust') && !JSON.stringify(lakRow).includes('x.example.com'), lakRow);
  check('GET one says only who is who', Object.keys((await call('GET', '/customers/b-lak')).data ?? {}).sort().join() === 'boutiqueCustomerId,inventoryCustomerId,nameMatches,removed,removedReason');

  console.log('\nCRM\'S CHANGE FEED');
  const events = await prisma.moduleEvent.findMany({ where: { clientId: C1, module: 'crm', sourceTable: 'customer_boutique_profiles' }, orderBy: { sequence: 'asc' } });
  const lakEvents = events.filter(e => (e.payload as any).boutique_customer_id === 'b-lak');
  check('CRM hears customer_boutique_profile.created and .updated', lakEvents.some(e => e.kind === 'customer_boutique_profile.created') && lakEvents.some(e => e.kind === 'customer_boutique_profile.updated'), events.map(e => e.kind));
  const lastLak = lakEvents.at(-1)?.payload as any;
  check('...the event carries the current customer, the name and name_matches, and nothing boutique', lastLak?.customer_id === lak.data.inventoryCustomerId && lastLak?.boutique_name && lastLak?.name_matches === true && JSON.stringify(lastLak?.snapshot ?? {}) === '{}' && !('edit_url' in (lastLak ?? {})), lastLak);
  const priMove = events.filter(e => (e.payload as any).boutique_customer_id === 'b-pri').map(e => (e.payload as any).customer_id);
  check('Priya\'s move to her own number is one event with the new customer', priMove.includes(moved.data.inventoryCustomerId));
  check('shop 2 (not on CRM) sends nothing to the feed', !(await prisma.moduleEvent.count({ where: { clientId: C2 } })));

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
  check('GET one shows them removed', (await call('GET', '/customers/b-lak')).data?.removed === true);

  console.log('\nANOTHER SHOP');
  check('shop 2 cannot read shop 1\'s person', (await call('GET', '/customers/b-pri', undefined, { tenant: T2 })).status === 404);
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
