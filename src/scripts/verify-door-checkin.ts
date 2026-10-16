/**
 * Door QR check-in, through the same door the WhatsApp Service uses (handleEvent with
 * contact.checked_in), on a throwaway shop removed at the end. The welcome is captured, not sent.
 *
 *   npx tsx src/scripts/verify-door-checkin.ts
 */
import { prisma } from '../lib/prisma';
import * as wa from '../services/whatsapp/service';
import { doorCheckins, doorCode, checkinWelcome, VISIT_MS } from '../services/door-checkin';

const STAMP = Date.now();
const C = `door-${STAMP}`;
const OTHER = `door-other-${STAMP}`;
let passed = 0, failed = 0;
const check = (name: string, ok: boolean, detail?: unknown) => {
  if (ok) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name}${detail !== undefined ? ` -- ${JSON.stringify(detail).slice(0, 400)}` : ''}`); }
};
const sent: any[] = [];
checkinWelcome.send = async (input: any) => { sent.push(input); return null as any; };
let ev = 0;
const arrive = (clientId: string, contact: string, code: string, kind = 'CLIENT') =>
  wa.handleEvent({ id: `evt-door-${STAMP}-${++ev}`, type: 'contact.checked_in', data: { kind, clientId, contact, code, at: new Date().toISOString() } });
const rows = (where: any = {}) => prisma.storeCheckin.findMany({ where: { clientId: C, ...where }, orderBy: { createdAt: 'asc' } });

async function main() {
  const main = await prisma.stockLocation.create({ data: { clientId: C, name: 'Main Store', code: `DM-${STAMP}`, type: 'STORE' as any, active: true } });
  const branch = await prisma.stockLocation.create({ data: { clientId: C, name: 'Branch', code: `DB-${STAMP}`, type: 'STORE' as any, active: true } });
  const elsewhere = await prisma.stockLocation.create({ data: { clientId: OTHER, name: 'Their Store', code: `DO-${STAMP}`, type: 'STORE' as any, active: true } });
  await prisma.clientSettings.create({ data: { clientId: C, businessName: 'Lakshmi Silks', gstRegistration: 'UNREGISTERED' } as any });
  const meena = await prisma.customer.create({ data: { clientId: C, customerCode: `DC-${STAMP}`, name: 'Meena Iyer', phone: '+919848033311', tags: ['VIP'] } });
  const mainCode = doorCode(C, main.id);

  console.log('\nA. DOOR CODES');
  check('six letters and digits, none of 0 O 1 I', /^[A-HJ-NP-Z2-9]{6}$/.test(mainCode), mainCode);
  check('the same every time for a store, so a printed standee keeps working', doorCode(C, main.id) === mainCode);
  check('each store has its own, and another shop never shares it', doorCode(C, branch.id) !== mainCode && doorCode(OTHER, main.id) !== mainCode);

  console.log('\nB. A CUSTOMER ARRIVES');
  const r1 = await arrive(C, '919848033311', mainCode);
  let all = await rows();
  check('the WhatsApp event is taken and Meena is in Main Store\'s list', r1.handled && all.length === 1 && all[0].locationId === main.id && all[0].customerId === meena.id && all[0].phone === '+919848033311', all);
  check('...she gets one welcome back by name, from the shop', sent.length === 1 && sent[0].to === '+919848033311' && sent[0].text === 'Welcome back, Meena! Someone from Lakshmi Silks will be with you in a moment.' && sent[0].idempotencyKey === `welcome:${all[0].id}`, sent);
  const dup = await wa.handleEvent({ id: `evt-door-${STAMP}-${ev}`, type: 'contact.checked_in', data: { kind: 'CLIENT', clientId: C, contact: '919848033311', code: mainCode } });
  check('the same event delivered twice is handled once', (dup as any).duplicate === true && (await rows()).length === 1);
  await arrive(C, '919848033311', mainCode.toLowerCase());
  check('scanning again in the same visit (code typed in small letters): still one arrival, no second welcome', (await rows()).length === 1 && sent.length === 1);

  await arrive(C, '919848033399', mainCode);
  all = await rows();
  const stranger = all.find(r => r.phone === '+919848033399');
  check('a new number: in the list as a new customer, welcomed to the shop', !!stranger && stranger.customerId === null && sent[1]?.text === 'Welcome to Lakshmi Silks! Someone will be with you in a moment.', { stranger, sent: sent[1] });

  await arrive(C, '919848033377', doorCode(C, branch.id));
  check('the branch\'s code puts them in the branch, not Main Store', (await rows({ phone: '+919848033377' }))[0]?.locationId === branch.id);

  const before = (await rows()).length;
  await arrive(C, '919848033355', doorCode(OTHER, elsewhere.id));
  await arrive(C, '919848033355', 'ZZZZZZ');
  await arrive(C, '12', mainCode);
  await arrive(C, '919848033355', mainCode, 'SCALEEZY');
  check('another shop\'s code, an unknown code, a broken number, or ScaleEzy\'s own number: nothing recorded', (await rows()).length === before);

  console.log('\nC. IN THE STORE NOW');
  await prisma.storeCheckin.create({ data: { clientId: C, locationId: main.id, phone: '+919848033300', createdAt: new Date(Date.now() - VISIT_MS - 60_000) } });
  const list = await doorCheckins.list(C, main.id);
  check('Main Store lists its two arrivals, newest first; the branch and the 2-hour-old one are not there', list.length === 2 && list[0].phone === '+919848033399' && list[1].phone === '+919848033311', list.map(l => l.phone));
  check('...Meena with her name and VIP badge, the new one with a masked number to read out', list[1].customer?.name === 'Meena Iyer' && JSON.stringify(list[1].customer?.groups) === '["VIP"]' && list[0].customer === null && list[0].maskedPhone.includes('•'), list);
  const bad = await doorCheckins.list(C, '').then(() => null, e => e);
  check('no store chosen is refused in words', bad?.statusCode === 400);

  console.log('\nD. I\'LL TAKE THEM');
  const id = list[1].id;
  const took = await doorCheckins.take(C, id, { id: 'u-ravi', name: 'Ravi' });
  check('the first salesperson gets them, with the number to open the card', took.phone === '+919848033311');
  const second = await doorCheckins.take(C, id, { id: 'u-priya', name: 'Priya' }).then(() => null, e => e);
  check('a second one is told who is already with them', second?.statusCode === 409 && second.message === 'Ravi is already with them.', second?.message);
  const again = await doorCheckins.take(C, id, { id: 'u-ravi', name: 'Ravi' }).then(r => r, e => e);
  check('the same salesperson pressing again is fine', (again as any).phone === '+919848033311', again);
  const wrongShop = await doorCheckins.take(OTHER, id, { id: 'x', name: 'X' }).then(() => null, e => e);
  check('another shop cannot take them', wrongShop?.statusCode === 404);
  check('the list shows who has them', (await doorCheckins.list(C, main.id)).find(l => l.id === id)?.takenBy === 'Ravi');
  await arrive(C, '919848033311', mainCode);
  check('scanning again after being helped does not put them back as waiting', !(await doorCheckins.list(C, main.id)).some(l => l.phone === '+919848033311' && !l.takenBy));

  console.log('\nE. THE DOOR QR');
  const qr: any = await doorCheckins.doorQr(C, main.id);
  check('the message names the shop, the store and the door code', qr.text === `Hi! I'm at Lakshmi Silks, Main Store. Check-in code: IN-${mainCode}` && qr.code === `IN-${mainCode}`, qr);
  check('a shop with no WhatsApp linked gets no link, and is told why', qr.link === null && /Link the shop's WhatsApp/.test(qr.reason ?? ''), qr);
  const notMine = await doorCheckins.doorQr(C, elsewhere.id).then(() => null, e => e);
  check('another shop\'s store is refused', notMine?.statusCode === 404);

  console.log('\nF. EDGES');
  // A store that has been closed (inactive): its old standee must not put anybody anywhere.
  const closed = await prisma.stockLocation.create({ data: { clientId: C, name: 'Closed Store', code: `DX-${STAMP}`, type: 'STORE' as any, active: false } });
  await arrive(C, '919848033322', doorCode(C, closed.id));
  check('a closed store\'s old QR records nothing', (await rows({ phone: '+919848033322' })).length === 0);

  // A customer who replied STOP: shown to staff, but no welcome is even tried.
  await prisma.customer.create({ data: { clientId: C, customerCode: `DS-${STAMP}`, name: 'Stopped Person', phone: '+919848033344', whatsappStoppedAt: new Date() } });
  const before2 = sent.length;
  await arrive(C, '919848033344', mainCode);
  check('someone who replied STOP shows in the list, and gets no welcome', (await rows({ phone: '+919848033344' })).length === 1 && sent.length === before2);

  // The WhatsApp Service down: the arrival is still recorded and the event still handled.
  const realSend = checkinWelcome.send;
  checkinWelcome.send = async () => { throw new Error('service unreachable'); };
  const down = await arrive(C, '919848033366', mainCode);
  checkinWelcome.send = realSend;
  check('the WhatsApp Service down: the arrival is still recorded, nothing breaks', down.handled === true && (await rows({ phone: '+919848033366' })).length === 1);

  // Two salespeople pressing "I'll take them" at the same moment: exactly one wins.
  const fresh = (await rows({ phone: '+919848033366' }))[0];
  const both = await Promise.allSettled([
    doorCheckins.take(C, fresh.id, { id: 'u-a', name: 'Anil' }),
    doorCheckins.take(C, fresh.id, { id: 'u-b', name: 'Bhavna' })
  ]);
  const won = both.filter(r => r.status === 'fulfilled').length;
  const lostWith = both.find(r => r.status === 'rejected') as PromiseRejectedResult | undefined;
  const winner = (await prisma.storeCheckin.findUnique({ where: { id: fresh.id } }))?.takenByName;
  check('two at the same moment: exactly one gets them, the other is told who', won === 1 && lostWith?.reason?.statusCode === 409 && lostWith.reason.message === `${winner} is already with them.`, { won, winner, msg: lostWith?.reason?.message });

  check('another shop asking for this store\'s list gets nothing', (await doorCheckins.list(OTHER, main.id)).length === 0);
  const nobody = await doorCheckins.take(C, '00000000-0000-0000-0000-000000000000', { id: 'x', name: 'X' }).then(() => null, e => e);
  check('taking an arrival that does not exist is refused in words', nobody?.statusCode === 404);
}

main().catch(e => { failed++; console.error(e); }).finally(async () => {
  for (const c of [C, OTHER]) {
    await prisma.storeCheckin.deleteMany({ where: { clientId: c } }).catch(() => {});
    await prisma.customer.deleteMany({ where: { clientId: c } }).catch(() => {});
    await prisma.clientSettings.deleteMany({ where: { clientId: c } }).catch(() => {});
    await prisma.stockLocation.deleteMany({ where: { clientId: c } }).catch(() => {});
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  await prisma.$disconnect();
  process.exit(failed ? 1 : 0);
});
