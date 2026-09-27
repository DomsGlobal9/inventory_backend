/**
 * What a till may ask Inventory for, and tell it.
 *
 * Mounted ahead of the human `authenticate` gate, exactly like the storefront routes: the caller
 * is a till holding a connection credential, not a person with a session cookie. The same
 * middleware, the same scoping -- a POS connection cannot see another tenant and cannot see beyond
 * the locations it was given.
 *
 *   GET  /pos/catalogue        the storefront feed plus HSN, tax rate and integer paise
 *   GET  /pos/stock?codes=     live availability for a handful of codes
 *   POST /pos/events           a sale or a return the till has already completed
 *
 * WHY NOT A NEW CREDENTIAL SYSTEM. StorefrontConnection already does per-client credentials with a
 * hashed secret, a non-secret prefix so a shopkeeper can recognise their own key in a support
 * call, a status, and a locationIds scope. A till needs exactly those, so it gets exactly those.
 */

import { Router, Request, Response, NextFunction } from 'express';
import { authenticateStorefront, storefrontContext } from '../middleware/storefront.middleware';
import { listForPos, stockForPos } from '../services/pos/pos-catalogue.service';
import { checkReturnAmounts, type PosEventResult } from '../services/pos/pos-events.service';

const router = Router();

router.use(authenticateStorefront);

/**
 * One page of the catalogue.
 *
 * `since` makes it incremental: a till that synced this morning asks for what changed, not for
 * four hundred sarees again.
 */
router.get('/catalogue', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const ctx = storefrontContext(req, res);
    if (!ctx) return;

    const limit = req.query.limit ? Number(req.query.limit) : undefined;
    if (limit !== undefined && (!Number.isFinite(limit) || limit < 1)) {
      res.status(400).json({ success: false, message: '`limit` must be a positive number.' });
      return;
    }

    let since: Date | undefined;
    if (req.query.since) {
      since = new Date(String(req.query.since));
      if (Number.isNaN(since.getTime())) {
        res.status(400).json({ success: false, message: '`since` must be an ISO 8601 timestamp.' });
        return;
      }
    }

    const page = await listForPos(
      { clientId: ctx.clientId, locationIds: ctx.locationIds },
      { cursor: req.query.cursor ? String(req.query.cursor) : undefined, limit, since }
    );

    res.json({ success: true, data: page });
  } catch (error) { next(error); }
});

/**
 * Availability for specific codes, for the moment a till is about to promise the last piece.
 *
 * Capped at 200 codes: this is "is the last one still there", not a second way to pull the whole
 * catalogue.
 */
router.get('/stock', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const ctx = storefrontContext(req, res);
    if (!ctx) return;

    const raw = String(req.query.codes ?? '').trim();
    if (!raw) {
      res.status(400).json({ success: false, message: 'Give `codes` as a comma-separated list.' });
      return;
    }

    const rows = await stockForPos(
      { clientId: ctx.clientId, locationIds: ctx.locationIds },
      raw.split(',')
    );
    res.json({ success: true, data: rows });
  } catch (error) { next(error); }
});

/**
 * A sale or a return the till has already completed.
 *
 * One event at a time, in the POS's own order. Delivery is at-least-once, so every answer here is
 * safe to arrive twice: ALREADY_APPLIED is a success, not a complaint.
 *
 * THE ANSWER CODES ARE THE CONTRACT. APPLIED and ALREADY_APPLIED mean carry on. Everything else is
 * permanent and stops that shop's queue for a person, because the alternative -- retrying a
 * payload that will never work -- buries the one event somebody needs to look at under thousands
 * of attempts.
 */
router.post('/events', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const ctx = storefrontContext(req, res);
    if (!ctx) return;

    const event = req.body ?? {};
    const kind = String(event.kind ?? '');

    if (kind === 'sale.returned') {
      /*
       * Checked BEFORE anything is written. A return refers to a bill Inventory already holds, so
       * unlike a sale there is a second opinion available -- and a refund that quietly differs
       * between the two systems is the kind of disagreement that surfaces months later in a
       * reconciliation nobody can unpick.
       */
      const problem = await checkReturnAmounts(
        ctx.clientId,
        String(event.againstInvoiceNo ?? ''),
        Array.isArray(event.lines) ? event.lines : []
      );
      if (problem) {
        res.status(422).json({ success: false, data: problem });
        return;
      }
      const notYet: PosEventResult = {
        answer: 'BAD_PAYLOAD',
        detail: 'Returns are checked but not yet applied here. The amounts agree; the write is the next step.'
      };
      res.status(422).json({ success: false, data: notYet });
      return;
    }

    if (kind === 'sale.completed' || kind === 'sale.exchanged') {
      const notYet: PosEventResult = {
        answer: 'BAD_PAYLOAD',
        detail: 'This endpoint is not finished. Nothing has been recorded.'
      };
      res.status(422).json({ success: false, data: notYet });
      return;
    }

    res.status(400).json({
      success: false,
      data: { answer: 'BAD_PAYLOAD', detail: `Unknown event kind "${kind}".` } as PosEventResult
    });
  } catch (error) { next(error); }
});

export default router;
