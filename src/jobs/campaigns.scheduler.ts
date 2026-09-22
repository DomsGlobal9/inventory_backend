import { env } from '../config/env';
import { whatsappConfigured } from '../services/whatsapp/client';
import { runCampaignTick, runDailyPrepare } from '../services/campaigns';

/**
 * Campaigns and the automatic loyalty messages, in-process like the Day Book scheduler.
 *
 * Every two minutes: hand the next few campaign messages to WhatsApp (sender.ts decides how few).
 * Every ten: prepare any shop's day that is due -- lapsing quiet points, birthday gifts, and the
 * birthday, anniversary and points-lapsing messages. Both claim their work first, so two servers
 * running this do each thing once.
 *
 * These message real customers, and a development machine usually points at the production
 * database -- so outside production it stays off unless WHATSAPP_CAMPAIGNS_IN_DEV says otherwise.
 */
export class CampaignsScheduler {
  private static timers: NodeJS.Timeout[] = [];
  private static sending = false;
  private static preparing = false;

  static start() {
    if (this.timers.length) return;
    if (env.NODE_ENV !== 'production' && !env.WHATSAPP_CAMPAIGNS_IN_DEV) {
      console.log('   Campaigns job off (not production; set WHATSAPP_CAMPAIGNS_IN_DEV=true to run it here)');
      return;
    }
    if (!whatsappConfigured()) {
      console.log('   Campaigns job off (WhatsApp service not configured)');
      return;
    }

    const send = async () => {
      if (this.sending) return;
      this.sending = true;
      try {
        const r = await runCampaignTick();
        const handed = r.reduce((a, s) => a + s.handed, 0);
        if (handed) console.log(`[campaigns] ${handed} message(s) handed to WhatsApp`);
      } catch (err) {
        console.error('[campaigns] tick failed:', (err as Error)?.message);
      } finally {
        this.sending = false;
      }
    };
    const prepare = async () => {
      if (this.preparing) return;
      this.preparing = true;
      try {
        const r = await runDailyPrepare();
        if (r.length) console.log(`[campaigns] prepared the day for ${r.length} shop(s)`);
      } catch (err) {
        console.error('[campaigns] daily prepare failed:', (err as Error)?.message);
      } finally {
        this.preparing = false;
      }
    };
    this.timers.push(setInterval(send, 2 * 60 * 1000), setInterval(prepare, 10 * 60 * 1000));
    this.timers.forEach(t => t.unref?.());
    void prepare().then(send);
  }
}
