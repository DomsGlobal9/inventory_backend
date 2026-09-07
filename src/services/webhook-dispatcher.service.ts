import { prisma } from '../lib/prisma';
import axios from 'axios';

export class WebhookDispatcherService {
  /**
   * Processes pending events from the outbox and attempts to send them to the Storefront webhook.
   */
  static async dispatchPendingEvents() {
    try {
      // Get batch of pending event ids
      const candidates = await prisma.inventoryEvent.findMany({
        where: { status: 'PENDING' },
        take: 50,
        orderBy: { createdAt: 'asc' },
        select: { id: true }
      });

      if (candidates.length === 0) return;
      const candidateIds = candidates.map(c => c.id);

      // Atomically claim this batch (PENDING -> PROCESSING) before doing any network
      // I/O. If this service is ever scaled horizontally, each row's WHERE status =
      // 'PENDING' guard means only one instance's updateMany can win the transition
      // per row, so two instances can never both deliver the same event.
      await prisma.inventoryEvent.updateMany({
        where: { id: { in: candidateIds }, status: 'PENDING' },
        data: { status: 'PROCESSING' }
      });

      const pendingEvents = await prisma.inventoryEvent.findMany({
        where: { id: { in: candidateIds }, status: 'PROCESSING' },
        include: {
          variant: { select: { id: true, barcode: true } },
          location: { select: { id: true, code: true, name: true } }
        }
      });

      if (pendingEvents.length === 0) return;

      // A localhost default is right for dev and wrong in production, where it means
      // posting inventory events to a machine that isn't there, forever, every 30s.
      // Unset means "no storefront configured" -- stay idle instead of inventing a target.
      const STOREFRONT_WEBHOOK_URL = process.env.STOREFRONT_WEBHOOK_URL
        || (process.env.NODE_ENV === 'production' ? null : 'http://localhost:4000/api/v1/internal-webhooks/inventory-updated');
      if (!STOREFRONT_WEBHOOK_URL) {
        console.warn('WebhookDispatcher: STOREFRONT_WEBHOOK_URL not set — no storefront to notify, skipping this batch.');
        return;
      }
      // No hardcoded fallback — an unset key means we cannot sign outbound webhooks
      // truthfully, so we skip dispatching rather than send a signature anyone
      // could forge by reading this file.
      const EVENT_SIGNATURE = process.env.INTERNAL_SERVICE_KEY;
      if (!EVENT_SIGNATURE) {
        console.warn('WebhookDispatcher: INTERNAL_SERVICE_KEY not configured — skipping this batch, events remain claimed as PROCESSING and will need a manual reset or an env fix + restart.');
        return;
      }

      for (const event of pendingEvents) {
        try {
          const payload = {
            eventId: event.id,
            eventType: event.eventType,
            occurredAt: event.createdAt,
            variant: event.variant,
            location: event.location,
            stock: {
              previousQuantity: event.previousQuantity,
              quantity: event.quantity,
              available: event.available
            }
          };

          // Send to Storefront
          await axios.post(STOREFRONT_WEBHOOK_URL, payload, {
            headers: {
              'x-inventory-event-signature': EVENT_SIGNATURE,
              'Content-Type': 'application/json'
            },
            timeout: 5000
          });

          // Mark as processed
          await prisma.inventoryEvent.update({
            where: { id: event.id },
            data: {
              status: 'PROCESSED',
              processedAt: new Date()
            }
          });
        } catch (err: any) {
          console.error(`Failed to dispatch event ${event.id}:`, err.message);
          // Release the claim so the next poll retries it. If THIS write fails the event is
          // stranded in PROCESSING -- the poll only picks up PENDING, so it is never retried
          // and never delivered, and the storefront's stock quietly drifts from ours. That is
          // worth a line in the log rather than an empty catch: it cannot be recovered here,
          // but it must not be invisible.
          await prisma.inventoryEvent.update({
            where: { id: event.id },
            data: { status: 'PENDING' }
          }).catch((releaseErr: any) => {
            console.error(
              `[WebhookDispatcher] Event ${event.id} is stuck in PROCESSING: the claim could ` +
              `not be released, so it will not be retried. Reset it to PENDING to redeliver.`,
              releaseErr?.message || releaseErr
            );
          });
        }
      }
    } catch (err) {
      console.error('Error in WebhookDispatcher:', err);
    }
  }

  /**
   * Starts the polling mechanism. Should be called when the server starts.
   */
  static startPolling(intervalMs = 30000) {
    console.log(`Starting WebhookDispatcher polling every ${intervalMs}ms`);
    setInterval(() => {
      this.dispatchPendingEvents().catch(console.error);
    }, intervalMs);
  }
}
