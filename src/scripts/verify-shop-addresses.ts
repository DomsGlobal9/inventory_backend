/**
 * ADDRESSES A SHOPPER HAS SAVED (PLAN-online-shop.md).
 *
 *   the whole point of this file is the first section: WHO MAY READ A BOOK. These are people's
 *   home addresses, and the only thing standing between a stranger and one of them is that a
 *   phone number is not a key. Knowing the number must prove nothing; only the secret the
 *   browser earned by typing a code back may read anything.
 *
 *   npx tsx src/scripts/verify-shop-addresses.ts      (needs the local backend running)
 *
 * Makes only throwaway shops and deletes them afterwards. Sends nothing anywhere.
 */
import axios from 'axios';
import crypto from 'crypto';
import { prisma } from '../lib/prisma';
import { seedRolesForClient } from '../services/rbac-seed.service';
import { platformAdminService } from '../services/platform-admin.service';
import { AuthService } from '../services/auth.service';
import { shopOtp, shopAddresses, OnlineShopRuleError } from '../services/online-shop';

const SERVER = 'http://localhost:4006';
const STAMP = Date.now();
const SHOP = `addr-${STAMP}`;
const OTHER = `addr-other-${STAMP}`;
const SLUG = `addr-shop-${STAMP}`;
const OTHER_SLUG = `addr-other-${STAMP}`;

let passed = 0; const failures: string[] = [];
const check = (name: string, ok: boolean, detail: unknown = '') => {
  if (ok) { passed++; console.log(`  ok   ${name}`); }
  else { failures.push(name); console.log(`  FAIL ${name} :: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`); }
};
const refusal = async (p: Promise<unknown>) => {
  try { await p; return ''; } catch (e) { return e instanceof OnlineShopRuleError ? e.message : `NOT A RULE ERROR: ${(e as Error).message}`; }
};
const post = (path: string, body: unknown) =>
  axios.post(`${SERVER}${path}`, body, { validateStatus: () => true, headers: { 'Content-Type': 'application/json' } });

async function makeShop(clientId: string, slug: string) {
  const roles = await seedRolesForClient(clientId);
  await prisma.clientSettings.create({ data: { clientId, businessName: slug } });
  const store = await prisma.stockLocation.create({
    data: { clientId, name: 'Main', code: 'MAIN', type: 'STORE', active: true }
  });
  const prod = await prisma.product.create({
    data: { clientId, productCode: 'AD-1', title: 'A Saree', slug: `ad-${clientId}`, category: 'WOMEN', productType: 'READY_TO_WEAR', basePrice: 5000, status: 'ACTIVE' }
  });
  const v = await prisma.productVariant.create({
    data: { clientId, productId: prod.id, sku: 'AD-1-V', variantCode: `AD-1-VC-${clientId}`, size: 'Free', colorName: 'Red', sellingPrice: 5000, averageCost: 1 }
  });
  await prisma.inventoryStock.create({ data: { clientId, variantId: v.id, locationId: store.id, quantity: 9, reservedQty: 0 } });
  const u = await prisma.user.create({ data: { clientId, email: `o-${clientId}@e.com`, name: 'O', password: 'x', status: 'ACTIVE' } });
  await prisma.userRole.create({ data: { userId: u.id, roleId: roles.SUPER_ADMIN } });
  const own = axios.create({
    baseURL: `${SERVER}/api/v1`,
    headers: { Authorization: `Bearer ${AuthService.generateToken({ userId: u.id, clientId })}` },
    validateStatus: () => true
  });
  await own.post('/online-shop/address', { slug });
  await own.patch('/online-shop', { locationIds: [store.id], displayName: slug });
  await own.post('/online-shop/open', {});
  await own.patch('/online-shop', { acceptsOrders: true, payOnDelivery: true });
  return { own, variantCode: v.variantCode };
}

/** Prove a number the way a shopper does, but with the code written here since nothing sends one. */
async function prove(clientId: string, phone: string) {
  const code = '424242';
  await prisma.onlineShopPhoneCode.upsert({
    where: { clientId_phone: { clientId, phone } },
    create: { clientId, phone, codeHash: crypto.createHash('sha256').update(`${phone}:${code}`).digest('hex'), expiresAt: new Date(Date.now() + 600_000) },
    update: { codeHash: crypto.createHash('sha256').update(`${phone}:${code}`).digest('hex'), expiresAt: new Date(Date.now() + 600_000), tries: 0, verifiedAt: null }
  });
  const out: any = await shopOtp.checkCode(clientId, phone, code);
  return out.token as string;
}

