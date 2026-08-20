import { SalesOrderStatus } from '@prisma/client';

const transitions: Record<SalesOrderStatus, SalesOrderStatus[]> = {
  DRAFT: ['CONFIRMED', 'CANCELLED'],
  CONFIRMED: ['CANCELLED', 'PARTIALLY_DISPATCHED', 'DISPATCHED'],
  PARTIALLY_DISPATCHED: ['DISPATCHED', 'CANCELLED'],
  DISPATCHED: [],
  CANCELLED: [],
};

export const validateTransition = (current: SalesOrderStatus, target: SalesOrderStatus) => {
  const allowed = transitions[current];
  if (!allowed.includes(target)) {
    throw new Error(`Invalid state transition from ${current} to ${target}`);
  }
};
