/**
 * An offer written here, copied into a Shopify store, and kept honest.
 *
 * No Shopify account. The store is a fake that answers the exact GraphQL operations the mirror
 * sends, and behaves like Shopify in the ways that have consequences:
 *
 *   - an update ADDS products to a discount rather than replacing the list
 *   - a minimum requirement left out of an update is kept, not cleared
 *   - it throttles, it can time out AFTER creating, and it refuses a 26th automatic discount
 *   - a merchant can edit or delete a discount inside it
 *
 * The one property defended above all: the copy on Shopify charges what the offer here charges,
 * and when it does not, the offer screen says so in words -- it never shows a green tick over a
 * copy that charges something else.
 *
 * Throwaway tenant, deleted at the end.
 *
 *   npx tsx src/scripts/verify-shopify-discount-mirror.ts
 */
import { prisma } from '../lib/prisma';
import { offerService } from '../services/offers';
import {
  offerMirrorService, translateOffer, canonicalFromShopify, hashCanonical, mirrorTag, MirrorableOffer, TranslationContext
} from '../services/shopify-discounts';
import { ShopifyAdminApi, ShopifyApiError } from '../services/shopify-mapping';

let passed = 0, failed = 0;
const failures: string[] = [];
const check = (name: string, ok: boolean, detail?: string) => {
  if (ok) { passed++; console.log(`  [PASS] ${name}`); }
  else { failed++; failures.push(name); console.log(`  [FAIL] ${name}${detail ? `  -> ${detail}` : ''}`); }
};
async function refuses(name: string, fragment: string, fn: () => Promise<any>) {
  try { await fn(); check(name, false, 'it was accepted'); }
  catch (e: any) { const m = String(e?.message ?? e); check(name, m.toLowerCase().includes(fragment.toLowerCase()), `"${m}"`); }
}

const STAMP = Date.now();
const CLIENT = `mirror-${STAMP}`;
const OTHER = `mirror-other-${STAMP}`;
const SHOP = `mirror-${STAMP}.myshopify.com`;
const USER = 'merchant';
const day = 86400000;

// ── THE FAKE STORE ───────────────────────────────────────────────────────────────────────────────

type Node = any;
const store = {
  discounts: new Map<string, Node>(),
  nextId: 1000,
  currency: 'INR',
  throttleNext: 0,
  failAfterNextCreate: false,
  refuseNextCreateWith: null as null | string,
  /** Accept the next update, and quietly keep the old value. */
  mangleNextUpdate: false,
  calls: [] as string[]
};

function nodeFrom(kind: 'AUTOMATIC' | 'CODE', d: any, existing?: Node): Node {
  const prev = existing ?? {};
  const v = d.customerGets?.value;
  const items = d.customerGets?.items;

  let itemsNode = prev.customerGets?.items;
  if (items?.all) {
    itemsNode = { __typename: 'AllDiscountItems', allItems: true };
  } else if (items?.products) {
    const had = prev.customerGets?.items?.__typename === 'DiscountProducts' ? prev.customerGets.items : { products: { nodes: [] }, productVariants: { nodes: [] } };
    const p = new Set<string>(had.products.nodes.map((n: any) => n.id));
    const pv = new Set<string>(had.productVariants.nodes.map((n: any) => n.id));
    // Shopify's behaviour: ADD, then REMOVE -- never replace.
    (items.products.productsToAdd ?? []).forEach((id: string) => p.add(id));
    (items.products.productVariantsToAdd ?? []).forEach((id: string) => pv.add(id));
    (items.products.productsToRemove ?? []).forEach((id: string) => p.delete(id));
    (items.products.productVariantsToRemove ?? []).forEach((id: string) => pv.delete(id));
    itemsNode = { __typename: 'DiscountProducts', products: { nodes: [...p].map(id => ({ id })) }, productVariants: { nodes: [...pv].map(id => ({ id })) } };
  }

  let requirement = prev.minimumRequirement ?? null;   // KEPT when the update says nothing
  if (d.minimumRequirement?.subtotal) requirement = { greaterThanOrEqualToSubtotal: { amount: d.minimumRequirement.subtotal.greaterThanOrEqualToSubtotal } };
  if (d.minimumRequirement?.quantity) requirement = { greaterThanOrEqualToQuantity: d.minimumRequirement.quantity.greaterThanOrEqualToQuantity };

  return {
    __typename: kind === 'CODE' ? 'DiscountCodeBasic' : 'DiscountAutomaticBasic',
    title: d.title ?? prev.title,
    startsAt: d.startsAt ?? prev.startsAt,
    endsAt: d.endsAt === undefined ? prev.endsAt : d.endsAt,
    tags: d.tags ?? prev.tags ?? [],
    combinesWith: d.combinesWith ?? prev.combinesWith,
    minimumRequirement: requirement,
    customerGets: {
      value: v ? (v.percentage != null
        ? { __typename: 'DiscountPercentage', percentage: v.percentage }
        : { __typename: 'DiscountAmount', amount: { amount: v.discountAmount.amount }, appliesOnEachItem: v.discountAmount.appliesOnEachItem })
        : prev.customerGets?.value,
      items: itemsNode
    },
    ...(kind === 'CODE' ? {
      codes: { nodes: [{ code: d.code ?? prev.codes?.nodes?.[0]?.code }] },
      appliesOncePerCustomer: d.appliesOncePerCustomer ?? prev.appliesOncePerCustomer ?? false
    } : {})
  };
}

