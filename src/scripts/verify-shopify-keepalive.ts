/**
 * The Shopify connection staying alive (31 Oct). LOCAL DATABASE ONLY.
 *
 * Runs the real shopifyInstallationService against rows in the local copy. Only Shopify's token
 * endpoint is stood in for (axios.post to /admin/oauth/access_token): it hands out a new pair for a
 * pass it has not seen spent, and refuses a spent one -- the way Shopify's rotating renewal works.
 *
 *   1  four callers find the pass expired at once  -> ONE renewal, all four get the new pass
 *   2  another process renewed first (ours spent)  -> its fresh pass is used, no failure
 *   3  a real refusal, nobody renewed              -> a plain error
 *   4  keep-alive: 10 days left -> renewed; 60 days left / uninstalled -> left alone
 *   5  keep-alive: a store that cannot be renewed -> CRITICAL bell notice, once a day, not twice
 *   6  keep-alive on a deployment without the app's keys -> nothing tried, nobody told
 *
 *   DATABASE_URL=<local> DIRECT_URL=<local> npx tsx src/scripts/verify-shopify-keepalive.ts
 */
import axios from 'axios';
import { prisma } from '../lib/prisma';
import { env } from '../config/env';
import { encryptCredential, decryptCredential } from '../lib/credentialEncryption';
import { shopifyInstallationService, RECONNECT_NOTICE_TITLE } from '../services/shopify-installation.service';

const LOCAL = 'localhost:55433';
if (!String(process.env.DATABASE_URL).includes(LOCAL) || !String(process.env.DIRECT_URL).includes(LOCAL)) {
  console.error(`Refusing to run: DATABASE_URL and DIRECT_URL must point at the local copy (${LOCAL}).`);
  process.exit(2);
}

let passed = 0; const failures: string[] = [];
const check = (n: string, ok: boolean, d?: unknown) => {
  if (ok) { passed++; console.log(`  ok   ${n}`); } else { failures.push(n); console.log(`  FAIL ${n}${d === undefined ? '' : ' -- ' + JSON.stringify(d).slice(0, 300)}`); }
};
const STAMP = Date.now().toString(36);
const CLIENT = `keepalive-${STAMP}`;
const DAY = 24 * 60 * 60 * 1000;

// ── Shopify's token endpoint, stood in ─────────────────────────────────────────────────────────
const spent = new Set<string>();
let posts = 0;
let onPost: ((refresh: string, shop: string) => Promise<void>) | null = null;
const refuseShops = new Set<string>();
const realPost = axios.post.bind(axios);
(axios as any).post = async (url: string, body: any, cfg: any) => {
  if (!String(url).endsWith('/admin/oauth/access_token')) return realPost(url, body, cfg);
  posts++;
  const shop = new URL(url).hostname;
  await new Promise(r => setTimeout(r, 120));             // a real round trip, so callers overlap
  if (onPost) await onPost(body.refresh_token, shop);
  if (refuseShops.has(shop) || spent.has(body.refresh_token)) return { status: 400, data: { error: 'invalid_request' } };
  spent.add(body.refresh_token);
  const n = `${STAMP}-${posts}`;
  return { status: 200, data: { access_token: `access-${n}`, expires_in: 3600, refresh_token: `refresh-${n}`, refresh_token_expires_in: 90 * 24 * 3600 } };
};

const make = async (shop: string, refreshLeftMs: number, opts: { expired?: boolean; uninstalled?: boolean } = {}) =>
  prisma.shopifyInstallation.create({
    data: {
      shopDomain: `${shop}-${STAMP}.myshopify.com`, clientId: CLIENT, source: 'SCALEEZY' as any, scopes: 'read_products',
      accessTokenEncrypted: encryptCredential(`old-access-${shop}`), refreshTokenEncrypted: encryptCredential(`old-refresh-${shop}`),
      accessTokenExpiresAt: new Date(Date.now() + (opts.expired === false ? 3600_000 : -60_000)),
      refreshTokenExpiresAt: new Date(Date.now() + refreshLeftMs),
      uninstalledAt: opts.uninstalled ? new Date() : null
    } as any
  });

