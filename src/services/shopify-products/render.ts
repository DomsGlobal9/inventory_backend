/**
 * One of our products, said the way Shopify's productSet wants it. Pure: no database, no network.
 *
 * Everything that decides what a Shopify product LOOKS like lives here, so each awkward case -- a
 * saree with no colour or size, two variants nobody told apart, a description with "<" in it -- can
 * be proved without a store.
 *
 * The same canonical form is computed from what Shopify sends back in a products/update webhook,
 * which is how our own echo is told from an edit made inside Shopify: hash both, compare.
 */

import crypto from 'crypto';
import type { StorefrontProduct } from '../storefront-catalogue.service';
import { inclusiveFromTaxable } from '../pricing/tax';

/** Shopify allows three options per product. */
const MAX_OPTIONS = 3;
/** Photos sent per product. Shopify allows far more; a shop's listing does not need them. */
export const MAX_IMAGES = 20;

/** The tag that marks a product as ours, so a timed-out create is found on retry, not duplicated. */
export function scaleezyTag(productCode: string): string {
  return `scaleezy-${String(productCode).trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-')}`;
}

export const gid = (kind: string, id: string | number) => `gid://shopify/${kind}/${id}`;

/** Plain text as Shopify HTML: escaped, one paragraph per blank-line block, line breaks kept. */
export function descriptionHtml(text: string | null | undefined): string {
  const clean = String(text ?? '').replace(/\r\n?/g, '\n').trim();
  if (!clean) return '';
  const escape = (s: string) => s
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  return clean.split(/\n{2,}/).map(block => `<p>${escape(block).replace(/\n/g, '<br>')}</p>`).join('');
}

/**
 * HTML reduced to the words in it.
 *
 * Shopify stores description HTML its own way -- it may add a newline, reorder attributes or turn
 * <br> into <br/> -- so comparing HTML would call every one of our own pushes an edit made in
 * Shopify. The words are what a shop changes, so the words are what is compared.
 */
export function wordsOf(html: string | null | undefined): string {
  return String(html ?? '')
    .replace(/<br\s*\/?>/gi, ' ').replace(/<\/p>/gi, ' ').replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'").replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ').trim();
}

/** A price as Shopify's Money string. Two places; NaN and negatives are refused upstream. */
export const money = (n: number) => (Math.round(n * 100) / 100).toFixed(2);

export interface RenderedVariant {
  sku: string;
  optionValues: { optionName: string; name: string }[];
  price: string;
  compareAtPrice: string | null;
  barcode: string | null;
}

export interface Rendered {
  title: string;
  descriptionHtml: string;
  vendor: string | null;
  productType: string | null;
  tags: string[];
  options: { name: string; values: string[] }[];
  variants: RenderedVariant[];
  images: { url: string; alt: string }[];
  /** What a products/update webhook can be compared against. */
  hash: string;
  imagesHash: string;
  /** Why this product cannot be sent at all, in words. Null when it can. */
  refusal: string | null;
}

/** Title, words of the description, and each SKU's price -- the parts a shop edits by hand. */
export interface Canonical {
  title: string;
  words: string;
  variants: { sku: string; price: string; compareAtPrice: string | null }[];
}

export function hashCanonical(c: Canonical): string {
  const sorted = {
    title: c.title.trim(),
    words: c.words,
    variants: [...c.variants]
      .map(v => ({ sku: v.sku.trim().toUpperCase(), price: v.price, compareAtPrice: v.compareAtPrice }))
      .sort((a, b) => a.sku.localeCompare(b.sku))
  };
  return crypto.createHash('sha256').update(JSON.stringify(sorted)).digest('hex').slice(0, 32);
}

