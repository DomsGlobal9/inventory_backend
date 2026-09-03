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

      const STOREFRONT_WEBHOOK_URL = process.env.STOREFRONT_WEBHOOK_URL || 'http://localhost:4000/api/v1/internal-webhooks/inventory-updated';
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
          // Release the claim so the next poll retries it
          await prisma.inventoryEvent.update({
            where: { id: event.id },
            data: { status: 'PENDING' }
          }).catch(() => {});
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
