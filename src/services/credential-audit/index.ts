/**
 * Credential disclosure audit.
 *
 * Reading a colleague's password in plain text is the most sensitive thing this product lets
 * anybody do, and until now the only trace it left was a row saying somebody did "VIEW" on
 * "TEAM" -- not whose password, not why, and nothing at all if the attempt was refused.
 *
 * Three deliberate differences from the general activity log in audit-logger.middleware:
 *
 * **Refusals are recorded.** The general logger returns early on any status >= 400, because a
 * failed stock adjustment is not activity. A failed attempt to read a colleague's password is
 * exactly the event worth seeing -- somebody tried, and the system said no.
 *
 * **The write happens before the disclosure, and a failed write refuses it.** The usual rule
 * for audit logging is that it must never break the request; here that rule is wrong. A
 * disclosure nobody can prove happened is worse for the person whose password it was than a
 * disclosure that did not happen. So this throws, and the caller declines.
 *
 * **It records who it was about.** The whole point of the trail is answering "who read MY
 * password", which needs the target, not just the actor.
 *
 * Separate from the general logger, and from team.service, because it is its own concern: any
 * future credential disclosure -- resending a login, exporting an API key -- records here.
 */
import { prisma } from '../../lib/prisma';

export type DisclosureOutcome = 'DISCLOSED' | 'REFUSED';

export type CredentialDisclosure = {
  clientId: string;
  /** Who asked. */
  actorUserId: string;
  actorEmail?: string;
  /** Whose credential it was. */
  targetUserId: string;
  targetEmail?: string;
  /** What kind of credential. Today only one, but not for long. */
  credential: 'PASSWORD';
  outcome: DisclosureOutcome;
  /** Why they said they needed it. Absent is itself worth recording -- see below. */
  reason?: string;
  /** Ties the row to the request log line, so the whole request can be reconstructed. */
  requestId?: string;
  ipAddress?: string;
  /** For a refusal: what the system said. */
  refusedBecause?: string;
};

/**
 * Records one credential disclosure, or one refused attempt.
 *
 * Throws if the record cannot be written. Callers must let that propagate rather than
 * disclosing anyway -- see the note at the top of this file.
 */
export async function recordCredentialDisclosure(event: CredentialDisclosure): Promise<void> {
  await prisma.auditLog.create({
    data: {
      clientId: event.clientId,
      userId: event.actorUserId,
      action: event.outcome === 'DISCLOSED' ? 'PASSWORD_VIEWED' : 'PASSWORD_VIEW_REFUSED',
      // The entity is the person whose password it was, not the team page. That is what makes
      // "show me everything that happened to this account" a query rather than a grep.
      entityType: 'USER_CREDENTIAL',
      entityId: event.targetUserId,
      after: {
        credential: event.credential,
        outcome: event.outcome,
        actorEmail: event.actorEmail ?? null,
        targetEmail: event.targetEmail ?? null,
        // Recorded as an explicit null rather than an absent key, so "no reason was given" is
        // visible in the trail instead of looking like an older row from before this existed.
        reason: event.reason?.trim() || null,
        requestId: event.requestId ?? null,
        refusedBecause: event.refusedBecause ?? null
      },
      ipAddress: event.ipAddress
    }
  });
}
