/**
 * How a product is sold, and what its quantities mean (13 Nov 2026, PLAN-fabrics.md).
 *
 * Every quantity in the database stays a WHOLE number, in the unit's BASE: a metre product keeps centimetres
 * (225 = 2.25 m), a kilogram product grams. Everything sold today is PIECE, whose base is the piece itself, so for
 * those nothing changes: factor 1, whole numbers, as before. A price always means per sold-by unit (₹450 per metre),
 * so money is quantity × price ÷ factor.
 *
 * The same codes as the boutique module (CRM-B `Unit`), so a later merge is a copy, not a translation. Kept in step
 * by hand with frontend/src/lib/units.js and backend/shop/src/units.js.
 */
export type SoldBy = 'PIECE' | 'METRE' | 'PACKET' | 'PAIR' | 'SET' | 'KILOGRAM' | 'GRAM' | 'BOX' | 'STRING' | 'UNIT';

type UnitInfo = { factor: number; whole: boolean; one: string; many: string; short: string; base: string };
export const UNITS: Record<SoldBy, UnitInfo> = {
  PIECE:    { factor: 1,    whole: true,  one: 'piece',    many: 'pieces',    short: 'pc',  base: 'piece' },
  METRE:    { factor: 100,  whole: false, one: 'metre',    many: 'metres',    short: 'm',   base: 'cm' },
  PACKET:   { factor: 1,    whole: true,  one: 'packet',   many: 'packets',   short: 'pkt', base: 'packet' },
  PAIR:     { factor: 1,    whole: true,  one: 'pair',     many: 'pairs',     short: 'pr',  base: 'pair' },
  SET:      { factor: 1,    whole: true,  one: 'set',      many: 'sets',      short: 'set', base: 'set' },
  KILOGRAM: { factor: 1000, whole: false, one: 'kilogram', many: 'kilograms', short: 'kg',  base: 'g' },
  GRAM:     { factor: 1,    whole: true,  one: 'gram',     many: 'grams',     short: 'g',   base: 'g' },
  BOX:      { factor: 1,    whole: true,  one: 'box',      many: 'boxes',     short: 'box', base: 'box' },
  STRING:   { factor: 1,    whole: true,  one: 'string',   many: 'strings',   short: 'str', base: 'string' },
  UNIT:     { factor: 1,    whole: true,  one: 'unit',     many: 'units',     short: 'unit', base: 'unit' },
};
export const SOLD_BY = Object.keys(UNITS) as SoldBy[];
/** Offered for selling in the first round (decision D1); the rest are stored and shown, not offered yet. */
export const SELLING_NOW: SoldBy[] = ['PIECE', 'METRE', 'PACKET'];

/** What a product is: the boutique's kinds (CRM-B fabric_taxonomy), with the unit each is usually sold by. */
export const KINDS: { key: string; label: string; soldBy: SoldBy }[] = [
  { key: 'FABRIC', label: 'Fabric', soldBy: 'METRE' },
  { key: 'LINING', label: 'Lining', soldBy: 'METRE' },
  { key: 'BACKING_FABRIC', label: 'Backing fabric', soldBy: 'METRE' },
  { key: 'CAN_CAN', label: 'Can-can', soldBy: 'METRE' },
  { key: 'BORDER', label: 'Border', soldBy: 'METRE' },
  { key: 'LACE_TRIM', label: 'Lace / Trim', soldBy: 'METRE' },
  { key: 'GOTA', label: 'Gota', soldBy: 'METRE' },
  { key: 'KIRAN', label: 'Kiran', soldBy: 'METRE' },
  { key: 'ELASTIC', label: 'Elastic / Drawstring', soldBy: 'METRE' },
  { key: 'DORI', label: 'Dori', soldBy: 'PIECE' },
  { key: 'TASSEL_LATKAN', label: 'Tassel / Latkan', soldBy: 'PIECE' },
  { key: 'BUTTONS', label: 'Buttons', soldBy: 'PACKET' },
  { key: 'ZIPPER', label: 'Zipper', soldBy: 'PIECE' },
  { key: 'HOOKS', label: 'Hooks', soldBy: 'PACKET' },
  { key: 'PADDING_CUPS', label: 'Padding / Cups', soldBy: 'PAIR' },
  { key: 'SHOULDER_PADS', label: 'Shoulder pads', soldBy: 'PAIR' },
  { key: 'BONING', label: 'Boning', soldBy: 'METRE' },
  { key: 'DECORATIVE_MOTIFS', label: 'Decorative motifs', soldBy: 'PIECE' },
  { key: 'BROOCH_KALGI', label: 'Brooch / Kalgi', soldBy: 'PIECE' },
  { key: 'OTHER', label: 'Other', soldBy: 'PIECE' },
];
export const KIND_KEYS = KINDS.map(k => k.key);

export const isSoldBy = (v: unknown): v is SoldBy => typeof v === 'string' && (SOLD_BY as string[]).includes(v);
export const unitOf = (soldBy: unknown): UnitInfo => UNITS[isSoldBy(soldBy) ? soldBy : 'PIECE'];
export const factorOf = (soldBy: unknown) => unitOf(soldBy).factor;
export const isMeasured = (soldBy: unknown) => !unitOf(soldBy).whole;

