// Links the ScaleEzy number after a deploy. The engine is on Render's private network, so the QR
// comes through the service's admin API:
//
//   ADMIN_KEY=... npm run link:scaleezy -- --base https://whatsapp-service.onrender.com
//       writes scaleezy-qr.html (open it, scan with WhatsApp > Linked devices); refreshes until linked
//   ADMIN_KEY=... npm run link:scaleezy -- --base https://... --code 918142424642
//       prints an 8-letter pairing code instead (WhatsApp > Linked devices > Link with phone number)
//
// Safe to run again: a number that is already connected is left alone.

import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadDotEnv } from '../src/lib/dotenv';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function link(base: string, adminKey: string, body: object): Promise<{ status?: string; qr?: string; pairingCode?: string }> {
  const res = await fetch(`${base}/admin/scaleezy/link`, {
    method: 'POST',
    headers: { 'x-admin-key': adminKey, 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(90_000),
  });
  const json = (await res.json().catch(() => ({}))) as { status?: string; qr?: string; pairingCode?: string; error?: { message?: string } };
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${json.error?.message ?? 'no details'}`);
  return json;
}

async function main(): Promise<void> {
  loadDotEnv();
  const base = (arg('base') ?? '').replace(/\/+$/, '');
  const adminKey = process.env.ADMIN_KEY;
  const phone = arg('code');
  if (!/^https?:\/\//.test(base)) throw new Error('Give --base https://your-service-url');
  if (!adminKey) throw new Error('Set ADMIN_KEY in the environment; it is never passed on the command line.');

  if (phone) {
    const out = await link(base, adminKey, { method: 'code', phone });
    if (out.status === 'CONNECTED') return void console.log('The ScaleEzy number is already linked. Nothing to do.');
    console.log(`Pairing code: ${out.pairingCode}`);
    console.log('On the phone: WhatsApp > Linked devices > Link a device > Link with phone number instead, then type the code.');
    return;
  }

  const file = resolve('scaleezy-qr.html');
  for (let i = 0; i < 40; i++) {
    const out = await link(base, adminKey, { method: 'qr' });
    if (out.status === 'CONNECTED') {
      writeFileSync(file, '<!doctype html><meta charset="utf-8"><h2 style="font-family:system-ui">Linked. You can close this page.</h2>');
      console.log(i === 0 ? 'The ScaleEzy number is already linked. Nothing to do.' : 'The ScaleEzy number is linked.');
      return;
    }
    writeFileSync(
      file,
      `<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="5"><title>Link ScaleEzy WhatsApp</title>
<body style="font-family:system-ui;text-align:center;padding:30px"><h2>Scan with the ScaleEzy phone</h2>
<p>WhatsApp &gt; Linked devices &gt; Link a device</p><img src="${out.qr}" width="300" height="300"></body>`,
    );
    if (i === 0) console.log(`Open ${file} in a browser and scan the code. It refreshes by itself; this waits until the phone is linked.`);
    await sleep(15_000);
  }
  throw new Error('Not linked after 10 minutes. Run it again.');
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
