/**
 * A throwaway shop for the POS session's end-to-end run.
 *
 * Three products chosen to cover the three tax shapes a till actually meets, not three of the
 * same thing: a cotton saree (fabric, flat 5%), a silk saree (still fabric, still 5% -- the exact
 * case the POS seed had at 12%), and a stitched lehenga over Rs 2,500 (slabbed, so 18%).
 *
 * The credential is printed ONCE because only its hash is stored. Scoped to the one location, so
 * the run cannot reach anything else even by accident.
 *
 *   npx tsx src/scripts/setup-pos-e2e.ts
 *   npx tsx src/scripts/setup-pos-e2e.ts --teardown <clientId>
 */
import { prisma } from '../lib/prisma';
import { generateCredential } from '../utils/storefrontCredential';
import { POS_BASE_URL } from '../utils/posConnection';

const STOCK = 25;

const ITEMS = [
  { title: 'Cotton saree',   dressType: 'Saree',   fabric: 'Cotton', price: 3000,
    hsn: '5208', bps: 500,  slabbed: false, colour: 'Indigo' },
  { title: 'Silk saree',     dressType: 'Saree',   fabric: 'Silk',   price: 12999,
    hsn: '5007', bps: 500,  slabbed: false, colour: 'Maroon' },
  { title: 'Stitched lehenga', dressType: 'Lehenga', fabric: 'Silk', price: 8500,
    hsn: '6204', bps: 1800, slabbed: true,  colour: 'Emerald' }
];

async function teardown(clientId: string) {
  const w = { clientId };
  const steps: [string, () => Promise<unknown>][] = [
    ['pos events',   () => prisma.posInboundEvent.deleteMany({ where: w })],
    ['deliveries',   () => prisma.storefrontDelivery.deleteMany({ where: w })],
    ['events',       () => prisma.storefrontEvent.deleteMany({ where: w })],
    ['payments',     () => prisma.salesOrderPayment.deleteMany({ where: w })],
    // Returns point at the order, so they go before it or the order will not delete.
    ['return items', () => prisma.salesReturnItem.deleteMany({ where: { salesReturn: w } })],
    ['returns',      () => prisma.salesReturn.deleteMany({ where: w })],
    ['orders',       () => prisma.salesOrder.deleteMany({ where: w })],
    ['transactions', () => prisma.inventoryTransaction.deleteMany({ where: w })],
    ['customers',    () => prisma.customer.deleteMany({ where: w })],
    ['stock',        () => prisma.inventoryStock.deleteMany({ where: w })],
    ['variants',     () => prisma.productVariant.deleteMany({ where: w })],
    ['products',     () => prisma.product.deleteMany({ where: w })],
    ['connections',  () => prisma.storefrontConnection.deleteMany({ where: w })],
    ['locations',    () => prisma.stockLocation.deleteMany({ where: w })]
  ];
  for (const [label, run] of steps) {
    try { const r: any = await run(); console.log(`  ${label}: ${r?.count ?? 0}`); }
    catch (e: any) { console.log(`  ${label}: could not delete -- ${e.message.split('\n')[0]}`); }
  }
}

async function main() {
  const teardownAt = process.argv.indexOf('--teardown');
  if (teardownAt > -1) {
    const id = process.argv[teardownAt + 1];
    if (!id) { console.log('--teardown needs a clientId'); return prisma.$disconnect(); }
    console.log(`tearing down ${id}`);
    await teardown(id);
    return prisma.$disconnect();
  }

  const stamp = Date.now();
  const CLIENT = `pos-e2e-${stamp}`;

  const location = await prisma.stockLocation.create({
    data: { clientId: CLIENT, name: 'Counter', code: `E2E-${stamp}`, type: 'STORE' as any, active: true }
  });

  const made: { code: string; title: string; price: number; bps: number; slabbed: boolean; hsn: string }[] = [];

  for (const [i, it] of ITEMS.entries()) {
    const product = await prisma.product.create({
      data: {
        clientId: CLIENT, productCode: `E2EP-${stamp}-${i}`, slug: `e2e-${stamp}-${i}`,
        title: it.title, category: 'WOMEN' as any, productType: 'READY_TO_WEAR' as any,
        dressType: it.dressType, fabric: it.fabric, basePrice: it.price,
        status: 'ACTIVE' as any, publishedAt: new Date(),
        hsnCode: it.hsn, taxRateBps: it.bps, taxSlabbed: it.slabbed, priceIsExclusive: false
      }
    });
    const variant = await prisma.productVariant.create({
      data: {
        productId: product.id, clientId: CLIENT, colorName: it.colour, size: 'Free Size',
        variantCode: `E2EV-${stamp}-${i}`, sku: `E2ESKU-${stamp}-${i}`, sellingPrice: it.price
      }
    });
    await prisma.inventoryStock.create({
      data: { clientId: CLIENT, variantId: variant.id, locationId: location.id, quantity: STOCK, reservedQty: 0 }
    });
    made.push({ code: variant.variantCode, title: it.title, price: it.price,
                bps: it.bps, slabbed: it.slabbed, hsn: it.hsn });
  }

  const cred = generateCredential();
  await prisma.storefrontConnection.create({
    data: {
      clientId: CLIENT, name: 'POS end-to-end till', baseUrl: POS_BASE_URL, // a till key (utils/posConnection): /pos/v1 refuses website keys
      credentialHash: cred.hash, credentialPrefix: cred.prefix,
      status: 'ACTIVE', locationIds: [location.id]
    }
  });

  console.log('');
  console.log('=========== POS END-TO-END SHOP ===========');
  console.log(`base URL     http://localhost:4006/api/v1/pos/v1`);
  console.log(`header       X-Storefront-Key: ${cred.plaintext}`);
  console.log(`tenant       ${CLIENT}`);
  console.log(`location     ${location.id}  (Counter -- the credential reaches only this one)`);
  console.log('');
  console.log(`products     ${STOCK} in stock each`);
  for (const m of made) {
    console.log(`  ${m.code}  ${m.title} Rs ${m.price}  HSN ${m.hsn}  ` +
      `${m.bps / 100}%${m.slabbed ? ' (slabbed)' : ' (flat)'}`);
  }
  console.log('');
  console.log(`teardown     npx tsx src/scripts/setup-pos-e2e.ts --teardown ${CLIENT}`);
  console.log('==========================================');
  await prisma.$disconnect();
}
main();
