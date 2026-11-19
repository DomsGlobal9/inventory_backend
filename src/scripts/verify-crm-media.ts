/**
 * Pictures and the other things ScaleEzy CRM reads from Inventory for its messages (rewritten 19 Nov 2026, once
 * CRM prepared and stored its pictures itself). Real signed service tokens against the real routes, a throwaway
 * shop with CRM on (and one without), removed at the end:
 *   1. who may read the product photos: the modules:crm scope, a shop with CRM on, the token's own shop, a named
 *      ACTIVE person who may send messages (campaign:send or crm:messages:send);
 *   2. Inventory's old picture-making routes for CRM are GONE: POST campaign-media and campaign-media/from-product
 *      answer 404 to everybody, and store nothing;
 *   3. the picture preparation Inventory still uses for its own pictures (lib/imagePrep, via prepareImage): a
 *      big photo made WhatsApp-ready, a decompression bomb, an SVG with a script, a moving GIF, an iPhone HEIC,
 *      an AVIF, empty, not a picture, exactly 15 MB and one byte over;
 *   4. the product photos CRM chooses from (names and photos only; search taken literally) and one checked
 *      photo by id (this shop's, not archived or binned, in our storage, capitals the same id);
 *   5. housekeeping: a picture marked CRM is never removed, an unused Inventory upload still is;
 *   6. the rest CRM reads: the shop's pictures, its old wish settings, points with this year's birthday gift and
 *      the shop's gift, and GET/PUT moved with no campaigns or wishes in it any more.
 *
 *   DATABASE_URL=<local> DIRECT_URL=<local> VERIFY_API_URL=http://localhost:4036/api/v1 \
 *   CRM_KEY_DIR=<dir with private.pem> npx tsx src/scripts/verify-crm-media.ts
 */
import axios from 'axios';
import fs from 'node:fs';
import jwt from 'jsonwebtoken';
import sharp from 'sharp';
import zlib from 'node:zlib';
import { prisma } from '../lib/prisma';
import { AuthService } from '../services/auth.service';
import { seedRolesForClient } from '../services/rbac-seed.service';
import { platformAdminService } from '../services/platform-admin.service';
import { purgeUnusedCampaignMedia } from '../services/campaigns';
import { UNUSED_RETENTION_MS, prepareImage } from '../services/campaigns/media';
import { localDayKey } from '../utils/businessDay';
import { giveBirthdayPoints } from '../services/loyalty';

const BASE = process.env.VERIFY_API_URL || 'http://localhost:4036/api/v1';
const STAMP = Date.now();
const SHOP = `crmmedia-${STAMP}`;
const OTHER = `crmmedia-other-${STAMP}`;
for (const k of ['DATABASE_URL', 'DIRECT_URL']) {
  if (!/localhost:55433/.test(process.env[k] ?? '')) { console.error(`Refusing: ${k} is not the local database.`); process.exit(2); }
}
if (!/localhost|127\.0\.0\.1/.test(BASE)) { console.error('Refusing: VERIFY_API_URL is not a local server.'); process.exit(2); }

let passed = 0;
const failures: string[] = [];
const check = (name: string, ok: boolean, detail: unknown = '') => {
  if (ok) { passed++; console.log(`  ok   ${name}`); }
  else { failures.push(name); console.log(`  FAIL ${name} :: ${typeof detail === 'string' ? detail : JSON.stringify(detail)?.slice(0, 400)}`); }
};
const brief = (r: any) => `${r?.status} ${JSON.stringify(r?.data).slice(0, 300)}`;
const call = (method: string, path: string, headers: Record<string, string> = {}, data?: any) =>
  axios.request({ method, url: `${BASE}${path}`, headers, data, validateStatus: () => true, timeout: 120_000, maxBodyLength: Infinity, maxContentLength: Infinity });
const throws = async (fn: () => unknown) => { try { await fn(); return null; } catch (e: any) { return e; } };

