/**
 * The counter history for CRM (owner, 28 Oct: the counter stays in Inventory, "send that
 * hyper-personalisation history to CRM").
 *
 * Over real HTTP against the local server (4016), signed in by token cookie (never a password: the
 * shared test logins are used by other chats), with the two CRM test shops:
 *   1. a look-up that finds the customer keeps one row: store, who looked (id and name), and what
 *      the card showed (picks, also bought, looked at online) -- brief, at most 12 each;
 *   2. a shop on CRM gets exactly one counter_lookup.created event in the module outbox, with that
 *      row; a shop not on CRM gets none;
 *   3. looking the same customer up again within 10 minutes (a re-tap) is the same visit: no
 *      second row; another salesperson, or another store, is a new row;
 *   4. a number nobody has, or a bad number, keeps nothing; the card's answer is unchanged.
 *
 * LOCAL DATABASE ONLY. Removes every row it made.
 *   DATABASE_URL=postgresql://postgres:localpw@localhost:55433/inventory npx tsx src/scripts/verify-counter-lookups.ts
 */
const LOCAL = 'localhost:55433';
if (!String(process.env.DATABASE_URL || '').includes(LOCAL)) {
  console.error(`Refusing to run: DATABASE_URL must point at the local copy (${LOCAL}).`);
  process.exit(2);
}
import { prisma } from '../lib/prisma';
import { AuthService } from '../services/auth.service';

const API = 'http://localhost:4016/api/v1';
const PHONE = '9848011122';   // Meena Iyer, in both CRM test shops
let passed = 0, failed = 0;
const failures: string[] = [];
const check = (name: string, ok: boolean, detail?: unknown) => {
  if (ok) { passed++; console.log(`  [PASS] ${name}`); }
  else { failed++; failures.push(name); console.log(`  [FAIL] ${name}${detail === undefined ? '' : `  -> ${JSON.stringify(detail)}`}`); }
};
const eq = (name: string, got: unknown, want: unknown) => check(name, JSON.stringify(got) === JSON.stringify(want), { got, want });
const settle = () => new Promise(r => setTimeout(r, 1200));   // the row is written after the answer

