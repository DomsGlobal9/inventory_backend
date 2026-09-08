import { Request, Response } from 'express';
import { prisma } from '../lib/prisma';
import { AuthService } from '../services/auth.service';
import { platformAdminService } from '../services/platform-admin.service';
import { authCookieOptions, platformAdminCookieOptions, clearCookieOptions } from '../lib/cookies';

const cookieOptions = platformAdminCookieOptions;

export const login = async (req: Request, res: Response) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ success: false, message: 'Missing credentials' });
    }

    const admin = await prisma.platformAdmin.findUnique({ where: { email } });
    if (!admin || admin.status !== 'ACTIVE') {
      return res.status(401).json({ success: false, message: 'Invalid credentials or inactive admin' });
    }

    const isValid = await AuthService.comparePassword(password, admin.password);
    if (!isValid) {
      return res.status(401).json({ success: false, message: 'Invalid credentials' });
    }

    const token = AuthService.generatePlatformAdminToken({ platformAdminId: admin.id });
    res.cookie('platform_admin_token', token, cookieOptions);

    res.json({ success: true, data: { admin: { id: admin.id, name: admin.name, email: admin.email } } });
  } catch (error: any) {
    res.status(500).json({ success: false, message: 'Login failed', error: error.message });
  }
};

export const logout = async (req: Request, res: Response) => {
  // Signing out of the console MUST also drop the client `token` cookie that
  // assumeClient minted. That cookie is a fully-privileged 24h tenant session and
  // authenticates on its own, so clearing only platform_admin_token left whoever
  // used the machine next signed in as the last-impersonated boutique's Super Admin.
  //
  // maxAge is deliberately omitted from the clear options: clearCookie merges the
  // caller's options over its own `expires: new Date(1)`, and res.cookie then
  // recomputes expires from maxAge -- so passing the 8h cookieOptions through
  // re-issued the cookie for another 8 hours instead of deleting it.
  const clearOptions = clearCookieOptions;

  try {
    const token = req.cookies?.platform_admin_token;
    if (token) {
      const decoded = AuthService.verifyPlatformAdminToken(token);
      if (decoded?.sub) await platformAdminService.endOpenSessionsForAdmin(decoded.sub);
    }
  } catch {
    // An expired/invalid token still deserves a clean logout -- never block it.
  }

  res.clearCookie('platform_admin_token', clearOptions);
  res.clearCookie('token', clearOptions);
  res.json({ success: true, message: 'Logged out successfully' });
};

export const session = async (req: Request, res: Response) => {
  const admin = (req as any).platformAdmin;
  res.json({ success: true, authenticated: true, admin });
};

export const listClients = async (_req: Request, res: Response) => {
  try {
    const clients = await platformAdminService.listClients();
    res.json({ success: true, data: clients });
  } catch (error: any) {
    res.status(500).json({ success: false, message: 'Failed to load clients', error: error.message });
  }
};

export const listAllUsers = async (_req: Request, res: Response) => {
  try {
    const users = await platformAdminService.listAllUsers();
    res.json({ success: true, data: users });
  } catch (error: any) {
    res.status(500).json({ success: false, message: 'Failed to load users', error: error.message });
  }
};

export const onboardClient = async (req: Request, res: Response) => {
  try {
    const { companyName, adminName, adminEmail } = req.body;
    if (!companyName || !adminName || !adminEmail) {
      return res.status(400).json({ success: false, message: 'companyName, adminName, and adminEmail are required' });
    }

    const result = await platformAdminService.onboardClient(companyName, adminName, adminEmail);
    res.status(201).json({ success: true, data: result });
  } catch (error: any) {
    res.status(500).json({ success: false, message: 'Failed to onboard client', error: error.message });
  }
};

export const getClient = async (req: Request, res: Response) => {
  try {
    const clientId = req.params.clientId as string;
    const [summary, users] = await Promise.all([
      platformAdminService.getClientSummary(clientId),
      platformAdminService.getClientUsers(clientId)
    ]);
    // A clientId is only real if users exist under it -- there's no Client table to check
    // against. Without this, a mistyped URL or a chip pointing at an emptied tenant
    // rendered a convincing but entirely fabricated overview (0 users, Rs 0, "Not
    // Started") complete with a live "View Inventory Data" button. This mirrors the guard
    // assumeClient already applies.
    if (summary.userCount === 0) {
      return res.status(404).json({ success: false, message: 'Client not found' });
    }

    res.json({ success: true, data: { ...summary, users } });
  } catch (error: any) {
    res.status(500).json({ success: false, message: 'Failed to load client', error: error.message });
  }
};

