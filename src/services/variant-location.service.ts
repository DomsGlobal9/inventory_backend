import { prisma } from '../lib/prisma';
import { storefrontEventService } from './storefront-event.service';
import { notFound } from '../utils/httpError';

export class VariantLocationService {
  async upsertLocationProfile(clientId: string, productId: string, variantId: string, locationId: string, data: { isAvailable: boolean, priceOverride: number | null }) {
    // 1. Validate the location belongs to this client
    const location = await prisma.stockLocation.findFirst({ where: { id: locationId, clientId } });
    if (!location) throw notFound('Location not found or access denied');

    // 2. Validate the variant belongs to the client and product
    const variant = await prisma.productVariant.findFirst({
      where: { id: variantId, productId, clientId }
    });
    if (!variant) throw notFound('Variant not found or access denied');

    // 3. Upsert the profile
    const profile = await prisma.variantLocationProfile.upsert({
      where: {
        variantId_locationId: {
          variantId,
          locationId
        }
      },
      update: {
        isAvailable: data.isAvailable,
        priceOverride: data.priceOverride
      },
      create: {
        variantId,
        locationId,
        isAvailable: data.isAvailable,
        priceOverride: data.priceOverride
      }
    });

    // isAvailable is the explicit "show this online" switch and priceOverride is what a
    // storefront charges, yet flipping either used to emit nothing at all -- the website
    // found out only when some unrelated stock movement happened to send an update, or never.
    // Not awaited: the profile is saved either way, and a notification must not be able to
    // fail the save that caused it.
    void storefrontEventService.availabilityChanged(clientId, variantId, locationId)
      .catch(err => console.error('[StorefrontEvents] availabilityChanged failed', err));

    return profile;
  }
}

export const variantLocationService = new VariantLocationService();
