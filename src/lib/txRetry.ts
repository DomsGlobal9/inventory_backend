import { Prisma } from '@prisma/client';
import { prisma } from './prisma';

/**
 * Interactive transactions against a distant database.
 *
 * Every round trip to our database takes something like a second, and a transaction that writes
 * stock takes many of them: read the order, lock the variant, write the stock, write the ledger,
 * write the shelf legs, and again for each line of the delivery. Two things then go wrong, and
 * both did:
 *
 *   a conflict   two writers touch the same rows, Postgres aborts one and expects a retry
 *   a timeout    the work outlives the transaction's budget, Prisma closes it (P2028)
 *
 * In both cases NOTHING was written -- the transaction rolled back -- so running the whole thing
 * again is safe, and is what the caller is supposed to do. Without it, receiving a delivery on a
 * slow evening simply failed with "Something went wrong at our end" and the goods stayed unbooked.
 *
 * `alreadyDone` is for callers that can recognise their own finished work (a receipt saved under a
 * request key). It is asked before each retry, so a first attempt that did commit -- while the
 * answer was lost on the way back -- returns that work instead of doing it twice.
 */
export function isRetryableTransactionError(error: any): boolean {
  if (!error) return false;
  if (error.code === 'P2034' || error.code === '40001' || error.code === '40P01') return true;
  const message = String(error.message || '');
  return /could not serialize access|deadlock detected|write conflict/i.test(message);
}

/** The transaction ran out of time, or never got a connection. Nothing was written either way. */
export function isTransactionTimeout(error: any): boolean {
  if (!error) return false;
  if (error.code === 'P2028' || error.code === 'P2024') return true;
  const message = String(error.message || '');
  return /Transaction not found|Transaction already closed|Unable to start a transaction|Timed out fetching a new connection/i.test(message);
}

type Options<T> = {
  /** Named in the log line when an attempt is retried, e.g. "receive delivery". */
  label: string;
  attempts?: number;
  maxWait?: number;
  timeout?: number;
  isolationLevel?: Prisma.TransactionIsolationLevel;
  /** Work this caller has already finished (idempotency), asked before each retry. */
  alreadyDone?: () => Promise<T | null>;
  /** What to tell the person if time runs out every time. */
  tooSlowMessage?: string;
};

export async function runTransaction<T>(run: (tx: Prisma.TransactionClient) => Promise<T>, options: Options<T>): Promise<T> {
  const {
    label,
    attempts = 3,
    // Sized for a queue against a slow database, not for a fast local one: on a normal
    // connection these transactions finish in tens of milliseconds and never approach either.
    maxWait = 20000,
    timeout = 120000,
    isolationLevel,
    alreadyDone,
    tooSlowMessage
  } = options;

  for (let attempt = 1; ; attempt++) {
    try {
      return await prisma.$transaction(run, { maxWait, timeout, ...(isolationLevel ? { isolationLevel } : {}) });
    } catch (error: any) {
      const done = alreadyDone ? await alreadyDone().catch(() => null) : null;
      if (done) return done;

      const timedOut = isTransactionTimeout(error);
      const canRetry = timedOut || isRetryableTransactionError(error);
      if (attempt >= attempts || !canRetry) {
        if (timedOut && tooSlowMessage) throw Object.assign(new Error(tooSlowMessage), { statusCode: 503 });
        throw error;
      }

      // A short, uneven wait so two writers that collided do not collide again together.
      const wait = 150 * attempt + Math.floor(Math.random() * 150);
      console.warn(`[${label}] attempt ${attempt}/${attempts} ${timedOut ? 'ran out of time' : 'hit a conflict'} -- trying again in ${wait}ms`);
      await new Promise(resolve => setTimeout(resolve, wait));
    }
  }
}
