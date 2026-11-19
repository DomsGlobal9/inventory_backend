/**
 * What is left of WhatsApp messaging in Inventory (19 Nov 2026): campaigns and birthday/anniversary wishes are a
 * service of ScaleEzy CRM. Inventory keeps a customer's yes to offers (and STOP), the reminder a week before
 * points lapse and the points message after a sale -- points are Inventory's -- sent slowly from the shop's own
 * number, and the product photos CRM chooses pictures from.
 */
export { recordOffersConsent, setOffersConsent, markManyAgreed, offersState, markStopped } from './consent';
export { runCampaignTick, dailyBudget, withinSendingHours } from './sender';
export { runDailyPrepare, prepareShopDay } from './auto';
export { sendAfterSaleNotice } from './notices';
export { checkAudience, whereFor, describeAudience, recentlyOffered } from './audience';
export { render, checkText } from './message';
export { purgeUnused as purgeUnusedCampaignMedia, prepareImage, productPhotosOf } from './media';
