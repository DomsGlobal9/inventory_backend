/**
 * The POS key doctor (25 Nov 2026, services/pos-switch/doctor.ts): a till key ScaleEzy's switch made mends itself.
 * Against the REAL local Inventory (4036, its key check writing "last used" and reacting to a retired key) and the
 * REAL local POS (4007): a throwaway shop is switched on (owner by phone only, so no mail goes anywhere), then its key
 * is damaged every way it can be, and each time POS must end up holding a fresh, working key -- proved by POS itself
 * using it (the key's "last used" moves). Also: no repair when healthy, when POS is off or away, nor twice in a row.
 * Local only. The POS shop it makes is switched off at the end (POS keeps it, switched off).
 *   DATABASE_URL=<local> DIRECT_URL=<local> npx tsx src/scripts/verify-pos-key-doctor.ts
 */
import axios from 'axios';
import { prisma } from '../lib/prisma';
import { posConnectionService } from '../services/pos/pos-connection.service';

for (const k of ['DATABASE_URL', 'DIRECT_URL']) {
  if (!/localhost:55433/.test(process.env[k] ?? '')) { console.error(`Refusing: ${k} is not the local database.`); process.exit(2); }
}
const BASE = 'http://localhost:4036/api/v1';
const POS = 'http://localhost:4007/api/v1';
process.env.POS_API_URL = POS;
process.env.INVENTORY_KEY_ID = process.env.INVENTORY_KEY_ID || 'inv-local-dev';
process.env.INVENTORY_PRIVATE_KEY_PATH = process.env.INVENTORY_PRIVATE_KEY_PATH || 'dev-keys/inventory-private.pem';

