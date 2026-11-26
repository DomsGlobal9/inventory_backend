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
    // 5. `off` in the picture: every module switched off, read from the records, so a resend with no hint still says it.
    await prisma.clientModule.upsert({ where: { clientId_module: { clientId, module: 'pos' } }, create: { clientId, module: 'pos', on: false, source: 'console' } as any, update: { on: false } });
    const p5: any = await pictureOf(clientId); // no hint at all, as after a restart or "Tell it now"
    ok('picture without a hint: off lists POS (switched off)', Array.isArray(p5.off) && p5.off.includes('pos'), p5.off);
    ok('...and not Inventory (on), nor a module never recorded', !p5.off.includes('inventory') && !p5.off.includes('logistics'), p5.off);
    ok('...changed stays empty (only what this version changed)', p5.changed.on.length === 0 && p5.changed.off.length === 0, p5.changed);
    const sent = await call('PUT', { ...p5, version: 20, modules: ['inventory', 'crm'] });
    ok('CRM accepts the picture with off', sent.ok, sent);
    // 6. CRM switching its own feed on (PUT /internal/modules/crm/shops/:id), signed as CRM's test key: the Console's
    //    switch decides. Found 26 Nov: CRM's delayed job turned the feed back on just after CRM was switched off.
    if (process.env.CRM_KEY_DIR) {
      const fs = await import('node:fs');
      const jwt = (await import('jsonwebtoken')).default;
      const pk = fs.readFileSync(`${process.env.CRM_KEY_DIR}/private.pem`, 'utf8');
      const asCrm = (id: string) => fetch(`${process.env.VERIFY_API_URL ?? 'http://localhost:4036/api/v1'}/internal/modules/crm/shops/${encodeURIComponent(id)}`, {
        method: 'PUT', headers: { Authorization: `Bearer ${jwt.sign({ sub: 'scaleezy-crm-test', scope: ['modules:crm'] }, pk, { algorithm: 'RS256', audience: 'inventory', issuer: 'scaleezy-crm-test', keyid: 'test-1', expiresIn: '5m' })}` }
      }).then(async r => ({ status: r.status, body: await r.json().catch(() => ({})) as any }));
      await prisma.clientModule.upsert({ where: { clientId_module: { clientId, module: 'crm' } }, create: { clientId, module: 'crm', on: true, source: 'console' } as any, update: { on: true } });
      const onOk = await asCrm(clientId);
      ok('CRM may switch its feed on while CRM is on', onOk.status === 200, onOk);
      await prisma.moduleSubscription.deleteMany({ where: { clientId, module: 'crm' } });
      await prisma.clientModule.update({ where: { clientId_module: { clientId, module: 'crm' } }, data: { on: false } });
      const offNo = await asCrm(clientId);
      ok('CRM switched OFF: its own "feed on" is refused, 409 module_off, in words', offNo.status === 409 && offNo.body.reason === 'module_off' && /switched off/.test(offNo.body.message), offNo);
      ok('...and no feed was made', !(await prisma.moduleSubscription.findUnique({ where: { clientId_module: { clientId, module: 'crm' } } })));
    } else console.log('(CRM_KEY_DIR not set: the feed-door checks were skipped)');
  } finally {
    await call('DELETE', pic(99, false));
    await t.remove();
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  await prisma.$disconnect();
  process.exit(fail ? 1 : 0);
}
main().catch(async e => { console.error(e); await prisma.$disconnect(); process.exit(1); });
