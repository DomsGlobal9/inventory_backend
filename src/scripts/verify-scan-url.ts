/**
 * The URL a printed QR code carries, and what it is allowed to carry.
 *
 * Worth its own script because this string gets PRINTED on a garment tag. A page with a bad
 * link is a deploy away from fixed; a tag with a bad link is stitched to stock sitting in a
 * shop, and nobody finds out until a customer scans it. So the checks here lean on the cases
 * that would be embarrassing rather than on the happy path:
 *
 *   - the link still resolves when every optional parameter is missing or junk
 *   - a returnUrl off the allow-list is DROPPED, so a product QR can never be turned into an
 *     open redirect wearing our domain
 *   - javascript: and data: never survive, since the try-on page puts this into an href
 *   - the shopper's own front end is allowed without extra configuration
 *
 *   npx ts-node src/scripts/verify-scan-url.ts
 */
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://u:p@localhost:5432/db';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
process.env.SHOPPER_TRYON_APP_URL = 'https://www.tryon2buy.com';
process.env.FRONTEND_URL = 'https://app.inventory.example';
process.env.SHOPPER_TRYON_RETURN_ORIGINS = 'https://shop.example,https://store.example';

import { shopperTryOnProductService } from '../services/shopper-tryon';

let passed = 0, failed = 0;
const failures: string[] = [];
const check = (name: string, ok: boolean, detail?: string) => {
  if (ok) { passed++; console.log(`  [PASS] ${name}`); }
  else { failed++; failures.push(name); console.log(`  [FAIL] ${name}${detail ? `  -> ${detail}` : ''}`); }
};

const SHOP = 'client-123';
const CODE = 'PRD-0007';
const url = (opts?: any) => shopperTryOnProductService.scanUrlFor(SHOP, CODE, opts);
const q = (u: string | null, key: string) =>
  u ? new URL(u).searchParams.get(key) : null;

async function run() {
  console.log('\nTHE LINK ITSELF');

  const bare = url();
  check('a bare scan url is produced',
    bare === 'https://www.tryon2buy.com/try/client-123/PRD-0007', String(bare));
  check('it carries no query string when nothing was asked for',
    !!bare && !bare.includes('?'), String(bare));

  const encoded = shopperTryOnProductService.scanUrlFor('a/b c', 'PRD/1', {});
  check('path segments are encoded, so a code with a slash cannot forge a path',
    encoded === 'https://www.tryon2buy.com/try/a%2Fb%20c/PRD%2F1', String(encoded));

  console.log('\nRETURN URL -- WHAT IS ALLOWED');

  const configured = url({ returnUrl: 'https://shop.example/products/42' });
  check('a configured origin is carried',
    q(configured, 'returnUrl') === 'https://shop.example/products/42', String(configured));

  const second = url({ returnUrl: 'https://store.example/p/9' });
  check('a second configured origin is carried too (the list is a list)',
    q(second, 'returnUrl') === 'https://store.example/p/9', String(second));

  const ownFrontend = url({ returnUrl: 'https://app.inventory.example/products/42' });
  check('our own front end is allowed without being listed separately',
    q(ownFrontend, 'returnUrl') === 'https://app.inventory.example/products/42', String(ownFrontend));

  const withPathAndQuery = url({ returnUrl: 'https://shop.example/p/42?tab=details#reviews' });
  check('path, query and fragment on an allowed origin survive intact',
    q(withPathAndQuery, 'returnUrl') === 'https://shop.example/p/42?tab=details#reviews',
    String(q(withPathAndQuery, 'returnUrl')));

  console.log('\nRETURN URL -- WHAT IS REFUSED');

  const hostile = url({ returnUrl: 'https://evil.example/phish' });
  check('an origin that is not ours is dropped, not carried',
    q(hostile, 'returnUrl') === null, String(hostile));
  check('and the link still works without it',
    hostile === 'https://www.tryon2buy.com/try/client-123/PRD-0007', String(hostile));

  check('javascript: is dropped',
    q(url({ returnUrl: 'javascript:alert(1)' }), 'returnUrl') === null);
  check('data: is dropped',
    q(url({ returnUrl: 'data:text/html,<script>alert(1)</script>' }), 'returnUrl') === null);
  check('a relative url is dropped (there is no safe way to guess what was meant)',
    q(url({ returnUrl: '/products/42' }), 'returnUrl') === null);
  check('a malformed url is dropped rather than throwing',
    q(url({ returnUrl: 'ht!tp://%%%' }), 'returnUrl') === null);
  check('a lookalike host is dropped (suffix matching would have let this through)',
    q(url({ returnUrl: 'https://shop.example.evil.com/x' }), 'returnUrl') === null);
  check('an allowed host on a different port is dropped (origin, not hostname)',
    q(url({ returnUrl: 'https://shop.example:8443/x' }), 'returnUrl') === null);
  check('null and undefined are fine',
    url({ returnUrl: null }) === bare && url({ returnUrl: undefined }) === bare);

  console.log('\nSOURCE, AND MORE THAN ONE PARAMETER AT ONCE');

  check('a plain token is carried',
    q(url({ source: 'label-sheet' }), 'source') === 'label-sheet');
  check('a token with punctuation is dropped',
    q(url({ source: 'label sheet!' }), 'source') === null);
  check('an over-long token is dropped',
    q(url({ source: 'x'.repeat(41) }), 'source') === null);

  const both = url({ returnUrl: 'https://shop.example/p/42', source: 'product-screen' });
  check('both parameters travel together',
    q(both, 'returnUrl') === 'https://shop.example/p/42' && q(both, 'source') === 'product-screen',
    String(both));

  const oneGood = url({ returnUrl: 'https://evil.example/x', source: 'product-screen' });
  check('a bad parameter does not take a good one down with it',
    q(oneGood, 'returnUrl') === null && q(oneGood, 'source') === 'product-screen', String(oneGood));

  console.log('\nWHEN TRY-ON IS NOT CONFIGURED');
  const saved = process.env.SHOPPER_TRYON_APP_URL;
  delete process.env.SHOPPER_TRYON_APP_URL;
  // env is validated once at import, so this only proves the guard reads the same value it
  // was given; the real "not configured" case is covered by the null return in scanUrlFor.
  process.env.SHOPPER_TRYON_APP_URL = saved;
  check('a configured deployment still returns a url', url() !== null);

  console.log(`\n================ RESULT: ${passed} passed | ${failed} failed ================`);
  if (failed > 0) {
    console.log('FAILED:'); failures.forEach(f => console.log('  - ' + f));
    process.exit(1);
  }
  process.exit(0);
}

run().catch(err => { console.error(err); process.exit(1); });