/** The same three things, read out of a products/update webhook body. */
export function canonicalFromWebhook(payload: any): Canonical {
  const variants = Array.isArray(payload?.variants) ? payload.variants : [];
  return {
    title: String(payload?.title ?? ''),
    words: wordsOf(payload?.body_html),
    variants: variants
      .filter((v: any) => String(v?.sku ?? '').trim())
      .map((v: any) => {
        const price = Number(v?.price);
        const compare = v?.compare_at_price === null || v?.compare_at_price === undefined || v?.compare_at_price === ''
          ? null : Number(v.compare_at_price);
        return {
          sku: String(v.sku),
          price: Number.isFinite(price) ? money(price) : String(v?.price ?? ''),
          compareAtPrice: compare !== null && Number.isFinite(compare) && compare > 0 ? money(compare) : null
        };
      })
  };
}

/**
 * What changed, said for a person: "the price of PRD-1-RED-M from 4200.00 to 3900.00".
 * Compares only what both sides have; a variant Shopify has and we do not is the shop's own.
 */
export function describeEdits(ours: Canonical, theirs: Canonical): string[] {
  const out: string[] = [];
  if (ours.title.trim() !== theirs.title.trim()) out.push(`the title from "${ours.title}" to "${theirs.title}"`);
  if (ours.words !== theirs.words) out.push('the description');
  const theirBySku = new Map(theirs.variants.map(v => [v.sku.trim().toUpperCase(), v]));
  for (const v of ours.variants) {
    const t = theirBySku.get(v.sku.trim().toUpperCase());
    if (!t) { out.push(`removed ${v.sku}`); continue; }
    if (t.price !== v.price) out.push(`the price of ${v.sku} from ₹${v.price} to ₹${t.price}`);
    if ((t.compareAtPrice ?? null) !== (v.compareAtPrice ?? null)) out.push(`the old (crossed-out) price of ${v.sku}`);
  }
  return out;
}

const blank = (s: string | null | undefined) => !s || !String(s).trim();

