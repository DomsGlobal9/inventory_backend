import { prisma } from './prisma';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * USER / SYSTEM, as a person reads it: their name, or "System" when the app did it.
 *
 * A movement's createdBy has been written three ways over time -- the person's name (the
 * Inventory screen), their user id (imports, transfers, bulk updates) and, for bulk updates and
 * opening stock, the shop's own id -- so the ledger printed "lakshmi-silks-demo-..." and raw user
 * ids beside rows that said "Priya Reddy". The writers now record the person or 'SYSTEM'; this
 * reads the old rows too, with one lookup for the whole page rather than one per row.
 */
export async function withPerformerNames<T extends { createdBy: string | null }>(clientId: string, rows: T[]): Promise<T[]> {
  const ids = [...new Set(rows.map(r => r.createdBy).filter((v): v is string => !!v && UUID.test(v)))];
  const names = new Map<string, string>();
  if (ids.length) {
    for (const u of await prisma.user.findMany({ where: { clientId, id: { in: ids } }, select: { id: true, name: true, email: true } })) {
      names.set(u.id, u.name || u.email);
    }
  }
  return rows.map(r => {
    const by = (r.createdBy || '').trim();
    let shown: string;
    if (!by || by === clientId || by.toUpperCase() === 'SYSTEM') shown = 'System';
    // An id that is not one of this shop's people: somebody since removed from the team.
    else if (UUID.test(by)) shown = names.get(by) ?? 'A former team member';
    else shown = by;
    return { ...r, createdBy: shown };
  });
}