async function main() {
  const me = await makeShop(SHOP, SLUG);
  await makeShop(OTHER, OTHER_SLUG);

  const PHONE = '+919989000555';
  const token = await prove(SHOP, PHONE);
  check('proving a number gives the browser a secret', typeof token === 'string' && token.length >= 20, token?.length);

  console.log('\nWHO MAY READ A BOOK');
  check('no token, no addresses', /Confirm your number/.test(await refusal(shopAddresses.mine(SHOP, undefined))));
  check('a made-up token reads nothing', /Confirm your number/.test(await refusal(shopAddresses.mine(SHOP, 'not-a-real-token-at-all-xxxxx'))));
  check("another shop cannot use this shop's token", /Confirm your number/.test(await refusal(shopAddresses.mine(OTHER, token))));
  // The point of the whole design: knowing the NUMBER is not enough.
  check('knowing the number alone proves nothing', (await shopOtp.whoIs(SHOP, PHONE)) === null);
  check('...while the secret does', (await shopOtp.whoIs(SHOP, token)) === PHONE);

  console.log('\nSAVING');
  check('a proved shopper starts with an empty book', (await shopAddresses.mine(SHOP, token)).addresses.length === 0);
  const home: any = await shopAddresses.save(SHOP, token, {
    label: 'Home', name: 'Anita Rao', phone: '9989000555',
    line: '3-6-218 Flat 402, Himayatnagar, Hyderabad', pincode: '500029'
  });
  check('the first address saves', !!home.id && home.label === 'Home', home);
  check('...and is the default without anybody saying so', home.isDefault === true, home);

  const amma: any = await shopAddresses.save(SHOP, token, {
    label: "Amma's", name: 'Lakshmi Rao', phone: '9989000666',
    line: '12 Temple Street, Vijayawada, Andhra Pradesh', pincode: '520001'
  });
  check('a second address saves beside the first', !!amma.id && amma.id !== home.id);
  check('...and does not steal the default', amma.isDefault === false, amma);
  check('...and carries its own name and number, for a gift', amma.name === 'Lakshmi Rao' && amma.phone.includes('9989000666'), amma);

  const both = await shopAddresses.mine(SHOP, token);
  check('both are in the book, default first', both.addresses.length === 2 && both.addresses[0].id === home.id, both.addresses);

  console.log('\nREFUSALS A SHOPPER CAN ACT ON');
  check('no name is refused', /Who is this address for/.test(await refusal(shopAddresses.save(SHOP, token, { name: '', line: 'x'.repeat(20), pincode: '500029' }))));
  check('half an address is refused', /full address/.test(await refusal(shopAddresses.save(SHOP, token, { name: 'A B', line: 'short', pincode: '500029' }))));
  check('a bad PIN code is refused', /PIN code/.test(await refusal(shopAddresses.save(SHOP, token, { name: 'A B', line: 'x'.repeat(20), pincode: '12' }))));
  check("another person's address id cannot be edited",
    /could not be found/.test(await refusal(shopAddresses.save(SHOP, token, { id: 'deadbeef-0000-0000-0000-000000000000', name: 'A B', line: 'x'.repeat(20), pincode: '500029' }))));

  console.log('\nCHANGING AND REMOVING');
  const moved: any = await shopAddresses.save(SHOP, token, { ...home, id: home.id, label: 'Home (new flat)', isDefault: true });
  check('an address can be changed', moved.label === 'Home (new flat)', moved);
  const madeDefault: any = await shopAddresses.save(SHOP, token, { ...amma, id: amma.id, isDefault: true });
  check('the default can be moved', madeDefault.isDefault === true);
  const after = await shopAddresses.mine(SHOP, token);
  check('...and only one is ever the default', after.addresses.filter(a => a.isDefault).length === 1, after.addresses);

  await shopAddresses.remove(SHOP, token, amma.id);
  const left = await shopAddresses.mine(SHOP, token);
  check('a removed address is gone from the book', left.addresses.length === 1 && left.addresses[0].id === home.id);
  check('...and the remaining one becomes the default', left.addresses[0].isDefault === true, left.addresses);

  console.log('\nTHE BOOK FILLS ITSELF');
  const key = `addr-${STAMP}-${Math.random().toString(36).slice(2)}aaaaaaaaaa`;
  const order = await post(`/shop/${SLUG}/orders`, {
    placementKey: key, lines: [{ variantCode: me.variantCode, quantity: 1 }],
    name: 'Anita Rao', phone: PHONE,
    address: '9-1-100 Banjara Hills, Hyderabad, Telangana', pincode: '500034',
    payWay: 'ON_DELIVERY'
  });
  check('a proved shopper can order', order.status === 200, order.data);
  await new Promise(r => setTimeout(r, 1500));
  const grown = await shopAddresses.mine(SHOP, token);
  check('the address just ordered to is remembered, with no tick box',
    grown.addresses.some(a => a.line.includes('Banjara Hills')), grown.addresses.map(a => a.line));
  check('...without duplicating the one already there', grown.addresses.length === 2, grown.addresses.length);

  const customer = await prisma.customer.findFirst({ where: { clientId: SHOP, phone: PHONE }, select: { shippingAddress: true } });
  check("a customer with a book keeps their own shippingAddress, not the last order's",
    !String(customer?.shippingAddress ?? '').includes('Banjara Hills'), customer?.shippingAddress);

  console.log('\nTHROUGH THE SERVER');
  const listed = await post(`/shop/${SLUG}/addresses`, { token });
  check('the shop answers the book over HTTP', listed.status === 200 && listed.data.data.addresses.length === 2, listed.data);
  const noToken = await post(`/shop/${SLUG}/addresses`, {});
  check('...and refuses without the secret, as a sentence', noToken.status === 400 && /Confirm your number/.test(noToken.data.message), noToken.data);
  const crossed = await post(`/shop/${OTHER_SLUG}/addresses`, { token });
  check("...and one shop's secret reads nothing in another", crossed.status === 400, crossed.data);
  const body = JSON.stringify(listed.data);
  for (const word of ['clientId', 'customerId', 'deletedAt']) {
    check(`the book never carries ${word}`, !body.includes(word));
  }
}

main()
  .catch(e => { failures.push('stopped'); console.log('STOPPED', e?.stack ?? e); })
  .finally(async () => {
    for (const c of [SHOP, OTHER]) await platformAdminService.deleteClientCompletely(c, c).catch(() => {});
    await prisma.onlineShopSlugHistory.deleteMany({ where: { clientId: { in: [SHOP, OTHER] } } }).catch(() => {});
    console.log(`\nRESULT: ${passed} passed | ${failures.length} failed`);
    if (failures.length) console.log(failures.map(f => `  - ${f}`).join('\n'));
    await prisma.$disconnect();
    process.exit(failures.length ? 1 : 0);
  });
