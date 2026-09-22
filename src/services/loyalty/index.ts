/**
 * Loyalty points. The counter sale and returns call settleSale / settleReturn inside their own
 * transactions; everything else is the shop's screens and the daily job.
 */
export {
  getSettings, saveSettings, post, forCounter, checkSale, settleSale, settleReturn, previewReturn, customerPoints, adjust,
  lapseQuietPoints, giveBirthdayPoints, afterSaleText, lapseDate, DEFAULT_BIRTHDAY_TEXT, DEFAULT_ANNIVERSARY_TEXT
} from './loyalty.service';
export type { LoyaltySettingsView, Actor, SaleCheck } from './loyalty.service';
export * from './rules';
