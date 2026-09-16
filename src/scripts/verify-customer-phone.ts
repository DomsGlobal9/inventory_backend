/**
 * One customer per phone number, per shop -- the rule a counter finds its customers by.
 *
 *   A  saving: every way a number is typed is stored one way; the same person typed differently is
 *      refused, naming who already has the number; fake, short, landline-shaped-wrong and non-numbers
 *      refused with the reason; a number from another country kept; no phone, no customer
 *   B  the same customer saved twice at the same moment: one row
 *   C  changing a customer: groups alone still change for somebody saved without a phone; a phone
 *      cannot be cleared, cannot be taken from somebody else, and a new free number is stored one way
 *   D  the counter's lookup: any spelling finds them, an unknown number is "nobody", another shop's
 *      customer is never found, a bad number says why
 *   E  search by any part of the number, typed any way
 *   F  two shops may each have a customer on the same number; a deleted customer's number is free
 *   G  a customer arriving with an online order: a free number is kept, a number somebody already has
 *      is not (the order keeps it), a non-number stays only on the order
 *   H  the database's own index refuses a second customer on a number even when the service is skipped
 *   I  who may: Sales adds and changes customers, a role without customer permission is refused
 *
 * Fixtures on demo-client and a throwaway second shop, all removed at the end. Needs the API on :4006.
 *
 *   npx tsx src/scripts/verify-customer-phone.ts
 */
import axios, { AxiosInstance } from 'axios';
import { prisma } from '../lib/prisma';
import { AuthService } from '../services/auth.service';
import { salesOrderService } from '../services/sales-order.service';

const BASE = process.env.VERIFY_API_URL || 'http://localhost:4006/api/v1';
const CLIENT = 'demo-client';
const OTHER = `phone-other-${Date.now()}`;
const STAMP = Date.now();

