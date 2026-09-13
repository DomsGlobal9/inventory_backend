import { prisma } from '../lib/prisma';
import { generateSequentialCode } from '../utils/codeGenerator';
import { validateTransition } from '../utils/sales-order-state-machine';
import { reservationService } from './reservation.service';
import { resolveVariantForLocation } from '../utils/variant-location';
import { notFound, badRequest, conflict, forbidden } from '../utils/httpError';
import {
  toMinor, fromMinor, netUnitPrice, allocate,
  priceLine, allocateOrderDiscount, orderTotalsFrom, PricedLine,
  fingerprint, pricedLinesFromQuote, pricingQuoteService,
  normaliseManualDiscount, ManualDiscount
} from './pricing';
import { offerRedemptionService } from './offers';
import { getShopSettings } from '../lib/clientSettings';

export class SalesOrderService {
  async createDraftOrder(clientId: string, locationId: string, customerId: string, channel: any = 'POS') {
    const orderNumber = await generateSequentialCode(clientId, 'SO', 'SALES_ORDER');
    return prisma.salesOrder.create({
      data: {
        clientId,
        locationId,
        channel,
        orderNumber,
        customerId,
        status: 'DRAFT',
        subtotal: 0,
        total: 0
      }
    });
  }

  /**
   * `caller` is who is placing the order, when a person is. The till limit on manual discounts
   * applies to people; a system writing an order it received (Shopify) passes nothing.
   */
  async createFullOrder(
    clientId: string, locationId: string, data: any, channel: any = 'POS',
    caller?: { userId?: string | null; mayExceedManualLimit?: boolean }
  ) {
    // 1. Idempotency Check
    if (data.externalOrderId && data.sourceSystem) {
      const existingOrder = await prisma.salesOrder.findFirst({
        where: {
          clientId,
          externalOrderId: data.externalOrderId,
          sourceSystem: data.sourceSystem
        },
        include: { items: true, customer: true, discounts: true }
      });
      if (existingOrder) {
        return existingOrder; // Idempotent return
      }
    }

    /*
     * A person taking money off by hand, checked before a transaction is ever opened.
     *
     * The route has already refused a caller who lacks `offer:manual_discount`; this is the
     * other half -- whether what they sent is a discount a shop could defend afterwards. See
     * services/pricing/manualDiscount.ts for why the reason is required and why "na" is not one.
     */
    const orderManual = normaliseManualDiscount(data.manualDiscount, 'this order');

    /*
     * Two ways of saying the same thing, sent together.
     *
     * `discountAmount` is the total the CALLER decided -- a Shopify order arrives with one.
     * `manualDiscount` is a decision made here, at this till, now. An order carrying both has no
     * answer to whether the manual amount is already inside the total, and picking either
     * reading charges somebody an amount nobody can account for. Refused, rather than guessed.
     */
    if (orderManual && Number(data.discountAmount ?? 0) > 0) {
      throw badRequest(
        'This order already carries a discount total, so a second one cannot be typed on top ' +
        'of it. Send the order discount or the manual one, not both.'
      );
    }

    const orderNumber = await generateSequentialCode(clientId, 'SO', 'SALES_ORDER');

    try {
      const { manualDiscountMaxPercent } = await getShopSettings(clientId);
      const manualLimit = caller && !caller.mayExceedManualLimit ? manualDiscountMaxPercent : null;
      return await this.writeFullOrder(
        clientId, locationId, data, channel, orderNumber, orderManual,
        { userId: caller?.userId ?? null, manualLimitPercent: manualLimit }
      );
    } catch (error: any) {
      /*
       * The same order, sent twice at the same moment.
       *
       * A till that times out and retries, or a website that fires its checkout twice, sends two
       * requests carrying one (externalOrderId, sourceSystem). Both pass the check at the top of
       * this method; the unique key lets exactly one write. The loser used to receive the database's
       * refusal as an error -- so the till told the cashier the sale had FAILED when it had in fact
       * gone through, and the cashier rang it up again.
       *
       * It is not only the unique key that can refuse the loser. With a quote, the loser usually
       * fails a step earlier -- "that price has already been used" -- because the winner spent it.
       * So the test is not the error's code but the fact: the check at the top found no such order,
       * and now there is one. Something placed it in between, and it was this same request.
       *
       * The answer to "place this order" when it is already placed is the order.
       */
      if (data.externalOrderId && data.sourceSystem) {
        const winner = await prisma.salesOrder.findFirst({
          where: { clientId, externalOrderId: data.externalOrderId, sourceSystem: data.sourceSystem },
          include: { items: true, customer: true, discounts: true }
        });
        if (winner) return winner;
      }
      throw error;
    }
  }

