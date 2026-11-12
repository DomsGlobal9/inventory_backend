/**
 * Live updates: a line that accepts LISTEN but never hears (a transaction pooler, a quietly dead connection) must
 * NOT claim to be listening, so screens fall back to the minute refresh (services/live, probe).
 *
 * Two LOCAL servers, nothing faked:
 *   HEARING_API  (4036)  listens on the same database it writes to          -> ready.listening must be true
 *   DEAF_API     (4037)  listens on another database (live_deaf_test), so a signal sent the normal way can
 *                        never reach it -- exactly a pooler's behaviour     -> ready.listening must be false
 * Start both from launch.json (backend-localdb-4036, backend-deaf-4037), wait 15 s, then:
 *   DATABASE_URL=<local> DIRECT_URL=<local> npx tsx src/scripts/verify-live-deaf.ts
 */
import http from 'node:http';
import { prisma } from '../lib/prisma';
import { AuthService } from '../services/auth.service';

for (const k of ['DATABASE_URL', 'DIRECT_URL']) {
  if (!/localhost:55433/.test(process.env[k] ?? '')) { console.error(`Refusing: ${k} is not the local database.`); process.exit(2); }
}
const HEARING = process.env.HEARING_API || 'http://localhost:4036/api/v1';
const DEAF = process.env.DEAF_API || 'http://localhost:4037/api/v1';
let passed = 0, failed = 0;
const check = (name: string, ok: boolean, detail = '') => {
  if (ok) { passed++; console.log(`  ok   ${name}`); } else { failed++; console.log(`  FAIL ${name} -- ${detail}`); }
};

/** Open /live, return the first event and whatever else arrives within `ms`, then close. */
function listen(base: string, token: string, ms: number, during?: () => Promise<void>) {
  return new Promise<{ status: number; events: { event: string; data: any }[] }>(resolve => {
    const u = new URL(`${base}/live`);
    const out = { status: 0, events: [] as { event: string; data: any }[] };
    const req = http.get({ hostname: u.hostname, port: u.port, path: u.pathname, headers: { Authorization: `Bearer ${token}` } }, res => {
      out.status = res.statusCode ?? 0;
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', c => {
        buf += c;
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i); buf = buf.slice(i + 2);
          if (block.startsWith(':')) continue;
          let event = 'message', data = '';
          for (const l of block.split('\n')) { if (l.startsWith('event: ')) event = l.slice(7); else if (l.startsWith('data: ')) data += l.slice(6); }
          if (data) out.events.push({ event, data: JSON.parse(data) });
        }
      });
      setTimeout(() => { void during?.(); }, 300);
      setTimeout(() => { req.destroy(); resolve(out); }, ms);
    });
    req.on('error', () => resolve(out));
  });
}

async function main() {
  const owner = await prisma.user.findFirst({ where: { email: 'verify-suites@example.com' }, select: { id: true, clientId: true } });
  if (!owner) throw new Error('local owner verify-suites@example.com not found');
  const token = AuthService.generateToken({ userId: owner.id, clientId: owner.clientId });
  const customer = await prisma.customer.findFirst({ where: { clientId: owner.clientId, deletedAt: null }, select: { id: true } });
  if (!customer) throw new Error('no customer to touch in the local shop');
  const touch = async () => { await prisma.$executeRaw`UPDATE customers SET client_id = client_id WHERE id = ${customer.id}`; };

  const hear = await listen(HEARING, token, 2500, touch);
  const hearReady = hear.events.find(e => e.event === 'ready');
  check('a line that hears: ready says listening', hear.status === 200 && hearReady?.data.listening === true, JSON.stringify(hear));
  check('...and a change reaches the screen', hear.events.some(e => e.event === 'message' && e.data.topics.includes('customers')), JSON.stringify(hear.events));

  const deaf = await listen(DEAF, token, 2500, touch);
  if (deaf.status === 0) throw new Error(`nothing answers at ${DEAF}: start backend-deaf-4037 (launch.json) and wait 15 s`);
  const deafReady = deaf.events.find(e => e.event === 'ready');
  check('a deaf line (LISTEN accepted, signals never arrive): ready says NOT listening, so screens refresh every minute',
    deaf.status === 200 && deafReady?.data.listening === false, JSON.stringify(deaf));
  check('...and it never pretends a change arrived', !deaf.events.some(e => e.event === 'message'), JSON.stringify(deaf.events));
}

main()
  .catch(e => { failed++; console.error('CRASHED', e); })
  .finally(async () => {
    console.log(`\n${passed} passed, ${failed} failed`);
    await prisma.$disconnect();
    process.exit(failed ? 1 : 0);
  });
