import { Request, Response } from 'express';
import { teamService } from '../services/team.service';

function isSuperAdmin(req: Request) {
  return !!(req as any).user?.roles?.includes('SUPER_ADMIN');
}

export const listMembers = async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const members = await teamService.listMembers(user.clientId);
    res.json({ success: true, data: members });
  } catch (error: any) {
    res.status(500).json({ success: false, message: 'Failed to load team members', error: error.message });
  }
};

export const listRoles = async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const roles = await teamService.listRoles(user.clientId);
    res.json({ success: true, data: roles });
  } catch (error: any) {
    res.status(500).json({ success: false, message: 'Failed to load roles', error: error.message });
  }
};

export const listActivity = async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const activity = await teamService.listActivity(user.clientId);
    res.json({ success: true, data: activity });
  } catch (error: any) {
    res.status(500).json({ success: false, message: 'Failed to load activity', error: error.message });
  }
};

export const inviteMember = async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const { name, email, roleId, customPassword } = req.body;
    if (!name || !email || !roleId) {
      return res.status(400).json({ success: false, message: 'name, email, and roleId are required' });
    }

    const result = await teamService.inviteMember({
      clientId: user.clientId, name, email, roleId, customPassword, requesterIsSuperAdmin: isSuperAdmin(req)
    });
    res.status(201).json({ success: true, data: result });
  } catch (error: any) {
    res.status(error.statusCode || 500).json({ success: false, message: error.message || 'Failed to add team member' });
  }
};

export const updateMemberRole = async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const { roleId } = req.body;
    if (!roleId) return res.status(400).json({ success: false, message: 'roleId is required' });

    const result = await teamService.updateMemberRole({
      clientId: user.clientId, userId: req.params.id as string, roleId, requesterIsSuperAdmin: isSuperAdmin(req)
    });
    res.json({ success: true, data: result });
  } catch (error: any) {
    res.status(error.statusCode || 500).json({ success: false, message: error.message || 'Failed to update role' });
  }
};

export const setMemberStatus = async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const { status } = req.body;
    if (!['ACTIVE', 'INACTIVE'].includes(status)) {
      return res.status(400).json({ success: false, message: 'status must be ACTIVE or INACTIVE' });
    }

    const result = await teamService.setMemberStatus({
      clientId: user.clientId, userId: req.params.id as string, status, requesterUserId: user.id, requesterIsSuperAdmin: isSuperAdmin(req)
    });
    res.json({ success: true, data: result });
  } catch (error: any) {
    res.status(error.statusCode || 500).json({ success: false, message: error.message || 'Failed to update status' });
  }
};

export const viewMemberPassword = async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const result = await teamService.viewMemberPassword({
      clientId: user.clientId, userId: req.params.id as string, requesterIsSuperAdmin: isSuperAdmin(req)
    });
    res.json({ success: true, data: result });
  } catch (error: any) {
    res.status(error.statusCode || 500).json({ success: false, message: error.message || 'Failed to view password' });
  }
};

export const setMemberPassword = async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const { customPassword } = req.body;
    const result = await teamService.setMemberPassword({
      clientId: user.clientId, userId: req.params.id as string, customPassword, requesterIsSuperAdmin: isSuperAdmin(req)
    });
    res.json({ success: true, data: result });
  } catch (error: any) {
    res.status(error.statusCode || 500).json({ success: false, message: error.message || 'Failed to set password' });
  }
};
