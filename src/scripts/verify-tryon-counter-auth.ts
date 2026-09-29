/**
 * The counter try-on is behind the gate, and the shopper one is not.
 *
 * These two live next to each other and are named after each other, and that is exactly how the
 * counter one ended up mounted ABOVE `router.use(authenticate)`. `authenticate` never ran for it,
 * so requirePermission found no user and answered "Unauthorized: User context missing" -- and
 * because a 401 anywhere in this app clears the session and redirects, pressing "See it on the
 * customer" signed the shopkeeper out of their own till. It had never worked.
 *
 * Both directions are checked, because the obvious fix for one breaks the other: move the public
 * shopper route below the gate and a customer scanning a tag gets bounced to a login page for an
 * account they will never have.
 *
 * Needs the dev server up.
 *   npx tsx src/scripts/verify-tryon-counter-auth.ts
 */
import { prisma } from '../lib/prisma';
import { ensureTestTenant } from './support/testTenant';

const BASE = process.env.VERIFY_BASE_URL || 'http://localhost:4006/api/v1';
let passed = 0, failed = 0;
const check = (name: string, ok: boolean, detail = '') => {
  if (ok) { passed++; console.log(`  [PASS] ${name}${detail ? '  -- ' + detail : ''}`); }
  else { failed++; console.log(`  [FAIL] ${name}${detail ? '  -- ' + detail : ''}`); }
};

async function main() {
  const t = await ensureTestTenant();
  const login = await fetch(`${BASE}/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: t.email, password: t.password })
  });
  const jar = ((login.headers as any).getSetCookie?.() ?? [login.headers.get('set-cookie')])
    .filter(Boolean).map((c: string) => String(c).split(';')[0]).join('; ');
  if (!jar) throw new Error('no session cookie came back from login');

  const product = await prisma.product.findFirst({
    where: { clientId: t.clientId, trashedAt: null }, select: { id: true }
  });
  if (!product) throw new Error('the test tenant has no product to try on');

  const call = async (path: string, init: RequestInit = {}, withSession = true) => {
    const res = await fetch(`${BASE}${path}`, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        ...(withSession ? { Cookie: jar } : {}),
        ...(init.headers ?? {})
      }
    });
    const text = await res.text().catch(() => '');
    return { status: res.status, text: text.slice(0, 160) };
  };

  console.log('\nA. SIGNED IN, THE COUNTER TRY-ON ANSWERS');
  const allowance = await call('/tryon/allowance');
  check('the allowance endpoint is reachable at all', allowance.status === 200,
    `${allowance.status} ${allowance.text}`);
  check('and says nothing about a missing user', !/User context missing/.test(allowance.text),
    allowance.text);

  const noPhoto = await call(`/tryon/${product.id}`, { method: 'POST', body: '{}' });
  check('a try-on with no photograph is a BAD REQUEST, not unauthorised',
    noPhoto.status !== 401, `${noPhoto.status} ${noPhoto.text}`);
  /*
   * Worth stating separately. A 401 here is not merely the wrong status: the browser's response
   * interceptor clears the stored session and redirects to /login on any 401, so this one answer
   * throws the shopkeeper out of the app mid-sale.
   */
  check('so pressing the button cannot sign the shopkeeper out',
    noPhoto.status !== 401 && allowance.status !== 401);

  console.log('\nB. SIGNED OUT, IT STILL REFUSES');
  const anon = await call('/tryon/allowance', {}, false);
  check('no session means no counter try-on', anon.status === 401, String(anon.status));
  const anonPost = await call(`/tryon/${product.id}`, { method: 'POST', body: '{}' }, false);
  check('and no generating one either', anonPost.status === 401, String(anonPost.status));

  console.log('\nC. AND THE SHOPPER ROUTE IS STILL PUBLIC');
  /*
   * The obvious fix for the above is to move the whole block below the gate. That would bounce a
   * customer scanning a tag into a login page for an account they will never have -- so the
   * public one is checked from here too, without a session.
   */
  // A real scan: /public/tryon/<shop>/<product code>, which is what the QR code on a tag holds.
  // A path the public router does not have would fall through to the gate and answer 401 -- which
  // looks exactly like the bug this is guarding against, and is not it.
  const scanned = await prisma.product.findFirst({
    where: { clientId: t.clientId, status: 'ACTIVE', trashedAt: null },
    select: { productCode: true }
  });
  const publicScan = await call(`/public/tryon/${t.clientId}/${scanned?.productCode ?? 'NO-SUCH'}`, {}, false);
  check('a customer with no account is not asked to sign in',
    publicScan.status !== 401, `${publicScan.status} ${publicScan.text}`);

  console.log(`\nRESULT: ${passed} passed | ${failed} failed`);
  await prisma.$disconnect();
  process.exit(failed ? 1 : 0);
}
main().catch(async e => { console.log('CRASHED:', e.message); await prisma.$disconnect(); process.exit(1); });
