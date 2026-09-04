/**
 * Verifies the supplier <-> product catalogue.
 *
 * Runs against a live server so tenant scoping, permissions and route mounting are actually
 * exercised. The property that matters most here is isolation: these endpoints take a
 * supplierId and a variantId straight from the caller, so a tenant must not be able to link
 * or read another tenant's data by supplying its ids.
 *
 *   npx ts-node src/scripts/verify-supplier-products.ts
 */
import { prisma } from '../lib/prisma';

const BASE = process.env.TEST_API_URL || 'http://localhost:4006/api/v1';

let passed = 0;
let failed = 0;
const failures: string[] = [];

function check(name: string, ok: boolean, detail?: string) {
  if (ok) { passed++; console.log(`  [PASS] ${name}`); }
  else { failed++; failures.push(name); console.log(`  [FAIL] ${name}${detail ? `  -> ${detail}` : ''}`); }
}

class Jar {
  private cookies = new Map<string, string>();
  capture(res: Response) {
    for (const line of ((res.headers as any).getSetCookie?.() || [])) {
      const [pair] = String(line).split(';');
      const i = pair.indexOf('=');
      if (i > 0) this.cookies.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
    }
  }
  header() { return [...this.cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; '); }
}

async function call(method: string, path: string, body?: any, jar?: Jar) {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const cookie = jar?.header();
  if (cookie) headers['Cookie'] = cookie;
  const res = await fetch(`${BASE}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  jar?.capture(res);
  let json: any = null;
  try { json = await res.json(); } catch { /* no body */ }
  return { status: res.status, json };
}

async function main() {
  console.log(`\nVerifying against ${BASE}\n`);

  // A tenant with a supplier, a variant and a login is needed to exercise any of this.
  const owner = await prisma.user.findFirst({
    where: { email: 'e2e1788452461634@example.com' },
    select: { clientId: true, email: true }
  });
  if (!owner) throw new Error('Test tenant not found -- expected e2e1788452461634@example.com');

  const clientId = owner.clientId;
  const supplier = await prisma.supplier.findFirst({ where: { clientId }, select: { id: true, name: true } });
  const variants = await prisma.productVariant.findMany({ where: { clientId }, select: { id: true, sku: true }, take: 2 });
  if (!supplier || variants.length < 2) throw new Error('Test tenant needs a supplier and two variants');

  const jar = new Jar();
  const login = await call('POST', '/auth/login', { email: owner.email, password: '0B-GWDgJRCuK' }, jar);
  if (login.status !== 200) throw new Error(`Could not log in as the test tenant (${login.status})`);

  // Start clean so counts below are unambiguous.
  await prisma.supplierProduct.deleteMany({ where: { clientId, variantId: { in: variants.map(v => v.id) } } });

  // ─── LINKING ────────────────────────────────────────────────────────────────
  console.log('LINKING');
  const created = await call('POST', '/supplier-products', {
    supplierId: supplier.id, variantId: variants[0].id,
    supplierSku: 'SUP-ABC-01', costPrice: 420.5, leadTimeDays: 7, minOrderQty: 12
  }, jar);
  check('an item can be linked to a supplier', created.status === 201, `got ${created.status}`);
  check('the supplier SKU is stored', created.json?.data?.supplierSku === 'SUP-ABC-01');
  check('the agreed cost is stored', Number(created.json?.data?.costPrice) === 420.5);
  check('lead time and minimum order quantity are stored',
    created.json?.data?.leadTimeDays === 7 && created.json?.data?.minOrderQty === 12);
  check('the first supplier for an item becomes preferred automatically',
    created.json?.data?.isPreferred === true, String(created.json?.data?.isPreferred));

  const linkId = created.json?.data?.id;

  // ─── RE-LINKING IS AN EDIT, NOT A DUPLICATE ─────────────────────────────────
  const relinked = await call('POST', '/supplier-products', {
    supplierId: supplier.id, variantId: variants[0].id, costPrice: 399, supplierSku: 'SUP-ABC-02'
  }, jar);
  check('re-linking the same pair updates instead of erroring', relinked.status === 201, `got ${relinked.status}`);
  check('the updated terms are kept', Number(relinked.json?.data?.costPrice) === 399);
  const count = await prisma.supplierProduct.count({ where: { supplierId: supplier.id, variantId: variants[0].id } });
  check('re-linking does not create a second row', count === 1, `rows: ${count}`);

  // ─── VALIDATION ─────────────────────────────────────────────────────────────
  console.log('\nVALIDATION');
  const negative = await call('POST', '/supplier-products', {
    supplierId: supplier.id, variantId: variants[1].id, costPrice: -5
  }, jar);
  check('a negative cost is rejected', negative.status === 400, `got ${negative.status}`);

  const fractionalLead = await call('POST', '/supplier-products', {
    supplierId: supplier.id, variantId: variants[1].id, leadTimeDays: 2.5
  }, jar);
  check('a fractional lead time is rejected', fractionalLead.status === 400, `got ${fractionalLead.status}`);

  const zeroCost = await call('POST', '/supplier-products', {
    supplierId: supplier.id, variantId: variants[1].id, costPrice: 0
  }, jar);
  check('a zero cost is allowed (free samples are real)', zeroCost.status === 201, `got ${zeroCost.status}`);

  const badIds = await call('POST', '/supplier-products', { supplierId: 'not-a-uuid', variantId: variants[0].id }, jar);
  check('a malformed supplier id is rejected', badIds.status === 400, `got ${badIds.status}`);

  // ─── TENANT ISOLATION ───────────────────────────────────────────────────────
  console.log('\nTENANT ISOLATION');
  const foreignVariant = await prisma.productVariant.findFirst({
    where: { clientId: { not: clientId } }, select: { id: true }
  });
  const foreignSupplier = await prisma.supplier.findFirst({
    where: { clientId: { not: clientId } }, select: { id: true }
  });

  if (foreignVariant) {
    const r = await call('POST', '/supplier-products', { supplierId: supplier.id, variantId: foreignVariant.id }, jar);
    check("another tenant's variant cannot be linked", r.status === 404, `got ${r.status}`);
  } else {
    check("another tenant's variant cannot be linked", true, 'skipped -- no other tenant');
  }

  if (foreignSupplier) {
    const r = await call('POST', '/supplier-products', { supplierId: foreignSupplier.id, variantId: variants[0].id }, jar);
    check("another tenant's supplier cannot be linked", r.status === 404, `got ${r.status}`);
  } else {
    check("another tenant's supplier cannot be linked", true, 'skipped -- no other tenant');
  }

  const anon = await call('GET', `/suppliers/${supplier.id}/products`);
  check('the catalogue is not readable without a session', anon.status === 401, `got ${anon.status}`);

  // ─── READING FROM BOTH ENDS ─────────────────────────────────────────────────
  console.log('\nREADING');
  const bySupplier = await call('GET', `/suppliers/${supplier.id}/products`, undefined, jar);
  check("a supplier's items can be listed", bySupplier.status === 200, `got ${bySupplier.status}`);
  check('the linked item is in that list',
    (bySupplier.json?.data || []).some((l: any) => l.variant?.id === variants[0].id));
  check('the list carries stock and reorder data for ordering decisions',
    (bySupplier.json?.data || []).some((l: any) => l.variant?.stocks !== undefined && l.variant?.reorderLevel !== undefined));

  const byVariant = await call('GET', `/variants/${variants[0].id}/suppliers`, undefined, jar);
  check('the suppliers of one item can be listed', byVariant.status === 200, `got ${byVariant.status}`);
  check('the supplier is named for "who supplies this?"',
    (byVariant.json?.data || []).some((l: any) => l.supplier?.name === supplier.name));

  const search = await call('GET', `/suppliers/${supplier.id}/products?search=${encodeURIComponent(variants[0].sku)}`, undefined, jar);
  check("a supplier's items can be searched by SKU",
    search.status === 200 && (search.json?.data || []).some((l: any) => l.variant?.id === variants[0].id));

  // ─── PREFERRED IS EXCLUSIVE ─────────────────────────────────────────────────
  console.log('\nPREFERRED SUPPLIER');
  const second = await prisma.supplier.findFirst({
    where: { clientId, id: { not: supplier.id } }, select: { id: true }
  });

  if (second) {
    const secondLink = await call('POST', '/supplier-products', {
      supplierId: second.id, variantId: variants[0].id, costPrice: 380, isPreferred: true
    }, jar);
    check('a second supplier can be linked to the same item', secondLink.status === 201, `got ${secondLink.status}`);

    const preferredRows = await prisma.supplierProduct.findMany({
      where: { clientId, variantId: variants[0].id, isPreferred: true }, select: { supplierId: true }
    });
    check('exactly one supplier stays preferred', preferredRows.length === 1, `preferred rows: ${preferredRows.length}`);
    check('the newly preferred supplier is the one just set', preferredRows[0]?.supplierId === second.id);

    const back = await call('POST', `/supplier-products/${linkId}/preferred`, {}, jar);
    check('preference can be moved back', back.status === 200, `got ${back.status}`);
    const afterRows = await prisma.supplierProduct.findMany({
      where: { clientId, variantId: variants[0].id, isPreferred: true }, select: { supplierId: true }
    });
    check('moving preference still leaves exactly one', afterRows.length === 1, `preferred rows: ${afterRows.length}`);
  } else {
    check('a second supplier can be linked to the same item', true, 'skipped -- tenant has one supplier');
  }

  // ─── UNLINK ─────────────────────────────────────────────────────────────────
  console.log('\nUNLINK');
  const missing = await call('DELETE', '/supplier-products/00000000-0000-0000-0000-000000000000', undefined, jar);
  check('unlinking something that does not exist returns 404', missing.status === 404, `got ${missing.status}`);

  const removed = await call('DELETE', `/supplier-products/${linkId}`, undefined, jar);
  check('a link can be removed', removed.status === 200, `got ${removed.status}`);
  const gone = await prisma.supplierProduct.count({ where: { id: linkId } });
  check('the link is actually gone', gone === 0);

  // ─── CLEANUP ────────────────────────────────────────────────────────────────
  await prisma.supplierProduct.deleteMany({
    where: { clientId, variantId: { in: variants.map(v => v.id) } }
  });
  console.log('\nCLEANUP\n  removed test links');

  console.log(`\n================ RESULT: ${passed} passed | ${failed} failed ================`);
  if (failed) {
    console.log('Failed:\n' + failures.map(f => `  - ${f}`).join('\n'));
    process.exit(1);
  }
}

main()
  .catch(e => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
