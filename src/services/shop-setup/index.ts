/**
 * "Set up your shop" (13 Nov 2026, PLAN-onboarding-setup.md): what the shop sells, asked at onboarding and confirmed by
 * the owner at first sign-in. What it sells shapes the app: READY_MADE keeps everything by the metre out of sight
 * (fabrics off), FABRICS and BOTH switch it on.
 *
 * The shop's details and GST are NOT saved here: the setup saves them through Settings' own routes (branding.service:
 * name, address, phone, email, GST registration, GSTIN, state, receipt line), so the two can never disagree. This
 * reports what is still missing, for the warning in the top bar.
 */
import { prisma } from '../../lib/prisma';
import { fabricSettings, setFabricSettings } from '../fabrics';
import { linkState } from '../boutique';

export const SELLS = ['READY_MADE', 'FABRICS', 'BOTH'] as const;
export type Sells = typeof SELLS[number];
const problem = (message: string, statusCode = 400) => Object.assign(new Error(message), { statusCode });

export const isSells = (v: unknown): v is Sells => typeof v === 'string' && (SELLS as readonly string[]).includes(v);

/** A shop from before this was asked: a guess from what it already has, for the owner to confirm. */
export async function guessSells(clientId: string): Promise<Sells | null> {
  const rows = await prisma.product.groupBy({ by: ['soldBy'], where: { clientId, trashedAt: null, sellInShop: true }, _count: { _all: true } });
  const metre = rows.filter(r => r.soldBy === 'METRE' || r.soldBy === 'KILOGRAM').reduce((n, r) => n + r._count._all, 0);
  const pieces = rows.filter(r => r.soldBy !== 'METRE' && r.soldBy !== 'KILOGRAM').reduce((n, r) => n + r._count._all, 0);
  // A new shop with no products yet has nothing to go on: nothing is pre-selected, the owner chooses.
  if (!metre && !pieces) return null;
  return metre && pieces ? 'BOTH' : metre ? 'FABRICS' : 'READY_MADE';
}

/** What the setup shows, what is still missing, and what every screen needs to shape itself (sells). */
export async function getSetup(clientId: string) {
  const [s, fabrics, boutique] = await Promise.all([
    prisma.clientSettings.findUnique({ where: { clientId }, select: { businessName: true, businessPhone: true, businessAddress: true, gstStateCode: true, gstRegistration: true, sells: true, setupDoneAt: true } }),
    fabricSettings(clientId),
    linkState(clientId)
  ]);
  const sells = isSells(s?.sells) ? s!.sells as Sells : null;
  // In the order the setup asks them. GST itself is optional ("not registered" is an answer), so it is not "missing".
  const missing = [
    !s?.businessName && 'shop name',
    !s?.businessPhone && 'phone',
    !s?.businessAddress && 'address',
    // Only a GST-registered shop needs its state (the form asks for it only then).
    s?.gstRegistration && s.gstRegistration !== 'UNREGISTERED' && !s.gstStateCode && 'state'
    // "What you sell" is not the owner's to fill in any more: ScaleEzy sets it in the Platform Console (27 Nov 2026).
  ].filter(Boolean) as string[];
  return {
    sells, suggested: sells ?? await guessSells(clientId),
    setupDone: !!s?.setupDoneAt, setupDoneAt: s?.setupDoneAt ?? null, missing,
    fabricMinCut: fabrics.fabricMinCut, fabricsOn: fabrics.fabricsOn,
    boutique
  };
}

/**
 * Change what the shop sells. READY_MADE switches fabrics off -- refused, in words, while anything is still sold by the
 * metre or packet; FABRICS and BOTH switch them on (with the smallest cut, when given).
 */
async function applySells(clientId: string, sells: Sells, fabricMinCut?: unknown, console = false) {
  if (sells === 'READY_MADE') {
    if (await prisma.boutiqueLink.count({ where: { clientId, unlinkedAt: null } })) {
      throw problem(console
        ? 'This shop has the Boutique module on, which adds fabrics and materials, so it sells both. Turn the Boutique module off first to set ready-made only.'
        : 'Your boutique adds fabrics and materials to this shop, so it sells both. To sell ready-made garments only, ask ScaleEzy to turn off the Boutique module first.', 409);
    }
    const now = await fabricSettings(clientId);
    if (now.fabricsOn) {
      try { await setFabricSettings(clientId, { fabricsOn: false }); }
      catch (e: any) {
        if (e?.statusCode === 409) {
          const n = (String(e.message).match(/^(\d+)/) ?? [])[1] ?? 'Some';
          throw problem(`${n} product${n === '1' ? ' is' : 's are'} still sold by the metre or packet. Change ${n === '1' ? 'it' : 'them'} to be sold by the piece (possible only while there is no stock or sales), or move ${n === '1' ? 'it' : 'them'} to Trash, before selecting ready-made garments only.`, 409);
        }
        throw e;
      }
    }
  } else {
    await setFabricSettings(clientId, { fabricsOn: true, ...(fabricMinCut !== undefined && fabricMinCut !== null ? { fabricMinCut } : {}) });
  }
}

/** The owner's answers: what the shop sells (and its smallest cut), and "finished". Only what is sent changes. */
export async function saveSetup(clientId: string, input: { sells?: unknown; fabricMinCut?: unknown; finish?: unknown }) {
  const data: Record<string, unknown> = {};
  /*
   * What the shop sells is ScaleEzy's to set (27 Nov 2026: Platform Console, at onboarding or when the client asks).
   * Sending the same answer again is harmless (an older screen still sends it on "finish"); changing it is refused.
   */
  if (input.sells !== undefined) {
    const now = (await prisma.clientSettings.findUnique({ where: { clientId }, select: { sells: true } }))?.sells ?? null;
    if (input.sells !== now) throw problem(SET_BY_SCALEEZY, 403);
  }
  // The smallest cut is still the shop's own, for a shop that sells fabric.
  if (input.fabricMinCut !== undefined && input.fabricMinCut !== null && (await fabricSettings(clientId)).fabricsOn) {
    await setFabricSettings(clientId, { fabricMinCut: input.fabricMinCut });
  }
  if (input.finish === true) data.setupDoneAt = new Date();
  if (Object.keys(data).length) await prisma.clientSettings.upsert({ where: { clientId }, create: { clientId, ...data } as any, update: data as any });
  return getSetup(clientId);
}

export const SET_BY_SCALEEZY = 'What your shop sells (ready-made garments, fabrics or both) is set by ScaleEzy. To change it, contact ScaleEzy.';

/**
 * The Platform Console: ScaleEzy sets what the shop sells (27 Nov 2026), at onboarding or later when the client asks.
 * BOTH and FABRICS switch everything by the metre on; READY_MADE switches it off -- refused in words while a boutique is
 * linked or anything is still sold by the metre or packet.
 */
export async function setSellsByScaleEzy(clientId: string, sells: unknown) {
  if (!isSells(sells)) throw problem('Choose what the shop sells: ready-made garments, fabrics, or both.');
  await applySells(clientId, sells, undefined, true);
  await prisma.clientSettings.upsert({ where: { clientId }, create: { clientId, sells } as any, update: { sells } });
  return getSetup(clientId);
}

/** At onboarding (the Console): what the shop sells. Set by ScaleEzy; the owner sees it and cannot change it. */
export async function seedSells(clientId: string, sells: Sells | null) {
  if (!sells) return;
  await applySells(clientId, sells);
  await prisma.clientSettings.upsert({ where: { clientId }, create: { clientId, sells } as any, update: { sells } });
}
