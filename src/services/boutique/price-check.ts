import { prisma } from '../../lib/prisma';
import { pricingQuoteService } from '../pricing/quote.service';
import { toMinor } from '../pricing/money';
import { buildBill } from '../pricing/bill';
import { registrationInForce } from '../pricing/tax';
import { canonicalCode } from '../offers/codes';
import { customerForTill } from '../pos/pos-holds.service';
import { factorOf, pricePerUnit, type SoldBy } from '../../lib/units';
import { problem, storeOf, baseQty, type Actor } from './index';

/**
 * The price check (20 Nov 2026, PLAN-boutique-backend.md part 2): the exact total of a counter bill before it is
 * made, worked out by Inventory's ONE pricing engine (the till's offers, the shop's own GST settings), so the
 * Boutique app shows what the bill will say. Nothing is saved: a price check is asked on every scan. The bill itself
 * is made by the POS module's Boutique counter, which asks the same engine.
 *
 * Any item the shop sells is priced -- the boutique's own and the shop's retail products alike (client B runs both
 * from the Boutique app) -- found by barcode, item code, SKU or variant code. Quantities are in the item's unit:
 * 2.25 for 2.25 metres. Money is in rupees, like the rest of the boutique API.
 */
const MAX_LINES = 100;
const rupees = (minor: number) => Math.round(minor) / 100;

type Found = { id: string; code: string; itemCode: string | null; variantCode: string; title: string; colour: string | null; size: string | null; soldBy: SoldBy; hsn: string | null; rateBps: number | null; slabbed: boolean; exclusive: boolean; selling: boolean };

async function find(clientId: string, code: string): Promise<Found | null> {
  const select = {
    id: true, boutiqueRef: true, variantCode: true, colorName: true, size: true, boutiqueDeletedAt: true,
    product: { select: { title: true, soldBy: true, hsnCode: true, taxRateBps: true, taxSlabbed: true, priceIsExclusive: true, status: true, trashedAt: true, sellInShop: true } }
  } as const;
  // A barcode first (unique everywhere), then the codes a person types.
  const v = await prisma.productVariant.findFirst({ where: { clientId, barcode: code }, select })
    ?? await prisma.productVariant.findFirst({ where: { clientId, OR: [{ boutiqueRef: code }, { variantCode: code }, { sku: code }] }, select, orderBy: { createdAt: 'asc' } });
  if (!v || v.boutiqueDeletedAt) return null;
  const p = v.product;
  return {
    id: v.id, code, itemCode: v.boutiqueRef, variantCode: v.variantCode, title: p.title, colour: v.colorName, size: v.size,
    soldBy: p.soldBy as SoldBy, hsn: p.hsnCode, rateBps: p.taxRateBps, slabbed: !!p.taxSlabbed, exclusive: !!p.priceIsExclusive,
    selling: p.status === 'ACTIVE' && !p.trashedAt && p.sellInShop
  };
}

