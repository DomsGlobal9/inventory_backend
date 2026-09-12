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

/**
 * Events are written after the response returns, on setImmediate, and writing one means
 * re-reading the product through the catalogue service for every connection. A fixed sleep is
 * therefore a guess, and the first version of this suite guessed 1200ms -- which passed once
 * and then reported "PRODUCT_PUBLISHED is queued -> []" on the next run. A test that sometimes
 * passes is worse than no test, because it teaches you to ignore it.
 *
 * So: wait for the thing, not for a duration. Poll until the event appears or give up loudly.
 */
const settle = () => new Promise(r => setTimeout(r, 250));

async function waitForEvent(productCode: string, eventType: string, timeoutMs = 15000): Promise<string[]> {
  const deadline = Date.now() + timeoutMs;
  let seen: string[] = [];
  while (Date.now() < deadline) {
    seen = await eventsFor(productCode);
    if (seen.includes(eventType)) return seen;
    await new Promise(r => setTimeout(r, 200));
  }
  return seen;
}

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
    const afterPublish = await waitForEvent(product.productCode, 'PRODUCT_PUBLISHED');
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
    const afterUnpublish = await waitForEvent(product.productCode, 'PRODUCT_UNPUBLISHED');
    check('PRODUCT_UNPUBLISHED is queued', afterUnpublish.includes('PRODUCT_UNPUBLISHED'), JSON.stringify(afterUnpublish));

    const hidden = await storefrontCatalogueService.getProduct({ clientId: CLIENT, locationIds: [location.id] }, product.productCode);
    check('and the storefront API stops serving it', !hidden, JSON.stringify(hidden));

    // Publishing twice must not announce it twice: a storefront that receives a second
    // PRODUCT_PUBLISHED for something it already has is being told to do work for nothing.
    console.log('\nSAYING IT TWICE');
    await productService.updateProduct(product.id, CLIENT, { status: 'ACTIVE' });
    await waitForEvent(product.productCode, 'PRODUCT_PUBLISHED');
    await productService.updateProduct(product.id, CLIENT, { status: 'ACTIVE' });
    // No new PRODUCT_PUBLISHED to wait for here -- re-publishing something already published
    // sends PRODUCT_UPDATED -- so this one genuinely has to settle on a clock.
    await new Promise(r => setTimeout(r, 3000));
    const twice = (await eventsFor(product.productCode)).filter(e => e === 'PRODUCT_PUBLISHED').length;
    check('publishing an already-published product sends an update, not a second publish',
      twice === 2, `PRODUCT_PUBLISHED x${twice} (expected 2: the first publish and the re-publish after unpublishing)`);

    /*
     * Bulk publish is the whole reason the single-product path is not enough, and it is also
     * where a shortcut would do the most damage: an updateMany would be one fast query that
     * skipped the publishedAt stamp and told the website nothing, leaving a shop with a
     * hundred products it believes are on sale and a site that has never heard of them.
     */
    console.log('\nPUBLISHING A SELECTION TELLS THE STOREFRONT ABOUT EACH ONE');
    const batch = [];
    for (let i = 0; i < 3; i++) {
      const p = await productService.createProduct(CLIENT, {
        title: `Bulk Saree ${i + 1}`, category: 'WOMEN', productType: 'READY_TO_WEAR',
        basePrice: 1000 + i, status: 'DRAFT'
      });
      await prisma.productVariant.create({
        data: {
          clientId: CLIENT, productId: p.id, sku: `${p.productCode}-RED-FREESIZE`,
          variantCode: `VAR-BULK-${i}`, size: 'Free Size', colorName: 'Red', reorderLevel: 5
        }
      });
      batch.push(p);
    }
    await settle();

    // One of the ids is already gone, which is what a stale list on someone's screen looks
    // like. It must be reported, not counted as a success and not allowed to abandon the rest.
    const result = await productService.bulkSetStatus(
      CLIENT, [...batch.map(p => p.id), 'ffffffff-ffff-4fff-8fff-ffffffffffff'], 'ACTIVE'
    );
    await settle();

    check('every real product changed', result.changed === 3, JSON.stringify(result));
    check('the missing one is reported rather than silently dropped',
      result.failed.length === 1 && /no longer exists/i.test(result.failed[0]!.reason), JSON.stringify(result.failed));

    const announced = await Promise.all(batch.map(p => waitForEvent(p.productCode, 'PRODUCT_PUBLISHED')));
    check('each one produced its own PRODUCT_PUBLISHED',
      announced.every(e => e.includes('PRODUCT_PUBLISHED')), JSON.stringify(announced));

    const stamped = await prisma.product.findMany({
      where: { id: { in: batch.map(p => p.id) } },
      select: { status: true, publishedAt: true }
    });
    check('each one is ACTIVE and stamped',
      stamped.every(p => p.status === 'ACTIVE' && p.publishedAt !== null), JSON.stringify(stamped));

    // Re-running the same selection is what happens when somebody is not sure it worked.
    const again = await productService.bulkSetStatus(CLIENT, batch.map(p => p.id), 'ACTIVE');
    check('running it again changes nothing and says so',
      again.changed === 0 && again.unchanged === 3, JSON.stringify(again));

    const unpublished = await productService.bulkSetStatus(CLIENT, batch.map(p => p.id), 'DRAFT');
    await settle();
    check('unpublishing the selection withdraws all of them', unpublished.changed === 3, JSON.stringify(unpublished));
    const withdrawn = await Promise.all(batch.map(p => waitForEvent(p.productCode, 'PRODUCT_UNPUBLISHED')));
    check('and each is withdrawn from the storefront',
      withdrawn.every(e => e.includes('PRODUCT_UNPUBLISHED')), JSON.stringify(withdrawn));

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