const automaticCount = () => [...store.discounts.values()].filter(n => n.__typename === 'DiscountAutomaticBasic').length;

const fakeApi: ShopifyAdminApi = {
  async graphql(query: string, vars: any = {}) {
    const op = (query.match(/(?:query|mutation)\s+(\w+)/) ?? [])[1] ?? 'anonymous';
    store.calls.push(op);

    if (store.throttleNext > 0) {
      store.throttleNext--;
      throw new ShopifyApiError('Shopify is busy with this store right now. Try again in a minute.', 503);
    }

    switch (op) {
      case 'MirrorShop': return { shop: { currencyCode: store.currency } } as any;
      case 'MirrorDiscountByTag': {
        const tag = String(vars.query).match(/tag:'([^']+)'/)?.[1];
        const nodes = [...store.discounts.entries()].filter(([, n]) => (n.tags ?? []).includes(tag)).map(([id, n]) => ({ id, discount: { __typename: n.__typename } }));
        return { discountNodes: { nodes } } as any;
      }
      case 'MirrorDiscount': {
        const n = store.discounts.get(vars.id);
        return { discountNode: n ? { id: vars.id, discount: n } : null } as any;
      }
      case 'MirrorCreateAutomatic':
      case 'MirrorCreateCode': {
        const kind = op === 'MirrorCreateCode' ? 'CODE' : 'AUTOMATIC';
        const field = kind === 'CODE' ? 'discountCodeBasicCreate' : 'discountAutomaticBasicCreate';
        if (store.refuseNextCreateWith) {
          const code = store.refuseNextCreateWith; store.refuseNextCreateWith = null;
          return { [field]: { userErrors: [{ field: ['startsAt'], code, message: 'Refused by the fake store.' }] } } as any;
        }
        if (kind === 'AUTOMATIC' && automaticCount() >= 25) {
          return { [field]: { userErrors: [{ field: ['startsAt'], code: 'ACTIVE_PERIOD_OVERLAP', message: 'Only 25 automatic discounts can be active.' }] } } as any;
        }
        const id = `gid://shopify/${kind === 'CODE' ? 'DiscountCodeNode' : 'DiscountAutomaticNode'}/${store.nextId++}`;
        store.discounts.set(id, nodeFrom(kind, vars.d));
        if (store.failAfterNextCreate) {
          store.failAfterNextCreate = false;
          throw new ShopifyApiError('Could not reach the store. Try again in a moment.', 504);
        }
        return { [field]: { [kind === 'CODE' ? 'codeDiscountNode' : 'automaticDiscountNode']: { id }, userErrors: [] } } as any;
      }
      case 'MirrorUpdateAutomatic':
      case 'MirrorUpdateCode': {
        const kind = op === 'MirrorUpdateCode' ? 'CODE' : 'AUTOMATIC';
        const field = kind === 'CODE' ? 'discountCodeBasicUpdate' : 'discountAutomaticBasicUpdate';
        const existing = store.discounts.get(vars.id);
        if (!existing) return { [field]: { userErrors: [{ field: ['id'], code: 'INVALID', message: 'Discount does not exist' }] } } as any;
        if (store.mangleNextUpdate) {
          store.mangleNextUpdate = false;
          return { [field]: { [kind === 'CODE' ? 'codeDiscountNode' : 'automaticDiscountNode']: { id: vars.id }, userErrors: [] } } as any;
        }
        store.discounts.set(vars.id, nodeFrom(kind, vars.d, existing));
        return { [field]: { [kind === 'CODE' ? 'codeDiscountNode' : 'automaticDiscountNode']: { id: vars.id }, userErrors: [] } } as any;
      }
      case 'MirrorDeleteAutomatic':
      case 'MirrorDeleteCode': {
        const field = op === 'MirrorDeleteCode' ? 'discountCodeDelete' : 'discountAutomaticDelete';
        const existed = store.discounts.delete(vars.id);
        return { [field]: existed ? { userErrors: [] } : { userErrors: [{ field: ['id'], code: 'INVALID', message: 'Discount does not exist' }] } } as any;
      }
    }
    throw new Error(`the fake store does not know ${op}`);
  }
};
const apiFor = async () => fakeApi;

// ── HELPERS ──────────────────────────────────────────────────────────────────────────────────────

let installationId = '';
let shopLocationId = '';
const V: Record<string, string> = {};
let productId = '';

