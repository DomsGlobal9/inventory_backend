/**
 * What would a bill for these pieces actually look like? READ ONLY.
 *
 * Takes real products from a real shop, runs them through the same buildBill() a till will use,
 * and prints the invoice as a shopkeeper would see it. Nothing is saved and no order is created --
 * this exists to answer "is the tax right?" with a real catalogue rather than a made-up one.
 *
 *   npx tsx src/scripts/preview-bill.ts <clientId> <PRD-CODE> [PRD-CODE...]
 *   npx tsx src/scripts/preview-bill.ts sphl PRD-000002 PRD-000003
 */
import { prisma } from '../lib/prisma';
import { buildBill, financialYearOf, type BillLineInput } from '../services/pricing/bill';
import { hsnForInvoice } from '../services/pricing/hsn';
import type { GstRegistration } from '../services/pricing/tax';

const rs = (minor: number) => `Rs ${(minor / 100).toFixed(2)}`;

async function main() {
  const [clientId, ...codes] = process.argv.slice(2);
  if (!clientId || !codes.length) {
    console.error('Usage: npx tsx src/scripts/preview-bill.ts <clientId> <PRD-CODE> [PRD-CODE...]');
    process.exit(1);
  }

  const settings = await prisma.clientSettings.findUnique({
    where: { clientId },
    select: {
      businessName: true, gstNumber: true, gstRegistration: true,
      gstStateCode: true, turnoverAboveFiveCrore: true
    }
  });

  const registration = (settings?.gstRegistration ?? 'UNREGISTERED') as GstRegistration;

  const products = await prisma.product.findMany({
    where: { clientId, productCode: { in: codes }, trashedAt: null },
    select: {
      productCode: true, title: true, basePrice: true,
      hsnCode: true, taxRateBps: true, taxSlabbed: true, priceIsExclusive: true,
      variants: { select: { sellingPrice: true, hsnCode: true, taxRateBps: true }, take: 1 }
    }
  });

  if (!products.length) {
    console.log(`No such products for ${clientId}.`);
    return;
  }

  const lines: BillLineInput[] = products.map(p => {
    const v = p.variants[0];
    const unit = Math.round(Number(v?.sellingPrice ?? p.basePrice) * 100);
    return {
      label: `${p.productCode} ${p.title ?? ''}`.trim(),
      quantity: 1,
      netUnitPriceMinor: unit,
      lineTotalMinor: unit,
      hsnCode: v?.hsnCode ?? p.hsnCode,
      taxRateBps: v?.taxRateBps ?? p.taxRateBps,
      taxSlabbed: Boolean(p.taxSlabbed),
      priceIsExclusive: Boolean(p.priceIsExclusive)
    };
  });

  const bill = buildBill({ registration, shopStateCode: settings?.gstStateCode ?? null, lines });

  console.log(`\n${settings?.businessName ?? clientId}`);
  console.log(`GSTIN ${settings?.gstNumber ?? '(none)'}   registration ${registration}   state ${settings?.gstStateCode ?? '(not set)'}`);
  console.log(`${bill.documentKind.replace(/_/g, ' ')}   financial year ${financialYearOf(new Date())}\n`);

  const w = (s: string, n: number) => s.padEnd(n).slice(0, n);
  console.log(`${w('item', 34)} ${w('hsn', 7)} ${w('rate', 6)} ${w('taxable', 12)} ${w('cgst', 10)} ${w('sgst', 10)} ${w('igst', 10)} total`);
  console.log('-'.repeat(103));

  for (const l of bill.lines) {
    const hsn = l.hsnCode ? hsnForInvoice(l.hsnCode, Boolean(settings?.turnoverAboveFiveCrore)) : '-';
    console.log(
      `${w(l.label, 34)} ${w(hsn, 7)} ${w(`${l.rateBpsCharged / 100}%`, 6)} ` +
      `${w(rs(l.taxableValueMinor), 12)} ${w(rs(l.cgstMinor), 10)} ${w(rs(l.sgstMinor), 10)} ` +
      `${w(rs(l.igstMinor), 10)} ${rs(l.lineGrossMinor)}`
    );
  }

  console.log('-'.repeat(103));
  console.log(`${w('', 49)}${w(rs(bill.taxableMinor), 12)} ${w(rs(bill.cgstMinor), 10)} ${w(rs(bill.sgstMinor), 10)} ${w(rs(bill.igstMinor), 10)} ${rs(bill.grossMinor)}`);
  if (bill.roundOffMinor !== 0) console.log(`${w('round off', 49)}${rs(bill.roundOffMinor)}`);
  console.log(`\n   TOTAL TAX  ${rs(bill.totalTaxMinor)}`);
  console.log(`   PAYABLE    ${rs(bill.payableMinor)}`);

  if (!bill.issuable) {
    console.log('\n   THIS BILL CANNOT BE ISSUED:');
    for (const p of bill.problems) console.log(`     - ${p}`);
  } else {
    console.log('\n   Ready to issue.');
  }
}

main()
  .catch(e => { console.error('FAILED:', e.message); process.exit(1); })
  .finally(() => prisma.$disconnect());
