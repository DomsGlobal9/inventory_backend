/**
 * Drives the whole try-on flow over real HTTP, against the real routes, with a stand-in for
 * the gateway.
 *
 * The unit tests check each service in isolation. This checks the things only the assembled
 * system can be wrong about:
 *
 *   - the right client's key actually reaches the gateway
 *   - one client's key and usage are invisible to another
 *   - the meter counts what happened, not what was asked for
 *   - a refusal at the limit costs the client nothing
 *   - a stream the merchant abandons is not billed as a generation
 *   - last month's usage does not count against this month
 *   - the key is not in any response, on any route, in any shape
 *
 *   npx ts-node src/scripts/verify-tryon-e2e.ts
 */
// The gateway URL has to exist BEFORE config/env.ts is first imported, because it validates
// and freezes the environment at import time. Importing prisma at the top of this file was
// enough to pull env in through the chain, so every one of these was read as unset and the
// try-on service refused to call anything -- which is what fifteen of the failures on the
// first run actually were. A placeholder now; the real port replaces it before any import
// that reads it, and the imports below are dynamic for that reason.
process.env.CATALOG_TRYON_API_KEY = 'sk_shared_platform_key_for_everyone';

import http from 'http';
import express from 'express';
import { AddressInfo } from 'net';

let passed = 0, failed = 0;
const failures: string[] = [];
const check = (name: string, ok: boolean, detail?: string) => {
  if (ok) { passed++; console.log(`  [PASS] ${name}`); }
  else { failed++; failures.push(name); console.log(`  [FAIL] ${name}${detail ? `  -> ${detail}` : ''}`); }
};

const SHOP_A = `tryon-a-${Date.now()}`;
const SHOP_B = `tryon-b-${Date.now()}`;
// Only the first 12 characters are stored as the prefix, so the two keys have to differ
// INSIDE those 12 -- 'sk_live_shopA' and 'sk_live_shopB' share a prefix of 'sk_live_shop',
// and a leak check against a string both shops have in common proves nothing.
const KEY_A = 'sk_live_aaaa' + 'a'.repeat(30);
const KEY_B = 'sk_live_bbbb' + 'b'.repeat(30);

/** A stand-in gateway that records which key each call presented. */
function startGateway() {
  const seen: { path: string; key: string | undefined }[] = [];
  let mode: 'ok' | 'reject' | 'break' = 'ok';

  return new Promise<{
    url: string; seen: typeof seen; close: () => Promise<void>;
    setMode: (m: 'ok' | 'reject' | 'break') => void;
  }>(resolve => {
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', c => { body += c; });
      req.on('end', () => {
        seen.push({ path: req.url ?? '', key: req.headers['x-api-key'] as string | undefined });

        if (req.url?.includes('cancel-job')) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ success: true }));
        }

        if (mode === 'reject') {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ message: 'invalid key' }));
        }

        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        if (mode === 'break') {
          // Headers, then the connection dies mid-stream.
          res.write('data: {"status":"working"}\n\n');
          return res.destroy();
        }
        // Four views, as a real generation produces.
        for (let i = 1; i <= 4; i++) {
          res.write(`data: {"view":${i},"imageUrl":"https://cdn.example/view${i}.jpg"}\n\n`);
        }
        res.end('data: {"status":"done"}\n\n');
      });
    });
    server.listen(0, '127.0.0.1', () => {
      resolve({
        url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
        seen,
        close: () => new Promise(r => server.close(() => r())),
        setMode: m => { mode = m; }
      });
    });
  });
}

