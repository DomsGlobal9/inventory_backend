/**
 * remove-back-views.ts, run for real on a throwaway shop in the LOCAL database (29 Oct).
 *
 * The shapes it has to get right: a whole old set (front, left, right, back); a colour whose only
 * generated picture is its back, which was therefore its main photograph; a shop's own photograph
 * on the same colour; a product on Shopify (queued again) and one that is not. Then a dry run
 * changes nothing, the real run takes only the backs, keeps every file, writes a backup that
 * holds them, and a second run finds nothing to do.
 *
 *   DATABASE_URL=<local> DIRECT_URL=<local> npx tsx src/scripts/verify-remove-back-views.ts
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { prisma } from '../lib/prisma';

const LOCAL = 'localhost:55433';
if (!String(process.env.DATABASE_URL).includes(LOCAL) || !String(process.env.DIRECT_URL).includes(LOCAL)) {
  console.error(`Refusing to run: DATABASE_URL and DIRECT_URL must point at the local copy (${LOCAL}).`);
  process.exit(2);
}

let passed = 0; const failures: string[] = [];
const check = (n: string, ok: boolean, d?: unknown) => {
  if (ok) { passed++; console.log(`  ok   ${n}`); } else { failures.push(n); console.log(`  FAIL ${n}${d === undefined ? '' : ' -- ' + JSON.stringify(d).slice(0, 300)}`); }
};
const STAMP = Date.now().toString(36);
const SHOP = `backview-${STAMP}`;
const BACKUP = fs.mkdtempSync(path.join(os.tmpdir(), 'backviews-'));
const run = (...args: string[]) => execFileSync('npx', ['tsx', 'src/scripts/remove-back-views.ts', `--client=${SHOP}`, ...args], {
  cwd: path.join(__dirname, '..', '..'), env: { ...process.env, BACKUP_DIR: BACKUP }, shell: true
}).toString();

async function main() {

  const mk = (title: string) => prisma.product.create({ data: { clientId: SHOP, title, productCode: `BV-${title}-${STAMP}`, slug: `bv-${title.toLowerCase()}-${STAMP}`, category: 'WOMEN', productType: 'READY_TO_WEAR', dressType: title, fabric: 'Silk', basePrice: 1000, status: 'ACTIVE', hsnCode: '5007', taxRateBps: 500, taxSlabbed: false, priceIsExclusive: false } as any });
  const v = (productId: string, colour: string) => prisma.productVariant.create({ data: { productId, clientId: SHOP, colorName: colour, size: 'Free Size', variantCode: `BV-${colour}-${STAMP}-${Math.random().toString(36).slice(2, 6)}`, sku: `BVS-${colour}-${STAMP}-${Math.random().toString(36).slice(2, 6)}`, sellingPrice: 1000 } as any });
  const img = (productId: string, variantId: string, view: string | null, opts: { primary?: boolean; generated?: boolean; order?: number } = {}) =>
    prisma.productImage.create({ data: { productId, variantId, url: `https://local.invalid/${STAMP}/${variantId}/${view ?? 'own'}.jpg`, storagePath: `${SHOP}/${variantId}/${view ?? 'own'}.jpg`, generated: opts.generated ?? true, view, isPrimary: opts.primary ?? false, orderIndex: opts.order ?? 0, imageType: 'GALLERY' } as any });

  // A: a whole old set, on Shopify.
  const a = await mk('Saree'); const red = await v(a.id, 'Red');
  for (const [i, view] of ['front', 'left', 'right', 'back'].entries()) await img(a.id, red.id, view, { primary: view === 'front', order: i });
  // Hung on whichever Shopify installation the local copy has; only this mirror row is made and removed.
  const install = await prisma.shopifyInstallation.findFirst({ select: { id: true } });
  if (install) await prisma.shopifyProductMirror.create({ data: { clientId: SHOP, installationId: install.id, productId: a.id, status: 'SYNCED', wanted: true } });
  else console.log('    (no local Shopify installation: the re-push check is skipped)');
  // B: only a back was made, so it leads; the shop's own photograph sits beside it.
  const b = await mk('Lehenga'); const blue = await v(b.id, 'Blue');
  await img(b.id, blue.id, 'back', { primary: true, order: 3 });
  const own = await img(b.id, blue.id, null, { generated: false, order: 0 });

  const before = await prisma.productImage.count({ where: { product: { clientId: SHOP } } });
  console.log('\nDry run');
  const dry = run();
  check('says 2 back views on 2 products, 1 of them a main photograph', /2 back views on 2 products/.test(dry) && /1 of them are a colour's main photograph/.test(dry), dry);
  check('...and changes nothing', await prisma.productImage.count({ where: { product: { clientId: SHOP } } }) === before);

  console.log('\nThe real run');
  const out = run('--apply');
  const rows = await prisma.productImage.findMany({ where: { product: { clientId: SHOP } }, select: { productId: true, view: true, generated: true, isPrimary: true, storagePath: true } });
  check('every back view is gone', !rows.some(r => r.view === 'back'), rows);
  check('the Red set keeps front, left and right; front still leads', JSON.stringify(rows.filter(r => r.productId === a.id).map(r => `${r.view}${r.isPrimary ? '*' : ''}`).sort()) === JSON.stringify(['front*', 'left', 'right']), rows);
  check("Blue: the shop's own photograph is kept and now leads", rows.filter(r => r.productId === b.id).length === 1 && rows.find(r => r.productId === b.id)?.isPrimary === true && !rows.find(r => r.productId === b.id)?.generated, rows.filter(r => r.productId === b.id));
  check('own photograph untouched (same row)', !!(await prisma.productImage.findUnique({ where: { id: own.id } })));
  const mirror = await prisma.shopifyProductMirror.findFirst({ where: { productId: a.id }, select: { status: true } }).catch(() => null);
  if (mirror) check('the Shopify product is queued to be sent again', mirror.status === 'PENDING', mirror);
  const files = fs.readdirSync(BACKUP).filter(f => f.endsWith('.json'));
  const saved = files.length ? JSON.parse(fs.readFileSync(path.join(BACKUP, files[0]), 'utf8')) : [];
  check('a backup holds both removed rows, with their files named', files.length === 1 && saved.length === 2 && saved.every((r: any) => r.view === 'back' && r.storagePath && r.url), saved);
  check('it reports what it did', /removed 2/.test(out) && /back views left: 0/.test(out), out);

  console.log('\nRun again');
  check('nothing left to do', /0 back views on 0 products/.test(run('--apply')));
}

main()
  .catch(e => { failures.push(`stopped: ${e?.message ?? e}`); console.log('STOPPED:', e?.message ?? e); })
  .finally(async () => {
    await prisma.shopifyProductMirror.deleteMany({ where: { clientId: SHOP } }).catch(() => {});
    await prisma.productImage.deleteMany({ where: { product: { clientId: SHOP } } }).catch(() => {});
    await prisma.productVariant.deleteMany({ where: { clientId: SHOP } }).catch(() => {});
    await prisma.product.deleteMany({ where: { clientId: SHOP } }).catch(() => {});
    fs.rmSync(BACKUP, { recursive: true, force: true });
    console.log(`\nRESULT: ${passed} passed | ${failures.length} failed`);
    await prisma.$disconnect();
    process.exit(failures.length ? 1 : 0);
  });
