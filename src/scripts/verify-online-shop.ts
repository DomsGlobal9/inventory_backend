/**
 * EVERY SHOP'S OWN ONLINE SHOP (PLAN-online-shop.md, Phase 1).
 *
 *   R  the address rules, on their own: what is tidied up, what is refused, what is kept back
 *   O  the owner's side: claiming an address, settings, what must exist before it opens
 *   P  the shopper's side through the running server: open, closed, unknown, the catalogue
 *   N  the banners across the top: the limit, dead taps, order, hiding, another shop's
 *   F  the nav and the filters: read from the shop's whole catalogue, not one page of it
 *   C  buying: the bag, the price, the order, the stock held, and what may never be bought
 *   X  what must never leak: cost price, another shop, a location that does not sell online
 *
 *   npx tsx src/scripts/verify-online-shop.ts      (needs the local backend running)
 *
 * Makes only throwaway shops and deletes them afterwards. Sends nothing anywhere.
 */
import axios from 'axios';
import sharp from 'sharp';
import { prisma } from '../lib/prisma';
import { AuthService } from '../services/auth.service';
import { seedRolesForClient } from '../services/rbac-seed.service';
import { platformAdminService } from '../services/platform-admin.service';
import { onlineShop, shopBanners, shopCheckout, OnlineShopRuleError, checkSlug, RESERVED_SLUGS } from '../services/online-shop';

const SERVER = (process.env.VERIFY_API_URL || 'http://localhost:4006/api/v1').replace(/\/api\/v1\/?$/, '');
const API = `${SERVER}/api/v1`;
const STAMP = Date.now();
const SHOP = `onshop-${STAMP}`;
const OTHER = `onshop-other-${STAMP}`;

let passed = 0;
const failures: string[] = [];
const check = (name: string, ok: boolean, detail: unknown = '') => {
  if (ok) { passed++; if (!process.env.QUIET) console.log(`  ok   ${name}`); }
  else {
    const text = typeof detail === 'string' ? detail : JSON.stringify(detail);
    failures.push(`${name} :: ${text}`);
    console.log(`  FAIL ${name} :: ${text}`);
  }
};
const refusal = (fn: () => unknown): string => {
  try { fn(); return ''; } catch (e) { return e instanceof OnlineShopRuleError ? e.message : `NOT A RULE ERROR: ${(e as Error).message}`; }
};
const refusalAsync = async (p: Promise<unknown>): Promise<string> => {
  try { await p; return ''; } catch (e) { return e instanceof OnlineShopRuleError ? e.message : `NOT A RULE ERROR: ${(e as Error).message}`; }
};
const http = (path: string) => axios.get(`${SERVER}${path}`, { validateStatus: () => true });

