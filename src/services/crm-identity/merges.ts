import { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { post as postPoints } from '../loyalty/loyalty.service';
import { post as postCredit } from '../store-credit/store-credit.service';

type Tx = Prisma.TransactionClient;

/**
 * ScaleEzy CRM joined two customers into one (customer.merged), or took that back (customer.unmerged).
 *
 * Inventory's copies follow, in ONE transaction each, so a shop never sees half a join:
 *   - the joined copy's bills, offer uses, past purchases, addresses, boutique profiles, till holds, quotes,
 *     door check-ins, counter look-ups and vouchers bought move to the kept copy, and every moved row is written
 *     down (crm_customer_merges.moved);
 *   - points and store credit move as ONE ledger line each way ("Joined from CUS-0042" / "Joined into
 *     CUS-0007"), never by rewriting either customer's history, so both statements still add up;
 *   - a WhatsApp STOP on either holds for the kept one; offers stay agreed only if one agreed and nobody stopped;
 *   - the joined copy is marked deleted (it leaves every list, its number is free), never removed, so old
 *     receipts still open on it.
 * The undo moves back exactly the rows written down, and the points and credit as far as they are still there:
 * what the kept customer already spent cannot be put back, and that is said in words (undo_note).
 */
const MOVES: { table: string; column: string }[] = [
  { table: 'sales_orders', column: 'customer_id' },
  { table: 'offer_redemptions', column: 'customer_id' },
  { table: 'past_purchases', column: 'customer_id' },
  { table: 'customer_addresses', column: 'customer_id' },
  { table: 'customer_boutique_profiles', column: 'customer_id' },
  { table: 'pos_holds', column: 'customer_id' },
  { table: 'pricing_quotes', column: 'customer_id' },
  { table: 'store_checkins', column: 'customer_id' },
  { table: 'counter_lookups', column: 'customer_id' },
  { table: 'gift_vouchers', column: 'buyer_customer_id' }
];
/** Columns that point at a customer and are deliberately NOT moved (with why). The merge suite checks that the
 * database has no customer column outside MOVES and this list, so a new feature cannot be forgotten here. */
export const NOT_MOVED: Record<string, string> = {
  'loyalty_entries.customer_id': 'history stays; the balance moves as one ledger line',
  'store_credit_entries.customer_id': 'history stays; the balance moves as one ledger line',
  'campaign_recipients.customer_id': 'old campaign sends, a record of what went to that copy',
  'crm_customer_links.customer_id': 'each copy keeps its own link to CRM'
};
export const MOVED_COLUMNS = MOVES.map(m => `${m.table}.${m.column}`);

type Copy = { id: string; customerCode: string; loyaltyPoints: number; storeCreditPaise: number; whatsappOffers: boolean; whatsappStoppedAt: Date | null };
const COPY = { id: true, customerCode: true, loyaltyPoints: true, storeCreditPaise: true, whatsappOffers: true, whatsappStoppedAt: true } as const;

/** Inventory's live copies linked to a CRM customer, oldest first (the oldest is the one kept). */
export async function copiesOf(tx: Tx, clientId: string, crmId: string): Promise<Copy[]> {
  const links = await tx.crmCustomerLink.findMany({ where: { clientId, crmCustomerId: crmId }, select: { customerId: true } });
  if (!links.length) return [];
  return tx.customer.findMany({ where: { clientId, id: { in: links.map(l => l.customerId) }, deletedAt: null }, select: COPY, orderBy: { createdAt: 'asc' } });
}

async function joinOne(tx: Tx, clientId: string, kept: Copy, dropped: Copy, crm: { keptId: string; droppedId: string; eventId: string }) {
  const done = await tx.crmCustomerMerge.findUnique({ where: { crmEventId_droppedId: { crmEventId: crm.eventId, droppedId: dropped.id } } });
  if (done) return 'already';
  const moved: Record<string, string[]> = {};
  for (const m of MOVES) {
    const rows = await tx.$queryRawUnsafe<{ id: string }[]>(
      `UPDATE "${m.table}" SET "${m.column}" = $1 WHERE "${m.column}" = $2 RETURNING id`, kept.id, dropped.id);
    if (rows.length) moved[m.table] = rows.map(r => r.id);
  }
  const note = (dir: 'from' | 'into', code: string) => `${dir === 'from' ? 'Joined from' : 'Joined into'} ${code} (ScaleEzy CRM)`;
  if (dropped.loyaltyPoints !== 0) {
    await postPoints(tx, { clientId, customerId: dropped.id, kind: 'ADJUSTED', points: -dropped.loyaltyPoints, mayGoNegative: true, onceKey: `CRM-JOIN:${crm.eventId}:${dropped.id}:out`, note: note('into', kept.customerCode) });
    await postPoints(tx, { clientId, customerId: kept.id, kind: 'ADJUSTED', points: dropped.loyaltyPoints, mayGoNegative: true, onceKey: `CRM-JOIN:${crm.eventId}:${dropped.id}:in`, note: note('from', dropped.customerCode) });
  }
  if (dropped.storeCreditPaise > 0) {
    await postCredit(tx, { clientId, customerId: dropped.id, kind: 'ADJUSTED', amountPaise: -dropped.storeCreditPaise, onceKey: `CRM-JOIN:${crm.eventId}:${dropped.id}:out`, note: note('into', kept.customerCode) });
    await postCredit(tx, { clientId, customerId: kept.id, kind: 'ADJUSTED', amountPaise: dropped.storeCreditPaise, onceKey: `CRM-JOIN:${crm.eventId}:${dropped.id}:in`, note: note('from', dropped.customerCode) });
  }
  const stoppedAt = kept.whatsappStoppedAt ?? dropped.whatsappStoppedAt;
  await tx.customer.update({
    where: { id: kept.id },
    data: { whatsappStoppedAt: stoppedAt, whatsappOffers: stoppedAt ? false : (kept.whatsappOffers || dropped.whatsappOffers) }
  });
  await tx.customer.update({ where: { id: dropped.id }, data: { deletedAt: new Date() } });
  await tx.crmCustomerMerge.create({
    data: { clientId, keptId: kept.id, droppedId: dropped.id, crmKeptId: crm.keptId, crmDroppedId: crm.droppedId, crmEventId: crm.eventId, moved, points: dropped.loyaltyPoints, creditPaise: Math.max(0, dropped.storeCreditPaise) }
  });
  return 'joined';
}

/** customer.merged { from, into }: CRM's `from` joined into `into`. */
export async function applyMerged(clientId: string, eventId: string, from: string, into: string) {
  return prisma.$transaction(async tx => {
    const dropped = await copiesOf(tx, clientId, from);
    if (!dropped.length) return { outcome: 'nothing-here' as const };
    const kept = await copiesOf(tx, clientId, into);
    if (!kept.length) {
      // Only the joined one has a copy here: it simply becomes the kept customer's copy.
      await tx.crmCustomerLink.updateMany({ where: { clientId, crmCustomerId: from }, data: { crmCustomerId: into, linkedAt: new Date() } });
      return { outcome: 'relinked' as const };
    }
    const results: string[] = [];
    // Several copies of the kept customer (rare): the oldest keeps; the others are joined into it too.
    for (const extra of [...kept.slice(1), ...dropped]) {
      results.push(await joinOne(tx, clientId, kept[0], extra, { keptId: into, droppedId: from, eventId }));
      await tx.crmCustomerLink.update({ where: { customerId: extra.id }, data: { crmCustomerId: into } }).catch(() => undefined);
    }
    return { outcome: 'joined' as const, kept: kept[0].id, joined: results.length };
  }, { timeout: 60_000 });
}

/** customer.unmerged { restored, from }: CRM took back joining `restored` into `from`. */
export async function applyUnmerged(clientId: string, eventId: string, restored: string, from: string) {
  return prisma.$transaction(async tx => {
    const merges = await tx.crmCustomerMerge.findMany({ where: { clientId, crmDroppedId: restored, crmKeptId: from, undoneAt: null } });
    if (!merges.length) return { outcome: 'nothing-here' as const };
    const notes: string[] = [];
    for (const m of merges) {
      const moved = (m.moved ?? {}) as Record<string, string[]>;
      for (const mv of MOVES) {
        const ids = moved[mv.table] ?? [];
        if (ids.length) {
          await tx.$executeRawUnsafe(`UPDATE "${mv.table}" SET "${mv.column}" = $1 WHERE "${mv.column}" = $2 AND id = ANY($3::text[])`, m.droppedId, m.keptId, ids);
        }
      }
      const kept = await tx.customer.findUnique({ where: { id: m.keptId }, select: { customerCode: true, loyaltyPoints: true, storeCreditPaise: true } });
      const dropped = await tx.customer.findUnique({ where: { id: m.droppedId }, select: { customerCode: true, phone: true } });
      if (!kept || !dropped) continue;
      const note = (dir: 'back' | 'from') => dir === 'back' ? `Taken back to ${dropped.customerCode} (ScaleEzy CRM undo)` : `Given back from ${kept.customerCode} (ScaleEzy CRM undo)`;
      const points = Math.min(m.points, Math.max(0, kept.loyaltyPoints));
      if (points > 0) {
        await postPoints(tx, { clientId, customerId: m.keptId, kind: 'ADJUSTED', points: -points, onceKey: `CRM-UNJOIN:${eventId}:${m.id}:out`, note: note('back') });
        await postPoints(tx, { clientId, customerId: m.droppedId, kind: 'ADJUSTED', points, onceKey: `CRM-UNJOIN:${eventId}:${m.id}:in`, note: note('from') });
      }
      if (points < m.points) notes.push(`${m.points - points} points were already spent by ${kept.customerCode} and stay spent.`);
      const credit = Math.min(m.creditPaise, Math.max(0, kept.storeCreditPaise));
      if (credit > 0) {
        await postCredit(tx, { clientId, customerId: m.keptId, kind: 'ADJUSTED', amountPaise: -credit, onceKey: `CRM-UNJOIN:${eventId}:${m.id}:out`, note: note('back') });
        await postCredit(tx, { clientId, customerId: m.droppedId, kind: 'ADJUSTED', amountPaise: credit, onceKey: `CRM-UNJOIN:${eventId}:${m.id}:in`, note: note('from') });
      }
      if (credit < m.creditPaise) notes.push(`₹${((m.creditPaise - credit) / 100).toFixed(2)} of store credit was already used by ${kept.customerCode}.`);
      // Back on the lists. Its number, if somebody live has it meanwhile, stays with them.
      const phoneHeld = dropped.phone ? await tx.customer.findFirst({ where: { clientId, phone: dropped.phone, deletedAt: null, id: { not: m.droppedId } }, select: { id: true } }) : null;
      await tx.customer.update({ where: { id: m.droppedId }, data: { deletedAt: null, ...(phoneHeld ? { phone: null } : {}) } });
      if (phoneHeld) notes.push(`${dropped.customerCode} came back without its number: another customer has it now.`);
      await tx.crmCustomerLink.update({ where: { customerId: m.droppedId }, data: { crmCustomerId: restored } }).catch(() => undefined);
      await tx.crmCustomerMerge.update({ where: { id: m.id }, data: { undoneAt: new Date(), undoEventId: eventId, undoNote: notes.join(' ') || null } });
    }
    return { outcome: 'unjoined' as const, notes };
  }, { timeout: 60_000 });
}
