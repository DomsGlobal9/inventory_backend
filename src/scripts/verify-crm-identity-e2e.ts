/**
 * END TO END, LOCAL ONLY: Inventory (4036) and ScaleEzy CRM (4008) talking only through their APIs, CRM's REAL
 * outbox delivering to Inventory's events address, on the shared test shop "crm-identity-test".
 *
 *   1. Inventory adds a customer; the link job asks CRM (find-or-add) and keeps CRM's id; then tells CRM the
 *      shop is linked, and CRM says it owns the shop's customers.
 *   2. Another module changes that customer's name in CRM -> CRM's outbox -> Inventory's copy changes.
 *   3. Another module adds a walk-in in CRM -> Inventory gets a copy, linked.
 *   4. A change Inventory itself makes in CRM is never sent back to Inventory (no echo).
 *   5. Two customers CRM suggests are the same person, merged in CRM -> Inventory joins its copies (points move);
 *      undone in CRM -> Inventory puts them back. Skipped, said plainly, if CRM's matching offers no suggestion.
 *
 * "Another module" is CRM's own local test module (verify-module, its key in CRM's .local-keys).
 *   DATABASE_URL/DIRECT_URL=local CRM_SERVICE_URL=http://localhost:4008/api/v1/service
 *   INVENTORY_PRIVATE_KEY_PATH=<dev-keys/inventory-service.pem> INVENTORY_KEY_ID=inv-1 npx tsx src/scripts/verify-crm-identity-e2e.ts
 */
import fs from 'node:fs';
import jwt from 'jsonwebtoken';
import { prisma } from '../lib/prisma';
import { post as postPoints } from '../services/loyalty/loyalty.service';
import { crm, crmIdOf, runLinkPass } from '../services/crm-identity';

const SH = 'crm-identity-test';
const CRM = process.env.CRM_SERVICE_URL ?? '';
const STAMP = Date.now();
for (const k of ['DATABASE_URL', 'DIRECT_URL']) {
  if (!/localhost:55433/.test(process.env[k] ?? '')) { console.error(`Refusing: ${k} is not the local database.`); process.exit(2); }
}
if (!/localhost|127\.0\.0\.1/.test(CRM)) { console.error('Refusing: CRM_SERVICE_URL is not local.'); process.exit(2); }

let passed = 0, skipped = 0;
const failures: string[] = [];
const check = (name: string, ok: boolean, detail: unknown = '') => {
  if (ok) { passed++; console.log(`  ok   ${name}`); }
  else { failures.push(name); console.log(`  FAIL ${name} :: ${typeof detail === 'string' ? detail : JSON.stringify(detail)?.slice(0, 400)}`); }
};
const OTHER_KEY = fs.readFileSync('D:/villy/crm/backend/.local-keys/verify-module.pem', 'utf8');
async function asOther(method: string, path: string, body?: unknown) {
  const token = jwt.sign({ clientId: SH, scope: ['crm:customer:view', 'crm:customer:update', 'crm:customer:create', 'crm:customer:merge'] }, OTHER_KEY,
    { algorithm: 'RS256', issuer: 'verify-module', audience: 'scaleezy-crm', keyid: 'verify-1', expiresIn: '5m' });
  const r = await fetch(`${CRM}${path}`, { method, headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, data: (await r.json().catch(() => null)) as any };
}
/** Waits for a condition CRM's outbox should bring about (it sends at once, retries with growing gaps). */
async function within(ms: number, fn: () => Promise<boolean>) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await fn()) return true; await new Promise(r => setTimeout(r, 1000)); }
  return false;
}
const phone = (n: number) => `+9198${String(STAMP).slice(-6)}${String(n).padStart(2, '0')}`;
const mk = (name: string, n: number, extra: Record<string, unknown> = {}) =>
  prisma.customer.create({ data: { clientId: SH, customerCode: `E2E-${STAMP}-${n}`, name, phone: phone(n), ...extra } as any });

