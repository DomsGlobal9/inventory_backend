/**
 * Keeping our products true in a connected Shopify store.
 *
 *   PUSH      a product changed here, or was switched on: Shopify is told what it should look like
 *             NOW -- absolute state, rendered afresh -- so a retry or a reordering cannot corrupt it.
 *   STOCK     only the counts moved (a sale, a receipt, a move): just the numbers are sent, as
 *             exact figures per paired location, never "minus one".
 *   ARCHIVE   switched off or deleted here: a product WE made is archived in Shopify, never deleted.
 *             One the shop built by hand (MATCHED) is never archived; it only stops being sent to.
 *   EDITS     Shopify says a product of ours changed. If it is not our own echo, ScaleEzy's version
 *             is put back and the shop is told in the bell -- the shop chose "ScaleEzy wins, but
 *             tell me" on 26 October.
 *
 * Guards worth knowing before changing anything:
 *
 *   NO DUPLICATES  every product we create carries a tag naming it (render.scaleezyTag). A create
 *                  that timed out after Shopify made the product is found by that tag on retry and
 *                  updated, instead of a second identical product appearing in the shop.
 *   KEEP VARIANTS  an update names each variant by the Shopify id we hold for it. Without the id,
 *                  productSet would delete and re-create variants, giving them new inventory items
 *                  and breaking every order and stock link to the old ones.
 *   PAIRED ONLY    stock goes only to Shopify locations the shop paired with one of ours. Guessing
 *                  would publish back-office warehouse stock to the public web.
 */

import crypto from 'crypto';
import { prisma } from '../../lib/prisma';
import { backoffMs } from '../../utils/retryBackoff';
import { ShopifyAdminApi, ShopifyApiError, numericShopifyId } from '../shopify-mapping';
import { storefrontCatalogueService } from '../storefront-catalogue.service';
import {
  renderProduct, canonicalOf, canonicalFromWebhook, hashCanonical, describeEdits, scaleezyTag, gid, Rendered,
  withFinalPrices, VariantTax
} from './render';
import { mayChargeTax, registrationInForce } from '../pricing/tax';

export type ApiFor = (installation: { id: string; shopDomain: string }) => Promise<ShopifyAdminApi>;

const LEASE_MS = 2 * 60 * 1000;
const MAX_ATTEMPTS = 8;
/** Rows worked per pass, so one shop putting 2,000 products on cannot hold the worker for an hour. */
const BATCH = 10;
/** A stock change Shopify reports is re-checked this much later, so an order it came from lands first. */
const STOCK_SETTLE_MS = 2 * 60 * 1000;

/** Titles the bell recognises, so these notices are labelled as Shopify's and not as a count. */
export const SHOPIFY_NOTICE = { changed: 'Changed in Shopify', deleted: 'Deleted in Shopify' };

const Q = {
  byTag: `query ProductByTag($q: String!) { products(first: 2, query: $q) { nodes { id status } } }`,
  publications: `query Publications { publications(first: 25) { nodes { id name } } }`,
  set: `mutation ProductPush($input: ProductSetInput!, $identifier: ProductSetIdentifiers) {
    productSet(input: $input, identifier: $identifier, synchronous: true) {
      product { id status variants(first: 250) { nodes { id sku inventoryItem { id } } } }
      userErrors { field message code }
    }
  }`,
  archive: `mutation ProductArchive($p: ProductUpdateInput!) {
    productUpdate(product: $p) { product { id status } userErrors { field message } }
  }`,
  publish: `mutation ProductPublish($id: ID!, $input: [PublicationInput!]!) {
    publishablePublish(id: $id, input: $input) { userErrors { field message } }
  }`,
  prices: `mutation MatchedPrices($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
    productVariantsBulkUpdate(productId: $productId, variants: $variants) { userErrors { field message } }
  }`,
  stock: `mutation StockSet($input: InventorySetQuantitiesInput!, $key: String!) {
    inventorySetQuantities(input: $input) @idempotent(key: $key) { userErrors { field message code } }
  }`,
  activate: `mutation StockActivate($item: ID!, $location: ID!) {
    inventoryActivate(inventoryItemId: $item, locationId: $location) { userErrors { field message } }
  }`
};

/** A refusal from Shopify that retrying will not change. Its message is safe to show. */
class Refused extends Error {}

function refusal(userErrors: { field?: string[] | null; message?: string }[]): string {
  const first = userErrors.map(e => String(e?.message ?? '').trim()).filter(Boolean);
  if (first.some(m => /handle/i.test(m) && /taken|exists/i.test(m))) {
    return 'Shopify already has a product with this web address. Rename one of them, then try again.';
  }
  if (first.some(m => /sku/i.test(m) && /taken|exists|duplicate/i.test(m))) {
    return 'Shopify already uses one of these item codes on another product. Give each its own code, then try again.';
  }
  return `Shopify did not accept it: ${first.slice(0, 2).join(' ') || 'no reason given'}`;
}

const publicationCache = new Map<string, string | null>();

