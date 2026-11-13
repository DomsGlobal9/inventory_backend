/**
 * Fabrics by the metre: the shop's switch and the rules a product's unit must follow (13 Nov 2026, PLAN-fabrics.md).
 *
 * One place that answers "may this product be sold by the metre?" and "may its unit change?", so the product
 * screens, the API and (later) the boutique's screens all get the same answer.
 */
import { prisma } from '../../lib/prisma';
import { SELLING_NOW, isMeasured, isSoldBy, unitOf, KIND_KEYS, type SoldBy } from '../../lib/units';

const problem = (message: string, statusCode = 400) => Object.assign(new Error(message), { statusCode, message });

export type FabricSettings = { fabricsOn: boolean; fabricMinCut: number; fabricRollSize: number; fabricQuickLengths: number[] };

export async function fabricSettings(clientId: string): Promise<FabricSettings> {
  const s = await prisma.clientSettings.findUnique({ where: { clientId }, select: { fabricsOn: true, fabricMinCut: true, fabricRollSize: true, fabricQuickLengths: true } });
  return { fabricsOn: s?.fabricsOn ?? false, fabricMinCut: s?.fabricMinCut ?? 25, fabricRollSize: s?.fabricRollSize ?? 2500, fabricQuickLengths: s?.fabricQuickLengths?.length ? s.fabricQuickLengths : [100, 250, 550] };
}

/** The owner's switch and defaults (Settings → Products → Fabrics). Centimetres for both lengths. */
export async function setFabricSettings(clientId: string, input: { fabricsOn?: unknown; fabricMinCut?: unknown; fabricRollSize?: unknown; fabricQuickLengths?: unknown }) {
  const data: Partial<FabricSettings> = {};
  if (input.fabricsOn !== undefined) {
    if (typeof input.fabricsOn !== 'boolean') throw problem('Choose on or off.');
    if (input.fabricsOn === false) {
      // Off again: refused while products are still sold by the metre or packet, or their stock and prices would be
      // read as pieces by every screen that no longer knows better.
      const measured = await prisma.product.count({ where: { clientId, soldBy: { not: 'PIECE' }, trashedAt: null } });
      if (measured > 0) throw problem(`${measured} product${measured === 1 ? ' is' : 's are'} sold by the metre or packet. Change them back to pieces (only possible while they have no stock or sales) before switching fabrics off.`, 409);
    }
    data.fabricsOn = input.fabricsOn;
  }
  if (input.fabricMinCut !== undefined) {
    const n = Number(input.fabricMinCut);
    if (!Number.isInteger(n) || n < 5 || n > 1000 || n % 5 !== 0) throw problem('The minimum cut length is set in 5 cm steps, between 0.05 m and 10 m.');
    data.fabricMinCut = n;
  }
  if (input.fabricRollSize !== undefined) {
    const n = Number(input.fabricRollSize);
    if (!Number.isInteger(n) || n < 100 || n > 100_000) throw problem('A roll is between 1 m and 1,000 m.');
    data.fabricRollSize = n;
  }
  if (input.fabricQuickLengths !== undefined) {
    const list = Array.isArray(input.fabricQuickLengths) ? input.fabricQuickLengths.map(Number) : [];
    if (list.length < 1 || list.length > 6 || list.some(n => !Number.isInteger(n) || n < 1 || n > 10_000)) throw problem('Give 1 to 6 quick lengths, each between 0.01 m and 100 m.');
    data.fabricQuickLengths = [...new Set(list)].sort((a, b) => a - b);
  }
  await prisma.clientSettings.upsert({ where: { clientId }, create: { clientId, ...data } as any, update: data });
  return fabricSettings(clientId);
}

type UnitFields = { soldBy?: unknown; kind?: unknown; minCut?: unknown; widthCm?: unknown; rollSize?: unknown; cutReturnable?: unknown };

/**
 * Checks and tidies a product's unit fields before a create (productId null) or an update. Returns only the fields
 * to write. Rules:
 *  - anything but PIECE needs the shop's switch on, and only units offered now (Metre, Packet) may be chosen;
 *  - the unit changes only while the product has no stock and no history (bills must keep meaning what they meant);
 *  - smallest cut and roll size belong to measured units only (a packet has no smallest cut);
 *  - a kind is one of the known kinds, or none.
 */
export async function unitFieldsFor(clientId: string, productId: string | null, input: UnitFields) {
  const out: Record<string, unknown> = {};
  const has = (k: keyof UnitFields) => input[k] !== undefined;
  if (input.cutReturnable !== undefined) {
    if (typeof input.cutReturnable !== 'boolean') throw problem('Choose whether cut cloth can be returned.');
    out.cutReturnable = input.cutReturnable;
  }

  let soldBy: SoldBy | undefined;
  if (has('soldBy')) {
    if (!isSoldBy(input.soldBy)) throw problem('Choose how it is sold: by the piece, the metre or the packet.');
    soldBy = input.soldBy;
  }
  const before = productId
    ? await prisma.product.findFirst({ where: { id: productId, clientId }, select: { soldBy: true } })
    : null;
  const finalSoldBy: SoldBy = soldBy ?? ((before?.soldBy as SoldBy | undefined) ?? 'PIECE');

  if (soldBy && soldBy !== (before?.soldBy ?? 'PIECE')) {
    if (soldBy !== 'PIECE') {
      if (!SELLING_NOW.includes(soldBy)) throw problem(`Selling by the ${unitOf(soldBy).one} is not offered yet. Choose piece, metre or packet.`);
      const s = await fabricSettings(clientId);
      if (!s.fabricsOn) throw problem('Selling by the metre or packet is off for this shop. Switch it on in Settings → Products → Fabrics.', 409);
    }
    if (productId) {
      const [stock, moves, sold] = await Promise.all([
        prisma.inventoryStock.aggregate({ where: { clientId, variant: { productId } }, _sum: { quantity: true } }),
        prisma.inventoryTransaction.count({ where: { clientId, variant: { productId } } }),
        prisma.salesOrderItem.count({ where: { variant: { productId } } }),
      ]);
      if ((stock._sum.quantity ?? 0) !== 0 || moves > 0 || sold > 0) {
        throw problem('This product already has stock or sales, so how it is sold cannot change: old bills must keep meaning what they meant. Add a new product sold by the new unit instead.', 409);
      }
    }
    out.soldBy = soldBy;
  }

  if (has('kind')) {
    const k = input.kind === '' || input.kind === null ? null : String(input.kind);
    if (k !== null && !KIND_KEYS.includes(k)) throw problem('Choose a kind from the list.');
    out.kind = k;
  }

  const measured = isMeasured(finalSoldBy);
  const positiveInt = (v: unknown, label: string, max: number) => {
    if (v === null || v === '') return null;
    const n = Number(v);
    if (!Number.isInteger(n) || n < 1 || n > max) throw problem(`${label} must be a whole number above 0.`);
    return n;
  };
  if (has('minCut')) {
    out.minCut = measured ? positiveInt(input.minCut, 'The minimum cut length', 1000) : null;
    if (out.minCut != null && ((out.minCut as number) < 5 || (out.minCut as number) % 5 !== 0)) throw problem('The minimum cut length is set in 5 cm steps, between 0.05 m and 10 m.');
  }
  if (has('rollSize')) out.rollSize = measured ? positiveInt(input.rollSize, 'The roll length', 100_000) : null;
  if (has('widthCm')) out.widthCm = positiveInt(input.widthCm, 'The width', 1000);
  // Changed back to a counted unit: lengths that only mean something for cloth are cleared.
  if (out.soldBy && !measured) { out.minCut = null; out.rollSize = null; }
  return out;
}
