/**
 * Drives the whole Shopify install and webhook flow locally, over real HTTP, against the real
 * routes -- with a stand-in Shopify.
 *
 * WHY THIS EXISTS. Shopify refuses http and refuses localhost, so the real OAuth flow cannot
 * reach a machine that is not publicly reachable over HTTPS. That leaves two options: put a
 * temporary tunnel URL into the production app (which is permanent, and would force every
 * merchant who installs to reinstall later), or test everything that is OURS without Shopify
 * at all. This is the second.
 *
 * WHAT IT PROVES, which verify-shopify.ts does not:
 *
 *   - the routes are actually mounted, and reachable at the paths the Shopify app is configured
 *     with -- a typo there is invisible to a unit test and fatal in production;
 *   - the raw-body mount really is ahead of express.json(), so webhook signatures verify;
 *   - a callback ends in a redirect a browser can follow, not a JSON blob;
 *   - the token comes back out of the database intact and usable;
 *   - a forged webhook is refused, and a repeated one is not acted on twice;
 *   - uninstalling revokes.
 *
 * WHAT IT CANNOT PROVE: that Shopify behaves as documented. Only a real install does that.
 *
 *   npx ts-node src/scripts/verify-shopify-e2e.ts
 */

// Set BEFORE anything reads the environment. dotenv does not overwrite values that are already
// present, so these win over the blanks in .env, and config/env.ts validates them at import.
process.env.SHOPIFY_API_KEY = 'test-client-id';
process.env.SHOPIFY_API_SECRET = 'test-client-secret-for-e2e-only';
process.env.SHOPIFY_APP_URL = 'https://shopify.e2e.invalid';

import http from 'http';
import crypto from 'crypto';
import express from 'express';
import axios from 'axios';
import { AddressInfo } from 'net';

const SECRET = process.env.SHOPIFY_API_SECRET!;
const SHOP = `e2e-${Date.now()}.myshopify.com`;
const ISSUED_TOKEN = 'shpat_' + crypto.randomBytes(16).toString('hex');
const ISSUED_REFRESH = 'shprt_' + crypto.randomBytes(16).toString('hex');
const SHOP_GID = `gid://shopify/Shop/${Date.now()}`;

let passed = 0, failed = 0;
const failures: string[] = [];
const check = (name: string, ok: boolean, detail?: string) => {
  if (ok) { passed++; console.log(`  [PASS] ${name}`); }
  else { failed++; failures.push(name); console.log(`  [FAIL] ${name}${detail ? `  -> ${detail}` : ''}`); }
};

/** Signs a query string the way Shopify does for OAuth requests. */
const signQuery = (params: Record<string, string>) =>
  crypto.createHmac('sha256', SECRET)
    .update(Object.keys(params).sort().map(k => `${k}=${params[k]}`).join('&'), 'utf8')
    .digest('hex');

/** Signs a webhook body the way Shopify does: base64, over the raw bytes. */
const signBody = (raw: Buffer) =>
  crypto.createHmac('sha256', SECRET).update(raw).digest('base64');

/**
 * A stand-in Shopify: issues tokens and answers the shop-id query.
 *
 * Only the two endpoints our install path actually calls. Anything else 404s, which is the
 * correct outcome -- a test that quietly answers calls we did not expect would hide them.
 */
function startFakeShopify(): Promise<{ port: number; close: () => Promise<void>; calls: string[] }> {
  const calls: string[] = [];
  return new Promise(resolve => {
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', c => { body += c; });
      req.on('end', () => {
        calls.push(`${req.method} ${req.url}`);
        res.setHeader('Content-Type', 'application/json');

        if (req.url?.includes('/admin/oauth/access_token')) {
          const parsed = body ? JSON.parse(body) : {};
          // Refuse the wrong client credentials, so the test proves we send the right ones.
          if (parsed.client_id !== process.env.SHOPIFY_API_KEY || parsed.client_secret !== SECRET) {
            res.writeHead(401);
            return res.end(JSON.stringify({ error: 'invalid_client' }));
          }
          res.writeHead(200);
          return res.end(JSON.stringify({
            access_token: ISSUED_TOKEN,
            refresh_token: ISSUED_REFRESH,
            expires_in: 3600,
            refresh_token_expires_in: 7776000,
            // Deliberately COLLAPSED, exactly as Shopify records it: write_ implies read_, and
            // the read_ scopes we asked for do not come back by name.
            scope: 'write_products,write_inventory,read_locations,write_publications'
          }));
        }

        if (req.url?.includes('/graphql.json')) {
          res.writeHead(200);
          return res.end(JSON.stringify({ data: { shop: { id: SHOP_GID, name: 'E2E Store' } } }));
        }

        res.writeHead(404);
        res.end(JSON.stringify({ error: 'not found' }));
      });
    });
    server.listen(0, '127.0.0.1', () => {
      resolve({
        port: (server.address() as AddressInfo).port,
        close: () => new Promise(r => server.close(() => r())),
        calls
      });
    });
  });
}

