import { productRepository } from '../repositories/product.repository';
import { Prisma } from '@prisma/client';
import { generateSequentialCode } from '../utils/codeGenerator';
import { prisma } from '../lib/prisma';
import { supabase } from '../lib/supabase';
import { storefrontEventService } from './storefront-event.service';
import { shopperTryOnProductService, type ScanUrlOptions } from './shopper-tryon';
import { StorefrontEventType } from '@prisma/client';

/**
 * Tell any connected storefront that a product appeared, changed or was withdrawn.
 *
 * Fire-and-forget: the product is already saved, and a notification must never be able to fail
 * the save that caused it. storefrontEventService does nothing when the tenant has no
 * connection, which is most of them.
 */
function notifyStorefronts(clientId: string, productId: string, type: keyof typeof StorefrontEventType) {
  setImmediate(() => {
    void storefrontEventService.productChanged(clientId, productId, StorefrontEventType[type])
      .catch(err => console.error(`[StorefrontEvents] ${type} failed`, err));
  });
}

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
      status: data.status,
      // Published straight from the wizard rather than saved as a draft first, which is the
      // common path. See updateProduct for why this column needs setting at all.
      publishedAt: data.status === 'ACTIVE' ? new Date() : null
    };

    return productRepository.create(productData);
  }

  async getProducts(clientId: string, queryParams: any) {
    return productRepository.findManyWithFilters(clientId, queryParams);
  }

  async getProductById(id: string, clientId: string, scanOptions: ScanUrlOptions = {}) {
    const product = await productRepository.findById(id, clientId);
    if (!product) throw { statusCode: 404, message: "Product not found" };

    // The address a shopper reaches by scanning this product's QR code.
    //
    // Built on the server rather than assembled in the browser because the QR gets PRINTED on
    // a garment tag: a tag outlives every deploy, so where it points has to be one decision in
    // one place, changeable in configuration without reprinting anything already in a shop.
    //
    // Null when shopper try-on is not configured for this deployment, so the screen can leave
    // the QR off rather than print a code that leads nowhere.
    //
    // scanOptions carries where the shopper should be returned to. It is passed through rather
    // than assembled here because only the caller knows which page it is putting the link on,
    // and it is validated inside scanUrlFor rather than trusted.
    return {
      ...product,
      tryOnScanUrl: shopperTryOnProductService.scanUrlFor(clientId, product.productCode, scanOptions)
    };
  }

  async updateProduct(id: string, clientId: string, data: any) {
    // Re-generate slug if title changes, suffixed with the product's own (already
    // unique) productCode for the same reason as createProduct above.
    let updateData = { ...data };
    if (data.title) {
      const existing = await this.getProductById(id, clientId);
      updateData.slug = `${this.generateSlug(data.title)}-${existing.productCode.toLowerCase()}`;
    }

    // Stamp the moment a product first goes live. The column has existed since the beginning
    // and nothing has ever written it -- every ACTIVE product in the database carries null --
    // so anything asking "what was published, and when" got no answer. Set only on the
    // transition, so re-saving a live product does not keep moving its publication date.
    // Whether this edit takes the product off the storefront, puts it on, or simply changes
    // it -- decided before the write, while the old status is still knowable.
    const before = await this.getProductById(id, clientId);
    if (data.status === 'ACTIVE' && !before.publishedAt) updateData.publishedAt = new Date();

    const updated = await productRepository.updateSafe(id, clientId, updateData);

    const wasVisible = before.status === 'ACTIVE' && !before.trashedAt;
    const isVisible = (data.status ?? before.status) === 'ACTIVE';
    if (!wasVisible && isVisible) notifyStorefronts(clientId, id, 'PRODUCT_PUBLISHED');
    else if (wasVisible && !isVisible) notifyStorefronts(clientId, id, 'PRODUCT_UNPUBLISHED');
    else if (isVisible) notifyStorefronts(clientId, id, 'PRODUCT_UPDATED');

    return updated;
  }

  async archiveProduct(id: string, clientId: string) {
    // Remember what it was, the same way trashProduct does.
    //
    // This did not, and restoreProduct falls back to ACTIVE when previousStatus is empty --
    // so archiving a DRAFT and restoring it PUBLISHED it. Reproduced on a real tenant:
    // PRD-000002 went DRAFT -> archive -> restore -> ACTIVE, and PRODUCT_PUBLISHED went out
    // to the storefront for a product with no photographs that nobody had ever chosen to put
    // on sale. Trashing and restoring the same product was correct throughout, which is what
    // made it easy to miss.
    const existing = await this.getProductById(id, clientId);
    const archived = await productRepository.updateSafe(id, clientId, {
      previousStatus: existing.status,
      status: 'ARCHIVED'
    });
    // Withdrawn from sale. A storefront that is never told simply carries on selling it, which
    // is the one product event that must be sent even though the product is no longer eligible.
    notifyStorefronts(clientId, id, 'PRODUCT_UNPUBLISHED');
    return archived;
  }

  async trashProduct(id: string, clientId: string) {
    const existing = await this.getProductById(id, clientId);
    const trashed = await productRepository.updateSafe(id, clientId, {
      previousStatus: existing.status,
      status: 'TRASHED',
      trashedAt: new Date()
    });
    notifyStorefronts(clientId, id, 'PRODUCT_UNPUBLISHED');
    return trashed;
  }

  async restoreProduct(id: string, clientId: string) {
    const existing = await this.getProductById(id, clientId);

    // When we genuinely do not know what it was, come back as a DRAFT rather than ACTIVE.
    //
    // Only products archived BEFORE archiveProduct started recording previousStatus land
    // here. For those the honest answer is "unknown", and the two ways of being wrong are not
    // equal: restoring to DRAFT when it should have been ACTIVE means somebody presses
    // Publish, while restoring to ACTIVE when it should have been DRAFT puts an unfinished
    // product in front of customers and tells the storefront to sell it. The recoverable
    // mistake is the one to make.
    const restoredStatus = existing.previousStatus ?? 'DRAFT';

    const restored = await productRepository.updateSafe(id, clientId, {
      status: restoredStatus,
      previousStatus: null,
      trashedAt: null
    });
    // Only worth announcing if it came back to life. Restoring something to DRAFT or ARCHIVED
    // leaves it invisible to a storefront, which already believes it is gone.
    if (restoredStatus === 'ACTIVE') {
      notifyStorefronts(clientId, id, 'PRODUCT_PUBLISHED');
    }
    return restored;
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
