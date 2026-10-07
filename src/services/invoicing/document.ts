/**
 * The document a sale becomes: a Tax Invoice, a Bill of Supply, or a plain receipt.
 *
 * Assembled from what was SAVED, never recomputed. Every figure here comes off the order and its
 * lines, where the rate was frozen at the moment of sale. That is the whole point of freezing it:
 * the rates changed on 22 September 2025, so an invoice reprinted today for a sale made on the
 * 20th must show 12% -- what the customer actually paid -- and any code that recalculates would
 * print 18% and disagree with the money taken.
 *
 * PURE. An order and its settings in, a document out. It reads nothing and decides nothing about
 * what a rate should be.
 *
 * WHAT RULE 46 REQUIRES, and where each part comes from:
 *
 *   supplier name, address, GSTIN      ClientSettings
 *   a consecutive serial number        the frozen invoice_series/number/financial_year
 *   date of issue                      the order's own date
 *   recipient name, address, GSTIN     the customer, when there is one
 *   HSN per line                       frozen on the line, trimmed by turnover
 *   description, quantity, value       the line
 *   taxable value and the tax split    frozen on the line
 *   place of supply                    the order
 *   whether tax is payable on reverse charge   always no for a counter sale
 *   signature                          the shop's, on paper
 */

import { hsnForInvoice } from '../pricing/hsn';
import { formatInvoiceNumber } from './invoiceNumber';
import { documentKindFor, registrationInForce, type DocumentKind } from '../pricing/tax';

export interface DocumentShop {
  businessName: string | null;
  businessAddress: string | null;
  businessPhone: string | null;
  gstNumber: string | null;
  gstStateCode: string | null;
  gstRegistration: string;
  turnoverAboveFiveCrore: boolean;
  receiptFooter: string | null;
}

export interface DocumentCustomer {
  name: string | null;
  phone: string | null;
  gstNumber: string | null;
  address: string | null;
}

export interface DocumentOrderLine {
  description: string;
  quantity: number;
  /** What one piece was charged, after discount. */
  unitPrice: number;
  lineTotal: number;
  hsnCode: string | null;
  taxRateBps: number | null;
  taxableValue: number | null;
  cgst: number | null;
  sgst: number | null;
  igst: number | null;
}

export interface DocumentOrder {
  orderNumber: string;
  createdAt: Date;
  documentKind: DocumentKind | null;
  invoiceSeries: string | null;
  invoiceNumber: number | null;
  invoiceFinancialYear: string | null;
  placeOfSupplyStateCode: string | null;
  interState: boolean;
  roundOff: number;
  total: number;
  lines: DocumentOrderLine[];
}

export interface TaxDocumentLine {
  serial: number;
  description: string;
  hsn: string;
  quantity: number;
  unitPrice: number;
  taxableValue: number;
  ratePercent: number;
  cgst: number;
  sgst: number;
  igst: number;
  lineTotal: number;
}

export interface TaxDocument {
  kind: DocumentKind;
  /** "TAX INVOICE", "BILL OF SUPPLY", "RECEIPT" -- what gets printed at the top. */
  heading: string;
  /** CTR/2026-27/00001, or the order number when no invoice number was taken. */
  number: string;
  issuedAt: Date;
  shop: DocumentShop;
  customer: DocumentCustomer | null;
  placeOfSupply: string | null;
  interState: boolean;
  lines: TaxDocumentLine[];
  totals: {
    taxableValue: number;
    cgst: number;
    sgst: number;
    igst: number;
    totalTax: number;
    roundOff: number;
    payable: number;
  };
  /** A Bill of Supply must say this. Empty on the others. */
  declarations: string[];
  /** Missing things that make this document wrong, rather than merely plain. */
  problems: string[];
  footer: string | null;
}

const HEADINGS: Record<DocumentKind, string> = {
  TAX_INVOICE: 'TAX INVOICE',
  BILL_OF_SUPPLY: 'BILL OF SUPPLY',
  RECEIPT: 'RECEIPT'
};

