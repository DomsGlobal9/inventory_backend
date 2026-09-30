/**
 * How a till's connection is told apart from a website's.
 *
 * Both are StorefrontConnection rows -- same hashed key, same location scope, same revoke -- but
 * they are different things: a website is SENT stock and price changes at its address and reads
 * the public feed; a till has no address to send to and uses /pos/v1. Mixed up, a website key
 * could post bills, and a till was queued deliveries to a fake address that failed forever.
 *
 * The marker lives in baseUrl, a column that already exists, rather than in a new enum value or
 * column: the production database is shared with the deployed build, and a new enum value is
 * exactly what took the alerts bell down on 23 Sep. `pos://` can never be a website's address --
 * the website form accepts only http(s) and refuses anything that is not a public host.
 */
export const POS_BASE_URL = 'pos://counter';

export const isPosConnection = (c: { baseUrl?: string | null }) =>
  typeof c.baseUrl === 'string' && c.baseUrl.startsWith('pos://');

/** Prisma filters for "only tills" and "only websites". */
export const POS_ONLY = { baseUrl: { startsWith: 'pos://' } } as const;
export const WEBSITES_ONLY = { NOT: { baseUrl: { startsWith: 'pos://' } } } as const;
