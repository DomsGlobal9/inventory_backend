/**
 * Try-On: everything this module needs to offer garment generation to a client.
 *
 * Three responsibilities, kept in three files rather than one, because they change for
 * different reasons and are read by different people:
 *
 *   gateway.service     talks to the platform gateway -- the outbound call and nothing else
 *   credential.service  which key we present for a client, and who may see it
 *   usage.service       what was used, and whether they are still within their allowance
 *
 * Importers take this folder, not the files inside it, so the split above can change without
 * every caller in the codebase changing with it.
 */
export { catalogTryOnService } from './gateway.service';
export { serviceCredentialService } from './credential.service';
export type { CredentialSummary } from './credential.service';
export { tryOnUsageService } from './usage.service';
export type { UsageSummary } from './usage.service';
