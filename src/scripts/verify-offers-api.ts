/**
 * The offers API, over HTTP, as the screen will call it.
 *
 * verify-offers proves the service. This proves the wiring: that the routes are mounted, that the
 * permissions exist and are granted, and that a refusal arrives as a sentence rather than a stack
 * trace. Every one of those has been the thing that was actually broken at least once in this
 * codebase -- a permission added to the catalogue but never seeded is invisible until somebody
 * opens the page and finds it empty.
 *
 * Runs against demo-client and removes what it creates.
 *
 *   npx tsx src/scripts/verify-offers-api.ts     (needs the backend running)
 */
import axios from 'axios';
import jwt from 'jsonwebtoken';
import { prisma } from '../lib/prisma';

const BASE = 'http://localhost:4006/api/v1';
let passed = 0, failed = 0;
const failures: string[] = [];
const check = (name: string, ok: boolean, detail?: string) => {
  if (ok) { passed++; console.log(`  [PASS] ${name}`); }
  else { failed++; failures.push(name); console.log(`  [FAIL] ${name}${detail ? `  -> ${detail}` : ''}`); }
};

const STAMP = Date.now();
const created: string[] = [];

async function main() {
  const user = await prisma.user.findFirstOrThrow({
    where: { status: 'ACTIVE', clientId: 'demo-client', email: 'admin@example.com' }
  });
  const token = jwt.sign(
    { sub: user.id, clientId: 'demo-client', iss: 'scal_easy_auth', aud: 'scal_easy_inventory' },
    process.env.JWT_SECRET!, { expiresIn: '1h' }
  );
  const api = axios.create({
    baseURL: BASE, headers: { Authorization: `Bearer ${token}` }, validateStatus: () => true
  });
  const un = (r: any) => (r.data?.data !== undefined ? r.data.data : r.data);

  console.log('\nA. THE ROUTES ARE THERE AND THE PERMISSION EXISTS');

  const list = await api.get('/offers');
  check('the offers list answers', list.status === 200, `${list.status} ${JSON.stringify(list.data).slice(0, 200)}`);
  check('  ...and it is a list', Array.isArray(un(list)), typeof un(list));

  console.log('\nB. WRITING ONE');

  const create = await api.post('/offers', {
    name: `API test sale ${STAMP}`,
    trigger: 'CODE',
    couponCode: `APITEST${STAMP % 100000}`,
    valueType: 'PERCENTAGE',
    value: 15,
    maxDiscount: 2000,
    scope: 'ALL',
    startsAt: new Date(Date.now() - 3600_000).toISOString(),
    endsAt: null,
    minSubtotal: 1000,
    priority: 5
  });
  check('an offer can be written', create.status === 201, `${create.status} ${JSON.stringify(create.data).slice(0, 250)}`);
  const offer = un(create);
  if (offer?.id) created.push(offer.id);
  check('  ...it gets a code', /^OFR-\d{6}$/.test(offer?.offerCode ?? ''), offer?.offerCode);
  check('  ...and arrives as a draft', offer?.status === 'DRAFT', offer?.status);

  console.log('\nC. WHAT IT REFUSES, IN WORDS');

  const bad = await api.post('/offers', {
    name: 'Nonsense', valueType: 'PERCENTAGE', value: 500,
    startsAt: new Date().toISOString()
  });
  check('a percentage over 100 is refused', bad.status === 400, String(bad.status));
  check('  ...with a sentence a merchant can act on',
    /more than 100/i.test(bad.data?.message ?? ''), bad.data?.message);
  check('  ...and nothing about how the server is built',
    !/prisma|Invalid `|\.ts:\d+/.test(bad.data?.message ?? ''), bad.data?.message);

  const noName = await api.post('/offers', { valueType: 'PERCENTAGE', value: 10, startsAt: new Date().toISOString() });
  check('an offer with no name is refused', noName.status === 400 && /name/i.test(noName.data?.message ?? ''),
    noName.data?.message);

  console.log('\nD. STARTING AND PAUSING FROM THE SCREEN');

  const start = await api.post(`/offers/${offer.id}/status`, { status: 'ACTIVE' });
  check('it can be started', start.status === 200 && un(start)?.status === 'ACTIVE',
    `${start.status} ${JSON.stringify(start.data).slice(0, 200)}`);

  const pause = await api.post(`/offers/${offer.id}/status`, { status: 'PAUSED' });
  check('and paused', pause.status === 200 && un(pause)?.status === 'PAUSED', String(pause.status));

  const nonsense = await api.post(`/offers/${offer.id}/status`, { status: 'EXPIRED' });
  check('it cannot be expired by hand -- that is what time does',
    nonsense.status === 400, `${nonsense.status} ${nonsense.data?.message}`);

  console.log('\nE. READING ONE BACK');

  const detail = await api.get(`/offers/${offer.id}`);
  check('one offer can be read', detail.status === 200, String(detail.status));
  check('  ...with its history', Array.isArray(un(detail)?.versions) && un(detail).versions.length >= 1);
  check('  ...and what it has saved so far', un(detail)?.redemptionCount === 0);
  check('  ...and what it IS, not just what its column says',
    typeof un(detail)?.effectiveStatus === 'string', un(detail)?.effectiveStatus);

  const missing = await api.get('/offers/00000000-0000-0000-0000-000000000000');
  check('an offer that does not exist is a 404, not a crash', missing.status === 404, String(missing.status));

  console.log('\nF. CHANGING IT');

  const rename = await api.patch(`/offers/${offer.id}`, { name: `Renamed ${STAMP}` });
  check('it can be renamed', rename.status === 200 && un(rename)?.name === `Renamed ${STAMP}`,
    `${rename.status} ${un(rename)?.name}`);

  const reprice = await api.patch(`/offers/${offer.id}`, { value: 25, changeNote: 'Bumped for the weekend' });
  check('and repriced', reprice.status === 200 && Number(un(reprice)?.value) === 25, String(reprice.status));

  const after = await api.get(`/offers/${offer.id}`);
  const versions = un(after)?.versions ?? [];
  check('the rule change is versioned, the rename is not', versions.length === 2, `${versions.length} versions`);
  check('  ...and the note is kept',
    versions.some((v: any) => v.changeNote === 'Bumped for the weekend'));

  console.log('\nG. FILTERING, AS THE SCREEN WILL');

  const paused = await api.get('/offers', { params: { status: 'PAUSED' } });
  check('the list can be filtered by status',
    paused.status === 200 && un(paused).every((o: any) => o.status === 'PAUSED'), String(paused.status));

  const found = await api.get('/offers', { params: { search: `APITEST${STAMP % 100000}` } });
  check('and searched by code', found.status === 200 && un(found).length === 1, String(un(found)?.length));
}

main()
  .catch(e => { console.error('\nSUITE CRASHED:', e?.message ?? e); failed++; failures.push('crashed'); })
  .finally(async () => {
    for (const id of created) {
      await prisma.offerVersion.deleteMany({ where: { offerId: id } }).catch(() => undefined);
      await prisma.offerTarget.deleteMany({ where: { offerId: id } }).catch(() => undefined);
      await prisma.offer.delete({ where: { id } }).catch(() => undefined);
    }
    await prisma.$disconnect();
    console.log(`\nRESULT: ${passed} passed | ${failed} failed  (removed ${created.length} test offers)`);
    if (failures.length) console.log('Failures:\n  - ' + failures.join('\n  - '));
    process.exit(failed ? 1 : 0);
  });
