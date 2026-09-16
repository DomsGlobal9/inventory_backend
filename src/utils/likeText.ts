/**
 * Text a person typed, for a "contains" search, taken literally.
 *
 * Prisma turns `contains` into LIKE '%text%' and passes the text through as it came, so % and _ in
 * it are wildcards: searching orders for "%" returned every order, and "_" matched any single
 * character. Escaped, they are only themselves -- a product code "SR_01" finds SR_01 and not SRX01.
 */
export const literal = (text: string) => text.replace(/[\\%_]/g, (ch) => `\\${ch}`);
