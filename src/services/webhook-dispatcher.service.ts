import { prisma } from '../lib/prisma';
import axios from 'axios';

export class WebhookDispatcherService {
  /**
   * Processes pending events from the outbox and attempts to send them to the Storefront webhook.
   */
  static async dispatchPendingEvents() {
    try {
      // Get batch of pending events
      const pendingEvents = await prisma.inventoryEvent.findMany({
        where: { status: 'PENDING' },
        take: 50,
        orderBy: { createdAt: 'asc' },
        include: {
          variant: { select: { id: true, barcode: true } },
          location: { select: { id: true, code: true, name: true } }
        }
      });

      if (pendingEvents.length === 0) return;

      const STOREFRONT_WEBHOOK_URL = process.env.STOREFRONT_WEBHOOK_URL || 'http://localhost:4000/api/v1/internal-webhooks/inventory-updated';
      const EVENT_SIGNATURE = process.env.INTERNAL_SERVICE_KEY || 'development_secret_key_123';

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
          // Leave it as PENDING to retry next time
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
