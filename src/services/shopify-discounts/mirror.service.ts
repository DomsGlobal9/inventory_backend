/**
 * Keeping an offer's Shopify copy true.
 *
 * translate.ts decides what an offer MEANS in Shopify. This does the rest, and most of it is about
 * the ways a copy stops being true:
 *
 *   PUSH        the offer changed here -- make Shopify's copy match. Absolute state every time, so a
 *               retry cannot corrupt anything.
 *   RECONCILE   read the copy back on a schedule, and when Shopify tells us it changed. If a merchant
 *               edited or deleted it inside Shopify, say so on the offer instead of silently
 *               overwriting their change or silently believing ours still stands.
 *   RESOLVE     "Push ours" or "Accept theirs" -- the merchant decides, not a timer.
 *
 * Three guards worth knowing before changing anything:
 *
 *   NO DUPLICATES   every discount we create carries a tag naming the offer. A push that timed out
 *                   after Shopify created the discount is found by that tag on retry and updated,
 *                   rather than a second, identical discount appearing in the merchant's store.
 *   READ BEFORE     an update first reads the discount. Shopify's update ADDS products to a discount
 *                   rather than replacing the list, so what to remove can only be known by looking;
 *                   and a discount deleted in Shopify is reported as deleted, not quietly recreated.
 *   READ AFTER      a push is only "synced" once reading it back gives what we sent. Anything Shopify
 *                   did not keep is a failure with the difference named -- not a green tick over a
 *                   copy that charges something else.
 */

import { prisma } from '../../lib/prisma';
import { getShopSettings } from '../../lib/clientSettings';
import { badRequest, conflict, notFound } from '../../utils/httpError';
import { backoffMs } from '../../utils/retryBackoff';
import { offerService } from '../offers';
import { ShopifyAdminApi, ShopifyApiError } from '../shopify-mapping';
import {
  MirrorableOffer, TranslationContext, CanonicalDiscount,
  translateOffer, canonicalFromShopify, hashCanonical, describeDifferences, mirrorTag
} from './translate';

export type MirrorStatus = 'PENDING' | 'SYNCED' | 'DRIFTED' | 'FAILED' | 'UNSUPPORTED' | 'REMOVING';

export type ApiFor = (installation: { id: string; shopDomain: string }) => Promise<ShopifyAdminApi>;

const LEASE_MS = 2 * 60 * 1000;
const MAX_ATTEMPTS = 8;
/** How often a synced copy is read back when nothing told us it changed. */
export const RECONCILE_EVERY_MS = 30 * 60 * 1000;

const DISCOUNT_FIELDS = `
  __typename
  ... on DiscountAutomaticBasic {
    title startsAt endsAt tags
    combinesWith { productDiscounts orderDiscounts shippingDiscounts }
    minimumRequirement {
      ... on DiscountMinimumSubtotal { greaterThanOrEqualToSubtotal { amount } }
      ... on DiscountMinimumQuantity { greaterThanOrEqualToQuantity }
    }
    customerGets {
      value {
        __typename
        ... on DiscountPercentage { percentage }
        ... on DiscountAmount { amount { amount } appliesOnEachItem }
      }
      items {
        __typename
        ... on AllDiscountItems { allItems }
        ... on DiscountProducts {
          products(first: 250) { nodes { id } }
          productVariants(first: 250) { nodes { id } }
        }
      }
    }
  }
  ... on DiscountCodeBasic {
    title startsAt endsAt tags appliesOncePerCustomer
    codes(first: 1) { nodes { code } }
    combinesWith { productDiscounts orderDiscounts shippingDiscounts }
    minimumRequirement {
      ... on DiscountMinimumSubtotal { greaterThanOrEqualToSubtotal { amount } }
      ... on DiscountMinimumQuantity { greaterThanOrEqualToQuantity }
    }
    customerGets {
      value {
        __typename
        ... on DiscountPercentage { percentage }
        ... on DiscountAmount { amount { amount } appliesOnEachItem }
      }
      items {
        __typename
        ... on AllDiscountItems { allItems }
        ... on DiscountProducts {
          products(first: 250) { nodes { id } }
          productVariants(first: 250) { nodes { id } }
        }
      }
    }
  }
`;

