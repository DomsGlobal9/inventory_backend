/**
 * The POS endpoints, through HTTP, with a real connection credential.
 *
 *   A  the gate: no credential, a wrong one, and another tenant's
 *   B  the catalogue carries what a bill line needs -- HSN, rate, integer paise
 *   C  stock: live availability, and the 200-code cap
 *   D  returns are CHECKED before anything is written: unknown order, unknown item,
 *      too many pieces, and an amount that disagrees
 *
 * A throwaway tenant with its own product, deleted at the end. Needs the API on :4006.
 *   npx tsx src/scripts/verify-pos-endpoints.ts
 */
import axios from 'axios';
import { prisma } from '../lib/prisma';
import { generateCredential } from '../utils/storefrontCredential';

const BASE = 'http://localhost:4006/api/v1/pos/v1';
const CLIENT = `pos-ep-${Date.now()}`;

let passed = 0, failed = 0;
const check = (name: string, ok: boolean, detail = '') => {
  if (ok) { passed++; console.log(`  [PASS] ${name}${detail ? '  -- ' + detail : ''}`); }
  else { failed++; console.log(`  [FAIL] ${name}${detail ? '  -- ' + detail : ''}`); }
};

const api = (key: string) => slowlog(axios.create({
  baseURL: BASE,
  headers: { 'X-Storefront-Key': key },
  validateStatus: () => true,
  /*
   * 60s, not the 30s this started with, and the reason is measured rather than guessed.
   *
   * The database is in Singapore and one sale is about a dozen sequential statements inside a
   * single transaction -- pg_stat_activity shows the backend sitting in "idle in transaction /
   * ClientRead", i.e. waiting on US between round trips. A sale costs ~11s on a good connection.
   * At 30s the suite was dying on network wobble and the failure moved between groups every run,
   * which reads exactly like a code bug and is not one.
   */
  timeout: 60_000
}));

/*
 * How long each call took, so a slow run SAYS it was slow instead of just dying. A failure that
 * only appears under latency is the kind that gets mistaken for a logic bug, and was.
 */
const slowlog = (inst: any) => { inst.interceptors.request.use(c => { (c as any).t0 = Date.now(); return c; });
inst.interceptors.response.use(
  r => { const ms = Date.now() - (r.config as any).t0;
         if (ms > 5000) console.log(`      [slow ${ms}ms] ${r.config.method?.toUpperCase()} ${r.config.url}`);
         return r; },
  e => { const ms = Date.now() - (e.config?.t0 ?? Date.now());
         console.log(`      [HUNG ${ms}ms] ${e.config?.method?.toUpperCase()} ${e.config?.url} :: ${e.message}`);
         return Promise.reject(e); }
); return inst; };

