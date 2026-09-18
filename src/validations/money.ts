/**
 * Money goes to the paisa: at most two digits after the point.
 *
 * Every price column is Decimal(10, 2), so a third digit was not refused -- it was rounded by the
 * database with a success message on top: a base price of 12.345 saved as 12.35, a variant at
 * 1499.999 as 1500. Somebody who typed 1499.999 meant something by it, and is told rather than
 * silently corrected. (sales-order.schema says the same for amounts on an order.)
 *
 * The tolerance is there because 12.34 * 100 is 1233.9999999999998 in binary floating point;
 * without it every second legitimate price would be refused.
 */
export const isWholePaise = (v: number) => Math.abs(v * 100 - Math.round(v * 100)) < 1e-6;

export const PAISA_MESSAGE = 'Prices go to the paisa: use at most 2 digits after the point, for example 1499.50.';

/** The largest amount a Decimal(10, 2) column holds. */
export const MAX_PRICE = 99999999.99;
