import { imageRepository } from '../repositories/image.repository';
import { productRepository } from '../repositories/product.repository';
import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { supabase } from '../lib/supabase';

export class ImageService {

  async addImage(productId: string, clientId: string, data: any) {
    const product = await productRepository.findById(productId, clientId);
    if (!product) throw { statusCode: 404, message: "Product not found" };

    const imageData: Prisma.ProductImageUncheckedCreateInput = {
      productId,
      url: data.url,
      storagePath: data.storagePath,
      fileName: data.fileName,
      fileSize: data.fileSize,
      altText: data.altText,
      isPrimary: data.isPrimary,
      imageType: data.imageType,
      orderIndex: data.orderIndex
    };

    // A product can only have one primary image -- clear any existing one first so
    // creating a new primary (e.g. every publish/regenerate cycle) doesn't just stack
    // up multiple PRIMARY badges instead of replacing the old one.
    if (imageData.isPrimary) {
      return prisma.$transaction(async (tx) => {
        await tx.productImage.updateMany({ where: { productId, isPrimary: true }, data: { isPrimary: false } });
        return tx.productImage.create({ data: imageData });
      });
    }

    return imageRepository.create(imageData);
  }

  async getImages(productId: string, clientId: string) {
    return imageRepository.findManyByProduct(productId, clientId);
  }

  async updateImage(id: string, clientId: string, data: any) {
    const image = await imageRepository.findById(id, clientId);
    if (!image) throw { statusCode: 404, message: "Image not found" };

    if (data.isPrimary) {
      return prisma.$transaction(async (tx) => {
        await tx.productImage.updateMany({ where: { productId: image.productId, isPrimary: true, id: { not: id } }, data: { isPrimary: false } });
        return tx.productImage.update({ where: { id }, data });
      });
    }

    return imageRepository.update(id, data);
  }

  async deleteImage(id: string, clientId: string) {
    const image = await imageRepository.findById(id, clientId);
    if (!image) throw { statusCode: 404, message: "Image not found" };

    // Delete from Supabase Storage. storagePath is stored as {clientId}/{productId}/{filename}
    // *within* the inventory-images bucket (see useUploadImage.js) -- it does not carry a
    // bucket-name prefix, so it must be passed to .remove() as-is, not split apart.
    if (image.storagePath) {
      try {
        const { error } = await supabase.storage.from('inventory-images').remove([image.storagePath]);
        if (error) {
          console.error("Failed to delete from Supabase:", error);
          // Optional: throw error if strict consistency is required
        }
      } catch (err) {
        console.error("Supabase deletion error:", err);
      }
    }

    return imageRepository.delete(id, clientId);
  }
}

export const imageService = new ImageService();
