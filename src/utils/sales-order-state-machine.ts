import { SalesOrderStatus } from '@prisma/client';
import { conflict } from './httpError';

const transitions: Record<SalesOrderStatus, SalesOrderStatus[]> = {
  DRAFT: ['CONFIRMED', 'CANCELLED'],
  CONFIRMED: ['CANCELLED', 'PARTIALLY_DISPATCHED', 'DISPATCHED'],
  PARTIALLY_DISPATCHED: ['DISPATCHED', 'CANCELLED'],
  DISPATCHED: [],
  CANCELLED: [],
};

/** What each state is called out loud. "PARTIALLY_DISPATCHED" is not a word anybody says. */
const label: Record<SalesOrderStatus, string> = {
  DRAFT: 'still a draft',
  CONFIRMED: 'confirmed',
  PARTIALLY_DISPATCHED: 'partly sent out',
  DISPATCHED: 'already sent out',
  CANCELLED: 'cancelled',
};

/**
 * Refuse a step this order has already taken, or can no longer take.
 *
 * Two things were wrong with how this reported itself, and both were measured rather than
 * guessed.
 *
 * It threw a bare Error. A bare Error carries no status, so what the caller saw depended
 * entirely on which controller happened to catch it -- 400 here because sales-order.controller
 * flattens everything to 400, and 500 in the parts of the app that hand the error to the
 * middleware. Neither is a decision anybody made. 409 is the honest answer: the request was
 * perfectly well formed, and the thing it refers to has moved on since the screen was drawn.
 * A 5xx would also have been written to the Platform Console's Errors page, where a real
 * crash then has to be picked out from among routine double-clicks.
 *
 * And the message was written for whoever wrote the code. Confirming an order twice -- a
 * double-click, or two people at two tills -- answered "Invalid state transition from
 * CONFIRMED to CONFIRMED", which tells a shopkeeper nothing about what to do next.
 */
export const validateTransition = (current: SalesOrderStatus, target: SalesOrderStatus) => {
  const allowed = transitions[current];
  if (allowed.includes(target)) return;

  if (current === target) {
    throw conflict(`This order is already ${label[current]}. Refresh to see where it got to.`);
  }
  throw conflict(
    `This order is ${label[current]}, so it cannot be ${label[target]} now. Refresh to see where it got to.`
  );
};
