/** What the POS session has actually done to the end-to-end shop. Read-only. */
import { prisma } from '../lib/prisma';

const CLIENT = process.argv[2] ?? 'pos-e2e-1790504083240';

async function main() {
  const orders = await prisma.salesOrder.findMany({
    where: { clientId: CLIENT },
    orderBy: { createdAt: 'asc' },
    select: {
      orderNumber: true, externalOrderId: true, total: true, status: true, createdAt: true,
      customer: { select: { name: true } },
      items: { select: { taxRateBps: true, quantity: true, totalPrice: true, hsnCode: true,
                         taxableValue: true, cgst: true, sgst: true, igst: true,
                         variant: { select: { variantCode: true } } } },
      payments: { select: { method: true, amount: true } }
    }
  });

  const stock = await prisma.inventoryStock.findMany({
    where: { clientId: CLIENT },
    select: { quantity: true, reservedQty: true, variant: { select: { variantCode: true } } }
  });

  console.log(`\n${orders.length} order(s) in ${CLIENT}`);
  for (const o of orders) {
    const t = o.createdAt.toISOString().slice(11, 19);
    console.log(`\n  ${t}  ${o.orderNumber}  ${o.externalOrderId}  Rs ${o.total}  ${o.status}  [${o.customer?.name ?? 'no customer'}]`);
    for (const i of o.items) {
      const tax = [i.cgst, i.sgst, i.igst].filter(Boolean).map(String).join(' + ') || 'no tax stored';
      console.log(`      ${i.variant?.variantCode}  x${i.quantity}  Rs ${i.totalPrice}  @ ${Number(i.taxRateBps) / 100}%  HSN ${i.hsnCode ?? '-'}  taxable ${i.taxableValue ?? '-'}  tax ${tax}`);
    }
    for (const p of o.payments) console.log(`      paid ${p.method} Rs ${p.amount}`);
  }

  console.log('\n  stock now:');
  for (const s of stock) {
    console.log(`      ${s.variant?.variantCode}  qty ${s.quantity}  reserved ${s.reservedQty}`);
  }
  await prisma.$disconnect();
}
main();
