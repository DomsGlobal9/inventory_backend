/**
 * A boutique-only client asks to join ScaleEzy Inventory (16 Nov).
 *
 * A client the boutique team runs on its own (CRM-B only: a boutique-only shop here, no logins) decides to use the
 * whole of ScaleEzy Inventory -- the online shop, the till, reports. CRM-B's super-admin console sends the request;
 * our Platform Console shows it as a waiting card; ScaleEzy accepts or declines.
 *
 * Accepting runs the SAME onboarding as the Console's Onboarding screen, with the boutique account: the client is made,
 * its owner gets a login, and the boutique-only shop's items, stock, holds and history move into it (enableForClient
 * -> absorb). The boutique app changes nothing: its next call with the same account lands in the new shop.
 *
 *  - One open request per boutique account (a unique index): asking twice updates the one card.
 *  - An account already on a ScaleEzy client is refused: there is nothing to join.
 *  - Accepting claims the card first (WAITING -> ACCEPTING), so two admins, or a double-click, onboard once. A failed
 *    onboarding puts it back to WAITING with what went wrong, for the admin to fix and try again.
 *  - Declining needs a reason, and the boutique app can show it.
 */
import { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { accountState } from './index';
import { normalisePhone } from '../../lib/phone';

export class JoinError extends Error {
  constructor(public statusCode: number, message: string) { super(message); }
}
const fail = (status: number, message: string): never => { throw new JoinError(status, message); };
const text = (v: unknown, max: number) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '');
const TENANT = /^[a-z0-9][a-z0-9_-]{1,62}$/;
const OPEN = ['WAITING', 'ACCEPTING'];

function checkTenant(raw: unknown) {
  const t = String(raw ?? '').trim().toLowerCase();
  if (!TENANT.test(t)) fail(400, 'The boutique account (tenant) is letters, numbers and dashes.');
  return t;
}

/** What the boutique sends about the client. The same checks the Console's onboarding form makes. */
function readForm(b: any) {
  const shopName = text(b?.shopName, 120), ownerName = text(b?.ownerName, 120), ownerEmail = text(b?.ownerEmail, 160).toLowerCase();
  if (!shopName) fail(400, 'Give the shop\'s name (shopName).');
  if (!ownerName) fail(400, 'Give the owner\'s name (ownerName).');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(ownerEmail)) fail(400, 'Give the owner\'s email address (ownerEmail), like owner@shop.in. Their ScaleEzy login is sent there.');
  const mobile = normalisePhone(b?.ownerPhone);
  if (!mobile.ok) fail(400, `Owner's mobile (ownerPhone): ${mobile.reason.replace("the customer's", "the owner's")}`);
  return {
    shopName, ownerName, ownerEmail, ownerPhone: (mobile as any).value as string,
    city: text(b?.city, 60) || null, note: text(b?.note, 500) || null
  };
}

/** What the boutique app is told about its request. Never another shop's anything. */
const forBoutique = (r: { status: string; reason: string | null; createdAt: Date; decidedAt: Date | null; shopName: string }) => ({
  status: r.status === 'ACCEPTING' ? 'WAITING' : r.status,
  shopName: r.shopName,
  askedAt: r.createdAt,
  decidedAt: r.decidedAt,
  ...(r.status === 'DECLINED' ? { reason: r.reason } : {})
});

// ── From the boutique app (its signed pass names the account) ──────────────────────────────

