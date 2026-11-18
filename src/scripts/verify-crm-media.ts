/**
 * Campaign pictures for ScaleEzy CRM (18 Nov 2026): campaigns are made in CRM, Inventory keeps preparing and
 * storing their pictures. Real signed service tokens against the real routes, one throwaway shop with CRM on
 * (and one without), removed at the end with its pictures:
 *   1. who may: the modules:crm scope, a shop with CRM on, the token's own shop, a named ACTIVE person who may
 *      send messages (campaign:send or crm:messages:send);
 *   2. an upload: the same checks and words as the app's own picture route (empty, not base64, over 15 MB,
 *      not a picture), and the answer { id, url, width, height, byteSize } of a real JPEG under 1 MB;
 *   3. a product photo as the picture, and the product-photo list (names and photos only, this shop's);
 *   4. housekeeping: a CRM picture nothing in Inventory uses is NEVER removed, an unused upload made in
 *      Inventory still is.
 *
 * The local copy's server is cut off from the real picture storage on purpose (launch.json SUPABASE_URL is
 * http://127.0.0.1:9), so no test ever writes into the live bucket. There a good picture gets as far as being
 * saved and is refused with the app's own words, nothing left behind. Saving itself is the same store() the
 * app's Campaigns screen has used live since 22 Sep. With STORAGE_LIVE=1 (a server that can reach storage)
 * the saved picture is checked too.
 *
 *   DATABASE_URL=<local> DIRECT_URL=<local> VERIFY_API_URL=http://localhost:4036/api/v1 \
 *   CRM_KEY_DIR=<dir with private.pem> npx tsx src/scripts/verify-crm-media.ts
 */
import axios from 'axios';
import fs from 'node:fs';
import jwt from 'jsonwebtoken';
import sharp from 'sharp';
import { prisma } from '../lib/prisma';
import { AuthService } from '../services/auth.service';
import { seedRolesForClient } from '../services/rbac-seed.service';
import { platformAdminService } from '../services/platform-admin.service';
import { purgeUnusedCampaignMedia } from '../services/campaigns';
import { UNUSED_RETENTION_MS } from '../services/campaigns/media';

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

