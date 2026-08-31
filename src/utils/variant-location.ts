import { ProductVariant } from '@prisma/client';

type VariantWithProfiles = ProductVariant & {
  locationProfiles?: any[];
};

/**
 * Resolves the effective visibility and pricing for a variant at a specific location,
 * falling back to global settings if no specific profile exists.
 */
export function resolveVariantForLocation(variant: VariantWithProfiles, locationId: string) {
  const profile = variant.locationProfiles?.find((p) => p.locationId === locationId);

  // If no profile exists, default to Available + Global Price
  if (!profile) {
    return {
      isAvailable: true,
      price: variant.sellingPrice ? Number(variant.sellingPrice) : null,
      hasOverride: false
    };
  }

  // If profile exists, use its availability and its price override (fallback to global price if null)
  return {
    isAvailable: profile.isAvailable,
    price: profile.priceOverride !== null 
      ? Number(profile.priceOverride) 
      : (variant.sellingPrice ? Number(variant.sellingPrice) : null),
    hasOverride: profile.priceOverride !== null
  };
}
