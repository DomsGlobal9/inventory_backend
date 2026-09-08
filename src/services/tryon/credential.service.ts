import { prisma } from '../../lib/prisma';
import { env } from '../../config/env';
import { encryptCredential, decryptCredential } from '../../lib/credentialEncryption';
import { ClientService } from '@prisma/client';

/**
 * A client's keys for platform services, issued by the gateway and pasted in by an admin.
 *
 * Two rules this file exists to hold.
 *
 * THE VALUE NEVER LEAVES EXCEPT TO THE GATEWAY. `describe()` returns a masked prefix and is
 * what every screen uses. `keyFor()` decrypts and is called by exactly one place -- the code
 * that makes the outbound call. Keeping those as separate methods is what makes it possible to
 * be sure, by reading the callers, that no merchant-facing route can reach the value.
 *
 * A CLIENT WITHOUT A KEY STILL WORKS. `keyFor()` falls back to the shared
 * CATALOG_TRYON_API_KEY. That is what lets this ship in pieces: nothing breaks on the day it
 * deploys, keys are pasted in as clients are onboarded, and the fallback is removed only once
 * every client has their own. Without it, deploy day is the day try-on stops for everyone not
 * yet migrated.
 */

export interface CredentialSummary {
  service: ClientService;
  configured: boolean;
  /** e.g. "sk_live_a41f" -- enough to recognise, useless on its own. */
  keyPrefix: string | null;
  status: string | null;
  addedByAdmin: string | null;
  addedAt: Date | null;
  lastUsedAt: Date | null;
  /** True when the client is running on the shared key rather than one of their own. */
  usingSharedFallback: boolean;
}

/** How much of a key is safe to show. Long enough to identify, short enough to be useless. */
const PREFIX_LENGTH = 12;

export class ServiceCredentialService {
  /**
   * The key to send for this client, or the shared one.
   *
   * The only method that decrypts. If a second caller ever appears, that is the moment to ask
   * whether it should exist -- every extra place the plaintext is reachable is another place
   * it can be logged, returned or serialised into an error.
   */
  async keyFor(clientId: string, service: ClientService): Promise<{ key: string; shared: boolean }> {
    const row = await prisma.clientServiceCredential.findUnique({
      where: { uq_client_service_key: { clientId, service } },
      select: { id: true, keyEncrypted: true, status: true }
    });

    if (row && row.status === 'ACTIVE') {
      // Not awaited: recording that a key was used must never delay or fail the call that used
      // it. If this write is lost, lastUsedAt is stale -- which is a cosmetic problem.
      void prisma.clientServiceCredential
        .update({ where: { id: row.id }, data: { lastUsedAt: new Date() } })
        .catch(() => undefined);

      return { key: decryptCredential(row.keyEncrypted), shared: false };
    }

    if (!env.CATALOG_TRYON_API_KEY) {
      throw Object.assign(
        new Error('This workspace has no key for that service, and no shared key is configured.'),
        { statusCode: 503 }
      );
    }

    return { key: env.CATALOG_TRYON_API_KEY, shared: true };
  }

  /**
   * What a screen may show. Never the key.
   *
   * Returns a summary even when nothing is configured, so the caller does not have to
   * distinguish "no row" from "no service" -- and so the merchant screen can say "active on the
   * shared key" rather than showing nothing and implying try-on does not work.
   */
  async describe(clientId: string, service: ClientService): Promise<CredentialSummary> {
    const row = await prisma.clientServiceCredential.findUnique({
      where: { uq_client_service_key: { clientId, service } },
      select: {
        keyPrefix: true, status: true, addedByAdmin: true, addedAt: true, lastUsedAt: true
      }
    });

    const active = row?.status === 'ACTIVE';
    return {
      service,
      configured: active,
      keyPrefix: active ? row!.keyPrefix : null,
      status: row?.status ?? null,
      addedByAdmin: active ? row!.addedByAdmin : null,
      addedAt: active ? row!.addedAt : null,
      lastUsedAt: active ? row!.lastUsedAt : null,
      usingSharedFallback: !active && Boolean(env.CATALOG_TRYON_API_KEY)
    };
  }

