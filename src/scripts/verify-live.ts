/**
 * Instant updates (12 Nov 2026, PLAN-live.md): database triggers -> one listener -> GET /api/v1/live per shop.
 * Over the real route of a LOCAL server (VERIFY_API_URL), with app tokens, on a throwaway shop and a second one.
 *
 *   A  sign-in needed; an open line says ready (and that the server is listening)
 *   B  a change in my shop reaches me within 2 s with its topic; another shop's change never does
 *   C  50 stock lines in one transaction: one message; a rolled-back change: nothing; two kinds close together: one message
 *   D  the line to the database is cut: the server comes back and tells every screen "everything"
 *   E  the 20-second heartbeat arrives on a quiet line
 *
 *   DATABASE_URL=<local> DIRECT_URL=<local> VERIFY_API_URL=http://localhost:4036/api/v1 npx tsx src/scripts/verify-live.ts
 */
import http from 'node:http';
import { prisma } from '../lib/prisma';
import { AuthService } from '../services/auth.service';
import { seedRolesForClient } from '../services/rbac-seed.service';

for (const k of ['DATABASE_URL', 'DIRECT_URL']) {
  if (!/localhost:55433/.test(process.env[k] ?? '')) { console.error(`Refusing: ${k} is not the local database.`); process.exit(2); }
}
const BASE = new URL(process.env.VERIFY_API_URL || 'http://localhost:4036/api/v1');
if (!/localhost|127\.0\.0\.1/.test(BASE.hostname)) { console.error('Refusing: not a local server.'); process.exit(2); }
const STAMP = Date.now();
const SHOP = `live-${STAMP}`;
const OTHER = `live-other-${STAMP}`;
let passed = 0, failed = 0;
const check = (name: string, ok: boolean, detail = '') => {
  if (ok) { passed++; console.log(`  ok   ${name}`); } else { failed++; console.log(`  FAIL ${name} -- ${detail}`); }
};
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

type Line = { messages: { event: string; data: any; at: number }[]; comments: number; status: number; close: () => void };
function open(token: string | null): Promise<Line> {
  return new Promise(resolve => {
    const line: Line = { messages: [], comments: 0, status: 0, close: () => undefined };
    const req = http.get({ hostname: BASE.hostname, port: BASE.port, path: `${BASE.pathname}/live`, headers: token ? { Authorization: `Bearer ${token}` } : {} }, res => {
      line.status = res.statusCode ?? 0;
      line.close = () => { req.destroy(); };
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', chunk => {
        buf += chunk;
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i); buf = buf.slice(i + 2);
          if (block.startsWith(':')) { line.comments++; continue; }
          let event = 'message', data = '';
          for (const l of block.split('\n')) {
            if (l.startsWith('event: ')) event = l.slice(7);
            else if (l.startsWith('data: ')) data += l.slice(6);
          }
          if (data) line.messages.push({ event, data: JSON.parse(data), at: Date.now() });
        }
      });
      resolve(line);
    });
    req.on('error', () => resolve(line));
  });
}
const topicsOf = (l: Line, from = 0) => l.messages.slice(from).filter(m => m.event === 'message').map(m => m.data.topics as string[]);
const waitFor = async (l: Line, from: number, ms: number) => { const until = Date.now() + ms; while (Date.now() < until && topicsOf(l, from).length === 0) await sleep(50); return topicsOf(l, from); };

