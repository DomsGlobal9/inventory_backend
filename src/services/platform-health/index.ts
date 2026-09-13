/**
 * Platform health: what the people looking after every shop need to see across all of them.
 *
 * Its own module, like mail and offers, so a console screen reads through one door rather than
 * reaching into each feature's tables from the platform-admin service.
 */
export { offersHealthService } from './offers-health.service';
export type { OffersHealthRow } from './offers-health.service';
