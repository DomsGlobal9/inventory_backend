/**
 * Erased customers, for the ScaleEzy POS till (12 Nov 2026).
 *
 * When a customer is erased or removed in Inventory -- by the owner (customer-delete), or by Shopify's
 * privacy requests -- the till must erase its own copy of that person, or it would go on billing and
 * messaging the old record. The till and Inventory share only the phone number (the till's customerRef),
 * and the customer row no longer has it after the erase, so the number is noted here at that moment.
 *
 * Kept for KEEP_DAYS and then deleted: long enough for a till that was switched off over a long weekend to
 * catch up, short enough that Inventory does not quietly keep a list of the people it erased. The till asks
 * with its own key (GET /pos/v1/erasures?since=), its shop only, in order, a page at a time.
 */
import type { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma';

export const KEEP_DAYS = 30;
const PAGE = 200;

type Tx = Prisma.TransactionClient;

/** Note the numbers of people just erased, inside the caller's transaction. Empty or missing numbers are skipped. */
export async function noteErasures(tx: Tx, clientId: string, phones: (string | null | undefined)[]) {
  const clean = [...new Set(phones.map(p => String(p ?? '').trim()).filter(Boolean))];
  if (!clean.length) return 0;
  const r = await tx.customerErasure.createMany({ data: clean.map(phone => ({ clientId, phone })) });
  return r.count;
}

/**
 * The erasures after `since` (the `next` of the last page; 0 or nothing for the start), oldest first.
 * Rows past KEEP_DAYS are deleted first, so they are never answered.
 */
export async function erasuresAfter(clientId: string, sinceRaw: unknown, now = new Date()) {
  await prisma.customerErasure.deleteMany({ where: { erasedAt: { lt: new Date(now.getTime() - KEEP_DAYS * 86_400_000) } } });
  const text = String(sinceRaw ?? '').trim();
  if (text && !/^\d{1,18}$/.test(text)) throw Object.assign(new Error('since must be the "next" number from the last answer, or left out.'), { statusCode: 400 });
  const since = BigInt(text || '0');
  const rows = await prisma.customerErasure.findMany({
    where: { clientId, sequence: { gt: since } }, orderBy: { sequence: 'asc' }, take: PAGE + 1,
    select: { id: true, sequence: true, phone: true, erasedAt: true }
  });
  const page = rows.slice(0, PAGE);
  const last = page[page.length - 1];
  return {
    erasures: page.map(r => ({ id: r.id, phone: r.phone, erasedAt: r.erasedAt.toISOString() })),
    next: (last ? last.sequence : since).toString(),
    more: rows.length > PAGE,
    keptDays: KEEP_DAYS
  };
}
