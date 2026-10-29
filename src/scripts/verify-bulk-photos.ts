/**
 * Photos for many products at once (29 Oct): matching a folder of photos by name, the sheet's Photos
 * column, photos fetched from links (and the links that must be refused), and publishing after.
 *
 * Through the local server's real routes (verify-suites-tenant, token cookies). Storage is the local
 * stand-in (SUPABASE_URL=http://127.0.0.1:18200), never the real bucket, and the "website" with photos
 * on it is the stand-in on 18201 (PHOTO_LINKS_TEST_ORIGIN). Start both with scratchpad photo-standins.mjs.
 *
 * LOCAL DATABASE ONLY.
 *   DATABASE_URL=… DIRECT_URL=… ROLE_TOKENS=<old scratchpad>/local-tokens.json npx tsx src/scripts/verify-bulk-photos.ts
 */
const LOCAL = 'localhost:55433';
if (!String(process.env.DATABASE_URL || '').includes(LOCAL) || !String(process.env.DIRECT_URL || '').includes(LOCAL)) {
  console.error(`Refusing to run: DATABASE_URL and DIRECT_URL must both point at the local copy (${LOCAL}).`);
  process.exit(2);
}
import fs from 'node:fs';

let passed = 0, failed = 0;
const failures: string[] = [];
const check = (name: string, ok: boolean, detail?: unknown) => {
  if (ok) { passed++; console.log(`  [PASS] ${name}`); }
  else { failed++; failures.push(name); console.log(`  [FAIL] ${name}${detail === undefined ? '' : `  -> ${JSON.stringify(detail).slice(0, 400)}`}`); }
};
const eq = (name: string, got: unknown, want: unknown) => check(name, JSON.stringify(got) === JSON.stringify(want), { got, want });

const STAMP = Date.now().toString(36).toUpperCase();
const C = 'verify-suites-tenant', OTHER = `photos-other-${STAMP}`;
const SITE = 'http://127.0.0.1:18201';

