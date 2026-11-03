/**
 * The shop's own Logistics switch (3 Nov), over real HTTP against the local server (4016).
 * LOCAL DATABASE ONLY. verify-suites-tenant's Logistics state and its parcels' statuses are put back.
 *
 *   ROLE_TOKENS=<scratchpad>/local-tokens.json npx tsx src/scripts/verify-logistics-switch.ts
 */
const LOCAL = 'localhost:55433';
if (!String(process.env.DATABASE_URL || '').includes(LOCAL) || !String(process.env.DIRECT_URL || '').includes(LOCAL)) {
  console.error(`Refusing to run: DATABASE_URL and DIRECT_URL must both point at the local copy (${LOCAL}).`); process.exit(2);
}
import fs from 'node:fs';
import jwt from 'jsonwebtoken';
import { prisma } from '../lib/prisma';

const C = 'verify-suites-tenant';
const API = 'http://localhost:4016/api/v1';
const SP = 'C:/Users/HP/AppData/Local/Temp/claude/D--villy-inventory/00d435a0-68b0-4933-9758-bcc19e3e6522/scratchpad';
const tokens: Record<string, string> = JSON.parse(fs.readFileSync(process.env.ROLE_TOKENS || `${SP}/local-tokens.json`, 'utf8'));
const KEY = fs.readFileSync(`${SP}/test-logistics-keys/private.pem`);
let passed = 0, failed = 0;
const check = (n: string, ok: boolean, d?: unknown) => { ok ? passed++ : failed++; console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${n}${ok || d === undefined ? '' : ' -- ' + JSON.stringify(d).slice(0, 300)}`); };

const asShop = (role: string, method: string, path: string, body?: unknown) =>
  fetch(`${API}${path}`, { method, headers: { 'content-type': 'application/json', origin: 'http://localhost:5183', cookie: `token=${tokens[role]}` }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) })
    .then(async r => ({ status: r.status, body: await r.json().catch(() => null) as any }));
const asLogistics = (path: string) => {
  const t = jwt.sign({ sub: 'logistics-test', scope: ['modules:logistics'] }, KEY, { algorithm: 'RS256', keyid: 'test-1', issuer: 'scaleezy-logistics-test', audience: 'inventory', expiresIn: 300 });
  return fetch(`${API}/internal/modules/logistics${path}`, { headers: { authorization: `Bearer ${t}` } }).then(async r => ({ status: r.status, body: await r.json().catch(() => null) as any }));
};
const sub = () => prisma.moduleSubscription.findUnique({ where: { clientId_module: { clientId: C, module: 'logistics' } } });

(async () => {
  const before = await sub();
  const parcels = await prisma.logisticsParcel.findMany({ where: { clientId: C }, select: { id: true, status: true } });
  try {
    if (before) await prisma.moduleSubscription.delete({ where: { id: (before as any).id } }).catch(async () => prisma.moduleSubscription.deleteMany({ where: { clientId: C, module: 'logistics' } }));

    console.log('\nOff to start with');
    let r = await asShop('SUPER_ADMIN', 'GET', '/logistics');
    check('the owner reads: off, with the parcels still out counted', r.status === 200 && r.body?.data?.on === false && typeof r.body?.data?.openParcels === 'number', r.body);
    r = await asLogistics(`/shops/${C}/products`);
    check('Logistics is refused while the shop is off (404, the reason)', r.status === 404 && r.body?.message === 'This shop has not switched Logistics on.', r);

    console.log('\nWho may switch');
    for (const role of ['WAREHOUSE', 'SALES']) {
      r = await asShop(role, 'PUT', '/logistics/on', { on: true });
      check(`${role} cannot switch it (403), and nothing changes`, r.status === 403 && !(await sub()), r.status);
    }
    for (const body of [{}, { on: 'yes' }, { on: 1 }]) {
      r = await asShop('SUPER_ADMIN', 'PUT', '/logistics/on', body);
      check(`a wrong request ${JSON.stringify(body)}: 400 saying how`, r.status === 400 && /on: true or on: false/.test(r.body?.message ?? ''), r);
    }

    console.log('\nThe owner switches it on');
    r = await asShop('SUPER_ADMIN', 'PUT', '/logistics/on', { on: true });
    const s1 = await sub();
    check('on: 200, and the shop is on Logistics, recorded as switched on by a person here', r.status === 200 && r.body?.data?.on === true && !!s1 && String((s1 as any).enabledBy).startsWith('user:'), { r: r.body, by: (s1 as any)?.enabledBy });
    r = await asShop('SUPER_ADMIN', 'PUT', '/logistics/on', { on: true });
    check('on again: harmless, still one switch', r.status === 200 && (await prisma.moduleSubscription.count({ where: { clientId: C, module: 'logistics' } })) === 1);
    r = await asLogistics(`/shops/${C}/products`);
    check('Logistics now gets the products with NO call of its own first', r.status === 200 && Array.isArray(r.body?.data?.products) && r.body.data.products.length > 0, r.status);

    console.log('\nSwitching off with parcels still out');
    await prisma.logisticsParcel.updateMany({ where: { clientId: C }, data: { status: 'IN_TRANSIT' } });
    const out = parcels.length;
    r = await asShop('SUPER_ADMIN', 'PUT', '/logistics/on', { on: false });
    check(`refused (409), saying how many (${out}) and what to wait for`, r.status === 409 && r.body?.message === `${out} parcel${out === 1 ? ' is' : 's are'} still with Logistics. Switch off once ${out === 1 ? 'it has' : 'they have'} been delivered or returned.`, r.body);
    check('...and it stays on', !!(await sub()));
    r = await asShop('SUPER_ADMIN', 'GET', '/logistics');
    check('the owner sees how many are out', r.body?.data?.openParcels === out, r.body?.data);

    console.log('\nAll delivered or returned: off works');
    const ids = parcels.map(p => p.id);
    await prisma.logisticsParcel.updateMany({ where: { id: { in: ids.filter((_, i) => i % 2 === 0) } }, data: { status: 'DELIVERED' } });
    await prisma.logisticsParcel.updateMany({ where: { id: { in: ids.filter((_, i) => i % 2 === 1) } }, data: { status: 'RTO_DELIVERED' } });
    r = await asShop('SUPER_ADMIN', 'PUT', '/logistics/on', { on: false });
    check('off: 200, the shop is off Logistics', r.status === 200 && r.body?.data?.on === false && !(await sub()), r.body);
    r = await asLogistics(`/shops/${C}/products`);
    check('Logistics is refused again', r.status === 404);
    r = await asShop('SUPER_ADMIN', 'PUT', '/logistics/on', { on: false });
    check('off again: harmless', r.status === 200 && r.body?.data?.on === false);
  } catch (e: any) {
    check(`reached the end (stopped at: ${String(e?.message ?? e).split('\n')[0]})`, false);
  } finally {
    for (const p of parcels) await prisma.logisticsParcel.update({ where: { id: p.id }, data: { status: p.status } });
    await prisma.moduleSubscription.deleteMany({ where: { clientId: C, module: 'logistics' } });
    if (before) await prisma.moduleSubscription.create({ data: { clientId: C, module: 'logistics', enabledBy: (before as any).enabledBy, enabledAt: (before as any).enabledAt } as any });
    console.log(`\nRESULT: ${passed} passed | ${failed} failed`);
    await prisma.$disconnect();
    process.exit(failed ? 1 : 0);
  }
})();
