/**
 * Receiving a purchase order: the stock, the order, and the goods receipt it leaves behind.
 *
 *   A  a part delivery into a chosen location: a GRN with what each line was measured against,
 *      who counted it, the supplier's invoice number; stock into THAT location; order part-received
 *   B  the same press twice, in a row and at the same moment: one receipt, stock moved once
 *   C  the rest of the order: into the location selected at the top of the app, the earlier
 *      delivery remembered on the lines, order received; the order page lists both receipts
 *   D  what must be refused, leaving nothing behind: receiving a finished order, more than
 *      ordered, half a piece, a line twice, another shop's location, a switched-off one, two
 *      locations at once, a key from another order, nothing at all, no permission
 *   E  the letterhead: only the owner sets it, bad GSTIN and email refused, blanks cleared,
 *      and saving the name does not wipe it
 *   F  deleting a client takes its receipts with it
 *
 * Fixtures on demo-client (a location, a supplier, a product, three people), all removed at the
 * end, and the shop's letterhead put back as it was. Needs the API on :4006.
 *
 *   npx tsx src/scripts/verify-po-receipts.ts
 */
import axios, { AxiosInstance } from 'axios';
import { prisma } from '../lib/prisma';
import { AuthService } from '../services/auth.service';
import { purchaseOrderService } from '../services/purchase-order.service';
import { platformAdminService } from '../services/platform-admin.service';
import { forgetShopSettings } from '../lib/clientSettings';

const BASE = process.env.VERIFY_API_URL || 'http://localhost:4006/api/v1';
const CLIENT = 'demo-client';
const STAMP = Date.now();

let passed = 0, failed = 0;
const failures: string[] = [];
const check = (name: string, ok: boolean, detail?: string) => {
  if (ok) { passed++; console.log(`  [PASS] ${name}`); }
  else { failed++; failures.push(name); console.log(`  [FAIL] ${name}${detail ? `  -> ${detail}` : ''}`); }
};
const brief = (r: any) => `${r.status} ${JSON.stringify(r.data).slice(0, 220)}`;

const made = {
  users: [] as string[], roles: [] as string[], locationId: '', supplierId: '', productId: '',
  variantIds: [] as string[], poIds: [] as string[], tenant: `grn-delete-${STAMP}`
};
let savedLetterhead: any = null;

async function person(name: string, roleId: string): Promise<{ id: string; api: AxiosInstance; name: string }> {
  const displayName = `GRN ${name} ${STAMP}`;
  const u = await prisma.user.create({ data: { clientId: CLIENT, email: `grn-${name}-${STAMP}@example.com`, name: displayName, password: 'unused', status: 'ACTIVE' } });
  made.users.push(u.id);
  await prisma.userRole.create({ data: { userId: u.id, roleId } });
  const api = axios.create({
    baseURL: BASE,
    headers: { Authorization: `Bearer ${AuthService.generateToken({ userId: u.id, clientId: CLIENT })}` },
    validateStatus: () => true
  });
  return { id: u.id, api, name: displayName };
}

async function customRole(name: string, keys: string[]) {
  const role = await prisma.role.create({ data: { clientId: CLIENT, name: `GRN-${name}-${STAMP}` } });
  made.roles.push(role.id);
  const perms = await prisma.permission.findMany({ where: { key: { in: keys } } });
  await prisma.rolePermission.createMany({ data: perms.map(p => ({ roleId: role.id, permissionId: p.id })) });
  return role.id;
}

const stockAt = async (variantId: string, locationId: string) =>
  (await prisma.inventoryStock.findFirst({ where: { variantId, locationId } }))?.quantity ?? 0;
const key = (n: number) => `grn-verify-${STAMP}-${n}`;

