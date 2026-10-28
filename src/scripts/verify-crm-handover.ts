/**
 * Inventory's side of moving customer features to ScaleEzy CRM (28 Oct, PLAN-crm.md §7).
 *
 * Two throwaway shops (one with CRM on, one without), built here and removed at the end. Checked over
 * the real service routes with a real signed service token, and against the app's own routes, so
 * "the same rules" means the same answer:
 *   1. the Customer card's suggestions and the store list for CRM;
 *   2. customer groups for CRM, done for a named person;
 *   3. groups, campaigns, campaign templates and pictures reach the change feed;
 *   4. the hand-over switch and its safety rules (campaigns, wishes), and the jobs obeying it;
 *   5. the session says which modules the shop has on.
 *
 * Needs the local server (launch config backend-localdb: local DB, TRUSTED_SERVICES_KEYS with the test
 * key). Run with the LOCAL database and no WhatsApp service, e.g.
 *
 *   DATABASE_URL=postgresql://postgres:localpw@localhost:55433/inventory DIRECT_URL=$DATABASE_URL \
 *   WHATSAPP_SERVICE_URL= WHATSAPP_SERVICE_KEY= VERIFY_API_URL=http://localhost:4016/api/v1 \
 *   CRM_KEY_DIR=<dir with private.pem> npx tsx src/scripts/verify-crm-handover.ts
 */
import axios from 'axios';
import fs from 'node:fs';
import jwt from 'jsonwebtoken';
import { prisma } from '../lib/prisma';
import { AuthService } from '../services/auth.service';
import { seedRolesForClient } from '../services/rbac-seed.service';
import { platformAdminService } from '../services/platform-admin.service';
import { crmHandover } from '../services/crm-handover';
import { prepareShopDay } from '../services/campaigns/auto';
import { runCampaignTick } from '../services/campaigns/sender';
import * as campaigns from '../services/campaigns/campaign.service';
import { localDayKey } from '../utils/businessDay';

const BASE = process.env.VERIFY_API_URL || 'http://localhost:4016/api/v1';
const KEY_DIR = process.env.CRM_KEY_DIR!;
const STAMP = Date.now();
const SHOP = `crmho-${STAMP}`;
const OTHER = `crmho-other-${STAMP}`;
const TZ = 'Asia/Kolkata';

if (!/localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL ?? '')) { console.error('Refusing: DATABASE_URL is not the local database.'); process.exit(2); }
if (process.env.WHATSAPP_SERVICE_URL) { console.error('Refusing: unset WHATSAPP_SERVICE_URL (the campaign tick must not reach a real service).'); process.exit(2); }

let passed = 0;
const failures: string[] = [];
const check = (name: string, ok: boolean, detail = '') => {
  if (ok) { passed++; console.log(`  ok   ${name}`); }
  else { failures.push(`${name} :: ${detail}`); console.log(`  FAIL ${name} :: ${detail}`); }
};
const brief = (r: any) => `${r?.status} ${JSON.stringify(r?.data).slice(0, 300)}`;
const call = (method: string, path: string, headers: Record<string, string> = {}, data?: any) =>
  axios.request({ method, url: `${BASE}${path}`, headers, data, validateStatus: () => true, timeout: 90_000 });

const privateKey = fs.readFileSync(`${KEY_DIR}/private.pem`, 'utf8');
const tokenFor = (claims: { scope?: string[]; clientId?: string; userId?: string } = {}) => ({
  Authorization: `Bearer ${jwt.sign({
    sub: 'scaleezy-crm-test', scope: claims.scope ?? ['modules:crm'],
    ...(claims.clientId ? { clientId: claims.clientId } : {}),
    ...(claims.userId ? { onBehalfOf: { userId: claims.userId } } : {})
  }, privateKey, { algorithm: 'RS256', audience: 'inventory', issuer: 'scaleezy-crm-test', keyid: 'test-1', expiresIn: '5m' })}`
});
const CRM = tokenFor();
const crm = (path: string) => `/internal/modules/crm/shops/${SHOP}${path}`;
const strip = (x: unknown) => JSON.parse(JSON.stringify(x));