(async () => {
  const { prisma } = await import('../lib/prisma');
  const { isPrivateAddress, directLink } = await import('../services/product-photos');
  const api = 'http://localhost:4016/api/v1';
  const tokens: Record<string, string> = JSON.parse(fs.readFileSync(process.env.ROLE_TOKENS!, 'utf8'));
  const call = (who: string, method: string, path: string, body?: unknown) =>
    fetch(`${api}${path}`, { method, headers: { 'content-type': 'application/json', origin: 'http://localhost:5183', cookie: `token=${tokens[who]}` }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) })
      .then(async r => ({ status: r.status, body: await r.json().catch(() => null) as any }));
  const owner = (method: string, path: string, body?: unknown) => call('SUPER_ADMIN', method, path, body);
  const made: string[] = [];
  let otherProductId = '';

  try {
    // Health of the stand-ins first: a suite against the real bucket must not even start.
    const st = await fetch('http://127.0.0.1:18200/storage/v1/object/public/inventory-images/none').then(r => r.status).catch(() => 0);
    if (st !== 404) throw new Error('The storage stand-in on 18200 is not running (start photo-standins.mjs).');

    console.log('\n1. THE SHEET\'S PHOTOS COLUMN');
    const skuA = (c: string, s: string) => `BP${STAMP}-${c}-${s}`;
    const rows = [
      { rowNumber: 2, productKey: `bp-a-${STAMP}`, title: `Bulk Photo Kanchi ${STAMP}`, category: 'WOMEN', basePrice: 9000, sku: skuA('RED', 'FS'), size: 'Free Size', color: 'Red' },
      { rowNumber: 3, productKey: `bp-a-${STAMP}`, sku: skuA('RED', 'L'), size: 'L', color: 'Red' },
      { rowNumber: 4, productKey: `bp-a-${STAMP}`, sku: skuA('GRN', 'FS'), size: 'Free Size', color: 'Green' },
      { rowNumber: 5, productKey: `bp-b-${STAMP}`, title: `Bulk Photo Kurti ${STAMP}`, category: 'WOMEN', basePrice: 1500, sku: `BQ${STAMP}-M`, size: 'M',
        photos: [`${SITE}/red.jpg`, `${SITE}/green.png`, `${SITE}/red.jpg`] },
      { rowNumber: 6, productKey: `bp-b-${STAMP}`, sku: `BQ${STAMP}-L`, size: 'L', photos: [`${SITE}/red.jpg`] }
    ];
    const bad = (photos: unknown) => owner('POST', '/products/import/validate', { rows: [{ ...rows[0], photos }] });
    let v = await bad(['http://example.com/a.jpg']);
    check('a plain http link is refused before anything is imported', !v.body?.data?.canApply && /not an https web link/.test(JSON.stringify(v.body?.data?.errors)), v.body);
    v = await bad(['ftp://example.com/a.jpg']);
    check('an ftp link is refused', !v.body?.data?.canApply, v.body?.data?.errors);
    v = await bad(['photo of the red one']);
    check('words that are not a link are refused', !v.body?.data?.canApply, v.body?.data?.errors);
    v = await bad(Array.from({ length: 6 }, (_, i) => `https://example.com/${i}.jpg`));
    check('six links on one row are refused (five at most)', /Keep it to 5/.test(JSON.stringify(v.body?.data?.errors)), v.body?.data?.errors);
    v = await bad('https://example.com/a.jpg');
    check('Photos that is not a list is refused', !v.body?.data?.canApply, v.body?.data?.errors);

    const plan = await owner('POST', '/products/import/validate', { rows });
    check('the good file can be imported', plan.body?.data?.canApply === true, plan.body);
    check('the preview says the photo links are added next', /photo links are added next/.test(JSON.stringify(plan.body?.data?.warnings)), plan.body?.data?.warnings);
    const applied = await owner('POST', '/products/import/apply', { rows, fingerprint: plan.body.data.fingerprint });
    const d = applied.body?.data;
    check('the import went in', applied.status === 200 && d?.createdProducts === 2, applied.body);
    const A = await prisma.product.findFirstOrThrow({ where: { clientId: C, title: `Bulk Photo Kanchi ${STAMP}` }, include: { variants: true } });
    const B = await prisma.product.findFirstOrThrow({ where: { clientId: C, title: `Bulk Photo Kurti ${STAMP}` }, include: { variants: true } });
    made.push(A.id, B.id);
    eq('it names both products it touched', [...(d?.productIds ?? [])].sort(), [A.id, B.id].sort());
    eq('the links come back once per product, duplicates dropped, rows merged', d?.photoLinks, [{ productId: B.id, colour: null, urls: [`${SITE}/red.jpg`, `${SITE}/green.png`] }]);
    eq('both arrive as drafts', [A.status, B.status], ['DRAFT', 'DRAFT']);

    console.log('\n2. MATCHING A FOLDER BY NAME');
    const redIds = A.variants.filter(x => x.colorName === 'Red').map(x => x.id).sort();
    const greenIds = A.variants.filter(x => x.colorName === 'Green').map(x => x.id);
    const names = [
      `${skuA('RED', 'FS')}.jpg`,                 // 0 a SKU: its colour, every size of it
      `${A.productCode}-green-2.JPG`,              // 1 code, colour, number
      `${A.productCode} Green (3).jpeg`,           // 2 spaces and a bracketed number, as a phone names copies
      `${A.productCode}.png`,                      // 3 the piece as a whole
      `${A.productCode.toLowerCase()}_red.webp`,   // 4 lower case and underscores
      `nothing-${STAMP}.jpg`,                      // 5 no such product
      'IMG_1234.HEIC',                             // 6 iPhone photo
      'notes.txt',                                 // 7 not a photo
      `Sarees/new stock/${skuA('GRN', 'FS')}.jpg`, // 8 a path from a folder pick
      `${A.productCode}-purple.jpg`,               // 9 a colour this product does not have
      `${A.productCode}-2.jpg`,                    // 10 a number on the code alone
      `${A.productCode}-21.jpg`                    // 11 past the 20 photos a set may number
    ];
    const m = await owner('POST', '/product-photos/match', { names });
    const f = m.body?.data?.files ?? [];
    check('the names are matched', m.status === 200 && f.length === names.length, m.body);
    const pick = (i: number) => ({ s: f[i]?.status, p: f[i]?.productId, c: f[i]?.colour, n: f[i]?.position });
    eq('a SKU -> its product, colour Red', pick(0), { s: 'MATCHED', p: A.id, c: 'Red', n: null });
    eq('... and every size of Red, not only the one in the name', [...(f[0]?.variantIds ?? [])].sort(), redIds);
    eq('code-green-2 -> Green, photo 2', pick(1), { s: 'MATCHED', p: A.id, c: 'Green', n: 2 });
    eq('"code Green (3)" -> Green, photo 3', pick(2), { s: 'MATCHED', p: A.id, c: 'Green', n: 3 });
    eq('the code alone -> the whole piece', pick(3), { s: 'MATCHED', p: A.id, c: null, n: null });
    eq('lower case with an underscore still matches', pick(4), { s: 'MATCHED', p: A.id, c: 'Red', n: null });
    eq('a name of nothing is unmatched', f[5]?.status, 'UNMATCHED');
    check('an iPhone HEIC photo is refused with what to do', f[6]?.status === 'NOT_A_PHOTO' && /HEIC/.test(f[6]?.reason), f[6]);
    eq('a text file is not a photo', f[7]?.status, 'NOT_A_PHOTO');
    check('a folder path is reduced to the file name, and still matches', f[8]?.name === `${skuA('GRN', 'FS')}.jpg` && f[8]?.colour === 'Green' && JSON.stringify(f[8]?.variantIds) === JSON.stringify(greenIds), f[8]);
    eq('a colour the product does not have is unmatched, not guessed', f[9]?.status, 'UNMATCHED');
    eq('code-2 -> the whole piece, photo 2', pick(10), { s: 'MATCHED', p: A.id, c: null, n: 2 });
    eq('code-21 is not taken as photo 21', f[11]?.status, 'UNMATCHED');
    check('the product\'s title and code come back for the list', f[0]?.productTitle === A.title && f[0]?.productCode === A.productCode, f[0]);
    check('drafts still without a photo include B (nothing in the folder for it)', (m.body?.data?.withoutPhotos ?? []).some((x: any) => x.id === B.id), m.body?.data?.withoutPhotos?.length);
    check('... and not A, which this folder covers', !(m.body?.data?.withoutPhotos ?? []).some((x: any) => x.id === A.id));

    // A product code that ends in digits must be the code, not "code minus a photo number".
    const whole = await owner('POST', '/product-photos/match', { names: [`${B.productCode}.jpg`] });
    eq(`${B.productCode}.jpg is that product, not ${B.productCode.replace(/-\d+$/, '')} photo ${B.productCode.split('-').pop()}`, [whole.body?.data?.files?.[0]?.productId, whole.body?.data?.files?.[0]?.position], [B.id, null]);

    // Another shop's SKU is not this shop's.
    const other = await prisma.product.create({ data: { clientId: OTHER, productCode: `PRD-O${STAMP}`, slug: `o-${STAMP}`, title: 'Theirs', category: 'WOMEN' as any, productType: 'READY_TO_WEAR' as any, basePrice: 100,
      variants: { create: { clientId: OTHER, sku: `THEIRS-${STAMP}`, variantCode: `VO-${STAMP}`, colorName: 'Red' } } } });
    otherProductId = other.id;
    const theirs = await owner('POST', '/product-photos/match', { names: [`THEIRS-${STAMP}.jpg`, `PRD-O${STAMP}.jpg`] });
    eq('another shop\'s SKU and code match nothing here', theirs.body?.data?.files?.map((x: any) => x.status), ['UNMATCHED', 'UNMATCHED']);

    eq('no names -> refused', (await owner('POST', '/product-photos/match', { names: [] })).status, 400);
    eq('not a list -> refused', (await owner('POST', '/product-photos/match', { names: 'a.jpg' })).status, 400);
    const many = await owner('POST', '/product-photos/match', { names: Array.from({ length: 1001 }, (_, i) => `${i}.jpg`) });
    check('1,001 names -> refused, saying the limit', many.status === 400 && /1000/.test(many.body?.message), many.body);
    const sales = await call('SALES', 'POST', '/product-photos/match', { names: ['a.jpg'] });
    eq('somebody who may not change products cannot use it', sales.status, 403);

    console.log('\n3. UPLOADING A MATCHED PHOTO (THE BROWSER\'S WAY), THEN THE SAME FOLDER AGAIN');
    const name0 = names[0];
    const prep = await owner('POST', `/products/${A.id}/images/upload-url`, { fileName: name0 });
    const { storagePath, signedUrl, publicUrl } = prep.body?.data ?? {};
    check('storage hands out an upload address (the stand-in, never the real bucket)', String(signedUrl).startsWith('http://127.0.0.1:18200/'), signedUrl);
    const jpeg = await fetch(`${SITE}/red.jpg`).then(r => r.arrayBuffer());
    const put = await fetch(signedUrl, { method: 'PUT', body: Buffer.from(jpeg), headers: { 'content-type': 'image/jpeg' } });
    eq('the bytes go up once', put.status, 200);
    for (const variantId of f[0].variantIds) {
      const reg = await owner('POST', `/products/${A.id}/images`, { url: publicUrl, storagePath, fileName: name0, fileSize: jpeg.byteLength, altText: name0, isPrimary: true, imageType: 'GALLERY', orderIndex: 0, variantId });
      check(`registered for ${A.variants.find(x => x.id === variantId)?.size}`, reg.status === 201 || reg.status === 200, reg.body);
    }
    const aImgs = await prisma.productImage.findMany({ where: { productId: A.id } });
    check('one file, one row per size of Red, all pointing at it', aImgs.length === 2 && new Set(aImgs.map(i => i.storagePath)).size === 1 && aImgs.every(i => i.isPrimary), aImgs.map(i => [i.variantId, i.isPrimary]));
    const again = await owner('POST', '/product-photos/match', { names: [name0, names[1]] });
    eq('the same folder again: that photo is marked already added, the other is not', again.body?.data?.files?.map((x: any) => !!x.already), [true, false]);

    console.log('\n4. PHOTOS FROM LINKS');
    const link = (url: string, extra: Record<string, unknown> = {}) => owner('POST', '/product-photos/from-link', { productId: B.id, url, position: 1, ...extra });
    let r = await link(`${SITE}/red.jpg`);
    check('a JPG link is fetched, stored and added', r.status === 200 && r.body?.data?.registered === 1 && r.body?.data?.already === false, r.body);
    check('it went to the storage stand-in', fs.existsSync(`C:/Users/HP/AppData/Local/Temp/claude/D--villy-inventory/3a9af89a-c63e-40d7-b55a-2e611cb491cb/scratchpad/storage-standin/inventory-images/${r.body?.data?.storagePath}`), r.body?.data?.storagePath);
    eq('it names the product and that it is a draft, for the publish step', [r.body?.data?.productTitle, r.body?.data?.productStatus], [B.title, 'DRAFT']);
    r = await link(`${SITE}/red.jpg`);
    eq('the same link again adds nothing (a sheet imported twice)', [r.status, r.body?.data?.registered, r.body?.data?.already], [200, 0, true]);
    eq('a PNG link, photo 2', (await link(`${SITE}/green.png`, { position: 2 })).body?.data?.registered, 1);
    eq('a WebP link, photo 3', (await link(`${SITE}/blue.webp`, { position: 3 })).body?.data?.registered, 1);
    eq('a link that moves once (302) is followed to the photo', (await link(`${SITE}/moved`, { position: 4 })).body?.data?.registered, 1);
    const bImgs = await prisma.productImage.findMany({ where: { productId: B.id }, orderBy: { orderIndex: 'asc' } });
    eq('B: four photos in order, only the first is the main one', bImgs.map(i => [i.orderIndex, i.isPrimary]), [[0, true], [1, false], [2, false], [3, false]]);
    check('each stored file name carries the link\'s fingerprint', bImgs.every(i => /^link-[0-9a-f]{12}\.(jpg|png|webp)$/.test(String(i.fileName))), bImgs.map(i => i.fileName));

    r = await link(`${SITE}/red.jpg`, { productId: A.id, colour: 'green', position: 1 });
    const aGreen = await prisma.productImage.findMany({ where: { productId: A.id, variantId: { in: greenIds } } });
    check('a link for a colour goes on that colour (any spelling of it)', r.body?.data?.registered === greenIds.length && aGreen.length === greenIds.length, r.body);
    check('... and is Green\'s main photo, though Red already has its own', aGreen.every(i => i.isPrimary), aGreen.map(i => [i.orderIndex, i.isPrimary]));
    eq('Red keeps its main photo', await prisma.productImage.count({ where: { productId: A.id, variantId: { in: redIds }, isPrimary: true } }), redIds.length);

    const refused = async (what: string, url: string, says: RegExp, extra: Record<string, unknown> = {}) => {
      const x = await link(url, extra);
      check(`refused: ${what}`, x.status === 400 && says.test(x.body?.message ?? ''), { status: x.status, message: x.body?.message });
    };
    await refused('a web page pretending to be a JPG (a sign-in page)', `${SITE}/sign-in-page.jpg`, /not a JPG, PNG or WebP/);
    await refused('a photo that says it is 20 MB', `${SITE}/says-big.jpg`, /bigger than 15 MB/);
    await refused('16 MB with no size given (counted as it arrives)', `${SITE}/really-big.jpg`, /bigger than 15 MB/);
    await refused('a link that is gone (404)', `${SITE}/gone.jpg`, /answered 404/);
    await refused('a link that redirects for ever', `${SITE}/round`, /too many times/);
    await refused('a redirect to this very server (plain http)', `${SITE}/to-this-server`, /Only https/);
    await refused('a redirect to the cloud metadata address', `${SITE}/to-metadata`, /not a public address/);
    await refused('a redirect to localhost', `${SITE}/to-localhost`, /not a public address/);
    await refused('this machine, directly', 'https://127.0.0.1/x.jpg', /not a public address/);
    await refused('this machine over IPv6', 'https://[::1]/x.jpg', /not a public address/);
    await refused('an IPv4 address dressed as IPv6', 'https://[::ffff:7f00:1]/x.jpg', /not a public address/);
    await refused('a private network address', 'https://10.1.2.3/x.jpg', /not a public address/);
    await refused('the cloud metadata address, directly', 'https://169.254.169.254/latest/meta-data/', /not a public address/);
    await refused('the test website on a different port', 'http://127.0.0.1:18200/storage/v1/object/public/x', /Only https/);
    await refused('plain http', 'http://example.com/a.jpg', /Only https/);
    await refused('a link with a password in it', 'https://user:pw@example.com/a.jpg', /password/);
    await refused('an unusual port', 'https://example.com:8443/a.jpg', /not a normal public address/);
    await refused('a website that does not exist', `https://no-such-host-${STAMP.toLowerCase()}.invalid/a.jpg`, /could not be found/);
    await refused('a colour the product does not have', `${SITE}/red.jpg`, /no colour called Purple/, { productId: A.id, colour: 'Purple' });
    await refused('not a link at all', 'the red one', /not a web link/);
    const theirsLink = await link(`${SITE}/red.jpg`, { productId: otherProductId });
    eq('another shop\'s product cannot be given a photo', theirsLink.status, 404);
    const noFile = await prisma.productImage.count({ where: { productId: otherProductId } });
    eq('... and nothing was added to it', noFile, 0);
    eq('somebody who may not change products cannot add links', (await call('SALES', 'POST', '/product-photos/from-link', { productId: B.id, url: `${SITE}/red.jpg` })).status, 403);

    console.log('\n5. THE ADDRESS RULES THEMSELVES');
    for (const [ip, want] of [['127.0.0.1', true], ['10.0.0.1', true], ['172.16.5.4', true], ['172.32.0.1', false], ['192.168.1.1', true], ['169.254.169.254', true], ['100.64.0.1', true],
      ['0.0.0.0', true], ['224.0.0.1', true], ['8.8.8.8', false], ['::1', true], ['fd00::1', true], ['fe80::1', true], ['::ffff:127.0.0.1', true], ['::ffff:7f00:1', true], ['::ffff:8.8.8.8', false], ['2606:4700::1111', false]] as const) {
      eq(`${ip} is ${want ? 'private' : 'public'}`, isPrivateAddress(ip), want);
    }
    eq('a Google Drive share link becomes its download', directLink('https://drive.google.com/file/d/AbC123/view?usp=sharing'), 'https://drive.google.com/uc?export=download&id=AbC123');
    eq('a Dropbox link asks for the file, not the page', directLink('https://www.dropbox.com/s/xyz/saree.jpg?dl=0'), 'https://www.dropbox.com/s/xyz/saree.jpg?dl=1');
    eq('any other link is left as it is', directLink('https://cdn.example.com/a.jpg'), 'https://cdn.example.com/a.jpg');

    console.log('\n6. PICKING A PRODUCT BY HAND');
    const found = await owner('GET', `/product-photos/find?q=${encodeURIComponent(`Kanchi ${STAMP}`)}`);
    const hit = (found.body?.data ?? []).find((x: any) => x.id === A.id);
    check('found by name', !!hit, found.body);
    eq('with its colours and their sizes', hit?.colours?.map((c: any) => [c.colour, c.variantIds.length]).sort(), [['Green', 1], ['Red', 2]]);
    check('found by SKU too', ((await owner('GET', `/product-photos/find?q=${skuA('GRN', 'FS')}`)).body?.data ?? []).some((x: any) => x.id === A.id));
    eq('one letter finds nothing (too vague)', (await owner('GET', '/product-photos/find?q=K')).body?.data, []);
    eq('another shop\'s products are not found', ((await owner('GET', `/product-photos/find?q=THEIRS-${STAMP}`)).body?.data ?? []).length, 0);

    console.log('\n7. PUBLISHING THE ONES WITH PHOTOS');
    const pub = await owner('POST', '/products/bulk-status', { ids: [A.id, B.id], status: 'ACTIVE' });
    eq('both publish', pub.body?.data?.changed, 2);
    const after = await prisma.product.findMany({ where: { id: { in: [A.id, B.id] } }, select: { status: true } });
    check('both are on sale now', after.every(p => p.status === 'ACTIVE'), after);
  } catch (e: any) {
    check(`the suite reached the end (stopped at: ${String(e?.message ?? e).split('\n')[0]})`, false);
  } finally {
    // Removed again: photos, sizes, the products, and the other shop's one.
    const ids = [...made, otherProductId].filter(Boolean);
    await prisma.productImage.deleteMany({ where: { productId: { in: ids } } }).catch(() => null);
    await prisma.product.deleteMany({ where: { id: { in: ids } } }).catch((e: any) => console.log('cleanup:', e?.message));
    await prisma.$disconnect();
    console.log(`\nRESULT: ${passed} passed, ${failed} failed`);
    if (failures.length) console.log(failures.map(x => `  - ${x}`).join('\n'));
    process.exit(failed ? 1 : 0);
  }
})();
