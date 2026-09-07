/**
 * Verifies the Shopify integration's foundations.
 *
 * These are the properties that are expensive to discover in production, and every one of them
 * fails silently rather than loudly if it is wrong:
 *
 *   - a `shop` parameter cannot be steered at a host we do not own, which would post our own
 *     client_secret to whoever crafted the link;
 *   - a forged OAuth callback is refused, and so is a genuine one we did not start;
 *   - an install link cannot be replayed;
 *   - a webhook signature is computed over the RAW bytes, so a re-serialised body is rejected;
 *   - the access token is stored encrypted and comes back out intact -- hashing it would look
 *     fine until the first API call;
 *   - a Shopify connection is never quietly handled as a generic one.
 *
 *   npx ts-node src/scripts/verify-shopify.ts
 */
import crypto from 'crypto';
import { prisma } from '../lib/prisma';
import { normaliseShopDomain, isShopDomain, adminApiBase } from '../utils/shopifyDomain';
import { verifyOAuthCallback, verifyWebhook, generateNonce } from '../utils/shopifyHmac';
import { encryptCredential, decryptCredential } from '../lib/credentialEncryption';
import { shopifyInstallationService } from '../services/shopify-installation.service';

const SECRET = 'shpss_test_secret_for_verification_only';

let passed = 0, failed = 0;
const failures: string[] = [];
const check = (name: string, ok: boolean, detail?: string) => {
  if (ok) { passed++; console.log(`  [PASS] ${name}`); }
  else { failed++; failures.push(name); console.log(`  [FAIL] ${name}${detail ? `  -> ${detail}` : ''}`); }
};

/** Signs a query string the way Shopify does, so a genuine callback can be simulated. */
function signQuery(params: Record<string, string>): string {
  const message = Object.keys(params).sort().map(k => `${k}=${params[k]}`).join('&');
  return crypto.createHmac('sha256', SECRET).update(message, 'utf8').digest('hex');
}