async function liveOffer(over: any = {}) {
  const offer: any = await offerService.create(CLIENT, {
    name: 'Deepavali Sale', trigger: 'AUTOMATIC', level: 'LINE', valueType: 'PERCENTAGE',
    value: 20, scope: 'ALL', startsAt: new Date(Date.now() - day), endsAt: new Date(Date.now() + 10 * day), ...over
  } as any, USER);
  await offerService.setStatus(CLIENT, offer.id, 'ACTIVE', USER);
  return offer;
}

const mirrorOf = (offerId: string) => prisma.offerExternalMirror.findFirst({ where: { offerId } });

/** Run the worker's work for one offer, as many passes as it takes to settle (bounded). */
async function settle(offerId: string, passes = 3) {
  let last = '';
  for (let i = 0; i < passes; i++) {
    const m = await mirrorOf(offerId);
    if (!m || !['PENDING', 'REMOVING'].includes(m.status)) break;
    await prisma.offerExternalMirror.update({ where: { id: m.id }, data: { nextAttemptAt: null, lockedAt: null } });
    last = await offerMirrorService.process(m.id, apiFor);
  }
  return last;
}

const remoteOf = async (offerId: string) => {
  const m = await mirrorOf(offerId);
  return m?.shopifyDiscountId ? store.discounts.get(m.shopifyDiscountId) : undefined;
};

