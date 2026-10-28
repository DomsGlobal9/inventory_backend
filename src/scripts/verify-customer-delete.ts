/**
 * Deleting a customer (29 Oct), over real HTTP against the local server (4016), signed in by token
 * cookie (never a password): the owner (SUPER_ADMIN token) and a salesperson (SALES token).
 *
 *   1. Only the owner: a salesperson is refused (preview and delete).
 *   2. No bills -> removed for good, with everything tied to them and their number; a wrong or empty
 *      confirmation is refused first.
 *   3. Bills -> personal details erased, bills kept untouched, gone from lists and look-ups, and the
 *      number free to come back as a new customer.
 *   4. Refused, with the reason, while store credit is owed or an order is still to go out.
 *   5. No phone: confirmed by name. Already deleted, another shop's, unknown: 404.
 *   6. CRM hears (the change feed) and the security log records it.
 *
 * LOCAL DATABASE ONLY, shop verify-suites-tenant. Removes what it made.
 *   DATABASE_URL=… DIRECT_URL=… ROLE_TOKENS=<scratchpad>/local-tokens.json IDS=<scratchpad>/local-ids.json npx tsx src/scripts/verify-customer-delete.ts
 */
const LOCAL = 'localhost:55433';
if (!String(process.env.DATABASE_URL || '').includes(LOCAL) || !String(process.env.DIRECT_URL || '').includes(LOCAL)) {
  console.error(`Refusing to run: DATABASE_URL and DIRECT_URL must both point at the local copy (${LOCAL}).`);
  process.exit(2);
}
import fs from 'node:fs';

let passed = 0, failed = 0;
const failures: string[] = [];
const check = (name: string, ok: boolean, detail?: unknown) => {
  if (ok) { passed++; console.log(`  [PASS] ${name}`); }
  else { failed++; failures.push(name); console.log(`  [FAIL] ${name}${detail === undefined ? '' : `  -> ${JSON.stringify(detail)}`}`); }
};
const eq = (name: string, got: unknown, want: unknown) => check(name, JSON.stringify(got) === JSON.stringify(want), { got, want });

const API = 'http://localhost:4016/api/v1';
const tokens: Record<string, string> = JSON.parse(fs.readFileSync(process.env.ROLE_TOKENS!, 'utf8'));
const ids = JSON.parse(fs.readFileSync(process.env.IDS!, 'utf8'));
const C: string = ids.clientId;
const STAMP = Date.now();
const call = (who: string, method: string, path: string, body?: unknown) =>
  fetch(`${API}${path}`, { method, headers: { 'content-type': 'application/json', origin: 'http://localhost:5183', cookie: `token=${tokens[who]}` }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) })
    .then(async r => ({ status: r.status, body: await r.json().catch(() => null) as any }));

