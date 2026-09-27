/**
 * The door a POS event comes through, and the worker that does the work behind it.
 *
 * WHY THIS EXISTS. Applying a sale is about thirty-seven database round trips to Singapore, and
 * the till used to wait for every one of them -- eight to twelve seconds with a customer standing
 * at the counter. None of that work needs the customer present. The POS has already taken the
 * money and printed the bill; Inventory is the record kept behind it. So the event is written
 * down in ONE round trip, the till is told it is safely received, and the bookkeeping follows a
 * moment later.
 *
 * WHY ANSWERING FIRST IS HONEST. The row IS the promise, and it is committed before the till is
 * told anything. A crash between the answer and the work loses nothing: the row is still QUEUED
 * and the worker picks it up. This would be a lie only if the event could evaporate.
 *
 * WHAT IS STILL CHECKED AT THE DOOR. Anything that can be decided without asking the database --
 * a missing invoice number, no lines, a fractional quantity. Those are faults in the message
 * itself, they will never become valid by being retried, and a till that sent one should be told
 * at once rather than discover it by polling. Everything needing a lookup -- is this item ours,
 * is there stock -- happens in the worker, because it costs a round trip and the answer does not
 * change what the till does next.
 */
import { prisma } from '../../lib/prisma';
import { env } from '../../config/env';
import { applySale, POS_SOURCE, type PosEventResult } from './pos-events.service';
import { applyReturn } from './pos-returns.service';

/** How many events one tick may take on. */
const BATCH = 10;

/** A row left on RUNNING longer than this belonged to an instance that died. */
const STRANDED_MS = 5 * 60 * 1000;

/** Attempts before a row is left alone for a person to look at. */
const MAX_ATTEMPTS = 5;

export type PosAcceptResult =
  | { answer: 'ACCEPTED'; reference: string }
  | PosEventResult;

/**
 * Faults in the message itself, decided without touching the database.
 *
 * Exported so the door and the worker can never disagree about what a valid sale looks like --
 * two copies of a rule is one rule and one bug waiting.
 */
export function faultInSaleShape(event: any): string | null {
  if (!event?.invoiceNo) return 'The event has no invoice number.';
  if (!Array.isArray(event.lines) || !event.lines.length) return 'The sale has no lines.';
  if (event.lines.some((l: any) => !Number.isInteger(l?.qty) || l.qty <= 0)) {
    return 'Every line needs a whole number of pieces above zero.';
  }
  if (event.lines.some((l: any) => !Number.isInteger(l?.lineTotalPaise) || l.lineTotalPaise < 0)) {
    return 'Every line needs a whole number of paise, zero or more.';
  }
  return null;
}

/**
 * Take the event, promise to apply it, and answer.
 *
 * The upsert does two jobs at once and that is the point: it writes a new event, and on a retry
 * it returns the existing row instead -- so a repeat costs the same single round trip as a first
 * send, and can never produce a second sale. The unique key IS the idempotency check; there is no
 * separate "have I seen this?" query to pay for.
 */
export async function acceptSale(
  clientId: string,
  locationId: string,
  event: any
): Promise<PosAcceptResult> {
  const fault = faultInSaleShape(event);
  if (fault) return { answer: 'BAD_PAYLOAD', detail: fault };
  return accept(clientId, locationId, 'sale.completed', String(event.invoiceNo), event);
}

/**
 * Take a return in the same way, and for the same reason.
 *
 * A return is as much a thing that already happened as a sale is: the customer has their money
 * before this event is sent. What is NOT deferred is the arithmetic check -- that runs at the door
 * in the route, because a refund the two systems disagree about is exactly the disagreement worth
 * stopping a till for, and it is only three queries.
 *
 * Filed under the credit note number rather than the invoice, so a bill and a return against it
 * are two rows and neither can displace the other.
 */
export async function acceptReturn(
  clientId: string,
  locationId: string,
  event: any
): Promise<PosAcceptResult> {
  const creditNoteNo = String(event?.creditNoteNo ?? '').trim();
  if (!creditNoteNo) return { answer: 'BAD_PAYLOAD', detail: 'The return has no credit note number.' };
  return accept(clientId, locationId, 'sale.returned', creditNoteNo, event);
}

