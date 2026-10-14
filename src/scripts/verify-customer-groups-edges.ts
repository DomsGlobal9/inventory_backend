/**
 * Customer groups, the edge cases: through the real API (sign-ins, permissions, another shop, URL
 * encoding, races, limits) and against the service for spending rules and campaigns.
 *
 *   A  names: spaces, too long, another script, slashes and %, same name in other capitals
 *   B  races: two people make one group, three add one customer at the same moment
 *   C  members: deleted customer, another shop's customer, a customer already in 20 groups, bad lists
 *   D  another shop sees and changes nothing; a role without customer access is refused
 *   E  rename / merge / delete: offers in every state, spelling-only rename keeps offers, merge rules
 *   F  rules: refused in words, off again, on a group that does not exist
 *   G  join by spending: cancelled, deleted, old and shared walk-in sales do not count; the exact amount does
 *   H  WhatsApp: a quiet group wins over another group; wishes vs offers; the points reminder; Start says why
 *
 * Needs the local backend on 4006. Shops: two demo help-shops (test data) and throwaway ids for G/H,
 * which have no WhatsApp number, so nothing prepared can ever be sent. Everything made is deleted.
 *
 *   npx tsx src/scripts/verify-customer-groups-edges.ts
 */
import { prisma } from '../lib/prisma';
import { AuthService } from '../services/auth.service';
import { customerGroups, runGroupAutoJoin } from '../services/customer-groups';
import { preview } from '../services/campaigns/audience';
import { prepareShopDay } from '../services/campaigns';
import * as campaignService from '../services/campaigns/campaign.service';
import { localDayKey } from '../utils/businessDay';

const API = process.env.API_URL || 'http://localhost:4006/api/v1';
const A = 'lakshmi-silks-demo-helpshop-1791264977589';
const B = 'lakshmi-silks-demo-helpshop-1791263421564';
const T = `groups-edge-${Date.now()}`;            // throwaway shop for G and H
const PREFIX = 'Edge Groups';
const GROUPS = ['Edge Gold', 'ఎడ్జ్ వీఐపీ', 'Edge/Slash %50', 'Edge Race', 'Edge Silver', 'Edge Merge From', 'Edge Merge Into', 'Edge Ruled'];

