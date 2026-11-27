import { prisma } from '../../lib/prisma';
import { brandingService } from '../branding.service';
import { getSetup, saveSetup } from '../shop-setup';
import * as loyalty from '../loyalty/loyalty.service';
import { offerService } from '../offers';
import { getRules as returnRules, saveRules as saveReturnRules } from '../counter-return/counter-return.service';
import { paymentAccounts } from '../payments/account.service';
import { GatewayError } from '../payments/gateway';
import { OnlineShopRuleError } from '../online-shop';
import { problem, type Actor } from './index';
import * as giftVouchers from '../gift-vouchers';

/**
 * The shop's settings through the boutique API (20 Nov 2026, PLAN-boutique-backend.md part 3, #12 #18 #24 #29):
 * the same settings and the same rules as Inventory's Settings screens, each saved by the service that owns it.
 * Reading: anyone of the boutique. Changing: settings:write only (the boutique gives it to its owner).
 * The shop's Razorpay keys can be entered and replaced, NEVER read back: the view says only whether they are set.
 */
const mustOwn = (a: Actor) => { if (!a.can.includes('settings:write')) throw problem('Only the owner may change the shop\'s settings.', 403); };
const who = (a: Actor) => `boutique:${a.name}`;

/** Errors the reused services raise without an HTTP status, as plain 400s with their sentence. */
async function said<T>(run: () => Promise<T>): Promise<T> {
  try { return await run(); } catch (e: any) {
    if (e instanceof OnlineShopRuleError || e instanceof GatewayError) throw problem(e.message, 400);
    if (e && typeof e === 'object' && e.statusCode && !(e instanceof Error)) throw problem(String(e.message), e.statusCode);
    // An HttpError (gift vouchers' rules): its own sentence and status, never a 500.
    if (e instanceof Error && typeof (e as any).statusCode === 'number' && (e as any).statusCode < 500) throw problem(e.message, (e as any).statusCode);
    throw e;
  }
}

export async function read(a: Actor, apiBase: string) {
  const [shop, setup, points, offers, returns, payments] = await Promise.all([
    brandingService.get(a.clientId), getSetup(a.clientId), loyalty.settingsForScreen(a.clientId),
    offerService.getSettings(a.clientId), returnRules(a.clientId), paymentAccounts.describe(a.clientId, apiBase)
  ]);
  const s = await prisma.clientSettings.findUnique({ where: { clientId: a.clientId }, select: { gstRegistration: true, gstNumber: true, gstStateCode: true } });
  return {
    shop,
    gst: { registration: s?.gstRegistration ?? 'UNREGISTERED', gstNumber: s?.gstNumber ?? null, stateCode: s?.gstStateCode ?? null },
    whatYouSell: setup,
    points, offers, returns,
    vouchers: await vouchersView(a.clientId),
    // Whether the shop takes online payments, and how far it is set up. Never the keys; the webhook address
    // (where Razorpay reports payments) only to the owner, like Inventory's own Payments screen.
    payments: a.can.includes('settings:write') ? payments : { connected: payments.connected, readyForCustomers: payments.readyForCustomers, upiQrEnabled: payments.upiQrEnabled }
  };
}

const SHOP_FIELDS = ['businessName', 'businessAddress', 'businessPhone', 'businessEmail', 'gstNumber', 'gstRegistration', 'gstStateCode', 'receiptFooter'];

/** Name, address, phone, email, GSTIN (and registration) -- what the bills print. */
export async function saveShop(a: Actor, body: any) {
  mustOwn(a);
  // A field name we do not know would be dropped without a word (the save looks fine and nothing changes): refused.
  const unknown = Object.keys(body ?? {}).filter(k => !SHOP_FIELDS.includes(k));
  if (unknown.length) throw problem(`Not a shop detail: ${unknown.join(', ')}. Send any of ${SHOP_FIELDS.join(', ')}.`);
  const { businessName, ...details } = body ?? {};
  if (businessName !== undefined) await said(() => brandingService.setName(a.clientId, businessName));
  if (Object.keys(details).length) await said(() => brandingService.setDetails(a.clientId, details));
  return brandingService.get(a.clientId);
}

/**
 * The smallest cut of cloth. What the shop sells (ready-made, fabrics or both) is set by ScaleEzy (27 Nov 2026): sending
 * the same value again is harmless, a different one is refused (403) in words, as on Inventory's own screens.
 */
export async function saveSells(a: Actor, body: any) {
  mustOwn(a);
  if (body?.sells === undefined && body?.fabricMinCut === undefined) throw problem('Send fabricMinCut (cm). What the shop sells is set by ScaleEzy.');
  await said(() => saveSetup(a.clientId, { ...(body?.sells !== undefined ? { sells: body.sells } : {}), ...(body?.fabricMinCut !== undefined ? { fabricMinCut: body.fabricMinCut } : {}) }));
  return getSetup(a.clientId);
}

/** Points: earning, spending, expiry, where they are earned. The same rules as Settings -> Loyalty. */
export async function savePoints(a: Actor, body: any) {
  mustOwn(a);
  await said(() => loyalty.saveSettings({ id: who(a), clientId: a.clientId, name: a.name, permissions: ['loyalty:manage'] }, body ?? {}));
  return loyalty.settingsForScreen(a.clientId);
}

