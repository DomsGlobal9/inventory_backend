/**
 * Instant updates for what a POS till shows (25 Nov 2026): the shop's settings, its stores, loyalty settings, offer
 * codes, store prices and product photos now announce a change on the live line, which pos-push turns into
 * catalogue.changed for the shop's till. Against the REAL local database: listen on inventory_live, touch each table
 * of a throwaway shop, and expect exactly that shop and the right topic. Local only; everything it makes is removed.
 *   DATABASE_URL=<local> DIRECT_URL=<local> npx tsx src/scripts/verify-live-till-settings.ts
 */
import { Client } from 'pg';
import { prisma } from '../lib/prisma';

for (const k of ['DATABASE_URL', 'DIRECT_URL']) {
  if (!/localhost:55433/.test(process.env[k] ?? '')) { console.error(`Refusing: ${k} is not the local database.`); process.exit(2); }
}
const S = Date.now().toString(36);
const C = `livetill-${S}`;
let bad = 0, good = 0;
const check = (n: string, ok: boolean, d: unknown = '') => { ok ? good++ : bad++; console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${n}${ok ? '' : ' :: ' + JSON.stringify(d)}`); };

async function main() {
  const heard: { c: string; t: string }[] = [];
  const pg = new Client({ connectionString: process.env.DIRECT_URL });
  await pg.connect();
  await pg.query('LISTEN inventory_live');
  pg.on('notification', m => { try { heard.push(JSON.parse(m.payload ?? '{}')); } catch { /* not ours */ } });
  const wait = () => new Promise(r => setTimeout(r, 400));
  const after = async (what: () => Promise<unknown>) => { heard.length = 0; await what(); await wait(); return heard.filter(h => h.c === C).map(h => h.t); };

  const store = await prisma.stockLocation.create({ data: { clientId: C, code: `LT-${S}`, name: 'Main', type: 'STORE' as any, active: true } });
  const p = await prisma.product.create({ data: { clientId: C, productCode: `LT-${S}`, slug: `lt-${S}`, title: 'Saree', category: 'WOMEN' as any, productType: 'READY_TO_WEAR' as any, basePrice: 1000, status: 'ACTIVE' as any, publishedAt: new Date(), sellInShop: true } as any });
  const v = await prisma.productVariant.create({ data: { clientId: C, productId: p.id, variantCode: `LTV-${S}`, sku: `LTS-${S}`, sellingPrice: 1000 } as any });

  check('shop settings (bill details, GSTIN, logo): "settings"', (await after(() => prisma.clientSettings.create({ data: { clientId: C, businessName: 'Live Till Shop' } as any }))).includes('settings'));
  check('...changed again: "settings"', (await after(() => prisma.clientSettings.update({ where: { clientId: C }, data: { businessName: 'Live Till Shop 2' } as any }))).includes('settings'));
  check('a store renamed (name and address print on bills): "settings"', (await after(() => prisma.stockLocation.update({ where: { id: store.id }, data: { name: 'Main store' } }))).includes('settings'));
  check('a store price for one item: "products"', (await after(() => prisma.variantLocationProfile.create({ data: { variantId: v.id, locationId: store.id, priceOverride: 900 } as any }))).includes('products'));
  check('a product photo added: "products"', (await after(() => prisma.productImage.create({ data: { productId: p.id, url: 'https://example.invalid/x.jpg', orderIndex: 0, imageType: 'GALLERY' } as any }))).includes('products'));
  check('loyalty settings: "settings"', (await after(async () => { await prisma.$executeRawUnsafe(`INSERT INTO loyalty_settings (client_id, updated_at) VALUES ($1, now()) ON CONFLICT DO NOTHING`, C); }).catch(() => [])).includes('settings'));
  const other = await after(() => prisma.clientSettings.update({ where: { clientId: C }, data: { businessName: 'x' } as any }));
  check('...and only THIS shop is named (no other shop told)', heard.every(h => h.c === C) && other.length >= 1, heard);

  await pg.end();
}

async function cleanup() {
  await prisma.$executeRawUnsafe(`DELETE FROM inventory_product_images WHERE product_id IN (SELECT id FROM inventory_products WHERE client_id = $1)`, C).catch(() => undefined);
  await prisma.$executeRawUnsafe(`DELETE FROM variant_location_profiles WHERE variant_id IN (SELECT id FROM inventory_product_variants WHERE client_id = $1)`, C).catch(() => undefined);
  const tables = await prisma.$queryRaw<{ table_name: string }[]>`SELECT DISTINCT table_name FROM information_schema.columns WHERE table_schema = 'public' AND column_name = 'client_id'`;
  for (let round = 0; round < 6; round++) {
    let left = 0;
    for (const t of tables) { try { await prisma.$executeRawUnsafe(`DELETE FROM "${t.table_name}" WHERE client_id = $1`, C); } catch { left++; } }
    if (!left) break;
  }
}

main()
  .catch(e => { bad++; console.error('CRASH', e); })
  .finally(async () => { await cleanup().catch(e => console.error('cleanup failed', e)); console.log(`${good} passed, ${bad} problems`); await prisma.$disconnect(); process.exit(bad ? 1 : 0); });
