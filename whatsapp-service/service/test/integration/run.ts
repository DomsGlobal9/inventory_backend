// Integration run against the REAL local engine and the linked ScaleEzy number.
//
//   npm run test:integration                   full run: 5 real messages to the ScaleEzy number itself
//   npm run test:integration -- --skip-restart  3 real messages (no restart test)
//   npm run test:integration -- --no-send       everything that does not send a WhatsApp message
//
// Safety: every message goes ONLY to the ScaleEzy number (it shows as "Message yourself"),
// sends are spaced at least 10 s apart, the throwaway instance is deleted at the end, and the
// ScaleEzy instance is never logged out, deleted or restarted by this script.
//
// It starts the service itself (so it can kill and restart it), on PORT from .env (18081, where
// the engine's webhook points).

import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { loadDotEnv } from '../../src/lib/dotenv';
import { encrypt, hashModuleKey, newModuleKey, newWebhookSecret, verifySignature } from '../../src/lib/crypto';
import { maskPhone } from '../../src/lib/phone';

loadDotEnv();
const NO_SEND = process.argv.includes('--no-send');
const SKIP_RESTART = process.argv.includes('--skip-restart');
const SELF = '918142424642'; // the ScaleEzy number: the only allowed recipient
const PORT = Number(process.env.PORT ?? 18081);
const BASE = `http://127.0.0.1:${PORT}`;
const HOOK_PORT = 18082;
const ENGINE = (process.env.ENGINE_URL ?? '').replace(/\/+$/, '');
const ENGINE_KEY = process.env.ENGINE_API_KEY ?? '';
const ADMIN = process.env.ADMIN_KEY ?? '';
const MIN_SPACING_MS = 10_000;
const THROWAWAY_CLIENT = 'integration-throwaway';

const db = new PrismaClient();
let service: ChildProcess | null = null;
let failures = 0;
const realSends: Array<{ id: string; label: string }> = [];

function line(ok: boolean | null, what: string, detail = ''): void {
  if (ok === false) failures++;
  const tag = ok === null ? 'INFO' : ok ? 'PASS' : 'FAIL';
  process.stdout.write(`${tag}  ${what}${detail ? `  (${detail})` : ''}\n`);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function http(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(60_000),
  });
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text.slice(0, 200) };
  }
  return { status: res.status, body: json };
}

async function engine(method: string, path: string) {
  const res = await fetch(`${ENGINE}${path}`, { method, headers: { apikey: ENGINE_KEY }, signal: AbortSignal.timeout(30_000) });
  return { status: res.status, body: await res.json().catch(() => null) };
}

function startService(): ChildProcess {
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/main.ts'], {
    cwd: resolve(__dirname, '../..'),
    env: {
      ...process.env,
      // At least 10 s between two real messages.
      SEND_GAP_MIN_MS: '11000',
      SEND_GAP_MAX_MS: '13000',
      CANARY_ENABLED: 'false',
      LOG_LEVEL: 'info',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  // The service's own log is already scrubbed; keep only a short tail for failures.
  const tail: string[] = [];
  const keep = (b: Buffer) => {
    for (const l of b.toString('utf8').split('\n')) if (l.trim()) tail.push(l);
    while (tail.length > 40) tail.shift();
  };
  child.stdout?.on('data', keep);
  child.stderr?.on('data', keep);
  (child as ChildProcess & { tail?: string[] }).tail = tail;
  return child;
}

async function waitReady(timeoutMs = 60_000): Promise<boolean> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    try {
      const r = await fetch(`${BASE}/ready`, { signal: AbortSignal.timeout(3000) });
      if (r.status === 200) return true;
    } catch {
      /* not up yet */
    }
    await sleep(500);
  }
  return false;
}

async function waitStatus(key: string, id: string, want: string[], timeoutMs: number): Promise<any> {
  const until = Date.now() + timeoutMs;
  let last: any = null;
  while (Date.now() < until) {
    const r = await http('GET', `/v1/messages/${id}`, undefined, { 'x-module-key': key });
    last = r.body;
    if (want.includes(last?.status)) return last;
    if (last?.status === 'FAILED' || last?.status === 'EXPIRED') return last;
    await sleep(1500);
  }
  return last;
}

