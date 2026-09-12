/**
 * Who is allowed to take money off at the counter.
 *
 * The arithmetic is proved in verify-quote-to-order. This proves the part that is not
 * arithmetic: that a cashier cannot do it, that a manager can, and that the refusal happens
 * BEFORE the request is validated -- so somebody who is not allowed to do this is told that,
 * rather than handed a validation message that teaches them the shape the field wants.
 *
 * This has to be an HTTP test. The permission lives on the request, not in the service: the
 * same service is called by the Shopify ingester, which has no user at all and must keep
 * working.
 *
 * Needs the API running.  Throwaway tenant, deleted at the end.
 *
 *   npx tsx src/scripts/verify-till-discount-api.ts
 */
import axios from 'axios';
import jwt from 'jsonwebtoken';
import { prisma } from '../lib/prisma';
import { getPermission } from '../config/permissions';

const BASE = process.env.VERIFY_API_URL || 'http://localhost:4006/api/v1';

let passed = 0, failed = 0;
const failures: string[] = [];
const check = (name: string, ok: boolean, detail?: string) => {
  if (ok) { passed++; console.log(`  [PASS] ${name}`); }
  else { failed++; failures.push(name); console.log(`  [FAIL] ${name}${detail ? `  -> ${detail}` : ''}`); }
};

const CLIENT = `till-${Date.now()}`;
const num = (v: any) => Number(v);

const CASHIER_KEYS = ['sales_order:view', 'sales_order:create', 'product:view'];
const MANAGER_KEYS = [...CASHIER_KEYS, 'offer:manual_discount', 'offer:view'];

/** A role holding exactly these keys, creating any permission row the database has not seen. */
async function roleWith(name: string, keys: string[]) {
  await prisma.permission.createMany({
    data: keys.map(key => ({ key, description: getPermission(key)?.label ?? key })),
    skipDuplicates: true
  });
  const rows = await prisma.permission.findMany({ where: { key: { in: keys } } });
  const role = await prisma.role.create({ data: { clientId: CLIENT, name, description: name } });
  await prisma.rolePermission.createMany({
    data: rows.map(p => ({ roleId: role.id, permissionId: p.id })),
    skipDuplicates: true
  });
  return role;
}

async function userAs(email: string, name: string, roleId: string) {
  const user = await prisma.user.create({
    data: { clientId: CLIENT, email, name, password: 'not-used-here', status: 'ACTIVE' }
  });
  await prisma.userRole.create({ data: { userId: user.id, roleId } });
  const token = jwt.sign(
    { sub: user.id, clientId: CLIENT, iss: 'scal_easy_auth', aud: 'scal_easy_inventory' },
    process.env.JWT_SECRET!, { expiresIn: '1h' }
  );
  return axios.create({
    baseURL: BASE, headers: { Authorization: `Bearer ${token}` }, validateStatus: () => true
  });
}

