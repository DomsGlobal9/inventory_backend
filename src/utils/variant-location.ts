import { ProductVariant } from '@prisma/client';

type VariantWithProfiles = ProductVariant & {
  locationProfiles?: any[];
};

/**
 * Resolves the effective visibility and pricing for a variant at a specific location,
 * falling back to global settings if no specific profile exists.
 *
 * Price fallback chain: location price override -> variant's own sellingPrice ->
 * the product's basePrice -> null. Without the basePrice step, a variant that was
 * never given its own sellingPrice used to resolve to a null/0 price -- charging
 * customers nothing for a real item. `basePrice` is optional only for callers that
 * haven't loaded the parent product; omitting it reproduces the old (buggy) behavior,
 * so always pass it when available.
 */
export function resolveVariantForLocation(variant: VariantWithProfiles, locationId: string, basePrice?: number | null) {
  const globalPrice = variant.sellingPrice ? Number(variant.sellingPrice) : (basePrice ?? null);
  const profile = variant.locationProfiles?.find((p) => p.locationId === locationId);

  // If no profile exists, default to Available + Global Price
  if (!profile) {
    return {
      isAvailable: true,
      price: globalPrice,
      hasOverride: false
    };
  }

  // If profile exists, use its availability and its price override (fallback to global price if null)
  return {
    isAvailable: profile.isAvailable,
    price: profile.priceOverride !== null ? Number(profile.priceOverride) : globalPrice,
    hasOverride: profile.priceOverride !== null
  };
}
