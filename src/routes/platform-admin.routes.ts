import { Router } from 'express';
import { verifyPlatformAdmin } from '../middleware/platform-admin.middleware';
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
  setUserPassword
} from '../controllers/platform-admin.controller';
import { listLeads, updateLead, convertLead } from '../controllers/lead.controller';

const authRouter = Router();
authRouter.post('/login', login);
authRouter.post('/logout', logout);
authRouter.get('/session', verifyPlatformAdmin, session);

const consoleRouter = Router();
consoleRouter.use(verifyPlatformAdmin);
consoleRouter.get('/clients', listClients);
consoleRouter.post('/clients', onboardClient);
consoleRouter.get('/users', listAllUsers);
consoleRouter.get('/clients/:clientId', getClient);
consoleRouter.post('/clients/:clientId/assume', assumeClient);
consoleRouter.post('/sessions/:sessionId/end', endAssumedSession);
consoleRouter.get('/audit-log', listAuditLog);
consoleRouter.get('/client-errors', listClientErrors);
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

export { authRouter as platformAdminAuthRoutes, consoleRouter as platformAdminConsoleRoutes };
