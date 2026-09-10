/**
 * Errors that carry the HTTP status they mean.
 *
 * error.middleware already honours `err.statusCode` and, crucially, only writes a record to
 * clientErrorLog -- the table the Platform Console's Errors tab reads -- when the status is
 * 5xx. Its comment says exactly the right thing: "a validation 400 or a permission 403 is
 * expected traffic, not something the Platform Console needs paged for."
 *
 * Not-founds were slipping past that. Thirty places across the services threw a bare
 * `new Error('... not found')`, which has no statusCode, so it defaulted to 500 -- and every
 * stale bookmark, deleted record and refused cross-tenant lookup was filed as a backend crash
 * against a real customer.
 *
 * Demonstrated rather than assumed: probing another tenant's stock count from a live session
 * was correctly refused, and the refusal appeared at the top of the Errors tab as
 * "BACKEND 500 Stock count not found". The guard did its job and the console reported it as a
 * fault. Products, orders, returns and customers already answered 404 properly, so the
 * behaviour was inconsistent as well as wrong.
 *
 * That matters beyond neatness: if routine misses are logged as crashes, a real crash is one
 * line among hundreds and nobody can tell which is which.
 */

export class HttpError extends Error {
  statusCode: number;

  constructor(statusCode: number, message: string) {
    super(message);
    this.name = 'HttpError';
    this.statusCode = statusCode;
    // Without this the stack starts inside this constructor rather than at the throw site,
    // which is the one thing a stack is for.
    Error.captureStackTrace?.(this, this.constructor);
  }
}

/** Something was asked for by id and is not there -- or belongs to somebody else. */
export const notFound = (message: string) => new HttpError(404, message);

/** The request is understood and refused because of what it contains. */
export const badRequest = (message: string) => new HttpError(400, message);

/** The caller is who they say they are and still may not do this. */
export const forbidden = (message: string) => new HttpError(403, message);

/**
 * The request conflicts with the current state -- dispatching more than is reserved,
 * completing something already completed. Distinct from badRequest: the request would have
 * been fine a moment ago, or against a different record.
 */
export const conflict = (message: string) => new HttpError(409, message);
