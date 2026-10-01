/**
 * The Day Book's sales and profit, checked against a real till sale and a real return.
 *
 * Three things were wrong and are pinned here:
 *   1. GST was counted as profit (cost was taken off the tax-inclusive figure);
 *   2. a return never came back off sales or profit;
 *   3. one store's Day Book showed the WHOLE shop's revenue.
 *
 * It runs on the shared test shop, which charges GST, and that shop has other sales on the same
 * day -- so nothing here asserts a total. Every check is a DIFFERENCE: the Day Book before a step
 * and after it, and the exact amount each figure should have moved by. The amounts come from the
 * bill itself (its own tax lines), not from a second copy of the tax formula.
 *
 *   npx tsx src/scripts/verify-daybook-profit.ts
 */
import axios from 'axios';
import { prisma } from '../lib/prisma';
import { generateCredential } from '../utils/storefrontCredential';
import { POS_BASE_URL } from '../utils/posConnection';
import { inventoryMutationService } from '../services/inventory-mutation.service';
import { dayBookService } from '../services/daybook.service';
import { ensureTestTenant } from './support/testTenant';

const BASE = (process.env.TEST_API_URL || 'http://localhost:4006/api/v1') + '/pos/v1';
const STAMP = Date.now() % 1000000;
const PRICE = 3000;   // per piece, GST included
const COST = 1400;    // what the shop paid per piece

let passed = 0, failed = 0;
const check = (name: string, ok: boolean, detail = '') => {
  if (ok) { passed++; console.log(`  [PASS] ${name}${detail ? '  -- ' + detail : ''}`); }
  else { failed++; console.log(`  [FAIL] ${name}${detail ? '  -- ' + detail : ''}`); }
};
const near = (a: number, b: number) => Math.abs(a - b) < 0.011;
const r2 = (n: number) => Number(n.toFixed(2));

const api = (key: string) => axios.create({ baseURL: BASE, headers: { 'X-Storefront-Key': key }, validateStatus: () => true });
async function settle(key: string, body: any) {
  const r = await api(key).post('/events', body);
  if (r.data?.data?.answer !== 'ACCEPTED') return r.data?.data;
  const number = String(body.creditNoteNo ?? body.invoiceNo);
  const until = Date.now() + 240_000;
  while (Date.now() < until) {
    const d = (await api(key).get(`/events/status?invoiceNo=${encodeURIComponent(number)}`)).data?.data;
    if (d && (d.status === 'APPLIED' || d.status === 'REJECTED')) return d;
    await new Promise(res => setTimeout(res, 500));
  }
  throw new Error(`${number} never settled`);
}