const privateKey = fs.readFileSync(`${process.env.CRM_KEY_DIR}/private.pem`, 'utf8');
const tokenFor = (claims: { clientId?: string; userId?: string; scope?: string[] } = {}) => ({
  Authorization: `Bearer ${jwt.sign({
    sub: 'scaleezy-crm-test', scope: claims.scope ?? ['modules:crm'],
    ...(claims.clientId ? { clientId: claims.clientId } : {}),
    ...(claims.userId ? { onBehalfOf: { userId: claims.userId } } : {})
  }, privateKey, { algorithm: 'RS256', audience: 'inventory', issuer: 'scaleezy-crm-test', keyid: 'test-1', expiresIn: '5m' })}`
});
const crm = (path: string, shop = SHOP) => `/internal/modules/crm/shops/${shop}${path}`;

// A real "decompression bomb": a 48 KB PNG that would unpack to 20,000 x 20,000 pixels (400 megapixels).
const crc = (buf: Buffer) => { let c = ~0; for (const b of buf) { c ^= b; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)); } return (~c) >>> 0; };
const pngChunk = (type: string, data: Buffer) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(body));
  return Buffer.concat([len, body, c]);
};
function bombPng(side = 20000) {
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(side, 0); ihdr.writeUInt32BE(side, 4); ihdr[8] = 1; ihdr[9] = 0;
  const idat = zlib.deflateSync(Buffer.alloc((Math.ceil(side / 8) + 1) * side), { level: 9 });
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), pngChunk('IHDR', ihdr), pngChunk('IDAT', idat), pngChunk('IEND', Buffer.alloc(0))]);
}

