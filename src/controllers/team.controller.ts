import { Request, Response } from 'express';
import { teamService } from '../services/team.service';
import { recordCredentialDisclosure } from '../services/credential-audit';
import { holdsEverything } from '../config/permissions';

/**
 * Whether this identity is the account owner.
 *
 * Not a permission check -- it is the hierarchy rule that stops an Admin reading the OWNER's
 * password, or resetting it and taking the account. It reads the '*' grant rather than the role
 * NAME it used to read, so a shop that renames its owner role, or has two of them, still works,
 * and so that authority lives in one place: a row somebody granted.
 */
function isSuperAdmin(req: Request) {
  const user = (req as any).user;
  return holdsEverything(user?.permissions, user?.roles);
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

/**
 * Reads a team member's password in plain text.
 *
 * Every call leaves a record naming the actor, the account it was about, when, from where, and
 * why -- including the calls that were refused, which the general activity logger drops because
 * it ignores anything that returned an error.
 *
 * The record is written BEFORE the password is returned, and if it cannot be written the
 * password is not returned. Audit logging normally must not be able to fail a request; this is
 * the exception, because a disclosure nobody can prove is worse than one that did not happen.
 */
export const viewMemberPassword = async (req: Request, res: Response) => {
  const user = (req as any).user;
  const targetUserId = req.params.id as string;
  const reason = typeof req.body?.reason === 'string' ? req.body.reason : undefined;
  const context = {
    clientId: user?.clientId,
    actorUserId: user?.id,
    actorEmail: user?.email,
    targetUserId,
    credential: 'PASSWORD' as const,
    reason,
    requestId: (req as any).requestId,
    ipAddress: req.ip
  };

  let result;
  try {
    result = await teamService.viewMemberPassword({
      clientId: user.clientId, userId: targetUserId, requesterIsSuperAdmin: isSuperAdmin(req)
    });
  } catch (error: any) {
    // The refusal is the interesting event. Recorded on a best-effort basis: the request is
    // already failing, and losing the log line must not turn a 403 into a 500 that reads like
    // a bug in the guard.
    await recordCredentialDisclosure({ ...context, outcome: 'REFUSED', refusedBecause: error?.message })
      .catch(err => console.error('credential-audit: failed to record a refused password view', err));
    return res.status(error.statusCode || 500)
      .json({ success: false, message: error.message || 'Failed to view password' });
  }

  try {
    await recordCredentialDisclosure({ ...context, targetEmail: result.email, outcome: 'DISCLOSED' });
  } catch (err) {
    console.error('credential-audit: refusing to disclose a password that cannot be logged', err);
    return res.status(503).json({
      success: false,
      message: 'Could not record who viewed this password, so it was not shown. Try again.'
    });
  }

  res.json({ success: true, data: result });
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

/**
 * Sends a team member their existing login again.
 *
 * POST rather than GET for the same reason as viewing a password: it discloses a credential
 * and causes a side effect, so it belongs in the audit log rather than in a link someone can
 * prefetch.
 */
export const resendMemberCredentials = async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const result = await teamService.resendCredentials({
      clientId: user.clientId, userId: req.params.id as string, requesterIsSuperAdmin: isSuperAdmin(req)
    });
    res.json({ success: true, data: result });
  } catch (error: any) {
    res.status(error.statusCode || 500).json({ success: false, message: error.message || 'Failed to resend the login' });
  }
};
