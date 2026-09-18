import { ZodTypeAny, z } from 'zod';
import { badRequest } from '../utils/httpError';

/**
 * A form's contents, checked, or refused with the first thing wrong with them in words.
 *
 * `schema.parse` threw a ZodError, which the error handler answers with the message
 * "Validation failed" -- so a price with a third decimal came back to the screen as "Validation
 * failed" while the sentence that said what to do sat unread in `errors`. Same checks; the
 * sentence is now the message.
 */
export function parseBody<S extends ZodTypeAny>(schema: S, body: unknown): z.infer<S> {
  const parsed = schema.safeParse(body);
  if (parsed.success) return parsed.data;
  const first = parsed.error.errors[0];
  const message = first?.message && !/^(Required|Expected|Invalid)/.test(first.message)
    ? first.message
    : `Check ${first?.path?.length ? `"${first.path[first.path.length - 1]}"` : 'the form'} and try again.`;
  throw badRequest(message);
}
