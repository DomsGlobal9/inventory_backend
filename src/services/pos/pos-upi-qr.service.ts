/**
 * UPI QR at the POS till: a Razorpay QR for exactly one bill, through the shop's OWN Razorpay
 * account, that confirms itself. Opt-in per shop (shop_payment_accounts.upi_qr_enabled): Razorpay
 * charges the shop for every payment, so the owner turns it on knowingly.
 *
 * A QR is PAID only on Razorpay's word: the qr_code.credited webhook, or the till's own poll asking
 * Razorpay (at most every few seconds per QR), so a missed webhook still lands within a poll. A QR
 * the cashier gave up on that the customer paid anyway is still PAID -- money that arrived is never
 * lost; the till matches it to its bill.
 */
import { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { badRequest } from '../../utils/httpError';
import { paymentAccounts } from '../payments/account.service';
import { GatewayError, type PaymentGateway, type UpiQrPayment } from '../payments/gateway/types';

export const QR_TTL_MS = 15 * 60 * 1000;
const ASK_EVERY_MS = 4000;

const refusal = (statusCode: number, answer: string, message: string) => ({ statusCode, answer, message });

type Row = Prisma.PosUpiQrGetPayload<{}>;
const shape = (r: Row) => ({
  qrId: r.qrId, imageUrl: r.imageUrl, amountPaise: r.amountPaise, status: r.status,
  expiresAt: r.closeBy.toISOString(),
  paymentId: r.paymentId, utr: r.utr, paidPaise: r.paidPaise, paidAt: r.paidAt ? r.paidAt.toISOString() : null
});

/** The gateway that may take this shop's QR money, or the plain reason it may not. */
async function gatewayForQr(clientId: string): Promise<PaymentGateway> {
  const account = await prisma.shopPaymentAccount.findUnique({ where: { clientId }, select: { upiQrEnabled: true, mode: true } });
  if (!account) throw refusal(422, 'NOT_CONNECTED', 'This shop has no Razorpay account connected. Use your bank QR.');
  if (!account.upiQrEnabled) throw refusal(422, 'NOT_ENABLED', 'UPI QR is switched off for this shop. Use your bank QR, or switch it on in Inventory: Settings, Razorpay account.');
  const ready = await paymentAccounts.readiness(clientId);
  if (!ready.ready) throw refusal(422, account.mode === 'TEST' ? 'TEST_KEYS' : 'NOT_CONNECTED', `${ready.why} Use your bank QR.`);
  const gateway = await paymentAccounts.gatewayFor(clientId);
  if (!gateway) throw refusal(422, 'NOT_CONNECTED', 'This shop has no Razorpay account connected. Use your bank QR.');
  return gateway;
}

export async function createQr(clientId: string, connectionId: string, body: any) {
  const key = typeof body?.idempotencyKey === 'string' ? body.idempotencyKey.trim() : '';
  if (!key || key.length > 120) throw badRequest('Send an idempotencyKey for the QR, up to 120 characters.');
  const amountPaise = Number(body?.amountPaise);
  if (!Number.isInteger(amountPaise) || amountPaise < 100) throw badRequest('Say the amount in whole paise, at least 100 (₹1).');
  const invoiceRef = typeof body?.invoiceRef === 'string' ? body.invoiceRef.trim().slice(0, 80) || null : null;

  const same = await prisma.posUpiQr.findUnique({ where: { clientId_idempotencyKey: { clientId, idempotencyKey: key } } });
  if (same) return shape(same);

  const gateway = await gatewayForQr(clientId);
  const shop = await prisma.clientSettings.findUnique({ where: { clientId }, select: { businessName: true } });
  const closeBy = new Date(Date.now() + QR_TTL_MS);
  let made;
  try {
    made = await gateway.createUpiQr(amountPaise, {
      name: shop?.businessName || 'Shop', closeBy,
      description: invoiceRef ? `Bill ${invoiceRef}` : undefined,
      notes: { till: connectionId, ...(invoiceRef ? { bill: invoiceRef } : {}) }
    });
  } catch (e) {
    if (e instanceof GatewayError && e.kind === 'BAD_REQUEST') {
      // Razorpay answers "The requested URL was not found" when QR Codes is not switched on for the account.
      const notOn = /url was not found|not enabled|not activated|feature/i.test(e.message);
      throw refusal(422, 'QR_NOT_ACTIVATED', notOn
        ? "QR Codes is not switched on for this shop's Razorpay account. Ask Razorpay to activate QR Codes, and use your bank QR until then."
        : `Razorpay would not make a QR for this bill: ${e.message} Use your bank QR.`);
    }
    if (e instanceof GatewayError) throw refusal(503, 'UNAVAILABLE', `${e.message} Use your bank QR for this bill.`);
    throw e;
  }
  try {
    const row = await prisma.posUpiQr.create({
      data: { clientId, connectionId, idempotencyKey: key, qrId: made.qrId, amountPaise, invoiceRef, imageUrl: made.imageUrl, closeBy }
    });
    return shape(row);
  } catch (e: any) {
    // The same key raced in at the same moment: keep the first QR, stop the second taking money.
    if (e?.code === 'P2002') {
      await gateway.closeUpiQr(made.qrId).catch(() => undefined);
      return shape(await prisma.posUpiQr.findUniqueOrThrow({ where: { clientId_idempotencyKey: { clientId, idempotencyKey: key } } }));
    }
    throw e;
  }
}

/** Write what Razorpay says was paid. Only ever moves forward: WAITING or CLOSED becomes PAID, never back. */
async function markPaid(row: Row, p: UpiQrPayment) {
  const status = p.amountPaise === row.amountPaise ? 'PAID' : 'PAID_WRONG_AMOUNT';
  await prisma.posUpiQr.updateMany({
    where: { id: row.id, status: { in: ['WAITING', 'CLOSED'] } },
    data: { status, paymentId: p.paymentId, utr: p.utr, paidPaise: p.amountPaise, paidAt: p.paidAt ?? new Date() }
  });
}

const lastAsked = new Map<string, number>();
/** Ask Razorpay about one QR, at most every few seconds, and record a payment if there is one. */
async function refresh(row: Row, force = false): Promise<Row> {
  if (row.status !== 'WAITING' && row.status !== 'CLOSED') return row;
  if (!force && Date.now() - (lastAsked.get(row.id) ?? 0) < ASK_EVERY_MS) return row;
  lastAsked.set(row.id, Date.now());
  const gateway = await paymentAccounts.gatewayFor(row.clientId);
  if (!gateway) return row;
  try {
    const paid = (await gateway.upiQrPayments(row.qrId)).find(p => p.status === 'CAPTURED');
    if (paid) await markPaid(row, paid);
    else if (row.status === 'WAITING' && row.closeBy.getTime() < Date.now()) {
      await prisma.posUpiQr.updateMany({ where: { id: row.id, status: 'WAITING' }, data: { status: 'CLOSED' } });
    }
  } catch (e) {
    if (!(e instanceof GatewayError)) throw e; // Razorpay slow: the answer stays WAITING, the next poll asks again
  }
  return prisma.posUpiQr.findUniqueOrThrow({ where: { id: row.id } });
}

async function rowOf(clientId: string, qrId: string) {
  const row = await prisma.posUpiQr.findFirst({ where: { clientId, qrId: String(qrId) } });
  if (!row) throw refusal(404, 'QR_UNKNOWN', 'No such QR here.');
  return row;
}

export async function status(clientId: string, qrId: string) {
  return shape(await refresh(await rowOf(clientId, qrId)));
}

/** The cashier chose another way to pay. A QR already paid answers PAID, so that money is taken, not lost. */
export async function close(clientId: string, qrId: string) {
  let row = await refresh(await rowOf(clientId, qrId), true);
  if (row.status === 'WAITING') {
    const gateway = await paymentAccounts.gatewayFor(clientId);
    if (gateway) {
      await gateway.closeUpiQr(row.qrId).catch(e => { if (!(e instanceof GatewayError)) throw e; });
      row = await refresh(row, true); // paid in the last second before closing?
    }
    if (row.status === 'WAITING') {
      await prisma.posUpiQr.updateMany({ where: { id: row.id, status: 'WAITING' }, data: { status: 'CLOSED' } });
      row = await prisma.posUpiQr.findUniqueOrThrow({ where: { id: row.id } });
    }
  }
  return shape(row);
}

/** From the webhook (qr_code.credited). Razorpay is asked again with the shop's keys; the delivery is only a cue. */
export async function onQrCredited(clientId: string, qrCodeId: string | null | undefined): Promise<'APPLIED' | 'IGNORED'> {
  if (!qrCodeId) return 'IGNORED';
  const row = await prisma.posUpiQr.findFirst({ where: { clientId, qrId: qrCodeId } });
  if (!row) return 'IGNORED';
  const after = await refresh(row, true);
  return after.status === 'PAID' || after.status === 'PAID_WRONG_AMOUNT' ? 'APPLIED' : 'IGNORED';
}
