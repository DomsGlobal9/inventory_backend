import { Router, Request, Response } from 'express';
import { prisma } from '../lib/prisma';

import { usageCountsForClient, usageCountFor } from '../services/catalog-usage.service';
import { tenantMiddleware } from '../middleware/tenant.middleware';
import { requirePermission } from '../middleware/permission.middleware';

const router = Router();
router.use(tenantMiddleware);

// GET /api/v1/catalog/config
// Returns all active catalog config values grouped by type for the current tenant
router.get('/config', requirePermission('product:view'), async (req: Request, res: Response) => {
  try {
    const clientId = (req as any).clientId;

    const items = await prisma.clientCatalogItem.findMany({
      where: { 
        clientId,
        isActive: true 
      },
      orderBy: [{ type: 'asc' }, { sortOrder: 'asc' }],
      select: {
        type: true,
        value: true,
        label: true,
        category: true,
        metadata: true,
        sortOrder: true,
      }
    });

    // Group by type
    const grouped = items.reduce((acc: Record<string, any[]>, item: any) => {
      if (!acc[item.type]) acc[item.type] = [];
      acc[item.type].push(item);
      return acc;
    }, {});

    res.json({ success: true, data: grouped });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to load catalog config' });
  }
});

// GET /api/v1/catalog/items
// Returns all items (active and inactive) for the current tenant
router.get('/items', requirePermission('product:view'), async (req: Request, res: Response) => {
  try {
    const clientId = (req as any).clientId;

    const items = await prisma.clientCatalogItem.findMany({
      where: { clientId },
      orderBy: [{ type: 'asc' }, { sortOrder: 'asc' }],
    });

    // Seven grouped queries for the whole catalogue, rather than one count per entry. See
    // catalog-usage.service.ts -- a typical tenant has 72 entries, and this screen used to
    // open 72 simultaneous counts against a pool of about 17.
    const usage = await usageCountsForClient(clientId);
    const itemsWithUsage = items.map(item => ({
      ...item,
      usageCount: usage.get(`${item.type}:${item.value}`) ?? 0
    }));

    res.json({ success: true, data: itemsWithUsage });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to load catalog items' });
  }
});

// POST /api/v1/catalog/items
// Add a new custom item for the client
router.post('/items', requirePermission('admin:catalog'), async (req: Request, res: Response) => {
  try {
    const clientId = (req as any).clientId;
    const { type, value, label, category, metadata, sortOrder } = req.body;

    const item = await prisma.clientCatalogItem.create({
      data: {
        clientId,
        type,
        value,
        label,
        category,
        metadata,
        sortOrder: sortOrder || 0,
        isSystem: false,
        isActive: true,
      }
    });

    res.status(201).json({ success: true, data: item });
  } catch (error: any) {
    res.status(500).json({ success: false, message: 'Failed to create catalog item', error: error.message });
  }
});

// PATCH /api/v1/catalog/items/:id
// Update an existing item (e.g., label, sortOrder, isActive)
router.patch('/items/:id', requirePermission('admin:catalog'), async (req: Request, res: Response) => {
  try {
    const clientId = (req as any).clientId;
    const id = req.params.id as string;
    const { label, value, category, metadata, sortOrder, isActive } = req.body;

    // Ensure item belongs to client
    const existing = await prisma.clientCatalogItem.findFirst({
      where: { id, clientId }
    });

    if (!existing) {
      return res.status(404).json({ success: false, message: 'Item not found' });
    }

    const item = await prisma.clientCatalogItem.update({
      where: { id },
      data: {
        label: label !== undefined ? label : existing.label,
        value: value !== undefined ? value : existing.value,
        category: category !== undefined ? category : existing.category,
        metadata: metadata !== undefined ? metadata : existing.metadata,
        sortOrder: sortOrder !== undefined ? sortOrder : existing.sortOrder,
        isActive: isActive !== undefined ? isActive : existing.isActive,
      }
    });

    res.json({ success: true, data: item });
  } catch (error: any) {
    res.status(500).json({ success: false, message: 'Failed to update catalog item', error: error.message });
  }
});

// DELETE /api/v1/catalog/items/:id
// Soft delete an item
router.delete('/items/:id', requirePermission('admin:catalog'), async (req: Request, res: Response) => {
  try {
    const clientId = (req as any).clientId;
    const id = req.params.id as string;

    // Ensure item belongs to client
    const existing = await prisma.clientCatalogItem.findFirst({
      where: { id, clientId }
    });

    if (!existing) {
      return res.status(404).json({ success: false, message: 'Item not found' });
    }

    // Read fresh rather than trusted from the browser: the count the screen was showing may
    // be minutes old, and someone else may have used this colour since.
    const usageCount = await usageCountFor(clientId, existing.type, existing.value);
    
    if (usageCount > 0) {
      return res.status(400).json({ 
        success: false, 
        message: `Cannot delete this item. It is currently used by ${usageCount} products/variants. Disable it instead.` 
      });
    }

    const item = await prisma.clientCatalogItem.delete({
      where: { id }
    });

    res.json({ success: true, message: 'Item deleted successfully', data: item });
  } catch (error: any) {
    res.status(500).json({ success: false, message: 'Failed to delete catalog item', error: error.message });
  }
});

export default router;