  private async writeFullOrder(
    clientId: string, locationId: string, data: any, channel: any,
    orderNumber: string, orderManual: ManualDiscount | null,
    who: { userId: string | null; manualLimitPercent: number | null } = { userId: null, manualLimitPercent: null }
  ) {
    /*
     * The till limit.
     *
     * "Up to 10% by hand; more needs a manager." Measured against what the discount comes off --
     * the line as it stood, or the bill after line discounts -- because 500 off a 50,000 lehenga
     * and 500 off a 900 blouse are not the same decision.
     */
    const overLimit = (amountMinor: number, ofMinor: number, label: string) => {
      if (who.manualLimitPercent == null || ofMinor <= 0) return;
      if (amountMinor * 100 > ofMinor * who.manualLimitPercent + 1e-6) {
        const pct = Math.round((amountMinor / ofMinor) * 1000) / 10;
        throw forbidden(
          `Taking ${amountMinor / 100} off ${label} is ${pct}% -- more than the ${who.manualLimitPercent}% ` +
          `the till may take off by hand. A manager has to take this one off.`
        );
      }
    };

    return prisma.$transaction(async (tx) => {
      let customerId = data.customer?.id;
      
      // If external customer ID provided, sync/find the customer
      if (data.customer?.externalId) {
        let existingCustomer = await tx.customer.findFirst({
          where: { clientId, externalCustomerId: data.customer.externalId }
        });
        
        if (!existingCustomer) {
          const customerCode = await generateSequentialCode(clientId, 'CUS', 'CUSTOMER', tx as any);
          existingCustomer = await tx.customer.create({
            data: {
              clientId,
              customerCode,
              externalCustomerId: data.customer.externalId,
              name: data.customer.name || 'Unknown',
              phone: data.customer.phone || null,
              email: data.customer.email || null,
              billingAddress: data.customer.billingAddress || null,
              shippingAddress: data.customer.shippingAddress || null,
              status: 'ACTIVE'
            }
          });
        }
        customerId = existingCustomer.id;
      } else if (!customerId) {
        throw new Error('Customer information or external ID is required');
      }

      const order = await tx.salesOrder.create({
        data: {
          clientId,
          locationId,
          channel,
          orderNumber,
          customerId,
          externalOrderId: data.externalOrderId || null,
          sourceSystem: data.sourceSystem || null,
          customerName: data.customer?.name || null,
          customerPhone: data.customer?.phone || null,
          shippingAddress: data.customer?.shippingAddress || null,
          billingAddress: data.customer?.billingAddress || null,
          status: 'DRAFT',
          subtotal: 0,
          total: 0,
          taxAmount: data.taxAmount || 0,
          discountAmount: data.discountAmount || 0,
          shippingAmount: data.shippingAmount || 0,
        }
      });

      /*
       * The quote, if the caller was given one.
       *
       * Claimed HERE, inside the same transaction that writes the order, and not a moment
       * earlier. Claimed outside it, an order that then fails to reserve stock would leave a
       * quote spent on an order that does not exist -- and the customer could not check out
       * again at the price they were shown.
       *
       * The fingerprint is recomputed from the items that actually arrived, so a basket that
       * changed between being priced and being ordered is refused rather than given the old
       * price. That is the whole reason the fingerprint is stored.
       */
      let quoted: ReturnType<typeof pricedLinesFromQuote> | null = null;
      if (data.quoteId) {
        const expected = fingerprint({
          locationId,
          channel,
          lines: data.items.map((i: any) => ({ variantId: i.variantId, quantity: i.quantity })),
          couponCodes: data.couponCodes ?? []
        });
        const quote = await pricingQuoteService.consume(
          clientId, data.quoteId, order.id, expected, tx, customerId
        );
        quoted = pricedLinesFromQuote(quote.result);
      }

      /*
       * Price every line BEFORE writing any of them.
       *
       * The loop used to create each row as it went and accumulate a subtotal. It cannot any
       * more: an order-level discount has to be divided between the lines, and you cannot divide
       * something between lines you have not finished counting. So this is two passes -- resolve
       * and price, then allocate, then write.
       */
      const resolved: {
        item: any; unitCostMinor: number; priced: PricedLine;
        manual: ManualDiscount | null; orderItemId?: string;
      }[] = [];

      for (const item of data.items) {
        const variant = await tx.productVariant.findFirst({
          where: { id: item.variantId, clientId },
          include: { locationProfiles: true, product: { select: { basePrice: true } } }
        });
        if (!variant) throw notFound(`Variant not found: ${item.variantId}`);

        const locationConfig = resolveVariantForLocation(variant, locationId, Number(variant.product.basePrice));

        if (!locationConfig.isAvailable) {
          throw new Error(`Variant ${variant.sku} is not available for sale at this location`);
        }

        // Checked here rather than before the transaction so the message can name the SKU. A
        // cashier reading "say why money is coming off item 2" has to count down the screen.
        const manual = normaliseManualDiscount(item.manualDiscount, variant.sku);

        let priced: PricedLine;

        if (quoted) {
          /*
           * A quoted line is taken EXACTLY as quoted. Not re-priced, not checked against the
           * catalogue, not adjusted because an offer has since ended -- that is what freezing
           * means, and re-deriving it here would put the midnight bug straight back.
           */
          const line = quoted.byVariant.get(item.variantId);
          if (!line) {
            throw badRequest(
              `${variant.sku} was not in the basket that was priced. Ask for the price again.`
            );
          }
          if (line.quantity !== item.quantity) {
            throw badRequest(
              `${variant.sku} was priced for ${line.quantity} and this order has ` +
              `${item.quantity}. Ask for the price again.`
            );
          }
          priced = {
            quantity: item.quantity,
            listUnitPriceMinor: line.listUnitPriceMinor,
            lineDiscountMinor: line.discountMinor,
            allocatedDiscountMinor: 0,
            totalPriceMinor: line.lineTotalMinor,
            unitPriceMinor: netUnitPrice(line.lineTotalMinor, item.quantity),
            priceSource: 'QUOTE'
          };
        } else {
          // The caller's prices win where it gave any, and our catalogue fills in where it did
          // not. Which is the whole point of this release: a till or a website that has already
          // charged somebody is telling us what was charged, not asking what it should be.
          priced = priceLine(
            item.quantity,
            toMinor(locationConfig.price || 0),
            item,
            variant.sku
          );
        }

        if (manual) {
          overLimit(manual.amountMinor, priced.totalPriceMinor, variant.sku);
          // On top of whatever the line already costs -- an offer and a goodwill gesture are two
          // separate decisions, and both are real.
          if (manual.amountMinor > priced.totalPriceMinor) {
            throw badRequest(
              `Taking ${manual.amountMinor / 100} off ${variant.sku} would leave it worth less ` +
              `than nothing. The line is ${priced.totalPriceMinor / 100}.`
            );
          }
          priced.lineDiscountMinor += manual.amountMinor;
          priced.totalPriceMinor -= manual.amountMinor;
          priced.unitPriceMinor = netUnitPrice(priced.totalPriceMinor, priced.quantity);
          // The price on this row was decided by a person, and the row now says so. Which line
          // was overridden by hand is a question a shop asks, and inferring it from the presence
          // of a discount cannot tell a markdown from an offer.
          priced.priceSource = 'MANUAL';
        }

        resolved.push({
          item,
          unitCostMinor: toMinor(variant.averageCost),
          priced,
          manual
        });
      }

      const pricedLines = resolved.map(r => r.priced);

      /*
       * How an order-level discount is divided, captured BEFORE it is applied.
       *
       * `allocateOrderDiscount` rewrites the line totals, so weights taken afterwards would be
       * the weights of already-discounted lines. The manual share needs the same weights the
       * allocation itself used, or the rows recording where the manual money went would not add
       * up to the manual discount.
       */
      const weights = pricedLines.map(l => l.listUnitPriceMinor * l.quantity - l.lineDiscountMinor);

      const manualOrderMinor = orderManual?.amountMinor ?? 0;
      if (orderManual) overLimit(manualOrderMinor, weights.reduce((s, w) => s + w, 0), 'this order');

      /*
       * And the two together. Each check above measures one decision against what it came off, so
       * 10% off every line and then 10% off the bill passed both -- 19% by hand on a 10% till. What
       * the limit means is how much a person took off this order, measured against the order as it
       * stood before anybody took anything off by hand.
       */
      const manualLinesMinor = resolved.reduce((s, r) => s + (r.manual?.amountMinor ?? 0), 0);
      if (orderManual && manualLinesMinor > 0) {
        const beforeManual = resolved.reduce((s, r) => s + r.priced.totalPriceMinor + (r.manual?.amountMinor ?? 0), 0);
        overLimit(manualLinesMinor + manualOrderMinor, beforeManual, 'this order in all');
      }
      allocateOrderDiscount(
        pricedLines,
        this.orderLevelDiscountMinor(data.discountAmount, pricedLines) + manualOrderMinor
      );

      const manualShares = manualOrderMinor > 0 ? allocate(manualOrderMinor, weights) : [];

      const reservationItems = [];

      for (const entry of resolved) {
        const { item, unitCostMinor, priced } = entry;
        const totalCostMinor = unitCostMinor * priced.quantity;

        const orderItem = await tx.salesOrderItem.create({
          data: {
            salesOrderId: order.id,
            variantId: item.variantId,
            quantity: priced.quantity,
            listUnitPrice: fromMinor(priced.listUnitPriceMinor),
            lineDiscount: fromMinor(priced.lineDiscountMinor),
            allocatedDiscount: fromMinor(priced.allocatedDiscountMinor),
            unitPrice: fromMinor(priced.unitPriceMinor),
            unitCost: fromMinor(unitCostMinor),
            totalPrice: fromMinor(priced.totalPriceMinor),
            totalCost: fromMinor(totalCostMinor),
            // Against the NET total. This is the line the whole change exists for: a saree sold
            // at ₹9,600 after ₹2,400 off used to report the margin of a ₹12,000 sale.
            grossProfit: fromMinor(priced.totalPriceMinor - totalCostMinor),
            priceSource: priced.priceSource
          }
        });

        entry.orderItemId = orderItem.id;

        reservationItems.push({
          variantId: item.variantId,
          salesOrderItemId: orderItem.id,
          quantity: priced.quantity
        });
      }

      /*
       * WHY the money came off, beside WHAT came off.
       *
       * The line columns say a saree was sold at 9,600 instead of 12,000. They cannot say it was
       * the Deepavali offer, or a manager's decision about a marked hem. Six months later that is
       * the only question anybody asks about a discount, and a row that cannot answer it is the
       * reason shops keep a paper book beside the till.
       *
       * The shape is Shopify's -- a discount, and its allocations across the lines -- chosen
       * deliberately so an order we ingest from Shopify and an order we priced ourselves can be
       * read by the same report.
       */
      const writeDiscount = async (
        input: {
          source: 'OFFER' | 'MANUAL';
          title: string;
          amountMinor: number;
          offerId?: string | null;
          offerVersionId?: string | null;
          code?: string | null;
          appliedBy?: string | null;
          shares: { orderItemId: string; amountMinor: number }[];
        }
      ) => {
        if (input.amountMinor <= 0) return;
        const row = await tx.salesOrderDiscount.create({
          data: {
            salesOrderId: order.id,
            offerId: input.offerId ?? null,
            offerVersionId: input.offerVersionId ?? null,
            source: input.source,
            title: input.title,
            amount: fromMinor(input.amountMinor),
            code: input.code ?? null,
            appliedBy: input.appliedBy ?? null
          }
        });
        for (const share of input.shares) {
          if (share.amountMinor <= 0) continue;
          await tx.salesOrderItemDiscount.create({
            data: {
              salesOrderItemId: share.orderItemId,
              salesOrderDiscountId: row.id,
              amount: fromMinor(share.amountMinor)
            }
          });
        }
      };

      if (quoted) {
        for (const discount of quoted.discounts) {
          await writeDiscount({
            source: 'OFFER',
            title: discount.title,
            amountMinor: discount.amountMinor,
            offerId: discount.offerId,
            offerVersionId: discount.offerVersionId,
            code: discount.code,
            // Taken from what the engine actually did to each line, not re-divided here. Two
            // allocations of the same total by two different pieces of code is how the parts
            // stop adding up to the whole.
            shares: resolved.map(r => ({
              orderItemId: r.orderItemId!,
              amountMinor: (quoted!.byVariant.get(r.item.variantId)?.appliedOffers ?? [])
                .filter(a => a.offerId === discount.offerId)
                .reduce((sum, a) => sum + a.amountMinor, 0)
            }))
          });
        }
      }

      // A person's decision on one line. Its own row, with the reason as its title, because the
      // reason IS the record -- "200 off" six months later with nothing beside it is
      // indistinguishable from theft.
      for (const entry of resolved) {
        if (!entry.manual) continue;
        await writeDiscount({
          source: 'MANUAL',
          title: entry.manual.reason,
          appliedBy: who.userId,
          amountMinor: entry.manual.amountMinor,
          shares: [{ orderItemId: entry.orderItemId!, amountMinor: entry.manual.amountMinor }]
        });
      }

      if (orderManual) {
        await writeDiscount({
          source: 'MANUAL',
          title: orderManual.reason,
          appliedBy: who.userId,
          amountMinor: orderManual.amountMinor,
          shares: resolved.map((r, index) => ({
            orderItemId: r.orderItemId!,
            amountMinor: manualShares[index] ?? 0
          }))
        });
      }

      /*
       * Spend the offers' allowances.
       *
       * Inside this transaction, after the order exists and before anything is returned. Outside
       * it, two simultaneous checkouts both pass a "one use left" check and a shop that
       * advertised fifty serves fifty-one. If an allowance has run out between the quote and
       * now, this throws and the whole order rolls back -- which is the right answer even though
       * it is an unhappy one.
       */
      if (quoted && quoted.discounts.length > 0) {
        await offerRedemptionService.record(
          tx,
          { clientId, salesOrderId: order.id, customerId },
          quoted.discounts.map(d => ({
            offerId: d.offerId,
            offerVersionId: d.offerVersionId,
            amountMinor: d.amountMinor,
            code: d.code
          }))
        );
      }

      const totals = orderTotalsFrom(
        pricedLines,
        toMinor(order.taxAmount),
        toMinor(order.shippingAmount)
      );

      const updatedOrder = await tx.salesOrder.update({
        where: { id: order.id },
        data: {
          subtotal: fromMinor(totals.subtotalMinor),
          // Re-stated from the lines rather than left as the caller sent it. For an order with
          // only an order-level discount the two are identical; for one carrying per-line
          // discounts this is what makes the order's figure and its lines agree.
          discountAmount: fromMinor(totals.discountMinor),
          total: fromMinor(totals.totalMinor),
          status: data.status === 'CONFIRMED' ? 'CONFIRMED' : 'DRAFT'
        },
        include: { items: true, customer: true, discounts: true }
      });

      if (data.status === 'CONFIRMED' && reservationItems.length > 0) {
        await reservationService.reserveStock(clientId, locationId, reservationItems, tx);
      }

      return updatedOrder;
    }, { timeout: 30000 });
    // No custom timeout previously — Prisma's 5000ms default was too short for the
    // per-item loop above (2 round-trips per item) under this environment's DB
    // latency, and failed with "Transaction not found" once the connection was
    // reclaimed mid-transaction. Same fix already applied to the other multi-step
    // transactions in inventory-mutation.service.ts / purchase-order.service.ts / etc.
  }

