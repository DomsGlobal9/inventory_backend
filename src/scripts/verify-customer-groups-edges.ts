/**
 * Customer groups, the edge cases: through the real API (sign-ins, permissions, another shop, URL
 * encoding, races, limits) and against the service for spending rules and campaigns.
 *
 *   A  names: spaces, too long, another script, slashes and %, same name in other capitals
 *   B  races: two people make one group, three add one customer at the same moment
 *   C  members: deleted customer, another shop's customer, a customer already in 20 groups, bad lists
 *   D  another shop sees and changes nothing; a role without customer access is refused
 *   E  rename / merge / delete: offers in every state, spelling-only rename keeps offers, merge rules
 *   F  rules: refused in words, off again, on a group that does not exist
 *   G  join by spending: cancelled, deleted, old and shared walk-in sales do not count; the exact amount does
 *   H  WhatsApp: a quiet group wins over another group; wishes vs offers; the points reminder; Start says why
 *
 * Needs the local backend on 4006. Shops: two demo help-shops (test data) and throwaway ids for G/H,
 * which have no WhatsApp number, so nothing prepared can ever be sent. Everything made is deleted.
 *
 *   npx tsx src/scripts/verify-customer-groups-edges.ts
 */
// RETIRED 18 Nov 2026: customer groups are made and changed only in ScaleEzy CRM; Inventory keeps a read-only
// copy. What this suite tested (Inventory's own group editing) no longer exists. The new rules are proved by
// verify-customer-groups.ts and verify-crm-groups-and-reads.ts.
console.log('verify-customer-groups-edges is retired: groups are made in ScaleEzy CRM (see verify-customer-groups, verify-crm-groups-and-reads).');
process.exit(0);

export {};
