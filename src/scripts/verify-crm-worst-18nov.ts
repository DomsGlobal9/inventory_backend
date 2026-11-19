/**
 * Worst cases for what moved to ScaleEzy CRM on 18 Nov 2026, the ones the other suites do not reach:
 *   G  the groups copy: names in Telugu and with an emoji, names that differ only by spaces, the same
 *      customer twice in different letter case, the biggest and one-past-the-biggest version, an empty push
 *      that empties the shop, a one-customer change racing a whole push, a deleted customer, a customer made
 *      after the push.
 *   P  money, end to end: a customer put in VIP by CRM's copy gets the VIP price at the till; taken out by
 *      the next change, the same bill is full price again; a group CRM removed takes its offer price away.
 *   R  the reads with awkward input: codes with spaces, repeats and a trailing comma; a date with no time;
 *      a receipt exactly on the window's edges; a heart on a colour since deleted; a shop with no settings
 *      row; points asked with repeats and capitals; a birthday gift from last year.
 *   C  an older app still open in a browser after the push: its Loyalty screen saving the old wish fields,
 *      its Campaigns screen making one, its group screen adding a member -- each answered in words.
 *
 *   DATABASE_URL=<local> DIRECT_URL=<local> VERIFY_API_URL=http://localhost:4036/api/v1 \
 *   CRM_KEY_DIR=<dir with private.pem> npx tsx src/scripts/verify-crm-worst-18nov.ts
 */
import axios from 'axios';
import fs from 'node:fs';
import jwt from 'jsonwebtoken';
import { prisma } from '../lib/prisma';
import { AuthService } from '../services/auth.service';
import { seedRolesForClient } from '../services/rbac-seed.service';
import { platformAdminService } from '../services/platform-admin.service';
import { quietGroupOf } from '../services/customer-groups';
import { offerService } from '../services/offers/offer.service';
import { pricingQuoteService } from '../services/pricing/quote.service';
import { localDayKey } from '../utils/businessDay';

const BASE = process.env.VERIFY_API_URL || 'http://localhost:4036/api/v1';
const STAMP = Date.now();
const SHOP = `crmworst-${STAMP}`;
const BARE = `crmworst-bare-${STAMP}`;
for (const k of ['DATABASE_URL', 'DIRECT_URL']) {
  if (!/localhost:55433/.test(process.env[k] ?? '')) { console.error(`Refusing: ${k} is not the local database.`); process.exit(2); }
}
if (!/localhost|127\.0\.0\.1/.test(BASE)) { console.error('Refusing: VERIFY_API_URL is not a local server.'); process.exit(2); }

let passed = 0;
const failures: string[] = [];
const check = (name: string, ok: boolean, detail: unknown = '') => {
  if (ok) { passed++; console.log(`  ok   ${name}`); }
  else { failures.push(name); console.log(`  FAIL ${name} :: ${typeof detail === 'string' ? detail : JSON.stringify(detail)?.slice(0, 500)}`); }
};
const brief = (r: any) => `${r?.status} ${JSON.stringify(r?.data).slice(0, 400)}`;
const call = (method: string, path: string, headers: Record<string, string> = {}, data?: any) =>
  axios.request({ method, url: `${BASE}${path}`, headers, data, validateStatus: () => true, timeout: 120_000 });
const privateKey = fs.readFileSync(`${process.env.CRM_KEY_DIR}/private.pem`, 'utf8');
const key = (clientId = SHOP) => ({
  Authorization: `Bearer ${jwt.sign({ sub: 'scaleezy-crm-test', scope: ['modules:crm'], clientId }, privateKey, { algorithm: 'RS256', audience: 'inventory', issuer: 'scaleezy-crm-test', keyid: 'test-1', expiresIn: '5m' })}`
});
const crm = (path: string, shop = SHOP) => `/internal/modules/crm/shops/${shop}${path}`;
const put = (body: any) => call('PUT', crm('/groups/projection'), key(), body);
const patch = (id: string, body: any) => call('PATCH', crm(`/groups/projection/customers/${id}`), key(), body);
let n = 0;
const mkCustomer = (name: string, tags: string[] = [], extra: any = {}) => prisma.customer.create({
  data: { clientId: SHOP, customerCode: `W-${++n}-${STAMP}`, name, phone: `+9195${String(STAMP).slice(-4)}${String(n).padStart(4, '0')}`, tags, ...extra } as any
});
const tagsOf = async (id: string) => JSON.stringify((await prisma.customer.findUniqueOrThrow({ where: { id } })).tags);

