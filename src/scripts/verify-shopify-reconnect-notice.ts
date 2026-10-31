/**
 * The "Shopify needs reconnecting" notice reaching a person (31 Oct). LOCAL DATABASE + the local API on 4016.
 *
 * The real keep-alive fails for a store paired with verify-suites-tenant's MAIN-STORE (only Shopify's
 * token endpoint is stood in, refusing). Then the bell's own request, GET /inventory/alerts, is made as
 * the shop's owner: with MAIN-STORE chosen, with another store chosen, and with none.
 *   setup   -> leaves the rows for a screen check, prints what to look for
 *   cleanup -> removes them           npx tsx src/scripts/verify-shopify-reconnect-notice.ts [setup|cleanup]
 */
import axios from 'axios';
import { prisma } from '../lib/prisma';
import { env } from '../config/env';
import { encryptCredential } from '../lib/credentialEncryption';
import { shopifyInstallationService, RECONNECT_NOTICE_TITLE } from '../services/shopify-installation.service';
import { AuthService } from '../services/auth.service';

const LOCAL = 'localhost:55433';
if (!String(process.env.DATABASE_URL).includes(LOCAL) || !String(process.env.DIRECT_URL).includes(LOCAL)) {
  console.error(`Refusing to run: DATABASE_URL and DIRECT_URL must point at the local copy (${LOCAL}).`); process.exit(2);
}
const C = 'verify-suites-tenant';
const SHOP = 'reconnect-uitest.myshopify.com';
const API = 'http://localhost:4016/api/v1';
let passed = 0, failed = 0;
const check = (n: string, ok: boolean, d?: unknown) => { ok ? passed++ : failed++; console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${n}${ok || d === undefined ? '' : ' -- ' + JSON.stringify(d).slice(0, 300)}`); };

async function cleanup() {
  await prisma.inventoryAlert.deleteMany({ where: { clientId: C, title: RECONNECT_NOTICE_TITLE, message: { contains: SHOP } } });
  const inst = await prisma.shopifyInstallation.findUnique({ where: { shopDomain: SHOP } });
  if (inst) { await prisma.shopifyLocationMap.deleteMany({ where: { installationId: inst.id } }); await prisma.shopifyInstallation.delete({ where: { id: inst.id } }); }
}

async function main() {
  if (process.argv[2] === 'cleanup') { await cleanup(); console.log('cleaned'); return; }
  await cleanup();
  // A store of this shop not already paired with a Shopify location (the lent trial store holds some).
  const paired = (await prisma.shopifyLocationMap.findMany({ where: { clientId: C }, select: { locationId: true } })).map(m => m.locationId);
  const store = await prisma.stockLocation.findFirstOrThrow({ where: { clientId: C, type: 'STORE', id: { notIn: paired } }, select: { id: true, name: true } });
  const other = await prisma.stockLocation.findFirstOrThrow({ where: { clientId: C, code: 'GODOWN' }, select: { id: true } });
  // The lent trial store has ~85 days left, so keep-alive leaves it alone; and the stand-in below only refuses, so nothing of it can change.
  const inst = await prisma.shopifyInstallation.create({ data: {
    shopDomain: SHOP, clientId: C, source: 'SCALEEZY' as any, scopes: 'read_products',
    accessTokenEncrypted: encryptCredential('x'), refreshTokenEncrypted: encryptCredential('y'),
    accessTokenExpiresAt: new Date(Date.now() + 3600_000), refreshTokenExpiresAt: new Date(Date.now() + 3 * 86400_000)
  } as any });
  await prisma.shopifyLocationMap.create({ data: { installationId: inst.id, clientId: C, locationId: store.id, shopifyLocationId: '990001' } as any });

  // Shopify refuses the renewal.
  (axios as any).post = async () => ({ status: 400, data: { error: 'invalid_request' } });
  Object.assign(env as any, { SHOPIFY_API_KEY: 'k', SHOPIFY_API_SECRET: 's', SHOPIFY_APP_URL: 'https://local.invalid' });
  const r = await shopifyInstallationService.keepAlive();
  check('the real keep-alive reports this store failed', r.failed.includes(SHOP), r);
  const row = await prisma.inventoryAlert.findFirst({ where: { clientId: C, title: RECONNECT_NOTICE_TITLE, message: { contains: SHOP } } });
  check('the notice is pinned to the paired store', row?.locationId === store.id, row?.locationId);

  // A fresh sign-in for the shop's owner (a saved one expires): the person whose bell this is.
  const owner = await prisma.user.findFirstOrThrow({ where: { clientId: C, status: 'ACTIVE', roles: { some: { role: { name: 'SUPER_ADMIN' } } } } as any, select: { id: true } });
  const token = AuthService.generateToken({ userId: owner.id, clientId: C });
  const bell = async (loc?: string) => (await fetch(`${API}/inventory/alerts`, { headers: { cookie: `token=${token}`, origin: 'http://localhost:5183', ...(loc ? { 'x-location-id': loc } : {}) } }).then(x => x.json())) as any;
  const has = (b: any) => JSON.stringify(b).includes(RECONNECT_NOTICE_TITLE) && JSON.stringify(b).includes(SHOP);
  check(`the owner's bell with ${store.name} chosen shows it`, has(await bell(store.id)));
  check("...with no store chosen, it shows too", has(await bell()));
  check('...with another store chosen (the godown), it does not', !has(await bell(other.id)));
  console.log(`\nFOR THE SCREEN: sign in to 5193 as the owner, choose ${store.name}, open the bell: "${RECONNECT_NOTICE_TITLE}".`);
  console.log(`RESULT: ${passed} passed | ${failed} failed`);
  if (failed) process.exitCode = 1;
}
main().catch(async e => { console.error('STOPPED:', e.message); process.exitCode = 1; await cleanup(); }).finally(() => prisma.$disconnect());
