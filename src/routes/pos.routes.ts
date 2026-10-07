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
import sharp from 'sharp';
import { authenticateStorefront, onlyPos, storefrontContext } from '../middleware/storefront.middleware';
import { quoteForTill } from '../services/pos/pos-quote.service';
import * as holds from '../services/pos/pos-holds.service';
import * as upiQr from '../services/pos/pos-upi-qr.service';
import { paymentAccounts } from '../services/payments/account.service';
import { getShopSettings } from '../lib/clientSettings';
import { prisma } from '../lib/prisma';
import { listForPos, stockForPos } from '../services/pos/pos-catalogue.service';
import { checkReturnAmounts, exchangeTooEarly, type PosEventResult } from '../services/pos/pos-events.service';
import { acceptSale, acceptReturn, acceptPaymentUpdate, acceptExchange, acceptSkip, saleStatus } from '../services/pos/pos-queue.service';
import { SKIP_KIND } from '../utils/posConnection';

const router = Router();

router.use(authenticateStorefront, onlyPos);

/**
 * One page of the catalogue.
 *
 * `since` makes it incremental: a till that synced this morning asks for what changed, not for
 * four hundred sarees again.
 */
/**
 * The shop's logo as a PNG (transparency kept, at most 400 px wide), converted on request so every
 * logo works, old or new, without a re-upload. Cached by the logo's own address: a new logo is a new
 * entry, and the old one simply stops being asked for.
 * ponytail: per-process cache, unbounded by count; fine at one small PNG per shop, an LRU if that grows.
 */
const printLogos = new Map<string, Promise<Buffer>>();
function printLogo(url: string): Promise<Buffer> {
  let made = printLogos.get(url);
  if (!made) {
    made = fetch(url)
      .then(r => { if (!r.ok) throw new Error(`logo fetch ${r.status}`); return r.arrayBuffer(); })
      .then(b => sharp(Buffer.from(b)).resize({ width: 400, withoutEnlargement: true }).png().toBuffer());
    printLogos.set(url, made);
    made.catch(() => printLogos.delete(url)); // a failure is not remembered: the next ask tries again
  }
  return made;
}

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

    /*
     * The shop's manual-discount limit rides with the catalogue, as an EXPLICIT shape: Inventory's
     * null means no limit, and the till's 0 means nothing without a manager -- a bare null read
     * into that column would turn the owner's choice into its opposite (contract, catalogue
     * addition). Measured by the till on the manual part of a bill only, never on an offer.
     */
    const [{ manualDiscountMaxPercent: max }, gst, store, payAccount, payReady] = await Promise.all([
      getShopSettings(ctx.clientId),
      prisma.clientSettings.findUnique({ where: { clientId: ctx.clientId }, select: { gstRegistration: true, gstStateCode: true, gstNumber: true, logoUrl: true, businessName: true, businessAddress: true, businessPhone: true, receiptFooter: true } }),
      prisma.stockLocation.findFirst({ where: { clientId: ctx.clientId, id: { in: ctx.locationIds } }, select: { address: true, phone: true } }),
      prisma.shopPaymentAccount.findUnique({ where: { clientId: ctx.clientId }, select: { upiQrEnabled: true } }),
      paymentAccounts.readiness(ctx.clientId)
    ]);
    if (gst?.logoUrl) printLogo(gst.logoUrl).catch(() => undefined);
    res.json({ success: true, data: {
      ...page,
      manualDiscount: max == null ? { unlimited: true } : { maxPercent: max },
      // REGULAR charges GST (a missing rate on an item is a gap to fill before it sells);
      // COMPOSITION and UNREGISTERED charge none, so a missing rate changes nothing there.
      //
      // null = the owner never said. The column defaults to UNREGISTERED, so a shop that never opened
      // the GST card reads exactly like one that chose "not registered" -- except that a GSTIN on
      // file cannot belong to an unregistered shop (the card refuses that pair). No settings row at
      // all, or UNREGISTERED beside a GSTIN: not chosen, and the till keeps its own.
      gst: {
        registration: !gst || (gst.gstRegistration === 'UNREGISTERED' && gst.gstNumber) ? null : gst.gstRegistration,
        stateCode: gst?.gstStateCode ?? null
      },
      // logoUrl for screens (any image type; uploads are stored as WebP). logoPrintUrl: the same logo
      // as a PNG, for documents that cannot embed WebP (the till's WhatsApp PDF). Same till key.
      // On only when the owner switched it on AND the Razorpay account can take money now.
      upiQr: { enabled: !!payAccount?.upiQrEnabled && payReady.ready },
      shop: {
        logoUrl: gst?.logoUrl ?? null,
        logoPrintUrl: gst?.logoUrl ? `${req.protocol}://${req.get('host')}${req.baseUrl}/logo-print` : null,
        // What the bill prints, from Settings -> Name, logo and bill details. The till's own store's
        // address and phone first, as Inventory's receipts do; the shop's when the store has none.
        name: gst?.businessName || null,
        address: store?.address || gst?.businessAddress || null,
        phone: store?.phone || gst?.businessPhone || null,
        gstin: gst?.gstNumber || null,
        receiptFooter: gst?.receiptFooter || null
      }
    } });
  } catch (error) { next(error); }
});