async function main() {
  const keys = { k: env.SHOPIFY_API_KEY, s: env.SHOPIFY_API_SECRET, u: env.SHOPIFY_APP_URL };
  Object.assign(env as any, { SHOPIFY_API_KEY: 'test-key', SHOPIFY_API_SECRET: 'test-secret', SHOPIFY_APP_URL: 'https://local.invalid' });
  try {
    console.log('\n1. Four callers, one expired pass');
    const a = await make('race', 80 * DAY);
    posts = 0;
    const got = await Promise.all([1, 2, 3, 4].map(() => shopifyInstallationService.accessTokenFor(a.id)));
    check('exactly one renewal was asked for', posts === 1, posts);
    check('all four got the same new pass', new Set(got).size === 1 && got[0].startsWith('access-'), got);
    const rowA = await prisma.shopifyInstallation.findUniqueOrThrow({ where: { id: a.id } });
    check('...and it is saved, with the renewal pass moved on', decryptCredential(rowA.accessTokenEncrypted) === got[0] && decryptCredential(rowA.refreshTokenEncrypted!).startsWith('refresh-') && rowA.refreshTokenExpiresAt!.getTime() > Date.now() + 89 * DAY);

    console.log('\n2. Another process renewed first');
    const b = await make('other', 80 * DAY);
    posts = 0;
    onPost = async (refresh) => {
      // The other process used the same pass a moment earlier and saved its result.
      spent.add(refresh);
      await prisma.shopifyInstallation.update({ where: { id: b.id }, data: {
        accessTokenEncrypted: encryptCredential('access-from-the-other-process'), refreshTokenEncrypted: encryptCredential('refresh-from-the-other-process'),
        accessTokenExpiresAt: new Date(Date.now() + 3600_000)
      } });
    };
    const tokB = await shopifyInstallationService.accessTokenFor(b.id).catch(e => `ERROR: ${e.message}`);
    onPost = null;
    check("the other process's fresh pass is used, nothing fails", tokB === 'access-from-the-other-process', tokB);

    console.log('\n3. A real refusal');
    const c = await make('refused', 10 * DAY);
    refuseShops.add(c.shopDomain);
    const errC = await shopifyInstallationService.accessTokenFor(c.id).then(() => null, e => e.message);
    check('says it could not renew, and that the shop may need to reconnect', /Could not renew access to .*reconnect/.test(String(errC)), errC);

    console.log('\n4. Keep-alive');
    const soon = await make('soon', 10 * DAY, { expired: false });
    const later = await make('later', 60 * DAY, { expired: false });
    const gone = await make('gone', 5 * DAY, { uninstalled: true });
    posts = 0;
    const r1 = await shopifyInstallationService.keepAlive();
    const mine = (xs: string[]) => xs.filter(x => x.includes(STAMP)).sort();
    check('renews the store with 10 days left (and the refused one is reported failed)', JSON.stringify(mine(r1.renewed)) === JSON.stringify([soon.shopDomain]) && JSON.stringify(mine(r1.failed)) === JSON.stringify([c.shopDomain]), r1);
    const s1 = await prisma.shopifyInstallation.findUniqueOrThrow({ where: { id: soon.id } });
    check('...its renewal pass now runs ~90 days again', s1.refreshTokenExpiresAt!.getTime() > Date.now() + 89 * DAY);
    const untouched = await prisma.shopifyInstallation.findMany({ where: { id: { in: [later.id, gone.id] } } });
    check('60 days left, and an uninstalled store: left alone', untouched.every(u => decryptCredential(u.refreshTokenEncrypted!).startsWith('old-refresh-')));
    check('the stores with plenty of time were not even asked about', !r1.renewed.includes(later.shopDomain) && !r1.renewed.includes(gone.shopDomain));

    console.log('\n5. A store that cannot be renewed');
    const notices = () => prisma.inventoryAlert.findMany({ where: { clientId: CLIENT, title: RECONNECT_NOTICE_TITLE }, select: { severity: true, type: true, message: true } });
    const n1 = await notices();
    check('the bell says reconnect, CRITICAL, naming the store and what to do', n1.length === 1 && n1[0].severity === 'CRITICAL' && n1[0].type === 'SYSTEM_ERROR' && n1[0].message.includes(c.shopDomain) && /Settings, then Shopify/.test(n1[0].message), n1);
    await shopifyInstallationService.keepAlive();
    check('a second keep-alive the same day does not say it twice', (await notices()).length === 1);

    console.log('\n5b. Worst cases');
    await prisma.inventoryAlert.deleteMany({ where: { clientId: CLIENT } });
    // A store installed from Shopify's side and never claimed by a shop: nobody's bell to ring.
    const orphan = await prisma.shopifyInstallation.create({ data: {
      shopDomain: `orphan-${STAMP}.myshopify.com`, clientId: null, source: 'SCALEEZY' as any, scopes: 'read_products',
      accessTokenEncrypted: encryptCredential('old-access-orphan'), refreshTokenEncrypted: encryptCredential('old-refresh-orphan'),
      accessTokenExpiresAt: new Date(Date.now() + 3600_000), refreshTokenExpiresAt: new Date(Date.now() + 5 * DAY)
    } as any });
    refuseShops.add(orphan.shopDomain);
    // A pass that never runs out (no expiry recorded): nothing to keep alive.
    const forever = await make('forever', 0, { expired: false });
    await prisma.shopifyInstallation.update({ where: { id: forever.id }, data: { refreshTokenExpiresAt: null } });
    // A pass that already ran out: still tried (Shopify decides), and the shop told if refused.
    const lapsed = await make('lapsed', -2 * DAY, { expired: false });
    refuseShops.add(lapsed.shopDomain);
    // A healthy store due for renewal, queued AFTER the failures: one bad store must not stop the rest.
    const healthy = await make('healthy', 3 * DAY, { expired: false });
    const r2 = await shopifyInstallationService.keepAlive().catch(e => ({ renewed: [], failed: [`THREW ${e.message}`] }));
    check('a refusal on one store does not stop the others being renewed', r2.renewed.includes(healthy.shopDomain), r2);
    check('a never-claimed store that fails: reported, no crash, no notice to anyone', r2.failed.includes(orphan.shopDomain) &&
      (await prisma.inventoryAlert.count({ where: { title: RECONNECT_NOTICE_TITLE, message: { contains: orphan.shopDomain } } })) === 0, r2);
    check('a pass that never expires is left alone', !r2.renewed.includes(forever.shopDomain) && !r2.failed.includes(forever.shopDomain));
    check('a pass that already ran out is tried, and the shop told to reconnect', r2.failed.includes(lapsed.shopDomain) &&
      (await notices()).some(n => n.message.includes(lapsed.shopDomain)), r2);
    const after = await prisma.shopifyInstallation.findUniqueOrThrow({ where: { id: lapsed.id } });
    check('...a refused store keeps its stored passes untouched (nothing half-written)', decryptCredential(after.refreshTokenEncrypted!) === 'old-refresh-lapsed' && decryptCredential(after.accessTokenEncrypted) === 'old-access-lapsed');
    await prisma.shopifyInstallation.delete({ where: { id: orphan.id } });

    console.log('\n6. A deployment without the app keys');
    Object.assign(env as any, { SHOPIFY_API_KEY: undefined });
    await prisma.inventoryAlert.deleteMany({ where: { clientId: CLIENT } });
    posts = 0;
    const r3 = await shopifyInstallationService.keepAlive();
    check('nothing is tried and nobody is told', posts === 0 && mine(r3.failed).length === 0 && (await notices()).length === 0, { posts, r3 });
  } finally {
    Object.assign(env as any, { SHOPIFY_API_KEY: keys.k, SHOPIFY_API_SECRET: keys.s, SHOPIFY_APP_URL: keys.u });
  }
}

main()
  .catch(e => { failures.push(`stopped: ${e?.message ?? e}`); console.log('STOPPED:', e?.message ?? e); })
  .finally(async () => {
    await prisma.inventoryAlert.deleteMany({ where: { clientId: CLIENT } }).catch(() => {});
    await prisma.shopifyInstallation.deleteMany({ where: { clientId: CLIENT } }).catch(() => {});
    console.log(`\nRESULT: ${passed} passed | ${failures.length} failed`);
    await prisma.$disconnect();
    process.exit(failures.length ? 1 : 0);
  });
