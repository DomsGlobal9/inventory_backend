/**
 * Short links at go.scaleezy.com: make them, open them, count them, switch them off. Everything
 * else in the backend goes through here; nothing else reads or writes the short_links tables.
 */
export * as links from './link.service';
export { LinkRuleError, newRecipientRef } from './rules';
export type { TargetType } from './rules';
