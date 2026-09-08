/**
 * Try-On, the shopper's one, driven over real HTTP against the real public routes with a
 * stand-in for the gateway.
 *
 * This is the most exposed surface on the service -- no session, no account, reachable by
 * anyone who can photograph a QR code -- so the checks are weighted towards what a stranger
 * can do rather than towards the happy path:
 *
 *   - the scanned code resolves to the garment, and to nothing else about the shop
 *   - an unpublished product is not reachable by guessing its code
 *   - the shop's own key reaches the gateway, and never the browser
 *   - the garment comes from the code, so nobody can try on an image they supplied
 *   - a shop out of allowance costs nothing and sends nothing
 *   - the two try-on services meter separately and cannot spend each other's allowance
 *
 *   npx ts-node src/scripts/verify-shopper-tryon-e2e.ts
 */
process.env.SHOPPER_TRYON_API_KEY = 'sk_shared_shopper_key';
process.env.CATALOG_TRYON_API_KEY = 'sk_shared_catalog_key';
process.env.SHOPPER_TRYON_APP_URL = 'https://www.tryon2buy.com';

import http from 'http';
import express from 'express';
import { AddressInfo } from 'net';

let passed = 0, failed = 0;
const failures: string[] = [];
const check = (name: string, ok: boolean, detail?: string) => {
  if (ok) { passed++; console.log(`  [PASS] ${name}`); }
  else { failed++; failures.push(name); console.log(`  [FAIL] ${name}${detail ? `  -> ${detail}` : ''}`); }
};

const SHOP = `shopper-a-${Date.now()}`;
const OTHER_SHOP = `shopper-b-${Date.now()}`;
const SHOP_KEY = 'sk_live_shopper_' + 'a'.repeat(26);
const SELFIE = 'https://cdn.example/selfie.jpg';
const GARMENT = 'https://cdn.example/garment.jpg';