export const QUERIES = {
  node: `query MirrorDiscount($id: ID!) { discountNode(id: $id) { id discount { ${DISCOUNT_FIELDS} } } }`,
  byTag: `query MirrorDiscountByTag($query: String!) { discountNodes(first: 2, query: $query) { nodes { id discount { __typename } } } }`,
  shop: `query MirrorShop { shop { currencyCode } }`,
  createAutomatic: `mutation MirrorCreateAutomatic($d: DiscountAutomaticBasicInput!) {
    discountAutomaticBasicCreate(automaticBasicDiscount: $d) { automaticDiscountNode { id } userErrors { field code message } } }`,
  updateAutomatic: `mutation MirrorUpdateAutomatic($id: ID!, $d: DiscountAutomaticBasicInput!) {
    discountAutomaticBasicUpdate(id: $id, automaticBasicDiscount: $d) { automaticDiscountNode { id } userErrors { field code message } } }`,
  deleteAutomatic: `mutation MirrorDeleteAutomatic($id: ID!) {
    discountAutomaticDelete(id: $id) { deletedAutomaticDiscountId userErrors { field code message } } }`,
  createCode: `mutation MirrorCreateCode($d: DiscountCodeBasicInput!) {
    discountCodeBasicCreate(basicCodeDiscount: $d) { codeDiscountNode { id } userErrors { field code message } } }`,
  updateCode: `mutation MirrorUpdateCode($id: ID!, $d: DiscountCodeBasicInput!) {
    discountCodeBasicUpdate(id: $id, basicCodeDiscount: $d) { codeDiscountNode { id } userErrors { field code message } } }`,
  deleteCode: `mutation MirrorDeleteCode($id: ID!) {
    discountCodeDelete(id: $id) { deletedCodeDiscountId userErrors { field code message } } }`
};

/** A refusal from Shopify that retrying will not change. */
class ShopifyRefused extends Error {}

/** Shopify's userErrors, as a sentence a merchant can act on. */
export function refusalMessage(userErrors: { code?: string; message?: string; field?: string[] }[], offer: { couponCode: string | null }): string {
  const codes = userErrors.map(e => e.code);
  if (codes.includes('ACTIVE_PERIOD_OVERLAP')) {
    return 'Shopify allows 25 automatic discounts to be active at the same time, and this store already has 25 during these dates. End one in Shopify, or change this offer\'s dates.';
  }
  if (codes.includes('MAX_APP_DISCOUNTS')) {
    return 'Shopify limits how many app discounts can be active at once, and this store has reached that limit during these dates.';
  }
  if (codes.includes('TAKEN') && offer.couponCode) {
    return `The code ${offer.couponCode} is already used by another discount in your Shopify store. Change the code here, or remove the other one in Shopify.`;
  }
  const said = userErrors.map(e => e.message).filter(Boolean).join(' ');
  return `Shopify refused it: ${said || 'no reason was given.'}`;
}

function assertNoUserErrors(result: any, offer: { couponCode: string | null }) {
  const errors = result?.userErrors ?? [];
  if (errors.length > 0) throw new ShopifyRefused(refusalMessage(errors, offer));
}

function asMirrorable(o: any): MirrorableOffer {
  return {
    id: o.id, name: o.name, status: o.status, trigger: o.trigger, couponCode: o.couponCode,
    level: o.level, valueType: o.valueType, value: Number(o.value),
    maxDiscount: o.maxDiscount == null ? null : Number(o.maxDiscount),
    scope: o.scope, targets: (o.targets ?? []).map((t: any) => ({ scope: t.scope, refId: t.refId })),
    minSubtotal: o.minSubtotal == null ? null : Number(o.minSubtotal),
    minQuantity: o.minQuantity, channels: o.channels ?? [], locationIds: o.locationIds ?? [],
    startsAt: new Date(o.startsAt), endsAt: o.endsAt ? new Date(o.endsAt) : null,
    usageLimit: o.usageLimit, usageLimitPerCustomer: o.usageLimitPerCustomer, stackable: o.stackable,
    perPiece: !!o.perPiece,
    exclusions: (o.exclusions ?? []).map((e: any) => ({ scope: e.scope, refId: e.refId })),
    customerTags: o.customerTags ?? [], schedule: o.schedule ?? null, uniqueCodes: !!o.uniqueCodes
  };
}

export class OfferMirrorService {
  // ── context ────────────────────────────────────────────────────────────────

  /**
   * Everything the translator needs about one store, loaded once per offer.
   *
   * `storeCurrency` is asked of Shopify only when an api is given. The preview on the offer screen
   * passes none -- a Settings page should not call a merchant's store every time it opens -- and
   * the currency check then happens at push time instead.
   */
  async contextFor(clientId: string, installationId: string, offer: any, api?: ShopifyAdminApi): Promise<TranslationContext> {
    const [settings, idMaps, locationMaps] = await Promise.all([
      getShopSettings(clientId),
      prisma.shopifyIdMap.findMany({
        where: { clientId, installationId },
        select: { variantId: true, shopifyVariantId: true, shopifyProductId: true }
      }),
      prisma.shopifyLocationMap.findMany({ where: { clientId, installationId }, select: { locationId: true } })
    ]);

    // ShopifyIdMap records variants; offers can name products. Which product each matched variant
    // belongs to is asked separately, in one query.
    const variants = idMaps.length
      ? await prisma.productVariant.findMany({
          where: { id: { in: idMaps.map(m => m.variantId) } }, select: { id: true, productId: true }
        })
      : [];
    const productOfVariant = new Map(variants.map(v => [v.id, v.productId]));

    const shopifyVariantOf = new Map<string, string>();
    const shopifyProductsOf = new Map<string, string[]>();
    for (const m of idMaps) {
      shopifyVariantOf.set(m.variantId, m.shopifyVariantId);
      const productId = productOfVariant.get(m.variantId);
      if (!productId) continue;
      const list = shopifyProductsOf.get(productId) ?? [];
      if (!list.includes(m.shopifyProductId)) list.push(m.shopifyProductId);
      shopifyProductsOf.set(productId, list);
    }

    // Names for the "not matched" message, only for what this offer names.
    const labelOf = new Map<string, string>();
    const refIds = (offer?.targets ?? []).map((t: any) => t.refId);
    if (refIds.length) {
      const [products, variants] = await Promise.all([
        prisma.product.findMany({ where: { id: { in: refIds }, clientId }, select: { id: true, title: true } }),
        prisma.productVariant.findMany({ where: { id: { in: refIds }, clientId }, select: { id: true, sku: true } })
      ]);
      products.forEach(p => labelOf.set(p.id, p.title));
      variants.forEach(v => labelOf.set(v.id, v.sku));
    }

    let storeCurrency: string | null = null;
    if (api) {
      const data: any = await api.graphql(QUERIES.shop);
      storeCurrency = data?.shop?.currencyCode ?? null;
    }

    return {
      now: new Date(),
      shopCurrency: settings.currency,
      storeCurrency,
      shopifyVariantOf,
      shopifyProductsOf,
      sellingLocationIds: locationMaps.map(l => l.locationId),
      labelOf
    };
  }

