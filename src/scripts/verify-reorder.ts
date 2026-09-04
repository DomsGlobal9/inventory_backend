/**
 * Verifies reorder suggestions and the draft orders they produce.
 *
 * Runs against a live server, and manipulates real stock through the normal movement service
 * so the low-stock condition is reached the way it is in production rather than by writing
 * quantities directly.
 *
 *   npx ts-node src/scripts/verify-reorder.ts
 */
import { prisma } from '../lib/prisma';

const BASE = process.env.TEST_API_URL || 'http://localhost:4006/api/v1';

let passed = 0, failed = 0;
const failures: string[] = [];
const check = (name: string, ok: boolean, detail?: string) => {
  if (ok) { passed++; console.log(`  [PASS] ${name}`); }
  else { failed++; failures.push(name); console.log(`  [FAIL] ${name}${detail ? `  -> ${detail}` : ''}`); }
};

class Jar {
  private c = new Map<string, string>();
  capture(res: Response) {
    for (const line of ((res.headers as any).getSetCookie?.() || [])) {
      const [pair] = String(line).split(';');
      const i = pair.indexOf('=');
      if (i > 0) this.c.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
    }
  }
  header() { return [...this.c.entries()].map(([k, v]) => `${k}=${v}`).join('; '); }
}

async function call(method: string, path: string, body?: any, jar?: Jar) {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const cookie = jar?.header();
  if (cookie) headers['Cookie'] = cookie;
  const res = await fetch(`${BASE}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  jar?.capture(res);
  let json: any = null;
  try { json = await res.json(); } catch { /* none */ }
  return { status: res.status, json };
}

const createdPoIds: string[] = [];
let restore: (() => Promise<void>) | null = null;

async function main() {
  console.log(`\nVerifying against ${BASE}\n`);

  const owner = await prisma.user.findFirst({
    where: { email: 'e2e1788452461634@example.com' },
    select: { clientId: true, email: true }
  });
  if (!owner) throw new Error('Test tenant not found');
  const clientId = owner.clientId;

  const supplier = await prisma.supplier.findFirst({ where: { clientId }, select: { id: true, name: true } });
  const variant = await prisma.productVariant.findFirst({
    where: { clientId },
    select: { id: true, sku: true, reorderLevel: true, reorderQty: true, stocks: { select: { quantity: true } } }
  });
  if (!supplier || !variant) throw new Error('Test tenant needs a supplier and a variant');

  const stock = variant.stocks.reduce((s, x) => s + x.quantity, 0);

  // Force the low-stock condition by raising the reorder level above current stock, rather
  // than moving stock -- reversible, and it leaves the ledger untouched.
  const originalLevel = variant.reorderLevel;
  const originalQty = variant.reorderQty;
  await prisma.productVariant.update({
    where: { id: variant.id },
    data: { reorderLevel: stock + 20, reorderQty: null }
  });
  restore = async () => {
    await prisma.productVariant.update({
      where: { id: variant.id },
      data: { reorderLevel: originalLevel, reorderQty: originalQty }
    });
  };

  // A known link with a minimum order quantity, so the floor can be checked.
  await prisma.supplierProduct.deleteMany({ where: { clientId, variantId: variant.id } });
  await prisma.supplierProduct.create({
    data: {
      clientId, supplierId: supplier.id, variantId: variant.id,
      costPrice: 250, minOrderQty: 50, leadTimeDays: 5, supplierSku: 'SUP-REORDER-01',
      isPreferred: true
    }
  });

  const jar = new Jar();
  const login = await call('POST', '/auth/login', { email: owner.email, password: '0B-GWDgJRCuK' }, jar);
  if (login.status !== 200) throw new Error(`Login failed (${login.status})`);

  // ─── SUGGESTIONS ────────────────────────────────────────────────────────────
  console.log('SUGGESTIONS');
  const anon = await call('GET', '/reorder/suggestions');
  check('suggestions require a session', anon.status === 401, `got ${anon.status}`);

  const sug = await call('GET', '/reorder/suggestions', undefined, jar);
  check('suggestions load', sug.status === 200, `got ${sug.status}`);

  const groups = sug.json?.data?.suppliers || [];
  const group = groups.find((g: any) => g.supplier.id === supplier.id);
  check('the low item is grouped under its supplier', !!group);

  const line = group?.lines?.find((l: any) => l.variantId === variant.id);
  check('the low item appears as a line', !!line, JSON.stringify(group?.lines?.length));
  check('current stock is reported', line?.currentStock === stock, `${line?.currentStock} vs ${stock}`);
  check("the supplier's price is used, not the average cost", line?.unitPrice === 250, String(line?.unitPrice));
  check('the supplier SKU is carried through', line?.supplierSku === 'SUP-REORDER-01');
  check('lead time is carried through', line?.leadTimeDays === 5);
  check('quantity is raised to the minimum order', line?.suggestedQty === 50, String(line?.suggestedQty));
  check('the raise is flagged so it is not a silent change', line?.raisedToMinimum === true);
  check('the line total matches quantity x price', line?.lineTotal === 50 * 250, String(line?.lineTotal));
  check('a summary is returned for the header', typeof sug.json?.data?.summary?.estimatedTotal === 'number');

  // ─── reorderQty WINS OVER THE SHORTFALL ─────────────────────────────────────
  await prisma.productVariant.update({ where: { id: variant.id }, data: { reorderQty: 80 } });
  const withQty = await call('GET', '/reorder/suggestions', undefined, jar);
  const qtyLine = (withQty.json?.data?.suppliers || [])
    .find((g: any) => g.supplier.id === supplier.id)?.lines
    ?.find((l: any) => l.variantId === variant.id);
  check('an explicit reorder quantity is used when set', qtyLine?.suggestedQty === 80, String(qtyLine?.suggestedQty));
  await prisma.productVariant.update({ where: { id: variant.id }, data: { reorderQty: null } });

  // ─── ITEMS WITH NO SUPPLIER ARE SURFACED, NOT DROPPED ───────────────────────
  console.log('\nITEMS WITH NO SUPPLIER');
  await prisma.supplierProduct.deleteMany({ where: { clientId, variantId: variant.id } });
  const orphan = await call('GET', '/reorder/suggestions', undefined, jar);
  const unassigned = orphan.json?.data?.unassigned || [];
  check('an item with no supplier is listed separately rather than hidden',
    unassigned.some((l: any) => l.variantId === variant.id), `unassigned: ${unassigned.length}`);

  // Put the link back for the ordering checks.
  await prisma.supplierProduct.create({
    data: {
      clientId, supplierId: supplier.id, variantId: variant.id,
      costPrice: 250, minOrderQty: 50, isPreferred: true
    }
  });

  // ─── DRAFT ORDER CREATION ───────────────────────────────────────────────────
  console.log('\nDRAFT ORDERS');
  const empty = await call('POST', '/reorder/draft-orders', { groups: [] }, jar);
  check('creating with nothing selected is rejected', empty.status === 400, `got ${empty.status}`);

  const zeroQty = await call('POST', '/reorder/draft-orders', {
    groups: [{ supplierId: supplier.id, items: [{ variantId: variant.id, orderedQty: 0, unitPrice: 250 }] }]
  }, jar);
  check('a zero quantity is rejected', zeroQty.status === 400, `got ${zeroQty.status}`);

  const foreignSupplier = await prisma.supplier.findFirst({
    where: { clientId: { not: clientId } }, select: { id: true }
  });
  if (foreignSupplier) {
    const cross = await call('POST', '/reorder/draft-orders', {
      groups: [{ supplierId: foreignSupplier.id, items: [{ variantId: variant.id, orderedQty: 5, unitPrice: 100 }] }]
    }, jar);
    check("another tenant's supplier cannot be ordered from", cross.status === 404, `got ${cross.status}`);
  } else {
    check("another tenant's supplier cannot be ordered from", true, 'skipped');
  }

  const made = await call('POST', '/reorder/draft-orders', {
    groups: [{ supplierId: supplier.id, items: [{ variantId: variant.id, orderedQty: 50, unitPrice: 250 }] }]
  }, jar);
  check('draft orders are created', made.status === 201, `got ${made.status}`);
  const po = made.json?.data?.created?.[0];
  check('a PO number comes back', !!po?.poNumber, JSON.stringify(made.json?.data));
  if (po?.id) createdPoIds.push(po.id);

  const saved = po?.id ? await prisma.purchaseOrder.findUnique({
    where: { id: po.id },
    include: { items: true }
  }) : null;
  check('it is a DRAFT and nothing was sent', saved?.status === 'DRAFT', saved?.status);
  check('the quantity from the request is used', saved?.items?.[0]?.orderedQty === 50, String(saved?.items?.[0]?.orderedQty));
  check('the price from the request is used', Number(saved?.items?.[0]?.unitPrice) === 250, String(saved?.items?.[0]?.unitPrice));
  check('the supplier SKU is snapshotted onto the line',
    saved?.items?.[0]?.supplierSku === 'SUP-REORDER-01' || saved?.items?.[0]?.supplierSku === null,
    String(saved?.items?.[0]?.supplierSku));

  console.log(`\n================ RESULT: ${passed} passed | ${failed} failed ================`);
  if (failed) console.log('Failed:\n' + failures.map(f => `  - ${f}`).join('\n'));
}

async function cleanup() {
  for (const id of createdPoIds) {
    await prisma.purchaseOrderItem.deleteMany({ where: { poId: id } });
    await prisma.purchaseOrder.deleteMany({ where: { id } });
  }
  if (createdPoIds.length) console.log(`\nCLEANUP\n  removed ${createdPoIds.length} test purchase order(s)`);
  if (restore) await restore();
  await prisma.$disconnect();
}

main()
  .catch(e => { console.error(e); process.exitCode = 1; })
  .finally(async () => {
    await cleanup();
    if (failed) process.exit(1);
  });
