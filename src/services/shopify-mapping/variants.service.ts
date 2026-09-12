/**
 * Which Shopify product is which of ours -- matched by SKU, read-only.
 *
 * Like location pairing, nothing in the application could create a ShopifyIdMap before this.
 * Every line of every Shopify order is looked up in that table, so every real order would have
 * parked as "product not recognised". This does not push anything to Shopify (that is a separate
 * project, and a destructive one); it only reads the store's variants and adopts the ones whose
 * SKU is unmistakably one of ours.
 *
 * "Unmistakably" is the whole design. A SKU matched wrongly books a Shopify sale against the
 * wrong saree -- the wrong stock goes down, the right stock is oversold, and nothing looks broken.
 * So anything that could be two things is refused and listed, never guessed:
 *
 *   - a SKU used by two Shopify variants, or by two of ours
 *   - a Shopify variant already matched to a DIFFERENT one of ours
 *   - one of ours already matched to a DIFFERENT Shopify variant
 *   - a Shopify variant with no SKU at all
 *
 * The decision is a pure function (`planMatches`) so every one of those can be proved without a
 * store or a tenant. The service around it only reads and writes.
 */

import { prisma } from '../../lib/prisma';
import { ShopifyAdminApi, activeInstallation, numericShopifyId } from './adminApi';

const VARIANTS_QUERY = `
  query Variants($after: String) {
    productVariants(first: 250, after: $after) {
      pageInfo { hasNextPage endCursor }
      nodes { id sku title product { id title } inventoryItem { id } }
    }
  }
`;

export interface ShopifyVariant {
  shopifyVariantId: string;
  shopifyProductId: string;
  shopifyInventoryItemId: string | null;
  sku: string;
  title: string;
}

export interface OurVariant { id: string; sku: string }
export interface ExistingMap { variantId: string; shopifyVariantId: string; shopifyInventoryItemId: string | null }

/** SKUs are compared trimmed and case-blind. "sar-001 " and "SAR-001" are the same label on a shelf. */
export const skuKey = (sku: string | null | undefined) => String(sku ?? '').trim().toUpperCase();

export function planMatches(shopify: ShopifyVariant[], ours: OurVariant[], existing: ExistingMap[]) {
  const theirsBySku = new Map<string, ShopifyVariant[]>();
  let blankSku = 0;
  for (const v of shopify) {
    const key = skuKey(v.sku);
    if (!key) { blankSku++; continue; }
    theirsBySku.set(key, [...(theirsBySku.get(key) ?? []), v]);
  }

  const oursBySku = new Map<string, OurVariant[]>();
  for (const v of ours) {
    const key = skuKey(v.sku);
    if (!key) continue;
    oursBySku.set(key, [...(oursBySku.get(key) ?? []), v]);
  }

  const mapByShopify = new Map(existing.map(m => [m.shopifyVariantId, m]));
  const mapByOurs = new Map(existing.map(m => [m.variantId, m]));

  const toCreate: { variantId: string; sku: string; shopifyVariantId: string; shopifyProductId: string; shopifyInventoryItemId: string | null }[] = [];
  const toRefresh: { shopifyVariantId: string; shopifyInventoryItemId: string | null }[] = [];
  const problems: { sku: string; title: string; problem: string }[] = [];
  const notHere: { sku: string; title: string }[] = [];
  let alreadyMatched = 0;

  for (const [key, theirs] of theirsBySku) {
    const mine = oursBySku.get(key) ?? [];

    if (theirs.length > 1) {
      problems.push({
        sku: theirs[0].sku.trim(), title: theirs.map(t => t.title).join(' / '),
        problem: `${theirs.length} Shopify variants share this SKU, so there is no telling which is which. Give each its own SKU in Shopify.`
      });
      continue;
    }
    const v = theirs[0];

    if (mine.length === 0) {
      // Already matched by an earlier run under a SKU that has since changed on one side is not
      // "not here" -- it is matched, and the map is what counts.
      if (mapByShopify.has(v.shopifyVariantId)) { alreadyMatched++; continue; }
      notHere.push({ sku: v.sku.trim(), title: v.title });
      continue;
    }
    if (mine.length > 1) {
      problems.push({
        sku: v.sku.trim(), title: v.title,
        problem: `${mine.length} of your variants here share this SKU. Give each its own SKU first.`
      });
      continue;
    }
    const our = mine[0];

    const theirMap = mapByShopify.get(v.shopifyVariantId);
    if (theirMap) {
      if (theirMap.variantId !== our.id) {
        problems.push({
          sku: v.sku.trim(), title: v.title,
          problem: 'This Shopify variant is already matched to a different item here. It was left as it is.'
        });
        continue;
      }
      alreadyMatched++;
      if ((theirMap.shopifyInventoryItemId ?? null) !== v.shopifyInventoryItemId) {
        toRefresh.push({ shopifyVariantId: v.shopifyVariantId, shopifyInventoryItemId: v.shopifyInventoryItemId });
      }
      continue;
    }

    const ourMap = mapByOurs.get(our.id);
    if (ourMap) {
      problems.push({
        sku: v.sku.trim(), title: v.title,
        problem: 'Your item with this SKU is already matched to a different Shopify variant. It was left as it is.'
      });
      continue;
    }

    toCreate.push({
      variantId: our.id, sku: our.sku, shopifyVariantId: v.shopifyVariantId,
      shopifyProductId: v.shopifyProductId, shopifyInventoryItemId: v.shopifyInventoryItemId
    });
  }

  return { toCreate, toRefresh, problems, notHere, blankSku, alreadyMatched };
}

