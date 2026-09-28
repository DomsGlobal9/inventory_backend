/**
 * The credit note a return is, under GST.
 *
 * A return is NOT a negative invoice, and the difference is not pedantry: a credit note has its
 * own unbroken series, references the bill it reverses, and reverses the tax at the rate that
 * bill carried. Filed as a negative invoice it would break the invoice series' continuity, which
 * is the one thing an assessing officer checks first.
 *
 * THE RATE IS READ, NEVER LOOKED UP. Sarees went from 12% to 5% on 22 September 2025. A saree
 * sold on the 21st and returned on the 23rd must give back the 12% the customer actually paid.
 * Looking the rate up at return time would hand back 5% and quietly keep the difference -- and
 * nobody would notice until an audit, because both figures look reasonable on their own. So every
 * line's tax comes from the frozen sale line: taxRateBps, hsnCode and the split as recorded.
 *
 * APPORTIONED WITH allocate(), because one saree out of three is a third of that line's tax and
 * thirds do not divide into paise. allocate puts the stray paisa somewhere deliberate and makes
 * the parts add back to the whole, so three separate returns of one saree each give back exactly
 * what one return of three would.
 */
import { Prisma } from '@prisma/client';
import { toMinor, fromMinor, portionOf } from '../pricing/money';
import { allocateInvoiceNumber, SERIES } from './invoiceNumber';

type Tx = Prisma.TransactionClient;

/** What one returned line takes back, in paise. */
export interface ReversedLine {
  salesReturnItemId: string;
  hsnCode: string | null;
  taxRateBps: number | null;
  taxableMinor: number;
  cgstMinor: number;
  sgstMinor: number;
  igstMinor: number;
}

/**
 * Work out what a return takes back, line by line, from the frozen sale lines.
 *
 * Pure apart from the read: given the same rows it gives the same answer, which is what makes it
 * testable without a shop.
 */
export async function reverseTaxForReturn(tx: Tx, returnId: string): Promise<ReversedLine[]> {
  const items = await tx.salesReturnItem.findMany({
    where: { salesReturnId: returnId },
    select: {
      id: true, quantity: true,
      dispatchItem: {
        select: {
          salesOrderItem: {
            select: {
              id: true, quantity: true,
              hsnCode: true, taxRateBps: true,
              taxableValue: true, cgst: true, sgst: true, igst: true
            }
          }
        }
      }
    }
  });

  /*
   * Grouped by SALE line, not by return line.
   *
   * Two return lines can point at the same sale line -- a bill dispatched in two parcels, both
   * partly returned. Apportioning each against the sale line separately would round each one up
   * and give back more tax than was charged. Allocating once across the whole group cannot.
   */
  const bySaleLine = new Map<string, typeof items>();
  for (const it of items) {
    const saleLineId = it.dispatchItem.salesOrderItem.id;
    const at = bySaleLine.get(saleLineId) ?? [];
    at.push(it);
    bySaleLine.set(saleLineId, at);
  }

  const out: ReversedLine[] = [];

  for (const group of bySaleLine.values()) {
    const sale = group[0].dispatchItem.salesOrderItem;

    // Nothing was frozen on this line: a sale from before GST existed, or a shop that charges
    // none. Reversing a tax that was never charged would invent money.
    if (sale.taxRateBps == null) {
      for (const g of group) {
        out.push({
          salesReturnItemId: g.id, hsnCode: sale.hsnCode ?? null, taxRateBps: null,
          taxableMinor: 0, cgstMinor: 0, sgstMinor: 0, igstMinor: 0
        });
      }
      continue;
    }

    /*
     * How many of this line came back BEFORE this return.
     *
     * The apportionment is by RANGE, not by fraction, and that is what stops three separate
     * returns of one saree from giving back a different total than one return of three. Asking
     * "what is the tax on pieces 1 to 2" and then "on pieces 2 to 3" always adds back to "on
     * pieces 0 to 3"; rounding a third three times does not.
     */
    const prior = await tx.salesReturnItem.aggregate({
      where: {
        salesReturnId: { not: returnId },
        dispatchItem: { salesOrderItemId: sale.id },
        salesReturn: { status: 'COMPLETED' }
      },
      _sum: { quantity: true }
    });

    let from = prior._sum.quantity ?? 0;
    const qty = sale.quantity;

    /*
     * Each figure taken over the same range, separately.
     *
     * Splitting only the total and deriving the rest would let cgst + sgst drift from the line's
     * tax by a paisa -- exactly the kind of difference that makes a return fail its own amount
     * check months later.
     */
    for (const g of group) {
      const to = from + g.quantity;
      const over = (whole: unknown) => portionOf(toMinor(whole as any), qty, from, to);

      out.push({
        salesReturnItemId: g.id,
        hsnCode: sale.hsnCode ?? null,
        taxRateBps: sale.taxRateBps,
        taxableMinor: over(sale.taxableValue ?? 0),
        cgstMinor: over(sale.cgst ?? 0),
        sgstMinor: over(sale.sgst ?? 0),
        igstMinor: over(sale.igst ?? 0)
      });
      from = to;
    }
  }

  return out;
}

/**
 * Give a completed return its credit note: a number, and the tax it reverses.
 *
 * Called from inside the return's own transaction, so a return and its credit note are one thing
 * or neither. Idempotent by the column it fills: a return that already has a number keeps it,
 * because a credit note number that changed on a retry would leave two documents claiming to
 * reverse the same bill.
 */
export async function issueCreditNote(
  tx: Tx,
  clientId: string,
  returnId: string,
  when: Date = new Date()
): Promise<{ creditNoteNo: string | null; reversedMinor: number }> {
  const salesReturn = await tx.salesReturn.findFirst({
    where: { id: returnId, clientId },
    select: { creditNoteNo: true }
  });
  if (!salesReturn) return { creditNoteNo: null, reversedMinor: 0 };

  const lines = await reverseTaxForReturn(tx, returnId);
  const anyTax = lines.some(l => l.taxRateBps != null);

  for (const l of lines) {
    await tx.salesReturnItem.update({
      where: { id: l.salesReturnItemId },
      data: {
        hsnCode: l.hsnCode,
        taxRateBps: l.taxRateBps,
        taxableValue: fromMinor(l.taxableMinor),
        cgst: fromMinor(l.cgstMinor),
        sgst: fromMinor(l.sgstMinor),
        igst: fromMinor(l.igstMinor)
      }
    });
  }

  const totals = lines.reduce(
    (a, l) => ({
      taxable: a.taxable + l.taxableMinor,
      cgst: a.cgst + l.cgstMinor,
      sgst: a.sgst + l.sgstMinor,
      igst: a.igst + l.igstMinor
    }),
    { taxable: 0, cgst: 0, sgst: 0, igst: 0 }
  );

  /*
   * No number for a shop that charges no tax.
   *
   * A composition shop and an unregistered one issue a plain refund receipt, not a credit note,
   * and a credit note series with nothing in it is a series somebody will later mistake for a
   * gap. The refund still happens; only the tax document does not.
   */
  const creditNoteNo = salesReturn.creditNoteNo
    ?? (anyTax ? (await allocateInvoiceNumber(tx as any, clientId, SERIES.CREDIT_NOTE, when)).formatted : null);

  await tx.salesReturn.update({
    where: { id: returnId },
    data: {
      creditNoteNo,
      taxableValue: fromMinor(totals.taxable),
      cgst: fromMinor(totals.cgst),
      sgst: fromMinor(totals.sgst),
      igst: fromMinor(totals.igst)
    }
  });

  return { creditNoteNo, reversedMinor: totals.cgst + totals.sgst + totals.igst };
}
