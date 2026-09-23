import { prisma } from '../lib/prisma';
import { shopifyInstallationService } from '../services/shopify-installation.service';
import { shopifyPrivacyService } from '../services/shopify-privacy';
import { fillService } from '../services/shelves/fill.service';
import { links } from '../services/links';
import { purgeUnusedCampaignMedia } from '../services/campaigns';
import { shopCheckout, shopOtp } from '../services/online-shop';

/**
 * Throwing away what has stopped meaning anything.
 *
 * Two tables grow without bound and nothing ever trimmed them:
 *
 *   pricing_quotes        a row every time a till or a website prices a basket. A storefront
 *                         re-pricing as a shopper changes quantities writes several a minute,
 *                         and most are never bought.
 *   shopify_oauth_states  a row every time somebody starts connecting Shopify. The service had a
 *                         prune method; nothing called it.
 *   whatsapp_events_seen  one id per event from the WhatsApp Service, kept only to recognise a
 *                         repeat. The service gives up retrying an event within about a minute,
 *                         so a week is far more than enough.
 *
 * What is NOT deleted matters more than what is:
 *
 *   - A quote that became an order is kept for ever. It is the record of the price a customer was
 *     shown, and "why was I charged this?" can arrive a year later.
 *   - An unused quote is kept for a week after it expired, not a minute. A shopper who says "the
 *     site told me 9,600 on Tuesday" deserves an answer, and a week covers that conversation.
 *
 * Same shape as SnapshotScheduler: in-process, catches up on boot, and harmless to run twice.
 */
export class HousekeepingScheduler {
  private static timer: NodeJS.Timeout | null = null;

  private static readonly INTERVAL_MS = 6 * 60 * 60 * 1000;

  /** How long an unbought quote is kept after it stopped being valid. */
  static readonly UNUSED_QUOTE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

  /** How long a handled WhatsApp event's id is remembered. */
  static readonly WHATSAPP_EVENT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

  /** How long a spent or expired checkout code is kept. A day is far more than anybody needs. */
  static readonly PHONE_CODE_RETENTION_MS = 24 * 60 * 60 * 1000;

  /**
   * How long a shelf's "this save already happened" key is kept. It exists so a phone that lost the
   * network can retry; a month later nobody is retrying, and the rows would grow for ever.
   */
  static readonly SHELF_FILL_SAVE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

  /** Exposed so it can be run, and verified, without waiting for the clock. */
  static async runOnce(now = new Date()) {
    const cutoff = new Date(now.getTime() - this.UNUSED_QUOTE_RETENTION_MS);

    const quotes = await prisma.pricingQuote.deleteMany({
      where: { consumedAt: null, expiresAt: { lt: cutoff } }
    });
    const oauthStates = await shopifyInstallationService.pruneExpiredStates();
    const whatsappEvents = await prisma.whatsAppEventSeen.deleteMany({
      where: { receivedAt: { lt: new Date(now.getTime() - this.WHATSAPP_EVENT_RETENTION_MS) } }
    });

    // Not throwing away, but the same "nobody else will ever come back for this" chore: a Shopify
    // privacy request that failed after its webhook was acknowledged. Shopify will not resend it.
    const privacyRequestsRetried = await shopifyPrivacyService.retryUnfinished();
    const shelfSaveKeys = await prisma.shelfFillSave.deleteMany({
      where: { createdAt: { lt: new Date(now.getTime() - this.SHELF_FILL_SAVE_RETENTION_MS) } }
    });

    // A shop that started putting its stock onto shelves and never finished. It changes how the till
    // picks shelves, so after a week they are reminded once.
    const shelfFills = await fillService.remindForgotten(now)
      .catch(error => { console.error('[Housekeeping] shelf reminder failed:', (error as Error)?.message); return { reminded: 0, emails: 0 }; });

    // Short links: each open's row after 180 days (the counts on the link stay), and test sends' links.
    const shortLinks = await links.purge(now)
      .catch(error => { console.error('[Housekeeping] short-link clean-up failed:', (error as Error)?.message); return { taps: 0, testLinks: 0 }; });

    // Campaign pictures nothing uses any more (a draft that changed its picture, a deleted draft).
    const campaignPictures = await purgeUnusedCampaignMedia(now)
      .catch(error => { console.error('[Housekeeping] campaign picture clean-up failed:', (error as Error)?.message); return 0; });

    /*
     * Online orders whose number was never proved, still holding the shop's stock a day later.
     *
     * This is the one chore here that gives something BACK rather than throwing something away. A
     * shop open to the internet can otherwise be emptied by somebody typing a made-up number into
     * a checkout twenty times: every order holds real stock, and until this, nothing returned it.
     * An order whose number was proved has no expiry and is never touched.
     */
    const staleHolds = await shopCheckout.releaseExpiredHolds(now)
      .catch(error => { console.error('[Housekeeping] stale online holds not released:', (error as Error)?.message); return 0; });

    // Codes nobody will ever type again. They are hashed, but a row per checkout still grows.
    const phoneCodes = await shopOtp.forgetOldCodes(new Date(now.getTime() - this.PHONE_CODE_RETENTION_MS))
      .catch(error => { console.error('[Housekeeping] phone code clean-up failed:', (error as Error)?.message); return 0; });

    return {
      unusedCampaignPictures: campaignPictures,
      unusedQuotes: quotes.count, oauthStates, privacyRequestsRetried,
      whatsappEvents: whatsappEvents.count, firstFillsReminded: shelfFills.reminded,
      shelfSaveKeys: shelfSaveKeys.count, shortLinkTaps: shortLinks.taps, testShortLinks: shortLinks.testLinks,
      staleHolds, phoneCodes
    };
  }

  static start() {
    if (this.timer) return;

    const tick = async () => {
      try {
        const removed = await this.runOnce();
        if (removed.privacyRequestsRetried) {
          console.log(`[Housekeeping] finished ${removed.privacyRequestsRetried} Shopify privacy request(s) that had failed`);
        }
        if (removed.staleHolds) {
          console.log(`[Housekeeping] let go of ${removed.staleHolds} online order(s) whose number was never proved`);
        }
        if (removed.unusedQuotes || removed.oauthStates) {
          console.log(
            `[Housekeeping] removed ${removed.unusedQuotes} unbought quote(s) and ` +
            `${removed.oauthStates} abandoned Shopify connection attempt(s)`
          );
        }
      } catch (error) {
        console.error('[Housekeeping] failed; will retry later.', error);
      }
    };

    void tick();
    this.timer = setInterval(tick, this.INTERVAL_MS);
    this.timer.unref?.();
  }

  static stop() {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }
}