async function main() {
  console.log(`SETUP ${SHOP}`);
  const roles = await seedRolesForClient(SHOP);
  const rolesB = await seedRolesForClient(OTHER);
  await prisma.clientSettings.create({ data: { clientId: SHOP, businessName: 'Handover Silks', timezone: TZ } as any });
  await prisma.clientSettings.create({ data: { clientId: OTHER, businessName: 'Other Sarees', timezone: TZ } as any });
  const hash = await AuthService.hashPassword('Same-Pass-123');
  const mkUser = async (clientId: string, name: string, roleId: string, status = 'ACTIVE') => {
    const u = await prisma.user.create({ data: { clientId, email: `${name.toLowerCase().replace(/\s/g, '')}-${STAMP}@example.com`, name, password: hash, status: status as any } });
    await prisma.userRole.create({ data: { userId: u.id, roleId } });
    return u;
  };
  const owner = await mkUser(SHOP, 'Owner Asha', roles.SUPER_ADMIN);
  const sales = await mkUser(SHOP, 'Sales Ravi', roles.SALES);
  const gone = await mkUser(SHOP, 'Former Staff', roles.ADMIN, 'INACTIVE');
  const ownerB = await mkUser(OTHER, 'Owner B', rolesB.SUPER_ADMIN);
  const asOwner = { Authorization: `Bearer ${AuthService.generateToken({ userId: owner.id, clientId: SHOP })}` };
  const asOwnerB = { Authorization: `Bearer ${AuthService.generateToken({ userId: ownerB.id, clientId: OTHER })}` };
  await call('POST', '/auth/tour-seen', asOwner);

  // CRM switches the shop on the way it really does (same route as the outbox).
  const on = await call('PUT', `/internal/modules/crm/shops/${SHOP}`, CRM);
  check('CRM switches the shop on', on.status === 200, brief(on));

  // ---- Stock, bills, looks: enough for every list on the card to have something in it ------------
  const store = await prisma.stockLocation.create({ data: { clientId: SHOP, name: 'Main Store', code: `M-${STAMP}`, type: 'STORE' as any, active: true } });
  const branch = await prisma.stockLocation.create({ data: { clientId: SHOP, name: 'Annex', code: `A-${STAMP}`, type: 'STORE' as any, active: true } });
  await prisma.stockLocation.create({ data: { clientId: SHOP, name: 'Closed Store', code: `C-${STAMP}`, type: 'STORE' as any, active: false } });
  const otherStore = await prisma.stockLocation.create({ data: { clientId: OTHER, name: 'Theirs', code: `T-${STAMP}`, type: 'STORE' as any, active: true } });
  let n = 0;
  const product = (title: string, dressType: string) => prisma.product.create({ data: { clientId: SHOP, productCode: `P${STAMP}-${++n}`, slug: `p${STAMP}-${n}`, title, category: 'WOMEN' as any, productType: 'READY_TO_WEAR' as any, dressType, basePrice: 1000, status: 'ACTIVE' as any } });
  const variant = (productId: string, colorName: string, size: string, price = 1000) => prisma.productVariant.create({ data: { productId, clientId: SHOP, colorName, size, variantCode: `V${STAMP}-${++n}`, sku: `S${STAMP}-${n}`, sellingPrice: price } });
  const stock = (variantId: string, quantity: number, locationId = store.id) => prisma.inventoryStock.create({ data: { clientId: SHOP, variantId, locationId, quantity, reservedQty: 0 } });

  const kurti = await product('Cotton Kurti', 'Kurti'); const kBlueM = await variant(kurti.id, 'Blue', 'M');
  const linen = await product('Linen Kurti', 'Kurti'); const lBlueM = await variant(linen.id, 'Blue', 'M'); await stock(lBlueM.id, 4);
  const pink = await product('Pink Kurti', 'Kurti'); const pM = await variant(pink.id, 'Pink', 'M'); await stock(pM.id, 2);
  const dupatta = await product('Silk Dupatta', 'Dupatta'); const dRed = await variant(dupatta.id, 'Red', 'Free'); await stock(dRed.id, 3);
  const saree = await product('Kanchi Saree', 'Saree'); const sGreen = await variant(saree.id, 'Green', 'Free'); await stock(sGreen.id, 2);
  // A shelf for the linen kurti, so "where is it" is part of the answer.
  const spot = await prisma.storageSpot.create({ data: { clientId: SHOP, locationId: store.id, address: 'R1', code: 'R1', kind: 'AREA', depth: 1, labelCode: `CRMH${String(STAMP).slice(-8)}` } as any });
  await prisma.spotStock.create({ data: { clientId: SHOP, locationId: store.id, spotId: spot.id, variantId: lBlueM.id, quantity: 2 } as any });

  const customer = await prisma.customer.create({ data: { clientId: SHOP, customerCode: `C-${STAMP}`, name: 'Meena Iyer', phone: '+919848011122', email: `meena-${STAMP}@example.com` } });
  const noPhone = await prisma.customer.create({ data: { clientId: SHOP, customerCode: `CN-${STAMP}`, name: 'No Phone Nila' } });
  const theirs = await prisma.customer.create({ data: { clientId: OTHER, customerCode: `CO-${STAMP}`, name: 'Someone Else', phone: '+919848011122' } });
  const bill = (customerId: string, items: { v: any; qty: number }[], total: number, daysAgo: number) => prisma.salesOrder.create({ data: {
    clientId: SHOP, orderNumber: `SO-${STAMP}-${++n}`, customerId, channel: 'POS' as any, locationId: store.id, status: 'DISPATCHED' as any,
    subtotal: total, discountAmount: 0, taxAmount: 0, shippingAmount: 0, total, createdAt: new Date(Date.now() - daysAgo * 86_400_000),
    items: { create: items.map(i => ({ variantId: i.v.id, quantity: i.qty, listUnitPrice: total / i.qty, unitPrice: total / i.qty, unitCost: 0, totalPrice: total })) }
  } as any });
  await bill(customer.id, [{ v: kBlueM, qty: 1 }], 1000, 20);
  await bill(noPhone.id, [{ v: kBlueM, qty: 1 }], 1000, 15);
  // Two other people bought the cotton kurti AND the dupatta: "others also bought" has something.
  for (const p of ['+919848000001', '+919848000002']) {
    const c = await prisma.customer.create({ data: { clientId: SHOP, customerCode: `CB-${STAMP}-${++n}`, name: `Buyer ${n}`, phone: p } });
    await bill(c.id, [{ v: kBlueM, qty: 1 }], 1000, 30);
    await bill(c.id, [{ v: dRed, qty: 1 }], 1500, 29);
  }
  // She looked at the saree in the online shop.
  await prisma.shopProductView.create({ data: { clientId: SHOP, productId: saree.id, phone: '+919848011122', views: 3, tryOns: 1, variantId: sGreen.id } });

  console.log('\n1. SUGGESTIONS AND STORES FOR CRM');
  check('no service token: 401', (await call('GET', crm(`/locations`))).status === 401);
  const wrongScope = await call('GET', crm('/locations'), tokenFor({ scope: ['session:read'] }));
  check('without modules:crm: 403', wrongScope.status === 403, brief(wrongScope));
  const notOn = await call('GET', `/internal/modules/crm/shops/${OTHER}/locations`, CRM);
  check('a shop that has not switched CRM on: 404', notOn.status === 404 && /not switched CRM on/.test(notOn.data?.message), brief(notOn));
  const crossToken = await call('GET', crm('/locations'), tokenFor({ clientId: OTHER }));
  check('a token naming another shop: 403', crossToken.status === 403, brief(crossToken));

  const locs = await call('GET', crm('/locations'), CRM);
  check('stores: exactly the open ones, by name, as { id, name }', locs.status === 200 && JSON.stringify(locs.data.data) === JSON.stringify([{ id: branch.id, name: 'Annex' }, { id: store.id, name: 'Main Store' }]), brief(locs));

  const app = await call('GET', `/customers/card?phone=9848011122&locationId=${store.id}`, { ...asOwner, 'x-location-id': store.id });
  const sug = await call('GET', crm(`/customers/${customer.id}/suggestions?locationId=${store.id}`), CRM);
  const s = sug.data?.data, a = app.data?.data;
  check('suggestions answer 200 with picks, alsoBought, lookedAtOnline', sug.status === 200 && Array.isArray(s?.picks) && Array.isArray(s?.alsoBought) && Array.isArray(s?.lookedAtOnline), brief(sug));
  check('picks are the card\'s picks, exactly (same rules)', JSON.stringify(s?.picks) === JSON.stringify(a?.picks) && s.picks.length >= 2 && s.picks.length <= 6, `${JSON.stringify(s?.picks)} | ${JSON.stringify(a?.picks)}`);
  check('...the linen kurti in her size and colour, with its shelf', s?.picks?.[0]?.variantId === lBlueM.id && s.picks[0].yourColour === true && s.picks[0].shelf === 'R1', JSON.stringify(s?.picks?.[0]));
  check('...never what she already has', !s?.picks?.some((p: any) => p.variantId === kBlueM.id));
  check('alsoBought is the card\'s "others also bought", exactly: the dupatta, 2 buyers', JSON.stringify(s?.alsoBought) === JSON.stringify(a?.othersAlsoBought) && s.alsoBought.length === 1 && s.alsoBought[0].variantId === dRed.id && s.alsoBought[0].buyers === 2, JSON.stringify(s?.alsoBought));
  check('lookedAtOnline is the card\'s, exactly: the saree, 3 views + 1 try-on, 2 in this store', JSON.stringify(s?.lookedAtOnline) === JSON.stringify(a?.lookedOnline) && s.lookedAtOnline.length === 1 && s.lookedAtOnline[0].productId === saree.id && s.lookedAtOnline[0].views === 3 && s.lookedAtOnline[0].tryOns === 1 && s.lookedAtOnline[0].inStock === 2, JSON.stringify(s?.lookedAtOnline));
  const atBranch = await call('GET', crm(`/customers/${customer.id}/suggestions?locationId=${branch.id}`), CRM);
  check('at the other store (no stock there): no picks, and the saree shows 0 in this store', atBranch.status === 200 && atBranch.data.data.picks.length === 0 && atBranch.data.data.lookedAtOnline[0]?.inStock === 0, brief(atBranch));
  const np = await call('GET', crm(`/customers/${noPhone.id}/suggestions?locationId=${store.id}`), CRM);
  check('a customer with no phone: picks from their own bills, nothing looked at online', np.status === 200 && np.data.data.picks.some((p: any) => p.variantId === lBlueM.id) && np.data.data.lookedAtOnline.length === 0, brief(np));
  const foreignCustomer = await call('GET', crm(`/customers/${theirs.id}/suggestions?locationId=${store.id}`), CRM);
  check('another shop\'s customer: 404', foreignCustomer.status === 404, brief(foreignCustomer));
  const noSuch = await call('GET', crm(`/customers/00000000-0000-0000-0000-000000000000/suggestions`), CRM);
  check('a customer id that does not exist: 404', noSuch.status === 404, brief(noSuch));
  const foreignStore = await call('GET', crm(`/customers/${customer.id}/suggestions?locationId=${otherStore.id}`), CRM);
  check('another shop\'s store: 404', foreignStore.status === 404 && /store/.test(foreignStore.data?.message), brief(foreignStore));
  await prisma.customer.update({ where: { id: noPhone.id }, data: { deletedAt: new Date() } });
  const deleted = await call('GET', crm(`/customers/${noPhone.id}/suggestions`), CRM);
  check('a deleted customer: 404', deleted.status === 404, brief(deleted));

  console.log('\n2. CUSTOMER GROUPS FOR CRM, DONE FOR A NAMED PERSON');
  const asOwnerViaCrm = tokenFor({ clientId: SHOP, userId: owner.id });
  const noPerson = await call('POST', crm('/groups'), CRM, { name: 'VIP' });
  check('a change with nobody named: 403', noPerson.status === 403 && /onBehalfOf/.test(noPerson.data?.message), brief(noPerson));
  const outsider = await call('POST', crm('/groups'), tokenFor({ clientId: SHOP, userId: ownerB.id }), { name: 'VIP' });
  check('a person from another shop: 403', outsider.status === 403 && /not in this shop/.test(outsider.data?.message), brief(outsider));
  const inactive = await call('POST', crm('/groups'), tokenFor({ clientId: SHOP, userId: gone.id }), { name: 'VIP' });
  check('a person whose account is switched off: 403', inactive.status === 403 && /switched off/.test(inactive.data?.message), brief(inactive));
  const mismatch = await call('POST', crm('/groups'), tokenFor({ clientId: OTHER, userId: owner.id }), { name: 'VIP' });
  check('a token for another shop, even naming this shop\'s owner: 403', mismatch.status === 403, brief(mismatch));
  const salesCreate = await call('POST', crm('/groups'), tokenFor({ clientId: SHOP, userId: sales.id }), { name: 'VIP' });
  check('a salesperson cannot make a group (same permission as in Inventory): 403', salesCreate.status === 403 && /customer:manage_groups/.test(salesCreate.data?.message), brief(salesCreate));

  const made = await call('POST', crm('/groups'), asOwnerViaCrm, { name: 'VIP' });
  check('the owner makes "VIP"', made.status === 200, brief(made));
  const dup = await call('POST', crm('/groups'), asOwnerViaCrm, { name: 'vip' });
  check('"vip" again: 409, as in Inventory', dup.status === 409, brief(dup));
  const add = await call('POST', crm('/groups/members'), tokenFor({ clientId: SHOP, userId: sales.id }), { group: 'VIP', customerIds: [customer.id] });
  check('a salesperson may put a customer in a group (customer:update)', add.status === 200, brief(add));
  const tags = (await prisma.customer.findUnique({ where: { id: customer.id }, select: { tags: true } }))?.tags;
  check('...membership is in customers.tags', JSON.stringify(tags) === '["VIP"]', JSON.stringify(tags));
  const foreignMember = await call('POST', crm('/groups/members'), asOwnerViaCrm, { group: 'VIP', customerIds: [theirs.id] });
  const theirTags = (await prisma.customer.findUnique({ where: { id: theirs.id }, select: { tags: true } }))?.tags;
  check('another shop\'s customer is "not found", as in Inventory, and never put in the group', foreignMember.status === 200 && foreignMember.data.data.added === 0 && foreignMember.data.data.notFound === 1 && JSON.stringify(theirTags) === '[]', `${brief(foreignMember)} ${JSON.stringify(theirTags)}`);
  const list = await call('GET', crm('/groups'), CRM);
  const appList = await call('GET', '/customer-groups', asOwner);
  check('the list is the one Inventory\'s Settings shows', list.status === 200 && JSON.stringify(list.data.data) === JSON.stringify(appList.data.data) && list.data.data.some((g: any) => g.name === 'VIP'), `${brief(list)} | ${brief(appList)}`);
  const members = await call('GET', crm('/groups/vip/members'), CRM);
  check('members of VIP: Meena', members.status === 200 && JSON.stringify(members.data.data).includes(customer.id), brief(members));
  const readAsOutsider = await call('GET', crm('/groups'), tokenFor({ clientId: SHOP, userId: ownerB.id }));
  check('a read naming somebody from another shop is refused too', readAsOutsider.status === 403, brief(readAsOutsider));
  const rules = await call('PATCH', crm('/groups/vip/rules'), asOwnerViaCrm, { noOfferMessages: true });
  check('rules change for the owner', rules.status === 200, brief(rules));
  const ren = await call('POST', crm('/groups/vip/rename'), asOwnerViaCrm, { name: 'Gold' });
  check('rename VIP to Gold', ren.status === 200 && JSON.stringify((await prisma.customer.findUnique({ where: { id: customer.id }, select: { tags: true } }))?.tags) === '["Gold"]', brief(ren));
  await call('POST', crm('/groups'), asOwnerViaCrm, { name: 'Silver' });
  const offer = await prisma.offer.create({ data: { clientId: SHOP, offerCode: `OFF-${STAMP}`, name: 'Gold 10%', valueType: 'PERCENTAGE', value: 10, startsAt: new Date(), status: 'ACTIVE', customerTags: ['Gold'] } as any });
  const delLive = await call('DELETE', crm('/groups/gold'), asOwnerViaCrm);
  check('deleting a group a live offer is only for: 409 naming the offer', delLive.status === 409 && /Gold 10%/.test(delLive.data?.message), brief(delLive));
  const mergeLive = await call('POST', crm('/groups/gold/merge'), asOwnerViaCrm, { into: 'Silver' });
  check('merging it away: 409 too', mergeLive.status === 409 && /Gold 10%/.test(mergeLive.data?.message), brief(mergeLive));
  await prisma.offer.update({ where: { id: offer.id }, data: { status: 'ARCHIVED' } });
  const merged = await call('POST', crm('/groups/gold/merge'), asOwnerViaCrm, { into: 'Silver' });
  check('after the offer is archived, merge Gold into Silver', merged.status === 200 && JSON.stringify((await prisma.customer.findUnique({ where: { id: customer.id }, select: { tags: true } }))?.tags) === '["Silver"]', brief(merged));
  const out = await call('DELETE', crm(`/groups/silver/members/${customer.id}`), tokenFor({ clientId: SHOP, userId: sales.id }));
  check('take her out of Silver', out.status === 200 && JSON.stringify((await prisma.customer.findUnique({ where: { id: customer.id }, select: { tags: true } }))?.tags) === '[]', brief(out));
  const del = await call('DELETE', crm('/groups/silver'), asOwnerViaCrm);
  check('delete Silver', del.status === 200, brief(del));
  await new Promise(r => setTimeout(r, 1500));   // the activity row is written after the answer
  const log = await prisma.auditLog.findMany({ where: { clientId: SHOP, entityType: 'CUSTOMER_GROUP' }, orderBy: { createdAt: 'asc' }, select: { userId: true, action: true, entityId: true } });
  const who = (id: string) => id === owner.id ? 'owner' : id === sales.id ? 'sales' : id;
  const seen = log.map(l => `${who(l.userId ?? '')}:${l.action}:${l.entityId}`);
  check('the activity log names who did each change, as Inventory\'s own screen would',
    JSON.stringify(seen) === JSON.stringify(['owner:CREATED:n/a', 'sales:MEMBERS:members', 'owner:MEMBERS:members', 'owner:RULES:vip', 'owner:RENAME:vip', 'owner:CREATED:n/a', 'owner:MERGE:gold', 'sales:MEMBERS:silver', 'owner:DELETED:silver']), JSON.stringify(seen));
  check('...and refused changes left no row', !log.some(l => l.userId === ownerB.id || l.userId === gone.id));

  console.log('\n3. THE CHANGE FEED');
  const tpl = await prisma.campaignTemplate.create({ data: { clientId: SHOP, name: `Tpl ${STAMP}`, text: 'Hello {name}' } });
  const media = await prisma.campaignMedia.create({ data: { clientId: SHOP, storagePath: `test/${STAMP}.jpg`, url: 'https://example.com/x.jpg', width: 10, height: 10, byteSize: 100 } });
  const camp = await prisma.campaign.create({ data: { clientId: SHOP, name: `Feed ${STAMP}`, text: 'Hi', mediaId: media.id } });
  await prisma.campaign.update({ where: { id: camp.id }, data: { text: 'Hi again' } });
  await prisma.campaignTemplate.delete({ where: { id: tpl.id } });
  await prisma.campaignTemplate.create({ data: { clientId: OTHER, name: `Theirs ${STAMP}`, text: 'x' } });
  const kinds = new Set((await prisma.moduleEvent.findMany({ where: { clientId: SHOP }, select: { kind: true } })).map(e => e.kind));
  for (const k of ['customer_group.created', 'customer_group.updated', 'customer_group.deleted', 'campaign.created', 'campaign.updated', 'campaign_template.created', 'campaign_template.deleted', 'campaign_media.created']) {
    check(`feed has ${k}`, kinds.has(k), [...kinds].join(','));
  }
  const campEvent = await prisma.moduleEvent.findFirst({ where: { clientId: SHOP, kind: 'campaign.updated', rowId: camp.id }, select: { payload: true } });
  check('...a campaign event carries the row as it is now', (campEvent?.payload as any)?.text === 'Hi again' && (campEvent?.payload as any)?.client_id === SHOP, JSON.stringify(campEvent?.payload).slice(0, 200));
  check('a shop without CRM writes no events', (await prisma.moduleEvent.count({ where: { clientId: OTHER } })) === 0);

  console.log('\n4. THE HAND-OVER SWITCH');
  const listed0 = await call('GET', '/internal/modules/crm/shops', CRM);
  const row0 = listed0.data?.data?.find((r: any) => r.clientId === SHOP);
  check('the shops list says what has moved: nothing yet', listed0.status === 200 && JSON.stringify(row0?.movedToCrm) === '{}', brief(listed0));
  const bySales = await call('PUT', crm('/moved'), tokenFor({ clientId: SHOP, userId: sales.id }), { notes: true });
  check('only the owner moves things: a salesperson gets 403', bySales.status === 403 && /owner/.test(bySales.data?.message), brief(bySales));
  const noOne = await call('PUT', crm('/moved'), CRM, { notes: true });
  check('...and nobody named: 403', noOne.status === 403, brief(noOne));
  const junk = await call('PUT', crm('/moved'), asOwnerViaCrm, { notes: 'yes', everything: true });
  check('anything but the known flags: 400 in words', junk.status === 400 && /notes/.test(junk.data?.message), brief(junk));
  const notesOn = await call('PUT', crm('/moved'), asOwnerViaCrm, { notes: true, onlineViews: true });
  check('notes and online views move', notesOn.status === 200 && JSON.stringify(notesOn.data.data) === '{"notes":true,"onlineViews":true}', brief(notesOn));
  const notOnShop = await call('PUT', `/internal/modules/crm/shops/${OTHER}/moved`, tokenFor({ clientId: OTHER, userId: ownerB.id }), { notes: true });
  check('a shop without CRM cannot hand anything over: 404', notOnShop.status === 404, brief(notOnShop));

  // Campaigns: refused while one of the shop's own is still going out.
  const actor = { id: owner.id, clientId: SHOP, name: 'Owner Asha', permissions: ['*'], roles: ['SUPER_ADMIN'] };
  const sending = await prisma.campaign.create({ data: { clientId: SHOP, name: 'Diwali offer', text: 'Hi {name}', status: 'SENDING', startedAt: new Date() } });
  const blocked = await call('PUT', crm('/moved'), asOwnerViaCrm, { campaigns: true });
  check('campaigns cannot move while "Diwali offer" is sending: 409 naming it', blocked.status === 409 && /Diwali offer \(sending\)/.test(blocked.data?.message), brief(blocked));
  for (const st of ['PAUSED', 'PREPARING'] as const) {
    await prisma.campaign.update({ where: { id: sending.id }, data: { status: st } });
    const b = await call('PUT', crm('/moved'), asOwnerViaCrm, { campaigns: true });
    check(`...nor while it is ${st.toLowerCase()}`, b.status === 409, brief(b));
  }
  // A birthday lot still going out is Inventory's own automatic message, not a campaign that moves.
  await prisma.campaign.update({ where: { id: sending.id }, data: { status: 'DONE', finishedAt: new Date() } });
  const bday = await prisma.campaign.create({ data: { clientId: SHOP, name: 'Birthday wishes, test', text: 'Happy birthday', source: 'BIRTHDAY', status: 'SENDING', startedAt: new Date() } });
  const moved = await call('PUT', crm('/moved'), asOwnerViaCrm, { campaigns: true });
  check('once it is done, campaigns move (a birthday lot sending does not block it)', moved.status === 200 && moved.data.data.campaigns === true && moved.data.data.notes === true, brief(moved));

  // Each with somebody still waiting, so the tick's "finished?" sweep leaves them SENDING.
  const manual = await prisma.campaign.create({ data: { clientId: SHOP, name: 'Sneaked in', text: 'Hi', status: 'SENDING', startedAt: new Date() } });
  await prisma.campaignRecipient.create({ data: { campaignId: manual.id, clientId: SHOP, customerId: customer.id } });
  await prisma.campaignRecipient.create({ data: { campaignId: bday.id, clientId: SHOP, customerId: customer.id } });
  const tick = await runCampaignTick(new Date(), { onlyClients: [SHOP], ignoreHours: true });
  check('the campaign tick still takes the shop for its birthday lot', tick.some(r => r.clientId === SHOP), JSON.stringify(tick));
  await prisma.campaign.update({ where: { id: bday.id }, data: { status: 'DONE' } });
  const tick2 = await runCampaignTick(new Date(), { onlyClients: [SHOP], ignoreHours: true });
  const manualNow = await prisma.campaign.findUnique({ where: { id: manual.id }, select: { status: true } });
  const waitingNow = await prisma.campaignRecipient.count({ where: { campaignId: manual.id, state: 'WAITING' } });
  check('...but with only its own campaign sending, the tick leaves the shop alone (nothing handed, still waiting)', !tick2.some(r => r.clientId === SHOP) && manualNow?.status === 'SENDING' && waitingNow === 1, `${JSON.stringify(tick2)} ${manualNow?.status} waiting=${waitingNow}`);
  await prisma.campaign.update({ where: { id: manual.id }, data: { status: 'CANCELLED' } });

  // Starting one in Inventory now is refused.
  await prisma.customer.update({ where: { id: customer.id }, data: { whatsappOffers: true, whatsappOffersAt: new Date() } });
  const draft = await campaigns.create(actor, { name: `After move ${STAMP}`, text: 'Hello {name}, new arrivals are in.', audience: {} });
  const started = await campaigns.start(actor, (draft as any).id).then(() => null, (e: any) => e);
  check('starting a campaign in Inventory after the move: 409 "sent from ScaleEzy CRM"', started?.statusCode === 409 && /ScaleEzy CRM/.test(started.message), started?.message ?? 'it started');
  check('...and it stays a draft', (await prisma.campaign.findUnique({ where: { id: (draft as any).id }, select: { status: true } }))?.status === 'DRAFT');
  const back = await call('PUT', crm('/moved'), asOwnerViaCrm, { campaigns: false });
  check('campaigns can be given back', back.status === 200 && back.data.data.campaigns === false, brief(back));
  const startedNow = await campaigns.start(actor, (draft as any).id).then((r: any) => r?.status, (e: any) => `refused: ${e?.message}`);
  check('...and then Inventory starts it as before', startedNow === 'SENDING', String(startedNow));
  await prisma.campaign.update({ where: { id: (draft as any).id }, data: { status: 'CANCELLED' } });

  // Wishes: the day is Inventory's choice, worked out from what it has prepared.
  const today = localDayKey(new Date(), TZ);
  const dayAfter = (k: string, d = 1) => { const [y, m, dd] = k.split('-').map(Number); return new Date(Date.UTC(y, m - 1, dd + d)).toISOString().slice(0, 10); };
  const yesterday = dayAfter(today, -1);
  await prisma.loyaltySettings.create({ data: { clientId: SHOP, birthdayWish: true, autoPreparedFor: yesterday } as any });
  const birthdayToday = today.slice(5);
  await prisma.customer.update({ where: { id: customer.id }, data: { birthday: birthdayToday } });
  const w1 = await call('PUT', crm('/moved'), asOwnerViaCrm, { wishes: true });
  check(`today not prepared yet: wishes move from today (${today})`, w1.status === 200 && w1.data.data.wishes?.fromDay === today, brief(w1));
  const w1again = await call('PUT', crm('/moved'), asOwnerViaCrm, { wishes: true });
  check('asking again keeps the same day', w1again.data?.data?.wishes?.fromDay === today, brief(w1again));
  const prep = await prepareShopDay(SHOP, new Date(), { ignoreHours: true });
  const wishLots = await prisma.campaign.count({ where: { clientId: SHOP, source: 'BIRTHDAY', name: { startsWith: 'Birthday wishes, ' }, NOT: { id: bday.id } } });
  check('Inventory\'s daily job claims the day but makes no birthday wishes from fromDay on', prep !== null && prep.birthdays === 0 && wishLots === 0, `${JSON.stringify(prep)} lots=${wishLots}`);
  check('...the day is still marked prepared (points and the lapse reminder are Inventory\'s)', (await prisma.loyaltySettings.findUnique({ where: { clientId: SHOP } }))?.autoPreparedFor === today);
  const giveBack = await call('PUT', crm('/moved'), asOwnerViaCrm, { wishes: null });
  check('wishes can be given back (null)', giveBack.status === 200 && giveBack.data.data.wishes === null, brief(giveBack));
  const w2 = await call('PUT', crm('/moved'), asOwnerViaCrm, { wishes: true });
  check(`today already prepared by Inventory: wishes move from tomorrow (${dayAfter(today)})`, w2.data?.data?.wishes?.fromDay === dayAfter(today), brief(w2));
  await call('PUT', crm('/moved'), asOwnerViaCrm, { wishes: false });
  await prisma.loyaltySettings.update({ where: { clientId: SHOP }, data: { autoPreparedFor: yesterday } });
  const prepHere = await prepareShopDay(SHOP, new Date(), { ignoreHours: true });
  check('with wishes not moved, the same job does make today\'s birthday wish (1)', prepHere?.birthdays === 1, JSON.stringify(prepHere));

  // The two at the same moment, many times: each day is wished by exactly one of them.
  let raced = 0, bad: string[] = [];
  for (let i = 0; i < 8; i++) {
    await prisma.campaign.deleteMany({ where: { clientId: SHOP, source: 'BIRTHDAY', NOT: { id: bday.id } } });   // recipients go with them (cascade)
    await crmHandover.set(SHOP, { wishes: false });
    await prisma.loyaltySettings.update({ where: { clientId: SHOP }, data: { autoPreparedFor: yesterday } });
    const [p, m] = await Promise.all([prepareShopDay(SHOP, new Date(), { ignoreHours: true }), crmHandover.set(SHOP, { wishes: true })]);
    const inventoryWished = (p?.birthdays ?? 0) > 0;
    const crmFrom = m.wishes?.fromDay;
    const ok = inventoryWished ? crmFrom === dayAfter(today) : crmFrom === today;
    if (!ok) bad.push(`round ${i}: inventory wished=${inventoryWished}, CRM from ${crmFrom}`);
    raced++;
  }
  check(`racing the daily job and the hand-over ${raced} times: never both, never neither`, bad.length === 0, bad.join('; '));
  await crmHandover.set(SHOP, { wishes: false });

  const listed = await call('GET', '/internal/modules/crm/shops', CRM);
  const row = listed.data?.data?.find((r: any) => r.clientId === SHOP);
  check('the shops list shows movedToCrm for the shop', JSON.stringify(row?.movedToCrm) === '{"notes":true,"onlineViews":true,"campaigns":false,"wishes":null}', JSON.stringify(row));
  await new Promise(r => setTimeout(r, 1000));
  const hoLog = await prisma.auditLog.count({ where: { clientId: SHOP, entityType: 'CRM_HANDOVER', userId: owner.id } });
  check('each hand-over change is in the activity log under the owner', hoLog >= 8, String(hoLog));

  console.log('\n5. THE SESSION SAYS WHICH MODULES ARE ON');
  const sess = await call('GET', '/auth/session', asOwner);
  check('a shop with CRM on: modules = [inventory, crm]', JSON.stringify(sess.data?.modules) === '["inventory","crm"]', brief(sess));
  const sessB = await call('GET', '/auth/session', asOwnerB);
  check('a shop without: modules = [inventory]', JSON.stringify(sessB.data?.modules) === '["inventory"]', brief(sessB));
  const viaCrm = await call('POST', '/internal/session', tokenFor({ scope: ['session:read'] }), { token: asOwner.Authorization.slice(7) });
  check('CRM\'s session check gives the very same answer', JSON.stringify(viaCrm.data) === JSON.stringify(sess.data), `${brief(viaCrm)}`);
  void strip;
}