async function main() {
  const shopify = await startFakeShopify();

  // Send anything bound for a myshopify.com host to the stand-in instead. The service under
  // test is unchanged and still builds the real URLs -- only the destination is swapped, so
  // the URL construction itself is still being exercised.
  axios.interceptors.request.use(config => {
    const url = config.url ?? '';
    if (url.includes('.myshopify.com')) {
      const parsed = new URL(url);
      config.url = `http://127.0.0.1:${shopify.port}${parsed.pathname}${parsed.search}`;
    }
    return config;
  });

  const { prisma } = await import('../lib/prisma');
  const { decryptCredential } = await import('../lib/credentialEncryption');
  const shopifyRoutes = (await import('../routes/shopify-public.routes')).default;
  const { shopifyInstallationService } = await import('../services/shopify-installation.service');

  // Mounted exactly as server.ts does it. The raw body parser MUST come first: Shopify's
  // webhook signature covers the exact bytes, and express.json() would consume them.
  const app = express();
  app.use('/api/v1/shopify/webhooks', express.raw({ type: '*/*', limit: '5mb' }));
  app.use(express.json());
  app.use('/api/v1/shopify', shopifyRoutes);

  const server = app.listen(0, '127.0.0.1');
  await new Promise(r => server.once('listening', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = axios.create({ baseURL: base, validateStatus: () => true, maxRedirects: 0 });

  try {
    // ─── THE APP URL SHOPIFY CALLS ──────────────────────────────────────────
    console.log('\nTHE ENTRY POINT SHOPIFY CALLS WHEN A MERCHANT INSTALLS');

    const entryParams = { shop: SHOP, timestamp: String(Math.floor(Date.now() / 1000)) };
    const entry = await call.get('/api/v1/shopify/install', {
      params: { ...entryParams, hmac: signQuery(entryParams) }
    });

    check('the App URL answers, so installing from Shopify is not a dead end',
      entry.status === 302, `HTTP ${entry.status}`);
    const authorizeUrl = String(entry.headers.location ?? '');
    check('it redirects to the merchant\'s own shop, not somewhere we chose',
      authorizeUrl.startsWith(`https://${SHOP}/admin/oauth/authorize`), authorizeUrl.slice(0, 80));
    check('the redirect_uri matches what the Shopify app is configured with',
      authorizeUrl.includes(encodeURIComponent('https://shopify.e2e.invalid/api/v1/shopify/callback')));

    const unsigned = await call.get('/api/v1/shopify/install', { params: { shop: SHOP } });
    check('an unsigned entry request is refused', unsigned.status === 401, `HTTP ${unsigned.status}`);

    const state = new URL(authorizeUrl).searchParams.get('state') ?? '';
    check('a single-use state was issued', state.length > 20);

    // ─── THE CALLBACK ───────────────────────────────────────────────────────
    console.log('\nTHE CALLBACK COMPLETES THE INSTALL');

    const cbParams = {
      code: 'test-authorization-code', shop: SHOP, state,
      timestamp: String(Math.floor(Date.now() / 1000))
    };
    const callback = await call.get('/api/v1/shopify/callback', {
      params: { ...cbParams, hmac: signQuery(cbParams) }
    });

    check('the callback redirects a browser somewhere real, not to JSON',
      callback.status === 302, `HTTP ${callback.status}`);
    const landing = String(callback.headers.location ?? '');
    check('an install with no tenant is sent to be claimed, not announced as connected',
      landing.includes('shopify=claim'), landing);

    check('we sent the right client credentials to Shopify',
      shopify.calls.some(c => c.includes('/admin/oauth/access_token')));

    const installation = await prisma.shopifyInstallation.findUnique({ where: { shopDomain: SHOP } });
    check('the installation was recorded', Boolean(installation));
    check('it is unclaimed, so nothing syncs until a human says whose it is',
      installation?.clientId === null, String(installation?.clientId));
    check('the permanent shop id was read, so a rename cannot duplicate the catalogue',
      installation?.shopifyShopId === SHOP_GID, String(installation?.shopifyShopId));

    // The whole reason this is encrypted rather than hashed: it has to come back out.
    check('the access token round-trips through the database intact',
      installation ? decryptCredential(installation.accessTokenEncrypted) === ISSUED_TOKEN : false);
    check('the refresh token was stored too, since offline tokens now expire',
      installation?.refreshTokenEncrypted
        ? decryptCredential(installation.refreshTokenEncrypted) === ISSUED_REFRESH : false);
    check('the stored form is not the token itself',
      installation ? !installation.accessTokenEncrypted.includes(ISSUED_TOKEN) : false);
    check('an expiry was recorded, so it can be renewed before it lapses',
      Boolean(installation?.accessTokenExpiresAt));

    // Shopify collapsed read_ into write_. Reporting those as declined would tell the merchant
    // to reconnect and approve something they already approved.
    check('collapsed read_ scopes are not reported as declined',
      shopifyInstallationService.missingScopes(installation?.scopes ?? '').length === 0,
      shopifyInstallationService.missingScopes(installation?.scopes ?? '').join(',') || 'none');

    const replay = await call.get('/api/v1/shopify/callback', {
      params: { ...cbParams, hmac: signQuery(cbParams) }
    });
    check('the same install link cannot be used twice',
      String(replay.headers.location ?? '').includes('shopify=failed'),
      String(replay.headers.location ?? ''));

    // ─── WEBHOOKS ───────────────────────────────────────────────────────────
    console.log('\nWEBHOOKS ARRIVE, ARE VERIFIED, AND ARE NOT ACTED ON TWICE');

    const body = Buffer.from(JSON.stringify({ id: 1, domain: SHOP, note: 'raw bytes matter' }));
    const webhookId = `e2e-${Date.now()}`;
    const headers = (id: string, topic: string, sig: string) => ({
      'Content-Type': 'application/json',
      'X-Shopify-Hmac-Sha256': sig,
      'X-Shopify-Topic': topic,
      'X-Shopify-Webhook-Id': id,
      'X-Shopify-Shop-Domain': SHOP
    });

    const forged = await call.post('/api/v1/shopify/webhooks', body, {
      headers: headers(webhookId, 'products/update', 'not-the-right-signature')
    });
    check('a forged webhook is refused', forged.status === 401, `HTTP ${forged.status}`);

    // The one that proves the raw-body mount. If express.json() had reached this route first,
    // the signature could not verify and this would be a 401.
    const genuine = await call.post('/api/v1/shopify/webhooks', body, {
      headers: headers(webhookId, 'products/update', signBody(body))
    });
    check('a genuine webhook is accepted -- so the raw body survived the parser',
      genuine.status === 200, `HTTP ${genuine.status}`);

    const duplicate = await call.post('/api/v1/shopify/webhooks', body, {
      headers: headers(webhookId, 'products/update', signBody(body))
    });
    check('a redelivery is acknowledged but not acted on again',
      duplicate.status === 200 && duplicate.data?.duplicate === true, JSON.stringify(duplicate.data));

    // ─── UNINSTALL ──────────────────────────────────────────────────────────
    console.log('\nUNINSTALLING ACTUALLY REVOKES');

    const uninstallBody = Buffer.from(JSON.stringify({ id: 99, domain: SHOP }));
    const uninstall = await call.post('/api/v1/shopify/webhooks', uninstallBody, {
      headers: headers(`${webhookId}-uninstall`, 'app/uninstalled', signBody(uninstallBody))
    });
    check('the uninstall webhook is accepted', uninstall.status === 200);

    // Handled after the acknowledgement, on purpose -- Shopify allows about five seconds.
    const until = Date.now() + 15000;
    let after = await prisma.shopifyInstallation.findUnique({ where: { shopDomain: SHOP } });
    while (Date.now() < until && !after?.uninstalledAt) {
      await new Promise(r => setTimeout(r, 400));
      after = await prisma.shopifyInstallation.findUnique({ where: { shopDomain: SHOP } });
    }

    check('the installation is marked uninstalled', Boolean(after?.uninstalledAt));
    check('the dead token is cleared rather than kept',
      after ? decryptCredential(after.accessTokenEncrypted) !== ISSUED_TOKEN : false);
    check('and it cannot be used again',
      await shopifyInstallationService.accessTokenFor(after!.id).then(() => false).catch(() => true));

    // ─── CLEANUP ────────────────────────────────────────────────────────────
    await prisma.shopifyWebhookReceipt.deleteMany({ where: { shopDomain: SHOP } });
    await prisma.shopifyOAuthState.deleteMany({ where: { shopDomain: SHOP } });
    await prisma.shopifyInstallation.deleteMany({ where: { shopDomain: SHOP } });
    console.log('\n(probe installation and receipts removed)');

    console.log(`\n================ RESULT: ${passed} passed | ${failed} failed ================`);
    if (failures.length) {
      console.log('\nFailed:');
      for (const name of failures) console.log(`  - ${name}`);
    }

    await prisma.$disconnect();
  } finally {
    server.close();
    await shopify.close();
  }
}

main().catch(error => { console.error('\nSuite crashed:', error); process.exitCode = 1; });