export const assumeClient = async (req: Request, res: Response) => {
  try {
    const clientId = req.params.clientId as string;
    const platformAdminId = (req as any).platformAdmin.id;

    const candidates = await prisma.user.findMany({
      where: { clientId, status: 'ACTIVE' },
      include: { roles: { include: { role: true } } },
      orderBy: { createdAt: 'asc' }
    });

    if (candidates.length === 0) {
      return res.status(404).json({ success: false, message: 'No active users found for this client' });
    }

    const superAdminUser = candidates.find((u: any) => u.roles.some((ur: any) => ur.role.name === 'SUPER_ADMIN'));
    const assumedUser = superAdminUser || candidates[0];

    const session = await platformAdminService.assumeClient(platformAdminId, clientId);

    const clientToken = AuthService.generateToken({ userId: assumedUser.id, clientId });
    res.cookie('token', clientToken, authCookieOptions);

    res.json({
      success: true,
      data: {
        sessionId: session.id,
        clientId,
        assumedAsFullAccess: !!superAdminUser
      }
    });
  } catch (error: any) {
    res.status(500).json({ success: false, message: 'Failed to assume client session', error: error.message });
  }
};

export const endAssumedSession = async (req: Request, res: Response) => {
  try {
    const sessionId = req.params.sessionId as string;
    await platformAdminService.endAssumedSession(sessionId);
    res.clearCookie('token', cookieOptions);
    res.json({ success: true, message: 'Assumed session ended' });
  } catch (error: any) {
    res.status(500).json({ success: false, message: 'Failed to end session', error: error.message });
  }
};

export const listAuditLog = async (_req: Request, res: Response) => {
  try {
    const log = await platformAdminService.listAuditLog();
    res.json({ success: true, data: log });
  } catch (error: any) {
    res.status(500).json({ success: false, message: 'Failed to load audit log', error: error.message });
  }
};

export const listClientErrors = async (_req: Request, res: Response) => {
  try {
    const errors = await platformAdminService.listClientErrors();
    res.json({ success: true, data: errors });
  } catch (error: any) {
    res.status(500).json({ success: false, message: 'Failed to load client errors', error: error.message });
  }
};

export const listSupportTickets = async (_req: Request, res: Response) => {
  try {
    const tickets = await platformAdminService.listAllSupportTickets();
    res.json({ success: true, data: tickets });
  } catch (error: any) {
    res.status(500).json({ success: false, message: 'Failed to load support tickets', error: error.message });
  }
};

export const getSupportTicket = async (req: Request, res: Response) => {
  try {
    const ticket = await platformAdminService.getSupportTicket(req.params.id as string);
    if (!ticket) return res.status(404).json({ success: false, message: 'Ticket not found' });
    res.json({ success: true, data: ticket });
  } catch (error: any) {
    res.status(500).json({ success: false, message: 'Failed to load ticket', error: error.message });
  }
};

export const replyToSupportTicket = async (req: Request, res: Response) => {
  try {
    const admin = (req as any).platformAdmin;
    const { body } = req.body;
    if (!body) return res.status(400).json({ success: false, message: 'body is required' });

    const message = await platformAdminService.replyToSupportTicket(req.params.id as string, admin.name, body);
    if (!message) return res.status(404).json({ success: false, message: 'Ticket not found' });
    res.status(201).json({ success: true, data: message });
  } catch (error: any) {
    res.status(500).json({ success: false, message: 'Failed to send reply', error: error.message });
  }
};

export const updateSupportTicketStatus = async (req: Request, res: Response) => {
  try {
    const { status } = req.body;
    if (!['OPEN', 'IN_PROGRESS', 'RESOLVED', 'CLOSED'].includes(status)) {
      return res.status(400).json({ success: false, message: 'Invalid status' });
    }
    const ticket = await platformAdminService.updateSupportTicketStatus(req.params.id as string, status);
    res.json({ success: true, data: ticket });
  } catch (error: any) {
    res.status(500).json({ success: false, message: 'Failed to update ticket', error: error.message });
  }
};

export const viewUserPassword = async (req: Request, res: Response) => {
  try {
    const result = await platformAdminService.viewUserPassword(req.params.id as string);
    res.json({ success: true, data: result });
  } catch (error: any) {
    res.status(error.statusCode || 500).json({ success: false, message: error.message || 'Failed to view password' });
  }
};

export const setUserPassword = async (req: Request, res: Response) => {
  try {
    const { customPassword } = req.body;
    const result = await platformAdminService.setUserPassword(req.params.id as string, customPassword);
    res.json({ success: true, data: result });
  } catch (error: any) {
    res.status(error.statusCode || 500).json({ success: false, message: error.message || 'Failed to set password' });
  }
};

