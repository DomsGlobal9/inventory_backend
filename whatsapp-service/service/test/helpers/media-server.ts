import { createServer, type Server } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';

// A stand-in for picture storage (Supabase public bucket) whose files a test controls.

export const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(2000, 7), Buffer.from([0xff, 0xd9])]);
export const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(500, 3)]);

export type MediaFile =
  | { kind: 'file'; body: Buffer; contentType?: string; noLength?: boolean }
  | { kind: 'status'; status: number }
  | { kind: 'redirect'; to: string }
  /** Answers only after ms (the client times out first). */
  | { kind: 'slow'; ms: number; body: Buffer }
  /** Sends part of the body, then cuts the connection. */
  | { kind: 'cut'; body: Buffer };

export class MediaServer {
  private server: Server | null = null;
  private sockets = new Set<Socket>();
  port = 0;
  readonly files = new Map<string, MediaFile>();
  /** Behaviours for the next requests to a path, used in order; then the file itself. */
  readonly next = new Map<string, MediaFile[]>();
  readonly hits = new Map<string, number>();

  get base(): string {
    return `http://127.0.0.1:${this.port}`;
  }
  /** The folder to allow: MEDIA_URL_PREFIXES. */
  get prefix(): string {
    return `${this.base}/whatsapp-media/`;
  }
  url(name: string): string {
    return `${this.prefix}${name}`;
  }

  async start(): Promise<void> {
    this.server = createServer((req, res) => {
      const path = new URL(req.url ?? '/', 'http://x').pathname;
      this.hits.set(path, (this.hits.get(path) ?? 0) + 1);
      const queued = this.next.get(path);
      const f = queued && queued.length ? queued.shift()! : this.files.get(path);
      if (!f) return void res.writeHead(404, { 'content-type': 'application/json' }).end('{"error":"not found"}');
      if (f.kind === 'status') return void res.writeHead(f.status).end();
      if (f.kind === 'redirect') return void res.writeHead(302, { location: f.to }).end();
      if (f.kind === 'slow') {
        setTimeout(() => {
          if (!res.destroyed) res.writeHead(200, { 'content-type': 'image/jpeg' }).end(f.body);
        }, f.ms);
        return;
      }
      if (f.kind === 'cut') {
        res.writeHead(200, { 'content-type': 'image/jpeg', 'content-length': String(f.body.length * 2) });
        res.write(f.body);
        setTimeout(() => res.socket?.destroy(), 20);
        return;
      }
      const headers: Record<string, string> = { 'content-type': f.contentType ?? 'image/jpeg' };
      if (f.noLength) {
        res.writeHead(200, headers);
        // Written in pieces so no length is known up front.
        const step = 64 * 1024;
        for (let i = 0; i < f.body.length; i += step) res.write(f.body.subarray(i, i + step));
        res.end();
        return;
      }
      res.writeHead(200, { ...headers, 'content-length': String(f.body.length) }).end(f.body);
    });
    this.server.on('connection', (s) => {
      this.sockets.add(s);
      s.on('close', () => this.sockets.delete(s));
    });
    await new Promise<void>((r) => this.server!.listen(0, '127.0.0.1', r));
    this.port = (this.server.address() as AddressInfo).port;
  }

  put(name: string, f: MediaFile): string {
    this.files.set(`/whatsapp-media/${name}`, f);
    return this.url(name);
  }

  queue(name: string, ...behaviours: MediaFile[]): void {
    this.next.set(`/whatsapp-media/${name}`, behaviours);
  }

  hitsFor(name: string): number {
    return this.hits.get(`/whatsapp-media/${name}`) ?? 0;
  }

  reset(): void {
    this.files.clear();
    this.next.clear();
    this.hits.clear();
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    for (const s of this.sockets) s.destroy();
    await new Promise<void>((r) => this.server!.close(() => r()));
    this.server = null;
  }
}
