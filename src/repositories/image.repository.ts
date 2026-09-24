import { prisma } from '../lib/prisma';
import { Prisma, ProductImage } from '@prisma/client';

export class ImageRepository {
  
  async create(data: Prisma.ProductImageUncheckedCreateInput): Promise<ProductImage> {
    return prisma.productImage.create({ data });
  }

  /**
   * Every photograph of a product, the shop's own ones first.
   *
   * The one the shop marked as the main photograph leads -- that star is the shop saying which
   * picture represents this colour, and a list that ignores it makes the star do nothing.
   * `generated: asc` then puts false before true, so among the rest a real photograph of the
   * real garment comes before the model shots Try-On made. Ordered by createdAt last so
   * the result is stable -- several photographs of one colour share an orderIndex, and a list
   * that reshuffles itself between two reads is a list a shop cannot reorder.
   */
  async findManyByProduct(productId: string, clientId: string): Promise<ProductImage[]> {
    return prisma.productImage.findMany({
      where: { productId, product: { clientId, status: { notIn: ['TRASHED' as any] } } },
      orderBy: [{ isPrimary: 'desc' }, { generated: 'asc' }, { orderIndex: 'asc' }, { createdAt: 'asc' }]
    });
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
