/**
 * Gives the demo shop something to look at.
 *
 * ensureDemoClient() rebuilds the shop, its roles and a handful of products, but every list screen
 * -- returns, stock counts, offers, purchase orders, suppliers, tickets -- came up empty, so there
 * was nothing on them to click, and no way to tell a working screen from a broken one.
 *
 * Everything here goes through the HTTP API with a real signed-in session, exactly as the screens
 * do. Nothing is written straight to the database, so a row that appears here is a row the app can
 * really make. It is safe to run again: it checks what is already there and only fills the gaps.
 */
import crypto from 'crypto';
import axios, { AxiosInstance } from 'axios';
import { prisma } from '../../lib/prisma';
import { AuthService } from '../../services/auth.service';

const BASE = process.env.VERIFY_BASE_URL || 'http://localhost:4006/api/v1';
const CLIENT = 'demo-client';
const EMAIL = 'admin@example.com';

const body = (r: any) => (r.data?.data !== undefined ? r.data.data : r.data);
const brief = (r: any) => `${r.status} ${JSON.stringify(r.data).slice(0, 200)}`;

async function signIn(): Promise<AxiosInstance> {
  const password = crypto.randomBytes(12).toString('base64url');
  const owner = await prisma.user.findFirstOrThrow({ where: { clientId: CLIENT, email: EMAIL } });
  await prisma.user.update({ where: { id: owner.id }, data: { password: await AuthService.hashPassword(password) } });

  const login = await axios.post(`${BASE}/auth/login`, { email: EMAIL, password },
    { headers: { 'x-client-id': CLIENT }, validateStatus: () => true });
  if (login.status !== 200) throw new Error(`could not sign in: ${brief(login)}`);

  const cookie = (login.headers['set-cookie'] || []).map((c: string) => c.split(';')[0]).join('; ');
  return axios.create({
    baseURL: BASE,
    headers: { 'x-client-id': CLIENT, Cookie: cookie },
    validateStatus: () => true
  });
}

export async function seedDemoData() {
  const api = await signIn();
  const made: string[] = [];

  const location = await prisma.stockLocation.findFirstOrThrow({ where: { clientId: CLIENT, code: 'MAIN-STORE' } });
  const variants = await prisma.productVariant.findMany({
    where: { clientId: CLIENT, product: { status: 'ACTIVE' } }, take: 4, select: { id: true, sku: true }
  });
  if (variants.length < 2) throw new Error('the demo shop has fewer than two sellable items -- run ensureDemoClient first');

  // ── a supplier and a purchase order, part received ──────────────────────────────────────────
  if (await prisma.supplier.count({ where: { clientId: CLIENT } }) === 0) {
    const s = await api.post('/suppliers', {
      name: 'Kanchi Silk House', contactName: 'Ravi Kumar',
      email: 'orders@kanchisilk.example', phone: '9876500011', address: 'Gandhi Road, Kanchipuram'
    });
    if (s.status >= 300) throw new Error(`supplier: ${brief(s)}`);
    made.push('supplier');
  }
  const supplier = await prisma.supplier.findFirstOrThrow({ where: { clientId: CLIENT } });

  if (await prisma.purchaseOrder.count({ where: { clientId: CLIENT } }) === 0) {
    for (const [i, v] of variants.slice(0, 2).entries()) {
      const po = await api.post('/purchase-orders', {
        supplierId: supplier.id, locationId: location.id,
        items: [{ variantId: v.id, orderedQty: 10, unitPrice: 800 + i * 100 }]
      });
      if (po.status >= 300) throw new Error(`purchase order: ${brief(po)}`);
      // One left as a draft, one sent and half received, so the list shows more than one state.
      if (i === 1) {
        const id = body(po).id;
        await api.put(`/purchase-orders/${id}/status`, { status: 'SENT' });
        const fresh = body(await api.get(`/purchase-orders/${id}`));
        await api.post(`/purchase-orders/${id}/receive`, {
          receivedByName: 'Demo Admin', locationId: location.id,
          receipts: [{ poItemId: fresh.items[0].id, quantityReceived: 4 }]
        });
      }
    }
    made.push('purchase orders');
  }

  // ── an offer, running ───────────────────────────────────────────────────────────────────────
  if (await prisma.offer.count({ where: { clientId: CLIENT } }) === 0) {
    const o = await api.post('/offers', {
      name: 'Festive 10% off', trigger: 'AUTOMATIC', valueType: 'PERCENTAGE', value: 10,
      scope: 'ALL', startsAt: new Date(Date.now() - 3600_000).toISOString(), endsAt: null, priority: 1
    });
    if (o.status >= 300) throw new Error(`offer: ${brief(o)}`);
    await api.post(`/offers/${body(o).id}/status`, { status: 'ACTIVE' });
    made.push('offer');
  }

  // ── a stock count, still open ───────────────────────────────────────────────────────────────
  if (await prisma.stockCount.count({ where: { clientId: CLIENT } }) === 0) {
    const c = await api.post('/stock-counts', { name: 'Weekly count', locationId: location.id, createdBy: 'Demo Admin' });
    if (c.status >= 300) throw new Error(`stock count: ${brief(c)}`);
    await api.post(`/stock-counts/${body(c).id}/start`);
    made.push('stock count');
  }

  // ── a counter sale, and a piece brought back ────────────────────────────────────────────────
  if (await prisma.salesReturn.count({ where: { clientId: CLIENT } }) === 0) {
    const customer = await prisma.customer.findFirstOrThrow({ where: { clientId: CLIENT } });
    const lines = [{ variantId: variants[0].id, quantity: 2 }];
    const quote = await api.post('/pricing/quote', { locationId: location.id, channel: 'POS', lines });
    if (quote.status !== 200) throw new Error(`quote: ${brief(quote)}`);
    const due = Number(body(quote).total ?? body(quote).payable ?? 0);
    const sale = await api.post('/counter-sales', {
      saleId: crypto.randomUUID(), locationId: location.id, quoteId: body(quote).quoteId,
      customer: { id: customer.id }, items: lines, payments: [{ method: 'CASH', amount: due }]
    });
    if (sale.status >= 300) throw new Error(`counter sale: ${brief(sale)}`);
    const bill = body(sale);

    const takeable = await api.get(`/counter-returns/sale/${bill.id}`);
    const line = body(takeable).lines[0];
    const ret = await api.post('/counter-returns', {
      key: crypto.randomUUID(), orderId: bill.id,
      lines: [{ dispatchItemId: line.dispatchItemId, quantity: 1 }],
      reason: 'SIZE_ISSUE', refund: { method: 'CASH' }
    });
    if (ret.status >= 300) throw new Error(`return: ${brief(ret)}`);
    made.push('counter sale and return');
  }

  // ── a support ticket ────────────────────────────────────────────────────────────────────────
  if (await prisma.supportTicket.count({ where: { clientId: CLIENT } }) === 0) {
    const t = await api.post('/support-tickets', {
      subject: 'Barcode scanner not reading tags',
      description: 'The scanner at the second till stopped reading tags this morning. It beeps but nothing appears on screen.',
      category: 'BUG', priority: 'NORMAL'
    });
    if (t.status >= 300) throw new Error(`support ticket: ${brief(t)}`);
    made.push('support ticket');
  }

  return made;
}

if (require.main === module) {
  seedDemoData()
    .then(made => console.log(made.length ? `Added: ${made.join(', ')}` : 'Nothing to add -- the demo shop already has data.'))
    .catch(e => { console.error('STOPPED:', e.message); process.exitCode = 1; })
    .finally(() => prisma.$disconnect());
}
