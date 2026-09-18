// Creates a module (Inventory, CRM, ...) that may call the WhatsApp service, or rotates its key.
// The key and webhook secret are printed ONCE; only the key's sha256 and the encrypted secret
// are stored. Copy them straight into the module's own settings.
//
//   npm run module:create -- --name inventory --webhook-url https://.../whatsapp/events --can-send-as-scaleezy
//   npm run module:create -- --name inventory --rotate-key
//   (production: node dist/scripts/create-module.js --name ...)

import { PrismaClient } from '@prisma/client';
import { encrypt, hashModuleKey, newModuleKey, newWebhookSecret } from '../src/lib/crypto';
import { loadDotEnv } from '../src/lib/dotenv';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return undefined;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : '';
}
const flag = (name: string) => process.argv.includes(`--${name}`);

async function main(): Promise<void> {
  loadDotEnv();
  const name = arg('name');
  const webhookUrl = arg('webhook-url');
  const encKey = process.env.ENCRYPTION_KEY;
  if (!name || !/^[a-z][a-z0-9-]{1,40}$/.test(name)) throw new Error('Give --name, lowercase, e.g. --name inventory');
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is not set');
  if (!encKey || Buffer.from(encKey, 'base64').length !== 32) throw new Error('ENCRYPTION_KEY must be set (32 bytes, base64)');
  if (webhookUrl && !/^https?:\/\//.test(webhookUrl)) throw new Error('--webhook-url must start with http:// or https://');

  const db = new PrismaClient();
  try {
    const existing = await db.moduleClient.findUnique({ where: { name } });
    const key = newModuleKey();
    const secret = webhookUrl ? newWebhookSecret() : null;

    if (existing && !flag('rotate-key')) {
      throw new Error(`Module "${name}" already exists. Use --rotate-key to issue a new key (the old one stops working).`);
    }
    const data = {
      keyHash: hashModuleKey(key),
      ...(webhookUrl !== undefined ? { webhookUrl: webhookUrl || null, webhookSecretEncrypted: secret ? encrypt(secret, encKey) : null } : {}),
      ...(flag('can-send-as-scaleezy') ? { canSendAsScaleEzy: true } : {}),
      ...(flag('no-send-as-scaleezy') ? { canSendAsScaleEzy: false } : {}),
    };
    const mod = existing
      ? await db.moduleClient.update({ where: { id: existing.id }, data })
      : await db.moduleClient.create({ data: { name, ...data } });

    process.stdout.write(
      [
        `Module: ${mod.name} (${mod.id})`,
        `Can send as ScaleEzy: ${mod.canSendAsScaleEzy ? 'yes' : 'no'}`,
        `Webhook: ${mod.webhookUrl ?? '(none)'}`,
        '',
        'Shown once. Store in the module\'s secret settings now:',
        `  WHATSAPP_SERVICE_KEY=${key}`,
        ...(secret ? [`  WHATSAPP_WEBHOOK_SECRET=${secret}`] : []),
        '',
      ].join('\n'),
    );
  } finally {
    await db.$disconnect();
  }
}

main().catch((e: Error) => {
  process.stderr.write(`${e.message}\n`);
  process.exit(1);
});
