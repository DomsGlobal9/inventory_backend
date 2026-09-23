import crypto from 'crypto';
import { supabase } from '../../lib/supabase';
import { prepareImage } from '../../lib/imagePrep';
import { tryOnUsageService } from '../tryon';
import { shopperTryOnGatewayService, categoryFor } from './gateway.service';

/**
 * Putting a garment on a photograph of a person, when the photograph is handed to us.
 *
 * The scanned-tag flow takes a URL instead, because the try-on app owns its own storage and an
 * unauthenticated upload endpoint is a bucket anyone can fill. Two places now have a photograph in
 * hand and nowhere to put it -- a shopper on a shop page, and a salesperson at the counter with a
 * customer standing in front of them -- so this owns that one awkward step for both of them.
 *
 * ONE COPY, deliberately. The first version of this lived inside the online shop's module; the
 * counter needed exactly the same thing, and a second copy would have been two places to remember
 * the allowance check, two places to strip EXIF, and two places to delete the photograph. The
 * caller decides WHO may do it and WHICH garment; everything after that is the same work.
 *
 * THE PHOTOGRAPH DOES NOT LINGER. It is shrunk, stripped of the EXIF a selfie carries (which
 * includes where it was taken), stored under a name nobody can guess, and deleted the moment the
 * gateway has finished with it -- whether it worked, failed or timed out. The only reason it is
 * stored at all is that the gateway fetches by URL.
 */

const BUCKET = 'inventory-images';
const FOLDER = 'shop-tryon';

/**
 * Smaller than a product photograph on purpose. The gateway wants a person, not a poster, and
 * every extra megabyte is a slower try-on on a phone holding a photograph it just took.
 */
const LIMITS = {
  maxSide: 1280,
  maxBytes: 400 * 1024,
  tooBig: 'That photograph could not be made small enough. Try another one.'
};

export class TryOnWearError extends Error {
  constructor(message: string, readonly statusCode = 400) {
    super(message);
    this.name = 'TryOnWearError';
  }
}

export type WearGarment = { imageUrl: string; title: string; dressType?: string | null };

/** What the shop has left, so a screen can say so before anybody chooses a photograph. */
export async function allowanceFor(clientId: string) {
  const usage = await tryOnUsageService.summary(clientId, undefined, 'SHOPPER_TRYON');
  return {
    used: usage.generations,
    limit: usage.monthlyLimit,
    remaining: usage.remaining,
    approachingLimit: usage.approachingLimit,
    overLimit: usage.overLimit
  };
}

/**
 * One try-on, metered against this client.
 *
 * Counted exactly as the scanned-tag flow counts: one generation, `completed` on success and
 * `failed` on a breakage, so `completed + failed` bills the same however the customer reached it.
 */
export async function wearIt(params: {
  clientId: string;
  garment: WearGarment;
  photoBase64: unknown;
  /** For the log line only, so a failure can be traced to where it came from. */
  from: 'SHOP_PAGE' | 'COUNTER';
}): Promise<{ imageUrl: string; title: string }> {
  const { clientId, garment } = params;

  /*
   * The allowance first, before the photograph is even decoded.
   *
   * A shop out of try-ons should cost nothing at all to refuse -- not a decode, not an upload,
   * not a gateway call. It is also what makes accepting an upload defensible at all: there is a
   * finite number of times anybody can do it, and it is the shop's own number.
   */
  try {
    await tryOnUsageService.assertWithinLimit(clientId, 'SHOPPER_TRYON');
  } catch (e: any) {
    throw new TryOnWearError(
      e?.statusCode === 429
        ? 'This shop has used all its try-ons for now.'
        : 'Try-on is not available just now.',
      e?.statusCode === 429 ? 429 : 503
    );
  }

  const raw = typeof params.photoBase64 === 'string'
    ? params.photoBase64.replace(/^data:image\/[a-z+]+;base64,/i, '')
    : '';
  if (!raw) throw new TryOnWearError('Choose a photograph of the person first.');

  let buf: Buffer;
  try { buf = Buffer.from(raw, 'base64'); }
  catch { throw new TryOnWearError('That photograph did not arrive intact. Please choose it again.'); }

  let prepared;
  try {
    prepared = await prepareImage(buf, LIMITS);
  } catch (e: any) {
    throw new TryOnWearError(e?.message ?? 'That photograph could not be used. Try another one.');
  }

  const path = `${FOLDER}/${crypto.randomBytes(24).toString('hex')}.jpg`;
  const { error } = await supabase.storage.from(BUCKET).upload(path, prepared.jpeg, {
    contentType: 'image/jpeg',
    // Nothing should cache a picture of somebody that is about to be deleted.
    cacheControl: 'no-store',
    upsert: false
  });
  if (error) throw new TryOnWearError('That photograph could not be used just now. Please try again.', 503);

  const humanImageUrl = supabase.storage.from(BUCKET).getPublicUrl(path).data.publicUrl;

  try {
    const result = await shopperTryOnGatewayService.generate({
      clientId,
      garmentImageUrl: garment.imageUrl,
      humanImageUrl,
      category: categoryFor(garment.dressType)
    });

    // Counted after the fact and never awaited: the meter must not be able to fail the thing it
    // is counting.
    void tryOnUsageService.record(
      clientId, { started: true, completed: true, viewsGenerated: 1 }, 'SHOPPER_TRYON'
    );

    return { imageUrl: result.resultImageUrl, title: garment.title };
  } catch (e: any) {
    void tryOnUsageService.record(clientId, { started: true, failed: true }, 'SHOPPER_TRYON');
    // The gateway's own words may name internal services; the caller gets something to act on.
    console.error(`[TryOn] ${params.from} generation failed for ${clientId}:`, e?.message);
    throw new TryOnWearError(
      e?.statusCode === 429
        ? 'This shop has used all its try-ons for now.'
        : 'That did not work. Try a clear, full-length photograph taken straight on.',
      e?.statusCode === 429 ? 429 : 502
    );
  } finally {
    /*
     * The photograph goes, always. Not awaited into the answer -- nobody should wait on our
     * tidying -- but it does happen, on every path out of here.
     */
    void supabase.storage.from(BUCKET).remove([path]).catch(() => undefined);
  }
}
