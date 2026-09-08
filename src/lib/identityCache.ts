import { prisma } from './prisma';

/**
 * Who is this request, and what are they allowed to do.
 *
 * Every authenticated request has to answer that before it can do anything, and the answer
 * used to cost SEVEN database round trips: Prisma turns
 *
 *   user -> userRoles -> role -> rolePermissions -> permission
 *
 * into a query per level, and each level waits for the one above it. Measured against the
 * live database that is 4.4 seconds of a request that has not yet started doing what it was
 * asked to do -- which is why every screen felt slow at once, including screens that read
 * almost nothing. A 404 on a route that does no work at all still took 2.4 seconds.
 *
 * Roles and permissions change when an admin changes them, which is rare, and the request
 * that changes them can say so. So this holds the answer in memory for a short window and
 * every write that could invalidate it calls forget(). The TTL is the backstop for anything
 * that changes the tables without going through those paths (a migration, a manual fix), not
 * the mechanism -- correctness comes from the explicit invalidation, not from waiting.
 *
 * Per process. Two Render instances keep two copies, so an eviction on one does not reach the
 * other; the TTL bounds that to half a minute. For the one case where that matters most --
 * locking someone out -- half a minute is well inside how long it takes anyone to notice they
 * still have a session, and their next login is checked against the database directly.
 */

export type Identity = {
  id: string;
  clientId: string;
  name: string | null;
  email: string;
  status: string;
  roles: string[];
  permissions: string[];
};

const TTL_MS = 30_000;
// Bounded so a long-lived process cannot accumulate every user who ever signed in. Well above
// any plausible number of people active in one 30-second window.
const MAX_ENTRIES = 5_000;

const cache = new Map<string, { at: number; value: Identity | null }>();

/** Reads through to the database on a miss. `null` means no such user, and is cached too --
 *  otherwise a stale or forged token becomes an uncached query on every retry. */
export async function loadIdentity(userId: string): Promise<Identity | null> {
  const hit = cache.get(userId);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;

  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: {
      roles: { include: { role: { include: { permissions: { include: { permission: true } } } } } }
    }
  });

  const value: Identity | null = user
    ? {
        id: user.id,
        clientId: user.clientId,
        name: user.name,
        email: user.email,
        status: user.status,
        roles: user.roles.map((ur: any) => ur.role.name),
        permissions: Array.from(
          new Set(user.roles.flatMap((ur: any) => ur.role.permissions.map((rp: any) => rp.permission.key)))
        )
      }
    : null;

  if (cache.size >= MAX_ENTRIES) cache.clear();
  cache.set(userId, { at: Date.now(), value });
  return value;
}

/** Call after anything that changes one user's status, roles, or password. */
export function forgetIdentity(userId: string) {
  cache.delete(userId);
}

/**
 * Call after anything that changes a whole tenant at once -- suspending a client, restoring
 * one, erasing one. Suspension is the case that must not wait: it is the button an admin
 * presses when they want a shop out NOW.
 */
export function forgetClientIdentities(clientId: string) {
  for (const [userId, entry] of cache) {
    if (entry.value?.clientId === clientId) cache.delete(userId);
  }
}
