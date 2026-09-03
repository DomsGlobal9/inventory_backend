import { searchRepository } from '../repositories/search.repository';

export class SearchService {
  async performSearch(clientId: string, query: string) {
    if (!query || query.trim().length === 0) {
      return { products: [], variants: [], transactions: [] };
    }

    const { products, variants, transactions } = await searchRepository.globalSearch(clientId, query);
    
    // Format into standard result shape
    const formattedProducts = products.map((p: any) => ({
      type: 'product',
      id: p.id,
      label: p.title,
      code: p.productCode,
      barcode: null,
      imageUrl: p.images?.[0]?.url || null,
      url: `/products/${p.id}`
    }));

    const formattedVariants = variants.map((v: any) => {
      const parts = [v.product?.title];
      if (v.colorName) parts.push(v.colorName);
      if (v.size) parts.push(v.size);
      
      return {
        type: 'variant',
        id: v.id,
        label: parts.filter(Boolean).join(' - '),
        code: v.variantCode,
        barcode: v.barcode,
        sku: v.sku,
        imageUrl: v.product?.images?.[0]?.url || null,
        // Deep-link to the Variants tab with this exact variant flagged. The URL used to be
        // a bare `/products/:id`, so scanning one size/colour dropped you on the product's
        // Overview tab with every sibling variant hidden behind another click -- on a
        // product with nine variants, the scan told you nothing about which one you held.
        url: `/products/${v.productId}?tab=variants&variant=${v.id}`
      };
    });

    return {
      products: formattedProducts,
      variants: formattedVariants,
      transactions: transactions // Empty for now as per V1 plan
    };
  }
}

export const searchService = new SearchService();
