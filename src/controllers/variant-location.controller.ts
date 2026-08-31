import { Request, Response } from 'express';
import { variantLocationService } from '../services/variant-location.service';

export const upsertVariantLocationProfile = async (req: Request, res: Response) => {
  try {
    const clientId = (req as any).clientId as string;
    const productId = req.params.productId as string;
    const variantId = req.params.variantId as string;
    const locationId = req.params.locationId as string;
    const { isAvailable, priceOverride } = req.body;

    if (priceOverride !== null && priceOverride < 0) {
      return res.status(400).json({ error: 'Price override cannot be negative' });
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
    res.status(500).json({ error: error.message });
  }
};