async function main() {
  console.log(`SETUP ${SHOP}`);
  const roles = await seedRolesForClient(SHOP);
  await seedRolesForClient(BARE);
  await prisma.clientSettings.create({ data: { clientId: SHOP, businessName: 'Worst Silks', timezone: 'Asia/Kolkata' } as any });
  for (const s of [SHOP, BARE]) {
    // Switching a shop on is CRM's own call, made with its key for no particular shop.
    const anyShop = `Bearer ${jwt.sign({ sub: 'scaleezy-crm-test', scope: ['modules:crm'] }, privateKey, { algorithm: 'RS256', audience: 'inventory', issuer: 'scaleezy-crm-test', keyid: 'test-1', expiresIn: '5m' })}`;
    const on = await call('PUT', `/internal/modules/crm/shops/${s}`, { Authorization: anyShop });
    check(`CRM switched on for ${s === SHOP ? 'the shop' : 'a shop with no settings row'}`, on.status === 200, brief(on));
  }
  const owner = await prisma.user.create({ data: { clientId: SHOP, email: `worst-${STAMP}@example.com`, name: 'Owner', password: 'unused', status: 'ACTIVE' } as any });
  await prisma.userRole.create({ data: { userId: owner.id, roleId: roles.SUPER_ADMIN } });
  const app = { Authorization: `Bearer ${AuthService.generateToken({ userId: owner.id, clientId: SHOP })}` };
  const meena = await mkCustomer('Meena'), ravi = await mkCustomer('Ravi'), gone = await mkCustomer('Gone', ['Old'], { deletedAt: new Date() });

  console.log('\nG. THE GROUPS COPY, AWKWARD');
  let r = await put({ version: 1, groups: [{ name: 'వీఐపీ' }, { name: 'VIP ⭐', noOfferMessages: true }, { name: 'Gold Club' }], members: { [meena.id]: ['వీఐపీ', 'vip ⭐'], [ravi.id]: ['GOLD   club'] } });
  check('a Telugu name and a name with an emoji are kept exactly; members matched whatever the case or the spaces typed', r.status === 200
    && await tagsOf(meena.id) === JSON.stringify(['వీఐపీ', 'VIP ⭐']) && await tagsOf(ravi.id) === '["Gold Club"]', brief(r));
  check('...and the till\'s quiet-group rule finds the emoji group', (await quietGroupOf(SHOP, ['vip ⭐'], 'offers')) === 'VIP ⭐');
  r = await put({ version: 2, groups: [{ name: 'Gold Club' }, { name: 'Gold  Club' }], members: {} });
  check('"Gold Club" and "Gold  Club" (two spaces) are one group: 400, listed twice, nothing applied', r.status === 400 && /twice/.test(r.data?.message) && await tagsOf(ravi.id) === '["Gold Club"]', brief(r));
  r = await put({ version: 2, groups: [{ name: 'Gold Club' }], members: { [meena.id]: ['Gold Club'], [meena.id.toUpperCase()]: [] } });
  check('the same customer twice (once in capitals) with different groups: 400, never "the last one wins"', r.status === 400 && /twice/i.test(r.data?.message) && await tagsOf(meena.id) === JSON.stringify(['వీఐపీ', 'VIP ⭐']), brief(r));
  r = await put({ version: Number.MAX_SAFE_INTEGER - 10, groups: [{ name: 'Gold Club' }, { name: 'VIP' }], members: { [ravi.id]: ['Gold Club'], [meena.id]: ['VIP'] } });
  check('a very big version (2^53 - 11) is taken', r.status === 200 && r.data.data.version === Number.MAX_SAFE_INTEGER - 10, brief(r));
  r = await put({ version: 2 ** 53 + 2, groups: [], members: {} });
  check('...one past the biggest whole number JavaScript can count exactly: 400, nothing applied', r.status === 400 && /version/.test(r.data?.message) && await tagsOf(ravi.id) === '["Gold Club"]', brief(r));
  const v0 = Number.MAX_SAFE_INTEGER - 10;

  // A one-customer change and a whole push racing: the whole push carries the bigger version, so it wins.
  const [pa, pu] = await Promise.all([
    patch(meena.id, { version: v0 + 1, groups: ['Gold Club'] }),
    put({ version: v0 + 2, groups: [{ name: 'Gold Club' }, { name: 'VIP' }], members: { [meena.id]: ['VIP'], [ravi.id]: ['Gold Club'] } })
  ]);
  check(`a one-customer change (v+1) racing a whole push (v+2), answered ${pa.status}/${pu.status}: Meena ends as the whole push says`, pu.status === 200 && await tagsOf(meena.id) === '["VIP"]', { pa: brief(pa), pu: brief(pu) });
  r = await put({ version: v0 + 3, groups: [{ name: 'VIP' }], members: { [gone.id]: ['VIP'], [meena.id]: ['VIP'] } });
  check('a deleted customer listed: reported unknown, keeps what they had', r.status === 200 && r.data.data.unknownCustomers.includes(gone.id) && await tagsOf(gone.id) === '["Old"]', brief(r));
  const late = await mkCustomer('Late comer');
  r = await patch(late.id, { version: v0 + 4, groups: ['VIP'] });
  check('a customer made after the push can be put in a group by a one-customer change', r.status === 200 && await tagsOf(late.id) === '["VIP"]', brief(r));
  r = await put({ version: v0 + 5, groups: [], members: {} });
  check('an EMPTY whole push empties the shop on purpose: no groups, nobody in any, and it says which went', r.status === 200 && JSON.stringify(r.data.data.removedGroups) === '["VIP"]'
    && (await prisma.customerGroup.count({ where: { clientId: SHOP } })) === 0 && await tagsOf(meena.id) === '[]' && await tagsOf(late.id) === '[]' && r.data.data.customersChanged === 2, brief(r));   // Meena and Late comer (Ravi was already in none)

  console.log('\nP. MONEY, END TO END');
  const loc = await prisma.stockLocation.create({ data: { clientId: SHOP, code: `W${STAMP % 10000}`, name: 'Store', type: 'STORE' } as any });
  const prod = await prisma.product.create({ data: { clientId: SHOP, productCode: `WP-${STAMP}`, slug: `wp-${STAMP}`, title: 'Silk', category: 'WOMEN', productType: 'READY_TO_WEAR', basePrice: 1000, status: 'ACTIVE' } as any });
  const v = await prisma.productVariant.create({ data: { clientId: SHOP, productId: prod.id, sku: `WP-S-${STAMP}`, variantCode: `WP-V-${STAMP}`, colorName: 'Red', size: 'Free', sellingPrice: 1000, costPrice: 600, averageCost: 600 } as any });
  await prisma.inventoryStock.create({ data: { clientId: SHOP, variantId: v.id, locationId: loc.id, quantity: 50 } });
  const vipOffer = await offerService.create(SHOP, { name: 'VIP 30%', trigger: 'AUTOMATIC', level: 'LINE', valueType: 'PERCENTAGE', value: 30, scope: 'ALL', customerTags: ['VIP'], startsAt: new Date(Date.now() - 86_400_000) } as any);
  await offerService.setStatus(SHOP, vipOffer.id, 'ACTIVE', 'owner');
  const price = async (customerId: string) => ((await pricingQuoteService.quote(SHOP, { locationId: loc.id, channel: 'POS', lines: [{ variantId: v.id, quantity: 1 }], customerId } as any)) as any).total;
  check('before: Meena is in no group, full price 1,000', await price(meena.id) === 1000, String(await price(meena.id)));
  await put({ version: v0 + 6, groups: [{ name: 'VIP' }], members: { [meena.id]: ['VIP'] } });
  check('CRM puts her in VIP: the till quotes her the VIP price, 700', await price(meena.id) === 700, String(await price(meena.id)));
  await patch(meena.id, { version: v0 + 7, groups: [] });
  check('CRM takes her out: the same bill is full price again, 1,000', await price(meena.id) === 1000, String(await price(meena.id)));
  await patch(meena.id, { version: v0 + 8, groups: ['vip'] });
  await put({ version: v0 + 9, groups: [{ name: 'Gold Club' }], members: { [meena.id]: ['Gold Club'] } });
  check('CRM removes the VIP group itself: nobody gets the VIP price any more', await price(meena.id) === 1000, String(await price(meena.id)));

  console.log('\nR. THE READS, AWKWARD');
  r = await call('GET', crm('/profile', BARE), key(BARE));
  check('the profile of a shop with no settings row: nulls and the default timezone, not an error', r.status === 200 && r.data.data.name === null && r.data.data.phone === null && typeof r.data.data.timezone === 'string', brief(r));
  r = await call('GET', crm(`/shop-link/products?codes=${encodeURIComponent(` ${prod.productCode} ,${prod.productCode},,${v.sku}, `)}`), key());
  check('codes with spaces, a repeat, an empty one and a trailing comma: each real code once', r.status === 200 && JSON.stringify(r.data.data.links.map((x: any) => x.code)) === JSON.stringify([prod.productCode, v.sku]), brief(r));
  const supplier = await prisma.supplier.create({ data: { clientId: SHOP, supplierCode: `WS-${STAMP}`, name: 'Weaver' } as any });
  const po = await prisma.purchaseOrder.create({ data: { clientId: SHOP, poNumber: `WPO-${STAMP}`, supplierId: supplier.id } as any });
  const item = await prisma.purchaseOrderItem.create({ data: { poId: po.id, variantId: v.id, sku: v.sku, variantCode: v.variantCode, productTitle: 'Silk', orderedQty: 2, unitPrice: 600 } as any });
  const edge = new Date(Date.UTC(2026, 10, 10, 0, 0, 0));
  const rc = await prisma.purchaseReceipt.create({ data: { clientId: SHOP, receiptNumber: `WGRN-${STAMP}`, poId: po.id, locationId: loc.id, receivedAt: edge } as any });
  await prisma.purchaseReceiptItem.create({ data: { receiptId: rc.id, poItemId: item.id, variantId: v.id, sku: v.sku, variantCode: v.variantCode, productTitle: 'Silk', orderedQty: 2, receivedBefore: 0, quantity: 2, unitPrice: 600 } as any });
  r = await call('GET', crm('/new-arrivals?from=2026-11-10&to=2026-11-11'), key());
  check('a date with no time ("2026-11-10"): read as that day from midnight UTC, and a receipt exactly at "from" counts', r.status === 200 && r.data.data.pieces.length === 1, brief(r));
  r = await call('GET', crm('/new-arrivals?from=2026-11-09T00:00:00Z&to=2026-11-10T00:00:00Z'), key());
  check('...and exactly at "to" does not (the window is from, up to but not including to)', r.status === 200 && r.data.data.pieces.length === 0, brief(r));
  const vGone = await prisma.productVariant.create({ data: { clientId: SHOP, productId: prod.id, sku: `WP-G-${STAMP}`, variantCode: `WP-VG-${STAMP}`, colorName: 'Blue' } as any });
  await prisma.shopProductView.create({ data: { clientId: SHOP, productId: prod.id, phone: '+919811122233', views: 1, likedAt: new Date(), variantId: vGone.id } as any });
  await prisma.productVariant.delete({ where: { id: vGone.id } });
  r = await call('GET', crm(`/product-likes?productIds=${prod.id}`), key());
  check('a heart on a colour that has since been deleted: still listed, colour null, no error', r.status === 200 && r.data.data.length === 1 && r.data.data[0].colour === null, brief(r));
  await prisma.loyaltySettings.create({ data: { clientId: SHOP, enabled: true, birthdayPoints: 50 } as any });
  const year = Number(localDayKey(new Date(), 'Asia/Kolkata').slice(0, 4));
  await prisma.loyaltyEntry.create({ data: { clientId: SHOP, customerId: ravi.id, kind: 'BIRTHDAY', points: 50, balance: 50, onceKey: `BIRTHDAY:${ravi.id}:${year - 1}`, note: 'Birthday gift', createdAt: new Date(Date.UTC(year - 1, 5, 1)) } as any });
  r = await call('GET', crm(`/customers/points?ids=${encodeURIComponent(`${ravi.id}, ${ravi.id.toUpperCase()},${ravi.id}`)}`), key());
  check('points asked with the same id three times (spaces, capitals): one answer; a gift from LAST year is not this year\'s', r.status === 200 && r.data.data.length === 1 && r.data.data[0].birthdayGift === null && r.data.data[0].giftPoints === 50, brief(r));

  console.log('\nC. AN OLDER APP STILL OPEN AFTER THE PUSH');
  r = await call('PUT', '/loyalty/settings', app, { enabled: true, birthdayWish: false, birthdayText: 'x'.repeat(900), anniversaryWish: false, anniversaryText: 'y', birthdayMediaId: '00000000-0000-4000-8000-000000000001' });
  check('the old Loyalty screen saving its wish fields switched off (even a too-long old text): saved, the wish fields ignored', r.status === 200 && r.data.data?.birthdayWish === false, brief(r));
  r = await call('PUT', '/loyalty/settings', app, { birthdayWish: true });
  check('...switching a wish on there: 400 in words', r.status === 400 && r.data?.message === 'Birthday and anniversary wishes are sent from ScaleEzy CRM now.', brief(r));
  r = await call('POST', '/campaigns', app, { name: 'Diwali', text: 'Hello {name}', audience: {} });
  check('the old Campaigns screen making one: no such address any more (404 in words)', r.status === 404 && r.data?.message === 'There is nothing at this address.', brief(r));
  const raviBefore = await tagsOf(ravi.id);
  r = await call('POST', '/customer-groups/members', app, { group: 'VIP', customerIds: [ravi.id] });
  check('the old group screen adding a member: 409 in words, nothing changed', r.status === 409 && r.data?.message === 'Customer groups are made and changed in ScaleEzy CRM now.' && await tagsOf(ravi.id) === raviBefore, brief(r));
  r = await call('PATCH', `/customers/${ravi.id}`, app, { tags: ['VIP'] });
  check('the old customer page changing groups: 409 in words', r.status === 409 && r.data?.message === 'Customer groups are made and changed in ScaleEzy CRM now.', brief(r));
  r = await call('GET', '/customer-groups', app);
  check('...while the group list it reads still answers', r.status === 200 && Array.isArray(r.data?.data ?? r.data), brief(r));
}

async function cleanup() {
  await prisma.crmGroupProjection.deleteMany({ where: { clientId: { in: [SHOP, BARE] } } });
  await prisma.moduleSubscription.deleteMany({ where: { clientId: { in: [SHOP, BARE] } } });
  await prisma.moduleEvent.deleteMany({ where: { clientId: { in: [SHOP, BARE] } } });
  for (const id of [SHOP, BARE]) await platformAdminService.deleteClientCompletely(id, id).catch((e: any) => { if (!/No such client/.test(e?.message)) console.log('cleanup', id, e?.message); });
  const left = await prisma.customer.count({ where: { clientId: { in: [SHOP, BARE] } } });
  if (left) failures.push(`cleanup left ${left} customers`);
}

main()
  .catch(e => { failures.push(`crashed: ${e?.message}`); console.error(e); })
  .finally(async () => {
    await cleanup().catch(e => { failures.push(`cleanup crashed: ${e?.message}`); console.error(e); });
    console.log(`\nRESULT: ${passed} passed | ${failures.length} failed`);
    if (failures.length) console.log('FAILED: ' + failures.join(' | '));
    await prisma.$disconnect();
    process.exit(failures.length ? 1 : 0);
  });
