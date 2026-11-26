/**
 * The suite server (26 Nov 2026): a second LOCAL backend for the suites that need stand-ins, with the stand-ins.
 *
 *   storage stand-in    127.0.0.1:18200   Supabase storage API (upload / public read / download / list / remove /
 *                                         signed upload) into a temp folder -- no test picture reaches real storage
 *   WhatsApp stand-in   127.0.0.1:18199   accepts every message, writes it to whatsapp.jsonl (OTP codes for robots)
 *   Razorpay stand-in   127.0.0.1:18300   orders, UPI QR codes (+ /bharatqr/pay/test to "pay" one), VPA checks
 *   the backend         PORT (4046)       the env it is started with, plus the overrides below
 *
 * Overrides, forced last: SUPABASE_URL, WHATSAPP_SERVICE_URL, RAZORPAY_API_URL -> the stand-ins; POS_EVENTS_URL ->
 * 4187 (verify-pos-push listens there); POS_API_URL -> 4197 (verify-pos-switch's stand-in POS, so a real local POS
 * on 4007 is never in the way); PAYMENTS_ALLOW_TEST_KEYS; a high rate limit.
 * Refuses to start unless DATABASE_URL and DIRECT_URL are the local database.
 *
 *   started from .claude/launch.json "backend-suites-4046" (the 4036 env + PORT 4046), or:
 *   node src/scripts/support/suite-server.mjs
 */
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const LOCAL = 'localhost:55433';
if (!String(process.env.DATABASE_URL || '').includes(LOCAL) || !String(process.env.DIRECT_URL || '').includes(LOCAL)) {
  console.error('suite-server: refusing to start -- DATABASE_URL and DIRECT_URL must both be the local database.');
  process.exit(2);
}

export const STANDINS = path.join(os.tmpdir(), 'scaleezy-suite-standins');
const FILES = path.join(STANDINS, 'storage');
fs.mkdirSync(FILES, { recursive: true });

const body = (req) => new Promise((resolve) => { const parts = []; req.on('data', c => parts.push(c)); req.on('end', () => resolve(Buffer.concat(parts))); });
const json = (res, status, data) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(data)); };
const safe = (p) => { const full = path.join(FILES, p); if (!full.startsWith(FILES)) throw new Error('outside'); return full; };
const TYPES = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif', '.mp4': 'video/mp4', '.pdf': 'application/pdf' };

