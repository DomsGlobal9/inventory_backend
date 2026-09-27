/**
 * The GST fields through the real API, on a throwaway shop of its own.
 *
 *   A  a product saves with an HSN and a rate, and reads them back
 *   B  a bad HSN is refused, in words a shopkeeper can act on
 *   C  clearing the box stores NOTHING, not an empty string
 *   D  a draft with no HSN at all still saves -- refusing belongs at the invoice, not here
 *   E  the rate is frozen onto a sale line, and the line still serialises
 *
 * Needs the API on :4006.
 *   npx tsx src/scripts/verify-gst-api.ts
 */
import { prisma } from '../lib/prisma';
import { productService } from '../services/product.service';

let passed = 0, failed = 0;
const check = (name: string, ok: boolean, detail = '') => {
  if (ok) { passed++; console.log(`  [PASS] ${name}${detail ? '  -- ' + detail : ''}`); }
  else { failed++; console.log(`  [FAIL] ${name}${detail ? '  -- ' + detail : ''}`); }
};

const CLIENT = `gst-api-${Date.now()}`;

async function main() {
  /*
   * A tenant here is not a row -- there is no Client table. It is just a clientId that rows carry,
   * with its settings beside it. So "making a shop" is making its settings, and cleaning up is
   * deleting everything that carries the id.
   */
  await prisma.clientSettings.create({
    data: { clientId: CLIENT, gstRegistration: 'REGULAR', gstStateCode: '36' }
  });

  const base = {
    title: 'Test saree', category: 'WOMEN' as any, productType: 'READY_TO_WEAR' as any,
    dressType: 'Saree', fabric: 'Cotton', basePrice: 3000, status: 'ACTIVE' as any
  };

  console.log('\nA. SAVING AND READING BACK');
  const made = await productService.createProduct(CLIENT, {
    ...base, hsnCode: '5208', taxRateBps: 500, taxSlabbed: false, priceIsExclusive: false
  } as any);
  const read = await productService.getProductById(made.id, CLIENT);
  check('the HSN comes back', (read as any).hsnCode === '5208', String((read as any).hsnCode));
  check('the rate comes back', (read as any).taxRateBps === 500, String((read as any).taxRateBps));
  check('and the slab flag defaults to false', (read as any).taxSlabbed === false);

  console.log('\nB. A BAD HSN IS REFUSED');
  let refused = '';
  try {
    const { createProductSchema } = await import('../validations/product.schema');
    createProductSchema.parse({ ...base, hsnCode: '52' });
  } catch (e: any) {
    refused = JSON.stringify(e.issues?.[0]?.message ?? e.message);
  }
  check('a 2-digit HSN is refused', refused.includes('4, 6 or 8 digits'), refused || '(not refused)');

  console.log('\nC. CLEARING THE BOX STORES NOTHING');
  await productService.updateProduct(made.id, CLIENT, { hsnCode: '' } as any);
  const cleared = await prisma.product.findUnique({ where: { id: made.id }, select: { hsnCode: true } });
  check('an empty box becomes null, not ""', cleared?.hsnCode === null, JSON.stringify(cleared?.hsnCode));

  console.log('\nD. A PRODUCT WITH NO GST AT ALL STILL SAVES');
  const plain = await productService.createProduct(CLIENT, { ...base, title: 'No GST yet', status: 'DRAFT' as any } as any);
  check('saving works without an HSN', Boolean(plain.id));
  check('and it is stored as not-set', (plain as any).hsnCode == null);

  console.log('\nE. THE FROZEN LINE');
  const { freezeTaxForLine } = await import('../services/pricing/freezeTax');
  const frozen = freezeTaxForLine(
    { hsnCode: '5208', taxRateBps: 500, taxSlabbed: false, priceIsExclusive: false },
    { quantity: 1, unitPriceMinor: 312100, totalPriceMinor: 312100 },
    true, false
  );
  check('a rate is frozen', frozen.taxRateBps === 500);
  let serialised = true;
  try { JSON.stringify({ ...frozen }); } catch { serialised = false; }
  check('and an order item carrying it serialises', serialised, 'the BigInt fault would break this');
}

main()
  .then(async () => {
    await prisma.product.deleteMany({ where: { clientId: CLIENT } });
    await prisma.clientSettings.deleteMany({ where: { clientId: CLIENT } });
    console.log(`\nRESULT: ${passed} passed | ${failed} failed`);
    process.exit(failed === 0 ? 0 : 1);
  })
  .catch(async (e) => {
    console.error('CRASHED:', e.message);
    await prisma.product.deleteMany({ where: { clientId: CLIENT } }).catch(() => {});
    await prisma.clientSettings.deleteMany({ where: { clientId: CLIENT } }).catch(() => {});
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
