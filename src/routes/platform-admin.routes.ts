import { Router } from 'express';
import { verifyPlatformAdmin } from '../middleware/platform-admin.middleware';
import { links, LinkRuleError } from '../services/links';
import * as platformWhatsApp from '../services/whatsapp/platform';
import { listTryOnFailures } from '../services/tryon';
import { WhatsAppServiceError } from '../services/whatsapp/client';
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
  getOffersHealth,
  getTillHealth
} from '../controllers/platform-admin.controller';
import { readOnboardingForm } from '../controllers/platform-admin.controller';
import { platformAdminService } from '../services/platform-admin.service';
import { listLeads, updateLead, convertLead } from '../controllers/lead.controller';
import * as boutique from '../services/boutique';
import * as join from '../services/boutique/join';
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
// The Boutique module for a client (PLAN-boutique-sync.md): only ScaleEzy turns it on or off. Enabling an account that
// has been running as its own boutique-only shop moves everything it holds into this client's shop.
const boutiqueFail = (res: any, e: any) => res.status(e?.statusCode ?? 500).json({ success: false, message: e?.statusCode ? e.message : 'The Boutique module could not be changed just now. Please try again.' });
// The Boutique module is switched on and off for OUR clients only (people sign in). A boutique-only shop belongs to the
// boutique app: the Console neither shows nor changes it.
const ourClient = async (clientId: string) => (await (await import('../lib/prisma')).prisma.user.count({ where: { clientId } })) > 0;
const notOurs = (res: any) => res.status(404).json({ success: false, message: 'No such client.' });
consoleRouter.get('/clients/:clientId/boutique', async (req, res) => {
  try {
    if (!(await ourClient(String(req.params.clientId)))) return notOurs(res);
    res.json({ success: true, data: await boutique.linkState(String(req.params.clientId)) });
  } catch (e) { boutiqueFail(res, e); }
});
consoleRouter.get('/boutique-accounts/:tenant', async (req, res) => {
  try { res.json({ success: true, data: await boutique.accountState(String(req.params.tenant).trim().toLowerCase()) }); } catch (e) { boutiqueFail(res, e); }
});
consoleRouter.put('/clients/:clientId/boutique', async (req, res) => {
  try {
    const clientId = String(req.params.clientId);
    if (!(await ourClient(clientId))) return notOurs(res);
    res.json({ success: true, data: await boutique.enableForClient(clientId, String(req.body?.tenant ?? ''), req.body?.shopName ? String(req.body.shopName).slice(0, 120) : null) });
  } catch (e) { boutiqueFail(res, e); }
});
consoleRouter.delete('/clients/:clientId/boutique', async (req, res) => {
  try {
    if (!(await ourClient(String(req.params.clientId)))) return notOurs(res);
    res.json({ success: true, data: await boutique.disableForClient(String(req.params.clientId)) });
  } catch (e) { boutiqueFail(res, e); }
});
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
// Try-on failures with the far end's real words (shops only ever see a friendly sentence).
consoleRouter.get('/tryon-failures', async (req, res, next) => {
  try {
    const q = req.query as Record<string, string | undefined>;
    res.json({ success: true, data: await listTryOnFailures({ service: q.service || undefined, clientId: q.clientId || undefined, days: Number(q.days) || 7, limit: Number(q.limit) || undefined }) });
  } catch (e) { next(e); }
});
// Offers and Shopify across every shop: copies failing, orders waiting, codes run out. Read only.
consoleRouter.get('/offers-health', getOffersHealth);
consoleRouter.get('/till-health', getTillHealth);
consoleRouter.get('/support-tickets', listSupportTickets);
consoleRouter.get('/support-tickets/:id', getSupportTicket);
consoleRouter.post('/support-tickets/:id/messages', replyToSupportTicket);
consoleRouter.patch('/support-tickets/:id', updateSupportTicketStatus);
// Recovery path of last resort -- see the comment on viewUserPassword in
// platform-admin.service.ts. A platform admin outranks every client role, so no per-client
// hierarchy guard applies (unlike team.routes.ts's equivalent, client-scoped endpoints).
consoleRouter.post('/users/:id/password/view', viewUserPassword);
consoleRouter.post('/users/:id/password', setUserPassword);

// Boutique clients asking to join ScaleEzy Inventory from the boutique app (16 Nov). Accepting runs this Console's own
// onboarding with the boutique account, so the client is made exactly as the Onboarding screen makes one.
const joinAction = (fn: (req: any, res: any) => Promise<unknown>, status = 200) => async (req: any, res: any) => {
  try {
    res.status(status).json({ success: true, data: await fn(req, res) });
  } catch (e: any) {
    if (e instanceof join.JoinError || e?.statusCode) return res.status(e.statusCode).json({ success: false, message: e.message });
    console.error('[boutique join] failed:', e?.message);
    res.status(500).json({ success: false, message: 'That could not be done just now. Nothing was changed; try again.' });
  }
};
consoleRouter.get('/boutique-join-requests', joinAction(req => join.listForConsole(req.query.status)));
consoleRouter.get('/boutique-join-requests/count', joinAction(async () => ({ waiting: await join.waitingCount() })));
consoleRouter.post('/boutique-join-requests/:id/accept', joinAction(async (req, res) => {
  const made = await join.accept(String(req.params.id), req.platformAdmin.id, req.body ?? {},
    (f: any) => { const { companyName, adminName, adminEmail, ...more } = f; return platformAdminService.onboardClient(companyName, adminName, adminEmail, null, more); },
    readOnboardingForm);
  res.locals.auditTargetId = made.clientId;
  res.locals.auditTargetLabel = `boutique join: ${made.clientId}`;
  return made;
}));
consoleRouter.post('/boutique-join-requests/:id/decline', joinAction(req => join.decline(String(req.params.id), req.platformAdmin.id, req.body?.reason)));

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

// ScaleEzy's own WhatsApp number, and every shop's (read-only). See services/whatsapp/platform.ts.
const waAction = (fn: (req: any) => Promise<unknown>) => async (req: any, res: any, next: any) => {
  try {
    res.locals.auditTargetLabel = 'ScaleEzy WhatsApp number';
    res.json({ success: true, data: await fn(req) });
  } catch (e) {
    if (e instanceof WhatsAppServiceError) return res.status(e.statusCode).json({ success: false, message: e.message });
    next(e);
  }
};
consoleRouter.get('/whatsapp', waAction(() => platformWhatsApp.overview()));
consoleRouter.post('/whatsapp/scaleezy/link', waAction(req => platformWhatsApp.link(req.body?.method, req.body?.phone)));
consoleRouter.post('/whatsapp/scaleezy/reconnect', waAction(() => platformWhatsApp.reconnect()));

export { authRouter as platformAdminAuthRoutes, consoleRouter as platformAdminConsoleRoutes };
