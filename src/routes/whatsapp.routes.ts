import { Router, Request, Response, NextFunction } from 'express';
import * as whatsapp from '../services/whatsapp/service';
import { WhatsAppServiceError } from '../services/whatsapp/client';
import { requirePermission } from '../middleware/permission.middleware';

/**
 * Settings > WhatsApp, the Send buttons, and the nightly Day Book choice. The rules about who may do
 * what live in services/whatsapp; linking is also guarded here at the door, like every route whose
 * whole purpose is one permission.
 */
const router = Router();

const actor = (req: Request): whatsapp.Actor => {
  const u = (req as any).user;
  return { id: u.id, clientId: u.clientId, name: u.name, permissions: u.permissions, roles: u.roles };
};

/** The service's own sentence reaches the screen; anything else goes to the shared handler. */
const handle = (fn: (req: Request) => Promise<unknown>, status = 200) =>
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      res.status(status).json({ success: true, data: await fn(req) });
    } catch (err) {
      if (err instanceof WhatsAppServiceError) return res.status(err.statusCode).json({ success: false, message: err.message });
      next(err);
    }
  };

router.get('/', handle(req => whatsapp.getOverview(actor(req))));
router.post('/link', requirePermission('whatsapp:manage'), handle(req => whatsapp.link(actor(req), req.body?.method, req.body?.phone)));
router.post('/disconnect', requirePermission('whatsapp:manage'), handle(req => whatsapp.disconnect(actor(req))));
router.post('/test', requirePermission('whatsapp:manage'), handle(req => whatsapp.sendTest(actor(req), req.body?.to, req.body?.nonce), 202));
router.post('/send', handle(req => whatsapp.sendDocument(actor(req), req.body ?? {}), 202));
router.get('/messages', handle(req => whatsapp.latestFor(actor(req), req.query.kind, req.query.id)));
router.put('/day-book', handle(req => whatsapp.saveDayBookSettings(actor(req), req.body ?? {})));
router.post('/day-book/send-now', handle(req => whatsapp.sendDayBookNow(actor(req), req.body?.nonce), 202));

export default router;

/**
 * Events from the WhatsApp Service: delivery ticks, a shop's number dropping. Mounted ahead of the
 * login gate (the service has no session) on the raw body, because the signature covers the exact
 * bytes sent. Anything unsigned or badly signed is refused before it is read.
 */
export async function whatsappEvents(req: Request, res: Response) {
  const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from('');
  if (!whatsapp.verifySignature(raw, req.headers['x-signature'])) {
    return res.status(401).json({ success: false, message: 'Signature does not match.' });
  }
  let event: any;
  try { event = JSON.parse(raw.toString('utf8')); } catch { return res.status(400).json({ success: false, message: 'Not JSON.' }); }
  try {
    const result = await whatsapp.handleEvent(event);
    res.json({ success: true, ...result });
  } catch (err) {
    // A 5xx makes the service try again later, which is what a database blip deserves.
    console.error('[whatsapp] event not handled:', (err as Error)?.message);
    res.status(503).json({ success: false, message: 'Try again later.' });
  }
}
