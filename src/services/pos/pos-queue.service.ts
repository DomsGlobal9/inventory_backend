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
import { applySale, POS_SOURCE, type PosEventResult } from './pos-events.service';

/** How many events one tick may take on. */
const BATCH = 5;

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

  const row = await prisma.posInboundEvent.upsert({
    where: {
      clientId_kind_invoiceNo: {
        clientId, kind: 'sale.completed', invoiceNo: String(event.invoiceNo)
      }
    },
    create: {
      clientId, locationId, kind: 'sale.completed',
      invoiceNo: String(event.invoiceNo), payload: event
    },
    // Deliberately empty. A resend must not overwrite the event we are already working on: the
    // first version is the one the answer will be about.
    update: {},
    select: {
      id: true, status: true, answer: true, orderNumber: true, detail: true, warnings: true
    }
  });

  // Already finished while the till was retrying: give it the real answer, not a queue position.
  if (row.status === 'APPLIED' || row.status === 'REJECTED') {
    return {
      answer: (row.answer ?? 'APPLIED') as PosEventResult['answer'],
      orderNumber: row.orderNumber ?? undefined,
      detail: row.detail ?? undefined,
      warnings: (row.warnings as string[] | null) ?? undefined
    } as PosEventResult;
  }

  return { answer: 'ACCEPTED', reference: row.id };
}

/** Where an event got to, for a till that wants to know. */
export async function saleStatus(clientId: string, invoiceNo: string) {
  const row = await prisma.posInboundEvent.findUnique({
    where: { clientId_kind_invoiceNo: { clientId, kind: 'sale.completed', invoiceNo } },
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
    select: { clientId: true, locationId: true, payload: true, attempts: true }
  });
  if (!row) return false;

  try {
    const out = await applySale(row.clientId, row.locationId, row.payload as any);

    /*
     * Settled either way. APPLIED and ALREADY_APPLIED are obviously done, but so is anything the
     * event itself is wrong about: an item this shop does not sell will still not exist on the
     * fiftieth attempt, and retrying it forever buries the one event somebody needs to look at.
     */
    await prisma.posInboundEvent.update({
      where: { id },
      data: {
        status: 'APPLIED',
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

  let did = 0;
  /*
   * One at a time on purpose. These are long sequential transactions against a database an ocean
   * away; five at once would hold five connections for ten seconds each and starve everything
   * else the server is doing, for throughput nobody is waiting on.
   */
  for (const w of waiting) if (await runOne(w.id)) did++;
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
  acceptSale, saleStatus, tick, recoverStranded, faultInSaleShape, POS_SOURCE
};