async function accept(
  clientId: string,
  locationId: string,
  kind: string,
  idNo: string,
  event: any
): Promise<PosAcceptResult> {
  const row = await prisma.posInboundEvent.upsert({
    where: {
      clientId_kind_invoiceNo: { clientId, kind, invoiceNo: idNo }
    },
    create: {
      clientId, locationId, kind,
      invoiceNo: idNo, payload: event
    },
    // Deliberately empty. A resend must not overwrite the event we are already working on: the
    // first version is the one the answer will be about. A REJECTED one is different -- see below.
    update: {},
    select: {
      id: true, status: true, answer: true, orderNumber: true, detail: true, warnings: true
    }
  });

  /*
   * A resend of a REJECTED event RE-OPENS it, with the new payload.
   *
   * REJECTED means "nobody should keep retrying this on its own" -- an item the shop does not
   * sell, or a fault that outlasted five attempts. The owner is meant to fix the cause and press
   * Retry, and if we handed the stored rejection straight back, Retry could never clear anything.
   * Pointed out by the POS session before it could bite a shop.
   *
   * Safe to re-run because applySale is idempotent in its own right: if an earlier attempt did
   * commit before we lost the answer, it finds that order by its invoice number and reports
   * ALREADY_APPLIED rather than selling anything twice.
   *
   * Checked AFTER the upsert rather than before it, so an ordinary sale still costs exactly one
   * round trip and only the rare rejected resend pays for a second.
   */
  if (row.status === 'REJECTED') {
    await prisma.posInboundEvent.update({
      where: { id: row.id },
      data: {
        status: 'QUEUED', payload: event, attempts: 0,
        answer: null, detail: null, warnings: undefined, settledAt: null
      }
    });
    return { answer: 'ACCEPTED', reference: row.id };
  }

  // Already finished while the till was retrying: give it the real answer, not a queue position.
  if (row.status === 'APPLIED') {
    /*
     * APPLIED becomes ALREADY_APPLIED, because that is what it is from the sender's side.
     *
     * The stored answer records what happened the FIRST time. Handing it back unchanged told a
     * till that its retry had just made the sale, when the sale was made minutes ago -- and the
     * POS uses that distinction to tell a first send from a retry. Nothing was double-sold
     * either way, which is why this was a quiet regression rather than a loud one.
     */
    const answer = row.answer === 'APPLIED' ? 'ALREADY_APPLIED' : row.answer;
    return {
      answer: (answer ?? 'ALREADY_APPLIED') as PosEventResult['answer'],
      orderNumber: row.orderNumber ?? undefined,
      detail: row.detail ?? undefined,
      warnings: (row.warnings as string[] | null) ?? undefined
    } as PosEventResult;
  }

  return { answer: 'ACCEPTED', reference: row.id };
}

/** Where an event got to, for a till that wants to know. */
export async function saleStatus(clientId: string, invoiceNo: string) {
  /*
   * By number alone, whichever kind it is. An invoice number and a credit note number are
   * different things in every till that has ever existed, so a till asking "where did this get
   * to?" should not also have to say which sort of thing it was asking about.
   */
  const row = await prisma.posInboundEvent.findFirst({
    where: { clientId, invoiceNo },
    orderBy: { receivedAt: 'desc' },
    select: {
      id: true, status: true, answer: true, orderNumber: true, detail: true,
      warnings: true, attempts: true, receivedAt: true, settledAt: true
    }
  });
  if (!row) return null;
  return {
    reference: row.id,
    status: row.status,
    answer: row.answer ?? undefined,
    orderNumber: row.orderNumber ?? undefined,
    detail: row.detail ?? undefined,
    warnings: (row.warnings as string[] | null) ?? undefined,
    attempts: row.attempts,
    receivedAt: row.receivedAt,
    settledAt: row.settledAt ?? undefined
  };
}

/**
 * Take one event and do the work.
 *
 * The claim is a conditional update, not a read followed by a write: two instances both see the
 * row as QUEUED, both try to move it to RUNNING, and exactly one changes a row. The loser's count
 * is zero and it moves on. Same claim the photo-job worker uses, for the same reason -- what a
 * queue library would add here is a status column and a WHERE clause.
 */
