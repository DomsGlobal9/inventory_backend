/**
 * What the shop sells is ScaleEzy's to set (27 Nov 2026): owners cannot change it; the Platform Console sets it at
 * onboarding (required for a client with Inventory) and later on the client's page.
 *
 *   OWNER    PUT /setup { sells } changing it -> 403 in words; the same answer again -> fine; finish works unset
 *            PUT /fabrics { fabricsOn } changing it -> 403; the smallest cut and roll stay the owner's
 *            GET /setup no longer lists "what you sell" as missing
 *   CONSOLE  GET/PUT /admin/clients/:id/sells: BOTH and FABRICS switch fabrics on, READY_MADE off; a bad value, a
 *            boutique-linked shop and fabric still on sale are refused in words; a client without Inventory says so
 *            onboarding without "what it sells" for an Inventory client is refused (checked without creating a client)
 *
 *   VERIFY_API_URL=http://localhost:4036/api/v1 DATABASE_URL=<local> DIRECT_URL=<local> npx tsx src/scripts/verify-sells-by-scaleezy.ts
 */
import { execSync } from 'node:child_process';
import axios from 'axios';
import { prisma } from '../lib/prisma';
import { makeThrowawayShop, removeShop } from './lib/throwaway-shop';

const BASE = process.env.VERIFY_API_URL || 'http://localhost:4036/api/v1';
for (const k of ['DATABASE_URL', 'DIRECT_URL']) if (!/localhost:55433/.test(process.env[k] ?? '')) { console.error(`Refusing: ${k} is not the local database.`); process.exit(2); }
if (!/localhost|127\.0\.0\.1/.test(BASE)) { console.error('Refusing: not a local server.'); process.exit(2); }
const CONSOLE = execSync('npx tsx src/scripts/print-local-console-token.ts', { env: process.env, encoding: 'utf8' }).match(/eyJ[A-Za-z0-9._-]+/)![0];

let passed = 0, failed = 0;
const ok = (name: string, cond: boolean, detail?: unknown) => {
  if (cond) { passed++; console.log(`PASS ${name}`); } else { failed++; console.log(`FAIL ${name}${detail === undefined ? '' : ` -> ${JSON.stringify(detail).slice(0, 300)}`}`); }
};
const plain = (m?: string) => !!m && !/undefined|null|\{|\}|Error:|HTTP/.test(m);