/**
 * The price after offers, for the basket in front of the cashier (contract §9).
 *
 * Advisory: the till sells with or without it. So a basket that cannot be priced at all is a
 * BAD_PAYLOAD it can act on, and anything else answers 200 with what could be priced.
 */
router.post('/quote', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const ctx = storefrontContext(req, res);
    if (!ctx) return;
    const answer = await quoteForTill(ctx.clientId, ctx.locationIds[0], req.body);
    res.json({ success: true, data: answer });
  } catch (error: any) {
    if (error?.statusCode === 400 || error?.statusCode === 404) {
      res.status(422).json({ success: false, data: { answer: 'BAD_PAYLOAD', detail: error.message } });
      return;
    }
    next(error);
  }
});

/**
 * Points and store credit at the till (contract §10): what may be spent on this bill, a reserve
 * before Complete, its confirm the moment the sale commits, and its release. Points are money, so
 * every refusal here is a plain line the cashier reads and the sale completes another way.
 */
const holdFailure = (res: Response, error: any) => {
  if (error?.answer && error?.statusCode) { res.status(error.statusCode).json({ success: false, data: { answer: error.answer, detail: error.message } }); return true; }
  if (error?.statusCode === 400) { res.status(422).json({ success: false, data: { answer: 'BAD_PAYLOAD', detail: error.message } }); return true; }
  return false;
};
/**
 * UPI QR at the till (pos-upi-qr.service): a QR for one bill that confirms itself, through the shop's
 * own Razorpay account. Every refusal is one plain line; the till then uses the shop's bank QR.
 */
router.post('/upi-qr', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const ctx = storefrontContext(req, res);
    if (!ctx) return;
    res.json({ success: true, data: await upiQr.createQr(ctx.clientId, ctx.connectionId, req.body) });
  } catch (error: any) { if (!holdFailure(res, error)) next(error); }
});
router.get('/upi-qr/:qrId', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const ctx = storefrontContext(req, res);
    if (!ctx) return;
    res.json({ success: true, data: await upiQr.status(ctx.clientId, String(req.params.qrId)) });
  } catch (error: any) { if (!holdFailure(res, error)) next(error); }
});
router.post('/upi-qr/:qrId/close', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const ctx = storefrontContext(req, res);
    if (!ctx) return;
    res.json({ success: true, data: await upiQr.close(ctx.clientId, String(req.params.qrId)) });
  } catch (error: any) { if (!holdFailure(res, error)) next(error); }
});

