import { prisma } from '../../lib/prisma';
import { POS_ONLY, SKIP_KIND } from '../../utils/posConnection';

const DAY = 86_400_000;

/**
 * How long a bill may wait before it counts as stuck. The queue worker picks a bill up within
 * seconds and gives a dead instance's work back after five minutes (STRANDED_MS in
 * pos-queue.service), so anything older than that is not slowness -- nothing is working on it.
 */
const STUCK_MS = 5 * 60 * 1000;

export type TillHealthState = 'STUCK' | 'CHECK' | 'NO_BILLS' | 'OK';

export interface TillHealthProblem {
  invoiceNo: string;
  kind: string;
  status: string;
  answer: string | null;
  detail: string | null;
  attempts: number;
  receivedAt: Date;
}

export interface TillHealthRow {
  clientId: string;
  tills: number;
  lastBillAt: Date | null;
  waiting: number;
  stuck: number;
  refused7d: number;
  state: TillHealthState;
  problems: TillHealthProblem[];
}

const RANK: Record<TillHealthState, number> = { STUCK: 0, CHECK: 1, NO_BILLS: 2, OK: 3 };

/**
 * Bills sent from POS tills, per shop, for the Platform Console.
 *
 * The shop's own Settings shows its tills and when a bill last came in. What nobody could see
 * was a bill Inventory REFUSED or one sitting in the queue with nothing working on it -- the
 * October incident where the till sent a kind Inventory did not know yet was found from logs.
 * Read-only: a refused bill is re-opened by the till sending it again, never from here.
 */
export class TillHealthService {
  async overview(now: Date = new Date()): Promise<{ clients: TillHealthRow[] }> {
    const stuckBefore = new Date(now.getTime() - STUCK_MS);
    const since7 = new Date(now.getTime() - 7 * DAY);
    // A bill is stuck when it has waited too long, or is RUNNING with no sign of life.
    const stuckWhere = {
      OR: [
        { status: 'QUEUED', receivedAt: { lt: stuckBefore } },
        { status: 'RUNNING', OR: [{ heartbeatAt: { lt: stuckBefore } }, { heartbeatAt: null }] }
      ]
    };

    const [tills, counts, problems] = await Promise.all([
      prisma.storefrontConnection.groupBy({ by: ['clientId'], where: { ...POS_ONLY, status: 'ACTIVE' }, _count: { _all: true } }),
      prisma.$queryRaw<{ client_id: string; last_bill: Date | null; waiting: bigint; stuck: bigint; refused: bigint }[]>`
        SELECT client_id,
               MAX(received_at) FILTER (WHERE kind <> ${SKIP_KIND})                         AS last_bill,
               COUNT(*) FILTER (WHERE status IN ('QUEUED', 'RUNNING'))                     AS waiting,
               COUNT(*) FILTER (WHERE (status = 'QUEUED' AND received_at < ${stuckBefore})
                                   OR (status = 'RUNNING' AND (heartbeat_at IS NULL OR heartbeat_at < ${stuckBefore}))) AS stuck,
               COUNT(*) FILTER (WHERE status = 'REJECTED' AND settled_at >= ${since7})       AS refused
          FROM pos_inbound_events
         GROUP BY client_id
      `,
      prisma.posInboundEvent.findMany({
        where: { OR: [stuckWhere, { status: 'REJECTED', settledAt: { gte: since7 } }] },
        orderBy: { receivedAt: 'desc' },
        take: 300,
        select: { clientId: true, invoiceNo: true, kind: true, status: true, answer: true, detail: true, attempts: true, receivedAt: true }
      })
    ]);

    const tillsBy = new Map(tills.map(t => [t.clientId, t._count._all]));
    const countsBy = new Map(counts.map(c => [c.client_id, c]));
    const problemsBy = new Map<string, TillHealthProblem[]>();
    for (const { clientId, ...p } of problems) {
      const list = problemsBy.get(clientId) ?? [];
      if (list.length < 25) list.push(p);
      problemsBy.set(clientId, list);
    }

    // Every shop with a working till, plus any that still has bills on record after disconnecting.
    const ids = [...new Set([...tillsBy.keys(), ...countsBy.keys()])];
    const clients = ids.map((clientId): TillHealthRow => {
      const c = countsBy.get(clientId);
      const row = {
        clientId,
        tills: tillsBy.get(clientId) ?? 0,
        lastBillAt: c?.last_bill ?? null,
        waiting: Number(c?.waiting ?? 0),
        stuck: Number(c?.stuck ?? 0),
        refused7d: Number(c?.refused ?? 0),
        problems: problemsBy.get(clientId) ?? []
      };
      const state: TillHealthState = row.stuck > 0 ? 'STUCK'
        : row.refused7d > 0 ? 'CHECK'
        : row.lastBillAt === null ? 'NO_BILLS'
        : 'OK';
      return { ...row, state };
    });

    clients.sort((a, b) => RANK[a.state] - RANK[b.state]
      || (b.lastBillAt?.getTime() ?? 0) - (a.lastBillAt?.getTime() ?? 0));
    return { clients };
  }
}

export const tillHealthService = new TillHealthService();
