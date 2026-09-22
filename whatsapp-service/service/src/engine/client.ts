// The only code that talks to the WhatsApp engine (Evolution API 2.3.7). Everything else
// uses the Engine interface, which lets tests swap in a fake engine.

export type EngineErrorKind =
  | 'unreachable' // could not connect at all: nothing was sent, wait for the engine
  | 'timeout' // connected but no answer in time: it MAY have been sent
  | 'server' // engine 5xx: try again later
  | 'not_connected' // the number is not connected right now: wait, do not count as a try
  | 'not_found' // no such instance
  | 'not_on_whatsapp' // the recipient has no WhatsApp
  | 'bad_media' // the engine could not read the picture: retrying will not help
  | 'unauthorized' // wrong engine key: a configuration problem
  | 'rejected'; // any other 4xx: will not work by retrying

export class EngineError extends Error {
  constructor(
    public readonly kind: EngineErrorKind,
    message: string,
    public readonly httpStatus?: number,
  ) {
    super(message);
    this.name = 'EngineError';
  }
  get transient(): boolean {
    return this.kind === 'unreachable' || this.kind === 'timeout' || this.kind === 'server';
  }
}

export interface EngineConnectionInfo {
  state: string; // open | connecting | close | refused
  statusReason: number | null;
  ownerDigits: string | null;
  profileName: string | null;
}

export interface LinkInfo {
  state: string;
  qr: string | null; // data:image/png;base64,...
  pairingCode: string | null;
}

export interface Engine {
  ping(): Promise<boolean>;
  /** null when the instance does not exist in the engine. */
  connectionInfo(instance: string): Promise<EngineConnectionInfo | null>;
  createInstance(instance: string, number?: string): Promise<LinkInfo>;
  connect(instance: string, number?: string): Promise<LinkInfo>;
  logout(instance: string): Promise<void>;
  deleteInstance(instance: string): Promise<void>;
  sendText(instance: string, toDigits: string, text: string, opts?: { linkPreview?: boolean }): Promise<{ engineMessageId: string }>;
  sendImage(
    instance: string,
    toDigits: string,
    img: { base64: string; mimeType: string; caption?: string | null },
  ): Promise<{ engineMessageId: string }>;
  sendDocument(
    instance: string,
    toDigits: string,
    doc: { base64: string; fileName: string; mimeType: string; caption?: string | null },
  ): Promise<{ engineMessageId: string }>;
  onWhatsApp(instance: string, digits: string[]): Promise<Map<string, boolean>>;
}

interface Options {
  baseUrl: string;
  apiKey: string;
  timeoutMs?: number;
  sendTimeoutMs?: number;
}

// The last one: Evolution 2.3.7 on an instance with no live WhatsApp socket fails with a TypeError
// before anything is sent (checked on the real engine, 22 Sep 2026).
const NOT_CONNECTED =
  /connection (closed|terminated|lost|failure)|not connected|instance is not connected|socket (closed|not open)|precondition required|reading '(onWhatsApp|waUploadToServer|sendMessage|relayMessage)'/i;
// The engine turns every picture into a thumbnail first (sharp/libvips); a picture it cannot read
// fails there with a 500, e.g. "Input buffer has corrupt header: VipsJpeg: ...".
const BAD_MEDIA = /input buffer|vips|unsupported image format|corrupt (jpeg|png|header)/i;

export class EvolutionEngine implements Engine {
  private readonly timeoutMs: number;
  private readonly sendTimeoutMs: number;

  constructor(private readonly opts: Options) {
    this.timeoutMs = opts.timeoutMs ?? 15_000;
    // Short enough that a graceful shutdown (Render allows 60 s here) can wait for it.
    this.sendTimeoutMs = opts.sendTimeoutMs ?? 25_000;
  }

  async ping(): Promise<boolean> {
    try {
      const res = await this.raw('GET', '/', undefined, 3000);
      return res.status === 200;
    } catch {
      return false;
    }
  }

