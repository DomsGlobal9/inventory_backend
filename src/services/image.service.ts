import { imageRepository } from '../repositories/image.repository';
import { productRepository } from '../repositories/product.repository';
import { Prisma } from '@prisma/client';
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

    return imageRepository.create(imageData);
  }

  async getImages(productId: string, clientId: string) {
    return imageRepository.findManyByProduct(productId, clientId);
  }

  async updateImage(id: string, clientId: string, data: any) {
    const image = await imageRepository.findById(id, clientId);
    if (!image) throw { statusCode: 404, message: "Image not found" };

    // If setting as primary, we should probably unset others, but for V1 we just update this one
    return imageRepository.update(id, data);
  }

  async deleteImage(id: string, clientId: string) {
    const image = await imageRepository.findById(id, clientId);
    if (!image) throw { statusCode: 404, message: "Image not found" };

    // Delete from Supabase Storage
    if (image.storagePath) {
      try {
        const bucket = image.storagePath.split('/')[0];
        const path = image.storagePath.split('/').slice(1).join('/');
        
        const { error } = await supabase.storage.from(bucket).remove([path]);
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
