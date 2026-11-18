/**
 * Customer groups in Inventory since 18 Nov 2026: READ ONLY. The owner: groups are made and changed only in
 * ScaleEzy CRM (which writes Inventory's copy, see verify-crm-groups-and-reads). Here:
 *   A  the groups a shop has are still listed, their members found, the customers list filters by them;
 *   B  every change refused in the same words (make, add, remove, rename, merge, rules, delete, a new
 *      customer with groups, changing a customer's groups), with nothing changed; the same groups sent back
 *      by a form still saves;
 *   C  what reads them still works: quiet groups leave customers out of a message's reach, and the
 *      daily job makes no wish (wishes are CRM's too).
 *
 * Runs on a throwaway shop id with no WhatsApp number, so nothing it prepares can ever be sent. Deletes
 * everything it made.
 *
 *   npx tsx src/scripts/verify-customer-groups.ts
 */
import { prisma } from '../lib/prisma';
import { customerGroups, quietGroupOf } from '../services/customer-groups';
import { preview } from '../services/campaigns/audience';
import { prepareShopDay } from '../services/campaigns';
import { customerService } from '../services/customer.service';
import { GROUPS_IN_CRM } from '../services/crm-groups';
import { localDayKey } from '../utils/businessDay';

let passed = 0, failed = 0;
const check = (name: string, ok: boolean, detail?: unknown) => {
  if (ok) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name}${detail !== undefined ? ` -- ${JSON.stringify(detail)}` : ''}`); }
};
const C = `groups-test-${Date.now()}`;
const refused = async (p: Promise<unknown>) => { try { await p; return null; } catch (e: any) { return e; } };

async function main() {
  const today = localDayKey(new Date(), 'Asia/Kolkata').slice(5);   // MM-DD
  const mk = (n: number, name: string, tags: string[], extra: any = {}) => prisma.customer.create({
    data: { clientId: C, customerCode: `CUS-${n}`, name, phone: `+9190000000${n}`, tags, whatsappOffers: true, birthday: today, ...extra }
  });
  const meena = await mk(1, 'Meena', ['vip']);
  const ravi = await mk(2, 'Ravi', ['VIP', 'Staff']);
  const anu = await mk(3, 'Anu', []);
  await mk(4, 'Old customer', ['Wholesale'], { loyaltyPoints: 50 });
  await prisma.customerGroup.create({ data: { clientId: C, key: 'vip', name: 'VIP', noOfferMessages: true, noWishes: true } });

  console.log('\nA. STILL READ');
  const list = await customerGroups.list(C);
  check('"vip" and "VIP" are one group of 2', list.find(g => g.key === 'vip')?.count === 2, list);
  check('3 groups in all (VIP, Staff, Wholesale)', list.length === 3, list.map(g => g.name));
  const m = await customerGroups.members(C, 'vip');
  check('members of VIP: Meena and Ravi', m.members.map(x => x.name).join(',') === 'Meena,Ravi', m);
  const filtered = await customerService.getCustomers(C, { group: 'Vip' });
  check('the customers list filter finds both, whatever the spelling asked', filtered.length === 2, filtered.map((c: any) => c.name));

  console.log('\nB. EVERY CHANGE IS CRM\'S');
  const tagsBefore = JSON.stringify((await prisma.customer.findMany({ where: { clientId: C }, orderBy: { customerCode: 'asc' }, select: { tags: true } })).map(c => c.tags));
  for (const [what, p] of [
    ['make a group', () => customerGroups.create(C, 'Festival list')],
    ['put customers in a group', () => customerGroups.addMembers(C, 'VIP', [anu.id])],
    ['put customers in a NEW group', () => customerGroups.addMembers(C, 'Brand new', [anu.id])],
    ['take a customer out', () => customerGroups.removeMember(C, 'vip', meena.id)],
    ['rename a group', () => customerGroups.rename(C, 'staff', 'Team')],
    ['merge two groups', () => customerGroups.rename(C, 'staff', 'VIP', { merge: true })],
    ['change a group\'s rules', () => customerGroups.setRules(C, 'vip', { noOfferMessages: false })],
    ['set a spending rule', () => customerGroups.setRules(C, 'vip', { autoMinSpend: 50000, autoDays: 365 })],
    ['delete a group', () => customerGroups.remove(C, 'wholesale')],
    ['make a customer with groups', () => customerService.createCustomer(C, { name: 'New VIP', phone: '+919000000099', tags: ['VIP'] })],
    ['change a customer\'s groups', () => customerService.updateCustomer(C, ravi.id, { tags: ['VIP'] })]
  ] as const) {
    const e = await refused((p as () => Promise<unknown>)());
    check(`Inventory cannot ${what}: 409 "${GROUPS_IN_CRM}"`, e?.statusCode === 409 && e.message === GROUPS_IN_CRM, e?.message ?? 'it was allowed');
  }
  const tagsAfter = JSON.stringify((await prisma.customer.findMany({ where: { clientId: C, customerCode: { startsWith: 'CUS-' } }, orderBy: { customerCode: 'asc' }, select: { tags: true } })).map(c => c.tags));
  check('...nothing changed: every customer\'s groups as they were, no group made or removed', tagsAfter === tagsBefore && (await customerGroups.list(C)).length === 3
    && (await prisma.customerGroup.findUnique({ where: { clientId_key: { clientId: C, key: 'vip' } } }))?.noOfferMessages === true, { tagsBefore, tagsAfter });
  const same = await refused(customerService.updateCustomer(C, ravi.id, { name: 'Ravi Kumar', tags: ['VIP', 'Staff'] }));
  check('editing a customer and sending back the SAME groups (as a form does): saved', same === null && (await prisma.customer.findUniqueOrThrow({ where: { id: ravi.id } })).name === 'Ravi Kumar', same?.message);
  const plain: any = await customerService.createCustomer(C, { name: 'Plain new', phone: '+919000000098' });
  check('a new customer with no groups: made as usual', !!plain?.id && plain.tags.length === 0);

  console.log('\nC. WHAT READS THEM STILL WORKS');
  const p = await preview(C, {});
  check('a message to everyone: Anu and Old customer; the 2 in VIP left out (no offer messages), the new one has not agreed to offers', p.count === 2 && p.breakdown.inQuietGroup === 2
    && p.sample.map((x: any) => x.name).sort().join() === 'Anu,Old customer', p);
  check('the sender would skip Meena, naming the group, for offers and for wishes', (await quietGroupOf(C, ['vip'], 'offers')) === 'VIP' && (await quietGroupOf(C, ['VIP'], 'wishes')) === 'VIP');
  await prisma.loyaltySettings.create({ data: { clientId: C, birthdayWish: true } as any });
  const day = await prepareShopDay(C, new Date(), { ignoreHours: true });
  const wishLots = await prisma.campaign.count({ where: { clientId: C, source: 'BIRTHDAY' } });
  check('the daily job makes no birthday wish (CRM\'s), even with the old switch left on', wishLots === 0 && (day?.birthdays ?? 0) === 0, { day, wishLots });
}

main()
  .catch(e => { failed++; console.error(e); })
  .finally(async () => {
    const camps = await prisma.campaign.findMany({ where: { clientId: C }, select: { id: true } });
    await prisma.campaignRecipient.deleteMany({ where: { campaignId: { in: camps.map(c => c.id) } } });
    await prisma.campaign.deleteMany({ where: { clientId: C } });
    await prisma.loyaltySettings.deleteMany({ where: { clientId: C } });
    await prisma.customerGroup.deleteMany({ where: { clientId: C } });
    await prisma.customer.deleteMany({ where: { clientId: C } });
    console.log(`\n${passed} passed, ${failed} failed`);
    await prisma.$disconnect();
    process.exit(failed ? 1 : 0);
  });