async function main() {
  const health = await axios.get(`${SERVER}/health`).catch(() => null);
  if (!health) throw new Error(`The backend is not running at ${SERVER}.`);

  // ── R ─────────────────────────────────────────────────────────────────────────────────
  console.log('\nR. THE ADDRESS RULES');
  check('a shop name becomes an address', checkSlug('Lakshmi Silks') === 'lakshmi-silks');
  check('capitals, dots and extra spaces are tidied', checkSlug('  Sree  S.P.H.L.  ') === 'sree-s-p-h-l');
  check('an apostrophe joins rather than splits', checkSlug("O'Brien Sarees") === 'obrien-sarees');
  check('hyphens are never doubled or left hanging', checkSlug('--silk--house--') === 'silk-house');
  check('an address already in shape is unchanged', checkSlug('lakshmi-silks') === 'lakshmi-silks');
  check('nothing typed is refused with a suggestion', /for example/.test(refusal(() => checkSlug(''))));
  check('too short is refused', /at least/.test(refusal(() => checkSlug('ab'))));
  check('too long is refused', /shorter/.test(refusal(() => checkSlug('a'.repeat(41)))));
  check('only digits is refused (unreadable off a poster)', /letters/.test(refusal(() => checkSlug('123456'))));
  check('one of ours is kept back', /kept by ScaleEzy/.test(refusal(() => checkSlug('admin'))));
  check('"shop" is ours but "shopping" is not', RESERVED_SLUGS.has('shop') && checkSlug('shopping') === 'shopping');
  check('emoji and other scripts cannot make an address', /letters|at least/.test(refusal(() => checkSlug('🌸🌸🌸'))));

  // ── SETUP ─────────────────────────────────────────────────────────────────────────────
  console.log(`\nSETUP ${SHOP}`);
  const roles = await seedRolesForClient(SHOP);
  await seedRolesForClient(OTHER);
  await prisma.clientSettings.create({ data: { clientId: SHOP, businessName: 'Lakshmi Silks', businessAddress: '12 Silk St', gstNumber: '36AAAAA0000A1Z5' } });
  await prisma.clientSettings.create({ data: { clientId: OTHER, businessName: 'Other Silks' } });
  const store = await prisma.stockLocation.create({ data: { clientId: SHOP, name: 'Main Store', code: 'MAIN', type: 'STORE', active: true } });
  const godown = await prisma.stockLocation.create({ data: { clientId: SHOP, name: 'Godown', code: 'GD', type: 'WAREHOUSE', active: true } });
  const theirs = await prisma.stockLocation.create({ data: { clientId: OTHER, name: 'Theirs', code: 'TH', type: 'STORE', active: true } });
  // Real pieces to browse, so search, filters and sorting are tested against a catalogue rather
  // than an empty one. Prices are far apart so "cheapest first" cannot pass by luck.
  const pieces = [
    { code: 'OS-SAREE-1', title: 'Kanchipuram Silk Saree', fabric: 'Silk',   dress: 'Saree', price: 12000, colour: 'Maroon' },
    { code: 'OS-SAREE-2', title: 'Mysore Crepe Saree',     fabric: 'Crepe',  dress: 'Saree', price: 6400,  colour: 'Green'  },
    { code: 'OS-KURTI-1', title: 'Cotton Kurti',           fabric: 'Cotton', dress: 'Kurti', price: 1450,  colour: 'Blue'   }
  ];
  for (const [i, piece] of pieces.entries()) {
    const prod = await prisma.product.create({
      data: {
        clientId: SHOP, productCode: piece.code, title: piece.title, slug: `os-${STAMP}-${i}`,
        category: 'WOMEN', productType: 'READY_TO_WEAR', basePrice: piece.price, status: 'ACTIVE',
        fabric: piece.fabric, dressType: piece.dress, publishedAt: new Date(Date.now() - i * 60_000)
      }
    });
    const v = await prisma.productVariant.create({
      data: {
        clientId: SHOP, productId: prod.id, sku: `${piece.code}-V`, variantCode: `${piece.code}-VC`,
        size: 'Free Size', colorName: piece.colour, sellingPrice: piece.price, averageCost: 1
      }
    });
    // Stock in the store that sells online, so the pieces are sellable.
    await prisma.inventoryStock.create({ data: { clientId: SHOP, variantId: v.id, locationId: store.id, quantity: 5, reservedQty: 0 } });
  }

  const u = await prisma.user.create({ data: { clientId: SHOP, email: `owner-${SHOP}@example.com`, name: 'Owner', password: 'unused', status: 'ACTIVE' } });
  await prisma.userRole.create({ data: { userId: u.id, roleId: roles.SUPER_ADMIN } });
  const own = axios.create({
    baseURL: API,
    headers: { Authorization: `Bearer ${AuthService.generateToken({ userId: u.id, clientId: SHOP })}` },
    validateStatus: () => true
  });

  // ── O ─────────────────────────────────────────────────────────────────────────────────
  console.log('\nO. THE OWNER SETTING IT UP');
  const first = await own.get('/online-shop');
  check('a shop with no online shop yet still gets a screen', first.status === 200 && first.data.data.slug === null, first.data);
  check('...and is told what it needs before it can open', (first.data.data.missingBeforeLive ?? []).length >= 1, first.data.data.missingBeforeLive);

  const claimed = await own.post('/online-shop/address', { slug: 'Lakshmi Silks' });
  check('claiming an address tidies it up', claimed.status === 200 && claimed.data.data.slug === 'lakshmi-silks', claimed.data);
  check('it is not open merely by being claimed', claimed.data.data.isLive === false);

  const tooSoon = await own.post('/online-shop/open', {});
  check('it cannot open before a store is chosen', tooSoon.status === 400 && /store/i.test(tooSoon.data.message), tooSoon.data);

  const notMine = await own.patch('/online-shop', { locationIds: [theirs.id] });
  check("another shop's store cannot be chosen", notMine.status === 400 && /not yours/i.test(notMine.data.message), notMine.data);

  const saved = await own.patch('/online-shop', { locationIds: [store.id], displayName: 'Lakshmi Silks Online', accent: '#8b1a2b', hideOutOfStock: true });
  check('the shop keeps its settings', saved.status === 200 && saved.data.data.locationIds.length === 1 && saved.data.data.accent === '#8b1a2b', saved.data);
  check('a colour that is not a colour is ignored, not saved',
    (await own.patch('/online-shop', { accent: 'red' })).data.data.accent === '#8b1a2b');

  const opened = await own.post('/online-shop/open', {});
  check('now it opens', opened.status === 200 && opened.data.data.isLive === true, opened.data);

  const moved = await own.post('/online-shop/address', { slug: 'different-name' });
  check('an open shop cannot change its address (posters and messages already have it)',
    moved.status === 400 && /already open/i.test(moved.data.message), moved.data);

  // ── P ─────────────────────────────────────────────────────────────────────────────────
  console.log('\nP. WHAT A SHOPPER GETS');
  const open = await http('/shop/lakshmi-silks');
  check('the shop answers at its address', open.status === 200 && open.data.data.name === 'Lakshmi Silks Online', open.data);
  check("the seller's own details are there (Consumer Protection Rules)",
    open.data.data.seller?.gstNumber === '36AAAAA0000A1Z5' && !!open.data.data.seller?.address, open.data.data.seller);
  check('the shop id is never sent to a shopper', !('clientId' in (open.data.data ?? {})) && !('locationIds' in (open.data.data ?? {})), Object.keys(open.data.data ?? {}));
  check('nothing is cached by a shared cache', /no-store/.test(String(open.headers['cache-control'])), open.headers['cache-control']);

  const unknown = await http('/shop/nobody-has-this');
  check('an address nobody has says so, and nothing else', unknown.status === 404 && unknown.data.state === 'UNKNOWN', unknown.data);

  await own.post('/online-shop/close', {});
  const closed = await http('/shop/lakshmi-silks');
  check('a closed shop says it is closed, not that it never existed', closed.status === 503 && closed.data.state === 'CLOSED', closed.data);
  check('...and names the shop, so a saved link is not a mystery', /Lakshmi Silks Online/.test(String(closed.data.message)), closed.data.message);
  const closedList = await http('/shop/lakshmi-silks/products');
  check('a closed shop shows no catalogue', closedList.status === 503, closedList.status);
  await own.post('/online-shop/open', {});

  const list = await http('/shop/lakshmi-silks/products');
  check('the catalogue answers', list.status === 200 && Array.isArray(list.data.data.products), list.data);

  console.log('\nB. BROWSING THE CATALOGUE');
  const all = await http('/shop/lakshmi-silks/products');
  check('every piece is offered', all.data.data.total === 3, all.data.data);
  check('newest first by default', all.data.data.products[0]?.title === 'Kanchipuram Silk Saree', all.data.data.products.map((p: any) => p.title));

  const cheapest = await http('/shop/lakshmi-silks/products?sort=PRICE_LOW');
  check('cheapest first when asked', cheapest.data.data.products[0]?.title === 'Cotton Kurti', cheapest.data.data.products.map((p: any) => p.title));
  const dearest = await http('/shop/lakshmi-silks/products?sort=PRICE_HIGH');
  check('dearest first when asked', dearest.data.data.products[0]?.title === 'Kanchipuram Silk Saree');
  check('a sort nobody offers falls back, it does not break',
    (await http('/shop/lakshmi-silks/products?sort=CHEAPEST_PLEASE')).status === 200);

  const searched = await http('/shop/lakshmi-silks/products?q=kanchipuram');
  check('searching by name finds it', searched.data.data.total === 1 && searched.data.data.products[0].title === 'Kanchipuram Silk Saree', searched.data.data);
  check('searching does not care about capitals', (await http('/shop/lakshmi-silks/products?q=KANCHIPURAM')).data.data.total === 1);
  check('searching by fabric works', (await http('/shop/lakshmi-silks/products?q=cotton')).data.data.total === 1);
  check('searching by colour works (it is on the variant, not the product)',
    (await http('/shop/lakshmi-silks/products?q=maroon')).data.data.total === 1);
  check('a search that matches nothing says so, plainly',
    (await http('/shop/lakshmi-silks/products?q=zzzznothing')).data.data.total === 0);

  check('filtering by fabric works', (await http('/shop/lakshmi-silks/products?fabric=Silk')).data.data.total === 1);
  check('filtering by what it is works', (await http('/shop/lakshmi-silks/products?dressType=Saree')).data.data.total === 2);
  const priced = await http('/shop/lakshmi-silks/products?minPrice=2000&maxPrice=7000');
  check('filtering by price works', priced.data.data.total === 1 && priced.data.data.products[0].title === 'Mysore Crepe Saree', priced.data.data);

  const paged = await http('/shop/lakshmi-silks/products?limit=2&page=1');
  check('a page holds what was asked for, and says there is more', paged.data.data.products.length === 2 && paged.data.data.hasMore === true, paged.data.data);
  const page2 = await http('/shop/lakshmi-silks/products?limit=2&page=2');
  check('the second page holds the rest and says so', page2.data.data.products.length === 1 && page2.data.data.hasMore === false, page2.data.data);
  check('a page past the end is empty, not an error', (await http('/shop/lakshmi-silks/products?limit=2&page=99')).data.data.products.length === 0);

  const one = await http('/shop/lakshmi-silks/products/OS-KURTI-1');
  check('one product answers at its own address', one.status === 200 && one.data.data.title === 'Cotton Kurti', one.data);
  check('a product nobody has says so', (await http('/shop/lakshmi-silks/products/NO-SUCH-THING')).status === 404);


  // ── N ─────────────────────────────────────────────────────────────────────────────────
  // The banners across the top of the shop. A real JPEG is made here rather than kept as a
  // fixture, so the whole path runs: shrink, strip, upload, row, and what a shopper is given.
  console.log('\nN. THE BANNERS ACROSS THE TOP');
  const picture = async (w = 1400, h = 800) =>
    'data:image/jpeg;base64,' + (await sharp({ create: { width: w, height: h, channels: 3, background: '#8b1a2b' } })
      .jpeg().toBuffer()).toString('base64');
  const jpeg = await picture();

  const noPic = await own.post('/online-shop/banners', { heading: 'Nothing to show' });
  check('a banner with no picture is refused', noPic.status === 400 && /picture/i.test(noPic.data.message), noPic.data);

  const b1 = await own.post('/online-shop/banners', { base64: jpeg, heading: 'Festival collection', subtext: 'New silks just in' });
  check('a banner is added', b1.status === 200 && b1.data.data.length === 1, b1.data);
  check('...and its words are kept', b1.data.data[0]?.heading === 'Festival collection' && b1.data.data[0]?.subtext === 'New silks just in', b1.data.data[0]);
  check('...and it is shown unless the shop hides it', b1.data.data[0]?.active === true, b1.data.data[0]);
  check('the picture is shrunk to what a phone can load',
    b1.data.data[0]?.width <= 2000 && b1.data.data[0]?.width > 0, b1.data.data[0]);

  const emptySearch = await own.post('/online-shop/banners', { base64: jpeg, linkKind: 'SEARCH', linkValue: '   ' });
  check('a banner that searches for nothing is refused (it would be a dead tap)',
    emptySearch.status === 400 && /search for/i.test(emptySearch.data.message), emptySearch.data);

  const badCode = await own.post('/online-shop/banners', { base64: jpeg, linkKind: 'PRODUCT', linkValue: 'NO-SUCH-CODE' });
  check('a banner pointing at a product nobody has is refused',
    badCode.status === 400 && /NO-SUCH-CODE/.test(badCode.data.message), badCode.data);

  const nonsenseKind = await own.post('/online-shop/banners', { base64: jpeg, linkKind: 'ANYWHERE', linkValue: 'x' });
  check('a banner cannot go somewhere we do not offer', nonsenseKind.status === 400, nonsenseKind.data);

  const b2 = await own.post('/online-shop/banners', { base64: jpeg, heading: 'Silk sarees', linkKind: 'SEARCH', linkValue: 'silk' });
  check('a banner can point at a search', b2.status === 200 && b2.data.data.length === 2, b2.data);
  const b3 = await own.post('/online-shop/banners', { base64: jpeg, heading: 'This kurti', linkKind: 'PRODUCT', linkValue: 'OS-KURTI-1' });
  check('a banner can point at one real product', b3.status === 200 && b3.data.data.length === 3, b3.data);

  const ids = b3.data.data.map((b: any) => b.id);
  check('banners come back in the order they were added', b3.data.data[0]?.heading === 'Festival collection', b3.data.data.map((b: any) => b.heading));

  const reordered = await own.patch('/online-shop/banners/order', { ids: [ids[2], ids[0], ids[1]] });
  check('the shop can change the order', reordered.status === 200 && reordered.data.data[0]?.id === ids[2], reordered.data.data.map((b: any) => b.heading));
  const shortOrder = await own.patch('/online-shop/banners/order', { ids: [ids[0]] });
  check('a partial order is refused, not half-applied', shortOrder.status === 400, shortOrder.data);
  const foreignOrder = await own.patch('/online-shop/banners/order', { ids: [ids[0], ids[1], 'not-a-banner-of-mine'] });
  check("an order carrying somebody else's banner is refused", foreignOrder.status === 400, foreignOrder.data);

  // What the shopper is actually given.
  const withBanners = await http('/shop/lakshmi-silks');
  const shown = withBanners.data.data.banners ?? [];
  check('the shopper gets the banners, in the shop\'s order', shown.length === 3 && shown[0]?.heading === 'This kurti', shown.map((b: any) => b.heading));
  check('a banner that goes nowhere says so plainly', shown.some((b: any) => b.link === null), shown.map((b: any) => b.link));
  check('a banner that searches carries the words, not an id',
    shown.some((b: any) => b.link?.kind === 'SEARCH' && b.link?.value === 'silk'), shown.map((b: any) => b.link));
  check('the banner rows\' own ids are never sent to a shopper',
    !JSON.stringify(shown).includes(ids[0]), Object.keys(shown[0] ?? {}));
  check('the shape is sent with the picture, so the page does not jump',
    shown.every((b: any) => b.width > 0 && b.height > 0), shown[0]);

  const hidden = await own.patch(`/online-shop/banners/${ids[1]}`, { active: false });
  check('a banner can be hidden without deleting it', hidden.status === 200 && hidden.data.data.find((b: any) => b.id === ids[1])?.active === false, hidden.data);
  check('...and a hidden banner does not reach a shopper',
    ((await http('/shop/lakshmi-silks')).data.data.banners ?? []).length === 2);
  await own.patch(`/online-shop/banners/${ids[1]}`, { active: true });

  // ids[1] is the one that searches for "silk". Editing its heading alone must not quietly turn
  // it into a banner that goes nowhere -- that was the easy mistake in the update.
  const worded = await own.patch(`/online-shop/banners/${ids[1]}`, { heading: 'Deepavali offers' });
  const after = worded.data.data.find((b: any) => b.id === ids[1]);
  check('changing only the words leaves where it goes alone',
    after?.heading === 'Deepavali offers' && after?.linkKind === 'SEARCH' && after?.linkValue === 'silk', after);

  // The limit. Three exist; three more fill it, and the seventh is refused.
  for (let i = 0; i < 3; i++) await own.post('/online-shop/banners', { base64: jpeg, heading: `Filler ${i}` });
  const seventh = await own.post('/online-shop/banners', { base64: jpeg, heading: 'One too many' });
  check('a shop can have six banners and no more', seventh.status === 400 && /six|6/i.test(seventh.data.message), seventh.data);

  // Another shop's banners are none of this shop's business.
  const theirBanner = await refusalAsync(shopBanners.edit(OTHER, ids[0], { heading: 'Mine now' }));
  check("one shop cannot edit another shop's banner", /not there any more/i.test(theirBanner), theirBanner);
  const theirRemove = await refusalAsync(shopBanners.remove(OTHER, ids[0]));
  check("one shop cannot remove another shop's banner", /not there any more/i.test(theirRemove), theirRemove);
  check("...and the banner is still there", (await own.get('/online-shop/banners')).data.data.some((b: any) => b.id === ids[0]));

  const gone = await own.delete(`/online-shop/banners/${ids[0]}`);
  check('a banner can be removed', gone.status === 200 && !gone.data.data.some((b: any) => b.id === ids[0]), gone.data);
  const goneTwice = await own.delete(`/online-shop/banners/${ids[0]}`);
  check('removing it twice says so rather than breaking', goneTwice.status === 400, goneTwice.data);

  const noLoginBanners = await axios.get(`${API}/online-shop/banners`, { validateStatus: () => true });
  check('banners need a login too', noLoginBanners.status === 401, noLoginBanners.status);


  // ── F ─────────────────────────────────────────────────────────────────────────────────
  console.log('\nF. WHAT THIS SHOP SELLS (the nav and the filters)');
  const withFacets = await http('/shop/lakshmi-silks');
  const facets = withFacets.data.data.facets;
  check('the shop says what it sells, from its whole catalogue', facets?.total === 3, facets);
  check('...its categories, for the nav', facets.categories?.[0]?.value === 'WOMEN' && facets.categories[0].label === 'Women', facets.categories);
  check('...what kinds of thing, most-stocked first', facets.dressTypes?.[0]?.value === 'Saree' && facets.dressTypes[0].count === 2, facets.dressTypes);
  check('...every fabric it stocks, not just the ones on page one',
    facets.fabrics?.length === 3 && facets.fabrics.every((f: any) => f.count >= 1), facets.fabrics);
  check('...and the range its prices really run over',
    facets.price?.min <= 1400 && facets.price?.max >= 12000, facets.price);
  check('a shop is never asked to name its own categories', !JSON.stringify(facets).includes('undefined'));

  // ── C ─────────────────────────────────────────────────────────────────────────────────
  console.log('\nC. BUYING');
  const post = (path: string, body: unknown) =>
    axios.post(`${SERVER}${path}`, body, { validateStatus: () => true, headers: { 'Content-Type': 'application/json' } });

  const codeOf = async (productCode: string) => {
    const one = await http(`/shop/lakshmi-silks/products/${productCode}`);
    return one.data.data.variants[0].variantCode as string;
  };
  const sareeCode = await codeOf('OS-SAREE-1');
  const kurtiCode = await codeOf('OS-KURTI-1');

  // A shop that has not switched ordering on is a shop that only shows and tells.
  const tooEarly = await post('/shop/lakshmi-silks/bag', { lines: [{ variantCode: sareeCode, quantity: 1 }] });
  check('a shop that has not opened ordering takes no orders', tooEarly.status === 400, tooEarly.data);
  check("...and says so in a way a shopper can act on", /not taking orders/i.test(String(tooEarly.data.message)), tooEarly.data.message);

  const noWay = await own.patch('/online-shop', { acceptsOrders: true, payOnDelivery: false, payOnline: false });
  check('ordering cannot be switched on with no way to pay', noWay.status === 400 && /way customers can pay/i.test(noWay.data.message), noWay.data);

  const terms = await own.patch('/online-shop', {
    acceptsOrders: true, payOnDelivery: true, deliveryFee: 79, freeDeliveryAbove: 50000, minOrderValue: 2000
  });
  check('the shop opens for orders on its own terms', terms.status === 200 && terms.data.data.acceptsOrders === true
    && terms.data.data.deliveryFee === 79 && terms.data.data.minOrderValue === 2000, terms.data.data);
  check('...and the shopper is told those terms', (await http('/shop/lakshmi-silks')).data.data.buying?.open === true);

  const noLines = await post('/shop/lakshmi-silks/bag', { lines: [] });
  check('an empty bag is refused kindly', noLines.status === 400 && /nothing in your bag/i.test(noLines.data.message), noLines.data);

  const bag = await post('/shop/lakshmi-silks/bag', { lines: [{ variantCode: sareeCode, quantity: 1 }] });
  check('a bag is priced', bag.status === 200 && bag.data.data.goods === 12000, bag.data.data);
  check('...at the shop\'s own price, not one the browser sent', bag.data.data.lines[0].unitPrice === 12000, bag.data.data.lines);
  check('...with the shop\'s own delivery charge', bag.data.data.delivery === 79, bag.data.data);
  check('...and the shape of it: pieces, saving, delivery, to pay',
    bag.data.data.total === 12079, bag.data.data);
  check('the bag carries the colour the shop recorded, for the swatch',
    bag.data.data.lines[0].colour === 'Maroon', bag.data.data.lines[0]);

  const twoOfOne = await post('/shop/lakshmi-silks/bag', {
    lines: [{ variantCode: sareeCode, quantity: 1 }, { variantCode: sareeCode, quantity: 2 }]
  });
  check('the same piece twice is three of it, not a refusal',
    twoOfOne.status === 200 && twoOfOne.data.data.lines.length === 1 && twoOfOne.data.data.lines[0].quantity === 3, twoOfOne.data.data);

  const tooMany = await post('/shop/lakshmi-silks/bag', { lines: [{ variantCode: sareeCode, quantity: 999 }] });
  check('a bag cannot ask for more than a person buys', tooMany.status === 400 || tooMany.data.data.lines[0].quantity <= 10, tooMany.data);

  const nonsense = await post('/shop/lakshmi-silks/bag', { lines: [{ variantCode: 'NOT-A-PIECE', quantity: 1 }] });
  check('something not in this shop is refused', nonsense.status === 400 && /no longer in this shop/i.test(nonsense.data.message), nonsense.data);

  // Ordering itself.
  const key = () => `verify-${STAMP}-${Math.random().toString(36).slice(2)}aaaaaaaaaa`;
  const details = {
    name: 'Anita Rao', phone: '9989000111',
    address: '3-6-218 Flat 402, Himayatnagar, Hyderabad, Telangana 500029',
    payWay: 'ON_DELIVERY'
  };

  const tooSmall = await post('/shop/lakshmi-silks/orders', {
    ...details, placementKey: key(), lines: [{ variantCode: kurtiCode, quantity: 1 }]
  });
  check('an order below what the shop will send is refused, with the figure',
    tooSmall.status === 400 && /2000/.test(String(tooSmall.data.message)), tooSmall.data);

  const noName = await post('/shop/lakshmi-silks/orders', {
    ...details, name: '', placementKey: key(), lines: [{ variantCode: sareeCode, quantity: 1 }]
  });
  check('an order with no name is refused', noName.status === 400 && /your name/i.test(noName.data.message), noName.data);

  const badPhone = await post('/shop/lakshmi-silks/orders', {
    ...details, phone: '123', placementKey: key(), lines: [{ variantCode: sareeCode, quantity: 1 }]
  });
  check('an order with a number nobody could ring is refused', badPhone.status === 400 && /phone/i.test(badPhone.data.message), badPhone.data);

  const noAddress = await post('/shop/lakshmi-silks/orders', {
    ...details, address: 'x', placementKey: key(), lines: [{ variantCode: sareeCode, quantity: 1 }]
  });
  check('an order with no real address is refused', noAddress.status === 400 && /address/i.test(noAddress.data.message), noAddress.data);

  const badWay = await post('/shop/lakshmi-silks/orders', {
    ...details, payWay: 'BITCOIN', placementKey: key(), lines: [{ variantCode: sareeCode, quantity: 1 }]
  });
  check('an order cannot invent a way to pay the shop does not take', badWay.status === 400, badWay.data);

  const thisKey = key();
  const order = await post('/shop/lakshmi-silks/orders', {
    ...details, placementKey: thisKey, lines: [{ variantCode: sareeCode, quantity: 1 }]
  });
  check('an order is placed', order.status === 200 && /^SO-/.test(String(order.data.data.orderNumber)), order.data);
  check('...and the customer is told what it came to', order.data.data.total === 12079, order.data.data);
  check('...and where it is going', /Himayatnagar/.test(String(order.data.data.address)), order.data.data.address);
  check('...and that it is not paid yet', order.data.data.paid === false && order.data.data.payWay === 'ON_DELIVERY');

  const token = order.data.data.token as string;
  check('the link to the order is a secret, not a number to count from', token.length >= 30, token.length);

  // The order really is an inventory order, on the ONLINE channel, holding real stock.
  const written = await prisma.salesOrder.findFirst({
    where: { clientId: SHOP, externalOrderId: thisKey },
    select: {
      orderNumber: true, channel: true, status: true, sourceSystem: true, locationId: true,
      total: true, shippingAmount: true, customerPhone: true,
      items: { select: { quantity: true, variantId: true } }
    }
  });
  check('the order is an ordinary inventory order', written?.channel === 'ONLINE' && written?.status === 'CONFIRMED', written);
  check('...from this shop', written?.sourceSystem === 'SCALEEZY_SHOP');
  check('...sold from the store the shop chose to sell online', written?.locationId === store.id, written?.locationId);
  check('...with the delivery charge on it', Number(written?.shippingAmount) === 79, written?.shippingAmount);
  check('...and the customer\'s number on it, for the shop to ring',
    String(written?.customerPhone ?? '').includes('9989000111'), written?.customerPhone);

  const held = await prisma.inventoryStock.findFirst({
    where: { clientId: SHOP, locationId: store.id, variantId: written!.items[0].variantId },
    select: { quantity: true, reservedQty: true }
  });
  check('the stock is really held for this customer', held?.reservedQty === 1, held);

  // The same order twice.
  const again = await post('/shop/lakshmi-silks/orders', {
    ...details, placementKey: thisKey, lines: [{ variantCode: sareeCode, quantity: 1 }]
  });
  check('pressing order twice makes one order, not two',
    again.status === 200 && again.data.data.orderNumber === order.data.data.orderNumber, again.data.data);
  const howMany = await prisma.salesOrder.count({ where: { clientId: SHOP, externalOrderId: thisKey } });
  check('...and there is exactly one order in the books', howMany === 1, howMany);
  const stillHeld = await prisma.inventoryStock.findFirst({
    where: { clientId: SHOP, locationId: store.id, variantId: written!.items[0].variantId },
    select: { reservedQty: true }
  });
  check('...and the stock was held once, not twice', stillHeld?.reservedQty === 1, stillHeld);

  // The customer's own order, and nobody else's.
  const mine = await http(`/shop/lakshmi-silks/orders/${token}`);
  check('the customer can see their own order', mine.status === 200 && mine.data.data.orderNumber === order.data.data.orderNumber);
  const guessed = await http('/shop/lakshmi-silks/orders/not-a-real-token-at-all-aaaaaaa');
  check('a guessed link shows nothing', guessed.status === 400 || guessed.status === 404, guessed.status);
  // Straight at the service, because there is only one live shop here and the point is the scope:
  // a token is looked up on its own and then checked against the shop asking for it.
  const theirRead = await refusalAsync(shopCheckout.summary(OTHER, token));
  check("one shop cannot read another shop's order, even holding the link",
    /could not be found/i.test(theirRead), theirRead);

  const orderBody = JSON.stringify(mine.data);
  for (const word of ['costPrice', 'averageCost', 'clientId', 'locationId', 'variantId']) {
    check(`an order never carries ${word}`, !orderBody.includes(word));
  }

  // What cannot be bought.
  await own.patch('/online-shop', { acceptsOrders: false });
  const shut = await post('/shop/lakshmi-silks/orders', {
    ...details, placementKey: key(), lines: [{ variantCode: sareeCode, quantity: 1 }]
  });
  check('a shop that stops taking orders stops taking orders', shut.status === 400, shut.data);
  await own.patch('/online-shop', { acceptsOrders: true });

  // ── X ─────────────────────────────────────────────────────────────────────────────────
  console.log('\nX. WHAT MUST NEVER LEAK');
  const body = JSON.stringify(list.data);
  for (const word of ['costPrice', 'averageCost', 'lastPurchaseCost', 'supplier', 'reorderLevel']) {
    check(`the catalogue never carries ${word}`, !body.includes(word));
  }
  check('a shopper is told whether they can buy, never how many are left',
    !/"quantity"|"reserved"|"available"/.test(body));
  check('the godown is not offered: only the chosen store sells online',
    (await prisma.onlineShop.findUniqueOrThrow({ where: { clientId: SHOP } })).locationIds.join() === store.id,
    godown.id);

  // Another shop cannot take this address, now or ever.
  const theirClaim = await refusalAsync(onlineShop.chooseSlug(OTHER, 'lakshmi-silks'));
  check('another shop cannot claim an address in use', /already has|has used/i.test(theirClaim), theirClaim);
  await own.post('/online-shop/close', {});
  const afterClose = await refusalAsync(onlineShop.chooseSlug(OTHER, 'lakshmi-silks'));
  check('...nor after it is closed: a printed QR code outlives the shop', /has used/i.test(afterClose), afterClose);

  const noPermission = await axios.get(`${API}/online-shop`, { validateStatus: () => true });
  check('the owner screen needs a login', noPermission.status === 401, noPermission.status);
}

main()
  .catch(e => { failures.push(`suite stopped: ${(e as Error).stack ?? e}`); console.log(`\nSTOPPED: ${(e as Error).message}`); })
  .finally(async () => {
    // The banner pictures are files in storage, which deleting the client does not touch.
    for (const c of [SHOP, OTHER]) {
      for (const b of await shopBanners.listFor(c).catch(() => [])) {
        await shopBanners.remove(c, b.id).catch(() => {});
      }
    }
    for (const c of [SHOP, OTHER]) await platformAdminService.deleteClientCompletely(c, c).catch(() => {});
    await prisma.onlineShopSlugHistory.deleteMany({ where: { clientId: { in: [SHOP, OTHER] } } }).catch(() => {});
    console.log(`\nRESULT: ${passed} passed | ${failures.length} failed`);
    if (failures.length) console.log(failures.map(f => `  - ${f}`).join('\n'));
    await prisma.$disconnect();
    process.exit(failures.length ? 1 : 0);
  });