let passed = 0, failed = 0;
const check = (name: string, ok: boolean, detail?: unknown) => {
  if (ok) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name}${detail !== undefined ? ` -- ${JSON.stringify(detail).slice(0, 400)}` : ''}`); }
};
const enc = encodeURIComponent;
const lc = (s: string) => s.toLowerCase();

async function tokenFor(clientId: string, role: string) {
  const u = await prisma.user.findFirst({ where: { clientId, status: 'ACTIVE', roles: { some: { role: { name: role } } } }, select: { id: true, sessionVersion: true } });
  if (!u) throw new Error(`No ${role} in ${clientId}`);
  return AuthService.generateToken({ userId: u.id, clientId, sessionVersion: u.sessionVersion });
}
function client(token: string) {
  const call = async (method: string, path: string, body?: unknown) => {
    const r = await fetch(API + path, { method, headers: { 'content-type': 'application/json', cookie: `token=${token}` }, body: body === undefined ? undefined : JSON.stringify(body) });
    const j: any = await r.json().catch(() => ({}));
    return { status: r.status, data: j?.data, message: j?.message ?? j?.error ?? '' };
  };
  return { get: (p: string) => call('GET', p), post: (p: string, b?: unknown) => call('POST', p, b ?? {}), patch: (p: string, b: unknown) => call('PATCH', p, b), del: (p: string) => call('DELETE', p) };
}
const tagsOf = async (id: string) => (await prisma.customer.findUnique({ where: { id }, select: { tags: true } }))?.tags ?? [];

async function main() {
  const owner = client(await tokenFor(A, 'SUPER_ADMIN'));
  const warehouse = client(await tokenFor(A, 'WAREHOUSE'));
  const otherShop = client(await tokenFor(B, 'SUPER_ADMIN'));
  const mk = (clientId: string, n: string, extra: any = {}) => prisma.customer.create({
    data: { clientId, customerCode: `EDG-${Date.now() % 1e7}-${n}`, name: `${PREFIX} ${n}`, ...extra }
  });
  const c1 = await mk(A, '1'), c2 = await mk(A, '2'), c3 = await mk(A, '3');
  const gone = await mk(A, 'deleted', { deletedAt: new Date() });
  const crowded = await mk(A, 'crowded', { tags: Array.from({ length: 20 }, (_, i) => `Edge Filler ${i}`) });
  const foreign = await mk(B, 'other shop');

  console.log('\nA. NAMES');
  let r = await owner.post('/customer-groups', { name: '   Edge    Gold  ' });
  check('spaces are tidied: "   Edge    Gold  " is made as "Edge Gold"', r.status === 200 && r.data?.name === 'Edge Gold' && r.data?.key === 'edge gold', r);
  r = await owner.post('/customer-groups', { name: 'EDGE GOLD' });
  check('the same name in other capitals is refused: already a group', r.status === 409 && /already a group called/.test(r.message), r);
  r = await owner.post('/customer-groups', { name: 'x'.repeat(41) });
  check('41 characters is refused in words', r.status === 400 && /under 40/.test(r.message), r);
  r = await owner.post('/customer-groups', { name: '   ' });
  check('a blank name is refused in words', r.status === 400 && /name/.test(r.message), r);
  r = await owner.post('/customer-groups', { name: 'ఎడ్జ్ వీఐపీ' });
  check('a Telugu name works', r.status === 200, r);
  r = await owner.post('/customer-groups/members', { group: 'ఎడ్జ్ వీఐపీ', customerIds: [c1.id] });
  check('...and takes members', r.data?.added === 1, r);
  r = await owner.get(`/customer-groups/${enc(lc('ఎడ్జ్ వీఐపీ'))}/members`);
  check('...and its members can be read back by its address', r.status === 200 && r.data?.members?.length === 1, r);
  r = await owner.post('/customer-groups', { name: 'Edge/Slash %50' });
  const slash = enc('edge/slash %50');
  check('a name with / and % is made', r.status === 200, r);
  r = await owner.post('/customer-groups/members', { group: 'Edge/Slash %50', customerIds: [c2.id] });
  r = await owner.patch(`/customer-groups/${slash}/rules`, { noOfferMessages: true });
  check('...its rules can be set through the address (/ and % encoded)', r.status === 200 && r.data?.noOfferMessages === true, r);
  r = await owner.get(`/customer-groups/${slash}/members`);
  check('...its members are read', r.status === 200 && r.data?.members?.[0]?.id === c2.id, r);
  r = await owner.post(`/customer-groups/${slash}/rename`, { name: 'Edge Silver' });
  check('...it can be renamed', r.status === 200 && r.data?.key === 'edge silver', r);
  check('...and the member carries the new name', (await tagsOf(c2.id)).includes('Edge Silver') && !(await tagsOf(c2.id)).includes('Edge/Slash %50'));
  check('...and its rule moved with it', (await prisma.customerGroup.findFirst({ where: { clientId: A, key: 'edge silver' } }))?.noOfferMessages === true);
  const xss = await owner.post('/customer-groups', { name: '<img src=x onerror=alert(1)>' });
  check('a name that looks like HTML is just text: kept exactly, shown escaped on screen', xss.status === 200 && xss.data?.name === '<img src=x onerror=alert(1)>', xss);
  if (xss.status === 200) await owner.del(`/customer-groups/${enc(xss.data.key)}`);

  console.log('\nB. RACES');
  const both = await Promise.all([owner.post('/customer-groups', { name: 'Edge Race' }), owner.post('/customer-groups', { name: 'edge race' })]);
  check('two people make the same group at once: one succeeds, the other is told in words (no server error)',
    both.map(x => x.status).sort().join() === '200,409' && both.some(x => /already a group/.test(x.message)), both);
  const three = await Promise.all([1, 2, 3].map(() => owner.post('/customer-groups/members', { group: 'Edge Race', customerIds: [c3.id] })));
  const raceTags = (await tagsOf(c3.id)).filter(t => lc(t) === 'edge race');
  check('three add one customer at the same moment: they are in the group exactly once', raceTags.length === 1 && three.reduce((a, x) => a + (x.data?.added ?? 0), 0) === 1, { raceTags, three });

  console.log('\nC. MEMBERS');
  r = await owner.post('/customer-groups/members', { group: 'Edge Gold', customerIds: [c1.id, c1.id, gone.id, foreign.id, crowded.id] });
  check('a list with a repeat, a deleted customer, another shop\'s customer and a full one adds just 1',
    r.data?.added === 1 && r.data?.notFound === 2 && r.data?.full === 1 && r.data?.alreadyIn === 0, r.data);
  check('...the other shop\'s customer is untouched', (await tagsOf(foreign.id)).length === 0);
  check('...the deleted customer is untouched', (await tagsOf(gone.id)).length === 0);
  check('...the full customer still has exactly 20 groups', (await tagsOf(crowded.id)).length === 20);
  r = await owner.post('/customer-groups/members', { group: 'Edge Gold', customerIds: [c1.id] });
  check('adding someone already in it says so (alreadyIn 1, added 0)', r.data?.added === 0 && r.data?.alreadyIn === 1, r.data);
  await prisma.customer.update({ where: { id: c2.id }, data: { tags: { push: 'edge gold' } } });   // as the customer-page card would, other spelling
  r = await owner.get('/customer-groups');
  const gold = (r.data as any[]).find(g => g.key === 'edge gold');
  check('a spelling typed on the customer page joins the same group (count 2, one row)', gold?.count === 2 && (r.data as any[]).filter(g => g.key === 'edge gold').length === 1, gold);
  await prisma.customer.update({ where: { id: gone.id }, data: { tags: ['Edge Gold'] } });
  r = await owner.get('/customer-groups');
  check('a deleted customer is not counted', (r.data as any[]).find(g => g.key === 'edge gold')?.count === 2);
  r = await owner.get(`/customer-groups/${enc('edge gold')}/members`);
  check('...nor listed as a member', !(r.data?.members ?? []).some((m: any) => m.id === gone.id), r.data);
  for (const bad of [[], 'abc', [1, 2], Array.from({ length: 501 }, (_, i) => `id-${i}`)]) {
    r = await owner.post('/customer-groups/members', { group: 'Edge Gold', customerIds: bad });
    check(`a bad customer list (${Array.isArray(bad) ? `${bad.length} items` : typeof bad}) is refused in words`, r.status === 400 && /Choose the customers|at most 500/.test(r.message), r);
  }
  r = await owner.del(`/customer-groups/${enc('edge gold')}/members/${c3.id}`);
  check('taking out someone who is not in the group says so (404 in words)', r.status === 404 && /not in this group/.test(r.message), r);
  const listRes = await fetch(`${API}/customers?group=${enc('EDGE GOLD')}`, { headers: { cookie: `token=${await tokenFor(A, 'SUPER_ADMIN')}` } }).then(x => x.json());
  check('the customers list filter finds both spellings, whatever capitals are asked', Array.isArray(listRes) && listRes.length === 2, Array.isArray(listRes) ? listRes.map((c: any) => c.name) : listRes);
  const none = await fetch(`${API}/customers?group=${enc('No Such Group')}`, { headers: { cookie: `token=${await tokenFor(A, 'SUPER_ADMIN')}` } }).then(x => x.json());
  check('a group that does not exist shows nobody (not everybody)', Array.isArray(none) && none.length === 0, Array.isArray(none) ? none.length : none);

  console.log('\nD. OTHER SHOPS AND PERMISSIONS');
  r = await otherShop.get('/customer-groups');
  check('another shop does not see these groups', !(r.data as any[]).some(g => g.key.startsWith('edge')), r.data?.map?.((g: any) => g.key));
  r = await otherShop.get(`/customer-groups/${enc('edge gold')}/members`);
  check('...cannot read their members (404)', r.status === 404, r);
  r = await otherShop.post(`/customer-groups/${enc('edge gold')}/rename`, { name: 'Hijacked' });
  check('...cannot rename (404)', r.status === 404, r);
  r = await otherShop.patch(`/customer-groups/${enc('edge gold')}/rules`, { noOfferMessages: true });
  check('...cannot set its rules (404)', r.status === 404, r);
  r = await otherShop.del(`/customer-groups/${enc('edge gold')}`);
  check('...cannot delete (404)', r.status === 404, r);
  r = await otherShop.post('/customer-groups/members', { group: 'Edge Gold', customerIds: [c3.id] });
  check('...adding our customer from there adds nobody', r.data?.added === 0 && r.data?.notFound === 1 && !(await tagsOf(c3.id)).some(t => lc(t) === 'edge gold'), r.data);
  check('...and made no "Edge Gold" in that shop', !(await prisma.customer.findMany({ where: { clientId: B }, select: { tags: true } })).some(c => c.tags.some(t => lc(t) === 'edge gold')));
  r = await warehouse.get('/customer-groups');
  check('a Warehouse person (no customer access) cannot list groups (403)', r.status === 403, r.status);
  r = await warehouse.post('/customer-groups', { name: 'Edge Sneaky' });
  check('...nor make one (403)', r.status === 403, r.status);
  r = await warehouse.patch(`/customer-groups/${enc('edge gold')}/rules`, { noOfferMessages: true });
  check('...nor change who gets WhatsApp messages (403)', r.status === 403, r.status);

  console.log('\nE. RENAME, MERGE, DELETE AGAINST OFFERS');
  const offer = (status: string, tags: string[]) => prisma.offer.create({ data: { clientId: A, offerCode: `EDG-${status}-${Date.now() % 1e7}`, name: `Edge offer ${status}`, valueType: 'PERCENTAGE', value: 5, startsAt: new Date(), status, customerTags: tags } as any });
  const madeOffers: string[] = [];
  for (const status of ['DRAFT', 'PAUSED', 'EXPIRED']) {
    const o = await offer(status, ['edge gold']);
    madeOffers.push(o.id);
    r = await owner.del(`/customer-groups/${enc('edge gold')}`);
    check(`an offer that is ${status} (spelt "edge gold") blocks deleting "Edge Gold", named in words`, r.status === 409 && r.message.includes(`Edge offer ${status}`), r);
    await prisma.offer.update({ where: { id: o.id }, data: { status: 'ARCHIVED' } });
  }
  const live = await offer('ACTIVE', ['Edge Gold', 'Somebody Else']);
  madeOffers.push(live.id);
  r = await owner.post(`/customer-groups/${enc('edge gold')}/rename`, { name: 'EDGE GOLD' });
  const liveNow = await prisma.offer.findUnique({ where: { id: live.id }, select: { customerTags: true, status: true } });
  check('a spelling-only rename is allowed even with a live offer, and the offer follows the spelling', r.status === 200 && JSON.stringify(liveNow?.customerTags) === '["EDGE GOLD","Somebody Else"]' && liveNow?.status === 'ACTIVE', { r, liveNow });
  r = await owner.post(`/customer-groups/${enc('edge gold')}/rename`, { name: 'Edge Platinum' });
  check('renaming it to a new name is refused while the live offer needs it', r.status === 409 && /Edge offer ACTIVE/.test(r.message), r);
  r = await owner.post(`/customer-groups/${enc('edge gold')}/merge`, { into: 'Edge Silver' });
  check('merging it is refused too', r.status === 409 && /Edge offer ACTIVE/.test(r.message), r);
  r = await owner.post(`/customer-groups/${enc('edge gold')}/merge`, { into: 'No Such Group' });
  check('merging into a group that does not exist is refused in words', r.status === 404 && /no group called/i.test(r.message), r);
  await owner.post('/customer-groups', { name: 'Edge Merge From' });
  await owner.post('/customer-groups', { name: 'Edge Merge Into' });
  await owner.patch(`/customer-groups/${enc('edge merge from')}/rules`, { noOfferMessages: true, noWishes: true });
  await owner.post('/customer-groups/members', { group: 'Edge Merge From', customerIds: [c1.id, c3.id] });
  await owner.post('/customer-groups/members', { group: 'Edge Merge Into', customerIds: [c1.id] });
  r = await owner.post(`/customer-groups/${enc('edge merge from')}/merge`, { into: 'edge merge into' });
  const into = await prisma.customerGroup.findFirst({ where: { clientId: A, key: 'edge merge into' } });
  check('merge into an existing group (asked in other capitals) works', r.status === 200 && r.data?.name === 'Edge Merge Into', r);
  check('...the group merged INTO keeps its own rules (none), not the merged one\'s', into?.noOfferMessages === false && into?.noWishes === false, into);
  check('...a customer in both is in it once', (await tagsOf(c1.id)).filter(t => lc(t) === 'edge merge into').length === 1 && !(await tagsOf(c1.id)).some(t => lc(t) === 'edge merge from'));
  check('...the merged group is gone', !(await owner.get('/customer-groups')).data.some((g: any) => g.key === 'edge merge from'));
  r = await owner.post(`/customer-groups/${enc('edge merge into')}/rename`, { name: 'Edge Silver' });
  check('renaming onto an existing group points to Merge', r.status === 409 && /Merge/.test(r.message), r);

  console.log('\nF. RULES');
  for (const [body, why] of [
    [{ autoMinSpend: 1000 }, 'only the amount'],
    [{ autoMinSpend: 1000, autoDays: 0 }, '0 days'],
    [{ autoMinSpend: 1000, autoDays: 3651 }, '3651 days'],
    [{ autoMinSpend: 1000, autoDays: 1.5 }, '1.5 days'],
    [{ autoMinSpend: -5, autoDays: 30 }, 'a negative amount'],
    [{ autoMinSpend: 'lots', autoDays: 30 }, 'words for an amount']
  ] as const) {
    r = await owner.patch(`/customer-groups/${enc('edge silver')}/rules`, body);
    check(`a spending rule with ${why} is refused in words`, r.status === 400 && /rupees|days/.test(r.message), r);
  }
  r = await owner.patch(`/customer-groups/${enc('no such group')}/rules`, { noOfferMessages: true });
  check('rules for a group that does not exist: 404', r.status === 404, r);
  r = await owner.patch(`/customer-groups/${enc('edge silver')}/rules`, { noOfferMessages: 'yes' });
  check('"yes" is not true: only a real true switches it on', r.status === 200 && r.data?.noOfferMessages === false, r.data);
  const two = await Promise.all([owner.patch(`/customer-groups/${enc('edge race')}/rules`, { noOfferMessages: true }), owner.patch(`/customer-groups/${enc('edge race')}/rules`, { noWishes: true })]);
  const race = await prisma.customerGroup.findFirst({ where: { clientId: A, key: 'edge race' } });
  check('two rules saved at the same moment: both stick', two.every(x => x.status === 200) && race?.noOfferMessages === true && race?.noWishes === true, { two: two.map(x => x.status), race });

  console.log('\nG. JOIN BY SPENDING (throwaway shop)');
  const loc = await prisma.stockLocation.create({ data: { clientId: T, code: 'E1', name: 'Edge store', type: 'STORE' } as any });
  const tc = (n: string, extra: any = {}) => prisma.customer.create({ data: { clientId: T, customerCode: `T-${n}`, name: n, phone: `+91910000${String(Math.random()).slice(2, 6)}`, whatsappOffers: true, ...extra } });
  const exact = await tc('Exactly 50k');
  const cancelled = await tc('Cancelled order');
  const deletedOrder = await tc('Deleted order');
  const oldBuyer = await tc('Bought long ago');
  const inactive = await tc('Inactive', { status: 'INACTIVE' });
  const deletedCust = await tc('Deleted customer', { deletedAt: new Date() });
  const walkIn = await tc('Walk-in customer (no details taken)', { phone: null, externalCustomerId: 'POS:WALK-IN' });
  const guest = await tc('Online guest', { phone: null, externalCustomerId: 'shopify:guest' });
  const full = await tc('Full', { tags: Array.from({ length: 20 }, (_, i) => `F${i}`) });
  let n = 0;
  const order = (customerId: string, total: number, extra: any = {}) => prisma.salesOrder.create({ data: { clientId: T, customerId, locationId: loc.id, orderNumber: `T-${++n}`, total, ...extra } as any });
  await order(exact.id, 20000); await order(exact.id, 30000);
  await order(cancelled.id, 90000, { status: 'CANCELLED' });
  await order(deletedOrder.id, 90000, { deletedAt: new Date() });
  await order(oldBuyer.id, 90000, { createdAt: new Date(Date.now() - 40 * 86_400_000) });
  await order(inactive.id, 90000);
  await order(deletedCust.id, 90000);
  await order(walkIn.id, 500000);
  await order(guest.id, 500000);
  await order(full.id, 90000);
  await customerGroups.create(T, 'VIP');
  const res = await customerGroups.setRules(T, 'vip', { autoMinSpend: 50000, autoDays: 30 });
  const inVip = (await prisma.customer.findMany({ where: { clientId: T, tags: { has: 'VIP' } }, select: { name: true } })).map(c => c.name);
  check('exactly the amount counts; cancelled, deleted, older, inactive, deleted-customer, walk-in, guest and full do not', JSON.stringify(inVip) === '["Exactly 50k"]' && res.joined === 1, { inVip, joined: res.joined });
  check('the shared walk-in row is never made a VIP, whatever it "spent"', !(await tagsOf(walkIn.id)).length && !(await tagsOf(guest.id)).length);
  check('the full customer was skipped without an error, still at 20', (await tagsOf(full.id)).length === 20);
  await prisma.customer.update({ where: { id: exact.id }, data: { tags: [] } });
  check('taken out by hand, the hourly run puts them back while they still qualify (the rule is the rule)', (await runGroupAutoJoin(new Date(), { onlyClients: [T] })) === 1);

  console.log('\nH. WHATSAPP RULES (throwaway shop)');
  const today = localDayKey(new Date(), 'Asia/Kolkata').slice(5);
  const vipAndWholesale = await tc('VIP and Wholesale', { tags: ['VIP', 'Wholesale'], birthday: today, loyaltyPoints: 100 });
  const wholesale = await tc('Wholesale only', { tags: ['Wholesale'], birthday: today, loyaltyPoints: 100 });
  await customerGroups.setRules(T, 'vip', { autoMinSpend: null, autoDays: null, noOfferMessages: true });
  let pv = await preview(T, { tags: ['Wholesale'] });
  check('in a quiet group AND another one: the quiet group wins, a Wholesale campaign leaves them out', pv.count === 1 && pv.breakdown.inQuietGroup === 1, pv.breakdown);
  await prisma.loyaltySettings.create({ data: { clientId: T, birthdayWish: true, enabled: true, expiryReminder: true, expiryMonths: 1 } as any });
  // Their points lapse in exactly 7 days: last active one month minus seven days ago.
  const lapse = new Date(Date.now() + 7 * 86_400_000); lapse.setMonth(lapse.getMonth() - 1);
  await prisma.customer.updateMany({ where: { id: { in: [vipAndWholesale.id, wholesale.id] } }, data: { loyaltyActiveAt: new Date(lapse.getTime() + 3600_000) } });
  await prepareShopDay(T, new Date(), { ignoreHours: true });
  const lot = async (source: string) => ((await prisma.campaign.findFirst({ where: { clientId: T, source }, include: { recipients: { select: { customerId: true } } } as any })) as any)?.recipients?.map((x: any) => x.customerId) ?? [];
  const wishes = await lot('BIRTHDAY'), reminder = await lot('POINTS_EXPIRING');
  check('"No offer messages" alone: the VIP still gets the birthday wish', wishes.includes(vipAndWholesale.id) && wishes.includes(wholesale.id), wishes);
  check('...but not the points-expiry reminder (that is an offer message)', reminder.includes(wholesale.id) && !reminder.includes(vipAndWholesale.id), reminder);
  const actor = { id: 'edge-test', clientId: T, roles: ['SUPER_ADMIN'], permissions: ['*'] };
  const draft: any = await campaignService.create(actor as any, { name: 'Edge VIP only', text: 'Hello {name}', audience: { tags: ['VIP'] } });
  const err = await campaignService.start(actor as any, draft.id ?? draft?.data?.id).then(() => '', (e: any) => String(e?.message));
  check('starting a campaign whose only people are in a quiet group says that is why', /No offer messages/.test(err), err);
  await customerGroups.setRules(T, 'vip', { noOfferMessages: false });
  pv = await preview(T, { tags: ['VIP'] });
  check('switching the rule off lets them back in at once (both VIPs: the one joined by spending too)', pv.count === 2 && pv.breakdown.inQuietGroup === 0, pv.breakdown);
}

main()
  .catch(e => { failed++; console.error(e); })
  .finally(async () => {
    const ids = (await prisma.customer.findMany({ where: { name: { startsWith: PREFIX }, clientId: { in: [A, B] } }, select: { id: true } })).map(c => c.id);
    await prisma.offer.deleteMany({ where: { clientId: A, name: { startsWith: 'Edge offer' } } });
    await prisma.customer.deleteMany({ where: { id: { in: ids } } });
    await prisma.customerGroup.deleteMany({ where: { clientId: { in: [A, B] }, OR: [{ key: { startsWith: 'edge' } }, { key: { in: GROUPS.map(lc) } }] } });
    const camps = await prisma.campaign.findMany({ where: { clientId: T }, select: { id: true } });
    await prisma.campaignRecipient.deleteMany({ where: { campaignId: { in: camps.map(c => c.id) } } });
    await prisma.campaign.deleteMany({ where: { clientId: T } });
    await prisma.salesOrder.deleteMany({ where: { clientId: T } });
    await prisma.loyaltySettings.deleteMany({ where: { clientId: T } });
    await prisma.customerGroup.deleteMany({ where: { clientId: T } });
    await prisma.customer.deleteMany({ where: { clientId: T } });
    await prisma.stockLocation.deleteMany({ where: { clientId: T } });
    console.log(`\n${passed} passed, ${failed} failed`);
    await prisma.$disconnect();
    process.exit(failed ? 1 : 0);
  });
