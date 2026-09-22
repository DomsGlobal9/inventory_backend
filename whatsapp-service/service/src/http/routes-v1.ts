import { Router, json } from 'express';
import type { Ctx } from '../context';
import { requireModule } from '../auth/middleware';
import { mayModuleUseClient } from '../auth/allow';
import { disconnectClient, linkClient, publicAccountView } from '../accounts/service';
import { createMessage, publicMessageView, resolveSender, waitingFor } from '../messages/service';
import { isOnWhatsApp } from '../numbers/service';
import { Errors } from '../lib/errors';
import { normalisePhone } from '../lib/phone';
import { route } from './errors';
import { clientIdParam, linkBody, numbersCheckBody, sendBody } from './schemas';
import { MAX_CAPTION } from '../domain/rules';
import { IMAGE_MIME_TYPES, MAX_IMAGE_BYTES } from '../lib/media';

export function v1Routes(ctx: Ctx): Router {
  const r = Router();
  // PDFs arrive as base64 inside JSON: 5 MB decoded is about 7 MB encoded.
  r.use(json({ limit: '8mb' }));
  r.use(requireModule(ctx));

  const clientFor = async (req: Parameters<Parameters<typeof route>[0]>[0]) => {
    const clientId = clientIdParam.parse(req.params.clientId);
    if (!(await mayModuleUseClient(ctx, req.module!, clientId))) throw Errors.forbidden('This module may not manage this shop’s WhatsApp.');
    return clientId;
  };

  // What this service can send. A module checks it before offering a feature, so the module can be
  // deployed before or after the service without breaking anything.
  r.get(
    '/capabilities',
    route(async (_req, res) => {
      const image = ctx.config.mediaUrlPrefixes.length > 0;
      res.json({
        text: true,
        document: { mimeTypes: ['application/pdf'], maxBytes: 5 * 1024 * 1024 },
        image: image ? { mimeTypes: IMAGE_MIME_TYPES, maxBytes: MAX_IMAGE_BYTES, maxCaption: MAX_CAPTION, urlPrefixes: ctx.config.mediaUrlPrefixes } : false,
        linkPreview: true,
        failCodes: ['NOT_ON_WHATSAPP', 'MEDIA_FETCH_FAILED', 'MEDIA_UNREADABLE', 'ENGINE_GAVE_UP', 'ENGINE_REJECTED', 'DELIVERY_FAILED', 'EXPIRED'],
      });
    }),
  );

  r.post(
    '/accounts/client/:clientId/link',
    route(async (req, res) => {
      const clientId = await clientFor(req);
      const body = linkBody.parse(req.body ?? {});
      let phone: string | null = null;
      if (body.method === 'code') {
        phone = normalisePhone(body.phone);
        if (!phone) throw Errors.badRequest('To link with a code, enter the WhatsApp number of the phone you are linking.');
      }
      const result = await linkClient(ctx, clientId, body.method, phone);
      res.json(result);
    }),
  );

  r.get(
    '/accounts/client/:clientId',
    route(async (req, res) => {
      const clientId = await clientFor(req);
      const account = await ctx.db.account.findUnique({ where: { clientId } });
      if (!account) {
        res.json({ status: 'NOT_LINKED', phone: null, linkedAt: null, lastSeenAt: null });
        return;
      }
      res.json(publicAccountView(account));
    }),
  );

  r.post(
    '/accounts/client/:clientId/disconnect',
    route(async (req, res) => {
      const clientId = await clientFor(req);
      const account = await disconnectClient(ctx, clientId);
      res.json(publicAccountView(account));
    }),
  );

  r.post(
    '/messages',
    route(async (req, res) => {
      const body = sendBody.parse(req.body ?? {});
      const { message, existing } = await createMessage(ctx, req.module!, body);
      res.status(202).json({ id: message.id, status: message.status, ...(existing ? { duplicate: true } : {}) });
    }),
  );

  r.get(
    '/messages/:id',
    route(async (req, res) => {
      const id = String(req.params.id ?? '');
      const m = /^[0-9a-f-]{36}$/i.test(id) ? await ctx.db.message.findFirst({ where: { id, moduleId: req.module!.id } }) : null;
      if (!m) throw Errors.notFound('No such message.');
      res.json({ ...publicMessageView(m), ...(await waitingFor(ctx, m)) });
    }),
  );

  r.post(
    '/numbers/check',
    route(async (req, res) => {
      const body = numbersCheckBody.parse(req.body ?? {});
      const account = await resolveSender(ctx, req.module!, body.from);
      if (account.status !== 'CONNECTED') throw account.kind === 'SCALEEZY' ? Errors.scaleezyNotConnected() : Errors.disconnected();
      const to = normalisePhone(body.to);
      if (!to) throw Errors.badRequest('This is not a valid phone number.');
      res.json({ onWhatsApp: await isOnWhatsApp(ctx, account, to) });
    }),
  );

  return r;
}
