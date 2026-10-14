/**
 * Customer groups: managing members, rename / merge / delete (and when they are refused), the
 * WhatsApp rules -- campaigns, the points reminder and wishes skip quiet groups -- and auto-join by
 * spend.
 *
 * Runs on a throwaway shop id with no WhatsApp number, so nothing it prepares can ever be sent (the
 * sender waits for a connected number). Deletes everything it made.
 *
 *   npx tsx src/scripts/verify-customer-groups.ts
 */
import { prisma } from '../lib/prisma';
import { customerGroups, quietGroupOf, runGroupAutoJoin } from '../services/customer-groups';
import { preview } from '../services/campaigns/audience';
import { prepareShopDay } from '../services/campaigns';
import { customerService } from '../services/customer.service';
import { localDayKey } from '../utils/businessDay';

let passed = 0, failed = 0;
const check = (name: string, ok: boolean, detail?: unknown) => {
  if (ok) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name}${detail !== undefined ? ` -- ${JSON.stringify(detail)}` : ''}`); }
};
const C = `groups-test-${Date.now()}`;
const refused = async (p: Promise<unknown>) => { try { await p; return ''; } catch (e: any) { return String(e?.message ?? e); } };

async function main() {
  const today = localDayKey(new Date(), 'Asia/Kolkata').slice(5);   // MM-DD
  const mk = (n: number, name: string, tags: string[], extra: any = {}) => prisma.customer.create({
    data: { clientId: C, customerCode: `CUS-${n}`, name, phone: `+9190000000${n}`, tags, whatsappOffers: true, birthday: today, ...extra }
  });
  const meena = await mk(1, 'Meena', ['vip']);
  const ravi = await mk(2, 'Ravi', ['VIP', 'Staff']);
  const anu = await mk(3, 'Anu', []);
  const old = await mk(4, 'Old customer', ['Wholesale'], { loyaltyPoints: 50 });

  console.log('\nA. LIST AND MEMBERS');
  let list = await customerGroups.list(C);
  const vip = list.find(g => g.key === 'vip');
  check('"vip" and "VIP" are one group of 2', vip?.count === 2, list);
  check('3 groups in all (VIP, Staff, Wholesale)', list.length === 3, list.map(g => g.name));
  const m = await customerGroups.members(C, 'vip');
  check('members of VIP: Meena and Ravi', m.members.map(x => x.name).join(',') === 'Meena,Ravi', m);

  console.log('\nB. ADD, REMOVE, FILTER');
  const add = await customerGroups.addMembers(C, 'VIP', [anu.id, meena.id]);
  check('adding Anu and Meena adds 1 (Meena already in, any spelling)', add.added === 1, add);
  const filtered = await customerService.getCustomers(C, { group: 'Vip' });
  check('the customers list filter finds all 3, whatever the spelling asked', filtered.length === 3, filtered.map((c: any) => c.name));
  await customerGroups.removeMember(C, 'vip', anu.id);
  const anuNow = await prisma.customer.findUnique({ where: { id: anu.id }, select: { tags: true } });
  check('removing Anu leaves her with no groups', anuNow?.tags.length === 0, anuNow);
  const fresh = await customerGroups.addMembers(C, 'Festival list', [anu.id]);
  check('adding to a group that does not exist yet makes it', fresh.added === 1 && (await customerGroups.list(C)).some(g => g.name === 'Festival list'));
  check('an empty group name is refused in words', /name/.test(await refused(customerGroups.addMembers(C, '  ', [anu.id]))));

  console.log('\nC. RENAME, MERGE, DELETE');
  await customerGroups.rename(C, 'vip', 'VIP');
  const spellings = await prisma.customer.findMany({ where: { clientId: C, id: { in: [meena.id, ravi.id] } }, select: { tags: true } });
  check('a spelling-only rename makes every member say "VIP"', spellings.every(s => s.tags.includes('VIP') && !s.tags.includes('vip')), spellings);
  check('renaming onto an existing group is refused, pointing to Merge', /Merge/.test(await refused(customerGroups.rename(C, 'staff', 'VIP'))));
  const offer = await prisma.offer.create({ data: { clientId: C, offerCode: `OFF-${Date.now()}`, name: 'Staff 20%', valueType: 'PERCENTAGE', value: 20, startsAt: new Date(), status: 'ACTIVE', customerTags: ['Staff'] } as any });
  check('merging a group a live offer is only for is refused, naming the offer', /Staff 20%/.test(await refused(customerGroups.rename(C, 'staff', 'VIP', { merge: true }))));
  check('deleting it is refused too', /Staff 20%/.test(await refused(customerGroups.remove(C, 'staff'))));
  await prisma.offer.update({ where: { id: offer.id }, data: { status: 'ARCHIVED' } });
  await customerGroups.rename(C, 'staff', 'VIP', { merge: true });
  const raviNow = await prisma.customer.findUnique({ where: { id: ravi.id }, select: { tags: true } });
  check('after archiving, merge works: Ravi is in VIP once, Staff gone', JSON.stringify(raviNow?.tags) === '["VIP"]', raviNow);
  const del = await customerGroups.remove(C, 'festival list');
  check('delete removes the group from its members', del.removedFrom === 1 && !(await customerGroups.list(C)).some(g => g.key === 'festival list'), del);

  console.log('\nD. WHATSAPP RULES');
  await customerGroups.setRules(C, 'vip', { noOfferMessages: true });
  const p = await preview(C, {});
  check('a campaign to everyone leaves out the 2 VIPs: reaches 2 (Anu, Old customer)', p.count === 2, p);
  check('the dry run says why: 2 in a group with no offer messages', p.breakdown.inQuietGroup === 2, p.breakdown);
  const vipOnly = await preview(C, { tags: ['VIP'] });
  check('a campaign only to VIP reaches nobody', vipOnly.count === 0 && vipOnly.breakdown.inQuietGroup === 2, vipOnly.breakdown);
  check('the sender would skip Meena, naming the group', (await quietGroupOf(C, ['VIP'], 'offers')) === 'VIP');
  check('...but her birthday wish still goes (no "no wishes" rule yet)', (await quietGroupOf(C, ['VIP'], 'wishes')) === null);

  await customerGroups.setRules(C, 'vip', { noWishes: true });
  await prisma.loyaltySettings.create({ data: { clientId: C, birthdayWish: true } as any });
  const day = await prepareShopDay(C, new Date(), { ignoreHours: true });
  const wish = await prisma.campaign.findFirst({ where: { clientId: C, source: 'BIRTHDAY' }, include: { recipients: { select: { customerId: true } } } as any }) as any;
  const got = (wish?.recipients ?? []).map((r: any) => r.customerId).sort();
  check('the day\'s birthday wishes go to Anu and Old customer, not the VIPs', JSON.stringify(got) === JSON.stringify([anu.id, old.id].sort()), { day, got });

  console.log('\nE. AUTO-JOIN BY SPEND');
  const loc = await prisma.stockLocation.create({ data: { clientId: C, code: 'T1', name: 'Test store', type: 'STORE' } as any });
  // Orders are made raw: the auto-join only reads customer, total, status and date.
  const order = (customerId: string, total: number, daysAgo: number, n: number) => prisma.salesOrder.create({
    data: { clientId: C, customerId, locationId: loc.id, orderNumber: `SO-T${n}`, total, createdAt: new Date(Date.now() - daysAgo * 86_400_000) } as any
  });
  await order(anu.id, 30000, 10, 1);
  await order(anu.id, 25000, 20, 2);
  await order(old.id, 60000, 400, 3);                       // big, but over a year ago
  const r = await customerGroups.setRules(C, 'wholesale', { autoMinSpend: 50000, autoDays: 365 });
  const anuTags = (await prisma.customer.findUnique({ where: { id: anu.id }, select: { tags: true } }))?.tags;
  check('saving "₹50,000 in 365 days" adds Anu (₹55,000) at once', r.joined === 1 && !!anuTags?.includes('Wholesale'), { r, anuTags });
  check('a second run adds nobody new (only adds, never twice)', (await runGroupAutoJoin(new Date(), { onlyClients: [C] })) === 0);
  check('half a rule is refused in words', /rupees|days/.test(await refused(customerGroups.setRules(C, 'wholesale', { autoMinSpend: 100 }))));
  await customerGroups.setRules(C, 'wholesale', { autoMinSpend: null, autoDays: null });
  check('switching the rule off keeps the members it added', !!(await prisma.customer.findUnique({ where: { id: anu.id }, select: { tags: true } }))?.tags.includes('Wholesale'));
}

main()
  .catch(e => { failed++; console.error(e); })
  .finally(async () => {
    const campaigns = await prisma.campaign.findMany({ where: { clientId: C }, select: { id: true } });
    await prisma.campaignRecipient.deleteMany({ where: { campaignId: { in: campaigns.map(c => c.id) } } });
    await prisma.campaign.deleteMany({ where: { clientId: C } });
    await prisma.salesOrder.deleteMany({ where: { clientId: C } });
    await prisma.offer.deleteMany({ where: { clientId: C } });
    await prisma.loyaltySettings.deleteMany({ where: { clientId: C } });
    await prisma.stockLocation.deleteMany({ where: { clientId: C } });
    await prisma.customerGroup.deleteMany({ where: { clientId: C } });
    await prisma.customer.deleteMany({ where: { clientId: C } });
    console.log(`\n${passed} passed, ${failed} failed`);
    await prisma.$disconnect();
    process.exit(failed ? 1 : 0);
  });
