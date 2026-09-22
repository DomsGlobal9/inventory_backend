import { Router } from 'express';
import { verifyPlatformAdmin } from '../middleware/platform-admin.middleware';
import { links, LinkRuleError } from '../services/links';
import {
  login,
  logout,
  session,
  listClients,
  listAllUsers,
  onboardClient,
  getClient,
  assumeClient,
  endAssumedSession,
  listAuditLog,
  listClientErrors,
  listSupportTickets,
  getSupportTicket,
  replyToSupportTicket,
  updateSupportTicketStatus,
  viewUserPassword,
  setUserPassword,
  listPlatformAdmins,
  createPlatformAdmin,
  setPlatformAdminStatus,
  resetPlatformAdminPassword,
  setClientSuspended,
  previewClientDeletion,
  deleteClient,
  getClientServiceKeys,
  setClientServiceKey,
  revokeClientServiceKey,
  getClientTryOnUsage,
  setClientTryOnLimit,
  getOffersHealth
} from '../controllers/platform-admin.controller';
import { listLeads, updateLead, convertLead } from '../controllers/lead.controller';
import { platformAuditLogger } from '../middleware/platform-audit.middleware';

const authRouter = Router();
authRouter.post('/login', login);
authRouter.post('/logout', logout);
authRouter.get('/session', verifyPlatformAdmin, session);

const consoleRouter = Router();
consoleRouter.use(verifyPlatformAdmin);
// Immediately after the identity check and before any route, so every console mutation is
// recorded -- including ones added later by someone who has not read this file.
consoleRouter.use(platformAuditLogger);
consoleRouter.get('/clients', listClients);
consoleRouter.post('/clients', onboardClient);
consoleRouter.get('/users', listAllUsers);
consoleRouter.get('/clients/:clientId', getClient);
consoleRouter.post('/clients/:clientId/assume', assumeClient);
// Cutting a client off, and erasing one. Kept next to each other deliberately: suspending is
// the reversible answer to almost every reason someone reaches for deleting.
consoleRouter.patch('/clients/:clientId/suspend', setClientSuspended);
consoleRouter.get('/clients/:clientId/deletion-preview', previewClientDeletion);
consoleRouter.delete('/clients/:clientId', deleteClient);
// A client's keys for platform services. Generated in the gateway, pasted here.
consoleRouter.get('/clients/:clientId/service-keys', getClientServiceKeys);
consoleRouter.post('/clients/:clientId/service-keys', setClientServiceKey);
consoleRouter.delete('/clients/:clientId/service-keys', revokeClientServiceKey);
// Usage against allowance, and setting that allowance.
consoleRouter.get('/clients/:clientId/tryon-usage', getClientTryOnUsage);
consoleRouter.patch('/clients/:clientId/tryon-limit', setClientTryOnLimit);
consoleRouter.post('/sessions/:sessionId/end', endAssumedSession);
// Managing who can reach this console at all.
consoleRouter.get('/platform-admins', listPlatformAdmins);
consoleRouter.post('/platform-admins', createPlatformAdmin);
consoleRouter.patch('/platform-admins/:id/status', setPlatformAdminStatus);
consoleRouter.post('/platform-admins/:id/password', resetPlatformAdminPassword);
consoleRouter.get('/audit-log', listAuditLog);
consoleRouter.get('/client-errors', listClientErrors);
// Offers and Shopify across every shop: copies failing, orders waiting, codes run out. Read only.
consoleRouter.get('/offers-health', getOffersHealth);
consoleRouter.get('/support-tickets', listSupportTickets);
consoleRouter.get('/support-tickets/:id', getSupportTicket);
consoleRouter.post('/support-tickets/:id/messages', replyToSupportTicket);
consoleRouter.patch('/support-tickets/:id', updateSupportTicketStatus);
// Recovery path of last resort -- see the comment on viewUserPassword in
// platform-admin.service.ts. A platform admin outranks every client role, so no per-client
// hierarchy guard applies (unlike team.routes.ts's equivalent, client-scoped endpoints).
consoleRouter.post('/users/:id/password/view', viewUserPassword);
consoleRouter.post('/users/:id/password', setUserPassword);

// Signup enquiries. Reading and triaging them is ordinary console work; converting one runs
// the same onboarding as the Onboarding screen and is the only path that creates a tenant
// from a lead -- the public form itself provisions nothing.
consoleRouter.get('/leads', listLeads);
consoleRouter.patch('/leads/:id', updateLead);
consoleRouter.post('/leads/:id/convert', convertLead);

// Short links: look one up from a reported code, and switch it off (a scam) or on again. The
// visitor then sees a plain "not available" page, never the reason.
const linkAction = (fn: (req: any) => Promise<unknown>) => async (req: any, res: any, next: any) => {
  try {
    res.json({ success: true, data: await fn(req) });
  } catch (e) {
    if (e instanceof LinkRuleError) return res.status(400).json({ success: false, message: e.message });
    next(e);
  }
};
consoleRouter.get('/links/:code', linkAction(async req => {
  const link = await links.describe(String(req.params.code));
  if (!link) throw new LinkRuleError('No link has that code.');
  return link;
}));
consoleRouter.post('/links/:code/disable', linkAction(req => links.platformDisable(String(req.params.code), req.platformAdmin.id, String(req.body?.note ?? ''))));
consoleRouter.post('/links/:code/enable', linkAction(req => links.platformEnable(String(req.params.code))));

export { authRouter as platformAdminAuthRoutes, consoleRouter as platformAdminConsoleRoutes };
