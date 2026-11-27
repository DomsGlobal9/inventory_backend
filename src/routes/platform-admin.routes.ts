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
import * as shopAppKeys from '../services/shop-app-keys';
import { listLeads, updateLead, convertLead } from '../controllers/lead.controller';
import * as boutique from '../services/boutique';
import * as join from '../services/boutique/join';
import * as posSwitch from '../services/pos-switch';
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
    // handOver: the boutique app runs this whole shop (every product becomes the boutique's; 24 Nov, Swathy Reddy).
    res.json({ success: true, data: await boutique.enableForClient(clientId, String(req.body?.tenant ?? ''), req.body?.shopName ? String(req.body.shopName).slice(0, 120) : null, { handOver: req.body?.handOver === true }) });
  } catch (e) { boutiqueFail(res, e); }
});
// One-switch onboarding (26 Nov 2026, PLAN-onboarding-modules.md): the client's modules in one place, and how each
// module says it is connected. The boutique and POS routes above and below stay for their own details.
const modulesFail = (res: any, e: any) => res.status(e?.statusCode ?? 500).json({ success: false, message: e?.statusCode ? e.message : 'The modules could not be changed just now. Please try again.' });
consoleRouter.get('/clients/:clientId/modules', async (req, res) => {
  try {
    const clientId = String(req.params.clientId);
    if (!(await ourClient(clientId))) return notOurs(res);
    const cm = await import('../services/client-modules');
    const s = await cm.state(clientId);
    if (!(await (await import('../lib/prisma')).prisma.clientModule.findFirst({ where: { clientId, module: 'inventory' } }))) s.on.inventory = await cm.inventoryOn(clientId);
    const linked = await (await import('../lib/prisma')).prisma.boutiqueLink.findUnique({ where: { clientId }, select: { tenant: true, unlinkedAt: true } });
    res.json({ success: true, data: { ...s, modules: cm.MODULES.filter(m => s.on[m]), all: cm.MODULES.map(m => ({ module: m, label: cm.LABEL[m], on: s.on[m] })), boutiqueTenant: linked && !linked.unlinkedAt ? linked.tenant : null } });
  } catch (e) { modulesFail(res, e); }
});
consoleRouter.put('/clients/:clientId/modules', async (req, res) => {
  try {
    const clientId = String(req.params.clientId);
    if (!(await ourClient(clientId))) return notOurs(res);
    const cm = await import('../services/client-modules');
    const b = req.body ?? {};
    const out = await cm.setModules(clientId, { modules: b.modules ?? {}, by: adminBy(req), source: 'console', boutique: b.boutique ?? null });
    res.json({ success: true, data: out });
  } catch (e) { modulesFail(res, e); }
});
// What the shop sells (27 Nov 2026): ScaleEzy's to set, here; the owner sees it in Settings and cannot change it.
consoleRouter.get('/clients/:clientId/sells', async (req, res) => {
  try {
    const clientId = String(req.params.clientId);
    if (!(await ourClient(clientId))) return notOurs(res);
    const { getSetup } = await import('../services/shop-setup');
    const s = await getSetup(clientId);
    res.json({ success: true, data: { sells: s.sells, suggested: s.suggested, fabricsOn: s.fabricsOn, boutiqueLinked: !!(s.boutique as any)?.linked, inventoryOn: await (await import('../services/client-modules')).inventoryOn(clientId) } });
  } catch (e) { modulesFail(res, e); }
});
consoleRouter.put('/clients/:clientId/sells', async (req, res) => {
  try {
    const clientId = String(req.params.clientId);
    if (!(await ourClient(clientId))) return notOurs(res);
    const { setSellsByScaleEzy } = await import('../services/shop-setup');
    const s = await setSellsByScaleEzy(clientId, req.body?.sells);
    res.json({ success: true, data: { sells: s.sells, suggested: s.suggested, fabricsOn: s.fabricsOn, boutiqueLinked: !!(s.boutique as any)?.linked, inventoryOn: await (await import('../services/client-modules')).inventoryOn(clientId) } });
  } catch (e) { res.status((e as any)?.statusCode ?? 500).json({ success: false, message: (e as any)?.statusCode ? (e as any).message : 'That could not be changed just now. Please try again.' }); }
});
consoleRouter.get('/clients/:clientId/connections', async (req, res) => {
  try {
    const clientId = String(req.params.clientId);
    if (!(await ourClient(clientId))) return notOurs(res);
    const { checklist } = await import('../services/client-modules/status');
    res.set('Cache-Control', 'no-store').json({ success: true, data: await checklist(clientId) });
  } catch (e) { modulesFail(res, e); }
});
consoleRouter.post('/clients/:clientId/modules/:module/retry', async (req, res) => {
  try {
    const clientId = String(req.params.clientId);
    if (!(await ourClient(clientId))) return notOurs(res);
    const { retry } = await import('../services/client-modules/connect');
    const { DOORS } = await import('../services/client-modules');
    const module = String(req.params.module);
    if (!(DOORS as readonly string[]).includes(module)) return res.status(400).json({ success: false, message: 'Only POS and CRM are told about a client.' });
    // Not told yet (or answered): told again now with the newest picture.
    if (!(await retry(clientId, module))) {
      const prisma = (await import('../lib/prisma')).prisma;
      const c = await prisma.platformClient.findUnique({ where: { clientId }, select: { version: true } });
      const on = (await prisma.clientModule.findUnique({ where: { clientId_module: { clientId, module } } }))?.on;
      if (!on) return res.status(409).json({ success: false, message: 'That module is switched off for this client.' });
      await prisma.moduleConnect.upsert({ where: { clientId_module: { clientId, module } }, create: { clientId, module, action: 'connect', version: c?.version ?? 1 }, update: { action: 'connect', status: 'PENDING', nextAttemptAt: new Date(), lockedAt: null } });
      (await import('../services/client-modules/connect')).kick(clientId, { by: adminBy(req), source: 'console' });
    }
    res.json({ success: true, data: { asked: true } });
  } catch (e) { modulesFail(res, e); }
});
// POS switched on for a client automatically (25 Nov 2026): Inventory makes the till key and calls POS (pos-switch).
const posFail = (res: any, e: any) => res.status(e?.statusCode ?? 500).json({ success: false, message: e?.statusCode ? e.message : 'POS could not be changed just now. Please try again.' });
const adminBy = (req: any) => ({ userId: String(req.platformAdmin?.id ?? 'console'), name: `${req.platformAdmin?.name ?? req.platformAdmin?.email ?? 'ScaleEzy'} (ScaleEzy Console)` });
consoleRouter.get('/clients/:clientId/pos', async (req, res) => {
  try {
    if (!(await ourClient(String(req.params.clientId)))) return notOurs(res);
    res.json({ success: true, data: await posSwitch.status(String(req.params.clientId)) });
  } catch (e) { posFail(res, e); }
});
consoleRouter.post('/clients/:clientId/pos/on', async (req, res) => {
  try {
    if (!(await ourClient(String(req.params.clientId)))) return notOurs(res);
    res.json({ success: true, data: await posSwitch.switchOn(String(req.params.clientId), adminBy(req), req.body?.owner ?? null) });
  } catch (e) { posFail(res, e); }
});
consoleRouter.post('/clients/:clientId/pos/off', async (req, res) => {
  try {
    if (!(await ourClient(String(req.params.clientId)))) return notOurs(res);
    res.json({ success: true, data: await posSwitch.switchOff(String(req.params.clientId), adminBy(req)) });
  } catch (e) { posFail(res, e); }
});
consoleRouter.post('/clients/:clientId/pos/owner-link', async (req, res) => {
  try {
    if (!(await ourClient(String(req.params.clientId)))) return notOurs(res);
    res.json({ success: true, data: await posSwitch.ownerLink(String(req.params.clientId), adminBy(req), req.body?.reset === true) });
  } catch (e) { posFail(res, e); }
});
// A shop whose Boutique module is already on: the boutique app takes over every product (see handOverShop).
consoleRouter.post('/clients/:clientId/boutique/hand-over', async (req, res) => {
  try {
    if (!(await ourClient(String(req.params.clientId)))) return notOurs(res);
    res.json({ success: true, data: await boutique.handOverShop(String(req.params.clientId)) });
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

// Partner app keys for Shop API v1 (20 Nov 2026): made here, shown once, switched off here. A key reaches only the shops
// linked to its boutique account. The Console screen for these is still to be designed; the calls work today.
const appKeyAction = (fn: (req: any) => Promise<unknown>, status = 200) => async (req: any, res: any) => {
  try { res.status(status).json({ success: true, data: await fn(req) }); }
  catch (e: any) {
    if (e instanceof shopAppKeys.AppKeyError) return res.status(e.statusCode).json({ success: false, message: e.message });
    console.error('[shop app keys] failed:', e?.message);
    res.status(500).json({ success: false, message: 'That could not be done just now. Nothing was changed; try again.' });
  }
};
consoleRouter.get('/shop-app-keys', appKeyAction(req => shopAppKeys.list(req.query.tenant)));
consoleRouter.post('/shop-app-keys', appKeyAction(req => shopAppKeys.make(req.body ?? {}, req.platformAdmin?.id ?? null), 201));
consoleRouter.post('/shop-app-keys/:id/off', appKeyAction(req => shopAppKeys.setActive(String(req.params.id), false)));
consoleRouter.post('/shop-app-keys/:id/on', appKeyAction(req => shopAppKeys.setActive(String(req.params.id), true)));

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
