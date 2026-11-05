/**
 * The shop's product list: price, search and "hide out of stock" together (5 Nov).
 * Each test says exactly which products should come back. The 4 Nov push put two ORs in one object (search
 * replaced price), and matched a product's stored base price even when the shopper is shown another.
 *
 * LOCAL DATABASE ONLY. Its own stores and products on the suites' test client, removed at the end.
 *   DATABASE_URL=postgresql://postgres:localpw@localhost:55433/inventory DIRECT_URL=<same> npx tsx src/scripts/verify-shop-catalogue-filters.ts
 */
const LOCAL = 'localhost:55433';
if (!String(process.env.DATABASE_URL || '').includes(LOCAL) || !String(process.env.DIRECT_URL || '').includes(LOCAL)) {
  console.error(`Refusing to run: DATABASE_URL and DIRECT_URL must both point at the local copy (${LOCAL}).`);
  process.exit(1);
}
import { prisma } from '../lib/prisma';
import { publicProducts } from '../services/online-shop/shop.service';

const C = 'verify-suites-tenant';
const STAMP = String(Date.now()).slice(-7);
const DRESS = `Filt${STAMP}`;
let failed = 0, passed = 0;
const same = (name: string, got: string[], want: string[]) => {
  const g = [...got].sort().join(','), w = [...want].sort().join(',');
  if (g === w) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name} -- got [${g}] want [${w}]`); }
};

async function main() {
  const made: string[] = [];
  const main = await prisma.stockLocation.create({ data: { clientId: C, name: 'Main', code: `FM-${STAMP}`, type: 'STORE' as any, active: true } });
  const branch = await prisma.stockLocation.create({ data: { clientId: C, name: 'Branch', code: `FB-${STAMP}`, type: 'STORE' as any, active: true } });
  let n = 0;
  const product = async (title: string, basePrice: number, extra: any = {}) => {
    const p = await prisma.product.create({ data: { clientId: C, productCode: `F${STAMP}-${++n}`, slug: `f${STAMP}-${n}`, title, category: 'WOMEN' as any, productType: 'READY_TO_WEAR' as any, dressType: DRESS, basePrice, status: 'ACTIVE' as any, ...extra } });
    made.push(p.id);
    return p;
  };
  const variant = (productId: string, sellingPrice: number | null, size = 'Free') => prisma.productVariant.create({ data: { productId, clientId: C, colorName: 'Red', size, variantCode: `FV${STAMP}-${++n}`, sku: `FS${STAMP}-${n}`, sellingPrice, costPrice: 1, reorderLevel: 0 } as any });
  const stock = (variantId: string, quantity: number, locationId = main.id) => prisma.inventoryStock.create({ data: { clientId: C, variantId, locationId, quantity, reservedQty: 0 } });

  try {
    // Swathy's case: a base price of 23, while every variant sells at 3000.
    const a = await product('Zari wrongbase', 23);          await stock((await variant(a.id, 3000)).id, 5);
    const b = await product('Zari usesbase', 1500);         await stock((await variant(b.id, null)).id, 5);
    const c = await product('Zari twoprices', 5000);        await stock((await variant(c.id, 1000, 'S')).id, 5); await stock((await variant(c.id, 6000, 'M')).id, 5);
    const gone = await product('Zari soldout', 2000);       await stock((await variant(gone.id, 2000)).id, 0);
    const reserved = await product('Zari allheld', 2200);
    const vr = await variant(reserved.id, 2200);            await prisma.inventoryStock.create({ data: { clientId: C, variantId: vr.id, locationId: main.id, quantity: 2, reservedQty: 2 } });
    const service = await product('Zari stitching', 700, { isService: true }); await variant(service.id, 700);
    // On sale at Main, switched off at Branch: still sellable, at Main.
    const multi = await product('Zari twostores', 2500);
    const vm = await variant(multi.id, 2500);               await stock(vm.id, 5);
    await prisma.variantLocationProfile.create({ data: { variantId: vm.id, locationId: branch.id, isAvailable: false } as any });
    const other = await product('Plain cotton', 1200);      await stock((await variant(other.id, 1200)).id, 5);

    const name = (p: any) => p.title.split(' ').slice(-1)[0] === 'cotton' ? 'cotton' : p.title.replace('Zari ', '');
    const shop = (hideOutOfStock: boolean, locationIds = [main.id, branch.id]) => ({ clientId: C, locationIds, hideOutOfStock, allPhotos: false, showFewLeft: true });
    const list = async (s: any, opts: any) => (await publicProducts(s, { dressType: DRESS, limit: 48, ...opts })).products.map(name);
    const all = ['wrongbase', 'usesbase', 'twoprices', 'soldout', 'allheld', 'stitching', 'twostores', 'cotton'];

    console.log('\nNothing chosen');
    same('every product', await list(shop(false), {}), all);

    console.log('\nPrice');
    same('up to 100: nothing, not the one whose stored base price is 23 but sells at 3000', await list(shop(false), { maxPrice: 100 }), []);
    same('2900 to 3100: the one selling at 3000', await list(shop(false), { minPrice: 2900, maxPrice: 3100 }), ['wrongbase']);
    same('1400 to 1600: the variant with no price of its own uses the base price', await list(shop(false), { minPrice: 1400, maxPrice: 1600 }), ['usesbase']);
    same('900 to 1100: one size of a two-price product is enough', await list(shop(false), { minPrice: 900, maxPrice: 1100 }), ['twoprices']);
    same('4900 to 5100: not on its base price, no size sells at that', await list(shop(false), { minPrice: 4900, maxPrice: 5100 }), []);

    console.log('\nSearch and price together');
    same('"Zari": the word alone', await list(shop(false), { q: 'Zari' }), all.filter(x => x !== 'cotton'));
    same('"Zari" up to 100: price still applies', await list(shop(false), { q: 'Zari', maxPrice: 100 }), []);
    same('"Zari" 1400 to 1600: price and word both apply', await list(shop(false), { q: 'Zari', minPrice: 1400, maxPrice: 1600 }), ['usesbase']);
    same('"cotton" 1400 to 1600: right price, wrong word', await list(shop(false), { q: 'cotton', minPrice: 1400, maxPrice: 1600 }), []);
    same('"cotton" 1100 to 1300: both right', await list(shop(false), { q: 'cotton', minPrice: 1100, maxPrice: 1300 }), ['cotton']);

    console.log('\nHide out of stock');
    const onSale = ['wrongbase', 'usesbase', 'twoprices', 'twostores', 'cotton'];
    same('sold-out and all-reserved go, a service goes (not sold online); switched off at one store stays', await list(shop(true), {}), onSale);
    same('the same with no stores chosen (meaning every store)', await list(shop(true, []), {}), onSale);
    same('with search and price too', await list(shop(true), { q: 'Zari', minPrice: 2400, maxPrice: 2600 }), ['twostores']);
    same('a sold-out one in range is still hidden', await list(shop(true), { minPrice: 1900, maxPrice: 2100 }), []);
    same('...and shown when the shop does not hide', await list(shop(false), { minPrice: 1900, maxPrice: 2100 }), ['soldout']);

    const page = await publicProducts(shop(true), { dressType: DRESS, limit: 48 });
    if (page.total >= page.products.length) { passed++; console.log('  ok   the count is never below what is listed'); }
    else { failed++; console.log(`  FAIL total ${page.total} below listed ${page.products.length}`); }
  } finally {
    const variants = await prisma.productVariant.findMany({ where: { productId: { in: made } }, select: { id: true } });
    const ids = variants.map(v => v.id);
    await prisma.variantLocationProfile.deleteMany({ where: { variantId: { in: ids } } });
    await prisma.inventoryStock.deleteMany({ where: { variantId: { in: ids } } });
    await prisma.productVariant.deleteMany({ where: { id: { in: ids } } });
    await prisma.product.deleteMany({ where: { id: { in: made } } });
    await prisma.stockLocation.deleteMany({ where: { id: { in: [main.id, branch.id] } } });
    const left = await prisma.product.count({ where: { clientId: C, dressType: DRESS } });
    if (left === 0) { passed++; console.log('\n  ok   cleanup: nothing left behind'); } else { failed++; console.log(`\n  FAIL cleanup left ${left}`); }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
}
main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(async () => { await prisma.$disconnect(); process.exit(failed || process.exitCode ? 1 : 0); });
