import React from 'react';
import { prisma } from '../../lib/prisma';
import { code128B, encodable } from './code128';
import { pricePerUnit, type SoldBy } from '../../lib/units';
import { problem, storeOf, type Actor } from './index';

/**
 * Barcode and price labels for the Boutique app (20 Nov 2026, PLAN-boutique-backend.md #4): the same 50 x 25 mm label
 * Inventory's app prints -- name, price, SKU, the Code 128 barcode and its number -- as one PDF ready for a label
 * printer. Written with createElement and loaded as an ES module, exactly like the Day Book PDF (whatsapp/daybook-pdf).
 */
const loadEsm = new Function('specifier', 'return import(specifier)') as (s: string) => Promise<any>;
const h = React.createElement;
const W = 141.73, H = 70.86; // 50 mm x 25 mm in points

export type LabelItem = { title: string; sku: string; barcode: string; price: number | null; per?: string };

const rupees = (n: number | null) => (n === null ? 'No price' : `Rs. ${n.toLocaleString('en-IN', { minimumFractionDigits: n % 1 ? 2 : 0, maximumFractionDigits: 2 })}`);

/** The label PDF for these items, `copies` of each (1 to 50). */
export async function labelsPdf(items: LabelItem[], copies = 1): Promise<Buffer> {
  const { Document, Page, Text, View, renderToBuffer } = await loadEsm('@react-pdf/renderer');
  const pages: React.ReactElement[] = [];
  items.forEach((it, idx) => {
    const bars = code128B(it.barcode);
    const unit = Math.min(0.9, (W - 12) / bars.length); // width of one module, so the code fits the label
    const runs: React.ReactElement[] = [];
    let x = 0;
    for (let i = 0; i < bars.length;) {
      let j = i;
      while (j < bars.length && bars[j] === bars[i]) j++;
      if (bars[i] === '1') runs.push(h(View, { key: `${i}`, style: { position: 'absolute', left: x, top: 0, width: (j - i) * unit, height: 24, backgroundColor: '#000' } }));
      x += (j - i) * unit;
      i = j;
    }
    for (let c = 0; c < copies; c++) {
      pages.push(h(Page, { key: `${idx}-${c}`, size: [W, H], style: { padding: 4, fontFamily: 'Helvetica', alignItems: 'center', justifyContent: 'center', backgroundColor: '#fff' } },
        h(View, { style: { flexDirection: 'row', justifyContent: 'space-between', width: '100%', marginBottom: 1 } },
          h(Text, { style: { fontSize: 6, fontFamily: 'Helvetica-Bold', maxWidth: '62%' } }, it.title.slice(0, 40)),
          h(Text, { style: { fontSize: 6, fontFamily: 'Helvetica-Bold' } }, rupees(it.price) + (it.price !== null && it.per ? ` / ${it.per}` : ''))),
        h(Text, { style: { fontSize: 5, width: '100%', marginBottom: 2 } }, `SKU: ${it.sku}`),
        h(View, { style: { width: x, height: 24, position: 'relative' } }, ...runs),
        h(Text, { style: { fontSize: 5.5, marginTop: 1, letterSpacing: 0.5 } }, it.barcode)
      ));
    }
  });
  return renderToBuffer(h(Document, { title: 'Labels', creator: 'ScaleEzy' }, ...pages));
}

const PER: Partial<Record<SoldBy, string>> = { METRE: 'm', KILOGRAM: 'kg' };

/**
 * The label sheet asked for: up to 100 item codes, 1 to 50 copies of each, priced at a store (its own price there,
 * else the item's). Codes not in the shop, or items with no barcode yet, are refused by name, so nothing prints wrong.
 */
export async function labelsFor(actor: Actor, body: { itemCodes?: unknown; storeId?: unknown; copies?: unknown }) {
  const raw = body.itemCodes;
  if (!Array.isArray(raw) || !raw.length) throw problem('Send itemCodes: a list of item codes.');
  if (raw.length > 100) throw problem('Print at most 100 items at once.');
  const codes = [...new Set(raw.map(c => String(c ?? '').trim()).filter(Boolean))];
  const copies = body.copies == null || body.copies === '' ? 1 : Number(body.copies);
  if (!Number.isInteger(copies) || copies < 1 || copies > 50) throw problem('copies is a whole number from 1 to 50.');
  const storeId = body.storeId ? await storeOf(actor.clientId, body.storeId, prisma, true) : null;
  const { items, missing, noBarcode } = await labelItems(actor.clientId, codes, storeId);
  if (missing.length) throw problem(`Not in this shop: ${missing.join(', ')}.`, 404);
  if (noBarcode.length) throw problem(`No barcode yet: ${noBarcode.join(', ')}. Give them one first (POST /items/barcodes/fill).`, 409);
  if (items.length * copies > 2000) throw problem('That is more than 2,000 labels. Print it in parts.');
  return labelsPdf(items, copies);
}

/** The shop's items by the boutique's own item codes, with the price at a store (its own price there, else the item's). */
export async function labelItems(clientId: string, itemCodes: string[], storeId: string | null): Promise<{ items: LabelItem[]; missing: string[]; noBarcode: string[] }> {
  const variants = await prisma.productVariant.findMany({
    where: { clientId, boutiqueRef: { in: itemCodes }, boutiqueDeletedAt: null },
    select: {
      boutiqueRef: true, sku: true, barcode: true, sellingPrice: true,
      product: { select: { title: true, basePrice: true, soldBy: true } },
      locationProfiles: storeId ? { where: { locationId: storeId }, select: { priceOverride: true } } : false
    }
  });
  const byCode = new Map(variants.map(v => [v.boutiqueRef!, v]));
  const items: LabelItem[] = [];
  const missing: string[] = [];
  const noBarcode: string[] = [];
  for (const code of itemCodes) {
    const v = byCode.get(code);
    if (!v) { missing.push(code); continue; }
    if (!v.barcode || !encodable(v.barcode)) { noBarcode.push(code); continue; }
    const soldBy = v.product.soldBy as SoldBy;
    const override = (v as any).locationProfiles?.[0]?.priceOverride;
    // Prices are kept per base unit (a centimetre of cloth, a gram); the label shows them per metre or kilogram.
    const stored = override ?? v.sellingPrice ?? v.product.basePrice ?? null;
    const price = stored === null ? null : pricePerUnit(Number(stored), soldBy);
    items.push({ title: v.product.title, sku: v.sku, barcode: v.barcode, price, per: PER[soldBy] });
  }
  return { items, missing, noBarcode };
}