export async function priceCheck(actor: Actor, body: any) {
  const raw = Array.isArray(body?.lines) ? body.lines : null;
  if (!raw || !raw.length) throw problem('Send lines: each { code, quantity }.');
  if (raw.length > MAX_LINES) throw problem(`At most ${MAX_LINES} lines in one price check.`);
  const locationId = await storeOf(actor.clientId, body?.storeId);
  const coupon = typeof body?.couponCode === 'string' && body.couponCode.trim() ? canonicalCode(body.couponCode) : null;

  const found: { line: number; code: string; quantity: unknown; item: Found | null }[] = [];
  for (const [i, l] of raw.entries()) {
    const code = String(l?.code ?? l?.itemCode ?? l?.barcode ?? '').trim();
    if (!code || code.length > 60) throw problem(`Line ${i + 1}: give the item's code or barcode.`);
    found.push({ line: i + 1, code, quantity: l?.quantity, item: await find(actor.clientId, code) });
  }
  const seen = new Map<string, string>();
  for (const f of found) {
    if (!f.item) continue;
    const before = seen.get(f.item.id);
    if (before) throw problem(`${before} and ${f.code} are the same item. Send it once, with the full quantity.`);
    seen.set(f.item.id, f.code);
  }

  // The customer as the bill will name them (by phone), for their offers; nobody if the number is not a customer.
  const phone = typeof body?.customerPhone === 'string' ? body.customerPhone.trim() : '';
  const customer = phone ? await customerForTill(prisma, actor.clientId, phone) : null;

  const priceable: { f: typeof found[number]; base: number }[] = [];
  const notPriced: { code: string; reason: string }[] = [];
  for (const f of found) {
    if (!f.item) { notPriced.push({ code: f.code, reason: 'Nothing in this shop has this code.' }); continue; }
    if (!f.item.selling) { notPriced.push({ code: f.code, reason: `${f.item.title} is not for sale (a material, archived or in the bin).` }); continue; }
    const base = baseQty(f.quantity, f.item.soldBy, `quantity of ${f.code}`);
    if (base <= 0) throw problem(`Line ${f.line}: the quantity must be above 0.`);
    priceable.push({ f, base });
  }

  const quote: any = priceable.length
    ? await pricingQuoteService.quote(actor.clientId, {
        locationId, channel: 'POS', customerId: customer?.id ?? null, couponCodes: coupon ? [coupon] : [],
        lines: priceable.map(p => ({ variantId: p.f.item!.id, quantity: p.base }))
      }, { persist: false, tolerant: true })
    : { lines: [], discounts: [], rejected: [], nearMisses: [], unpriced: [] };
  const byVariant = new Map<string, any>((quote.lines ?? []).map((l: any) => [l.variantId, l]));
  for (const p of priceable) if (!byVariant.has(p.f.item!.id)) notPriced.push({ code: p.f.code, reason: 'Not for sale at this store.' });
  const priced = priceable.filter(p => byVariant.has(p.f.item!.id));

  const settings = await prisma.clientSettings.findUnique({ where: { clientId: actor.clientId }, select: { gstRegistration: true, gstNumber: true, gstStateCode: true } });
  const registration = registrationInForce(settings?.gstRegistration, settings?.gstNumber);
  const bill = buildBill({
    registration, shopStateCode: settings?.gstStateCode ?? null,
    lines: priced.map(p => {
      const q = byVariant.get(p.f.item!.id);
      const total = toMinor(q.lineTotal);
      return {
        label: `${p.f.item!.title} (${p.f.code})`, quantity: p.base, netUnitPriceMinor: Math.round(total / p.base), lineTotalMinor: total,
        hsnCode: p.f.item!.hsn, taxRateBps: p.f.item!.rateBps, taxSlabbed: p.f.item!.slabbed, priceIsExclusive: p.f.item!.exclusive
      };
    })
  });

  const lines = priced.map((p, i) => {
    const q = byVariant.get(p.f.item!.id), b = bill.lines[i], it = p.f.item!;
    const f = factorOf(it.soldBy);
    return {
      code: p.f.code, itemCode: it.itemCode, variantCode: it.variantCode, name: it.title, colour: it.colour, size: it.size,
      unit: it.soldBy, quantity: p.base / f,
      // Per metre for cloth, per piece otherwise -- the price the shop set.
      unitPrice: pricePerUnit(Number(q.listUnitPrice), it.soldBy),
      discount: rupees(toMinor(q.discount)), lineTotal: rupees(toMinor(q.lineTotal)),
      offers: (q.appliedOffers ?? []).map((a: any) => ({ name: a.title, amount: rupees(toMinor(a.amount)) })),
      hsnCode: it.hsn, gstPercent: bill.chargesTax && it.rateBps != null ? b.rateBpsCharged / 100 : null,
      taxable: rupees(b.taxableValueMinor), cgst: rupees(b.cgstMinor), sgst: rupees(b.sgstMinor), igst: rupees(b.igstMinor), lineGross: rupees(b.lineGrossMinor)
    };
  });

  let couponOut: { code: string; accepted: boolean; reason?: string } | undefined;
  if (coupon) {
    const refused = (quote.rejected ?? []).find((r: any) => r.code === coupon);
    const took = (quote.discounts ?? []).some((d: any) => d.code === coupon);
    couponOut = refused ? { code: coupon, accepted: false, reason: refused.reason }
      : took ? { code: coupon, accepted: true } : { code: coupon, accepted: false, reason: 'That code took nothing off this bill.' };
  }

  return {
    storeId: locationId,
    customer: customer ? { found: true, name: customer.name } : { found: false },
    document: bill.documentKind, chargesGst: bill.chargesTax,
    lines,
    notPriced,
    totals: {
      beforeDiscount: rupees(priced.reduce((s, p) => s + toMinor(byVariant.get(p.f.item!.id).listUnitPrice) * p.base, 0)),
      discount: rupees(priced.reduce((s, p) => s + toMinor(byVariant.get(p.f.item!.id).discount), 0)),
      taxable: rupees(bill.taxableMinor), cgst: rupees(bill.cgstMinor), sgst: rupees(bill.sgstMinor), igst: rupees(bill.igstMinor), gst: rupees(bill.totalTaxMinor),
      roundOff: rupees(bill.roundOffMinor), payable: rupees(bill.payableMinor)
    },
    ...(couponOut ? { coupon: couponOut } : {}),
    // Offers almost reached: "add Rs 500 more for 10% off".
    notes: (quote.nearMisses ?? []).map((n: any) => n.reason).filter(Boolean),
    problems: bill.problems, warnings: bill.warnings, canBill: bill.issuable && notPriced.length === 0
  };
}
