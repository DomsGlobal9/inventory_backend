/**
 * The same photograph is never registered twice for the same colour (13 Nov 2026, image.service addImage).
 * Swathy Reddy's shop had 16 sarees showing one photo twice: the same camera file saved twice a few seconds apart.
 * Over the real route of a LOCAL server (VERIFY_API_URL), on a throwaway shop:
 *
 *   A  the same file (name + size) for the same colour, twice -> one photo, the first one handed back
 *   B  three times quickly, side by side -> still one
 *   C  a different file, the same file with a different size, another colour, the product as a whole, another
 *      product -> each its own photo (nothing real is swallowed)
 *   D  generated views with the same name -> each kept (every generation is its own picture)
 *
 *   DATABASE_URL=<local> DIRECT_URL=<local> VERIFY_API_URL=http://localhost:4036/api/v1 npx tsx src/scripts/verify-photo-once.ts
 */
import { prisma } from '../lib/prisma';
import { AuthService } from '../services/auth.service';
import { seedRolesForClient } from '../services/rbac-seed.service';

for (const k of ['DATABASE_URL', 'DIRECT_URL']) {
  if (!/localhost:55433/.test(process.env[k] ?? '')) { console.error(`Refusing: ${k} is not the local database.`); process.exit(2); }
}
const BASE = process.env.VERIFY_API_URL || 'http://localhost:4036/api/v1';
if (!/localhost|127\.0\.0\.1/.test(BASE)) { console.error('Refusing: not a local server.'); process.exit(2); }
const STAMP = Date.now();
const SHOP = `photo-once-${STAMP}`;
let passed = 0, failed = 0;
const check = (name: string, ok: boolean, detail = '') => {
  if (ok) { passed++; console.log(`  ok   ${name}`); } else { failed++; console.log(`  FAIL ${name} -- ${detail}`); }
};

