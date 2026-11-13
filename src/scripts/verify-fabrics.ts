/**
 * Fabrics by the metre, backend worst cases (13 Nov 2026, PLAN-fabrics.md). LOCAL database and LOCAL server only.
 * Settings and products go through the real routes (VERIFY_API_URL); stock, the till, the feeds, offers and the
 * online shop's bag through the real services in this process. A throwaway shop, removed at the end.
 *
 *   DATABASE_URL=<local> DIRECT_URL=<local> VERIFY_API_URL=http://localhost:4036/api/v1 npx tsx src/scripts/verify-fabrics.ts
 */
import { prisma } from '../lib/prisma';
import { AuthService } from '../services/auth.service';
import { seedRolesForClient } from '../services/rbac-seed.service';
import { inventoryMutationService } from '../services/inventory-mutation.service';
import { storefrontCatalogueService } from '../services/storefront-catalogue.service';
import { applySale } from '../services/pos/pos-events.service';
import { priceBasket } from '../services/pricing/engine';
import { priceBag } from '../services/online-shop/checkout';
import { storedPrice } from '../lib/units';

for (const k of ['DATABASE_URL', 'DIRECT_URL']) {
  if (!/localhost:55433/.test(process.env[k] ?? '')) { console.error(`Refusing: ${k} is not the local database.`); process.exit(2); }
}
const BASE = process.env.VERIFY_API_URL || 'http://localhost:4036/api/v1';
if (!/localhost|127\.0\.0\.1/.test(BASE)) { console.error('Refusing: not a local server.'); process.exit(2); }
const STAMP = Date.now();
const SHOP = `fabric-${STAMP}`;
let passed = 0, failed = 0;
const check = (name: string, ok: boolean, detail = '') => {
  if (ok) { passed++; console.log(`  ok   ${name}`); } else { failed++; console.log(`  FAIL ${name} -- ${detail}`); }
};
const said = async (p: Promise<unknown>) => { try { await p; return null; } catch (e: any) { return String(e?.message ?? e); } };