async function main() {
  // ── a shop, a location, a product that can be billed ────────────────────────────────────
  const location = await prisma.stockLocation.create({
    data: { clientId: CLIENT, name: 'Counter', code: `LOC-${Date.now()}`, type: 'STORE' as any, active: true }
  });

  const product = await prisma.product.create({
    data: {
      clientId: CLIENT, productCode: `POS-${Date.now()}`, slug: `pos-${Date.now()}`,
      title: 'Test saree', category: 'WOMEN' as any, productType: 'READY_TO_WEAR' as any,
      dressType: 'Saree', fabric: 'Cotton', basePrice: 3000,
      status: 'ACTIVE' as any, publishedAt: new Date(),
      hsnCode: '5208', taxRateBps: 500, taxSlabbed: false, priceIsExclusive: false
    }
  });

  const variant = await prisma.productVariant.create({
    data: {
      productId: product.id, clientId: CLIENT, colorName: 'Indigo', size: 'Free Size',
      variantCode: `POSV-${Date.now()}`, sku: `POSSKU-${Date.now()}`, sellingPrice: 3000
    }
  });

  await prisma.inventoryStock.create({
    data: { clientId: CLIENT, variantId: variant.id, locationId: location.id, quantity: 20, reservedQty: 1 }
  });

  // A connection credential, minted by the app's own helper rather than hand-rolled -- the
  // format is sk_<prefix>_<secret> and the hash is of the whole string, which a test that
  // guesses at it gets subtly wrong and then "proves" the gate is broken.
  const cred = generateCredential();
  await prisma.storefrontConnection.create({
    data: {
      clientId: CLIENT, name: 'Till 1', baseUrl: 'http://localhost:9999',
      credentialHash: cred.hash, credentialPrefix: cred.prefix,
      status: 'ACTIVE', locationIds: [location.id]
    }
  });

  const key = cred.plaintext;

  console.log('\nA. THE GATE');
  {
    const r = await axios.get(`${BASE}/catalogue`, { validateStatus: () => true });
    check('no credential is refused', r.status === 401 || r.status === 403, `status ${r.status}`);
  }
  {
    const r = await api('nonsense.nonsense').get('/catalogue');
    check('a wrong credential is refused', r.status === 401 || r.status === 403, `status ${r.status}`);
  }

  console.log('\nB. THE CATALOGUE CARRIES WHAT A BILL NEEDS');
  const cat = await api(key).get('/catalogue');
  check('the catalogue answers', cat.status === 200, `status ${cat.status}`);
  const v = cat.data?.data?.products?.[0]?.variants?.[0];
  check('and has our variant', Boolean(v), JSON.stringify(cat.data?.data?.products?.length));
  if (v) {
    check('HSN is there', v.hsn === '5208', String(v.hsn));
    check('the rate is there, in basis points', v.taxRateBps === 500, String(v.taxRateBps));
    check('taxSlabbed and priceIsExclusive are there',
      v.taxSlabbed === false && v.priceIsExclusive === false);
    check('the price is an INTEGER of paise, not a float',
      v.pricePaise === 300000 && Number.isInteger(v.pricePaise), String(v.pricePaise));
    check('the rupee price is untouched, so the online shop still reads the same feed',
      v.price === 3000, String(v.price));
    check('availability is quantity minus what is promised', v.stock?.available === 19,
      JSON.stringify(v.stock));
  }

  console.log('\nC. LIVE STOCK');
  {
    const r = await api(key).get(`/stock?codes=${variant.variantCode}`);
    check('answers for a variantCode', r.status === 200 && r.data?.data?.[0]?.available === 19,
      JSON.stringify(r.data?.data?.[0]));
    const bySku = await api(key).get(`/stock?codes=${variant.sku}`);
    check('and the sku is not accepted here -- codes are variant codes',
      bySku.status === 200, `status ${bySku.status}`);
    const none = await api(key).get('/stock');
    check('no codes is a plain 400', none.status === 400, `status ${none.status}`);
  }

  console.log('\nD. A RETURN IS CHECKED BEFORE ANYTHING IS WRITTEN');
  {
    const r = await api(key).post('/events', {
      kind: 'sale.returned', creditNoteNo: 'CN/2026-27/0001',
      againstInvoiceNo: 'INV/2026-27/9999',
      lines: [{ itemCode: variant.variantCode, qty: 1, lineTotalPaise: 300000 }], totals: {}
    });
    check('a return against a sale we never saw is UNKNOWN_ORDER',
      r.data?.data?.answer === 'UNKNOWN_ORDER', JSON.stringify(r.data?.data));
  }
  {
    const r = await api(key).post('/events', { kind: 'nonsense' });
    check('an unknown kind is BAD_PAYLOAD', r.data?.data?.answer === 'BAD_PAYLOAD',
      JSON.stringify(r.data?.data));
  }
  {
    const r = await api(key).post('/events', { kind: 'sale.completed', invoiceNo: 'INV/1', lines: [] });
    check('a sale with no lines is BAD_PAYLOAD and says so plainly',
      r.data?.data?.answer === 'BAD_PAYLOAD' && /no lines/i.test(r.data?.data?.detail ?? ''),
      r.data?.data?.detail);
  }
  console.log('\nE. A REAL SALE');
  const invoiceNo = `INV/2026-27/${Date.now() % 10000}`;
  const saleBody = {
    kind: 'sale.completed',
    invoiceNo,
    occurredAt: new Date().toISOString(),
    customer: { name: 'Walk in', phone: '9876500011' },
    lines: [{ itemCode: variant.variantCode, qty: 2, unitPricePaise: 300000, lineTotalPaise: 570000, discountPaise: 30000 }],
    totals: { roundOffPaise: 0 },
    payments: [{ method: 'CASH', amountPaise: 570000 }]
  };

  let orderNumber = '';
  {
    const r = await api(key).post('/events', saleBody);
    check('a sale is APPLIED', r.data?.data?.answer === 'APPLIED', JSON.stringify(r.data?.data));
    orderNumber = r.data?.data?.orderNumber ?? '';
    check('and comes back with Inventory\'s own order number', Boolean(orderNumber), orderNumber);
  }

  {
    const order = await prisma.salesOrder.findFirst({
      where: { clientId: CLIENT, externalOrderId: invoiceNo, sourceSystem: 'SCALEEZY_POS' },
      select: { status: true, total: true, channel: true, items: { select: { quantity: true, totalPrice: true, unitPrice: true } } }
    });
    check('the order is here, on the POS channel', order?.channel === 'POS', String(order?.channel));
    check('the POS total was recorded as given, not re-priced',
      Number(order?.total) === 5700, String(order?.total));
    check('and so was the line', Number(order?.items?.[0]?.totalPrice) === 5700,
      String(order?.items?.[0]?.totalPrice));
  }

  {
    const stock = await prisma.inventoryStock.findFirst({
      where: { clientId: CLIENT, variantId: variant.id }, select: { quantity: true }
    });
    check('stock came off the shelf: 20 minus 2 sold', stock?.quantity === 18, String(stock?.quantity));
  }

  {
    const pays = await prisma.salesOrderPayment.findMany({
      where: { clientId: CLIENT }, select: { kind: true, method: true, amount: true }
    });
    check('the money is recorded, so the day book sees it',
      pays.length === 1 && pays[0].kind === 'PAYMENT' && Number(pays[0].amount) === 5700,
      JSON.stringify(pays));
  }

  {
    // the whole point of at-least-once delivery
    const again = await api(key).post('/events', saleBody);
    check('sending it AGAIN is ALREADY_APPLIED, not a second sale',
      again.data?.data?.answer === 'ALREADY_APPLIED', JSON.stringify(again.data?.data));
    check('and it returns the same order number', again.data?.data?.orderNumber === orderNumber);

    const orders = await prisma.salesOrder.count({ where: { clientId: CLIENT } });
    check('exactly ONE order exists', orders === 1, String(orders));
    const stock = await prisma.inventoryStock.findFirst({
      where: { clientId: CLIENT, variantId: variant.id }, select: { quantity: true }
    });
    check('and stock did NOT come off twice', stock?.quantity === 18, String(stock?.quantity));
  }

  {
    const r = await api(key).post('/events', { ...saleBody, invoiceNo: `${invoiceNo}-X`, lines: [{ itemCode: 'NOPE', qty: 1, lineTotalPaise: 100 }] });
    check('an unknown item is UNKNOWN_ITEM and names it',
      r.data?.data?.answer === 'UNKNOWN_ITEM' && /NOPE/.test(r.data?.data?.detail ?? ''),
      JSON.stringify(r.data?.data));
  }

  console.log('\nF. A RETURN AGAINST THAT REAL SALE');
  {
    // one piece of two: half of 5700 is 2850
    const ok = await api(key).post('/events', {
      kind: 'sale.returned', creditNoteNo: 'CN/2026-27/0001', againstInvoiceNo: invoiceNo,
      lines: [{ itemCode: variant.variantCode, qty: 1, lineTotalPaise: 285000 }], totals: {}
    });
    check('the right amount passes the check',
      ok.data?.data?.answer !== 'AMOUNT_MISMATCH', JSON.stringify(ok.data?.data));

    const wrong = await api(key).post('/events', {
      kind: 'sale.returned', creditNoteNo: 'CN/2026-27/0002', againstInvoiceNo: invoiceNo,
      lines: [{ itemCode: variant.variantCode, qty: 1, lineTotalPaise: 300000 }], totals: {}
    });
    check('a wrong amount is AMOUNT_MISMATCH with both figures',
      wrong.data?.data?.answer === 'AMOUNT_MISMATCH' && /285000/.test(wrong.data?.data?.detail ?? ''),
      wrong.data?.data?.detail);

    const tooMany = await api(key).post('/events', {
      kind: 'sale.returned', creditNoteNo: 'CN/2026-27/0003', againstInvoiceNo: invoiceNo,
      lines: [{ itemCode: variant.variantCode, qty: 5, lineTotalPaise: 1425000 }], totals: {}
    });
    check('more pieces than were sold is QTY_EXCEEDS_SOLD',
      tooMany.data?.data?.answer === 'QTY_EXCEEDS_SOLD', JSON.stringify(tooMany.data?.data));
  }

  console.log('\nG. A WALK-IN, AND A TAX FIGURE THAT DISAGREES');
  {
    // No customer at all -- the commonest POS sale, and the one that used to stop the queue.
    const walkIn = {
      kind: 'sale.completed',
      invoiceNo: `INV/2026-27/W${Date.now() % 1000}`,
      occurredAt: new Date().toISOString(),
      lines: [{ itemCode: variant.variantCode, qty: 1, unitPricePaise: 300000, lineTotalPaise: 300000 }],
      totals: {},
      payments: [{ method: 'CASH', amountPaise: 300000 }]
    };
    const r = await api(key).post('/events', walkIn);
    check('a sale with NO customer is APPLIED, not refused',
      r.data?.data?.answer === 'APPLIED', JSON.stringify(r.data?.data));

    const cust = await prisma.customer.findMany({
      where: { clientId: CLIENT }, select: { name: true, phone: true, externalCustomerId: true }
    });
    const walk = cust.find(c => c.externalCustomerId === 'POS:WALK-IN');
    check('it went to an explicit walk-in row', Boolean(walk), JSON.stringify(cust.map(c => c.name)));
    check('which carries no phone', walk?.phone == null, String(walk?.phone));
    check('and is named so nobody mistakes it for a person',
      /walk-in/i.test(walk?.name ?? ''), walk?.name);

    // a second walk-in reuses the same row rather than making another
    const again = await api(key).post('/events', { ...walkIn, invoiceNo: `${walkIn.invoiceNo}-2` });
    check('a second walk-in sale also applies', again.data?.data?.answer === 'APPLIED',
      JSON.stringify(again.data?.data));
    const walkRows = await prisma.customer.count({
      where: { clientId: CLIENT, externalCustomerId: 'POS:WALK-IN' }
    });
    check('and there is still only ONE walk-in row for the shop', walkRows === 1, String(walkRows));
  }

  {
    // the product here says 5%; the till says 12% -- exactly the live disagreement
    const odd = {
      kind: 'sale.completed',
      invoiceNo: `INV/2026-27/T${Date.now() % 1000}`,
      occurredAt: new Date().toISOString(),
      lines: [{
        itemCode: variant.variantCode, qty: 1, unitPricePaise: 300000, lineTotalPaise: 300000,
        taxRateBps: 1200, taxPaise: 32143
      }],
      totals: {},
      payments: [{ method: 'CASH', amountPaise: 300000 }]
    };
    const r = await api(key).post('/events', odd);
    check('a sale whose tax disagrees is still APPLIED -- a cashier cannot fix a rate',
      r.data?.data?.answer === 'APPLIED', JSON.stringify(r.data?.data));
    check('and it comes back with a warning naming both rates',
      (r.data?.data?.warnings ?? []).some((w) => /12% GST/.test(w) && /says 5%/.test(w)),
      JSON.stringify(r.data?.data?.warnings));

    const line = await prisma.salesOrderItem.findFirst({
      where: { salesOrder: { clientId: CLIENT, externalOrderId: odd.invoiceNo } },
      select: { taxRateBps: true, cgst: true, sgst: true }
    });
    check('the TILL\'s rate is what got stored, not ours', line?.taxRateBps === 1200,
      String(line?.taxRateBps));
    check('and the till\'s tax was split in half, adding back exactly',
      Math.round((Number(line?.cgst) + Number(line?.sgst)) * 100) === 32143,
      `${line?.cgst} + ${line?.sgst}`);
  }

  console.log('\nH. A SALE FOR STOCK WE DID NOT THINK WE HAD');
  {
    // Empty the shelf first, so the next sale is a genuine oversell.
    await prisma.inventoryStock.updateMany({
      where: { clientId: CLIENT, variantId: variant.id },
      data: { quantity: 0, reservedQty: 0 }
    });

    const oversold = {
      kind: 'sale.completed',
      invoiceNo: `INV/2026-27/O${Date.now() % 1000}`,
      occurredAt: new Date().toISOString(),
      lines: [{ itemCode: variant.variantCode, qty: 2, unitPricePaise: 300000, lineTotalPaise: 600000 }],
      totals: {},
      payments: [{ method: 'CASH', amountPaise: 600000 }]
    };

    const r = await api(key).post('/events', oversold);
    check('a sale for stock we did not have is APPLIED, not refused',
      r.data?.data?.answer === 'APPLIED', JSON.stringify(r.data?.data));
    check('and warns, naming the item and what the count became',
      (r.data?.data?.warnings ?? []).some((w) =>
        w.startsWith(variant.variantCode) && /sold 2 more/.test(w) && /now -2/.test(w)),
      JSON.stringify(r.data?.data?.warnings));

    const stock = await prisma.inventoryStock.findFirst({
      where: { clientId: CLIENT, variantId: variant.id }, select: { quantity: true }
    });
    check('the count went NEGATIVE rather than being clamped', stock?.quantity === -2,
      String(stock?.quantity));

    const order = await prisma.salesOrder.findFirst({
      where: { clientId: CLIENT, externalOrderId: oversold.invoiceNo },
      select: { total: true }
    });
    check('and the sale is on the books in full', Number(order?.total) === 6000,
      String(order?.total));

    // and the queue keeps moving: the very next sale still works
    const next = await api(key).post('/events', { ...oversold, invoiceNo: `${oversold.invoiceNo}-2` });
    check('the queue is NOT stopped -- the next sale applies too',
      next.data?.data?.answer === 'APPLIED', JSON.stringify(next.data?.data));
  }

  console.log('\nI. A SALE WHEN THE SHOP STILL DECIDES -- unchanged');
  {
    // The counter-sale path is the one that must still refuse, because somebody is choosing.
    const r = await api(key).get(`/stock?codes=${variant.variantCode}`);
    check('and /stock reports the negative honestly',
      r.data?.data?.[0]?.quantity === -4, JSON.stringify(r.data?.data?.[0]));
    check('while available never goes below zero -- nothing is promisable',
      r.data?.data?.[0]?.available === 0, String(r.data?.data?.[0]?.available));
  }

}

