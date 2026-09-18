import { createHash } from 'node:crypto';
import type { Account, AccountStatus } from '@prisma/client';
import type { Ctx } from '../context';
import { EngineError, type LinkInfo } from '../engine/client';
import { enqueueForAllModules } from '../events/module-events';
import { Errors } from '../lib/errors';
import { maskPhone } from '../lib/phone';
import { isDrop } from '../domain/status';

/** The ScaleEzy number is adopted from config: its instance was linked once and must be kept. */
export async function ensureScaleezyAccount(ctx: Ctx): Promise<Account> {
  const instanceName = ctx.config.SCALEEZY_INSTANCE;
  const existing = await ctx.db.account.findFirst({ where: { kind: 'SCALEEZY' } });
  if (existing) {
    if (existing.instanceName !== instanceName) {
      // Config moved the ScaleEzy number to another instance (e.g. after a planned re-link).
      return ctx.db.account.update({ where: { id: existing.id }, data: { instanceName } });
    }
    return existing;
  }
  return ctx.db.account.create({
    data: { kind: 'SCALEEZY', instanceName, displayName: 'ScaleEzy', status: 'NOT_LINKED' },
  });
}

export async function getScaleezyAccount(ctx: Ctx): Promise<Account | null> {
  return ctx.db.account.findFirst({ where: { kind: 'SCALEEZY' } });
}

/** Engine instance name for a client. Stable, safe characters only, never the ScaleEzy one. */
export function instanceNameForClient(clientId: string): string {
  const safe = clientId.replace(/[^A-Za-z0-9_-]/g, '');
  if (safe && safe === clientId && safe.length <= 48) return `client_${safe}`;
  return `client_h${createHash('sha256').update(clientId).digest('hex').slice(0, 40)}`;
}

export function publicAccountView(a: Account) {
  return {
    status: a.status,
    phone: maskPhone(a.phone),
    linkedAt: a.linkedAt,
    lastSeenAt: a.lastSeenAt,
  };
}

/**
 * Records a status change and tells modules. Returns true when the status actually changed.
 * The account row is re-read inside the transaction so two watchers cannot both fire an alert.
 */
export async function setAccountStatus(
  ctx: Ctx,
  accountId: string,
  to: AccountStatus,
  source: string,
  extra: { phone?: string | null; displayName?: string | null } = {},
): Promise<boolean> {
  return ctx.db.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<Array<{ status: AccountStatus }>>`
      SELECT status FROM "Account" WHERE id = ${accountId} FOR UPDATE`;
    const current = rows[0]?.status;
    if (!current) return false;
    const now = new Date();
    const data: Record<string, unknown> = { lastSeenAt: now };
    if (to === 'CONNECTED') {
      if (extra.phone) data.phone = extra.phone;
      if (extra.displayName) data.displayName = extra.displayName;
    }
    if (current === to) {
      await tx.account.update({ where: { id: accountId }, data });
      return false;
    }
    data.status = to;
    data.statusChangedAt = now;
    if (to === 'CONNECTED') {
      const acc = await tx.account.findUniqueOrThrow({ where: { id: accountId }, select: { linkedAt: true } });
      if (!acc.linkedAt || current === 'LOGGED_OUT' || current === 'NOT_LINKED' || current === 'LINKING') data.linkedAt = now;
    }
    const account = await tx.account.update({ where: { id: accountId }, data });
    await tx.accountStatusLog.create({ data: { accountId, from: current, to, source } });

    const payload = {
      accountId: account.id,
      kind: account.kind,
      clientId: account.clientId,
      status: to,
      previousStatus: current,
      phone: maskPhone(account.phone),
      at: now.toISOString(),
    };
    if (isDrop(current, to)) await enqueueForAllModules(tx, 'account.disconnected', payload);
    else if (to === 'CONNECTED') await enqueueForAllModules(tx, 'account.connected', payload);
    else await enqueueForAllModules(tx, 'account.status', payload);
    ctx.log.info({ accountId, from: current, to, source }, 'account status changed');
    return true;
  });
}

