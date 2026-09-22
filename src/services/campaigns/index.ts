/**
 * WhatsApp campaigns and the automatic loyalty messages. Sent from the shop's own number, slowly,
 * only to customers who agreed -- see campaign.service.ts for the rules.
 */
export * as campaigns from './campaign.service';
export { recordOffersConsent, setOffersConsent, markManyAgreed, offersState, markStopped } from './consent';
export { runCampaignTick, dailyBudget, withinSendingHours } from './sender';
export { runDailyPrepare, prepareShopDay } from './auto';
export { sendAfterSaleNotice } from './notices';
export { checkAudience, whereFor, describeAudience } from './audience';
export { render, checkText } from './message';
