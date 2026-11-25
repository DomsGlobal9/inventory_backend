// LOCAL ONLY: queues one message.received, as if a customer had written to a shop's WhatsApp number, for the
// modules that receive customers' messages (CRM). The running service's dispatcher delivers it, signed, like a real
// one -- so a module can test its lead path end to end without a phone. Refuses production and any database that is
// not on this machine.
//
//   npm run message:test -- --client verify-suites-tenant --contact 919876543210 --text "Do you have this in blue?"
//   npm run message:test -- --client verify-suites-tenant --contact 919876543210 --media image
//   (add --name "Asha" for the WhatsApp name; --id <messageId> to send the same message twice)

import { randomBytes } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { loadDotEnv } from '../src/lib/dotenv';
import { enqueueForMessageReaders } from '../src/events/module-events';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return undefined;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : '';
}

async function main(): Promise<void> {
  loadDotEnv();
  const url = process.env.DATABASE_URL ?? '';
  if (process.env.NODE_ENV === 'production') throw new Error('Refusing: this is for a local service only.');
  if (!/@(localhost|127\.0\.0\.1)(:\d+)?\//.test(url)) throw new Error('Refusing: DATABASE_URL is not a database on this machine.');
  const clientId = arg('client');
  const contact = (arg('contact') ?? '').replace(/\D/g, '');
  const media = arg('media');
  const text = arg('text');
  if (!clientId) throw new Error('Give --client <the shop\'s client id>');
  if (!/^\d{10,15}$/.test(contact)) throw new Error('Give --contact as digits with the country code, e.g. 919876543210');
  if (media && !['image', 'video', 'audio', 'document', 'sticker'].includes(media)) throw new Error('--media is image, video, audio, document or sticker');
  if (!text && !media) throw new Error('Give --text, --media, or both');

  const db = new PrismaClient();
  try {
    const account = await db.account.findFirst({ where: { kind: 'CLIENT', clientId } });
    if (!account) throw new Error(`No WhatsApp number for "${clientId}" in this service. Link one (or seed an account) first.`);
    const messageId = arg('id') || `TEST-${randomBytes(8).toString('hex').toUpperCase()}`;
    const n = await db.$transaction((tx) => enqueueForMessageReaders(tx, {
      accountId: account.id, clientId: account.clientId, kind: account.kind,
      contact, messageId, text: text ? text.slice(0, 4096) : null, media: media ? { type: media } : null,
      pushName: arg('name') || null, at: new Date().toISOString(),
    }));
    process.stdout.write(n
      ? `Queued message.received (${messageId}) for ${n} module${n === 1 ? '' : 's'}; the running service delivers it.\n`
      : 'No module receives customers\' messages yet. Give one the permission: npm run module:create -- --name crm --receives-messages\n');
  } finally {
    await db.$disconnect();
  }
}

main().catch((e: Error) => {
  process.stderr.write(`${e.message}\n`);
  process.exit(1);
});
