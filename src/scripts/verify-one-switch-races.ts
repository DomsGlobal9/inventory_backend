/**
 * One-switch, the races (26 Nov 2026, the joint round with CRM). LOCAL only: Inventory's own CRM caller against CRM
 * on 4008, for a throwaway client.
 *   1. the SAME PUT /platform/client sent twice at once: both answered, CRM ends on that version;
 *   2. a newer and an older version at once, and the older one late: CRM keeps the newer;
 *   3. off (DELETE) then on again with a higher version: CRM has it on, at the newer version;
 *   4. an older "off" after the newer "on": ignored.
 *   DATABASE_URL=<local> DIRECT_URL=<local> CRM_SERVICE_URL=http://localhost:4008/api/v1/service npx tsx src/scripts/verify-one-switch-races.ts
 */
import { prisma } from '../lib/prisma';
import { makeThrowawayShop } from './lib/throwaway-shop';
import { pictureOf } from '../services/client-modules';

process.env.CRM_SERVICE_URL = process.env.CRM_SERVICE_URL || 'http://localhost:4008/api/v1/service';
process.env.INVENTORY_KEY_ID = process.env.INVENTORY_KEY_ID || 'inv-local-dev';
process.env.INVENTORY_PRIVATE_KEY_PATH = process.env.INVENTORY_PRIVATE_KEY_PATH || 'dev-keys/inventory-private.pem';
if (!/localhost/.test(process.env.CRM_SERVICE_URL)) { console.error('Refusing: CRM is not local.'); process.exit(2); }

let pass = 0, fail = 0;
const ok = (name: string, cond: boolean, detail?: unknown) => {
  if (cond) pass++; else fail++;
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${!cond && detail !== undefined ? ` -> ${JSON.stringify(detail).slice(0, 400)}` : ''}`);
};

async function main() {
  const { callCrm } = await import('../services/crm-identity/client');
  const t = await makeThrowawayShop('Races');
  const { clientId } = t;
  const call = (method: 'PUT' | 'DELETE' | 'GET', body?: unknown) =>
    callCrm<any>(method, '/platform/client', clientId, body, { scope: ['crm:platform'], timeoutMs: 30_000 })
      .then(a => ({ ok: true, a }), (e: any) => ({ ok: false, status: e?.status, why: String(e?.message ?? e), detail: e?.why ?? e?.cause?.message }));
  const base = await pictureOf(clientId, { source: 'console' });
  // The picture exactly as Inventory sends it, only the version and CRM's place in the module list changed.
  const pic = (version: number, crm: boolean) => ({ ...base, version, at: new Date().toISOString(), modules: crm ? ['inventory', 'crm'] : ['inventory'], changed: { on: crm ? ['crm'] : [], off: crm ? [] : ['crm'] } });
  // CRM's own checklist line "CRM is switched on": good when on.
  const crmOn = async () => { const g: any = await call('GET'); return g.a?.lines?.find((l: any) => l.key === 'crm-on')?.state; };
  try {
    // 1. The same PUT twice at once.
    const [a, b] = await Promise.all([call('PUT', pic(10, true)), call('PUT', pic(10, true))]);
    ok('the same PUT twice at once: both answered (no 5xx, no duplicate error)', a.ok && b.ok, [a, b]);
    ok('...CRM is on', (await crmOn()) === 'ok', await call('GET'));

    // 2. A newer "on" and an older "off" at once, whichever lands first; then the older again, late.
    const [n, o] = await Promise.all([call('PUT', pic(12, true)), call('DELETE', pic(11, false))]);
    ok('newer on (12) and older off (11) at once: both answered', n.ok && o.ok, [n, o]);
    ok('...CRM stays on (the older off ignored)', (await crmOn()) === 'ok', await call('GET'));
    const late = await call('DELETE', pic(11, false));
    ok('the older off again, late: answered without error', late.ok, late);
    ok('...still on', (await crmOn()) === 'ok', await call('GET'));

    // 3. Off, then on again with a higher version.
    const off = await call('DELETE', pic(13, false));
    ok('off (13): answered', off.ok, off);
    ok('...CRM says it is off', (await crmOn()) !== 'ok', await call('GET'));
    const on = await call('PUT', pic(14, true));
    ok('on again (14): answered', on.ok, on);
    ok('...CRM is on again', (await crmOn()) === 'ok', await call('GET'));

    // 4. A late, older "off" after the newer "on".
    const lateOff = await call('DELETE', pic(13, false));
    ok('a late older off (13): answered without error', lateOff.ok, lateOff);
    ok('...ignored: still on', (await crmOn()) === 'ok', await call('GET'));
  } finally {
    await call('DELETE', pic(99, false));
    await t.remove();
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  await prisma.$disconnect();
  process.exit(fail ? 1 : 0);
}
main().catch(async e => { console.error(e); await prisma.$disconnect(); process.exit(1); });
