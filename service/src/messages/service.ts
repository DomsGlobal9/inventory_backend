import { Prisma, type Account, type Message, type MessageKind, type ModuleClient } from '@prisma/client';
import type { Ctx } from '../context';
import { contentHash, isWithinDuplicateWindow, DUPLICATE_WINDOW_MS } from '../domain/rules';
import { Errors } from '../lib/errors';
import { decodePdf } from '../lib/pdf';
import { normalisePhone } from '../lib/phone';
import { getScaleezyAccount } from '../accounts/service';
import { mayModuleUseClient } from '../auth/allow';

export interface NewMessageInput {
  from: 'scaleezy' | { clientId: string };
  to: string;
  text?: string | null;
  document?: { fileName: string; mimeType: string; base64: string } | null;
  kind: MessageKind;
  reference?: string | null;
  idempotencyKey: string;
}

export interface CreateResult {
  message: Message;
  /** true when an earlier message was returned instead of queueing a new one. */
  existing: boolean;
}

/** Which number a module is asking to send from, after checking it may. */
export async function resolveSender(ctx: Ctx, mod: ModuleClient, from: NewMessageInput['from']): Promise<Account> {
  if (from === 'scaleezy') {
    if (!mod.canSendAsScaleEzy) throw Errors.forbidden('This module is not allowed to send from the ScaleEzy number.');
    const acc = await getScaleezyAccount(ctx);
    if (!acc) throw Errors.scaleezyNotConnected();
    return acc;
  }
  if (!(await mayModuleUseClient(ctx, mod, from.clientId))) {
    throw Errors.forbidden('This module is not allowed to send from this shop’s number.');
  }
  const acc = await ctx.db.account.findUnique({ where: { clientId: from.clientId } });
  if (!acc || acc.status === 'NOT_LINKED' || acc.status === 'LINKING' || acc.status === 'LOGGED_OUT') throw Errors.notLinked();
  return acc;
}

export async function createMessage(ctx: Ctx, mod: ModuleClient, input: NewMessageInput): Promise<CreateResult> {
  // 1. Idempotency first: a retried request gets the same message back, whatever else changed.
  const earlier = await ctx.db.message.findUnique({
    where: { moduleId_idempotencyKey: { moduleId: mod.id, idempotencyKey: input.idempotencyKey } },
  });
  if (earlier) return { message: earlier, existing: true };

  const account = await resolveSender(ctx, mod, input.from);
  if (account.kind === 'SCALEEZY' && account.status !== 'CONNECTED' && account.status !== 'DISCONNECTED') {
    throw Errors.scaleezyNotConnected();
  }
  if (account.kind === 'CLIENT' && account.status === 'DISCONNECTED') throw Errors.disconnected();

  const to = normalisePhone(input.to);
  if (!to) throw Errors.badRequest('This is not a valid phone number. Please check it and include the country code if it is not an Indian number.');

  const text = input.text?.trim() ? input.text : null;
  let document: Buffer | null = null;
  if (input.document) document = decodePdf(input.document.base64, input.document.mimeType);
  if (!text && !document) throw Errors.badRequest('There is nothing to send: add a message or a PDF.');
  if (text && text.length > 4000) throw Errors.badRequest('This message is too long. Please keep it under 4,000 characters.');

  const optedOut = await ctx.db.optOut.findUnique({ where: { accountId_toDigits: { accountId: account.id, toDigits: to } } });
  if (optedOut) throw Errors.forbidden('This person replied STOP, so WhatsApp messages are not sent to them from this number.');

  const hash = contentHash(text, document);
  const now = new Date();

  // 2. The 60 s rule: the same content to the same person from the same number (a double click)
  //    returns the first message instead of sending twice.
  const dup = await ctx.db.message.findFirst({
    where: {
      accountId: account.id,
      toDigits: to,
      contentHash: hash,
      queuedAt: { gte: new Date(now.getTime() - DUPLICATE_WINDOW_MS) },
      status: { notIn: ['FAILED', 'EXPIRED'] },
    },
    orderBy: { queuedAt: 'desc' },
  });
  if (dup && isWithinDuplicateWindow(dup.queuedAt, now)) return { message: dup, existing: true };

  try {
    const message = await ctx.db.message.create({
      data: {
        accountId: account.id,
        moduleId: mod.id,
        toDigits: to,
        kind: input.kind,
        reference: input.reference ?? null,
        idempotencyKey: input.idempotencyKey,
        contentHash: hash,
        text,
        document: document ? new Uint8Array(document) : null,
        fileName: document ? sanitiseFileName(input.document!.fileName) : null,
        mimeType: document ? 'application/pdf' : null,
      },
    });
    ctx.log.info({ messageId: message.id, accountId: account.id, kind: message.kind, hasDocument: Boolean(document) }, 'message queued');
    return { message, existing: false };
  } catch (e) {
    // Two identical requests at the same moment: the unique key lets exactly one in.
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
      const winner = await ctx.db.message.findUnique({
        where: { moduleId_idempotencyKey: { moduleId: mod.id, idempotencyKey: input.idempotencyKey } },
      });
      if (winner) return { message: winner, existing: true };
    }
    throw e;
  }
}

export function sanitiseFileName(name: string): string {
  const base = name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim().slice(0, 120) || 'document';
  return /\.pdf$/i.test(base) ? base : `${base}.pdf`;
}

export function publicMessageView(m: Message) {
  return {
    id: m.id,
    status: m.status,
    kind: m.kind,
    reference: m.reference,
    failReason: m.failReason,
    queuedAt: m.queuedAt,
    sentAt: m.sentAt,
    engineConfirmedAt: m.engineConfirmedAt,
    deliveredAt: m.deliveredAt,
    readAt: m.readAt,
    failedAt: m.failedAt,
  };
}
