import { InventoryAlertType, InventoryAlertSeverity, Prisma } from '@prisma/client';
import { isLowStock } from '../lib/lowStock';
import { runTransaction } from '../lib/txRetry';

type AlertTarget = { type: InventoryAlertType; severity: InventoryAlertSeverity; title: string; message: string };

export class InventoryAlertService {
  /**
   * What an item's stock at one store calls for: out of stock, low, or nothing. The one rule,
   * used by the movement path, the bulk re-check and the alert list alike.
   *
   * A reorder level of 0 (or less) means "not tracked": never low, only out of stock -- the same
   * answer lib/lowStock gives the Inventory Overview badge, so the two cannot disagree.
   */
  static targetFor(currentQuantity: number, reorderLevel: number | null | undefined): AlertTarget | null {
    if (currentQuantity <= 0) {
      return { type: 'OUT_OF_STOCK', severity: 'CRITICAL', title: 'Out of Stock', message: 'This variant is out of stock at this location.' };
    }
    if (isLowStock(currentQuantity, reorderLevel)) {
      return { type: 'LOW_STOCK', severity: 'WARNING', title: 'Low Stock', message: `Stock is low (${currentQuantity} remaining). Reorder level is ${reorderLevel}.` };
    }
    return null;
  }

  /**
   * Re-checks every store's alert for these items at once, straight after a change made in bulk
   * -- Import Updates, a product import -- and after a reorder level changes without any stock
   * moving, which the movement path never saw.
   *
   * Without it the alerts were whatever they were when the stock last moved: an item set to
   * reorder level 0 stayed LOW STOCK on Stock alerts and in the bell while Inventory Overview
   * called it Healthy, and lowering a level left an alert for something no longer low.
   *
   * Batched, because every round trip to this database costs about a second: three reads for the
   * whole set, then one statement per kind of change -- never a query per row.
   */
  static async recheckVariants(db: any, clientId: string, variantIds: string[]) {
    const ids = [...new Set(variantIds.filter(Boolean))].sort();
    if (!ids.length) return { created: 0, resolved: 0, updated: 0 };
    // Given the client rather than a transaction, it makes its own: see recheckLocked.
    if (typeof db.$transaction === 'function') {
      return runTransaction(tx => InventoryAlertService.recheckLocked(tx, clientId, ids), { label: 'recheck stock alerts' });
    }
    return InventoryAlertService.recheckLocked(db, clientId, ids);
  }

