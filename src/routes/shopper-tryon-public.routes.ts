import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { shopperTryOnGatewayService, shopperTryOnProductService } from '../services/shopper-tryon';
import { tryOnUsageService } from '../services/tryon';
import { garmentTryOns } from '../services/garment-tryons';
import { shopperFor, asksForNumber, NumberNeededError } from '../services/shopper-tryon/who.service';
import { sendCode, checkCode, whoIs } from '../services/online-shop/otp';
import { OnlineShopRuleError } from '../services/online-shop/rules';
import * as shopViews from '../services/shop-views';

/**
 * Try-On, as a shopper reaches it: scan the QR code on a garment, upload a photograph of
 * yourself, see yourself wearing it.
 *
 * PUBLIC. Mounted ahead of the global `authenticate`, because the person using it is a
 * customer standing in a shop with no account and no reason to make one. That makes this the
 * most exposed surface in the service, and it is written accordingly:
 *
 *   - THE KEY NEVER LEAVES THIS SERVER. The page could call the gateway directly and save a
 *     hop, but only by holding the shop's key in a browser, where anyone who scanned the code
 *     could read it. The whole point of issuing a key per client is that it identifies that
 *     client; published in a page, it identifies nobody.
 *   - Generations are rate limited far below the global 100/minute. A try-on is GPU time, and
 *     the global limit is sized for a merchant clicking around an inventory screen, not for
 *     something each request of which costs real money.
 *   - Every outcome is metered against the shop whose code was scanned, so the console shows
 *     which shops customers are actually using this on.
 *   - Nothing about the shop is disclosed beyond the garment on the tag.
 */

const router = Router();

/**
 * Looking at a garment is cheap; generating is not. Two limits, sized to what each costs.
 *
 * Keyed on IP, like the global limiter, and for the same reason: there is no authenticated
 * identity here to key on, and anything the caller supplies can be rotated to dodge the limit
 * or forged to exhaust someone else's.
 */
const lookupLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many requests. Please wait a moment.' }
});

/*
 * Whether this request comes from a proved WhatsApp number (the pass from the code). Asked once per
 * request and kept on it, for the two limits below.
 */
const provedNumber = async (req: any): Promise<boolean> => {
  if (req._provedNumber === undefined) req._provedNumber = !!(await whoIs(String(req.params.clientId ?? ''), req.body?.token).catch(() => null));
  return req._provedNumber;
};

const generateLimiter = rateLimit({
  // Not for a proved number: that shopper is counted by the limit below instead, per number.
  skip: provedNumber,
  windowMs: 10 * 60 * 1000,
  // Enough for a shopper to try a few photographs and change their mind; not enough for one
  // address to burn a shop's monthly allowance in an afternoon.
  max: 8,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    message: 'That is a lot of try-ons in a short time. Please wait a few minutes and try again.'
  }
});

/*
 * A shopper who proved their number gets room for a whole TryOn2Buy list (up to 10 pieces) and a
 * retry or two: 30 in 10 minutes, counted per number rather than per address -- a shop's wifi is one
 * address for every customer in it. Somebody who has not proved a number stays at the 8 above.
 */
const provedLimiter = rateLimit({
  skip: async (req) => !(await provedNumber(req)),
  windowMs: 10 * 60 * 1000,
  max: 30,
  keyGenerator: (req) => `proved:${String(req.params.clientId)}:${String(req.body?.token ?? '')}`,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    message: 'That is a lot of try-ons in a short time. Please wait a few minutes and try again.'
  }
});

/**
 * What was scanned.
 *
 * Deliberately returns 404 for a product that does not exist, is not published, or has no
 * photograph. Those are three different things to us and the same thing to a stranger, and
 * telling them apart would turn this into a way to probe what a shop has.
 */
