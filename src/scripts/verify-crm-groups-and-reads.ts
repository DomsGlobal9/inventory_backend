/**
 * Customer groups owned by ScaleEzy CRM, and what CRM reads instead of Inventory's tables (18 Nov 2026).
 * Real signed service tokens against the real routes, throwaway shops (one with CRM, one without), all
 * removed at the end:
 *   1. the copy: bad bodies refused in words with nothing written; the whole shop applied exactly (groups,
 *      rules, members, spelt as the group is); older or repeated versions refused; one customer at a time;
 *      five pushes at once end in the newest; 5,000 customers at once; offers left aiming at a gone group said.
 *   2. once CRM owns the groups, nothing in Inventory can change them (group screens, CRM's old routes, the
 *      customer form), the till still reads them (quiet rules, names), and Inventory's auto-join does nothing.
 *   3. who may: CRM's key for this shop only; a shop without CRM is not there.
 *   4. the reads: the shop's profile, its online shop, codes -> pages, and the new pieces with stock and photos.
 *
 *   DATABASE_URL=<local> DIRECT_URL=<local> VERIFY_API_URL=http://localhost:4036/api/v1 \
 *   CRM_KEY_DIR=<dir with private.pem> npx tsx src/scripts/verify-crm-groups-and-reads.ts
 */
import axios from 'axios';
import fs from 'node:fs';
import jwt from 'jsonwebtoken';
import { prisma } from '../lib/prisma';
import { seedRolesForClient } from '../services/rbac-seed.service';
import { platformAdminService } from '../services/platform-admin.service';
import { customerGroups, quietGroupOf, groupNamesOf, runGroupAutoJoin } from '../services/customer-groups';
import { customerService } from '../services/customer.service';
import { GROUPS_IN_CRM } from '../services/crm-groups';

const BASE = process.env.VERIFY_API_URL || 'http://localhost:4036/api/v1';
const STAMP = Date.now();
const SHOP = `crmgroups-${STAMP}`;
const OTHER = `crmgroups-other-${STAMP}`;
const FRESH = `crmgroups-fresh-${STAMP}`;
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
  axios.request({ method, url: `${BASE}${path}`, headers, data, validateStatus: () => true, timeout: 180_000, maxBodyLength: Infinity, maxContentLength: Infinity });
const throws = async (fn: () => unknown) => { try { await fn(); return null; } catch (e: any) { return e; } };

const privateKey = fs.readFileSync(`${process.env.CRM_KEY_DIR}/private.pem`, 'utf8');
const tokenFor = (claims: { clientId?: string; userId?: string; scope?: string[] } = {}) => ({
  Authorization: `Bearer ${jwt.sign({
    sub: 'scaleezy-crm-test', scope: claims.scope ?? ['modules:crm'],
    ...(claims.clientId ? { clientId: claims.clientId } : {}),
    ...(claims.userId ? { onBehalfOf: { userId: claims.userId } } : {})
  }, privateKey, { algorithm: 'RS256', audience: 'inventory', issuer: 'scaleezy-crm-test', keyid: 'test-1', expiresIn: '5m' })}`
});
const crm = (path: string, shop = SHOP) => `/internal/modules/crm/shops/${shop}${path}`;
const key = (shop = SHOP) => tokenFor({ clientId: shop });
const put = (body: any, shop = SHOP) => call('PUT', crm('/groups/projection', shop), key(shop), body);
const patch = (customerId: string, body: any, shop = SHOP) => call('PATCH', crm(`/groups/projection/customers/${customerId}`, shop), key(shop), body);

let n = 0;
const mkCustomer = (clientId: string, name: string, tags: string[] = [], extra: any = {}) => prisma.customer.create({
  data: { clientId, customerCode: `G-${++n}-${STAMP}`, name, phone: `+9197${String(STAMP).slice(-4)}${String(n).padStart(4, '0')}`, tags, ...extra } as any
});