  async getOrders(clientId: string, filters: any = {}) {
    const where: any = { clientId, deletedAt: null };
    if (filters.status) where.status = filters.status;

    return prisma.salesOrder.findMany({
      where,
      include: {
        customer: {
          select: { name: true, companyName: true, email: true }
        },
        items: true
      },
      orderBy: { createdAt: 'desc' }
    });
  }

  async getOrderById(clientId: string, id: string) {
    const order = await prisma.salesOrder.findFirst({
      where: { clientId, id, deletedAt: null },
      include: {
        customer: true,
        items: {
          include: {
            variant: {
              include: { product: true }
            }
          }
        },
        /*
         * Why the money came off, not only that it did.
         *
         * The order screen could always show that a line was discounted; it could not show
         * whether that was the Deepavali offer or somebody's decision about a marked hem. For a
         * manual discount the title IS the reason that was typed, which is the only record of
         * it -- so it has to reach the screen or it may as well not have been required.
         */
        discounts: {
          include: { allocations: true },
          orderBy: { createdAt: 'asc' }
        }
      }
    });
    if (!order) throw notFound('Order not found');
    return order;
  }

  async updateOrder(clientId: string, id: string, data: any) {
    // Basic update for shipping, discount, tax (for Draft orders)
    const order = await prisma.salesOrder.findFirst({ where: { clientId, id } });
    if (!order) throw notFound('Order not found');
    
    // We don't use state machine here because status isn't changing, but we enforce DRAFT
    if (order.status !== 'DRAFT') throw new Error('Can only update DRAFT orders');

    const updated = await prisma.salesOrder.update({
      where: { id },
      data: {
        discountAmount: data.discountAmount ?? order.discountAmount,
        taxAmount: data.taxAmount ?? order.taxAmount,
        shippingAmount: data.shippingAmount ?? order.shippingAmount,
      }
    });

    return this.recalculateOrderTotals(clientId, id);
  }