router.get('/:clientId/:productCode', lookupLimiter, async (req, res, next) => {
  try {
    /*
     * ?variant= is what a swing tag carries. Optional, and a scan without it -- every tag printed
     * before this existed -- resolves exactly as it always did.
     */
    const garment = await shopperTryOnProductService.resolve(
      String(req.params.clientId),
      String(req.params.productCode),
      typeof req.query.variant === 'string' ? req.query.variant : null
    );

    if (!garment) {
      return res.status(404).json({
        success: false,
        message: 'That code does not match anything available to try on.'
      });
    }

    /*
     * The colours this garment comes in, so the page can ask which one before trying anything on.
     *
     * A product QR names no colour, so the try-on used the cover -- a shopper at a rack of the
     * same saree in five colours saw themselves in whichever one the shop leads with, and nothing
     * said so. Fetched even when the scan DID name a colour, so the page can offer the others: a
     * customer holding the crimson one is exactly the person who wants to see the indigo.
     */
    const colours = await shopperTryOnProductService.coloursFor(
      String(req.params.clientId),
      String(req.params.productCode)
    );

    res.json({
      success: true,
      data: {
        title: garment.title,
        productCode: garment.productCode,
        imageUrl: garment.imageUrl,
        category: garment.category,
        // One entry per colour, with a picture. Empty for a garment that has no variants at all,
        // which the page reads as "nothing to choose" rather than "something went wrong".
        colours,
        // The shopper proves their WhatsApp number before trying on (28 Oct), when this shop can send
        // a code. False for a shop whose WhatsApp is not linked: its try-ons stay anonymous, as before.
        needsNumber: await asksForNumber(String(req.params.clientId)),
        // So the page can say which colour it is showing, rather than leaving a shopper to
        // wonder whether the tag they scanned was the one they are holding.
        ...(garment.variantCode ? { variantCode: garment.variantCode, colourName: garment.colourName ?? null } : {})
      }
    });
  } catch (error) {
    next(error);
  }
});

/*
 * Proving the shopper's number, before a try-on: the same codes the online shop's checkout uses
 * (services/online-shop/otp), sent on WhatsApp from the shop's own number. Counted tightly per
 * caller, and per number inside sendCode: a code goes to somebody's phone.
 */
const codeLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 8,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many attempts just now. Wait a few minutes and try again.' }
});

const refusal = (res: any, error: any) => {
  if (error instanceof OnlineShopRuleError) {
    return res.status(400).json({ success: false, message: error.message, ...(error instanceof NumberNeededError ? { needsNumber: true } : {}) });
  }
  return null;
};

router.post('/:clientId/verify/send', codeLimiter, async (req, res, next) => {
  try {
    res.json({ success: true, data: await sendCode(String(req.params.clientId), req.body?.phone, 'TRYON') });
  } catch (error) { if (!refusal(res, error)) next(error); }
});

router.post('/:clientId/verify/check', codeLimiter, async (req, res, next) => {
  try {
    // { verified, token }: the page keeps the token and sends it with each try-on.
    res.json({ success: true, data: await checkCode(String(req.params.clientId), req.body?.phone, req.body?.code) });
  } catch (error) { if (!refusal(res, error)) next(error); }
});

/**
 * A heart on a try-on (TryOn2Buy's list): this proved number likes this piece, or no longer does.
 * Saved for the shop's Customer card. A shop that does not ask for numbers saves nothing and says so
 * ({ saved: false }) -- the heart still works on the phone.
 */
// Hearts are cheap and tapped often (on, off, on): their own limit, per address.
const likeLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many taps just now. Wait a moment and try again.' }
});

router.post('/:clientId/:productCode/liked', likeLimiter, async (req, res, next) => {
  try {
    const saved = await shopViews.like(String(req.params.clientId), req.body?.token, String(req.params.productCode), req.body?.liked !== false, req.body?.variant);
    res.json({ success: true, data: { saved } });
  } catch (error) { if (!refusal(res, error)) next(error); }
});

/**
 * One try-on.
 *
 * `humanImageUrl` is a photograph the shopper has already uploaded -- the try-on app owns that
 * step and its own storage. We deliberately do not accept the image itself: an unauthenticated
 * upload endpoint is a bucket anyone can fill, and there is no reason to own that risk to save
 * a hop.
 */
