/**
 * Pressing Publish has to reach the shop's website, not just the badge on the page.
 *
 * Until now a product could only become ACTIVE at the end of the Add Product wizard; the
 * product page offered Archive, Restore and Trash and nothing else. Every bulk-imported
 * product arrives as a DRAFT -- a spreadsheet carries no photographs -- so a shop could import
 * its whole catalogue and sell none of it. A Publish button fixes that only if the storefront
 * pipeline hears about it, which is what this proves.
 *
 * A storefront event is written per CONNECTION, so a tenant with nothing connected produces no
 * events at all -- correctly, there is no queue to fill. That is why this creates a connection
 * rather than testing against a live shop, where the absence of events proves nothing.
 *
 *   npx tsx src/scripts/verify-publish-reaches-storefront.ts
 */
import { prisma } from '../lib/prisma';
import { productService } from '../services/product.service';

let passed = 0, failed = 0;
const failures: string[] = [];
const check = (name: string, ok: boolean, detail?: string) => {
  if (ok) { passed++; console.log(`  [PASS] ${name}`); }
  else { failed++; failures.push(name); console.log(`  [FAIL] ${name}${detail ? `  -> ${detail}` : ''}`); }
};

const CLIENT = `pub-${Date.now()}`;

/** Events are written after the response, on setImmediate. Wait for them rather than race. */
const settle = () => new Promise(r => setTimeout(r, 1200));

const eventsFor = async (productCode: string) => {
  const rows: any[] = await prisma.$queryRawUnsafe(
    `SELECT event_type FROM storefront_events WHERE client_id = $1 AND product_code = $2 ORDER BY sequence ASC`,
    CLIENT, productCode
  );
  return rows.map(r => r.event_type as string);
};

async function main() {
  try {
    const location = await prisma.stockLocation.create({
      data: { clientId: CLIENT, name: 'Main Store', code: 'MAIN', type: 'STORE', active: true }
    });
    await prisma.storefrontConnection.create({
      data: {
        clientId: CLIENT, name: 'Test Shop', type: 'GENERIC', status: 'ACTIVE',
        baseUrl: 'https://example.invalid', credentialHash: 'x', credentialPrefix: 'test',
        locationIds: [location.id]
      }
    });

    const product = await productService.createProduct(CLIENT, {
      title: 'Publish Pipeline Saree', category: 'WOMEN', productType: 'READY_TO_WEAR',
      basePrice: 4500, status: 'DRAFT'
    });
    await prisma.productVariant.create({
      data: {
        clientId: CLIENT, productId: product.id, sku: `${product.productCode}-RED-FREESIZE`,
        variantCode: 'VAR-PUB-1', size: 'Free Size', colorName: 'Red', reorderLevel: 5
      }
    });
    await settle();

    console.log('\nA DRAFT IS NOT ON THE WEBSITE');
    check('creating a draft announces nothing', (await eventsFor(product.productCode)).length === 0,
      JSON.stringify(await eventsFor(product.productCode)));
    const fresh = await prisma.product.findUnique({ where: { id: product.id }, select: { status: true, publishedAt: true } });
    check('and it has never been published', fresh?.status === 'DRAFT' && fresh?.publishedAt === null,
      JSON.stringify(fresh));

    console.log('\nPUBLISH REACHES THE STOREFRONT');
    await productService.updateProduct(product.id, CLIENT, { status: 'ACTIVE' });
    await settle();
    const afterPublish = await eventsFor(product.productCode);
    check('PRODUCT_PUBLISHED is queued', afterPublish.includes('PRODUCT_PUBLISHED'), JSON.stringify(afterPublish));

    const published = await prisma.product.findUnique({ where: { id: product.id }, select: { status: true, publishedAt: true } });
    check('the product is ACTIVE', published?.status === 'ACTIVE');
    // The column existed from the beginning and nothing ever wrote it, so "what went live and
    // when" had no answer. Publishing is the moment that should fill it.
    check('and publishedAt is finally stamped', published?.publishedAt !== null, String(published?.publishedAt));

    console.log('\nTHE PUBLIC CATALOGUE CAN SEE IT');
    const { storefrontCatalogueService } = await import('../services/storefront-catalogue.service');
    const visible = await storefrontCatalogueService.getProduct({ clientId: CLIENT, locationIds: [location.id] }, product.productCode);
    check('it is readable through the storefront API', !!visible, String(visible));

    console.log('\nUNPUBLISH WITHDRAWS IT');
    await productService.updateProduct(product.id, CLIENT, { status: 'DRAFT' });
    await settle();
    const afterUnpublish = await eventsFor(product.productCode);
    check('PRODUCT_UNPUBLISHED is queued', afterUnpublish.includes('PRODUCT_UNPUBLISHED'), JSON.stringify(afterUnpublish));

    const hidden = await storefrontCatalogueService.getProduct({ clientId: CLIENT, locationIds: [location.id] }, product.productCode);
    check('and the storefront API stops serving it', !hidden, JSON.stringify(hidden));

    // Publishing twice must not announce it twice: a storefront that receives a second
    // PRODUCT_PUBLISHED for something it already has is being told to do work for nothing.
    console.log('\nSAYING IT TWICE');
    await productService.updateProduct(product.id, CLIENT, { status: 'ACTIVE' });
    await settle();
    await productService.updateProduct(product.id, CLIENT, { status: 'ACTIVE' });
    await settle();
    const twice = (await eventsFor(product.productCode)).filter(e => e === 'PRODUCT_PUBLISHED').length;
    check('publishing an already-published product sends an update, not a second publish',
      twice === 2, `PRODUCT_PUBLISHED x${twice} (expected 2: the first publish and the re-publish after unpublishing)`);

    console.log(`\n================ RESULT: ${passed} passed | ${failed} failed ================`);
    if (failures.length) { console.log('\nFailed:'); failures.forEach(f => console.log('  - ' + f)); process.exitCode = 1; }
  } finally {
    const where = { clientId: CLIENT };
    await prisma.$executeRawUnsafe(`DELETE FROM storefront_deliveries WHERE connection_id IN (SELECT id FROM storefront_connections WHERE client_id = $1)`, CLIENT).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM storefront_events WHERE client_id = $1`, CLIENT).catch(() => {});
    await prisma.storefrontConnection.deleteMany({ where }).catch(() => {});
    await prisma.inventoryStock.deleteMany({ where }).catch(() => {});
    await prisma.productVariant.deleteMany({ where }).catch(() => {});
    await prisma.product.deleteMany({ where }).catch(() => {});
    await prisma.stockLocation.deleteMany({ where }).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM inventory_client_sequences WHERE client_id = $1`, CLIENT).catch(() => {});
    console.log('\n(test tenant removed)');
    await prisma.$disconnect();
  }
}

main().catch(e => { console.error('\nSuite did not finish:', e?.message ?? e); process.exitCode = 1; });