  async deleteOrder(clientId: string, id: string) {
    const order = await prisma.salesOrder.findFirst({ where: { clientId, id, deletedAt: null } });
    if (!order) throw notFound('Order not found');
    if (order.status !== 'DRAFT') throw new Error('Can only delete DRAFT orders');
    /*
     * A draft can already have spent offers: an order placed as a draft with a quote claims its
     * allowances and single-use codes at once. Deleting it without giving them back left the card
     * in the customer's hand dead for good and a "first 50" offer one short -- and nothing could
     * release them later, because a deleted order can no longer be found to cancel.
     */
    return prisma.$transaction(async (tx) => {
      const gone = await tx.salesOrder.updateMany({
        where: { id, clientId, status: 'DRAFT', deletedAt: null },
        data: { deletedAt: new Date() }
      });
      if (gone.count === 0) throw conflict('This order changed while it was being deleted. Open it again and check.');
      await offerRedemptionService.release(tx, clientId, id, `Draft order ${order.orderNumber} deleted`);
      return tx.salesOrder.findFirstOrThrow({ where: { id, clientId } });
    }, { timeout: 30000 });
  }

  async addOrderItem(clientId: string, orderId: string, variantId: string, quantity: number) {
    return prisma.$transaction(async (tx) => {
      const order = await tx.salesOrder.findFirst({ where: { id: orderId, clientId, deletedAt: null } });
      if (!order || order.status !== 'DRAFT') throw new Error('Cannot add items to non-DRAFT order');

      // Same location-aware price + availability resolution as createFullOrder -- this
      // path used to skip both entirely (flat `variant.sellingPrice` with a silent ₹0
      // fallback, no per-location override, no availability check), so the same item
      // could price differently depending on which of the two endpoints added it.
      const variant = await tx.productVariant.findFirst({
        where: { id: variantId, clientId },
        include: { locationProfiles: true, product: { select: { basePrice: true } } }
      });
      if (!variant) throw notFound('Variant not found');

      const locationConfig = resolveVariantForLocation(variant, order.locationId, Number(variant.product.basePrice));
      if (!locationConfig.isAvailable) {
        throw new Error(`Variant ${variant.sku} is not available for sale at this location`);
      }

      const unitPriceMinor = toMinor(locationConfig.price || 0);
      const unitCostMinor = toMinor(variant.averageCost);
      const totalPriceMinor = unitPriceMinor * quantity;
      const totalCostMinor = unitCostMinor * quantity;

      const item = await tx.salesOrderItem.create({
        data: {
          salesOrderId: orderId,
          variantId,
          quantity,
          // Added one at a time from inside the app, so there is no external price to honour
          // and no line discount: this is the catalogue path, unchanged in substance.
          listUnitPrice: fromMinor(unitPriceMinor),
          lineDiscount: fromMinor(0),
          allocatedDiscount: fromMinor(0),
          unitPrice: fromMinor(unitPriceMinor),
          unitCost: fromMinor(unitCostMinor),
          totalPrice: fromMinor(totalPriceMinor),
          totalCost: fromMinor(totalCostMinor),
          grossProfit: fromMinor(totalPriceMinor - totalCostMinor),
          priceSource: 'CATALOGUE'
        }
      });

      // Any order-level discount already typed against this draft is spread again across the
      // new set of lines, including this one. Without that, adding a fourth item to a
      // three-line order left the discount attributed entirely to the original three.
      await this.recalculateOrderTotals(clientId, orderId, tx);
      return item;
    }, { timeout: 30000 });
  }