async function runOne(id: string): Promise<boolean> {
  const claimed = await prisma.posInboundEvent.updateMany({
    where: { id, status: 'QUEUED' },
    data: { status: 'RUNNING', heartbeatAt: new Date(), attempts: { increment: 1 } }
  });
  if (claimed.count === 0) return false;

  const row = await prisma.posInboundEvent.findUnique({
    where: { id },
    select: { clientId: true, locationId: true, payload: true, attempts: true, kind: true }
  });
  if (!row) return false;

  try {
    const out = row.kind === 'sale.returned'
      ? await applyReturn(row.clientId, row.locationId, row.payload as any)
      : await applySale(row.clientId, row.locationId, row.payload as any);

    /*
     * Settled either way, but NOT under the same status.
     *
     * APPLIED and ALREADY_APPLIED are done. Anything else -- an item this shop does not sell --
     * is settled in the sense that retrying it unchanged will never help, and REJECTED is what
     * that is. Recording it as APPLIED with a failing answer, which is what this did first, gave
     * a till no way to tell a sale that went through from one that needs a person: both said
     * APPLIED and only the answer field differed.
     */
    const wentThrough = out.answer === 'APPLIED' || out.answer === 'ALREADY_APPLIED';
    await prisma.posInboundEvent.update({
      where: { id },
      data: {
        status: wentThrough ? 'APPLIED' : 'REJECTED',
        answer: out.answer,
        orderNumber: out.orderNumber ?? null,
        detail: out.detail ?? null,
        warnings: (out.warnings as any) ?? undefined,
        settledAt: new Date()
      }
    });
    return true;
  } catch (e: any) {
    /*
     * A real failure -- the database was unreachable, the transaction timed out. Back to QUEUED
     * so the next tick tries again, unless it has failed enough times that trying again is only
     * noise. REJECTED does not mean the sale did not happen; it means nobody should keep retrying
     * this on its own. The event is still here, whole, to replay once the cause is fixed.
     */
    const done = (row.attempts ?? 0) >= MAX_ATTEMPTS;
    await prisma.posInboundEvent.update({
      where: { id },
      data: {
        status: done ? 'REJECTED' : 'QUEUED',
        detail: String(e?.message ?? e).slice(0, 500),
        ...(done ? { answer: 'FAILED', settledAt: new Date() } : {})
      }
    });
    return false;
  }
}

/**
 * Which shops this worker is allowed to touch.
 *
 * A trailing * matches a prefix, and it exists because the verification suites invent a new
 * tenant per run -- pos-ep-1790504083240 and the next one along. Without prefixes the only way to
 * let a suite through is to let everything through, on a database that is the production one.
 */
function scopeFor(onlyClients?: string[]) {
  if (!onlyClients?.length) return {};
  const exact = onlyClients.filter(c => !c.endsWith('*'));
  const prefixes = onlyClients.filter(c => c.endsWith('*')).map(c => c.slice(0, -1)).filter(Boolean);
  const or: any[] = [];
  if (exact.length) or.push({ clientId: { in: exact } });
  for (const p of prefixes) or.push({ clientId: { startsWith: p } });
  return or.length ? { OR: or } : {};
}

/** One pass: take on whatever is waiting, oldest first. */
export async function tick(onlyClients?: string[]): Promise<number> {
  const waiting = await prisma.posInboundEvent.findMany({
    where: { status: 'QUEUED', ...scopeFor(onlyClients) },
    orderBy: { receivedAt: 'asc' },
    take: BATCH,
    select: { id: true }
  });

  /*
   * A few at a time, not one, and not all of them.
   *
   * This ran strictly one at a time, which was the right instinct and the wrong number. A sale is
   * ten seconds of WAITING on a database an ocean away -- the server does almost nothing during
   * it -- so serialising them meant a shop ringing up three items in a row watched the third
   * appear thirty seconds later, for no gain.
   *
   * Not unbounded either. Each sale holds one pooled connection inside an open transaction for
   * its whole length, and the pooler in front of Postgres has its own ceiling: ten at once would
   * hold ten connections for ten seconds and starve every ordinary request the server is serving
   * at the same time. Three is the compromise, and POS_QUEUE_CONCURRENCY moves it without a
   * deploy if a shop turns out to need more.
   *
   * Sales for the same variant still serialise on the variant lock inside applyMovement, which is
   * correct and costs only waiting -- the lock is what keeps two sales of the last saree honest.
   */
  const limit = Math.max(1, env.POS_QUEUE_CONCURRENCY);
  let did = 0;
  for (let i = 0; i < waiting.length; i += limit) {
    const slice = waiting.slice(i, i + limit);
    const results = await Promise.all(slice.map(w => runOne(w.id)));
    did += results.filter(Boolean).length;
  }
  return did;
}

/** Put back whatever a dead instance left holding. */
export async function recoverStranded(): Promise<number> {
  const r = await prisma.posInboundEvent.updateMany({
    where: { status: 'RUNNING', heartbeatAt: { lt: new Date(Date.now() - STRANDED_MS) } },
    data: { status: 'QUEUED' }
  });
  return r.count;
}

export const posQueue = {
  acceptSale, acceptReturn, saleStatus, tick, recoverStranded, faultInSaleShape, POS_SOURCE
};
