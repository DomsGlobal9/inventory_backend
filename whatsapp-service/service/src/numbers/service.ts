import type { Account } from '@prisma/client';
import type { Ctx } from '../context';
import { isNumberCheckFresh } from '../domain/rules';

/**
 * Is this number on WhatsApp? Asked through the sending number's own connection, and cached
 * for 7 days so repeated sends to a supplier do not repeat the lookup.
 * Throws EngineError when the engine cannot answer; the caller decides what that means.
 */
export async function isOnWhatsApp(ctx: Ctx, account: Account, toDigits: string, opts: { refresh?: boolean } = {}): Promise<boolean> {
  const now = new Date();
  if (!opts.refresh) {
    const cached = await ctx.db.numberCheck.findUnique({ where: { toDigits } });
    if (cached && isNumberCheckFresh(cached.checkedAt, now)) return cached.onWhatsApp;
  }
  const result = await ctx.engine.onWhatsApp(account.instanceName, [toDigits]);
  // One number asked, one answer: use it even if the engine echoed the number differently.
  const onWhatsApp = result.get(toDigits) ?? (result.size === 1 ? [...result.values()][0] === true : false);
  await ctx.db.numberCheck.upsert({
    where: { toDigits },
    create: { toDigits, onWhatsApp, checkedAt: now },
    update: { onWhatsApp, checkedAt: now },
  });
  return onWhatsApp;
}
