/**
 * CAMPAIGNS WITH A PICTURE AND A LINK (PLAN-whatsapp-offers.md, Part C), worst cases included.
 *
 *   P  the picture conversion: size, 1 MB, GPS and camera data gone, upright, see-through made white,
 *      print colours, first frame of a GIF, and every file that must be refused
 *   U  uploading and choosing a product photo through the API; who may; another shop's photo
 *   C  words, picture and link together: {link} rules, the 1,024-letter limit, where a link may go
 *   D  the dry run: who the choices describe, and who is left out and why
 *   S  Start: frozen, one link per customer made before sending, making links failing and recovering
 *   W  the sender: the picture, each customer's own link, the 72-hour rule, a missing link, an older
 *      WhatsApp service, failure codes, taps counted, links switched off and on
 *   T  the test send, copies, templates
 *   B  a picture on the birthday wish
 *   H  pictures nobody uses are cleared; deleting the shop takes its pictures
 *
 * WhatsApp is never really called: the client is swapped for a recorder before anything sends, and
 * the local server's own campaign job is off (it is off outside production).
 *
 *   npx tsx src/scripts/verify-campaign-media.ts     (needs the local backend running, LINK_BASE_URL set)
 */
import axios, { AxiosInstance } from 'axios';
import crypto from 'crypto';
import sharp from 'sharp';
import { prisma } from '../lib/prisma';
import { supabase } from '../lib/supabase';
import { env } from '../config/env';
import { AuthService } from '../services/auth.service';
import { seedRolesForClient } from '../services/rbac-seed.service';
import { platformAdminService } from '../services/platform-admin.service';
import { whatsappClient, WhatsAppServiceError, forgetCapabilities } from '../services/whatsapp/client';
import * as wa from '../services/whatsapp/service';
import { runCampaignTick, prepareShopDay, campaigns, prepareImage, purgeUnusedCampaignMedia } from '../services/campaigns';
import { birthdayKeysFor } from '../services/loyalty';
import { localDayKey } from '../utils/businessDay';
import { links } from '../services/links';

const BASE = process.env.VERIFY_API_URL || 'http://localhost:4006/api/v1';
const SERVER = BASE.replace(/\/api\/v1\/?$/, '');
const STAMP = Date.now();
const SHOP = `cmedia-${STAMP}`;
const OTHER = `cmedia-other-${STAMP}`;

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
const brief = (r: any) => `${r.status} ${JSON.stringify(r.data).slice(0, 300)}`;
const api = (token: string): AxiosInstance => axios.create({ baseURL: BASE, headers: { Authorization: `Bearer ${token}` }, validateStatus: () => true, timeout: 120_000, maxBodyLength: Infinity, maxContentLength: Infinity });
const throws = async (fn: () => unknown) => { try { await fn(); return null; } catch (e: any) { return e; } };
const msgOf = (r: any) => String(r?.data?.message ?? '');

// ── The WhatsApp recorder ────────────────────────────────────────────────────────────────
const sent: any[] = [];
let refuse: ((input: any) => Error | null) | null = null;
(whatsappClient as any).send = async (input: any) => {
  const r = refuse?.(input);
  if (r) throw r;
  const seen = sent.find(s => s.idempotencyKey === input.idempotencyKey);
  if (seen) return { id: seen.id, status: 'QUEUED', duplicate: true };
  const id = crypto.randomUUID();
  sent.push({ ...input, id });
  return { id, status: 'QUEUED' };
};
(whatsappClient as any).account = async () => ({ status: 'CONNECTED', phone: '91••••4642', linkedAt: new Date(Date.now() - 30 * 86400000).toISOString(), lastSeenAt: null });
(whatsappClient as any).capabilities = async () => ({ image: { urlPrefixes: [], maxCaption: 1024 }, linkPreview: true });
forgetCapabilities();

async function person(clientId: string, name: string, roleId: string) {
  const u = await prisma.user.create({ data: { clientId, email: `cmedia-${name.toLowerCase()}-${clientId}@example.com`, name, password: 'unused', status: 'ACTIVE' } });
  await prisma.userRole.create({ data: { userId: u.id, roleId } });
  return { id: u.id, name, http: api(AuthService.generateToken({ userId: u.id, clientId })) };
}

let n = 0;
const phone = () => `+919${String(STAMP).slice(-5)}${String(++n).padStart(4, '0')}`;
const customer = (over: Record<string, unknown>) => prisma.customer.create({
  data: { clientId: SHOP, customerCode: `CM-${STAMP}-${++n}`, name: `Customer ${n}`, phone: phone(), whatsappOffers: true, status: 'ACTIVE', ...over } as any
});

/** A real photo: a gradient with noise, so it compresses like a camera picture. */
async function photo(w: number, h: number, opts: { alpha?: boolean; noise?: boolean } = {}) {
  const channels = opts.alpha ? 4 : 3;
  const raw = Buffer.alloc(w * h * channels);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * channels;
    const r = opts.noise ? Math.random() * 255 : 0;
    raw[i] = (x * 255) / w; raw[i + 1] = (y * 255) / h; raw[i + 2] = opts.noise ? r : 128;
    if (opts.alpha) raw[i + 3] = x < w / 2 ? 0 : 255; // left half see-through
  }
  return sharp(raw, { raw: { width: w, height: h, channels } });
}
const b64 = (b: Buffer) => b.toString('base64');

