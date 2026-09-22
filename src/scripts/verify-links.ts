/**
 * SHORT LINKS (go.scaleezy.com), worst cases included.
 *
 *   R  the rules (pure): codes, where a link may go, expiry, person or robot
 *   M  making links: once per person, again after a failure halfway, two at the same moment,
 *      shops kept apart, every refusal in words
 *   O  opening them through the running server: redirect, attribution, counts, every page, nothing
 *      cached, only GET/HEAD
 *   G  the go.scaleezy.com host: nothing else of the server reachable; the per-visitor limit
 *   C  counts: customers who tapped, test sends left out, twenty taps at once
 *   D  switching off: by the shop, by ScaleEzy, and which one wins
 *   S  other ScaleEzy services: signed tokens, scopes, their own links only
 *   H  clean-up: old opens and old test links go, real links stay
 *   X  deleting the shop takes its links
 *
 *   npx tsx src/scripts/verify-links.ts     (needs the local backend running, LINK_BASE_URL set)
 *
 * Makes only a throwaway shop's links; sends nothing anywhere. Run at most once a minute (the
 * server's per-visitor limit on opening links is 60 a minute).
 */
import axios from 'axios';
import express from 'express';
import jwt from 'jsonwebtoken';
import { generateKeyPairSync } from 'crypto';
import { writeFileSync, unlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { AddressInfo } from 'net';
import { prisma } from '../lib/prisma';
import { env } from '../config/env';
import { platformAdminService } from '../services/platform-admin.service';
import { links, newRecipientRef, LinkRuleError } from '../services/links';
import * as R from '../services/links/rules';
import { classifyVisitor } from '../services/links/robots';
import { linkHostGate, linkPathRouter } from '../routes/link-open.routes';
import linksApiRoutes from '../routes/links-api.routes';

const SERVER = (process.env.VERIFY_API_URL || 'http://localhost:4006/api/v1').replace(/\/api\/v1\/?$/, '');
const STAMP = Date.now();
const SHOP = `links-${STAMP}`;
const OTHER = `links-other-${STAMP}`;

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
  try { fn(); return ''; } catch (e) { return e instanceof LinkRuleError ? e.message : `NOT A RULE ERROR: ${(e as Error).message}`; }
};
const refusalAsync = async (p: Promise<unknown>): Promise<string> => {
  try { await p; return ''; } catch (e) { return e instanceof LinkRuleError ? e.message : `NOT A RULE ERROR: ${(e as Error).message}`; }
};
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const codeOf = (shortUrl: string) => shortUrl.slice(shortUrl.lastIndexOf('/') + 1);
const row = (code: string) => prisma.shortLink.findUniqueOrThrow({ where: { code } });
const BROWSER = 'Mozilla/5.0 (Linux; Android 14; SM-A146B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36';
const WHATSAPP = 'WhatsApp/2.24.13.78 A';

const httpGet = (url: string, headers: Record<string, string> = {}, method: 'GET' | 'HEAD' | 'POST' = 'GET') =>
  axios.request({ url, method, headers, maxRedirects: 0, validateStatus: () => true, responseType: 'text' });

/** An app on a random port, for the parts that must run with other settings than the server's. */
async function localApp(build: (app: express.Express) => void) {
  const app = express();
  build(app);
  app.use((_req, res) => res.status(299).send('passed through'));
  const server = app.listen(0);
  await new Promise(r => server.once('listening', r));
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => new Promise(r => server.close(r)) };
}

