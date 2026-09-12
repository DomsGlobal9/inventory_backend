import { imageRepository } from '../repositories/image.repository';
import { productRepository } from '../repositories/product.repository';
import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { supabase } from '../lib/supabase';

export class ImageService {

  /**
   * Issues a short-lived, single-use upload URL scoped to a path THIS server computed.
   *
   * The browser used to build `${clientId}/${productId}/${file}` itself and write straight
   * to Supabase with the anon key. That put the tenant boundary entirely in the client's
   * hands: anyone could name another boutique's folder and write into it, and the anon key
   * carries no identity for a storage policy to check against. The backend already knows
   * the tenant from the JWT, which the browser cannot forge, so the path is derived here
   * and the client is never asked for -- nor trusted with -- a clientId.
   */
  async createUploadUrl(productId: string, clientId: string, fileName: string) {
    const product = await productRepository.findById(productId, clientId);
    if (!product) throw { statusCode: 404, message: "Product not found" };

    // Never interpolate a client-supplied name into a path unsanitised: "../" or a leading
    // slash would escape the tenant prefix that is the whole point of this.
    // Slash removal alone already makes escape impossible, but collapsing dot runs keeps
    // the stored object names sane too -- "../../etc/passwd" should not survive as
    // "_.._.._etc_passwd".
    const safeName = String(fileName || 'upload')
      .replace(/[^a-zA-Z0-9._-]/g, '_')
      .replace(/\.{2,}/g, '.')
      .replace(/^[._-]+/, '')
      .slice(0, 120) || 'upload';

    const storagePath = `${clientId}/${productId}/${Date.now()}_${safeName}`;

    const { data, error } = await supabase.storage
      .from('inventory-images')
      .createSignedUploadUrl(storagePath);

    if (error || !data) {
      throw { statusCode: 502, message: `Could not prepare upload: ${error?.message || 'unknown storage error'}` };
    }

    const { data: publicUrlData } = supabase.storage.from('inventory-images').getPublicUrl(storagePath);

    return {
      storagePath,
      token: data.token,
      signedUrl: data.signedUrl,
      publicUrl: publicUrlData.publicUrl
    };
  }

  async addImage(productId: string, clientId: string, data: any) {
    const product = await productRepository.findById(productId, clientId);
    if (!product) throw { statusCode: 404, message: "Product not found" };

    // Defence in depth: even though createUploadUrl now generates the path, this endpoint
    // still accepts one from the request body. Reject anything outside this tenant's own
    // prefix so a crafted call cannot register another boutique's file against this
    // product (or point a product at a path it never owned).
    const requiredPrefix = `${clientId}/${productId}/`;
    if (data.storagePath && !String(data.storagePath).startsWith(requiredPrefix)) {
      throw { statusCode: 400, message: "storagePath does not belong to this product" };
    }

    /*
     * A photograph can name the colour it shows, but only a colour of THIS product.
     *
     * Checked rather than trusted: variantId arrives from the browser, and without this a
     * crafted call could hang one shop's photograph off another shop's variant. Scoped by
     * clientId AND productId, so neither a foreign tenant nor a different product of the same
     * tenant is reachable.
     */
    if (data.variantId) {
      const variant = await prisma.productVariant.findFirst({
        where: { id: data.variantId, clientId, productId },
        select: { id: true }
      });
      if (!variant) throw { statusCode: 400, message: 'That size/colour does not belong to this product.' };
    }

    const imageData: Prisma.ProductImageUncheckedCreateInput = {
      productId,
      variantId: data.variantId ?? null,
      url: data.url,
      storagePath: data.storagePath,
      fileName: data.fileName,
      fileSize: data.fileSize,
      altText: data.altText,
      isPrimary: data.isPrimary,
      imageType: data.imageType,
      orderIndex: data.orderIndex
    };

    // One primary image per SET, and a variant is its own set -- clear any existing one
    // first so creating a new primary (e.g. every publish/regenerate cycle) doesn't just
    // stack up multiple PRIMARY badges instead of replacing the old one.
    //
    // Scoped by variant now that a photograph can name a colour: clearing on productId alone
    // would mean setting the primary shot of the red saree un-set the primary shot of the
    // blue one, and a shop with five colours could only ever have one primary between them.
    if (imageData.isPrimary) {
      return prisma.$transaction(async (tx) => {
        await tx.productImage.updateMany({
          where: { productId, variantId: imageData.variantId ?? null, isPrimary: true },
          data: { isPrimary: false }
        });
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
        // Same scoping as addImage: the primary of one colour is not the primary of another.
        await tx.productImage.updateMany({
          where: { productId: image.productId, variantId: image.variantId, isPrimary: true, id: { not: id } },
          data: { isPrimary: false }
        });
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
