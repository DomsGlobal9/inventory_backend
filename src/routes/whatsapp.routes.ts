import { Router, Request, Response, NextFunction } from 'express';
import * as whatsapp from '../services/whatsapp/service';
import * as shopNumber from '../services/whatsapp/shop-number';
import { WhatsAppServiceError } from '../services/whatsapp/client';
import { SignupVerifyError } from '../services/signup-verify';
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
      // A wrong or expired code is something the person can act on, not a fault.
      if (err instanceof SignupVerifyError) return res.status(400).json({ success: false, message: err.message });
      next(err);
    }
  };

router.get('/', handle(req => whatsapp.getOverview(actor(req))));

/*
 * The shop's own contact number, and changing it.
 *
 * Behind `whatsapp:manage`, the same permission that links the number, because these are the same
 * job: deciding which phone is this shop's. Proving the new number is what replaces an approval
 * queue -- see services/whatsapp/shop-number.ts.
 */
router.post('/shop-number/start', requirePermission('whatsapp:manage'),
  handle(req => shopNumber.startChange(actor(req), req.body?.phone)));
router.post('/shop-number/finish', requirePermission('whatsapp:manage'),
  handle(req => shopNumber.finishChange(actor(req), req.body?.phone, req.body?.code)));
router.post('/link', requirePermission('whatsapp:manage'), handle(req => whatsapp.link(actor(req), req.body?.method, req.body?.phone)));
router.post('/disconnect', requirePermission('whatsapp:manage'), handle(req => whatsapp.disconnect(actor(req))));
router.post('/test', requirePermission('whatsapp:manage'), handle(req => whatsapp.sendTest(actor(req), req.body?.to, req.body?.nonce), 202));
router.post('/send', handle(req => whatsapp.sendDocument(actor(req), req.body ?? {}), 202));
router.get('/messages', handle(req => whatsapp.latestFor(actor(req), req.query.kind, req.query.id)));
router.put('/day-book', handle(req => whatsapp.saveDayBookSettings(actor(req), req.body ?? {})));
router.post('/day-book/send-now', handle(req => whatsapp.sendDayBookNow(actor(req), req.body?.nonce), 202));
// The Day Book page's own button: any day or range on the screen, to the owner's saved number.
router.get('/day-book/sending', requirePermission('report:financial'), handle(req => whatsapp.getDayBookSending(actor(req))));
router.post('/day-book/send', requirePermission('report:financial'), handle(req => whatsapp.sendDayBookFromPage(actor(req), req.body ?? {}), 202));
router.get('/day-book/message', requirePermission('report:financial'), handle(req => whatsapp.dayBookMessage(actor(req), req.query.id)));

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