async function main() {
  const roles = await seedRolesForClient(SHOP);
  const hash = await AuthService.hashPassword('Same-Pass-123');
  const owner = await prisma.user.create({ data: { clientId: SHOP, email: `fabric-${STAMP}@example.com`, name: 'Fabric Owner', password: hash, status: 'ACTIVE' as any } });
  await prisma.userRole.create({ data: { userId: owner.id, roleId: roles.SUPER_ADMIN } });
  const token = AuthService.generateToken({ userId: owner.id, clientId: SHOP });
  const api = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(`${BASE}${path}`, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, Origin: 'http://localhost:5183' }, body: body ? JSON.stringify(body) : undefined });
    const j: any = await res.json().catch(() => ({}));
    return { status: res.status, data: j?.data, message: j?.message ?? j?.error?.message ?? '' };
  };
  const store = await prisma.stockLocation.create({ data: { clientId: SHOP, name: 'Main', code: `FB-${STAMP}`, type: 'STORE' as any, active: true } });
  const fabricBody = (over: Record<string, unknown> = {}) => ({ title: `Maroon silk ${Math.random().toString(36).slice(2, 6)}`, category: 'WOMEN', productType: 'READY_TO_WEAR', basePrice: storedPrice(450, 'METRE'), status: 'ACTIVE', soldBy: 'METRE', kind: 'FABRIC', widthCm: 112, ...over });

  console.log('A. THE SHOP\'S SWITCH');
  let r = await api('GET', '/fabrics');
  check('off by default, smallest cut 0.25 m, quick lengths 1 / 2.5 / 5.5 m', r.status === 200 && r.data.fabricsOn === false && r.data.fabricMinCut === 25 && JSON.stringify(r.data.fabricQuickLengths) === '[100,250,550]', JSON.stringify(r.data ?? r));
  r = await api('POST', '/products', fabricBody());
  check('switch off: a product sold by the metre is refused, in words', r.status === 409 && /Settings/.test(r.message), `${r.status} ${r.message}`);
  r = await api('PUT', '/fabrics', { fabricMinCut: 0 });
  check('a smallest cut of 0 is refused', r.status === 400, `${r.status} ${r.message}`);
  r = await api('PUT', '/fabrics', { fabricQuickLengths: [250, 100, 100, 550] });
  check('quick lengths are tidied (no repeats, in order)', r.status === 200 && JSON.stringify(r.data.fabricQuickLengths) === '[100,250,550]', JSON.stringify(r.data ?? r.message));
  r = await api('PUT', '/fabrics', { fabricsOn: true });
  check('the owner switches it on', r.status === 200 && r.data.fabricsOn === true, JSON.stringify(r.data ?? r.message));

  console.log('\nB. PRODUCTS');
  r = await api('POST', '/products', fabricBody({ soldBy: 'KILOGRAM' }));
  check('a unit not offered yet (kilogram) is refused', r.status === 400 && /not offered yet/.test(r.message), `${r.status} ${r.message}`);
  r = await api('POST', '/products', fabricBody({ kind: 'NOT_A_KIND' }));
  check('an unknown kind is refused', r.status === 400, `${r.status} ${r.message}`);
  r = await api('POST', '/products', fabricBody({ minCut: 50, rollSize: 2500 }));
  const fabric = r.data;
  check('switch on: Maroon silk sold by the metre, 0.5 m cut, rolls of 25 m', r.status === 201 && fabric?.soldBy === 'METRE' && fabric?.minCut === 50 && fabric?.rollSize === 2500 && fabric?.kind === 'FABRIC', `${r.status} ${r.message} ${JSON.stringify(fabric)?.slice(0, 200)}`);
  r = await api('POST', '/products', { ...fabricBody({ soldBy: 'PACKET', kind: 'HOOKS', minCut: 50, rollSize: 2500 }), basePrice: 120 });
  check('a packet product: the smallest cut and roll size do not apply (cleared)', r.status === 201 && r.data?.soldBy === 'PACKET' && r.data?.minCut === null && r.data?.rollSize === null, JSON.stringify(r.data ?? r.message));
  const packet = r.data;
  r = await api('POST', `/products/${fabric.id}/variants`, { sku: `MS-${STAMP}-MAR`, colorName: 'Maroon', size: 'Free', sellingPrice: storedPrice(450, 'METRE'), costPrice: storedPrice(280, 'METRE') });
  const variant = r.data;
  check('a colour added: reorder level starts at 10 m (1000 cm), not 5 cm', r.status === 201 && variant?.reorderLevel === 1000, `${r.status} ${r.message} ${variant?.reorderLevel}`);

  console.log('\nC. STOCK');
  await inventoryMutationService.applyMovement({ clientId: SHOP, variantId: variant.id, locationId: store.id, movementType: 'IN' as any, reason: 'PURCHASE', quantityDelta: 2500, unitCost: storedPrice(280, 'METRE')! });
  const roll = await said(inventoryMutationService.applyMovement({ clientId: SHOP, variantId: variant.id, locationId: store.id, movementType: 'IN' as any, reason: 'PURCHASE', quantityDelta: 1173, unitCost: storedPrice(280, 'METRE')! }));
  check('a roll end of 11.73 m comes in (receiving is whatever was measured)', roll === null, String(roll));
  const v1 = await prisma.productVariant.findUnique({ where: { id: variant.id }, select: { averageCost: true } });
  check('average cost stays ₹280 per metre (2.80 per cm), the price code untouched', Math.abs(Number(v1?.averageCost) - 2.8) < 0.001, String(v1?.averageCost));
  const tiny = await said(inventoryMutationService.applyMovement({ clientId: SHOP, variantId: variant.id, locationId: store.id, movementType: 'OUT' as any, reason: 'SALE', quantityDelta: -3 }));
  check('selling 0.03 m is refused with the nearest lengths', !!tiny && /smallest cut \(0\.50 m\)/.test(tiny) && /0\.50 m/.test(tiny), String(tiny));
  const odd = await said(inventoryMutationService.applyMovement({ clientId: SHOP, variantId: variant.id, locationId: store.id, movementType: 'OUT' as any, reason: 'SALE', quantityDelta: -225 }));
  check('2.25 m with a 0.5 m smallest cut is refused (2.00 or 2.50)', !!odd && /2\.00 m or 2\.50 m/.test(odd), String(odd));
  const ok = await said(inventoryMutationService.applyMovement({ clientId: SHOP, variantId: variant.id, locationId: store.id, movementType: 'OUT' as any, reason: 'SALE', quantityDelta: -250 }));
  check('2.50 m sells', ok === null, String(ok));
  const waste = await said(inventoryMutationService.applyMovement({ clientId: SHOP, variantId: variant.id, locationId: store.id, movementType: 'OUT' as any, reason: 'DAMAGE', quantityDelta: -7 }));
  check('7 cm written off as damaged is fine (not a sale)', waste === null, String(waste));
  const back = await said(inventoryMutationService.applyMovement({ clientId: SHOP, variantId: variant.id, locationId: store.id, movementType: 'IN' as any, reason: 'CUSTOMER_RETURN', quantityDelta: 100 }));
  check('cut cloth is not taken back by default, and the message says how to allow it', !!back && /not taken back/.test(back) && /Cut cloth can be returned/.test(back), String(back));
  r = await api('PATCH', `/products/${fabric.id}`, { cutReturnable: true });
  if (r.status === 404) r = await api('PUT', `/products/${fabric.id}`, { cutReturnable: true });
  const back2 = await said(inventoryMutationService.applyMovement({ clientId: SHOP, variantId: variant.id, locationId: store.id, movementType: 'IN' as any, reason: 'CUSTOMER_RETURN', quantityDelta: 100 }));
  check('...once the owner allows it on the product, it comes back', back2 === null && r.status === 200, `${r.status} ${r.message} / ${back2}`);
  r = await api('PATCH', `/products/${fabric.id}`, { soldBy: 'PIECE' });
  if (r.status === 404) r = await api('PUT', `/products/${fabric.id}`, { soldBy: 'PIECE' });
  check('the unit cannot change once there is stock (old bills keep their meaning)', r.status === 409 && /cannot change/.test(r.message), `${r.status} ${r.message}`);
  r = await api('PUT', '/fabrics', { fabricsOn: false });
  check('the switch cannot go off while products are sold by the metre/packet', r.status === 409, `${r.status} ${r.message}`);

  console.log('\nD. WHO SEES CLOTH');
  const scope = { clientId: SHOP, locationIds: [] as string[] };
  const feed = await storefrontCatalogueService.listProducts(scope, { limit: 100 });
  check('other websites\' feed and the till\'s catalogue: no metre product (they count pieces)', !feed.products.some((p: any) => p.productCode === fabric.productCode), JSON.stringify(feed.products.map((p: any) => p.productCode)));
  const one = await storefrontCatalogueService.getProduct(scope, fabric.productCode);
  check('...not even asked for by its code', one === null);
  const ours = await storefrontCatalogueService.getProduct(scope, fabric.productCode, { withLengths: true });
  check('our online shop sees it, sold by the metre with its cut and width', ours?.soldBy === 'METRE' && ours?.minCut === 50 && ours?.widthCm === 112, JSON.stringify(ours && { soldBy: ours.soldBy, minCut: ours.minCut, widthCm: ours.widthCm }));
  const till = await applySale(SHOP, store.id, { invoiceNo: `T-${STAMP}`, lines: [{ itemCode: variant.variantCode, qty: 250, lineTotalPaise: 112500 }], payments: [], at: new Date().toISOString() } as any);
  check('a till bill naming it is refused in words (the till cannot sell lengths yet)', (till as any).answer === 'UNKNOWN_ITEM' && /metre/.test((till as any).detail), JSON.stringify(till));

  console.log('\nE. OFFERS');
  const mk = (valueType: any, value: number, extra: any = {}) => ({ id: valueType, versionId: null, name: valueType, trigger: 'AUTOMATIC' as const, couponCode: null, level: 'LINE' as const, valueType, value, maxDiscount: null, scope: 'ALL' as const, targets: [], minSubtotalMinor: null, minQuantity: null, priority: 1, stackable: false, createdAt: new Date(), ...extra });
  const line = { variantId: variant.id, productId: fabric.id, category: 'WOMEN', quantity: 250, listUnitPriceMinor: 450, measured: true };
  const pct = priceBasket([line], [mk('PERCENTAGE', 10)]);
  check('10% off 2.50 m at ₹450/m: ₹1,125 - ₹112.50 = ₹1,012.50', pct.lines[0].lineTotalMinor === 101250, String(pct.lines[0].lineTotalMinor));
  const each = priceBasket([line], [mk('FIXED_AMOUNT', 5000, { perPiece: true })]);
  check('"₹50 off each" does not touch cloth (it would be ₹50 per cm)', each.lines[0].lineTotalMinor === 112500, String(each.lines[0].lineTotalMinor));
  const fixed = priceBasket([line], [mk('FIXED_PRICE', 99900)]);
  check('a fixed-price offer does not touch cloth', fixed.lines[0].lineTotalMinor === 112500, String(fixed.lines[0].lineTotalMinor));
  const buy3 = priceBasket([line], [mk('PERCENTAGE', 10, { minQuantity: 3 })]);
  check('"buy 3" does not count 250 cm as 250 items (one line = one item)', buy3.lines[0].lineTotalMinor === 112500, String(buy3.lines[0].lineTotalMinor));

  console.log('\nF. THE ONLINE SHOP\'S BAG');
  await prisma.onlineShop.create({ data: { clientId: SHOP, slug: `fabric-${STAMP}`, isLive: true, acceptsOrders: true, payOnDelivery: true, locationIds: [store.id] } as any });
  const bagWords = async (q: number) => said(priceBag(SHOP, [{ variantCode: variant.variantCode, quantity: q }]));
  check('a bag with 0.03 m is refused, naming the cloth', /Maroon silk.*smallest cut/.test(String(await bagWords(3))), String(await bagWords(3)));
  check('a bag with 2.50 m prices', (await bagWords(250)) === null, String(await bagWords(250)));
  const priced: any = await priceBag(SHOP, [{ variantCode: variant.variantCode, quantity: 250 }]).catch(e => ({ e: String(e?.message) }));
  check('...at ₹1,125 for 2.50 m', JSON.stringify(priced).includes('1125'), JSON.stringify(priced).slice(0, 300));
  check('more than 100 m on one line is refused', /at most 100\.00 m/.test(String(await bagWords(10_050))), String(await bagWords(10_050)));
  void packet;
}