  async connectionInfo(instance: string): Promise<EngineConnectionInfo | null> {
    let body: unknown;
    try {
      body = await this.call('GET', `/instance/fetchInstances?instanceName=${encodeURIComponent(instance)}`);
    } catch (e) {
      if (e instanceof EngineError && e.kind === 'not_found') return null;
      throw e;
    }
    const list = Array.isArray(body) ? body : [];
    const row = list.find((r) => r && typeof r === 'object' && (r as Record<string, unknown>).name === instance) as
      | Record<string, unknown>
      | undefined;
    if (!row) return null;
    // fetchInstances reads the database; connectionState reads the live socket. The live one wins.
    let state = String(row.connectionStatus ?? 'close');
    try {
      const live = (await this.call('GET', `/instance/connectionState/${encodeURIComponent(instance)}`)) as {
        instance?: { state?: string };
      };
      if (live?.instance?.state) state = live.instance.state;
    } catch (e) {
      if (!(e instanceof EngineError) || e.kind !== 'not_found') throw e;
    }
    const owner = typeof row.ownerJid === 'string' ? row.ownerJid.split('@')[0]?.split(':')[0] ?? null : null;
    return {
      state,
      statusReason: typeof row.disconnectionReasonCode === 'number' ? row.disconnectionReasonCode : null,
      ownerDigits: owner && /^\d{8,15}$/.test(owner) ? owner : null,
      profileName: typeof row.profileName === 'string' ? row.profileName : null,
    };
  }

  async createInstance(instance: string, number?: string): Promise<LinkInfo> {
    const body = (await this.call('POST', '/instance/create', {
      instanceName: instance,
      integration: 'WHATSAPP-BAILEYS',
      qrcode: true,
      ...(number ? { number } : {}),
      // Shops' numbers are for sending documents; the engine must not act on chats.
      rejectCall: false,
      groupsIgnore: true,
      alwaysOnline: false,
      readMessages: false,
      readStatus: false,
      syncFullHistory: false,
    }, 45_000)) as { instance?: { status?: string }; qrcode?: Record<string, unknown> };
    return toLinkInfo(body?.instance?.status ?? 'connecting', body?.qrcode);
  }

  async connect(instance: string, number?: string): Promise<LinkInfo> {
    const q = number ? `?number=${encodeURIComponent(number)}` : '';
    const body = (await this.call('GET', `/instance/connect/${encodeURIComponent(instance)}${q}`, undefined, 30_000)) as Record<
      string,
      unknown
    >;
    // Already open: { instance: { state: 'open' } }. Otherwise the QR fields at top level.
    const inst = body?.instance as { state?: string; status?: string } | undefined;
    if (inst?.state === 'open') return { state: 'open', qr: null, pairingCode: null };
    return toLinkInfo('connecting', body);
  }

  async logout(instance: string): Promise<void> {
    await this.call('DELETE', `/instance/logout/${encodeURIComponent(instance)}`);
  }

  async deleteInstance(instance: string): Promise<void> {
    await this.call('DELETE', `/instance/delete/${encodeURIComponent(instance)}`);
  }

  async sendText(instance: string, toDigits: string, text: string, opts: { linkPreview?: boolean } = {}): Promise<{ engineMessageId: string }> {
    const body = await this.call(
      'POST',
      `/message/sendText/${encodeURIComponent(instance)}`,
      { number: toDigits, text, delay: 1200, linkPreview: opts.linkPreview === true },
      this.sendTimeoutMs,
    );
    return { engineMessageId: engineId(body) };
  }

  /** The bytes, not the address: the service fetched and checked the picture itself. */
  async sendImage(
    instance: string,
    toDigits: string,
    img: { base64: string; mimeType: string; caption?: string | null },
  ): Promise<{ engineMessageId: string }> {
    const body = await this.call(
      'POST',
      `/message/sendMedia/${encodeURIComponent(instance)}`,
      {
        number: toDigits,
        mediatype: 'image',
        mimetype: img.mimeType,
        media: img.base64,
        fileName: img.mimeType === 'image/png' ? 'picture.png' : 'picture.jpg',
        ...(img.caption ? { caption: img.caption } : {}),
        delay: 1200,
      },
      this.sendTimeoutMs,
    );
    return { engineMessageId: engineId(body) };
  }