  /**
   * Checks a key actually works, by using it.
   *
   * Called before saving, deliberately. A key with a missing character saves perfectly well and
   * then fails later -- in front of a merchant pressing Generate, as a 401 they cannot
   * interpret, hours after the admin who pasted it has moved on. One request now turns that
   * into an error message the person who caused it is still looking at.
   *
   * A cancel for a client with no running job is the cheapest call the try-on API has: it does
   * no GPU work, and it answers the only question being asked -- does the gateway accept this
   * key for this client.
   */
  async validate(key: string, clientId: string): Promise<{ ok: boolean; reason?: string }> {
    if (!env.CATALOG_TRYON_GATEWAY_URL) {
      return { ok: false, reason: 'No gateway URL is configured on this deployment.' };
    }

    try {
      const response = await fetch(`${env.CATALOG_TRYON_GATEWAY_URL}/api/v1/draping/cancel-job`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': key },
        body: JSON.stringify({ clientId }),
        signal: AbortSignal.timeout(15_000)
      });

      // 401/403 is the answer we are actually testing for. Anything else -- including a 404 for
      // "no job to cancel" -- means the gateway accepted the key, which is the question.
      if (response.status === 401 || response.status === 403) {
        return { ok: false, reason: 'The gateway rejected that key. Check it was copied in full.' };
      }
      if (response.status >= 500) {
        return { ok: false, reason: `The gateway is not answering (HTTP ${response.status}). Try again shortly.` };
      }
      return { ok: true };
    } catch (error: any) {
      return {
        ok: false,
        reason: error?.name === 'TimeoutError'
          ? 'The gateway did not answer in time.'
          : 'Could not reach the gateway to check that key.'
      };
    }
  }

  /**
   * Stores a client's key, replacing any existing one for that service.
   *
   * Validated first, and refused if the key does not work. Saving a broken key is worse than
   * refusing it: the client appears configured, the fallback stops applying, and try-on breaks
   * for them specifically.
   */
  async setKey(input: {
    clientId: string;
    service: ClientService;
    key: string;
    addedByAdmin: string;
  }) {
    const key = input.key.trim();
    if (key.length < 16) {
      throw Object.assign(new Error('That does not look like a full key'), { statusCode: 400 });
    }

    const check = await this.validate(key, input.clientId);
    if (!check.ok) {
      throw Object.assign(new Error(check.reason ?? 'That key was not accepted'), { statusCode: 400 });
    }

    const row = await prisma.clientServiceCredential.upsert({
      where: { uq_client_service_key: { clientId: input.clientId, service: input.service } },
      create: {
        clientId: input.clientId,
        service: input.service,
        keyEncrypted: encryptCredential(key),
        keyPrefix: key.slice(0, PREFIX_LENGTH),
        addedByAdmin: input.addedByAdmin,
        status: 'ACTIVE'
      },
      update: {
        keyEncrypted: encryptCredential(key),
        keyPrefix: key.slice(0, PREFIX_LENGTH),
        addedByAdmin: input.addedByAdmin,
        addedAt: new Date(),
        status: 'ACTIVE',
        revokedAt: null,
        // Belongs to the key that was replaced, not to this one.
        lastUsedAt: null
      },
      select: { id: true }
    });

    // Deliberately returns the summary rather than anything derived from the key itself, so
    // there is no path from this method back to a caller that could echo the value.
    void row;
    return this.describe(input.clientId, input.service);
  }

  /**
   * Disconnects a client's key.
   *
   * Marked revoked rather than deleted, so the audit trail of who added what and when survives.
   * The client falls back to the shared key, which is why this is not the same as cutting off
   * their access -- that is the gateway's job, and doing it here would only look like it worked.
   */
  async revoke(clientId: string, service: ClientService) {
    await prisma.clientServiceCredential.updateMany({
      where: { clientId, service },
      data: { status: 'REVOKED', revokedAt: new Date() }
    });
    return this.describe(clientId, service);
  }
}

export const serviceCredentialService = new ServiceCredentialService();
