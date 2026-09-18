/**
 * Selling, round two: what the order screen is told a line still holds, and what the customer form
 * is told when it is refused.
 *
 *   A  heldQty comes from the live reservations. A confirmed order holds every line in full; a part
 *      sent one holds only what has not gone; closing the rest short (the order ends DISPATCHED, not
 *      CANCELLED) and cancelling both leave 0 on every line; a draft holds nothing. The number always
 *      agrees with the store's own reserved count.
 *   B  the customer rules speak plain English: a bad email, an email sent as a number, a blank name
 *      and an unknown status are each refused with a sentence, never Zod's "Invalid email" or
 *      "Expected string, received number"; a blank email is still no email.
 *
 * A throwaway shop of its own, removed at the end.
 *
 *   npx ts-node --transpile-only src/scripts/verify-selling-round2.ts
 */
import { prisma } from '../lib/prisma';
import { salesOrderService } from '../services/sales-order.service';
import { dispatchService } from '../services/dispatch.service';
import { customerService } from '../services/customer.service';
import { customerSchema, customerUpdateSchema } from '../validations/customer.schema';

let passed = 0, failed = 0;
const failures: string[] = [];
const check = (name: string, ok: boolean, detail?: string) => {
  if (ok) { passed++; console.log(`  [PASS] ${name}`); }
  else { failed++; failures.push(name); console.log(`  [FAIL] ${name}${detail ? `  -> ${detail}` : ''}`); }
};

const CLIENT = `sell-round2-${Date.now()}`;

async function reservedAt(variantId: string, locationId: string) {
  const s = await prisma.inventoryStock.findFirst({ where: { variantId, locationId }, select: { reservedQty: true } });
  return s?.reservedQty ?? 0;
}

async function held(orderId: string) {
  const o: any = await salesOrderService.getOrderById(CLIENT, orderId);
  // Gold first, then red, whatever order the lines come back in.
  const lines = [...o.items].sort((a: any, b: any) => String(a.variant?.colorName).localeCompare(String(b.variant?.colorName)));
  return { status: o.status as string, byLine: lines.map((i: any) => i.heldQty) as number[], leaked: o.items.some((i: any) => 'inventoryReservations' in i) };
}

