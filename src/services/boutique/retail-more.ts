import { prisma } from '../../lib/prisma';
import * as analytics from '../analytics';
import { storefrontConnectionService } from '../storefront-connection.service';
import { shopifyInstallationService } from '../shopify-installation.service';
import * as whatsapp from '../whatsapp/service';
import { problem, storeOf, type Actor } from './index';

/**
 * More retail services through the boutique API (20 Nov 2026, PLAN-boutique-backend.md part 6): sales and stock reports
 * (the dashboard's own figures), the shop's own website key, the Shopify connect link, and the nightly Day Book on
 * WhatsApp -- each the same service as Inventory's screens. Reports need reports:view; the rest settings:write (owner).
 */
const mustReport = (a: Actor) => { if (!a.can.includes('reports:view')) throw problem('This person may not see reports.', 403); };
const mustOwn = (a: Actor) => { if (!a.can.includes('settings:write')) throw problem('Only the owner may do that.', 403); };
const said = async <T>(run: () => Promise<T>): Promise<T> => {
  try { return await run(); } catch (e: any) {
    if (e?.statusCode || e?.status) throw problem(String(e.message), e.statusCode ?? e.status);
    if (/ShopifyInstall|ShopifyConfiguration/.test(e?.constructor?.name ?? '')) throw problem(String(e.message), 400);
    throw e;
  }
};

/* ── reports ──────────────────────────────────────────────────────────────────────────────────── */
/** Sales for a period (period=today|7d|30d|month|..., or from/to days): billed, GST, returns, by day, best sellers. */
export async function sales(a: Actor, q: Record<string, unknown>) {
  mustReport(a);
  if (q.locationId) await storeOf(a.clientId, q.locationId, prisma, true);
  return said(() => analytics.salesPage(a.clientId, q as any));
}
export async function stockValue(a: Actor) { mustReport(a); return said(() => analytics.stockValuePage(a.clientId)); }
export async function stockOnHand(a: Actor, q: Record<string, unknown>) { mustReport(a); return said(() => analytics.stockOnHandPage(a.clientId, q as any)); }
export async function runningLow(a: Actor, q: Record<string, unknown>) {
  mustReport(a);
  if (q.locationId) await storeOf(a.clientId, q.locationId, prisma, true);
  return said(() => analytics.runningLowPage(a.clientId, q as any));
}

/* ── the shop's own website (a site that sells from the same stock) ────────────────────────────── */
const siteView = (c: any) => ({ id: c.id, name: c.name, url: c.baseUrl, status: c.status, storeIds: c.locationIds, keyStartsWith: c.credentialPrefix, createdAt: c.createdAt });
export async function websites(a: Actor) {
  const rows = await prisma.storefrontConnection.findMany({ where: { clientId: a.clientId, baseUrl: { not: { startsWith: 'pos://' } }, status: { not: 'REVOKED' as any } }, orderBy: { createdAt: 'asc' } });
  return rows.map(siteView);
}
/** A key for the shop's own website: the site reads products, offers and prices, and is told of changes at its url. Shown once. */
export async function addWebsite(a: Actor, body: any) {
  mustOwn(a);
  const name = typeof body?.name === 'string' ? body.name.trim().slice(0, 80) : '';
  if (!name) throw problem('Name the website, for example "labelswathyreddy.com".');
  const storeIds = Array.isArray(body?.storeIds) ? body.storeIds.map(String) : [];
  for (const s of storeIds) await storeOf(a.clientId, s);
  const made: any = await said(() => storefrontConnectionService.create(a.clientId, { name, baseUrl: String(body?.url ?? ''), type: 'GENERIC', locationIds: storeIds } as any));
  return { ...siteView(made.connection), key: made.secret };
}
export async function removeWebsite(a: Actor, id: string) {
  mustOwn(a);
  const c = await prisma.storefrontConnection.findFirst({ where: { id, clientId: a.clientId, baseUrl: { not: { startsWith: 'pos://' } } } });
  if (!c) throw problem('That website is not this shop\'s.', 404);
  await said(() => storefrontConnectionService.revoke(a.clientId, id));
  return { id, removed: true };
}

/* ── Shopify ──────────────────────────────────────────────────────────────────────────────────── */
/**
 * The link the owner opens once to approve ScaleEzy in their Shopify admin (Shopify needs its own sign-in screen, so
 * this cannot be done for them). After approving, Shopify returns to a ScaleEzy page; from then on products, stock and
 * orders flow by themselves.
 */
export async function shopifyConnectLink(a: Actor, body: any) {
  mustOwn(a);
  const out: any = await said(() => shopifyInstallationService.beginInstall({ shop: String(body?.shop ?? ''), clientId: a.clientId }));
  return { shopDomain: out.shopDomain, openThisLink: out.authorizeUrl, note: 'Open it on the owner\'s phone or computer, signed in to Shopify, and approve. It works once.' };
}
export async function shopifyStatus(a: Actor) {
  const inst = await prisma.shopifyInstallation.findFirst({ where: { clientId: a.clientId }, select: { shopDomain: true, installedAt: true, uninstalledAt: true }, orderBy: { installedAt: 'desc' } });
  return inst && !inst.uninstalledAt ? { connected: true, shopDomain: inst.shopDomain, since: inst.installedAt } : { connected: false, ...(inst ? { shopDomain: inst.shopDomain, removedAt: inst.uninstalledAt } : {}) };
}

/* ── the nightly Day Book on the owner's WhatsApp ─────────────────────────────────────────────── */
const ownerActor = (a: Actor) => ({ id: `boutique:${a.name}`, clientId: a.clientId, name: `${a.name} (Boutique)`, roles: ['SUPER_ADMIN'], permissions: ['*'] });
export async function dayBookSending(a: Actor) { return said(() => whatsapp.getDayBookSending(ownerActor(a) as any)); }
/** { enabled, time: "22:00", to: "+9198..." } -- the shop's WhatsApp sends the day's Day Book PDF to that number nightly. */
export async function saveDayBookSending(a: Actor, body: any) {
  mustOwn(a);
  return said(() => whatsapp.saveDayBookSettings(ownerActor(a) as any, { enabled: body?.enabled, time: body?.time, to: body?.to }));
}
