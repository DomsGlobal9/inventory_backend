/**
 * Selling stock, and taking it back.
 *
 * This is the arithmetic a shop is judged on. If a sale does not take the piece out of stock,
 * the shop sells the same saree twice and disappoints a customer standing in front of them. If
 * a return does not put it back, the piece is invisible -- it is on the shelf and the system
 * says it is not, so it never gets sold again.
 *
 * The path is longer than it looks: an order is CONFIRMED (which reserves, but does not remove),
 * then DISPATCHED (which removes), and only a dispatched piece can be returned. A return is
 * then requested, received, inspected -- where someone decides whether it goes back on the
 * shelf or into the bin -- and completed. Every one of those steps can be got wrong
 * independently, and none of them had a test.
 *
 * The distinction that matters most is RESERVED against ON HAND. A confirmed order must make
 * the piece unsellable without pretending it has left the building, because it is still there
 * and a stock count will find it.
 *
 *   npx ts-node src/scripts/verify-sell-and-return.ts
 */
import { prisma } from '../lib/prisma';
import { salesOrderService } from '../services/sales-order.service';
import { dispatchService } from '../services/dispatch.service';
import { returnService } from '../services/return.service';
import { customerService } from '../services/customer.service';
import { inventoryTransferService } from '../services/inventory-transfer.service';

let passed = 0, failed = 0;
const failures: string[] = [];
const check = (name: string, ok: boolean, detail?: string) => {
  if (ok) { passed++; console.log(`  [PASS] ${name}`); }
  else { failed++; failures.push(name); console.log(`  [FAIL] ${name}${detail ? `  -> ${detail}` : ''}`); }
};

const CLIENT = `sell-return-${Date.now()}`;
const OTHER = `sell-return-other-${Date.now()}`;

/** What the shop can see of one variant at one place: what is there, and what is spoken for. */
async function stockAt(variantId: string, locationId: string) {
  const s = await prisma.inventoryStock.findFirst({
    where: { variantId, locationId },
    select: { quantity: true, reservedQty: true }
  });
  return { onHand: s?.quantity ?? 0, reserved: s?.reservedQty ?? 0, available: (s?.quantity ?? 0) - (s?.reservedQty ?? 0) };
}