  private async installationFor(clientId: string) {
    return prisma.shopifyInstallation.findFirst({
      where: { clientId, uninstalledAt: null },
      select: { id: true, shopDomain: true, scopes: true }
    });
  }

  /** A granted write implies the read, so write_discounts alone is enough. */
  private canWriteDiscounts(scopes: string) {
    return scopes.split(',').map(s => s.trim()).includes('write_discounts');
  }

  // ── what the offer screen asks ─────────────────────────────────────────────

  /** The state of an offer's Shopify copy, and -- when there is none -- whether there could be. */
  async overview(clientId: string, offerId: string) {
    const offer = await prisma.offer.findFirst({ where: { id: offerId, clientId }, include: { targets: true, exclusions: true } });
    if (!offer) throw notFound('That offer no longer exists.');

    const installation = await this.installationFor(clientId);
    if (!installation) return { connected: false as const };

    const mirror = await prisma.offerExternalMirror.findUnique({
      where: { uq_mirror_offer_installation: { offerId, installationId: installation.id } }
    });

    const preview = translateOffer(asMirrorable(offer), await this.contextFor(clientId, installation.id, offer));

    return {
      connected: true as const,
      shopDomain: installation.shopDomain,
      canWrite: this.canWriteDiscounts(installation.scopes),
      mirror: mirror && {
        status: mirror.status as MirrorStatus,
        problem: mirror.problem,
        lastPushedAt: mirror.lastPushedAt,
        lastCheckedAt: mirror.lastCheckedAt,
        attempts: mirror.attempts,
        onShopify: !!mirror.shopifyDiscountId
      },
      canBeMirrored: preview.ok,
      reasons: preview.ok ? [] : preview.reasons
    };
  }

  /** One line per offer for the list screen. */
  async summaries(clientId: string, offerIds: string[]) {
    if (!offerIds.length) return new Map<string, { status: string; problem: string | null }>();
    const rows = await prisma.offerExternalMirror.findMany({
      where: { clientId, offerId: { in: offerIds } },
      select: { offerId: true, status: true, problem: true }
    });
    return new Map(rows.map(r => [r.offerId, { status: r.status, problem: r.problem }]));
  }

  /** "Put this offer on Shopify." */
  async enable(clientId: string, offerId: string, userId?: string) {
    const offer = await prisma.offer.findFirst({ where: { id: offerId, clientId }, include: { targets: true, exclusions: true } });
    if (!offer) throw notFound('That offer no longer exists.');
    if (offer.status === 'ARCHIVED') throw conflict('A retired offer cannot be put on Shopify.');
    if (offer.status === 'DRAFT') throw badRequest('Start the offer first. A draft is not put on Shopify.');

    const installation = await this.installationFor(clientId);
    if (!installation) throw badRequest('No Shopify store is connected to this workspace.');
    if (!this.canWriteDiscounts(installation.scopes)) {
      throw badRequest('Your Shopify store has not given this app permission to manage discounts. Reconnect it in Settings > Storefront and approve discounts.');
    }

    // Refused up front when it cannot be expressed, so "Put on Shopify" never appears to work and
    // then fail a minute later for a reason that was knowable now.
    const preview = translateOffer(asMirrorable(offer), await this.contextFor(clientId, installation.id, offer));
    if (!preview.ok) throw badRequest(preview.reasons.join(' '));

    return prisma.offerExternalMirror.upsert({
      where: { uq_mirror_offer_installation: { offerId, installationId: installation.id } },
      create: { clientId, offerId, installationId: installation.id, status: 'PENDING', createdBy: userId ?? null },
      update: { status: 'PENDING', problem: null, attempts: 0, nextAttemptAt: null }
    });
  }