async function main() {
  try {
    console.log('SETUP: one shop, two items, twenty of each');
    const shop = await prisma.stockLocation.create({ data: { clientId: CLIENT, name: 'Main Store', code: 'MAIN', type: 'STORE', active: true } });
    const product = await prisma.product.create({
      data: { clientId: CLIENT, title: 'Banarasi Silk Saree', productCode: 'PRD-R2-1', slug: `banarasi-${Date.now()}`, category: 'WOMEN', productType: 'READY_TO_WEAR', basePrice: 4000 }
    });
    const variants = [];
    for (const [i, colour] of ['Gold', 'Red'].entries()) {
      const v = await prisma.productVariant.create({
        data: { clientId: CLIENT, productId: product.id, sku: `R2-${colour}-${Date.now()}`, variantCode: `VAR-R2-${i}`, colorName: colour, size: 'Free', sellingPrice: 4000, costPrice: 2500, averageCost: 2500 }
      });
      await prisma.inventoryStock.create({ data: { clientId: CLIENT, variantId: v.id, locationId: shop.id, quantity: 20, reservedQty: 0 } });
      variants.push(v);
    }
    const [gold, red] = variants;
    const customer: any = await customerService.createCustomer(CLIENT, { name: 'Farah Khan', phone: `+919${String(Date.now()).slice(-9)}` } as any);

    const newOrder = () => salesOrderService.createFullOrder(CLIENT, shop.id, {
      customer: { id: customer.id },
      items: [{ variantId: gold.id, quantity: 1, unitPrice: 4000 }, { variantId: red.id, quantity: 2, unitPrice: 4000 }]
    } as any) as Promise<any>;

    // ── A ─────────────────────────────────────────────────────────────────────────────
    console.log('\nA. WHAT EACH LINE STILL HOLDS');
    const draft = await newOrder();
    const d0 = await held(draft.id);
    check('a draft holds nothing on any line', d0.status === 'DRAFT' && d0.byLine.every(n => n === 0), JSON.stringify(d0));
    check('the reservation rows themselves are not sent to the screen', !d0.leaked);

    await salesOrderService.confirmOrder(CLIENT, draft.id);
    const d1 = await held(draft.id);
    check('a confirmed order holds every line in full (1 and 2)', d1.status === 'CONFIRMED' && d1.byLine.join() === '1,2', JSON.stringify(d1));
    check('and the store agrees: 1 gold and 2 red reserved', await reservedAt(gold.id, shop.id) === 1 && await reservedAt(red.id, shop.id) === 2);

    const redLine = draft.items.find((i: any) => i.variantId === red.id);
    await dispatchService.createDispatch(CLIENT, draft.id, [{ salesOrderItemId: redLine.id, quantity: 1 }]);
    const d2 = await held(draft.id);
    check('after sending one red, the order is part sent and holds 1 gold and 1 red', d2.status === 'PARTIALLY_DISPATCHED' && d2.byLine.join() === '1,1', JSON.stringify(d2));

    await dispatchService.createDispatch(CLIENT, draft.id, [{ salesOrderItemId: redLine.id, quantity: 1 }]);
    const d3 = await held(draft.id);
    check('after sending both red, only the gold is still held', d3.status === 'PARTIALLY_DISPATCHED' && d3.byLine.join() === '1,0', JSON.stringify(d3));

    const closed: any = await salesOrderService.cancelOrder(CLIENT, draft.id);
    const d4 = await held(draft.id);
    check('closing the rest ends the order DISPATCHED, not CANCELLED', closed.status === 'DISPATCHED' && d4.status === 'DISPATCHED', `${closed.status} / ${d4.status}`);
    check('and the unsent gold line now holds 0 (it said RESERVED 1)', d4.byLine.every(n => n === 0), JSON.stringify(d4));
    check('the store agrees: nothing reserved for either item', await reservedAt(gold.id, shop.id) === 0 && await reservedAt(red.id, shop.id) === 0);

    const other = await newOrder();
    await salesOrderService.confirmOrder(CLIENT, other.id);
    await salesOrderService.cancelOrder(CLIENT, other.id);
    const c = await held(other.id);
    check('a cancelled order holds 0 on every line', c.status === 'CANCELLED' && c.byLine.every(n => n === 0), JSON.stringify(c));

    // Nothing sent, everything sent: a fully dispatched order holds nothing either.
    const full = await newOrder();
    await salesOrderService.confirmOrder(CLIENT, full.id);
    await dispatchService.createDispatch(CLIENT, full.id, full.items.map((i: any) => ({ salesOrderItemId: i.id, quantity: i.quantity })));
    const f = await held(full.id);
    check('a fully sent order holds 0 on every line', f.status === 'DISPATCHED' && f.byLine.every(n => n === 0), JSON.stringify(f));

    // ── B ─────────────────────────────────────────────────────────────────────────────
    console.log('\nB. THE CUSTOMER FORM IS REFUSED IN PLAIN ENGLISH');
    const developer = /Invalid email|Expected string|Required|Invalid enum|received/;
    const said = (r: any) => (r.success ? '(accepted)' : r.error.errors[0].message);
    const refusals: [string, any, RegExp][] = [
      ['an email with no @', { name: 'Priya', phone: '9848022338', email: 'not an email' }, /doesn't look right.*leave the box empty/],
      ['an email sent as a number', { name: 'Priya', phone: '9848022338', email: 12345 }, /email must be written as text/],
      ['a blank name', { name: '   ', phone: '9848022338' }, /Enter the customer's name/],
      ['no name at all', { phone: '9848022338' }, /Enter the customer's name/],
      ['a status that does not exist', { name: 'Priya', phone: '9848022338', status: 'DELETED' }, /Active, Inactive or Archived/],
      ['a group sent as a number', { name: 'Priya', phone: '9848022338', tags: [7] }, /group name must be written as text/],
    ];
    for (const [label, body, want] of refusals) {
      const r = customerSchema.safeParse(body);
      check(`refused in plain words: ${label}`, !r.success && want.test(said(r)) && !developer.test(said(r)), said(r));
    }
    const upd = customerUpdateSchema.safeParse({ email: 'priya@' });
    check('a change to a bad email says the same sentence', !upd.success && /doesn't look right/.test(said(upd)), said(upd));
    const blank = customerSchema.safeParse({ name: 'Priya', phone: '9848022338', email: '  ' });
    check('an empty email box is still no email, not a bad one', blank.success && blank.data.email == null, said(blank));
    const good = customerSchema.safeParse({ name: 'Priya', phone: '9848022338', email: ' priya@example.com ' });
    check('a real email is accepted and trimmed', good.success && good.data.email === 'priya@example.com', said(good));

    console.log(`\n================ RESULT: ${passed} passed | ${failed} failed ================`);
    if (failures.length) { console.log('\nFailed:'); failures.forEach(x => console.log('  - ' + x)); process.exitCode = 1; }
  } finally {
    const where = { clientId: CLIENT };
    await prisma.dispatchItem.deleteMany({ where: { dispatch: where } }).catch(() => {});
    await prisma.dispatch.deleteMany({ where }).catch(() => {});
    await prisma.inventoryReservation.deleteMany({ where }).catch(() => {});
    await prisma.salesOrderItem.deleteMany({ where: { salesOrder: where } }).catch(() => {});
    await prisma.salesOrder.deleteMany({ where }).catch(() => {});
    await prisma.customer.deleteMany({ where }).catch(() => {});
    await prisma.inventoryTransaction.deleteMany({ where }).catch(() => {});
    await prisma.inventoryEvent.deleteMany({ where }).catch(() => {});
    await prisma.inventoryStock.deleteMany({ where }).catch(() => {});
    await prisma.productVariant.deleteMany({ where }).catch(() => {});
    await prisma.product.deleteMany({ where }).catch(() => {});
    await prisma.stockLocation.deleteMany({ where }).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM inventory_client_sequences WHERE client_id = $1`, CLIENT).catch(() => {});
    const left = await prisma.salesOrder.count({ where }) + await prisma.productVariant.count({ where }) + await prisma.stockLocation.count({ where });
    console.log(`\n(test shop removed, rows left: ${left})`);
    await prisma.$disconnect();
  }
}

main().catch(e => { console.error('\nSuite did not finish:', e?.message ?? e); process.exitCode = 1; });