async function main() {
  try {
    console.log('SETUP: one shop, two locations, twenty pieces at the first');

    const shop = await prisma.stockLocation.create({
      data: { clientId: CLIENT, name: 'Chirala Showroom', code: 'CHIRALA', type: 'STORE', active: true }
    });
    const warehouse = await prisma.stockLocation.create({
      data: { clientId: CLIENT, name: 'Godown', code: 'GODOWN', type: 'WAREHOUSE', active: true }
    });

    const product = await prisma.product.create({
      data: {
        clientId: CLIENT, title: 'Pochampally Ikat Saree', productCode: 'PRD-SR-1',
        slug: `pochampally-${Date.now()}`, category: 'WOMEN', productType: 'READY_TO_WEAR', basePrice: 4200
      }
    });
    const variant = await prisma.productVariant.create({
      data: {
        clientId: CLIENT, productId: product.id, sku: `SR-${Date.now()}`, variantCode: 'VAR-SR-1',
        colorName: 'Indigo', size: 'Free', sellingPrice: 4200, costPrice: 2600, averageCost: 2600
      }
    });
    await prisma.inventoryStock.create({
      data: { clientId: CLIENT, variantId: variant.id, locationId: shop.id, quantity: 20, reservedQty: 0 }
    });

    const customer: any = await customerService.createCustomer(CLIENT, {
      name: 'Lakshmi Devi', phone: '+919000000001', email: 'lakshmi@example.com'
    } as any);
    check('a customer can be created with a code that can be quoted', !!customer?.customerCode, String(customer?.customerCode));

    // --- CONFIRMING RESERVES, IT DOES NOT REMOVE ----------------------------
    console.log('\nCONFIRMING AN ORDER SPEAKS FOR STOCK WITHOUT REMOVING IT');
    const order: any = await salesOrderService.createFullOrder(CLIENT, shop.id, {
      customer: { id: customer.id },
      items: [{ variantId: variant.id, quantity: 3, unitPrice: 4200 }]
    });
    check('an order is created with a number a customer can quote', !!order?.orderNumber, String(order?.orderNumber));

    const beforeConfirm = await stockAt(variant.id, shop.id);
    await salesOrderService.confirmOrder(CLIENT, order.id);
    const afterConfirm = await stockAt(variant.id, shop.id);

    check('the pieces are still physically there', afterConfirm.onHand === beforeConfirm.onHand,
      `${beforeConfirm.onHand} -> ${afterConfirm.onHand}`);
    check('but three of them are spoken for', afterConfirm.reserved === beforeConfirm.reserved + 3,
      `${beforeConfirm.reserved} -> ${afterConfirm.reserved}`);
    check('so three fewer can be sold to anyone else', afterConfirm.available === beforeConfirm.available - 3,
      `${beforeConfirm.available} -> ${afterConfirm.available}`);

    // --- CANCELLING GIVES THEM BACK -----------------------------------------
    console.log('\nCANCELLING GIVES THE STOCK BACK, AND ONLY ONCE');
    const cancelled: any = await salesOrderService.createFullOrder(CLIENT, shop.id, {
      customer: { id: customer.id },
      items: [{ variantId: variant.id, quantity: 2, unitPrice: 4200 }]
    });
    await salesOrderService.confirmOrder(CLIENT, cancelled.id);
    const withCancelReserved = await stockAt(variant.id, shop.id);
    await salesOrderService.cancelOrder(CLIENT, cancelled.id);
    const afterCancel = await stockAt(variant.id, shop.id);
    check('cancelling releases what it reserved', afterCancel.reserved === withCancelReserved.reserved - 2,
      `${withCancelReserved.reserved} -> ${afterCancel.reserved}`);

    // Cancelling an already-cancelled order must not release a second time, or stock the shop
    // does not have becomes sellable.
    await salesOrderService.cancelOrder(CLIENT, cancelled.id).catch(() => {});
    const afterDoubleCancel = await stockAt(variant.id, shop.id);
    check('cancelling twice does not release twice', afterDoubleCancel.reserved === afterCancel.reserved,
      `${afterCancel.reserved} -> ${afterDoubleCancel.reserved}`);

    // --- DISPATCH REMOVES ---------------------------------------------------
    console.log('\nDISPATCHING IS WHAT ACTUALLY TAKES THE STOCK OUT');
    const beforeDispatch = await stockAt(variant.id, shop.id);
    const dispatch: any = await dispatchService.createDispatch(CLIENT, order.id,
      order.items.map((i: any) => ({ salesOrderItemId: i.id, quantity: 3 })));
    const afterDispatch = await stockAt(variant.id, shop.id);

    check('a dispatch is recorded with a number', !!dispatch?.dispatchNumber, String(dispatch?.dispatchNumber));
    check('three pieces leave the shop', afterDispatch.onHand === beforeDispatch.onHand - 3,
      `${beforeDispatch.onHand} -> ${afterDispatch.onHand}`);
    check('and the reservation is consumed, not left behind',
      afterDispatch.reserved === beforeDispatch.reserved - 3,
      `${beforeDispatch.reserved} -> ${afterDispatch.reserved}`);
    check('so available is unchanged -- it was already spoken for',
      afterDispatch.available === beforeDispatch.available,
      `${beforeDispatch.available} -> ${afterDispatch.available}`);

    // --- YOU CANNOT RETURN WHAT WAS NEVER SENT ------------------------------
    console.log('\nA CUSTOMER CANNOT RETURN MORE THAN THEY WERE SENT');
    const dispatchItem: any = dispatch.items[0];
    let tooMany: any = null;
    await returnService.createReturn(CLIENT, order.id, [{ dispatchItemId: dispatchItem.id, quantity: 5 }])
      .catch(e => { tooMany = e; });
    check('returning five of three is refused', !!tooMany, String(tooMany?.message).slice(0, 70));
    const afterBadReturn = await stockAt(variant.id, shop.id);
    check('and nothing was put back on the shelf', afterBadReturn.onHand === afterDispatch.onHand,
      `${afterDispatch.onHand} -> ${afterBadReturn.onHand}`);

    // --- A RETURN THAT GOES BACK ON THE SHELF -------------------------------
    console.log('\nA RETURNED PIECE IN GOOD CONDITION GOES BACK ON THE SHELF');
    const ret: any = await returnService.createReturn(CLIENT, order.id,
      [{ dispatchItemId: dispatchItem.id, quantity: 1 }], 'Colour not as expected');
    check('the return has a number the customer can quote', !!ret?.returnNumber, String(ret?.returnNumber));

    await returnService.receiveReturn(CLIENT, ret.id);
    await returnService.inspectReturn(CLIENT, ret.id,
      ret.items.map((i: any) => ({ salesReturnItemId: i.id, disposition: 'RESTOCK' as const })));

    const beforeComplete = await stockAt(variant.id, shop.id);
    await returnService.completeReturn(CLIENT, ret.id);
    const afterComplete = await stockAt(variant.id, shop.id);

    check('the piece comes back into stock', afterComplete.onHand === beforeComplete.onHand + 1,
      `${beforeComplete.onHand} -> ${afterComplete.onHand}`);
    check('and it is sellable again, not reserved', afterComplete.available === beforeComplete.available + 1,
      `${beforeComplete.available} -> ${afterComplete.available}`);

    // --- A DAMAGED RETURN DOES NOT --------------------------------------
    console.log('\nA DAMAGED PIECE IS TAKEN BACK BUT NOT PUT BACK ON SALE');
    // The most valuable distinction in this whole flow. A torn saree that reappears as
    // sellable stock is sold to somebody, who then returns it too.
    const damaged: any = await returnService.createReturn(CLIENT, order.id,
      [{ dispatchItemId: dispatchItem.id, quantity: 1 }], 'Torn at the border');
    await returnService.receiveReturn(CLIENT, damaged.id);
    await returnService.inspectReturn(CLIENT, damaged.id,
      damaged.items.map((i: any) => ({ salesReturnItemId: i.id, disposition: 'DAMAGED' as const })));

    const beforeDamaged = await stockAt(variant.id, shop.id);
    await returnService.completeReturn(CLIENT, damaged.id);
    const afterDamaged = await stockAt(variant.id, shop.id);
    check('a damaged piece does not become sellable stock',
      afterDamaged.onHand === beforeDamaged.onHand,
      `${beforeDamaged.onHand} -> ${afterDamaged.onHand}`);

    // --- AN UNINSPECTED RETURN CANNOT BE FINISHED ---------------------------
    console.log('\nA RETURN NOBODY LOOKED AT CANNOT BE FINISHED');
    // Otherwise "complete" becomes the button everyone presses, and damaged stock silently
    // goes back on the shelf because deciding was optional.
    const unchecked: any = await returnService.createReturn(CLIENT, order.id,
      [{ dispatchItemId: dispatchItem.id, quantity: 1 }]);
    let notInspected: any = null;
    await returnService.completeReturn(CLIENT, unchecked.id).catch(e => { notInspected = e; });
    check('completing before inspection is refused', !!notInspected, String(notInspected?.message).slice(0, 60));

    // --- ISOLATION ----------------------------------------------------------
    console.log("\nONE SHOP CANNOT TOUCH ANOTHER SHOP'S SALE OR RETURN");
    let crossOrder: any = null, crossReturn: any = null;
    await salesOrderService.cancelOrder(OTHER, order.id).catch(e => { crossOrder = e; });
    await returnService.completeReturn(OTHER, unchecked.id).catch(e => { crossReturn = e; });
    check('a stranger cannot cancel the order', !!crossOrder);
    check('nor complete the return', !!crossReturn);
    const untouched = await stockAt(variant.id, shop.id);
    check('and the stock is exactly where it was', untouched.onHand === afterDamaged.onHand,
      `${afterDamaged.onHand} -> ${untouched.onHand}`);

    // --- MOVING STOCK BETWEEN SHOPS -----------------------------------------
    console.log('\nMOVING STOCK BETWEEN TWO SHOPS DOES NOT CREATE OR LOSE ANY');
    const shopBefore = await stockAt(variant.id, shop.id);
    const godownBefore = await stockAt(variant.id, warehouse.id);
    const totalBefore = shopBefore.onHand + godownBefore.onHand;

    await inventoryTransferService.transferStock(
      CLIENT, shop.id, warehouse.id, [{ variantId: variant.id, quantity: 5 }], 'Restocking the godown');

    const shopAfter = await stockAt(variant.id, shop.id);
    const godownAfter = await stockAt(variant.id, warehouse.id);
    check('five leave the shop', shopAfter.onHand === shopBefore.onHand - 5,
      `${shopBefore.onHand} -> ${shopAfter.onHand}`);
    check('five arrive at the godown', godownAfter.onHand === godownBefore.onHand + 5,
      `${godownBefore.onHand} -> ${godownAfter.onHand}`);
    check('and the shop owns exactly as many as before',
      shopAfter.onHand + godownAfter.onHand === totalBefore,
      `${totalBefore} -> ${shopAfter.onHand + godownAfter.onHand}`);

    console.log('\nA SHOP CANNOT SEND STOCK IT DOES NOT HAVE');
    let overTransfer: any = null;
    await inventoryTransferService.transferStock(
      CLIENT, warehouse.id, shop.id, [{ variantId: variant.id, quantity: 9999 }], 'Impossible')
      .catch(e => { overTransfer = e; });
    check('an impossible transfer is refused', !!overTransfer, String(overTransfer?.message).slice(0, 60));
    const godownFinal = await stockAt(variant.id, warehouse.id);
    check('and neither side moved', godownFinal.onHand === godownAfter.onHand,
      `${godownAfter.onHand} -> ${godownFinal.onHand}`);

    console.log(`\n================ RESULT: ${passed} passed | ${failed} failed ================`);
    if (failures.length) { console.log('\nFailed:'); failures.forEach(f => console.log('  - ' + f)); process.exitCode = 1; }
  } finally {
    const where = { clientId: { in: [CLIENT, OTHER] } };
    await prisma.salesReturnItem.deleteMany({ where: { salesReturn: where } }).catch(() => {});
    await prisma.salesReturn.deleteMany({ where }).catch(() => {});
    await prisma.dispatchItem.deleteMany({ where: { dispatch: where } }).catch(() => {});
    await prisma.dispatch.deleteMany({ where }).catch(() => {});
    await prisma.inventoryReservation.deleteMany({ where }).catch(() => {});
    await prisma.salesOrderItem.deleteMany({ where: { salesOrder: where } }).catch(() => {});
    await prisma.salesOrder.deleteMany({ where }).catch(() => {});
    await prisma.customer.deleteMany({ where }).catch(() => {});
    await prisma.inventoryTransfer.deleteMany({ where }).catch(() => {});
    await prisma.inventoryTransaction.deleteMany({ where }).catch(() => {});
    await prisma.inventoryEvent.deleteMany({ where }).catch(() => {});
    await prisma.inventoryStock.deleteMany({ where }).catch(() => {});
    await prisma.productVariant.deleteMany({ where }).catch(() => {});
    await prisma.product.deleteMany({ where }).catch(() => {});
    await prisma.stockLocation.deleteMany({ where }).catch(() => {});
    await prisma.$executeRawUnsafe(
      `DELETE FROM inventory_client_sequences WHERE client_id = ANY($1::text[])`, [CLIENT, OTHER]).catch(() => {});
    console.log('\n(test tenant removed)');
    await prisma.$disconnect();
  }
}

main().catch(e => { console.error('\nSuite did not finish:', e?.message ?? e); process.exitCode = 1; });
