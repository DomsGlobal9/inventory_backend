/**
 * GET /pos/v1/wallet carries the customer's groups for the till's badge (VIP, Wholesale): display
 * names only, once each, [] when none -- and never a group's message rules. Real HTTP against the
 * local backend with a real till key, on a throwaway shop removed at the end.
 *
 *   npx tsx src/scripts/verify-pos-wallet-groups.ts      (backend running on :4006)
 */
import axios from 'axios';
import { prisma } from '../lib/prisma';
import { posConnectionService } from '../services/pos/pos-connection.service';

const BASE = `${process.env.TEST_API_URL || 'http://localhost:4006/api/v1'}/pos/v1`;
const STAMP = Date.now();
const CLIENT = `pos-groups-${STAMP}`;
const OTHER = `pos-groups-other-${STAMP}`;
let passed = 0, failed = 0;
const check = (name: string, ok: boolean, detail = '') => {
  if (ok) { passed++; console.log(`  ok   ${name}`); } else { failed++; console.log(`  FAIL ${name} -- ${detail}`); }
};
const brief = (r: any) => `${r.status} ${JSON.stringify(r.data).slice(0, 260)}`;

async function main() {
  const store = await prisma.stockLocation.create({ data: { clientId: CLIENT, name: 'Counter', code: `GRP-${STAMP}`, type: 'STORE' as any, active: true } });
  await prisma.clientSettings.create({ data: { clientId: CLIENT, businessName: 'Groups Test Shop', gstRegistration: 'UNREGISTERED' } });
  const phone = (n: number) => `+919${String(STAMP + n).slice(-9)}`;
  const mk = (n: number, name: string, tags: string[]) => prisma.customer.create({ data: { clientId: CLIENT, customerCode: `GC-${STAMP}-${n}`, name, phone: phone(n), tags } });
  await mk(1, 'Meena Iyer', ['vip', 'Wholesale']);
  await mk(2, 'Farah Khan', ['VIP', 'vip', ' Vip ']);
  await mk(3, 'Kavya Menon', []);
  // The group row decides the spelling, and it carries rules a cashier must never see.
  await prisma.customerGroup.create({ data: { clientId: CLIENT, key: 'vip', name: 'VIP', noOfferMessages: true, noWishes: true } as any });
  // Another shop's group with the same key must not lend its spelling.
  await prisma.customerGroup.create({ data: { clientId: OTHER, key: 'wholesale', name: 'OTHER SHOP WHOLESALE' } as any });
  const till = await posConnectionService.create(CLIENT, { locationId: store.id, name: 'Till one' });
  const A = axios.create({ baseURL: BASE, headers: { 'X-Storefront-Key': till.key }, validateStatus: () => true });
  const wallet = (n: number | string) => A.get('/wallet', { params: { customerRef: typeof n === 'number' ? phone(n) : n, billPaise: 100000 } });

  const r1 = await wallet(1);
  check('a customer in two groups: both names, the row\'s spelling for VIP, the tag\'s for Wholesale', r1.status === 200 && JSON.stringify(r1.data?.data?.groups) === JSON.stringify(['VIP', 'Wholesale']), brief(r1));
  check('...and no message rule reaches the till', !/noOfferMessages|noWishes|autoMinSpend/.test(JSON.stringify(r1.data)), brief(r1));
  check('...and the wallet\'s own figures are still there', r1.data?.data?.customerName === 'Meena Iyer' && 'credit' in (r1.data?.data ?? {}) && 'points' in (r1.data?.data ?? {}), brief(r1));

  const r2 = await wallet(2);
  check('the same group typed three ways is one badge', JSON.stringify(r2.data?.data?.groups) === JSON.stringify(['VIP']), brief(r2));

  const r3 = await wallet(3);
  check('a customer in no group gets groups: [] (present, not missing)', Array.isArray(r3.data?.data?.groups) && r3.data.data.groups.length === 0, brief(r3));

  const r4 = await wallet('+919000000001');
  check('an unknown number also gets groups: []', r4.status === 200 && Array.isArray(r4.data?.data?.groups) && r4.data.data.groups.length === 0 && r4.data.data.customerName === null, brief(r4));

  await prisma.customerGroup.update({ where: { clientId_key: { clientId: CLIENT, key: 'vip' } }, data: { name: 'Gold VIP' } });
  const r5 = await wallet(1);
  check('a group renamed in Settings shows its new name at once', JSON.stringify(r5.data?.data?.groups) === JSON.stringify(['Gold VIP', 'Wholesale']), brief(r5));

  const r6 = await axios.get(`${BASE}/wallet`, { params: { customerRef: phone(1), billPaise: 100000 }, validateStatus: () => true });
  check('without a till key the wallet (and its groups) is refused', r6.status === 401 || r6.status === 403, brief(r6));
}

main().catch(e => { failed++; console.error(e); }).finally(async () => {
  for (const c of [CLIENT, OTHER]) {
    await prisma.customerGroup.deleteMany({ where: { clientId: c } }).catch(() => {});
    await prisma.customer.deleteMany({ where: { clientId: c } }).catch(() => {});
    await prisma.storefrontConnection.deleteMany({ where: { clientId: c } }).catch(() => {});
    await prisma.clientSettings.deleteMany({ where: { clientId: c } }).catch(() => {});
    await prisma.stockLocation.deleteMany({ where: { clientId: c } }).catch(() => {});
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  await prisma.$disconnect();
  process.exit(failed ? 1 : 0);
});
