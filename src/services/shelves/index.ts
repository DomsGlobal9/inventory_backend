/**
 * Racks and shelves: where inside a location the pieces are.
 *
 *   addresses.ts          codes, addresses, label codes, walking order
 *   plan.ts               which shelves a movement touches (pure; the rule)
 *   legs.ts               writing those legs inside applyMovement's transaction
 *   spot.service.ts       the rack tree: set up, change, remove, labels
 *   shelf-stock.service   where is it, what is on a shelf, put away, move
 *   issue.service.ts      what the rule could not do cleanly, shown to the shop
 *
 * Plan: PLAN-shelves.md at the inventory root (local).
 */
export { spotService } from './spot.service';
export { shelfStockService } from './shelf-stock.service';
export { shelfIssueService } from './issue.service';
export { planShelfLegs } from './plan';
export { applyShelfLegs } from './legs';
export * from './addresses';
