import { Request, Response } from 'express';
import { receiveCrmEvent } from '../services/crm-identity';

/**
 * POST /api/v1/webhooks/crm/events -- ScaleEzy CRM's signed customer events (services/crm-identity/events.ts).
 * Ahead of the sign-in gate: CRM's server carries no session; it proves itself with the signature, checked over
 * the raw bytes before anything is read (the body arrives raw: server.ts).
 */
export async function crmEvents(req: Request, res: Response) {
  const raw = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : typeof req.body === 'string' ? req.body : '';
  const reply = await receiveCrmEvent(raw, { signature: req.header('x-crm-signature'), eventId: req.header('x-crm-event-id') });
  res.status(reply.status).json(reply.body);
}
