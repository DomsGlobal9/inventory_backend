import { Request, Response, NextFunction } from 'express';
import { InventoryReason } from '@prisma/client';
import { inventoryService } from '../services/inventory.service';
import { valuationService } from '../services/valuation.service';
import { stockChangeSchema } from '../validations/inventory.schema';
import { legsTakenFrom } from '../services/shelves/from-spots';
import { canSeeCost } from '../middleware/cost-visibility.middleware';

/** Who made a movement, for the ledger: the signed-in person's name, never the shop's id. */
const performerOf = (req: Request) => (req as any).user?.name || (req as any).user?.id;

const VALID_REASONS: string[] = Object.values(InventoryReason);
// Not the list of reason codes: those mean nothing to the person reading this.
const UNKNOWN_REASON = 'That reason is not one the app knows. Choose a reason from the list.';

/**
 * Why pieces may be taken off by hand.
 *
 * Not SALE. A counter sale or a sent order takes its pieces off by itself, and the day book
 * measures sales against those dispatches -- so a hand-made "SALE" was a write-off wearing a
 * sale's name: the day book counted pieces as sold that no order sold, and a damaged saree
 * issued with the form's old default of SALE disappeared into the sales figures.
 */
const MANUAL_STOCK_OUT_REASONS: string[] = ['DAMAGE', 'RETURN_TO_VENDOR', 'SAMPLE'];

/**
 * Run the movement payload through stockChangeSchema before anything touches stock.
 *
 * The schema was imported at the top of this file and never called. Every handler read
 * req.body raw and hand-checked `quantity <= 0`, so:
 *
 *   - 2.7 pieces was accepted and silently became 2. Garments are not sold by the fraction,
 *     and a stock figure that quietly loses 0.7 of what somebody typed is worse than one that
 *     refuses it.
 *   - a unit cost of -500 was accepted and dragged the weighted average of a live product from
 *     47,045 down to 44,031 -- real money on a real valuation, with nothing refused.
 *
 * Both proven against a running tenant during an audit, and both reverted afterwards. There was
 * even a comment further down claiming "stockChangeSchema enforces positive". It does now; it
 * did not then, because nothing ran it.
 *
 * The sign stays the caller's business: stock-in wants positive, an adjustment may legitimately
 * be negative. Everything else -- whole pieces, a finite number, a cost that is not negative --
 * is the same wherever the movement comes from, so it belongs in one place.
 */
function parseMovement(body: unknown) {
  return stockChangeSchema.safeParse(body);
}

/** Turns a Zod failure into the shape the rest of this API answers with. */
function movementError(res: Response, parsed: any) {
  const issues = parsed.error?.issues || [];
  return res.status(400).json({
    success: false,
    message: issues[0]?.message || 'That stock movement is not valid.',
    errors: issues.map((i: any) => ({ field: i.path.join('.'), message: i.message }))
  });
}


export class InventoryController {

  async stockIn(req: Request, res: Response, next: NextFunction) {
    try {
      const clientId = (req as any).clientId as string;
      const parsed = parseMovement(req.body);
      if (!parsed.success) return movementError(res, parsed);
      const { variantId, quantity, reason, referenceType, reference, unitCost, notes } = parsed.data;
      const { locationId } = req.body;

      if (reason !== undefined && !VALID_REASONS.includes(reason)) {
        return res.status(400).json({ success: false, message: UNKNOWN_REASON });
      }

      let targetLocationId = locationId || (req as any).locationId;
      if (!targetLocationId) {
        // Fallback for transition phase
        const defaultLoc = await import('../lib/prisma').then(m => m.prisma.stockLocation.findFirst({ where: { clientId, code: 'MAIN-STORE' } }));
        if (!defaultLoc) throw new Error("Location ID required");
        targetLocationId = defaultLoc.id;
      }

      if (quantity <= 0) return res.status(400).json({ success: false, message: "Quantity must be positive" });
      const result = await inventoryService.stockIn(clientId, targetLocationId, variantId, quantity, reason, referenceType, reference, unitCost, notes, performerOf(req));
      res.status(200).json({ success: true, data: result });
    } catch (error) {
      next(error);
    }
  }

  async stockOut(req: Request, res: Response, next: NextFunction) {
    try {
      const clientId = (req as any).clientId as string;
      const parsed = parseMovement(req.body);
      if (!parsed.success) return movementError(res, parsed);
      const { variantId, quantity, reason, referenceType, reference, notes } = parsed.data;
      const { locationId } = req.body;

      // Chosen by the person, never assumed: the form used to start on SALE, so every write-off
      // that was not changed by hand landed in the ledger as a sale.
      if (!reason) {
        return res.status(400).json({ success: false, message: 'Choose why these pieces are going out: damaged, a sample, or returned to the supplier.' });
      }
      if (reason === 'SALE') {
        return res.status(400).json({ success: false, message: 'Sales take stock off by themselves when the sale is made or the order is sent. To take pieces off by hand, choose damaged, a sample, or returned to the supplier.' });
      }
      if (!MANUAL_STOCK_OUT_REASONS.includes(reason)) {
        return res.status(400).json({ success: false, message: VALID_REASONS.includes(reason) ? 'That reason is not for taking stock off by hand. Choose damaged, a sample, or returned to the supplier.' : UNKNOWN_REASON });
      }

      let targetLocationId = locationId || (req as any).locationId;
      if (!targetLocationId) {
        // Fallback for transition phase
        const defaultLoc = await import('../lib/prisma').then(m => m.prisma.stockLocation.findFirst({ where: { clientId, code: 'MAIN-STORE' } }));
        if (!defaultLoc) throw new Error("Location ID required");
        targetLocationId = defaultLoc.id;
      }

      if (quantity <= 0) return res.status(400).json({ success: false, message: "Quantity must be positive" });
      // Which shelves the pieces came off, when the person said so. Otherwise the shelf rule decides.
      const spots = legsTakenFrom(req.body?.fromSpots, quantity);
      const result = await inventoryService.stockOut(clientId, targetLocationId, variantId, quantity, reason, referenceType, reference, notes, performerOf(req), spots);
      res.status(200).json({ success: true, data: result });
    } catch (error) {
      next(error);
    }
  }