export interface LinkResult {
  status: AccountStatus;
  qr?: string;
  pairingCode?: string;
}

/**
 * Starts (or continues) linking a client's own number. Never touches a connected number and
 * never the ScaleEzy instance.
 */
export async function linkClient(ctx: Ctx, clientId: string, method: 'qr' | 'code', phone: string | null): Promise<LinkResult> {
  const instanceName = instanceNameForClient(clientId);
  if (instanceName === ctx.config.SCALEEZY_INSTANCE) throw Errors.forbidden('This client id cannot be used.');

  let account = await ctx.db.account.findUnique({ where: { clientId } });
  if (!account) {
    account = await ctx.db.account.upsert({
      where: { clientId },
      create: { kind: 'CLIENT', clientId, instanceName, status: 'NOT_LINKED' },
      update: {},
    });
  }
  return startLink(ctx, account, method, phone);
}

/**
 * Admin: links the ScaleEzy number itself. The engine is on the private network, so this is the
 * only way to show its QR / pairing code. Refuses when it is already connected.
 */
export async function linkScaleezy(ctx: Ctx, method: 'qr' | 'code', phone: string | null): Promise<LinkResult> {
  const account = await ensureScaleezyAccount(ctx);
  return startLink(ctx, account, method, phone);
}

async function startLink(ctx: Ctx, account: Account, method: 'qr' | 'code', phone: string | null): Promise<LinkResult> {
  let info = await engineCall(() => ctx.engine.connectionInfo(account.instanceName));
  if (info?.state === 'open') {
    await setAccountStatus(ctx, account.id, 'CONNECTED', 'link', { phone: info.ownerDigits, displayName: info.profileName });
    return { status: 'CONNECTED' };
  }

  const inst = account.instanceName;
  const number = method === 'code' ? phone ?? undefined : undefined;
  let link: LinkInfo | null = null;
  // The link is gone: unlinked here, or removed on the phone (401) or by WhatsApp (403). What the
  // engine still holds is a used-up instance, and a new QR on top of it fails on the phone with
  // "Couldn't link device" (seen in production, 18 Sep 2026). A number that only dropped
  // (DISCONNECTED) keeps its instance: its session may still come back by itself.
  const linkGone = account.status === 'LOGGED_OUT' || info?.statusReason === 401 || info?.statusReason === 403;
  if (info && (method === 'code' || linkGone)) {
    // Start from nothing, exactly like a first link. (A pairing code is also only issued when the
    // connection starts with the phone number.) Safe: the instance is not linked to anything. The
    // engine finishes removing it in the background, so wait until it is really gone.
    await ctx.engine.deleteInstance(inst).catch(() => undefined);
    for (let i = 0; i < 20; i++) {
      if (!(await engineCall(() => ctx.engine.connectionInfo(inst)))) break;
      await sleep(500);
    }
    info = null;
  }
  if (linkGone && account.linkedAt) {
    // A fresh link, not a reconnect: the health watch reads "connecting" as LINKING, not as a drop.
    await ctx.db.account.update({ where: { id: account.id }, data: { linkedAt: null } });
  }
  try {
    if (!info) link = await ctx.engine.createInstance(inst, number);
    else link = await ctx.engine.connect(inst);
  } catch (e) {
    // The engine can take longer than our call to start a connection (seen with pairing codes).
    // It carries on anyway, so keep asking below instead of failing the person's click.
    if (!(e instanceof EngineError) || e.kind !== 'timeout') throw toFriendly(e);
  }

  // The engine produces the QR / code a moment after the connection starts.
  for (let i = 0; i < 20; i++) {
    if (link?.state === 'open') break;
    const ready = method === 'code' ? Boolean(link?.pairingCode) : Boolean(link?.qr);
    if (ready) break;
    await sleep(1500);
    try {
      link = await ctx.engine.connect(inst, number);
    } catch (e) {
      if (!(e instanceof EngineError) || (e.kind !== 'timeout' && e.kind !== 'not_found')) throw toFriendly(e);
    }
  }
  if (!link) throw Errors.engineUnavailable();

  if (link.state === 'open') {
    await setAccountStatus(ctx, account.id, 'CONNECTED', 'link');
    return { status: 'CONNECTED' };
  }
  await setAccountStatus(ctx, account.id, 'LINKING', 'link');
  const out: LinkResult = { status: 'LINKING' };
  if (link.qr) out.qr = link.qr;
  if (method === 'code' && link.pairingCode) out.pairingCode = link.pairingCode;
  if (method === 'code' && !out.pairingCode) {
    throw Errors.engineUnavailable();
  }
  if (method === 'qr' && !out.qr) throw Errors.engineUnavailable();
  return out;
}

