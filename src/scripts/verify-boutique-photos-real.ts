/**
 * Photo upload for the boutique (POST /photos and the 10 MB check on save), proven against the REAL storage -- the
 * bucket the live app uses, because the local server's storage is switched off. Throwaway files under
 * boutique-phototest-<stamp>/ only, all deleted at the end (the answer prints the emptied folder). The database is
 * the LOCAL one. Runs only when asked: REAL_STORAGE=1.
 *   REAL_STORAGE=1 DATABASE_URL=<local> DIRECT_URL=<local> BOUTIQUE_KEY_DIR=<dir> npx tsx src/scripts/verify-boutique-photos-real.ts
 * (SUPABASE_URL and its key come from backend/.env.)
 */
import fs from 'node:fs';
if (process.env.REAL_STORAGE !== '1') { console.error('Refusing: this writes (and then deletes) test files in the REAL storage. Set REAL_STORAGE=1 to run it.'); process.exit(2); }
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import axios from 'axios';
import jwt from 'jsonwebtoken';
import { supabase } from '../lib/supabase';
import { photoUploads, checkOwnPhotos } from '../services/boutique/more';
import { prisma } from '../lib/prisma';

let good = 0, bad = 0;
const check = (n: string, ok: boolean, d: unknown = '') => { ok ? good++ : bad++; console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${n}${ok ? '' : ' :: ' + JSON.stringify(d).slice(0, 400)}`); };
const S = Date.now().toString(36);
const clientId = `boutique-phototest-${S}`;
const made: string[] = [];
const pathOf = (u: string) => decodeURIComponent(u.split('/object/public/inventory-images/')[1] ?? '');

/** A real 64x48 PNG (maroon), made here so the test needs no file on disk. */
function png(w: number, h: number) {
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (b: Buffer) => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (t: string, d: Buffer) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const raw = Buffer.alloc((w * 3 + 1) * h); for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) raw.set([128, 0, 0], y * (w * 3 + 1) + 1 + x * 3);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

(async () => {
  if (!/supabase\.co/.test(process.env.SUPABASE_URL ?? '')) throw new Error('SUPABASE_URL is not the real storage');
  if (!/localhost:55433/.test(process.env.DATABASE_URL ?? '')) throw new Error('database must be local');
  const actor = { clientId, name: 'Photo test', can: ['products:write'] };
  const img = png(64, 48);

  console.log('UPLOAD LINKS FROM OUR CODE, BYTES TO THE REAL STORAGE');
  const links = await photoUploads(actor, { files: [{ name: 'Maroon silk (front).png', contentType: 'image/png', size: img.length }, { name: 'back', contentType: 'image/jpeg', size: 10 }] });
  check('two upload links, each under this shop\'s boutique folder, names made safe', links.files.length === 2 && links.files.every(f => pathOf(f.publicUrl).startsWith(`${clientId}/boutique/`)) && /Maroon-silk-front-\.png$|Maroon-silk-front\.png$/.test(pathOf(links.files[0].publicUrl)), links.files.map(f => pathOf(f.publicUrl)));
  made.push(...links.files.map(f => pathOf(f.publicUrl)));
  const put = await axios.put(links.files[0].uploadUrl, img, { headers: { 'Content-Type': 'image/png' }, validateStatus: () => true, maxBodyLength: Infinity });
  check('the picture is accepted by the storage at its link', put.status === 200, [put.status, put.data]);
  const got = await axios.get(links.files[0].publicUrl, { responseType: 'arraybuffer', validateStatus: () => true });
  check('its public link gives back exactly the same bytes, as a PNG', got.status === 200 && Buffer.compare(Buffer.from(got.data), img) === 0 && String(got.headers['content-type']).includes('image/png'), [got.status, got.headers['content-type']]);
  const again = await axios.put(links.files[0].uploadUrl, png(8, 8), { headers: { 'Content-Type': 'image/png' }, validateStatus: () => true });
  check('the same link used a second time cannot replace the picture', again.status >= 400, again.status);
  const got2 = await axios.get(links.files[0].publicUrl, { responseType: 'arraybuffer', validateStatus: () => true });
  check('...the picture is still the first one', Buffer.compare(Buffer.from(got2.data), img) === 0);
  const forged = links.files[1].uploadUrl.replace(/token=[^&]+/, 'token=' + crypto.randomBytes(16).toString('hex'));
  const f = await axios.put(forged, img, { headers: { 'Content-Type': 'image/png' }, validateStatus: () => true });
  check('a link with a made-up token is refused', f.status >= 400, f.status);

  console.log('\nTHE 10 MB LIMIT');
  const big = (await photoUploads(actor, { files: [{ name: 'big', contentType: 'image/jpeg', size: 9 * 1024 * 1024 }] })).files[0];
  made.push(pathOf(big.publicUrl));
  const tooBig = await axios.put(big.uploadUrl, Buffer.alloc(11 * 1024 * 1024, 7), { headers: { 'Content-Type': 'image/jpeg' }, validateStatus: () => true, maxBodyLength: Infinity, maxContentLength: Infinity });
  console.log(`  note: 11 MB sent to a link asked for as 9 MB -> storage answered ${tooBig.status} (storage does not cap it)`);
  const why = async (urls: string[], cid = clientId) => { try { await checkOwnPhotos(cid, urls); return 'passed'; } catch (e: any) { return `${e.statusCode} ${e.message}`; } };
  check('saving an item with the 11 MB photo: refused, in words', /over 10 MB/.test(await why([big.publicUrl])));
  const stillThere = await axios.head(big.publicUrl, { validateStatus: () => true });
  check('...and the oversized photo was deleted from storage', stillThere.status >= 400, stillThere.status);
  check('the good photo passes the check', (await why([links.files[0].publicUrl])) === 'passed');
  check('a photo link from another shop\'s folder: 403', /^403 .*another shop/.test(await why([links.files[0].publicUrl], `boutique-someone-else-${S}`)));
  check('a link that was asked for but never uploaded: refused, in words', /was not uploaded/.test(await why([links.files[1].publicUrl])));
  check('a link to the boutique\'s own website is left alone', (await why(['https://cdn.example.com/a.jpg'])) === 'passed');

  console.log('\nTHE ITEM CARRIES THE PICTURE (local server)');
  const key = fs.readFileSync(`${process.env.BOUTIQUE_KEY_DIR}/private.pem`, 'utf8');
  const tenant = `phototest-${S}`;
  const pass = () => jwt.sign({ sub: 'crm-b', scope: ['modules:boutique'], tenant, onBehalfOf: { userId: 'u1', name: 'Photo test', can: ['products:write', 'stock:write'] } }, key, { algorithm: 'RS256', audience: 'inventory', issuer: 'scaleezy-boutique-test', keyid: 'btq-1', expiresIn: '5m' });
  const api = (m: string, p: string, d?: unknown) => axios.request({ method: m, url: `http://localhost:4036/api/v1/internal/boutique${p}`, data: d, validateStatus: () => true, headers: { Authorization: `Bearer ${pass()}`, 'Idempotency-Key': `photo-${S}-${Math.random().toString(36).slice(2)}` } });
  await api('POST', '/link', { shopName: 'Photo Test' });
  const saved = await api('PUT', `/items/PH-${S}`, { name: 'Kanchi silk', category: 'FABRIC', unit: 'METER', sellingPrice: 450, imageUrls: [links.files[0].publicUrl, 'http://not-https.example/x.jpg'] });
  const item = (await api('GET', `/items/PH-${S}`)).data?.data;
  check('the item keeps the uploaded picture as its cover, and drops a non-https link', saved.status === 201 && item?.imageUrls?.length === 1 && item.imageUrls[0] === links.files[0].publicUrl, item?.imageUrls);
})()
  .catch(e => { bad++; console.error('CRASH', e?.message ?? e); })
  .finally(async () => {
    const { error } = await supabase.storage.from('inventory-images').remove(made.filter(Boolean));
    const left = await supabase.storage.from('inventory-images').list(`${clientId}/boutique`, { limit: 10 });
    console.log(`\nremoved test files: ${error ? 'ERROR ' + error.message : 'ok'}; folder now ${JSON.stringify((left.data ?? []).map(x => x.name))}`);
    const links = await prisma.boutiqueLink.findMany({ where: { tenant: { startsWith: 'phototest-' } }, select: { clientId: true } });
    for (const l of links) {
      const tables = await prisma.$queryRaw<{ table_name: string }[]>`SELECT DISTINCT table_name FROM information_schema.columns WHERE table_schema='public' AND column_name='client_id'`;
      await prisma.$executeRawUnsafe(`DELETE FROM inventory_product_images WHERE product_id IN (SELECT id FROM inventory_products WHERE client_id = $1)`, l.clientId).catch(() => undefined);
      for (let r = 0; r < 8; r++) { let n = 0; for (const t of tables) { try { await prisma.$executeRawUnsafe(`DELETE FROM "${t.table_name}" WHERE client_id = $1`, l.clientId); } catch { n++; } } if (!n) break; }
    }
    console.log(`${good} passed, ${bad} problems`);
    await prisma.$disconnect(); process.exit(bad ? 1 : 0);
  });