async function onlineStorePublication(api: ShopifyAdminApi, installationId: string): Promise<string | null> {
  if (publicationCache.has(installationId)) return publicationCache.get(installationId)!;
  const data: any = await api.graphql(Q.publications);
  const store = (data?.publications?.nodes ?? []).find((n: any) => String(n?.name).toLowerCase() === 'online store');
  publicationCache.set(installationId, store?.id ?? null);
  return store?.id ?? null;
}

export class ShopifyProductPushService {
  /* ── the switch ─────────────────────────────────────────────────────────────────────────── */

  /** The "On Shopify" switch for one product. */
  async setOnShopify(clientId: string, productId: string, on: boolean) {
    const installation = await this.installation(clientId);
    const product = await prisma.product.findFirst({
      where: { id: productId, clientId },
      select: { id: true, title: true, status: true, trashedAt: true, isService: true }
    });
    if (!product) throw new ShopifyApiError('That product was not found in this shop.', 404);

    const existing = await prisma.shopifyProductMirror.findUnique({
      where: { uq_shopify_product_mirror: { installationId: installation.id, productId } }
    });
    if (existing?.origin === 'MATCHED' && on) {
      // Already in Shopify, built by hand there; making a second copy would sell it twice.
      return this.describeOne(existing);
    }
    if (on) {
      if (product.isService) throw new ShopifyApiError('Services such as stitching are not sent to Shopify.', 400);
      if (product.trashedAt || product.status !== 'ACTIVE') {
        throw new ShopifyApiError('Only active products can go on Shopify. Make it active first.', 400);
      }
    }
    if (!existing) {
      if (!on) return null;
      const row = await prisma.shopifyProductMirror.create({
        data: { clientId, installationId: installation.id, productId, origin: 'CREATED', wanted: true, status: 'PENDING' }
      });
      return this.describeOne(row);
    }
    const row = await prisma.shopifyProductMirror.update({
      where: { id: existing.id },
      data: { wanted: on, status: 'PENDING', attempts: 0, nextAttemptAt: null, problem: null, lockedAt: null }
    });
    return this.describeOne(row);
  }

  /** "Put all products on Shopify": every active, non-service product not already there. */
  async putAll(clientId: string) {
    const installation = await this.installation(clientId);
    await this.ensureMatchedMirrors(clientId, installation.id);
    const products = await prisma.product.findMany({
      where: { clientId, status: 'ACTIVE', trashedAt: null, isService: false },
      select: { id: true, shopifyMirrors: { where: { installationId: installation.id }, select: { id: true, origin: true, wanted: true } } }
    });
    let added = 0, switchedOn = 0;
    for (const p of products) {
      const m = p.shopifyMirrors[0];
      if (!m) {
        await prisma.shopifyProductMirror.create({
          data: { clientId, installationId: installation.id, productId: p.id, origin: 'CREATED', wanted: true, status: 'PENDING' }
        }).catch(() => undefined); // a second press racing this one made it already
        added++;
      } else if (!m.wanted && m.origin === 'CREATED') {
        await prisma.shopifyProductMirror.update({
          where: { id: m.id }, data: { wanted: true, status: 'PENDING', attempts: 0, nextAttemptAt: null, problem: null }
        });
        switchedOn++;
      }
    }
    return { added, switchedOn, summary: await this.summary(clientId) };
  }

  /** Try everything that failed again, now. */
  async retryFailed(clientId: string) {
    const r = await prisma.shopifyProductMirror.updateMany({
      where: { clientId, status: 'FAILED' },
      data: { status: 'PENDING', attempts: 0, nextAttemptAt: null, problem: null, lockedAt: null }
    });
    return { retried: r.count };
  }

  /**
   * Products matched by SKU get a mirror of their own (origin MATCHED), so their price and stock
   * follow ours. Called after matching and before any summary, so matches made before this
   * existed are picked up too.
   */
  async ensureMatchedMirrors(clientId: string, installationId: string) {
    const maps = await prisma.shopifyIdMap.findMany({
      where: { clientId, installationId, origin: 'MATCHED' },
      select: { shopifyProductId: true, variantId: true }
    });
    if (maps.length === 0) return 0;
    const variants = await prisma.productVariant.findMany({
      where: { id: { in: maps.map(m => m.variantId) } }, select: { id: true, productId: true }
    });
    const productOf = new Map(variants.map(v => [v.id, v.productId]));
    const byProduct = new Map<string, string>();
    for (const m of maps) { const pid = productOf.get(m.variantId); if (pid) byProduct.set(pid, m.shopifyProductId); }
    if (byProduct.size === 0) return 0;
    const have = await prisma.shopifyProductMirror.findMany({
      where: { installationId, productId: { in: [...byProduct.keys()] } }, select: { productId: true }
    });
    const haveSet = new Set(have.map(h => h.productId));
    const missing = [...byProduct.entries()].filter(([productId]) => !haveSet.has(productId));
    if (missing.length) {
      await prisma.shopifyProductMirror.createMany({
        data: missing.map(([productId, shopifyProductId]) => ({
          clientId, installationId, productId, origin: 'MATCHED', wanted: true, status: 'PENDING', shopifyProductId
        })),
        skipDuplicates: true
      });
    }
    return missing.length;
  }

  /* ── what the screens read ──────────────────────────────────────────────────────────────── */

