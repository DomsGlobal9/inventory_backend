/**
 * Shopify products: how one of our products is said to Shopify, and how an edit made in Shopify is
 * told from our own echo. Pure -- no database, no store -- so every awkward product can be proved.
 *
 * The real round trip against a store is verify-shopify-products-live.ts (needs a test store).
 *
 *   npx tsx src/scripts/verify-shopify-products.ts
 */
import {
  renderProduct, canonicalFromWebhook, hashCanonical, describeEdits, descriptionHtml, wordsOf, scaleezyTag
} from '../services/shopify-products';
import type { StorefrontProduct } from '../services/storefront-catalogue.service';

let passed = 0, failed = 0;
const check = (name: string, ok: boolean, detail: unknown = '') => {
  if (ok) { passed++; console.log(`  ok   ${name}`); } else { failed++; console.log(`  FAIL ${name} -- ${JSON.stringify(detail).slice(0, 400)}`); }
};

const variant = (sku: string, colour: string | null, size: string | null, price = 1500, compareAtPrice: number | null = null) => ({
  sku, variantCode: sku, barcode: null, size, colour, colourHex: null, price, compareAtPrice, currency: 'INR',
  stock: { quantity: 1, reserved: 0, available: 1, sellable: true }
});
const product = (over: Partial<StorefrontProduct> = {}): StorefrontProduct => ({
  productCode: 'PRD-000001', title: 'Kanchi silk saree', description: 'Pure silk.', category: 'WOMEN', productType: 'READY_TO_WEAR',
  dressType: 'Saree', fabric: 'Silk', craft: null, brand: 'Swathi', publishedAt: null, updatedAt: new Date().toISOString(),
  images: [], variants: [variant('A-RED-M', 'Red', 'M'), variant('A-RED-L', 'Red', 'L'), variant('A-BLUE-M', 'Blue', 'M')],
  ...over
});

console.log('\n1. AN ORDINARY PRODUCT');
let r = renderProduct(product());
check('Colour and Size options, in that order', JSON.stringify(r.options.map(o => o.name)) === '["Colour","Size"]', r.options);
check('...with each value once', JSON.stringify(r.options[0].values) === '["Red","Blue"]' && JSON.stringify(r.options[1].values) === '["M","L"]', r.options);
check('prices as Shopify money: 1500.00', r.variants.every(v => v.price === '1500.00'), r.variants);
check('tagged as ours, by product code', r.tags[0] === 'scaleezy-prd-000001', r.tags);
check('vendor from brand, type from dress type', r.vendor === 'Swathi' && r.productType === 'Saree', [r.vendor, r.productType]);

console.log('\n2. PRODUCTS THAT WOULD MAKE SHOPIFY REFUSE THE WHOLE THING');
r = renderProduct(product({ variants: [variant('ONE', null, null)] }));
check('one variant, no colour or size: Shopify\'s own "Title / Default Title"', r.options[0].name === 'Title' && r.variants[0].optionValues[0].name === 'Default Title', r.options);
r = renderProduct(product({ variants: [variant('X1', null, null), variant('X2', null, null)] }));
check('two variants nobody told apart: the item code becomes an option', r.options.map(o => o.name).includes('Item') && new Set(r.variants.map(v => v.optionValues.map(o => o.name).join('|'))).size === 2, r.variants);
r = renderProduct(product({ variants: [variant('D1', 'Red', 'M'), variant('D2', 'red', 'm')] }));
check('two with the same colour and size (any capitals): told apart by item code', r.options.map(o => o.name).join() === 'Colour,Size,Item', r.options);
r = renderProduct(product({ variants: [variant('S1', 'Red', null), variant('S2', 'Blue', 'M')] }));
check('a size missing on one variant is filled, not left blank', r.variants[0].optionValues.find(o => o.optionName === 'Size')?.name === 'One size', r.variants[0]);
r = renderProduct(product({ variants: [variant('', 'Red', 'M')] }));
check('no item code at all: refused in words, nothing sent', !!r.refusal && /item code/.test(r.refusal), r.refusal);
r = renderProduct(product({ variants: [variant('P0', 'Red', 'M', 0)] }));
check('a price of 0: refused in words', !!r.refusal && /no selling price/.test(r.refusal), r.refusal);
r = renderProduct(product({ variants: [variant('PN', 'Red', 'M', NaN)] }));
check('a price that is not a number: refused, not sent as "NaN"', !!r.refusal, r.refusal);