/** Last real send's sentAt, so the next one is at least 10 s later. */
async function respectSpacing(): Promise<void> {
  const last = await db.message.findFirst({ where: { toDigits: SELF, sentAt: { not: null } }, orderBy: { sentAt: 'desc' } });
  if (!last?.sentAt) return;
  const wait = last.sentAt.getTime() + MIN_SPACING_MS + 500 - Date.now();
  if (wait > 0) await sleep(wait);
}

function minimalPdf(): Buffer {
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 144] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    null,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  const stream = 'BT /F1 14 Tf 20 70 Td (ScaleEzy WhatsApp service test PDF) Tj ET';
  objs[3] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

async function main(): Promise<void> {
  if (!ENGINE || !ENGINE_KEY || !ADMIN || !process.env.ENCRYPTION_KEY) throw new Error('Run from service/ with a complete .env');
  line(null, `mode: ${NO_SEND ? 'no-send (no WhatsApp messages)' : 'full (real messages to the ScaleEzy number only)'}`);

  // --- module webhook receiver ---
  const received: Array<{ id: string; type: string; data: any; signatureOk: boolean }> = [];
  let hookSecret = '';
  const hook: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      try {
        const b = JSON.parse(raw);
        received.push({ ...b, signatureOk: verifySignature(hookSecret, raw, req.headers['x-signature'] as string) });
      } catch {
        /* ignore */
      }
      res.writeHead(200).end('{}');
    });
  });
  await new Promise<void>((r) => hook.listen(HOOK_PORT, '127.0.0.1', r));

  // --- modules: fresh keys every run ---
  const invKey = newModuleKey();
  hookSecret = newWebhookSecret();
  const encKey = process.env.ENCRYPTION_KEY!;
  await db.moduleClient.upsert({
    where: { name: 'integration-inventory' },
    create: { name: 'integration-inventory', keyHash: hashModuleKey(invKey), canSendAsScaleEzy: true, webhookUrl: `http://127.0.0.1:${HOOK_PORT}/hook`, webhookSecretEncrypted: encrypt(hookSecret, encKey) },
    update: { keyHash: hashModuleKey(invKey), canSendAsScaleEzy: true, active: true, webhookUrl: `http://127.0.0.1:${HOOK_PORT}/hook`, webhookSecretEncrypted: encrypt(hookSecret, encKey) },
  });
  const crmKey = newModuleKey();
  await db.moduleClient.upsert({
    where: { name: 'integration-crm' },
    create: { name: 'integration-crm', keyHash: hashModuleKey(crmKey), canSendAsScaleEzy: false },
    update: { keyHash: hashModuleKey(crmKey), canSendAsScaleEzy: false, active: true },
  });
  const inv = { 'x-module-key': invKey };

  // --- service up ---
  service = startService();
  line(await waitReady(), 'service started and /ready (database + engine)');

  // The ScaleEzy account is adopted from config; the health watch confirms it with the engine.
  await http('POST', '/admin/health-watch/run', {}, { 'x-admin-key': ADMIN });
  const acc = await db.account.findFirst({ where: { kind: 'SCALEEZY' } });
  line(acc?.status === 'CONNECTED', 'ScaleEzy account CONNECTED', `instance ${acc?.instanceName}, phone ${maskPhone(acc?.phone)}, status ${acc?.status}`);
  if (acc?.phone && acc.phone !== SELF) throw new Error('The ScaleEzy instance is linked to an unexpected number; stopping before any send.');

  // --- keys ---
  const wrong = await http('POST', '/v1/messages', { from: 'scaleezy', to: SELF, text: 'x', kind: 'TEST', idempotencyKey: 'x' }, { 'x-module-key': 'wsk_wrong' });
  line(wrong.status === 401, 'wrong module key -> 401', wrong.body?.error?.message);
  const noKey = await http('GET', '/v1/messages/00000000-0000-0000-0000-000000000000');
  line(noKey.status === 401, 'missing module key -> 401');
  const wrongAdmin = await http('GET', '/admin/accounts', undefined, { 'x-admin-key': 'nope' });
  line(wrongAdmin.status === 401, 'wrong admin key -> 401');
  const wrongSecret = await http('POST', '/engine/events/not-the-secret', { event: 'connection.update' });
  line(wrongSecret.status === 401, 'engine webhook with wrong secret -> 401');

  // --- a module without canSendAsScaleEzy ---
  const crm = await http('POST', '/v1/messages', { from: 'scaleezy', to: SELF, text: 'x', kind: 'TEST', idempotencyKey: `crm-${randomUUID()}` }, { 'x-module-key': crmKey });
  line(crm.status === 403, 'module without canSendAsScaleEzy -> 403', crm.body?.error?.message);

  // --- numbers/check (no message sent) ---
  const chk = await http('POST', '/v1/numbers/check', { from: 'scaleezy', to: SELF }, inv);
  line(chk.status === 200 && chk.body?.onWhatsApp === true, 'numbers/check on the ScaleEzy number', JSON.stringify(chk.body));

  // --- throwaway client instances: one QR, one pairing code (full run only), then deleted ---
  const qrClient = `${THROWAWAY_CLIENT}-qr`;
  const codeClient = `${THROWAWAY_CLIENT}-code`;
  const qr = await http('POST', `/v1/accounts/client/${qrClient}/link`, { method: 'qr' }, inv);
  line(qr.status === 200 && typeof qr.body?.qr === 'string' && qr.body.qr.startsWith('data:image/png;base64,'), 'throwaway client: link returns a QR', `status ${qr.body?.status}, qr ${qr.body?.qr ? `${qr.body.qr.length} chars` : 'none'}`);
  // Asking again gives the current QR of the same instance (the screen refreshes it this way).
  const qr2 = await http('POST', `/v1/accounts/client/${qrClient}/link`, { method: 'qr' }, inv);
  line(qr2.status === 200 && typeof qr2.body?.qr === 'string', 'throwaway client: asking again returns the current QR');
  if (!NO_SEND) {
    // Requests a pairing code for the ScaleEzy number (the only number we may involve). The phone
    // may show a "link a device" prompt; nothing is linked unless someone types the code there.
    const t0 = Date.now();
    const code = await http('POST', `/v1/accounts/client/${codeClient}/link`, { method: 'code', phone: SELF }, inv);
    line(code.status === 200 && /^[A-Z0-9]{8}$/.test(code.body?.pairingCode ?? ''), 'throwaway client: link with phone returns a pairing code', `status ${code.status}, ${Math.round((Date.now() - t0) / 1000)} s, code ${code.body?.pairingCode ? 'received (8 chars)' : JSON.stringify(code.body)}`);
  }
  for (const clientId of [qrClient, codeClient, THROWAWAY_CLIENT]) {
    const throwaway = await db.account.findUnique({ where: { clientId } });
    if (!throwaway) continue;
    await engine('DELETE', `/instance/delete/${encodeURIComponent(throwaway.instanceName)}`);
    await sleep(2000);
    const gone = await engine('GET', `/instance/fetchInstances?instanceName=${encodeURIComponent(throwaway.instanceName)}`);
    const stillThere = Array.isArray(gone.body) && gone.body.some((i: any) => i?.name === throwaway.instanceName);
    await db.account.delete({ where: { id: throwaway.id } });
    line(!stillThere, `throwaway instance ${clientId} deleted from the engine and the service`);
  }

  if (NO_SEND) {
    line(null, 'no-send mode: skipping real messages, restart test and canary');
    return;
  }

  // --- 1. text to the ScaleEzy number ---
  const textKey = `integration-text-${randomUUID()}`;
  const t = await http('POST', '/v1/messages', { from: 'scaleezy', to: SELF, text: 'ScaleEzy WhatsApp service: integration test 1/5 (text). No reply needed.', kind: 'TEST', reference: 'integration', idempotencyKey: textKey }, inv);
  line(t.status === 202, 'text queued -> 202', `id ${t.body?.id}`);
  realSends.push({ id: t.body.id, label: 'text' });
  const tSent = await waitStatus(invKey, t.body.id, ['SENT', 'DELIVERED', 'READ'], 90_000);
  line(['SENT', 'DELIVERED', 'READ'].includes(tSent?.status), 'text SENT', `status ${tSent?.status}`);
  await confirmTicks(invKey, t.body.id, 'text');

  // --- idempotent resend ---
  const again = await http('POST', '/v1/messages', { from: 'scaleezy', to: SELF, text: 'ScaleEzy WhatsApp service: integration test 1/5 (text). No reply needed.', kind: 'TEST', reference: 'integration', idempotencyKey: textKey }, inv);
  const count = await db.message.count({ where: { idempotencyKey: textKey } });
  line(again.body?.id === t.body.id && count === 1, 'idempotent resend returns the same id, nothing new queued', `same id: ${again.body?.id === t.body.id}, rows: ${count}`);

  // --- 2. small PDF ---
  await respectSpacing();
  const pdf = minimalPdf();
  const d = await http(
    'POST',
    '/v1/messages',
    { from: 'scaleezy', to: SELF, text: 'Integration test 2/5 (PDF).', document: { fileName: 'scaleezy-test.pdf', mimeType: 'application/pdf', base64: pdf.toString('base64') }, kind: 'TEST', reference: 'integration', idempotencyKey: `integration-pdf-${randomUUID()}` },
    inv,
  );
  line(d.status === 202, 'PDF queued -> 202', `${pdf.length} bytes`);
  realSends.push({ id: d.body.id, label: 'pdf' });
  const dSent = await waitStatus(invKey, d.body.id, ['SENT', 'DELIVERED', 'READ'], 90_000);
  line(['SENT', 'DELIVERED', 'READ'].includes(dSent?.status), 'PDF SENT', `status ${dSent?.status}`);
  await confirmTicks(invKey, d.body.id, 'PDF');
  const wiped = await db.message.findUnique({ where: { id: d.body.id }, select: { document: true } });
  line(wiped?.document === null, 'PDF bytes wiped once sent');

  // --- module webhooks ---
  await sleep(4000);
  const mine = received.filter((e) => e.type === 'message.status' && [t.body.id, d.body.id].includes(e.data?.messageId));
  line(mine.length >= 2 && mine.every((e) => e.signatureOk), 'module webhook got signed status events', mine.map((e) => `${e.data.status}`).join(','));

  // --- 3+4. restart mid-queue ---
  if (SKIP_RESTART) line(null, 'restart test skipped (--skip-restart)');
  else await restartTest(invKey, inv, acc!.id);

  // --- 5. canary (once) ---
  await respectSpacing();
  const c = await http('POST', '/admin/canary/run', {}, { 'x-admin-key': ADMIN });
  line(c.status === 202 && c.body?.outcome === 'PENDING', 'canary started', `outcome ${c.body?.outcome}`);
  if (c.body?.messageId) realSends.push({ id: c.body.messageId, label: 'canary' });
  let outcome = 'PENDING';
  let detail = '';
  const until = Date.now() + 11 * 60_000;
  while (Date.now() < until && outcome === 'PENDING') {
    await sleep(10_000);
    const runs = await http('GET', '/admin/canary', undefined, { 'x-admin-key': ADMIN });
    const run = runs.body?.runs?.find((x: any) => x.id === c.body?.id);
    outcome = run?.outcome ?? 'PENDING';
    detail = run?.detail ?? '';
  }
  line(outcome === 'OK', 'canary confirmed and recorded at /admin/canary', detail || outcome);
}

