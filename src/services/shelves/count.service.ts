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
    if (!spot.active) throw badRequest(`${spot.address} is not in use. Press Use again on it in Set up racks first.`);
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
    /*
     * "I counted the whole shelf" on a shelf with nothing recorded and nothing found: the empty shelf is
     * confirmed. Refusing it ("Nothing was counted.") left a worker no way to say "I looked: it is empty".
     */
    if (lines.length === 0 && complete) {
      await prisma.storageSpot.update({ where: { id: spot.id }, data: { lastCountedAt: new Date() } });
      return { address: spot.address, counted: 0, matched: 0, issues: 0, failed: 0, results: [], emptyConfirmed: true };
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
        /*
         * One transaction per line, holding the item's lock (the same FOR UPDATE every stock movement
         * takes): the shelf's figure is read INSIDE it, so two counts of one shelf at once apply once --
         * the second sees the first's result and finds nothing to change. Read outside, both applied the
         * difference and a shelf of 5 counted as 3 ended at 1, with two problems (26 Oct review). The
         * problem and its alert are saved in the same transaction, never "could not record" for a count
         * that did change the shelf.
         */
        const row = await prisma.$transaction(async (tx) => {
          await tx.$queryRaw`SELECT id FROM inventory_product_variants WHERE id = ${line.variantId} FOR UPDATE`;
          const recorded = (await tx.spotStock.findUnique({ where: { spotId_variantId: { spotId: spot.id, variantId: line.variantId } } }))?.quantity ?? 0;
          const diff = line.counted - recorded;
          /*
           * Problems a count answers close by themselves, saying why (they stayed open for ever unless someone
           * pressed Mark fixed). Which ones, carefully:
           *   - a picker's "not found on this shelf" report asked for exactly this count: answered by any count
           *     (the count itself records a real shortfall as its own problem);
           *   - "count and stock do not match" asked to correct the stock and count again: answered when the
           *     count now matches;
           *   - a COUNT's own "N fewer than recorded" stays open: the pieces are still lost, whatever a later
           *     count of the shelf says (26 Oct -- the first version closed it, and the test caught it).
           */
          const closedAt = new Date();
          const closedReports = await tx.shelfIssue.updateMany({
            where: { clientId, spotId: spot.id, variantId: line.variantId, resolvedAt: null, kind: 'NOT_FOUND_ON_SHELF', NOT: { message: { startsWith: 'A count of' } } },
            data: { resolvedAt: closedAt, resolvedBy: userId, resolutionNote: `Closed by itself: ${spot.address} was counted (${line.counted} found).` }
          });
          if (diff === 0) {
            const closed = await tx.shelfIssue.updateMany({
              where: { clientId, spotId: spot.id, variantId: line.variantId, resolvedAt: null, kind: 'COUNT_BELOW_SHELVES' },
              data: { resolvedAt: closedAt, resolvedBy: userId, resolutionNote: `Closed by itself: a count of ${spot.address} matched (${line.counted}).` }
            });
            return { variantId: line.variantId, recorded, counted: line.counted, onShelfNow: recorded, issue: null, closedProblems: closed.count + closedReports.count };
          }

          let moved = diff;
          let issue: { kind: 'NOT_FOUND_ON_SHELF' | 'COUNT_BELOW_SHELVES'; quantity: number; message: string } | null = null;
          if (diff > 0) {
            const [stock, shelved] = await Promise.all([
              tx.inventoryStock.findUnique({ where: { variantId_locationId: { variantId: line.variantId, locationId: spot.locationId } } }),
              tx.spotStock.aggregate({ where: { variantId: line.variantId, locationId: spot.locationId }, _sum: { quantity: true } })
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
                `${-diff === 1 ? 'It is' : 'They are'} now counted as not on a shelf. Find ${-diff === 1 ? 'it' : 'them'}, or correct the stock.`
            };
          }

          if (moved !== 0) {
            await inventoryMutationService.applyMovement({
              clientId, variantId: line.variantId, locationId: spot.locationId, movementType: 'ADJUSTMENT', reason: 'SHELF_MOVE',
              quantityDelta: 0, spots: [{ spotId: spot.id, quantity: moved }], referenceType: 'SHELF_COUNT', referenceId: spot.id,
              notes: `Shelf count of ${spot.address}: ${line.counted} counted, ${recorded} recorded`, createdBy: userId ?? undefined, tx
            } as any);
          }
          if (issue) {
            await tx.shelfIssue.create({ data: { clientId, locationId: spot.locationId, variantId: line.variantId, spotId: spot.id, address: spot.address, kind: issue.kind, quantity: issue.quantity, message: issue.message } });
            await tx.inventoryAlert.create({ data: { clientId, type: 'STOCK_DISCREPANCY', severity: 'WARNING', title: 'Shelves need a look', message: issue.message, variantId: line.variantId, locationId: spot.locationId } });
          }
          const now = (await tx.spotStock.findUnique({ where: { spotId_variantId: { spotId: spot.id, variantId: line.variantId } } }))?.quantity ?? 0;
          return { variantId: line.variantId, recorded, counted: line.counted, onShelfNow: now, issue: issue?.message ?? null };
        }, { timeout: 60_000, maxWait: 20_000 });
        results.push(row);
      } catch (error: any) {
        results.push({ variantId: line.variantId, recorded: null, counted: line.counted, onShelfNow: null, issue: null, error: typeof error?.statusCode === 'number' ? error.message : 'Could not record this count.' });
      }
    }

    // When it was last counted, whether or not anything changed (Count lists the longest-uncounted first).
    await prisma.storageSpot.update({ where: { id: spot.id }, data: { lastCountedAt: new Date() } });
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