/** The smallest amount one sale may be, in base units: the product's own cut, else the shop's (metre), else 1. */
export function minCutOf(product: { soldBy?: string | null; minCut?: number | null }, shopMinCut = 25): number {
  if (!isMeasured(product.soldBy)) return 1;
  const own = Number(product.minCut);
  if (Number.isInteger(own) && own > 0) return own;
  return product.soldBy === 'METRE' && Number.isInteger(shopMinCut) && shopMinCut > 0 ? shopMinCut : 1;
}

/**
 * What a person typed ("2.25", "2,25", 2.25) in the product's unit, as base units (225), or null when it is not a
 * number the unit can hold: more decimals than the base allows (2.255 m is not whole centimetres), or not finite.
 */
export function toBase(input: unknown, soldBy: unknown): number | null {
  const text = String(input ?? '').trim().replace(',', '.');
  if (!/^-?\d+(\.\d+)?$/.test(text)) return null;
  const f = factorOf(soldBy);
  const decimals = (text.split('.')[1] ?? '').length;
  if (decimals > Math.round(Math.log10(f))) return null;
  const base = Math.round(Number(text) * f);
  return Number.isSafeInteger(base) ? base : null;
}

/** Base units as the unit's number (225 cm -> 2.25). */
export const fromBase = (base: number, soldBy: unknown) => Number(base) / factorOf(soldBy);

/** "2.25 m", "3 packets", "1 piece". `short` uses the short unit name. */
export function formatQty(base: number, soldBy: unknown, { short = false } = {}): string {
  const u = unitOf(soldBy);
  const n = fromBase(base, soldBy);
  const digits = Math.round(Math.log10(u.factor));
  const shown = digits ? n.toFixed(digits) : String(n);
  if (short || !u.whole) return `${shown} ${u.short}`;
  return `${shown} ${n === 1 ? u.one : u.many}`;
}

/**
 * Why a quantity cannot be used for this product, in plain words, or null when it can. Base units in. Positive,
 * whole base units, and for a measured product a multiple of its smallest cut.
 */
export function quantityProblem(base: number, product: { soldBy?: string | null; minCut?: number | null }, shopMinCut = 25): string | null {
  const u = unitOf(product.soldBy);
  if (!Number.isSafeInteger(base)) return u.whole ? `Enter a whole number of ${u.many}.` : `Enter the length in ${u.many}, like 2.25.`;
  if (base <= 0) return `Enter more than 0 ${u.many}.`;
  const cut = minCutOf(product, shopMinCut);
  if (cut > 1 && base % cut !== 0) {
    const step = formatQty(cut, product.soldBy);
    const down = Math.floor(base / cut) * cut, up = down + cut;
    return `${formatQty(base, product.soldBy)} is not a multiple of the smallest cut (${step}). Use ${down > 0 ? `${formatQty(down, product.soldBy)} or ` : ''}${formatQty(up, product.soldBy)}.`;
  }
  return null;
}

/*
 * PRICES ARE STORED PER BASE UNIT (PLAN-fabrics 4.3): a metre product's ₹450 per metre is stored as 4.50 per cm, so
 * every existing `quantity × price` in bills, tax, refunds, cost and reports is already right without change. Only
 * what people type and see is per metre.
 */

/**
 * A price typed per sold-by unit (₹450 per metre) as the stored per-base-unit price (4.50), or null when it cannot
 * be stored exactly in paise per base unit (₹450.50 per metre is 4.505 per cm): metre prices are whole rupees.
 */
export function storedPrice(perUnit: unknown, soldBy: unknown): number | null {
  const n = Number(String(perUnit ?? '').trim().replace(',', '.'));
  if (!Number.isFinite(n) || n < 0) return null;
  const paisePerBase = (n * 100) / factorOf(soldBy);
  const whole = Math.round(paisePerBase);
  if (Math.abs(paisePerBase - whole) > 1e-6) return null;
  return whole / 100;
}

/** The stored per-base-unit price as the price per sold-by unit people see (4.50 per cm -> 450 per metre). */
export const pricePerUnit = (stored: number, soldBy: unknown) => Math.round(Number(stored) * factorOf(soldBy) * 100) / 100;

/** Why a typed price cannot be used, in plain words, or null. */
export function priceProblem(perUnit: unknown, soldBy: unknown): string | null {
  if (storedPrice(perUnit, soldBy) !== null) return null;
  const n = Number(String(perUnit ?? '').trim().replace(',', '.'));
  if (!Number.isFinite(n) || n < 0) return 'Enter a price of 0 or more.';
  const u = unitOf(soldBy);
  return `A price per ${u.one} must be in whole rupees${u.factor >= 1000 ? ' (or tens of rupees)' : ''}, like ${Math.round(n)}.`;
}

/** Money for a quantity in base units at the stored per-base price, to the paisa: 225 cm × 4.50 = ₹1,012.50. */
export const lineAmount = (baseQty: number, stored: number) => Math.round(Number(baseQty) * Number(stored) * 100) / 100;