(async () => {
  const t = await makeThrowawayShop('Sells');
  const C = t.clientId;
  const owner = (method: string, path: string, data?: unknown) => axios.request({ method, url: `${BASE}${path}`, data, validateStatus: () => true, timeout: 60_000,
    headers: { Cookie: `token=${t.tokens.SUPER_ADMIN}`, Origin: 'http://localhost:5183', 'Content-Type': 'application/json' } });
  const admin = (method: string, path: string, data?: unknown) => axios.request({ method, url: `${BASE}/admin${path}`, data, validateStatus: () => true, timeout: 60_000,
    headers: { Cookie: `platform_admin_token=${CONSOLE}`, Origin: 'http://localhost:5183', 'Content-Type': 'application/json' } });
  try {
    await prisma.clientSettings.updateMany({ where: { clientId: C }, data: { sells: null, fabricsOn: false, setupDoneAt: null } as any });

    console.log('THE OWNER');
    const s0 = await owner('GET', '/setup');
    ok('a shop not set yet: GET /setup says null, and "what you sell" is not on the owner\'s to-do', s0.status === 200 && s0.data.data.sells === null && !s0.data.data.missing.includes('what you sell'), s0.data);
    const pickBoth = await owner('PUT', '/setup', { sells: 'BOTH' });
    ok('the owner choosing "Both" is refused: 403, in words, pointing at ScaleEzy', pickBoth.status === 403 && /set by ScaleEzy\. To change it, contact ScaleEzy/.test(pickBoth.data.message) && plain(pickBoth.data.message), pickBoth.data);
    ok('...and nothing changed', (await prisma.clientSettings.findUnique({ where: { clientId: C }, select: { sells: true, fabricsOn: true } }))?.sells === null);
    const fin = await owner('PUT', '/setup', { finish: true });
    ok('the owner can still finish the setup with it unset (it is ScaleEzy\'s to set)', fin.status === 200 && fin.data.data.setupDone === true, fin.data);
    const fabOn = await owner('PUT', '/fabrics', { fabricsOn: true });
    ok('the owner switching fabrics on is refused too (it follows what the shop sells): 403 in words', fabOn.status === 403 && /set by ScaleEzy/.test(fabOn.data.message), fabOn.data);

    console.log('');
    console.log('THE PLATFORM CONSOLE');
    const g0 = await admin('GET', `/clients/${C}/sells`);
    ok('the console reads it: not set, Inventory on, no boutique', g0.status === 200 && g0.data.data.sells === null && g0.data.data.inventoryOn === true && g0.data.data.boutiqueLinked === false, g0.data);
    const bad = await admin('PUT', `/clients/${C}/sells`, { sells: 'EVERYTHING' });
    ok('a value that is not ready-made / fabrics / both is refused in words', bad.status === 400 && /ready-made garments, fabrics, or both/.test(bad.data.message), bad.data);
    const both = await admin('PUT', `/clients/${C}/sells`, { sells: 'BOTH' });
    ok('ScaleEzy sets "Both": saved, and everything by the metre switched on', both.status === 200 && both.data.data.sells === 'BOTH' && both.data.data.fabricsOn === true, both.data);
    const s1 = await owner('GET', '/setup');
    ok('...the owner\'s app sees it at once (sells BOTH, fabrics on)', s1.data.data.sells === 'BOTH' && s1.data.data.fabricsOn === true, s1.data.data);
    const same = await owner('PUT', '/setup', { sells: 'BOTH', fabricMinCut: 50, finish: true });
    ok('the owner sending the same answer again (an older screen) is harmless, and the smallest cut is still theirs', same.status === 200 && same.data.data.fabricMinCut === 50, same.data);
    const change = await owner('PUT', '/setup', { sells: 'READY_MADE' });
    ok('...but changing it is refused (403) and it stays "Both"', change.status === 403 && (await prisma.clientSettings.findUnique({ where: { clientId: C }, select: { sells: true } }))?.sells === 'BOTH', change.data);
    const roll = await owner('PUT', '/fabrics', { fabricRollSize: 2500 });
    ok('the owner still sets fabric details (the roll length)', roll.status === 200, roll.data);
    const fabSame = await owner('PUT', '/fabrics', { fabricsOn: true, fabricMinCut: 25 });
    ok('...and sending fabrics "on" when it is already on is harmless', fabSame.status === 200, fabSame.data);
    const fabOff = await owner('PUT', '/fabrics', { fabricsOn: false });
    ok('...switching fabrics off is refused (403)', fabOff.status === 403, fabOff.data);

    // A product sold by the metre: ready-made only must be refused, in words, until it is dealt with.
    const S = Date.now().toString(36);
    const cloth = await prisma.product.create({ data: { clientId: C, productCode: `SB-${S}`, slug: `sb-${S}`, title: 'Silk by the metre', category: 'WOMEN' as any, productType: 'UNSTITCHED' as any, basePrice: 4.5, status: 'ACTIVE' as any, soldBy: 'METRE' as any } as any });
    const ready = await admin('PUT', `/clients/${C}/sells`, { sells: 'READY_MADE' });
    ok('ready-made only while cloth is still sold by the metre: refused in words (409), still "Both"', ready.status === 409 && /sold by the metre or packet/.test(ready.data.message) && (await prisma.clientSettings.findUnique({ where: { clientId: C }, select: { sells: true } }))?.sells === 'BOTH', ready.data);
    await prisma.product.delete({ where: { id: cloth.id } });
    const ready2 = await admin('PUT', `/clients/${C}/sells`, { sells: 'READY_MADE' });
    ok('with nothing by the metre: ready-made only saved, fabrics switched off', ready2.status === 200 && ready2.data.data.sells === 'READY_MADE' && ready2.data.data.fabricsOn === false, ready2.data);
    const fab = await admin('PUT', `/clients/${C}/sells`, { sells: 'FABRICS' });
    ok('fabrics only: saved, fabrics on', fab.status === 200 && fab.data.data.sells === 'FABRICS' && fab.data.data.fabricsOn === true, fab.data);

    // A boutique linked: ready-made only is refused, in the console's words (not "ask ScaleEzy").
    await prisma.boutiqueLink.create({ data: { clientId: C, tenant: `sells-test-${S}` } as any }).catch(() => undefined);
    const g1 = await admin('GET', `/clients/${C}/sells`);
    ok('the console sees the boutique link', g1.data.data.boutiqueLinked === true, g1.data);
    const rb = await admin('PUT', `/clients/${C}/sells`, { sells: 'READY_MADE' });
    ok('ready-made only with a boutique linked: refused in the console\'s words (turn the Boutique module off first)', rb.status === 409 && /Turn the Boutique module off first/.test(rb.data.message), rb.data);
    await prisma.boutiqueLink.deleteMany({ where: { clientId: C } });

    const nobody = await admin('GET', `/clients/no-such-client-${S}/sells`);
    ok('a client that is not ours: 404 in words', nobody.status === 404, nobody.data);

    console.log('');
    console.log('ONBOARDING (the form check only: no client is created)');
    const { readOnboardingForm } = await import('../controllers/platform-admin.controller') as any;
    if (typeof readOnboardingForm === 'function') {
      const base = { companyName: 'Sells Test Silks', adminName: 'Owner', adminEmail: `owner-${S}@example.invalid`, ownerPhone: '9848012345' };
      const noSells = readOnboardingForm({ ...base, modules: ['inventory'] });
      ok('an Inventory client without "what it sells": refused in words', 'problem' in noSells && /Choose what the shop sells/.test(noSells.problem), noSells);
      const withBoth = readOnboardingForm({ ...base, modules: ['inventory'], sells: 'BOTH' });
      ok('...with "Both": accepted, carrying BOTH', !('problem' in withBoth) && withBoth.sells === 'BOTH', withBoth);
      const posOnly = readOnboardingForm({ ...base, modules: ['pos'] });
      ok('a POS-only client (no Inventory) does not need it', !('problem' in posOnly) && posOnly.sells === null, posOnly);
    } else {
      const r = await admin('POST', '/clients', { companyName: 'Sells Test Silks', adminName: 'Owner', adminEmail: `owner-${S}@example.invalid`, ownerPhone: '9848012345', modules: ['inventory'] });
      ok('an Inventory client without "what it sells": refused in words (nothing created)', r.status === 400 && /Choose what the shop sells/.test(r.data.message ?? ''), r.data);
    }
  } catch (e) {
    console.error(e); failed++;
  } finally {
    await prisma.boutiqueLink.deleteMany({ where: { clientId: C } }).catch(() => undefined);
    await removeShop(C).catch(e => console.log('left the throwaway shop', e?.message));
    await prisma.$disconnect();
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
