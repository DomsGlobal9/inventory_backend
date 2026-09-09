import { Router } from 'express';
import { returnService } from '../services/return.service';
import { tenantMiddleware } from '../middleware/tenant.middleware';

import { requirePermission } from '../middleware/permission.middleware';
import { createReturnSchema, inspectReturnSchema } from '../validations/return.schema';
import { ZodError } from 'zod';

export const returnsRoutes = Router();

returnsRoutes.use(tenantMiddleware);

/**
 * What the caller is told when something goes wrong.
 *
 * Every handler here used to answer with `error.message`, which for a Prisma failure is the
 * whole invocation -- table names, column names, the data being written. That is a map of the
 * database handed to anyone who can reach the endpoint, and it tells the person who made the
 * mistake nothing useful either.
 *
 * A validation failure gets the field and a sentence. Anything the service raised
 * deliberately ("Sales order not found") is already written for a person and passes through.
 * Anything else is logged for us and reduced to a sentence for them.
 */
function fail(res: any, error: any) {
  if (error instanceof ZodError) {
    return res.status(400).json({
      success: false,
      message: error.errors[0]?.message || 'That request was not valid',
      errors: error.errors.map(e => ({ field: e.path.join('.'), message: e.message }))
    });
  }

  // Prisma puts its query dump in `message`, and its errors carry a code; anything with one
  // is machinery, not a sentence somebody wrote to be read.
  const isInternal = !!error?.code || /prisma|invocation|Argument `/i.test(error?.message || '');
  if (isInternal) {
    console.error('returns:', error);
    return res.status(400).json({ success: false, message: 'That return could not be saved. Check the lines and try again.' });
  }

  return res.status(400).json({ success: false, message: error?.message || 'That return could not be saved' });
}

returnsRoutes.get('/', requirePermission('return:view'), async (req, res) => {
  try {
    const clientId = (req as any).clientId as string;
    const returns = await returnService.getReturns(clientId);
    res.json({ data: returns });
  } catch (error: any) {
    res.status(500).json({ message: error.message });
  }
});

returnsRoutes.get('/:id', requirePermission('return:view'), async (req, res) => {
  try {
    const clientId = (req as any).clientId as string;
    const ret = await returnService.getReturnById(clientId, req.params.id as string);
    res.json({ data: ret });
  } catch (error: any) {
    if (error.message === 'Return not found') {
      res.status(404).json({ message: error.message });
    } else {
      res.status(500).json({ message: error.message });
    }
  }
});

returnsRoutes.post('/', requirePermission('return:create'), async (req, res) => {
  try {
    const clientId = (req as any).clientId as string;
    const { salesOrderId, items, notes } = createReturnSchema.parse(req.body);
    const newReturn = await returnService.createReturn(clientId, salesOrderId, items as any, notes ?? undefined);
    res.status(201).json({ data: newReturn });
  } catch (error: any) {
    return fail(res, error);
  }
});

returnsRoutes.post('/:id/receive', requirePermission('return:receive'), async (req, res) => {
  try {
    const clientId = (req as any).clientId as string;
    const updated = await returnService.receiveReturn(clientId, req.params.id as string);
    res.json({ data: updated });
  } catch (error: any) {
    return fail(res, error);
  }
});

returnsRoutes.post('/:id/inspect', requirePermission('return:inspect'), async (req, res) => {
  try {
    const clientId = (req as any).clientId as string;
    const { itemsDisposition } = inspectReturnSchema.parse(req.body);
    const updated = await returnService.inspectReturn(clientId, req.params.id as string, itemsDisposition as any);
    res.json({ data: updated });
  } catch (error: any) {
    return fail(res, error);
  }
});

returnsRoutes.post('/:id/complete', requirePermission('return:complete'), async (req, res) => {
  try {
    const clientId = (req as any).clientId as string;
    const updated = await returnService.completeReturn(clientId, req.params.id as string);
    res.json({ data: updated });
  } catch (error: any) {
    return fail(res, error);
  }
});

returnsRoutes.post('/:id/reject', requirePermission('return:complete'), async (req, res) => {
  try {
    const clientId = (req as any).clientId as string;
    const updated = await returnService.rejectReturn(clientId, req.params.id as string);
    res.json({ data: updated });
  } catch (error: any) {
    return fail(res, error);
  }
});
