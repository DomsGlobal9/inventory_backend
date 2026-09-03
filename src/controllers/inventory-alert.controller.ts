import { Request, Response } from 'express';
import { prisma } from '../lib/prisma';

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

    const alerts = await prisma.inventoryAlert.findMany({
      where,
      orderBy: [
        { isPinned: 'desc' }, // Pinned alerts float to the top
        { severity: 'asc' }, // CRITICAL before WARNING before INFO
        { updatedAt: 'desc' }
      ],
      include: {
        variant: {
          select: {
            id: true,
            sku: true,
            variantCode: true,
            colorName: true,
            hexCode: true,
            size: true,
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

    const unreadCount = await prisma.inventoryAlert.count({
      where: {
        ...where,
        reads: { none: { userId } }
      }
    });

    const formattedAlerts = alerts.map(alert => ({
      id: alert.id,
      type: alert.type,
      severity: alert.severity,
      title: alert.title,
      message: alert.message,
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
      reorderLevel: alert.threshold, // Frontend expects reorderLevel
      locationId: alert.location?.id,
      locationName: alert.location?.name,
      currentQuantity: alert.currentQuantity,
      threshold: alert.threshold,
      isRead: alert.reads.length > 0, // Per-user read state
      isResolved: alert.isResolved,
      isPinned: alert.isPinned,
      createdAt: alert.createdAt,
      updatedAt: alert.updatedAt
    }));

    res.json({
      success: true,
      data: {
        alerts: formattedAlerts,
        unreadCount
      }
    });
  } catch (error: any) {
    res.status(500).json({ success: false, message: 'Failed to fetch alerts', error: error.message });
  }
};

export const markAsRead = async (req: Request, res: Response) => {
  try {
    const { clientId, id: userId } = (req as any).user;
    const { id } = req.params;

    const alert = await prisma.inventoryAlert.findFirst({
      where: { id: id as string, clientId }
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
    res.status(500).json({ success: false, message: 'Failed to update alert', error: error.message });
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
    res.status(500).json({ success: false, message: 'Failed to update alerts', error: error.message });
  }
};

export const togglePin = async (req: Request, res: Response) => {
  try {
    const { clientId } = (req as any).user;
    const { id } = req.params;

    const alert = await prisma.inventoryAlert.findFirst({
      where: { id: id as string, clientId }
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
    res.status(500).json({ success: false, message: 'Failed to update alert', error: error.message });
  }
};

export const deleteAlert = async (req: Request, res: Response) => {
  try {
    const { clientId } = (req as any).user;
    const { id } = req.params;

    const alert = await prisma.inventoryAlert.findFirst({
      where: { id: id as string, clientId }
    });

    if (!alert) {
      return res.status(404).json({ success: false, message: 'Alert not found' });
    }

    await prisma.inventoryAlert.delete({ where: { id: id as string } });

    res.json({ success: true, message: 'Alert dismissed' });
  } catch (error: any) {
    res.status(500).json({ success: false, message: 'Failed to delete alert', error: error.message });
  }
};
