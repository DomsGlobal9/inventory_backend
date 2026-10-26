import { prisma } from '../lib/prisma';
import { literal } from '../utils/likeText';
import { ProductCategory } from '@prisma/client';
import { Product, ProductVariant, InventoryTransaction } from '@prisma/client';

export class SearchRepository {

  /**
   * Universal search across products and variants.
   * Prioritizes exact matches on identifiers (barcode, variantCode, productCode, sku),
   * then falls back to fuzzy title search.
   */
  async globalSearch(clientId: string, query: string) {
    const q = query.trim();
    /*
     * Typed text, taken literally. A case-insensitive equals is a LIKE in the database, so a lone "\\" crashed
     * the search (500) and "%" matched every product as an "exact" code (26 Oct worst-case run).
     */
    const lit = literal(q);

    // 1. EXACT MATCHES FIRST (Identifiers)
    // Identifier matches are case-INSENSITIVE. A hardware scanner transmits exactly what
    // the barcode encodes, so case never mattered for scanning -- but this same box invites
    // typing ("Search products, SKU, barcode..."), and a typed `svm-46p3d3tj` used to find
    // nothing while every other search bar in the app (/variants/search,
    // /inventory/variants) matched it. This makes global search agree with them.
    const exactProducts = await prisma.product.findMany({
      where: {
        clientId,
        status: { notIn: ['TRASHED'] as any },
        productCode: { equals: lit, mode: 'insensitive' }
      },
      include: {
        images: {
          // Oldest first: the primary is per colour now, so without an order this returned an
          // arbitrary colour -- and a different one on a different day.
          where: { isPrimary: true },
          orderBy: { createdAt: 'asc' as const },
          take: 1
        }
      }
    });

    const exactVariants = await prisma.productVariant.findMany({
      where: {
        clientId,
        product: { status: { notIn: ['TRASHED'] as any } },
        OR: [
          { barcode: { equals: lit, mode: 'insensitive' } },
          { variantCode: { equals: lit, mode: 'insensitive' } },
          { sku: { equals: lit, mode: 'insensitive' } }
        ]
      },
      include: {
        product: {
          include: {
            images: {
              where: { isPrimary: true },
              orderBy: { createdAt: 'asc' as const },
              take: 1
            }
          }
        }
      }
    });

    // If we found exact matches, return them immediately (Scanner Optimization)
    if (exactProducts.length > 0 || exactVariants.length > 0) {
      return { products: exactProducts, variants: exactVariants, transactions: [] };
    }

    // 2. FUZZY MATCHES (Titles and Attributes) - Only if no exact matches
    const fuzzyProducts = await prisma.product.findMany({
      where: {
        clientId,
        status: { notIn: ['TRASHED'] as any },
        OR: [
          { title: { contains: lit, mode: 'insensitive' } },
          ...(Object.values(ProductCategory).includes(q.toUpperCase() as any) ? [{ category: { equals: q.toUpperCase() as any } }] : [])
        ]
      },
      include: {
        images: {
          // Oldest first: the primary is per colour now, so without an order this returned an
          // arbitrary colour -- and a different one on a different day.
          where: { isPrimary: true },
          orderBy: { createdAt: 'asc' as const },
          take: 1
        }
      },
      take: 20
    });

    const fuzzyVariants = await prisma.productVariant.findMany({
      where: {
        clientId,
        product: { status: { notIn: ['TRASHED'] as any } },
        OR: [
          { colorName: { contains: lit, mode: 'insensitive' } }
        ]
      },
      include: {
        product: {
          include: {
            images: {
              where: { isPrimary: true },
              take: 1
            }
          }
        }
      },
      take: 20
    });

    return { products: fuzzyProducts, variants: fuzzyVariants, transactions: [] };
  }
}

export const searchRepository = new SearchRepository();