  async sendDocument(
    instance: string,
    toDigits: string,
    doc: { base64: string; fileName: string; mimeType: string; caption?: string | null },
  ): Promise<{ engineMessageId: string }> {
    const body = await this.call(
      'POST',
      `/message/sendMedia/${encodeURIComponent(instance)}`,
      {
        number: toDigits,
        mediatype: 'document',
        mimetype: doc.mimeType,
        media: doc.base64,
        fileName: doc.fileName,
        ...(doc.caption ? { caption: doc.caption } : {}),
        delay: 1200,
      },
      this.sendTimeoutMs,
    );
    return { engineMessageId: engineId(body) };
  }

  async onWhatsApp(instance: string, digits: string[]): Promise<Map<string, boolean>> {
    const body = await this.call('POST', `/chat/whatsappNumbers/${encodeURIComponent(instance)}`, { numbers: digits });
    const out = new Map<string, boolean>();
    if (Array.isArray(body)) {
      for (const r of body as Array<{ number?: string; exists?: boolean; jid?: string }>) {
        const n = String(r.number ?? r.jid?.split('@')[0] ?? '').replace(/\D/g, '');
        if (n) out.set(n, r.exists === true);
      }
    }
    return out;
  }

  // ---- HTTP ----

  private async raw(method: string, path: string, body: unknown, timeoutMs: number): Promise<Response> {
    try {
      return await fetch(`${this.opts.baseUrl}${path}`, {
        method,
        headers: { apikey: this.opts.apiKey, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      const name = (e as Error)?.name;
      if (name === 'TimeoutError' || name === 'AbortError') throw new EngineError('timeout', 'The engine did not answer in time.');
      // fetch reports a refused/failed connection as a TypeError with the socket error as cause.
      const code = String(((e as { cause?: { code?: string } })?.cause?.code) ?? '');
      if (/ECONNRESET|UND_ERR_SOCKET|EPIPE/.test(code)) throw new EngineError('timeout', 'The engine connection broke mid-request.');
      throw new EngineError('unreachable', 'The engine could not be reached.');
    }
  }

  private async call(method: string, path: string, body?: unknown, timeoutMs = this.timeoutMs): Promise<unknown> {
    const res = await this.raw(method, path, body, timeoutMs);
    let data: unknown = null;
    const text = await res.text().catch(() => '');
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = null;
    }
    if (res.ok) return data;
    throw classify(res.status, data);
  }
}

function engineMessageText(data: unknown): string {
  const d = data as { response?: { message?: unknown }; message?: unknown } | null;
  const m = d?.response?.message ?? d?.message;
  if (Array.isArray(m)) return m.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join('; ');
  return typeof m === 'string' ? m : '';
}

export function classify(status: number, data: unknown): EngineError {
  const text = engineMessageText(data);
  if (status === 401 || status === 403) return new EngineError('unauthorized', 'The engine refused our key.', status);
  if (status === 404) return new EngineError('not_found', 'That WhatsApp instance does not exist in the engine.', status);
  if (BAD_MEDIA.test(text)) return new EngineError('bad_media', 'The engine could not read the picture.', status);
  if (status >= 500) {
    if (NOT_CONNECTED.test(text)) return new EngineError('not_connected', 'The number is not connected.', status);
    return new EngineError('server', `The engine failed (${status}).`, status);
  }
  if (/"exists"\s*:\s*false/.test(text)) return new EngineError('not_on_whatsapp', 'This number is not on WhatsApp.', status);
  if (NOT_CONNECTED.test(text)) return new EngineError('not_connected', 'The number is not connected.', status);
  if (/timed out|timeout/i.test(text)) return new EngineError('server', 'The engine timed out talking to WhatsApp.', status);
  return new EngineError('rejected', `The engine refused the request (${status}).`, status);
}

function engineId(body: unknown): string {
  const id = (body as { key?: { id?: unknown } } | null)?.key?.id;
  if (typeof id !== 'string' || !id) throw new EngineError('server', 'The engine did not return a message id.');
  return id;
}

function toLinkInfo(state: string, q: Record<string, unknown> | undefined | null): LinkInfo {
  const base64 = typeof q?.base64 === 'string' && q.base64.startsWith('data:image') ? q.base64 : null;
  const pairingCode = typeof q?.pairingCode === 'string' && q.pairingCode ? q.pairingCode : null;
  return { state, qr: base64, pairingCode };
}