router.get('/wallet', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const ctx = storefrontContext(req, res);
    if (!ctx) return;
    res.json({ success: true, data: await holds.wallet(ctx.clientId, { customerRef: req.query.customerRef, billPaise: req.query.billPaise }) });
  } catch (error: any) { if (!holdFailure(res, error)) next(error); }
});
router.post('/holds', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const ctx = storefrontContext(req, res);
    if (!ctx) return;
    res.json({ success: true, data: await holds.reserve(ctx.clientId, ctx.connectionId, req.body) });
  } catch (error: any) { if (!holdFailure(res, error)) next(error); }
});
router.post('/holds/:holdId/confirm', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const ctx = storefrontContext(req, res);
    if (!ctx) return;
    res.json({ success: true, data: await holds.confirm(ctx.clientId, String(req.params.holdId), req.body) });
  } catch (error: any) { if (!holdFailure(res, error)) next(error); }
});
router.delete('/holds/:holdId', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const ctx = storefrontContext(req, res);
    if (!ctx) return;
    res.json({ success: true, data: await holds.release(ctx.clientId, String(req.params.holdId)) });
  } catch (error: any) { if (!holdFailure(res, error)) next(error); }
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
        /*
         * 409, not 422, when the sale is simply not applied yet. 422 says "this message is wrong
         * and will stay wrong"; a till that reads it that way would stop its queue over a race
         * that clears in two seconds. 409 says "not now, try again", which is the truth.
         */
        const retryable = problem.answer === 'SALE_NOT_YET_APPLIED';
        res.status(retryable ? 409 : 422).json({ success: false, data: problem });
        return;
      }
      /*
       * The amounts agree, so the return is taken in and written behind the answer -- the same
       * shape as a sale, for the same reason: the customer already has their money.
       *
       * The CHECK stays at the door rather than moving into the worker, and that asymmetry is
       * deliberate. A refund the two systems disagree about is the one disagreement worth stopping
       * a till for, it is the one thing a till cannot check for itself, and it costs three queries.
       * Everything after it is bookkeeping nobody is standing and waiting for.
       */
      const locationId = ctx.locationIds[0];
      if (!locationId) {
        res.status(422).json({
          success: false,
          data: { answer: 'BAD_PAYLOAD', detail: 'This connection has no location, so a return has nowhere to go back to.' } as PosEventResult
        });
        return;
      }

      const taken = await acceptReturn(ctx.clientId, locationId, event);
      if (taken.answer === 'ACCEPTED') {
        res.status(202).json({ success: true, data: taken });
        return;
      }
      const tookOk = taken.answer === 'APPLIED' || taken.answer === 'ALREADY_APPLIED';
      res.status(tookOk ? 200 : 422).json({ success: tookOk, data: taken });
      return;
    }

    if (kind === 'sale.completed') {
      /*
       * One location per connection in v1, so the till's location is the connection's. When a
       * shop has two tills this becomes the event's own locationCode, checked against the scope --
       * which is why the contract already carries the field.
       */
      const locationId = ctx.locationIds[0];
      if (!locationId) {
        res.status(422).json({
          success: false,
          data: { answer: 'BAD_PAYLOAD', detail: 'This connection has no location, so a sale has nowhere to come off.' } as PosEventResult
        });
        return;
      }

      /*
       * WRITTEN DOWN, THEN ANSWERED -- the till does not wait for the bookkeeping.
       *
       * Applying a sale is about thirty-seven round trips to Singapore, eight to twelve seconds
       * with a customer at the counter, and not one of those trips needs the customer present.
       * The POS has already taken the money and printed the bill. So the event is committed in
       * one round trip and the answer goes back at once; the worker applies it moments later.
       *
       * 202, not 200, because the difference is real and a till should be able to see it: the
       * sale is safely ours, and it has not been applied yet.
       */
      const out = await acceptSale(ctx.clientId, locationId, event);

      if (out.answer === 'ACCEPTED') {
        res.status(202).json({ success: true, data: out });
        return;
      }

      // A resend that arrived after the work finished gets the real answer, not a queue position.
      const ok = out.answer === 'APPLIED' || out.answer === 'ALREADY_APPLIED';
      res.status(ok ? 200 : 422).json({ success: ok, data: out });
      return;
    }

    if (kind === 'payment.updated') {
      /*
       * Money that arrived after the bill: a kept order's balance, a cheque that cleared, or a
       * reversal when one bounced. Nothing about it needs the customer present either.
       */
      const locationId = ctx.locationIds[0];
      if (!locationId) {
        res.status(422).json({
          success: false,
          data: { answer: 'BAD_PAYLOAD', detail: 'This connection has no location, so a payment has nowhere to be recorded.' } as PosEventResult
        });
        return;
      }
      const took = await acceptPaymentUpdate(ctx.clientId, locationId, event);
      if (took.answer === 'ACCEPTED') {
        res.status(202).json({ success: true, data: took });
        return;
      }
      const ok = took.answer === 'APPLIED' || took.answer === 'ALREADY_APPLIED';
      res.status(ok ? 200 : 422).json({ success: ok, data: took });
      return;
    }

    if (kind === 'sale.exchanged') {
      /*
       * A return and a sale in one act, applied in one transaction. Taken in like both of them,
       * for the same reason: the customer has already walked out with the difference.
       */
      const locationId = ctx.locationIds[0];
      if (!locationId) {
        res.status(422).json({
          success: false,
          data: { answer: 'BAD_PAYLOAD', detail: 'This connection has no location, so an exchange has nowhere to happen.' } as PosEventResult
        });
        return;
      }
      // The sale it is against may still be on its way: "not now, try again", never a queue stop.
      const early = await exchangeTooEarly(ctx.clientId, String(event.againstInvoiceNo ?? ''));
      if (early) {
        res.status(409).json({ success: false, data: early });
        return;
      }
      const swapped = await acceptExchange(ctx.clientId, locationId, event);
      if (swapped.answer === 'ACCEPTED') {
        res.status(202).json({ success: true, data: swapped });
        return;
      }
      const ok = swapped.answer === 'APPLIED' || swapped.answer === 'ALREADY_APPLIED';
      res.status(ok ? 200 : 422).json({ success: ok, data: swapped });
      return;
    }

    if (kind === SKIP_KIND) {
      // Recorded on the spot, not queued: it moves nothing, so there is nothing to wait for.
      const locationId = ctx.locationIds[0];
      if (!locationId) {
        res.status(422).json({
          success: false,
          data: { answer: 'BAD_PAYLOAD', detail: 'This connection has no location, so a left-out bill has nowhere to be noted.' } as PosEventResult
        });
        return;
      }
      const noted = await acceptSkip(ctx.clientId, locationId, event);
      const ok = noted.answer === 'APPLIED' || noted.answer === 'ALREADY_APPLIED';
      res.status(ok ? 200 : 422).json({ success: ok, data: noted });
      return;
    }

    res.status(400).json({
      success: false,
      data: { answer: 'BAD_PAYLOAD', detail: `Unknown event kind "${kind}".` } as PosEventResult
    });
  } catch (error) { next(error); }
});

