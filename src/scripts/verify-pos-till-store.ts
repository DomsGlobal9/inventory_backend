/**
 * Which store the POS switch gives the till (25 Nov 2026), against the REAL local database. Found live: Jyoti Atelier's
 * till was given its old EMPTY "Main Store" while every piece sat in "Boutique - 1".
 *
 *   - Main Store empty, another store holds stock: the stocked store;
 *   - Main Store holds stock too: the Main Store (it wins when it holds any);
 *   - no store holds stock yet: the Main Store;
 *   - a switched-off store is never chosen, even with stock;
 *   - no Main Store at all: the store holding the most;
 *   - no store switched on: none (the switch then refuses in words).
 *
 * Throwaway shops only (tillstore-*). Local only.
 *   DATABASE_URL=<local> DIRECT_URL=<local> npx tsx src/scripts/verify-pos-till-store.ts
 */
import { prisma } from '../lib/prisma';
import { tillStore } from '../services/pos-switch';

for (const k of ['DATABASE_URL', 'DIRECT_URL']) {
  if (!/localhost:55433/.test(process.env[k] ?? '')) { console.error(`Refusing: ${k} is not the local database.`); process.exit(2); }
}
const S = Date.now().toString(36);
let bad = 0, good = 0;
const check = (name: string, ok: boolean, detail: unknown = '') => {
  ok ? good++ : bad++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : ` :: ${JSON.stringify(detail)}`}`);
};
const shops: string[] = [];

async function shop(n: string) {
  const clientId = `tillstore-${S}-${n}`;
  shops.push(clientId);
  const p = await prisma.product.create({ data: { clientId, productCode: `TS-${S}-${n}`, slug: `ts-${S}-${n}`, title: 'Saree', category: 'WOMEN' as any, productType: 'READY_TO_WEAR' as any, basePrice: 1000, status: 'ACTIVE' as any, publishedAt: new Date(), sellInShop: true } as any });
  const v = await prisma.productVariant.create({ data: { clientId, productId: p.id, variantCode: `TSV-${S}-${n}`, sku: `TSS-${S}-${n}`, sellingPrice: 1000 } as any });
  const store = (code: string, name: string, active = true) => prisma.stockLocation.create({ data: { clientId, code, name, type: 'STORE' as any, active } });
  const put = (locationId: string, quantity: number) => prisma.inventoryStock.create({ data: { clientId, variantId: v.id, locationId, quantity } as any });
  return { clientId, store, put };
}

async function main() {
  const a = await shop('a');
  const mainA = await a.store('MAIN-STORE', 'Main Store');
  const btqA = await a.store(`BTQ-${S}`, 'Boutique - 1');
  await a.put(btqA.id, 48);
  check('Main Store empty, "Boutique - 1" holds the stock: "Boutique - 1" (Jyoti Atelier)', (await tillStore(a.clientId))?.id === btqA.id);
  await a.put(mainA.id, 1);
  check('the Main Store holds stock too: the Main Store', (await tillStore(a.clientId))?.id === mainA.id);

  const b = await shop('b');
  const mainB = await b.store('MAIN-STORE', 'Main Store');
  await b.store(`OTHER-${S}`, 'Branch');
  check('no store holds stock yet (a new shop): the Main Store', (await tillStore(b.clientId))?.id === mainB.id);

  const c = await shop('c');
  await c.store('MAIN-STORE', 'Main Store');
  const offC = await c.store(`OFF-${S}`, 'Old godown', false);
  await c.put(offC.id, 30);
  const tc = await tillStore(c.clientId);
  check('a switched-off store is never chosen, even with stock', !!tc && tc.id !== offC.id);

  const d = await shop('d');
  const smallD = await d.store(`D1-${S}`, 'Small');
  const bigD = await d.store(`D2-${S}`, 'Big');
  await d.put(smallD.id, 2);
  await d.put(bigD.id, 9);
  check('no Main Store at all: the store holding the most', (await tillStore(d.clientId))?.id === bigD.id);

  const e = await shop('e');
  await e.store(`E1-${S}`, 'Closed', false);
  check('no store switched on: none', (await tillStore(e.clientId)) === null);
}

async function cleanup() {
  const tables = await prisma.$queryRaw<{ table_name: string }[]>`SELECT DISTINCT table_name FROM information_schema.columns WHERE table_schema = 'public' AND column_name = 'client_id'`;
  for (let round = 0; round < 8; round++) {
    let left = 0;
    for (const t of tables) { try { await prisma.$executeRawUnsafe(`DELETE FROM "${t.table_name}" WHERE client_id = ANY($1)`, shops); } catch { left++; } }
    if (!left) break;
  }
  console.log(`\ncleaned up ${shops.length} shops`);
}

main()
  .catch(e => { bad++; console.error('CRASH', e); })
  .finally(async () => { await cleanup().catch(e => console.error('cleanup failed', e)); console.log(`${good} passed, ${bad} problems`); await prisma.$disconnect(); process.exit(bad ? 1 : 0); });
