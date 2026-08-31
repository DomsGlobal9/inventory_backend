import { Request, Response } from 'express';
import { prisma } from '../lib/prisma';

export const getAlerts = async (req: Request, res: Response) => {
  try {
    const { clientId } = req.user!;
    const { status = 'active', locationId } = req.query;

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
        }
      }
    });

    const unreadCount = await prisma.inventoryAlert.count({
      where: {
        ...where,
        isRead: false
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
      isRead: alert.isRead,
      isResolved: alert.isResolved,
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
    const { clientId } = req.user!;
    const { id } = req.params;

    const alert = await prisma.inventoryAlert.findFirst({
      where: { id, clientId }
    });

    if (!alert) {
      return res.status(404).json({ success: false, message: 'Alert not found' });
    }

    await prisma.inventoryAlert.update({
      where: { id },
      data: { isRead: true }
    });

    res.json({ success: true, message: 'Alert marked as read' });
  } catch (error: any) {
    res.status(500).json({ success: false, message: 'Failed to update alert', error: error.message });
  }
};

export const markAllAsRead = async (req: Request, res: Response) => {
  try {
    const { clientId } = req.user!;
    const { locationId } = req.body;

    const where: any = { clientId, isRead: false, isResolved: false };
    if (locationId) {
      where.locationId = locationId;
    }

    await prisma.inventoryAlert.updateMany({
      where,
      data: { isRead: true }
    });

    res.json({ success: true, message: 'All active alerts marked as read' });
  } catch (error: any) {
    res.status(500).json({ success: false, message: 'Failed to update alerts', error: error.message });
  }
};
