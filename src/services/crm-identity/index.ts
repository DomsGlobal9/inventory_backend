/**
 * ScaleEzy CRM owns who a customer is, for a shop with CRM on (19 Nov 2026). Inventory's side, APIs only:
 *   - client.ts   Inventory calling CRM's service API with its own key
 *   - links.ts    the link job: every customer gets CRM's id (find-or-add), saved off the customer row
 *   - events.ts   CRM's signed events: changes, removals, joins and their undo
 *   - merges.ts   joining two copies money-safely, and the undo
 * Plan: PLAN-crm-customers.md at the inventory root.
 */
export { crm, crmConfigured, CrmRefused, CrmUnavailable, type CrmCustomer } from './client';
export { runLinkPass, linkOne, crmIdOf, crmShops, CrmLinkWorker } from './links';
export { receive as receiveCrmEvent, verifySignature } from './events';
export { applyMerged, applyUnmerged, MOVED_COLUMNS, NOT_MOVED } from './merges';
