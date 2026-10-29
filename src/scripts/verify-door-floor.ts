/**
 * The shop floor for door check-ins (29 Oct): waiting time, who is busy, who a customer asked for,
 * passing them on, Done (by hand or by a bill), and the 5-minute waiting alert.
 *
 * Throwaway shop for the service checks (removed at the end), and the local server's real routes for
 * the HTTP checks (verify-suites-tenant, token cookies). The welcome / sorry-for-the-wait WhatsApp is
 * captured instead of sent -- the one stand-in, for what would reach a real phone.
 *
 * LOCAL DATABASE ONLY.
 *   DATABASE_URL=… DIRECT_URL=… ROLE_TOKENS=<old scratchpad>/local-tokens.json IDS=<old scratchpad>/local-ids.json npx tsx src/scripts/verify-door-floor.ts
 */
const LOCAL = 'localhost:55433';
if (!String(process.env.DATABASE_URL || '').includes(LOCAL) || !String(process.env.DIRECT_URL || '').includes(LOCAL)) {
  console.error(`Refusing to run: DATABASE_URL and DIRECT_URL must both point at the local copy (${LOCAL}).`);
  process.exit(2);
}
import fs from 'node:fs';

let passed = 0, failed = 0;
const failures: string[] = [];
const check = (name: string, ok: boolean, detail?: unknown) => {
  if (ok) { passed++; console.log(`  [PASS] ${name}`); }
  else { failed++; failures.push(name); console.log(`  [FAIL] ${name}${detail === undefined ? '' : `  -> ${JSON.stringify(detail).slice(0, 400)}`}`); }
};
const eq = (name: string, got: unknown, want: unknown) => check(name, JSON.stringify(got) === JSON.stringify(want), { got, want });
const refusal = (p: Promise<unknown>) => p.then(() => null, (e: any) => ({ status: e?.statusCode ?? 0, message: String(e?.message ?? e), askedFor: e?.askedFor }));

const STAMP = Date.now();
const C = `floor-${STAMP}`, OTHER = `floor-other-${STAMP}`;

