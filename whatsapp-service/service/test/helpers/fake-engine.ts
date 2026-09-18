import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { randomUUID } from 'node:crypto';

// A stand-in for Evolution API 2.3.7 with the same routes and response shapes the service uses,
// whose behaviour a test can change: down, 5xx, slow, number not on WhatsApp, not connected.

export type SendBehaviour =
  | { kind: 'ok' }
  | { kind: 'status'; status: number; message?: unknown }
  /** Accepts and records the send, but answers only after `ms` (client times out first). */
  | { kind: 'slow'; ms: number };

export interface RecordedSend {
  instance: string;
  number: string;
  engineMessageId: string;
  type: 'text' | 'document';
  fileName?: string;
}

export class FakeEngine {
  private server: Server | null = null;
  private sockets = new Set<Socket>();
  port = 0;
  readonly sends: RecordedSend[] = [];
  /** Per-instance connection state. */
  readonly states = new Map<string, { state: string; ownerJid: string | null; reason: number | null }>();
  readonly notOnWhatsApp = new Set<string>();
  /** Behaviours for the next sends, used in order; afterwards 'ok'. */
  readonly nextSends: SendBehaviour[] = [];
  /** Called when a send is accepted (tests use it to emit engine events). */
  onSend: ((s: RecordedSend) => void | Promise<void>) | null = null;
  calls: string[] = [];
  /** The production fault: logout and delete answer SUCCESS and change nothing. */
  zombieLogout = false;

  get url(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  async start(port = 0): Promise<void> {
    this.server = createServer((req, res) => void this.handle(req, res));
    this.server.on('connection', (s) => {
      this.sockets.add(s);
      s.on('close', () => this.sockets.delete(s));
    });
    await new Promise<void>((resolve) => this.server!.listen(port || this.port, '127.0.0.1', resolve));
    this.port = (this.server.address() as AddressInfo).port;
  }

  /** Engine down: the port refuses connections. */
  async stop(): Promise<void> {
    if (!this.server) return;
    for (const s of this.sockets) s.destroy();
    await new Promise<void>((resolve) => this.server!.close(() => resolve()));
    this.server = null;
  }

  setState(instance: string, state: string, ownerDigits: string | null = null, reason: number | null = null): void {
    this.states.set(instance, { state, ownerJid: ownerDigits ? `${ownerDigits}@s.whatsapp.net` : null, reason });
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
    const url = new URL(req.url ?? '/', 'http://x');
    const path = url.pathname;
    this.calls.push(`${req.method} ${path}`);
    const send = (status: number, data: unknown) => {
      if (res.writableEnded || res.destroyed) return;
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(data));
    };
    const err = (status: number, message: unknown) => send(status, { status, error: 'Error', response: { message: [message] } });

    if (req.method === 'GET' && path === '/') return send(200, { status: 200, message: 'Welcome to the Evolution API, it is working!', version: '2.3.7' });

    if (req.method === 'GET' && path === '/instance/fetchInstances') {
      const name = url.searchParams.get('instanceName') ?? '';
      const s = this.states.get(name);
      if (!s) return err(404, `The "${name}" instance does not exist`);
      return send(200, [{ name, connectionStatus: s.state, ownerJid: s.ownerJid, profileName: 'Test', disconnectionReasonCode: s.reason }]);
    }
    let m = path.match(/^\/instance\/connectionState\/(.+)$/);
    if (m) {
      const s = this.states.get(decodeURIComponent(m[1]!));
      if (!s) return err(404, 'instance does not exist');
      return send(200, { instance: { instanceName: m[1], state: s.state } });
    }
    if (req.method === 'POST' && path === '/instance/create') {
      const name = String(body.instanceName);
      this.setState(name, 'connecting');
      return send(201, {
        instance: { instanceName: name, status: 'connecting' },
        qrcode: { base64: 'data:image/png;base64,iVBORw0KGgo=', code: '2@abc', pairingCode: body.number ? 'ABCD1234' : null, count: 1 },
      });
    }
    m = path.match(/^\/instance\/connect\/(.+)$/);
    if (m) {
      const name = decodeURIComponent(m[1]!);
      const s = this.states.get(name);
      if (!s) return err(404, 'instance does not exist');
      if (s.state === 'open') return send(200, { instance: { instanceName: name, state: 'open' } });
      return send(200, { base64: 'data:image/png;base64,iVBORw0KGgo=', code: '2@abc', pairingCode: url.searchParams.get('number') ? 'ABCD1234' : null, count: 2 });
    }
    m = path.match(/^\/instance\/(logout|delete)\/(.+)$/);
    if (m && req.method === 'DELETE') {
      const name = decodeURIComponent(m[2]!);
      if (!this.states.has(name)) return err(404, 'instance does not exist');
      if (this.zombieLogout) return send(200, { status: 'SUCCESS' });
      if (m[1] === 'delete') this.states.delete(name);
      else this.setState(name, 'close', null, 401);
      return send(200, { status: 'SUCCESS' });
    }
    m = path.match(/^\/chat\/whatsappNumbers\/(.+)$/);
    if (m) {
      const s = this.states.get(decodeURIComponent(m[1]!));
      if (!s || s.state !== 'open') return err(400, 'Error: Connection Closed');
      const numbers = (body.numbers as string[]) ?? [];
      return send(200, numbers.map((n) => ({ exists: !this.notOnWhatsApp.has(n), jid: `${n}@s.whatsapp.net`, number: n })));
    }
    m = path.match(/^\/message\/(sendText|sendMedia)\/(.+)$/);
    if (m) {
      const instance = decodeURIComponent(m[2]!);
      const s = this.states.get(instance);
      if (!s) return err(404, 'instance does not exist');
      if (s.state !== 'open') return err(400, 'Error: Connection Closed');
      const number = String(body.number);
      if (this.notOnWhatsApp.has(number)) return err(400, { exists: false, jid: `${number}@s.whatsapp.net`, number });
      const behaviour = this.nextSends.shift() ?? { kind: 'ok' };
      if (behaviour.kind === 'status') return err(behaviour.status, behaviour.message ?? 'Internal error');
      const rec: RecordedSend = {
        instance,
        number,
        engineMessageId: `3EB0${randomUUID().replace(/-/g, '').slice(0, 16).toUpperCase()}`,
        type: m[1] === 'sendMedia' ? 'document' : 'text',
        ...(m[1] === 'sendMedia' ? { fileName: String(body.fileName) } : {}),
      };
      this.sends.push(rec);
      await this.onSend?.(rec);
      const answer = () =>
        send(201, { key: { remoteJid: `${number}@s.whatsapp.net`, fromMe: true, id: rec.engineMessageId }, status: 'PENDING', messageTimestamp: Math.floor(Date.now() / 1000) });
      if (behaviour.kind === 'slow') {
        setTimeout(answer, behaviour.ms);
        return;
      }
      return answer();
    }
    return err(404, 'Cannot ' + req.method + ' ' + path);
  }
}
