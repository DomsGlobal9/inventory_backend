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

  const info = await engineCall(() => ctx.engine.connectionInfo(account!.instanceName));
  if (info?.state === 'open') {
    await setAccountStatus(ctx, account.id, 'CONNECTED', 'link', { phone: info.ownerDigits, displayName: info.profileName });
    return { status: 'CONNECTED' };
  }

  let link: LinkInfo;
  if (!info) {
    link = await engineCall(() => ctx.engine.createInstance(account!.instanceName, method === 'code' ? phone ?? undefined : undefined));
  } else if (method === 'code') {
    // A pairing code is only issued when the connection starts with the phone number, so an
    // unlinked instance is recreated for it. Safe: it is not linked to anything.
    await engineCall(() => ctx.engine.deleteInstance(account!.instanceName)).catch(() => undefined);
    link = await engineCall(() => ctx.engine.createInstance(account!.instanceName, phone ?? undefined));
  } else {
    link = await engineCall(() => ctx.engine.connect(account!.instanceName));
  }

  // The engine produces the QR / code a moment after the connection starts.
  for (let i = 0; i < 8 && link.state !== 'open'; i++) {
    const ready = method === 'code' ? Boolean(link.pairingCode) : Boolean(link.qr);
    if (ready) break;
    await sleep(1500);
    link = await engineCall(() => ctx.engine.connect(account!.instanceName, method === 'code' ? phone ?? undefined : undefined));
  }

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

export async function disconnectClient(ctx: Ctx, clientId: string): Promise<Account> {
  const account = await ctx.db.account.findUnique({ where: { clientId } });
  if (!account) throw Errors.notFound("This shop's WhatsApp is not linked.");
  try {
    await ctx.engine.logout(account.instanceName);
  } catch (e) {
    if (!(e instanceof EngineError)) throw e;
    if (e.transient) throw Errors.engineUnavailable();
    // Not connected / half-linked: remove the instance so nothing is left logged in.
    await ctx.engine.deleteInstance(account.instanceName).catch(() => undefined);
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
    if (e instanceof EngineError) {
      if (e.transient || e.kind === 'unauthorized') throw Errors.engineUnavailable();
    }
    throw e;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