(async () => {
  const { prisma } = await import('../lib/prisma');
  const { salesOrderService } = await import('../services/sales-order.service');
  const { inventoryMutationService } = await import('../services/inventory-mutation.service');
  const made: string[] = [];
  const orders: string[] = [];
  const started = new Date();
  const person = async (name: string, phone: string | null, extra: any = {}) => {
    const c = await prisma.customer.create({ data: { clientId: C, customerCode: `DEL-${STAMP}-${made.length}`, name, phone, ...extra } as any });
    made.push(c.id); return c;
  };
  const variant = await prisma.productVariant.findFirstOrThrow({ where: { clientId: C, product: { status: 'ACTIVE', trashedAt: null } }, orderBy: { sku: 'asc' }, select: { id: true } });
  const have = (await prisma.inventoryStock.findFirst({ where: { clientId: C, variantId: variant.id, locationId: ids.locationId } }))?.quantity ?? 0;
  if (have < 20) await inventoryMutationService.applyMovement({ clientId: C, variantId: variant.id, locationId: ids.locationId, movementType: 'IN', reason: 'PURCHASE_RECEIPT', quantityDelta: 50, unitCost: 1000, notes: 'verify-customer-delete top-up', createdBy: 'verify-customer-delete' } as any);
  const billFor = async (customerId: string, keepOpen = false) => {
    const o: any = await salesOrderService.createFullOrder(C, ids.locationId, { customer: { id: customerId }, channel: 'ONLINE', sourceSystem: 'SCALEEZY_SHOP', externalOrderId: `DEL-${STAMP}-${orders.length}`, items: [{ variantId: variant.id, quantity: 1 }] }, 'ONLINE');
    orders.push(o.id);
    await salesOrderService.confirmOrder(C, o.id);
    if (!keepOpen) await prisma.salesOrder.update({ where: { id: o.id }, data: { status: 'DISPATCHED' as any } });
    return o;
  };

  try {
    console.log('\n1. ONLY THE OWNER');
    const plain = await person('Asha Rao', `+9190000${String(STAMP).slice(-5)}`);
    let r = await call('SALES', 'GET', `/customers/${plain.id}/delete-preview`);
    eq('a salesperson cannot even ask', [r.status, r.body?.message], [403, 'Only the shop owner can delete a customer.']);
    r = await call('SALES', 'DELETE', `/customers/${plain.id}`, { confirm: plain.phone!.slice(-4) });
    eq('...nor delete', r.status, 403);

    console.log('\n2. NO BILLS: REMOVED FOR GOOD');
    const phone = plain.phone!;
    await prisma.customerAddress.create({ data: { customerId: plain.id, clientId: C, line1: '4 Gandhi Road', city: 'Vijayawada', pincode: '520001' } as any }).catch(() => null);
    const product = await prisma.product.findFirstOrThrow({ where: { clientId: C, status: 'ACTIVE' }, select: { id: true } });
    await prisma.shopProductView.create({ data: { clientId: C, phone, productId: product.id, views: 1, tryOns: 2, likedAt: new Date() } });
    await prisma.storeCheckin.create({ data: { clientId: C, locationId: ids.locationId, phone } });
    await prisma.counterLookup.create({ data: { clientId: C, customerId: plain.id, locationId: ids.locationId } });
    r = await call('SUPER_ADMIN', 'GET', `/customers/${plain.id}/delete-preview`);
    eq('preview: removed for good, confirmed with the last 4 digits', [r.status, r.body?.data?.mode, r.body?.data?.phoneLast4, r.body?.data?.bills, r.body?.data?.blocked], [200, 'REMOVE', phone.slice(-4), 0, null]);
    r = await call('SUPER_ADMIN', 'DELETE', `/customers/${plain.id}`, { confirm: '0000' });
    eq('the wrong 4 digits: refused, nothing deleted', [r.status, r.body?.message, !!(await prisma.customer.findUnique({ where: { id: plain.id } }))], [400, 'Type the last 4 digits of their number to confirm.', true]);
    r = await call('SUPER_ADMIN', 'DELETE', `/customers/${plain.id}`, {});
    eq('no confirmation at all: refused', r.status, 400);
    r = await call('SUPER_ADMIN', 'DELETE', `/customers/${plain.id}`, { confirm: phone.slice(-4) });
    eq('deleted: 200, removed', [r.status, r.body?.data?.mode], [200, 'REMOVE']);
    eq('the customer row is gone', await prisma.customer.count({ where: { id: plain.id } }), 0);
    eq('...and everything tied to them or their number', [
      await prisma.customerAddress.count({ where: { customerId: plain.id } }),
      await prisma.shopProductView.count({ where: { clientId: C, phone } }),
      await prisma.storeCheckin.count({ where: { clientId: C, phone } }),
      await prisma.counterLookup.count({ where: { clientId: C, customerId: plain.id } })
    ], [0, 0, 0, 0]);

    console.log('\n3. BILLS: DETAILS ERASED, BILLS KEPT');
    const billed = await person('Meera Krishnan', `+9190001${String(STAMP).slice(-5)}`, { email: 'meera@example.com', notes: 'buys for her daughter', tags: ['VIP'], birthday: '04-12', gstNumber: '36ABCDE1234F1Z5' });
    const o = await billFor(billed.id);
    const orderBefore = await prisma.salesOrder.findUniqueOrThrow({ where: { id: o.id }, select: { total: true, orderNumber: true, customerId: true } });
    r = await call('SUPER_ADMIN', 'GET', `/customers/${billed.id}/delete-preview`);
    eq('preview: erased, 1 bill', [r.body?.data?.mode, r.body?.data?.bills], ['ERASE', 1]);
    r = await call('SUPER_ADMIN', 'DELETE', `/customers/${billed.id}`, { confirm: billed.phone!.slice(-4) });
    eq('erased: 200', [r.status, r.body?.data?.mode], [200, 'ERASE']);
    const after = await prisma.customer.findUniqueOrThrow({ where: { id: billed.id } });
    eq('their personal details are gone', [after.name, after.phone, after.email, after.notes, after.tags, after.birthday, after.gstNumber, after.whatsappOffers, !!after.deletedAt],
      ['Removed customer', null, null, null, [], null, null, false, true]);
    const orderAfter = await prisma.salesOrder.findUniqueOrThrow({ where: { id: o.id }, select: { total: true, orderNumber: true, customerId: true } });
    eq('the bill is untouched (number, total, still linked)', [orderAfter.orderNumber, String(orderAfter.total), orderAfter.customerId], [orderBefore.orderNumber, String(orderBefore.total), orderBefore.customerId]);
    r = await call('SUPER_ADMIN', 'GET', `/customers/card?phone=${billed.phone}`);
    eq('the card for their number: nobody now', r.body?.data?.customer, null);
    r = await call('SUPER_ADMIN', 'GET', `/customers?search=Meera%20Krishnan`);
    check('the customers list no longer has them', !JSON.stringify(r.body).includes(billed.id), r.status);
    r = await call('SUPER_ADMIN', 'GET', `/customers/${billed.id}`);
    eq('their page: not found', r.status, 404);
    const again = await call('SUPER_ADMIN', 'POST', '/customers', { name: 'Meera K', phone: billed.phone });
    check('the number is free: a new customer can have it', again.status === 201 || again.status === 200, again);
    if (again.body?.data?.id || again.body?.id) made.push(again.body?.data?.id ?? again.body?.id);

    console.log('\n4. REFUSED WHILE MONEY OR GOODS ARE OWED');
    const credit = await person('Lata Shah', `+9190002${String(STAMP).slice(-5)}`, { storeCreditPaise: 50000 });
    r = await call('SUPER_ADMIN', 'GET', `/customers/${credit.id}/delete-preview`);
    eq('store credit: the preview says why', r.body?.data?.blocked, 'Lata Shah has ₹500 store credit. Pay it out, or let them use it, first.');
    r = await call('SUPER_ADMIN', 'DELETE', `/customers/${credit.id}`, { confirm: credit.phone!.slice(-4) });
    eq('...and the delete is refused: 409, still there', [r.status, !!(await prisma.customer.findFirst({ where: { id: credit.id, deletedAt: null } }))], [409, true]);
    const waiting = await person('Ravi Teja', `+9190003${String(STAMP).slice(-5)}`);
    const open = await billFor(waiting.id, true);
    r = await call('SUPER_ADMIN', 'DELETE', `/customers/${waiting.id}`, { confirm: waiting.phone!.slice(-4) });
    eq('an order still to go out: 409 naming it', [r.status, r.body?.message], [409, `Ravi Teja has an order still to go out (${open.orderNumber}). Send it or cancel it first.`]);

    console.log('\n5. NO PHONE, ALREADY GONE, ANOTHER SHOP');
    const nophone = await person('Walk In Wanda', null);
    r = await call('SUPER_ADMIN', 'GET', `/customers/${nophone.id}/delete-preview`);
    eq('no phone: confirmed by name', r.body?.data?.phoneLast4, null);
    r = await call('SUPER_ADMIN', 'DELETE', `/customers/${nophone.id}`, { confirm: 'walk in wanda' });
    eq('...their name in any letter case works', [r.status, r.body?.data?.mode], [200, 'REMOVE']);
    r = await call('SUPER_ADMIN', 'DELETE', `/customers/${billed.id}`, { confirm: '0000' });
    eq('already erased: 404', r.status, 404);
    const elsewhere = await prisma.customer.create({ data: { clientId: `other-${STAMP}`, customerCode: `DEL-O-${STAMP}`, name: 'Other Shop', phone: '+919000099999' } as any });
    r = await call('SUPER_ADMIN', 'DELETE', `/customers/${elsewhere.id}`, { confirm: '9999' });
    eq('another shop\'s customer: 404, untouched', [r.status, await prisma.customer.count({ where: { id: elsewhere.id } })], [404, 1]);
    await prisma.customer.delete({ where: { id: elsewhere.id } });

    console.log('\n6. CRM AND THE SECURITY LOG');
    const ev = await prisma.moduleEvent.findMany({ where: { clientId: C, module: 'crm', rowId: { in: [plain.id, billed.id] }, createdAt: { gte: started } }, select: { kind: true, rowId: true } });
    check('CRM is told: customer.deleted for the removed one, customer.updated for the erased one',
      ev.some(e => e.rowId === plain.id && e.kind === 'customer.deleted') && ev.some(e => e.rowId === billed.id && e.kind === 'customer.updated'), ev);
    await new Promise(x => setTimeout(x, 800));
    const audit = await prisma.auditLog.findMany({ where: { clientId: C, entityId: { in: [plain.id, billed.id] }, createdAt: { gte: started } }, select: { action: true, entityId: true } });
    check('the security log has both, by name', audit.some(a => a.entityId === plain.id && a.action === 'CUSTOMER_DELETED') && audit.some(a => a.entityId === billed.id && a.action === 'CUSTOMER_ERASED'), audit);
  } catch (e: any) {
    console.error(e);
    check(`the suite reached the end (stopped at: ${String(e?.message ?? e).trim().split('\n')[0]})`, false);
  } finally {
    // Bills made here: their items, then the orders, then whatever customers are left.
    await prisma.salesOrder.updateMany({ where: { id: { in: orders } }, data: { status: 'CANCELLED' as any } }).catch(() => null);
    await prisma.moduleEvent.deleteMany({ where: { clientId: C, rowId: { in: made }, createdAt: { gte: started } } }).catch(() => null);
    await prisma.customer.updateMany({ where: { id: { in: made } }, data: { deletedAt: new Date(), phone: null, storeCreditPaise: 0 } }).catch(e => console.log('left customers', e.message));
    console.log(`\n${passed} passed, ${failed} failed`);
    if (failures.length) console.log('FAILED: ' + failures.join(' | '));
    await prisma.$disconnect();
    process.exit(failed ? 1 : 0);
  }
})();