export function renderProduct(p: StorefrontProduct): Rendered {
  const variants = p.variants.filter(v => !blank(v.sku));
  const empty: Rendered = {
    title: p.title, descriptionHtml: '', vendor: null, productType: null, tags: [], options: [],
    variants: [], images: [], hash: '', imagesHash: '', refusal: null
  };
  if (variants.length === 0) {
    return { ...empty, refusal: 'It has no sizes or colours with an item code yet. Add one, then try again.' };
  }
  const badPrice = variants.find(v => !Number.isFinite(v.price) || v.price <= 0);
  if (badPrice) {
    return { ...empty, refusal: `${badPrice.sku} has no selling price. Shopify cannot sell it at zero; set a price first.` };
  }

  /*
   * Options. Colour and Size when the shop recorded them; when two variants would still look the
   * same (same colour and size, or neither recorded) the item code is added as a third option,
   * because Shopify refuses two variants it cannot tell apart -- and refusing the whole product
   * for it would be worse than showing the code.
   */
  const colourOf = (v: typeof variants[number]) => blank(v.colour) ? null : String(v.colour).trim();
  const sizeOf = (v: typeof variants[number]) => blank(v.size) ? null : String(v.size).trim();
  const useColour = variants.some(v => colourOf(v));
  const useSize = variants.some(v => sizeOf(v));
  const key = (v: typeof variants[number]) => `${useColour ? (colourOf(v) ?? '').toLowerCase() : ''}|${useSize ? (sizeOf(v) ?? '').toLowerCase() : ''}`;
  const seen = new Set<string>();
  let clash = false;
  for (const v of variants) { const k = key(v); if (seen.has(k)) clash = true; seen.add(k); }
  const useCode = clash || (!useColour && !useSize && variants.length > 1);

  const optionNames: string[] = [];
  if (useColour) optionNames.push('Colour');
  if (useSize) optionNames.push('Size');
  if (useCode) optionNames.push('Item');
  if (optionNames.length === 0) optionNames.push('Title'); // Shopify's own name for "one variant"
  if (optionNames.length > MAX_OPTIONS) optionNames.length = MAX_OPTIONS;

  const valueFor = (name: string, v: typeof variants[number]) => {
    if (name === 'Colour') return colourOf(v) ?? 'Standard';
    if (name === 'Size') return sizeOf(v) ?? 'One size';
    if (name === 'Item') return v.sku.trim();
    return 'Default Title';
  };

  const rendered: RenderedVariant[] = variants.map(v => ({
    sku: v.sku.trim(),
    optionValues: optionNames.map(optionName => ({ optionName, name: valueFor(optionName, v) })),
    price: money(v.price),
    compareAtPrice: v.compareAtPrice !== null && v.compareAtPrice > v.price ? money(v.compareAtPrice) : null,
    barcode: blank(v.barcode) ? null : String(v.barcode).trim()
  }));

  const options = optionNames.map(name => ({
    name,
    values: [...new Set(rendered.map(r => r.optionValues.find(o => o.optionName === name)!.name))]
  }));

  const images = [...p.images]
    .sort((a, b) => (Number(b.isPrimary) - Number(a.isPrimary)) || a.position - b.position)
    .filter(i => /^https:\/\//i.test(i.url))
    .slice(0, MAX_IMAGES)
    .map(i => ({ url: i.url, alt: p.title }));

  const html = descriptionHtml(p.description);
  const canonical: Canonical = {
    title: p.title,
    words: wordsOf(html),
    variants: rendered.map(r => ({ sku: r.sku, price: r.price, compareAtPrice: r.compareAtPrice }))
  };

  return {
    title: p.title,
    descriptionHtml: html,
    vendor: blank(p.brand) ? null : String(p.brand).trim(),
    productType: blank(p.dressType) ? null : String(p.dressType).trim(),
    tags: [scaleezyTag(p.productCode)],
    options,
    variants: rendered,
    images,
    hash: hashCanonical(canonical),
    imagesHash: crypto.createHash('sha256').update(JSON.stringify(images.map(i => i.url))).digest('hex').slice(0, 32),
    refusal: null
  };
}

/** One variant's GST standing, for the price a Shopify customer pays. */
export interface VariantTax {
  rateBps: number | null;
  priceIsExclusive: boolean;
}

/**
 * The FINAL customer price, which is the only price Shopify is given (owner's rule, 26 Oct 2026).
 *
 * Shopify products are pushed with tax switched off: ScaleEzy decides GST, and a Shopify that added
 * its own on top would charge the customer twice and disagree with the shop's returns. So the price
 * sent must already contain the GST. A product priced INCLUSIVE (the shelf price) goes as it is; one
 * priced EXCLUSIVE (stitched apparel, "cost + GST = total") has its GST added first, exactly as the
 * till adds it. A shop that charges no GST (composition, unregistered, no GSTIN) adds nothing --
 * GST is optional, and its price is simply its price.
 *
 * Pure. Keyed by variant code, the same as StorefrontVariant.variantCode.
 */
export function withFinalPrices(p: StorefrontProduct, taxByVariantCode: Map<string, VariantTax>, shopChargesTax: boolean): StorefrontProduct {
  if (!shopChargesTax) return p;
  const gross = (price: number, rateBps: number) =>
    inclusiveFromTaxable(Math.round(price * 100), rateBps) / 100;
  return {
    ...p,
    variants: p.variants.map(v => {
      const t = taxByVariantCode.get(v.variantCode);
      if (!t || !t.priceIsExclusive || !t.rateBps || t.rateBps <= 0 || !Number.isFinite(v.price)) return v;
      return {
        ...v,
        price: gross(v.price, t.rateBps),
        compareAtPrice: v.compareAtPrice !== null && Number.isFinite(v.compareAtPrice) ? gross(v.compareAtPrice, t.rateBps) : v.compareAtPrice
      };
    })
  };
}

/** The canonical form of what we are about to send, for describing an edit against. */
export function canonicalOf(r: Rendered): Canonical {
  return {
    title: r.title,
    words: wordsOf(r.descriptionHtml),
    variants: r.variants.map(v => ({ sku: v.sku, price: v.price, compareAtPrice: v.compareAtPrice }))
  };
}
