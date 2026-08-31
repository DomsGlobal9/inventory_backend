import { prisma } from '../lib/prisma';

export class VariantLocationService {
  async upsertLocationProfile(clientId: string, productId: string, variantId: string, locationId: string, data: { isAvailable: boolean, priceOverride: number | null }) {
    // 1. Validate the location belongs to this client
    const location = await prisma.stockLocation.findFirst({ where: { id: locationId, clientId } });
    if (!location) throw new Error('Location not found or access denied');

    // 2. Validate the variant belongs to the client and product
    const variant = await prisma.productVariant.findFirst({
      where: { id: variantId, productId, clientId }
    });
    if (!variant) throw new Error('Variant not found or access denied');

    // 3. Upsert the profile
    return prisma.variantLocationProfile.upsert({
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
  }
}

export const variantLocationService = new VariantLocationService();
