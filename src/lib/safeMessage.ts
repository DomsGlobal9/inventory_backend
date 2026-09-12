/**
 * Whether a message is safe to show somebody standing in a shop.
 *
 * One definition, in one file, because there are two roads out of this building and they were
 * about to have one of these each -- which is exactly how UNIT_COST ended up with three copies
 * and five tenants seeing two different inventory values.
 *
 *   respondWithError      forty-seven controller catch blocks
 *   error.middleware      everything that reaches the express error handler
 *
 * What prompted it: pressing Dispatch twice in the UI produced this, verbatim, in a red toast.
 *
 *   Invalid `db.clientSequence.upsert()` invocation in
 *   D:\villy\inventory\backend\src\utils\codeGenerator.ts:65:44
 *   Transaction failed due to a write conflict or a deadlock. Please retry your transaction
 *
 * That is the server's absolute path, its ORM, its table and a line number. A second case found
 * while testing this: `connect ECONNREFUSED 127.0.0.1:5432` names the database host and port.
 *
 * Deliberately a denylist rather than an allowlist. Plenty of thrown Errors carry sentences a
 * person genuinely needs -- "Cannot dispatch 5. Only 2 reserved remaining", "Cannot confirm an
 * order with no items" -- and those are written by us, for the user, and must survive. What is
 * filtered is the shape of machinery: paths, ORM calls, stack frames, hosts and ports.
 */

const PATTERNS: RegExp[] = [
  /Invalid `/,                      // Prisma's invocation banner
  /\bprisma\./,                     // prisma.model.method()
  /node_modules/,
  /\.[jt]s:\d+/,                    // a file and line number
  /[A-Za-z]:\\/,                    // C:\ or D:\ -- a Windows path
  /(?:^|[\s(])\/(?:home|usr|var|etc|opt|root)\//,  // a unix path
  /\bat\s+\w+\s+\(/,                // a stack frame
  /\bE(?:CONNREFUSED|CONNRESET|TIMEDOUT|NOTFOUND|HOSTUNREACH|PIPE)\b/,
  /\bEAI_AGAIN\b/,
  /\b\d{1,3}(?:\.\d{1,3}){3}\b/,    // an IP address
  /\blocalhost:\d+/,
  /\b(?:postgres|postgresql|mysql|redis|mongodb):\/\//, // a connection string
];

/** What to say instead. Vague on purpose: the real text is in the log and in clientErrorLog. */
export const SAFE_GENERIC = 'Something went wrong at our end. Please try again.';

export function looksInternal(message: unknown): boolean {
  const text = String(message ?? '');
  return PATTERNS.some(p => p.test(text));
}

/** The message if it is fit to show, otherwise `fallback` -- or the generic. */
export function safeMessage(message: unknown, fallback?: string): string {
  const text = String(message ?? '').trim();
  if (!text) return fallback || SAFE_GENERIC;
  return looksInternal(text) ? (fallback || SAFE_GENERIC) : text;
}
