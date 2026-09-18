import { env } from '../config/env';
import { runDayBookTick } from '../services/whatsapp/service';
import { whatsappConfigured } from '../services/whatsapp/client';

/**
 * The nightly Day Book on WhatsApp, in-process like the snapshot scheduler.
 *
 * Every five minutes it asks which shops' chosen time (10:00 pm unless the owner changed it) has
 * passed today without their Day Book going; runDayBookTick claims each before sending, so this
 * firing twice, or on two servers, still sends one per night. Five minutes is how late a 10:00 pm
 * Day Book can be, and checking costs one small query when there is nothing to do.
 *
 * It sends real messages to real owners, and a development machine usually points at the
 * production database -- so outside production it stays off unless WHATSAPP_DAYBOOK_IN_DEV says
 * otherwise, whatever else is configured.
 */
export class WhatsAppDayBookScheduler {
  private static timer: NodeJS.Timeout | null = null;
  private static running = false;
  private static readonly CHECK_INTERVAL_MS = 5 * 60 * 1000;

  static start() {
    if (this.timer) return;
    if (env.NODE_ENV !== 'production' && !env.WHATSAPP_DAYBOOK_IN_DEV) {
      console.log('   WhatsApp Day Book job off (not production; set WHATSAPP_DAYBOOK_IN_DEV=true to run it here)');
      return;
    }
    if (!whatsappConfigured()) {
      console.log('   WhatsApp Day Book job off (WhatsApp service not configured)');
      return;
    }

    const tick = async () => {
      // A slow tick must not overlap the next one.
      if (this.running) return;
      this.running = true;
      try {
        const r = await runDayBookTick();
        if (r.sent || r.failed) console.log(`[whatsapp] Day Book: ${r.sent} handed to WhatsApp, ${r.failed} to retry`);
      } catch (err) {
        console.error('[whatsapp] Day Book tick failed:', (err as Error)?.message);
      } finally {
        this.running = false;
      }
    };
    this.timer = setInterval(tick, this.CHECK_INTERVAL_MS);
    this.timer.unref?.();
    void tick();
  }
}
