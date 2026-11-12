/**
 * Erased customers for the POS till (12 Nov 2026): every way Inventory erases a person notes the number they
 * had, and the till reads it with its key (GET /pos/v1/erasures?since=). Throwaway shops, LOCAL only, the
 * real routes of a local server (VERIFY_API_URL), the real erase (customer-delete).
 *
 *   A  the owner erases a customer with bills / removes one without: both noted, with the number they had
 *   B  the till reads them in order, a page at a time; again with `next`: nothing new; its shop only
 *   C  a customer with no phone, a bad `since`, no key or a website key: nothing, or refused
 *   D  kept 30 days, then gone; more than one page
 *
 *   DATABASE_URL=<local> DIRECT_URL=<local> VERIFY_API_URL=http://localhost:4036/api/v1 npx tsx src/scripts/verify-customer-erasures.ts
 */
import axios from 'axios';
import { prisma } from '../lib/prisma';
import { posConnectionService } from '../services/pos/pos-connection.service';
import { deleteCustomer } from '../services/customer-delete';
import { noteErasures, erasuresAfter, KEEP_DAYS } from '../services/customer-erasures';

for (const k of ['DATABASE_URL', 'DIRECT_URL']) {
  if (!/localhost:55433/.test(process.env[k] ?? '')) { console.error(`Refusing: ${k} is not the local database.`); process.exit(2); }
}
const BASE = process.env.VERIFY_API_URL || 'http://localhost:4036/api/v1';
if (!/localhost|127\.0\.0\.1/.test(BASE)) { console.error('Refusing: not a local server.'); process.exit(2); }
const STAMP = Date.now();
const SHOP = `erase-pos-${STAMP}`;
const OTHER = `erase-pos-other-${STAMP}`;
let passed = 0, failed = 0;
const check = (name: string, ok: boolean, detail = '') => {
  if (ok) { passed++; console.log(`  ok   ${name}`); } else { failed++; console.log(`  FAIL ${name} -- ${detail}`); }
};
const get = (key: string | null, since?: string) => axios.get(`${BASE}/pos/v1/erasures${since !== undefined ? `?since=${encodeURIComponent(since)}` : ''}`,
  { headers: key ? { 'X-Storefront-Key': key } : {}, validateStatus: () => true, timeout: 60_000 });