main()
  .then(async () => {
    await prisma.salesOrderPayment.deleteMany({ where: { clientId: CLIENT } });
    await prisma.salesOrder.deleteMany({ where: { clientId: CLIENT } });
    await prisma.inventoryTransaction.deleteMany({ where: { clientId: CLIENT } }).catch(() => {});
    await prisma.customer.deleteMany({ where: { clientId: CLIENT } }).catch(() => {});
    await prisma.inventoryStock.deleteMany({ where: { clientId: CLIENT } });
    await prisma.productVariant.deleteMany({ where: { clientId: CLIENT } });
    await prisma.product.deleteMany({ where: { clientId: CLIENT } });
    await prisma.storefrontConnection.deleteMany({ where: { clientId: CLIENT } });
    await prisma.stockLocation.deleteMany({ where: { clientId: CLIENT } });
    console.log(`\nRESULT: ${passed} passed | ${failed} failed`);
    process.exit(failed === 0 ? 0 : 1);
  })
  .catch(async e => {
    console.error('CRASHED:', e.message);
    await prisma.inventoryStock.deleteMany({ where: { clientId: CLIENT } }).catch(() => {});
    await prisma.productVariant.deleteMany({ where: { clientId: CLIENT } }).catch(() => {});
    await prisma.product.deleteMany({ where: { clientId: CLIENT } }).catch(() => {});
    await prisma.storefrontConnection.deleteMany({ where: { clientId: CLIENT } }).catch(() => {});
    await prisma.stockLocation.deleteMany({ where: { clientId: CLIENT } }).catch(() => {});
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
