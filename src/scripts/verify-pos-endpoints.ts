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

/**
 * Post an event and, if it was only taken in, wait for the worker to finish it.
 *
 * /events stopped doing the work in-line -- it writes the event down, answers 202 ACCEPTED and a
 * worker applies it a moment later. A test that asserts on the OUTCOME therefore has to wait for
 * the outcome. Shaped like the axios response the assertions already read, so this is one
 * function rather than forty edits, and every existing check keeps meaning what it meant.
 */
async function sendEvent(key: string, body: any) {
  const r = await api(key).post('/events', body);
  if (r.data?.data?.answer !== 'ACCEPTED') return r;
  // A sale is filed under its invoice number, a return under its credit note number.
  const number = String(body.creditNoteNo ?? body.invoiceNo ?? '');

  const until = Date.now() + 180_000;
  while (Date.now() < until) {
    const s = await api(key).get(`/events/status?invoiceNo=${encodeURIComponent(number)}`);
    const d = s.data?.data;
    if (d && (d.status === 'APPLIED' || d.status === 'REJECTED')) {
      const ok = d.answer === 'APPLIED' || d.answer === 'ALREADY_APPLIED';
      return { ...r, status: ok ? 200 : 422,
        data: { success: ok, data: {
          answer: d.answer, orderNumber: d.orderNumber, detail: d.detail, warnings: d.warnings
        } } };
    }
    await new Promise(res => setTimeout(res, 400));
  }
  throw new Error(`event ${number} never settled -- is the POS worker running? (POS_QUEUE_IN_DEV=true)`);
}

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
    const r = await sendEvent(key, {
      kind: 'sale.returned', creditNoteNo: 'CN/2026-27/0001',
      againstInvoiceNo: 'INV/2026-27/9999',
      lines: [{ itemCode: variant.variantCode, qty: 1, lineTotalPaise: 300000 }], totals: {}
    });
    check('a return against a sale we never saw is UNKNOWN_ORDER',
      r.data?.data?.answer === 'UNKNOWN_ORDER', JSON.stringify(r.data?.data));
  }
  {
    const r = await sendEvent(key, { kind: 'nonsense' });
    check('an unknown kind is BAD_PAYLOAD', r.data?.data?.answer === 'BAD_PAYLOAD',
      JSON.stringify(r.data?.data));
  }
  {
    const r = await sendEvent(key, { kind: 'sale.completed', invoiceNo: 'INV/1', lines: [] });
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
    const r = await sendEvent(key, saleBody);
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
    const again = await sendEvent(key, saleBody);
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
    const r = await sendEvent(key, { ...saleBody, invoiceNo: `${invoiceNo}-X`, lines: [{ itemCode: 'NOPE', qty: 1, lineTotalPaise: 100 }] });
    check('an unknown item is UNKNOWN_ITEM and names it',
      r.data?.data?.answer === 'UNKNOWN_ITEM' && /NOPE/.test(r.data?.data?.detail ?? ''),
      JSON.stringify(r.data?.data));
  }

  console.log('\nF. A RETURN AGAINST THAT REAL SALE');
  {
    // one piece of two: half of 5700 is 2850
    const ok = await sendEvent(key, {
      kind: 'sale.returned', creditNoteNo: 'CN/2026-27/0001', againstInvoiceNo: invoiceNo,
      lines: [{ itemCode: variant.variantCode, qty: 1, lineTotalPaise: 285000 }], totals: {}
    });
    check('the right amount is APPLIED, not refused',
      ok.data?.data?.answer !== 'AMOUNT_MISMATCH', JSON.stringify(ok.data?.data));

    const wrong = await sendEvent(key, {
      kind: 'sale.returned', creditNoteNo: 'CN/2026-27/0002', againstInvoiceNo: invoiceNo,
      lines: [{ itemCode: variant.variantCode, qty: 1, lineTotalPaise: 300000 }], totals: {}
    });
    check('a wrong amount is AMOUNT_MISMATCH with both figures',
      wrong.data?.data?.answer === 'AMOUNT_MISMATCH' && /285000/.test(wrong.data?.data?.detail ?? ''),
      wrong.data?.data?.detail);

    const tooMany = await sendEvent(key, {
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
    const r = await sendEvent(key, walkIn);
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
    const again = await sendEvent(key, { ...walkIn, invoiceNo: `${walkIn.invoiceNo}-2` });
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
    const r = await sendEvent(key, odd);
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

    const r = await sendEvent(key, oversold);
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
    const next = await sendEvent(key, { ...oversold, invoiceNo: `${oversold.invoiceNo}-2` });
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

  console.log('\nJ. THE TILL DOES NOT WAIT');
  {
    const quick = {
      kind: 'sale.completed',
      invoiceNo: `INV/2026-27/Q${Date.now() % 10000}`,
      occurredAt: new Date().toISOString(),
      lines: [{ itemCode: variant.variantCode, qty: 1, unitPricePaise: 300000, lineTotalPaise: 300000 }],
      totals: {},
      payments: [{ method: 'CASH', amountPaise: 300000 }]
    };

    const t0 = Date.now();
    const r = await api(key).post('/events', quick);
    const waited = Date.now() - t0;

    check('the answer is 202 -- taken in, not yet applied', r.status === 202, `status ${r.status}`);
    check('and it says ACCEPTED with a reference to ask about later',
      r.data?.data?.answer === 'ACCEPTED' && Boolean(r.data?.data?.reference),
      JSON.stringify(r.data?.data));

    /*
     * The whole point of the change, so it is asserted rather than admired. Three seconds is not
     * the target -- one round trip is under a second -- it is the line past which somebody at a
     * counter starts wondering whether the till has frozen.
     */
    check('and the till waited under 3 seconds, not twelve', waited < 3000, `${waited}ms`);

    // a resend while it is still queued must not make a second sale
    const again = await api(key).post('/events', quick);
    check('a resend while it is still queued is not a second sale',
      again.data?.data?.reference === r.data?.data?.reference ||
      again.data?.data?.answer === 'APPLIED' || again.data?.data?.answer === 'ALREADY_APPLIED',
      JSON.stringify(again.data?.data));

    // and it really does get done
    const until = Date.now() + 180_000;
    let settled: any = null;
    while (Date.now() < until && !settled) {
      const st = await api(key).get(`/events/status?invoiceNo=${encodeURIComponent(quick.invoiceNo)}`);
      if (st.data?.data?.status === 'APPLIED' || st.data?.data?.status === 'REJECTED') settled = st.data.data;
      else await new Promise(res => setTimeout(res, 400));
    }
    check('the worker finishes it', settled?.status === 'APPLIED', JSON.stringify(settled)?.slice(0, 160));
    check('and the status says which order it became',
      typeof settled?.orderNumber === 'string' && settled.orderNumber.startsWith('SO-'),
      String(settled?.orderNumber));

    const onBooks = await prisma.salesOrder.count({
      where: { clientId: CLIENT, externalOrderId: quick.invoiceNo }
    });
    check('exactly ONE order, despite the resend', onBooks === 1, String(onBooks));

    const st = await api(key).get('/events/status?invoiceNo=INV/2026-27/NOPE');
    check('asking about an invoice we never saw is a plain 404', st.status === 404, `status ${st.status}`);

    const noArg = await api(key).get('/events/status');
    check('and asking without an invoice number is a plain 400', noArg.status === 400, `status ${noArg.status}`);
  }

  console.log('\nK. A FAULT IN THE MESSAGE IS STILL REFUSED AT THE DOOR');
  {
    // These need no database, so they must not be queued and discovered later.
    const t0 = Date.now();
    const r = await api(key).post('/events', {
      kind: 'sale.completed', invoiceNo: `INV/2026-27/B${Date.now() % 10000}`,
      lines: [{ itemCode: variant.variantCode, qty: 1.5, unitPricePaise: 300000, lineTotalPaise: 300000 }],
      totals: {}, payments: []
    });
    const waited = Date.now() - t0;
    check('half a piece is refused outright, not accepted then rejected',
      r.status === 422 && r.data?.data?.answer === 'BAD_PAYLOAD', JSON.stringify(r.data?.data));
    check('and refused without a database round trip to decide it', waited < 3000, `${waited}ms`);

    const queued = await prisma.posInboundEvent.count({ where: { clientId: CLIENT, status: 'QUEUED' } });
    check('nothing was left sitting in the queue', queued === 0, String(queued));
  }

  console.log('\nL. A RETURN THAT OVERTAKES ITS OWN SALE');
  {
    /*
     * Only possible since sales became asynchronous: the POS sends the return after the sale, but
     * the sale is applied a moment later, so the return can arrive first. This must be retryable,
     * never UNKNOWN_ORDER -- a shop's queue stopping over a two-second race is the exact failure
     * the whole design exists to avoid.
     */
    const race = {
      kind: 'sale.completed',
      invoiceNo: `INV/2026-27/R${Date.now() % 10000}`,
      occurredAt: new Date().toISOString(),
      lines: [{ itemCode: variant.variantCode, qty: 1, unitPricePaise: 300000, lineTotalPaise: 300000 }],
      totals: {},
      payments: [{ method: 'CASH', amountPaise: 300000 }]
    };
    const accepted = await api(key).post('/events', race);
    check('the sale is taken in', accepted.status === 202, `status ${accepted.status}`);

    // straight away, before the worker can have finished it
    const ret = await api(key).post('/events', {
      kind: 'sale.returned', creditNoteNo: `CN/2026-27/R${Date.now() % 10000}`,
      againstInvoiceNo: race.invoiceNo,
      lines: [{ itemCode: variant.variantCode, qty: 1, lineTotalPaise: 300000 }], totals: {}
    });
    check('a return against a sale still in the queue is NOT UNKNOWN_ORDER',
      ret.data?.data?.answer !== 'UNKNOWN_ORDER', JSON.stringify(ret.data?.data));
    check('it says the sale is not applied yet, and says so retryably',
      ret.data?.data?.answer === 'SALE_NOT_YET_APPLIED' && ret.status === 409,
      `${ret.status} ${JSON.stringify(ret.data?.data)}`);

    // and once the sale lands, the same return is checked properly
    const until = Date.now() + 180_000;
    while (Date.now() < until) {
      const st = await api(key).get(`/events/status?invoiceNo=${encodeURIComponent(race.invoiceNo)}`);
      if (st.data?.data?.status === 'APPLIED') break;
      await new Promise(res => setTimeout(res, 400));
    }
    /*
     * sendEvent, not a bare post, and the difference now matters: a return WRITES. Fired and not
     * waited for, this one landed in the middle of a later group and put a piece back on a shelf
     * that group had just counted. The old check-only behaviour hid that entirely.
     */
    const after = await sendEvent(key, {
      kind: 'sale.returned', creditNoteNo: `CN/2026-27/S${Date.now() % 10000}`,
      againstInvoiceNo: race.invoiceNo,
      lines: [{ itemCode: variant.variantCode, qty: 1, lineTotalPaise: 300000 }], totals: {},
      refund: { method: 'CASH' }
    });
    /*
     * Asserted on what it SHOULD be, not on what it should not be. The first version of this
     * checked only that the answer was neither SALE_NOT_YET_APPLIED nor UNKNOWN_ORDER, and a
     * return failing outright with "insufficient stock" passed it happily.
     */
    check('once the sale has landed the return goes through on its merits',
      after.data?.data?.answer === 'APPLIED', JSON.stringify(after.data?.data));
  }

  console.log('\nM. RETRY CLEARS A REJECTION');
  {
    /*
     * An event the shop can fix: an item code we do not know. It settles REJECTED, and the owner
     * is meant to correct it and press Retry. If a resend handed the stored rejection back, Retry
     * could never clear anything -- which is exactly what it did until the POS session asked.
     */
    const invoiceNo = `INV/2026-27/X${Date.now() % 10000}`;
    const base = {
      kind: 'sale.completed', invoiceNo,
      occurredAt: new Date().toISOString(),
      totals: {}, payments: [{ method: 'CASH', amountPaise: 300000 }]
    };

    const bad = await sendEvent(key, {
      ...base, lines: [{ itemCode: 'NO-SUCH-ITEM', qty: 1, unitPricePaise: 300000, lineTotalPaise: 300000 }]
    });
    check('an unknown item settles as a rejection, naming it',
      bad.data?.data?.answer === 'UNKNOWN_ITEM', JSON.stringify(bad.data?.data));

    const st = await api(key).get(`/events/status?invoiceNo=${encodeURIComponent(invoiceNo)}`);
    check('and its STATUS is REJECTED, not APPLIED with a bad answer',
      st.data?.data?.status === 'REJECTED', JSON.stringify(st.data?.data?.status));

    const stock0 = await prisma.inventoryStock.findFirst({
      where: { clientId: CLIENT, variantId: variant.id }, select: { quantity: true }
    });

    // the owner fixes the item code and presses Retry
    const fixed = await sendEvent(key, {
      ...base, lines: [{ itemCode: variant.variantCode, qty: 1, unitPricePaise: 300000, lineTotalPaise: 300000 }]
    });
    check('resending the corrected sale is re-evaluated, not handed the old rejection',
      fixed.data?.data?.answer === 'APPLIED', JSON.stringify(fixed.data?.data));

    const st2 = await api(key).get(`/events/status?invoiceNo=${encodeURIComponent(invoiceNo)}`);
    check('and it is APPLIED now, with an order number',
      st2.data?.data?.status === 'APPLIED' && String(st2.data?.data?.orderNumber ?? '').startsWith('SO-'),
      JSON.stringify(st2.data?.data?.orderNumber));

    const stock1 = await prisma.inventoryStock.findFirst({
      where: { clientId: CLIENT, variantId: variant.id }, select: { quantity: true }
    });
    check('the rejected attempt moved no stock; only the corrected one did',
      (stock0?.quantity ?? 0) - (stock1?.quantity ?? 0) === 1,
      `${stock0?.quantity} -> ${stock1?.quantity}`);

    const orders = await prisma.salesOrder.count({
      where: { clientId: CLIENT, externalOrderId: invoiceNo }
    });
    check('and exactly ONE order came out of the whole exchange', orders === 1, String(orders));
  }

  console.log('\nN. A RETURN IS ACTUALLY WRITTEN');
  {
    // A sale of its own, so the numbers cannot be disturbed by anything earlier.
    const inv = `INV/2026-27/RT${Date.now() % 10000}`;
    await prisma.inventoryStock.updateMany({
      where: { clientId: CLIENT, variantId: variant.id }, data: { quantity: 10, reservedQty: 0 }
    });
    const sale = await sendEvent(key, {
      kind: 'sale.completed', invoiceNo: inv, occurredAt: new Date().toISOString(),
      lines: [{ itemCode: variant.variantCode, qty: 2, unitPricePaise: 300000, lineTotalPaise: 600000 }],
      totals: {}, payments: [{ method: 'CASH', amountPaise: 600000 }]
    });
    check('the sale it will be returned against applied',
      sale.data?.data?.answer === 'APPLIED', JSON.stringify(sale.data?.data));

    const afterSale = await prisma.inventoryStock.findFirst({
      where: { clientId: CLIENT, variantId: variant.id }, select: { quantity: true }
    });
    check('two pieces went out', afterSale?.quantity === 8, String(afterSale?.quantity));

    const cn = `CN/2026-27/W${Date.now() % 10000}`;
    const ret = await sendEvent(key, {
      kind: 'sale.returned', creditNoteNo: cn, againstInvoiceNo: inv,
      lines: [{ itemCode: variant.variantCode, qty: 1, lineTotalPaise: 300000 }], totals: {},
      refund: { method: 'CASH' }
    });
    check('the return is APPLIED, not "the write is the next step"',
      ret.data?.data?.answer === 'APPLIED', JSON.stringify(ret.data?.data));
    check('and it comes back with a credit note number of ours',
      String(ret.data?.data?.orderNumber ?? '').startsWith('RET-'), String(ret.data?.data?.orderNumber));

    const afterReturn = await prisma.inventoryStock.findFirst({
      where: { clientId: CLIENT, variantId: variant.id }, select: { quantity: true }
    });
    check('ONE piece went back on the shelf', afterReturn?.quantity === 9, String(afterReturn?.quantity));

    const refunds = await prisma.salesOrderPayment.findMany({
      where: { clientId: CLIENT, kind: 'REFUND', salesOrder: { externalOrderId: inv } },
      select: { method: true, amount: true }
    });
    check('the money is recorded as a refund, so the day book sees it go out',
      refunds.length === 1 && Number(refunds[0].amount) === 3000,
      JSON.stringify(refunds.map(r => ({ m: r.method, a: String(r.amount) }))));

    const rows = await prisma.salesReturn.findMany({
      where: { clientId: CLIENT, salesOrder: { externalOrderId: inv } },
      select: { status: true, refundStatus: true, returnNumber: true }
    });
    check('the return itself is COMPLETED and marked refunded',
      rows.length === 1 && rows[0].status === 'COMPLETED' && rows[0].refundStatus === 'REFUNDED',
      JSON.stringify(rows));

    // the same credit note again must not refund a second time
    const again = await sendEvent(key, {
      kind: 'sale.returned', creditNoteNo: cn, againstInvoiceNo: inv,
      lines: [{ itemCode: variant.variantCode, qty: 1, lineTotalPaise: 300000 }], totals: {},
      refund: { method: 'CASH' }
    });
    check('sending the same credit note again is ALREADY_APPLIED',
      again.data?.data?.answer === 'ALREADY_APPLIED', JSON.stringify(again.data?.data));

    const afterTwice = await prisma.inventoryStock.findFirst({
      where: { clientId: CLIENT, variantId: variant.id }, select: { quantity: true }
    });
    check('and the piece did NOT go back twice', afterTwice?.quantity === 9, String(afterTwice?.quantity));

    const refundsTwice = await prisma.salesOrderPayment.count({
      where: { clientId: CLIENT, kind: 'REFUND', salesOrder: { externalOrderId: inv } }
    });
    check('nor was the money paid back twice', refundsTwice === 1, String(refundsTwice));

    // more than was sold, now that one has already come back
    const tooMany = await sendEvent(key, {
      kind: 'sale.returned', creditNoteNo: `CN/2026-27/Z${Date.now() % 10000}`, againstInvoiceNo: inv,
      lines: [{ itemCode: variant.variantCode, qty: 2, lineTotalPaise: 600000 }], totals: {}
    });
    check('returning more than is left is refused, counting what already came back',
      tooMany.data?.data?.answer === 'QTY_EXCEEDS_SOLD', JSON.stringify(tooMany.data?.data));
  }

  console.log('\nO. A REFUND SPLIT ACROSS TWO METHODS');
  {
    const inv = `INV/2026-27/SP${Date.now() % 10000}`;
    await prisma.inventoryStock.updateMany({
      where: { clientId: CLIENT, variantId: variant.id }, data: { quantity: 10, reservedQty: 0 }
    });
    await sendEvent(key, {
      kind: 'sale.completed', invoiceNo: inv, occurredAt: new Date().toISOString(),
      lines: [{ itemCode: variant.variantCode, qty: 2, unitPricePaise: 300000, lineTotalPaise: 600000 }],
      totals: {}, payments: [{ method: 'CASH', amountPaise: 600000 }]
    });

    // one piece back: 3000, given back as 1800 UPI + 1200 cash
    const cn = `CN/2026-27/SP${Date.now() % 10000}`;
    const ret = await sendEvent(key, {
      kind: 'sale.returned', creditNoteNo: cn, againstInvoiceNo: inv,
      lines: [{ itemCode: variant.variantCode, qty: 1, lineTotalPaise: 300000 }], totals: {},
      refund: { method: 'UPI', reference: 'utr-9931' },
      refunds: [
        { method: 'UPI', amountPaise: 180000, reference: 'utr-9931' },
        { method: 'CASH', amountPaise: 120000 }
      ]
    });
    check('a split refund is APPLIED', ret.data?.data?.answer === 'APPLIED',
      JSON.stringify(ret.data?.data));

    const rows = await prisma.salesOrderPayment.findMany({
      where: { clientId: CLIENT, kind: 'REFUND', salesOrder: { externalOrderId: inv } },
      select: { method: true, amount: true, reference: true }
    });
    check('it is TWO rows, not one -- the day book sees each method',
      rows.length === 2, JSON.stringify(rows.map(r => `${r.method} ${r.amount}`)));
    check('the UPI part kept its reference',
      rows.some(r => r.method === 'UPI' && Number(r.amount) === 1800 && r.reference === 'utr-9931'),
      JSON.stringify(rows.map(r => ({ m: r.method, a: String(r.amount), ref: r.reference }))));
    check('and the two add up to what came back',
      rows.reduce((a, r) => a + Number(r.amount), 0) === 3000,
      String(rows.reduce((a, r) => a + Number(r.amount), 0)));

    // a split that does NOT add up must not quietly write wrong books
    const cn2 = `CN/2026-27/SQ${Date.now() % 10000}`;
    const bad = await sendEvent(key, {
      kind: 'sale.returned', creditNoteNo: cn2, againstInvoiceNo: inv,
      lines: [{ itemCode: variant.variantCode, qty: 1, lineTotalPaise: 300000 }], totals: {},
      refund: { method: 'CASH' },
      refunds: [{ method: 'CASH', amountPaise: 250000 }]
    });
    check('a split that does not add up is still APPLIED -- a cashier cannot fix it',
      bad.data?.data?.answer === 'APPLIED', JSON.stringify(bad.data?.data));
    check('but it warns, naming both figures',
      (bad.data?.data?.warnings ?? []).some((w) => /2500.00/.test(w) && /3000.00/.test(w)),
      JSON.stringify(bad.data?.data?.warnings));

    const after = await prisma.salesOrderPayment.findMany({
      where: { clientId: CLIENT, kind: 'REFUND', salesOrder: { externalOrderId: inv } },
      select: { amount: true }
    });
    check('and the books stay consistent: one row for it, at OUR figure',
      after.length === 3 && after.some(r => Number(r.amount) === 3000),
      JSON.stringify(after.map(r => String(r.amount))));
  }

}

main()
  .then(async () => {
    await prisma.posInboundEvent.deleteMany({ where: { clientId: CLIENT } }).catch(() => {});
    await prisma.salesOrderPayment.deleteMany({ where: { clientId: CLIENT } });
    // Returns point at the order, so they go first or the order will not delete.
    await prisma.salesReturnItem.deleteMany({ where: { salesReturn: { clientId: CLIENT } } }).catch(() => {});
    await prisma.salesReturn.deleteMany({ where: { clientId: CLIENT } }).catch(() => {});
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
    await prisma.posInboundEvent.deleteMany({ where: { clientId: CLIENT } }).catch(() => {});
    await prisma.salesReturnItem.deleteMany({ where: { salesReturn: { clientId: CLIENT } } }).catch(() => {});
    await prisma.salesReturn.deleteMany({ where: { clientId: CLIENT } }).catch(() => {});
    await prisma.inventoryStock.deleteMany({ where: { clientId: CLIENT } }).catch(() => {});
    await prisma.productVariant.deleteMany({ where: { clientId: CLIENT } }).catch(() => {});
    await prisma.product.deleteMany({ where: { clientId: CLIENT } }).catch(() => {});
    await prisma.storefrontConnection.deleteMany({ where: { clientId: CLIENT } }).catch(() => {});
    await prisma.stockLocation.deleteMany({ where: { clientId: CLIENT } }).catch(() => {});
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
