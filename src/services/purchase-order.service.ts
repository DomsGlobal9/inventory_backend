import { PurchaseOrderStatus, InventoryReason, Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { runTransaction } from '../lib/txRetry';
import { generateSequentialCode } from '../utils/codeGenerator';
import { inventoryMutationService } from './inventory-mutation.service';
import { mailService } from './mail.service';
import { getShopSettings } from '../lib/clientSettings';

/**
 * Every rejection below carries an explicit statusCode. Thrown bare they inherited
 * errorHandler's `err.statusCode || 500`, so "you tried to receive more than you ordered"
 * came back as a 500 -- wrong semantics for a request that can never succeed on retry, and
 * errorHandler persists 5xx, so each one was written to the Platform Console's Errors page.
 * That page is for crashes; routine rejections were burying the real faults (one such entry,
 * "Cannot receive goods for PO in status ...", was visible there in production).
 */
/** What a goods receipt needs to print itself: its lines and where the goods went. */
const RECEIPT_INCLUDE = {
  items: { orderBy: { sku: 'asc' as const } },
  location: { select: { id: true, name: true, code: true } }
} satisfies Prisma.PurchaseReceiptInclude;

/** The store an order is for, with what a supplier needs to deliver there. */
const DELIVER_TO_SELECT = { id: true, name: true, code: true, active: true, address: true, phone: true } satisfies Prisma.StockLocationSelect;

const refuse = (message: string, statusCode = 400) => Object.assign(new Error(message), { statusCode });

export class PurchaseOrderService {
  /**
   * @param selectedLocationId the store chosen at the top of the app, used when the request names none
   */
  async createPO(
    clientId: string,
    data: { supplierId: string; locationId?: string | null; expectedDeliveryDate?: Date; notes?: string; items: { variantId: string; orderedQty: number; unitPrice: number; productTitle?: string; color?: string; size?: string }[] },
    selectedLocationId?: string
  ) {
    // Both looked up within this shop. Neither was: a supplier id from another shop failed only at
    // the foreign key, and a variant id from another shop was accepted and snapshotted onto the
    // order -- another shop's product and SKU on this shop's purchase order.
    const supplier = await prisma.supplier.findFirst({ where: { id: data.supplierId, clientId }, select: { id: true } });
    if (!supplier) throw refuse('That supplier could not be found.', 404);

    const deliverTo = await this.deliverToFor(prisma, clientId, data.locationId, selectedLocationId);

    // Fetch variants to snapshot their identifiers
    const variantIds = data.items.map(i => i.variantId);
    const variants = await prisma.productVariant.findMany({
      where: { id: { in: variantIds }, clientId },
      include: { product: true }
    });
    const missingVariant = variantIds.find(vid => !variants.some(v => v.id === vid));
    if (missingVariant) throw refuse(`Variant ${missingVariant} not found`, 404);

    // Numbered once the supplier and store are known to be good, so a refused order uses no number.
    const poNumber = await generateSequentialCode(clientId, 'PO', 'PURCHASE_ORDER');

    const variantMap = new Map(variants.map(v => [v.id, v]));

    // The supplier's own code for each item, snapshotted onto the line the same way the SKU
    // and barcode are. PurchaseOrderItem.supplierSku has existed since the model was written
    // but nothing ever populated it -- there was no supplier catalogue to read it from --
    // so every PO ever raised carried a null there. It is what the vendor recognises on
    // their side, which is precisely what belongs on an order sent to them.
    const supplierLinks = await prisma.supplierProduct.findMany({
      where: { clientId, supplierId: data.supplierId, variantId: { in: variantIds } },
      select: { variantId: true, supplierSku: true }
    });
    const supplierSkuMap = new Map(supplierLinks.map(l => [l.variantId, l.supplierSku]));

    const created = await prisma.purchaseOrder.create({
      data: {
        clientId,
        poNumber,
        supplierId: data.supplierId,
        locationId: deliverTo?.id ?? null,
        status: PurchaseOrderStatus.DRAFT,
        expectedDeliveryDate: data.expectedDeliveryDate,
        notes: data.notes,
        totalAmount: data.items.reduce((sum, item) => sum + (item.orderedQty * item.unitPrice), 0),
        items: {
          create: data.items.map(item => {
            const variant = variantMap.get(item.variantId);
            if (!variant) throw Object.assign(new Error(`Variant ${item.variantId} not found`), { statusCode: 404 });

            return {
              variantId: variant.id,
              sku: variant.sku,
              variantCode: variant.variantCode,
              barcode: variant.barcode,
              supplierSku: supplierSkuMap.get(variant.id) || null,
              productTitle: item.productTitle || variant.product?.title || 'Unknown Product',
              color: item.color || variant.colorName,
              size: item.size || variant.size,
              orderedQty: item.orderedQty,
              unitPrice: item.unitPrice
            };
          })
        }
      },
      include: {
        items: true,
        supplier: true,
        location: { select: DELIVER_TO_SELECT }
      }
    });

    // Ordering an item from a supplier IS the statement that they supply it, so the link is
    // recorded here rather than asking the user to maintain a catalogue by hand -- which
    // nobody would, leaving the supplier's item list permanently empty and the feature
    // useless. createMany with skipDuplicates so an existing link keeps its agreed price,
    // lead time and supplier SKU: those are negotiated terms and must not be overwritten by
    // whatever a single order happened to cost.
    //
    // Deliberately outside the create above and non-fatal: a failure to record the
    // relationship must never lose the purchase order the user just raised.
    try {
      await prisma.supplierProduct.createMany({
        data: created.items.map(item => ({
          clientId,
          supplierId: data.supplierId,
          variantId: item.variantId,
          costPrice: item.unitPrice,
          notes: `Linked automatically from ${poNumber}.`
        })),
        skipDuplicates: true
      });
    } catch (error) {
      console.error(`[createPO] could not link items to supplier for ${poNumber}`, error);
    }

    return created;
  }

  async getPOs(clientId: string) {
    return prisma.purchaseOrder.findMany({
      where: { clientId },
      orderBy: { createdAt: 'desc' },
      include: {
        supplier: { select: { name: true, supplierCode: true } },
        location: { select: DELIVER_TO_SELECT },
        _count: { select: { items: true } }
      }
    });
  }

  async getPOById(clientId: string, id: string) {
    return prisma.purchaseOrder.findFirst({
      where: { id, clientId },
      include: {
        supplier: true,
        location: { select: DELIVER_TO_SELECT },
        // Every delivery, so the order page can list them and print any one again.
        receipts: { include: RECEIPT_INCLUDE, orderBy: { receivedAt: 'asc' } },
        items: {
          include: {
            variant: {
              select: {
                stocks: { select: { quantity: true } },
                product: {
                  // basePrice as well as title: a reopened Draft's margin warning compares the
                  // PO cost against what the item sells for, and most variants carry no
                  // sellingPrice of their own -- the product's price is the real one.
                  select: { title: true, basePrice: true }
                },
                // Needed so a reopened Draft PO can still show the margin warning --
                // previously omitted, which silently disabled it for anything but a
                // brand-new PO (see PurchaseOrderDetails.jsx's getMarginWarning).
                sellingPrice: true,
                averageCost: true
              }
            }
          }
        }
      }
    });
  }

  /**
   * Change the store an order is for.
   *
   * Allowed until the order is fully received or cancelled: plans change after an order goes out
   * (a branch closes for a week, the warehouse takes it instead). Once the goods have all arrived
   * the order is history, and rewriting where it was meant to go would only make the record
   * disagree with itself. The answer says whether the supplier was already told another store, so
   * the screen can remind the person to tell them.
   */
  async setDeliverTo(clientId: string, id: string, locationId: string) {
    const po = await prisma.purchaseOrder.findFirst({
      where: { id, clientId },
      select: { id: true, status: true, locationId: true, location: { select: { name: true } } }
    });
    if (!po) throw refuse('Purchase Order not found', 404);
    if (po.status === PurchaseOrderStatus.RECEIVED || po.status === PurchaseOrderStatus.CANCELLED) {
      throw refuse(`This order is ${po.status === PurchaseOrderStatus.RECEIVED ? 'fully received' : 'cancelled'}, so the store it was for can no longer change.`);
    }

    const location = (await this.deliverToFor(prisma, clientId, locationId))!;
    const changed = po.locationId !== location.id;
    if (changed) {
      // The status is checked again in the write itself. The check above can pass a moment before
      // the last delivery completes the order, and a plain update would then move a finished order.
      const moved = await prisma.purchaseOrder.updateMany({
        where: { id: po.id, clientId, status: { notIn: [PurchaseOrderStatus.RECEIVED, PurchaseOrderStatus.CANCELLED] } },
        data: { locationId: location.id }
      });
      if (moved.count === 0) {
        throw refuse('This order was completed or cancelled a moment ago, so the store it was for can no longer change.', 409);
      }
    }

    return {
      po: await this.getPOById(clientId, id),
      previous: po.location?.name ?? null,
      changed,
      supplierAlreadyTold: changed && !!po.locationId && po.status !== PurchaseOrderStatus.DRAFT
    };
  }

  /**
   * The store an order is for.
   *
   * A store the request names must belong to this shop and be switched on -- an order for a store
   * that cannot take stock in could never be received there. Named none: the store chosen at the
   * top of the app, then MAIN-STORE, then the oldest active store. Null only for a shop with no
   * active store at all, which cannot receive anything yet either.
   */
  private async deliverToFor(db: Prisma.TransactionClient, clientId: string, wanted?: string | null, selected?: string | null) {
    if (wanted) {
      const location = await db.stockLocation.findFirst({ where: { id: wanted, clientId }, select: DELIVER_TO_SELECT });
      if (!location) throw refuse('That store does not belong to this shop.');
      if (!location.active) throw refuse(`${location.name} is switched off, so goods cannot be delivered there.`);
      return location;
    }
    if (selected) {
      const location = await db.stockLocation.findFirst({ where: { id: selected, clientId, active: true }, select: DELIVER_TO_SELECT });
      if (location) return location;
    }
    return await db.stockLocation.findFirst({ where: { clientId, code: 'MAIN-STORE', active: true }, select: DELIVER_TO_SELECT })
      ?? await db.stockLocation.findFirst({ where: { clientId, active: true }, orderBy: { createdAt: 'asc' }, select: DELIVER_TO_SELECT });
  }

  async updatePOStatus(clientId: string, id: string, status: PurchaseOrderStatus) {
    return prisma.$transaction(async (tx) => {
      // Scope the lookup by clientId too — otherwise a caller could pass another
      // tenant's PO id and corrupt that tenant's supplier counters below even
      // though the final update (correctly scoped) would go on to 404.
      const po = await tx.purchaseOrder.findFirst({ where: { id, clientId }, select: { supplierId: true, status: true } });
      if (!po) throw Object.assign(new Error('Purchase Order not found'), { statusCode: 404 });

      /*
       * Which changes this route may make. RECEIVED and PARTIALLY_RECEIVED come only from receiving
       * goods; setting them here said goods had arrived when none had, and closed the order to
       * further receiving. A received order is finished, and a cancelled one stays cancelled.
       * A part-received order may be cancelled -- that is closing it short; what arrived stays.
       */
      const ALLOWED: Record<string, string[]> = {
        DRAFT: ['SENT', 'CANCELLED'],
        SENT: ['SENT', 'CANCELLED'],
        PARTIALLY_RECEIVED: ['CANCELLED'],
        RECEIVED: [],
        CANCELLED: []
      };
      if (!Object.values(PurchaseOrderStatus).includes(status)) {
        throw Object.assign(new Error('That is not a purchase order status.'), { statusCode: 400 });
      }
      if (!(ALLOWED[po.status] ?? []).includes(status)) {
        throw Object.assign(new Error(`This order is ${po.status.toLowerCase().replace('_', ' ')}, so it cannot be marked ${status.toLowerCase().replace('_', ' ')}.`), { statusCode: 409 });
      }

      // Count the supplier once, when the order is actually placed -- not every time something
      // sets the status to SENT. Pressing "Mark as Sent" twice, or emailing a copy of an order
      // the supplier mislaid, used to add another order to their lifetime total each time.
      //
      // No screen reads these two columns today: supplier.service computes totalOrders,
      // totalSpend and lastOrderDate live from the orders themselves, which is why nobody ever
      // noticed. That makes this stored pair a quiet trap rather than a visible bug -- it looks
      // authoritative, it is wrong, and the first screen or report to trust it inherits the
      // error. Kept correct for whoever reaches for it next.
      if (status === PurchaseOrderStatus.SENT && po.status === PurchaseOrderStatus.DRAFT) {
        await tx.supplier.update({
          where: { id: po.supplierId },
          data: {
            lastOrderDate: new Date(),
            totalOrders: { increment: 1 }
          }
        });
      }

      return tx.purchaseOrder.update({
        where: { id, clientId },
        data: { status }
      });
    });
  }

  /**
   * One delivery against the order: stock in, the order's counts up, and a goods receipt note.
   *
   * All three happen in one transaction, so a receipt exists exactly when the stock it describes
   * does. Before the receipt existed a delivery left no trace of itself -- no date, no person, no
   * shop, no supplier invoice -- and two part-deliveries of one order were indistinguishable.
   *
   * Where the goods go, in order: a location on the lines (the older request shape), the one the
   * screen chose, the store the order is for, the location selected at the top of the app, then the
   * shop called MAIN-STORE. The order's own store comes before the top bar because it is a
   * statement about THIS order; the top bar is only where the person happens to be looking.
   * It used to be `findFirst({ where: { clientId } })` -- whichever location the database
   * happened to return first, inactive ones included -- because the screen never sent one.
   */
  async receiveGoods(
    clientId: string,
    id: string,
    input: {
      receipts: { poItemId: string; quantityReceived: number; locationId?: string | null }[];
      locationId?: string | null;
      receivedByName?: string | null;
      receivedByPhone?: string | null;
      supplierReference?: string | null;
      notes?: string | null;
      requestKey?: string | null;
    },
    actor: { id?: string; name?: string } = {},
    selectedLocationId?: string
  ) {
    const lines = input.receipts.filter(r => r.quantityReceived > 0);
    if (lines.length === 0) {
      throw Object.assign(new Error('Enter how many of at least one item arrived.'), { statusCode: 400 });
    }

    const requestKey = input.requestKey?.trim() || null;
    const existing = requestKey ? await this.receiptForRequest(clientId, id, requestKey) : null;
    if (existing) return existing;

    const lineLocations = [...new Set(lines.map(l => l.locationId).filter(Boolean))] as string[];
    if (lineLocations.length > 1) {
      throw Object.assign(new Error('Receive into one location at a time: a receipt says where its goods went.'), { statusCode: 400 });
    }

    return await runTransaction(async (tx) => {
        const po = await tx.purchaseOrder.findFirst({
          where: { id, clientId },
          include: { items: true }
        });

        if (!po) throw Object.assign(new Error('Purchase Order not found'), { statusCode: 404 });
        if (po.status === PurchaseOrderStatus.RECEIVED || po.status === PurchaseOrderStatus.CANCELLED) {
          throw Object.assign(new Error(`Cannot receive goods for PO in status ${po.status}`), { statusCode: 400 });
        }

        const location = await this.receivingLocation(tx, clientId, lineLocations[0] || input.locationId, [po.locationId, selectedLocationId]);

        const itemMap = new Map(po.items.map(i => [i.id, i]));
        const now = new Date();
        const receiptLines: Prisma.PurchaseReceiptItemCreateWithoutReceiptInput[] = [];
        const seen = new Set<string>();

        for (const receipt of lines) {
          // itemMap is built from THIS po's items; without this check the findUnique below
          // matched a line on any other PO in the tenant and booked the receipt -- and the
          // resulting stock/lastPurchaseCost writes -- against that unrelated PO instead.
          if (!itemMap.has(receipt.poItemId)) {
            throw Object.assign(new Error(`PO Item ${receipt.poItemId} does not belong to this purchase order`), { statusCode: 400 });
          }
          // The same line twice in one delivery would each be checked against the remaining
          // quantity before either was added, and so could receive more than was ordered.
          if (seen.has(receipt.poItemId)) {
            throw Object.assign(new Error('Each item can appear once in a delivery.'), { statusCode: 400 });
          }
          seen.add(receipt.poItemId);

          const currentPoItem = await tx.purchaseOrderItem.findUnique({ where: { id: receipt.poItemId } });
          if (!currentPoItem) throw Object.assign(new Error(`PO Item ${receipt.poItemId} not found`), { statusCode: 404 });

          if (currentPoItem.receivedQty + receipt.quantityReceived > currentPoItem.orderedQty) {
            throw Object.assign(new Error(`Cannot receive more than remaining quantity for SKU ${currentPoItem.sku}`), { statusCode: 400 });
          }

          // 1. Update PO Item atomically
          const poItem = await tx.purchaseOrderItem.update({
            where: { id: receipt.poItemId },
            data: {
              receivedQty: { increment: receipt.quantityReceived },
              lastReceivedAt: now
            }
          });

          // Atomic double-check
          if (poItem.receivedQty > poItem.orderedQty) {
            throw Object.assign(new Error(`Cannot receive more than remaining quantity for SKU ${poItem.sku}`), { statusCode: 400 });
          }

          // 2. Adjust Inventory atomically with WAC Calculation using central mutation service
          await inventoryMutationService.applyMovement({
            clientId,
            locationId: location.id,
            variantId: poItem.variantId,
            movementType: 'IN',
            reason: InventoryReason.PURCHASE_RECEIPT,
            quantityDelta: receipt.quantityReceived,
            unitCost: Number(poItem.unitPrice),
            referenceType: 'PO',
            referenceId: po.poNumber,
            notes: 'PO Receipt',
            // Who actually counted it in. This was the string 'Admin' for every receipt ever
            // taken, whoever took it.
            createdBy: actor.name || actor.id || 'Unknown',
            tx
          });

          // applyMovement above already blends this into averageCost; lastPurchaseCost is
          // a separate, simpler field -- "what did the last PO actually charge", not a
          // blended figure -- and was never being written anywhere despite existing on
          // the schema and being exposed in variant API responses.
          await tx.productVariant.update({
            where: { id: poItem.variantId },
            data: { lastPurchaseCost: poItem.unitPrice }
          });

          receiptLines.push({
            poItem: { connect: { id: poItem.id } },
            variant: { connect: { id: poItem.variantId } },
            sku: poItem.sku,
            variantCode: poItem.variantCode,
            productTitle: poItem.productTitle,
            color: poItem.color,
            size: poItem.size,
            orderedQty: poItem.orderedQty,
            receivedBefore: currentPoItem.receivedQty,
            quantity: receipt.quantityReceived,
            unitPrice: poItem.unitPrice
          });
        }

        // Inside the transaction, so a delivery that fails leaves no gap in the GRN numbers.
        const receiptNumber = await generateSequentialCode(clientId, 'GRN', 'PURCHASE_RECEIPT', tx as any);
        const receipt = await tx.purchaseReceipt.create({
          data: {
            clientId,
            receiptNumber,
            po: { connect: { id: po.id } },
            location: { connect: { id: location.id } },
            receivedById: actor.id ?? null,
            recordedByName: actor.name ?? null,
            // The route requires a typed receiver; a caller inside the server that has none (a
            // script, a future integration) falls back to the account, as receipts always did.
            receivedByName: input.receivedByName?.trim() || actor.name || null,
            receivedByPhone: input.receivedByPhone?.trim() || null,
            supplierReference: input.supplierReference?.trim() || null,
            notes: input.notes?.trim() || null,
            requestKey,
            receivedAt: now,
            items: { create: receiptLines }
          },
          include: RECEIPT_INCLUDE
        });

        // Determine new PO Status
        // Re-fetch items to get the most updated received quantities
        const updatedItems = await tx.purchaseOrderItem.findMany({ where: { poId: id } });
        const isFullyReceived = updatedItems.every(i => i.receivedQty >= i.orderedQty);
        const isPartiallyReceived = updatedItems.some(i => i.receivedQty > 0);

        let newStatus: PurchaseOrderStatus = po.status;
        let receivedAt = po.receivedAt;

        if (isFullyReceived) {
          newStatus = PurchaseOrderStatus.RECEIVED;
          receivedAt = now;
        } else if (isPartiallyReceived) {
          newStatus = PurchaseOrderStatus.PARTIALLY_RECEIVED;
        }

        const updated = await tx.purchaseOrder.update({
          where: { id },
          data: {
            status: newStatus,
            receivedAt
          },
          include: {
            items: true
          }
        });

        return { po: updated, receipt, duplicate: false };
      }, {
        label: 'receive delivery',
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        // Every line costs several round trips to the database, and a delivery can have many
        // lines, so this budget is for the whole receipt, not for one row.
        timeout: 120000,
        // Two presses of the same Confirm Receipt that both got past the check above: one wins,
        // and the other is told what the winner recorded rather than failing. The same answer
        // is what makes a retry safe if an attempt committed but the answer was lost.
        alreadyDone: requestKey ? () => this.receiptForRequest(clientId, id, requestKey) : undefined,
        tooSlowMessage: 'Saving this delivery took too long, so nothing was recorded. Check the order and try again.'
      });
  }

  /** The receipt a request key already produced, with the order as it stands now. */
  private async receiptForRequest(clientId: string, poId: string, requestKey: string) {
    const receipt = await prisma.purchaseReceipt.findUnique({
      where: { uq_purchase_receipt_request: { clientId, requestKey } },
      include: RECEIPT_INCLUDE
    });
    if (!receipt) return null;
    if (receipt.poId !== poId) {
      throw Object.assign(new Error('That receipt key was already used for a different purchase order.'), { statusCode: 409 });
    }
    const po = await prisma.purchaseOrder.findFirstOrThrow({ where: { id: poId, clientId }, include: { items: true } });
    return { po, receipt, duplicate: true };
  }

  /**
   * A location of this shop that can take stock in.
   *
   * `wanted` was asked for, so a wrong one is refused. `preferred` were not -- the order's store and
   * the top bar -- so one that has since been switched off is passed over rather than refused.
   */
  private async receivingLocation(tx: Prisma.TransactionClient, clientId: string, wanted?: string | null, preferred: (string | null | undefined)[] = []) {
    if (wanted) {
      const location = await tx.stockLocation.findFirst({ where: { id: wanted, clientId } });
      if (!location) throw Object.assign(new Error('That location does not belong to this shop.'), { statusCode: 400 });
      if (!location.active) throw Object.assign(new Error(`${location.name} is switched off, so it cannot take stock in.`), { statusCode: 400 });
      return location;
    }
    for (const id of preferred) {
      if (!id) continue;
      const location = await tx.stockLocation.findFirst({ where: { id, clientId, active: true } });
      if (location) return location;
    }
    const location =
      await tx.stockLocation.findFirst({ where: { clientId, code: 'MAIN-STORE', active: true } })
      ?? await tx.stockLocation.findFirst({ where: { clientId, active: true }, orderBy: { createdAt: 'asc' } });
    if (!location) throw Object.assign(new Error('Add a location before receiving stock.'), { statusCode: 400 });
    return location;
  }

  /**
   * Emails the order to the supplier, and only then records it as sent.
   *
   * The order of those two matters. "Mark as Sent" already existed and is honest about what it
   * does -- it records that YOU sent it somewhere else. This one does the sending, so the
   * status only moves if the message actually left. A status that says SENT when the email
   * bounced is worse than no email feature at all: the merchant stops chasing it.
   */
  async emailToSupplier(clientId: string, id: string, orderedByName?: string) {
    const po = await prisma.purchaseOrder.findFirst({
      where: { id, clientId },
      include: { supplier: true, items: true, location: { select: DELIVER_TO_SELECT } }
    });
    if (!po) throw Object.assign(new Error('Purchase Order not found'), { statusCode: 404 });

    // A supplier cannot deliver to "one of our stores". Only older orders can have none.
    if (!po.location) {
      throw refuse('Choose the store this order is for before sending it, so the supplier knows where to deliver.');
    }

    // Said plainly, and early, because the fix is on a different screen. "Failed to send" would
    // leave the merchant retrying a button that can never work.
    const to = po.supplier?.email?.trim();
    if (!to) {
      throw Object.assign(
        new Error(`${po.supplier?.name || 'This supplier'} has no email address. Add one on the supplier, then send again.`),
        { statusCode: 400 }
      );
    }
    if (po.items.length === 0) {
      throw Object.assign(new Error('This order has no items to send.'), { statusCode: 400 });
    }
    if (!mailService.isConfigured()) {
      throw Object.assign(
        new Error('Email is not set up on this server yet. Use "Send on WhatsApp" instead.'),
        { statusCode: 503 }
      );
    }

    const { businessName } = await getShopSettings(clientId);
    const letterhead = await prisma.clientSettings.findUnique({ where: { clientId }, select: { businessAddress: true, businessPhone: true } });

    const result = await mailService.sendPurchaseOrder({
      to,
      supplierName: po.supplier.name,
      poNumber: po.poNumber,
      shopName: businessName || 'Your customer',
      orderedByName,
      expectedDeliveryDate: po.expectedDeliveryDate,
      // The store's own address when it has one; otherwise the shop's, which for a one-store shop
      // is the same place.
      deliverTo: {
        name: po.location.name,
        address: po.location.address || letterhead?.businessAddress || null,
        phone: po.location.phone || letterhead?.businessPhone || null
      },
      notes: po.notes,
      items: po.items.map(i => ({
        title: i.productTitle,
        sku: i.sku,
        variantLabel: [i.color, i.size].filter(Boolean).join(' / ') || undefined,
        quantity: i.orderedQty,
        unitPrice: Number(i.unitPrice)
      })),
      total: po.items.reduce((sum, i) => sum + i.orderedQty * Number(i.unitPrice), 0)
    });

    if (!result.sent) {
      throw Object.assign(
        new Error(result.reason || 'The email could not be sent. The order has not been marked as sent.'),
        { statusCode: 502 }
      );
    }

    // Only a Draft advances. Re-sending a copy of an order already in flight is a normal thing
    // to do -- the supplier lost it, or asked for it again -- and it must not roll a
    // part-received order back to SENT or count the supplier a second time.
    if (po.status === PurchaseOrderStatus.DRAFT) {
      await this.updatePOStatus(clientId, id, PurchaseOrderStatus.SENT);
    }

    return { sent: true, to, poNumber: po.poNumber, statusChanged: po.status === PurchaseOrderStatus.DRAFT };
  }

}

export const purchaseOrderService = new PurchaseOrderService();