async function main() {
  // ── P ───────────────────────────────────────────────────────────────────────────────────
  console.log('\nP. THE PICTURE CONVERSION');
  {
    const camera = await (await photo(4000, 3000, { noise: true })).jpeg({ quality: 95 })
      .withExif({ IFD0: { Make: 'TestCam', Model: 'X1', Copyright: 'Shop' }, IFD3: { GPSLatitudeRef: 'N', GPSLatitude: '12/1 58/1 0/1', GPSLongitudeRef: 'E', GPSLongitude: '77/1 35/1 0/1' } })
      .toBuffer();
    const inMeta = await sharp(camera).metadata();
    const p = await prepareImage(camera);
    const outMeta = await sharp(p.jpeg).metadata();
    check('a 12-megapixel camera photo comes out at most 1,600 px wide', p.width === 1600 && p.height === 1200 && outMeta.format === 'jpeg', { w: p.width, h: p.height });
    check('...under 1 MB, even full of fine detail', p.jpeg.length <= 1024 * 1024, p.jpeg.length);
    check('...with the GPS position and camera details gone', !!inMeta.exif && !outMeta.exif && !outMeta.icc && !outMeta.xmp, { before: !!inMeta.exif, after: !!outMeta.exif });

    const turned = await (await photo(400, 200)).jpeg().withMetadata({ orientation: 6 }).toBuffer();
    const t = await prepareImage(turned);
    check('a phone photo taken sideways is turned upright (400×200 marked "turn" -> 200×400)', t.width === 200 && t.height === 400, { w: t.width, h: t.height });

    const png = await (await photo(300, 300, { alpha: true })).png().toBuffer();
    const pp = await prepareImage(png);
    const px = await sharp(pp.jpeg).extract({ left: 5, top: 150, width: 1, height: 1 }).raw().toBuffer();
    check('a PNG with a see-through background gets white, not black', px[0] > 240 && px[1] > 240 && px[2] > 240, [...px]);

    const cmyk = await (await photo(300, 300)).toColourspace('cmyk').jpeg().toBuffer();
    check('a print (CMYK) file becomes normal colour', (await sharp(cmyk).metadata()).space === 'cmyk' && (await sharp((await prepareImage(cmyk)).jpeg).metadata()).space === 'srgb');

    const gif = await sharp({ create: { width: 200, height: 200, channels: 3, background: '#c00' } }).gif().toBuffer();
    check('a GIF becomes a still JPEG', (await sharp((await prepareImage(gif)).jpeg).metadata()).format === 'jpeg');
    const webp = await (await photo(500, 400)).webp().toBuffer();
    check('a WebP becomes a JPEG', (await sharp((await prepareImage(webp)).jpeg).metadata()).format === 'jpeg');
    const small = await prepareImage(await (await photo(600, 400)).jpeg().toBuffer());
    check('a small picture is not blown up', small.width === 600 && small.height === 400);

    const refused: Array<[string, Buffer, RegExp]> = [
      ['a text file renamed .jpg', Buffer.from('hello, this is not a picture'), /not a picture/],
      ['random bytes', crypto.randomBytes(5000), /not a picture/],
      ['a PDF', Buffer.from('%PDF-1.4\n%âãÏÓ\n1 0 obj<<>>endobj\n'), /not a picture/],
      ['an empty file', Buffer.alloc(0), /empty/],
      ['a 50×50 icon', await (await photo(50, 50)).jpeg().toBuffer(), /too small/],
      ['a "bomb": 48 megapixels that packs into a few KB', await sharp({ create: { width: 8000, height: 6000, channels: 3, background: '#fff' } }).png().toBuffer(), /40 megapixels/],
      ['over 15 MB', Buffer.alloc(15 * 1024 * 1024 + 10, 1), /15 MB/]
    ];
    for (const [what, buf, why] of refused) {
      const e = await throws(() => prepareImage(buf));
      check(`refused in words: ${what}`, e?.statusCode === 400 && why.test(e.message), e?.message ?? 'ACCEPTED');
    }
    const cut = camera.subarray(0, Math.floor(camera.length / 3));
    const ce = await throws(() => prepareImage(cut));
    check('a photo cut off a third of the way is refused, never sent half grey', ce?.statusCode === 400 && /damaged|not a picture/.test(ce.message), ce?.message ?? 'ACCEPTED');
  }

  // ── setup ───────────────────────────────────────────────────────────────────────────────
  console.log(`\nSETUP ${SHOP}`);
  const roles = await seedRolesForClient(SHOP);
  const otherRoles = await seedRolesForClient(OTHER);
  await prisma.clientSettings.create({ data: { clientId: SHOP, businessName: 'Sree Silks', businessPhone: '8247003162' } });
  await prisma.clientSettings.create({ data: { clientId: OTHER, businessName: 'Other Shop' } });
  const owner = await person(SHOP, 'Owner', roles.SUPER_ADMIN);
  const sales = await person(SHOP, 'Sita', roles.SALES);
  const stranger = await person(OTHER, 'Stranger', otherRoles.SUPER_ADMIN);
  const own = owner.http;
  await prisma.stockLocation.create({ data: { clientId: SHOP, name: 'Main Store', code: 'MAIN', type: 'STORE', active: true } });
  await prisma.stockLocation.create({ data: { clientId: OTHER, name: 'Main Store', code: 'MAIN', type: 'STORE', active: true } });

  // A product with a real photo in our storage, and one whose photo lives elsewhere.
  const product = await prisma.product.create({ data: { clientId: SHOP, title: 'Red Kanchipuram Silk Saree', productCode: `CM-${STAMP}`, slug: `cm-${STAMP}`, category: 'WOMEN', productType: 'READY_TO_WEAR', basePrice: 4999, status: 'ACTIVE' } });
  const productPath = `${SHOP}/verify-${STAMP}.jpg`;
  const up = await supabase.storage.from('inventory-images').upload(productPath, await (await photo(1200, 1600)).jpeg().toBuffer(), { contentType: 'image/jpeg' });
  if (up.error) throw new Error(`could not put a test product photo in storage: ${up.error.message}`);
  const productUrl = supabase.storage.from('inventory-images').getPublicUrl(productPath).data.publicUrl;
  const productImage = await prisma.productImage.create({ data: { productId: product.id, url: productUrl, storagePath: productPath, imageType: 'COVER', isPrimary: true } });
  const outsideImage = await prisma.productImage.create({ data: { productId: product.id, url: 'https://example.com/saree.jpg', imageType: 'GALLERY' } });
  const otherProduct = await prisma.product.create({ data: { clientId: OTHER, title: 'Other saree', productCode: `CMO-${STAMP}`, slug: `cmo-${STAMP}`, category: 'WOMEN', productType: 'READY_TO_WEAR', basePrice: 100, status: 'ACTIVE' } });
  const otherImage = await prisma.productImage.create({ data: { productId: otherProduct.id, url: productUrl, imageType: 'COVER' } });

  // ── U ───────────────────────────────────────────────────────────────────────────────────
  console.log('\nU. UPLOADING AND CHOOSING PICTURES');
  const upload = async (http: AxiosInstance, buf: Buffer) => http.post('/campaigns/media', { base64: `data:image/jpeg;base64,${b64(buf)}` });
  const uploaded = await upload(own, await (await photo(2400, 1800, { noise: true })).jpeg({ quality: 92 }).toBuffer());
  check('an owner uploads a photo: 201 with its WhatsApp-ready copy', uploaded.status === 201 && uploaded.data.data.width === 1600, brief(uploaded));
  const pic = uploaded.data.data;
  check('stored at a random address in inventory-images/whatsapp-media/, saying nothing about the shop',
    /\/inventory-images\/whatsapp-media\/[0-9a-f]{32}\.jpg$/.test(pic.url) && !pic.url.includes(SHOP), pic.url);
  const fetched = await axios.get(pic.url, { responseType: 'arraybuffer', validateStatus: () => true });
  check('the copy is really there, a JPEG anyone can load (WhatsApp must)', fetched.status === 200 && Buffer.from(fetched.data).subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff])), fetched.status);
  const second = await upload(own, await (await photo(2400, 1800, { noise: true })).jpeg().toBuffer());
  check('the same kind of photo again is a new picture at a new address (never overwritten)', second.status === 201 && second.data.data.url !== pic.url);
  const notPic = await own.post('/campaigns/media', { base64: b64(Buffer.from('not a picture at all')) });
  const junk = await own.post('/campaigns/media', { base64: '%%%not base64%%%' });
  const nothing = await own.post('/campaigns/media', {});
  check('a non-picture, junk and nothing: 400 in words', [notPic, junk, nothing].every(r => r.status === 400 && /picture/.test(msgOf(r))), [brief(notPic), brief(junk), brief(nothing)]);
  const huge = await own.post('/campaigns/media', { base64: b64(Buffer.alloc(16 * 1024 * 1024, 7)) });
  check('16 MB: refused in words at the door, never read in', (huge.status === 413 || huge.status === 400) && /15 MB/.test(msgOf(huge)), brief(huge));
  const justOver = await own.post('/campaigns/media', { base64: b64(Buffer.alloc(15 * 1024 * 1024 + 4096, 7)) });
  check('just over 15 MB (inside the door\'s limit): refused by the size check, before decoding', justOver.status === 400 && /15 MB/.test(msgOf(justOver)), brief(justOver));
  const bySales = await upload(sales.http, await (await photo(300, 300)).jpeg().toBuffer());
  check('a salesperson (no campaign:send) cannot upload', bySales.status === 403, brief(bySales));
  const noLogin = await axios.post(`${BASE}/campaigns/media`, { base64: 'AAAA' }, { validateStatus: () => true });
  check('no login: 401 before the big body is even read', noLogin.status === 401);

  const photos = await own.get('/campaigns/product-photos', { params: { q: 'kanchipuram' } });
  check('product photos: found by name, with their photos', photos.status === 200 && photos.data.data.length === 1 && photos.data.data[0].images.length === 2, brief(photos));
  const salesPhotos = await sales.http.get('/campaigns/product-photos');
  check('...not for a salesperson', salesPhotos.status === 403);
  const fromProduct = await own.post('/campaigns/media/from-product', { productImageId: productImage.id });
  check('a product photo becomes a campaign picture (1200×1600 stays that size)', fromProduct.status === 201 && fromProduct.data.data.width === 1200 && fromProduct.data.data.height === 1600, brief(fromProduct));
  const stored = await prisma.campaignMedia.findUniqueOrThrow({ where: { id: fromProduct.data.data.id } });
  check('...remembering which product it came from', stored.source === 'PRODUCT' && stored.productId === product.id);
  const otherShops = await own.post('/campaigns/media/from-product', { productImageId: otherImage.id });
  const outside = await own.post('/campaigns/media/from-product', { productImageId: outsideImage.id });
  check('another shop\'s product photo: not found', otherShops.status === 404, brief(otherShops));
  check('a photo stored outside ScaleEzy is never fetched', outside.status === 400 && /not stored with ScaleEzy/.test(msgOf(outside)), brief(outside));

  // ── C ───────────────────────────────────────────────────────────────────────────────────
  console.log('\nC. WORDS, PICTURE AND LINK TOGETHER');
  const chat = { type: 'WHATSAPP' };
  const create = (body: Record<string, unknown>) => own.post('/campaigns', { name: 'Diwali', text: 'Hello {name}!', audience: { tags: ['X'] }, ...body });
  const cases: Array<[string, Record<string, unknown>, RegExp]> = [
    ['a link chosen but {link} not in the words', { link: chat }, /Put \{link\}/],
    ['{link} in the words with nowhere to go', { text: 'See {link}' }, /Choose where the link goes/],
    ['{link} twice', { text: '{link} and {link}', link: chat }, /once/],
    ['a web page on another short link', { text: 'See {link}', link: { type: 'EXTERNAL', url: 'https://bit.ly/abc' } }, /another short link/],
    ['a web page that is not https', { text: 'See {link}', link: { type: 'EXTERNAL', url: 'http://sreesilks.in' } }, /https/],
    ['the ScaleEzy app as a destination', { text: 'See {link}', link: { type: 'EXTERNAL', url: 'https://app.scaleezy.com/login' } }, /part of ScaleEzy/],
    ['a link lasting 5 days', { text: 'See {link}', link: { type: 'WHATSAPP', days: 5 } }, /7 to 365/],
    ['a chat number that is not a number', { text: 'See {link}', link: { type: 'WHATSAPP', phone: '12345' } }, /number/],
    ['an unknown kind of link', { text: 'See {link}', link: { type: 'FTP' } }, /Choose where/],
    ['another shop\'s picture', { mediaId: (await upload(stranger.http, await (await photo(300, 300)).jpeg().toBuffer())).data.data.id }, /picture was not found/],
    // 982 letters: under the 1,000 for any message, but with a 20-letter name and the STOP line over 1,024.
    ['words too long to go under a picture', { text: `Hello {name}! ${'Silk sarees on offer. '.repeat(44)}`, mediaId: pic.id }, /1,024 letters.*Shorten it by/]
  ];
  for (const [what, body, why] of cases) {
    const r = await create(body);
    check(`refused in words: ${what}`, r.status === 400 && why.test(msgOf(r)), brief(r));
  }
  const nearLimit = `Hello {name}! ${'x'.repeat(900)}`;
  const fits = await create({ text: nearLimit, mediaId: pic.id });
  check('the same words WITHOUT a picture are fine (the 1,024 limit is for captions)', (await create({ text: `Hello {name}! ${'Silk sarees on offer. '.repeat(44)}` })).status === 201);
  check('words that fit under a picture are accepted', fits.status === 201, brief(fits));
  const withChat = await create({ text: 'Hello {name}! 🎉 Red Kanchipuram silk sarees, 20% off till 31 Oct. Chat with us: {link}', mediaId: pic.id, link: { type: 'WHATSAPP', chatText: 'Hi, I want the red saree' } });
  check('picture + chat link: saved, the chat goes to the shop\'s own phone with the first line typed',
    withChat.status === 201 && withChat.data.data.link.target === 'https://wa.me/918247003162?text=Hi%2C%20I%20want%20the%20red%20saree' && withChat.data.data.media.id === pic.id, brief(withChat));
  const draftId = withChat.data.data.id;
  const noPhone = await prisma.clientSettings.update({ where: { clientId: SHOP }, data: { businessPhone: null } });
  const needsPhone = await create({ text: 'Chat {link}', link: chat });
  check('no shop phone saved and none typed: it asks for one', needsPhone.status === 400 && /WhatsApp number/.test(msgOf(needsPhone)), brief(needsPhone));
  const typedPhone = await create({ text: 'Chat {link}', link: { type: 'WHATSAPP', phone: '98480 22338' } });
  check('...a typed number works', typedPhone.status === 201 && typedPhone.data.data.link.target.startsWith('https://wa.me/919848022338?text='), brief(typedPhone));
  await prisma.clientSettings.update({ where: { clientId: SHOP }, data: { businessPhone: '8247003162' } });
  void noPhone;
  const changed = await own.patch(`/campaigns/${draftId}`, { mediaId: second.data.data.id });
  check('a draft can change its picture', changed.status === 200 && changed.data.data.media.id === second.data.data.id);
  const dropLink = await own.patch(`/campaigns/${draftId}`, { link: null });
  check('taking the link away while {link} is still in the words is refused', dropLink.status === 400 && /take \{link\} out/.test(msgOf(dropLink)), brief(dropLink));
  await own.patch(`/campaigns/${draftId}`, { mediaId: pic.id });
  const overview = await own.get('/campaigns/overview');
  check('the page is told pictures and links are available, and the shop\'s phone', overview.data.data.features?.picture === true && overview.data.data.features?.link === true && overview.data.data.features?.shopPhone === '+918247003162', overview.data.data.features);

  // ── D ───────────────────────────────────────────────────────────────────────────────────
  console.log('\nD. THE DRY RUN');
  const A = await customer({ name: 'Anitha Rao', tags: ['X'] });
  const B = await customer({ name: 'Bindu', tags: ['X'], whatsappOffers: false });
  const Cst = await customer({ name: 'Chitra', tags: ['X'], whatsappStoppedAt: new Date() });
  const D = await customer({ name: 'Devi', tags: ['X'], phone: null });
  const E = await customer({ name: 'Eshwari', tags: ['X'] });
  const F = await customer({ name: 'Fathima', tags: ['X'] });
  const G = await customer({ name: 'Gowri', tags: ['X'] });
  // E had an offer an hour ago; F four days ago; G an hour ago but it failed. And a birthday wish to
  // A an hour ago -- wishes are not offers.
  const past = async (who: string, hoursAgo: number, status: string, source = 'MANUAL') => {
    const c = await prisma.campaign.create({ data: { clientId: SHOP, name: `past ${source} ${who}`, text: 'x', status: 'DONE', source, startedAt: new Date() } });
    const m = await prisma.whatsAppMessage.create({ data: { clientId: SHOP, kind: 'CAMPAIGN', referenceId: c.id, toMasked: '••••0000', status } });
    await prisma.campaignRecipient.create({ data: { campaignId: c.id, clientId: SHOP, customerId: who, state: 'HANDED', handedAt: new Date(Date.now() - hoursAgo * 3600_000), messageId: m.id } });
  };
  await past(E.id, 1, 'DELIVERED');
  await past(F.id, 96, 'READ');
  await past(G.id, 1, 'FAILED');
  await past(A.id, 1, 'READ', 'BIRTHDAY');
  const dry = await own.post('/campaigns/preview', { audience: { tags: ['X'] } });
  const bd = dry.data.data?.breakdown;
  check('7 described: 1 no phone, 1 said STOP, 1 did not agree, 4 reachable', bd?.matched === 7 && bd.noPhone === 1 && bd.stopped === 1 && bd.notAgreed === 1 && bd.reachable === 4, bd);
  check('...1 had an offer in the last 72 hours (not the failed one, not the 4-day-old one, not a birthday wish): 3 will get it', bd?.recentOffer === 1 && bd.willGet === 3, bd);
  check('...and the parts add up', bd && bd.noPhone + bd.stopped + bd.notAgreed + bd.reachable === bd.matched);
  void B; void Cst; void D;

  // ── S ───────────────────────────────────────────────────────────────────────────────────
  console.log('\nS. START');
  const started = await own.post(`/campaigns/${draftId}/start`, { expected: 4 });
  const X = started.data.data;
  check('started: all links made straight away, so it is already SENDING', started.status === 200 && X.status === 'SENDING', brief(started));
  const recips = await prisma.campaignRecipient.findMany({ where: { campaignId: draftId } });
  check('4 customers, each with a random token and their own code', recips.length === 4 && recips.every(r => r.linkRef && /^[A-Za-z0-9]{7}$/.test(r.linkCode ?? '')) && new Set(recips.map(r => r.linkCode)).size === 4);
  const madeLinks = await prisma.shortLink.findMany({ where: { clientId: SHOP, ownerModule: 'campaigns', ownerRef: draftId } });
  check('4 short links owned by the campaign; they know tokens, never customers', madeLinks.length === 4 && madeLinks.every(l => recips.some(r => r.linkRef === l.recipientRef && r.linkCode === l.code) && !recips.some(r => r.customerId === l.recipientRef)));
  check('each goes to the shop chat, and lasts 90 days', madeLinks.every(l => l.target.startsWith('https://wa.me/918247003162') && Math.abs(l.expiresAt.getTime() - Date.now() - 90 * 86_400_000) < 120_000));
  check('what goes out is frozen: words, picture, link, shop name', X.sent?.text === X.text && X.sent?.media?.id === pic.id && X.sent?.link?.type === 'WHATSAPP' && X.sent?.shopName === 'Sree Silks', X.sent);
  await prisma.clientSettings.update({ where: { clientId: SHOP }, data: { businessName: 'Sree Silks & Sarees' } });
  const later = await own.get(`/campaigns/${draftId}`);
  check('renaming the shop later does not change what the page says was sent', later.data.data.sent.shopName === 'Sree Silks');
  const edit = await own.patch(`/campaigns/${draftId}`, { text: 'changed' });
  check('a started campaign cannot be changed (409)', edit.status === 409);

  // Making links fails, then recovers (this process's own copy of the settings).
  const W = (await create({ name: 'Flaky links', text: 'See {link}', link: { type: 'EXTERNAL', url: 'https://sreesilks.in/sale' }, audience: { tags: ['W'] } })).data.data;
  const w1 = await customer({ tags: ['W'] }); const w2 = await customer({ tags: ['W'] });
  const savedBase = env.LINK_BASE_URL;
  // Started through the running server (links made there), then put back to "making links" by hand.
  const ws = await own.post(`/campaigns/${W.id}/start`, { expected: 2 });
  check('a second campaign starts', ws.status === 200 && ws.data.data.status === 'SENDING', brief(ws));
  await prisma.campaignRecipient.updateMany({ where: { campaignId: W.id }, data: { linkCode: null } });
  await prisma.campaign.update({ where: { id: W.id }, data: { status: 'PREPARING' } });
  const paused = await own.post(`/campaigns/${W.id}/pause`);
  check('pausing while links are being made is refused in words', paused.status === 409 && /links ready/.test(msgOf(paused)), brief(paused));
  (env as any).LINK_BASE_URL = undefined;
  const failed = await campaigns.prepareLinks(W.id);
  const wRow = await prisma.campaign.findUniqueOrThrow({ where: { id: W.id } });
  check('links cannot be made: it stays PREPARING and says why', failed === 'PREPARING' && wRow.status === 'PREPARING' && /not set up/.test(wRow.prepareError ?? ''), { failed, err: wRow.prepareError });
  (env as any).LINK_BASE_URL = savedBase;
  const tickBefore = sent.length;
  await runCampaignTick(new Date(), { onlyClients: [SHOP], ignoreHours: true });
  const wAfter = await prisma.campaign.findUniqueOrThrow({ where: { id: W.id } });
  const wRecips = await prisma.campaignRecipient.findMany({ where: { campaignId: W.id } });
  check('the next run makes them, the same links as before, and it starts sending', wAfter.status === 'SENDING' && !wAfter.prepareError && wRecips.every(r => r.linkCode)
    && (await prisma.shortLink.count({ where: { ownerRef: W.id } })) === 2, { status: wAfter.status, err: wAfter.prepareError });
  void w1; void w2; void tickBefore;

  // ── W ───────────────────────────────────────────────────────────────────────────────────
  console.log('\nW. THE SENDER');
  const settle = () => prisma.whatsAppMessage.updateMany({ where: { clientId: SHOP, kind: 'CAMPAIGN', status: 'QUEUED' }, data: { status: 'SENT' } });
  const tick = async () => { await settle(); return runCampaignTick(new Date(), { onlyClients: [SHOP], ignoreHours: true }); };
  for (let i = 0; i < 4; i++) await tick();
  const xSends = sent.filter(s => s.reference === `CAMPAIGN:${draftId}`);
  const xr = await prisma.campaignRecipient.findMany({ where: { campaignId: draftId } });
  const byCustomer = (id: string) => xr.find(r => r.customerId === id)!;
  check('3 sent (Anitha, Fathima, Gowri); Eshwari skipped: an offer in the last 72 hours', xSends.length === 3 && byCustomer(E.id).state === 'SKIPPED' && byCustomer(E.id).skipCode === 'RECENT_OFFER', xr.map(r => [r.state, r.skipCode]));
  check('...a birthday wish an hour ago did not stop Anitha', byCustomer(A.id).state === 'HANDED');
  const toAnitha = xSends.find(s => s.idempotencyKey === `CAMPAIGN:${draftId}:${A.id}`);
  check('the picture goes with it, from our storage', toAnitha?.image?.url === pic.url, toAnitha?.image);
  check('the words carry HER link and her first name, and end with STOP', toAnitha?.text.includes(links.shortUrl(byCustomer(A.id).linkCode!)) && /^Hello Anitha!/.test(toAnitha.text) && /Reply STOP/.test(toAnitha.text), toAnitha?.text);
  check('nobody gets anybody else\'s link', xSends.every(s => { const who = xr.find(r => s.idempotencyKey.endsWith(r.customerId))!; return xr.every(r => r.linkCode === who.linkCode || !s.text.includes(r.linkCode!)); }));
  check('no link card under a picture', xSends.every(s => !s.linkPreview));
  const wSends = sent.filter(s => s.reference === `CAMPAIGN:${W.id}`);
  check('a campaign with a link and no picture asks for WhatsApp\'s link card', wSends.length === 2 && wSends.every(s => s.linkPreview === true && !s.image), wSends.map(s => [s.linkPreview, !!s.image]));

  // A customer's link missing when their turn comes (should never happen): not sent, links made again.
  const Y = (await create({ name: 'Missing link', text: 'Hi {name} {link}', link: { type: 'EXTERNAL', url: 'https://sreesilks.in/new' }, audience: { tags: ['Y'] } })).data.data;
  const y1 = await customer({ name: 'Yamuna', tags: ['Y'] });
  await own.post(`/campaigns/${Y.id}/start`, { expected: 1 });
  const yCode = (await prisma.campaignRecipient.findFirstOrThrow({ where: { campaignId: Y.id } })).linkCode;
  await prisma.campaignRecipient.updateMany({ where: { campaignId: Y.id }, data: { linkCode: null } });
  const yBefore = sent.length;
  await tick();
  const yNow = await prisma.campaign.findUniqueOrThrow({ where: { id: Y.id } });
  const yRec = await prisma.campaignRecipient.findFirstOrThrow({ where: { campaignId: Y.id } });
  check('a customer\'s link missing at their turn: not sent, waiting, and the campaign goes back to making links',
    sent.slice(yBefore).every(s => s.reference !== `CAMPAIGN:${Y.id}`) && yRec.state === 'WAITING' && yNow.status === 'PREPARING', { status: yNow.status, state: yRec.state });
  await tick();
  const yFixed = await prisma.campaignRecipient.findFirstOrThrow({ where: { campaignId: Y.id } });
  const ySent = sent.filter(s => s.reference === `CAMPAIGN:${Y.id}`);
  check('...the next run makes it again -- the same link, since it may be in nobody\'s hands yet -- and sends it',
    yFixed.linkCode === yCode && ySent.length === 1 && ySent[0].text.includes(links.shortUrl(yCode!)), { code: yFixed.linkCode, was: yCode, sent: ySent.length });
  void y1;

  // An older WhatsApp service that does not know pictures refuses the field: customers wait, nothing is lost.
  const Z = (await create({ name: 'Old service', text: 'Hello {name}', mediaId: pic.id, audience: { tags: ['Z'] } })).data.data;
  await customer({ name: 'Zeenath', tags: ['Z'] });
  await own.post(`/campaigns/${Z.id}/start`, { expected: 1 });
  refuse = (input) => (input.image ? new WhatsAppServiceError(400, 'The request is not valid: unknown field(s): image.') : null);
  await tick();
  const zRec = await prisma.campaignRecipient.findFirstOrThrow({ where: { campaignId: Z.id } });
  check('an older WhatsApp service refusing pictures: the customer waits their turn, not failed', zRec.state === 'WAITING', zRec.state);
  refuse = null;
  await tick();
  check('...and gets it once the service knows pictures', (await prisma.campaignRecipient.findFirstOrThrow({ where: { campaignId: Z.id } })).state === 'HANDED');

  // Failure codes arrive from the service and are counted.
  const gowriMsg = byCustomer(G.id).messageId!;
  const serviceId = (await prisma.whatsAppMessage.findUniqueOrThrow({ where: { id: gowriMsg } })).serviceMessageId!;
  await wa.handleEvent({ id: crypto.randomUUID(), type: 'message.status', data: { messageId: serviceId, status: 'FAILED', failReason: 'The picture could not be sent: The picture is no longer in picture storage.', failCode: 'MEDIA_FETCH_FAILED' } });
  const gm = await prisma.whatsAppMessage.findUniqueOrThrow({ where: { id: gowriMsg } });
  check('a failure code from WhatsApp is kept beside the words', gm.status === 'FAILED' && gm.failCode === 'MEDIA_FETCH_FAILED');
  const xPage = (await own.get(`/campaigns/${draftId}`)).data.data;
  const codes = Object.fromEntries(xPage.notSent.map((r: any) => [r.code, r.count]));
  check('the campaign page counts why: 1 offered recently, 1 picture failed', codes.RECENT_OFFER === 1 && codes.MEDIA_FETCH_FAILED === 1, xPage.notSent);

  // Taps
  const anithaCode = byCustomer(A.id).linkCode!;
  const open = await axios.get(`${SERVER}/l/${anithaCode}`, { maxRedirects: 0, validateStatus: () => true, headers: { 'user-agent': 'Mozilla/5.0 (Linux; Android 14) Chrome/126 Mobile Safari/537.36' } });
  await axios.get(`${SERVER}/l/${anithaCode}`, { maxRedirects: 0, validateStatus: () => true, headers: { 'user-agent': 'WhatsApp/2.24 A' } });
  check('Anitha\'s link opens the shop chat', open.status === 302 && String(open.headers.location).startsWith('https://wa.me/918247003162'), open.status);
  await new Promise(r => setTimeout(r, 400));
  const tapped = (await own.get(`/campaigns/${draftId}`)).data.data;
  check('the page: 1 customer tapped, 1 tap (WhatsApp\'s own preview not counted)', tapped.progress.tapped === 1 && tapped.progress.taps === 1, tapped.progress);
  check('...and it is Anitha', tapped.recipients.find((r: any) => r.customerId === A.id)?.tapped === 1 && tapped.recipients.find((r: any) => r.customerId === F.id)?.tapped === 0);

  const off = await own.post(`/campaigns/${draftId}/links/off`);
  const whenOff = await axios.get(`${SERVER}/l/${anithaCode}`, { maxRedirects: 0, validateStatus: () => true });
  check('the shop switches the campaign\'s links off: 4 off, the link says "no longer available"', off.status === 200 && off.data.data.switchedOff === 4 && whenOff.status === 410 && /no longer available/.test(whenOff.data), brief(off));
  const on = await own.post(`/campaigns/${draftId}/links/on`);
  const whenOn = await axios.get(`${SERVER}/l/${anithaCode}`, { maxRedirects: 0, validateStatus: () => true });
  check('...and on again', on.status === 200 && whenOn.status === 302);
  const othersOff = await stranger.http.post(`/campaigns/${draftId}/links/off`);
  check('another shop cannot touch them', othersOff.status === 404, brief(othersOff));

  // ── T ───────────────────────────────────────────────────────────────────────────────────
  console.log('\nT. TEST SEND, COPIES, TEMPLATES');
  const actor = { id: owner.id, clientId: SHOP, name: 'Ravi Kumar', roles: ['SUPER_ADMIN'], permissions: ['campaign:send'] };
  const before = sent.length;
  const test = await campaigns.sendTest(actor, { text: 'Hi {name}, see {link}', mediaId: pic.id, link: { type: 'EXTERNAL', url: 'https://sreesilks.in/sale' }, to: '8247003162', name: 'Draft' });
  const t = sent[before];
  check('a test from the editor: the real picture, a real short link, the sender\'s own name', !!test.link && t?.image?.url === pic.url && t.text.startsWith('[Test] Hi Ravi, see ') && t.text.includes(test.link!), t?.text);
  const testLink = await prisma.shortLink.findUniqueOrThrow({ where: { code: test.link!.split('/').pop()! } });
  check('...its link is marked as a test, lasting a week', testLink.isTest && Math.abs(testLink.expiresAt.getTime() - Date.now() - 7 * 86_400_000) < 120_000);
  const savedTest = await campaigns.sendTest(actor, { campaignId: draftId, to: '8247003162' });
  check('a test of a started campaign sends what it sent', sent[sent.length - 1].image?.url === pic.url && sent[sent.length - 1].text.includes(savedTest.link!));
  const statsAfterTest = await links.statsFor(SHOP, { module: 'campaigns', ref: draftId });
  check('test links are not counted in the campaign\'s numbers', statsAfterTest.links === 4, statsAfterTest);
  check('a test never counts as an offer for the 72 hours (no customer row)', (await prisma.campaignRecipient.count({ where: { clientId: SHOP, campaign: { name: 'Draft' } } })) === 0);

  const copied = await own.post(`/campaigns/${draftId}/copy`);
  check('copying a started campaign copies what it sent: picture and link', copied.status === 201 && copied.data.data.status === 'DRAFT' && copied.data.data.media?.id === pic.id && copied.data.data.link?.type === 'WHATSAPP', brief(copied));

  const tl = await own.get('/campaigns/templates');
  check('4 starter templates, each naming what is on offer in the words', tl.status === 200 && tl.data.data.filter((x: any) => x.starter).length === 4 && tl.data.data.every((x: any) => /\{name\}/.test(x.text)));
  const saveT = await own.post('/campaigns/templates', { name: 'Diwali chat', text: 'Hello {name}, chat with us: {link}', mediaId: pic.id, link: { type: 'WHATSAPP' } });
  check('save the editor\'s words, picture and link as a template', saveT.status === 201 && saveT.data.data.media?.id === pic.id && saveT.data.data.link?.type === 'WHATSAPP', brief(saveT));
  const dupT = await own.post('/campaigns/templates', { name: 'Diwali chat', text: 'x' });
  check('the same name twice: 409 in words', dupT.status === 409 && /already have a template/.test(msgOf(dupT)), brief(dupT));
  const fromCampaign = await own.post('/campaigns/templates', { name: 'What we sent', campaignId: draftId });
  check('save a started campaign as a template: what it sent', fromCampaign.status === 201 && fromCampaign.data.data.text === X.text && fromCampaign.data.data.media?.id === pic.id);
  const delStarter = await own.delete('/campaigns/templates/starter:sale');
  const delOther = await stranger.http.delete(`/campaigns/templates/${saveT.data.data.id}`);
  check('starters cannot be deleted; another shop cannot delete mine', delStarter.status === 400 && delOther.status === 404, [delStarter.status, delOther.status]);
  const salesT = await sales.http.post('/campaigns/templates', { name: 'x', text: 'y' });
  check('a salesperson cannot save templates', salesT.status === 403);

  // ── B ───────────────────────────────────────────────────────────────────────────────────
  console.log('\nB. A PICTURE ON THE BIRTHDAY WISH');
  const otherPic = (await upload(stranger.http, await (await photo(300, 300)).jpeg().toBuffer())).data.data;
  const badWish = await own.put('/loyalty/settings', { birthdayWish: true, birthdayMediaId: otherPic.id });
  check('another shop\'s picture for the wish: refused', badWish.status === 400, brief(badWish));
  const wish = await own.put('/loyalty/settings', { birthdayWish: true, birthdayMediaId: pic.id });
  check('the birthday wish gets a picture, shown back with its address', wish.status === 200 && wish.data.data.birthdayMedia?.url === pic.url, brief(wish));
  const today = localDayKey(new Date(), 'Asia/Kolkata');
  const K = await customer({ name: 'Kavya', birthday: birthdayKeysFor(today)[0] });
  await prisma.loyaltySettings.update({ where: { clientId: SHOP }, data: { autoPreparedFor: null } });
  await prepareShopDay(SHOP, new Date(), { ignoreHours: true });
  const bday = await prisma.campaign.findFirst({ where: { clientId: SHOP, source: 'BIRTHDAY', name: { startsWith: 'Birthday wishes' } } });
  check('the day\'s birthday wishes carry the picture, frozen like any campaign', bday?.mediaId === pic.id && (bday?.snapshot as any)?.media?.url === pic.url, bday);
  for (let i = 0; i < 2; i++) await tick();
  const toKavya = sent.find(s => s.idempotencyKey === `CAMPAIGN:${bday?.id}:${K.id}`);
  check('Kavya gets the wish with the picture', toKavya?.image?.url === pic.url && /Kavya/.test(toKavya.text), toKavya);

  // ── H ───────────────────────────────────────────────────────────────────────────────────
  console.log('\nH. CLEARING UNUSED PICTURES; DELETING THE SHOP');
  const unused = (await upload(own, await (await photo(400, 300)).jpeg().toBuffer())).data.data;
  const fresh = (await upload(own, await (await photo(400, 300)).jpeg().toBuffer())).data.data;
  const threeDays = new Date(Date.now() - 3 * 86_400_000);
  await prisma.campaignMedia.updateMany({ where: { id: { in: [unused.id, second.data.data.id, pic.id] } }, data: { createdAt: threeDays } });
  const cleared = await purgeUnusedCampaignMedia(new Date(), { onlyClients: [SHOP] });
  const left = await prisma.campaignMedia.findMany({ where: { clientId: SHOP }, select: { id: true } });
  const has = (id: string) => left.some(l => l.id === id);
  check('an unused 3-day-old picture goes (file and row); the one in use stays; a new one waits', !has(unused.id) && has(pic.id) && has(fresh.id) && cleared >= 1, { cleared, unused: has(unused.id), used: has(pic.id), fresh: has(fresh.id) });
  check('...the 3-day-old picture a draft once had but no longer uses goes too', !has(second.data.data.id));
  // Asked of storage itself, not the public address: the storage network may still hand out a copy
  // for up to its cache time (an hour) after the file is gone.
  const inStorage = async (url: string) => {
    const path = decodeURIComponent(url.split('/object/public/inventory-images/')[1] ?? '');
    const { data } = await supabase.storage.from('inventory-images').download(path);
    return !!data;
  };
  check('...its file is really gone from storage', !(await inStorage(unused.url)));
  // GET, not HEAD: storage answers a HEAD with "no-cache" whatever the file's own setting.
  const cached = await axios.get(pic.url, { validateStatus: () => true, responseType: 'arraybuffer' });
  check('pictures are cached for an hour, not a year (so a deleted one does not linger)', /max-age=3600\b/.test(String(cached.headers['cache-control'])), cached.headers['cache-control']);

  const mediaPaths = (await prisma.campaignMedia.findMany({ where: { clientId: SHOP }, select: { url: true } })).map(m => m.url);
  await platformAdminService.deleteClientCompletely(SHOP, SHOP);
  check('deleting the shop removes its pictures, templates and campaigns', (await prisma.campaignMedia.count({ where: { clientId: SHOP } })) === 0
    && (await prisma.campaignTemplate.count({ where: { clientId: SHOP } })) === 0 && (await prisma.campaign.count({ where: { clientId: SHOP } })) === 0);
  const after = await Promise.all(mediaPaths.map(inStorage));
  check(`...and the ${mediaPaths.length} picture files in storage`, after.every(x => !x), after);
}

main()
  .catch(e => { failures.push(`suite stopped: ${(e as Error).stack ?? e}`); console.log(`\nSTOPPED: ${(e as Error).message}`); })
  .finally(async () => {
    await platformAdminService.deleteClientCompletely(SHOP, SHOP).catch(() => {});
    await platformAdminService.deleteClientCompletely(OTHER, OTHER).catch(() => {});
    console.log(`\nRESULT: ${passed} passed | ${failures.length} failed`);
    if (failures.length) console.log(failures.map(f => `  - ${f}`).join('\n'));
    await prisma.$disconnect();
    process.exit(failures.length ? 1 : 0);
  });
