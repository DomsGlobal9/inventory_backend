import { prisma } from '../lib/prisma';
import { getShopSettings } from '../lib/clientSettings';
import { startOfLocalDay, todayKey } from '../utils/businessDay';
import { grants, holdsEverything } from '../config/permissions';

/**
 * The Dashboard's "your day" cards, one per permission.
 *
 * Built from PERMISSIONS, never role names: a shop that edits Sales, or makes its own "Counter
 * staff" role, gets exactly the cards its permissions allow. A card the person may not see is not
 * computed and not sent at all -- the screen never has to say "not part of your role".
 *
 * Scoped to the store picked at the top of the app when one is, like the rest of the Dashboard.
 */
export interface MyDay {
  bills?: { count: number; total: number };
  returnsWaiting?: number;
  returnsToInspect?: number;
  customersToday?: number;
  transfersOnTheWay?: number;
}

export async function myDay(clientId: string, user: { permissions?: string[]; roles?: string[] }, locationId?: string): Promise<MyDay> {
  const may = (key: string) => holdsEverything(user.permissions ?? [], user.roles ?? []) || grants(user.permissions ?? [], key);
  const { timezone } = await getShopSettings(clientId);
  const since = startOfLocalDay(todayKey(timezone), timezone);
  const store = locationId ? { locationId } : {};
  const out: MyDay = {};

  await Promise.all([
    may('sales_order:view') && prisma.salesOrder.aggregate({
      where: { clientId, ...store, deletedAt: null, status: { not: 'CANCELLED' }, createdAt: { gte: since } },
      _count: { _all: true }, _sum: { total: true }
    }).then(r => { out.bills = { count: r._count._all, total: Number(r._sum.total ?? 0) }; }),
    // Still to finish: asked for, or in and not yet closed. Rejected and completed are done.
    may('return:view') && prisma.salesReturn.count({
      where: { clientId, ...store, status: { in: ['REQUESTED', 'RECEIVED', 'INSPECTED'] } }
    }).then(n => { out.returnsWaiting = n; }),
    may('return:inspect') && prisma.salesReturn.count({
      where: { clientId, ...store, status: 'RECEIVED' }
    }).then(n => { out.returnsToInspect = n; }),
    may('customer:view') && prisma.customer.count({
      where: { clientId, deletedAt: null, createdAt: { gte: since } }
    }).then(n => { out.customersToday = n; }),
    // On the way to or from this store; every store's when none is picked.
    may('inventory:transfer') && prisma.inventoryTransfer.count({
      where: {
        clientId, status: { in: ['APPROVED', 'IN_TRANSIT'] },
        ...(locationId ? { OR: [{ fromLocationId: locationId }, { toLocationId: locationId }] } : {})
      }
    }).then(n => { out.transfersOnTheWay = n; })
  ]);
  return out;
}
