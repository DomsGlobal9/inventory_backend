/**
 * More retail services through the boutique API (20 Nov 2026, PLAN-boutique-backend.md part 6), against the REAL local
 * server and database: sales and stock reports, the shop's own website key, the Shopify connect link, the nightly Day
 * Book on WhatsApp. Who may, refusals in words. Nothing is sent: the website key starts waiting for its first sync, the
 * Shopify link is only made (never opened), the Day Book is only switched on (never sent now).
 *
 * Throwaway accounts only (rmtest-*); everything it makes is removed. Local only.
 *   DATABASE_URL=<local> DIRECT_URL=<local> VERIFY_API_URL=http://localhost:4036/api/v1 \
 *   BOUTIQUE_KEY_DIR=<dir with private.pem> npx tsx src/scripts/verify-boutique-retail-more.ts
 */
import fs from 'node:fs';
import axios from 'axios';
import jwt from 'jsonwebtoken';
import { prisma } from '../lib/prisma';

const BASE = process.env.VERIFY_API_URL || 'http://localhost:4036/api/v1';
for (const k of ['DATABASE_URL', 'DIRECT_URL']) {
  if (!/localhost:55433/.test(process.env[k] ?? '')) { console.error(`Refusing: ${k} is not the local database.`); process.exit(2); }
}
if (!/localhost|127\.0\.0\.1/.test(BASE)) { console.error('Refusing: VERIFY_API_URL is not a local server.'); process.exit(2); }
const privateKey = fs.readFileSync(`${process.env.BOUTIQUE_KEY_DIR}/private.pem`, 'utf8');