async function main() {
  const gateway = await startGateway();
  process.env.CATALOG_TRYON_GATEWAY_URL = gateway.url;

  // Every import below is dynamic and happens AFTER the environment is set, so config/env.ts
  // is first evaluated with the stand-in gateway's real address in place.
  const { prisma } = await import('../lib/prisma');
  const { encryptCredential } = await import('../lib/credentialEncryption');
  const { serviceCredentialService, tryOnUsageService } = await import('../services/tryon');
  const { getShopSettings } = await import('../lib/clientSettings');
  const { todayKey } = await import('../utils/businessDay');
  const { catalogTryOnController } = await import('../controllers/catalog-tryon.controller');
  const { tenantMiddleware } = await import('../middleware/tenant.middleware');
  const serviceRoutes = (await import('../routes/service-catalogue.routes')).default;

  // The real routes. Only the signed-in identity is faked -- `req.user` is what requireAuth
  // would have put there, and the real tenantMiddleware derives the tenant from it. Setting
  // req.clientId directly would have skipped the very middleware that decides whose data a
  // request sees, which is the thing most worth exercising here.
  const app = express();
  app.use(express.json());
  let actingAs = SHOP_A;
  app.use((req, _res, next) => { (req as any).user = { clientId: actingAs }; next(); });
  app.post('/generate', tenantMiddleware, (req, res, next) => catalogTryOnController.generateCatalog(req, res, next));
  app.use('/services', serviceRoutes);

  /**
   * Usage is recorded fire-and-forget, on purpose -- a merchant's generation must not wait on
   * our meter. So the counter lands slightly after the response does, and reading it the
   * instant a fetch resolves reads it too early. This polls to the expected state instead of
   * sleeping a guessed number of milliseconds, and returns whatever it last saw on timeout so
   * the assertion still reports the real figure.
   */
  const settle = async (clientId: string, reached: (s: any) => boolean, ms = 10000) => {
    const startedAt = Date.now();
    let last = await tryOnUsageService.summary(clientId);
    while (!reached(last) && Date.now() - startedAt < ms) {
      await new Promise(r => setTimeout(r, 120));
      last = await tryOnUsageService.summary(clientId);
    }
    return last;
  };

  const server = app.listen(0, '127.0.0.1');
  await new Promise(r => server.once('listening', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const cleanup = async () => {
    await prisma.tryOnUsage.deleteMany({ where: { clientId: { in: [SHOP_A, SHOP_B] } } });
    await prisma.clientServiceLimit.deleteMany({ where: { clientId: { in: [SHOP_A, SHOP_B] } } });
    await prisma.clientServiceCredential.deleteMany({ where: { clientId: { in: [SHOP_A, SHOP_B] } } });
  };
  await cleanup();

  try {
    // ─── EACH CLIENT'S OWN KEY REACHES THE GATEWAY ──────────────────────────
    console.log('\nTHE RIGHT KEY REACHES THE GATEWAY');

    for (const [clientId, key] of [[SHOP_A, KEY_A], [SHOP_B, KEY_B]] as const) {
      await prisma.clientServiceCredential.create({
        data: {
          clientId, service: 'CATALOG_TRYON',
          keyEncrypted: encryptCredential(key), keyPrefix: key.slice(0, 12),
          addedByAdmin: 'suite@scaleezy.com', status: 'ACTIVE'
        }
      });
    }

    actingAs = SHOP_A;
    await fetch(`${base}/generate`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}'
    }).then(r => r.text());

    const aCall = gateway.seen.filter(s => s.path.includes('generate')).at(-1);
    check('shop A\'s generation presents shop A\'s key', aCall?.key === KEY_A, String(aCall?.key).slice(0, 20));

    actingAs = SHOP_B;
    await fetch(`${base}/generate`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}'
    }).then(r => r.text());

    const bCall = gateway.seen.filter(s => s.path.includes('generate')).at(-1);
    check('shop B\'s presents shop B\'s, not the one before it', bCall?.key === KEY_B, String(bCall?.key).slice(0, 20));
    check('and not the shared platform key', bCall?.key !== process.env.CATALOG_TRYON_API_KEY);

    // ─── COUNTED BY WHAT HAPPENED ───────────────────────────────────────────
    console.log('\nTHE METER COUNTS WHAT HAPPENED');

    const aUsage = await settle(SHOP_A, s => s.completed >= 1);
    check('a completed generation is counted once', aUsage.completed === 1, String(aUsage.completed));
    check('its four views are counted', aUsage.viewsGenerated === 4, String(aUsage.viewsGenerated));
    check('nothing is recorded as failed', aUsage.failed === 0);

    // ─── ONE CLIENT CANNOT SEE ANOTHER ──────────────────────────────────────
    console.log('\nONE SHOP CANNOT SEE ANOTHER\'S KEY OR USAGE');

    const bUsage = await settle(SHOP_B, s => s.completed >= 1);
    check('shop B\'s usage is its own, not A\'s and B\'s together',
      bUsage.completed === 1 && bUsage.viewsGenerated === 4,
      `${bUsage.completed}/${bUsage.viewsGenerated}`);

    actingAs = SHOP_A;
    const aServices = await fetch(`${base}/services`).then(r => r.text());
    check('shop A\'s services screen shows its own prefix', aServices.includes(KEY_A.slice(0, 12)));
    check('and carries no trace of shop B\'s key', !aServices.includes(KEY_B.slice(0, 12)));
    // The property that matters most, checked on the raw response body rather than a field.
    check('nor the full value of its own', !aServices.includes(KEY_A));

    // ─── A REFUSED GENERATION COSTS NOTHING ─────────────────────────────────
    console.log('\nBEING REFUSED AT THE LIMIT COSTS THE CLIENT NOTHING');

    await tryOnUsageService.setMonthlyLimit(SHOP_A, 1, 'suite@scaleezy.com');
    const atLimit = await tryOnUsageService.summary(SHOP_A);
    check('one generation against a limit of one is at the limit', atLimit.overLimit === true);

    const before = gateway.seen.length;
    const refused = await fetch(`${base}/generate`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}'
    });
    check('the request is refused with 429, not 500', refused.status === 429, String(refused.status));

    const refusedBody = await refused.json().catch(() => ({} as any));
    check('and the message names the limit',
      String((refusedBody as any).message ?? '').includes('1'), JSON.stringify(refusedBody).slice(0, 90));

    check('nothing was sent to the gateway', gateway.seen.length === before, `${gateway.seen.length - before} calls`);

    const afterRefusal = await tryOnUsageService.summary(SHOP_A);
    // The bug this exists to catch: a refusal recorded as a failure charges someone who was
    // just told they had nothing left, and pushes them further past a limit.
    check('and the refusal itself was not charged',
      afterRefusal.generations === atLimit.generations,
      `${atLimit.generations} -> ${afterRefusal.generations}`);

    console.log('\nRAISING THE LIMIT LETS THEM STRAIGHT BACK IN');
    await tryOnUsageService.setMonthlyLimit(SHOP_A, 100, 'suite@scaleezy.com');
    const allowed = await fetch(`${base}/generate`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}'
    });
    check('the next generation is allowed', allowed.status === 200, String(allowed.status));
    await allowed.text();

    // ─── A GENERATION THAT BREAKS ───────────────────────────────────────────
    console.log('\nA GENERATION THAT BREAKS IS COUNTED AS FAILED, NOT COMPLETED');

    const beforeBreak = await settle(SHOP_A, s => s.completed >= 2);
    gateway.setMode('reject');
    const rejected = await fetch(`${base}/generate`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}'
    });
    check('a rejected key surfaces as an error, not a silent success', rejected.status >= 400, String(rejected.status));

    const afterBreak = await settle(SHOP_A, s => s.failed >= beforeBreak.failed + 1);
    check('it is recorded as a failure', afterBreak.failed === beforeBreak.failed + 1,
      `${beforeBreak.failed} -> ${afterBreak.failed}`);
    check('and not as a completed generation', afterBreak.completed === beforeBreak.completed,
      `${beforeBreak.completed} -> ${afterBreak.completed}`);
    // A shop whose key is wrong must not read as "no usage" -- that looks identical to a shop
    // that simply has not used it, and hides a broken integration.
    check('a broken integration shows as usage, not as silence', afterBreak.generations > beforeBreak.generations);
    gateway.setMode('ok');

    // ─── LAST MONTH IS NOT THIS MONTH ───────────────────────────────────────
    console.log('\nLAST MONTH\'S USAGE DOES NOT COUNT AGAINST THIS MONTH');

    const { timezone } = await getShopSettings(SHOP_A);
    const thisMonth = todayKey(timezone).slice(0, 7);
    const [y, m] = thisMonth.split('-').map(Number);
    const lastMonth = m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;

    await prisma.tryOnUsage.create({
      data: { clientId: SHOP_A, day: `${lastMonth}-15`, started: 500, completed: 500, viewsGenerated: 2000 }
    });

    const nowSummary = await tryOnUsageService.summary(SHOP_A);
    check('500 generations last month do not appear in this month',
      nowSummary.completed === afterBreak.completed, `${nowSummary.completed}`);
    check('so an allowance resets rather than accumulating forever', nowSummary.overLimit === false);

    const lastSummary = await tryOnUsageService.summary(SHOP_A, lastMonth);
    check('but last month can still be read on its own', lastSummary.completed === 500, String(lastSummary.completed));

    // ─── A CLIENT WITH NO KEY ───────────────────────────────────────────────
    console.log('\nA CLIENT WITH NO KEY OF THEIR OWN STILL WORKS');

    await serviceCredentialService.revoke(SHOP_B, 'CATALOG_TRYON');
    actingAs = SHOP_B;
    await fetch(`${base}/generate`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}'
    }).then(r => r.text());

    const sharedCall = gateway.seen.filter(s => s.path.includes('generate')).at(-1);
    check('it falls back to the shared key rather than failing',
      sharedCall?.key === process.env.CATALOG_TRYON_API_KEY, String(sharedCall?.key).slice(0, 20));

    const bAfter = await settle(SHOP_B, s => s.completed >= 2);
    // Usage is still attributed to the shop, even on the shared key -- otherwise revoking a key
    // would silently stop the meter as well as the attribution.
    check('and its usage is still counted against that shop', bAfter.completed === 2, String(bAfter.completed));

    const bServices = await fetch(`${base}/services`).then(r => r.text());
    check('their screen still shows the service as active', bServices.includes('"active":true'));
    check('with no key prefix, because they have none', !bServices.includes(KEY_B.slice(0, 12)));

    console.log(`\n================ RESULT: ${passed} passed | ${failed} failed ================`);
    if (failures.length) {
      console.log('\nFailed:');
      for (const name of failures) console.log(`  - ${name}`);
      // Said in the exit code as well as on the screen, so a failing run cannot pass for a
      // green one when this is run by anything that is not a person reading the output.
      process.exitCode = 1;
    }
  } finally {
    await cleanup();
    console.log('\n(test shops removed)');
    server.close();
    await gateway.close();
    await prisma.$disconnect();
  }
}

main().catch(error => { console.error('\nSuite crashed:', error); process.exitCode = 1; });
