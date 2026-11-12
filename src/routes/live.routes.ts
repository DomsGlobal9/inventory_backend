import { Router, Request, Response } from 'express';
import { subscribe, liveStatus } from '../services/live';

/**
 * GET /api/v1/live -- server-sent events for the signed-in person's shop (12 Nov 2026, PLAN-live.md).
 *
 * Each message is `data: {"topics":["orders","stock"]}`: something of that kind changed in this shop. The screen
 * reloads what it shows through the usual routes, with this person's permissions; nothing about the change itself
 * is sent. A comment every 20 s keeps proxies (Render's) from closing a quiet line, and `retry` tells the browser
 * to come back after 3 s if it does drop.
 */
const router = Router();
const HEARTBEAT_MS = 20_000;

router.get('/', (req: Request, res: Response) => {
  const clientId = ((req as any).clientId ?? (req as any).user?.clientId) as string | undefined;
  if (!clientId) return res.status(401).json({ success: false, message: 'Sign in first.' });

  res.status(200).set({
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  res.flushHeaders?.();
  const write = (text: string) => { if (!res.writableEnded) res.write(text); };

  const stop = subscribe(clientId, topics => write(`data: ${JSON.stringify({ topics })}\n\n`));
  if (!stop) {
    write(`event: busy\ndata: ${JSON.stringify({ message: 'Too many screens are open for this shop.' })}\n\n`);
    return res.end();
  }
  write(`retry: 3000\nevent: ready\ndata: ${JSON.stringify({ listening: liveStatus().listening })}\n\n`);
  const beat = setInterval(() => write(`: ${Date.now()}\n\n`), HEARTBEAT_MS);
  const close = () => { clearInterval(beat); stop(); };
  req.on('close', close);
  res.on('error', close);
});

export default router;
