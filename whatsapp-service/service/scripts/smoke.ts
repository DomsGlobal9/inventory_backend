// Post-deploy smoke test. Run after every deploy (and after any engine change):
//
//   ADMIN_KEY=... npm run smoke -- --base https://whatsapp-service.onrender.com
//   ADMIN_KEY=... npm run smoke -- --base https://... --canary     (also sends the canary; waits up to 11 min)
//
// Checks: /health, /ready (database + engine), and that every number the service believes is
// CONNECTED really is connected in the engine. Exits non-zero on any failure.

import { loadDotEnv } from '../src/lib/dotenv';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

let failures = 0;
function report(ok: boolean, what: string, detail = ''): void {
  if (!ok) failures++;
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'}  ${what}${detail ? `  (${detail})` : ''}\n`);
}

async function getJson(url: string, headers: Record<string, string> = {}, method = 'GET'): Promise<{ status: number; body: unknown }> {
  const res = await fetch(url, { method, headers, signal: AbortSignal.timeout(30_000) });
  const text = await res.text();
  let body: unknown = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = text.slice(0, 200);
  }
  return { status: res.status, body };
}

async function main(): Promise<void> {
  loadDotEnv();
  const base = (arg('base') ?? '').replace(/\/+$/, '');
  const adminKey = process.env.SMOKE_ADMIN_KEY ?? process.env.ADMIN_KEY;
  if (!/^https?:\/\//.test(base)) throw new Error('Give --base https://your-service-url');
  if (!adminKey) throw new Error('Set ADMIN_KEY (or SMOKE_ADMIN_KEY) in the environment; it is never passed on the command line.');
  const admin = { 'x-admin-key': adminKey };

  const health = await getJson(`${base}/health`);
  report(health.status === 200, 'GET /health', `HTTP ${health.status}`);

  const ready = await getJson(`${base}/ready`);
  const r = ready.body as { db?: boolean; engine?: boolean };
  report(ready.status === 200, 'GET /ready', `HTTP ${ready.status}, database ${r?.db ? 'ok' : 'DOWN'}, engine ${r?.engine ? 'ok' : 'DOWN'}`);

  const verify = await getJson(`${base}/admin/accounts/verify`, admin);
  if (verify.status !== 200) {
    report(false, 'numbers match the engine', `HTTP ${verify.status}`);
  } else {
    const v = verify.body as { ok: boolean; accounts: Array<{ id: string; kind: string; status: string; engineState: string | null; ok: boolean }> };
    for (const a of v.accounts) {
      report(a.ok, `${a.kind.toLowerCase()} number ${a.id.slice(0, 8)}`, `service says ${a.status}, engine says ${a.engineState ?? 'no instance'}`);
    }
    const scaleezy = v.accounts.find((a) => a.kind === 'SCALEEZY');
    report(scaleezy?.status === 'CONNECTED' && scaleezy.engineState === 'open', 'ScaleEzy number connected');
  }

  if (process.argv.includes('--canary')) {
    const run = await getJson(`${base}/admin/canary/run`, admin, 'POST');
    const started = run.body as { id?: string; outcome?: string; detail?: string };
    if (run.status !== 202 || !started.id) {
      report(false, 'canary started', `HTTP ${run.status}`);
    } else if (started.outcome === 'FAILED') {
      report(false, 'canary', started.detail ?? '');
    } else {
      process.stdout.write('....  canary sent; waiting for it to be confirmed (up to 11 minutes)\n');
      const until = Date.now() + 11 * 60 * 1000;
      let outcome = 'PENDING';
      let detail = '';
      while (Date.now() < until && outcome === 'PENDING') {
        await new Promise((res) => setTimeout(res, 15_000));
        const c = await getJson(`${base}/admin/canary`, admin);
        const found = (c.body as { runs?: Array<{ id: string; outcome: string; detail: string | null }> }).runs?.find((x) => x.id === started.id);
        outcome = found?.outcome ?? 'PENDING';
        detail = found?.detail ?? '';
      }
      report(outcome === 'OK', 'canary passed', detail || outcome);
    }
  }

  process.stdout.write(failures === 0 ? '\nSmoke test passed.\n' : `\nSmoke test FAILED (${failures} check(s)).\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e: Error) => {
  process.stderr.write(`Smoke test could not run: ${e.message}\n`);
  process.exit(2);
});