/**
 * Unlinks a shop's number, and only says so once it is true.
 *
 * The engine's logout alone cannot be trusted (seen in production, 18 Sep 2026: it answered
 * SUCCESS, the phone still listed the device and the next Link came back CONNECTED with no scan).
 * So: log out (tells WhatsApp to remove the device), then delete the engine instance, which drops
 * its saved login, its keys and its live socket, and then look: the instance must be gone. The
 * next link makes a brand-new instance, so nothing of this one can be picked up again.
 */
export async function disconnectClient(ctx: Ctx, clientId: string): Promise<Account> {
  const account = await ctx.db.account.findUnique({ where: { clientId } });
  if (!account) throw Errors.notFound("This shop's WhatsApp is not linked.");
  const inst = account.instanceName;
  try {
    await ctx.engine.logout(inst);
  } catch (e) {
    if (!(e instanceof EngineError)) throw e;
    if (e.transient) throw Errors.engineUnavailable();
    // Not connected / half-linked / already gone: the delete below clears whatever is left.
  }
  await ctx.engine.deleteInstance(inst).catch((e) => {
    if (e instanceof EngineError && e.transient) throw Errors.engineUnavailable();
  });
  let gone = false;
  for (let i = 0; i < 20 && !gone; i++) {
    gone = !(await engineCall(() => ctx.engine.connectionInfo(inst)));
    if (!gone) await sleep(500);
  }
  if (!gone) {
    ctx.log.error({ accountId: account.id }, 'unlink: the engine still has the instance after logout and delete');
    throw Errors.engineUnavailable();
  }
  await setAccountStatus(ctx, account.id, 'LOGGED_OUT', 'disconnect');
  return ctx.db.account.findUniqueOrThrow({ where: { id: account.id } });
}

/** Admin: ask the engine to reconnect a number that dropped. Never logs out, never shows a new QR for a linked number. */
export async function reconnectAccount(ctx: Ctx, accountId: string): Promise<{ status: AccountStatus; engineState: string | null }> {
  const account = await ctx.db.account.findUnique({ where: { id: accountId } });
  if (!account) throw Errors.notFound('No such WhatsApp number.');
  const info = await engineCall(() => ctx.engine.connectionInfo(account.instanceName));
  if (!info) return { status: account.status, engineState: null };
  if (info.state === 'close') {
    // connect() on a closed instance restarts the socket with the stored session.
    await engineCall(() => ctx.engine.connect(account.instanceName)).catch(() => undefined);
  }
  const after = await engineCall(() => ctx.engine.connectionInfo(account.instanceName));
  return { status: (await ctx.db.account.findUniqueOrThrow({ where: { id: accountId } })).status, engineState: after?.state ?? null };
}

async function engineCall<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    throw toFriendly(e);
  }
}

function toFriendly(e: unknown): unknown {
  if (e instanceof EngineError && (e.transient || e.kind === 'unauthorized')) return Errors.engineUnavailable();
  return e;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