const n = (v: number | null | undefined) => Number(v ?? 0);

export function buildDocument(
  order: DocumentOrder,
  shop: DocumentShop,
  customer: DocumentCustomer | null
): TaxDocument {
  // The kind fixed at sale time. An order from before that was stored (6 Oct 2026) follows the
  // shop's registration as it is now -- the only answer there is for it.
  const kind: DocumentKind = (order.documentKind as DocumentKind) ?? documentKindFor(registrationInForce(shop.gstRegistration, shop.gstNumber));
  const problems: string[] = [];

  /*
   * The number. An order that never took one falls back to its order number -- which is honest
   * for a draft or a shop that issues no invoices, and wrong for a tax invoice, so that case is
   * called out rather than papered over.
   */
  const number = order.invoiceNumber != null && order.invoiceSeries && order.invoiceFinancialYear
    ? formatInvoiceNumber(order.invoiceSeries, order.invoiceFinancialYear, order.invoiceNumber)
    : order.orderNumber;

  if (kind === 'TAX_INVOICE' && order.invoiceNumber == null) {
    problems.push('This sale has no invoice number. A tax invoice must carry one from an unbroken series.');
  }
  if (kind === 'TAX_INVOICE' && !shop.gstNumber) {
    problems.push('The shop has no GSTIN saved. A tax invoice must show it.');
  }

  const lines: TaxDocumentLine[] = order.lines.map((l, i) => {
    if (kind === 'TAX_INVOICE' && !l.hsnCode) {
      problems.push(`"${l.description}" has no HSN code. Every line of a tax invoice needs one.`);
    }
    return {
      serial: i + 1,
      description: l.description,
      hsn: l.hsnCode ? hsnForInvoice(l.hsnCode, shop.turnoverAboveFiveCrore) : '',
      quantity: l.quantity,
      unitPrice: n(l.unitPrice),
      taxableValue: n(l.taxableValue),
      ratePercent: (l.taxRateBps ?? 0) / 100,
      cgst: n(l.cgst),
      sgst: n(l.sgst),
      igst: n(l.igst),
      lineTotal: n(l.lineTotal)
    };
  });

  const sum = (pick: (l: TaxDocumentLine) => number) =>
    Math.round(lines.reduce((s, l) => s + pick(l), 0) * 100) / 100;

  const cgst = sum(l => l.cgst);
  const sgst = sum(l => l.sgst);
  const igst = sum(l => l.igst);

  /*
   * An inter-state sale of more than Rs 2.5 lakh to an unregistered customer must carry the
   * customer's address. Below that, or to a registered one, it need not.
   */
  const bigInterStateToUnregistered =
    order.interState && !customer?.gstNumber && n(order.total) > 250_000;
  if (bigInterStateToUnregistered && !customer?.address) {
    problems.push('An inter-state sale above Rs 2,50,000 to an unregistered customer must show their address.');
  }

  const declarations: string[] = [];
  if (kind === 'BILL_OF_SUPPLY') {
    // Required wording, not a nicety: this is what makes it a Bill of Supply rather than a
    // tax invoice with the tax left off.
    declarations.push('Composition taxable person, not eligible to collect tax on supplies.');
  }

  return {
    kind,
    heading: HEADINGS[kind],
    number,
    issuedAt: order.createdAt,
    shop,
    customer,
    placeOfSupply: order.placeOfSupplyStateCode ?? shop.gstStateCode,
    interState: order.interState,
    lines,
    totals: {
      taxableValue: sum(l => l.taxableValue),
      cgst, sgst, igst,
      totalTax: Math.round((cgst + sgst + igst) * 100) / 100,
      roundOff: n(order.roundOff),
      payable: n(order.total)
    },
    declarations,
    problems,
    footer: shop.receiptFooter
  };
}