/** The most a cashier may take off by hand, in percent. */
export async function saveOffers(a: Actor, body: any) {
  mustOwn(a);
  // The body as sent: a limit LEFT OUT is refused there, never read as "no limit" (an empty value clears it).
  await said(() => offerService.setSettings(a.clientId, body ?? {}));
  return offerService.getSettings(a.clientId);
}

/** How many days a bill may be returned in, and the most a cashier may refund without the manager. */
export async function saveReturns(a: Actor, body: any) {
  mustOwn(a);
  await said(() => saveReturnRules({ id: who(a), clientId: a.clientId, name: a.name, permissions: ['return:complete'] }, body ?? {}));
  return returnRules(a.clientId);
}

/**
 * The shop's own Razorpay keys: checked with Razorpay, then kept encrypted. The answer says whether they work and
 * gives the webhook address and secret to paste into Razorpay -- the secret once, now. The keys are never shown again.
 */
export async function savePayments(a: Actor, body: any, apiBase: string) {
  mustOwn(a);
  return said(() => paymentAccounts.save(a.clientId, null, { keyId: body?.keyId, keySecret: body?.keySecret }, apiBase));
}
export async function checkPayments(a: Actor, apiBase: string) {
  return said(() => paymentAccounts.check(a.clientId, apiBase));
}
export async function removePayments(a: Actor, apiBase: string) {
  mustOwn(a);
  return said(() => paymentAccounts.remove(a.clientId, apiBase));
}

/* ── Gift vouchers and the logo (25 Nov 2026, asked by POS: a boutique-run shop has no Inventory login, so these
 *    were set nowhere) ─────────────────────────────────────────────────────────────────────────────────────── */

const rupees = (paise: number) => Math.round(paise) / 100;
/** Settings -> Gift vouchers, in rupees, and what the shop owes in unspent vouchers now. */
export async function vouchersView(clientId: string) {
  const [s, sum] = await Promise.all([giftVouchers.getSettings(clientId), giftVouchers.summary(clientId)]);
  return {
    enabled: s.enabled, validMonths: s.validMonths, minAmount: rupees(s.minPaise), maxAmount: rupees(s.maxPaise),
    owed: rupees(sum.owedPaise), openVouchers: sum.openVouchers, expiringIn30Days: sum.expiringIn30Days
  };
}

const VOUCHER_FIELDS = ['enabled', 'validMonths', 'minAmount', 'maxAmount'];
const paise = (v: unknown, what: string) => {
  const n = Number(v);
  if (v === null || v === '' || typeof v === 'boolean' || !Number.isFinite(n) || Math.round(n * 100) !== n * 100) throw problem(`${what} is an amount in rupees, to 2 decimals.`);
  return Math.round(n * 100);
};
/** Vouchers on or off, how long they last, the smallest and largest. The same rules as Settings -> Gift vouchers. */
export async function saveVouchers(a: Actor, body: any) {
  mustOwn(a);
  const unknown = Object.keys(body ?? {}).filter(k => !VOUCHER_FIELDS.includes(k));
  if (unknown.length) throw problem(`Not a voucher setting: ${unknown.join(', ')}. Send any of ${VOUCHER_FIELDS.join(', ')}.`);
  if (body?.enabled !== undefined && typeof body.enabled !== 'boolean') throw problem('"enabled" is true or false.');
  await said(() => giftVouchers.saveSettings(a.clientId, {
    ...(body?.enabled !== undefined ? { enabled: body.enabled } : {}),
    ...(body?.validMonths !== undefined ? { validMonths: body.validMonths } : {}),
    ...(body?.minAmount !== undefined ? { minPaise: paise(body.minAmount, 'The smallest voucher') } : {}),
    ...(body?.maxAmount !== undefined ? { maxPaise: paise(body.maxAmount, 'The largest voucher') } : {})
  }, null));
  return vouchersView(a.clientId);
}

const LOGO_TYPES = /\.(png|jpe?g|webp)$/i;
/** Step 1 of a new logo: where to upload the picture (PNG, JPEG or WebP), the same storage as Inventory's. */
export async function logoUploadUrl(a: Actor, body: any) {
  mustOwn(a);
  const fileName = String(body?.fileName ?? '').trim();
  if (!LOGO_TYPES.test(fileName)) throw problem('Send the file name of the picture, ending .png, .jpg, .jpeg or .webp.');
  const up = await said(() => brandingService.createLogoUploadUrl(a.clientId, fileName));
  return { uploadUrl: up.signedUrl, storagePath: up.storagePath, publicUrl: up.publicUrl };
}
/** Step 2: the uploaded picture becomes the shop's logo (bills, POS, the shop); the old one is removed. */
export async function saveLogo(a: Actor, body: any) {
  mustOwn(a);
  const path = String(body?.storagePath ?? '');
  if (!path) throw problem('Send the storagePath from the upload step.');
  return said(() => brandingService.setLogo(a.clientId, path));
}
export async function removeLogo(a: Actor) {
  mustOwn(a);
  return said(() => brandingService.removeLogo(a.clientId));
}