async function main() {
  // ── SETUP ──────────────────────────────────────────────────────────────
  console.log('SETUP: a shop, a connected Shopify store, two matched variants');

  shopLocationId = (await prisma.stockLocation.create({
    data: { clientId: CLIENT, name: 'Chirala', code: 'CHIRALA', type: 'STORE', active: true }
  })).id;
  const godown = await prisma.stockLocation.create({
    data: { clientId: CLIENT, name: 'Godown', code: 'GODOWN', type: 'WAREHOUSE', active: true }
  });
  const product = await prisma.product.create({
    data: { clientId: CLIENT, productCode: 'PRD-M', title: 'Kanchipuram Saree', slug: `m-${STAMP}`, category: 'WOMEN', basePrice: 12000, status: 'ACTIVE', productType: 'READY_TO_WEAR' }
  });
  productId = product.id;
  for (const [key, sv] of [['maroon', '9101'], ['green', '9102'], ['unmatched', '']] as const) {
    const v = await prisma.productVariant.create({
      data: { clientId: CLIENT, productId: product.id, sku: `SKU-${key}-${STAMP}`, variantCode: `VAR-${key}-${STAMP}`, size: 'Free', colorName: key, sellingPrice: 12000, averageCost: 100 }
    });
    V[key] = v.id;
    void sv;
  }

  const installation = await prisma.shopifyInstallation.create({
    data: { shopDomain: SHOP, clientId: CLIENT, source: 'SCALEEZY', accessTokenEncrypted: 'unused', scopes: 'read_products,read_orders,write_discounts' }
  });
  installationId = installation.id;
  await prisma.shopifyLocationMap.create({ data: { installationId, clientId: CLIENT, locationId: shopLocationId, shopifyLocationId: '7001' } });
  for (const [key, sv] of [['maroon', '9101'], ['green', '9102']] as const) {
    await prisma.shopifyIdMap.create({
      data: { installationId, clientId: CLIENT, variantId: V[key], sku: `SKU-${key}-${STAMP}`, shopifyProductId: '4101', shopifyVariantId: sv, origin: 'MATCHED' }
    });
  }

  // ── A. WHAT SHOPIFY CAN SAY (pure) ─────────────────────────────────────
  console.log('\nA. WHAT AN OFFER BECOMES IN SHOPIFY, OR WHY IT CANNOT');

  const base: MirrorableOffer = {
    id: 'o1', name: 'Sale', status: 'ACTIVE', trigger: 'AUTOMATIC', couponCode: null, level: 'LINE',
    valueType: 'PERCENTAGE', value: 20, maxDiscount: null, scope: 'ALL', targets: [], minSubtotal: null,
    minQuantity: null, channels: [], locationIds: [], startsAt: new Date(Date.now() - day), endsAt: new Date(Date.now() + day),
    usageLimit: null, usageLimitPerCustomer: null, stackable: false
  };
  const ctx: TranslationContext = {
    now: new Date(), shopCurrency: 'INR', storeCurrency: 'INR',
    shopifyVariantOf: new Map([['v1', '9101']]), shopifyProductsOf: new Map([['p1', ['4101']]]),
    sellingLocationIds: ['loc-online']
  };
  const t = (over: Partial<MirrorableOffer>, c: Partial<TranslationContext> = {}) => translateOffer({ ...base, ...over }, { ...ctx, ...c });
  const reasonOf = (r: any) => (r.ok ? '(accepted)' : r.reasons.join(' '));

  const pct = t({});
  check('20% is sent as 0.20, the way Shopify counts', pct.ok && (pct.input as any).customerGets.value.percentage === 0.2, JSON.stringify(pct.ok && (pct.input as any).customerGets));
  check('  ...tagged with the offer, so a retry can find it', pct.ok && (pct.input as any).tags[0] === mirrorTag('o1'));
  check('a percentage with a cap is refused', /cannot cap a percentage/i.test(reasonOf(t({ maxDiscount: 2000 }))), reasonOf(t({ maxDiscount: 2000 })));
  check('a fixed price is refused', /fixed price/i.test(reasonOf(t({ valueType: 'FIXED_PRICE', value: 9999 }))));
  check('an amount off each LINE is refused -- Shopify cannot say it', /each line/i.test(reasonOf(t({ valueType: 'FIXED_AMOUNT', value: 200 }))));
  const orderAmount = t({ valueType: 'FIXED_AMOUNT', value: 500, level: 'ORDER' });
  check('an amount off the ORDER is sent split across it, not per item',
    orderAmount.ok && (orderAmount.input as any).customerGets.value.discountAmount.appliesOnEachItem === false);
  check('an amount is refused when the store sells in another currency',
    /never converted/i.test(reasonOf(t({ valueType: 'FIXED_AMOUNT', value: 500, level: 'ORDER' }, { storeCurrency: 'USD' }))));
  check('a category is refused -- Shopify has none', /no categories/i.test(reasonOf(t({ scope: 'CATEGORY', targets: [{ scope: 'CATEGORY', refId: 'WOMEN' }] }))));
  check('a variant not matched to Shopify is refused, by name',
    /is matched to your Shopify store/i.test(reasonOf(t({ scope: 'VARIANT', targets: [{ scope: 'VARIANT', refId: 'v9' }] }, { labelOf: new Map([['v9', 'SKU-NINE']]) })))
    && /SKU-NINE/.test(reasonOf(t({ scope: 'VARIANT', targets: [{ scope: 'VARIANT', refId: 'v9' }] }, { labelOf: new Map([['v9', 'SKU-NINE']]) }))));
  const variantOk = t({ scope: 'VARIANT', targets: [{ scope: 'VARIANT', refId: 'v1' }] });
  check('a matched variant is named by its Shopify GID',
    variantOk.ok && (variantOk.input as any).customerGets.items.products.productVariantsToAdd[0] === 'gid://shopify/ProductVariant/9101');
  check('a shared usage limit is refused, and says why', /given away twice/i.test(reasonOf(t({ usageLimit: 50 }))));
  check('a per-customer limit on an automatic discount is refused', /cannot limit an automatic/i.test(reasonOf(t({ usageLimitPerCustomer: 1 }))));
  const once = t({ trigger: 'CODE', couponCode: 'STAFF', usageLimitPerCustomer: 1 });
  check('a code limited to once per customer is expressible', once.ok && (once.input as any).appliesOncePerCustomer === true);
  check('a code limited to twice per customer is not', /once per customer, but not/i.test(reasonOf(t({ trigger: 'CODE', couponCode: 'STAFF', usageLimitPerCustomer: 2 }))));
  check('a minimum spend AND a minimum count is refused', /not both/i.test(reasonOf(t({ minSubtotal: 1000, minQuantity: 2 }))));
  check('a till-only offer is refused', /till/i.test(reasonOf(t({ channels: ['POS'] }))));
  check('an offer for locations Shopify does not sell from is refused', /not paired/i.test(reasonOf(t({ locationIds: ['elsewhere'] }))));
  check('an offer that includes a Shopify location is fine', t({ locationIds: ['elsewhere', 'loc-online'] }).ok);

  const paused = t({ status: 'PAUSED' });
  check('a paused offer is sent as ended now', paused.ok && paused.canonical.window === 'ENDED' &&
    new Date((paused.input as any).endsAt).getTime() <= Date.now() + 1000);
  const future = t({ startsAt: new Date(Date.now() + day), status: 'PAUSED' });
  check('  ...without an end before its start, which Shopify refuses', future.ok &&
    new Date((future.input as any).startsAt) < new Date((future.input as any).endsAt));

  // The property drift detection rests on: what we send and what Shopify reads back reduce to the same thing.
  for (const [label, r] of [['percentage, everything', pct], ['amount off the order', orderAmount], ['one variant', variantOk], ['a code, once each', once], ['ended', paused]] as const) {
    const node = nodeFrom(r.ok ? r.kind : 'AUTOMATIC', r.ok ? r.input : {});
    const back = canonicalFromShopify(node, new Date());
    check(`round trip holds for ${label}`, r.ok && !!back && hashCanonical(back) === r.hash,
      JSON.stringify({ sent: r.ok && r.canonical, read: back }));
  }

  // ── B. PUTTING AN OFFER ON SHOPIFY ─────────────────────────────────────
  console.log('\nB. PUTTING AN OFFER ON SHOPIFY');

  const draft: any = await offerService.create(CLIENT, { name: 'Draft', valueType: 'PERCENTAGE', value: 10, startsAt: new Date() } as any, USER);
  await refuses('a draft cannot be put on Shopify', 'start the offer first', () => offerMirrorService.enable(CLIENT, draft.id, USER));

  const capped = await liveOffer({ name: 'Capped', maxDiscount: 1000, stackable: true });
  await refuses('an offer Shopify cannot express is refused before anything is queued', 'cannot cap',
    () => offerMirrorService.enable(CLIENT, capped.id, USER));
  check('  ...and nothing was queued for it', !(await mirrorOf(capped.id)));

  await prisma.shopifyInstallation.update({ where: { id: installationId }, data: { scopes: 'read_products,read_orders' } });
  const sale = await liveOffer({ name: 'Deepavali Sale', value: 20 });
  await refuses('a store that has not approved discounts is told to reconnect', 'reconnect',
    () => offerMirrorService.enable(CLIENT, sale.id, USER));
  await prisma.shopifyInstallation.update({ where: { id: installationId }, data: { scopes: 'read_products,read_orders,write_discounts' } });

  await refuses('another workspace cannot see this offer\'s copy', 'no longer exists', () => offerMirrorService.overview(OTHER, sale.id));

  const before = await offerMirrorService.overview(CLIENT, sale.id);
  check('the offer screen says it can be put on Shopify', before.connected === true && (before as any).canBeMirrored === true && !(before as any).mirror);

  await offerMirrorService.enable(CLIENT, sale.id, USER);
  check('putting it on Shopify queues it', (await mirrorOf(sale.id))?.status === 'PENDING');

  const outcome = await settle(sale.id);
  const m1 = await mirrorOf(sale.id);
  check('the worker pushes it', outcome === 'SYNCED' && m1?.status === 'SYNCED', `${outcome} / ${m1?.status} ${m1?.problem ?? ''}`);
  check('  ...as one automatic discount in the store', store.discounts.size === 1 && (await remoteOf(sale.id))?.__typename === 'DiscountAutomaticBasic');
  check('  ...at 20%', (await remoteOf(sale.id))?.customerGets?.value?.percentage === 0.2);
  check('  ...and it records what it pushed', !!m1?.pushedHash && m1?.pushedHash === m1?.remoteHash);

  // ── C. CHANGES HERE FOLLOW ─────────────────────────────────────────────
  console.log('\nC. A CHANGE HERE REACHES SHOPIFY');

  await offerService.update(CLIENT, sale.id, { value: 25 } as any, USER, 'Deeper for the weekend');
  check('editing the offer queues a push', (await mirrorOf(sale.id))?.status === 'PENDING');
  await settle(sale.id);
  check('Shopify now takes 25%', (await remoteOf(sale.id))?.customerGets?.value?.percentage === 0.25);
  check('  ...by updating the same discount, not adding a second', store.discounts.size === 1);

  await offerService.setStatus(CLIENT, sale.id, 'PAUSED', USER);
  await settle(sale.id);
  const pausedRemote = await remoteOf(sale.id);
  check('pausing here ends it in Shopify', !!pausedRemote?.endsAt && new Date(pausedRemote.endsAt).getTime() <= Date.now() + 1000, pausedRemote?.endsAt);
  check('  ...and the copy is still considered in step', (await mirrorOf(sale.id))?.status === 'SYNCED', (await mirrorOf(sale.id))?.problem ?? '');

  await offerService.setStatus(CLIENT, sale.id, 'ACTIVE', USER);
  await settle(sale.id);
  const resumed = await remoteOf(sale.id);
  check('resuming puts its real end date back', !!resumed?.endsAt && new Date(resumed.endsAt).getTime() > Date.now() + 5 * day, resumed?.endsAt);

  // ── D. THINGS GOING WRONG ON THE WAY ───────────────────────────────────
  console.log('\nD. A PUSH THAT TIMES OUT, A BUSY STORE, A FULL STORE');

  const timeout = await liveOffer({ name: 'Timeout sale', value: 10, stackable: true });
  await offerMirrorService.enable(CLIENT, timeout.id, USER);
  store.failAfterNextCreate = true;
  const first = await settle(timeout.id, 1);
  check('a push that times out after Shopify created it is retried, not failed', first === 'RETRYING', first);
  const countAfterTimeout = store.discounts.size;
  await settle(timeout.id);
  check('the retry finds what was created, by its tag', store.discounts.size === countAfterTimeout, `${countAfterTimeout} -> ${store.discounts.size}`);
  check('  ...so there is ONE discount for it, not two',
    [...store.discounts.values()].filter(n => n.tags.includes(mirrorTag(timeout.id))).length === 1);
  check('  ...and it is in step', (await mirrorOf(timeout.id))?.status === 'SYNCED');

  const busy = await liveOffer({ name: 'Busy store sale', value: 5, stackable: true });
  await offerMirrorService.enable(CLIENT, busy.id, USER);
  store.throttleNext = 1;
  const throttled = await settle(busy.id, 1);
  const busyMirror = await mirrorOf(busy.id);
  check('a throttled push waits and retries', throttled === 'RETRYING' && !!busyMirror?.nextAttemptAt && busyMirror.nextAttemptAt > new Date(), `${throttled}`);
  check('  ...saying so, not failing', /trying again shortly/i.test(busyMirror?.problem ?? ''), busyMirror?.problem ?? '');
  await settle(busy.id);
  check('  ...and lands once the store answers', (await mirrorOf(busy.id))?.status === 'SYNCED');

  const full = await liveOffer({ name: 'One too many', value: 7, stackable: true });
  await offerMirrorService.enable(CLIENT, full.id, USER);
  store.refuseNextCreateWith = 'ACTIVE_PERIOD_OVERLAP';
  const refused = await settle(full.id, 1);
  const fullMirror = await mirrorOf(full.id);
  check('the 26th automatic discount is refused', refused === 'FAILED' && fullMirror?.status === 'FAILED', refused);
  check('  ...with Shopify\'s real limit, in words', /allows 25 automatic discounts/i.test(fullMirror?.problem ?? ''), fullMirror?.problem ?? '');
  check('  ...and is not retried for ever', fullMirror?.nextAttemptAt === null);

  // Two workers at once on the same row: one does the work, the other stands aside.
  const raced = await liveOffer({ name: 'Raced', value: 3, stackable: true });
  await offerMirrorService.enable(CLIENT, raced.id, USER);
  const racedMirror = await mirrorOf(raced.id);
  const both = await Promise.all([offerMirrorService.process(racedMirror!.id, apiFor), offerMirrorService.process(racedMirror!.id, apiFor)]);
  check('two workers on one row: one pushes, the other stands aside', both.includes('BUSY') && both.includes('SYNCED'), both.join(','));
  check('  ...leaving one discount', [...store.discounts.values()].filter(n => n.tags.includes(mirrorTag(raced.id))).length === 1);

  // ── E. CHANGED IN SHOPIFY ──────────────────────────────────────────────
  console.log('\nE. A MERCHANT CHANGES IT INSIDE SHOPIFY');

  const synced = await mirrorOf(sale.id);
  const theirs = store.discounts.get(synced!.shopifyDiscountId!)!;
  theirs.title = 'DEEPAVALI MEGA SALE';
  theirs.customerGets.value = { __typename: 'DiscountPercentage', percentage: 0.3 };

  const drift = await offerMirrorService.reconcile(synced!.id, apiFor);
  const drifted = await mirrorOf(sale.id);
  check('reading it back notices', drift === 'DRIFTED' && drifted?.status === 'DRIFTED', drift);
  check('  ...and names what changed', /the name/.test(drifted?.problem ?? '') && /how much comes off/.test(drifted?.problem ?? ''), drifted?.problem ?? '');
  check('  ...without overwriting the merchant\'s change on its own', store.discounts.get(synced!.shopifyDiscountId!)!.customerGets.value.percentage === 0.3);

  await offerMirrorService.pushOurs(CLIENT, sale.id);
  await settle(sale.id);
  check('"push ours" puts the offer\'s version back', store.discounts.get(synced!.shopifyDiscountId!)!.customerGets.value.percentage === 0.25 &&
    (await mirrorOf(sale.id))?.status === 'SYNCED');

  // Fetched again: the push above replaced the stored discount, so the old reference edits nothing.
  const theirsAgain = store.discounts.get(synced!.shopifyDiscountId!)!;
  theirsAgain.customerGets.value = { __typename: 'DiscountPercentage', percentage: 0.3 };
  await offerMirrorService.reconcile(synced!.id, apiFor);
  const versionsBefore = await prisma.offerVersion.count({ where: { offerId: sale.id } });
  await offerMirrorService.acceptTheirs(CLIENT, sale.id, USER, apiFor);
  const acceptedOffer = await prisma.offer.findUniqueOrThrow({ where: { id: sale.id } });
  check('"accept theirs" changes the offer here to 30%', Number(acceptedOffer.value) === 30, String(acceptedOffer.value));
  const newest = await prisma.offerVersion.findFirst({ where: { offerId: sale.id }, orderBy: { version: 'desc' } });
  check('  ...as a new version, saying it came from Shopify', (await prisma.offerVersion.count({ where: { offerId: sale.id } })) === versionsBefore + 1 &&
    /Shopify/.test(newest?.changeNote ?? ''), newest?.changeNote ?? '');
  await settle(sale.id);
  check('  ...and both sides agree afterwards, with no second discount', (await mirrorOf(sale.id))?.status === 'SYNCED' &&
    [...store.discounts.values()].filter(n => n.tags.includes(mirrorTag(sale.id))).length === 1);

  // Nobody touched it; the offer simply reached its end.
  const ending = await liveOffer({ name: 'Ends soon', value: 4, stackable: true, endsAt: new Date(Date.now() + 60 * 60 * 1000) });
  await offerMirrorService.enable(CLIENT, ending.id, USER);
  await settle(ending.id);
  const endingMirror = await mirrorOf(ending.id);
  const past = new Date(Date.now() - 1000).toISOString();
  store.discounts.get(endingMirror!.shopifyDiscountId!)!.endsAt = past;
  await prisma.offer.update({ where: { id: ending.id }, data: { endsAt: new Date(past) } });
  check('an offer that simply reached its end is in step, not drifted',
    (await offerMirrorService.reconcile(endingMirror!.id, apiFor)) === 'SYNCED');

  // Deleted in Shopify.
  const gone = await mirrorOf(timeout.id);
  store.discounts.delete(gone!.shopifyDiscountId!);
  check('a copy deleted in Shopify is reported as deleted', (await offerMirrorService.reconcile(gone!.id, apiFor)) === 'DELETED' &&
    /Deleted in Shopify/.test((await mirrorOf(timeout.id))?.problem ?? ''));
  await offerMirrorService.pushOurs(CLIENT, timeout.id);
  await settle(timeout.id);
  const recreated = await mirrorOf(timeout.id);
  check('  ..."push ours" puts it back as a new discount', recreated?.status === 'SYNCED' && recreated.shopifyDiscountId !== gone!.shopifyDiscountId);

  // The webhook fast path.
  await prisma.offerExternalMirror.update({ where: { id: recreated!.id }, data: { lastCheckedAt: new Date() } });
  await offerMirrorService.flagChangedInShopify(recreated!.shopifyDiscountId!);
  check('a discounts/update webhook makes it due for checking now', (await mirrorOf(timeout.id))?.lastCheckedAt === null);

  // ── F. EDITS THAT CHANGE WHAT SHOPIFY HOLDS ─────────────────────────────
  console.log('\nF. PRODUCTS REMOVED, A CODE, A RETIREMENT');

  const pair = await liveOffer({ name: 'Two colours', value: 15, stackable: true, scope: 'VARIANT', targets: [{ scope: 'VARIANT', refId: V.maroon }, { scope: 'VARIANT', refId: V.green }] });
  await offerMirrorService.enable(CLIENT, pair.id, USER);
  await settle(pair.id);
  check('a two-variant offer is pushed with both', (await remoteOf(pair.id))?.customerGets.items.productVariants.nodes.length === 2);
  await offerService.update(CLIENT, pair.id, { targets: [{ scope: 'VARIANT', refId: V.maroon }] } as any, USER);
  await settle(pair.id);
  const narrowed = await remoteOf(pair.id);
  check('dropping one here REMOVES it in Shopify, which only adds unless told',
    narrowed?.customerGets.items.productVariants.nodes.length === 1 &&
    narrowed.customerGets.items.productVariants.nodes[0].id === 'gid://shopify/ProductVariant/9101',
    JSON.stringify(narrowed?.customerGets.items));
  check('  ...and the copy is in step', (await mirrorOf(pair.id))?.status === 'SYNCED', (await mirrorOf(pair.id))?.problem ?? '');

  await refuses('adding an unmatched variant to a mirrored offer is caught', 'matched to your Shopify store', async () => {
    const r = translateOffer({ ...(await prisma.offer.findUniqueOrThrow({ where: { id: pair.id }, include: { targets: true } })) as any,
      value: 15, targets: [{ scope: 'VARIANT', refId: V.unmatched }] } as any,
      await offerMirrorService.contextFor(CLIENT, installationId, { targets: [{ refId: V.unmatched }] }));
    if (!r.ok) throw new Error(r.reasons.join(' '));
  });

  // A minimum spend removed here. The fake store, like the cautious reading of Shopify's reference,
  // KEEPS a requirement an update does not mention -- so the mirror replaces the discount instead.
  const minSpend = await liveOffer({ name: 'Spend more', value: 8, stackable: true, minSubtotal: 5000 });
  await offerMirrorService.enable(CLIENT, minSpend.id, USER);
  await settle(minSpend.id);
  const minGid = (await mirrorOf(minSpend.id))?.shopifyDiscountId;
  await offerService.update(CLIENT, minSpend.id, { minSubtotal: null } as any, USER);
  await settle(minSpend.id);
  const minMirror = await mirrorOf(minSpend.id);
  check('removing a minimum spend here removes it on Shopify', minMirror?.status === 'SYNCED' &&
    (await remoteOf(minSpend.id))?.minimumRequirement == null, `${minMirror?.status} ${minMirror?.problem ?? ''}`);
  check('  ...by replacing the discount rather than trusting an update to clear it',
    !!minMirror?.shopifyDiscountId && minMirror.shopifyDiscountId !== minGid && !store.discounts.has(minGid!));

  // Shopify accepting an update and then holding something else: the read-back must catch it.
  const mangled = await liveOffer({ name: 'Honest tick', value: 6, stackable: true });
  await offerMirrorService.enable(CLIENT, mangled.id, USER);
  await settle(mangled.id);
  store.mangleNextUpdate = true;
  await offerService.update(CLIENT, mangled.id, { value: 9 } as any, USER);
  await settle(mangled.id);
  const mangledMirror = await mirrorOf(mangled.id);
  check('a change Shopify said yes to but did not keep is a failure, not a green tick', mangledMirror?.status === 'FAILED', mangledMirror?.status);
  check('  ...naming what differs', /how much comes off/.test(mangledMirror?.problem ?? ''), mangledMirror?.problem ?? '');

  // Edited into something Shopify cannot say: the old copy must not keep charging the old rule.
  await offerService.update(CLIENT, busy.id, { maxDiscount: 500 } as any, USER);
  const busyGid = (await mirrorOf(busy.id))?.shopifyDiscountId;
  await settle(busy.id);
  const nowUnsupported = await mirrorOf(busy.id);
  check('an edit Shopify cannot express marks it unsupported', nowUnsupported?.status === 'UNSUPPORTED', nowUnsupported?.status);
  check('  ...removes the old copy from Shopify', !store.discounts.has(busyGid!));
  check('  ...and says both things', /cannot cap/i.test(nowUnsupported?.problem ?? '') && /removed/i.test(nowUnsupported?.problem ?? ''), nowUnsupported?.problem ?? '');

  // Automatic -> code.
  const oldGid = (await mirrorOf(raced.id))?.shopifyDiscountId;
  await offerService.update(CLIENT, raced.id, { trigger: 'CODE', couponCode: `RACE${STAMP % 10000}` } as any, USER);
  await settle(raced.id);
  const asCode = await remoteOf(raced.id);
  check('switching to a code replaces the automatic discount with a code one',
    !store.discounts.has(oldGid!) && asCode?.__typename === 'DiscountCodeBasic' && asCode.codes.nodes[0].code === `RACE${STAMP % 10000}`);

  // Retire and remove.
  const retiredGid = (await mirrorOf(pair.id))?.shopifyDiscountId;
  await offerService.setStatus(CLIENT, pair.id, 'ARCHIVED', USER);
  check('retiring an offer queues its removal', (await mirrorOf(pair.id))?.status === 'PENDING');
  const removed = await settle(pair.id);
  check('  ...deletes it from Shopify', removed === 'REMOVED' && !store.discounts.has(retiredGid!), removed);
  check('  ...and forgets the copy', !(await mirrorOf(pair.id)));

  const offGid = (await mirrorOf(ending.id))?.shopifyDiscountId;
  await offerMirrorService.disable(CLIENT, ending.id);
  await settle(ending.id);
  check('"take it off Shopify" deletes it there and here', !store.discounts.has(offGid!) && !(await mirrorOf(ending.id)));

  // Uninstalled.
  const late = await liveOffer({ name: 'After uninstall', value: 2, stackable: true });
  await offerMirrorService.enable(CLIENT, late.id, USER);
  await prisma.shopifyInstallation.update({ where: { id: installationId }, data: { uninstalledAt: new Date() } });
  check('a store that uninstalled the app fails with that reason', (await settle(late.id, 1)) === 'FAILED' &&
    /uninstalled/i.test((await mirrorOf(late.id))?.problem ?? ''));
  await prisma.shopifyInstallation.update({ where: { id: installationId }, data: { uninstalledAt: null } });

  void godown; void productId;
}