console.log('\n3. PRICES');
r = renderProduct(product({ variants: [variant('C1', 'Red', 'M', 1200, 1500), variant('C2', 'Red', 'L', 1200, 1000), variant('C3', 'Red', 'S', 1199.999)] }));
check('a crossed-out price above the price is kept', r.variants[0].compareAtPrice === '1500.00', r.variants[0]);
check('...one at or below the price is dropped (Shopify shows nonsense otherwise)', r.variants[1].compareAtPrice === null, r.variants[1]);
check('...prices round to paise', r.variants[2].price === '1200.00', r.variants[2]);

console.log('\n4. WORDS AND PHOTOS');
check('< > & " in a description are escaped', descriptionHtml('Silk & zari <b> "best"') === '<p>Silk &amp; zari &lt;b&gt; &quot;best&quot;</p>', descriptionHtml('Silk & zari <b> "best"'));
check('blank lines become paragraphs, single lines breaks', descriptionHtml('a\nb\n\nc') === '<p>a<br>b</p><p>c</p>', descriptionHtml('a\nb\n\nc'));
check('an empty description sends nothing', descriptionHtml('  \n ') === '', descriptionHtml('  \n '));
r = renderProduct(product({ images: [
  { url: 'http://insecure/x.jpg', isPrimary: false, position: 0, variantCode: null, kind: 'GALLERY' },
  { url: 'https://cdn/b.jpg', isPrimary: false, position: 2, variantCode: null, kind: 'GALLERY' },
  { url: 'https://cdn/a.jpg', isPrimary: true, position: 5, variantCode: null, kind: 'COVER' }
] }));
check('photos: the cover first, then by position; http links left out', JSON.stringify(r.images.map(i => i.url)) === '["https://cdn/a.jpg","https://cdn/b.jpg"]', r.images);
r = renderProduct(product({ images: Array.from({ length: 30 }, (_, i) => ({ url: `https://cdn/${i}.jpg`, isPrimary: false, position: i, variantCode: null, kind: 'GALLERY' })) }));
check('at most 20 photos are sent', r.images.length === 20, r.images.length);
check('tags survive odd product codes', scaleezyTag(' PRD 01/A ') === 'scaleezy-prd-01-a', scaleezyTag(' PRD 01/A '));

console.log('\n5. OUR OWN ECHO, AND AN EDIT MADE IN SHOPIFY');
r = renderProduct(product({ description: 'Pure silk & zari.\nDry clean.' }));
const echo = { title: r.title, body_html: '<p>Pure silk &amp; zari.<br/>\nDry clean.</p>\n', status: 'active',
  variants: r.variants.map(v => ({ sku: v.sku.toLowerCase(), price: v.price.replace('.00', '.0'), compare_at_price: null })) };
check('Shopify rewriting our HTML (<br/>, new lines) is still our echo', hashCanonical(canonicalFromWebhook(echo)) === r.hash, [canonicalFromWebhook(echo), r.hash]);
check('...as are "1500.0" for "1500.00" and SKU capitals', hashCanonical(canonicalFromWebhook(echo)) === r.hash);
const edited = { ...echo, variants: echo.variants.map((v, i) => i === 0 ? { ...v, price: '999.00' } : v) };
check('a price changed in Shopify is NOT our echo', hashCanonical(canonicalFromWebhook(edited)) !== r.hash);
const edits = describeEdits({ title: r.title, words: wordsOf(r.descriptionHtml), variants: r.variants.map(v => ({ sku: v.sku, price: v.price, compareAtPrice: v.compareAtPrice })) }, canonicalFromWebhook(edited));
check('...and the notice names it: price of A-RED-M from 1500.00 to 999.00', edits.length === 1 && /A-RED-M from ₹1500\.00 to ₹999\.00/.test(edits[0]), edits);
const retitled = { ...echo, title: 'Cheap saree' };
check('a title changed in Shopify is named', describeEdits({ title: r.title, words: wordsOf(r.descriptionHtml), variants: [] }, canonicalFromWebhook(retitled))[0]?.includes('Cheap saree'), '');
const extra = { ...echo, variants: [...echo.variants, { sku: 'THEIRS-ONLY', price: '10.00', compare_at_price: null }] };
check('a variant the shop added only in Shopify is not called an edit of ours', describeEdits({ title: r.title, words: wordsOf(r.descriptionHtml), variants: r.variants.map(v => ({ sku: v.sku, price: v.price, compareAtPrice: v.compareAtPrice })) }, canonicalFromWebhook(extra)).length === 0);
check('a webhook with no variants or body does not crash', canonicalFromWebhook({}).variants.length === 0 && canonicalFromWebhook({}).words === '');

console.log(`\nRESULT: ${passed} passed | ${failed} failed`);
process.exit(failed ? 1 : 0);
