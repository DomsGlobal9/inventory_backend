import { prisma } from '../../lib/prisma';
import { conflict, notFound } from '../../utils/httpError';
import { getShopSettings } from '../../lib/clientSettings';
import { formatPhone } from '../../lib/phone';
import { salesOrderService } from '../sales-order.service';
import { dispatchService } from '../dispatch.service';
import { counterCustomer } from '../customer.service';
import { normaliseManualDiscount, toMinor } from '../pricing';
import { planPayments, paymentSummary, recordPayments } from '../payments';
import { checkSale, settleSale } from '../loyalty';
import { spendOnSale } from '../store-credit';
import { recordOffersConsent } from '../campaigns/consent';
import { afterCommit } from '../../lib/afterCommit';
import { sendAfterSaleNotice } from '../campaigns/notices';
import { CompleteSaleInput } from './counter-sale.schema';

/** Where a counter order came from, beside the sale id the screen made up. */
export const COUNTER_SOURCE = 'SCALEEZY_COUNTER';

export interface CounterCaller {
  userId: string | null;
  /** Holds offer:manual_discount_unlimited, or everything. */
  mayExceedManualLimit: boolean;
}

/** The quote's refusals -- gone, expired, changed, already spent: the screen re-prices and asks the cashier to check. */
function asPriceChanged(error: any) {
  if (error?.statusCode === 400 && typeof error.message === 'string' && /ask for it again|already been used/i.test(error.message)) {
    return Object.assign(conflict(`Prices have changed since this basket was priced. Check the bill and press Complete sale again.`), {
      details: { code: 'PRICE_CHANGED', reason: error.message }
    });
  }
  return error;
}

/** "variantId:qty" for each line, in a fixed order -- whether two baskets are the same basket. */
function basketKey(items: { variantId: string; quantity: number }[]) {
  return items.map(i => `${i.variantId}:${i.quantity}`).sort().join('|');
}

