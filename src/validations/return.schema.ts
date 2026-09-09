import { z } from 'zod';

/**
 * The returns endpoints had no validation at all.
 *
 * Every other write path in this API parses its body before the service sees it. Returns
 * destructured `req.body` straight through, so a request naming the wrong field reached Prisma
 * and came back as this, verbatim, to whoever asked:
 *
 *     Invalid `prisma.salesReturn.create()` invocation:
 *     { data: { clientId: "...", returnNumber: "RET-000001", ... } }
 *     Argument `dispatchItem` is missing.
 *
 * Two problems in one reply. It hands out the table names, the column names and the shape of
 * the query -- a map of the database, free, to anyone who can reach the endpoint. And it tells
 * the person who made the mistake nothing they can act on: the field they got wrong is
 * `dispatchItemId`, which appears nowhere in that message.
 */

/**
 * The reasons a sale can come back, as stored. Kept in step with the ReturnReason enum in
 * the Prisma schema -- if a value is added there it belongs here too, or callers will be
 * refused a reason the database would have accepted.
 */
export const RETURN_REASONS = [
  'DAMAGED_IN_TRANSIT',
  'WRONG_ITEM',
  'SIZE_ISSUE',
  'CUSTOMER_REJECTED',
  'DEFECTIVE',
  'OTHER'
] as const;

/** A returned line refers to what was DISPATCHED, not to what was ordered. */
export const createReturnSchema = z.object({
  salesOrderId: z.string({ required_error: 'Which order is this coming back from?' }).min(1, 'Which order is this coming back from?'),
  // Why it came back. Absent from this schema until now, which meant Zod stripped it from
  // every request before anything could read it -- and the service hardcoded OTHER anyway.
  // Between the two, every return ever recorded on this platform says OTHER, whatever the
  // customer actually said, and "why are things coming back?" has no answer.
  //
  // Named values rather than free text, because a returns report can only group what is
  // spelled the same way twice, and rejected rather than quietly coerced: a POS sending
  // DAMAGED instead of DAMAGED_IN_TRANSIT should be told once at integration time, not file
  // a year of returns under OTHER and find out from an empty report.
  reason: z.enum(RETURN_REASONS, {
    errorMap: () => ({
      message: 'Say why it came back, using one of: ' + RETURN_REASONS.join(', ') + '.'
    })
  }).optional(),
  items: z.array(z.object({
    // The commonest mistake, and the one the raw error above was hiding: callers reach for
    // salesOrderItemId because that is what they have. You can only return what actually left.
    dispatchItemId: z.string({
      required_error: 'Each line needs the dispatch it came from — dispatchItemId, not salesOrderItemId. You can only return what actually left.'
    }).min(1, 'Each line needs the dispatch it came from'),
    quantity: z.number({ required_error: 'How many pieces are coming back?' }).int().positive('Return at least one piece'),
    reason: z.string().max(500).optional().nullable()
  })).min(1, 'A return needs at least one line'),
  notes: z.string().max(4000).optional().nullable()
});

export const inspectReturnSchema = z.object({
  itemsDisposition: z.array(z.object({
    salesReturnItemId: z.string({ required_error: 'Which returned line is this decision about?' }).min(1, 'Which returned line is this decision about?'),
    // PENDING is deliberately not offered: inspecting IS the act of deciding, so "still
    // undecided" is not an outcome the inspection step can produce.
    disposition: z.enum(['RESTOCK', 'DAMAGED', 'SCRAP'], {
      errorMap: () => ({ message: 'Say whether it goes back on the shelf, is damaged, or is scrap' })
    }),
    reason: z.string().max(500).optional().nullable()
  })).min(1, 'Decide on at least one line')
});