async function restartTest(invKey: string, inv: Record<string, string>, accountId: string): Promise<void> {
  await respectSpacing();
  const q1 = await http('POST', '/v1/messages', { from: 'scaleezy', to: SELF, text: 'Integration test 3/5 (restart test, first).', kind: 'TEST', reference: 'integration', idempotencyKey: `integration-r1-${randomUUID()}` }, inv);
  const q2 = await http('POST', '/v1/messages', { from: 'scaleezy', to: SELF, text: 'Integration test 4/5 (restart test, second).', kind: 'TEST', reference: 'integration', idempotencyKey: `integration-r2-${randomUUID()}` }, inv);
  realSends.push({ id: q1.body.id, label: 'restart-1' }, { id: q2.body.id, label: 'restart-2' });
  await waitStatus(invKey, q1.body.id, ['SENT', 'DELIVERED', 'READ'], 90_000);
  // Kill hard while the second waits for its gap (on Windows this is a hard kill, like a crash).
  const running = service!;
  const exited = new Promise((r) => running.once('exit', r));
  running.kill();
  await exited;
  line(null, 'service killed with the second message still queued');
  const r2 = await db.message.findUniqueOrThrow({ where: { id: q2.body.id } });
  // Make it the worst case: the crash happened mid-send, before the engine answered.
  if (r2.status === 'QUEUED') {
    await db.message.update({ where: { id: q2.body.id }, data: { status: 'SENDING', sendingAt: new Date(Date.now() - 3 * 60_000) } });
  }
  // And one that WAS sent (engine id known) but not marked: must never go again.
  const ghost = await db.message.create({
    data: { accountId: accountId, toDigits: SELF, kind: 'TEST', reference: 'integration-ghost', idempotencyKey: `integration-ghost-${randomUUID()}`, contentHash: randomUUID(), text: 'never sent by this test', status: 'SENDING', sendingAt: new Date(Date.now() - 3 * 60_000), engineMessageId: `INTEGRATION-GHOST-${Date.now()}` },
  });
  await sleep(MIN_SPACING_MS);
  service = startService();
  line(await waitReady(), 'service restarted');
  const r2done = await waitStatus(invKey, q2.body.id, ['SENT', 'DELIVERED', 'READ'], 120_000);
  line(['SENT', 'DELIVERED', 'READ'].includes(r2done?.status), 'message stuck mid-send was recovered and sent after the restart', `status ${r2done?.status}`);
  const g = await db.message.findUniqueOrThrow({ where: { id: ghost.id } });
  line(g.status === 'SENT', 'a message with an engine id was marked SENT, not sent again', `status ${g.status}`);
  await db.message.delete({ where: { id: ghost.id } });
  const both = await db.message.findMany({ where: { id: { in: [q1.body.id, q2.body.id] } } });
  line(both.every((m) => m.engineMessageId) && new Set(both.map((m) => m.engineMessageId)).size === 2, 'each restart-test message sent exactly once');
}

