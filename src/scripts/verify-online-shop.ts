/**
 * EVERY SHOP'S OWN ONLINE SHOP (PLAN-online-shop.md, Phase 1).
 *
 *   R  the address rules, on their own: what is tidied up, what is refused, what is kept back
 *   O  the owner's side: claiming an address, settings, what must exist before it opens
 *   P  the shopper's side through the running server: open, closed, unknown, the catalogue
 *   X  what must never leak: cost price, another shop, a location that does not sell online
 *
 *   npx tsx src/scripts/verify-online-shop.ts      (needs the local backend running)
 *
 * Makes only throwaway shops and deletes them afterwards. Sends nothing anywhere.
 */
import axios from 'axios';
import { prisma } from '../lib/prisma';
import { AuthService } from '../services/auth.service';
import { seedRolesForClient } from '../services/rbac-seed.service';
import { platformAdminService } from '../services/platform-admin.service';
import { onlineShop, OnlineShopRuleError, checkSlug, RESERVED_SLUGS } from '../services/online-shop';

const SERVER = (process.env.VERIFY_API_URL || 'http://localhost:4006/api/v1').replace(/\/api\/v1\/?$/, '');
const API = `${SERVER}/api/v1`;
const STAMP = Date.now();
const SHOP = `onshop-${STAMP}`;
const OTHER = `onshop-other-${STAMP}`;

let passed = 0;
const failures: string[] = [];
const check = (name: string, ok: boolean, detail: unknown = '') => {
  if (ok) { passed++; if (!process.env.QUIET) console.log(`  ok   ${name}`); }
  else {
    const text = typeof detail === 'string' ? detail : JSON.stringify(detail);
    failures.push(`${name} :: ${text}`);
    console.log(`  FAIL ${name} :: ${text}`);
  }
};
const refusal = (fn: () => unknown): string => {
  try { fn(); return ''; } catch (e) { return e instanceof OnlineShopRuleError ? e.message : `NOT A RULE ERROR: ${(e as Error).message}`; }
};
const refusalAsync = async (p: Promise<unknown>): Promise<string> => {
  try { await p; return ''; } catch (e) { return e instanceof OnlineShopRuleError ? e.message : `NOT A RULE ERROR: ${(e as Error).message}`; }
};
const http = (path: string) => axios.get(`${SERVER}${path}`, { validateStatus: () => true });