// ── storage ─────────────────────────────────────────────────────────────────────────────────────
http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    const p = decodeURIComponent(url.pathname);
    const raw = await body(req);
    let m;
    if ((m = p.match(/^\/storage\/v1\/object\/(?:public|authenticated)\/(.+)$/)) && req.method === 'GET' || (m = p.match(/^\/storage\/v1\/object\/(?!list\/|sign\/|upload\/)(.+)$/)) && req.method === 'GET') {
      const file = safe(m[1]);
      if (!fs.existsSync(file)) return json(res, 404, { statusCode: '404', error: 'not_found', message: 'Object not found' });
      res.writeHead(200, { 'content-type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream' });
      return res.end(fs.readFileSync(file));
    }
    if ((m = p.match(/^\/storage\/v1\/object\/upload\/sign\/(.+)$/))) {
      if (req.method === 'POST') return json(res, 200, { url: `/object/upload/sign/${m[1]}?token=standin-${crypto.randomBytes(6).toString('hex')}` });
      const file = safe(m[1]); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, raw);
      return json(res, 200, { Key: m[1] });
    }
    if ((m = p.match(/^\/storage\/v1\/object\/list\/([^/]+)$/)) && req.method === 'POST') {
      const q = raw.length ? JSON.parse(raw.toString()) : {};
      const dir = safe(path.join(m[1], q.prefix || ''));
      const names = fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }) : [];
      return json(res, 200, names.slice(q.offset || 0, (q.offset || 0) + (q.limit || 100)).map(d => ({ name: d.name, id: d.isFile() ? d.name : null, metadata: d.isFile() ? { size: fs.statSync(path.join(dir, d.name)).size } : null })));
    }
    if ((m = p.match(/^\/storage\/v1\/object\/([^/]+)$/)) && req.method === 'DELETE') {
      const q = raw.length ? JSON.parse(raw.toString()) : {};
      const gone = [];
      for (const pre of q.prefixes || []) { const f = safe(path.join(m[1], pre)); if (fs.existsSync(f)) { fs.rmSync(f, { force: true }); gone.push({ name: pre }); } }
      return json(res, 200, gone);
    }
    if ((m = p.match(/^\/storage\/v1\/object\/(.+)$/)) && (req.method === 'POST' || req.method === 'PUT')) {
      const file = safe(m[1]);
      if (req.method === 'POST' && fs.existsSync(file) && String(req.headers['x-upsert']) !== 'true') return json(res, 400, { statusCode: '409', error: 'Duplicate', message: 'The resource already exists' });
      let data = raw;
      const ct = String(req.headers['content-type'] || '');
      if (ct.startsWith('multipart/form-data')) {   // a Blob/File upload: keep the part that carries the file
        const boundary = '--' + ct.split('boundary=')[1];
        const parts = raw.toString('latin1').split(boundary).filter(x => x.includes('\r\n\r\n'));
        const file = parts.find(x => /filename=/.test(x)) || parts[parts.length - 1];
        data = Buffer.from(file.slice(file.indexOf('\r\n\r\n') + 4).replace(/\r\n$/, ''), 'latin1');
      }
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, data);
      return json(res, 200, { Key: m[1], Id: crypto.randomUUID() });
    }
    if (p.startsWith('/storage/v1/bucket')) return json(res, 200, []);
    json(res, 404, { message: `not in the storage stand-in: ${req.method} ${p}` });
  } catch (e) { json(res, 400, { message: String(e?.message || e) }); }
}).listen(18200, '127.0.0.1', () => console.log('storage stand-in on 18200 ->', FILES));

// ── WhatsApp ────────────────────────────────────────────────────────────────────────────────────
const WA_LOG = path.join(STANDINS, 'whatsapp.jsonl');
const linked = new Set();
http.createServer(async (req, res) => {
  const raw = (await body(req)).toString();
  // Like a real shop that never linked WhatsApp, unless a suite links it for its run (POST /standin/link|unlink).
  let m;
  if (req.method === 'POST' && (m = (req.url || '').match(/^\/standin\/(link|unlink)\/(.+)$/))) {
    if (m[1] === 'link') linked.add(decodeURIComponent(m[2])); else linked.delete(decodeURIComponent(m[2]));
    return json(res, 200, { linked: [...linked] });
  }
  if (req.method === 'GET' && (m = (req.url || '').match(/^\/v1\/accounts\/client\/([^/?]+)/))) {
    const id = decodeURIComponent(m[1]);
    return json(res, 200, { clientId: id, status: linked.has(id) ? 'CONNECTED' : 'NOT_LINKED', phone: linked.has(id) ? '••••0000' : null });
  }
  if (req.method === 'GET' && (req.url || '').startsWith('/v1/platform/accounts')) return json(res, 200, []);
  if (req.method === 'POST' && /\/messages/.test(req.url || '')) {
    const b = raw ? JSON.parse(raw) : {};
    fs.appendFileSync(WA_LOG, JSON.stringify({ at: new Date().toISOString(), to: b.to, text: b.text ?? b.body ?? null }) + '\n');
    return json(res, 200, { id: `standin-${Date.now()}`, status: 'SENT' });
  }
  json(res, 200, { ok: true });
}).listen(18199, '127.0.0.1', () => console.log('WhatsApp stand-in on 18199 ->', WA_LOG));

