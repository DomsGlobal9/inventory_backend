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

/** A returned line refers to what was DISPATCHED, not to what was ordered. */
export const createReturnSchema = z.object({
  salesOrderId: z.string({ required_error: 'Which order is this coming back from?' }).min(1, 'Which order is this coming back from?'),
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