async function main() {
  console.log(`SETUP ${SHOP}`);
  for (const s of [SHOP, OTHER, FRESH]) await seedRolesForClient(s);
  for (const s of [SHOP, OTHER, FRESH]) await prisma.clientSettings.create({ data: { clientId: s, businessName: s === SHOP ? 'Group Silks' : 'Other', timezone: 'Asia/Kolkata' } as any });
  for (const s of [SHOP, FRESH]) {
    const on = await call('PUT', `/internal/modules/crm/shops/${s}`, tokenFor());
    check(`CRM switches ${s === SHOP ? 'the shop' : 'a second shop'} on`, on.status === 200, brief(on));
  }
  const asha = await mkCustomer(SHOP, 'Asha', ['VIP']);
  const ravi = await mkCustomer(SHOP, 'Ravi', ['Wholesale']);
  const chitra = await mkCustomer(SHOP, 'Chitra', []);
  const gone = await mkCustomer(SHOP, 'Gone', ['VIP'], { deletedAt: new Date() });
  const theirs = await mkCustomer(OTHER, 'Theirs', ['VIP']);
  await prisma.customerGroup.create({ data: { clientId: SHOP, key: 'vip', name: 'VIP', autoMinSpend: 50000, autoDays: 365 } as any });
  await prisma.customerGroup.create({ data: { clientId: SHOP, key: 'wholesale', name: 'Wholesale' } });
  await prisma.customerGroup.create({ data: { clientId: SHOP, key: 'old', name: 'Old' } });
  await prisma.customerGroup.create({ data: { clientId: OTHER, key: 'vip', name: 'VIP' } });
  await prisma.offer.create({ data: { clientId: SHOP, offerCode: `GRP-${STAMP}`, name: `Old buyers ${STAMP}`, valueType: 'PERCENTAGE', value: 10, startsAt: new Date(), status: 'ACTIVE', customerTags: ['Old'] } as any });
  const roles = await seedRolesForClient(SHOP);
  const owner = await prisma.user.create({ data: { clientId: SHOP, email: `grp-owner-${STAMP}@example.com`, name: 'Owner Gita', password: 'unused', status: 'ACTIVE' } as any });
  await prisma.userRole.create({ data: { userId: owner.id, roleId: roles.SUPER_ADMIN } });

  console.log('\n1. THE COPY');
  r = await call('GET', crm('/groups/projection'), key());
  check('before anything: no copy (the shop\'s groups are still Inventory\'s)', r.status === 200 && r.data.data === null, brief(r));
  const good = { version: 5, groups: [{ key: 'vip', name: 'VIP', noOfferMessages: true, noWishes: false }, { key: 'gold', name: 'Gold', noOfferMessages: false, noWishes: true }], members: {} };
  for (const [what, body, words] of [
    ['no version', { ...good, version: undefined }, /version as a whole number/],
    ['version 0', { ...good, version: 0 }, /version as a whole number/],
    ['version 1.5', { ...good, version: 1.5 }, /version as a whole number/],
    ['version as text', { ...good, version: '6' }, /version as a whole number/],
    ['groups not a list', { ...good, groups: 'VIP' }, /groups as a list/],
    ['a group with no name', { ...good, groups: [{ name: '  ' }] }, /has no name/],
    ['a 41-letter name', { ...good, groups: [{ name: 'x'.repeat(41) }] }, /under 40 characters/],
    ['the same group twice ("Gold" and "gold")', { ...good, groups: [{ name: 'Gold' }, { name: 'gold' }] }, /in the list twice/],
    ['a key that is not the name', { ...good, groups: [{ key: 'silver', name: 'Gold' }] }, /must be its name in small letters/],
    ['noWishes as "yes"', { ...good, groups: [{ name: 'Gold', noWishes: 'yes' }] }, /noWishes of "Gold" as true or false/],
    ['members as a list', { ...good, members: [] }, /members as \{/],
    ['a member id that is not an id', { ...good, members: { 'Asha': ['VIP'] } }, /not a customer id/],
    ['a member put in a group that is not sent', { ...good, members: { [asha.id]: ['Platinum'] } }, /not one of the shop's groups/],
    ['a member in 21 groups', { ...good, groups: Array.from({ length: 21 }, (_, i) => ({ name: `G${i}` })), members: { [asha.id]: Array.from({ length: 21 }, (_, i) => `G${i}`) } }, /more than 20 groups/]
  ] as const) {
    const x = await put(body);
    check(`refused, 400 in words: ${what}`, x.status === 400 && (words as RegExp).test(x.data?.message), brief(x));
  }
  check('...and nothing was written by any of them (no copy, groups and members as they were)', (await prisma.crmGroupProjection.count({ where: { clientId: SHOP } })) === 0
    && (await prisma.customerGroup.count({ where: { clientId: SHOP } })) === 3 && JSON.stringify((await prisma.customer.findUniqueOrThrow({ where: { id: asha.id } })).tags) === '["VIP"]');

  const unknownId = '00000000-0000-4000-8000-0000000000aa';
  r = await put({ ...good, members: { [asha.id.toUpperCase()]: ['vip', 'GOLD'], [chitra.id]: ['Gold'], [theirs.id]: ['VIP'], [unknownId]: ['Gold'] } });
  const d = r.data?.data;
  check('the whole shop, version 5: applied; Wholesale and Old removed; 3 customers changed', r.status === 200 && d.version === 5 && d.groups === 2
    && JSON.stringify([...d.removedGroups].sort()) === '["Old","Wholesale"]' && d.customersChanged === 3, brief(r));
  check('...another shop\'s customer and an unknown id are not touched, and said', JSON.stringify([...d.unknownCustomers].sort()) === JSON.stringify([theirs.id, unknownId].sort()), d?.unknownCustomers);
  check('...the offer still aimed at "Old" is named, so CRM can warn the owner', JSON.stringify(d?.offersStillUsing) === JSON.stringify([`Old buyers ${STAMP}`]), d?.offersStillUsing);
  const groupsNow = await prisma.customerGroup.findMany({ where: { clientId: SHOP }, orderBy: { key: 'asc' } });
  check('the groups are exactly CRM\'s: Gold (no wishes) and VIP (no offer messages), with NO auto-join rule left', groupsNow.length === 2
    && groupsNow[0].name === 'Gold' && groupsNow[0].noWishes && !groupsNow[0].noOfferMessages && groupsNow[1].name === 'VIP' && groupsNow[1].noOfferMessages
    && groupsNow.every(g => g.autoMinSpend === null && g.autoDays === null), groupsNow);
  const tagsOf = async (id: string) => JSON.stringify((await prisma.customer.findUniqueOrThrow({ where: { id } })).tags);
  check('members, spelt as the group is: Asha VIP + Gold, Ravi in none (not listed), Chitra Gold', await tagsOf(asha.id) === '["VIP","Gold"]' && await tagsOf(ravi.id) === '[]' && await tagsOf(chitra.id) === '["Gold"]',
    [await tagsOf(asha.id), await tagsOf(ravi.id), await tagsOf(chitra.id)]);
  check('...a deleted customer and the other shop\'s customer kept what they had', await tagsOf(gone.id) === '["VIP"]' && await tagsOf(theirs.id) === '["VIP"]');
  r = await call('GET', crm('/groups/projection'), key());
  check('the copy says version 5, 2 groups, 4 members sent', r.data?.data?.version === 5 && r.data.data.groups === 2 && r.data.data.members === 4, brief(r));

  for (const v of [5, 4]) {
    const x = await put({ ...good, version: v, members: {} });
    check(`version ${v} again / older: 409, not applied, says the current one`, x.status === 409 && /not newer than the 5/.test(x.data?.message) && x.data?.details?.current === 5, brief(x));
  }
  check('...so Asha is still in her groups (an empty older push did not wipe them)', await tagsOf(asha.id) === '["VIP","Gold"]');
  r = await put({ ...good, version: 6, members: { [asha.id]: ['VIP', 'Gold'], [chitra.id]: ['Gold'] } });
  check('the same state as version 6: applied, nothing written (0 customers changed)', r.status === 200 && r.data.data.customersChanged === 0, brief(r));

  // One customer at a time.
  r = await patch(chitra.id, { version: 7, groups: ['vip'] });
  check('one customer, version 7: Chitra now in VIP only, spelt as the group', r.status === 200 && await tagsOf(chitra.id) === '["VIP"]' && JSON.stringify(r.data.data.groups) === '["VIP"]', brief(r));
  r = await patch(chitra.id, { version: 7, groups: ['Gold'] });
  check('...the same version again: 409, not applied', r.status === 409 && await tagsOf(chitra.id) === '["VIP"]', brief(r));
  r = await patch(chitra.id, { version: 8, groups: ['Platinum'] });
  check('...a group the copy does not have: 400 in words', r.status === 400 && /not one of the shop's groups/.test(r.data?.message), brief(r));
  r = await patch(theirs.id, { version: 9, groups: ['VIP'] });
  check('...another shop\'s customer: 404, and their groups untouched', r.status === 404 && await tagsOf(theirs.id) === '["VIP"]', brief(r));
  r = await patch(chitra.id, { version: 10, groups: [] });
  check('...taken out of every group', r.status === 200 && await tagsOf(chitra.id) === '[]', brief(r));
  r = await put({ ...good, version: 9, members: {} });
  check('a whole-shop push made before that one-customer change (version 9 < 10): 409, never puts back older groups', r.status === 409 && await tagsOf(asha.id) === '["VIP","Gold"]', brief(r));
  r = await patch(asha.id, { version: 1, groups: [] }, FRESH);
  check('one customer before the shop\'s first whole push: 409 "send the whole shop first"', r.status === 409 && /whole shop/.test(r.data?.message), brief(r));

  // Five pushes at once: the newest wins, whatever order they land in.
  const racing = [11, 12, 13, 14, 15].map(v => put({ ...good, version: v, members: { [asha.id]: v === 15 ? ['Gold'] : ['VIP'], [chitra.id]: [v % 2 ? 'Gold' : 'VIP'] } }));
  const raced = await Promise.all(racing);
  const st = (await call('GET', crm('/groups/projection'), key())).data?.data;
  check(`five pushes at once (${raced.map(x => x.status).join(',')}): the copy ends at version 15 with version 15's members`, st?.version === 15 && await tagsOf(asha.id) === '["Gold"]' && await tagsOf(chitra.id) === '["Gold"]'
    && raced.every(x => x.status === 200 || x.status === 409), { st, statuses: raced.map(x => x.status) });

  // A big shop.
  const many = Array.from({ length: 5000 }, (_, i) => ({ clientId: SHOP, customerCode: `BULK-${i}-${STAMP}`, name: `Bulk ${i}`, phone: `+9196${String(STAMP).slice(-3)}${String(i).padStart(5, '0')}` }));
  await prisma.customer.createMany({ data: many as any });
  const bulkIds = (await prisma.customer.findMany({ where: { clientId: SHOP, customerCode: { startsWith: 'BULK-' } }, select: { id: true } })).map(c => c.id);
  const members = Object.fromEntries(bulkIds.map((id, i) => [id, i % 2 ? ['Gold'] : ['VIP', 'Gold']]));
  let t0 = Date.now();
  r = await put({ ...good, version: 20, members });
  check(`5,000 customers in one push (${Math.round(JSON.stringify(members).length / 1024)} KB): applied in ${Date.now() - t0} ms, 5,000 changed (plus Asha and Chitra, now in none)`, r.status === 200 && r.data.data.customersChanged === 5002 && Date.now() - t0 < 60_000, brief(r));
  check('...spot check: the 1st in VIP + Gold, the 2nd in Gold', await tagsOf(bulkIds[0]) === '["VIP","Gold"]' && await tagsOf(bulkIds[1]) === '["Gold"]');
  t0 = Date.now();
  r = await put({ ...good, version: 21, members });
  check(`...the same again as version 21: nothing written, in ${Date.now() - t0} ms`, r.status === 200 && r.data.data.customersChanged === 0, brief(r));
  r = await call('PUT', crm('/groups/projection'), key(), { version: 22, groups: [], members: {}, pad: 'x'.repeat(9 * 1024 * 1024) });
  check('a body over 8 MB: 413 in words, nothing applied', r.status === 413 && /8 MB/.test(r.data?.message) && (await call('GET', crm('/groups/projection'), key())).data?.data?.version === 21, brief(r));

  console.log('\n2. ONCE CRM OWNS THE GROUPS');
  for (const [what, fn] of [
    ['make a group', () => customerGroups.create(SHOP, 'Silver')],
    ['put customers in a group', () => customerGroups.addMembers(SHOP, 'VIP', [ravi.id])],
    ['take one out', () => customerGroups.removeMember(SHOP, 'vip', bulkIds[0])],
    ['rename a group', () => customerGroups.rename(SHOP, 'gold', 'Golden')],
    ['change its rules', () => customerGroups.setRules(SHOP, 'gold', { noWishes: false })],
    ['delete it', () => customerGroups.remove(SHOP, 'gold')]
  ] as const) {
    const e = await throws(fn as () => unknown);
    check(`Inventory cannot ${what}: 409 "${GROUPS_IN_CRM.slice(0, 40)}..."`, e?.statusCode === 409 && e.message === GROUPS_IN_CRM, e?.message);
  }
  const old = await call('POST', crm('/groups'), tokenFor({ clientId: SHOP, userId: owner.id }), { name: 'Silver' });
  check('...nor through CRM\'s old group routes, even for the owner: 409 in the same words', old.status === 409 && old.data?.message === GROUPS_IN_CRM, brief(old));
  const newWithGroup = await throws(() => customerService.createCustomer(SHOP, { name: 'New VIP', phone: '+919811100001', tags: ['VIP'] }));
  check('a new customer made in Inventory with a group: 409 (groups are CRM\'s)', newWithGroup?.statusCode === 409 && newWithGroup.message === GROUPS_IN_CRM, newWithGroup?.message);
  const plainNew: any = await customerService.createCustomer(SHOP, { name: 'New plain', phone: '+919811100002' });
  check('...without a group: made as usual', !!plainNew?.id);
  const sameTags = await throws(() => customerService.updateCustomer(SHOP, bulkIds[0], { name: 'Bulk zero renamed', tags: ['VIP', 'Gold'] }));
  check('editing a customer and sending back the SAME groups (as the form does): saved', sameTags === null && (await prisma.customer.findUniqueOrThrow({ where: { id: bulkIds[0] } })).name === 'Bulk zero renamed', sameTags?.message);
  const changeTags = await throws(() => customerService.updateCustomer(SHOP, bulkIds[0], { tags: ['VIP'] }));
  check('...changing the groups: 409, and they stay', changeTags?.statusCode === 409 && await tagsOf(bulkIds[0]) === '["VIP","Gold"]', changeTags?.message);
  check('the till still reads them: VIP gets no offer messages, Gold no wishes, names spelt as CRM sent', (await quietGroupOf(SHOP, ['vip'], 'offers')) === 'VIP' && (await quietGroupOf(SHOP, ['GOLD'], 'wishes')) === 'Gold'
    && JSON.stringify(await groupNamesOf(SHOP, ['gold', 'vip'])) !== '[]');
  const joined = await runGroupAutoJoin(new Date(), { onlyClients: [SHOP] });
  check('Inventory\'s auto-join does nothing for this shop (the copy carries no rule; CRM runs its own)', joined === 0, joined);
  const otherCreate = await throws(() => customerGroups.create(OTHER, 'Silver'));
  check('a shop whose groups are NOT CRM\'s still makes groups in Inventory as before', otherCreate === null, otherCreate?.message);

  console.log('\n3. WHO MAY');
  r = await call('PUT', crm('/groups/projection'), tokenFor({ clientId: OTHER }), { ...good, version: 99 });
  check('a token for another shop: 403', r.status === 403, brief(r));
  r = await call('PUT', crm('/groups/projection'), tokenFor({ clientId: SHOP, scope: ['session:read'] }), { ...good, version: 99 });
  check('a token without modules:crm: 403', r.status === 403, brief(r));
  r = await put({ ...good, version: 1 }, OTHER);
  check('a shop that has not switched CRM on: 404, nothing made', r.status === 404 && (await prisma.crmGroupProjection.count({ where: { clientId: OTHER } })) === 0, brief(r));

  console.log('\n4. WHAT CRM READS');
  await prisma.clientSettings.update({ where: { clientId: SHOP }, data: { businessPhone: '+91 98450 12345', businessEmail: 'hello@groupsilks.example', businessAddress: '12 Silk St, Mysuru', logoUrl: 'https://example.invalid/logo.png' } as any });
  r = await call('GET', crm('/profile'), key());
  check('the shop\'s profile: exactly name, phone, email, address, logo, timezone', r.status === 200 && JSON.stringify(r.data.data) === JSON.stringify({ name: 'Group Silks', phone: '+91 98450 12345', email: 'hello@groupsilks.example', address: '12 Silk St, Mysuru', logoUrl: 'https://example.invalid/logo.png', timezone: 'Asia/Kolkata' }), brief(r));
  r = await call('GET', crm('/shop-link'), key());
  check('no online shop: null', r.status === 200 && r.data.data === null, brief(r));
  const slug = `gs-${String(STAMP).slice(-8)}`;
  await prisma.onlineShop.create({ data: { clientId: SHOP, slug, isLive: false } as any });
  r = await call('GET', crm('/shop-link'), key());
  const link = r.data?.data;
  check('its online shop: slug, open or not, and its address (or null where pages are not set up)', r.status === 200 && link.slug === slug && link.isLive === false && (link.url === null || link.url.endsWith(`/${slug}`)), brief(r));

  const loc = await prisma.stockLocation.create({ data: { clientId: SHOP, code: `GS${STAMP % 10000}`, name: 'Store', type: 'STORE' } as any });
  const mkPiece = async (title: string, status: string, colour: string, stock: number, firstInDaysAgo: number | null, clientId = SHOP) => {
    const p = await prisma.product.create({ data: { clientId, productCode: `NA-${++n}-${STAMP}`, slug: `na-${n}-${STAMP}`, title, category: 'WOMEN', productType: 'READY_TO_WEAR', basePrice: 1000, status } as any });
    const v = await prisma.productVariant.create({ data: { clientId, productId: p.id, sku: `NA-SKU-${n}-${STAMP}`, variantCode: `NA-V-${n}-${STAMP}`, colorName: colour, size: 'Free', sellingPrice: 2500, createdAt: new Date(Date.now() - 200 * 86400000) } as any });
    if (clientId === SHOP) await prisma.inventoryStock.create({ data: { clientId, variantId: v.id, locationId: loc.id, quantity: stock } });
    if (firstInDaysAgo !== null && clientId === SHOP) {
      await prisma.inventoryTransaction.create({ data: { clientId, variantId: v.id, locationId: loc.id, type: 'IN', reason: 'PURCHASE', quantity: Math.max(stock, 1), balanceBefore: 0, balanceAfter: Math.max(stock, 1), createdAt: new Date(Date.now() - firstInDaysAgo * 86400000) } as any });
    }
    return { p, v };
  };
  const fresh = await mkPiece('Fresh kanchi', 'ACTIVE', 'Red', 4, 2);
  await prisma.productImage.create({ data: { productId: fresh.p.id, url: 'https://example.invalid/p.jpg', imageType: 'GALLERY', orderIndex: 1, isPrimary: false } as any });
  await prisma.productImage.create({ data: { variantId: fresh.v.id, url: 'https://example.invalid/red.jpg', imageType: 'GALLERY', orderIndex: 0, isPrimary: true } as any });
  const soldOut = await mkPiece('Sold out', 'ACTIVE', 'Blue', 0, 1);
  const monthOld = await mkPiece('Month old', 'ACTIVE', 'Green', 3, 30);
  const archived = await mkPiece('Archived new', 'ARCHIVED', 'Gold', 5, 1);
  r = await call('GET', crm('/new-arrivals?days=14'), key());
  const pieces = r.data?.data?.pieces ?? [];
  const f = pieces.find((x: any) => x.variantId === fresh.v.id);
  check('new arrivals (14 days): the fresh piece only (not sold out, not a month old, not archived)', r.status === 200 && pieces.length === 1 && !!f
    && !pieces.some((x: any) => [soldOut.v.id, monthOld.v.id, archived.v.id].includes(x.variantId)), pieces.map((x: any) => x.title));
  check('...with what CRM needs: ids, title, kind, size, colour, price, stock, first in stock 2 days ago', f && f.productId === fresh.p.id && f.title === 'Fresh kanchi' && f.kind === 'WOMEN' && f.size === 'Free' && f.colour === 'Red'
    && f.price === 2500 && f.stock === 4 && Math.abs(Date.now() - new Date(f.firstInStockAt).getTime() - 2 * 86400000) < 3600_000, f);
  check('...and its photos, the colour\'s own first (primary), each with its colour', f && f.photos.length === 2 && f.photos[0].url === 'https://example.invalid/red.jpg' && f.photos[0].colour === 'Red' && f.photos[0].isPrimary && f.photos[1].variantId === null, f?.photos);
  r = await call('GET', crm('/new-arrivals?days=60'), key());
  check('60 days: the month-old piece too, newest first', r.data?.data?.pieces?.map((x: any) => x.title).join() === 'Fresh kanchi,Month old', brief(r));
  for (const q of ['days=0', 'days=91', 'days=abc', 'page=0']) {
    const x = await call('GET', crm(`/new-arrivals?${q}`), key());
    check(`...${q}: 400 in words`, x.status === 400 && /whole number/.test(x.data?.message), brief(x));
  }

  r = await call('GET', crm(`/shop-link/products?codes=${fresh.p.productCode},${fresh.v.sku},${archived.p.productCode},NOPE`), key());
  const ls = r.data?.data?.links ?? [];
  check('codes -> pages while the shop is closed: known codes found, but no url (never link to a closed shop)', r.status === 200 && ls.length === 4 && ls[0].productCode === fresh.p.productCode && ls[1].productCode === fresh.p.productCode && ls.every((x: any) => x.url === null), ls);
  await prisma.onlineShop.update({ where: { clientId: SHOP }, data: { isLive: true } });
  r = await call('GET', crm(`/shop-link/products?codes=${fresh.p.productCode},${fresh.v.sku},${archived.p.productCode},NOPE`), key());
  const ls2 = r.data?.data?.links ?? [];
  const base = r.data?.data?.shop?.url;
  check('...open: the product and its colour\'s SKU open the product page; archived and unknown codes get none', base === null
    ? ls2.every((x: any) => x.url === null)
    : ls2[0].url === `${base}/p/${encodeURIComponent(fresh.p.productCode)}` && ls2[1].url === ls2[0].url && ls2[2].url === null && ls2[3].url === null && ls2[2].productCode === null, ls2);
  r = await call('GET', crm('/shop-link/products'), key());
  check('...no codes: 400 in words', r.status === 400 && /Say which codes/.test(r.data?.message), brief(r));
  r = await call('GET', crm('/profile', OTHER), tokenFor({ clientId: OTHER }));
  check('a shop without CRM: 404 for the reads too', r.status === 404, brief(r));
}

let r: any;
async function cleanup() {
  await prisma.offer.deleteMany({ where: { clientId: SHOP } }).catch(() => {});
  await prisma.crmGroupProjection.deleteMany({ where: { clientId: { in: [SHOP, OTHER, FRESH] } } });
  await prisma.moduleSubscription.deleteMany({ where: { clientId: { in: [SHOP, OTHER, FRESH] } } });
  await prisma.moduleEvent.deleteMany({ where: { clientId: { in: [SHOP, OTHER, FRESH] } } });
  for (const id of [SHOP, OTHER, FRESH]) {
    await platformAdminService.deleteClientCompletely(id, id).catch((e: any) => { if (!/No such client/.test(e?.message)) console.log('cleanup', id, e?.message); });
  }
  const left = await prisma.customer.count({ where: { clientId: { in: [SHOP, OTHER, FRESH] } } });
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