  async summary(clientId: string) {
    const installation = await prisma.shopifyInstallation.findFirst({
      where: { clientId, uninstalledAt: null }, select: { id: true, shopDomain: true }
    });
    if (!installation) return null;
    await this.ensureMatchedMirrors(clientId, installation.id);
    // By workspace as well as store: a store can be reconnected to another workspace, and its
    // old rows must never be counted, or named, on the new one's screen.
    const rows = await prisma.shopifyProductMirror.groupBy({
      by: ['origin', 'status', 'wanted'], where: { installationId: installation.id, clientId }, _count: { id: true }
    });
    const count = (f: (r: typeof rows[number]) => boolean) => rows.filter(f).reduce((a, r) => a + r._count.id, 0);
    const failed = await prisma.shopifyProductMirror.findMany({
      where: { installationId: installation.id, clientId, status: 'FAILED' },
      select: { productId: true, problem: true, product: { select: { title: true, productCode: true } } },
      take: 20, orderBy: { updatedAt: 'desc' }
    });
    const [activeProducts, pairedLocations] = await Promise.all([
      prisma.product.count({ where: { clientId, status: 'ACTIVE', trashedAt: null, isService: false } }),
      prisma.shopifyLocationMap.count({ where: { installationId: installation.id } })
    ]);
    return {
      shopDomain: installation.shopDomain,
      activeProducts,
      pairedLocations,
      onShopify: count(r => r.wanted && r.status !== 'ARCHIVED'),
      created: count(r => r.origin === 'CREATED' && r.wanted),
      matched: count(r => r.origin === 'MATCHED'),
      upToDate: count(r => r.wanted && r.status === 'SYNCED'),
      sending: count(r => r.wanted && r.status === 'PENDING'),
      failed: count(r => r.status === 'FAILED'),
      archived: count(r => r.status === 'ARCHIVED'),
      problems: failed.map(f => ({ productId: f.productId, title: f.product.title, productCode: f.product.productCode, problem: f.problem }))
    };
  }

  /** One product's Shopify state, for its page. Null when no store is connected. */
  async forProduct(clientId: string, productId: string) {
    const installation = await prisma.shopifyInstallation.findFirst({
      where: { clientId, uninstalledAt: null }, select: { id: true, shopDomain: true }
    });
    if (!installation) return null;
    await this.ensureMatchedMirrors(clientId, installation.id);
    const row = await prisma.shopifyProductMirror.findUnique({
      where: { uq_shopify_product_mirror: { installationId: installation.id, productId } }
    });
    return { shopDomain: installation.shopDomain, ...(row ? this.describeOne(row) : { on: false, origin: null, status: null }) };
  }

  private describeOne(row: { origin: string; wanted: boolean; status: string; problem: string | null; lastSyncedAt: Date | null; shopifyProductId: string | null }) {
    return {
      on: row.wanted,
      origin: row.origin,
      status: row.status,
      problem: row.problem,
      lastSyncedAt: row.lastSyncedAt,
      shopifyProductId: row.shopifyProductId
    };
  }

  /* ── the worker's pass ──────────────────────────────────────────────────────────────────── */