  /** "Take it off Shopify." The discount is deleted there, then the record here. */
  async disable(clientId: string, offerId: string) {
    const { count } = await prisma.offerExternalMirror.updateMany({
      where: { clientId, offerId },
      data: { status: 'REMOVING', attempts: 0, nextAttemptAt: null, lockedAt: null, problem: null }
    });
    if (count === 0) throw notFound('This offer is not on Shopify.');
    return { removing: true };
  }

  /**
   * "Push ours" -- and "Retry" after a failure.
   *
   * For a copy deleted in Shopify this recreates it: the merchant is looking at the message saying
   * it was deleted and has chosen to put it back, which is a decision, not an accident.
   */
  async pushOurs(clientId: string, offerId: string) {
    const mirror = await prisma.offerExternalMirror.findFirst({ where: { clientId, offerId } });
    if (!mirror) throw notFound('This offer is not on Shopify.');
    if (mirror.status === 'REMOVING') throw conflict('This offer is being taken off Shopify.');

    const deletedThere = mirror.status === 'FAILED' && (mirror.problem ?? '').startsWith('Deleted in Shopify');
    return prisma.offerExternalMirror.update({
      where: { id: mirror.id },
      data: {
        status: 'PENDING', problem: null, attempts: 0, nextAttemptAt: null, lockedAt: null,
        ...(deletedThere ? { shopifyDiscountId: null, kind: null } : {})
      }
    });
  }

  /**
   * "Accept theirs" -- make the offer here say what the Shopify copy now says.
   *
   * Written through offerService.update, so the change is versioned like any other: the order
   * history keeps pointing at the rule that priced it, and the new version records that it came
   * from Shopify. Refused when Shopify's version says something an offer here cannot.
   */
  async acceptTheirs(clientId: string, offerId: string, userId: string | undefined, apiFor: ApiFor) {
    const mirror = await prisma.offerExternalMirror.findFirst({
      where: { clientId, offerId }, include: { installation: { select: { id: true, shopDomain: true } } }
    });
    if (!mirror) throw notFound('This offer is not on Shopify.');
    if (mirror.status !== 'DRIFTED' || !mirror.shopifyDiscountId) {
      throw conflict('There is no Shopify change waiting to be accepted.');
    }
    const offer = await prisma.offer.findFirstOrThrow({ where: { id: offerId }, include: { targets: true, exclusions: true } });

    const api = await apiFor(mirror.installation);
    const data: any = await api.graphql(QUERIES.node, { id: mirror.shopifyDiscountId });
    const theirs = canonicalFromShopify(data?.discountNode?.discount, new Date());
    if (!theirs) throw conflict('The Shopify copy is gone. It cannot be accepted.');

    const ctx = await this.contextFor(clientId, mirror.installationId, offer);

    // An offer that has since gained something Shopify cannot hold (customer groups, left-out items,
    // hours, single-use codes) would keep that after accepting, and the next push would take the copy
    // off Shopify anyway -- "accepted" followed by the discount disappearing. Said now instead.
    const asItStands = translateOffer(asMirrorable(offer), ctx);
    if (!asItStands.ok) {
      throw conflict(`This offer can no longer be copied to Shopify, so Shopify's version cannot be accepted: ${asItStands.reasons.join(' ')}`);
    }

    const changes = this.offerChangesFrom(theirs, ctx);

    await offerService.update(clientId, offerId, changes.input as any, userId,
      'Accepted the version edited in Shopify');

    if (theirs.window === 'ENDED' && offer.status === 'ACTIVE') {
      await offerService.setStatus(clientId, offerId, 'PAUSED', userId);
    } else if (theirs.window !== 'ENDED' && offer.status === 'PAUSED') {
      await offerService.setStatus(clientId, offerId, 'ACTIVE', userId);
    }

    // The update above marked the copy PENDING. The push that follows sends back what Shopify
    // already holds -- a no-op there -- and confirms both sides agree.
    return { accepted: true };
  }