(async () => {
  const { prisma } = await import('../lib/prisma');
  const { doorCheckins, doorCode, checkinWelcome, WAIT_ALERT_MS } = await import('../services/door-checkin');
  const sent: any[] = [];
  checkinWelcome.send = async (input: any) => { sent.push(input); return null as any; };
  const httpRows: string[] = [];
  const api = 'http://localhost:4016/api/v1';
  const tokens: Record<string, string> = JSON.parse(fs.readFileSync(process.env.ROLE_TOKENS!, 'utf8'));
  const ids = JSON.parse(fs.readFileSync(process.env.IDS!, 'utf8'));
  const call = (who: string, method: string, path: string, body?: unknown) =>
    fetch(`${api}${path}`, { method, headers: { 'content-type': 'application/json', origin: 'http://localhost:5183', cookie: `token=${tokens[who]}` }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) })
      .then(async r => ({ status: r.status, body: await r.json().catch(() => null) as any }));

  try {
    const store = await prisma.stockLocation.create({ data: { clientId: C, name: 'Main Store', code: `FM-${STAMP}`, type: 'STORE' as any, active: true } });
    await prisma.stockLocation.create({ data: { clientId: OTHER, name: 'Theirs', code: `FO-${STAMP}`, type: 'STORE' as any, active: true } });
    await prisma.clientSettings.create({ data: { clientId: C, businessName: 'Lakshmi Silks' } as any });
    const mk = (name: string, status = 'ACTIVE', clientId = C) => prisma.user.create({ data: { clientId, email: `${name.toLowerCase()}-${STAMP}@example.com`, name, password: 'unused', status: status as any } });
    const lakshmi = await mk('Lakshmi'), ravi = await mk('Ravi'), priya = await mk('Priya'), gone = await mk('Gone', 'INACTIVE'), stranger = await mk('Stranger', 'ACTIVE', OTHER);
    const L = { id: lakshmi.id, name: 'Lakshmi' }, R = { id: ravi.id, name: 'Ravi' }, P = { id: priya.id, name: 'Priya' };
    const OWNER = { id: 'owner-x', name: 'Owner', owner: true };
    const meena = await prisma.customer.create({ data: { clientId: C, customerCode: `FC1-${STAMP}`, name: 'Meena Iyer', phone: '+919848044411' } });
    const kavya = await prisma.customer.create({ data: { clientId: C, customerCode: `FC2-${STAMP}`, name: 'Kavya Reddy', phone: '+919848044422', whatsappStoppedAt: new Date() } as any });
    const code = doorCode(C, store.id);
    const at = (minAgo: number) => new Date(Date.now() - minAgo * 60_000);
    const arrive = (digits: string, when: Date) => doorCheckins.record(C, digits, code, when);
    const list = () => doorCheckins.list(C, store.id);
    const row = (id: string) => prisma.storeCheckin.findUniqueOrThrow({ where: { id } });

    console.log('\n1. WAITING TIME, AND WHO WAITED LONGEST');
    const m = await arrive('919848044411', at(9));
    const n = await arrive('919848044433', at(3));
    await arrive('919848044411', at(1));            // Meena scans again
    let l = await list();
    eq('a second scan keeps her waiting time (since 9 minutes ago), not "just now"', Math.round((Date.now() - new Date((await row(m!.id)).waitingSince).getTime()) / 60000), 9);
    eq('longest waiting first: Meena, then the new number', l.arrivals.map(a => a.id), [m!.id, n!.id]);
    eq('the staff: everybody active in the shop, nobody busy; the switched-off and another shop\'s are not there', l.staff.map(s => [s.name, s.with]), [['Lakshmi', 0], ['Priya', 0], ['Ravi', 0]]);

    console.log('\n2. ASKED FOR SOMEONE');
    let r: any = await doorCheckins.askFor(C, m!.id, ravi.id);
    eq('"they asked for Ravi"', r.askedFor, { id: ravi.id, name: 'Ravi' });
    eq('...the list says so', (await list()).arrivals.find(a => a.id === m!.id)?.askedFor, { id: ravi.id, name: 'Ravi' });
    let x = await refusal(doorCheckins.take(C, m!.id, L));
    eq('Lakshmi taking her: refused with who she asked for', [x?.status, x?.message, x?.askedFor], [409, 'Meena Iyer asked for Ravi.', 'Ravi']);
    eq('...nobody has her yet', (await row(m!.id)).takenById, null);
    x = await refusal(doorCheckins.askFor(C, m!.id, gone.id));
    eq('asking for someone switched off: refused', [x?.status, x?.message], [400, 'Choose somebody who works in this shop.']);
    x = await refusal(doorCheckins.askFor(C, m!.id, stranger.id));
    eq('asking for another shop\'s person: refused', x?.status, 400);
    r = await doorCheckins.askFor(C, n!.id, null);
    eq('"nobody in particular" clears it', r.askedFor, null);
    r = await doorCheckins.take(C, m!.id, R);
    eq('Ravi, who she asked for, takes her: no question asked', [r.takenBy, (await row(m!.id)).takenById], ['Ravi', ravi.id]);
    x = await refusal(doorCheckins.askFor(C, m!.id, priya.id));
    eq('once someone is with her, "asked for" is refused', [x?.status, x?.message], [409, 'Ravi is already with them.']);
    x = await refusal(doorCheckins.take(C, m!.id, P));
    eq('Priya cannot take her from Ravi by taking', [x?.status, x?.message], [409, 'Ravi is already with them.']);
    l = await list();
    eq('Ravi is with 1; the waiting one first, then the taken one', [l.staff.find(s => s.id === ravi.id)?.with, l.arrivals.map(a => a.id)], [1, [n!.id, m!.id]]);

    console.log('\n3. TAKING ANYWAY');
    await doorCheckins.askFor(C, n!.id, priya.id);
    x = await refusal(doorCheckins.take(C, n!.id, L));
    eq('asked for Priya, Lakshmi tries: asked first', x?.askedFor, 'Priya');
    r = await doorCheckins.take(C, n!.id, L, true);
    eq('"take them anyway": Lakshmi has them', [r.takenBy, (await row(n!.id)).takenById], ['Lakshmi', lakshmi.id]);

    console.log('\n4. PASSING ON');
    x = await refusal(doorCheckins.pass(C, m!.id, priya.id, P));
    eq('Priya cannot pass on Ravi\'s customer', [x?.status, x?.message], [403, 'Only the person with them, or the owner, can pass them on.']);
    x = await refusal(doorCheckins.pass(C, m!.id, ravi.id, R));
    eq('passing to the person already with them: refused', [x?.status, x?.message], [400, 'They are already with Ravi.']);
    x = await refusal(doorCheckins.pass(C, m!.id, gone.id, R));
    eq('passing to someone switched off: refused', x?.status, 400);
    r = await doorCheckins.pass(C, m!.id, priya.id, R);
    l = await list();
    const mm = l.arrivals.find(a => a.id === m!.id);
    eq('Ravi passes her to Priya: with Priya, "passed by Ravi", Ravi free', [r.takenBy, mm?.takenById, mm?.passedBy, l.staff.find(s => s.id === ravi.id)?.with, l.staff.find(s => s.id === priya.id)?.with], ['Priya', priya.id, 'Ravi', 0, 1]);
    // The database keeps JSON's keys in its own order: compare the values, not the order.
    const kept = ((await row(m!.id)).handoffs as any[]).map(h => [h.fromId, h.fromName, h.toId, h.toName, typeof h.at]);
    eq('...kept on her record', kept, [[ravi.id, 'Ravi', priya.id, 'Priya', 'string']]);
    r = await doorCheckins.pass(C, m!.id, ravi.id, OWNER);
    eq('the owner can pass anybody\'s customer: back to Ravi', r.takenBy, 'Ravi');
    const twice = await Promise.allSettled([doorCheckins.pass(C, m!.id, lakshmi.id, R), doorCheckins.pass(C, m!.id, priya.id, R)]);
    const ok = twice.filter(t => t.status === 'fulfilled').length;
    const holder = (await row(m!.id)).takenById;
    check('Ravi passes her to two people at the same moment: exactly one lands', ok === 1 && (holder === lakshmi.id || holder === priya.id), { ok, holder });

    console.log('\n5. DONE');
    const holderUser = holder === lakshmi.id ? L : P;
    const other = holder === lakshmi.id ? P : L;
    x = await refusal(doorCheckins.done(C, m!.id, other));
    eq('someone who is not with her cannot finish her', x?.status, 403);
    const busyBefore = (await list()).staff.find(s => s.id === holder)?.with ?? 0;
    r = await doorCheckins.done(C, m!.id, holderUser);
    l = await list();
    check('Done: off the list, and that person has one customer fewer', r.done && !l.arrivals.some(a => a.id === m!.id) && l.staff.find(s => s.id === holder)?.with === busyBefore - 1, { busyBefore, staff: l.staff });
    eq('Done twice: the same calm answer', (await doorCheckins.done(C, m!.id, holderUser)).done, true);
    x = await refusal(doorCheckins.take(C, m!.id, L));
    eq('taking her after Done: she has been helped', [x?.status, x?.message], [409, 'They have already been helped.']);
    x = await refusal(doorCheckins.done(C, (await arrive('919848044455', at(1)))!.id, OWNER));
    eq('Done for someone nobody has taken: refused', x?.status, 400);

    console.log('\n6. LAST TIME, AND A NEW VISIT AFTER DONE');
    const again = await arrive('919848044411', new Date());
    check('Meena scans again after Done: a new visit, not the finished one', !!again && again.id !== m!.id && again.fresh === true, again);
    l = await list();
    eq('...and the list says who helped her last time', l.arrivals.find(a => a.id === again!.id)?.lastHelpedBy?.id, holder);

    console.log('\n7. A BILL FINISHES THE VISIT');
    await doorCheckins.take(C, again!.id, R);
    const before = await prisma.salesOrder.create({ data: { clientId: C, locationId: store.id, customerId: meena.id, orderNumber: `FL-${STAMP}-0`, channel: 'POS', status: 'CONFIRMED', subtotal: 100, total: 100, createdAt: at(30) } as any }).catch(e => { console.log('bill', e.message); return null; });
    l = await list();
    check('a bill from BEFORE she was taken does not finish her', l.arrivals.some(a => a.id === again!.id), l.arrivals.map(a => a.id));
    const bill = await prisma.salesOrder.create({ data: { clientId: C, locationId: store.id, customerId: meena.id, orderNumber: `FL-${STAMP}-1`, channel: 'POS', status: 'CONFIRMED', subtotal: 100, total: 100 } as any }).catch(e => { console.log('bill', e.message); return null; });
    l = await list();
    check('a bill for her at this store after Ravi took her: done by itself, Ravi free', !!bill && !l.arrivals.some(a => a.id === again!.id) && !!(await row(again!.id)).doneAt && l.staff.find(s => s.id === ravi.id)?.with === 0, { bill: !!bill, before: !!before });

    console.log('\n8. WAITING TOO LONG');
    sent.length = 0;
    const late = await arrive('919848044466', at(6));
    const lateStop = await arrive('919848044422', at(7));     // Kavya replied STOP
    const notYet = await arrive('919848044477', at(4));
    sent.length = 0;
    r = await doorCheckins.waitTick(new Date(), [C]);
    const alerts = await prisma.inventoryAlert.findMany({ where: { clientId: C, type: 'CUSTOMER_WAITING' as any }, orderBy: { createdAt: 'asc' } });
    check('after 5 minutes with nobody taking them: the owner\'s bell, once each (not the 4-minute one)', r.raised === 2 && alerts.length === 2 && alerts.every(a => a.severity === 'WARNING' && a.locationId === store.id), { r, alerts: alerts.map(a => a.title) });
    check('...the alert says who and where', alerts.some(a => a.title === 'Kavya Reddy is waiting at Main Store' && /has waited 7 minutes at Main Store/.test(a.message)), alerts.map(a => [a.title, a.message]));
    eq('...one "sorry for the wait" to the new number; none to Kavya, who replied STOP', sent.map(s => [s.to, s.text, s.idempotencyKey]), [['+919848044466', 'Sorry for the wait. Someone from Lakshmi Silks will be with you in a few minutes.', `sorry:${late!.id}`]]);
    r = await doorCheckins.waitTick(new Date(), [C]);
    eq('the next minute: nothing again for the same people', [r.raised, sent.length], [0, 1]);
    r = await doorCheckins.waitTick(new Date(Date.now() + 2 * 60_000), [C]);
    eq('two minutes later the 4-minute one has waited 6: its turn', r.raised, 1);
    await doorCheckins.take(C, late!.id, L);
    const settled = await prisma.inventoryAlert.findUniqueOrThrow({ where: { id: (await row(late!.id)).waitAlertId! } });
    eq('someone takes them: their alert is settled', settled.isResolved, true);
    void lateStop; void notYet; void kavya; void WAIT_ALERT_MS;

    console.log('\n9. ANOTHER SHOP');
    // One at a time (thunks): started together, a refusal can land before it is awaited.
    for (const [what, run] of [['take', () => doorCheckins.take(OTHER, n!.id, L)], ['ask', () => doorCheckins.askFor(OTHER, n!.id, ravi.id)], ['pass', () => doorCheckins.pass(OTHER, n!.id, ravi.id, OWNER)], ['done', () => doorCheckins.done(OTHER, n!.id, OWNER)]] as const) {
      x = await refusal((run as () => Promise<unknown>)());
      eq(`another shop's id for "${what}": not found`, x?.status, 404);
    }

    console.log('\n10. THE REAL ROUTES (local server, verify-suites-tenant)');
    const ownerId = JSON.parse(Buffer.from(tokens.SUPER_ADMIN.split('.')[1], 'base64url').toString()).sub;
    const ownerName = (await prisma.user.findUniqueOrThrow({ where: { id: ownerId } })).name;
    const h = await prisma.storeCheckin.create({ data: { clientId: ids.clientId, locationId: ids.locationId, phone: '+919848044499', askedForId: ownerId, askedForName: ownerName } });
    httpRows.push(h.id);
    let res = await call('SALES', 'GET', `/customers/checkins?locationId=${ids.locationId}`);
    check('GET checkins: arrivals and staff', res.status === 200 && Array.isArray(res.body?.data?.arrivals) && Array.isArray(res.body?.data?.staff) && res.body.data.arrivals.some((a: any) => a.id === h.id && a.askedFor?.id === ownerId), res.body);
    res = await call('SALES', 'POST', `/customers/checkins/${h.id}/take`);
    eq('the salesperson takes someone who asked for the owner: 409 with the name', [res.status, res.body?.askedFor], [409, ownerName]);
    res = await call('SALES', 'POST', `/customers/checkins/${h.id}/take`, { anyway: true });
    eq('...take them anyway: 200', res.status, 200);
    res = await call('SALES', 'POST', `/customers/checkins/${h.id}/pass`, { userId: ownerId });
    eq('the salesperson passes them to the owner', [res.status, res.body?.data?.takenById], [200, ownerId]);
    res = await call('SALES', 'POST', `/customers/checkins/${h.id}/done`);
    eq('...and can no longer finish them (the owner has them)', res.status, 403);
    res = await call('SUPER_ADMIN', 'POST', `/customers/checkins/${h.id}/done`);
    eq('the owner finishes them', [res.status, res.body?.data?.done], [200, true]);
  } catch (e: any) {
    console.error(e);
    check(`the suite reached the end (stopped at: ${String(e?.message ?? e).split('\n')[0]})`, false);
  } finally {
    await prisma.storeCheckin.deleteMany({ where: { OR: [{ clientId: { in: [C, OTHER] } }, { id: { in: httpRows } }] } }).catch(() => null);
    await prisma.inventoryAlert.deleteMany({ where: { clientId: { in: [C, OTHER] } } }).catch(() => null);
    await prisma.salesOrder.deleteMany({ where: { clientId: C } }).catch(() => null);
    await prisma.customer.deleteMany({ where: { clientId: C } }).catch(() => null);
    await prisma.user.deleteMany({ where: { clientId: { in: [C, OTHER] } } }).catch(() => null);
    await prisma.clientSettings.deleteMany({ where: { clientId: C } }).catch(() => null);
    await prisma.stockLocation.deleteMany({ where: { clientId: { in: [C, OTHER] } } }).catch(() => null);
    console.log(`\n${passed} passed, ${failed} failed`);
    if (failures.length) console.log('FAILED: ' + failures.join(' | '));
    await prisma.$disconnect();
    process.exit(failed ? 1 : 0);
  }
})();
