/**
 * Invoice numbers: unbroken, per financial year, per shop, per series.
 *
 * A gap in an invoice series is a question the shop has to answer to a tax officer, and "our
 * software did that" is not an answer. So this borrows the rule `generateSequentialCode` already
 * states for product codes, where it matters for tidiness, and applies it where it matters
 * legally: THE NUMBER MUST BE TAKEN INSIDE THE TRANSACTION THAT SAVES THE SALE. Taken outside, a
 * sale that fails afterwards leaves a number nothing will ever use, sitting between two real
 * invoices with nothing to explain it.
 *
 * WHY THE FINANCIAL YEAR IS PART OF THE KEY. The series restarts every April, so 2026-27 and
 * 2027-28 are two different countings, not one continuing. Folding the year into the sequence key
 * makes that restart happen by itself on 1 April -- there is no job to run and nothing to remember,
 * which is the only way a yearly reset is ever reliable.
 *
 * WHY A SERIES PER CHANNEL. GST permits a business more than one series as long as each is unique
 * and sequential. The till and the online shop will each have their own, with distinct prefixes,
 * decided here rather than discovered at the first audit when two channels are found sharing
 * numbers.
 */

import { financialYearOf } from '../pricing/bill';

/** The channel a document was issued by. Distinct prefixes, on purpose. */
export const SERIES = {
  /** Sold at the counter. */
  COUNTER: 'CTR',
  /** The shop's own online shop. */
  ONLINE: 'WEB',
  /** Arrived from Shopify, which numbered it too -- ours is the one our books use. */
  SHOPIFY: 'SHP',
  /** A credit note reverses an invoice and has its own counting, as GST requires. */
  CREDIT_NOTE: 'CRN'
} as const;

export type SeriesCode = typeof SERIES[keyof typeof SERIES];

export interface AllocatedNumber {
  series: string;
  financialYear: string;
  number: number;
  /** What gets printed: CTR/2026-27/00001 */
  formatted: string;
}

/** Just enough of a Prisma transaction client to take a number. */
interface SequenceCapable {
  clientSequence: {
    upsert: (args: any) => Promise<{ lastValue: number }>;
  };
}

export function formatInvoiceNumber(series: string, financialYear: string, number: number): string {
  return `${series}/${financialYear}/${String(number).padStart(5, '0')}`;
}

/**
 * Take the next number.
 *
 * `tx` is required rather than optional -- unlike `generateSequentialCode`, where calling on the
 * base client is merely untidy, here it is the difference between a defensible series and a gapped
 * one. Making it non-optional means the mistake cannot be made by forgetting.
 */
export async function allocateInvoiceNumber(
  tx: SequenceCapable,
  clientId: string,
  series: SeriesCode | string,
  when: Date = new Date()
): Promise<AllocatedNumber> {
  const financialYear = financialYearOf(when);

  /*
   * One counter per shop, per series, per year. `ClientSequence` is keyed on
   * (clientId, entityType), so the year and series live inside entityType -- which is how the
   * April restart costs nothing: on the 1st, the key changes and a fresh counter starts at 1.
   */
  const entityType = `INVOICE:${series}:${financialYear}`;

  const sequence = await tx.clientSequence.upsert({
    where: { clientId_entityType: { clientId, entityType } },
    update: { lastValue: { increment: 1 } },
    create: { clientId, entityType, lastValue: 1 }
  });

  return {
    series,
    financialYear,
    number: sequence.lastValue,
    formatted: formatInvoiceNumber(series, financialYear, sequence.lastValue)
  };
}

/**
 * What the last issued number was, without taking one.
 *
 * For the screen that tells a shopkeeper where their series has got to. Reading it can never
 * advance it -- a report that consumes a number is how a series gets a hole in it.
 */
export async function lastInvoiceNumber(
  db: { clientSequence: { findUnique: (args: any) => Promise<{ lastValue: number } | null> } },
  clientId: string,
  series: SeriesCode | string,
  when: Date = new Date()
): Promise<number> {
  const entityType = `INVOICE:${series}:${financialYearOf(when)}`;
  const row = await db.clientSequence.findUnique({
    where: { clientId_entityType: { clientId, entityType } }
  });
  return row?.lastValue ?? 0;
}