  private offerChangesFrom(theirs: CanonicalDiscount, ctx: TranslationContext) {
    const input: Record<string, unknown> = {
      name: theirs.title,
      trigger: theirs.kind,
      couponCode: theirs.kind === 'CODE' ? theirs.code : null,
      stackable: theirs.combines.product || theirs.combines.order,
      minSubtotal: theirs.minSubtotal != null ? Number(theirs.minSubtotal) : null,
      minQuantity: theirs.minQuantity,
      usageLimitPerCustomer: theirs.oncePerCustomer ? 1 : null
    };

    if (theirs.window !== 'ENDED') {
      input.startsAt = new Date(theirs.window.startsAt);
      input.endsAt = theirs.window.endsAt ? new Date(theirs.window.endsAt) : null;
    }

    if ('percentage' in theirs.value) {
      input.valueType = 'PERCENTAGE';
      input.value = Math.round(Number(theirs.value.percentage) * 10000) / 100;
      input.maxDiscount = null;
    } else if (!theirs.value.eachItem) {
      input.valueType = 'FIXED_AMOUNT';
      input.level = 'ORDER';
      input.perPiece = false;
      input.value = Number(theirs.value.amount);
    } else {
      // An amount off each item: an offer here says that as "off each piece".
      input.valueType = 'FIXED_AMOUNT';
      input.level = 'LINE';
      input.perPiece = true;
      input.value = Number(theirs.value.amount);
    }

    if (theirs.items === 'ALL') {
      input.scope = 'ALL';
      input.targets = [];
    } else if (theirs.items.variants.length && !theirs.items.products.length) {
      const ours = new Map([...ctx.shopifyVariantOf].map(([o, s]) => [s, o]));
      const mapped = theirs.items.variants.map(v => ours.get(v));
      if (mapped.some(m => !m)) {
        throw badRequest('In Shopify this now covers items that are not matched to products here. Match them by SKU first, or push ours.');
      }
      input.scope = 'VARIANT';
      input.targets = mapped.map(refId => ({ scope: 'VARIANT', refId }));
    } else if (theirs.items.products.length && !theirs.items.variants.length) {
      const ours = new Map<string, string>();
      for (const [productId, shopifyIds] of ctx.shopifyProductsOf) shopifyIds.forEach(s => ours.set(s, productId));
      const mapped = [...new Set(theirs.items.products.map(p => ours.get(p)))];
      if (mapped.some(m => !m)) {
        throw badRequest('In Shopify this now covers products that are not matched here. Match them by SKU first, or push ours.');
      }
      input.scope = 'PRODUCT';
      input.targets = mapped.map(refId => ({ scope: 'PRODUCT', refId }));
    } else {
      throw badRequest('In Shopify this now mixes whole products and single variants, which an offer here cannot say. Push ours, or change it in Shopify.');
    }

    return { input };
  }

  // ── the work ───────────────────────────────────────────────────────────────

  /** Claim one row for work. A claim is a lease: a worker that dies costs one retry, not the row. */
  private async claim(id: string): Promise<boolean> {
    const staleBefore = new Date(Date.now() - LEASE_MS);
    const { count } = await prisma.offerExternalMirror.updateMany({
      where: { id, OR: [{ lockedAt: null }, { lockedAt: { lt: staleBefore } }] },
      data: { lockedAt: new Date() }
    });
    return count === 1;
  }