export class CounterSaleService {
  /**
   * Complete sale: the customer, the order, the goods going out and the money coming in, as one
   * thing.
   *
   * ONE TRANSACTION. A sale is all of those or none of them. Done as separate requests -- create the
   * order, confirm it, dispatch it, record the payment -- a dropped connection between any two left a
   * shop with stock held for a customer who had already walked out with it, or goods gone with no
   * money recorded. Here a failure anywhere leaves nothing: no order, no order number used, no
   * customer, no stock moved, no quote or offer use spent.
   *
   * Inside it, in this order:
   *   1. the customer (found by number under a lock, or created)
   *   2. the order, priced from the quote plus reasoned manual discounts under the till limit, its
   *      stock held at this store -- writeFullOrderInTransaction, the same code every order uses
   *   3. the payments checked against the bill it actually came to
   *   4. the goods sent out: stock off the shelf, the revenue row, the order DISPATCHED
   *   5. the payments written
   * Storefronts hear about the stock change only after it commits (lib/afterCommit).
   *
   * THE SAME SALE TWICE. The screen makes one sale id per basket. Pressing Complete twice, a retry
   * after a timeout, or two requests racing all find or become the one sale: the second gets the
   * first sale back, never a second order, a second stock movement or a second payment. The same id
   * with a different basket is refused -- that is a bug or a stale screen, and guessing which basket
   * was meant charges someone wrongly.
   */
  async completeSale(clientId: string, caller: CounterCaller, input: CompleteSaleInput) {
    const already = await this.findSale(clientId, input.saleId);
    if (already) return this.replay(clientId, already, input);

    // Checked before a transaction opens: "na" is not a reason, and that needs no database.
    const orderManual = normaliseManualDiscount(input.manualDiscount, 'this bill');
    // Loyalty's rules and the customer's points, read before the transaction opens (each read inside
    // it is another trip across regions with a transaction held open).
    const pointsPaidMinor = (input.payments ?? []).filter(p => p.method === 'POINTS').reduce((sum, p) => sum + toMinor(p.amount), 0);
    const [{ manualDiscountMaxPercent }, variants, loyaltyCheck] = await Promise.all([
      getShopSettings(clientId),
      prisma.productVariant.findMany({
        where: { id: { in: input.items.map(i => i.variantId) }, clientId },
        select: { id: true, product: { select: { title: true, status: true, trashedAt: true } } }
      }),
      // A new customer holds nothing; one chosen by id is checked here.
      checkSale(clientId, input.customer.id ?? null, null, pointsPaidMinor)
    ]);

    /*
     * A product retired, or moved to the bin, while it sat in an open basket. The quote was worked out
     * before that and would still price it; an order from Shopify for such a product must still be
     * recorded, so the order code does not refuse it. At the counter the shop has decided not to sell
     * it any more, and the cashier can take it off the bill.
     */
    for (const item of input.items) {
      const variant = variants.find(v => v.id === item.variantId);
      if (!variant) throw notFound('An item on this bill was not found. Take it off and scan it again.');
      if (variant.product.trashedAt || variant.product.status === 'ARCHIVED' || variant.product.status === 'TRASHED') {
        throw Object.assign(conflict(`${variant.product.title} is no longer sold. Take it off the bill.`), {
          details: { code: 'ITEM_RETIRED', variantId: variant.id }
        });
      }
    }

    try {
      const orderId = await prisma.$transaction(async (tx) => {
        const customer = await counterCustomer(tx as any, clientId, input.customer);

        const order: any = await salesOrderService.writeFullOrderInTransaction(
          tx, clientId, input.locationId,
          {
            customer: { id: customer.id, name: customer.name, phone: customer.phone },
            externalOrderId: input.saleId,
            sourceSystem: COUNTER_SOURCE,
            status: 'CONFIRMED',
            handover: 'TAKEN_NOW',
            quoteId: input.quoteId,
            couponCodes: input.couponCodes ?? [],
            manualDiscount: input.manualDiscount ?? null,
            items: input.items.map(i => ({ variantId: i.variantId, quantity: i.quantity, manualDiscount: i.manualDiscount ?? null }))
          },
          'POS',
          orderManual,
          {
            userId: caller.userId,
            manualLimitPercent: caller.mayExceedManualLimit ? null : manualDiscountMaxPercent,
            lean: true
          }
        );

        // Against the bill as it was actually priced and written, not the figure the screen showed.
        const planned = planPayments(toMinor(order.total), input.payments, 'FULL');

        await dispatchService.dispatchInTransaction(
          tx, clientId, order.id,
          order.items.map((item: any) => ({ salesOrderItemId: item.id, quantity: item.quantity }))
        );

        await recordPayments(tx, {
          clientId,
          salesOrderId: order.id,
          locationId: input.locationId,
          // Whoever the order records as ringing it up -- the same person, already checked to be
          // one of this shop's users.
          receivedById: order.createdById ?? null
        }, planned);

        // Points used on the bill are taken, and points earned given, in this same transaction: a
        // sale refused for points leaves nothing, and a sale that fails later takes no points.
        await settleSale(tx, {
          clientId,
          customerId: customer.id,
          orderId: order.id,
          billMinor: toMinor(order.total),
          pointsPaidMinor: planned.filter(p => p.method === 'POINTS').reduce((sum, p) => sum + p.amountMinor, 0),
          userId: caller.userId
        }, {
          settings: loyaltyCheck.settings,
          // Known only for a customer chosen by id; one found by number is read inside.
          held: input.customer.id && input.customer.id === customer.id ? loyaltyCheck.held : undefined
        });

        // Store credit spent on the bill, taken in the same transaction (refused if they hold less).
        await spendOnSale(tx, {
          clientId, customerId: customer.id, orderId: order.id, userId: caller.userId,
          paise: planned.filter(p => p.method === 'CREDIT').reduce((sum, p) => sum + p.amountMinor, 0)
        });

        // Only ever turned on here, when the cashier ticked that the customer agreed. Never off:
        // a counter screen without the tick is not the customer saying no.
        if (input.customer.offersOk) await recordOffersConsent(tx, clientId, customer.id, caller.userId);

        const saleId = order.id as string;
        afterCommit(() => { void sendAfterSaleNotice(clientId, saleId); });
        return saleId;
      }, { timeout: 30000, maxWait: 15000 });

      return { replayed: false, sale: await this.getSale(clientId, orderId) };
    } catch (error: any) {
      // Lost a race with the same sale id: the other request made the sale. That is the answer.
      const winner = await this.findSale(clientId, input.saleId).catch(() => null);
      if (winner) return this.replay(clientId, winner, input);
      throw asPriceChanged(error);
    }
  }

  private findSale(clientId: string, saleId: string) {
    return prisma.salesOrder.findFirst({
      where: { clientId, externalOrderId: saleId, sourceSystem: COUNTER_SOURCE },
      select: { id: true, orderNumber: true, items: { select: { variantId: true, quantity: true } } }
    });
  }

  private async replay(clientId: string, existing: { id: string; orderNumber: string; items: { variantId: string; quantity: number }[] }, input: CompleteSaleInput) {
    if (basketKey(existing.items) !== basketKey(input.items)) {
      throw Object.assign(
        conflict(`This sale was already completed as ${existing.orderNumber}. Start a new sale for a different basket.`),
        { details: { code: 'SALE_ALREADY_COMPLETED', orderId: existing.id, orderNumber: existing.orderNumber } }
      );
    }
    return { replayed: true, sale: await this.getSale(clientId, existing.id) };
  }