const privateKey = fs.readFileSync(`${process.env.CRM_KEY_DIR}/private.pem`, 'utf8');
const tokenFor = (claims: { clientId?: string; userId?: string; scope?: string[] } = {}) => ({
  Authorization: `Bearer ${jwt.sign({
    sub: 'scaleezy-crm-test', scope: claims.scope ?? ['modules:crm'],
    ...(claims.clientId ? { clientId: claims.clientId } : {}),
    ...(claims.userId ? { onBehalfOf: { userId: claims.userId } } : {})
  }, privateKey, { algorithm: 'RS256', audience: 'inventory', issuer: 'scaleezy-crm-test', keyid: 'test-1', expiresIn: '5m' })}`
});
const crm = (path: string, shop = SHOP) => `/internal/modules/crm/shops/${shop}${path}`;

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

  // A real photo: 2400 x 1800, so it must be made smaller; and a product with it as its photo.
  const jpeg = await sharp({ create: { width: 2400, height: 1800, channels: 3, background: '#8b1a2b' } }).jpeg({ quality: 92 }).toBuffer();
  const b64 = jpeg.toString('base64');

  console.log('\n1. WHO MAY');
  let r = await call('POST', crm('/campaign-media'), tokenFor({ scope: ['session:read'] }), { base64: b64 });
  check('a token without modules:crm: refused', r.status === 403 && /modules:crm/.test(r.data?.message), brief(r));
  r = await call('POST', crm('/campaign-media', OTHER), as(theirs, OTHER), { base64: b64 });
  check('a shop that has not switched CRM on: 404 in words', r.status === 404 && r.data?.message === 'This shop has not switched CRM on.', brief(r));
  r = await call('POST', crm('/campaign-media'), as(theirs, OTHER), { base64: b64 });
  check('a token for another shop: refused', r.status === 403 && /another shop/.test(r.data?.message), brief(r));
  r = await call('POST', crm('/campaign-media'), tokenFor(), { base64: b64 });
  check('nobody named: refused (a picture is made FOR a person)', r.status === 403 && /Say who this is for/.test(r.data?.message), brief(r));
  r = await call('POST', crm('/campaign-media'), as(store), { base64: b64 });
  check('a storekeeper (may not send messages): refused, naming both permissions', r.status === 403 && r.data?.message === 'That person may not do this in Inventory (needs campaign:send or crm:messages:send).', brief(r));
  r = await call('POST', crm('/campaign-media'), as(gone), { base64: b64 });
  check('a person whose account is switched off: refused', r.status === 403 && /switched off/.test(r.data?.message), brief(r));
  r = await call('GET', crm('/product-photos'), as(store));
  check('the product-photo list needs the same permission', r.status === 403, brief(r));
  check('nothing was stored by any refused call', (await prisma.campaignMedia.count({ where: { clientId: { in: [SHOP, OTHER] } } })) === 0);

  console.log('\n2. AN UPLOAD');
  const words = async (body: any) => (await call('POST', crm('/campaign-media'), as(owner), body));
  r = await words({});
  check('no picture: 400 "Choose a picture to upload."', r.status === 400 && r.data?.message === 'Choose a picture to upload.', brief(r));
  r = await words({ base64: 'not base64 at all!' });
  check('not base64: 400 "The picture could not be read. Choose it again."', r.status === 400 && r.data?.message === 'The picture could not be read. Choose it again.', brief(r));
  r = await words({ base64: Buffer.from('this is a text file, not a picture').toString('base64') });
  check('base64 of something that is not a picture: 400 in words, no file stored', r.status === 400 && typeof r.data?.message === 'string' && !/sharp|vips|Error:/i.test(r.data.message) && (await prisma.campaignMedia.count({ where: { clientId: SHOP } })) === 0, brief(r));
  r = await words({ base64: 'A'.repeat(16 * 1024 * 1024 * 4 / 3) });
  check('over 15 MB: refused in words (never decoded)', [400, 413].includes(r.status) && /larger than 15 MB/.test(r.data?.message), brief(r));
  r = await words({ base64: `data:image/jpeg;base64,${b64}`, byName: 'ignored' });
  const up = r.data?.data;
  const STORAGE = process.env.STORAGE_LIVE === '1';
  if (STORAGE) {
    check('a 2400 x 1800 photo (as a data: address): 200, exactly { id, url, width, height, byteSize }', r.status === 200 && Object.keys(up ?? {}).sort().join() === 'byteSize,height,id,url,width', brief(r));
    check('...made ready for WhatsApp: at most 1,600 px on its longer side, under 1 MB', up?.width === 1600 && up?.height === 1200 && up?.byteSize > 0 && up?.byteSize < 1024 * 1024, up);
    const row = up?.id ? await prisma.campaignMedia.findUnique({ where: { id: up.id } }) : null;
    check('...kept for this shop, marked source CRM, made by the person named', row?.clientId === SHOP && row?.source === 'CRM' && row?.createdById === owner.id, row);
  } else {
    check('a good 2400 x 1800 photo passes every check and reaches the saving step: there (storage cut off here) the app\'s own words, 503, nothing left behind',
      r.status === 503 && r.data?.message === 'The picture could not be saved just now. Please try again.' && (await prisma.campaignMedia.count({ where: { clientId: SHOP } })) === 0, brief(r));
  }

  console.log('\n3. A PRODUCT PHOTO AS THE PICTURE');
  const product = await prisma.product.create({ data: { clientId: SHOP, productCode: `CM-${STAMP}`, slug: `cm-${STAMP}`, title: 'Kanchi silk saree', category: 'WOMEN' as any, productType: 'READY_TO_WEAR' as any, basePrice: 9000, status: 'ACTIVE' as any } as any });
  // A photo "in our storage": the address starts with this server's own storage (the cut-off one here).
  const ourPhoto = up?.url ?? `${process.env.LOCAL_STORAGE_URL ?? 'http://127.0.0.1:9'}/storage/v1/object/public/inventory-images/test/${STAMP}.jpg`;
  const image = await prisma.productImage.create({ data: { productId: product.id, url: ourPhoto, imageType: 'GALLERY' as any, orderIndex: 0, isPrimary: true } as any });
  await prisma.product.create({ data: { clientId: SHOP, productCode: `CM2-${STAMP}`, slug: `cm2-${STAMP}`, title: 'No photo yet', category: 'WOMEN' as any, productType: 'READY_TO_WEAR' as any, basePrice: 100, status: 'ACTIVE' as any } as any });
  r = await call('GET', crm('/product-photos'), as(owner));
  const list = r.data?.data ?? [];
  check('the list: this shop\'s products that HAVE photos, with names and photos only', r.status === 200 && list.length === 1 && list[0].id === product.id && list[0].title === 'Kanchi silk saree'
    && JSON.stringify(Object.keys(list[0]).sort()) === '["id","images","title"]' && list[0].images[0]?.id === image.id && JSON.stringify(Object.keys(list[0].images[0]).sort()) === '["id","url"]', brief(r));
  r = await call('GET', crm('/product-photos?q=kanchi'), as(owner));
  check('...searched by name ("kanchi" finds it, any letter case)', r.data?.data?.length === 1);
  r = await call('GET', crm('/product-photos?q=zzz-nothing'), as(owner));
  check('...a search that matches nothing: an empty list, not an error', r.status === 200 && Array.isArray(r.data?.data) && r.data.data.length === 0, brief(r));
  r = await call('POST', crm('/campaign-media/from-product'), as(owner), { productImageId: image.id });
  const fromP = r.data?.data;
  if (STORAGE) {
    const pRow = fromP?.id ? await prisma.campaignMedia.findUnique({ where: { id: fromP.id } }) : null;
    check('from a product photo: 200, the same answer, source CRM, the product remembered', r.status === 200 && Object.keys(fromP ?? {}).sort().join() === 'byteSize,height,id,url,width' && pRow?.source === 'CRM' && pRow?.productId === product.id, brief(r));
  } else {
    check('from this shop\'s own product photo: it passes every check and goes to fetch it from our storage (cut off here: 503 in words)', r.status === 503 && r.data?.message === 'That product photo could not be loaded just now. Please try again.', brief(r));
  }
  r = await call('POST', crm('/campaign-media/from-product'), as(owner), { productImageId: 'nope' });
  check('a photo id that is not one: 400 "Choose one of the product photos."', r.status === 400 && r.data?.message === 'Choose one of the product photos.', brief(r));
  const otherProduct = await prisma.product.create({ data: { clientId: OTHER, productCode: `OT-${STAMP}`, slug: `ot-${STAMP}`, title: 'Theirs', category: 'WOMEN' as any, productType: 'READY_TO_WEAR' as any, basePrice: 1, status: 'ACTIVE' as any } as any });
  const otherImage = await prisma.productImage.create({ data: { productId: otherProduct.id, url: ourPhoto, imageType: 'GALLERY' as any, orderIndex: 0, isPrimary: true } as any });
  r = await call('POST', crm('/campaign-media/from-product'), as(owner), { productImageId: otherImage.id });
  check('another shop\'s product photo: 404 "That product photo was not found."', r.status === 404 && r.data?.message === 'That product photo was not found.', brief(r));
  const outside = await prisma.productImage.create({ data: { productId: product.id, url: 'https://example.com/elsewhere.jpg', imageType: 'GALLERY' as any, orderIndex: 1, isPrimary: false } as any });
  r = await call('POST', crm('/campaign-media/from-product'), as(owner), { productImageId: outside.id });
  check('a photo stored somewhere else: refused in words (never fetched)', r.status === 400 && /not stored with ScaleEzy/.test(r.data?.message), brief(r));

  console.log('\n4. INVENTORY\'S HOUSEKEEPING NEVER REMOVES CRM\'S PICTURES');
  const old = new Date(Date.now() - UNUSED_RETENTION_MS - 86_400_000);
  // CRM's pictures as the routes record them (source CRM; one from a product), three days old, used by nothing
  // Inventory can see. With real storage they were made above; here they are written as the routes would.
  if (!STORAGE) {
    await prisma.campaignMedia.create({ data: { id: '00000000-0000-4000-8000-00000000c001', clientId: SHOP, storagePath: `whatsapp-media/crm-a-${STAMP}.jpg`, url: 'https://example.invalid/a.jpg', width: 1600, height: 1200, byteSize: 90000, source: 'CRM', createdById: owner.id } });
    await prisma.campaignMedia.create({ data: { id: '00000000-0000-4000-8000-00000000c002', clientId: SHOP, storagePath: `whatsapp-media/crm-b-${STAMP}.jpg`, url: 'https://example.invalid/b.jpg', width: 1600, height: 1200, byteSize: 90000, source: 'CRM', productId: product.id, createdById: owner.id } });
  }
  const crmIds = STORAGE ? [up?.id, fromP?.id] : ['00000000-0000-4000-8000-00000000c001', '00000000-0000-4000-8000-00000000c002'];
  await prisma.campaignMedia.updateMany({ where: { clientId: SHOP }, data: { createdAt: old } });
  // An unused picture made in Inventory itself, as old: that one must still go.
  const own = await prisma.campaignMedia.create({ data: { clientId: SHOP, storagePath: `whatsapp-media/test-${STAMP}.jpg`, url: 'https://example.invalid/x.jpg', width: 1, height: 1, byteSize: 1, source: 'UPLOAD', createdAt: old } });
  const removed = await purgeUnusedCampaignMedia(new Date(), { onlyClients: [SHOP] });
  const left = await prisma.campaignMedia.findMany({ where: { clientId: SHOP }, select: { id: true, source: true } });
  check('three days old, used by nothing Inventory can see: CRM\'s two pictures stay', left.filter(x => x.source === 'CRM').length === 2 && crmIds.every(id => left.some(x => x.id === id)), left);
  check('...while an unused upload made in Inventory is still cleared, as before', removed === 1 && !left.some(x => x.id === own.id), { removed, left });
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