/**
 * The engine's own event about the message must reach the service. A delivered tick is waited
 * for briefly but cannot come here: WhatsApp sends none for messages to one's own number (and
 * the server tick only when the phone next syncs), and this build may message nobody else.
 */
async function confirmTicks(invKey: string, id: string, label: string): Promise<void> {
  const until = Date.now() + 60_000;
  let m: any = null;
  while (Date.now() < until) {
    m = (await http('GET', `/v1/messages/${id}`, undefined, { 'x-module-key': invKey })).body;
    if (m?.engineConfirmedAt) break;
    await sleep(1500);
  }
  line(Boolean(m?.engineConfirmedAt), `${label}: confirmed by the engine's own event (webhook path works)`, `sent ${m?.sentAt}, engine confirmed ${m?.engineConfirmedAt}`);
  await sleep(15_000);
  m = (await http('GET', `/v1/messages/${id}`, undefined, { 'x-module-key': invKey })).body;
  line(null, `${label}: delivered tick`, m?.deliveredAt ? `DELIVERED at ${m.deliveredAt}` : 'none, as expected for a message to yourself');
}

async function finish(): Promise<void> {
  // Report every real message: recipient (masked), times, spacing.
  if (realSends.length) {
    const rows = await db.message.findMany({ where: { id: { in: realSends.map((s) => s.id) } }, orderBy: { sentAt: 'asc' } });
    const others = rows.filter((r) => r.toDigits !== SELF);
    line(others.length === 0, 'every real message went to the ScaleEzy number only', `${rows.length} message(s) to ${maskPhone(SELF)}`);
    let minGap = Infinity;
    for (let i = 1; i < rows.length; i++) {
      const a = rows[i - 1]!.sentAt;
      const b = rows[i]!.sentAt;
      if (a && b) minGap = Math.min(minGap, b.getTime() - a.getTime());
    }
    for (const r of rows) {
      const label = realSends.find((s) => s.id === r.id)?.label;
      line(null, `real message ${label}: ${r.status}`, `sent ${r.sentAt?.toISOString() ?? '-'}, delivered ${r.deliveredAt?.toISOString() ?? '-'}`);
    }
    if (rows.length > 1) line(minGap >= MIN_SPACING_MS, 'real messages at least 10 s apart', `smallest gap ${Math.round(minGap / 100) / 10} s`);
  }
  if (service && service.exitCode === null) {
    if (failures) {
      const tail = (service as ChildProcess & { tail?: string[] }).tail ?? [];
      process.stdout.write(`\nLast service log lines:\n${tail.slice(-15).join('\n')}\n`);
    }
    service.kill();
  }
  await db.$disconnect();
  process.stdout.write(`\n${failures === 0 ? 'Integration run passed.' : `Integration run FAILED (${failures} check(s)).`}\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main()
  .catch((e: Error) => {
    failures++;
    process.stdout.write(`FAIL  integration run stopped: ${e.message}\n`);
  })
  .finally(() => void finish());