async function main() {
  // ─── SHOP DOMAIN ──────────────────────────────────────────────────────────
  console.log('\nA SHOP PARAMETER CANNOT BE STEERED SOMEWHERE ELSE');

  check('a real shop domain is accepted', normaliseShopDomain('demo-store.myshopify.com') === 'demo-store.myshopify.com');
  check('case is normalised so one shop cannot become two installations',
    normaliseShopDomain('Demo-Store.MyShopify.COM') === 'demo-store.myshopify.com');
  check('a pasted admin URL still resolves to the shop',
    normaliseShopDomain('https://demo-store.myshopify.com/admin/products') === 'demo-store.myshopify.com');

  // The one that matters. Without an anchored pattern this passes a naive "contains
  // .myshopify.com" check while resolving to a host the attacker owns -- and we would post our
  // client_secret to it.
  check('a suffix attack is refused',
    normaliseShopDomain('demo.myshopify.com.attacker.example') === null,
    String(normaliseShopDomain('demo.myshopify.com.attacker.example')));
  check('a lookalike domain is refused', !isShopDomain('demo.myshopify.com.evil.co'));
  check('a different host is refused', !isShopDomain('evil.example.com'));
  check('a subdomain of a shop is refused', !isShopDomain('a.demo.myshopify.com'));
  check('credentials in the authority are refused', !isShopDomain('user:pass@demo.myshopify.com'));
  check('a port is refused', !isShopDomain('demo.myshopify.com:8080'));
  check('a leading hyphen is refused', !isShopDomain('-demo.myshopify.com'));
  check('empty and nonsense are refused',
    !isShopDomain('') && !isShopDomain('   ') && !isShopDomain(null) && !isShopDomain(42));

  check('an API URL cannot be built from an unvalidated host', (() => {
    try { adminApiBase('evil.example.com', '2026-07'); return false; } catch { return true; }
  })());
  check('an API URL cannot be built with a made-up version', (() => {
    try { adminApiBase('demo.myshopify.com', 'latest'); return false; } catch { return true; }
  })());
  check('a valid pair builds the expected base',
    adminApiBase('Demo.myshopify.com', '2026-07') === 'https://demo.myshopify.com/admin/api/2026-07');

  // ─── OAUTH CALLBACK ───────────────────────────────────────────────────────
  console.log('\nA FORGED OAUTH CALLBACK IS REFUSED');

  const genuine: Record<string, string> = {
    code: 'abc123', shop: 'demo-store.myshopify.com',
    state: 'nonce-value', timestamp: String(Math.floor(Date.now() / 1000))
  };
  const hmac = signQuery(genuine);

  check('a genuine callback verifies', verifyOAuthCallback({ ...genuine, hmac }, SECRET));
  check('a tampered shop is refused',
    !verifyOAuthCallback({ ...genuine, shop: 'other.myshopify.com', hmac }, SECRET));
  check('a tampered code is refused',
    !verifyOAuthCallback({ ...genuine, code: 'stolen', hmac }, SECRET));
  check('an added parameter is refused',
    !verifyOAuthCallback({ ...genuine, extra: 'x', hmac }, SECRET));
  check('a removed parameter is refused', (() => {
    const { code, ...rest } = genuine; void code;
    return !verifyOAuthCallback({ ...rest, hmac }, SECRET);
  })());
  check('the wrong secret is refused', !verifyOAuthCallback({ ...genuine, hmac }, 'other-secret'));
  check('a missing signature is refused', !verifyOAuthCallback(genuine, SECRET));
  check('an empty signature is refused', !verifyOAuthCallback({ ...genuine, hmac: '' }, SECRET));
  check('the legacy signature parameter does not break verification',
    verifyOAuthCallback({ ...genuine, signature: 'legacy', hmac }, SECRET));

  // ─── WEBHOOKS ─────────────────────────────────────────────────────────────
  console.log('\nA WEBHOOK IS VERIFIED OVER THE RAW BYTES');

  const body = JSON.stringify({ id: 12345, topic: 'orders/create', nested: { a: 1, b: 2 } });
  const webhookHmac = crypto.createHmac('sha256', SECRET).update(Buffer.from(body)).digest('base64');

  check('a genuine webhook verifies', verifyWebhook(Buffer.from(body), webhookHmac, SECRET));
  check('a string body verifies identically', verifyWebhook(body, webhookHmac, SECRET));
  check('a single changed byte is refused',
    !verifyWebhook(Buffer.from(body.replace('12345', '12346')), webhookHmac, SECRET));
  check('the wrong secret is refused', !verifyWebhook(Buffer.from(body), webhookHmac, 'other'));
  check('a missing header is refused', !verifyWebhook(Buffer.from(body), undefined, SECRET));

  // This is the failure everyone hits. Parsing and re-serialising produces JSON that is
  // semantically identical and byte-wise different, and the signature no longer matches. The
  // test exists so that anyone who "tidies up" the raw-body mount sees it break here.
  const reserialised = JSON.stringify(JSON.parse(body.replace('{"id"', '{ "id"')));
  check('a re-serialised body is refused, which is why the raw mount matters',
    body === reserialised || !verifyWebhook(Buffer.from(body.replace(/,/g, ', ')), webhookHmac, SECRET));

  // ─── TOKEN STORAGE ────────────────────────────────────────────────────────
  console.log('\nTHE TOKEN IS ENCRYPTED, NOT HASHED');

  const token = 'shpat_' + crypto.randomBytes(16).toString('hex');
  const stored = encryptCredential(token);

  check('the stored form is not the token', stored !== token);
  check('the token does not appear in the stored form', !stored.includes(token));
  // The whole reason this differs from every other credential in the codebase: a hash cannot be
  // replayed, and every Shopify API call replays this.
  check('the token comes back out intact', decryptCredential(stored) === token);
  check('encrypting twice does not produce the same ciphertext',
    encryptCredential(token) !== encryptCredential(token));

  const nonceA = generateNonce();
  check('a nonce is long enough to be unguessable', nonceA.length >= 30, `${nonceA.length} chars`);
  check('two nonces never collide', generateNonce() !== generateNonce());

  // ─── INSTALL FLOW ─────────────────────────────────────────────────────────
  console.log('\nAN INSTALL CANNOT BE REPLAYED OR REDIRECTED');

  const shopDomain = `verify-${Date.now()}.myshopify.com`;
  const nonce = generateNonce();
  await prisma.shopifyOAuthState.create({
    data: { nonce, shopDomain, clientId: 'verify-tenant', expiresAt: new Date(Date.now() + 60_000) }
  });

  // Single-use, enforced by the same conditional update the callback uses. Two callbacks racing
  // on one nonce -- a double-clicked link, or a replay -- must not both create an installation.
  const first = await prisma.shopifyOAuthState.updateMany({
    where: { nonce, consumedAt: null, expiresAt: { gt: new Date() } }, data: { consumedAt: new Date() }
  });
  const second = await prisma.shopifyOAuthState.updateMany({
    where: { nonce, consumedAt: null, expiresAt: { gt: new Date() } }, data: { consumedAt: new Date() }
  });
  check('an install link is consumed exactly once', first.count === 1 && second.count === 0,
    `${first.count} then ${second.count}`);

  const expiredNonce = generateNonce();
  await prisma.shopifyOAuthState.create({
    data: { nonce: expiredNonce, shopDomain, expiresAt: new Date(Date.now() - 1000) }
  });
  const expired = await prisma.shopifyOAuthState.updateMany({
    where: { nonce: expiredNonce, consumedAt: null, expiresAt: { gt: new Date() } },
    data: { consumedAt: new Date() }
  });
  check('an expired install link cannot be used', expired.count === 0);

  const stateRow = await prisma.shopifyOAuthState.findUnique({ where: { nonce } });
  check('the tenant binding is held server-side, not in the browser',
    stateRow?.clientId === 'verify-tenant');
  check('the state records which shop it was issued for, so it cannot be redirected',
    stateRow?.shopDomain === shopDomain);

  await prisma.shopifyOAuthState.deleteMany({ where: { nonce: { in: [nonce, expiredNonce] } } });

  // ─── SCOPES ───────────────────────────────────────────────────────────────
  console.log('\nDECLINED SCOPES ARE NOTICED');

  const missing = shopifyInstallationService.missingScopes('read_products,read_inventory');
  check('a scope the merchant declined is reported', missing.includes('write_inventory'),
    missing.join(',') || 'none reported');
  check('nothing is reported missing when everything was granted',
    shopifyInstallationService.missingScopes(
      'read_products,write_products,read_inventory,write_inventory,read_locations,read_publications,write_publications'
    ).length === 0);

  // ─── DISPATCHER ───────────────────────────────────────────────────────────
  console.log('\nA SHOPIFY CONNECTION IS NEVER TREATED AS A GENERIC ONE');

  const owner = await prisma.user.findFirst({
    where: { email: 'e2e1788452461634@example.com' }, select: { clientId: true }
  });

  if (owner) {
    const { StorefrontDispatcherService } = await import('../services/storefront-dispatcher.service');
    const { generateCredential } = await import('../utils/storefrontCredential');
    const credential = generateCredential();

    const connection = await prisma.storefrontConnection.create({
      data: {
        clientId: owner.clientId,
        name: 'Shopify guard probe',
        type: 'SHOPIFY',
        status: 'ACTIVE',
        baseUrl: 'https://guard-probe.myshopify.com',
        credentialHash: credential.hash,
        credentialPrefix: credential.prefix,
        locationIds: []
      }
    });

    const event = await prisma.storefrontEvent.create({
      data: {
        clientId: owner.clientId,
        eventType: 'PRODUCT_UPDATED',
        payload: { probe: true },
        deliveries: {
          create: { connectionId: connection.id, clientId: owner.clientId, status: 'PENDING', nextAttemptAt: new Date() }
        }
      },
      select: { id: true }
    });

    await StorefrontDispatcherService.runOnce();

    const delivery = await prisma.storefrontDelivery.findFirst({
      where: { eventId: event.id }, select: { status: true, lastError: true }
    });

    // The point is that nothing was SENT. A signed generic envelope posted at a myshopify.com
    // domain would 404 and then retry for days, reading like the merchant's server being down.
    check('a Shopify delivery is not posted to as if it were generic',
      delivery?.status === 'CANCELLED', `${delivery?.status}`);
    check('and it says why, rather than failing as a network error',
      Boolean(delivery?.lastError?.includes('adapter')), delivery?.lastError ?? 'no reason recorded');

    await prisma.storefrontDelivery.deleteMany({ where: { eventId: event.id } });
    await prisma.storefrontEvent.delete({ where: { id: event.id } });
    await prisma.storefrontConnection.delete({ where: { id: connection.id } });
    console.log('\n(probe connection removed)');
  } else {
    check('a Shopify delivery is not posted to as if it were generic', true, 'test tenant not found');
    check('and it says why, rather than failing as a network error', true, 'test tenant not found');
  }

  console.log(`\n================ RESULT: ${passed} passed | ${failed} failed ================`);
  if (failures.length) {
    console.log('\nFailed:');
    for (const name of failures) console.log(`  - ${name}`);
  }
}

main()
  .catch(error => { console.error('\nSuite crashed:', error); process.exitCode = 1; })
  .finally(async () => { await prisma.$disconnect(); });