  async adjustment(req: Request, res: Response, next: NextFunction) {
    try {
      const clientId = (req as any).clientId as string;
      // An adjustment is the one movement where a negative quantity is the point -- it is how a
      // count correction goes down. The schema deliberately does not police the sign; it still
      // checks the quantity is a whole, finite number, which an adjustment needs as much as any
      // other movement does.
      const parsed = parseMovement(req.body);
      if (!parsed.success) return movementError(res, parsed);
      const { variantId, quantity, reason, referenceType, reference, notes } = parsed.data;
      const { locationId } = req.body;

      if (quantity === 0) {
        return res.status(400).json({ success: false, message: 'An adjustment of zero would change nothing.' });
      }
      if (reason !== undefined && !VALID_REASONS.includes(reason)) {
        return res.status(400).json({ success: false, message: UNKNOWN_REASON });
      }
      // A correction marked SALE would count in the day book as a sale no order made -- the same
      // hole stock-out closes above.
      if (reason === 'SALE') {
        return res.status(400).json({ success: false, message: 'A stock correction is not a sale. Sales take stock off by themselves when the sale is made or the order is sent.' });
      }

      let targetLocationId = locationId || (req as any).locationId;
      if (!targetLocationId) {
        const defaultLoc = await import('../lib/prisma').then(m => m.prisma.stockLocation.findFirst({ where: { clientId, code: 'MAIN-STORE' } }));
        if (!defaultLoc) throw new Error("Location ID required");
        targetLocationId = defaultLoc.id;
      }

      const result = await inventoryService.adjustment(clientId, targetLocationId, variantId, quantity, reason, referenceType, reference, notes, performerOf(req));
      res.status(200).json({ success: true, data: result });
    } catch (error) {
      next(error);
    }
  }

  async getTransactions(req: Request, res: Response, next: NextFunction) {
    try {
      const clientId = (req as any).clientId as string;
      const transactions = await inventoryService.getTransactions(clientId, req.query);
      res.status(200).json({ success: true, data: transactions });
    } catch (error) {
      next(error);
    }
  }

  async getVariants(req: Request, res: Response, next: NextFunction) {
    try {
      const clientId = (req as any).clientId as string;
      // An explicit ?locationId= query param overrides the x-location-id header (the
      // globally-selected TopNav location) -- callers that need a *specific* location's
      // view regardless of what's currently selected app-wide (e.g. the Transfers page
      // scoping the variant picker to whichever Origin was just chosen) pass this.
      const locationId = (req.query.locationId as string | undefined) || ((req as any).locationId as string | undefined);
      // Sorting by cost or stock value hands over the ranking the redacted numbers would have
      // given -- "these ten are what the shop paid most for". Ignored for anyone without cost:view.
      const filters: any = { ...req.query };
      if (['averageCost', 'inventoryValue'].includes(String(filters.sortBy)) && !canSeeCost((req as any).user)) {
        delete filters.sortBy;
      }
      const variants = await inventoryService.getVariants(clientId, filters, locationId);
      res.status(200).json({ success: true, data: variants });
    } catch (error) {
      next(error);
    }
  }

  async getMetadata(req: Request, res: Response, next: NextFunction) {
    try {
      const metadata = await inventoryService.getMetadata();
      res.status(200).json({ success: true, data: metadata });
    } catch (error) {
      next(error);
    }
  }

  async getAlerts(req: Request, res: Response, next: NextFunction) {
    try {
      const clientId = (req as any).clientId as string;
      const alerts = await inventoryService.getAlerts(clientId);
      res.status(200).json({ success: true, data: alerts });
    } catch (error) {
      next(error);
    }
  }

  async reconcileValuation(req: Request, res: Response, next: NextFunction) {
    try {
      const clientId = (req as any).clientId as string;
      const mode = req.query.mode === 'repair' ? 'repair' : 'report';
      const result = await valuationService.reconcileValuation(clientId, mode);
      res.status(200).json({ success: true, data: result });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Sets what stock already on hand cost. Changes no quantities.
   *
   * Under inventory:adjust rather than a permission of its own: restating what stock is worth
   * is the same authority as changing how much of it there is, and both are already the line
   * between someone who can move stock and someone who can only look at it.
   */
  async setCostOfStockOnHand(req: Request, res: Response, next: NextFunction) {
    try {
      const clientId = (req as any).clientId as string;
      const { variantId, unitCost, notes } = req.body ?? {};
      if (!variantId) {
        return res.status(400).json({ success: false, message: 'variantId is required' });
      }
      const result = await valuationService.setCostOfStockOnHand(clientId, variantId, Number(unitCost), {
        performedBy: (req as any).user?.name,
        notes
      });
      res.status(200).json({
        success: true,
        data: result,
        message: `${result.unitsRevalued} unit${result.unitsRevalued === 1 ? '' : 's'} now valued at ${result.averageCost} each.`
      });
    } catch (error) {
      next(error);
    }
  }

}

export const inventoryController = new InventoryController();