const S = Date.now().toString(36);
const TEN = `rmtest-${S}`;
let bad = 0, good = 0;
const check = (name: string, ok: boolean, detail: unknown = '') => {
  ok ? good++ : bad++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : ` :: ${typeof detail === 'string' ? detail : JSON.stringify(detail)?.slice(0, 500)}`}`);
};
const OWNER = ['products:write', 'stock:write', 'reports:view', 'settings:write'];
const pass = (can: string[]) => jwt.sign({ sub: 'crm-b', scope: ['modules:boutique'], tenant: TEN, onBehalfOf: { userId: 'u1', name: 'Lakshmi', can } },
  privateKey, { algorithm: 'RS256', audience: 'inventory', issuer: 'scaleezy-boutique-test', keyid: 'btq-1', expiresIn: '5m' });
let n = 0;
async function call(method: string, p: string, body?: unknown, can = OWNER) {
  const r = await axios.request({ method, url: `${BASE}/internal/boutique${p}`, data: body, validateStatus: () => true, timeout: 90_000,
    headers: { Authorization: `Bearer ${pass(can)}`, ...(method !== 'GET' ? { 'Idempotency-Key': `rm-${S}-${++n}` } : {}) } });
  return { status: r.status, data: r.data?.data, message: r.data?.message as string | undefined };
}

async function main() {
  const link = await call('POST', '/link', { shopName: 'Retail More Test' });
  const clientId = link.data.clientId as string;
  await call('PUT', `/items/${S}-BL`, { name: 'Ready blouse', category: 'FINISHED', unit: 'PIECE', sellingPrice: 1499, sellInShop: true, reorderLevel: 5 });
  await call('POST', '/movements', { itemCode: `${S}-BL`, kind: 'PURCHASE', quantity: 2, unitCost: 900 });

  console.log('\nREPORTS');
  check('without reports:view: 403', (await call('GET', '/reports/sales?period=30d', undefined, ['stock:write'])).status === 403);
  const sales = await call('GET', '/reports/sales?period=30d');
  check('sales for 30 days: 200', sales.status === 200 && sales.data && typeof sales.data === 'object', sales);
  const value = await call('GET', '/reports/stock-value');
  check('stock value: 200, Rs 1,800 at cost (2 x 900)', value.status === 200 && JSON.stringify(value.data).includes('1800'), value.data);
  check('stock on hand: 200', (await call('GET', '/reports/stock-on-hand')).status === 200);
  const low = await call('GET', '/reports/running-low');
  check('running low: 200, the blouse (2 left, level 5) is in it', low.status === 200 && JSON.stringify(low.data).includes('Ready blouse'), low.data);
  check('a store not in the shop: 404', (await call('GET', '/reports/sales?period=30d&locationId=00000000-0000-0000-0000-000000000000')).status === 404);

  console.log('\nTHE SHOP\'S OWN WEBSITE');
  check('without settings:write: 403', (await call('POST', '/websites', { name: 'site', url: 'https://example.com/hooks/scaleezy' }, ['reports:view'])).status === 403);
  check('a url that is not https: 400 in words', (await call('POST', '/websites', { name: 'site', url: 'ftp://example.com' })).status === 400);
  check('no name: 400', (await call('POST', '/websites', { url: 'https://example.com/hooks/scaleezy' })).status === 400);
  const site = await call('POST', '/websites', { name: 'labelswathyreddy.com', url: 'https://example.com/hooks/scaleezy' });
  check('a website key: 201, the key shown once, waiting for its first sync', site.status === 201 && /^sk_/.test(site.data?.key ?? '') && site.data?.status === 'PENDING_SYNC', [site.status, site.message, site.data?.status]);
  const sites = await call('GET', '/websites');
  check('listed without its key', sites.data?.length === 1 && !('key' in sites.data[0]) && sites.data[0].url === 'https://example.com/hooks/scaleezy', sites.data);
  const gone = await call('DELETE', `/websites/${site.data?.id}`);
  check('removed: the key stops working (revoked), the list is empty', gone.status === 200 && (await prisma.storefrontConnection.findUnique({ where: { id: site.data.id } }))?.status === 'REVOKED' && (await call('GET', '/websites')).data.length === 0, gone);

  console.log('\nSHOPIFY');
  check('not connected yet', (await call('GET', '/shopify')).data?.connected === false);
  check('connect link without settings:write: 403', (await call('POST', '/shopify/connect-link', { shop: `${S}.myshopify.com` }, ['reports:view'])).status === 403);
  const bad = await call('POST', '/shopify/connect-link', { shop: 'not a shop' });
  if (/not configured/.test(bad.message ?? '')) {
    // This server has no SHOPIFY_APP_URL (local): the refusal must say so in words. The link itself is proved only
    // where Shopify is configured (Render) -- this run does NOT prove it.
    check('Shopify not configured on this server: refused in words, naming what is missing (link NOT proved here)', bad.status === 400 && /SHOPIFY_APP_URL/.test(bad.message ?? ''), bad);
  } else {
    check('a store address that is not Shopify\'s: 400 saying how it ends', bad.status === 400 && /myshopify\.com/.test(bad.message ?? ''), bad);
    const shopLink = await call('POST', '/shopify/connect-link', { shop: `rmtest-${S}.myshopify.com` });
    check('the connect link: Shopify\'s own approval page for that store', [200, 201].includes(shopLink.status) && String(shopLink.data?.openThisLink ?? '').startsWith(`https://rmtest-${S}.myshopify.com/admin/oauth/authorize`), [shopLink.status, shopLink.message]);
  }

  console.log('\nTHE NIGHTLY DAY BOOK ON WHATSAPP');
  check('reading it: 200', (await call('GET', '/settings/daybook-whatsapp')).status === 200);
  check('switching it on without settings:write: 403', (await call('PUT', '/settings/daybook-whatsapp', { enabled: true, time: '22:00', to: '+919848012345' }, ['reports:view'])).status === 403);
  check('on with no number: 400', (await call('PUT', '/settings/daybook-whatsapp', { enabled: true, time: '22:00' })).status === 400);
  check('a time that is not one: 400', (await call('PUT', '/settings/daybook-whatsapp', { enabled: true, time: '10pm', to: '+919848012345' })).status === 400);
  const on = await call('PUT', '/settings/daybook-whatsapp', { enabled: true, time: '22:00', to: '+919848012345' });
  const saved = await prisma.whatsAppSettings.findUnique({ where: { clientId } });
  check('on at 22:00 to the owner\'s number: saved, who changed it recorded', on.status === 200 && saved?.dayBookEnabled === true && saved.dayBookTime === '22:00' && saved.dayBookTo === '919848012345' && /Lakshmi/.test(saved.updatedBy ?? ''), [on, saved]);
}

async function cleanup() {
  const ids = (await prisma.boutiqueLink.findMany({ where: { tenant: { startsWith: 'rmtest-' } }, select: { clientId: true } })).map(l => l.clientId);
  if (!ids.length) return;
  await prisma.$executeRawUnsafe(`DELETE FROM storefront_deliveries WHERE connection_id IN (SELECT id FROM storefront_connections WHERE client_id = ANY($1))`, ids).catch(() => undefined);
  const tables = await prisma.$queryRaw<{ table_name: string }[]>`SELECT DISTINCT table_name FROM information_schema.columns WHERE table_schema = 'public' AND column_name = 'client_id'`;
  for (let round = 0; round < 10; round++) {
    let left = 0;
    for (const t of tables) { try { await prisma.$executeRawUnsafe(`DELETE FROM "${t.table_name}" WHERE client_id = ANY($1)`, ids); } catch { left++; } }
    if (!left) break;
  }
  console.log(`\ncleaned up ${ids.length} clients`);
}

main()
  .catch(e => { bad++; console.error('CRASH', e); })
  .finally(async () => { await cleanup().catch(e => console.error('cleanup failed', e)); console.log(`${good} passed, ${bad} problems`); await prisma.$disconnect(); process.exit(bad ? 1 : 0); });