  /** One pass: claim due rows, push each. Returns what happened to each, for the log. */
  async runOnce(apiFor: ApiFor): Promise<string[]> {
    const now = new Date();
    const stale = new Date(now.getTime() - LEASE_MS);
    const due = await prisma.shopifyProductMirror.findMany({
      where: {
        AND: [
          { OR: [{ lockedAt: null }, { lockedAt: { lt: stale } }] },
          { OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }] },
          { OR: [{ status: 'PENDING' }, { status: 'SYNCED', stockPending: true }] },
          { installation: { uninstalledAt: null } }
        ]
      },
      orderBy: { updatedAt: 'asc' },
      take: BATCH,
      select: { id: true, lockedAt: true }
    });

    const results: string[] = [];
    for (const candidate of due) {
      // Guarded on the lock it found, so two workers cannot both take the same row.
      const claimed = await prisma.shopifyProductMirror.updateMany({
        where: { id: candidate.id, lockedAt: candidate.lockedAt },
        data: { lockedAt: new Date() }
      });
      if (claimed.count !== 1) { results.push('BUSY'); continue; }
      results.push(await this.work(candidate.id, apiFor));
    }
    return results;
  }

  /** Every 10 minutes: re-render each synced product and queue any that no longer match. */
  async sweep(): Promise<number> {
    const rows = await prisma.shopifyProductMirror.findMany({
      where: { status: 'SYNCED', wanted: true, origin: 'CREATED', installation: { uninstalledAt: null } },
      select: { id: true, clientId: true, installationId: true, installation: { select: { clientId: true } }, lastHash: true, imagesHash: true, product: { select: { productCode: true } } },
      take: 500, orderBy: { lastSyncedAt: 'asc' }
    });
    let queued = 0;
    for (const r of rows) {
      if (r.installation.clientId !== r.clientId) continue;
      const scope = await this.scope(r.installationId);
      const p = await this.productForShopify(r.clientId, scope.ourLocationIds, r.product.productCode);
      const rendered = p ? renderProduct(p) : null;
      if (!rendered || rendered.hash !== r.lastHash || rendered.imagesHash !== r.imagesHash) {
        await prisma.shopifyProductMirror.update({ where: { id: r.id }, data: { status: 'PENDING', attempts: 0, nextAttemptAt: null } });
        queued++;
      }
    }
    return queued;
  }

  /** One leased row. Never throws: every outcome is written onto the row. */
  async work(mirrorId: string, apiFor: ApiFor): Promise<string> {
    const mirror = await prisma.shopifyProductMirror.findUnique({
      where: { id: mirrorId },
      include: {
        installation: { select: { id: true, shopDomain: true, uninstalledAt: true, clientId: true } },
        product: { select: { id: true, productCode: true, status: true, trashedAt: true, isService: true } }
      }
    });
    if (!mirror) return 'GONE';
    const stockOnly = mirror.status === 'SYNCED' && mirror.stockPending;

    // The store now belongs to another workspace: this one's products must not go into it.
    if (mirror.installation.clientId !== mirror.clientId) {
      await prisma.shopifyProductMirror.update({
        where: { id: mirror.id },
        data: { status: 'FAILED', lockedAt: null, nextAttemptAt: null, stockPending: false,
          problem: 'This Shopify store is now connected to another workspace, so nothing more is sent to it from here.' }
      });
      return 'FAILED';
    }

    try {
      const api = await apiFor(mirror.installation);
      const scope = await this.scope(mirror.installationId);
      if (scope.pairs.length === 0) {
        throw new Refused('Pair a Shopify location with one of your stores first (Settings, Shopify, Locations), so Shopify knows where the stock is.');
      }
      const eligible = mirror.product.status === 'ACTIVE' && !mirror.product.trashedAt && !mirror.product.isService;

      // Cleared before the work, so a sale during the push queues another round instead of being lost.
      await prisma.shopifyProductMirror.update({ where: { id: mirror.id }, data: { stockPending: false } });

      if (stockOnly) {
        await this.sendStock(api, mirror, scope, eligible);
        await this.done(mirror.id, {});
        return 'STOCK';
      }

      if (mirror.origin === 'MATCHED') {
        if (mirror.wanted) {
          await this.sendMatchedPrices(api, mirror, scope, eligible);
          await this.sendStock(api, mirror, scope, eligible);
        }
        await this.done(mirror.id, { status: mirror.wanted ? 'SYNCED' : 'ARCHIVED' });
        return mirror.wanted ? 'SYNCED' : 'STOPPED';
      }

      // CREATED: ours entirely.
      if (!mirror.wanted || !eligible) {
        if (mirror.shopifyProductId) {
          const data: any = await api.graphql(Q.archive, { p: { id: gid('Product', mirror.shopifyProductId), status: 'ARCHIVED' } });
          const errors = data?.productUpdate?.userErrors ?? [];
          // A product deleted in Shopify meanwhile is already as gone as archiving would make it.
          if (errors.length && !errors.some((e: any) => /not exist|not found/i.test(String(e?.message)))) throw new Refused(refusal(errors));
        }
        await this.done(mirror.id, { status: 'ARCHIVED' });
        return 'ARCHIVED';
      }

      const p = await this.productForShopify(mirror.clientId, scope.ourLocationIds, mirror.product.productCode);
      if (!p) throw new Refused('This product could not be read. Check it is active, then try again.');
      const rendered = renderProduct(p);
      if (rendered.refusal) throw new Refused(rendered.refusal);

      await this.sendProduct(api, mirror, scope, rendered);
      return 'SYNCED';
    } catch (error: any) {
      return this.failed(mirror.id, mirror.attempts + 1, error);
    }
  }

  /**
   * The product as Shopify gets it: the shop-front copy, with each price made the FINAL price
   * (GST added first where it was entered without). Every place that renders a product for
   * Shopify reads it through here, so the push, the sweep and the echo check agree on the price.
   */
  private async productForShopify(clientId: string, locationIds: string[], productCode: string) {
    const p = await storefrontCatalogueService.getProduct({ clientId, locationIds }, productCode);
    if (!p) return null;
    const [settings, variants] = await Promise.all([
      prisma.clientSettings.findUnique({ where: { clientId }, select: { gstRegistration: true, gstNumber: true } }),
      prisma.productVariant.findMany({
        where: { clientId, product: { productCode } },
        select: { variantCode: true, taxRateBps: true, product: { select: { taxRateBps: true, priceIsExclusive: true } } }
      })
    ]);
    const chargesTax = mayChargeTax(registrationInForce(settings?.gstRegistration, settings?.gstNumber));
    const taxBy = new Map<string, VariantTax>(variants.map(v => [v.variantCode, {
      rateBps: v.taxRateBps ?? v.product.taxRateBps ?? null,
      priceIsExclusive: Boolean(v.product.priceIsExclusive)
    }]));
    return withFinalPrices(p, taxBy, chargesTax);
  }

  /* ── the Shopify calls ──────────────────────────────────────────────────────────────────── */

  private async sendProduct(api: ShopifyAdminApi, mirror: any, scope: Scope, r: Rendered) {
    // Ours already? By id, then by tag -- the tag is what finds a create that timed out.
    let shopifyProductId: string | null = mirror.shopifyProductId;
    if (!shopifyProductId) {
      const found: any = await api.graphql(Q.byTag, { q: `tag:'${r.tags[0]}'` });
      const nodes = found?.products?.nodes ?? [];
      if (nodes.length > 1) throw new Refused('Shopify has two products tagged as this one. Delete the extra one in Shopify, then try again.');
      shopifyProductId = nodes.length ? numericShopifyId(nodes[0].id) : null;
    }
    const creating = !shopifyProductId;

    // Our variants' Shopify ids, so an update keeps them instead of re-making them.
    const variantIds = await prisma.productVariant.findMany({ where: { productId: mirror.productId }, select: { id: true, sku: true } });
    const maps = await prisma.shopifyIdMap.findMany({
      where: { installationId: mirror.installationId, variantId: { in: variantIds.map(v => v.id) } },
      select: { variantId: true, shopifyVariantId: true, shopifyProductId: true }
    });
    const ourIdBySku = new Map(variantIds.map(v => [v.sku.trim().toUpperCase(), v.id]));
    const mapByOurId = new Map(maps.filter(m => m.shopifyProductId === shopifyProductId).map(m => [m.variantId, m]));

    // Stock for brand-new variants is set in the same call: that also stocks them at the location.
    const stockNow = await this.stockFor(variantIds.map(v => v.id), scope, true);

    const input: any = {
      title: r.title,
      descriptionHtml: r.descriptionHtml,
      vendor: r.vendor ?? undefined,
      productType: r.productType ?? undefined,
      tags: r.tags,
      status: 'ACTIVE',
      productOptions: r.options.map(o => ({ name: o.name, values: o.values.map(name => ({ name })) })),
      variants: r.variants.map(v => {
        const ourId = ourIdBySku.get(v.sku.toUpperCase());
        const known = ourId ? mapByOurId.get(ourId) : undefined;
        return {
          ...(known ? { id: gid('ProductVariant', known.shopifyVariantId) } : {}),
          optionValues: v.optionValues,
          price: v.price,
          compareAtPrice: v.compareAtPrice,
          // Shopify adds no tax of its own: the price already is the final price, GST inside it.
          taxable: false,
          ...(v.barcode ? { barcode: v.barcode } : {}),
          inventoryPolicy: 'DENY',
          inventoryItem: { sku: v.sku, tracked: true },
          ...(!known && ourId ? {
            inventoryQuantities: scope.pairs.map(pair => ({
              locationId: gid('Location', pair.shopifyLocationId), name: 'available',
              quantity: stockNow.get(`${ourId}|${pair.ourLocationId}`) ?? 0
            }))
          } : {})
        };
      })
    };
    // Photos only when they changed: re-sending makes Shopify fetch and re-process every one.
    if (creating || mirror.imagesHash !== r.imagesHash) {
      input.files = r.images.map(i => ({ originalSource: i.url, contentType: 'IMAGE', alt: i.alt }));
    }

    const data: any = await api.graphql(Q.set, {
      input,
      identifier: shopifyProductId ? { id: gid('Product', shopifyProductId) } : null
    });
    const result = data?.productSet;
    if (result?.userErrors?.length) throw new Refused(refusal(result.userErrors));
    const productGid = result?.product?.id;
    shopifyProductId = numericShopifyId(productGid);
    if (!shopifyProductId) throw new Error('Shopify answered without the product.');

    // Remember each variant, so stock, orders and the next update all find it.
    for (const node of result.product.variants?.nodes ?? []) {
      const ourId = ourIdBySku.get(String(node?.sku ?? '').trim().toUpperCase());
      const shopifyVariantId = numericShopifyId(node?.id);
      if (!ourId || !shopifyVariantId) continue;
      const shopifyInventoryItemId = numericShopifyId(node?.inventoryItem?.id);
      // A Shopify variant held under another of our variants (a SKU moved) is let go first.
      await prisma.shopifyIdMap.deleteMany({
        where: { installationId: mirror.installationId, shopifyVariantId, NOT: { variantId: ourId } }
      });
      await prisma.shopifyIdMap.upsert({
        where: { uq_shopify_map_variant: { installationId: mirror.installationId, variantId: ourId } },
        create: {
          installationId: mirror.installationId, clientId: mirror.clientId, variantId: ourId, sku: String(node.sku),
          shopifyProductId, shopifyVariantId, shopifyInventoryItemId, origin: 'CREATED'
        },
        update: { sku: String(node.sku), shopifyProductId, shopifyVariantId, shopifyInventoryItemId, origin: 'CREATED' }
      });
    }

    if (creating) {
      // Made through the API, a product is in no sales channel: invisible in the shop until published.
      const publicationId = await onlineStorePublication(api, mirror.installationId);
      if (publicationId) {
        const pub: any = await api.graphql(Q.publish, { id: productGid, input: [{ publicationId }] });
        const errs = pub?.publishablePublish?.userErrors ?? [];
        if (errs.length) console.warn(`[shopify products] could not publish ${productGid}:`, JSON.stringify(errs).slice(0, 300));
      }
    }

    await prisma.shopifyProductMirror.update({
      where: { id: mirror.id },
      data: { shopifyProductId, lastHash: r.hash, imagesHash: r.imagesHash }
    });

    // Existing variants' stock, as exact numbers. New ones were set above.
    await this.sendStock(api, { ...mirror, shopifyProductId }, scope, true);
    await this.done(mirror.id, { status: 'SYNCED' });
  }

  /** Price for a product the shop built in Shopify: only the variants matched to ours. */
  private async sendMatchedPrices(api: ShopifyAdminApi, mirror: any, scope: Scope, eligible: boolean) {
    if (!eligible || !mirror.shopifyProductId) return;
    const p = await this.productForShopify(mirror.clientId, scope.ourLocationIds, mirror.product.productCode);
    if (!p) return;
    const maps = await prisma.shopifyIdMap.findMany({
      where: { installationId: mirror.installationId, shopifyProductId: mirror.shopifyProductId },
      select: { sku: true, shopifyVariantId: true, variantId: true }
    });
    // Our current SKU, not the one stored at matching time: a renamed item keeps its price link.
    const ourSku = new Map((await prisma.productVariant.findMany({
      where: { id: { in: maps.map(m => m.variantId) } }, select: { id: true, sku: true }
    })).map(v => [v.id, v.sku]));
    const priceBySku = new Map(p.variants.map(v => [v.sku.trim().toUpperCase(), v]));
    const variants = maps.map(m => {
      const v = priceBySku.get(String(ourSku.get(m.variantId) ?? m.sku).trim().toUpperCase());
      if (!v || !Number.isFinite(v.price) || v.price <= 0) return null;
      return {
        id: gid('ProductVariant', m.shopifyVariantId),
        price: (Math.round(v.price * 100) / 100).toFixed(2),
        compareAtPrice: v.compareAtPrice !== null && v.compareAtPrice > v.price ? (Math.round(v.compareAtPrice * 100) / 100).toFixed(2) : null,
        // The price is ours and final, so Shopify must not add tax to it -- even on a product the
        // shop built there.
        taxable: false,
        inventoryItem: { tracked: true }
      };
    }).filter(Boolean);
    if (variants.length === 0) return;
    const data: any = await api.graphql(Q.prices, { productId: gid('Product', mirror.shopifyProductId), variants });
    const errs = data?.productVariantsBulkUpdate?.userErrors ?? [];
    if (errs.length) throw new Refused(refusal(errs));
    // Remembered, so a products/update for this price is known as our own.
    const sent = variants.map((v: any) => ({ sku: maps.find(m => gid('ProductVariant', m.shopifyVariantId) === v.id)?.sku ?? '', price: v.price, compareAtPrice: v.compareAtPrice }));
    await prisma.shopifyProductMirror.update({ where: { id: mirror.id }, data: { lastHash: hashCanonical({ title: '', words: '', variants: sent }) } });
  }

  /**
   * Exact stock per paired location for every variant of the product that Shopify knows.
   * Zero for a product that is no longer active here, so a matched one cannot be oversold.
   */
  private async sendStock(api: ShopifyAdminApi, mirror: any, scope: Scope, eligible: boolean) {
    const variants = await prisma.productVariant.findMany({ where: { productId: mirror.productId }, select: { id: true } });
    const maps = await prisma.shopifyIdMap.findMany({
      where: { installationId: mirror.installationId, variantId: { in: variants.map(v => v.id) }, shopifyInventoryItemId: { not: null } },
      select: { variantId: true, shopifyInventoryItemId: true }
    });
    if (maps.length === 0) return;
    const stock = await this.stockFor(maps.map(m => m.variantId), scope, eligible);

    const quantities = maps.flatMap(m => scope.pairs.map(pair => ({
      inventoryItemId: gid('InventoryItem', m.shopifyInventoryItemId!),
      locationId: gid('Location', pair.shopifyLocationId),
      quantity: stock.get(`${m.variantId}|${pair.ourLocationId}`) ?? 0,
      changeFromQuantity: null
    })));

    const send = () => api.graphql(Q.stock, {
      input: { name: 'available', reason: 'correction', quantities },
      key: crypto.randomUUID()
    });
    let data: any = await send();
    let errs = data?.inventorySetQuantities?.userErrors ?? [];
    // A variant the shop made by hand may not be stocked at the paired location yet.
    if (errs.some((e: any) => /not stocked|activate|NOT_STOCKED/i.test(`${e?.code} ${e?.message}`))) {
      for (const q of quantities) await api.graphql(Q.activate, { item: q.inventoryItemId, location: q.locationId }).catch(() => undefined);
      data = await send();
      errs = data?.inventorySetQuantities?.userErrors ?? [];
    }
    if (errs.length) throw new Refused(refusal(errs));

    // What we wrote, so Shopify's inventory_levels/update about it is recognised as our own voice.
    for (const q of quantities) {
      const item = numericShopifyId(q.inventoryItemId)!;
      const location = numericShopifyId(q.locationId)!;
      await prisma.shopifyInventoryEcho.upsert({
        where: { uq_shopify_echo: { installationId: mirror.installationId, shopifyInventoryItemId: item, shopifyLocationId: location } },
        create: { installationId: mirror.installationId, shopifyInventoryItemId: item, shopifyLocationId: location, quantity: q.quantity },
        update: { quantity: q.quantity, writtenAt: new Date() }
      });
    }
  }

  /** Available to sell per (variant, our location): on hand less held, nothing where it is switched off. */
  private async stockFor(variantIds: string[], scope: Scope, eligible: boolean) {
    const out = new Map<string, number>();
    if (!eligible || variantIds.length === 0) return out;
    const [stocks, profiles] = await Promise.all([
      prisma.inventoryStock.findMany({
        where: { variantId: { in: variantIds }, locationId: { in: scope.ourLocationIds } },
        select: { variantId: true, locationId: true, quantity: true, reservedQty: true }
      }),
      prisma.variantLocationProfile.findMany({
        where: { variantId: { in: variantIds }, locationId: { in: scope.ourLocationIds }, isAvailable: false },
        select: { variantId: true, locationId: true }
      }).catch(() => [] as { variantId: string; locationId: string }[])
    ]);
    const off = new Set(profiles.map(p => `${p.variantId}|${p.locationId}`));
    for (const s of stocks) {
      const k = `${s.variantId}|${s.locationId}`;
      out.set(k, off.has(k) ? 0 : Math.max(0, s.quantity - s.reservedQty));
    }
    return out;
  }

  /* ── what Shopify tells us ──────────────────────────────────────────────────────────────── */

  /** products/update. Our echo is ignored; anything else is put back, and the shop is told. */
  async onProductUpdated(shopDomain: string, payload: any): Promise<string> {
    const shopifyProductId = numericShopifyId(payload?.id);
    if (!shopifyProductId) return 'IGNORED';
    const mirror = await prisma.shopifyProductMirror.findFirst({
      where: { shopifyProductId, installation: { shopDomain, uninstalledAt: null } },
      include: { product: { select: { title: true, productCode: true } }, installation: { select: { clientId: true } } }
    });
    if (!mirror || !mirror.wanted || mirror.status === 'ARCHIVED') return 'IGNORED';
    if (mirror.installation.clientId !== mirror.clientId) return 'IGNORED';

    const theirs = canonicalFromWebhook(payload);
    let edits: string[];
    if (mirror.origin === 'MATCHED') {
      // Only the prices of matched variants are ours to compare.
      const maps = await prisma.shopifyIdMap.findMany({ where: { installationId: mirror.installationId, shopifyProductId }, select: { sku: true } });
      const ours = new Set(maps.map(m => m.sku.trim().toUpperCase()));
      const only = { title: '', words: '', variants: theirs.variants.filter(v => ours.has(v.sku.trim().toUpperCase())) };
      if (!mirror.lastHash || hashCanonical(only) === mirror.lastHash) return 'ECHO';
      edits = ['the price'];
    } else {
      const statusChanged = payload?.status && String(payload.status).toLowerCase() !== 'active';
      if (!statusChanged && hashCanonical(theirs) === mirror.lastHash) return 'ECHO';
      // What we would send now, to name what they changed.
      const scope = await this.scope(mirror.installationId);
      const p = await this.productForShopify(mirror.clientId, scope.ourLocationIds, mirror.product.productCode);
      const ours = p ? canonicalOf(renderProduct(p)) : null;
      edits = ours ? describeEdits(ours, theirs) : [];
      if (statusChanged) edits.push(`its status to ${String(payload.status).toLowerCase()}`);
      if (edits.length === 0) return 'ECHO';
    }

    await this.notice(mirror.clientId, `${SHOPIFY_NOTICE.changed}: ${mirror.product.title}`,
      `Someone changed ${edits.slice(0, 3).join(', ')} in Shopify. ScaleEzy put its own version back. To change it, edit the product here.`);
    await prisma.shopifyProductMirror.update({
      where: { id: mirror.id }, data: { status: 'PENDING', attempts: 0, nextAttemptAt: null, problem: null }
    });
    return 'APPLIED';
  }

  /** products/delete. Ours is made again; one the shop built is let go. */
  async onProductDeleted(shopDomain: string, payload: any): Promise<string> {
    const shopifyProductId = numericShopifyId(payload?.id);
    if (!shopifyProductId) return 'IGNORED';
    const mirror = await prisma.shopifyProductMirror.findFirst({
      where: { shopifyProductId, installation: { shopDomain } },
      include: { product: { select: { title: true } }, installation: { select: { clientId: true } } }
    });
    if (!mirror || mirror.installation.clientId !== mirror.clientId) return 'IGNORED';
    await prisma.shopifyIdMap.deleteMany({ where: { installationId: mirror.installationId, shopifyProductId } });

    if (mirror.origin === 'MATCHED') {
      await prisma.shopifyProductMirror.delete({ where: { id: mirror.id } });
      await this.notice(mirror.clientId, `${SHOPIFY_NOTICE.deleted}: ${mirror.product.title}`,
        'This product was deleted in Shopify, so it is no longer matched. Its sales there will not reach ScaleEzy until it is added and matched again.');
      return 'APPLIED';
    }
    if (!mirror.wanted || mirror.status === 'ARCHIVED') {
      await prisma.shopifyProductMirror.update({ where: { id: mirror.id }, data: { shopifyProductId: null, lastHash: null, imagesHash: null } });
      return 'APPLIED';
    }
    await prisma.shopifyProductMirror.update({
      where: { id: mirror.id },
      data: { shopifyProductId: null, lastHash: null, imagesHash: null, status: 'PENDING', attempts: 0, nextAttemptAt: null, problem: null }
    });
    await this.notice(mirror.clientId, `${SHOPIFY_NOTICE.deleted}: ${mirror.product.title}`,
      'This product was deleted in Shopify. ScaleEzy is putting it back, because it is switched on here. To take it off Shopify, switch off "On Shopify" on the product.');
    return 'APPLIED';
  }

  /**
   * inventory_levels/update. Our own write coming back is ignored. Anything else -- a sale in
   * Shopify, or somebody typing a number there -- is re-sent from our count a little later, once
   * the order it may have come from has landed here and moved our stock too.
   */
  async onInventoryChanged(shopDomain: string, payload: any): Promise<string> {
    const item = numericShopifyId(payload?.inventory_item_id);
    const location = numericShopifyId(payload?.location_id);
    if (!item || !location) return 'IGNORED';
    const installation = await prisma.shopifyInstallation.findUnique({ where: { shopDomain }, select: { id: true, clientId: true } });
    if (!installation?.clientId) return 'IGNORED';
    const echo = await prisma.shopifyInventoryEcho.findUnique({
      where: { uq_shopify_echo: { installationId: installation.id, shopifyInventoryItemId: item, shopifyLocationId: location } }
    });
    if (echo && Number(payload?.available) === echo.quantity) return 'ECHO';
    const map = await prisma.shopifyIdMap.findFirst({
      where: { installationId: installation.id, shopifyInventoryItemId: item }, select: { variantId: true }
    });
    const variant = map ? await prisma.productVariant.findUnique({ where: { id: map.variantId }, select: { productId: true } }) : null;
    if (!variant) return 'IGNORED';
    const r = await prisma.shopifyProductMirror.updateMany({
      where: { installationId: installation.id, clientId: installation.clientId, productId: variant.productId, wanted: true, status: { not: 'ARCHIVED' } },
      data: { stockPending: true, nextAttemptAt: new Date(Date.now() + STOCK_SETTLE_MS) }
    });
    return r.count ? 'APPLIED' : 'IGNORED';
  }

  /* ── small helpers ──────────────────────────────────────────────────────────────────────── */

  private async installation(clientId: string) {
    const installation = await prisma.shopifyInstallation.findFirst({
      where: { clientId, uninstalledAt: null }, select: { id: true, shopDomain: true }
    });
    if (!installation) throw new ShopifyApiError('No Shopify store is connected to this workspace.', 404);
    return installation;
  }

  private async scope(installationId: string): Promise<Scope> {
    const pairs = await prisma.shopifyLocationMap.findMany({
      where: { installationId }, select: { locationId: true, shopifyLocationId: true }
    });
    return {
      pairs: pairs.map(p => ({ ourLocationId: p.locationId, shopifyLocationId: p.shopifyLocationId })),
      ourLocationIds: pairs.map(p => p.locationId)
    };
  }

  private async notice(clientId: string, title: string, message: string) {
    // Pinned to the paired store: the bell lists only the store a person has chosen, so a notice
    // with no store was saved and never seen (26 Oct screen test).
    const pairing = await prisma.shopifyLocationMap.findFirst({ where: { clientId }, select: { locationId: true } }).catch(() => null);
    await prisma.inventoryAlert.create({
      data: { clientId, type: 'STOCK_DISCREPANCY', severity: 'WARNING', title: title.slice(0, 200), message, locationId: pairing?.locationId ?? null }
    }).catch(error => console.error('[shopify products] could not raise a notice', error));
  }

  private async done(id: string, data: { status?: string }) {
    await prisma.shopifyProductMirror.update({
      where: { id },
      data: { ...data, attempts: 0, nextAttemptAt: null, problem: null, lockedAt: null, lastSyncedAt: new Date() }
    });
  }

  private async failed(id: string, attempts: number, error: any): Promise<string> {
    const refused = error instanceof Refused;
    const apiProblem = error instanceof ShopifyApiError;
    const message = refused || apiProblem ? String(error.message)
      : 'Shopify could not be reached just now. It will be tried again by itself.';
    if (!refused && !apiProblem) console.error('[shopify products] push failed', error);
    // A refusal will not change by retrying; anything else is retried on the usual curve.
    const giveUp = refused || attempts >= MAX_ATTEMPTS;
    await prisma.shopifyProductMirror.update({
      where: { id },
      data: {
        status: giveUp ? 'FAILED' : 'PENDING', attempts, problem: message, lockedAt: null,
        nextAttemptAt: giveUp ? null : new Date(Date.now() + backoffMs(attempts)),
        // The stock flag was cleared before the work; put it back so it is not lost.
        stockPending: true
      }
    }).catch(() => undefined);
    return giveUp ? 'FAILED' : 'RETRY';
  }
}

interface Scope {
  pairs: { ourLocationId: string; shopifyLocationId: string }[];
  ourLocationIds: string[];
}

export const shopifyProductPushService = new ShopifyProductPushService();
