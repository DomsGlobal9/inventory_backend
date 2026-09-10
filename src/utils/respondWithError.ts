import { Response } from 'express';

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
  const deliberate = typeof error?.statusCode === 'number';
  const status = deliberate ? error.statusCode : fallback.status;
  const message = deliberate
    ? (error.message || fallback.message || 'That did not work.')
    : (fallback.message || error?.message || 'That did not work.');

  return res.status(status).json({
    success: false,
    message,
    // Kept alongside `message` only because a few older screens still read this key. New code
    // should read `message`, which is what the rest of the API and the frontend both use.
    error: message
  });
}
