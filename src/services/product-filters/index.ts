import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../../lib/prisma';
import { isLowStock } from '../../lib/lowStock';
import { colourFamily } from '../customer-card/colours';
import { productRepository } from '../../repositories/product.repository';

/**
 * THE PRODUCTS PAGE'S SEARCH, FILTERS AND SORT.
 *
 * Asked for only by the Products page (`facets=1`); every other caller of GET /products -- the app's
 * pickers, the Android app -- gets the plain list exactly as before.
 *
 * A filter is decided per COLOUR (variant), because that is how a saree is chosen: "blue sarees under
 * ₹5,000 still in stock" means one colour of one product that is all three at once, not a product
 * with a blue one, a cheap one and an in-stock one. A product is shown when at least one of its
 * colours passes, and `matches` says which, so the photo view can show just those.
 *
 * Beside every choice is how many products it would leave, worked out with all the OTHER filters on
 * (picking Blue does not make Red count zero), so a choice never leads to an empty page by surprise.
 *
 * Done in code over the shop's colours rather than in SQL: the colour families are a code rule
 * (customer-card/colours), and a shop's catalogue is hundreds to a few thousand rows.
 */

const list = z.preprocess(
  (v) => (typeof v === 'string' ? v.split('|').map(s => s.trim()).filter(Boolean) : Array.isArray(v) ? v : []),
  z.array(z.string().max(80)).max(60)
);
const price = z.preprocess((v) => (v === undefined || v === '' ? undefined : Number(v)), z.number().min(0).max(1e9).optional());

export const productFilterQuery = z.object({
  page: z.preprocess((v) => (v === undefined ? 1 : parseInt(String(v), 10)), z.number().int().min(1).default(1)),
  limit: z.preprocess((v) => (v === undefined ? 50 : parseInt(String(v), 10)), z.number().int().min(1).max(100).default(50)),
  q: z.string().max(100).optional(),
  status: z.enum(['ACTIVE', 'DRAFT', 'ARCHIVED', 'TRASHED']).optional(),
  type: list, colour: list, fabric: list, craft: list, brand: list, stock: list, photos: list,
  min: price, max: price,
  sort: z.enum(['new', 'old', 'plo', 'phi', 'qhi', 'qlo', 'az']).default('new')
});
export type ProductFilterQuery = z.infer<typeof productFilterQuery>;

/** "Not set" travels as this, so an empty fabric can be picked like any other. */
export const NOT_SET = '__none';

type Row = {
  pid: string; title: string; code: string; created: Date; type: string | null; fabric: string | null; craft: string | null; brand: string | null;
  vid: string | null; sku: string | null; barcode: string | null; colour: string | null; price: number; qty: number; level: number;
};
type Variant = Row & { fam: string; stock: 'in' | 'low' | 'out'; photos: 'with' | 'without' };

const FACETS = ['type', 'colour', 'fabric', 'craft', 'brand', 'stock', 'photos'] as const;
type Facet = typeof FACETS[number];
const valueOf = (v: Variant, f: Facet): string => {
  switch (f) {
    case 'type': return v.type || NOT_SET;
    case 'colour': return v.fam;
    case 'fabric': return v.fabric || NOT_SET;
    case 'craft': return v.craft || NOT_SET;
    case 'brand': return v.brand || NOT_SET;
    case 'stock': return v.stock;
    case 'photos': return v.photos;
  }
};

