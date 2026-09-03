import { env } from '../config/env';

const GENERATE_PATH = '/api/v1/draping/generate-catalog';
const CANCEL_PATH = '/api/v1/draping/cancel-job';

export class CatalogTryOnService {
  private assertConfigured() {
    if (!env.CATALOG_TRYON_GATEWAY_URL || !env.CATALOG_TRYON_API_KEY) {
      throw { statusCode: 503, message: 'Catalog Try-On is not configured (missing CATALOG_TRYON_GATEWAY_URL / CATALOG_TRYON_API_KEY).' };
    }
  }

  // Proxies the Gateway's SSE stream straight through. The Gateway resolves our
  // tenant from CATALOG_TRYON_API_KEY and injects its own separate secret when it
  // forwards to the actual catalog-tryon-microservice -- we never see that secret.
  async streamGenerateCatalog(payload: Record<string, unknown>, signal: AbortSignal) {
    this.assertConfigured();
    const response = await fetch(`${env.CATALOG_TRYON_GATEWAY_URL}${GENERATE_PATH}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': env.CATALOG_TRYON_API_KEY as string,
      },
      body: JSON.stringify(payload),
      signal,
    });
    return response;
  }

  async cancelJob(clientId: string) {
    this.assertConfigured();
    const response = await fetch(`${env.CATALOG_TRYON_GATEWAY_URL}${CANCEL_PATH}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': env.CATALOG_TRYON_API_KEY as string,
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
