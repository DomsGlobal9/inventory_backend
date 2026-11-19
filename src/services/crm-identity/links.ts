import { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { backoffMs } from '../../utils/retryBackoff';
import { crm, crmConfigured, CrmRefused, CrmUnavailable } from './client';
import { applyChanged } from './events';

/**
 * The link job: every live customer of a shop with CRM on gets CRM's id for them, asked through CRM's API.
 *
 * Every place that adds a customer (staff, the till, the online shop, Shopify, imports, the boutique) still
 * saves in Inventory first, exactly as before, so nothing ever waits for CRM. This job links them afterwards:
 *   - with a phone: CRM's find-or-add, sending Inventory's own id as externalId (safe to repeat: CRM never
 *     makes a second person for the same number or the same id);
 *   - without a phone (a Shopify guest, a boutique person): CRM's "who is Inventory's customer X", which CRM
 *     knows from Inventory's change feed. Not known yet: tried again tomorrow.
 * CRM away: that shop waits and is tried again later, with a growing gap. One shop's trouble never stops another.
 *
 * The link lives in crm_customer_links, never on the customer row (a write there tells CRM "changed").
 */
const BATCH = 200;
const PARALLEL = 4;
const LEASE_MS = 2 * 60_000;
const DAY_MS = 86_400_000;

/** Shops whose customers CRM owns: CRM switched on for them (by the ScaleEzy admin). */
export async function crmShops(only?: string[]): Promise<string[]> {
  const rows = await prisma.moduleSubscription.findMany({
    where: { module: 'crm', ...(only ? { clientId: { in: only } } : {}) },
    select: { clientId: true }
  });
  return rows.map(r => r.clientId);
}

/** A link row for every live customer of these shops that has none yet. One statement, no customer row touched. */
export async function addMissingLinks(clientIds: string[]) {
  if (!clientIds.length) return 0;
  return prisma.$executeRaw`
    INSERT INTO crm_customer_links (customer_id, client_id, next_try_at, updated_at)
    SELECT c.id, c.client_id, NOW(), NOW() FROM customers c
     WHERE c.client_id IN (${Prisma.join(clientIds)}) AND c.deleted_at IS NULL
       AND NOT EXISTS (SELECT 1 FROM crm_customer_links l WHERE l.customer_id = c.id)
    ON CONFLICT (customer_id) DO NOTHING`;
}

type Claimed = { customer_id: string; client_id: string; attempts: number };

/** Takes due, unlinked rows for one shop, leased so two passes never take the same one. */
function claim(clientId: string, limit: number) {
  return prisma.$queryRaw<Claimed[]>`
    UPDATE crm_customer_links SET next_try_at = ${new Date(Date.now() + LEASE_MS)}, updated_at = NOW()
     WHERE customer_id IN (
       SELECT customer_id FROM crm_customer_links
        WHERE client_id = ${clientId} AND crm_customer_id IS NULL AND next_try_at <= NOW()
        ORDER BY next_try_at, customer_id
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED)
    RETURNING customer_id, client_id, attempts`;
}

// Upserts, not updates: a customer staff added a moment ago has no link row yet (the job makes rows on its pass),
// and an update of a missing row failed quietly -- the customer then stayed unlinked until the next pass.
async function linked(clientId: string, customerId: string, crmCustomerId: string) {
  const data = { crmCustomerId, linkedAt: new Date(), lastError: null, nextTryAt: new Date() };
  await prisma.crmCustomerLink.upsert({ where: { customerId }, create: { customerId, clientId, ...data }, update: data });
}

async function later(clientId: string, customerId: string, attempts: number, why: string, waitMs?: number) {
  const data = { attempts, lastError: why.slice(0, 500), nextTryAt: new Date(Date.now() + (waitMs ?? backoffMs(attempts))) };
  await prisma.crmCustomerLink.upsert({ where: { customerId }, create: { customerId, clientId, ...data }, update: data })
    .catch(() => undefined); // the customer may have been removed meanwhile (the link goes with it)
}

/** What to tell CRM about this customer: only what Inventory has, never an empty value over CRM's. */
function personOf(c: { id: string; name: string; phone: string | null; email: string | null; birthday: string | null; anniversary: string | null }) {
  const body: Record<string, unknown> = { phone: c.phone, externalId: c.id };
  if (c.name && c.name !== 'Removed customer') body.name = c.name;
  if (c.email) body.email = c.email;
  if (c.birthday) body.birthday = c.birthday;
  if (c.anniversary) body.anniversary = c.anniversary;
  return body;
}

export type LinkOutcome = 'linked' | 'not-known-yet' | 'refused' | 'crm-away' | 'gone';

/** Link one customer now. Used by the job, and straight after staff add someone. */
export async function linkOne(clientId: string, customerId: string, attempts = 0, timeoutMs = 10_000): Promise<LinkOutcome> {
  const c = await prisma.customer.findFirst({
    where: { id: customerId, clientId, deletedAt: null },
    select: { id: true, name: true, phone: true, email: true, birthday: true, anniversary: true }
  });
  if (!c) {
    await prisma.crmCustomerLink.deleteMany({ where: { customerId } });
    return 'gone';
  }
  const tries = attempts + 1;
  try {
    if (c.phone) {
      let r;
      try { r = await crm.findOrAdd(clientId, personOf(c), { timeoutMs }); }
      catch (e) {
        // CRM refused something it has a rule about (an email it finds odd, a date): the phone and our id are
        // enough to link; the rest stays as it is on both sides.
        if (!(e instanceof CrmRefused) || e.status === 409) throw e;
        r = await crm.findOrAdd(clientId, { phone: c.phone, externalId: c.id }, { timeoutMs });
      }
      await linked(clientId, c.id, r.customer.id);
      // CRM owns who they are: what it already knew for this number (a name, a birthday) comes back here.
      await applyChanged(clientId, r.customer).catch(err => console.error('[crm-identity] could not take the details CRM has for', c.id, err?.message));
      return 'linked';
    }
    try {
      const r = await crm.fromInventory(clientId, c.id, { timeoutMs });
      await linked(clientId, c.id, r.id);
      return 'linked';
    } catch (e) {
      if (e instanceof CrmRefused && e.status === 404) {
        await later(clientId, c.id, tries, 'No phone, and CRM does not know them yet (it will from the change feed).', DAY_MS);
        return 'not-known-yet';
      }
      throw e;
    }
  } catch (e) {
    if (e instanceof CrmUnavailable) { await later(clientId, c.id, tries, e.why); return 'crm-away'; }
    if (e instanceof CrmRefused) { await later(clientId, c.id, tries, `${e.status}: ${e.message}`, 7 * DAY_MS); return 'refused'; }
    await later(clientId, c.id, tries, String((e as Error)?.message ?? e));
    return 'crm-away';
  }
}

export type PassResult = { shops: number; linked: number; waiting: number; refused: number; owned: string[] };

/** Shops CRM already said it owns (this server, since it started): not asked again. */
const ownedShops = new Set<string>();

/**
 * Once every live customer WITH a number is linked, Inventory tells CRM so (CRM's API, no switch): from then on
 * CRM owns the shop's customers and Inventory's feed only fills blanks there. Customers without a number never
 * hold this up -- CRM learns them from the feed. Safe to repeat; a refusal or CRM away is simply tried next pass.
 */
async function tellCrmIfLinked(clientId: string): Promise<boolean> {
  if (ownedShops.has(clientId)) return false;
  const left = await prisma.$queryRaw<{ n: number }[]>`
    SELECT COUNT(*)::int AS n FROM customers c
      LEFT JOIN crm_customer_links l ON l.customer_id = c.id
     WHERE c.client_id = ${clientId} AND c.deleted_at IS NULL AND c.phone IS NOT NULL AND l.crm_customer_id IS NULL`;
  if ((left[0]?.n ?? 1) > 0) return false;
  try {
    const r = await crm.takeOwnership(clientId);
    if (r?.ownedAt) { ownedShops.add(clientId); return true; }
  } catch (e) {
    if (!(e instanceof CrmUnavailable) && !(e instanceof CrmRefused)) console.error('[crm-identity] telling CRM about', clientId, 'failed:', (e as Error)?.message);
  }
  return false;
}
export const forgetOwnedShops = () => ownedShops.clear();

/** One pass over every CRM shop (or the ones a test names). Never throws. */
export async function runLinkPass(opts: { onlyClients?: string[] } = {}): Promise<PassResult> {
  const out: PassResult = { shops: 0, linked: 0, waiting: 0, refused: 0, owned: [] };
  if (!crmConfigured()) return out;
  try {
    const shops = await crmShops(opts.onlyClients);
    out.shops = shops.length;
    await addMissingLinks(shops);
    for (const clientId of shops) {
      const rows = await claim(clientId, BATCH);
      for (let i = 0; i < rows.length; i += PARALLEL) {
        const results = await Promise.all(rows.slice(i, i + PARALLEL).map(r => linkOne(clientId, r.customer_id, r.attempts)));
        for (const r of results) {
          if (r === 'linked') out.linked++;
          else if (r === 'refused') out.refused++;
          else if (r !== 'gone') out.waiting++;
        }
        // CRM is away for this shop: put the rest back for later instead of knocking on a closed door 200 times.
        if (results.includes('crm-away')) {
          const left = rows.slice(i + PARALLEL).map(r => r.customer_id);
          if (left.length) await prisma.crmCustomerLink.updateMany({ where: { customerId: { in: left } }, data: { nextTryAt: new Date(Date.now() + 60_000) } });
          break;
        }
      }
      if (await tellCrmIfLinked(clientId)) out.owned.push(clientId);
    }
  } catch (e) {
    console.error('[crm-identity] link pass failed; will try again.', e);
  }
  return out;
}

/** CRM's id for one of Inventory's customers, if linked. */
export async function crmIdOf(customerId: string) {
  return (await prisma.crmCustomerLink.findUnique({ where: { customerId }, select: { crmCustomerId: true } }))?.crmCustomerId ?? null;
}

export class CrmLinkWorker {
  private static timer: NodeJS.Timeout | null = null;
  private static running = false;
  static start(intervalMs = 30_000) {
    if (this.timer) return;
    const tick = async () => {
      if (this.running) return;
      this.running = true;
      try { await runLinkPass(); } finally { this.running = false; }
    };
    this.timer = setInterval(() => { void tick(); }, intervalMs);
    this.timer.unref?.();
    void tick();
    console.log(crmConfigured() ? '[crm-identity] Linking customers to ScaleEzy CRM.' : '[crm-identity] Not set up (CRM_SERVICE_URL / INVENTORY_KEY_ID / key); waiting.');
  }
  static stop() { if (this.timer) { clearInterval(this.timer); this.timer = null; } }
}
