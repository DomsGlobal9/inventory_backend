import { Response } from 'express';
import { Prisma } from '@prisma/client';
import { safeMessage } from '../lib/safeMessage';

/**
 * Anything that reads like it came out of the engine rather than out of a decision.
 *
 * Seen in a browser, verbatim, by pressing Dispatch twice:
 *
 *   Invalid `db.clientSequence.upsert()` invocation in
 *   D:\villy\inventory\backend\src\utils\codeGenerator.ts:65:44
 *   Transaction failed due to a write conflict or a deadlock. Please retry your transaction
 *
 * That is the server's absolute file path, its ORM, its table and its line number, handed to a
 * shop owner in a red toast. The error middleware already translates the common Prisma codes;
 * this is the other road out of the building -- forty-seven controller catch blocks -- and it
 * had no such guard.
 */

/**
 * A write conflict is not a fault, it is two people saving at the same moment.
 *
 * Prisma raises P2034 when a Serializable transaction loses a race -- which is exactly what a
 * double-clicked Dispatch produces, and the outcome is correct: one succeeded. It deserves a
 * 409 and a sentence, not a 400 carrying a stack trace.
 */
function writeConflict(error: any): boolean {
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2034') return true;
  return typeof error?.message === 'string'
    && /write conflict or a deadlock/i.test(error.message);
}

/**
 * Answer a caught error at the status it was raised with, in the shape this API answers in.
 *
 * Forty-seven catch blocks across thirteen controllers ended in a hardcoded status. Whatever a
 * service had carefully decided -- `notFound` is a 404, `conflict` is a 409 -- was thrown away
 * by whichever handler happened to catch it. That is not a decision anybody made; it is what
 * you get when each `catch` is written on its own.
 *
 * It cost two things that were both measured rather than guessed:
 *
 *   - A refused state transition on a sales order came back as 400 from one controller and
 *     500 from another, for the identical rejection. The 500s are persisted to the Platform
 *     Console's Errors page, so a double-clicked Confirm was filed as a backend crash against
 *     a real customer. The state machines were fixed to raise 409; the controllers were still
 *     flattening it.
 *   - Nineteen of them replied `{ error: '...' }`. The frontend's interceptor rejects with the
 *     response body and ninety places in the app read `error.message`; only three ever looked
 *     at `.error`. So the sentence the server took trouble over arrived under a key almost
 *     nothing reads, and the screen showed its generic "something went wrong" instead.
 *
 * `fallback` is what to say when the error carries no status of its own -- an unexpected fault,
 * where the caller's own wording ("Failed to load clients") is friendlier than whatever the
 * exception happens to contain. When the error DOES carry a status it was raised deliberately,
 * and its own message is the specific one worth showing.
 */
export function respondWithError(
  res: Response,
  error: any,
  fallback: { status: number; message?: string }
) {
  if (writeConflict(error)) {
    return res.status(409).json({
      success: false,
      message: 'Somebody saved this at the same moment you did. Nothing was lost -- refresh and try again.',
      error: 'Somebody saved this at the same moment you did. Nothing was lost -- refresh and try again.'
    });
  }

  const deliberate = typeof error?.statusCode === 'number';
  const status = deliberate ? error.statusCode : fallback.status;

  // An error raised on purpose carries wording somebody chose, and that wording is shown. One
  // that merely escaped does not: the caller's fallback is used, and failing that a generic --
  // never the exception's own text, which is where the engine's file paths live.
  const raw = deliberate
    ? (error.message || fallback.message || 'That did not work.')
    : (fallback.message || error?.message || 'That did not work.');

  const message = safeMessage(raw, fallback.message);

  return res.status(status).json({
    success: false,
    message,
    // Kept alongside `message` only because a few older screens still read this key. New code
    // should read `message`, which is what the rest of the API and the frontend both use.
    error: message
  });
}