main()
  .catch(e => { console.error('\nSUITE CRASHED:', e); failed++; failures.push('suite crashed'); })
  .finally(async () => {
    await prisma.offerExternalMirror.deleteMany({ where: { clientId: CLIENT } });
    await prisma.offerRedemption.deleteMany({ where: { clientId: CLIENT } });
    await prisma.offerVersion.deleteMany({ where: { offer: { clientId: CLIENT } } });
    await prisma.offerTarget.deleteMany({ where: { offer: { clientId: CLIENT } } });
    await prisma.offer.deleteMany({ where: { clientId: CLIENT } });
    await prisma.shopifyIdMap.deleteMany({ where: { clientId: CLIENT } });
    await prisma.shopifyLocationMap.deleteMany({ where: { clientId: CLIENT } });
    await prisma.shopifyInstallation.deleteMany({ where: { shopDomain: SHOP } });
    await prisma.productVariant.deleteMany({ where: { clientId: CLIENT } });
    await prisma.product.deleteMany({ where: { clientId: CLIENT } });
    await prisma.stockLocation.deleteMany({ where: { clientId: CLIENT } });
    await prisma.clientSequence.deleteMany({ where: { clientId: CLIENT } });
    await prisma.$disconnect();
    console.log(`\nRESULT: ${passed} passed | ${failed} failed`);
    if (failures.length) console.log('Failures:\n  - ' + failures.join('\n  - '));
    process.exit(failed ? 1 : 0);
  });
