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

    /*
     * A generated view can only point at a flat-lay of THIS product.
     *
     * Same reasoning as variantId above: it arrives from the browser, and unchecked it would
     * let one shop's photograph claim to have been generated from another shop's.
     */
    if (data.generatedFromId) {
      const source = await prisma.productImage.findFirst({
        where: { id: data.generatedFromId, productId, product: { clientId } },
        select: { id: true }
      });
      if (!source) throw { statusCode: 400, message: 'That photograph does not belong to this product.' };
    }

    const imageData: Prisma.ProductImageUncheckedCreateInput = {
      productId,
      variantId: data.variantId ?? null,
      generated: data.generated ?? false,
      generatedFromId: data.generatedFromId ?? null,
      view: data.view ?? null,
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

    /*
     * The file goes only when the LAST row using it goes.
     *
     * storagePath is {clientId}/{productId}/{filename} WITHIN the inventory-images bucket -- it
     * carries no bucket-name prefix, so it is passed to .remove() as-is rather than split apart.
     *
     * One photograph of the red saree is registered against red/S, red/M and red/L -- the bytes
     * are uploaded once and three rows point at them. Removing the file as soon as any one of
     * those rows was deleted would blank the other two: the shop would delete red/M's copy and
     * watch red/S and red/L turn into broken images.
     *
     * Counted inside the same call that deletes the row, and deliberately BEFORE it: if another
     * row shares the path there is nothing to do, and if this was the last one the file is
     * removed after the row is gone, so a failure here leaves an orphaned file rather than a
     * row pointing at nothing. An orphan costs storage; a row pointing at nothing is a broken
     * picture on a shop's product page.
     */
    let sharedWith = 0;
    if (image.storagePath) {
      sharedWith = await prisma.productImage.count({
        where: { storagePath: image.storagePath, id: { not: id } }
      });
    }

    const deleted = await imageRepository.delete(id, clientId);

    if (image.storagePath && sharedWith === 0) {
      try {
        const { error } = await supabase.storage.from('inventory-images').remove([image.storagePath]);
        if (error) {
          console.error("Failed to delete from Supabase:", error);
        }
      } catch (err) {
        console.error("Supabase deletion error:", err);
      }
    }

    return deleted;

  }
}

export const imageService = new ImageService();
