import { productRepository } from '../repositories/product.repository';
import { Prisma } from '@prisma/client';
import { generateSequentialCode } from '../utils/codeGenerator';

export class ProductService {
  
  private generateSlug(title: string): string {
    return title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)+/g, '');
  }

  async createProduct(clientId: string, data: any) {
    const slug = this.generateSlug(data.title);
    
    // Generate sequential product code
    const productCode = await generateSequentialCode(clientId, 'PRD', 'PRODUCT');
    
    const productData: Prisma.ProductUncheckedCreateInput = {
      clientId,
      slug,
      productCode,
      title: data.title,
      description: data.description,
      category: data.category,
      productType: data.productType,
      dressType: data.dressType,
      fabric: data.fabric,
      craft: data.craft,
      brand: data.brand,
      basePrice: data.basePrice,
      status: data.status
    };

    return productRepository.create(productData);
  }

  async getProducts(clientId: string, queryParams: any) {
    return productRepository.findManyWithFilters(clientId, queryParams);
  }

  async getProductById(id: string, clientId: string) {
    const product = await productRepository.findById(id, clientId);
    if (!product) throw { statusCode: 404, message: "Product not found" };
    return product;
  }

  async updateProduct(id: string, clientId: string, data: any) {
    // Re-generate slug if title changes
    let updateData = { ...data };
    if (data.title) {
      updateData.slug = this.generateSlug(data.title);
    }
    return productRepository.updateSafe(id, clientId, updateData);
  }

  async archiveProduct(id: string, clientId: string) {
    return productRepository.updateSafe(id, clientId, { status: 'ARCHIVED' });
  }

  async trashProduct(id: string, clientId: string) {
    const existing = await this.getProductById(id, clientId);
    return productRepository.updateSafe(id, clientId, { 
      previousStatus: existing.status,
      status: 'TRASHED',
      trashedAt: new Date()
    });
  }

  async restoreProduct(id: string, clientId: string) {
    const existing = await this.getProductById(id, clientId);
    return productRepository.updateSafe(id, clientId, {
      status: existing.previousStatus ?? 'ACTIVE',
      previousStatus: null,
      trashedAt: null
    });
  }

  async hardDeleteProduct(id: string, clientId: string) {
    return productRepository.hardDelete(id, clientId);
  }
}

export const productService = new ProductService();
