import { Errors } from './errors';

// Pictures travel by address. A module says where the picture is; the worker fetches it when the
// message is due and hands the bytes to the engine. Only addresses under MEDIA_URL_PREFIXES are
// accepted, so no module can make the service (or the engine) fetch an arbitrary address.

export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_MEDIA_URL_LENGTH = 2048;
export const IMAGE_MIME_TYPES = ['image/jpeg', 'image/png'] as const;
export type ImageMimeType = (typeof IMAGE_MIME_TYPES)[number];

const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

/** https everywhere; plain http only to this computer, and never in production. */
function schemeAllowed(u: URL, production: boolean): boolean {
  if (u.protocol === 'https:') return true;
  return !production && u.protocol === 'http:' && LOCAL_HOSTS.has(u.hostname);
}

/**
 * Reads MEDIA_URL_PREFIXES: comma-separated addresses of folders pictures may come from, e.g.
 * `https://<project>.supabase.co/storage/v1/object/public/inventory-images/whatsapp-media/`. Each must be a folder
 * (ends in `/`, not a whole site) with no password, query or fragment. Throws a message naming the
 * bad entry; config turns it into a refusal to start.
 */
export function parseMediaPrefixes(raw: string | undefined, production: boolean): string[] {
  const out: string[] = [];
  for (const part of (raw ?? '').split(',').map((p) => p.trim()).filter(Boolean)) {
    let u: URL;
    try {
      u = new URL(part);
    } catch {
      throw new Error(`"${part}" is not a web address`);
    }
    if (!schemeAllowed(u, production)) throw new Error(`"${part}" must start with https://`);
    if (u.username || u.password) throw new Error(`"${part}" must not contain a user name or password`);
    if (u.search || u.hash) throw new Error(`"${part}" must not contain ? or #`);
    if (!u.pathname.endsWith('/') || u.pathname === '/') throw new Error(`"${part}" must be a folder ending in /, not a whole site`);
    out.push(u.href);
  }
  return out;
}

/**
 * Checks a picture address a module sent. Returns the address in its normal form (the form that is
 * stored and hashed), or throws a plain-English 400.
 */
export function checkMediaUrl(raw: string, prefixes: readonly string[], production: boolean): string {
  if (prefixes.length === 0) throw Errors.badRequest('Pictures cannot be sent: this WhatsApp service has no picture storage set up.');
  if (raw.length > MAX_MEDIA_URL_LENGTH) throw Errors.badRequest('The picture address is too long.');
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw Errors.badRequest('The picture address is not a web address.');
  }
  if (!schemeAllowed(u, production)) throw Errors.badRequest('The picture address must start with https://.');
  if (u.username || u.password) throw Errors.badRequest('The picture address must not contain a user name or password.');
  if (u.search || u.hash) throw Errors.badRequest('The picture address must not contain ? or #.');
  // URL already folds "/../"; encoded ones it leaves for the storage to decode. Refuse them, so an
  // address can never climb out of the allowed folder.
  if (/%2e|%2f|%5c|\\/i.test(u.pathname)) throw Errors.badRequest('The picture address is not allowed.');
  const href = u.href;
  if (!prefixes.some((p) => href.startsWith(p) && href.length > p.length)) {
    throw Errors.badRequest("The picture must come from ScaleEzy's picture storage.");
  }
  return href;
}

/** Tells a JPEG or PNG by its first bytes; anything else is not sent as a picture. */
export function sniffImage(buf: Buffer): ImageMimeType | null {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  return null;
}

/**
 * Fetching the picture failed. `transient`: storage was slow or down, try again later.
 * Otherwise it will never work (gone, too big, not a picture) and the message fails now.
 */
export class MediaFetchError extends Error {
  constructor(
    public readonly transient: boolean,
    message: string,
  ) {
    super(message);
    this.name = 'MediaFetchError';
  }
}

export interface FetchedImage {
  bytes: Buffer;
  mimeType: ImageMimeType;
}

export async function fetchImage(url: string, opts: { timeoutMs?: number; maxBytes?: number } = {}): Promise<FetchedImage> {
  const maxBytes = opts.maxBytes ?? MAX_IMAGE_BYTES;
  let res: Response;
  try {
    // No redirects: an allowed address must not be able to send us somewhere else.
    res = await fetch(url, { redirect: 'manual', headers: { accept: 'image/jpeg, image/png' }, signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000) });
  } catch {
    throw new MediaFetchError(true, 'Picture storage could not be reached.');
  }
  if (res.status >= 300 && res.status < 400) {
    await res.body?.cancel().catch(() => undefined);
    throw new MediaFetchError(false, 'The picture address points somewhere else.');
  }
  if (!res.ok) {
    await res.body?.cancel().catch(() => undefined);
    if (res.status === 408 || res.status === 429 || res.status >= 500) throw new MediaFetchError(true, `Picture storage failed (${res.status}).`);
    throw new MediaFetchError(false, 'The picture is no longer in picture storage.');
  }
  const declared = Number(res.headers.get('content-length') ?? '');
  if (Number.isFinite(declared) && declared > maxBytes) {
    await res.body?.cancel().catch(() => undefined);
    throw new MediaFetchError(false, 'The picture is larger than 5 MB.');
  }
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      total += chunk.length;
      // Counted while reading: a missing or lying length header cannot make us hold a huge file.
      if (total > maxBytes) {
        await res.body?.cancel().catch(() => undefined);
        throw new MediaFetchError(false, 'The picture is larger than 5 MB.');
      }
      chunks.push(Buffer.from(chunk));
    }
  } catch (e) {
    if (e instanceof MediaFetchError) throw e;
    throw new MediaFetchError(true, 'The picture download broke off.');
  }
  const bytes = Buffer.concat(chunks);
  if (bytes.length === 0) throw new MediaFetchError(false, 'The picture is empty.');
  const mimeType = sniffImage(bytes);
  if (!mimeType) throw new MediaFetchError(false, 'The file is not a JPEG or PNG picture.');
  return { bytes, mimeType };
}

/**
 * Recently fetched pictures. A campaign sends one picture to many people, one message every few
 * seconds; fetching it once per message would be wasteful. Addresses are immutable (modules
 * store each picture at a new random address and never overwrite), so a cached copy is exact.
 */
export class ImageCache {
  private readonly items = new Map<string, { img: FetchedImage; at: number }>();

  constructor(
    private readonly maxItems = 8,
    private readonly maxAgeMs = 10 * 60 * 1000,
    private readonly now: () => number = Date.now,
  ) {}

  get(url: string): FetchedImage | null {
    const hit = this.items.get(url);
    if (!hit) return null;
    if (this.now() - hit.at > this.maxAgeMs) {
      this.items.delete(url);
      return null;
    }
    // Most recently used goes to the end.
    this.items.delete(url);
    this.items.set(url, hit);
    return hit.img;
  }

  set(url: string, img: FetchedImage): void {
    this.items.delete(url);
    this.items.set(url, { img, at: this.now() });
    while (this.items.size > this.maxItems) {
      const oldest = this.items.keys().next().value as string;
      this.items.delete(oldest);
    }
  }

  get size(): number {
    return this.items.size;
  }
}