async function main() {
  const roles = await seedRolesForClient(SHOP);
  const rolesB = await seedRolesForClient(OTHER);
  const hash = await AuthService.hashPassword('Same-Pass-123');
  const mkUser = async (clientId: string, roleId: string) => {
    const u = await prisma.user.create({ data: { clientId, email: `live-${clientId}@example.com`, name: 'Live Tester', password: hash, status: 'ACTIVE' as any } });
    await prisma.userRole.create({ data: { userId: u.id, roleId } });
    return AuthService.generateToken({ userId: u.id, clientId });
  };
  const token = await mkUser(SHOP, roles.SUPER_ADMIN);
  const tokenB = await mkUser(OTHER, rolesB.SUPER_ADMIN);
  const store = await prisma.stockLocation.create({ data: { clientId: SHOP, name: 'Main', code: `LV-${STAMP}`, type: 'STORE' as any, active: true } });
  const product = await prisma.product.create({ data: { clientId: SHOP, productCode: `LVP-${STAMP}`, slug: `lvp-${STAMP}`, title: 'Live saree', category: 'WOMEN' as any, productType: 'READY_TO_WEAR' as any, basePrice: 1000, status: 'ACTIVE' as any } });
  const variants = await Promise.all(Array.from({ length: 50 }, (_, i) => prisma.productVariant.create({ data: { productId: product.id, clientId: SHOP, colorName: `C${i}`, size: 'Free', variantCode: `LVV-${STAMP}-${i}`, sku: `LVS-${STAMP}-${i}`, sellingPrice: 1000 } })));
  await prisma.inventoryStock.createMany({ data: variants.map(v => ({ clientId: SHOP, variantId: v.id, locationId: store.id, quantity: 1 })) });
  const customer = await prisma.customer.create({ data: { clientId: SHOP, customerCode: `LVC-${STAMP}`, name: 'Live Customer', phone: '+919000077001' } });
  const theirs = await prisma.customer.create({ data: { clientId: OTHER, customerCode: `LVC2-${STAMP}`, name: 'Their Customer', phone: '+919000077002' } });
  await sleep(800);

  console.log('A. OPENING THE LINE');
  const anon = await open(null);
  check('no sign-in: refused', anon.status === 401, String(anon.status));
  anon.close();
  const me = await open(token);
  const other = await open(tokenB);
  await sleep(500);
  const ready = me.messages.find(m => m.event === 'ready');
  check('signed in: the line opens and says ready, with the server listening', me.status === 200 && !!ready && ready.data.listening === true, JSON.stringify(me.messages));

  console.log('\nB. MY SHOP, NOT OTHERS');
  let mark = me.messages.length, markB = other.messages.length;
  const t0 = Date.now();
  await prisma.customer.update({ where: { id: customer.id }, data: { name: 'Live Customer (renamed)' } });
  let got = await waitFor(me, mark, 2000);
  check('a customer changed in my shop: "customers" reaches me within 2 s', got.flat().includes('customers'), JSON.stringify(got));
  check('...in under 2 seconds', (me.messages[me.messages.length - 1]?.at ?? 0) - t0 < 2000, `${(me.messages[me.messages.length - 1]?.at ?? 0) - t0} ms`);
  await sleep(600);
  check('the other shop heard nothing of it', topicsOf(other, markB).length === 0, JSON.stringify(topicsOf(other, markB)));
  mark = me.messages.length;
  await prisma.customer.update({ where: { id: theirs.id }, data: { name: 'Their Customer (renamed)' } });
  const gotB = await waitFor(other, markB, 2000);
  await sleep(600);
  check('their change reaches them, never me', gotB.flat().includes('customers') && topicsOf(me, mark).length === 0, `${JSON.stringify(gotB)} / mine ${JSON.stringify(topicsOf(me, mark))}`);

  console.log('\nC. BURSTS, ROLLBACKS, TWO KINDS');
  mark = me.messages.length;
  await prisma.$transaction(variants.map(v => prisma.inventoryStock.updateMany({ where: { clientId: SHOP, variantId: v.id }, data: { quantity: 2 } })));
  await waitFor(me, mark, 2000);
  await sleep(800);
  const burst = topicsOf(me, mark);
  check('50 stock lines in one transaction: one message, saying stock', burst.length === 1 && burst[0].includes('stock'), JSON.stringify(burst));
  mark = me.messages.length;
  await prisma.$transaction(async tx => {
    await tx.customer.update({ where: { id: customer.id }, data: { name: 'Never saved' } });
    throw new Error('rolled back on purpose');
  }).catch(() => undefined);
  await sleep(1200);
  check('a change that was rolled back: nothing', topicsOf(me, mark).length === 0, JSON.stringify(topicsOf(me, mark)));
  mark = me.messages.length;
  await prisma.customer.update({ where: { id: customer.id }, data: { name: 'Live Customer again' } });
  await prisma.inventoryStock.updateMany({ where: { clientId: SHOP, variantId: variants[0].id }, data: { quantity: 3 } });
  await waitFor(me, mark, 2000);
  await sleep(800);
  const two = topicsOf(me, mark);
  check('a customer and a stock change close together: one message with both', two.length === 1 && two[0].includes('customers') && two[0].includes('stock'), JSON.stringify(two));

  console.log('\nD. THE LINE TO THE DATABASE IS CUT');
  mark = me.messages.length;
  const cut = await prisma.$queryRawUnsafe<any[]>(`SELECT pg_terminate_backend(pid) AS ok FROM pg_stat_activity WHERE query ILIKE 'LISTEN inventory_live%' AND pid <> pg_backend_pid()`);
  check('the listening connection is cut', cut.length >= 1, JSON.stringify(cut));
  const back = await waitFor(me, mark, 8000);
  check('the server comes back and tells my screen to reload everything', back.length >= 1 && ['orders', 'stock', 'customers', 'alerts'].every(t => back.flat().includes(t)), JSON.stringify(back));
  mark = me.messages.length;
  await prisma.customer.update({ where: { id: customer.id }, data: { name: 'After the cut' } });
  got = await waitFor(me, mark, 3000);
  check('...and changes reach me again after it', got.flat().includes('customers'), JSON.stringify(got));

  console.log('\nE. A QUIET LINE');
  const before = me.comments;
  await sleep(21_000);
  check('a heartbeat arrives within 20 s on a quiet line', me.comments > before, `${before} -> ${me.comments}`);
  me.close(); other.close();
}

main()
  .catch(e => { failed++; console.error('CRASHED', e); })
  .finally(async () => {
    for (const c of [SHOP, OTHER]) {
      await prisma.inventoryStock.deleteMany({ where: { clientId: c } });
      await prisma.productVariant.deleteMany({ where: { clientId: c } });
      await prisma.product.deleteMany({ where: { clientId: c } });
      await prisma.customer.deleteMany({ where: { clientId: c } });
      await prisma.stockLocation.deleteMany({ where: { clientId: c } });
      const users = await prisma.user.findMany({ where: { clientId: c }, select: { id: true } });
      await prisma.userRole.deleteMany({ where: { userId: { in: users.map(u => u.id) } } });
      await prisma.user.deleteMany({ where: { clientId: c } });
      const roleIds = (await prisma.role.findMany({ where: { clientId: c }, select: { id: true } })).map(r => r.id);
      await prisma.rolePermission.deleteMany({ where: { roleId: { in: roleIds } } });
      await prisma.role.deleteMany({ where: { clientId: c } });
    }
    const left = await prisma.customer.count({ where: { clientId: { in: [SHOP, OTHER] } } }) + await prisma.user.count({ where: { clientId: { in: [SHOP, OTHER] } } });
    check('nothing left behind', left === 0, String(left));
    console.log(`\n${passed} passed, ${failed} failed`);
    await prisma.$disconnect();
    process.exit(failed ? 1 : 0);
  });