  /** Push or remove one mirror. Returns what happened, for the worker's log and for tests. */
  async process(mirrorId: string, apiFor: ApiFor): Promise<string> {
    if (!(await this.claim(mirrorId))) return 'BUSY';

    const mirror = await prisma.offerExternalMirror.findUnique({
      where: { id: mirrorId },
      include: {
        offer: { include: { targets: true, exclusions: true } },
        installation: { select: { id: true, shopDomain: true, scopes: true, uninstalledAt: true } }
      }
    });
    if (!mirror) return 'GONE';

    const release = (data: Record<string, unknown>) => this.settle(mirror, data);

    /*
     * Taken off Shopify before it ever got there -- or from a store that has uninstalled the app.
     *
     * Nothing to delete on Shopify's side, or no way left to reach it, so the copy is simply
     * forgotten. Asking Shopify first would make "take it off" retry for ever against a store that
     * cannot answer, for a discount that does not exist.
     */
    const removing = mirror.status === 'REMOVING' || mirror.offer.status === 'ARCHIVED';
    if (removing && (!mirror.shopifyDiscountId || mirror.installation.uninstalledAt)) {
      /*
       * Without an id there may still be a discount there: a create Shopify carried out whose answer
       * never reached us. So Shopify is asked once, by the tag, while it can be -- but only asked, never
       * waited on: if the store cannot answer, the copy is forgotten as before rather than retried.
       */
      if (!mirror.shopifyDiscountId && !mirror.installation.uninstalledAt && this.canWriteDiscounts(mirror.installation.scopes)) {
        try {
          const api = await apiFor(mirror.installation);
          for (const node of await this.findByTag(api, mirror.offerId)) await this.deleteRemote(api, node.id, null);
        } catch (error) {
          console.error(`[offer mirror] ${mirror.id}: could not check Shopify for an untracked copy`, error);
        }
      }
      await prisma.offerExternalMirror.delete({ where: { id: mirror.id } });
      return 'REMOVED';
    }

    if (mirror.installation.uninstalledAt) {
      await release({ status: 'FAILED', problem: 'The app was uninstalled from this Shopify store.', nextAttemptAt: null });
      return 'FAILED';
    }
    if (!this.canWriteDiscounts(mirror.installation.scopes)) {
      await release({
        status: 'FAILED', nextAttemptAt: null,
        problem: 'Your Shopify store has not given this app permission to manage discounts. Reconnect it in Settings > Storefront and approve discounts, then retry.'
      });
      return 'FAILED';
    }

    try {
      const api = await apiFor(mirror.installation);

      if (removing) {
        if (mirror.shopifyDiscountId) await this.deleteRemote(api, mirror.shopifyDiscountId, mirror.kind);
        await prisma.offerExternalMirror.delete({ where: { id: mirror.id } });
        return 'REMOVED';
      }

      const ctx = await this.contextFor(mirror.clientId, mirror.installationId, mirror.offer, api);
      const translation = translateOffer(asMirrorable(mirror.offer), ctx);

      if (!translation.ok) {
        /*
         * It WAS expressible, and an edit here made it not.
         *
         * Leaving the old copy live would keep charging the old rule online. So the Shopify copy is
         * removed and the reason is shown -- the merchant sees exactly why their offer is no longer
         * on Shopify, rather than finding out from a customer.
         */
        let removedNote = '';
        // Including one created without us learning its id -- found by its tag, or it would stay live
        // on Shopify with nothing here tracking it.
        const stale = mirror.shopifyDiscountId
          ? [{ id: mirror.shopifyDiscountId, kind: mirror.kind }]
          : (await this.findByTag(api, mirror.offerId)).map(n => ({ id: n.id, kind: null }));
        for (const copy of stale) await this.deleteRemote(api, copy.id, copy.kind);
        if (stale.length) removedNote = ' The copy on Shopify was removed so it cannot charge the old rule.';
        await release({
          status: 'UNSUPPORTED', problem: translation.reasons.join(' ') + removedNote,
          shopifyDiscountId: null, kind: null, pushedHash: null, remoteHash: null, nextAttemptAt: null, attempts: 0
        });
        return 'UNSUPPORTED';
      }

      let discountId = mirror.shopifyDiscountId;
      let kind = mirror.kind;

      // Switched between automatic and code: Shopify cannot turn one into the other.
      if (discountId && kind && kind !== translation.kind) {
        await this.deleteRemote(api, discountId, kind);
        discountId = null;
      }

      // A push that timed out after Shopify created the discount: find it by its tag.
      if (!discountId) {
        const node = (await this.findByTag(api, mirror.offerId)).find((n: any) =>
          (translation.kind === 'CODE' ? n.discount?.__typename === 'DiscountCodeBasic' : n.discount?.__typename === 'DiscountAutomaticBasic'));
        if (node) discountId = node.id;
      }

      let currentNode: any = null;
      if (discountId) {
        const before: any = await api.graphql(QUERIES.node, { id: discountId });
        const current = before?.discountNode?.discount;
        if (!current) {
          await release({
            status: 'FAILED', nextAttemptAt: null,
            problem: 'Deleted in Shopify. Push ours to put it back, or take it off Shopify here.'
          });
          return 'FAILED';
        }
        currentNode = current;
        const held = canonicalFromShopify(current, ctx.now);

        /*
         * A minimum spend or item count removed here.
         *
         * Shopify's reference does not say how an update clears a minimum requirement, and an update
         * that simply leaves it out may keep it -- which would go on refusing the discount to
         * customers who now qualify. Rather than guess at an undocumented way to clear it, the
         * discount is replaced: deleted and created again, using only operations whose behaviour is
         * documented. The cost is Shopify's own usage count for it starting again.
         */
        if (held && (held.minSubtotal != null || held.minQuantity != null)
            && translation.canonical.minSubtotal == null && translation.canonical.minQuantity == null) {
          await this.deleteRemote(api, discountId, kind ?? translation.kind);
          discountId = null;
        }
      }

      if (discountId) {
        const input = this.withRemovals(translation.input, canonicalFromShopify(currentNode, ctx.now), translation.canonical);
        const result: any = await api.graphql(
          translation.kind === 'CODE' ? QUERIES.updateCode : QUERIES.updateAutomatic,
          { id: discountId, d: input }
        );
        assertNoUserErrors(translation.kind === 'CODE' ? result?.discountCodeBasicUpdate : result?.discountAutomaticBasicUpdate, mirror.offer);
      } else {
        const result: any = await api.graphql(
          translation.kind === 'CODE' ? QUERIES.createCode : QUERIES.createAutomatic,
          { d: translation.input }
        );
        const payload = translation.kind === 'CODE' ? result?.discountCodeBasicCreate : result?.discountAutomaticBasicCreate;
        assertNoUserErrors(payload, mirror.offer);
        discountId = translation.kind === 'CODE' ? payload?.codeDiscountNode?.id : payload?.automaticDiscountNode?.id;
        if (!discountId) throw new ShopifyApiError('Shopify did not say what it created.');
      }
      kind = translation.kind;

      // Read it back: "synced" means Shopify holds what we sent, not that it said OK.
      const after: any = await api.graphql(QUERIES.node, { id: discountId });
      const held = canonicalFromShopify(after?.discountNode?.discount, new Date());
      const heldHash = held ? hashCanonical(held) : null;

      if (!held || heldHash !== translation.hash) {
        const differences = held ? describeDifferences(translation.canonical, held) : ['everything'];
        await release({
          status: 'FAILED', shopifyDiscountId: discountId, kind, remoteHash: heldHash, nextAttemptAt: null,
          problem: `Shopify did not keep all of it: ${differences.join(', ')} differ from this offer. Check the discount in Shopify, then push ours again.`
        });
        return 'FAILED';
      }

      await release({
        status: 'SYNCED', shopifyDiscountId: discountId, kind, pushedHash: translation.hash, remoteHash: heldHash,
        problem: null, attempts: 0, nextAttemptAt: null, lastPushedAt: new Date(), lastCheckedAt: new Date()
      });
      return 'SYNCED';
    } catch (error: any) {
      if (error instanceof ShopifyRefused) {
        // Shopify said no, and will say no again. Retrying would only hide the reason.
        await release({ status: 'FAILED', problem: error.message, nextAttemptAt: null });
        return 'FAILED';
      }
      const attempts = mirror.attempts + 1;
      const exhausted = attempts >= MAX_ATTEMPTS;
      const reason = error instanceof ShopifyApiError ? error.message : 'Could not reach Shopify.';
      if (!(error instanceof ShopifyApiError)) console.error(`[offer mirror] ${mirror.id} failed`, error);
      await release({
        attempts,
        status: exhausted ? 'FAILED' : mirror.status,
        problem: exhausted ? `${reason} Gave up after ${attempts} tries -- press Retry.` : `${reason} Trying again shortly.`,
        nextAttemptAt: exhausted ? null : new Date(Date.now() + backoffMs(attempts))
      });
      return exhausted ? 'FAILED' : 'RETRYING';
    }
  }

