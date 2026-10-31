import { adminApiFor } from '../shopify-mapping';
import { shopifyProductPushService } from './push.service';
import { shopifyInstallationService } from '../shopify-installation.service';

/**
 * Doing the queued Shopify product work, in-process, like the discount mirror's worker.
 *
 * Every 20 seconds: products and stock that are due. Every 10 minutes: a sweep that re-renders each
 * synced product and queues any that no longer match -- the net under every edit path that forgot
 * to say it changed something (photo jobs, imports, a direct fix in the database). Every 6 hours:
 * every store's connection is kept alive (shopifyInstallationService.keepAlive).
 */
const SWEEP_EVERY_MS = 10 * 60 * 1000;
const KEEP_ALIVE_EVERY_MS = 6 * 60 * 60 * 1000;

export class ShopifyProductWorker {
  private static timer: NodeJS.Timeout | null = null;
  private static running = false;
  private static lastSweep = 0;
  private static lastKeepAlive = 0;

  static start(intervalMs = 20_000) {
    if (this.timer) return;
    const tick = async () => {
      if (this.running) return;
      this.running = true;
      try {
        if (Date.now() - this.lastSweep > SWEEP_EVERY_MS) {
          this.lastSweep = Date.now();
          const queued = await shopifyProductPushService.sweep();
          if (queued) console.log(`[shopify products] sweep queued ${queued} product(s) that had changed`);
        }
        if (Date.now() - this.lastKeepAlive > KEEP_ALIVE_EVERY_MS) {
          this.lastKeepAlive = Date.now();
          const kept = await shopifyInstallationService.keepAlive();
          if (kept.renewed.length || kept.failed.length) {
            console.log(`[shopify] keep-alive: renewed ${kept.renewed.length}, failed ${kept.failed.length}${kept.failed.length ? ` (${kept.failed.join(', ')})` : ''}`);
          }
        }
        const results = await shopifyProductPushService.runOnce(
          installation => adminApiFor(installation.id, installation.shopDomain)
        );
        const noteworthy = results.filter(r => !['SYNCED', 'STOCK', 'BUSY'].includes(r));
        if (noteworthy.length) console.log(`[shopify products] ${noteworthy.join(', ')}`);
      } catch (error) {
        console.error('[shopify products] pass failed; will retry', error);
      } finally {
        this.running = false;
      }
    };
    this.timer = setInterval(tick, intervalMs);
    this.timer.unref?.();
  }

  static stop() {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }
}