async function main() {
  const store = await prisma.stockLocation.create({ data: { clientId: SHOP, name: 'Main', code: `EP-${STAMP}`, type: 'STORE' as any, active: true } });
  const otherStore = await prisma.stockLocation.create({ data: { clientId: OTHER, name: 'Other', code: `EO-${STAMP}`, type: 'STORE' as any, active: true } });
  const till = await posConnectionService.create(SHOP, { locationId: store.id, name: 'Till' });
  const otherTill = await posConnectionService.create(OTHER, { locationId: otherStore.id, name: 'Till' });
  const mk = (clientId: string, n: string, phone: string | null) => prisma.customer.create({ data: { clientId, customerCode: `E${n}-${STAMP}`, name: `Person ${n}`, phone } });

  console.log('A. EVERY ERASE IS NOTED');
  const withBills = await mk(SHOP, '1', '+919000066001');
  await prisma.salesOrder.create({ data: { clientId: SHOP, orderNumber: `SO-E1-${STAMP}`, locationId: store.id, customerId: withBills.id, status: 'DISPATCHED' as any, subtotal: 100, total: 100 } as any });
  const withoutBills = await mk(SHOP, '2', '+919000066002');
  const noPhone = await mk(SHOP, '3', null);
  let r: any = await deleteCustomer(SHOP, withBills.id, '6001');
  check('a customer with bills is ERASED (kept as Removed customer)', r.mode === 'ERASE', JSON.stringify(r));
  r = await deleteCustomer(SHOP, withoutBills.id, '6002');
  check('a customer without bills is removed', r.mode === 'REMOVE', JSON.stringify(r));
  await deleteCustomer(SHOP, noPhone.id, 'Person 3');
  const noted = await prisma.customerErasure.findMany({ where: { clientId: SHOP }, orderBy: { sequence: 'asc' } });
  check('both numbers are noted, in order; the one without a phone notes nothing', noted.map(n => n.phone).join() === '+919000066001,+919000066002', noted.map(n => n.phone).join());
  const gone = await prisma.customer.findMany({ where: { clientId: SHOP, phone: { in: ['+919000066001', '+919000066002'] } } });
  check('and the customers themselves no longer hold the numbers', gone.length === 0, JSON.stringify(gone));
  await mk(OTHER, '9', '+919000066009').then(c => deleteCustomer(OTHER, c.id, '6009'));

  console.log('\nB. THE TILL READS THEM');
  let g = await get(till.key);
  check('the till reads both, oldest first, with when', g.status === 200 && g.data?.data?.erasures?.map((e: any) => e.phone).join() === '+919000066001,+919000066002'
    && g.data.data.erasures.every((e: any) => !Number.isNaN(Date.parse(e.erasedAt))) && g.data.data.more === false && g.data.data.keptDays === KEEP_DAYS, JSON.stringify(g.data));
  const next = g.data?.data?.next;
  g = await get(till.key, next);
  check('asked again with next: nothing new, next unchanged', g.status === 200 && g.data.data.erasures.length === 0 && g.data.data.next === next, JSON.stringify(g.data));
  await deleteCustomer(SHOP, (await mk(SHOP, '4', '+919000066004')).id, '6004');
  g = await get(till.key, next);
  check('a later erase arrives on the next ask, alone', g.status === 200 && g.data.data.erasures.map((e: any) => e.phone).join() === '+919000066004', JSON.stringify(g.data));
  g = await get(otherTill.key);
  check('another shop\'s till sees only its own', g.status === 200 && g.data.data.erasures.map((e: any) => e.phone).join() === '+919000066009', JSON.stringify(g.data));

  console.log('\nC. REFUSALS');
  g = await get(till.key, 'yesterday');
  check('a since that is not a number: refused in words', g.status === 400 && /since/.test(g.data?.message), JSON.stringify(g.data));
  g = await get(till.key, '-5');
  check('a negative since: refused', g.status === 400, JSON.stringify(g.data));
  g = await get(null);
  check('no key: refused', g.status === 401 || g.status === 403, String(g.status));
  g = await get('sk_not_a_real_key_00000000000000');
  check('a wrong key: refused', g.status === 401 || g.status === 403, String(g.status));
  await posConnectionService.disconnect(SHOP, till.id);
  g = await get(till.key);
  check('a disconnected till: refused', g.status === 401 || g.status === 403, String(g.status));

  console.log('\nD. KEPT 30 DAYS, AND PAGES');
  const old = await prisma.customerErasure.create({ data: { clientId: OTHER, phone: '+919000066100', erasedAt: new Date(Date.now() - (KEEP_DAYS + 1) * 86_400_000) } });
  const page = await erasuresAfter(OTHER, '0');
  check('an erasure older than 30 days is deleted, never answered', !page.erasures.some(e => e.id === old.id) && !(await prisma.customerErasure.findUnique({ where: { id: old.id } })), JSON.stringify(page.erasures.map(e => e.phone)));
  await prisma.$transaction(tx => noteErasures(tx, OTHER, Array.from({ length: 205 }, (_, i) => `+91900007${String(i).padStart(4, '0')}`)));
  const p1 = await erasuresAfter(OTHER, '0');
  const p2 = await erasuresAfter(OTHER, p1.next);
  check('205 more: a page of 200 says more; the next page has the rest', p1.erasures.length === 200 && p1.more === true && p2.erasures.length === 6 && p2.more === false, `${p1.erasures.length}/${p1.more} then ${p2.erasures.length}/${p2.more}`);
  const dupes = await prisma.$transaction(tx => noteErasures(tx, OTHER, ['+919000099999', '+919000099999', '', null]));
  check('the same number twice in one erase, or blanks: noted once', dupes === 1, String(dupes));
}

main()
  .catch(e => { failed++; console.error('CRASHED', e); })
  .finally(async () => {
    const w = { clientId: { in: [SHOP, OTHER] } };
    await prisma.customerErasure.deleteMany({ where: w });
    await prisma.salesOrder.deleteMany({ where: w }).catch(() => null);
    await prisma.moduleEvent.deleteMany({ where: w }).catch(() => null);
    await prisma.customer.deleteMany({ where: w });
    await prisma.storefrontConnection.deleteMany({ where: w });
    await prisma.stockLocation.deleteMany({ where: w });
    const left = await prisma.customerErasure.count({ where: w }) + await prisma.customer.count({ where: w });
    check('nothing left behind', left === 0, String(left));
    console.log(`\n${passed} passed, ${failed} failed`);
    await prisma.$disconnect();
    process.exit(failed ? 1 : 0);
  });