  /**
   * Shopify's update adds to a discount's product list; it does not replace it.
   *
   * So a product dropped from the offer here has to be removed explicitly, and the only way to know
   * what Shopify still holds is to have read it. Switching from "everything" to a list needs `all`
   * turned off as well.
   */
  private withRemovals(input: Record<string, any>, current: CanonicalDiscount | null, desired: CanonicalDiscount) {
    if (!current || current.items === 'ALL' || desired.items === 'ALL') return input;
    const d = desired.items as { products: string[]; variants: string[] };
    const productsToRemove = current.items.products.filter(p => !d.products.includes(p)).map(p => `gid://shopify/Product/${p}`);
    const productVariantsToRemove = current.items.variants.filter(v => !d.variants.includes(v)).map(v => `gid://shopify/ProductVariant/${v}`);
    if (!productsToRemove.length && !productVariantsToRemove.length) return input;
    return {
      ...input,
      customerGets: {
        ...input.customerGets,
        items: {
          products: { ...input.customerGets.items.products, productsToRemove, productVariantsToRemove }
        }
      }
    };
  }

  /** Discounts on Shopify carrying this offer's tag -- how a copy whose id we never saved is found. */
  private async findByTag(api: ShopifyAdminApi, offerId: string): Promise<{ id: string; discount?: { __typename?: string } }[]> {
    const found: any = await api.graphql(QUERIES.byTag, { query: `tag:'${mirrorTag(offerId)}'` });
    return found?.discountNodes?.nodes ?? [];
  }

  /**
   * Finish with a claimed mirror: write what happened, and let go of it.
   *
   * Unless something moved while it was being worked on. A push takes several Shopify calls; if the
   * merchant edits the offer (or takes it off Shopify) in those seconds, writing SYNCED from the
   * version loaded before the edit would leave Shopify holding the older, looser rule while this
   * says all is well -- for up to half an hour, until a read-back noticed. So the write only lands if
   * the offer is unchanged and the mirror's status is still the one it was claimed with. Otherwise
   * what Shopify now holds is still recorded, and the copy is left for the next pass.
   */
  private async settle(
    mirror: { id: string; offerId: string; status: string; offer: { updatedAt: Date } },
    data: Record<string, unknown>,
    extra: Record<string, unknown> = {}
  ) {
    const offerNow = await prisma.offer.findUnique({ where: { id: mirror.offerId }, select: { updatedAt: true } });
    const offerMoved = !offerNow || offerNow.updatedAt.getTime() !== mirror.offer.updatedAt.getTime();
    if (!offerMoved) {
      const done = await prisma.offerExternalMirror.updateMany({
        where: { id: mirror.id, status: mirror.status as any },
        data: { lockedAt: null, ...extra, ...data }
      });
      if (done.count === 1) return;
    }
    const known: Record<string, unknown> = { lockedAt: null, ...extra };
    for (const key of ['shopifyDiscountId', 'kind'] as const) if (key in data) known[key] = data[key];
    await prisma.offerExternalMirror.updateMany({ where: { id: mirror.id }, data: known });
    if (offerMoved) {
      await prisma.offerExternalMirror.updateMany({
        where: { id: mirror.id, status: { not: 'REMOVING' } },
        data: { status: 'PENDING', attempts: 0, nextAttemptAt: null, problem: null }
      });
    }
  }

