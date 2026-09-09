/**
 * The roles API.
 *
 * Thin on purpose: every rule about what a role may hold is in services/role-management, so
 * that a second caller -- the platform console, a future setup wizard -- cannot get a different
 * answer by going through a different door.
 */
import { Request, Response } from 'express';
import * as roles from '../services/role-management';

/** The editing identity, exactly as the auth middleware left it. */
function actor(req: Request): roles.Actor {
  const user = (req as any).user;
  return {
    clientId: user.clientId,
    userId: user.id,
    permissions: user.permissions || [],
    roles: user.roles || []
  };
}

const handle = (res: Response, error: any, fallback: string) =>
  res.status(error?.statusCode || 500).json({
    success: false,
    message: error?.message || fallback,
    // The screen needs to tell "rename it" apart from "move these people first".
    code: error?.code
  });

export const listRoles = async (req: Request, res: Response) => {
  try {
    res.json({ success: true, data: await roles.listRoles(actor(req)) });
  } catch (error: any) {
    handle(res, error, 'Failed to load roles');
  }
};

export const getCatalogue = async (req: Request, res: Response) => {
  try {
    res.json({ success: true, data: roles.getCatalogue(actor(req)) });
  } catch (error: any) {
    handle(res, error, 'Failed to load the permission list');
  }
};

export const createRole = async (req: Request, res: Response) => {
  try {
    res.status(201).json({ success: true, data: await roles.createRole(actor(req), req.body ?? {}) });
  } catch (error: any) {
    handle(res, error, 'Failed to create the role');
  }
};

export const updateRole = async (req: Request, res: Response) => {
  try {
    res.json({ success: true, data: await roles.updateRole(actor(req), req.params.id as string, req.body ?? {}) });
  } catch (error: any) {
    handle(res, error, 'Failed to save the role');
  }
};

/**
 * Who a change would affect, before it is made.
 *
 * Accepts the proposed permission list so the screen can say "3 people will lose the ability to
 * see what the business paid" while the person is still deciding, rather than afterwards.
 */
export const roleImpact = async (req: Request, res: Response) => {
  try {
    const proposed = Array.isArray(req.body?.permissions) ? req.body.permissions : undefined;
    res.json({ success: true, data: await roles.roleImpact(actor(req), req.params.id as string, proposed) });
  } catch (error: any) {
    handle(res, error, 'Failed to work out who this affects');
  }
};

export const deleteRole = async (req: Request, res: Response) => {
  try {
    res.json({ success: true, data: await roles.deleteRole(actor(req), req.params.id as string) });
  } catch (error: any) {
    handle(res, error, 'Failed to delete the role');
  }
};
