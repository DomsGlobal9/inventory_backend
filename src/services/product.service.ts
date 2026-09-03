import { productRepository } from '../repositories/product.repository';
import { Prisma } from '@prisma/client';
import { generateSequentialCode } from '../utils/codeGenerator';
import { prisma } from '../lib/prisma';
import { supabase } from '../lib/supabase';

export class ProductService {
  
  private generateSlug(title: string): string {
    return title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)+/g, '');
  }

  async createProduct(clientId: string, data: any) {
    // Generate sequential product code
    const productCode = await generateSequentialCode(clientId, 'PRD', 'PRODUCT');

    // Slug is derived only from title, so two products with the same title (a retry
    // after a failed publish, a duplicated draft, etc.) would otherwise collide on the
    // (clientId, slug) unique constraint. productCode is already unique per client, so
    // suffixing with it guarantees the slug is too, without needing a collision-retry loop.
    const slug = `${this.generateSlug(data.title)}-${productCode.toLowerCase()}`;

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
    // Re-generate slug if title changes, suffixed with the product's own (already
    // unique) productCode for the same reason as createProduct above.
    let updateData = { ...data };
    if (data.title) {
      const existing = await this.getProductById(id, clientId);
      updateData.slug = `${this.generateSlug(data.title)}-${existing.productCode.toLowerCase()}`;
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
    // Read image storage paths *before* the delete, since Prisma cascade will remove
    // the ProductImage rows along with the Product -- once that happens the paths are gone.
    const images = await prisma.productImage.findMany({
      where: { productId: id, product: { clientId } },
      select: { storagePath: true }
    });

    const deleted = await productRepository.hardDelete(id, clientId);

    const paths = images.map(i => i.storagePath).filter((p): p is string => !!p);
    if (paths.length > 0) {
      const { error } = await supabase.storage.from('inventory-images').remove(paths);
      if (error) {
        console.error(`Failed to clean up ${paths.length} storage file(s) for deleted product ${id}:`, error);
      }
    }

    return deleted;
  }
}

export const productService = new ProductService();