async function main() {
  console.log(`SETUP ${SHOP}`);
  const roles = await seedRolesForClient(SHOP);
  const rolesB = await seedRolesForClient(OTHER);
  await prisma.clientSettings.create({ data: { clientId: SHOP, businessName: 'Media Silks', timezone: 'Asia/Kolkata' } as any });
  const hash = await AuthService.hashPassword('Same-Pass-123');
  const mkUser = async (clientId: string, name: string, roleId: string, status = 'ACTIVE') => {
    const u = await prisma.user.create({ data: { clientId, email: `${name.toLowerCase().replace(/\s/g, '')}-${STAMP}@example.com`, name, password: hash, status: status as any } });
    await prisma.userRole.create({ data: { userId: u.id, roleId } });
    return u;
  };
  const owner = await mkUser(SHOP, 'Owner Asha', roles.SUPER_ADMIN);
  const store = await mkUser(SHOP, 'Store Gopal', roles.WAREHOUSE);
  const gone = await mkUser(SHOP, 'Left Kiran', roles.SUPER_ADMIN, 'INACTIVE');
  const theirs = await mkUser(OTHER, 'Owner B', rolesB.SUPER_ADMIN);
  const as = (u: { id: string }, shop = SHOP) => tokenFor({ clientId: shop, userId: u.id });
  const on = await call('PUT', `/internal/modules/crm/shops/${SHOP}`, tokenFor());
  check('CRM switches the shop on', on.status === 200, brief(on));

  // The shop's products: one with a photo in our storage, one with none.
  const ourPhoto = `${process.env.LOCAL_STORAGE_URL ?? 'http://127.0.0.1:9'}/storage/v1/object/public/inventory-images/test/${STAMP}.jpg`;
  const product = await prisma.product.create({ data: { clientId: SHOP, productCode: `CM-${STAMP}`, slug: `cm-${STAMP}`, title: 'Kanchi silk saree', category: 'WOMEN' as any, productType: 'READY_TO_WEAR' as any, basePrice: 9000, status: 'ACTIVE' as any } as any });
  const image = await prisma.productImage.create({ data: { productId: product.id, url: ourPhoto, imageType: 'GALLERY' as any, orderIndex: 0, isPrimary: true } as any });
  await prisma.product.create({ data: { clientId: SHOP, productCode: `CM2-${STAMP}`, slug: `cm2-${STAMP}`, title: 'No photo yet', category: 'WOMEN' as any, productType: 'READY_TO_WEAR' as any, basePrice: 100, status: 'ACTIVE' as any } as any });
  const otherProduct = await prisma.product.create({ data: { clientId: OTHER, productCode: `OT-${STAMP}`, slug: `ot-${STAMP}`, title: 'Theirs', category: 'WOMEN' as any, productType: 'READY_TO_WEAR' as any, basePrice: 1, status: 'ACTIVE' as any } as any });
  const otherImage = await prisma.productImage.create({ data: { productId: otherProduct.id, url: ourPhoto, imageType: 'GALLERY' as any, orderIndex: 0, isPrimary: true } as any });

  console.log('\n1. WHO MAY READ THE PRODUCT PHOTOS');
  let r = await call('GET', crm('/product-photos'), tokenFor({ scope: ['session:read'] }));
  check('a token without modules:crm: refused', r.status === 403 && /modules:crm/.test(r.data?.message), brief(r));
  r = await call('GET', crm('/product-photos', OTHER), as(theirs, OTHER));
  check('a shop that has not switched CRM on: 404 in words', r.status === 404 && r.data?.message === 'This shop has not switched CRM on.', brief(r));
  r = await call('GET', crm('/product-photos'), as(theirs, OTHER));
  check('a token for another shop: refused', r.status === 403 && /another shop/.test(r.data?.message), brief(r));
  r = await call('GET', crm('/product-photos'), tokenFor());
  check('nobody named: refused', r.status === 403 && /Say who this is for/.test(r.data?.message), brief(r));
  r = await call('GET', crm('/product-photos'), as(store));
  check('a storekeeper (may not send messages): refused, naming both permissions', r.status === 403 && r.data?.message === 'That person may not do this in Inventory (needs campaign:send or crm:messages:send).', brief(r));
  r = await call('GET', crm('/product-photos'), as(gone));
  check('a person whose account is switched off: refused', r.status === 403 && /switched off/.test(r.data?.message), brief(r));

  console.log('\n2. THE OLD PICTURE-MAKING ROUTES ARE GONE (CRM makes its own pictures since 19 Nov)');
  const small = await sharp({ create: { width: 400, height: 300, channels: 3, background: '#8b1a2b' } }).jpeg().toBuffer();
  r = await call('POST', crm('/campaign-media'), as(owner), { base64: small.toString('base64') });
  check('POST campaign-media for the owner: 410 in words (retired), nothing stored', r.status === 410 && /made in ScaleEzy CRM/.test(r.data?.message) && (await prisma.campaignMedia.count({ where: { clientId: SHOP } })) === 0, brief(r));
  r = await call('POST', crm('/campaign-media/from-product'), as(owner), { productImageId: image.id });
  check('POST campaign-media/from-product for the owner: 410 in words (retired), nothing stored', r.status === 410 && /made in ScaleEzy CRM/.test(r.data?.message) && (await prisma.campaignMedia.count({ where: { clientId: SHOP } })) === 0, brief(r));
  r = await call('GET', crm('/campaign-media'), tokenFor({ clientId: SHOP }));
  check('...while reading the shop\'s pictures (GET campaign-media) still answers', r.status === 200 && Array.isArray(r.data?.data), brief(r));

  console.log('\n3. PICTURE PREPARATION (Inventory\'s own pictures still go through it)');
  const big = await sharp({ create: { width: 2400, height: 1800, channels: 3, background: '#8b1a2b' } }).withMetadata({ exif: { IFD0: { Copyright: 'camera' } } } as any).jpeg({ quality: 92 }).toBuffer();
  const ready = await prepareImage(big);
  const readyMeta = await sharp(ready.jpeg).metadata();
  check('a 2400 x 1800 photo: made WhatsApp-ready, 1,600 px on its longer side, under 1 MB, no camera data', readyMeta.format === 'jpeg' && ready.width === 1600 && ready.height === 1200 && ready.jpeg.length < 1024 * 1024 && !readyMeta.exif, { w: ready.width, h: ready.height, bytes: ready.jpeg.length, exif: !!readyMeta.exif });
  const NOT_A_PICTURE = 'That file is not a picture ScaleEzy can read. Use a JPEG or PNG photo.';
  const words = async (buf: Buffer) => (await throws(() => prepareImage(buf)))?.message ?? 'accepted';
  let t0 = Date.now();
  const bomb = bombPng();
  check(`a picture bomb (${Math.round(bomb.length / 1024)} KB that unpacks to 400 megapixels): refused from its header, in ${Date.now() - t0} ms`, (await words(bomb)) === 'The picture is too large (more than 40 megapixels). Choose a smaller one.' && Date.now() - t0 < 3000);
  check('an SVG with a <script> inside: "not a picture ScaleEzy can read"', (await words(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="800" height="800"><script>alert(document.cookie)</script><rect width="800" height="800" fill="red"/></svg>'))) === NOT_A_PICTURE);
  const frameA = await sharp({ create: { width: 600, height: 800, channels: 3, background: '#aa0000' } }).png().toBuffer();
  const frameB = await sharp({ create: { width: 600, height: 800, channels: 3, background: '#0000aa' } }).png().toBuffer();
  const gif = await sharp([frameA, frameB], { join: { animated: true } }).gif({ delay: [300, 300] }).toBuffer();
  const still = await prepareImage(gif);
  const stillMeta = await sharp(still.jpeg).metadata();
  check('a moving GIF (2 frames) becomes ONE still JPEG of its first frame (red), same size', (await sharp(gif).metadata()).pages === 2 && stillMeta.format === 'jpeg' && (stillMeta.pages ?? 1) === 1 && stillMeta.width === 600 && (await sharp(still.jpeg).raw().toBuffer())[0] > 150);
  const avif = await sharp(frameA).avif().toBuffer();
  const heic = Buffer.from(avif.toString('latin1').replace(/avif/g, 'heic').replace(/av01/g, 'hvc1').replace(/av1C/g, 'hvcC'), 'latin1');
  check('an iPhone HEIC photo: what to do, in words', (await words(heic)) === 'This is an iPhone HEIC photo. Share it as a JPEG (or set the camera to "Most Compatible") and choose it again.');
  check('an AVIF photo (Android / Chrome): accepted and made a JPEG, not told it is an iPhone photo', (await sharp((await prepareImage(avif)).jpeg).metadata()).format === 'jpeg');
  check('an empty file: refused in words', /empty/i.test(await words(Buffer.alloc(0))));
  check('a text file: "not a picture"', (await words(Buffer.from('this is a text file, not a picture'))) === NOT_A_PICTURE);
  const MB15 = 15 * 1024 * 1024;
  check('exactly 15 MB: not refused for size (only for not being a picture)', (await words(Buffer.alloc(MB15))) === NOT_A_PICTURE);
  check('15 MB and one byte: "larger than 15 MB"', (await words(Buffer.alloc(MB15 + 1))) === 'The picture is larger than 15 MB. Choose a smaller one.');

  console.log('\n4. THE PRODUCT PHOTOS CRM CHOOSES FROM');
  r = await call('GET', crm('/product-photos'), as(owner));
  const list = r.data?.data ?? [];
  check('the list: this shop\'s products that HAVE photos, names and photos only', r.status === 200 && list.length === 1 && list[0].id === product.id
    && JSON.stringify(Object.keys(list[0]).sort()) === '["id","images","title"]' && list[0].images[0]?.id === image.id && JSON.stringify(Object.keys(list[0].images[0]).sort()) === '["id","url"]', brief(r));
  const deal = await prisma.product.create({ data: { clientId: SHOP, productCode: `CM3-${STAMP}`, slug: `cm3-${STAMP}`, title: 'Diwali 50% off silk', category: 'WOMEN' as any, productType: 'READY_TO_WEAR' as any, basePrice: 500, status: 'ACTIVE' as any } as any });
  await prisma.productImage.create({ data: { productId: deal.id, url: ourPhoto, imageType: 'GALLERY' as any, orderIndex: 0, isPrimary: true } as any });
  const found = async (q: string) => { const x = await call('GET', crm(`/product-photos?q=${encodeURIComponent(q)}`), as(owner)); return x.status === 200 ? (x.data?.data ?? []).map((p: any) => p.title).sort().join(' + ') : `HTTP ${x.status}`; };
  check('search "kanchi": found, any letter case', (await found('KANCHI')) === 'Kanchi silk saree');
  check('search "%": only the name with a % in it (taken literally)', (await found('%')) === 'Diwali 50% off silk', await found('%'));
  check('search "_" and "k_nchi": nothing ("_" is not "any letter")', (await found('_')) === '' && (await found('k_nchi')) === '');
  check('search "\\": nothing, and no error', (await found('\\')) === '');
  check('search "silk": both', (await found('silk')) === 'Diwali 50% off silk + Kanchi silk saree', await found('silk'));

  r = await call('GET', crm(`/product-photos/${image.id}`), as(owner));
  check('one photo: exactly { id, url, productId, title }, this shop\'s', r.status === 200 && Object.keys(r.data?.data ?? {}).sort().join() === 'id,productId,title,url'
    && r.data.data.id === image.id && r.data.data.url === ourPhoto && r.data.data.productId === product.id && r.data.data.title === 'Kanchi silk saree', brief(r));
  r = await call('GET', crm(`/product-photos/${image.id.toUpperCase()}`), as(owner));
  check('...its id in capitals is the same photo', r.status === 200 && r.data.data.id === image.id, brief(r));
  const myVariant = await prisma.productVariant.create({ data: { productId: product.id, clientId: SHOP, variantCode: `CMV-${STAMP}`, sku: `CMV-${STAMP}` } as any });
  const theirVariant = await prisma.productVariant.create({ data: { productId: otherProduct.id, clientId: OTHER, variantCode: `OTV-${STAMP}`, sku: `OTV-${STAMP}` } as any });
  const myVariantPhoto = await prisma.productImage.create({ data: { variantId: myVariant.id, url: ourPhoto, imageType: 'GALLERY' as any, orderIndex: 0, isPrimary: false } as any });
  const theirVariantPhoto = await prisma.productImage.create({ data: { variantId: theirVariant.id, url: ourPhoto, imageType: 'GALLERY' as any, orderIndex: 0, isPrimary: false } as any });
  const outside = await prisma.productImage.create({ data: { productId: product.id, url: 'https://example.com/elsewhere.jpg', imageType: 'GALLERY' as any, orderIndex: 1, isPrimary: false } as any });
  r = await call('GET', crm(`/product-photos/${myVariantPhoto.id}`), as(owner));
  check('...a colour-only photo names its product and title', r.status === 200 && r.data.data.productId === product.id && r.data.data.title === 'Kanchi silk saree', brief(r));
  for (const [what, id, status, msg] of [
    ['another shop\'s photo', otherImage.id, 404, 'That product photo was not found.'],
    ['another shop\'s colour-only photo', theirVariantPhoto.id, 404, 'That product photo was not found.'],
    ['an id that is not one', 'nope', 400, 'Choose one of the product photos.'],
    ['a photo stored somewhere else (never handed out to fetch)', outside.id, 400, 'That product photo is not stored with ScaleEzy, so it cannot be used. Upload the picture instead.']
  ] as const) {
    r = await call('GET', crm(`/product-photos/${id}`), as(owner));
    check(`...${what}: ${status} in words`, r.status === status && r.data?.message === msg, brief(r));
  }
  const ARCHIVED_WORDS = 'That product is archived or in the bin, so its photos are not used. Bring the product back, or upload the picture instead.';
  for (const status of ['ARCHIVED', 'TRASHED']) {
    await prisma.product.update({ where: { id: product.id }, data: { status: status as any } });
    r = await call('GET', crm(`/product-photos/${image.id}`), as(owner));
    const r2 = await call('GET', crm(`/product-photos/${myVariantPhoto.id}`), as(owner));
    check(`a product that is ${status}: its photo and its colour's photo refused in words, and it leaves the list`, r.status === 400 && r.data?.message === ARCHIVED_WORDS && r2.status === 400 && !(await found('kanchi')).includes('Kanchi'), brief(r));
  }
  await prisma.product.update({ where: { id: product.id }, data: { status: 'ACTIVE' as any } });

  console.log('\n5. INVENTORY\'S HOUSEKEEPING NEVER REMOVES CRM\'S PICTURES');
  const old = new Date(Date.now() - UNUSED_RETENTION_MS - 86_400_000);
  const crmA = await prisma.campaignMedia.create({ data: { clientId: SHOP, storagePath: `whatsapp-media/crm-a-${STAMP}.jpg`, url: 'https://example.invalid/a.jpg', width: 1600, height: 1200, byteSize: 90000, source: 'CRM', createdById: owner.id, createdAt: old } });
  const crmB = await prisma.campaignMedia.create({ data: { clientId: SHOP, storagePath: `whatsapp-media/crm-b-${STAMP}.jpg`, url: 'https://example.invalid/b.jpg', width: 1600, height: 1200, byteSize: 90000, source: 'CRM', productId: product.id, createdById: owner.id, createdAt: old } });
  const own = await prisma.campaignMedia.create({ data: { clientId: SHOP, storagePath: `whatsapp-media/test-${STAMP}.jpg`, url: 'https://example.invalid/x.jpg', width: 1, height: 1, byteSize: 1, source: 'UPLOAD', createdAt: old } });
  const removed = await purgeUnusedCampaignMedia(new Date(), { onlyClients: [SHOP] });
  const left = await prisma.campaignMedia.findMany({ where: { clientId: SHOP }, select: { id: true } });
  check('three days old, used by nothing Inventory can see: CRM\'s two pictures stay', [crmA.id, crmB.id].every(id => left.some(x => x.id === id)), left);
  check('...while an unused upload made in Inventory is still cleared', removed === 1 && !left.some(x => x.id === own.id), { removed, left });

  console.log('\n6. THE REST CRM READS');
  r = await call('GET', crm('/campaign-media'), tokenFor({ clientId: SHOP }));
  check('the shop\'s pictures (no person needed): newest first, exactly { id, url, width, height, createdAt }', r.status === 200 && r.data.data.length === 2
    && Object.keys(r.data.data[0]).sort().join() === 'createdAt,height,id,url,width', brief(r));
  r = await call('GET', crm('/wish-settings'), tokenFor({ clientId: SHOP }));
  check('wish settings of a shop that never set any: both off, no words, no picture', r.status === 200 && JSON.stringify(r.data.data) === JSON.stringify({ birthday: { on: false, text: null, media: null }, anniversary: { on: false, text: null, media: null } }), brief(r));
  const theirPic = await prisma.campaignMedia.create({ data: { clientId: OTHER, storagePath: `whatsapp-media/r3-${STAMP}.jpg`, url: 'https://example.invalid/r3.jpg', width: 1, height: 1, byteSize: 1, source: 'UPLOAD' } });
  await prisma.loyaltySettings.create({ data: { clientId: SHOP, birthdayWish: true, birthdayText: 'Happy birthday {name}!', birthdayMediaId: crmA.id, anniversaryWish: false, anniversaryText: 'Happy anniversary', anniversaryMediaId: theirPic.id } as any });
  r = await call('GET', crm('/wish-settings'), tokenFor({ clientId: SHOP }));
  const ws = r.data?.data;
  check('...with them set: on, the words, and the picture with its address and size', r.status === 200 && ws.birthday.on === true && ws.birthday.text === 'Happy birthday {name}!'
    && JSON.stringify(ws.birthday.media) === JSON.stringify({ id: crmA.id, url: crmA.url, width: 1600, height: 1200 }) && ws.anniversary.on === false, brief(r));
  check('...a picture id that points at ANOTHER shop\'s picture is not handed out', ws?.anniversary.media === null, ws?.anniversary);
  r = await call('GET', crm('/wish-settings'), tokenFor({ clientId: SHOP, userId: store.id }));
  check('...a storekeeper named (may not see customers): 403, naming the permission', r.status === 403 && /customer:view/.test(r.data?.message), brief(r));
  await prisma.loyaltySettings.delete({ where: { clientId: SHOP } });

  // Points stay Inventory's: CRM's birthday wish reads the total and this year's gift.
  const todayKey = localDayKey(new Date(), 'Asia/Kolkata');
  const mkCustomer = (clientId: string, name: string, points: number) => prisma.customer.create({ data: { clientId, customerCode: `PT-${name}-${STAMP}`, name, phone: `+9198${String(STAMP).slice(-6)}${points % 100}`.slice(0, 13), loyaltyPoints: points } as any });
  const asha = await mkCustomer(SHOP, 'Asha', 250), ravi = await mkCustomer(SHOP, 'Ravi', 0), foreign = await mkCustomer(OTHER, 'Foreign', 999);
  const pts = (ids: string, shop = SHOP) => call('GET', crm(`/customers/points?ids=${encodeURIComponent(ids)}`, shop), tokenFor({ clientId: shop }));
  r = await pts(`${asha.id},${ravi.id}`);
  check('points switched off: points null, no gift, giftPoints 0', r.status === 200 && r.data.data.length === 2 && r.data.data.every((x: any) => x.points === null && x.birthdayGift === null && x.giftPoints === 0), brief(r));
  await prisma.loyaltySettings.create({ data: { clientId: SHOP, enabled: true, birthdayPoints: 100 } as any });
  const year = Number(todayKey.slice(0, 4));
  await giveBirthdayPoints(SHOP, asha.id, year);
  await giveBirthdayPoints(SHOP, asha.id, year);
  r = await pts(`${asha.id.toUpperCase()},${ravi.id},${foreign.id},00000000-0000-4000-8000-000000000000`);
  const byId = Object.fromEntries((r.data?.data ?? []).map((x: any) => [x.customerId, x]));
  check('points on: Asha 350 (the gift once), given today, giftPoints 100; Ravi 0, no gift', r.status === 200 && byId[asha.id]?.points === 350 && JSON.stringify(byId[asha.id]?.birthdayGift) === JSON.stringify({ points: 100, givenOn: todayKey })
    && byId[asha.id]?.giftPoints === 100 && byId[ravi.id]?.points === 0 && byId[ravi.id]?.birthdayGift === null, brief(r));
  check('...another shop\'s customer and an unknown id are left out', r.data.data.length === 2 && !byId[foreign.id]);
  for (const [what, ids, msg] of [['no ids', '', 'Say which customers: ids=<id>,<id> (up to 200).'], ['a name instead of an id', 'Asha', 'Every id must be a customer id from Inventory.']] as const) {
    r = await pts(ids);
    check(`...${what}: 400 in words`, r.status === 400 && r.data?.message === msg, brief(r));
  }

  // The hand-over switch: campaigns and wishes are CRM's for every shop, so the switch no longer has them.
  await prisma.moduleSubscription.update({ where: { clientId_module: { clientId: SHOP, module: 'crm' } }, data: { moved: { profile: true, campaigns: true, wishes: { fromDay: '2026-11-01' } } } });
  r = await call('GET', crm('/moved'), tokenFor({ clientId: SHOP }));
  check('GET moved: an old row that still holds campaigns and wishes gives back only what is still a switch', r.status === 200 && JSON.stringify(r.data.data) === '{"profile":true}', brief(r));
  r = await call('PUT', crm('/moved'), as(owner), { campaigns: true, wishes: true, notes: true });
  const storedMoved = (await prisma.moduleSubscription.findUnique({ where: { clientId_module: { clientId: SHOP, module: 'crm' } }, select: { moved: true } }))?.moved;
  check('PUT moved that still sends campaigns and wishes: accepted, they are ignored and cleared from the row', r.status === 200 && JSON.stringify(Object.entries(r.data.data).sort()) === JSON.stringify([['notes', true], ['profile', true]]) && JSON.stringify(Object.entries(storedMoved as any).sort()) === JSON.stringify([['notes', true], ['profile', true]]), `${brief(r)} stored ${JSON.stringify(storedMoved)}`);
  r = await call('PUT', crm('/moved'), as(owner), { notes: 'yes' });
  check('...a wrong value is still refused in words', r.status === 400 && /notes, onlineViews, card, groups and profile/.test(r.data?.message), brief(r));
  r = await call('GET', crm('/moved', OTHER), tokenFor({ clientId: OTHER }));
  check('a shop without CRM: 404, nothing written for it', r.status === 404 && !(await prisma.moduleSubscription.findUnique({ where: { clientId_module: { clientId: OTHER, module: 'crm' } } })), brief(r));
}

async function cleanup() {
  await prisma.moduleSubscription.deleteMany({ where: { clientId: { in: [SHOP, OTHER] } } });
  await prisma.moduleEvent.deleteMany({ where: { clientId: { in: [SHOP, OTHER] } } });
  for (const id of [SHOP, OTHER]) {
    await platformAdminService.deleteClientCompletely(id, id).catch((e: any) => { if (!/No such client/.test(e?.message)) console.log('cleanup', id, e?.message); });
  }
  const leftover = await prisma.campaignMedia.count({ where: { clientId: { in: [SHOP, OTHER] } } });
  if (leftover) failures.push(`cleanup left ${leftover} picture rows`);
}

main()
  .catch(e => { failures.push(`crashed: ${e?.message}`); console.error(e); })
  .finally(async () => {
    await cleanup().catch(e => { failures.push(`cleanup crashed: ${e?.message}`); console.error(e); });
    console.log(`\nRESULT: ${passed} passed | ${failures.length} failed`);
    if (failures.length) console.log('FAILED: ' + failures.join(' | '));
    await prisma.$disconnect();
    process.exit(failures.length ? 1 : 0);
  });