// ── Razorpay ────────────────────────────────────────────────────────────────────────────────────
const qrs = new Map(); const pays = new Map();
http.createServer(async (req, res) => {
  const raw = (await body(req)).toString();
  const b = raw ? JSON.parse(raw) : {};
  const p = new URL(req.url, 'http://x').pathname.replace(/^\/v1/, '');
  let m;
  if (req.method === 'POST' && p === '/payments/qr_codes') {
    const id = `qr_${crypto.randomBytes(7).toString('hex')}`;
    const qr = { id, entity: 'qr_code', status: 'active', usage: b.usage, type: b.type, payment_amount: b.payment_amount, payments_amount_received: 0, close_by: b.close_by, image_url: `http://127.0.0.1:18300/qr/${id}.png`, notes: b.notes || {} };
    qrs.set(id, qr); return json(res, 200, qr);
  }
  if ((m = p.match(/^\/qr\/(.+)\.png$/))) { res.writeHead(200, { 'content-type': 'image/png' }); return res.end(Buffer.alloc(800, 1)); }
  if ((m = p.match(/^\/payments\/qr_codes\/([^/]+)$/)) && req.method === 'GET') return qrs.has(m[1]) ? json(res, 200, qrs.get(m[1])) : json(res, 400, { error: { description: 'The id provided does not exist' } });
  if ((m = p.match(/^\/payments\/qr_codes\/([^/]+)\/close$/))) { const q = qrs.get(m[1]); if (!q) return json(res, 400, { error: { description: 'The id provided does not exist' } }); q.status = 'closed'; return json(res, 200, q); }
  if ((m = p.match(/^\/payments\/qr_codes\/([^/]+)\/payments$/))) { const items = [...pays.values()].filter(x => x.qr === m[1]).map(x => x.pay); return json(res, 200, { entity: 'collection', count: items.length, items }); }
  if (req.method === 'POST' && p === '/bharatqr/pay/test') {
    const q = qrs.get(b.reference); if (!q || q.status !== 'active') return json(res, 400, { error: { description: 'QR is not active' } });
    const pay = { id: `pay_${crypto.randomBytes(7).toString('hex')}`, entity: 'payment', amount: b.amount, currency: 'INR', status: 'captured', method: 'upi', captured: true, created_at: Math.floor(Date.now() / 1000) };
    pays.set(pay.id, { qr: q.id, pay }); q.payments_amount_received += b.amount; if (q.usage === 'single_use') q.status = 'closed';
    return json(res, 200, pay);
  }
  if ((m = p.match(/^\/payments\/([^/]+)$/)) && pays.has(m[1])) return json(res, 200, pays.get(m[1]).pay);
  if (req.method === 'POST' && p === '/payments/validate/vpa') return json(res, 200, { vpa: b.vpa, success: true, customer_name: 'STAND-IN HOLDER' });
  if (req.method === 'POST' && p === '/orders') return json(res, 200, { id: `order_${crypto.randomBytes(5).toString('hex')}`, amount: b.amount, currency: b.currency, status: 'created' });
  if (req.method === 'GET' && p.startsWith('/orders')) return json(res, 200, { entity: 'collection', count: 0, items: [] });
  json(res, 404, { error: { description: `not in the Razorpay stand-in: ${req.method} ${p}` } });
}).listen(18300, '127.0.0.1', () => console.log('Razorpay stand-in on 18300'));

// ── the backend ─────────────────────────────────────────────────────────────────────────────────
const backend = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const env = {
  ...process.env,
  PORT: process.env.PORT || '4046',
  SUPABASE_URL: 'http://127.0.0.1:18200', TARGET_SUPABASE_URL: 'http://127.0.0.1:18200', SUPABASE_SERVICE_ROLE_KEY: 'standin-key-local-only-0001',
  WHATSAPP_SERVICE_URL: 'http://127.0.0.1:18199', WHATSAPP_SERVICE_KEY: 'standin-key-local-only-0001',
  RAZORPAY_API_URL: 'http://127.0.0.1:18300/v1',
  POS_EVENTS_URL: 'http://localhost:4187/api/v1/inventory/events', POS_API_URL: 'http://127.0.0.1:4197/api/v1',
  PAYMENTS_ALLOW_TEST_KEYS: 'true', RATE_LIMIT_MAX: '100000'
};
const child = spawn('npx', ['tsx', 'src/server.ts'], { cwd: backend, env, stdio: 'inherit', shell: true });
child.on('exit', (c) => process.exit(c ?? 0));
for (const s of ['SIGINT', 'SIGTERM']) process.on(s, () => { child.kill(); process.exit(0); });
