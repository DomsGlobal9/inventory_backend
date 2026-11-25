/**
 * The catalogue sync feed's quick pull sees EVERY change a till shows (25 Nov 2026, migration
 * 20261125150000_catalogue_changed_at). Found by the POS session: the feed paged on the product's updatedAt, so a
 * size's price or a stock movement pushed catalogue.changed at once but the till's cursor pull brought nothing.
 *
 * Against the REAL local database and the real feed (storefrontCatalogueService.listProducts, which GET
 * /pos/v1/catalogue serves): a throwaway shop, one product changed in every way, one never touched; after each
 * change the quick pull must bring exactly the changed product, and nothing when nothing changed.
 * Local only; everything it makes is removed.
 *   DATABASE_URL=<local> DIRECT_URL=<local> npx tsx src/scripts/verify-catalogue-cursor.ts
 */
import { prisma } from '../lib/prisma';
import { storefrontCatalogueService } from '../services/storefront-catalogue.service';

for (const k of ['DATABASE_URL', 'DIRECT_URL']) {
  if (!/localhost:55433/.test(process.env[k] ?? '')) { console.error(`Refusing: ${k} is not the local database.`); process.exit(2); }
}
const S = Date.now().toString(36);
const C = `catcur-${S}`;
let bad = 0, good = 0;
const check = (n: string, ok: boolean, d: unknown = '') => { ok ? good++ : bad++; console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${n}${ok ? '' : ' :: ' + JSON.stringify(d)}`); };

async function main() {
  const store = await prisma.stockLocation.create({ data: { clientId: C, code: `CC-${S}`, name: 'Main', type: 'STORE' as any, active: true } });
  const store2 = await prisma.stockLocation.create({ data: { clientId: C, code: `CC2-${S}`, name: 'Second', type: 'STORE' as any, active: true } });
  const mk = async (n: string) => {
    const p = await prisma.product.create({ data: { clientId: C, productCode: `CC-${n}-${S}`, slug: `cc-${n}-${S}`, title: `Saree ${n}`, category: 'WOMEN' as any, productType: 'READY_TO_WEAR' as any, basePrice: 1000, status: 'ACTIVE' as any, publishedAt: new Date(), sellInShop: true } as any });
    const v = await prisma.productVariant.create({ data: { clientId: C, productId: p.id, variantCode: `CCV-${n}-${S}`, sku: `CCS-${n}-${S}`, sellingPrice: 1000 } as any });
    const st = await prisma.inventoryStock.create({ data: { clientId: C, variantId: v.id, locationId: store.id, quantity: 5 } });
    return { p, v, st };
  };
  const A = await mk('A');
  const B = await mk('B');
  const scope = { clientId: C, locationIds: [store.id] };

  // The till's first (full) pull, then its quick pulls from the cursor it keeps.
  const full = await storefrontCatalogueService.listProducts(scope, { includeLeavers: true });
  check('full pull: both products', full.products.length === 2, full.products.length);
  let cursor = full.nextCursor!;
  const quick = async () => {
    const page = await storefrontCatalogueService.listProducts(scope, { cursor, includeLeavers: true, limit: 100 });
    cursor = page.nextCursor ?? cursor;
    return page.products.map((p: any) => p.productCode);
  };
  const only = (codes: string[], p: any) => codes.length === 1 && codes[0] === p.productCode;

  check('nothing changed: the quick pull brings nothing', (await quick()).length === 0);

  await prisma.productVariant.update({ where: { id: A.v.id }, data: { sellingPrice: 1100 } as any });
  let got = await quick();
  check('a size\'s price: brings that product (and only it)', only(got, A.p), got);
  const priced = (await storefrontCatalogueService.listProducts(scope, { includeLeavers: true })).products.find((p: any) => p.productCode === A.p.productCode) as any;
  check('...with the new price', Number(priced?.variants?.[0]?.price) === 1100, priced?.variants?.[0]?.price);

  await prisma.inventoryStock.update({ where: { id: A.st.id }, data: { quantity: 4 } });
  got = await quick();
  check('a stock movement (a sale took one): brings it', only(got, A.p), got);

  await prisma.inventoryStock.create({ data: { clientId: C, variantId: B.v.id, locationId: store2.id, quantity: 3 } });
  got = await quick();
  check('stock arriving at another store: brings that product', only(got, B.p), got);

  await prisma.variantLocationProfile.create({ data: { variantId: A.v.id, locationId: store.id, priceOverride: 900 } as any });
  got = await quick();
  check('a store price: brings it', only(got, A.p), got);

  await prisma.productImage.create({ data: { productId: B.p.id, url: 'https://example.invalid/x.jpg', orderIndex: 0, imageType: 'GALLERY' } as any });
  got = await quick();
  check('a photo: brings it', only(got, B.p), got);

  await prisma.product.update({ where: { id: A.p.id }, data: { title: 'Saree A, renamed' } });
  got = await quick();
  check('the product itself edited: brings it', only(got, A.p), got);

  const v2 = await prisma.productVariant.create({ data: { clientId: C, productId: B.p.id, variantCode: `CCV-B2-${S}`, sku: `CCS-B2-${S}`, sellingPrice: 1200 } as any });
  got = await quick();
  check('a new size added: brings it', only(got, B.p), got);

  // One commit moving many rows of one product: it is stamped, and comes once.
  await prisma.$transaction(async tx => {
    for (let i = 0; i < 40; i++) await tx.inventoryStock.update({ where: { id: A.st.id }, data: { quantity: { increment: 1 } } });
  });
  got = await quick();
  check('one bill moving 40 lines of one product: brings it once', only(got, A.p), got);

  // A change that is rolled back moves nothing.
  await prisma.$transaction(async tx => {
    await tx.inventoryStock.update({ where: { id: B.st.id }, data: { quantity: 99 } });
    throw new Error('rolled back on purpose');
  }).catch(() => undefined);
  check('a change rolled back: the quick pull brings nothing', (await quick()).length === 0);

  // Two shops' changes in parallel, and a since question as a reconciling website asks it.
  const t = new Date(Date.now() - 1);
  await Promise.all([
    prisma.inventoryStock.update({ where: { id: A.st.id }, data: { quantity: 7 } }),
    prisma.productVariant.update({ where: { id: v2.id }, data: { sellingPrice: 1250 } as any })
  ]);
  got = await quick();
  check('two changes at the same moment: both products come', got.length === 2 && got.includes(A.p.productCode) && got.includes(B.p.productCode), got);
  const since = await storefrontCatalogueService.listProducts(scope, { since: t, includeLeavers: true });
  check('"changed since" (a website reconciling) sees the same two', since.products.length === 2, since.products.length);

  // A size deleted: the product comes again (the size is gone from it).
  await prisma.productVariant.delete({ where: { id: v2.id } });
  got = await quick();
  check('a size deleted: brings that product', only(got, B.p), got);

  // Reservations hold pieces for an order (available goes down): watched too.
  const trig = await prisma.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM pg_trigger WHERE tgname LIKE 'catalogue_touch_%' AND tgrelid = 'inventory_reservations'::regclass`;
  check('a reservation also stamps its product (trigger in place)', Number(trig[0].n) === 2, trig);

  // A cursor kept from before this change (old format, same shape) still works: nothing lost, at worst a repeat.
  const old = Buffer.from(`${new Date(Date.now() - 3600_000).toISOString()}|00000000-0000-0000-0000-000000000000`).toString('base64url');
  const fromOld = await storefrontCatalogueService.listProducts(scope, { cursor: old, includeLeavers: true });
  check('a till\'s cursor from before the fix still pages (brings everything since)', fromOld.products.length === 2, fromOld.products.length);
}

async function cleanup() {
  const tables = await prisma.$queryRaw<{ table_name: string }[]>`SELECT DISTINCT table_name FROM information_schema.columns WHERE table_schema = 'public' AND column_name = 'client_id'`;
  await prisma.$executeRawUnsafe(`DELETE FROM inventory_product_images WHERE product_id IN (SELECT id FROM inventory_products WHERE client_id = $1)`, C).catch(() => undefined);
  await prisma.$executeRawUnsafe(`DELETE FROM variant_location_profiles WHERE variant_id IN (SELECT id FROM inventory_product_variants WHERE client_id = $1)`, C).catch(() => undefined);
  for (let round = 0; round < 6; round++) {
    let left = 0;
    for (const t of tables) { try { await prisma.$executeRawUnsafe(`DELETE FROM "${t.table_name}" WHERE client_id = $1`, C); } catch { left++; } }
    if (!left) break;
  }
}

main()
  .catch(e => { bad++; console.error('CRASH', e); })
  .finally(async () => { await cleanup().catch(e => console.error('cleanup failed', e)); console.log(`${good} passed, ${bad} problems`); await prisma.$disconnect(); process.exit(bad ? 1 : 0); });
