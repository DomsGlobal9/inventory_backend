import { Request, Response } from 'express';
import { variantLocationService } from '../services/variant-location.service';
import { respondWithError } from '../utils/respondWithError';
import { isWholePaise, PAISA_MESSAGE, MAX_PRICE } from '../validations/money';

export const upsertVariantLocationProfile = async (req: Request, res: Response) => {
  try {
    const clientId = (req as any).clientId as string;
    const productId = req.params.productId as string;
    const variantId = req.params.variantId as string;
    const locationId = req.params.locationId as string;
    const { isAvailable, priceOverride } = req.body;

    // Answered as { message }, which is what the app reads. These went back as { error } and the
    // screen could only say "Failed to update settings" about a price it had been told was wrong.
    const refuse = (message: string) => res.status(400).json({ success: false, message, error: message });
    // Missing and blank both mean "no store price": sell at the item's own price.
    const blank = priceOverride === undefined || priceOverride === null || priceOverride === '';
    const price = blank ? null : Number(priceOverride);
    if (price !== null && !Number.isFinite(price)) return refuse('Type the store price as a number, for example 1499.');
    if (price !== null && price < 0) return refuse('A price cannot be less than zero.');
    // The column holds up to 99,999,999.99; beyond that the save failed as a server error.
    if (price !== null && price > MAX_PRICE) return refuse('That price is too large. The most a piece can cost is ₹9,99,99,999.');
    if (price !== null && !isWholePaise(price)) return refuse(PAISA_MESSAGE);

    const profile = await variantLocationService.upsertLocationProfile(
      clientId,
      productId,
      variantId,
      locationId,
      { isAvailable: Boolean(isAvailable), priceOverride: price }
    );

    res.json(profile);
  } catch (error: any) {
    return respondWithError(res, error, { status: 500 });
  }
};