  private async deleteRemote(api: ShopifyAdminApi, discountId: string, kind: string | null) {
    const isCode = kind === 'CODE' || /DiscountCodeNode/.test(discountId);
    const result: any = await api.graphql(isCode ? QUERIES.deleteCode : QUERIES.deleteAutomatic, { id: discountId });
    const payload = isCode ? result?.discountCodeDelete : result?.discountAutomaticDelete;
    const errors = payload?.userErrors ?? [];
    // Already gone is the outcome we wanted.
    if (errors.length && !errors.every((e: any) => /not exist|not found|could not find/i.test(String(e.message)))) {
      throw new ShopifyRefused(`Shopify would not remove the discount: ${errors.map((e: any) => e.message).join(' ')}`);
    }
  }

  /**
   * Read a synced copy back, and say whether it still matches.
   *
   * Compared with what the offer says NOW as well as with what was pushed: an offer that simply
   * reached its end date reads back as ended in Shopify too, and that is agreement, not drift.
   */
  async reconcile(mirrorId: string, apiFor: ApiFor): Promise<string> {
    if (!(await this.claim(mirrorId))) return 'BUSY';
    const mirror = await prisma.offerExternalMirror.findUnique({
      where: { id: mirrorId },
      include: { offer: { include: { targets: true, exclusions: true } }, installation: { select: { id: true, shopDomain: true, uninstalledAt: true } } }
    });
    if (!mirror) return 'GONE';
    const release = (data: Record<string, unknown>) => this.settle(mirror, data, { lastCheckedAt: new Date() });

    if (!mirror.shopifyDiscountId || mirror.installation.uninstalledAt) {
      await release({});
      return 'SKIPPED';
    }

    try {
      const api = await apiFor(mirror.installation);
      const data: any = await api.graphql(QUERIES.node, { id: mirror.shopifyDiscountId });
      const now = new Date();
      const theirs = canonicalFromShopify(data?.discountNode?.discount, now);

      if (!theirs) {
        await release({ status: 'FAILED', problem: 'Deleted in Shopify. Push ours to put it back, or take it off Shopify here.' });
        return 'DELETED';
      }

      const remoteHash = hashCanonical(theirs);
      const desired = translateOffer(asMirrorable(mirror.offer), await this.contextFor(mirror.clientId, mirror.installationId, mirror.offer));

      if (desired.ok && remoteHash === desired.hash) {
        await release({ status: 'SYNCED', problem: null, remoteHash, pushedHash: desired.hash });
        return 'SYNCED';
      }
      if (remoteHash === mirror.pushedHash) {
        // Shopify holds what we pushed, and the offer has since changed: that is work, not drift.
        await release({ status: 'PENDING', remoteHash, nextAttemptAt: null });
        return 'PENDING';
      }

      const differences = desired.ok ? describeDifferences(desired.canonical, theirs) : ['the discount'];
      await release({
        status: 'DRIFTED', remoteHash,
        problem: `Changed in Shopify: ${differences.join(', ')}. Push ours to put this offer back, or accept theirs to change the offer here.`
      });
      return 'DRIFTED';
    } catch (error: any) {
      await release({});
      if (!(error instanceof ShopifyApiError)) console.error(`[offer mirror] reconcile ${mirror.id} failed`, error);
      return 'ERROR';
    }
  }

  /** Shopify told us a discount changed or was deleted: check it on the next pass, not in 30 minutes. */
  async flagChangedInShopify(discountGid: string) {
    const { count } = await prisma.offerExternalMirror.updateMany({
      where: { shopifyDiscountId: discountGid, status: { in: ['SYNCED', 'DRIFTED'] } },
      data: { lastCheckedAt: null }
    });
    return count;
  }

  /** One pass of the worker: due pushes and removals first, then due read-backs. */
  async runOnce(apiFor: ApiFor, limit = 20) {
    const now = new Date();
    const due = await prisma.offerExternalMirror.findMany({
      where: {
        status: { in: ['PENDING', 'REMOVING'] },
        OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }]
      },
      select: { id: true }, orderBy: { updatedAt: 'asc' }, take: limit
    });
    const pushed: string[] = [];
    for (const m of due) pushed.push(await this.process(m.id, apiFor));

    const stale = await prisma.offerExternalMirror.findMany({
      where: {
        status: { in: ['SYNCED', 'DRIFTED'] },
        OR: [{ lastCheckedAt: null }, { lastCheckedAt: { lt: new Date(now.getTime() - RECONCILE_EVERY_MS) } }]
      },
      select: { id: true }, orderBy: { lastCheckedAt: 'asc' }, take: limit
    });
    const checked: string[] = [];
    for (const m of stale) checked.push(await this.reconcile(m.id, apiFor));

    return { pushed, checked };
  }
}

export const offerMirrorService = new OfferMirrorService();

/**
 * The discount a `discounts/update` or `discounts/delete` webhook is about, as the GID we stored.
 *
 * Only `admin_graphql_api_id` is used. The bare numeric `id` beside it cannot say whether it is an
 * automatic or a code discount, and guessing would match the wrong row.
 */
export function discountGidFromWebhook(payload: any): string | null {
  return typeof payload?.admin_graphql_api_id === 'string' ? payload.admin_graphql_api_id : null;
}
