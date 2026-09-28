/** A session cookie for UI testing, without the password leaving this process. */
import { ensureTestTenant } from './support/testTenant';

async function main() {
  const t = await ensureTestTenant();
  const res = await fetch('http://localhost:4006/api/v1/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: t.email, password: t.password })
  });
  const jar = (res.headers as any).getSetCookie?.() ?? [res.headers.get('set-cookie')];
  console.log('STATUS', res.status);
  console.log('CLIENT', t.clientId);
  for (const c of (jar as string[]).filter(Boolean)) console.log('COOKIE', String(c).split(';')[0]);
  process.exit(0);
}
main().catch(e => { console.log('ERR', String(e.message).split('\n').find(Boolean)); process.exit(1); });
