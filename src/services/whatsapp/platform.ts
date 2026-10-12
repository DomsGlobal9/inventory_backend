/**
 * The Platform Console's WhatsApp screen: ScaleEzy's own number (see it, reconnect it, link it
 * again) and every shop's number, read-only.
 *
 * Through Inventory's own module key, which the service lets do this only once it is granted
 * `--can-manage-scaleezy` (create-module). Never the service's ADMIN_KEY: that key also reads every
 * message, and keeping it in one place is the point. Phones arrive masked; nothing here sees a
 * message.
 */
import { prisma } from '../../lib/prisma';
import { whatsappClient, WhatsAppServiceError, type AccountStatus, type LinkResult } from './client';

export type PlatformAccount = {
  id: string; kind: 'SCALEEZY' | 'CLIENT'; clientId: string | null; phone: string | null; status: AccountStatus;
  linkedAt: string | null; lastSeenAt: string | null; queued: number;
};

const NOT_GRANTED =
  'Inventory is not allowed to manage ScaleEzy’s WhatsApp number yet. On the WhatsApp service, run once: ' +
  'node dist/scripts/create-module.js --name inventory --can-manage-scaleezy (the key stays the same).';

/** A refusal the console can show as it is; anything else is left to throw. */
function problemOf(e: unknown): string | null {
  if (!(e instanceof WhatsAppServiceError)) return null;
  if (e.statusCode === 403) return NOT_GRANTED;
  // An older service without these routes answers 404: same fix, after its deploy.
  if (e.statusCode === 404) return 'The WhatsApp service is older than this screen. Deploy the WhatsApp service, then grant Inventory --can-manage-scaleezy.';
  return e.message;
}

export async function overview() {
  let accounts: PlatformAccount[];
  try {
    accounts = await whatsappClient.platformAccounts();
  } catch (e) {
    const problem = problemOf(e);
    if (problem) return { problem, scaleezy: null, shops: [] };
    throw e;
  }
  const shops = accounts.filter(a => a.kind === 'CLIENT' && a.clientId);
  const names = new Map((await prisma.clientSettings.findMany({
    where: { clientId: { in: shops.map(s => s.clientId!) } }, select: { clientId: true, businessName: true }
  })).map(s => [s.clientId, s.businessName]));
  const scaleezy = accounts.find(a => a.kind === 'SCALEEZY') ?? null;
  return {
    problem: null,
    scaleezy: scaleezy && { id: scaleezy.id, status: scaleezy.status, phone: scaleezy.phone, linkedAt: scaleezy.linkedAt, lastSeenAt: scaleezy.lastSeenAt, queued: scaleezy.queued },
    // Dropped numbers first: that is what an admin opens this screen to find.
    shops: shops
      .map(s => ({ clientId: s.clientId!, businessName: names.get(s.clientId!) ?? null, status: s.status, phone: s.phone, lastSeenAt: s.lastSeenAt, queued: s.queued }))
      .sort((a, b) => Number(a.status === 'CONNECTED') - Number(b.status === 'CONNECTED') || a.clientId.localeCompare(b.clientId))
  };
}

export async function link(method: unknown, phone: unknown): Promise<LinkResult> {
  if (method !== 'qr' && method !== 'code') throw new WhatsAppServiceError(400, 'Choose QR code or pairing code.');
  const digits = typeof phone === 'string' ? phone.replace(/\D/g, '') : '';
  if (method === 'code' && digits.length < 10) throw new WhatsAppServiceError(400, 'Type ScaleEzy’s WhatsApp number to get a pairing code.');
  try {
    return await whatsappClient.platformLinkScaleezy(method, method === 'code' ? digits : undefined);
  } catch (e) {
    const problem = problemOf(e);
    if (problem && e instanceof WhatsAppServiceError) throw new WhatsAppServiceError(e.statusCode === 403 || e.statusCode === 404 ? 409 : e.statusCode, problem);
    throw e;
  }
}

/** Wakes the ScaleEzy connection up without logging it out: nothing to scan. */
export async function reconnect() {
  const now = await overview();
  if (now.problem) throw new WhatsAppServiceError(409, now.problem);
  if (!now.scaleezy) throw new WhatsAppServiceError(409, 'ScaleEzy’s number has never been linked. Use Link again.');
  return whatsappClient.platformReconnect(now.scaleezy.id);
}
