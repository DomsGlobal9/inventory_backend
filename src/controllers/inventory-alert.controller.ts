import { Request, Response } from 'express';
import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { respondWithError } from '../utils/respondWithError';
import { InventoryAlertService } from '../services/inventory-alert.service';

export const getAlerts = async (req: Request, res: Response) => {
  try {
    const { clientId, id: userId } = (req as any).user;
    const status = req.query.status as string || 'active';
    const locationId = (req.query.locationId as string | undefined) || (req as any).locationId;

    const where: any = { clientId };

    if (status === 'active') {
      where.isResolved = false;
    } else if (status === 'resolved') {
      where.isResolved = true;
    }

    if (locationId) {
      where.locationId = locationId;
    }

    /*
     * `type` and `severity` are read as TEXT, not as Prisma enums, and that is not a style choice.
     *
     * A value added to a Postgres enum is written by whichever build is newest and then READ by
     * every build, including ones generated before that value existed -- and an older Prisma
     * client throws on the row rather than skipping it. That is not hypothetical: adding
     * ONLINE_ORDER for the online shop's "new order" alert took the whole alerts endpoint down
     * with a 500 for a shop whose only fault was receiving an order, because the running build
     * had never heard of the value. One unreadable row should not cost a shopkeeper their bell.
     *
     * Read as text, an unknown value is simply a string: the alert still lists, still says what
     * it says, and only the rules that name a specific type stop applying to it.
     */
    const rows = await prisma.inventoryAlert.findMany({
      where,
      orderBy: [
        { isPinned: 'desc' }, // Pinned alerts float to the top
        { severity: 'asc' }, // CRITICAL before WARNING before INFO -- ordered by Postgres, never read here
        { updatedAt: 'desc' }
      ],
      select: {
        id: true,
        title: true,
        message: true,
        currentQuantity: true,
        threshold: true,
        isRead: true,
        isResolved: true,
        isPinned: true,
        createdAt: true,
        updatedAt: true,
        variant: {
          select: {
            id: true,
            sku: true,
            variantCode: true,
            colorName: true,
            hexCode: true,
            size: true,
            reorderLevel: true,
            productId: true,
            product: { select: { title: true } }
          }
        },
        location: {
          select: { id: true, name: true }
        },
        reads: {
          where: { userId },
          select: { id: true }
        }
      }
    });

    const labels = rows.length
      ? await prisma.$queryRaw<{ id: string; type: string; severity: string }[]>`
          SELECT id, type::text AS type, severity::text AS severity
          FROM inventory_alerts
          WHERE id IN (${Prisma.join(rows.map(r => r.id))})
        `
      : [];
    const labelOf = new Map(labels.map(l => [l.id, l]));
    // The order above is kept; only the two words come from the second read.
    const alerts = rows.map(r => ({
      ...r,
      type: labelOf.get(r.id)?.type ?? 'SYSTEM_ERROR',
      severity: labelOf.get(r.id)?.severity ?? 'INFO'
    }));

    /*
     * Read against the item's reorder level NOW, not the one stored when the alert was raised.
     *
     * The row's threshold is a snapshot. Changing a reorder level (Import Updates, a product
     * import) left Stock alerts and the bell showing the old number -- "Reorder level is 3" for
     * an item set to 0 -- and still listing as LOW an item the Inventory Overview called Healthy.
     * Changes are re-checked when they are made (InventoryAlertService.recheckVariants); this is
     * the same rule applied on the way out, so an alert raised before that existed cannot linger.
     */
    const current = alerts.filter(alert => {
      if (!alert.isResolved && alert.type === 'LOW_STOCK' && alert.variant && alert.currentQuantity != null) {
        return InventoryAlertService.targetFor(alert.currentQuantity, alert.variant.reorderLevel)?.type === 'LOW_STOCK';
      }
      return true;
    });

    // Counted from what is shown, so the bell's number and the list agree.
    const unreadCount = current.filter(alert => alert.reads.length === 0).length;

    const formattedAlerts = current.map(alert => {
      const level = alert.variant?.reorderLevel ?? alert.threshold;
      const live = alert.type === 'LOW_STOCK' && !alert.isResolved && alert.currentQuantity != null
        ? InventoryAlertService.targetFor(alert.currentQuantity, level)
        : null;
      return {
        id: alert.id,
        type: alert.type,
        severity: alert.severity,
        title: alert.title,
        message: live?.message ?? alert.message,
        variantId: alert.variant?.id,
        variantName: alert.variant?.product?.title || alert.variant?.sku,
        productTitle: alert.variant?.product?.title,
        productId: alert.variant?.productId,
        sku: alert.variant?.sku,
        variantCode: alert.variant?.variantCode,
        colorName: alert.variant?.colorName,
        hexCode: alert.variant?.hexCode,
        size: alert.variant?.size,
        quantity: alert.currentQuantity, // Frontend expects quantity
        reorderLevel: level, // Frontend expects reorderLevel
        locationId: alert.location?.id,
        locationName: alert.location?.name,
        currentQuantity: alert.currentQuantity,
        threshold: level,
        isRead: alert.reads.length > 0, // Per-user read state
        isResolved: alert.isResolved,
        isPinned: alert.isPinned,
        createdAt: alert.createdAt,
        updatedAt: alert.updatedAt
      };
    });

    res.json({
      success: true,
      data: {
        alerts: formattedAlerts,
        unreadCount
      }
    });
  } catch (error: any) {
    return respondWithError(res, error, { status: 500, message: 'Failed to fetch alerts' });
  }
};