  async removeOrderItem(clientId: string, orderId: string, itemId: string) {
    return prisma.$transaction(async (tx) => {
      const order = await tx.salesOrder.findFirst({ where: { id: orderId, clientId, deletedAt: null } });
      if (!order || order.status !== 'DRAFT') throw new Error('Cannot remove items from non-DRAFT order');

      // Scope the delete to THIS order. `id` alone is globally unique, so an itemId
      // belonging to a different order -- including another tenant's -- was accepted and
      // destroyed, while this order's totals were then recalculated as if nothing changed.
      const deleted = await tx.salesOrderItem.deleteMany({
        where: { id: itemId, salesOrderId: orderId }
      });
      if (deleted.count === 0) throw notFound('Order item not found on this order');

      await this.recalculateOrderTotals(clientId, orderId, tx);
    }, { timeout: 30000 });
  }

  /**
   * How much of an order's stated discount is NOT already attributed to a particular line.
   *
   * `SalesOrder.discountAmount` means the total taken off the order. A caller may express that
   * either way round -- Shopify sends per-line allocations AND their sum, a till sends one
   * figure for the basket -- so the order-level part is the difference, and a stated total
   * SMALLER than the lines it contains is a contradiction rather than a negative top-up.
   */
  private orderLevelDiscountMinor(declared: any, lines: PricedLine[]): number {
    if (declared === null || declared === undefined) return 0;

    const declaredMinor = toMinor(declared);
    const lineSumMinor = lines.reduce((sum, l) => sum + l.lineDiscountMinor, 0);

    if (declaredMinor < lineSumMinor) {
      throw badRequest(
        `This order says ${declaredMinor / 100} was taken off, but its lines already account ` +
        `for ${lineSumMinor / 100}.`
      );
    }
    return declaredMinor - lineSumMinor;
  }