async function main() {
  console.log(`SETUP: a shop, a cashier and a manager  (${BASE})`);

  const shop = await prisma.stockLocation.create({
    data: { clientId: CLIENT, name: 'Counter', code: 'COUNTER', type: 'STORE', active: true }
  });
  const customer = await prisma.customer.create({
    data: { clientId: CLIENT, customerCode: 'CUS-1', name: 'Walk in', status: 'ACTIVE' }
  });
  const product = await prisma.product.create({
    data: {
      clientId: CLIENT, productCode: 'PRD-T', title: 'Silk Saree', slug: `t-${Date.now()}`,
      category: 'WOMEN', basePrice: 5000, status: 'ACTIVE', productType: 'READY_TO_WEAR'
    }
  });
  const variant = await prisma.productVariant.create({
    data: {
      clientId: CLIENT, productId: product.id, sku: 'SKU-T', variantCode: 'VAR-T',
      size: 'Free', colorName: 'Green', sellingPrice: 5000, averageCost: 2000
    }
  });
  await prisma.inventoryStock.create({
    data: { clientId: CLIENT, variantId: variant.id, locationId: shop.id, quantity: 50, reservedQty: 0 }
  });

  const cashier = await userAs('cashier@example.com', 'Cashier', (await roleWith('CASHIER', CASHIER_KEYS)).id);
  const manager = await userAs('manager@example.com', 'Manager', (await roleWith('MANAGER', MANAGER_KEYS)).id);

  const order = (over: any = {}) => ({
    customer: { id: customer.id },
    locationId: shop.id,
    items: [{ variantId: variant.id, quantity: 1 }],
    ...over
  });

  // ── A. A CASHIER SELLS, AND THAT IS ALL ────────────────────────────────
  console.log('\nA. A CASHIER CAN SELL BUT CANNOT DISCOUNT');

  const ordinary = await cashier.post('/sales-orders/full', order());
  check('a cashier can take an ordinary order', ordinary.status === 201,
    `${ordinary.status} ${JSON.stringify(ordinary.data).slice(0, 200)}`);

  const refused = await cashier.post('/sales-orders/full', order({
    items: [{ variantId: variant.id, quantity: 1, manualDiscount: { amount: 500, reason: 'Feeling generous' } }]
  }));
  check('a cashier cannot take money off a line', refused.status === 403, String(refused.status));
  check('  ...told what they cannot do, in words',
    /permission to take money off/i.test(String(refused.data?.message)), String(refused.data?.message));
  check('  ...and which permission would allow it, for whoever manages the team',
    refused.data?.requiredPermission === 'offer:manual_discount');

  const refusedBill = await cashier.post('/sales-orders/full', order({
    manualDiscount: { amount: 500, reason: 'Feeling generous' }
  }));
  check('nor off the whole bill', refusedBill.status === 403, String(refusedBill.status));

  /*
   * The ordering that matters.
   *
   * A malformed manual discount from somebody who is not allowed to use it must come back as
   * "you cannot do this", not as "your reason is too short". The second answer teaches a
   * cashier exactly what to send next time.
   */
  const malformed = await cashier.post('/sales-orders/full', order({
    manualDiscount: { amount: -5, reason: '' }
  }));
  check('a BROKEN discount from a cashier is still a permission refusal', malformed.status === 403,
    String(malformed.status));
  check('  ...and says nothing about what the field wanted',
    !/reason|decimal|negative|amount/i.test(String(malformed.data?.message)),
    String(malformed.data?.message));

  check('nothing was written by any of the refusals',
    (await prisma.salesOrder.count({ where: { clientId: CLIENT } })) === 1,
    String(await prisma.salesOrder.count({ where: { clientId: CLIENT } })));

  // ── B. A MANAGER CAN, WITH A REASON ────────────────────────────────────
  console.log('\nB. A MANAGER CAN, AND THE REASON IS KEPT');

  const allowed = await manager.post('/sales-orders/full', order({
    items: [{
      variantId: variant.id, quantity: 1,
      manualDiscount: { amount: 500, reason: 'Zari pulled on the border' }
    }]
  }));
  check('a manager can take money off', allowed.status === 201,
    `${allowed.status} ${JSON.stringify(allowed.data).slice(0, 200)}`);

  const created = allowed.data?.data ?? allowed.data;
  check('  ...and the order is worth what it should be', num(created?.total) === 4500,
    String(created?.total));

  const row = await prisma.salesOrderDiscount.findFirst({
    where: { salesOrderId: created?.id }, include: { allocations: true }
  });
  check('  ...with the reason kept against the order',
    row?.title === 'Zari pulled on the border', String(row?.title));
  check('  ...marked as a person, not an offer', row?.source === 'MANUAL', String(row?.source));
  check('  ...allocated to the line it came off',
    row?.allocations.length === 1 && num(row?.allocations[0].amount) === 500);

  const item = await prisma.salesOrderItem.findFirst({ where: { salesOrderId: created?.id } });
  check('  ...and the line says a person decided its price',
    item?.priceSource === 'MANUAL', String(item?.priceSource));

  // ── C. WHAT A MANAGER STILL CANNOT DO ──────────────────────────────────
  console.log('\nC. THE PERMISSION IS NOT A BLANK CHEQUE');

  const noReason = await manager.post('/sales-orders/full', order({
    items: [{ variantId: variant.id, quantity: 1, manualDiscount: { amount: 500 } }]
  }));
  check('a manager still cannot discount without saying why', noReason.status === 400,
    String(noReason.status));

  const emptyReason = await manager.post('/sales-orders/full', order({
    items: [{ variantId: variant.id, quantity: 1, manualDiscount: { amount: 500, reason: 'na' } }]
  }));
  check('"na" is refused even from a manager', emptyReason.status === 400, String(emptyReason.status));
  check('  ...and the message says what a reason is for',
    /does not say why/i.test(String(emptyReason.data?.message)), String(emptyReason.data?.message));

  const tooMuch = await manager.post('/sales-orders/full', order({
    items: [{ variantId: variant.id, quantity: 1, manualDiscount: { amount: 50000, reason: 'Owner said so' } }]
  }));
  check('more than the line is worth is refused', tooMuch.status === 400, String(tooMuch.status));
  check('  ...because a line cannot be sold for less than nothing',
    /less than nothing/i.test(String(tooMuch.data?.message)), String(tooMuch.data?.message));

  const both = await manager.post('/sales-orders/full', order({
    discountAmount: 200,
    manualDiscount: { amount: 200, reason: 'Owner said so' }
  }));
  check('a bill discount and a manual one together is refused', both.status === 400,
    String(both.status));

  const everything = [noReason, emptyReason, tooMuch, both, refused, malformed]
    .map(r => JSON.stringify(r.data)).join(' ');
  check('no refusal leaks a file path, a table or a stack frame',
    !/(\\|\/)src(\\|\/)|node_modules|PrismaClient|at [A-Za-z]+ \(/i.test(everything),
    everything.slice(0, 300));

  check('only the two legitimate orders exist',
    (await prisma.salesOrder.count({ where: { clientId: CLIENT } })) === 2,
    String(await prisma.salesOrder.count({ where: { clientId: CLIENT } })));

  // ── D. THE ORDER SCREEN CAN SHOW IT ────────────────────────────────────
  console.log('\nD. THE ORDER SCREEN CAN SHOW WHY');

  const detail = await manager.get(`/sales-orders/${created?.id}`);
  const body = detail.data?.data ?? detail.data;
  check('the order reads back with its discounts', Array.isArray(body?.discounts),
    typeof body?.discounts);
  check('  ...carrying the reason to the screen',
    body?.discounts?.[0]?.title === 'Zari pulled on the border',
    JSON.stringify(body?.discounts?.[0]));
  check('  ...and how it was divided between the lines',
    Array.isArray(body?.discounts?.[0]?.allocations) && body.discounts[0].allocations.length === 1);
}

main()
  .catch(e => { console.error('\nSUITE CRASHED:', e); failed++; failures.push('suite crashed'); })
  .finally(async () => {
    await prisma.salesOrderItemDiscount.deleteMany({
      where: { salesOrderDiscount: { salesOrder: { clientId: CLIENT } } }
    });
    await prisma.salesOrderDiscount.deleteMany({ where: { salesOrder: { clientId: CLIENT } } });
    await prisma.inventoryReservation.deleteMany({ where: { clientId: CLIENT } });
    await prisma.salesOrderItem.deleteMany({ where: { salesOrder: { clientId: CLIENT } } });
    await prisma.salesOrder.deleteMany({ where: { clientId: CLIENT } });
    await prisma.userRole.deleteMany({ where: { user: { clientId: CLIENT } } });
    await prisma.user.deleteMany({ where: { clientId: CLIENT } });
    await prisma.rolePermission.deleteMany({ where: { role: { clientId: CLIENT } } });
    await prisma.role.deleteMany({ where: { clientId: CLIENT } });
    await prisma.inventoryStock.deleteMany({ where: { clientId: CLIENT } });
    await prisma.productVariant.deleteMany({ where: { clientId: CLIENT } });
    await prisma.product.deleteMany({ where: { clientId: CLIENT } });
    await prisma.customer.deleteMany({ where: { clientId: CLIENT } });
    await prisma.stockLocation.deleteMany({ where: { clientId: CLIENT } });
    await prisma.clientSequence.deleteMany({ where: { clientId: CLIENT } });
    await prisma.$disconnect();

    console.log(`\nRESULT: ${passed} passed | ${failed} failed`);
    if (failures.length) console.log('Failures:\n  - ' + failures.join('\n  - '));
    process.exit(failed ? 1 : 0);
  });