  /**
   * The re-check itself, holding the items' rows. A sale or stock movement locks its item's row
   * (FOR UPDATE, in inventory-mutation) while it writes that item's alert. Without the same lock
   * here, a movement landing between this read of the open alerts and its insert made a second
   * open alert for one item and store, and the movement path, which only ever updates the first
   * it finds, left the other open for good. Locked in id order, so two re-checks cannot deadlock
   * each other; a clash with a movement is retried by runTransaction.
   */
  private static async recheckLocked(db: any, clientId: string, ids: string[]) {
    await db.$queryRaw`SELECT id FROM inventory_product_variants WHERE id IN (${Prisma.join(ids)}) ORDER BY id FOR UPDATE`;

    const [variants, stocks, open] = await Promise.all([
      db.productVariant.findMany({ where: { clientId, id: { in: ids } }, select: { id: true, reorderLevel: true } }),
      db.inventoryStock.findMany({ where: { clientId, variantId: { in: ids } }, select: { variantId: true, locationId: true, quantity: true } }),
      db.inventoryAlert.findMany({
        where: { clientId, variantId: { in: ids }, isResolved: false, type: { in: ['LOW_STOCK', 'OUT_OF_STOCK'] } },
        select: { id: true, variantId: true, locationId: true, type: true, currentQuantity: true, threshold: true }
      })
    ]);

    const levelOf = new Map<string, number>(variants.map((v: any) => [v.id, v.reorderLevel]));
    const openAt = new Map<string, any>(open.map((a: any) => [`${a.variantId}|${a.locationId}`, a]));

    const resolve: string[] = [];
    const create: any[] = [];
    const change: { id: string; target: AlertTarget; quantity: number; level: number; typeChanged: boolean }[] = [];

    for (const s of stocks) {
      if (!levelOf.has(s.variantId)) continue;
      const level = levelOf.get(s.variantId)!;
      const key = `${s.variantId}|${s.locationId}`;
      const existing = openAt.get(key);
      openAt.delete(key);
      const target = InventoryAlertService.targetFor(s.quantity, level);
      if (!target) {
        if (existing) resolve.push(existing.id);
      } else if (!existing) {
        create.push({ clientId, variantId: s.variantId, locationId: s.locationId, type: target.type, severity: target.severity, title: target.title, message: target.message, currentQuantity: s.quantity, threshold: level });
      } else if (existing.type !== target.type || existing.currentQuantity !== s.quantity || existing.threshold !== level) {
        change.push({ id: existing.id, target, quantity: s.quantity, level, typeChanged: existing.type !== target.type });
      }
    }

    if (resolve.length) await db.inventoryAlert.updateMany({ where: { id: { in: resolve } }, data: { isResolved: true } });
    if (create.length) await db.inventoryAlert.createMany({ data: create });
    if (change.length) {
      // One statement for every changed alert, each with its own figures. A worsening (low to out
      // of stock) is marked unread again, as the movement path does.
      const rows = change.map(c => Prisma.sql`(${c.id}, ${c.target.type}, ${c.target.severity}, ${c.target.title}, ${c.target.message}, ${c.quantity}::int, ${c.level}::int, ${c.typeChanged})`);
      await db.$executeRaw`
        UPDATE inventory_alerts AS a SET
          type = v.type::"InventoryAlertType",
          severity = v.severity::"InventoryAlertSeverity",
          title = v.title,
          message = v.message,
          current_quantity = v.qty,
          threshold = v.level,
          is_read = CASE WHEN v.worse THEN false ELSE a.is_read END,
          updated_at = now()
        FROM (VALUES ${Prisma.join(rows)}) AS v(id, type, severity, title, message, qty, level, worse)
        WHERE a.id = v.id
      `;
    }
    return { created: create.length, resolved: resolve.length, updated: change.length };
  }

  /**
   * Evaluates if a stock change should trigger or resolve an alert.
   * This should be called within the same Prisma transaction as the stock mutation.
   */
  static async evaluateStockAlert(
    tx: any,
    clientId: string,
    variantId: string,
    locationId: string,
    currentQuantity: number,
    reorderLevel: number
  ) {
    // Determine target alert state based on V1 location rules
    const target = InventoryAlertService.targetFor(currentQuantity, reorderLevel);
    const targetType = target?.type ?? null;
    const targetSeverity = target?.severity ?? null;
    const title = target?.title ?? '';
    const message = target?.message ?? '';

    // Find any existing unresolved operational alert for this variant/location
    const existingAlert = await tx.inventoryAlert.findFirst({
      where: {
        clientId,
        variantId,
        locationId,
        isResolved: false
      }
    });

    // Case 1: Stock is now NORMAL
    if (!targetType) {
      if (existingAlert) {
        // Resolve the existing alert
        await tx.inventoryAlert.update({
          where: { id: existingAlert.id },
          data: {
            isResolved: true,
            currentQuantity // snapshot final healthy quantity
          }
        });
      }
      return;
    }

    // Case 2: Stock is LOW or OUT, and we ALREADY have an active alert
    if (existingAlert) {
      // If the condition changed (e.g., LOW_STOCK -> OUT_OF_STOCK), update it
      // Or if just the quantity changed, update the quantity snapshot
      if (existingAlert.type !== targetType || existingAlert.currentQuantity !== currentQuantity) {
        await tx.inventoryAlert.update({
          where: { id: existingAlert.id },
          data: {
            type: targetType,
            severity: targetSeverity,
            title,
            message,
            currentQuantity,
            threshold: reorderLevel,
            isRead: false // Mark unread again so the user sees the worsening condition
          }
        });
      }
      return; // Do not create a duplicate
    }

    // Case 3: Stock is LOW or OUT, and NO active alert exists
    await tx.inventoryAlert.create({
      data: {
        clientId,
        variantId,
        locationId,
        type: targetType,
        severity: targetSeverity,
        title,
        message,
        currentQuantity,
        threshold: reorderLevel
      }
    });
  }
}
