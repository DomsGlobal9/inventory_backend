import type { AccountStatus, MessageStatus } from '@prisma/client';

// Message statuses only move forward. Engine events can arrive twice or out of order
// ("delivered" before "sent"); a late or repeated event must never move a message back.

const RANK: Record<MessageStatus, number> = {
  QUEUED: 0,
  SENDING: 1,
  SENT: 2,
  DELIVERED: 3,
  READ: 4,
  FAILED: -1,
  EXPIRED: -1,
};

/** Engine (Baileys) ack names to our statuses. PENDING = left the device; SERVER_ACK = WhatsApp has it. */
export function mapEngineMessageStatus(engineStatus: unknown): MessageStatus | null {
  if (typeof engineStatus === 'number') {
    return mapEngineMessageStatus(['ERROR', 'PENDING', 'SERVER_ACK', 'DELIVERY_ACK', 'READ', 'PLAYED'][engineStatus]);
  }
  switch (String(engineStatus ?? '').toUpperCase()) {
    case 'PENDING':
    case 'SERVER_ACK':
      return 'SENT';
    case 'DELIVERY_ACK':
      return 'DELIVERED';
    case 'READ':
    case 'PLAYED':
      return 'READ';
    case 'ERROR':
      return 'FAILED';
    default:
      return null;
  }
}

/**
 * The status after applying `incoming` to `current`, or null when nothing should change.
 * - forward moves only (SENT -> DELIVERED -> READ);
 * - an engine error fails a message only if it had not been delivered;
 * - a delivered/read tick lifts a FAILED message: the tick is proof it arrived;
 * - EXPIRED is final (it was never sent).
 */
export function advanceStatus(current: MessageStatus, incoming: MessageStatus): MessageStatus | null {
  if (current === incoming) return null;
  if (current === 'EXPIRED') return null;
  if (incoming === 'FAILED') return RANK[current] >= 0 && RANK[current] <= RANK.SENT ? 'FAILED' : null;
  if (incoming === 'EXPIRED') return current === 'QUEUED' ? 'EXPIRED' : null;
  if (current === 'FAILED') return incoming === 'DELIVERED' || incoming === 'READ' ? incoming : null;
  return RANK[incoming] > RANK[current] ? incoming : null;
}

export interface EngineConnection {
  state: string | null | undefined;
  statusReason?: number | null;
}

/**
 * Engine connection state to our account status. `wasLinked` distinguishes a number that is
 * reconnecting (DISCONNECTED) from one that was never linked (LINKING while a QR is up).
 */
export function mapConnectionState(conn: EngineConnection, wasLinked: boolean): AccountStatus {
  const state = String(conn.state ?? '').toLowerCase();
  if (state === 'open') return 'CONNECTED';
  if (state === 'connecting') return wasLinked ? 'DISCONNECTED' : 'LINKING';
  if (state === 'close' || state === 'refused') {
    // 401 = logged out from the phone, 403 = banned/forbidden: the link is gone.
    if (conn.statusReason === 401 || conn.statusReason === 403) return 'LOGGED_OUT';
    return wasLinked ? 'DISCONNECTED' : 'NOT_LINKED';
  }
  return wasLinked ? 'DISCONNECTED' : 'NOT_LINKED';
}

/** A drop the owner must hear about. */
export function isDrop(from: AccountStatus, to: AccountStatus): boolean {
  return from === 'CONNECTED' && (to === 'DISCONNECTED' || to === 'LOGGED_OUT');
}