  /**
   * Re-derive an order's money from its lines.
   *
   * Three things changed here, and the third is the one that matters:
   *
   *  - `subtotal` is the sum of LIST prices, not net ones. It has always been the gross figure
   *    -- `total = subtotal - discount + tax + shipping` only works if it is -- and now that a
   *    line's `totalPrice` is net, summing that instead would have subtracted every discount
   *    twice.
   *  - `discountAmount` is now written, not just read. It is the sum of what the lines carry, so
   *    an order and its own lines can no longer disagree about how much came off.
   *  - the order-level discount is re-allocated across whatever lines exist NOW. Adding or
   *    removing an item after a discount was typed used to leave the discount attributed to the
   *    old set of lines, which is how a removed line could take its share of the discount with
   *    it and quietly raise the total.
   *
   * Idempotent, which it has to be -- this runs after every item add, every item removal and
   * every draft edit. The order-level part is recovered as
   * `order.discountAmount - sum(lineDiscount)`, which after a previous run reproduces exactly
   * the figure that run used.
   */
  private async recalculateOrderTotals(clientId: string, orderId: string, transactionClient: any = prisma) {
    const items = await transactionClient.salesOrderItem.findMany({
      where: { salesOrderId: orderId },
      orderBy: { createdAt: 'asc' }
    });
    const order = await transactionClient.salesOrder.findUnique({ where: { id: orderId } });

    // An order with nothing on it. Its discount is left exactly as the merchant typed it rather
    // than derived down to zero: a draft whose last line was removed while they reconsider must
    // still have its discount there when they add the next one.
    if (items.length === 0) {
      return transactionClient.salesOrder.update({
        where: { id: orderId },
        data: {
          subtotal: fromMinor(0),
          total: fromMinor(
            toMinor(order.taxAmount) + toMinor(order.shippingAmount) - toMinor(order.discountAmount)
          )
        }
      });
    }

    const lines: PricedLine[] = items.map((item: any) => {
      const listUnitPriceMinor = toMinor(item.listUnitPrice);
      const lineDiscountMinor = toMinor(item.lineDiscount);
      return {
        quantity: item.quantity,
        listUnitPriceMinor,
        lineDiscountMinor,
        allocatedDiscountMinor: 0,
        totalPriceMinor: listUnitPriceMinor * item.quantity - lineDiscountMinor,
        unitPriceMinor: 0,
        priceSource: item.priceSource
      };
    });

    allocateOrderDiscount(
      lines,
      this.orderLevelDiscountMinor(order.discountAmount, lines),
      // Clamped, not refused: this runs in reaction to an edit the merchant has already made,
      // and refusing here would leave them unable to remove a line. See allocateOrderDiscount.
      { clamp: true }
    );

    // Write back only the lines whose share actually moved. An order being edited has one line
    // changing and the rest standing still; updating all of them makes the row versions churn
    // for no reason and turns a two-item edit into forty writes on a large order.
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const line = lines[i];
      const totalCostMinor = toMinor(item.unitCost) * item.quantity;

      const unchanged =
        toMinor(item.allocatedDiscount) === line.allocatedDiscountMinor &&
        toMinor(item.totalPrice) === line.totalPriceMinor;
      if (unchanged) continue;

      await transactionClient.salesOrderItem.update({
        where: { id: item.id },
        data: {
          allocatedDiscount: fromMinor(line.allocatedDiscountMinor),
          totalPrice: fromMinor(line.totalPriceMinor),
          unitPrice: fromMinor(netUnitPrice(line.totalPriceMinor, line.quantity)),
          grossProfit: fromMinor(line.totalPriceMinor - totalCostMinor)
        }
      });
    }

