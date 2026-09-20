import { prisma } from '../../lib/prisma';
import { badRequest, notFound } from '../../utils/httpError';
import { inventoryMutationService } from '../inventory-mutation.service';

/**
 * Counting one shelf: what is really on it, item by item.
 *
 * A shelf count moves pieces between the shelf and Not shelved -- never in or out of the location,
 * which only a stock count or an adjustment can change. So:
 *
 *   fewer than recorded   the shelf is set to the count; the difference becomes Not shelved (the pieces
 *                         are somewhere in the location) and a NOT_FOUND_ON_SHELF issue says so
 *   more than recorded    the extra is taken from Not shelved; anything beyond what the location holds
 *                         cannot be recorded on a shelf, and a COUNT_BELOW_SHELVES issue asks for the
 *                         stock to be corrected
 *
 * Each item is its own movement, in the ledger as a SHELF_MOVE with a SCANNED leg.
 */

type CountLine = { variantId: string; counted: number };

export const shelfCountService = {
  async count(clientId: string, userId: string | null, spotId: string, body: { counts?: unknown; complete?: unknown }) {
    const spot = await prisma.storageSpot.findFirst({
      where: { id: spotId, clientId },
      select: { id: true, address: true, locationId: true, active: true, _count: { select: { children: true } } }
    });
    if (!spot) throw notFound('That shelf was not found.');
    if (!spot.active) throw badRequest(`${spot.address} is switched off. Switch it on in Racks & shelves first.`);
    if (spot._count.children > 0) throw badRequest(`${spot.address} has shelves inside it. Count those instead.`);

    if (!Array.isArray(body.counts)) throw badRequest('Send what was counted.');
    if (body.counts.length > 500) throw badRequest('Count at most 500 items on one shelf.');
    const lines: CountLine[] = [];
    const seen = new Set<string>();
    for (const raw of body.counts as any[]) {
      if (!raw || typeof raw.variantId !== 'string' || !raw.variantId) throw badRequest('Each count needs its item.');
      if (!Number.isInteger(raw.counted) || raw.counted < 0 || raw.counted > 100000) throw badRequest('A count is a whole number of pieces, zero or more.');
      if (seen.has(raw.variantId)) throw badRequest('The same item is counted twice. Add the counts together.');
      seen.add(raw.variantId);
      lines.push({ variantId: raw.variantId, counted: raw.counted });
    }
    const complete = body.complete === true;

    const onShelf = await prisma.spotStock.findMany({ where: { clientId, spotId: spot.id }, select: { variantId: true, quantity: true } });
    // "Complete" means the counter looked at the whole shelf: anything recorded here and not counted is 0.
    if (complete) {
      for (const row of onShelf) if (!seen.has(row.variantId)) lines.push({ variantId: row.variantId, counted: 0 });
    }
    if (lines.length === 0) throw badRequest('Nothing was counted.');

    const variants = await prisma.productVariant.findMany({
      where: { clientId, id: { in: lines.map(l => l.variantId) } },
      select: { id: true, sku: true, product: { select: { title: true } } }
    });
    if (variants.length !== lines.length) {
      const known = new Set(variants.map(v => v.id));
      const missing = lines.filter(l => !known.has(l.variantId));
      // A stray row recorded on the shelf must not make the whole shelf uncountable: it is left out
      // of the count and named. A line the COUNTER typed is still refused, because they chose it.
      const typedMissing = missing.filter(l => seen.has(l.variantId));
      if (typedMissing.length > 0) {
        throw notFound(`${typedMissing.length === 1 ? 'One of the items counted was' : `${typedMissing.length} of the items counted were`} not found in this shop.`);
      }
      for (const stray of missing) lines.splice(lines.indexOf(stray), 1);
      if (lines.length === 0) throw badRequest('Nothing on this shelf could be counted. Ask for a stock check on it.');
    }
    const nameOf = new Map(variants.map(v => [v.id, `${v.product.title} (${v.sku})`]));

    const results = [];
    for (const line of lines) {
      const name = nameOf.get(line.variantId)!;
      try {
        const recorded = (await prisma.spotStock.findUnique({ where: { spotId_variantId: { spotId: spot.id, variantId: line.variantId } } }))?.quantity ?? 0;
        const diff = line.counted - recorded;
        if (diff === 0) { results.push({ variantId: line.variantId, recorded, counted: line.counted, onShelfNow: recorded, issue: null }); continue; }

        let moved = diff;
        let issue: { kind: 'NOT_FOUND_ON_SHELF' | 'COUNT_BELOW_SHELVES'; quantity: number; message: string } | null = null;
        if (diff > 0) {
          const [stock, shelved] = await Promise.all([
            prisma.inventoryStock.findUnique({ where: { variantId_locationId: { variantId: line.variantId, locationId: spot.locationId } } }),
            prisma.spotStock.aggregate({ where: { variantId: line.variantId, locationId: spot.locationId }, _sum: { quantity: true } })
          ]);
          const free = Math.max(0, (stock?.quantity ?? 0) - (shelved._sum.quantity ?? 0));
          moved = Math.min(diff, free);
          if (moved < diff) {
            const extra = diff - moved;
            issue = {
              kind: 'COUNT_BELOW_SHELVES', quantity: extra,
              message: `A count of ${spot.address} found ${extra} more ${extra === 1 ? 'piece' : 'pieces'} of ${name} than the stock records allow. ` +
                'Correct the stock for this location, then count the shelf again.'
            };
          }
        } else {
          issue = {
            kind: 'NOT_FOUND_ON_SHELF', quantity: -diff,
            message: `A count of ${spot.address} found ${-diff} fewer ${-diff === 1 ? 'piece' : 'pieces'} of ${name} than recorded. ` +
              `${-diff === 1 ? 'It is' : 'They are'} now counted as not shelved -- find ${-diff === 1 ? 'it' : 'them'} or correct the stock.`
          };
        }

        if (moved !== 0) {
          await inventoryMutationService.applyMovement({
            clientId, variantId: line.variantId, locationId: spot.locationId, movementType: 'ADJUSTMENT', reason: 'SHELF_MOVE',
            quantityDelta: 0, spots: [{ spotId: spot.id, quantity: moved }], referenceType: 'SHELF_COUNT', referenceId: spot.id,
            notes: `Shelf count of ${spot.address}: ${line.counted} counted, ${recorded} recorded`, createdBy: userId ?? undefined
          });
        }
        if (issue) {
          await prisma.$transaction([
            prisma.shelfIssue.create({ data: { clientId, locationId: spot.locationId, variantId: line.variantId, spotId: spot.id, address: spot.address, kind: issue.kind, quantity: issue.quantity, message: issue.message } }),
            prisma.inventoryAlert.create({ data: { clientId, type: 'STOCK_DISCREPANCY', severity: 'WARNING', title: 'Shelves need a look', message: issue.message, variantId: line.variantId, locationId: spot.locationId } })
          ]);
        }
        const now = (await prisma.spotStock.findUnique({ where: { spotId_variantId: { spotId: spot.id, variantId: line.variantId } } }))?.quantity ?? 0;
        results.push({ variantId: line.variantId, recorded, counted: line.counted, onShelfNow: now, issue: issue?.message ?? null });
      } catch (error: any) {
        results.push({ variantId: line.variantId, recorded: null, counted: line.counted, onShelfNow: null, issue: null, error: typeof error?.statusCode === 'number' ? error.message : 'Could not record this count.' });
      }
    }

    return {
      address: spot.address,
      counted: results.length,
      matched: results.filter(r => r.recorded === r.counted).length,
      issues: results.filter(r => r.issue).length,
      failed: results.filter((r: any) => r.error).length,
      results
    };
  }
};