main()
  .catch(e => { failed++; console.error('CRASHED', e); })
  .finally(async () => {
    await prisma.onlineShop.deleteMany({ where: { clientId: SHOP } });
    await prisma.inventoryTransaction.deleteMany({ where: { clientId: SHOP } });
    await prisma.inventoryStock.deleteMany({ where: { clientId: SHOP } });
    await prisma.productVariant.deleteMany({ where: { clientId: SHOP } });
    await prisma.product.deleteMany({ where: { clientId: SHOP } });
    await prisma.stockLocation.deleteMany({ where: { clientId: SHOP } });
    await prisma.clientSettings.deleteMany({ where: { clientId: SHOP } });
    const users = await prisma.user.findMany({ where: { clientId: SHOP }, select: { id: true } });
    await prisma.userRole.deleteMany({ where: { userId: { in: users.map(u => u.id) } } });
    await prisma.user.deleteMany({ where: { clientId: SHOP } });
    const roleIds = (await prisma.role.findMany({ where: { clientId: SHOP }, select: { id: true } })).map(x => x.id);
    await prisma.rolePermission.deleteMany({ where: { roleId: { in: roleIds } } });
    await prisma.role.deleteMany({ where: { clientId: SHOP } });
    const left = await prisma.product.count({ where: { clientId: SHOP } });
    check('nothing left behind', left === 0, String(left));
    console.log(`\n${passed} passed, ${failed} failed`);
    await prisma.$disconnect();
    process.exit(failed ? 1 : 0);
  });