router.post('/:clientId/:productCode/generate', generateLimiter, provedLimiter, async (req, res, next) => {
  const clientId = String(req.params.clientId);
  const productCode = String(req.params.productCode);
  // Set once the generation is under way, so a refusal before it (no photograph, no garment, at
  // the limit) is not counted as a try-on of this garment.
  let started: { productId: string; colour: string | null } | null = null;

  try {
    const humanImageUrl = String(req.body?.humanImageUrl ?? '').trim();
    // https only, and checked before anything else: this URL is handed to the gateway, which
    // will fetch it. Accepting an arbitrary scheme here would let a stranger aim our gateway
    // at http://localhost or a file path through someone else's infrastructure.
    if (!/^https:\/\/[^\s]+$/i.test(humanImageUrl)) {
      return res.status(400).json({
        success: false,
        message: 'A photograph is needed before we can try this on.'
      });
    }

    /*
     * Resolved from the code rather than taken from the request. If the garment came from the
     * body, anyone could ask us to try on any image at all, at this shop's expense.
     *
     * The COLOUR does come from the request, and safely: it is a variant code, matched inside
     * resolve against this product's own variants and dropped if it does not belong to them. It
     * was not passed at all before, so a swing tag that correctly SHOWED the goldenrod one
     * generated the shopper wearing the cover -- the lookup honoured the colour and the
     * generation quietly ignored it.
     */
    const garment = await shopperTryOnProductService.resolve(
      clientId,
      productCode,
      typeof req.body?.variant === 'string' ? req.body.variant : null
    );
    if (!garment) {
      return res.status(404).json({
        success: false,
        message: 'That code does not match anything available to try on.'
      });
    }

    // Who, before anything is spent: a proved number when the shop can send codes, else anonymous.
    const shopper = await shopperFor(clientId, req.body?.token);

    // Checked before anything is started, so a shop out of allowance costs nothing and the
    // shopper is told rather than left waiting.
    await tryOnUsageService.assertWithinLimit(clientId, 'SHOPPER_TRYON');

    started = { productId: garment.productId, colour: garment.wornColour };
    const result = await shopperTryOnGatewayService.generate({
      clientId,
      garmentImageUrl: garment.imageUrl,
      humanImageUrl,
      category: garment.category
    });

    // One try-on produced one image. Recorded after the fact and never awaited -- the meter
    // must not be able to fail the thing it is counting.
    void tryOnUsageService.record(
      clientId, { started: true, completed: true, viewsGenerated: 1 }, 'SHOPPER_TRYON'
    );
    void garmentTryOns.record(clientId, started, 'TAG', true);
    // Against their number too, for their Customer card and CRM. Never fails the try-on.
    if (shopper) {
      void shopViews.seen(clientId, req.body?.token, productCode, 'TRYON', req.body?.variant)
        .catch(e => console.error('[tryon] a try-on was not recorded for the shopper:', (e as Error)?.message));
    }

    res.json({
      success: true,
      data: { resultImageUrl: result.resultImageUrl, title: garment.title }
    });
  } catch (error: any) {
    // No proved number yet (or a code-refusal): the page shows the number step. Nothing was started.
    if (refusal(res, error)) return;

    // Checked BEFORE recording a failure, for the same reason as the catalog flow: a refusal
    // at the limit was never started, and counting it would push a shop further past a ceiling
    // it cannot get back under.
    if (error?.statusCode === 429) {
      return res.status(429).json({
        success: false,
        message: 'This shop has used its try-ons for this month.'
      });
    }

    // Anything else broke after we committed to it. The GPU time was spent either way, and a
    // shop whose key is wrong must show as failing rather than as unused.
    void tryOnUsageService.record(clientId, { started: true, failed: true }, 'SHOPPER_TRYON');
    if (started) void garmentTryOns.record(clientId, started, 'TAG', false);
    next(error);
  }
});

export default router;