async function main() {
  const roles = await seedRolesForClient(SHOP);
  const hash = await AuthService.hashPassword('Same-Pass-123');
  const u = await prisma.user.create({ data: { clientId: SHOP, email: `photo-once-${STAMP}@example.com`, name: 'Photo Tester', password: hash, status: 'ACTIVE' as any } });
  await prisma.userRole.create({ data: { userId: u.id, roleId: roles.SUPER_ADMIN } });
  const token = AuthService.generateToken({ userId: u.id, clientId: SHOP });
  const mk = async (n: number) => {
    const p = await prisma.product.create({ data: { clientId: SHOP, productCode: `PO-${STAMP}-${n}`, slug: `po-${STAMP}-${n}`, title: `Saree ${n}`, category: 'WOMEN' as any, productType: 'READY_TO_WEAR' as any, basePrice: 1000, status: 'ACTIVE' as any } });
    const red = await prisma.productVariant.create({ data: { productId: p.id, clientId: SHOP, colorName: 'Red', size: 'Free', variantCode: `POV-${STAMP}-${n}-r`, sku: `POS-${STAMP}-${n}-r`, sellingPrice: 1000 } });
    const blue = await prisma.productVariant.create({ data: { productId: p.id, clientId: SHOP, colorName: 'Blue', size: 'Free', variantCode: `POV-${STAMP}-${n}-b`, sku: `POS-${STAMP}-${n}-b`, sellingPrice: 1000 } });
    return { p, red, blue };
  };
  const one = await mk(1), two = await mk(2);
  const add = async (productId: string, body: Record<string, unknown>) => {
    const res = await fetch(`${BASE}/products/${productId}/images`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, Origin: 'http://localhost:5183' }, body: JSON.stringify(body) });
    const j: any = await res.json().catch(() => ({}));
    return { status: res.status, id: j?.data?.id as string | undefined, body: j };
  };
  const photo = (over: Record<string, unknown> = {}) => ({
    url: `https://example.invalid/${SHOP}/${Math.random().toString(36).slice(2)}_DSC3031.JPG`,
    storagePath: `${SHOP}/${one.p.id}/${Date.now()}_${Math.random().toString(36).slice(2)}_DSC3031.JPG`,
    fileName: 'DSC3031.JPG', fileSize: 2_345_678, imageType: 'GALLERY', ...over
  });
  const count = (where: any) => prisma.productImage.count({ where });

  console.log('A. THE SAME PHOTO TWICE');
  const first = await add(one.p.id, photo({ variantId: one.red.id }));
  check('the first one is saved', first.status === 201 && !!first.id, JSON.stringify(first.body).slice(0, 200));
  const again = await add(one.p.id, photo({ variantId: one.red.id }));
  check('the same file again for the same colour: the first one is handed back, nothing new', again.status === 201 && again.id === first.id && await count({ productId: one.p.id, variantId: one.red.id }) === 1, `${again.id} vs ${first.id}, rows ${await count({ productId: one.p.id, variantId: one.red.id })}`);

  console.log('\nB. THREE AT ONCE');
  const burst = await Promise.all([1, 2, 3].map(() => add(one.p.id, photo({ variantId: one.blue.id, fileName: 'BLOUSE.JPG', fileSize: 999_001 }))));
  const blouseRows = await count({ productId: one.p.id, variantId: one.blue.id, fileName: 'BLOUSE.JPG' });
  check('three saves of the same blouse photo at the same moment: at most one row', blouseRows === 1, `${blouseRows} rows; ${burst.map(b => b.status).join(',')}`);

  console.log('\nC. REAL, DIFFERENT PHOTOS ARE ALL KEPT');
  await add(one.p.id, photo({ variantId: one.red.id, fileName: 'DSC3032.JPG' }));
  check('another file name: its own photo', await count({ productId: one.p.id, variantId: one.red.id }) === 2);
  await add(one.p.id, photo({ variantId: one.red.id, fileSize: 2_345_679 }));
  check('the same name but a different size (another picture): its own photo', await count({ productId: one.p.id, variantId: one.red.id }) === 3);
  await add(one.p.id, photo({ variantId: one.blue.id }));
  check('the same file on another colour: its own photo there', await count({ productId: one.p.id, variantId: one.blue.id, fileName: 'DSC3031.JPG' }) === 1);
  await add(one.p.id, photo({}));
  check('the same file on the product as a whole (no colour): its own photo', await count({ productId: one.p.id, variantId: null, fileName: 'DSC3031.JPG' }) === 1);
  await add(two.p.id, photo({ variantId: two.red.id, storagePath: `${SHOP}/${two.p.id}/${Date.now()}_DSC3031.JPG` }));
  check('the same file on another product: its own photo there', await count({ productId: two.p.id, fileName: 'DSC3031.JPG' }) === 1);

  console.log('\nD. GENERATED VIEWS');
  await add(one.p.id, photo({ variantId: one.red.id, generated: true, fileName: 'front.jpg', fileSize: 500_000, view: 'front' }));
  await add(one.p.id, photo({ variantId: one.red.id, generated: true, fileName: 'front.jpg', fileSize: 500_000, view: 'front' }));
  check('two generations with the same name: both kept (each is its own picture)', await count({ productId: one.p.id, variantId: one.red.id, generated: true }) === 2);
}

main()
  .catch(e => { failed++; console.error('CRASHED', e); })
  .finally(async () => {
    await prisma.productImage.deleteMany({ where: { product: { clientId: SHOP } } });
    await prisma.productVariant.deleteMany({ where: { clientId: SHOP } });
    await prisma.product.deleteMany({ where: { clientId: SHOP } });
    const users = await prisma.user.findMany({ where: { clientId: SHOP }, select: { id: true } });
    await prisma.userRole.deleteMany({ where: { userId: { in: users.map(x => x.id) } } });
    await prisma.user.deleteMany({ where: { clientId: SHOP } });
    const roleIds = (await prisma.role.findMany({ where: { clientId: SHOP }, select: { id: true } })).map(r => r.id);
    await prisma.rolePermission.deleteMany({ where: { roleId: { in: roleIds } } });
    await prisma.role.deleteMany({ where: { clientId: SHOP } });
    const left = await prisma.product.count({ where: { clientId: SHOP } }) + await prisma.user.count({ where: { clientId: SHOP } });
    check('nothing left behind', left === 0, String(left));
    console.log(`\n${passed} passed, ${failed} failed`);
    await prisma.$disconnect();
    process.exit(failed ? 1 : 0);
  });