async function main() {
  const { clientId } = await ensureTestTenant();
  const locations = await prisma.stockLocation.findMany({ where: { clientId, active: true }, select: { id: true, name: true } });
  const store = locations.find(l => l.name === 'Main Store') ?? locations[0];
  const elsewhere = locations.find(l => l.id !== store.id);
  console.log(`\nDay Book profit, on ${clientId} at ${store.name}\n`);

  const product = await prisma.product.create({ data: {
    clientId, productCode: `DBP-${STAMP}`, slug: `dbp-${STAMP}`, title: `Day Book profit saree ${STAMP}`,
    category: 'WOMEN' as any, productType: 'READY_TO_WEAR' as any, dressType: 'Saree', fabric: 'Silk',
    basePrice: PRICE, status: 'ACTIVE' as any, publishedAt: new Date(),
    hsnCode: '5007', taxRateBps: 500, taxSlabbed: false, priceIsExclusive: false
  } });
  const variant = await prisma.productVariant.create({ data: {
    productId: product.id, clientId, colorName: 'Teal', size: 'Free Size',
    variantCode: `DBPV-${STAMP}`, sku: `DBPS-${STAMP}`, sellingPrice: PRICE
  } });
  // Bought in properly, WITH a cost: profit is meaningless without one.
  await inventoryMutationService.applyMovement({
    clientId, variantId: variant.id, locationId: store.id, movementType: 'IN', reason: 'PURCHASE',
    quantityDelta: 10, unitCost: COST, notes: 'verify-daybook-profit setup', createdBy: 'verify-daybook-profit'
  });

  const cred = generateCredential();
  const till = await prisma.storefrontConnection.create({ data: {
    clientId, name: `Day Book profit till ${STAMP}`, baseUrl: POS_BASE_URL,
    credentialHash: cred.hash, credentialPrefix: cred.prefix, status: 'ACTIVE', locationIds: [store.id]
  } });

  try {
    const day = () => dayBookService.getToday(clientId, store.id).then((d: any) => d.sales);
    const before = await day();

    // ── 1. two pieces sold at the till ──────────────────────────────────────────────────────
    console.log('1. TWO PIECES SOLD AT THE TILL, 3,000 EACH, GST INCLUDED');
    const inv = `INV/DBP/${STAMP}`;
    const sold = await settle(cred.plaintext, {
      kind: 'sale.completed', invoiceNo: inv, occurredAt: new Date().toISOString(),
      lines: [{ itemCode: variant.variantCode, qty: 2, unitPricePaise: PRICE * 100, lineTotalPaise: PRICE * 200 }],
      totals: {}, payments: [{ method: 'CASH', amountPaise: PRICE * 200 }]
    });
    check('the sale is applied', sold?.answer === 'APPLIED', JSON.stringify(sold?.answer ?? sold));
    const order = await prisma.salesOrder.findFirst({
      where: { clientId, externalOrderId: inv },
      select: { id: true, items: { select: { totalPrice: true, cgst: true, sgst: true, igst: true, taxableValue: true } } }
    });
    const line = order!.items[0];
    const billTax = r2(Number(line.cgst ?? 0) + Number(line.sgst ?? 0) + Number(line.igst ?? 0));
    check('the bill itself carries GST (this shop charges it)', billTax > 0, `bill 6,000 of which GST ${billTax}`);

    const afterSale = await day();
    const d = (k: string) => r2(afterSale[k] - before[k]);
    check('billed goes up by what the customer paid', near(d('revenue'), 6000), `+${d('revenue')}`);
    check('the GST in it is the bill\'s own GST', near(d('gstCollected'), billTax), `+${d('gstCollected')} vs bill ${billTax}`);
    check('sales the shop keeps = billed less that GST', near(d('netSales'), 6000 - billTax), `+${d('netSales')}`);
    check('cost is what the two pieces cost', near(d('costOfGoods'), COST * 2) && near(d('netCost'), COST * 2), `+${d('costOfGoods')}`);
    const rightProfit = r2(6000 - billTax - COST * 2);
    check('PROFIT excludes the GST', near(d('grossProfit'), rightProfit), `+${d('grossProfit')} (the old sum gave +${6000 - COST * 2}, i.e. ${billTax} of tax counted as profit)`);

    // ── 2. one of them comes back ───────────────────────────────────────────────────────────
    console.log('\n2. ONE PIECE COMES BACK');
    const cn = `CN/DBP/${STAMP}`;
    const back = await settle(cred.plaintext, {
      kind: 'sale.returned', creditNoteNo: cn, againstInvoiceNo: inv,
      lines: [{ itemCode: variant.variantCode, qty: 1, lineTotalPaise: PRICE * 100 }], totals: {},
      refund: { method: 'CASH' }
    });
    check('the return is applied', back?.answer === 'APPLIED', JSON.stringify(back?.answer ?? back));
    const ret = await prisma.salesReturn.findFirst({
      where: { clientId, salesOrderId: order!.id }, select: { status: true, items: { select: { refundAmount: true, cgst: true, sgst: true, igst: true } } }
    });
    const retTax = r2(ret!.items.reduce((a, i) => a + Number(i.cgst ?? 0) + Number(i.sgst ?? 0) + Number(i.igst ?? 0), 0));
    const retValue = r2(ret!.items.reduce((a, i) => a + Number(i.refundAmount ?? 0), 0));
    check('the return is complete, worth one piece, with its own GST', ret?.status === 'COMPLETED' && near(retValue, PRICE) && retTax > 0, `value ${retValue}, GST ${retTax}`);

    const afterBack = await day();
    const e = (k: string) => r2(afterBack[k] - afterSale[k]);
    const er = (k: string) => r2(afterBack.returns[k] - afterSale.returns[k]);
    check('billed does not change: the bill was still made', near(e('revenue'), 0) && near(e('gstCollected'), 0), `${e('revenue')}`);
    check('returns go up by one piece, its value and its GST', er('units') === 1 && near(er('value'), retValue) && near(er('gst'), retTax), `units +${er('units')}, value +${er('value')}, gst +${er('gst')}`);
    check('the cost of the piece back on the shelf comes back', near(er('cost'), COST) && near(e('netCost'), -COST), `+${er('cost')}`);
    check('sales the shop keeps go DOWN by the piece, less its GST', near(e('netSales'), -(retValue - retTax)), `${e('netSales')}`);
    check('PROFIT goes down by what that piece had earned', near(e('grossProfit'), -(retValue - retTax - COST)), `${e('grossProfit')} (the old sum left profit unchanged)`);

    const whole = r2(afterBack.grossProfit - before.grossProfit);
    check('net of both: profit on the one piece kept', near(whole, r2((6000 - billTax) - (retValue - retTax) - COST)), `+${whole}`);
    check('the pieces add up: profit = sales kept less cost kept', near(afterBack.grossProfit, r2(afterBack.netSales - afterBack.netCost)));

    // ── 3. one store is one store ───────────────────────────────────────────────────────────
    console.log('\n3. EACH STORE SEES ITS OWN SALES');
    const shopWide: any = (await dayBookService.getToday(clientId) as any).sales;
    check('the whole shop includes this store', shopWide.revenue >= afterBack.revenue - 0.01, `shop ${shopWide.revenue}, ${store.name} ${afterBack.revenue}`);
    if (elsewhere) {
      const other: any = (await dayBookService.getToday(clientId, elsewhere.id) as any).sales;
      const otherOrders = await prisma.dispatch.count({ where: { clientId, salesOrder: { locationId: elsewhere.id }, dispatchedAt: { gte: new Date(Date.now() - 36 * 3600_000) } } });
      check(`${elsewhere.name}, which sold nothing, shows no sales`, otherOrders > 0 || (near(other.revenue, 0) && other.dispatchCount === 0),
        `${elsewhere.name} billed ${other.revenue} (it used to show the whole shop's ${shopWide.revenue})`);
    }
  } finally {
    // The till is disconnected; the bills and the product stay, like every other suite's on this shop.
    await prisma.storefrontConnection.update({ where: { id: till.id }, data: { status: 'REVOKED' } });
  }

  console.log(`\nRESULT: ${passed} passed | ${failed} failed`);
  await prisma.$disconnect();
  process.exit(failed ? 1 : 0);
}
main().catch(async e => { console.log('CRASHED:', e?.stack ?? e); await prisma.$disconnect(); process.exit(1); });
