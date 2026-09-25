/**
 * Which JOB this is, inside this shop.
 *
 * The catalog service treats the body's `clientId` as a job name: a second request under the same
 * one cancels the first mid-stream. We used to send the tenant id for every generation, so every
 * generation from one shop shared a single job name -- fine while a shop only ever made one set of
 * photographs at a time, and the thing that would stop several colours being made at once.
 *
 * The caller supplies only a SUFFIX, never the whole name, and the tenant is always prepended
 * here. Two reasons. A shop must not be able to name a job inside another shop -- the catalog
 * service scopes job names by the account in x-gateway-client-id, but that is the gateway's word,
 * not ours, and this costs nothing. And where that header does not arrive, the far end falls back
 * to a single flat namespace, where an unprefixed "crimson" from two different shops would be the
 * same job.
 *
 * Trimmed to what the far end accepts (identity.js: /^[A-Za-z0-9._:-]{1,128}$/), so a colour code
 * like "#dc143c" cannot silently make the whole name malformed and get the request disowned.
 *
 * It lives here, beside the gateway it names jobs for, rather than in the controller where it
 * started. There are two callers now -- the streaming endpoint a browser holds open, and the
 * photo-job worker, which has no request at all -- and a service reaching into a controller to
 * borrow a function is the wrong direction for the dependency.
 */
export function jobKeyFor(clientId: string, rawSuffix: unknown): string {
  const suffix = typeof rawSuffix === 'string'
    ? rawSuffix.trim().replace(/[^A-Za-z0-9._-]/g, '').slice(0, 40)
    : '';
  return (suffix ? `${clientId}:${suffix}` : clientId).slice(0, 128);
}
