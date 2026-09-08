import { env } from '../../config/env';
import { serviceCredentialService } from './credential.service';

const GENERATE_PATH = '/api/v1/draping/generate-catalog';
const CANCEL_PATH = '/api/v1/draping/cancel-job';

export class CatalogTryOnService {
  private assertConfigured() {
    // Only the URL is required here now. The KEY used to be checked too, which would refuse a
    // client who has a perfectly good key of their own on a deployment where the shared
    // fallback had been removed -- which is exactly the end state this work is heading for.
    // Whether a usable key exists is keyFor's question, and it answers it per client.
    if (!env.CATALOG_TRYON_GATEWAY_URL) {
      throw { statusCode: 503, message: 'Catalog Try-On is not configured (missing CATALOG_TRYON_GATEWAY_URL).' };
    }
  }

  // Proxies the Gateway's SSE stream straight through. The Gateway resolves the tenant from
  // the key we present and injects its own separate secret when it forwards to the actual
  // catalog-tryon-microservice -- we never see that secret.
  //
  // The key is now THIS CLIENT'S, where they have one. Every generation from every shop used
  // to arrive at the gateway under one key, so the gateway -- which meters by key -- saw the
  // whole platform as a single customer. There was nothing wrong with the calls; there was
  // simply no way to tell whose they were.
  //
  // A client with no key of their own falls back to the shared one, so this changed nothing on
  // the day it shipped and keys are pasted in as clients are onboarded.
  async streamGenerateCatalog(
    payload: Record<string, unknown>,
    signal: AbortSignal,
    clientId: string
  ) {
    this.assertConfigured();
    const { key } = await serviceCredentialService.keyFor(clientId, 'CATALOG_TRYON');

    const response = await fetch(`${env.CATALOG_TRYON_GATEWAY_URL}${GENERATE_PATH}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': key,
      },
      body: JSON.stringify(payload),
      signal,
    });
    return response;
  }

  async cancelJob(clientId: string) {
    this.assertConfigured();
    // The same key that started the job. Cancelling with a different one would ask the gateway
    // to stop a job belonging to a tenant it does not think we are.
    const { key } = await serviceCredentialService.keyFor(clientId, 'CATALOG_TRYON');

    const response = await fetch(`${env.CATALOG_TRYON_GATEWAY_URL}${CANCEL_PATH}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': key,
      },
      body: JSON.stringify({ clientId }),
    });
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw { statusCode: response.status, message: `Cancel-job failed: ${text || response.statusText}` };
    }
    return response.json().catch(() => ({ success: true }));
  }
}

export const catalogTryOnService = new CatalogTryOnService();
