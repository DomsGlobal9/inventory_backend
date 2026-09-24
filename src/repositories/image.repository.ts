import { prisma } from '../lib/prisma';
import { Prisma, ProductImage } from '@prisma/client';

export class ImageRepository {
  
  async create(data: Prisma.ProductImageUncheckedCreateInput): Promise<ProductImage> {
    return prisma.productImage.create({ data });
  }

  /**
   * Every photograph of a product, in the order a shopper meets them.
   *
   *   1. the one the shop starred    -- that star is the shop saying "this one"
   *   2. the model shots, front first -- front, sitting, side, back
   *   3. the shop's own photographs   -- the flat-lay, the border, the weave
   *
   * The same order the shop page uses (see storefront-catalogue.service.ts), so the Images tab
   * and the shop agree about what leads. This first put the shop's own photographs first, on the
   * reasoning that a real photograph beats a generated one -- true of provenance, wrong for a
   * shop window, where somebody deciding on a saree wants to see it on a person.
   *
   * Sorted here rather than in the query: "front, sitting, side, back" is not an order any column
   * sorts into, and createdAt keeps it stable, because several photographs of one colour share an
   * orderIndex and a list that reshuffles itself between two reads cannot be reordered by hand.
   */
  async findManyByProduct(productId: string, clientId: string): Promise<ProductImage[]> {
    const rows = await prisma.productImage.findMany({
      where: { productId, product: { clientId, status: { notIn: ['TRASHED' as any] } } },
      orderBy: [{ orderIndex: 'asc' }, { createdAt: 'asc' }]
    });
    const VIEW_ORDER: Record<string, number> = { front: 0, left: 1, right: 2, back: 3 };
    const rank = (i: ProductImage) =>
      i.isPrimary ? -1 : i.generated ? (VIEW_ORDER[i.view ?? ''] ?? 4) : 10;
    return rows
      .map((img, i) => ({ img, i }))
      .sort((a, b) => rank(a.img) - rank(b.img) || a.i - b.i)
      .map(x => x.img);
  }

  async findById(id: string, clientId: string): Promise<ProductImage | null> {
    return prisma.productImage.findFirst({
      where: { id, product: { clientId } }
    });
  }

  async update(id: string, data: Prisma.ProductImageUpdateInput): Promise<ProductImage> {
    return prisma.productImage.update({
      where: { id },
      data
    });
  }

  async delete(id: string, clientId: string): Promise<ProductImage> {
    // Ensure image belongs to a product owned by this client
    const existing = await this.findById(id, clientId);
    if (!existing) throw new Error("Image not found");

    return prisma.productImage.delete({ where: { id } });
  }
}

export const imageRepository = new ImageRepository();