export async function filterProducts(clientId: string, query: ProductFilterQuery) {
  const statuses = query.status ? [query.status] : ['ACTIVE', 'DRAFT'];
  // One row per colour (a product with none gets one empty row), its whole-shop stock as the list
  // shows it, and its price: the colour's own, else the product's.
  const [rows, pictured] = await Promise.all([
    prisma.$queryRaw<Row[]>(Prisma.sql`
      SELECT p.id AS pid, p.title, p.product_code AS code, p.created_at AS created, p.dress_type AS type, p.fabric, p.craft, p.brand,
             v.id AS vid, v.sku, v.barcode, v.color_name AS colour,
             COALESCE(NULLIF(v.selling_price, 0), p.base_price, 0)::float AS price,
             COALESCE(s.qty, 0)::int AS qty, COALESCE(v.reorder_level, 0)::int AS level
      FROM inventory_products p
      LEFT JOIN inventory_product_variants v ON v.product_id = p.id
      LEFT JOIN (SELECT variant_id, SUM(quantity) AS qty FROM inventory_stocks WHERE client_id = ${clientId} GROUP BY variant_id) s ON s.variant_id = v.id
      WHERE p.client_id = ${clientId} AND p.status::text IN (${Prisma.join(statuses)})`),
    // A product "has photos" when any picture belongs to it or to one of its colours.
    prisma.$queryRaw<{ pid: string }[]>(Prisma.sql`
      SELECT DISTINCT p.id AS pid FROM inventory_product_images i
      LEFT JOIN inventory_product_variants v ON v.id = i.variant_id
      JOIN inventory_products p ON p.id = COALESCE(i.product_id, v.product_id)
      WHERE p.client_id = ${clientId}`)
  ]);
  const hasPhoto = new Set(pictured.map(r => r.pid));
  const variants: Variant[] = rows.map(r => ({
    ...r,
    fam: colourFamily(r.colour) ?? NOT_SET,
    stock: r.qty <= 0 ? 'out' : isLowStock(r.qty, r.level) ? 'low' : 'in',
    photos: hasPhoto.has(r.pid) ? 'with' : 'without'
  }));

  const picked: Record<Facet, Set<string>> = Object.fromEntries(FACETS.map(f => [f, new Set(query[f])])) as any;
  const q = query.q?.trim().toLowerCase();
  const passes = (v: Variant, skip?: Facet | 'price') => {
    for (const f of FACETS) if (f !== skip && picked[f].size && !picked[f].has(valueOf(v, f))) return false;
    if (skip !== 'price') {
      if (query.min !== undefined && v.price < query.min) return false;
      if (query.max !== undefined && v.price > query.max) return false;
    }
    if (q && ![v.title, v.code, v.sku, v.barcode, v.colour, v.fam, v.type, v.fabric, v.craft, v.brand].some(x => String(x ?? '').toLowerCase().includes(q))) return false;
    return true;
  };

  // How many products each choice would leave, the other filters on.
  const facets = Object.fromEntries(FACETS.map(f => {
    const hits = new Map<string, Set<string>>();
    const every = new Set<string>();
    for (const v of variants) {
      const k = valueOf(v, f); every.add(k);
      if (passes(v, f)) { if (!hits.has(k)) hits.set(k, new Set()); hits.get(k)!.add(v.pid); }
    }
    const options = [...every].map(value => ({ value, count: hits.get(value)?.size ?? 0 }))
      .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
    return [f, options];
  })) as Record<Facet, { value: string; count: number }[]>;
  const priceSpan = variants.length ? { lo: Math.min(...variants.map(v => v.price)), hi: Math.max(...variants.map(v => v.price)) } : { lo: 0, hi: 0 };
  const priceCount = (lo?: number, hi?: number) => new Set(variants.filter(v => passes(v, 'price') && (lo === undefined || v.price >= lo) && (hi === undefined || v.price <= hi)).map(v => v.pid)).size;
  const priceBands = [[undefined, 1000], [1000, 5000], [5000, 15000], [15000, undefined]].map(([lo, hi]) => ({ min: lo ?? null, max: hi ?? null, count: priceCount(lo, hi) }));

  // The products left, each with the colours that passed, sorted.
  const byProduct = new Map<string, Variant[]>();
  for (const v of variants) if (passes(v)) { if (!byProduct.has(v.pid)) byProduct.set(v.pid, []); byProduct.get(v.pid)!.push(v); }
  const found = [...byProduct.entries()].map(([pid, vs]) => ({
    pid, title: vs[0].title, created: new Date(vs[0].created).getTime(),
    price: Math.min(...vs.map(v => v.price)), qty: vs.reduce((t, v) => t + v.qty, 0),
    matches: vs.map(v => v.vid).filter(Boolean) as string[]
  }));
  const by: Record<typeof query.sort, (a: typeof found[0], b: typeof found[0]) => number> = {
    new: (a, b) => b.created - a.created, old: (a, b) => a.created - b.created,
    plo: (a, b) => a.price - b.price, phi: (a, b) => b.price - a.price,
    qhi: (a, b) => b.qty - a.qty, qlo: (a, b) => a.qty - b.qty,
    az: (a, b) => a.title.localeCompare(b.title, 'en', { sensitivity: 'base' })
  };
  // A whole code, SKU or barcode typed (or scanned) puts that product first: "PRD-000003" also sits
  // inside "PRD-0000031", and the one asked for must not be lost among its neighbours.
  const exact = new Set(q ? variants.filter(v => [v.code, v.sku, v.barcode].some(x => String(x ?? '').toLowerCase() === q)).map(v => v.pid) : []);
  found.sort((a, b) => (exact.has(b.pid) ? 1 : 0) - (exact.has(a.pid) ? 1 : 0) || by[query.sort](a, b) || b.created - a.created || a.pid.localeCompare(b.pid));

  const start = (query.page - 1) * query.limit;
  const page = found.slice(start, start + query.limit);
  const { data } = await productRepository.findManyWithFilters(clientId, { ids: page.map(p => p.pid) });
  // Which colours passed: only worth sending when a filter looks at colours at all.
  const colourLevel = picked.colour.size || picked.stock.size || query.min !== undefined || query.max !== undefined;
  const matches = new Map(page.map(p => [p.pid, p.matches]));
  return {
    data: data.map((p: any) => (colourLevel ? { ...p, matches: matches.get(p.id) ?? [] } : p)),
    meta: {
      page: query.page, limit: query.limit, total: found.length, pages: Math.ceil(found.length / query.limit),
      colours: [...byProduct.values()].reduce((t, vs) => t + vs.filter(v => v.vid).length, 0),
      everything: new Set(variants.map(v => v.pid)).size
    },
    facets: { ...facets, price: { ...priceSpan, bands: priceBands } }
  };
}