/** A stand-in gateway that records which key each call presented, and what it was asked to do. */
function startGateway() {
  const seen: { key?: string; body: any }[] = [];
  let mode: 'ok' | 'reject' = 'ok';

  return new Promise<{
    url: string; seen: typeof seen; close: () => Promise<void>;
    setMode: (m: 'ok' | 'reject') => void;
  }>(resolve => {
    const server = http.createServer((req, res) => {
      let raw = '';
      req.on('data', c => { raw += c; });
      req.on('end', () => {
        seen.push({ key: req.headers['x-api-key'] as string, body: (() => {
          try { return JSON.parse(raw); } catch { return null; }
        })() });

        if (mode === 'reject') {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: 'invalid key' }));
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, resultImageUrl: 'https://cdn.example/result.jpg', processingTimeMs: 1200 }));
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
  process.env.SHOPPER_TRYON_GATEWAY_URL = gateway.url;
  process.env.CATALOG_TRYON_GATEWAY_URL = gateway.url;

  // Dynamic, and after the environment is set: config/env validates and freezes at first
  // import, so a static import here would read the gateway URL as unset.
  const { prisma } = await import('../lib/prisma');
  const { encryptCredential } = await import('../lib/credentialEncryption');
  const { serviceCredentialService, tryOnUsageService } = await import('../services/tryon');
  const { shopperTryOnProductService } = await import('../services/shopper-tryon');
  const publicRoutes = (await import('../routes/shopper-tryon-public.routes')).default;

  const app = express();
  app.use(express.json());
  app.use('/public/tryon', publicRoutes);
  const server = app.listen(0, '127.0.0.1');
  await new Promise(r => server.once('listening', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/public/tryon`;

  const settle = async (clientId: string, service: any, reached: (s: any) => boolean, ms = 10000) => {
    const startedAt = Date.now();
    let last = await tryOnUsageService.summary(clientId, undefined, service);
    while (!reached(last) && Date.now() - startedAt < ms) {
      await new Promise(r => setTimeout(r, 120));
      last = await tryOnUsageService.summary(clientId, undefined, service);
    }
    return last;
  };

  const madeProductIds: string[] = [];
  const makeProduct = async (clientId: string, code: string, status: 'ACTIVE' | 'DRAFT', withImage = true) => {
    const p = await prisma.product.create({
      data: {
        clientId, productCode: code, slug: `${code.toLowerCase()}-${Date.now()}`,
        title: `Garment ${code}`, category: 'WOMEN', productType: 'READY_TO_WEAR',
        dressType: 'Lehenga', status, basePrice: 4999
      }
    });
    madeProductIds.push(p.id);
    if (withImage) {
      await prisma.productImage.create({
        data: { productId: p.id, url: GARMENT, imageType: 'COVER', isPrimary: true }
      });
    }
    return p;
  };

  const cleanup = async () => {
    await prisma.productImage.deleteMany({ where: { productId: { in: madeProductIds } } });
    await prisma.product.deleteMany({ where: { clientId: { in: [SHOP, OTHER_SHOP] } } });
    await prisma.tryOnUsage.deleteMany({ where: { clientId: { in: [SHOP, OTHER_SHOP] } } });
    await prisma.clientServiceLimit.deleteMany({ where: { clientId: { in: [SHOP, OTHER_SHOP] } } });
    await prisma.clientServiceCredential.deleteMany({ where: { clientId: { in: [SHOP, OTHER_SHOP] } } });
  };
  await cleanup();

  try {
    await makeProduct(SHOP, 'PRD-TRY-1', 'ACTIVE');
    await makeProduct(SHOP, 'PRD-DRAFT', 'DRAFT');
    await makeProduct(SHOP, 'PRD-NOIMG', 'ACTIVE', false);

    await prisma.clientServiceCredential.create({
      data: {
        clientId: SHOP, service: 'SHOPPER_TRYON',
        keyEncrypted: encryptCredential(SHOP_KEY), keyPrefix: SHOP_KEY.slice(0, 12),
        addedByAdmin: 'suite@scaleezy.com', status: 'ACTIVE'
      }
    });

    // ─── SCANNING THE CODE ──────────────────────────────────────────────────
    console.log('\nSCANNING A GARMENT SHOWS THE GARMENT, AND NOTHING ELSE');

    const scan = await fetch(`${base}/${SHOP}/PRD-TRY-1`);
    const scanBody: any = await scan.json();
    check('a published garment resolves', scan.status === 200, String(scan.status));
    check('it names the garment', scanBody?.data?.title === 'Garment PRD-TRY-1', String(scanBody?.data?.title));
    check('and carries its photograph', scanBody?.data?.imageUrl === GARMENT);
    check('the garment type is mapped for the gateway', scanBody?.data?.category === 'LEHANGA',
      String(scanBody?.data?.category));

    const raw = JSON.stringify(scanBody);
    // The shopper is a stranger. Anything beyond the tag is a disclosure.
    for (const leak of ['basePrice', 'cost', 'supplier', 'quantity', 'clientId', 'id"'])
      check(`nothing about the shop leaks (${leak})`, !raw.includes(leak));

    console.log('\nWHAT IS NOT PUBLISHED IS NOT REACHABLE BY GUESSING');
    const draft = await fetch(`${base}/${SHOP}/PRD-DRAFT`);
    check('a draft is a 404, not a preview', draft.status === 404, String(draft.status));
    const noImage = await fetch(`${base}/${SHOP}/PRD-NOIMG`);
    check('a garment with no photograph is refused up front', noImage.status === 404, String(noImage.status));
    const missing = await fetch(`${base}/${SHOP}/PRD-NOPE`);
    check('an unknown code is a 404', missing.status === 404, String(missing.status));
    // A draft and a non-existent product must be indistinguishable, or this becomes a way to
    // find out what a shop is working on.
    check('a draft and a missing product look identical',
      (await draft.text()) === (await missing.text()));

    console.log('\nANOTHER SHOP CANNOT REACH THIS ONE\'S GARMENT');
    const crossTenant = await fetch(`${base}/${OTHER_SHOP}/PRD-TRY-1`);
    check('the same code under another shop finds nothing', crossTenant.status === 404, String(crossTenant.status));

    // ─── GENERATING ─────────────────────────────────────────────────────────
    console.log('\nA TRY-ON PRESENTS THIS SHOP\'S KEY, AND THE GARMENT FROM THE CODE');

    const before = gateway.seen.length;
    const gen = await fetch(`${base}/${SHOP}/PRD-TRY-1/generate`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ humanImageUrl: SELFIE })
    });
    const genBody: any = await gen.json();
    check('the try-on succeeds', gen.status === 200, String(gen.status));
    check('and returns the finished picture', genBody?.data?.resultImageUrl === 'https://cdn.example/result.jpg');

    const call = gateway.seen.at(-1);
    check('the gateway saw exactly one call', gateway.seen.length === before + 1);
    check('presented with this shop\'s own key', call?.key === SHOP_KEY, String(call?.key).slice(0, 18));
    check('the garment came from the scanned code', call?.body?.garmentImageUrl === GARMENT);
    check('the person came from the request', call?.body?.humanImageUrl === SELFIE);
    check('the garment type was passed through', call?.body?.category === 'LEHANGA');
    // The whole reason this call is proxied rather than made from the page.
    check('the key is nowhere in the response', !JSON.stringify(genBody).includes(SHOP_KEY));

    console.log('\nTHE GARMENT CANNOT BE CHOSEN BY THE CALLER');
    const injected = await fetch(`${base}/${SHOP}/PRD-TRY-1/generate`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ humanImageUrl: SELFIE, garmentImageUrl: 'https://evil.example/anything.jpg' })
    });
    await injected.json().catch(() => ({}));
    check('a garment supplied in the body is ignored',
      gateway.seen.at(-1)?.body?.garmentImageUrl === GARMENT,
      String(gateway.seen.at(-1)?.body?.garmentImageUrl));

    console.log('\nA PHOTOGRAPH IS REQUIRED, AND MUST BE FETCHABLE');
    for (const [label, value] of [
      ['nothing at all', ''],
      ['a plain-text value', 'not-a-url'],
      // The gateway fetches this URL. An arbitrary scheme would aim it wherever a stranger liked.
      ['an http url', 'http://cdn.example/selfie.jpg'],
      ['something local', 'http://localhost:4006/internal']
    ] as const) {
      const seenBefore = gateway.seen.length;
      const bad = await fetch(`${base}/${SHOP}/PRD-TRY-1/generate`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ humanImageUrl: value })
      });
      check(`${label} is refused, and reaches no gateway`,
        bad.status === 400 && gateway.seen.length === seenBefore, `${bad.status}`);
    }

    // ─── METERING ───────────────────────────────────────────────────────────
    console.log('\nEACH TRY-ON IS METERED AGAINST THE SHOP WHOSE CODE WAS SCANNED');

    const usage = await settle(SHOP, 'SHOPPER_TRYON', s => s.completed >= 2);
    check('both successful try-ons were counted', usage.completed === 2, String(usage.completed));
    check('one picture each, not four', usage.viewsGenerated === 2, String(usage.viewsGenerated));

    // The reason TryOnUsage gained a service column. Without it these two share a row.
    const catalogUsage = await tryOnUsageService.summary(SHOP, undefined, 'CATALOG_TRYON');
    check('the catalog service was not charged for any of it',
      catalogUsage.generations === 0, String(catalogUsage.generations));

    console.log('\nBEING OUT OF ALLOWANCE COSTS THE SHOP NOTHING');
    await tryOnUsageService.setMonthlyLimit(SHOP, 2, 'suite@scaleezy.com', 'SHOPPER_TRYON');
    const atLimitBefore = gateway.seen.length;
    const refused = await fetch(`${base}/${SHOP}/PRD-TRY-1/generate`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ humanImageUrl: SELFIE })
    });
    await refused.json().catch(() => ({}));
    check('the shopper is told, with a 429', refused.status === 429, String(refused.status));
    check('and nothing was sent to the gateway', gateway.seen.length === atLimitBefore);

    const afterRefusal = await tryOnUsageService.summary(SHOP, undefined, 'SHOPPER_TRYON');
    check('the refusal itself was not charged', afterRefusal.generations === usage.generations,
      `${usage.generations} -> ${afterRefusal.generations}`);

    console.log('\nTHE TWO SERVICES DO NOT SHARE AN ALLOWANCE');
    // Out of shopper allowance, but the catalog service has none set -- and must be unaffected.
    const catalogStillFine = await tryOnUsageService.summary(SHOP, undefined, 'CATALOG_TRYON');
    check('the catalog service is not blocked by the shopper limit', catalogStillFine.overLimit === false);

    console.log('\nA BROKEN INTEGRATION READS AS FAILURE, NOT AS SILENCE');
    await tryOnUsageService.setMonthlyLimit(SHOP, null, 'suite@scaleezy.com', 'SHOPPER_TRYON');
    const beforeBreak = await settle(SHOP, 'SHOPPER_TRYON', s => s.generations >= 2);
    gateway.setMode('reject');
    const broken = await fetch(`${base}/${SHOP}/PRD-TRY-1/generate`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ humanImageUrl: SELFIE })
    });
    check('a rejected key surfaces as an error', broken.status >= 400, String(broken.status));
    const afterBreak = await settle(SHOP, 'SHOPPER_TRYON', s => s.failed >= beforeBreak.failed + 1);
    check('and is recorded as a failure', afterBreak.failed === beforeBreak.failed + 1,
      `${beforeBreak.failed} -> ${afterBreak.failed}`);
    check('not as a completed try-on', afterBreak.completed === beforeBreak.completed);
    gateway.setMode('ok');

    // ─── THE PRINTED CODE ───────────────────────────────────────────────────
    console.log('\nTHE PRINTED QR POINTS AT SOMETHING THIS SERVICE CAN ANSWER');
    const url = shopperTryOnProductService.scanUrlFor(SHOP, 'PRD-TRY-1');
    check('a scan url is produced', typeof url === 'string' && url.length > 0, String(url));
    check('it points at the try-on app', url!.startsWith('https://www.tryon2buy.com/try/'), String(url));
    // The route that answers it is /:clientId/:productCode -- the shape has to match, or every
    // printed tag is wrong and nobody finds out until one is scanned in a shop.
    const path = url!.replace('https://www.tryon2buy.com/try/', '');
    const echo = await fetch(`${base}/${path}`);
    check('and the path it carries resolves here', echo.status === 200, String(echo.status));

    console.log(`\n================ RESULT: ${passed} passed | ${failed} failed ================`);
    if (failures.length) {
      console.log('\nFailed:');
      for (const name of failures) console.log(`  - ${name}`);
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

main().catch(error => {
  console.error('\nSuite did not finish:', error);
  process.exitCode = 1;
});
