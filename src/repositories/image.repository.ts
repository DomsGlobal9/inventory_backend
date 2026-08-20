import { prisma } from '../lib/prisma';
import { Prisma, ProductImage } from '@prisma/client';

export class ImageRepository {
  
  async create(data: Prisma.ProductImageUncheckedCreateInput): Promise<ProductImage> {
    return prisma.productImage.create({ data });
  }

  async findManyByProduct(productId: string, clientId: string): Promise<ProductImage[]> {
    return prisma.productImage.findMany({
      where: { productId, product: { clientId, status: { notIn: ['TRASHED' as any] } } },
      orderBy: { createdAt: 'asc' }
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
