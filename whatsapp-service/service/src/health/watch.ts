import type { Account, AccountStatus } from '@prisma/client';
import type { Ctx } from '../context';
import { EngineError, type EngineConnectionInfo } from '../engine/client';
import { mapConnectionState } from '../domain/status';
import { setAccountStatus } from '../accounts/service';

// Every 5 minutes: ask the engine how every number really is. Webhook events can be missed
// (service restarting, network), this catches up. A drop from CONNECTED is confirmed once more
// after a short wait before modules are told, so an engine restart does not alarm shop owners.

export interface WatchOptions {
  confirmDelayMs?: number;
}

export interface WatchResult {
  checked: number;
  changed: number;
  engineDown: boolean;
}

function statusFrom(info: EngineConnectionInfo | null, account: Account): AccountStatus {
  const wasLinked = account.linkedAt !== null;
  if (!info) return wasLinked ? 'LOGGED_OUT' : 'NOT_LINKED';
  return mapConnectionState({ state: info.state, statusReason: info.statusReason }, wasLinked);
}

export async function runHealthWatch(ctx: Ctx, opts: WatchOptions = {}): Promise<WatchResult> {
  const confirmDelayMs = opts.confirmDelayMs ?? 20_000;
  // Every number except client numbers that were never linked (nothing to watch there).
  const accounts = await ctx.db.account.findMany({
    where: { OR: [{ kind: 'SCALEEZY' }, { NOT: { status: 'NOT_LINKED', linkedAt: null } }] },
  });
  const result: WatchResult = { checked: 0, changed: 0, engineDown: false };

  for (const account of accounts) {
    let info: EngineConnectionInfo | null;
    try {
      info = await ctx.engine.connectionInfo(account.instanceName);
    } catch (e) {
      if (e instanceof EngineError && (e.transient || e.kind === 'unauthorized')) {
        // The engine itself is down: that is not a shop's number dropping. /ready reports it.
        ctx.log.error({ reason: e.kind }, 'health watch: engine not reachable');
        result.engineDown = true;
        return result;
      }
      throw e;
    }
    result.checked++;
    let to = statusFrom(info, account);

    if (account.status === 'CONNECTED' && to !== 'CONNECTED' && confirmDelayMs > 0) {
      await new Promise((r) => setTimeout(r, confirmDelayMs));
      try {
        info = await ctx.engine.connectionInfo(account.instanceName);
      } catch {
        continue;
      }
      to = statusFrom(info, account);
    }
    // A number still showing its QR stays LINKING; nothing to record.
    if (to === 'LINKING' && account.status === 'LINKING') continue;
    if (to === account.status) {
      await ctx.db.account.update({ where: { id: account.id }, data: { lastSeenAt: new Date() } });
      continue;
    }
    const changed = await setAccountStatus(ctx, account.id, to, 'health-watch', {
      phone: info?.ownerDigits ?? null,
      displayName: info?.profileName ?? null,
    });
    if (changed) result.changed++;
  }
  return result;
}
