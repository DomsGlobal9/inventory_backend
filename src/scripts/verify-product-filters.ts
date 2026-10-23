/**
 * The Products page's search, filters, counts, sort and paging (services/product-filters), on two
 * throwaway shops built here and removed at the end. Every answer is worked out by hand below.
 *
 *   npx tsx src/scripts/verify-product-filters.ts
 */
import { prisma } from '../lib/prisma';
import { filterProducts, productFilterQuery, NOT_SET } from '../services/product-filters';
import { productRepository } from '../repositories/product.repository';

const STAMP = Date.now();
const C = `pf-${STAMP}`;
const OTHER = `pf-other-${STAMP}`;
let passed = 0, failed = 0;
const check = (name: string, ok: boolean, detail?: unknown) => {
  if (ok) { passed++; console.log(`  ok   ${name}`); } else { failed++; console.log(`  FAIL ${name}${detail === undefined ? '' : ' -- ' + JSON.stringify(detail).slice(0, 500)}`); }
};
const eq = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const q = (o: Record<string, unknown> = {}) => productFilterQuery.parse(o);
const titles = (r: any) => r.data.map((p: any) => p.title);
const facet = (r: any, f: string) => Object.fromEntries(r.facets[f].map((o: any) => [o.value, o.count]));

let n = 0;
async function main() {
  const loc = await prisma.stockLocation.create({ data: { clientId: C, name: 'Main', code: `M-${STAMP}`, type: 'STORE' as any, active: true } });
  const product = (clientId: string, title: string, extra: any = {}) => prisma.product.create({ data: { clientId, productCode: `PF${STAMP}-${++n}`, slug: `pf${STAMP}-${n}`, title, category: 'WOMEN' as any, productType: 'READY_TO_WEAR' as any, basePrice: 1000, status: 'ACTIVE' as any, ...extra } });
  const variant = (clientId: string, productId: string, colorName: string | null, sellingPrice: number | null, reorderLevel = 2, extra: any = {}) =>
    prisma.productVariant.create({ data: { productId, clientId, colorName, size: 'Free', variantCode: `PV${STAMP}-${++n}`, sku: `PSKU${STAMP}-${n}`, sellingPrice, costPrice: 100, reorderLevel, ...extra } as any });
  const stock = (variantId: string, quantity: number) => prisma.inventoryStock.create({ data: { clientId: C, variantId, locationId: loc.id, quantity, reservedQty: 0 } });

  // ── The shop ────────────────────────────────────────────────────────────────────────────────────
  // A: Saree, Silk, brand Weave. Navy ₹900 in stock (10), Crimson ₹6,000 SOLD OUT.
  const A = await product(C, 'Alpha Silk Saree', { dressType: 'Saree', fabric: 'Silk', brand: 'Weave', createdAt: new Date('2026-10-01') });
  const aNavy = await variant(C, A.id, 'Navy', 900); await stock(aNavy.id, 10);
  const aRed = await variant(C, A.id, 'Crimson', 6000); await stock(aRed.id, 0);
  // B: Saree, Cotton, no brand. Indigo, no price of its own (falls back to base ₹1,000), 2 left of 2: running low.
  const B = await product(C, 'Beta Cotton Saree', { dressType: 'Saree', fabric: 'Cotton', createdAt: new Date('2026-10-02') });
  const bInd = await variant(C, B.id, 'Indigo', null, 2, { barcode: `BC${STAMP}` }); await stock(bInd.id, 2);
  // C: Lehenga, no fabric, brand Weave. Goldenrod ₹20,000, 5 in stock. Only its COLOUR has a photo.
  const Cp = await product(C, 'Gamma Lehenga', { dressType: 'Lehenga', brand: 'Weave', createdAt: new Date('2026-10-03') });
  const cGold = await variant(C, Cp.id, 'Goldenrod', 20000); await stock(cGold.id, 5);
  await prisma.productImage.create({ data: { variantId: cGold.id, url: 'https://x.test/c.jpg', isPrimary: true, imageType: 'GALLERY' as any, orderIndex: 0 } as any });
  // D: a DRAFT Kurti in a colour no family knows ("Zzzberry") at ₹500, 1 in stock, reorder 0 (not tracked).
  const D = await product(C, 'Delta Kurti', { dressType: 'Kurti', status: 'DRAFT', createdAt: new Date('2026-10-04') });
  const dZ = await variant(C, D.id, 'Zzzberry', 500, 0); await stock(dZ.id, 1);
  // E: archived, F: binned -- neither in the default list.
  const E = await product(C, 'Echo Archived Saree', { dressType: 'Saree', status: 'ARCHIVED', createdAt: new Date('2026-10-05') });
  await variant(C, E.id, 'Navy', 700);
  const F = await product(C, 'Foxtrot Binned Saree', { dressType: 'Saree', status: 'TRASHED', trashedAt: new Date(), createdAt: new Date('2026-10-06') });
  await variant(C, F.id, 'Navy', 700);
  // G: a product with no colours at all.
  await product(C, 'Hotel No Colours', { dressType: 'Dupatta', createdAt: new Date('2026-09-01') });
  // 55 filler sarees (for paging), Black, ₹2,000, oldest of all.
  for (let i = 0; i < 55; i++) {
    const p = await product(C, `Zulu Filler ${String(i).padStart(2, '0')}`, { dressType: 'Saree', fabric: 'Georgette', createdAt: new Date(Date.UTC(2026, 0, 1, 0, i)) });
    await variant(C, p.id, 'Black', 2000, 0);
  }
  // ── Another shop, with its own brand and colour ──────────────────────────────────────────────────
  const X = await product(OTHER, 'Other Shop Saree', { dressType: 'Saree', brand: 'Somebody Else Studio', fabric: 'Silk' });
  await variant(OTHER, X.id, 'Navy', 900);

  console.log('\nA. EVERYTHING, AND ONLY THIS SHOP');
  const all = await filterProducts(C, q());
  check('active and draft only: 60 products (A, B, C, D, the one with no colours, 55 fillers); archived and binned left out', all.meta.total === 60 && all.meta.everything === 60, all.meta);
  check('nothing from the other shop: no "Somebody Else Studio" brand, no Other Shop product, anywhere', !JSON.stringify(all).includes('Somebody Else') && !JSON.stringify(all).includes('Other Shop'));
  check('the other shop sees only its own one product and brand', await filterProducts(OTHER, q()).then(r => r.meta.total === 1 && eq(r.facets.brand.map(b => b.value), ['Somebody Else Studio'])));
  check('first page: 50, newest first (Delta, Gamma, Beta, Alpha, then the one with no colours)', all.data.length === 50 && eq(titles(all).slice(0, 5), ['Delta Kurti', 'Gamma Lehenga', 'Beta Cotton Saree', 'Alpha Silk Saree', 'Hotel No Colours']), titles(all).slice(0, 6));
  const page2 = await filterProducts(C, q({ page: 2 }));
  check('page 2: the other 10, none repeated', page2.data.length === 10 && !page2.data.some((p: any) => all.data.some((a: any) => a.id === p.id)), page2.data.length);
  check('the rows look exactly like the plain list\'s (same fields: colours, variantSummary, coverImageUrl)', ['colours', 'variantSummary', 'coverImageUrl', 'generating'].every(k => k in all.data[1]));

  console.log('\nB. COLOUR FAMILIES AND COUNTS');
  const colours = facet(all, 'colour');
  check('Navy and Indigo are both Blue (2 products), Crimson is Red, Goldenrod is Gold, Zzzberry stays as typed', colours.Blue === 2 && colours.Red === 1 && colours.Gold === 1 && colours.Zzzberry === 1 && colours.Black === 55, colours);
  const blue = await filterProducts(C, q({ colour: 'Blue' }));
  check('Blue: Alpha and Beta', eq(titles(blue).sort(), ['Alpha Silk Saree', 'Beta Cotton Saree']), titles(blue));
  check('Blue keeps the other colours counted (Red still 1, Black still 55), so a second colour can be added', facet(blue, 'colour').Red === 1 && facet(blue, 'colour').Black === 55, facet(blue, 'colour'));
  check('...and the other filters count only blue ones (Type: Saree 2, Lehenga 0)', facet(blue, 'type').Saree === 2 && facet(blue, 'type').Lehenga === 0, facet(blue, 'type'));
  check('Alpha comes with only its Navy colour marked as matching (the photo view shows the blue one)', eq((blue.data.find((p: any) => p.title === 'Alpha Silk Saree') as any).matches, [aNavy.id]));
  const blueRed = await filterProducts(C, q({ colour: 'Blue|Red' }));
  check('Blue or Red: Alpha (both colours match) and Beta', blueRed.meta.total === 2 && (blueRed.data.find((p: any) => p.title === 'Alpha Silk Saree') as any).matches.length === 2);

  console.log('\nC. ONE COLOUR MUST PASS EVERY FILTER AT ONCE');
  const blueDear = await filterProducts(C, q({ colour: 'Blue', min: '5000' }));
  check('Blue and ₹5,000 or more: nothing -- Alpha\'s blue is ₹900 and its ₹6,000 colour is red', blueDear.meta.total === 0, titles(blueDear));
  const redOut = await filterProducts(C, q({ colour: 'Red', stock: 'out' }));
  check('Red and sold out: Alpha, matching only the Crimson', redOut.meta.total === 1 && eq((redOut.data[0] as any).matches, [aRed.id]));
  const low = await filterProducts(C, q({ stock: 'low' }));
  check('running low: Beta (2 of 2); Delta\'s 1 piece is not low (not tracked)', eq(titles(low), ['Beta Cotton Saree']), titles(low));
  const stockF = facet(all, 'stock');
  // Per product, a product counted under every state one of its colours is in. The fillers were never stocked.
  check('stock counts: in stock 3 (Alpha\'s navy, Gamma, Delta), low 1 (Beta), sold out 57 (Alpha\'s red, the one with no colours, 55 never-stocked fillers)', eq(stockF, { out: 57, in: 3, low: 1 }), stockF);

  console.log('\nD. PRICE');
  const cheap = await filterProducts(C, q({ max: '1000' }));
  check('up to ₹1,000: Alpha (Navy 900), Beta (no own price, base 1,000), Delta (500), the one with no colours (base 1,000)', eq(titles(cheap).sort(), ['Alpha Silk Saree', 'Beta Cotton Saree', 'Delta Kurti', 'Hotel No Colours']), titles(cheap));
  const bands = (all.facets as any).price.bands.map((b: any) => b.count);
  check('price bands: under 1,000 = 4, 1,000-5,000 = 57 (Beta, no-colours and 55 fillers at 2,000; Beta and no-colours at exactly 1,000 count in both), 5,000-15,000 = 1, above 15,000 = 1', eq(bands, [4, 57, 1, 1]), bands);
  check('price span ₹500 to ₹20,000', (all.facets as any).price.lo === 500 && (all.facets as any).price.hi === 20000, (all.facets as any).price);

  console.log('\nE. NOT SET, PHOTOS, TYPE, BRAND, FABRIC');
  const noFabric = await filterProducts(C, q({ fabric: NOT_SET }));
  check('fabric "Not set": Gamma, Delta and the one with no colours', eq(titles(noFabric).sort(), ['Delta Kurti', 'Gamma Lehenga', 'Hotel No Colours']), titles(noFabric));
  const pictured = await filterProducts(C, q({ photos: 'with' }));
  check('has photos: Gamma, whose only photo belongs to its colour', eq(titles(pictured), ['Gamma Lehenga']), titles(pictured));
  check('brands: Weave 2, not set 58', facet(all, 'brand').Weave === 2 && facet(all, 'brand')[NOT_SET] === 58, facet(all, 'brand'));
  const weaveSaree = await filterProducts(C, q({ brand: 'Weave', type: 'Saree' }));
  check('Weave sarees: Alpha only', eq(titles(weaveSaree), ['Alpha Silk Saree']), titles(weaveSaree));

  console.log('\nF. SEARCH');
  const by = async (text: string) => titles(await filterProducts(C, q({ q: text })));
  check('by name, any case: "gamma" finds Gamma', eq(await by('gamma'), ['Gamma Lehenga']));
  check('by colour name: "indigo" finds Beta', eq(await by('indigo'), ['Beta Cotton Saree']));
  check('by colour family: "gold" finds Gamma (Goldenrod)', (await by('gold')).includes('Gamma Lehenga'));
  check('by barcode', eq(await by(`BC${STAMP}`), ['Beta Cotton Saree']));
  // These test SKUs and codes end in a running number, so "…-3" also sits inside "…-30" to "…-39":
  // those come too, and the one typed in full comes first.
  const skuHits = await by(aRed.sku);
  check('by a whole SKU: that product first (neighbours whose SKU contains it after)', skuHits[0] === 'Alpha Silk Saree', skuHits.slice(0, 4));
  const codeHits = await by(Cp.productCode);
  check('by a whole product code: that product first', codeHits[0] === 'Gamma Lehenga', codeHits.slice(0, 4));
  check('a whole SKU wins even when the sort says otherwise (A to Z would put Alpha first anyway; Z to A is not offered, so price high to low)', titles(await filterProducts(C, q({ q: aRed.sku, sort: 'phi' })))[0] === 'Alpha Silk Saree');
  check('nothing matches: empty page, not an error', (await filterProducts(C, q({ q: 'no-such-thing-xyz' }))).meta.total === 0);

  console.log('\nG. SORT AND STATUS');
  const sorted = async (s: string) => titles(await filterProducts(C, q({ sort: s, type: 'Saree|Lehenga|Kurti' })));
  check('price low to high: Delta 500, Alpha 900, Beta 1,000, then the 2,000s', eq((await sorted('plo')).slice(0, 3), ['Delta Kurti', 'Alpha Silk Saree', 'Beta Cotton Saree']));
  check('price high to low: Gamma 20,000 first', (await sorted('phi'))[0] === 'Gamma Lehenga');
  check('most in stock: Alpha (10) first', (await sorted('qhi'))[0] === 'Alpha Silk Saree');
  check('name A to Z: Alpha first, Zulu last', (await sorted('az'))[0] === 'Alpha Silk Saree');
  check('oldest first: the January fillers first', (await sorted('old'))[0] === 'Zulu Filler 00');
  const archived = await filterProducts(C, q({ status: 'ARCHIVED' }));
  check('Archived: Echo only', eq(titles(archived), ['Echo Archived Saree']));
  const binned = await filterProducts(C, q({ status: 'TRASHED' }));
  check('Trash: Foxtrot only', eq(titles(binned), ['Foxtrot Binned Saree']));
  let bad = false; try { q({ sort: 'bogus' }); } catch { bad = true; }
  check('an unknown sort is refused, not guessed', bad);

  console.log('\nH. THE PLAIN LIST IS UNCHANGED');
  const plain = await productRepository.findManyWithFilters(C, { page: 1, limit: 20, sortBy: 'createdAt', order: 'desc' });
  check('without the Products page\'s filters: 20 per page, total 60, newest first, no counts', plain.data.length === 20 && plain.meta.total === 60 && (plain.data[0] as any).title === 'Delta Kurti' && !('facets' in plain), plain.meta);
}

main().catch(e => { failed++; console.error(e); }).finally(async () => {
  const w = { clientId: { in: [C, OTHER] } };
  await prisma.productImage.deleteMany({ where: { variant: w } }).catch(e => console.log('left images', e.message));
  await prisma.inventoryStock.deleteMany({ where: w }).catch(e => console.log('left stock', e.message));
  await prisma.productVariant.deleteMany({ where: w }).catch(e => console.log('left variants', e.message));
  await prisma.product.deleteMany({ where: w }).catch(e => console.log('left products', e.message));
  await prisma.stockLocation.deleteMany({ where: w }).catch(e => console.log('left locations', e.message));
  console.log(`\n${passed} passed, ${failed} failed`);
  await prisma.$disconnect();
  process.exit(failed ? 1 : 0);
});