let passed = 0, failed = 0;
const failures: string[] = [];
const check = (name: string, ok: boolean, detail?: string) => {
  if (ok) { passed++; console.log(`  [PASS] ${name}`); }
  else { failed++; failures.push(name); console.log(`  [FAIL] ${name}${detail ? `  -> ${detail}` : ''}`); }
};
const brief = (r: any) => `${r.status} ${JSON.stringify(r.data).slice(0, 240)}`;
const noLeak = (r: any) => !/prisma|Invalid `|unique constraint|P2002/i.test(JSON.stringify(r.data));

// Ten-digit mobiles of this run's own, starting 7, so no earlier run or real customer can already hold them.
const tail = String(STAMP).slice(-7);
const num = (n: number) => `7${n}${tail}${String(n).padStart(1, '0')}`.slice(0, 10);

const made = { users: [] as string[], roles: [] as string[], customerIds: [] as string[], orderIds: [] as string[], variantId: '', productId: '' };

async function person(name: string, roleId: string): Promise<AxiosInstance> {
  const u = await prisma.user.create({ data: { clientId: CLIENT, email: `phone-${name}-${STAMP}@example.com`, name: `Phone ${name}`, password: 'unused', status: 'ACTIVE' } });
  made.users.push(u.id);
  await prisma.userRole.create({ data: { userId: u.id, roleId } });
  return axios.create({ baseURL: BASE, headers: { Authorization: `Bearer ${AuthService.generateToken({ userId: u.id, clientId: CLIENT })}` }, validateStatus: () => true });
}

async function main() {
  const adminRole = await prisma.role.findFirstOrThrow({ where: { clientId: CLIENT, name: 'ADMIN' } });
  const salesRole = await prisma.role.findFirstOrThrow({ where: { clientId: CLIENT, name: 'SALES' } });
  const bare = await prisma.role.create({ data: { clientId: CLIENT, name: `PHONE-NONE-${STAMP}` } });
  made.roles.push(bare.id);
  const admin = await person('admin', adminRole.id);
  const sales = await person('sales', salesRole.id);
  const nobody = await person('none', bare.id);

  const create = async (api: AxiosInstance, body: any) => {
    const r = await api.post('/customers', body);
    if (r.data?.data?.id) made.customerIds.push(r.data.data.id);
    return r;
  };

  // ── A ───────────────────────────────────────────────────────────────────────────────────
  console.log('\nA. SAVING A CUSTOMER');
  const p1 = num(1);
  const priya = await create(sales, { name: 'Priya Sharma', phone: `${p1.slice(0, 5)} ${p1.slice(5)}` });
  check('a number typed with a space is saved as +91 and ten digits', priya.status === 201 && priya.data.data.phone === `+91${p1}`, brief(priya));
  for (const spelling of [`0${p1}`, `+91-${p1.slice(0, 5)}-${p1.slice(5)}`, `91${p1}`, `0091 ${p1}`, `(+91) ${p1.slice(0, 5)}.${p1.slice(5)}`]) {
    const r = await create(sales, { name: 'Priya S', phone: spelling });
    check(`the same number typed as "${spelling}" is refused, naming who has it (409)`,
      r.status === 409 && r.data.existingCustomerId === priya.data.data.id && r.data.message.includes('Priya Sharma') && r.data.message.includes(priya.data.data.customerCode), brief(r));
  }
  const refusals: [string, any, RegExp][] = [
    ['no phone at all', { name: 'No Phone' }, /phone number/i],
    ['a blank phone', { name: 'Blank', phone: '   ' }, /phone number/i],
    ['all one digit', { name: 'Fake', phone: '9999999999' }, /real number/i],
    ['1234567890', { name: 'Fake', phone: '1234567890' }, /real number|starts with/i],
    ['9876543210', { name: 'Fake', phone: '9876543210' }, /real number/i],
    ['nine digits', { name: 'Short', phone: '984802233' }, /10-digit/i],
    ['starts with 5', { name: 'Wrong', phone: '5848022338' }, /starts with 6, 7, 8 or 9/i],
    ['words', { name: 'Words', phone: 'call me' }, /digits/i],
    ['+91 with too few digits', { name: 'Short', phone: '+91 98480' }, /10 digits after \+91/i],
    ['a foreign number that is too short', { name: 'Short', phone: '+1234567' }, /8 to 15 digits/i],
    ['a number sent as a number, not text', { name: 'Typed', phone: 9848022338 }, /phone number/i],
    ['a blank name', { name: '   ', phone: num(9) }, /name/i]
  ];
  for (const [label, body, reason] of refusals) {
    const r = await create(sales, body);
    check(`refused: ${label} (400, says why)`, r.status === 400 && reason.test(r.data?.message) && noLeak(r), brief(r));
  }
  const tourist = await create(sales, { name: 'Emma Clarke', phone: '+44 7700 9' + tail.slice(0, 5) });
  check('a number from another country is kept, with its country code', tourist.status === 201 && tourist.data.data.phone === `+4477009${tail.slice(0, 5)}`, brief(tourist));
  const sameEmail = await create(sales, { name: 'Priya\'s sister', phone: num(2), email: 'family@example.com' });
  const sameEmail2 = await create(sales, { name: 'Priya\'s mother', phone: num(3), email: 'family@example.com' });
  check('two people sharing one email address are two customers', sameEmail.status === 201 && sameEmail2.status === 201, `${brief(sameEmail)} | ${brief(sameEmail2)}`);
  const blankEmail = await create(sales, { name: 'No Email', phone: num(4), email: '' });
  check('an empty email box is no email, not an invalid one', blankEmail.status === 201 && blankEmail.data.data.email == null, brief(blankEmail));

  // ── B ───────────────────────────────────────────────────────────────────────────────────
  console.log('\nB. SAVED TWICE AT THE SAME MOMENT');
  const race = num(5);
  const pair = await Promise.all([
    create(sales, { name: 'Double Tap', phone: race }),
    create(admin, { name: 'Double Tap', phone: `0${race}` })
  ]);
  const rows = await prisma.customer.count({ where: { clientId: CLIENT, phone: `+91${race}` } });
  check('two tills saving one number at once make one customer, and the other is told who', rows === 1 && pair.map(p => p.status).sort().join() === '201,409', pair.map(brief).join(' | '));

  // ── C ───────────────────────────────────────────────────────────────────────────────────
  console.log('\nC. CHANGING A CUSTOMER');
  const old = await prisma.customer.create({ data: { clientId: CLIENT, customerCode: `CUS-PH-${STAMP}`, name: 'Saved Before Phones', status: 'ACTIVE' } });
  made.customerIds.push(old.id);
  const tagsOnly = await sales.patch(`/customers/${old.id}`, { tags: ['VIP'] });
  check('groups alone still change for a customer saved without a phone', tagsOnly.status === 200 && tagsOnly.data.data.tags.includes('VIP') && tagsOnly.data.data.phone === null, brief(tagsOnly));
  const id = priya.data.data.id;
  for (const [label, body] of [['null', { phone: null }], ['blank', { phone: '' }], ['spaces', { phone: '   ' }]] as [string, any][]) {
    const r = await sales.patch(`/customers/${id}`, body);
    check(`refused: clearing the phone (${label})`, r.status === 400 && /needs a phone number/i.test(r.data?.message), brief(r));
  }
  const steal = await sales.patch(`/customers/${id}`, { phone: `+91 ${num(2)}` });
  check('refused: taking a number another customer has, naming them (409)', steal.status === 409 && steal.data.existingCustomerId === sameEmail.data.data.id, brief(steal));
  const sameAgain = await sales.patch(`/customers/${id}`, { phone: `0${p1}`, name: 'Priya Sharma' });
  check('her own number typed another way is not a clash', sameAgain.status === 200 && sameAgain.data.data.phone === `+91${p1}`, brief(sameAgain));
  const moved = await sales.patch(`/customers/${id}`, { phone: `${num(6).slice(0, 5)}-${num(6).slice(5)}` });
  check('a new free number is stored one way', moved.status === 200 && moved.data.data.phone === `+91${num(6)}`, brief(moved));
  const freed = await create(sales, { name: 'Takes The Old Number', phone: p1 });
  check('  ...and the number she gave up is free for somebody else', freed.status === 201, brief(freed));
  const badEdit = await sales.patch(`/customers/${id}`, { phone: '12345' });
  check('refused: changing to a malformed number, with the reason', badEdit.status === 400 && /10-digit/i.test(badEdit.data?.message), brief(badEdit));
  check('  ...and none of the refused edits changed her', (await prisma.customer.findUniqueOrThrow({ where: { id } })).phone === `+91${num(6)}`);

  // ── D ───────────────────────────────────────────────────────────────────────────────────
  console.log('\nD. THE COUNTER\'S LOOKUP');
  const p6 = num(6);
  for (const spelling of [p6, `0${p6}`, `+91${p6}`, `91 ${p6.slice(0, 5)} ${p6.slice(5)}`]) {
    const r = await sales.get(`/customers/by-phone/${encodeURIComponent(spelling)}`);
    check(`"${spelling}" finds her`, r.status === 200 && r.data.data?.id === id && r.data.phone === `+91${p6}`, brief(r));
  }
  const unknown = await sales.get(`/customers/by-phone/${num(8)}`);
  check('an unknown number is "nobody yet" (200, null), not an error', unknown.status === 200 && unknown.data.data === null && unknown.data.phone === `+91${num(8)}`, brief(unknown));
  const bad = await sales.get('/customers/by-phone/12345');
  check('a malformed number says why (400)', bad.status === 400 && /10-digit/i.test(bad.data?.message), brief(bad));
  const lookupFields = await sales.get(`/customers/by-phone/${p6}`);
  check('the lookup brings what a counter shows: name, code, groups, last order', ['name', 'customerCode', 'tags', 'salesOrders'].every(k => k in (lookupFields.data?.data || {})), brief(lookupFields));

  // ── E ───────────────────────────────────────────────────────────────────────────────────
  console.log('\nE. SEARCH');
  for (const typed of [`${p6.slice(0, 5)} ${p6.slice(5)}`, `0${p6.slice(0, 6)}`, `+91 ${p6.slice(0, 5)}`, p6.slice(-6)]) {
    const r = await sales.get('/customers', { params: { search: typed } });
    check(`searching "${typed}" finds her`, r.status === 200 && (r.data || []).some((c: any) => c.id === id), `${r.status} ${(r.data || []).length} results`);
  }
  const byName = await sales.get('/customers', { params: { search: 'Priya Sharma' } });
  check('searching by name still works', byName.status === 200 && byName.data.some((c: any) => c.id === id));
  const digitsInName = await create(sales, { name: `Shop ${p6.slice(-6)} Traders`, phone: num(0) });
  const nameSearch = await sales.get('/customers', { params: { search: `Shop ${p6.slice(-6)} Traders` } });
  check('a name that contains digits finds that name, not people whose number contains the digits',
    digitsInName.status === 201 && nameSearch.data.some((c: any) => c.id === digitsInName.data.data.id) && !nameSearch.data.some((c: any) => c.id === id), `${nameSearch.status} ${(nameSearch.data || []).map((c: any) => c.name).join(', ')}`);

  // ── F ───────────────────────────────────────────────────────────────────────────────────
  console.log('\nF. OTHER SHOPS, DELETED CUSTOMERS');
  const elsewhere = await prisma.customer.create({ data: { clientId: OTHER, customerCode: 'CUS-X-1', name: 'Other Shop Priya', phone: `+91${p6}`, status: 'ACTIVE' } });
  check('another shop can have its own customer on the same number', !!elsewhere.id);
  const notLeaked = await sales.get(`/customers/by-phone/${p6}`);
  check('  ...and this shop\'s lookup never finds theirs', notLeaked.data?.data?.id === id, brief(notLeaked));
  const gone = await create(sales, { name: 'Left The Shop', phone: num(7) });
  await prisma.customer.update({ where: { id: gone.data.data.id }, data: { deletedAt: new Date() } });
  const reuse = await create(sales, { name: 'New Holder', phone: num(7) });
  check('a deleted customer\'s number can be given to somebody new', reuse.status === 201, brief(reuse));
  const goneLookup = await sales.get(`/customers/by-phone/${num(7)}`);
  check('  ...and the lookup finds the new holder, not the deleted one', goneLookup.data?.data?.id === reuse.data?.data?.id, brief(goneLookup));

  // ── G ───────────────────────────────────────────────────────────────────────────────────
  console.log('\nG. A CUSTOMER ARRIVING WITH AN ONLINE ORDER');
  const location = await prisma.stockLocation.findFirstOrThrow({ where: { clientId: CLIENT, code: 'MAIN-STORE' } });
  const product = await prisma.product.create({ data: { clientId: CLIENT, productCode: `PRD-PH-${STAMP}`, title: `Phone Saree ${STAMP}`, slug: `phone-saree-${STAMP}`, category: 'WOMEN', basePrice: 1000, status: 'ACTIVE', productType: 'READY_TO_WEAR' } });
  made.productId = product.id;
  const variant = await prisma.productVariant.create({ data: { clientId: CLIENT, productId: product.id, sku: `PH-${STAMP}`, variantCode: `VC-PH-${STAMP}`, size: 'Free', colorName: 'Red', sellingPrice: 1000 } });
  made.variantId = variant.id;
  await prisma.inventoryStock.create({ data: { clientId: CLIENT, variantId: variant.id, locationId: location.id, quantity: 20 } });
  const online = async (externalId: string, phone: any) => {
    const order: any = await salesOrderService.createFullOrder(CLIENT, location.id, {
      externalOrderId: `web-${externalId}`, sourceSystem: 'VERIFY_PHONE',
      customer: { externalId: `web:${externalId}`, name: `Web ${externalId}`, phone },
      items: [{ variantId: variant.id, quantity: 1 }]
    }, 'ONLINE');
    made.orderIds.push(order.id);
    const customer = await prisma.customer.findUniqueOrThrow({ where: { id: order.customerId } });
    made.customerIds.push(customer.id);
    return { order: await prisma.salesOrder.findUniqueOrThrow({ where: { id: order.id } }), customer };
  };
  const free = await online(`free-${STAMP}`, `0${num(8)}`);
  check('a free number arrives stored one way, on the customer and the order', free.customer.phone === `+91${num(8)}` && free.order.customerPhone === `+91${num(8)}`, JSON.stringify([free.customer.phone, free.order.customerPhone]));
  const clash = await online(`clash-${STAMP}`, `+91 ${p6}`);
  check('a number a shop customer already has is NOT put on the web customer', clash.customer.phone === null && clash.customer.id !== id, clash.customer.phone || 'null');
  check('  ...the order still carries it, so the shop can call them', clash.order.customerPhone === `+91${p6}`, String(clash.order.customerPhone));
  check('  ...and Priya is untouched', (await prisma.customer.findUniqueOrThrow({ where: { id } })).name === 'Priya Sharma');
  const junk = await online(`junk-${STAMP}`, 'not given');
  check('a non-number stays only on the order, as typed', junk.customer.phone === null && junk.order.customerPhone === 'not given', JSON.stringify([junk.customer.phone, junk.order.customerPhone]));
  const none = await online(`none-${STAMP}`, null);
  check('no number at all is fine for an online customer', none.customer.phone === null && none.order.customerPhone === null);

  // ── H ───────────────────────────────────────────────────────────────────────────────────
  console.log('\nH. THE DATABASE\'S OWN RULE');
  const direct = await prisma.customer.create({ data: { clientId: CLIENT, customerCode: `CUS-PH-D-${STAMP}`, name: 'Bypass', phone: `+91${p6}`, status: 'ACTIVE' } }).catch((e: any) => e);
  check('writing straight to the database, skipping the service, is still refused', direct instanceof Error && (direct as any).code === 'P2002', String((direct as any)?.code || (direct as any)?.id));
  if (!(direct instanceof Error)) made.customerIds.push((direct as any).id);

  // ── I ───────────────────────────────────────────────────────────────────────────────────
  console.log('\nI. WHO MAY');
  const noPerm = await create(nobody, { name: 'Should Not', phone: num(0) });
  check('refused: a role without customer permission cannot add one (403)', noPerm.status === 403, brief(noPerm));
  const noLookup = await nobody.get(`/customers/by-phone/${p6}`);
  check('refused: nor look one up by phone (403)', noLookup.status === 403, brief(noLookup));
}

async function cleanup() {
  await prisma.salesOrderDiscount.deleteMany({ where: { salesOrderId: { in: made.orderIds } } }).catch(() => undefined);
  await prisma.salesOrderItem.deleteMany({ where: { salesOrderId: { in: made.orderIds } } }).catch(() => undefined);
  await prisma.inventoryReservation.deleteMany({ where: { salesOrderId: { in: made.orderIds } } }).catch(() => undefined);
  await prisma.salesOrder.deleteMany({ where: { id: { in: made.orderIds } } }).catch(() => undefined);
  if (made.variantId) {
    await prisma.inventoryReservation.deleteMany({ where: { variantId: made.variantId } }).catch(() => undefined);
    await prisma.inventoryTransaction.deleteMany({ where: { variantId: made.variantId } });
    await prisma.inventoryAlert.deleteMany({ where: { variantId: made.variantId } }).catch(() => undefined);
    await prisma.inventoryEvent.deleteMany({ where: { variantId: made.variantId } }).catch(() => undefined);
    await prisma.inventoryStock.deleteMany({ where: { variantId: made.variantId } });
    await prisma.productVariant.deleteMany({ where: { id: made.variantId } });
  }
  if (made.productId) await prisma.product.deleteMany({ where: { id: made.productId } });
  await prisma.customer.deleteMany({ where: { OR: [{ id: { in: made.customerIds } }, { clientId: OTHER }] } });
  await prisma.userRole.deleteMany({ where: { userId: { in: made.users } } });
  await prisma.auditLog.deleteMany({ where: { userId: { in: made.users } } }).catch(() => undefined);
  await prisma.user.deleteMany({ where: { id: { in: made.users } } });
  await prisma.role.deleteMany({ where: { id: { in: made.roles } } });
  const left = [
    await prisma.customer.count({ where: { id: { in: made.customerIds } } }),
    await prisma.customer.count({ where: { clientId: OTHER } }),
    await prisma.salesOrder.count({ where: { id: { in: made.orderIds } } }),
    await prisma.user.count({ where: { id: { in: made.users } } })
  ];
  check('cleanup left nothing behind', left.every(n => n === 0), left.join());
}

main()
  .catch(error => { failed++; failures.push(`crashed: ${error?.message}`); console.error(error); })
  .finally(async () => {
    try { await cleanup(); } catch (error: any) { failed++; console.error('cleanup failed', error); }
    console.log(`\nRESULT: ${passed} passed, ${failed} failed`);
    if (failures.length) console.log('Failures:\n  - ' + failures.join('\n  - '));
    await prisma.$disconnect();
    process.exit(failed ? 1 : 0);
  });