async function main() {
  if (!links.available()) throw new Error('Set LINK_BASE_URL (e.g. http://localhost:4006/l) in backend/.env first.');
  const pathBase = env.LINK_BASE_URL!;
  const health = await axios.get(`${SERVER}/health`).catch(() => null);
  if (!health) throw new Error(`The backend is not running at ${SERVER}.`);

  console.log(`\nSETUP ${SHOP}`);
  await prisma.clientSettings.create({ data: { clientId: SHOP, businessName: 'Sree <Silks> & Sarees' } });
  // Deleting a shop needs it to exist: a location is enough.
  for (const c of [SHOP, OTHER]) await prisma.stockLocation.create({ data: { clientId: c, name: 'Main Store', code: 'MAIN', type: 'STORE', active: true } });
  const campaign = { module: 'campaigns', ref: `camp-${STAMP}` };

  // ── R ───────────────────────────────────────────────────────────────────────────────────
  console.log('\nR. THE RULES');
  {
    const N = 1_000_000;
    const seen = new Set<string>();
    const freq = new Map<string, number>();
    let badShape = 0;
    for (let i = 0; i < N; i++) {
      const c = R.newCode();
      if (!R.CODE_SHAPE.test(c)) badShape++;
      seen.add(c);
      for (const ch of c) freq.set(ch, (freq.get(ch) ?? 0) + 1);
    }
    check('a million codes: every one 7 letters/digits', badShape === 0, badShape);
    check('a million codes: all 62 characters used', freq.size === 62, freq.size);
    const expected = (N * 7) / 62;
    const worst = Math.max(...[...freq.values()].map(v => Math.abs(v - expected) / expected));
    check('a million codes: every character equally likely (within 2%)', worst < 0.02, `worst ${(worst * 100).toFixed(2)}%`);
    check('a million codes: clashes as rare as the maths says (expect 0, allow 2)', N - seen.size <= 2, N - seen.size);
    check('codes are not in order: two in a row share no pattern', R.newCode() !== R.newCode());
    // The unfair-byte guard: a source that only ever gives 255 then 0 must still produce "AAAAAAA".
    let calls = 0;
    const skewed = R.newCode(n => { calls++; return Buffer.from(Array.from({ length: n }, (_, i) => (i % 2 ? 0 : 255))); });
    check('bytes 248-255 are thrown away, never folded onto the first letters', skewed === 'AAAAAAA' && calls === 1, skewed);
    check('recipient tokens are 128-bit, url-safe and never repeat', (() => {
      const a = newRecipientRef(); const b = newRecipientRef();
      return a !== b && /^[A-Za-z0-9_-]{22}$/.test(a);
    })());

    const ctx = { blockedHosts: ['go.scaleezy.com', 'inventory-backend-6vk5.onrender.com', 'app.scaleezy.com'], production: true };
    const ok = (u: string, t: R.TargetType = 'EXTERNAL') => { try { return R.checkTarget(u, t, ctx); } catch (e) { return `REFUSED: ${(e as Error).message}`; } };
    const no = (u: unknown, t: R.TargetType = 'EXTERNAL') => refusal(() => R.checkTarget(u, t, ctx));
    check('a normal shop page is accepted and normalised', ok('https://LakshmiSilks.in/Sarees?c=red#top') === 'https://lakshmisilks.in/Sarees?c=red#top', ok('https://LakshmiSilks.in/Sarees?c=red#top'));
    check('a Shopify product page is accepted', ok('https://lakshmi-silks.myshopify.com/products/red-saree', 'PRODUCT').startsWith('https://'));
    check('our own shop pages are accepted', !ok('https://shop.scaleezy.com/lakshmi/p/red', 'PRODUCT').startsWith('REFUSED') && !ok('https://lakshmi.shop.scaleezy.com/', 'SHOP').startsWith('REFUSED'));
    check('a WhatsApp chat link is accepted as WHATSAPP', ok('https://wa.me/918247003162?text=I%20want%20the%20red%20saree', 'WHATSAPP').startsWith('https://wa.me/'));
    const refused: Array<[unknown, RegExp, R.TargetType?]> = [
      ['http://lakshmisilks.in/', /https/],
      ['javascript:alert(1)', /https/],
      ['data:text/html,<script>alert(1)</script>', /https/],
      ['ftp://lakshmisilks.in/', /https/],
      ['https://user:pass@lakshmisilks.in/', /password/],
      ['https://lakshmisilks.in:8443/', /port/],
      ['https://localhost/', /private network/],
      ['https://127.0.0.1/', /number address/],
      ['https://2130706433/', /number address/],
      ['https://0x7f.0.0.1/', /number address/],
      ['https://[::1]/', /number address/],
      ['https://10.0.0.5/admin', /number address/],
      ['https://169.254.169.254/latest/meta-data', /number address/],
      ['https://printer/', /private network/],
      ['https://nas.local/', /private network/],
      ['https://db.internal/', /private network/],
      ['https://go.scaleezy.com/AbC1234', /part of ScaleEzy/],
      ['https://GO.SCALEEZY.COM./AbC1234', /part of ScaleEzy/],
      ['https://inventory-backend-6vk5.onrender.com/api/v1/auth/login', /part of ScaleEzy/],
      ['https://app.scaleezy.com/login', /part of ScaleEzy/],
      ['https://shopify.scaleezy.com/api/v1/shopify/install', /part of ScaleEzy/],
      ['https://admin.scaleezy.com/', /part of ScaleEzy/],
      ['https://bit.ly/3abcDEF', /another short link/],
      ['https://www.tinyurl.com/abc', /another short link/],
      ['https://wa.link/abc123', /another short link/],
      ['https://xn--scleezy-9kd.com/', /not allowed/],
      ['https://lakshmisilks.in/a b', /spaces/],
      ['https://lakshmisilks.in/ ', /hidden/],
      ['', /Type the web address/],
      [null, /Type the web address/],
      [`https://lakshmisilks.in/${'a'.repeat(2100)}`, /too long/],
      ['notaurl', /not a web address/],
      ['not a url', /spaces/],
      ['https://wa.me/918247003162', /Chat with the shop/, 'EXTERNAL'],
      ['https://lakshmisilks.in/', /wa.me/, 'WHATSAPP'],
      ['https://wa.me/abc', /shop.s number/, 'WHATSAPP']
    ];
    for (const [u, why, t] of refused) {
      const m = no(u, t ?? 'EXTERNAL');
      check(`refused: ${String(u).slice(0, 60)}`, why.test(m), m || 'ACCEPTED');
    }
    check('an unknown kind of target is refused', /Choose where/.test(no('https://lakshmisilks.in/', 'NOPE' as R.TargetType)));
    check('plain http to this computer works only outside production',
      R.checkTarget('http://localhost:5173/shop', 'SHOP', { ...ctx, production: false }) === 'http://localhost:5173/shop' && /https/.test(no('http://localhost:5173/shop', 'SHOP')));

    check('our own targets carry ?sz=<code>; a typed address is left alone',
      R.redirectTarget('https://lakshmisilks.in/p?x=1', 'PRODUCT', 'AbC1234') === 'https://lakshmisilks.in/p?x=1&sz=AbC1234'
      && R.redirectTarget('https://lakshmisilks.in/p?x=1', 'EXTERNAL', 'AbC1234') === 'https://lakshmisilks.in/p?x=1'
      && R.redirectTarget('https://wa.me/918247003162', 'WHATSAPP', 'AbC1234') === 'https://wa.me/918247003162');
    check('a code sent in ?sz= replaces one already there (no stacking)', R.redirectTarget('https://a.in/p?sz=old', 'SHOP', 'NEW1234') === 'https://a.in/p?sz=NEW1234');

    const now = new Date('2026-09-22T10:00:00Z');
    check('90 days by default', R.expiryFor(now).getTime() - now.getTime() === 90 * 86_400_000);
    check('up to 365 days; 0, 366, 1.5 and -1 refused', R.expiryFor(now, 365).getTime() > now.getTime()
      && [0, 366, 1.5, -1].every(d => /1 to 365/.test(refusal(() => R.expiryFor(now, d)))));
    check('switched off by ScaleEzy wins over expired, so the reason never shows as "ended"',
      R.stateOf({ status: 'DISABLED_BY_PLATFORM', expiresAt: new Date(0) }, now) === 'DISABLED_BY_PLATFORM'
      && R.stateOf({ status: 'ACTIVE', expiresAt: now }, now) === 'EXPIRED'
      && R.stateOf({ status: 'ACTIVE', expiresAt: new Date(now.getTime() + 1) }, now) === 'ACTIVE');

    const people = [BROWSER,
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
      'Mozilla/5.0 (Linux; Android 10; CUBOT X30) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36',
      'Mozilla/5.0 (Linux; Android 13; SM-M146B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Mobile Safari/537.36 Instagram 334.0',
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 [FBAN/FBIOS;FBAV/460.0]'];
    const robots = [WHATSAPP, 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)', 'TelegramBot (like TwitterBot)',
      'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)', 'curl/8.4.0', 'python-requests/2.31',
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) SkypeUriPreview Preview/0.5', 'Mozilla/5.0 (compatible; SomeNewBot/1.0)',
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/120.0 Safari/537.36'];
    check('people on phones, in-app browsers and a CUBOT phone are people', people.every(u => classifyVisitor('GET', u) === 'HUMAN'), people.filter(u => classifyVisitor('GET', u) !== 'HUMAN'));
    check('WhatsApp previews, crawlers, scanners and programs are robots', robots.every(u => classifyVisitor('GET', u) === 'BOT'), robots.filter(u => classifyVisitor('GET', u) !== 'BOT'));
    check('no browser string, or a HEAD, is a robot', classifyVisitor('GET', '') === 'BOT' && classifyVisitor('GET', undefined) === 'BOT' && classifyVisitor('HEAD', BROWSER) === 'BOT');
  }

  // ── M ───────────────────────────────────────────────────────────────────────────────────
  console.log('\nM. MAKING LINKS');
  const refs = Array.from({ length: 8 }, () => newRecipientRef());
  const target = 'https://lakshmisilks.in/products/red-kanchipuram-saree';
  let first: links.MadeLink[] = [];
  {
    // A campaign that failed after five people, then tried again for all eight.
    const five = await links.makeLinks({ clientId: SHOP, owner: campaign, links: refs.slice(0, 5).map(r => ({ recipientRef: r, targetType: 'PRODUCT' as const, target })) });
    first = await links.makeLinks({ clientId: SHOP, owner: campaign, links: refs.map(r => ({ recipientRef: r, targetType: 'PRODUCT' as const, target })) });
    check('eight people, eight links, each its own code', first.length === 8 && new Set(first.map(l => l.code)).size === 8);
    check('again after a failure halfway: the first five are the same links, three new', five.every((l, i) => l.code === first[i].code));
    check('in the order asked, each with its short address', first.every((l, i) => l.recipientRef === refs[i] && l.shortUrl === `${pathBase}/${l.code}`));
    check('exactly eight rows in the database', (await prisma.shortLink.count({ where: { clientId: SHOP, ownerRef: campaign.ref } })) === 8);
    check('90 days, from now', Math.abs(first[0].expiresAt.getTime() - (Date.now() + 90 * 86_400_000)) < 60_000);
    const again = await links.makeLinks({ clientId: SHOP, owner: campaign, links: refs.map(r => ({ recipientRef: r, targetType: 'EXTERNAL' as const, target: 'https://elsewhere.example.com/' })) });
    check('asking again with another address changes nothing already sent', again.every((l, i) => l.code === first[i].code && l.target === target));

    // Two workers making the same people's links at the same moment.
    const race = Array.from({ length: 30 }, () => newRecipientRef());
    const [a, b] = await Promise.all([0, 1].map(() => links.makeLinks({ clientId: SHOP, owner: { module: 'campaigns', ref: `race-${STAMP}` }, links: race.map(r => ({ recipientRef: r, targetType: 'SHOP' as const, target: 'https://lakshmisilks.in/' })) })));
    check('two at the same moment: both get the same 30 links, none twice', a.every((l, i) => l.code === b[i].code) && (await prisma.shortLink.count({ where: { clientId: SHOP, ownerRef: `race-${STAMP}` } })) === 30);

    const otherShop = await links.makeLinks({ clientId: OTHER, owner: campaign, links: [{ recipientRef: refs[0], targetType: 'PRODUCT', target }] });
    check('another shop with the same campaign reference and token gets its own link', otherShop[0].code !== first[0].code);

    const shared = await links.makeLinks({ clientId: SHOP, owner: { module: 'receipts' }, links: [{ targetType: 'SHOP', target: 'https://lakshmisilks.in/' }] });
    const shared2 = await links.makeLinks({ clientId: SHOP, owner: { module: 'receipts' }, links: [{ targetType: 'SHOP', target: 'https://lakshmisilks.in/' }] });
    check('a shared link (nobody in particular) is a new one each time', shared[0].recipientRef === null && shared[0].code !== shared2[0].code);
    const short = await links.makeLinks({ clientId: SHOP, owner: { module: 'campaigns', ref: `short-${STAMP}` }, days: 7, links: [{ recipientRef: newRecipientRef(), targetType: 'SHOP', target: 'https://lakshmisilks.in/' }] });
    check('a link can be asked to last 7 days', Math.abs(short[0].expiresAt.getTime() - (Date.now() + 7 * 86_400_000)) < 60_000);

    const make = (over: Record<string, unknown>) => refusalAsync(links.makeLinks({ clientId: SHOP, owner: campaign, links: [{ recipientRef: newRecipientRef(), targetType: 'PRODUCT', target }], ...over } as any));
    const tooMany = Array.from({ length: 1001 }, () => ({ recipientRef: newRecipientRef(), targetType: 'SHOP' as const, target: 'https://lakshmisilks.in/' }));
    const dupRef = newRecipientRef();
    const cases: Array<[string, Promise<string> | string, RegExp]> = [
      ['no links', await make({ links: [] }), /no links/],
      ['1,001 links in one call', await make({ links: tooMany }), /1,000/],
      ['the same person twice', await make({ links: [{ recipientRef: dupRef, targetType: 'SHOP', target }, { recipientRef: dupRef, targetType: 'SHOP', target }] }), /twice/],
      ['several links with one shared among them', await make({ links: [{ targetType: 'SHOP', target }, { recipientRef: newRecipientRef(), targetType: 'SHOP', target }] }), /own recipient token/],
      ['people\'s links without the thing they belong to', await make({ owner: { module: 'campaigns' } }), /owner reference/],
      ['a customer id-looking token with spaces', await make({ links: [{ recipientRef: 'customer 42', targetType: 'SHOP', target }] }), /recipient token/],
      ['a bad module name', await make({ owner: { module: 'Campaigns!', ref: 'x' } }), /module name/],
      ['400 days', await make({ days: 400 }), /1 to 365/],
      ['no shop', await make({ clientId: '' }), /belongs to a shop/],
      ['the third link going somewhere bad, named by number', await make({ links: [0, 1, 2].map(i => ({ recipientRef: newRecipientRef(), targetType: 'EXTERNAL', target: i === 2 ? 'https://bit.ly/x' : target })) }), /^Link 3: .*another short link/]
    ];
    for (const [name, got, why] of cases) check(`refused in words: ${name}`, why.test(await got), await got);
    check('refusals made nothing', (await prisma.shortLink.count({ where: { clientId: SHOP, ownerRef: campaign.ref } })) === 8);

    const saved = env.LINK_BASE_URL;
    (env as any).LINK_BASE_URL = undefined;
    const off = await make({});
    (env as any).LINK_BASE_URL = saved;
    check('with LINK_BASE_URL unset nothing is made, and it says why', /not set up/.test(off) && links.available());
  }

  // ── O ───────────────────────────────────────────────────────────────────────────────────
  console.log('\nO. OPENING THROUGH THE RUNNING SERVER');
  {
    const code = first[0].code;
    const r = await httpGet(`${SERVER}/l/${code}`, { 'user-agent': BROWSER });
    check('a person is sent on with a 302', r.status === 302, `${r.status}`);
    check('to the product, carrying ?sz=<code>', r.headers.location === `${target}?sz=${code}`, r.headers.location);
    check('never cached, not indexed', /no-store/.test(String(r.headers['cache-control'])) && /noindex/.test(String(r.headers['x-robots-tag'])), r.headers);
    check('no cookie set, no app CORS on it', !r.headers['set-cookie'] && !r.headers['access-control-allow-credentials']);
    await sleep(300);
    let l = await row(code);
    check('counted as one tap, first and last time set', l.tapCount === 1 && l.botOpenCount === 0 && !!l.firstTapAt && !!l.lastTapAt, l);

    const p = await httpGet(`${SERVER}/l/${code}`, { 'user-agent': WHATSAPP });
    const h = await httpGet(`${SERVER}/l/${code}`, { 'user-agent': BROWSER }, 'HEAD');
    const n = await httpGet(`${SERVER}/l/${code}`, {});
    check('WhatsApp\'s preview robot, a HEAD and no browser string still get the redirect', [p, h, n].every(x => x.status === 302 && x.headers.location === `${target}?sz=${code}`), [p.status, h.status, n.status]);
    await sleep(300);
    l = await row(code);
    check('...but count as robot opens, not taps', l.tapCount === 1 && l.botOpenCount === 3, { tap: l.tapCount, bot: l.botOpenCount });
    const firstTap = l.firstTapAt!.getTime();
    await httpGet(`${SERVER}/l/${code}`, { 'user-agent': BROWSER });
    await sleep(300);
    l = await row(code);
    check('a second tap: count 2, first tap time unchanged, last tap later', l.tapCount === 2 && l.firstTapAt!.getTime() === firstTap && l.lastTapAt!.getTime() > firstTap);
    check('an open is stored as a time and person/robot only', (await prisma.shortLinkTap.count({ where: { linkId: l.id } })) === 5
      && Object.keys((await prisma.shortLinkTap.findFirstOrThrow({ where: { linkId: l.id } }))).sort().join() === 'at,id,linkId,visitor');

    // Expired
    await prisma.shortLink.update({ where: { code: first[1].code }, data: { expiresAt: new Date('2026-09-01T12:00:00Z') } });
    const e = await httpGet(`${SERVER}/l/${first[1].code}`, { 'user-agent': BROWSER });
    check('expired: 410 page saying when, with the shop\'s name made safe', e.status === 410 && /This offer has ended/.test(e.data) && /1 September 2026/.test(e.data) && e.data.includes('Sree &lt;Silks&gt; &amp; Sarees') && !e.data.includes('<Silks>'), `${e.status} ${String(e.data).slice(0, 200)}`);
    // Switched off by the shop
    await prisma.shortLink.update({ where: { code: first[2].code }, data: { status: 'DISABLED_BY_SHOP' } });
    const s = await httpGet(`${SERVER}/l/${first[2].code}`, { 'user-agent': BROWSER });
    check('switched off by the shop: 410 "no longer available", with the shop\'s name', s.status === 410 && /no longer available/.test(s.data) && /Sree/.test(s.data));
    // Switched off by ScaleEzy
    await links.platformDisable(first[3].code, 'verify-admin', 'Reported as a fake payment page');
    const pl = await httpGet(`${SERVER}/l/${first[3].code}`, { 'user-agent': BROWSER });
    check('switched off by ScaleEzy: the same page as an unknown code -- no shop, no reason', pl.status === 404 && /not available/.test(pl.data) && !/Sree|fake|Reported|ScaleEzy switched/.test(pl.data));
    const unknown = await httpGet(`${SERVER}/l/ZZZZZZ9`, { 'user-agent': BROWSER });
    const badShape = await httpGet(`${SERVER}/l/abc`, { 'user-agent': BROWSER });
    const sqlish = await httpGet(`${SERVER}/l/${encodeURIComponent("a' OR 1=1")}`, { 'user-agent': BROWSER });
    check('unknown code, wrong shape, or junk: the same 404 page', [unknown, badShape, sqlish].every(x => x.status === 404 && /not available/.test(x.data)), [unknown.status, badShape.status, sqlish.status]);
    check('pages cannot be framed or scripted (helmet headers present)', /DENY|SAMEORIGIN/i.test(String(unknown.headers['x-frame-options'])) && !!unknown.headers['content-security-policy']);
    await sleep(300);
    const quiet = await Promise.all([first[1], first[2], first[3]].map(x => row(x.code)));
    check('opens of expired or switched-off links are not counted', quiet.every(q => q.tapCount === 0 && q.botOpenCount === 0));
    const post = await httpGet(`${SERVER}/l/${code}`, { 'user-agent': BROWSER }, 'POST');
    check('POST to a link is refused (405)', post.status === 405, post.status);
    const api = await axios.get(`${SERVER}/api/v1/campaigns`, { validateStatus: () => true });
    check('the API itself is untouched (still asks for a login)', api.status === 401, api.status);
  }

  // ── G ───────────────────────────────────────────────────────────────────────────────────
  console.log('\nG. THE go.scaleezy.com HOST');
  {
    const saved = env.LINK_BASE_URL;
    (env as any).LINK_BASE_URL = 'https://go.scaleezy.com';
    const app = await localApp(a => { a.use(linkHostGate); a.use('/l', linkPathRouter); });
    try {
      const go = (path: string, method: 'GET' | 'HEAD' | 'POST' = 'GET', host = 'go.scaleezy.com') => httpGet(`${app.base}${path}`, { host, 'user-agent': BROWSER }, method);
      const code = first[4].code;
      const r = await go(`/${code}`);
      check('go.scaleezy.com/<code> redirects', r.status === 302 && r.headers.location === `${target}?sz=${code}`, r.status);
      const slash = await go(`/${code}/`);
      check('a trailing slash still works', slash.status === 302);
      const apiPath = await go('/api/v1/campaigns');
      const health = await go('/health');
      const lPath = await go(`/l/${code}`);
      check('nothing else of the server on that host: /api, /health, even /l/ are "not available"', [apiPath, health, lPath].every(x => x.status === 404 && /not available/.test(x.data)), [apiPath.status, health.status, lPath.status]);
      const home = await go('/');
      const robotsTxt = await go('/robots.txt');
      check('the bare host says what it is; robots.txt keeps search engines out', home.status === 200 && /short links/.test(home.data) && robotsTxt.status === 200 && /Disallow: \//.test(robotsTxt.data));
      const posted = await go(`/${code}`, 'POST');
      check('POST on the host refused', posted.status === 405);
      const upper = await go(`/${code}`, 'GET', 'GO.ScaleEzy.com');
      check('the host name in any case', upper.status === 302);
      const otherHost = await go('/anything', 'GET', 'api.scaleezy.com');
      check('any other host passes through untouched', otherHost.status === 299, otherHost.status);
      const shortU = links.shortUrl('AbC1234');
      check('short addresses use the host with no path', shortU === 'https://go.scaleezy.com/AbC1234', shortU);

      // The per-visitor limit (this process's own counter). Three opens above already count:
      // /<code>, /<code>/ and the upper-case host. POSTs are refused before the limiter.
      const already = 3;
      const statuses: number[] = [];
      for (let i = 0; i < 61 - already; i++) statuses.push((await go(`/Zz${String(i).padStart(5, '0')}`)).status);
      const limited = await go(`/${code}`);
      check('60 opens a minute from one address, then a "please wait" page (429)',
        statuses.slice(0, 60 - already).every(s => s === 404) && statuses[60 - already] === 429 && limited.status === 429 && /wait a minute/.test(limited.data), statuses.slice(-3));
    } finally {
      (env as any).LINK_BASE_URL = saved;
      await app.close();
    }
  }

  // ── C ───────────────────────────────────────────────────────────────────────────────────
  console.log('\nC. COUNTS');
  {
    // Twenty people tapping the same link at the same moment.
    const busy = first[5];
    const id = (await row(busy.code)).id;
    await Promise.all(Array.from({ length: 20 }, () => links.recordOpen(id, 'HUMAN')));
    const b = await row(busy.code);
    check('twenty taps at once: exactly 20, 20 rows', b.tapCount === 20 && (await prisma.shortLinkTap.count({ where: { linkId: id } })) === 20, b.tapCount);

    const test = await links.makeLinks({ clientId: SHOP, owner: campaign, isTest: true, links: [{ recipientRef: newRecipientRef(), targetType: 'PRODUCT', target }] });
    await links.recordOpen((await row(test[0].code)).id, 'HUMAN');
    const stats = await links.statsFor(SHOP, campaign);
    // first[0]: 2 taps + 3 robots (O); first[4]: 3 taps on go.scaleezy.com (G); first[5]: 20 taps. Test link left out.
    check('campaign numbers: 8 links, 3 customers tapped, 25 taps, 3 robot opens -- test send left out', stats.links === 8 && stats.tapped === 3 && stats.totalTaps === 25 && stats.robotOpens === 3, stats);
    const per = await links.tapsByRecipient(SHOP, campaign, [refs[0], refs[5], refs[6], 'not-a-real-ref']);
    check('per person: who tapped and how often, by token only', per.get(refs[0])?.tapCount === 2 && per.get(refs[5])?.tapCount === 20 && per.get(refs[6])?.tapCount === 0 && !per.has('not-a-real-ref'));
    const other = await links.statsFor(OTHER, campaign);
    check('another shop sees only its own', other.links === 1 && other.totalTaps === 0, other);
  }

  // ── D ───────────────────────────────────────────────────────────────────────────────────
  console.log('\nD. SWITCHING OFF');
  {
    const offCount = await links.disableForOwner(SHOP, campaign, 'owner-1');
    // 8 people's links + the test send's (C) = 9. first[2] was already off by the shop, first[3] by
    // ScaleEzy: 7 change. Expired ones are switched off too (the shop's choice outlives the date).
    check('the shop switches its campaign\'s links off, test send included (7 of 9 were on)', offCount.switchedOff === 7, offCount);
    const onCount = await links.enableForOwner(SHOP, campaign);
    check('...and on again: 8 (its own), never the one ScaleEzy switched off', onCount.switchedOn === 8 && (await row(first[3].code)).status === 'DISABLED_BY_PLATFORM', onCount);
    check('the shop cannot touch another shop\'s links', (await links.disableForOwner(OTHER, { module: 'campaigns', ref: 'nope' }, null)).switchedOff === 0 && (await row(first[0].code)).status === 'ACTIVE');
    check('ScaleEzy must say why', /why/.test(await refusalAsync(links.platformDisable(first[0].code, 'a', '  '))));
    check('ScaleEzy: unknown code refused in words', /No link/.test(await refusalAsync(links.platformDisable('QQQQQQ1', 'a', 'x'))));
    const d = await links.describe(first[3].code);
    check('the console sees the link and the note, never a person', !!d && d.disabledNote === 'Reported as a fake payment page' && !('recipientRef' in (d as object)));
    await links.platformEnable(first[3].code);
    check('ScaleEzy switches it back on', (await row(first[3].code)).status === 'ACTIVE');
    check('switching on one that is not off by ScaleEzy is refused', /No link with that code/.test(await refusalAsync(links.platformEnable(first[3].code))));
  }

  // ── S ───────────────────────────────────────────────────────────────────────────────────
  console.log('\nS. OTHER SCALEEZY SERVICES');
  {
    const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const keyFile = join(tmpdir(), `verify-links-${STAMP}.pem`);
    writeFileSync(keyFile, publicKey.export({ type: 'spki', format: 'pem' }));
    const savedKeys = env.TRUSTED_SERVICES_KEYS;
    (env as any).TRUSTED_SERVICES_KEYS = { 'test-billing': { k1: keyFile }, 'test-marketing': { k1: keyFile } };
    const token = (iss: string, sub: string, scope: string[], clientId?: string) =>
      jwt.sign({ sub, scope, ...(clientId ? { clientId } : {}) }, privateKey.export({ type: 'pkcs8', format: 'pem' }) as string, { algorithm: 'RS256', keyid: 'k1', audience: 'inventory', issuer: iss, expiresIn: '5m' });
    const app = await localApp(a => { a.use(express.json()); a.use('/links-api', linksApiRoutes); });
    const call = (method: 'GET' | 'POST', path: string, tok: string | null, body?: unknown) =>
      axios.request({ url: `${app.base}/links-api${path}`, method, data: body, headers: tok ? { authorization: `Bearer ${tok}` } : {}, validateStatus: () => true });
    try {
      const billing = token('test-billing', 'billing', ['links:write', 'links:read'], SHOP);
      const body = { ref: `inv-${STAMP}`, links: [{ recipientRef: 'r1', targetType: 'EXTERNAL', target: 'https://pay.lakshmisilks.in/inv/42' }, { recipientRef: 'r2', targetType: 'EXTERNAL', target: 'https://pay.lakshmisilks.in/inv/43' }] };
      const made = await call('POST', '/links', billing, body);
      check('a service with links:write makes links for the shop in its token', made.status === 201 && made.data.data.links.length === 2, `${made.status} ${JSON.stringify(made.data).slice(0, 200)}`);
      const stored = await prisma.shortLink.findMany({ where: { clientId: SHOP, ownerRef: `inv-${STAMP}` } });
      check('owned by that service ("svc-billing"), never by a module it names itself', stored.length === 2 && stored.every(x => x.ownerModule === 'svc-billing'));
      const sneaky = await call('POST', '/links', billing, { ...body, owner: { module: 'campaigns' }, clientId: OTHER });
      check('a module or shop sent in the body is ignored', sneaky.status === 201 && (await prisma.shortLink.count({ where: { clientId: OTHER, ownerModule: 'campaigns', ownerRef: `inv-${STAMP}` } })) === 0);
      const again = await call('POST', '/links', billing, body);
      check('the same call again returns the same links', again.status === 201 && again.data.data.links[0].code === made.data.data.links[0].code);
      const stats = await call('GET', `/stats?ref=inv-${STAMP}`, billing);
      check('it can read its counts', stats.status === 200 && stats.data.data.links === 2, stats.data);
      const marketing = token('test-marketing', 'marketing', ['links:write', 'links:read'], SHOP);
      const theirs = await call('GET', `/stats?ref=inv-${STAMP}`, marketing);
      const off = await call('POST', '/disable', marketing, { ref: `inv-${STAMP}` });
      check('another service sees none of them and cannot switch them off', theirs.data.data.links === 0 && off.data.data.switchedOff === 0 && (await prisma.shortLink.count({ where: { ownerModule: 'svc-billing', ownerRef: `inv-${STAMP}`, status: 'ACTIVE' } })) === 2);
      const readOnly = token('test-billing', 'billing', ['links:read'], SHOP);
      const noScope = await call('POST', '/links', readOnly, body);
      check('without links:write: 403 in words', noScope.status === 403 && /links:write/.test(noScope.data.message), noScope.data);
      const noShop = await call('POST', '/links', token('test-billing', 'billing', ['links:write']), body);
      check('a token that names no shop: 403 in words', noShop.status === 403 && /clientId/.test(noShop.data.message), noShop.data);
      const bad = await call('POST', '/links', billing, { ref: `inv-${STAMP}`, links: [{ recipientRef: 'r3', targetType: 'EXTERNAL', target: 'https://bit.ly/abc' }] });
      check('a bad address: 400 with the sentence', bad.status === 400 && /another short link/.test(bad.data.message), bad.data);
      const none = await call('POST', '/links', null, body);
      const forged = await call('POST', '/links', jwt.sign({ sub: 'billing', scope: ['links:write'], clientId: SHOP }, 'not-the-key', { keyid: 'k1', audience: 'inventory', issuer: 'test-billing' }), body);
      const unknownIss = await call('POST', '/links', token('test-nobody', 'x', ['links:write'], SHOP), body);
      check('no token, a forged one, or an unknown service: 401', none.status === 401 && forged.status === 401 && unknownIss.status === 401, [none.status, forged.status, unknownIss.status]);
      const taps = await call('POST', '/taps', billing, { ref: `inv-${STAMP}`, recipientRefs: ['r1', 'r2', 'zz'] });
      check('per-person counts by its own tokens', taps.status === 200 && taps.data.data.recipients.r1.tapCount === 0 && !taps.data.data.recipients.zz);
    } finally {
      (env as any).TRUSTED_SERVICES_KEYS = savedKeys;
      await app.close();
      try { unlinkSync(keyFile); } catch { /* gone */ }
    }
  }

  // ── H ───────────────────────────────────────────────────────────────────────────────────
  console.log('\nH. CLEAN-UP');
  {
    const day = 86_400_000;
    const now = new Date();
    const l = await row(first[6].code);
    await prisma.shortLinkTap.createMany({ data: [
      { linkId: l.id, visitor: 'HUMAN', at: new Date(now.getTime() - 181 * day) },
      { linkId: l.id, visitor: 'BOT', at: new Date(now.getTime() - 200 * day) },
      { linkId: l.id, visitor: 'HUMAN', at: new Date(now.getTime() - 179 * day) }
    ] });
    const oldTest = await links.makeLinks({ clientId: SHOP, owner: { module: 'campaigns', ref: `oldtest-${STAMP}` }, isTest: true, links: [{ recipientRef: newRecipientRef(), targetType: 'SHOP', target: 'https://lakshmisilks.in/' }] });
    const recentTest = await links.makeLinks({ clientId: SHOP, owner: { module: 'campaigns', ref: `newtest-${STAMP}` }, isTest: true, links: [{ recipientRef: newRecipientRef(), targetType: 'SHOP', target: 'https://lakshmisilks.in/' }] });
    await prisma.shortLink.update({ where: { code: oldTest[0].code }, data: { expiresAt: new Date(now.getTime() - 31 * day) } });
    await prisma.shortLink.update({ where: { code: recentTest[0].code }, data: { expiresAt: new Date(now.getTime() - 29 * day) } });
    await prisma.shortLink.update({ where: { code: first[7].code }, data: { expiresAt: new Date(now.getTime() - 400 * day) } });
    const res = await links.purge(now);
    check('opens older than 180 days go; a 179-day one stays', (await prisma.shortLinkTap.count({ where: { linkId: l.id } })) === 1 && res.taps >= 2, res);
    check('a test link 31 days past its end goes; one 29 days past stays', !(await prisma.shortLink.findUnique({ where: { code: oldTest[0].code } })) && !!(await prisma.shortLink.findUnique({ where: { code: recentTest[0].code } })));
    check('a real campaign link stays for the history, even long expired', !!(await prisma.shortLink.findUnique({ where: { code: first[7].code } })));
  }

  // ── X ───────────────────────────────────────────────────────────────────────────────────
  console.log('\nX. DELETING THE SHOP');
  {
    const before = await prisma.shortLink.count({ where: { clientId: SHOP } });
    const tapsBefore = await prisma.shortLinkTap.count({ where: { link: { clientId: SHOP } } });
    await platformAdminService.deleteClientCompletely(SHOP, SHOP);
    const after = await prisma.shortLink.count({ where: { clientId: SHOP } });
    const tapsAfter = await prisma.shortLinkTap.count({ where: { link: { clientId: SHOP } } });
    check(`deleting the shop removes its ${before} links and ${tapsBefore} opens`, before > 0 && tapsBefore > 0 && after === 0 && tapsAfter === 0);
    check('another shop\'s links are untouched', (await prisma.shortLink.count({ where: { clientId: OTHER } })) === 1);
    const gone = await httpGet(`${SERVER}/l/${first[0].code}`, { 'user-agent': BROWSER });
    check('its links no longer open', gone.status === 404);
  }
}

main()
  .catch(e => { failures.push(`suite stopped: ${(e as Error).stack ?? e}`); console.log(`\nSTOPPED: ${(e as Error).message}`); })
  .finally(async () => {
    await platformAdminService.deleteClientCompletely(SHOP, SHOP).catch(() => {});
    await platformAdminService.deleteClientCompletely(OTHER, OTHER).catch(() => {});
    console.log(`\nRESULT: ${passed} passed | ${failures.length} failed`);
    if (failures.length) console.log(failures.map(f => `  - ${f}`).join('\n'));
    await prisma.$disconnect();
    process.exit(failures.length ? 1 : 0);
  });
