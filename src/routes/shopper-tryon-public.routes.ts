import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { shopperTryOnGatewayService, shopperTryOnProductService } from '../services/shopper-tryon';
import { tryOnUsageService } from '../services/tryon';

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

const generateLimiter = rateLimit({
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

/**
 * What was scanned.
 *
 * Deliberately returns 404 for a product that does not exist, is not published, or has no
 * photograph. Those are three different things to us and the same thing to a stranger, and
 * telling them apart would turn this into a way to probe what a shop has.
 */
router.get('/:clientId/:productCode', lookupLimiter, async (req, res, next) => {
  try {
    const garment = await shopperTryOnProductService.resolve(
      String(req.params.clientId),
      String(req.params.productCode)
    );

    if (!garment) {
      return res.status(404).json({
        success: false,
        message: 'That code does not match anything available to try on.'
      });
    }

    res.json({
      success: true,
      data: {
        title: garment.title,
        productCode: garment.productCode,
        imageUrl: garment.imageUrl,
        category: garment.category
      }
    });
  } catch (error) {
    next(error);
  }
});

/**
 * One try-on.
 *
 * `humanImageUrl` is a photograph the shopper has already uploaded -- the try-on app owns that
 * step and its own storage. We deliberately do not accept the image itself: an unauthenticated
 * upload endpoint is a bucket anyone can fill, and there is no reason to own that risk to save
 * a hop.
 */
router.post('/:clientId/:productCode/generate', generateLimiter, async (req, res, next) => {
  const clientId = String(req.params.clientId);
  const productCode = String(req.params.productCode);

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

    // Resolved from the code rather than taken from the request. If the garment came from the
    // body, anyone could ask us to try on any image at all, at this shop's expense.
    const garment = await shopperTryOnProductService.resolve(clientId, productCode);
    if (!garment) {
      return res.status(404).json({
        success: false,
        message: 'That code does not match anything available to try on.'
      });
    }

    // Checked before anything is started, so a shop out of allowance costs nothing and the
    // shopper is told rather than left waiting.
    await tryOnUsageService.assertWithinLimit(clientId, 'SHOPPER_TRYON');

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

    res.json({
      success: true,
      data: { resultImageUrl: result.resultImageUrl, title: garment.title }
    });
  } catch (error: any) {
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
    next(error);
  }
});

export default router;
