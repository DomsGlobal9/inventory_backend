/**
 * The only file that talks to the ScaleEzy WhatsApp Service.
 *
 * Everything WhatsApp does for Inventory -- linking a shop's number, sending a purchase order or
 * a bill, the nightly Day Book -- goes through the service, which owns the numbers, the queue and
 * the engine. This wraps its HTTP API so the rest of the module never builds a URL or reads a
 * status code, and so a service that is down or slow becomes one plain sentence for the shop
 * instead of a stack trace.
 */
import { env } from '../../config/env';

export type AccountStatus = 'NOT_LINKED' | 'LINKING' | 'CONNECTED' | 'DISCONNECTED' | 'LOGGED_OUT';
export type MessageStatus = 'QUEUED' | 'SENDING' | 'SENT' | 'DELIVERED' | 'READ' | 'FAILED' | 'EXPIRED';

export type AccountView = { status: AccountStatus; phone: string | null; linkedAt: string | null; lastSeenAt: string | null };
export type LinkResult = { status: AccountStatus; qr?: string; pairingCode?: string };
export type SendResult = { id: string; status: MessageStatus; duplicate?: boolean };

/** A refusal or failure from the service, carrying its own plain-English sentence. */
export class WhatsAppServiceError extends Error {
  constructor(public statusCode: number, message: string, public code?: string) {
    super(message);
  }
}

export const whatsappConfigured = () => Boolean(env.WHATSAPP_SERVICE_URL && env.WHATSAPP_SERVICE_KEY);

const NOT_SET_UP = 'WhatsApp sending is not set up for ScaleEzy yet. Use Share on WhatsApp instead.';
const UNREACHABLE = 'WhatsApp could not be reached just now. Please try again in a minute.';

/**
 * One call. A PDF upload can take a while on a slow line, so sends get longer than reads; the
 * link call waits for the engine to produce a QR, which can take ~20 s.
 */
async function call<T>(method: 'GET' | 'POST', path: string, body?: unknown, timeoutMs = 15_000): Promise<T> {
  if (!whatsappConfigured()) throw new WhatsAppServiceError(503, NOT_SET_UP, 'not_configured');
  let res: Response;
  try {
    res = await fetch(`${env.WHATSAPP_SERVICE_URL!.replace(/\/+$/, '')}${path}`, {
      method,
      headers: { 'content-type': 'application/json', 'x-module-key': env.WHATSAPP_SERVICE_KEY! },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs)
    });
  } catch {
    throw new WhatsAppServiceError(503, UNREACHABLE, 'unreachable');
  }
  let json: any = null;
  try { json = await res.json(); } catch { json = null; }
  if (!res.ok) {
    // The service speaks plain English already; a key problem is ours to fix, not the shop's.
    if (res.status === 401) throw new WhatsAppServiceError(503, NOT_SET_UP, 'bad_key');
    // The service answers { error: { code, message } }; the sentence goes to the person as it is.
    const err = json?.error;
    const said = typeof err?.message === 'string' ? err.message
      : typeof json?.message === 'string' ? json.message
        : typeof err === 'string' ? err : null;
    throw new WhatsAppServiceError(res.status >= 500 ? 503 : res.status, said || UNREACHABLE, err?.code ?? json?.code);
  }
  return json as T;
}

export const whatsappClient = {
  account: (clientId: string) =>
    call<AccountView>('GET', `/v1/accounts/client/${encodeURIComponent(clientId)}`),

  link: (clientId: string, method: 'qr' | 'code', phone?: string) =>
    call<LinkResult>('POST', `/v1/accounts/client/${encodeURIComponent(clientId)}/link`, { method, ...(phone ? { phone } : {}) }, 60_000),

  disconnect: (clientId: string) =>
    call<AccountView>('POST', `/v1/accounts/client/${encodeURIComponent(clientId)}/disconnect`, {}, 30_000),

  send: (input: {
    from: 'scaleezy' | { clientId: string };
    to: string;
    text?: string | null;
    document?: { fileName: string; mimeType: 'application/pdf'; base64: string } | null;
    kind: string;
    reference?: string | null;
    idempotencyKey: string;
  }) => call<SendResult>('POST', '/v1/messages', input, 60_000),

  message: (id: string) => call<{ id: string; status: MessageStatus; failReason: string | null; waitingFor: 'link' | 'daily_limit' | null; waitingReason: string | null }>('GET', `/v1/messages/${encodeURIComponent(id)}`, undefined, 8_000)
};