/**
 * Where did that sale get to?
 *
 * The other half of answering before the work is done: a till that wants certainty can ask, and
 * anything watching a queue drain can see it drain. invoiceNo goes in the query string rather
 * than the path because a real one is "INV/2026-27/0001" and those slashes are not path
 * separators.
 */
router.get('/logo-print', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const ctx = storefrontContext(req, res);
    if (!ctx) return;
    const row = await prisma.clientSettings.findUnique({ where: { clientId: ctx.clientId }, select: { logoUrl: true } });
    if (!row?.logoUrl) { res.status(404).json({ success: false, data: { answer: 'NO_LOGO', detail: 'This shop has no logo. Add one in Inventory: Settings, Name, logo and bill details.' } }); return; }
    let png: Buffer;
    try { png = await printLogo(row.logoUrl); } catch {
      res.status(502).json({ success: false, data: { answer: 'LOGO_UNREACHABLE', detail: 'The logo could not be fetched just now. Try again shortly.' } });
      return;
    }
    res.set('Cache-Control', 'private, max-age=3600').type('png').send(png);
  } catch (error) { next(error); }
});

router.get('/events/status', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const ctx = storefrontContext(req, res);
    if (!ctx) return;

    const invoiceNo = String(req.query.invoiceNo ?? '').trim();
    if (!invoiceNo) {
      res.status(400).json({
        success: false,
        data: { answer: 'BAD_PAYLOAD', detail: 'Say which invoice, with ?invoiceNo=' } as PosEventResult
      });
      return;
    }

    const found = await saleStatus(ctx.clientId, invoiceNo);
    if (!found) {
      res.status(404).json({
        success: false,
        data: { answer: 'UNKNOWN_ORDER', detail: `Nothing here for invoice ${invoiceNo}.` } as PosEventResult
      });
      return;
    }
    res.json({ success: true, data: found });
  } catch (error) { next(error); }
});

export default router;