(async () => {
  try {
    console.log('\n1. LINK, THEN CRM OWNS THE SHOP');
    const asha = await mk('E2E Asha', 1);
    const pass = await runLinkPass({ onlyClients: [SH] });
    const ashaCrm = await crmIdOf(asha.id);
    check('Inventory\'s link job: the new customer has CRM\'s id', !!ashaCrm, pass);
    const own = await crm.ownership(SH);
    check('Inventory told CRM the shop is linked; CRM says it owns the shop\'s customers', !!own?.ownedAt, own);

    console.log('\n2. CHANGED IN CRM BY ANOTHER MODULE -> INVENTORY');
    const r2 = await asOther('PATCH', `/customers/${ashaCrm}`, { name: 'E2E Asha Devi', email: `asha-${STAMP}@example.com`, birthday: '08-14' });
    check('(another module changes her in CRM)', r2.status === 200, r2);
    const got = await within(30_000, async () => (await prisma.customer.findUnique({ where: { id: asha.id } }))?.name === 'E2E Asha Devi');
    const a2 = await prisma.customer.findUnique({ where: { id: asha.id } });
    check('CRM\'s outbox delivered it: Inventory\'s copy has the new name, email and birthday', got && a2?.email === `asha-${STAMP}@example.com` && a2?.birthday === '08-14', a2);
    const rec = await prisma.crmInboundEvent.findFirst({ where: { clientId: SH, subjectId: ashaCrm! }, orderBy: { receivedAt: 'desc' } });
    check('...recorded once, as applied', rec?.outcome === 'applied', rec);

    console.log('\n3. A WALK-IN ADDED IN CRM BY ANOTHER MODULE -> INVENTORY');
    const walkPhone = phone(3);
    const r3 = await asOther('POST', '/customers/find-or-add', { phone: walkPhone, name: 'E2E Walk-in Ravi', walkIn: true, externalId: `till-${STAMP}` });
    check('(another module adds a walk-in in CRM)', r3.status === 200 && r3.data?.data?.created === true, r3);
    const made = await within(30_000, async () => !!(await prisma.customer.findFirst({ where: { clientId: SH, phone: walkPhone, deletedAt: null } })));
    const ravi = await prisma.customer.findFirst({ where: { clientId: SH, phone: walkPhone, deletedAt: null } });
    check('Inventory got a copy of the walk-in, with a customer code, linked to CRM\'s id', made && /^CUS-/.test(ravi?.customerCode ?? '') && (await crmIdOf(ravi!.id)) === r3.data?.data?.customer?.id, ravi);

    console.log('\n4. NO ECHO');
    const before = await prisma.crmInboundEvent.count({ where: { clientId: SH } });
    await crm.update(SH, ashaCrm!, { name: 'E2E Asha (changed by Inventory)' });
    await new Promise(r => setTimeout(r, 6_000));
    check('a change Inventory made in CRM is not sent back to Inventory', (await prisma.crmInboundEvent.count({ where: { clientId: SH } })) === before);

    console.log('\n5. MERGED AND UNMERGED IN CRM');
    const email = `twin-${STAMP}@example.com`;
    const k = await mk('E2E Twin Meena', 6, { email }), d = await mk('E2E Twin Meena', 7, { email });
    await prisma.$transaction(async tx => {
      await postPoints(tx, { clientId: SH, customerId: k.id, kind: 'ADJUSTED', points: 100, onceKey: `e2e-${STAMP}-k`, note: 'e2e' });
      await postPoints(tx, { clientId: SH, customerId: d.id, kind: 'ADJUSTED', points: 40, onceKey: `e2e-${STAMP}-d`, note: 'e2e' });
    });
    await runLinkPass({ onlyClients: [SH] });
    const [kc, dc] = [await crmIdOf(k.id), await crmIdOf(d.id)];
    let sug: any = null;
    await within(20_000, async () => {
      const l = await asOther('GET', '/merges?status=open');
      // CRM's list: { suggestions: [{ id, reason, a: { id, ... }, b: { id, ... } }], open }
      const pairs: any[] = l.data?.data?.suggestions ?? [];
      sug = pairs.find(s => [s.a?.id, s.b?.id].includes(kc) && [s.a?.id, s.b?.id].includes(dc));
      return !!sug;
    });
    if (!sug) { skipped++; console.log('  SKIP CRM\'s matching offered no suggestion for the two twins: the merge path is covered by verify-crm-identity (signed events).'); }
    else {
      const m = await asOther('POST', `/merges/${sug.id}/merge`, { keepId: kc });
      check('(merged in CRM, keeping the first)', m.status === 200, m);
      const joined = await within(30_000, async () => !!(await prisma.customer.findUnique({ where: { id: d.id } }))?.deletedAt);
      const k2 = await prisma.customer.findUnique({ where: { id: k.id } });
      check('CRM\'s merge reached Inventory: the joined copy left the lists, the kept one has 140 points', joined && k2?.loyaltyPoints === 140, { joined, points: k2?.loyaltyPoints });
      const u = await asOther('POST', `/merges/${sug.id}/undo`);
      check('(undone in CRM)', u.status === 200, u);
      const back = await within(30_000, async () => !(await prisma.customer.findUnique({ where: { id: d.id } }))?.deletedAt);
      const [k3, d3] = [await prisma.customer.findUnique({ where: { id: k.id } }), await prisma.customer.findUnique({ where: { id: d.id } })];
      check('CRM\'s undo reached Inventory: the copy is back with its 40 points', back && k3?.loyaltyPoints === 100 && d3?.loyaltyPoints === 40, { back, k: k3?.loyaltyPoints, d: d3?.loyaltyPoints });
    }
    const evs = await prisma.crmInboundEvent.groupBy({ by: ['outcome'], where: { clientId: SH, receivedAt: { gte: new Date(STAMP) } }, _count: { _all: true } });
    console.log('  events Inventory received from CRM in this run:', JSON.stringify(evs.map(e => [e.outcome, e._count._all])));
  } catch (e: any) { failures.push(`crashed: ${e?.message}`); console.error(e); }
  finally {
    console.log(`\nRESULT: ${passed} passed | ${failures.length} failed${skipped ? ` | ${skipped} skipped (said above)` : ''}`);
    if (failures.length) console.log('FAILED: ' + failures.join(' | '));
    await prisma.$disconnect();
    process.exit(failures.length ? 1 : 0);
  }
})();