export async function fetchShopifyVariants(api: ShopifyAdminApi): Promise<ShopifyVariant[]> {
  const out: ShopifyVariant[] = [];
  let after: string | null = null;

  // 400 pages of 250 is 100,000 variants -- far past any shop this serves, and a hard stop
  // against a pagination bug walking somebody's store for ever.
  for (let page = 0; page < 400; page++) {
    const data: any = await api.graphql(VARIANTS_QUERY, { after });
    const conn = data?.productVariants;
    for (const node of conn?.nodes ?? []) {
      const shopifyVariantId = numericShopifyId(node?.id);
      const shopifyProductId = numericShopifyId(node?.product?.id);
      if (!shopifyVariantId || !shopifyProductId) continue;
      out.push({
        shopifyVariantId,
        shopifyProductId,
        shopifyInventoryItemId: numericShopifyId(node?.inventoryItem?.id),
        sku: String(node?.sku ?? ''),
        title: [node?.product?.title, node?.title].filter(t => t && t !== 'Default Title').join(' — ') || 'Untitled'
      });
    }
    if (!conn?.pageInfo?.hasNextPage) break;
    after = conn.pageInfo.endCursor;
  }
  return out;
}

export class ShopifyVariantMatchingService {
  /** How much of the store is matched, without asking Shopify anything. */
  async summary(clientId: string) {
    const installation = await activeInstallation(clientId);
    const matched = await prisma.shopifyIdMap.count({ where: { clientId, installationId: installation.id } });
    return { shopDomain: installation.shopDomain, matched };
  }

  /**
   * Read the store's variants and adopt every unambiguous SKU match.
   *
   * Safe to run any number of times: an existing match is kept (its inventory item id refreshed
   * if Shopify changed it), nothing is ever re-pointed, and nothing is deleted. A merchant who
   * fixes a duplicate SKU and runs it again gets exactly the one new match.
   */
  async matchBySku(clientId: string, api: ShopifyAdminApi) {
    const installation = await activeInstallation(clientId);

    const [shopify, ours, existing] = await Promise.all([
      fetchShopifyVariants(api),
      prisma.productVariant.findMany({ where: { clientId }, select: { id: true, sku: true } }),
      prisma.shopifyIdMap.findMany({
        where: { clientId, installationId: installation.id },
        select: { variantId: true, shopifyVariantId: true, shopifyInventoryItemId: true }
      })
    ]);

    const plan = planMatches(shopify, ours, existing);

    let created = 0;
    if (plan.toCreate.length > 0) {
      const result = await prisma.shopifyIdMap.createMany({
        data: plan.toCreate.map(m => ({
          installationId: installation.id, clientId, origin: 'MATCHED', ...m
        })),
        // A second run racing this one writes the same pairs; the unique keys keep one of each.
        skipDuplicates: true
      });
      created = result.count;
    }

    for (const r of plan.toRefresh) {
      await prisma.shopifyIdMap.updateMany({
        where: { installationId: installation.id, shopifyVariantId: r.shopifyVariantId },
        data: { shopifyInventoryItemId: r.shopifyInventoryItemId }
      });
    }

    return {
      shopDomain: installation.shopDomain,
      shopifyVariants: shopify.length,
      newlyMatched: created,
      alreadyMatched: plan.alreadyMatched,
      withoutSku: plan.blankSku,
      notHere: { count: plan.notHere.length, examples: plan.notHere.slice(0, 50) },
      problems: { count: plan.problems.length, examples: plan.problems.slice(0, 50) },
      totalMatched: await prisma.shopifyIdMap.count({ where: { clientId, installationId: installation.id } })
    };
  }
}

export const shopifyVariantMatchingService = new ShopifyVariantMatchingService();