const S = Date.now().toString(36);
const C = `posdoc-${S}`;
const MIN = 60_000;
let bad = 0, good = 0;
const check = (n: string, ok: boolean, d: unknown = '') => { ok ? good++ : bad++; console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${n}${ok ? '' : ' :: ' + JSON.stringify(d)?.slice(0, 600)}`); };
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function main() {
  const sw = await import('../services/pos-switch');
  const doc = await import('../services/pos-switch/doctor');
  const keys = () => prisma.storefrontConnection.findMany({ where: { clientId: C, baseUrl: 'pos://counter', name: 'POS' }, orderBy: { createdAt: 'desc' }, select: { id: true, status: true, locationIds: true, createdAt: true, lastUsedAt: true, credentialPrefix: true } });
  const current = async () => (await keys()).find(k => k.status === 'ACTIVE');
  /** POS proves a key works by using it: wait for its "last used" to be written. */
  const usedByPos = async (id: string, ms = 8000) => {
    for (let t = 0; t < ms; t += 500) { const k = await prisma.storefrontConnection.findUnique({ where: { id } }); if (k?.lastUsedAt) return true; await sleep(500); }
    return false;
  };
  const age = (id: string, mins: number, used: number | null) => prisma.storefrontConnection.update({ where: { id }, data: { createdAt: new Date(Date.now() - mins * MIN), lastUsedAt: used === null ? null : new Date(Date.now() - used * MIN) } as any });

  // A shop: an empty Main Store, and "Boutique - 1" holding the stock.
  const main = await prisma.stockLocation.create({ data: { clientId: C, code: 'MAIN-STORE', name: 'Main Store', type: 'STORE' as any, active: true } });
  const btq = await prisma.stockLocation.create({ data: { clientId: C, code: `BTQ-${S}`, name: 'Boutique - 1', type: 'STORE' as any, active: true } });
  const p = await prisma.product.create({ data: { clientId: C, productCode: `PD-${S}`, slug: `pd-${S}`, title: 'Saree', category: 'WOMEN' as any, productType: 'READY_TO_WEAR' as any, basePrice: 1000, status: 'ACTIVE' as any, publishedAt: new Date(), sellInShop: true } as any });
  const v = await prisma.productVariant.create({ data: { clientId: C, productId: p.id, variantCode: `PDV-${S}`, sku: `PDS-${S}`, sellingPrice: 1000 } as any });
  await prisma.inventoryStock.create({ data: { clientId: C, variantId: v.id, locationId: btq.id, quantity: 5 } });

  console.log('SWITCHED ON (real POS)');
  const on: any = await sw.switchOn(C, { userId: 'verify', name: 'Doctor test' }, { name: 'Doc Owner', phone: '9000000001' });
  const k0 = await current();
  check('POS on, one working key, at the store holding the stock', on?.posOn === true && !!k0 && k0.locationIds[0] === btq.id, { on, k0 });
  check('POS used the key the moment it got it (last used written)', await usedByPos(k0!.id));
  check('healthy: nothing to mend', (await doc.checkShop(C)).action === 'healthy');

  console.log('\nTHE KEY RETIRED BY MISTAKE');
  await posConnectionService.disconnect(C, k0!.id);
  await age(k0!.id, 15, 1);
  const r1 = await doc.checkShop(C, { now: Date.now() });
  const k1 = await current();
  check('repaired: NO_KEY, a fresh key handed to POS', r1.action === 'repaired' && (r1 as any).finding === 'NO_KEY' && !!k1 && k1.id !== k0!.id, r1);
  check('...and POS is using the fresh key', !!k1 && await usedByPos(k1.id));
  check('...POS still says the shop is on', (await sw.status(C) as any).posOn === true);
  await posConnectionService.disconnect(C, k1!.id);
  const again = await doc.checkShop(C);
  check('broken again a moment later: not repaired twice in a row (waits 10 minutes)', again.action === 'skipped' && /moment ago/.test((again as any).why), again);
  await age(k1!.id, 15, 1);
  doc.forgetRecentRepairs();
  const r1b = await doc.checkShop(C);
  check('...after the wait it is repaired', r1b.action === 'repaired', r1b);

  console.log('\nTHE KEY\'S STORE SWITCHED OFF, THEN ON AGAIN');
  let k = (await current())!;
  await age(k.id, 15, 1);
  await prisma.stockLocation.update({ where: { id: btq.id }, data: { active: false } });
  doc.forgetRecentRepairs();
  const r2 = await doc.checkShop(C);
  k = (await current())!;
  check('store switched off: STORE_CLOSED, the key moves to an open store', r2.action === 'repaired' && (r2 as any).finding === 'STORE_CLOSED' && k.locationIds[0] === main.id, { r2, at: k.locationIds });
  check('...POS is using it', await usedByPos(k.id));
  await prisma.stockLocation.update({ where: { id: btq.id }, data: { active: true } });
  await age(k.id, 15, 1);
  doc.forgetRecentRepairs();
  const r3 = await doc.checkShop(C);
  k = (await current())!;
  check('stock is in "Boutique - 1", the key on the empty Main Store: STOCK_MOVED, key moves to the stock', r3.action === 'repaired' && (r3 as any).finding === 'STOCK_MOVED' && k.locationIds[0] === btq.id, { r3, at: k.locationIds });
  check('...POS is using it', await usedByPos(k.id));

  console.log('\nPOS STOPS USING ITS KEY (its copy lost or broken)');
  // "Three hours from now" (silence is never judged from before this process started).
  const LATER = () => Date.now() + 3 * 60 * MIN;
  await age(k.id, 15, 10);
  check('in use: not "unused"', (await doc.diagnose(C)) === null);
  check('two hours with no call from POS: NOT_USED', (await doc.diagnose(C, LATER())) === 'NOT_USED');
  const r4 = await doc.checkShop(C, { now: LATER() });
  const k4 = (await current())!;
  check('repaired, and POS uses the fresh key', r4.action === 'repaired' && k4.id !== k.id && await usedByPos(k4.id), r4);

  console.log('\nA TILL CALLS WITH A RETIRED KEY (POS lost the newer one) -- the real key check reacts');
  const stray = await posConnectionService.create(C, { locationId: btq.id, name: 'POS' });
  await posConnectionService.disconnect(C, stray.id);
  await age(stray.id, 20, null);
  // The real POS still pulls with k4 every 30 s (in real life it would have lost it), and a pull in the 3 s before the
  // doctor looks makes k4 "in use" again: a stray call, rightly ignored. So the scene is played up to three times.
  let healed: any = null, refusedStatus = 0;
  for (let attempt = 0; attempt < 3 && !healed; attempt++) {
    await age(k4.id, 20, 15);
    refusedStatus = (await axios.get(`${BASE}/pos/v1/catalogue?limit=1`, { headers: { 'x-storefront-key': stray.key }, validateStatus: () => true })).status;
    for (let t = 0; t < 12 && !healed; t++) { await sleep(1000); const c = await current(); if (c && c.id !== k4.id) healed = c; }
  }
  check('the retired key is refused (401)', refusedStatus === 401, refusedStatus);
  check('within seconds Inventory handed POS a fresh key by itself', !!healed);
  check('...and POS is using it', !!healed && await usedByPos(healed.id));
  const fine = (await current())!;
  await prisma.storefrontConnection.update({ where: { id: fine.id }, data: { lastUsedAt: new Date() } });
  check('a stray call with an old key while the current key is in use: nothing to mend', (await doc.diagnose(C, Date.now(), true)) === null);

  console.log('\nNO REPAIR WHEN IT CANNOT HELP');
  await prisma.storefrontConnection.delete({ where: { id: stray.id } });
  await sw.switchOff(C, { userId: 'verify', name: 'Doctor test' });
  let n = (await keys()).length;
  await age(fine.id, 300, 240);
  doc.forgetRecentRepairs();
  const off = await doc.checkShop(C, { now: LATER() });
  check('POS switched off for the shop: left alone, no key made', off.action === 'skipped' && /switched off/.test((off as any).why) && (await keys()).length === n, off);
  // A key POS never picked up (it holds an older one): a newer key no till ever used.
  const ghost = await posConnectionService.create(C, { locationId: btq.id, name: 'POS' });
  await age(ghost.id, 150, null);
  doc.forgetRecentRepairs();
  const never = await doc.checkShop(C, { now: LATER() });
  const seen = { finding: await doc.diagnose(C, LATER()), keys: (await keys()).map(k => ({ s: k.status, c: k.createdAt, u: k.lastUsedAt, ghost: k.id === ghost.id })) };
  await prisma.storefrontConnection.delete({ where: { id: ghost.id } });
  check('the last key was never used by POS: waits (6 h) instead of making key after key', never.action === 'skipped' && /never used/.test((never as any).why), { never, seen });
  await age(fine.id, 300, 240);
  process.env.POS_API_URL = 'http://127.0.0.1:9/api/v1';
  doc.forgetRecentRepairs();
  const away = await doc.checkShop(C, { now: LATER() });
  process.env.POS_API_URL = POS;
  check('POS cannot be reached: left alone, nothing retired, no key made', away.action === 'skipped' && /not reachable/.test((away as any).why) && (await keys()).length === n && !!(await current()), away);

  console.log('\nPOS BACK AFTER A LONG OUTAGE (every key looks unused until its first pulls)');
  await sw.switchOn(C, { userId: 'verify', name: 'Doctor test' }, null);
  const back = (await current())!;
  await age(back.id, 300, 240);
  doc.forgetRecentRepairs();
  const T = LATER();
  const early = await doc.checkShop(C, { now: T });
  check('POS answers again: no "unused" repair in its first 15 minutes', early.action === 'skipped' && /just came back/.test((early as any).why), early);
  doc.forgetRecentRepairs();
  const late = await doc.checkShop(C, { now: T + 20 * MIN });
  check('...still silent 20 minutes later: repaired', late.action === 'repaired' && (late as any).finding === 'NOT_USED', late);

  const hand = await doc.checkShop(`nobody-${S}`);
  check('a shop with no switch key (connected by hand, or no POS): not touched', hand.action === 'skipped' || hand.action === 'healthy', hand);
}

async function cleanup() {
  const sw = await import('../services/pos-switch');
  await sw.switchOff(C, { userId: 'verify', name: 'Doctor test' }).catch(() => undefined);
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
