/**
 * A purchase order can be sent to the supplier who has to fill it.
 *
 * Until this existed, the only ways an order left the app were "Send on WhatsApp" -- which
 * opens WhatsApp and depends on the merchant pressing send -- and "Mark as Sent", which
 * delivers nothing at all and only records a claim. A supplier with an email address and no
 * WhatsApp number could not be sent an order from here; the merchant retyped it into their own
 * mail client, which is where wrong quantities come from.
 *
 * The property that matters most is the ORDER of send-then-record. A status reading SENT when
 * the message never left is worse than having no send button, because the merchant stops
 * chasing it and finds out when the stock does not arrive.
 *
 *   npx ts-node src/scripts/verify-po-email.ts
 */
import { prisma } from '../lib/prisma';
import { PurchaseOrderStatus } from '@prisma/client';
import { purchaseOrderService } from '../services/purchase-order.service';
import { mailService } from '../services/mail.service';

let passed = 0, failed = 0;
const failures: string[] = [];
const check = (name: string, ok: boolean, detail?: string) => {
  if (ok) { passed++; console.log(`  [PASS] ${name}`); }
  else { failed++; failures.push(name); console.log(`  [FAIL] ${name}${detail ? `  -> ${detail}` : ''}`); }
};

const CLIENT = `po-mail-${Date.now()}`;
const OTHER = `po-mail-other-${Date.now()}`;
// The sending account itself. A real delivery to a real inbox, so this proves the message
// leaves rather than only that our code called a function.
const INBOX = process.env.TEST_INBOX || 'inventory.scaleezy@gmail.com';

