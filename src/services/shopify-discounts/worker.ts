import { adminApiFor } from '../shopify-mapping';
import { offerMirrorService } from './mirror.service';

/**
 * Doing the queued Shopify discount work, in-process, like the storefront dispatcher.
 *
 * Every 30 seconds: pushes and removals that are due, then copies due to be read back. Each row is
 * leased while it is worked, so a second instance pointed at the same database -- or this one
 * restarting mid-push -- costs a retry, never a duplicate.
 */
export class OfferMirrorWorker {
  private static timer: NodeJS.Timeout | null = null;
  private static running = false;

  static start(intervalMs = 30_000) {
    if (this.timer) return;
    const tick = async () => {
      if (this.running) return;
      this.running = true;
      try {
        const { pushed, checked } = await offerMirrorService.runOnce(
          installation => adminApiFor(installation.id, installation.shopDomain)
        );
        const noteworthy = [...pushed, ...checked].filter(r => !['SYNCED', 'SKIPPED', 'BUSY'].includes(r));
        if (noteworthy.length) console.log(`[offer mirror] ${noteworthy.join(', ')}`);
      } catch (error) {
        console.error('[offer mirror] pass failed; will retry', error);
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