// ─── PLATFORM ADMINS ──────────────────────────────────────────────────────────
// Every account here can read and act on every tenant, so these are deliberately few and
// explicit: list, add, activate/deactivate, and issue a new password. There is no "view
// password" -- none is stored in a recoverable form.

export const listPlatformAdmins = async (_req: Request, res: Response) => {
  try {
    res.json({ success: true, data: await platformAdminService.listPlatformAdmins() });
  } catch (error: any) {
    res.status(error.statusCode || 500).json({ success: false, message: error.message || 'Failed to list platform admins' });
  }
};

export const createPlatformAdmin = async (req: Request, res: Response) => {
  try {
    const { name, email, customPassword } = req.body ?? {};
    if (!name?.trim() || !email?.trim()) {
      return res.status(400).json({ success: false, message: 'Name and email are required' });
    }
    const result = await platformAdminService.createPlatformAdmin({ name, email, customPassword });
    res.status(201).json({ success: true, data: result });
  } catch (error: any) {
    res.status(error.statusCode || 500).json({ success: false, message: error.message || 'Failed to add platform admin' });
  }
};

export const setPlatformAdminStatus = async (req: Request, res: Response) => {
  try {
    const { status } = req.body ?? {};
    if (status !== 'ACTIVE' && status !== 'INACTIVE') {
      return res.status(400).json({ success: false, message: 'Status must be ACTIVE or INACTIVE' });
    }
    const result = await platformAdminService.setPlatformAdminStatus({
      adminId: req.params.id as string,
      status,
      // Guards against locking yourself out, so it needs to know who is asking.
      requesterId: (req as any).platformAdmin?.id
    });
    res.json({ success: true, data: result });
  } catch (error: any) {
    res.status(error.statusCode || 500).json({ success: false, message: error.message || 'Failed to update platform admin' });
  }
};

export const resetPlatformAdminPassword = async (req: Request, res: Response) => {
  try {
    const result = await platformAdminService.resetPlatformAdminPassword({
      adminId: req.params.id as string,
      customPassword: req.body?.customPassword
    });
    res.json({ success: true, data: result });
  } catch (error: any) {
    res.status(error.statusCode || 500).json({ success: false, message: error.message || 'Failed to reset the password' });
  }
};

// ─── SUSPEND AND DELETE A CLIENT ──────────────────────────────────────────────

export const setClientSuspended = async (req: Request, res: Response) => {
  try {
    const { suspended } = req.body ?? {};
    if (typeof suspended !== 'boolean') {
      return res.status(400).json({ success: false, message: 'suspended must be true or false' });
    }
    const result = await platformAdminService.setClientSuspended(req.params.clientId as string, suspended);
    res.json({ success: true, data: result });
  } catch (error: any) {
    res.status(error.statusCode || 500).json({ success: false, message: error.message || 'Failed to update the client' });
  }
};

/** What a deletion would destroy. Read before anyone is asked to confirm it. */
export const previewClientDeletion = async (req: Request, res: Response) => {
  try {
    res.json({ success: true, data: await platformAdminService.previewClientDeletion(req.params.clientId as string) });
  } catch (error: any) {
    res.status(error.statusCode || 500).json({ success: false, message: error.message || 'Failed to read the client' });
  }
};

/**
 * Erases a client.
 *
 * The confirmation text must equal the client id exactly, and it is checked HERE as well as in
 * the service. Two checks for one rule looks redundant until you consider what each protects
 * against: this one stops a request that never went through the UI, and the service's stops a
 * future caller of our own from skipping the ceremony.
 *
 * DELETE with a body rather than a query parameter, so the confirmation cannot end up in a
 * server access log, a browser history entry, or a link someone can be tricked into following.
 */
export const deleteClient = async (req: Request, res: Response) => {
  try {
    const clientId = req.params.clientId as string;
    const { confirmation } = req.body ?? {};

    if (confirmation !== clientId) {
      return res.status(400).json({
        success: false,
        message: `Type the client id exactly to confirm: ${clientId}`
      });
    }

    const admin = (req as any).platformAdmin;
    // Logged before the attempt, not after. If this goes wrong mid-way there must still be a
    // record of who asked for it and when.
    console.warn(`[DeleteClient] ${admin?.email ?? 'unknown admin'} is erasing client "${clientId}"`);

    const result = await platformAdminService.deleteClientCompletely(clientId, confirmation);
    console.warn(`[DeleteClient] "${clientId}" erased by ${admin?.email ?? 'unknown admin'}`);

    res.json({ success: true, data: result });
  } catch (error: any) {
    console.error('[DeleteClient] failed and rolled back:', error?.message);
    res.status(error.statusCode || 500).json({ success: false, message: error.message || 'Failed to delete the client' });
  }
};