async function main() {
  try {
    console.log('SETUP');
    check('this deployment can send email at all', mailService.isConfigured(),
      'no SMTP configured -- the rest of this suite would prove nothing');
    if (!mailService.isConfigured()) throw new Error('SMTP not configured');

    const withEmail = await prisma.supplier.create({
      data: { clientId: CLIENT, supplierCode: 'SUP-TEST-1', name: 'Kanchi Silk House', email: INBOX, phone: '+919876543210' }
    });
    const noEmail = await prisma.supplier.create({
      data: { clientId: CLIENT, supplierCode: 'SUP-TEST-2', name: 'Cash Counter Traders', phone: '+919876543211' }
    });

    const product = await prisma.product.create({
      data: {
        clientId: CLIENT, title: 'Kanjivaram Silk Saree', productCode: 'PRD-TEST-1',
        slug: `kanjivaram-${Date.now()}`, category: 'WOMEN', productType: 'READY_TO_WEAR', basePrice: 8500
      }
    });
    const variant = await prisma.productVariant.create({
      data: {
        clientId: CLIENT, productId: product.id, sku: 'PO-MAIL-SKU-1', variantCode: 'VAR-TEST-1',
        colorName: 'Magenta', size: 'Free', sellingPrice: 8500, costPrice: 6200
      }
    });

    const makePO = async (supplierId: string, items = true) =>
      purchaseOrderService.createPO(CLIENT, {
        supplierId,
        expectedDeliveryDate: new Date(Date.now() + 7 * 86400_000),
        notes: 'Pre-launch test order -- please ignore.',
        items: items ? [{ variantId: variant.id, orderedQty: 12, unitPrice: 6200, productTitle: product.title, color: 'Magenta', size: 'Free' }] : []
      });

    // --- THE SUPPLIER HAS NO EMAIL ------------------------------------------
    console.log('\nA SUPPLIER WITH NO EMAIL IS SAID SO, NOT FAILED AT');
    const orphan: any = await makePO(noEmail.id);
    let refusal: any = null;
    await purchaseOrderService.emailToSupplier(CLIENT, orphan.id).catch(e => { refusal = e; });
    check('it refuses', !!refusal);
    check('with a 400, not a 500 -- retrying can never help', refusal?.statusCode === 400, String(refusal?.statusCode));
    check('and names the supplier and the fix',
      /Cash Counter Traders/.test(refusal?.message || '') && /add/i.test(refusal?.message || ''),
      refusal?.message);
    const stillDraft: any = await prisma.purchaseOrder.findUnique({ where: { id: orphan.id }, select: { status: true } });
    check('the order stays a Draft', stillDraft?.status === PurchaseOrderStatus.DRAFT, String(stillDraft?.status));

    // --- AN EMPTY ORDER -----------------------------------------------------
    console.log('\nAN EMPTY ORDER IS NOT SENT');
    const empty: any = await makePO(withEmail.id, false).catch(() => null);
    if (empty) {
      let emptyErr: any = null;
      await purchaseOrderService.emailToSupplier(CLIENT, empty.id).catch(e => { emptyErr = e; });
      check('an order with no lines is refused', emptyErr?.statusCode === 400, String(emptyErr?.statusCode));
    } else {
      // createPO rejecting it outright is the better outcome; nothing to send later.
      check('an order with no lines cannot even be created', true, 'rejected at creation');
    }

    // --- THE REAL SEND ------------------------------------------------------
    console.log('\nA REAL ORDER REACHES A REAL INBOX');
    const po: any = await makePO(withEmail.id);
    const supplierBefore: any = await prisma.supplier.findUnique({
      where: { id: withEmail.id }, select: { totalOrders: true }
    });

    const sent: any = await purchaseOrderService.emailToSupplier(CLIENT, po.id, 'Akshaya');
    check('the send reports success', sent?.sent === true);
    check('to the supplier address, not somewhere else', sent?.to === INBOX, String(sent?.to));
    check('and says the order number it sent', sent?.poNumber === po.poNumber, String(sent?.poNumber));

    const after: any = await prisma.purchaseOrder.findUnique({ where: { id: po.id }, select: { status: true } });
    check('the order is now recorded as Sent', after?.status === PurchaseOrderStatus.SENT, String(after?.status));
    check('and the send is what moved it', sent?.statusChanged === true);

    const supplierAfter: any = await prisma.supplier.findUnique({
      where: { id: withEmail.id }, select: { totalOrders: true, lastOrderDate: true }
    });
    check('the supplier is credited with one order',
      supplierAfter.totalOrders === supplierBefore.totalOrders + 1,
      `${supplierBefore.totalOrders} -> ${supplierAfter.totalOrders}`);

    // --- SENDING A SECOND COPY ----------------------------------------------
    console.log('\nSENDING A SECOND COPY DOES NOT COUNT A SECOND ORDER');
    // A supplier who mislaid the order asks for it again. That is one order, sent twice.
    const resent: any = await purchaseOrderService.emailToSupplier(CLIENT, po.id, 'Akshaya');
    check('the copy goes out', resent?.sent === true);
    check('but nothing about the order changed', resent?.statusChanged === false);
    const supplierResent: any = await prisma.supplier.findUnique({
      where: { id: withEmail.id }, select: { totalOrders: true }
    });
    check('and the supplier is still credited with exactly one',
      supplierResent.totalOrders === supplierBefore.totalOrders + 1,
      `${supplierBefore.totalOrders} -> ${supplierResent.totalOrders}`);

    console.log('\nNOR DOES PRESSING "MARK AS SENT" TWICE');
    // The same counter, reached by the older button. This was a live bug: every press added
    // another order to the supplier's lifetime total, so the number the supplier list sorts on
    // was counting button presses.
    const beforeDouble: any = await prisma.supplier.findUnique({
      where: { id: withEmail.id }, select: { totalOrders: true }
    });
    await purchaseOrderService.updatePOStatus(CLIENT, po.id, PurchaseOrderStatus.SENT);
    await purchaseOrderService.updatePOStatus(CLIENT, po.id, PurchaseOrderStatus.SENT);
    const afterDouble: any = await prisma.supplier.findUnique({
      where: { id: withEmail.id }, select: { totalOrders: true }
    });
    check('an already-sent order re-marked as sent adds nothing',
      afterDouble.totalOrders === beforeDouble.totalOrders,
      `${beforeDouble.totalOrders} -> ${afterDouble.totalOrders}`);

    // --- ISOLATION ----------------------------------------------------------
    console.log("\nONE SHOP CANNOT MAIL ANOTHER SHOP'S ORDER");
    // An order carries what a shop pays its supplier. Another tenant reaching it would be
    // reading someone else's buying prices -- and mailing them to a third party.
    const draft2: any = await makePO(withEmail.id);
    let cross: any = null;
    await purchaseOrderService.emailToSupplier(OTHER, draft2.id).catch(e => { cross = e; });
    check('a stranger gets a 404, not the order', cross?.statusCode === 404, String(cross?.statusCode));
    const untouched: any = await prisma.purchaseOrder.findUnique({ where: { id: draft2.id }, select: { status: true } });
    check('and the order is untouched', untouched?.status === PurchaseOrderStatus.DRAFT, String(untouched?.status));

    console.log(`\n================ RESULT: ${passed} passed | ${failed} failed ================`);
    console.log(`\n(check ${INBOX} -- two copies of ${po.poNumber} should be there)`);
    if (failures.length) { console.log('\nFailed:'); failures.forEach(f => console.log('  - ' + f)); process.exitCode = 1; }
  } finally {
    const ids = { in: [CLIENT, OTHER] };
    await prisma.purchaseOrderItem.deleteMany({ where: { po: { clientId: { in: [CLIENT, OTHER] } } } }).catch(() => {});
    await prisma.purchaseOrder.deleteMany({ where: { clientId: ids } }).catch(() => {});
    await prisma.inventoryTransaction.deleteMany({ where: { clientId: ids } }).catch(() => {});
    await prisma.inventoryStock.deleteMany({ where: { clientId: ids } }).catch(() => {});
    await prisma.productVariant.deleteMany({ where: { clientId: ids } }).catch(() => {});
    await prisma.product.deleteMany({ where: { clientId: ids } }).catch(() => {});
    await prisma.supplier.deleteMany({ where: { clientId: ids } }).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM inventory_client_sequences WHERE client_id = ANY($1::text[])`, [CLIENT, OTHER]).catch(() => {});
    console.log('\n(test tenant removed)');
    await prisma.$disconnect();
  }
}

main().catch(e => { console.error('\nSuite did not finish:', e?.message ?? e); process.exitCode = 1; });