(async () => {
  const started = new Date();
  const made: { users: string[]; rows: string[] } = { users: [], rows: [] };
  try {
    const shop = async (clientId: string) => {
      const owner = await prisma.user.findFirstOrThrow({ where: { clientId, email: `owner@${clientId}.test` } });
      const stores = await prisma.stockLocation.findMany({ where: { clientId, type: 'STORE' as any }, orderBy: { createdAt: 'asc' }, select: { id: true } });
      return { clientId, owner, stores: stores.map(s => s.id) };
    };
    const on = await shop('crmui-on');
    const off = await shop('crmui-off');
    check('crmui-on is on CRM, crmui-off is not', !!(await prisma.moduleSubscription.findFirst({ where: { clientId: on.clientId, module: 'crm' } })) && !(await prisma.moduleSubscription.findFirst({ where: { clientId: off.clientId } })));
    const tokenOf = (u: { id: string; clientId: string; sessionVersion: number }) => AuthService.generateToken({ userId: u.id, clientId: u.clientId, sessionVersion: u.sessionVersion } as any);
    const card = (token: string, phone: string, locationId?: string) =>
      fetch(`${API}/customers/card?phone=${encodeURIComponent(phone)}${locationId ? `&locationId=${locationId}` : ''}`, { headers: { cookie: `token=${token}` } })
        .then(async r => ({ status: r.status, body: await r.json() }));
    const rowsOf = (clientId: string) => prisma.counterLookup.findMany({ where: { clientId, createdAt: { gte: started } }, orderBy: { createdAt: 'asc' } });
    const eventsOf = (clientId: string) => prisma.moduleEvent.findMany({ where: { clientId, kind: 'counter_lookup.created', createdAt: { gte: started } }, orderBy: { sequence: 'asc' } });

    console.log('\n1. A LOOK-UP KEEPS ONE ROW (shop on CRM)');
    const ownerTok = tokenOf(on.owner as any);
    const a = await card(ownerTok, PHONE, on.stores[0]);
    eq('the card answers as before: 200, Meena Iyer', [a.status, a.body.data?.customer?.name], [200, 'Meena Iyer']);
    await settle();
    let rows = await rowsOf(on.clientId);
    eq('one row', rows.length, 1);
    const row = rows[0];
    if (row) made.rows.push(row.id);
    eq('row: this customer, this store, this salesperson by id and name', [row?.customerId, row?.locationId, row?.userId, row?.userName], [a.body.data.customer.id, on.stores[0], on.owner.id, on.owner.name]);
    const picks = row?.picks as any[];
    eq('row: the picks the card showed, brief', picks.map(p => [p.productId, p.title]), (a.body.data.picks ?? []).slice(0, 12).map((p: any) => [p.productId, p.title]));
    eq('row: looked at online, as shown', (row?.lookedOnline as any[]).map(p => p.productId), (a.body.data.lookedOnline ?? []).slice(0, 12).map((p: any) => p.productId));
    check('row: no phone number and no price in what is kept', !JSON.stringify(row).includes(PHONE) && !JSON.stringify(row?.picks).includes('"price"'), row);

    console.log('\n2. THE OUTBOX');
    let ev = await eventsOf(on.clientId);
    eq('shop on CRM: exactly one counter_lookup.created, for that row', [ev.length, ev[0]?.module, ev[0]?.sourceTable, ev[0]?.rowId], [1, 'crm', 'counter_lookups', row?.id]);
    eq('the event carries the row (customer, salesperson, picks)', [(ev[0]?.payload as any)?.customer_id, (ev[0]?.payload as any)?.user_name, ((ev[0]?.payload as any)?.picks ?? []).length], [row?.customerId, on.owner.name, picks.length]);

    console.log('\n3. RE-TAPS, ANOTHER SALESPERSON, ANOTHER STORE');
    await card(ownerTok, PHONE, on.stores[0]);
    await card(ownerTok, `+91 ${PHONE}`, on.stores[0]);
    await settle();
    eq('the same person looked up again within 10 minutes: still one row', (await rowsOf(on.clientId)).length, 1);
    // A throwaway salesperson of this shop (made here, removed after; the shared logins are not touched).
    const role = await prisma.role.findFirst({ where: { clientId: on.clientId } });
    const sales = await prisma.user.create({ data: { clientId: on.clientId, email: `counter-test-${Date.now()}@example.invalid`, name: 'Counter Test Ravi', password: 'x-not-a-login', ...(role ? { roles: { create: { roleId: role.id } } } : {}) } as any });
    made.users.push(sales.id);
    const b = await card(tokenOf(sales as any), PHONE, on.stores[0]);
    await settle();
    rows = await rowsOf(on.clientId);
    if (b.status === 200) eq('another salesperson: a new row, with their name', [rows.length, rows[1]?.userName], [2, 'Counter Test Ravi']);
    else check('another salesperson (no card permission in this role): refused, nothing kept', b.status === 403 && rows.length === 1, [b.status, rows.length]);
    if (on.stores[1]) {
      await card(ownerTok, PHONE, on.stores[1]);
      await settle();
      eq('another store: a new row', (await rowsOf(on.clientId)).filter(r => r.locationId === on.stores[1]).length, 1);
    } else console.log('  (crmui-on has one store: the other-store case is covered by the where-clause only)');
    // The window has passed: pretend the first row is older than 10 minutes.
    await prisma.counterLookup.update({ where: { id: row!.id }, data: { createdAt: new Date(Date.now() - 11 * 60_000) } });
    await card(ownerTok, PHONE, on.stores[0]);
    await settle();
    eq('after 10 minutes, the same look-up is a new visit', (await rowsOf(on.clientId)).filter(r => r.userId === on.owner.id && r.locationId === on.stores[0]).length, 1);   // the moved first row now counts as before the run

    console.log('\n4. NOTHING TO KEEP');
    const before = (await rowsOf(on.clientId)).length;
    const nobody = await card(ownerTok, '9000000001', on.stores[0]);
    eq('a number nobody has: 200, no customer', [nobody.status, nobody.body.data?.customer ?? null], [200, null]);
    const bad = await card(ownerTok, 'abc', on.stores[0]);
    check('a bad number: refused with a sentence, not a crash', bad.status === 400 || (bad.status === 200 && !bad.body.data?.customer), [bad.status, bad.body]);
    await settle();
    eq('neither kept a row', (await rowsOf(on.clientId)).length, before);

    console.log('\n5. A SHOP NOT ON CRM');
    const offCard = await card(tokenOf(off.owner as any), PHONE, off.stores[0]);
    eq('crmui-off: the card works', [offCard.status, offCard.body.data?.customer?.name], [200, 'Meena Iyer']);
    await settle();
    eq('crmui-off: the row is kept (Inventory\'s own history)', (await rowsOf(off.clientId)).length, 1);
    eq('crmui-off: no outbox event', (await eventsOf(off.clientId)).length, 0);
    ev = await eventsOf(on.clientId);
    // rowsOf leaves out the first row, moved 11 minutes back above; it still has its one event.
    eq('crmui-on: one event per kept row, no more', ev.map(e => e.rowId).sort(), [...made.rows, ...(await rowsOf(on.clientId)).map(r => r.id)].sort());
  } catch (e: any) {
    console.error(e);
    check(`the suite reached the end (stopped at: ${String(e?.message ?? e).trim().split('\n')[0]})`, false);
  } finally {
    for (const clientId of ['crmui-on', 'crmui-off']) {
      await prisma.moduleEvent.deleteMany({ where: { clientId, kind: 'counter_lookup.created', createdAt: { gte: started } } }).catch(e => console.log('left events', e.message));
      await prisma.counterLookup.deleteMany({ where: { clientId, OR: [{ createdAt: { gte: started } }, { id: { in: made.rows } }] } }).catch(e => console.log('left rows', e.message));
    }
    if (made.users.length) await prisma.user.deleteMany({ where: { id: { in: made.users } } }).catch(e => console.log('left user', e.message));
    console.log(`\n${passed} passed, ${failed} failed`);
    if (failures.length) console.log('FAILED: ' + failures.join(' | '));
    await prisma.$disconnect();
    process.exit(failed ? 1 : 0);
  }
})();