export async function ask(tenantIn: unknown, requestedBy: string | null, body: unknown) {
  const tenant = checkTenant(tenantIn);
  const form = readForm(body);
  const state = await accountState(tenant);
  if (state.state === 'taken') fail(409, 'This boutique account is already on ScaleEzy Inventory. There is nothing to ask for.');
  for (let attempt = 0; attempt < 3; attempt++) {
    const open = await prisma.boutiqueJoinRequest.findFirst({ where: { tenant, status: { in: OPEN } } });
    if (open?.status === 'ACCEPTING') fail(409, 'ScaleEzy is setting this client up right now. Ask again in a minute if it is not done.');
    if (open) {
      // Asking again while waiting updates the one card (a corrected email, a new note).
      // A city or note left out keeps the one already sent; everything given replaces it.
      const r = await prisma.boutiqueJoinRequest.update({ where: { id: open.id }, data: { ...form, city: form.city ?? undefined, note: form.note ?? undefined, requestedBy, reason: null } });
      return { ...forBoutique(r), already: true };
    }
    try {
      const r = await prisma.boutiqueJoinRequest.create({ data: { tenant, ...form, requestedBy } });
      return { ...forBoutique(r), already: false };
    } catch (e) {
      // Two asks at the same moment: the other one made the card; read it on the next turn.
      if (!(e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002')) throw e;
    }
  }
  return fail(503, 'The request could not be saved just now. Please try again.');
}

/** The latest request's answer, for the boutique app to show. */
export async function statusFor(tenantIn: unknown) {
  const tenant = checkTenant(tenantIn);
  const r = await prisma.boutiqueJoinRequest.findFirst({ where: { tenant }, orderBy: { createdAt: 'desc' } });
  if (!r) return { status: 'NONE' as const };
  return forBoutique(r);
}

/** The boutique withdraws a request still waiting. */
export async function cancel(tenantIn: unknown) {
  const tenant = checkTenant(tenantIn);
  const n = await prisma.boutiqueJoinRequest.updateMany({ where: { tenant, status: 'WAITING' }, data: { status: 'CANCELLED', decidedAt: new Date() } });
  if (n.count === 1) return { status: 'CANCELLED' as const };
  const open = await prisma.boutiqueJoinRequest.findFirst({ where: { tenant, status: 'ACCEPTING' } });
  if (open) fail(409, 'ScaleEzy is setting this client up right now, so it can no longer be withdrawn.');
  return fail(404, 'No request is waiting for this boutique account.');
}

// ── For the Platform Console ───────────────────────────────────────────────────────────────

/** What the boutique-only shop holds today: how much will move in when the request is accepted. */
async function holdings(tenant: string) {
  const s = await accountState(tenant);
  if (s.state !== 'boutique-only') return { state: s.state, items: 0, pieces: 0, metres: 0 };
  const rows = await prisma.$queryRaw<{ items: bigint; pieces: bigint | null; cm: bigint | null }[]>`
    SELECT COUNT(DISTINCT v.id) AS items,
           SUM(CASE WHEN p.sold_by = 'METRE' THEN 0 ELSE st.quantity END) AS pieces,
           SUM(CASE WHEN p.sold_by = 'METRE' THEN st.quantity ELSE 0 END) AS cm
      FROM inventory_product_variants v
      JOIN inventory_products p ON p.id = v.product_id
      LEFT JOIN inventory_stocks st ON st.variant_id = v.id
     WHERE v.client_id = ${s.clientId}`;
  const r = rows[0];
  return { state: s.state, items: Number(r?.items ?? 0), pieces: Number(r?.pieces ?? 0), metres: Number(r?.cm ?? 0) / 100 };
}

export async function listForConsole(which: unknown) {
  const all = which === 'ALL';
  const rows = await prisma.boutiqueJoinRequest.findMany({
    where: all ? {} : { status: { in: OPEN } },
    orderBy: { createdAt: all ? 'desc' : 'asc' },
    take: all ? 100 : 50
  });
  return Promise.all(rows.map(async r => {
    const open = OPEN.includes(r.status);
    const [held, emailUser] = open
      ? await Promise.all([holdings(r.tenant), prisma.user.findFirst({ where: { email: { equals: r.ownerEmail, mode: 'insensitive' } }, select: { id: true } })])
      : [null, null];
    return {
      id: r.id, tenant: r.tenant, shopName: r.shopName, ownerName: r.ownerName, ownerEmail: r.ownerEmail, ownerPhone: r.ownerPhone,
      city: r.city, note: r.note, requestedBy: r.requestedBy, status: r.status, reason: r.reason, clientId: r.clientId,
      createdAt: r.createdAt, decidedAt: r.decidedAt,
      ...(open ? {
        holdings: held,
        // Said on the card before anyone presses Accept, so nobody is surprised by a refusal.
        problems: [
          ...(held?.state === 'taken' ? ['This boutique account is already on another ScaleEzy client.'] : []),
          ...(emailUser ? ['The owner\'s email already signs in to a ScaleEzy shop. Change it before accepting.'] : [])
        ]
      } : {})
    };
  }));
}

/** How many are waiting: the badge on the Console's Clients menu. */
export const waitingCount = () => prisma.boutiqueJoinRequest.count({ where: { status: 'WAITING' } });

/**
 * Accept: onboard the client with this boutique account. The admin may correct the shop's name, the owner's name,
 * email and mobile, and what the shop sells, before it is made. `onboard` is the Console's own onboarding.
 */
export async function accept(id: string, adminId: string, overrides: any, onboard: (form: any) => Promise<any>, readOnboardingForm: (b: any) => any) {
  const r = await prisma.boutiqueJoinRequest.findUnique({ where: { id: String(id) } });
  if (!r) fail(404, 'That request is no longer here.');
  const form = readOnboardingForm({
    companyName: overrides?.shopName ?? r!.shopName,
    adminName: overrides?.ownerName ?? r!.ownerName,
    adminEmail: overrides?.ownerEmail ?? r!.ownerEmail,
    ownerPhone: overrides?.ownerPhone ?? r!.ownerPhone,
    city: overrides?.city ?? r!.city ?? undefined,
    // A boutique sells its fabric; most also sell ready pieces. The owner can change this in Settings.
    sells: overrides?.sells ?? 'BOTH',
    boutiqueTenant: r!.tenant
  });
  if ('problem' in form) fail(400, form.problem);

  // Claim it: only one accept ever runs for a card.
  const claimed = await prisma.boutiqueJoinRequest.updateMany({ where: { id: r!.id, status: 'WAITING' }, data: { status: 'ACCEPTING', reason: null } });
  if (claimed.count !== 1) {
    const now = await prisma.boutiqueJoinRequest.findUnique({ where: { id: r!.id } });
    if (now?.status === 'ACCEPTED') fail(409, 'This request was already accepted.');
    if (now?.status === 'ACCEPTING') fail(409, 'Someone is accepting this request right now.');
    if (now?.status === 'CANCELLED') fail(409, 'The boutique withdrew this request.');
    fail(409, 'This request was already declined.');
  }
  const putBack = (reason: string) => prisma.boutiqueJoinRequest.update({ where: { id: r!.id }, data: { status: 'WAITING', reason } });
  try {
    const state = await accountState(r!.tenant);
    if (state.state === 'taken') fail(409, 'This boutique account is already on another ScaleEzy client.');
    const inUse = await prisma.user.findFirst({ where: { email: { equals: form.adminEmail, mode: 'insensitive' } }, select: { id: true } });
    if (inUse) fail(409, 'The owner\'s email already signs in to a ScaleEzy shop. Use another email for this owner.');
    const made = await onboard(form);
    await prisma.boutiqueJoinRequest.update({
      where: { id: r!.id },
      data: { status: 'ACCEPTED', clientId: made.clientId, decidedById: adminId, decidedAt: new Date(), reason: null,
        shopName: form.companyName, ownerName: form.adminName, ownerEmail: form.adminEmail, ownerPhone: form.ownerPhone }
    });
    return made;
  } catch (e: any) {
    await putBack(e instanceof JoinError || e?.statusCode ? e.message : 'The client could not be set up. Nothing was changed; try again.').catch(() => undefined);
    throw e;
  }
}

export async function decline(id: string, adminId: string, reasonIn: unknown) {
  const reason = text(reasonIn, 300);
  if (reason.length < 3) fail(400, 'Say why, in a few words. The boutique is shown this.');
  const n = await prisma.boutiqueJoinRequest.updateMany({
    where: { id: String(id), status: 'WAITING' },
    data: { status: 'DECLINED', reason, decidedById: adminId, decidedAt: new Date() }
  });
  if (n.count === 1) return { status: 'DECLINED' as const };
  const now = await prisma.boutiqueJoinRequest.findUnique({ where: { id: String(id) } });
  if (!now) fail(404, 'That request is no longer here.');
  return fail(409, now!.status === 'ACCEPTING' ? 'Someone is accepting this request right now.' : `This request was already ${now!.status.toLowerCase()}.`);
}