async function cleanup() {
  await prisma.moduleSubscription.deleteMany({ where: { clientId: { in: [SHOP, OTHER] } } });
  await prisma.moduleEvent.deleteMany({ where: { clientId: { in: [SHOP, OTHER] } } });
  await prisma.shopProductView.deleteMany({ where: { clientId: { in: [SHOP, OTHER] } } });
  await prisma.campaignRecipient.deleteMany({ where: { clientId: { in: [SHOP, OTHER] } } });
  await prisma.campaign.deleteMany({ where: { clientId: { in: [SHOP, OTHER] } } });
  await prisma.campaignTemplate.deleteMany({ where: { clientId: { in: [SHOP, OTHER] } } });
  await prisma.campaignMedia.deleteMany({ where: { clientId: { in: [SHOP, OTHER] } } });
  for (const id of [SHOP, OTHER]) {
    await platformAdminService.deleteClientCompletely(id, id).catch((e: any) => { if (!/No such client/.test(e?.message)) console.log('cleanup', id, e?.message); });
  }
  const left = await prisma.user.count({ where: { clientId: { in: [SHOP, OTHER] } } }) + await prisma.moduleEvent.count({ where: { clientId: { in: [SHOP, OTHER] } } }) + await prisma.customer.count({ where: { clientId: { in: [SHOP, OTHER] } } });
  check('both throwaway shops are gone', left === 0, String(left));
}

main()
  .catch(e => { failures.push(`crashed: ${e?.message}`); console.error(e); })
  .finally(async () => {
    await cleanup().catch(e => { failures.push(`cleanup crashed: ${e?.message}`); console.error(e); });
    console.log(`\nRESULT: ${passed} passed | ${failures.length} failed`);
    if (failures.length) console.log('Failed:\n - ' + failures.join('\n - '));
    await prisma.$disconnect();
    process.exit(failures.length ? 1 : 0);
  });