async function main() {
  const health = await axios.get(`${SERVER}/health`).catch(() => null);
  if (!health) throw new Error(`The backend is not running at ${SERVER}.`);

  // ── R ─────────────────────────────────────────────────────────────────────────────────
  console.log('\nR. THE ADDRESS RULES');
  check('a shop name becomes an address', checkSlug('Lakshmi Silks') === 'lakshmi-silks');
  check('capitals, dots and extra spaces are tidied', checkSlug('  Sree  S.P.H.L.  ') === 'sree-s-p-h-l');
  check('an apostrophe joins rather than splits', checkSlug("O'Brien Sarees") === 'obrien-sarees');
  check('hyphens are never doubled or left hanging', checkSlug('--silk--house--') === 'silk-house');
  check('an address already in shape is unchanged', checkSlug('lakshmi-silks') === 'lakshmi-silks');
  check('nothing typed is refused with a suggestion', /for example/.test(refusal(() => checkSlug(''))));
  check('too short is refused', /at least/.test(refusal(() => checkSlug('ab'))));
  check('too long is refused', /shorter/.test(refusal(() => checkSlug('a'.repeat(41)))));
  check('only digits is refused (unreadable off a poster)', /letters/.test(refusal(() => checkSlug('123456'))));
  check('one of ours is kept back', /kept by ScaleEzy/.test(refusal(() => checkSlug('admin'))));
  check('"shop" is ours but "shopping" is not', RESERVED_SLUGS.has('shop') && checkSlug('shopping') === 'shopping');
  check('emoji and other scripts cannot make an address', /letters|at least/.test(refusal(() => checkSlug('🌸🌸🌸'))));

  // ── SETUP ─────────────────────────────────────────────────────────────────────────────
  console.log(`\nSETUP ${SHOP}`);
  const roles = await seedRolesForClient(SHOP);
  await seedRolesForClient(OTHER);
  await prisma.clientSettings.create({ data: { clientId: SHOP, businessName: 'Lakshmi Silks', businessAddress: '12 Silk St', gstNumber: '36AAAAA0000A1Z5' } });
  await prisma.clientSettings.create({ data: { clientId: OTHER, businessName: 'Other Silks' } });
  const store = await prisma.stockLocation.create({ data: { clientId: SHOP, name: 'Main Store', code: 'MAIN', type: 'STORE', active: true } });
  const godown = await prisma.stockLocation.create({ data: { clientId: SHOP, name: 'Godown', code: 'GD', type: 'WAREHOUSE', active: true } });
  const theirs = await prisma.stockLocation.create({ data: { clientId: OTHER, name: 'Theirs', code: 'TH', type: 'STORE', active: true } });
  const u = await prisma.user.create({ data: { clientId: SHOP, email: `owner-${SHOP}@example.com`, name: 'Owner', password: 'unused', status: 'ACTIVE' } });
  await prisma.userRole.create({ data: { userId: u.id, roleId: roles.SUPER_ADMIN } });
  const own = axios.create({
    baseURL: API,
    headers: { Authorization: `Bearer ${AuthService.generateToken({ userId: u.id, clientId: SHOP })}` },
    validateStatus: () => true
  });

  // ── O ─────────────────────────────────────────────────────────────────────────────────
  console.log('\nO. THE OWNER SETTING IT UP');
  const first = await own.get('/online-shop');
  check('a shop with no online shop yet still gets a screen', first.status === 200 && first.data.data.slug === null, first.data);
  check('...and is told what it needs before it can open', (first.data.data.missingBeforeLive ?? []).length >= 1, first.data.data.missingBeforeLive);

  const claimed = await own.post('/online-shop/address', { slug: 'Lakshmi Silks' });
  check('claiming an address tidies it up', claimed.status === 200 && claimed.data.data.slug === 'lakshmi-silks', claimed.data);
  check('it is not open merely by being claimed', claimed.data.data.isLive === false);

  const tooSoon = await own.post('/online-shop/open', {});
  check('it cannot open before a store is chosen', tooSoon.status === 400 && /store/i.test(tooSoon.data.message), tooSoon.data);

  const notMine = await own.patch('/online-shop', { locationIds: [theirs.id] });
  check("another shop's store cannot be chosen", notMine.status === 400 && /not yours/i.test(notMine.data.message), notMine.data);

  const saved = await own.patch('/online-shop', { locationIds: [store.id], displayName: 'Lakshmi Silks Online', accent: '#8b1a2b', hideOutOfStock: true });
  check('the shop keeps its settings', saved.status === 200 && saved.data.data.locationIds.length === 1 && saved.data.data.accent === '#8b1a2b', saved.data);
  check('a colour that is not a colour is ignored, not saved',
    (await own.patch('/online-shop', { accent: 'red' })).data.data.accent === '#8b1a2b');

  const opened = await own.post('/online-shop/open', {});
  check('now it opens', opened.status === 200 && opened.data.data.isLive === true, opened.data);

  const moved = await own.post('/online-shop/address', { slug: 'different-name' });
  check('an open shop cannot change its address (posters and messages already have it)',
    moved.status === 400 && /already open/i.test(moved.data.message), moved.data);

  // ── P ─────────────────────────────────────────────────────────────────────────────────
  console.log('\nP. WHAT A SHOPPER GETS');
  const open = await http('/shop/lakshmi-silks');
  check('the shop answers at its address', open.status === 200 && open.data.data.name === 'Lakshmi Silks Online', open.data);
  check("the seller's own details are there (Consumer Protection Rules)",
    open.data.data.seller?.gstNumber === '36AAAAA0000A1Z5' && !!open.data.data.seller?.address, open.data.data.seller);
  check('the shop id is never sent to a shopper', !('clientId' in (open.data.data ?? {})) && !('locationIds' in (open.data.data ?? {})), Object.keys(open.data.data ?? {}));
  check('nothing is cached by a shared cache', /no-store/.test(String(open.headers['cache-control'])), open.headers['cache-control']);

  const unknown = await http('/shop/nobody-has-this');
  check('an address nobody has says so, and nothing else', unknown.status === 404 && unknown.data.state === 'UNKNOWN', unknown.data);

  await own.post('/online-shop/close', {});
  const closed = await http('/shop/lakshmi-silks');
  check('a closed shop says it is closed, not that it never existed', closed.status === 503 && closed.data.state === 'CLOSED', closed.data);
  check('...and names the shop, so a saved link is not a mystery', /Lakshmi Silks Online/.test(String(closed.data.message)), closed.data.message);
  const closedList = await http('/shop/lakshmi-silks/products');
  check('a closed shop shows no catalogue', closedList.status === 503, closedList.status);
  await own.post('/online-shop/open', {});

  const list = await http('/shop/lakshmi-silks/products');
  check('the catalogue answers', list.status === 200 && Array.isArray(list.data.data.products), list.data);

  // ── X ─────────────────────────────────────────────────────────────────────────────────
  console.log('\nX. WHAT MUST NEVER LEAK');
  const body = JSON.stringify(list.data);
  for (const word of ['costPrice', 'averageCost', 'lastPurchaseCost', 'supplier', 'reorderLevel']) {
    check(`the catalogue never carries ${word}`, !body.includes(word));
  }
  check('a shopper is told whether they can buy, never how many are left',
    !/"quantity"|"reserved"|"available"/.test(body));
  check('the godown is not offered: only the chosen store sells online',
    (await prisma.onlineShop.findUniqueOrThrow({ where: { clientId: SHOP } })).locationIds.join() === store.id,
    godown.id);

  // Another shop cannot take this address, now or ever.
  const theirClaim = await refusalAsync(onlineShop.chooseSlug(OTHER, 'lakshmi-silks'));
  check('another shop cannot claim an address in use', /already has|has used/i.test(theirClaim), theirClaim);
  await own.post('/online-shop/close', {});
  const afterClose = await refusalAsync(onlineShop.chooseSlug(OTHER, 'lakshmi-silks'));
  check('...nor after it is closed: a printed QR code outlives the shop', /has used/i.test(afterClose), afterClose);

  const noPermission = await axios.get(`${API}/online-shop`, { validateStatus: () => true });
  check('the owner screen needs a login', noPermission.status === 401, noPermission.status);
}

main()
  .catch(e => { failures.push(`suite stopped: ${(e as Error).stack ?? e}`); console.log(`\nSTOPPED: ${(e as Error).message}`); })
  .finally(async () => {
    for (const c of [SHOP, OTHER]) await platformAdminService.deleteClientCompletely(c, c).catch(() => {});
    await prisma.onlineShopSlugHistory.deleteMany({ where: { clientId: { in: [SHOP, OTHER] } } }).catch(() => {});
    console.log(`\nRESULT: ${passed} passed | ${failures.length} failed`);
    if (failures.length) console.log(failures.map(f => `  - ${f}`).join('\n'));
    await prisma.$disconnect();
    process.exit(failures.length ? 1 : 0);
  });