  /**
   * One sale as a receipt reads it: the shop, the store, who sold it, each line with what came off
   * it, and every payment. Never what the shop paid -- a receipt is handed to the customer, and the
   * screen that shows it is open to a salesperson.
   */
  async getSale(clientId: string, orderId: string) {
    /*
     * Side by side, not one nested read. Prisma answers a nested select one relation at a time, and
     * each is a round trip to a database on another continent: read as one tree this was eleven
     * trips one after another, over a second added to every sale. As five reads started together it
     * costs the longest of them. Every one is scoped to this shop, so an order id from another shop
     * finds nothing in any of them.
     */
    const ofThisOrder = { salesOrderId: orderId, salesOrder: { clientId, deletedAt: null } };
    const [order, items, discounts, payments, shop] = await Promise.all([
      prisma.salesOrder.findFirst({
        where: { id: orderId, clientId, deletedAt: null },
        select: {
          id: true, orderNumber: true, status: true, channel: true, handover: true, sourceSystem: true,
          createdAt: true, subtotal: true, discountAmount: true, taxAmount: true, shippingAmount: true, total: true,
          customerName: true, customerPhone: true,
          customer: { select: { id: true, name: true, customerCode: true, phone: true } },
          location: { select: { id: true, name: true, address: true, phone: true } },
          createdBy: { select: { id: true, name: true } }
        }
      }),
      prisma.salesOrderItem.findMany({
        where: ofThisOrder,
        orderBy: { createdAt: 'asc' },
        select: {
          id: true, variantId: true, quantity: true, fulfilledQty: true,
          listUnitPrice: true, lineDiscount: true, allocatedDiscount: true, unitPrice: true, totalPrice: true, priceSource: true,
          variant: { select: { sku: true, colorName: true, size: true, product: { select: { title: true } } } },
          discountAllocations: { select: { amount: true, salesOrderDiscount: { select: { title: true, source: true } } } }
        }
      }),
      prisma.salesOrderDiscount.findMany({ where: ofThisOrder, select: { id: true, source: true, title: true, amount: true, code: true } }),
      prisma.salesOrderPayment.findMany({
        where: { salesOrderId: orderId, clientId },
        orderBy: { receivedAt: 'asc' },
        select: {
          id: true, kind: true, method: true, amount: true, cashReceived: true, changeGiven: true,
          reference: true, receivedAt: true, receivedBy: { select: { name: true } }
        }
      }),
      prisma.clientSettings.findUnique({
        where: { clientId },
        select: { businessName: true, logoUrl: true, businessAddress: true, businessPhone: true, businessEmail: true, gstNumber: true, receiptFooter: true }
      })
    ]);
    if (!order) throw notFound('Order not found');

    const n = (v: any) => (v === null || v === undefined ? null : Number(v));
    const phone = order.customer?.phone ?? order.customerPhone ?? null;

    return {
      id: order.id,
      orderNumber: order.orderNumber,
      status: order.status,
      channel: order.channel,
      handover: order.handover,
      atCounter: order.sourceSystem === COUNTER_SOURCE,
      createdAt: order.createdAt,
      soldBy: order.createdBy?.name ?? null,
      store: order.location,
      customer: {
        id: order.customer?.id ?? null,
        name: order.customer?.name ?? order.customerName ?? null,
        code: order.customer?.customerCode ?? null,
        phone: phone ? formatPhone(phone) : null,
        // The receipt goes home with the customer, and may be left on the counter.
        phoneMasked: phone ? `••••${phone.slice(-4)}` : null
      },
      items: items.map(item => ({
        id: item.id,
        variantId: item.variantId,
        title: item.variant.product.title,
        sku: item.variant.sku,
        colorName: item.variant.colorName,
        size: item.variant.size,
        quantity: item.quantity,
        fulfilledQty: item.fulfilledQty,
        listUnitPrice: n(item.listUnitPrice),
        lineDiscount: n(item.lineDiscount),
        allocatedDiscount: n(item.allocatedDiscount),
        unitPrice: n(item.unitPrice),
        totalPrice: n(item.totalPrice),
        priceSource: item.priceSource,
        discounts: item.discountAllocations.map(a => ({
          title: a.salesOrderDiscount.title, source: a.salesOrderDiscount.source, amount: n(a.amount)
        }))
      })),
      discounts: discounts.map(d => ({ ...d, amount: n(d.amount) })),
      subtotal: n(order.subtotal),
      discountAmount: n(order.discountAmount),
      taxAmount: n(order.taxAmount),
      shippingAmount: n(order.shippingAmount),
      total: n(order.total),
      payments: payments.map(p => ({
        id: p.id, kind: p.kind, method: p.method, amount: n(p.amount),
        cashReceived: n(p.cashReceived), changeGiven: n(p.changeGiven),
        reference: p.reference, receivedAt: p.receivedAt, receivedBy: p.receivedBy?.name ?? null
      })),
      payment: paymentSummary(toMinor(order.total), payments),
      shop: {
        name: shop?.businessName ?? null,
        logoUrl: shop?.logoUrl ?? null,
        // The store's own address and phone first; the shop's letterhead when the store has none.
        address: order.location.address || shop?.businessAddress || null,
        phone: order.location.phone || shop?.businessPhone || null,
        email: shop?.businessEmail ?? null,
        gstNumber: shop?.gstNumber ?? null,
        receiptFooter: shop?.receiptFooter ?? null
      }
    };
  }
}

export const counterSaleService = new CounterSaleService();