    const totals = orderTotalsFrom(lines, toMinor(order.taxAmount), toMinor(order.shippingAmount));

    return transactionClient.salesOrder.update({
      where: { id: orderId },
      data: {
        subtotal: fromMinor(totals.subtotalMinor),
        discountAmount: fromMinor(totals.discountMinor),
        total: fromMinor(totals.totalMinor)
      }
    });
  }

  async confirmOrder(clientId: string, id: string) {
    /*
     * Re-read, CLAIM, reserve -- in that order, inside one transaction.
     *
     * The previous version wrapped all of this in a transaction and believed that was enough.
     * It is not, and the comment it carried described the very bug it still had: at the default
     * isolation level two concurrent confirms both read DRAFT, both pass validateTransition,
     * both reserve, and both write CONFIRMED. A transaction makes the work atomic; it does not
     * make a read-then-write serialisable.
     *
     * Demonstrated from the UI, not theorised: pressing Confirm three times in one tick on a
     * 3+2+1 order produced NINE reservation rows holding EIGHTEEN units. Twelve units of a real
     * shop's stock, reserved against an order that wanted six, and unsellable.
     *
     * The claim below is a single atomic compare-and-set. The first transaction to reach it
     * takes the row lock and flips DRAFT to CONFIRMED; the second blocks on that lock, and when
     * it is released re-evaluates its own WHERE against the committed row, matches nothing, and
     * is told plainly that somebody got there first. Nothing is reserved on that path because
     * the claim happens BEFORE the reservation -- and if reserving then fails, the whole
     * transaction rolls back and the claim goes with it.
     */
    return prisma.$transaction(async (tx) => {
      const order = await tx.salesOrder.findFirst({
        where: { clientId, id, deletedAt: null },
        include: { items: true }
      });

      if (!order) throw notFound("Order not found");
      // Kept for the message it gives: "cannot go from CANCELLED to CONFIRMED" is worth saying
      // properly. The claim below is what actually enforces it.
      validateTransition(order.status, 'CONFIRMED');

      if (order.items.length === 0) {
        throw new Error("Cannot confirm an order with no items");
      }

      const claimed = await tx.salesOrder.updateMany({
        where: { id, clientId, status: 'DRAFT', deletedAt: null },
        data: { status: 'CONFIRMED' }
      });

      if (claimed.count === 0) {
        // 409, not 400: the request was fine, the order moved on. Said in words, because this
        // reaches somebody standing at a counter who pressed a button twice.
        throw conflict('This order has already been confirmed. Refresh to see where it got to.');
      }

      const reservationItems = order.items.map((item: any) => ({
        variantId: item.variantId,
        salesOrderItemId: item.id,
        quantity: item.quantity
      }));

      await reservationService.reserveStock(clientId, order.locationId, reservationItems, tx);

      return tx.salesOrder.findFirstOrThrow({ where: { id } });
    }, { timeout: 30000 });
  }

  async cancelOrder(clientId: string, id: string) {
    const order = await prisma.salesOrder.findFirst({
      where: { clientId, id, deletedAt: null },
      include: { items: true }
    });

    if (!order) throw notFound("Order not found");
    validateTransition(order.status, 'CANCELLED');

    // If it was confirmed, we need to release reservations
    if (order.status === 'CONFIRMED' || order.status === 'PARTIALLY_DISPATCHED') {
      for (const item of order.items) {
        await reservationService.releaseReservation(clientId, item.id);
      }
    }

    /*
     * Give the offers' allowances back -- but only if nothing has shipped.
     *
     * An order cancelled before dispatch was never a sale, so a "first 50 customers" offer
     * should not have lost one of its fifty to it. An order that shipped and then had its
     * remainder cancelled DID sell; keeping its allowance spent is what stops an offer being
     * used, part-refunded and used again. The same asymmetry Shopify applies, and the reason
     * returns never restore an allowance either.
     */
    const restoresAllowance = order.status === 'DRAFT' || order.status === 'CONFIRMED';

    return prisma.$transaction(async (tx) => {
      /*
       * Only if it is still what it was a moment ago. The status above was read outside this
       * transaction, so a second cancel -- or a dispatch -- could have landed in between; without
       * the check an order that shipped meanwhile would have its allowance and codes handed back.
       */
      const flipped = await tx.salesOrder.updateMany({
        where: { id, clientId, status: order.status, deletedAt: null },
        data: { status: 'CANCELLED' }
      });
      if (flipped.count === 0) {
        throw conflict('This order changed while it was being cancelled. Open it again and check.');
      }

      if (restoresAllowance) {
        await offerRedemptionService.release(tx, clientId, id, `Order ${order.orderNumber} cancelled`);
      }

      return tx.salesOrder.findFirstOrThrow({ where: { id, clientId } });
    }, { timeout: 30000 });
  }
}

export const salesOrderService = new SalesOrderService();
