import { Request, Response } from 'express';
import { variantLocationService } from '../services/variant-location.service';
import { respondWithError } from '../utils/respondWithError';

export const upsertVariantLocationProfile = async (req: Request, res: Response) => {
  try {
    const clientId = (req as any).clientId as string;
    const productId = req.params.productId as string;
    const variantId = req.params.variantId as string;
    const locationId = req.params.locationId as string;
    const { isAvailable, priceOverride } = req.body;

    if (priceOverride !== null && priceOverride < 0) {
      return res.status(400).json({ error: 'A price cannot be less than zero.' });
    }
    // The column holds up to 99,999,999.99; beyond that the save failed as a server error.
    if (priceOverride !== null && Number(priceOverride) > 99999999.99) {
      return res.status(400).json({ error: 'That price is too large. The most a piece can cost is ₹9,99,99,999.' });
    }

    const profile = await variantLocationService.upsertLocationProfile(
      clientId,
      productId,
      variantId,
      locationId,
      { isAvailable: Boolean(isAvailable), priceOverride: priceOverride === null ? null : Number(priceOverride) }
    );

    res.json(profile);
  } catch (error: any) {
    return respondWithError(res, error, { status: 500 });
  }
};