export const markAsRead = async (req: Request, res: Response) => {
  try {
    const { clientId, id: userId } = (req as any).user;
    const { id } = req.params;

    // Only the two things this needs, so the row's enum columns are never read. See the note in
    // getAlerts: a value added to an enum by a newer build makes the whole row unreadable to an
    // older one, and "mark as read" has no business caring what type of alert it is.
    const alert = await prisma.inventoryAlert.findFirst({
      where: { id: id as string, clientId },
      select: { id: true, isPinned: true }
    });

    if (!alert) {
      return res.status(404).json({ success: false, message: 'Alert not found' });
    }

    await prisma.inventoryAlertRead.upsert({
      where: { alertId_userId: { alertId: id as string, userId } },
      create: { alertId: id as string, userId },
      update: {}
    });

    res.json({ success: true, message: 'Alert marked as read' });
  } catch (error: any) {
    return respondWithError(res, error, { status: 500, message: 'Failed to update alert' });
  }
};

export const markAllAsRead = async (req: Request, res: Response) => {
  try {
    const { clientId, id: userId } = (req as any).user;
    const locationId = req.body?.locationId || (req as any).locationId;

    const where: any = { clientId, isResolved: false, reads: { none: { userId } } };
    if (locationId) {
      where.locationId = locationId;
    }

    const unread = await prisma.inventoryAlert.findMany({ where, select: { id: true } });

    if (unread.length > 0) {
      await prisma.inventoryAlertRead.createMany({
        data: unread.map(a => ({ alertId: a.id, userId })),
        skipDuplicates: true
      });
    }

    res.json({ success: true, message: 'All active alerts marked as read' });
  } catch (error: any) {
    return respondWithError(res, error, { status: 500, message: 'Failed to update alerts' });
  }
};

export const togglePin = async (req: Request, res: Response) => {
  try {
    const { clientId } = (req as any).user;
    const { id } = req.params;

    // Only the two things this needs, so the row's enum columns are never read. See the note in
    // getAlerts: a value added to an enum by a newer build makes the whole row unreadable to an
    // older one, and "mark as read" has no business caring what type of alert it is.
    const alert = await prisma.inventoryAlert.findFirst({
      where: { id: id as string, clientId },
      select: { id: true, isPinned: true }
    });

    if (!alert) {
      return res.status(404).json({ success: false, message: 'Alert not found' });
    }

    const updated = await prisma.inventoryAlert.update({
      where: { id: id as string },
      data: { isPinned: !alert.isPinned }
    });

    res.json({ success: true, data: { isPinned: updated.isPinned } });
  } catch (error: any) {
    return respondWithError(res, error, { status: 500, message: 'Failed to update alert' });
  }
};

export const deleteAlert = async (req: Request, res: Response) => {
  try {
    const { clientId } = (req as any).user;
    const { id } = req.params;

    // Only the two things this needs, so the row's enum columns are never read. See the note in
    // getAlerts: a value added to an enum by a newer build makes the whole row unreadable to an
    // older one, and "mark as read" has no business caring what type of alert it is.
    const alert = await prisma.inventoryAlert.findFirst({
      where: { id: id as string, clientId },
      select: { id: true, isPinned: true }
    });

    if (!alert) {
      return res.status(404).json({ success: false, message: 'Alert not found' });
    }

    await prisma.inventoryAlert.delete({ where: { id: id as string } });

    res.json({ success: true, message: 'Alert dismissed' });
  } catch (error: any) {
    return respondWithError(res, error, { status: 500, message: 'Failed to delete alert' });
  }
};