async function main() {
  const main = await prisma.stockLocation.findFirstOrThrow({ where: { clientId: CLIENT, code: 'MAIN-STORE' } });
  const store = await prisma.stockLocation.create({ data: { clientId: CLIENT, name: `GRN Back Room ${STAMP}`, code: `GRN-${STAMP}`, type: 'WAREHOUSE', active: true } as any });
  made.locationId = store.id;
  const supplier = await prisma.supplier.create({ data: { clientId: CLIENT, supplierCode: `SUP-GRN-${STAMP}`, name: `GRN Weavers ${STAMP}` } as any });
  made.supplierId = supplier.id;
  const product = await prisma.product.create({ data: { clientId: CLIENT, productCode: `PRD-GRN-${STAMP}`, title: `GRN Saree ${STAMP}`, slug: `grn-saree-${STAMP}`, category: 'WOMEN', basePrice: 3000, status: 'ACTIVE', productType: 'READY_TO_WEAR' } });
  made.productId = product.id;
  for (const [i, colour] of ['Red', 'Blue'].entries()) {
    const v = await prisma.productVariant.create({ data: { clientId: CLIENT, productId: product.id, sku: `GRN-${STAMP}-${colour}`, variantCode: `VC-GRN-${STAMP}-${i}`, size: 'Free', colorName: colour, sellingPrice: 3000 } });
    made.variantIds.push(v.id);
  }
  const [red, blue] = made.variantIds;

  const adminRole = await prisma.role.findFirstOrThrow({ where: { clientId: CLIENT, name: 'ADMIN' } });
  const ownerRole = await prisma.role.findFirstOrThrow({ where: { clientId: CLIENT, name: 'SUPER_ADMIN' } });
  const receiver = await person('receiver', await customRole('RECEIVER', ['purchase_order:receive']));
  const admin = await person('admin', adminRole.id);
  const owner = await person('owner', ownerRole.id);
  const salesRole = await prisma.role.findFirstOrThrow({ where: { clientId: CLIENT, name: 'SALES' } });
  const sales = await person('sales', salesRole.id);

  const newPO = async (qty: [number, number]) => {
    const r = await admin.api.post('/purchase-orders', { supplierId: supplier.id, items: [{ variantId: red, orderedQty: qty[0], unitPrice: 1200 }, { variantId: blue, orderedQty: qty[1], unitPrice: 800.5 }] });
    if (r.status !== 201) throw new Error(`PO create ${brief(r)}`);
    made.poIds.push(r.data.data.id);
    await admin.api.put(`/purchase-orders/${r.data.data.id}/status`, { status: 'SENT' });
    const items = r.data.data.items as any[];
    return { id: r.data.data.id as string, poNumber: r.data.data.poNumber as string, redItem: items.find(i => i.variantId === red).id as string, blueItem: items.find(i => i.variantId === blue).id as string };
  };

  // ── A ─────────────────────────────────────────────────────────────────────────────────────
  console.log('\nA. A PART DELIVERY INTO A CHOSEN LOCATION');
  const po = await newPO([10, 6]);
  const first = await receiver.api.post(`/purchase-orders/${po.id}/receive`, {
    receipts: [{ poItemId: po.redItem, quantityReceived: 4 }, { poItemId: po.blueItem, quantityReceived: 0 }],
    locationId: store.id, supplierReference: '  INV-2291  ', notes: 'Two boxes damp', requestKey: key(1)
  });
  const r1 = first.data?.receipt;
  check('someone who may only receive goods can receive them', first.status === 200 && !!r1, brief(first));
  check('a goods receipt comes back with a GRN number', /^GRN-\d{6}$/.test(r1?.receiptNumber ?? ''), r1?.receiptNumber);
  check('  ...into the chosen location, counted by that person, with the invoice number trimmed',
    r1?.location?.id === store.id && r1?.receivedByName === receiver.name && r1?.supplierReference === 'INV-2291' && r1?.notes === 'Two boxes damp', JSON.stringify(r1)?.slice(0, 300));
  check('  ...listing only the line that arrived, with what it was measured against',
    r1?.items?.length === 1 && r1.items[0].sku === `GRN-${STAMP}-Red` && r1.items[0].orderedQty === 10 && r1.items[0].receivedBefore === 0 && r1.items[0].quantity === 4 && Number(r1.items[0].unitPrice) === 1200, JSON.stringify(r1?.items));
  check('the order is part-received and not yet marked received', first.data?.data?.status === 'PARTIALLY_RECEIVED' && !first.data?.data?.receivedAt, first.data?.data?.status);
  check('the stock went into the chosen location, not the main store', (await stockAt(red, store.id)) === 4 && (await stockAt(red, main.id)) === 0);
  const tx = await prisma.inventoryTransaction.findFirst({ where: { variantId: red, locationId: store.id }, orderBy: { createdAt: 'desc' } });
  check('the stock movement names the person, not "Admin"', tx?.createdBy === receiver.name && tx?.referenceId === po.poNumber, JSON.stringify({ by: tx?.createdBy, ref: tx?.referenceId }));

  // ── B ─────────────────────────────────────────────────────────────────────────────────────
  console.log('\nB. THE SAME PRESS TWICE');
  const again = await receiver.api.post(`/purchase-orders/${po.id}/receive`, {
    receipts: [{ poItemId: po.redItem, quantityReceived: 4 }], locationId: store.id, requestKey: key(1)
  });
  check('pressing Confirm again with the same key returns the same receipt', again.status === 200 && again.data?.duplicate === true && again.data?.receipt?.id === r1?.id, brief(again));
  check('  ...and moves no more stock', (await stockAt(red, store.id)) === 4 && (await prisma.purchaseReceipt.count({ where: { poId: po.id } })) === 1);

  const [c1, c2] = await Promise.all([1, 2].map(() => receiver.api.post(`/purchase-orders/${po.id}/receive`, {
    receipts: [{ poItemId: po.blueItem, quantityReceived: 2 }], locationId: store.id, requestKey: key(2)
  })));
  check('two presses at the same moment both answer with one receipt', c1.status === 200 && c2.status === 200 && c1.data?.receipt?.id === c2.data?.receipt?.id, `${brief(c1)} | ${brief(c2)}`);
  check('  ...and the stock moved once', (await stockAt(blue, store.id)) === 2 && (await prisma.purchaseReceipt.count({ where: { poId: po.id } })) === 2);

  // ── C ─────────────────────────────────────────────────────────────────────────────────────
  console.log('\nC. THE REST OF THE ORDER');
  const rest = await receiver.api.post(`/purchase-orders/${po.id}/receive`, {
    receipts: [{ poItemId: po.redItem, quantityReceived: 6 }, { poItemId: po.blueItem, quantityReceived: 4 }], requestKey: key(3)
  }, { headers: { 'x-location-id': main.id } });
  const r3 = rest.data?.receipt;
  check('with no location chosen, the goods go to the location selected at the top of the app', rest.status === 200 && r3?.location?.id === main.id
    && (await stockAt(red, main.id)) === 6 && (await stockAt(blue, main.id)) === 4, brief(rest));
  const redLine = r3?.items?.find((i: any) => i.sku.endsWith('Red'));
  const blueLine = r3?.items?.find((i: any) => i.sku.endsWith('Blue'));
  check('  ...and each line remembers what came before it', redLine?.receivedBefore === 4 && redLine?.quantity === 6 && blueLine?.receivedBefore === 2 && blueLine?.quantity === 4, JSON.stringify(r3?.items));
  check('the order is now received, with the date it completed', rest.data?.data?.status === 'RECEIVED' && !!rest.data?.data?.receivedAt, rest.data?.data?.status);
  check('receipt numbers follow on from each other', Number(r3?.receiptNumber?.slice(4)) === Number(c1.data?.receipt?.receiptNumber?.slice(4)) + 1, `${c1.data?.receipt?.receiptNumber} then ${r3?.receiptNumber}`);

  const page = await receiver.api.get(`/purchase-orders/${po.id}`);
  const receipts = page.data?.data?.receipts ?? [];
  check('the order page lists all three deliveries, oldest first, each with its lines and location',
    receipts.length === 3 && receipts.map((r: any) => r.receiptNumber).join() === [r1?.receiptNumber, c1.data?.receipt?.receiptNumber, r3?.receiptNumber].join()
    && receipts.every((r: any) => r.items.length > 0 && r.location?.name), JSON.stringify(receipts.map((r: any) => r.receiptNumber)));

  // ── D ─────────────────────────────────────────────────────────────────────────────────────
  console.log('\nD. WHAT MUST BE REFUSED');
  const countNow = async () => prisma.purchaseReceipt.count({ where: { poId: { in: made.poIds } } });
  const before = await countNow();
  const done = await receiver.api.post(`/purchase-orders/${po.id}/receive`, { receipts: [{ poItemId: po.redItem, quantityReceived: 1 }], requestKey: key(4) });
  check('receiving against a finished order is refused', done.status === 400, brief(done));

  const po2 = await newPO([5, 5]);
  const stock2 = await stockAt(red, main.id);
  const cases: [string, any, number][] = [
    ['more than was ordered', { receipts: [{ poItemId: po2.redItem, quantityReceived: 6 }] }, 400],
    ['half a piece', { receipts: [{ poItemId: po2.redItem, quantityReceived: 2.5 }] }, 400],
    ['the same line twice in one delivery', { receipts: [{ poItemId: po2.redItem, quantityReceived: 3 }, { poItemId: po2.redItem, quantityReceived: 3 }] }, 400],
    ['nothing at all', { receipts: [{ poItemId: po2.redItem, quantityReceived: 0 }] }, 400],
    ['a line from a different order', { receipts: [{ poItemId: po.blueItem, quantityReceived: 1 }] }, 400],
    ["another shop's location", { receipts: [{ poItemId: po2.redItem, quantityReceived: 1 }], locationId: (await prisma.stockLocation.findFirst({ where: { clientId: { not: CLIENT } } }))?.id ?? 'nope' }, 400],
    ['two locations in one delivery', { receipts: [{ poItemId: po2.redItem, quantityReceived: 1, locationId: main.id }, { poItemId: po2.blueItem, quantityReceived: 1, locationId: store.id }] }, 400],
    ['a key already used on another order', { receipts: [{ poItemId: po2.redItem, quantityReceived: 1 }], requestKey: key(1) }, 409]
  ];
  for (const [label, body, status] of cases) {
    const r = await receiver.api.post(`/purchase-orders/${po2.id}/receive`, body);
    check(`refused: ${label} (${status})`, r.status === status && !/prisma|Invalid `/i.test(JSON.stringify(r.data)), brief(r));
  }
  await prisma.stockLocation.update({ where: { id: store.id }, data: { active: false } });
  const off = await receiver.api.post(`/purchase-orders/${po2.id}/receive`, { receipts: [{ poItemId: po2.redItem, quantityReceived: 1 }], locationId: store.id });
  check('refused: a switched-off location, and it says which', off.status === 400 && off.data?.message?.includes(store.name), brief(off));
  await prisma.stockLocation.update({ where: { id: store.id }, data: { active: true } });
  const noPerm = await sales.api.post(`/purchase-orders/${po2.id}/receive`, { receipts: [{ poItemId: po2.redItem, quantityReceived: 1 }] });
  check('refused: someone who may not receive goods (403)', noPerm.status === 403, brief(noPerm));
  const po2Now = await prisma.purchaseOrder.findUniqueOrThrow({ where: { id: po2.id }, include: { items: true } });
  check('none of those left a receipt, a received count, a status change or stock behind',
    (await countNow()) === before && po2Now.status === 'SENT' && po2Now.items.every(i => i.receivedQty === 0) && (await stockAt(red, main.id)) === stock2);

  const plain = await receiver.api.post(`/purchase-orders/${po2.id}/receive`, { receipts: [{ poItemId: po2.redItem, quantityReceived: 1 }] });
  check('with no location anywhere, the goods go to the main store', plain.status === 200 && plain.data?.receipt?.location?.id === main.id, brief(plain));
  check('  ...and a refused delivery before it used up no GRN number', Number(plain.data?.receipt?.receiptNumber?.slice(4)) === Number(r3?.receiptNumber?.slice(4)) + 1, `${r3?.receiptNumber} then ${plain.data?.receipt?.receiptNumber}`);

  // ── E ─────────────────────────────────────────────────────────────────────────────────────
  console.log('\nE. THE LETTERHEAD');
  savedLetterhead = await prisma.clientSettings.findUnique({ where: { clientId: CLIENT } });
  const details = { businessAddress: '12-4-56, Main Bazaar, Vijayawada 520001', businessPhone: '+91 98765 43210', businessEmail: 'orders@example.com', gstNumber: '37abcde1234f1z5' };
  const notOwner = await admin.api.put('/branding/details', details);
  check('only the owner can set the letterhead', notOwner.status === 403, brief(notOwner));
  const set = await owner.api.put('/branding/details', details);
  check('the owner sets it, and the GSTIN is stored in capitals', set.status === 200 && set.data?.data?.gstNumber === '37ABCDE1234F1Z5' && set.data?.data?.businessAddress === details.businessAddress, brief(set));
  const seen = await receiver.api.get('/branding');
  check('everyone signed in reads it, for printing', seen.status === 200 && seen.data?.data?.businessPhone === details.businessPhone, brief(seen));
  const badGst = await owner.api.put('/branding/details', { gstNumber: '12345' });
  const badEmail = await owner.api.put('/branding/details', { businessEmail: 'not-an-email' });
  const junk = await owner.api.put('/branding/details', { businessName: 'sneaky' });
  check('a malformed GSTIN or email, or a field that is not a letterhead detail, is refused', badGst.status === 400 && badEmail.status === 400 && junk.status === 400, `${brief(badGst)} | ${brief(badEmail)} | ${brief(junk)}`);
  const named = await owner.api.put('/branding/name', { businessName: savedLetterhead?.businessName ?? 'Demo' });
  check('saving the shop name answers with the letterhead intact', named.status === 200 && named.data?.data?.gstNumber === '37ABCDE1234F1Z5', brief(named));
  const cleared = await owner.api.put('/branding/details', { businessPhone: '   ' });
  check('a blank field is cleared, the others kept', cleared.status === 200 && cleared.data?.data?.businessPhone === null && cleared.data?.data?.businessEmail === details.businessEmail, brief(cleared));

  // ── F ─────────────────────────────────────────────────────────────────────────────────────
  console.log('\nF. DELETING A CLIENT');
  const t = made.tenant;
  const tLoc = await prisma.stockLocation.create({ data: { clientId: t, name: 'Main', code: 'MAIN-STORE', type: 'STORE', active: true } as any });
  await prisma.user.create({ data: { clientId: t, email: `grn-delete-${STAMP}@example.com`, name: 'Doomed', password: 'unused', status: 'ACTIVE' } });
  const tSup = await prisma.supplier.create({ data: { clientId: t, supplierCode: 'SUP-1', name: 'S' } as any });
  const tProd = await prisma.product.create({ data: { clientId: t, productCode: 'PRD-1', title: 'T', slug: `t-${STAMP}`, category: 'WOMEN', basePrice: 10, status: 'ACTIVE', productType: 'READY_TO_WEAR' } });
  const tVar = await prisma.productVariant.create({ data: { clientId: t, productId: tProd.id, sku: `T-${STAMP}`, variantCode: `VC-T-${STAMP}`, size: 'M', colorName: 'Red', sellingPrice: 10 } });
  const tPo = await purchaseOrderService.createPO(t, { supplierId: tSup.id, items: [{ variantId: tVar.id, orderedQty: 3, unitPrice: 5 }] });
  await purchaseOrderService.receiveGoods(t, tPo.id, { receipts: [{ poItemId: tPo.items[0].id, quantityReceived: 2 }], locationId: tLoc.id }, { name: 'x' });
  check('the throwaway client has a receipt to delete', (await prisma.purchaseReceipt.count({ where: { clientId: t } })) === 1);
  await platformAdminService.deleteClientCompletely(t, t);
  check('deleting it removes its receipts and their lines', (await prisma.purchaseReceipt.count({ where: { clientId: t } })) === 0
    && (await prisma.purchaseReceiptItem.count({ where: { variantId: tVar.id } })) === 0);
}

async function cleanup() {
  if (savedLetterhead !== null) {
    await prisma.clientSettings.update({
      where: { clientId: CLIENT },
      data: {
        businessName: savedLetterhead.businessName, businessAddress: savedLetterhead.businessAddress,
        businessPhone: savedLetterhead.businessPhone, businessEmail: savedLetterhead.businessEmail, gstNumber: savedLetterhead.gstNumber
      }
    }).catch(() => undefined);
    forgetShopSettings(CLIENT);
  }
  // Receipts and their lines go with the orders (cascade).
  await prisma.purchaseOrder.deleteMany({ where: { id: { in: made.poIds } } });
  await prisma.inventoryTransaction.deleteMany({ where: { variantId: { in: made.variantIds } } });
  await prisma.inventoryAlert.deleteMany({ where: { variantId: { in: made.variantIds } } }).catch(() => undefined);
  await prisma.inventoryStock.deleteMany({ where: { variantId: { in: made.variantIds } } });
  await prisma.supplierProduct.deleteMany({ where: { variantId: { in: made.variantIds } } });
  await prisma.productVariant.deleteMany({ where: { id: { in: made.variantIds } } });
  if (made.productId) await prisma.product.deleteMany({ where: { id: made.productId } });
  if (made.supplierId) await prisma.supplier.deleteMany({ where: { id: made.supplierId } });
  if (made.locationId) {
    await prisma.dailyLocationSnapshot.deleteMany({ where: { locationId: made.locationId } }).catch(() => undefined);
    await prisma.stockLocation.deleteMany({ where: { id: made.locationId } });
  }
  await prisma.userRole.deleteMany({ where: { userId: { in: made.users } } });
  await prisma.auditLog.deleteMany({ where: { userId: { in: made.users } } }).catch(() => undefined);
  await prisma.user.deleteMany({ where: { id: { in: made.users } } });
  await prisma.rolePermission.deleteMany({ where: { roleId: { in: made.roles } } });
  await prisma.role.deleteMany({ where: { id: { in: made.roles } } });

  const left = [
    await prisma.purchaseOrder.count({ where: { id: { in: made.poIds } } }),
    await prisma.purchaseReceipt.count({ where: { poId: { in: made.poIds } } }),
    await prisma.productVariant.count({ where: { id: { in: made.variantIds } } }),
    await prisma.stockLocation.count({ where: { id: made.locationId || 'none' } }),
    await prisma.user.count({ where: { id: { in: made.users } } }),
    await prisma.user.count({ where: { clientId: made.tenant } })
  ];
  check('cleanup left nothing behind on demo-client', left.every(n => n === 0), left.join());
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
