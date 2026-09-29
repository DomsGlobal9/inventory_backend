import { RazorpayGateway } from './razorpay';
import { GatewayName, PaymentGateway } from './types';

export * from './types';
export { RazorpayGateway, RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET, razorpayMode, maskKeyId } from './razorpay';

/**
 * The gateway for a shop's own account. Adding Cashfree or PhonePe is a new file and a new case
 * here; nothing that takes money needs to know which one it is talking to.
 */
export function gatewayFor(
  gateway: GatewayName,
  keys: { keyId: string; keySecret: string; webhookSecret?: string }
): PaymentGateway {
  switch (gateway) {
    case 'RAZORPAY':
      return new RazorpayGateway(keys.keyId, keys.keySecret, keys.webhookSecret);
    default:
      throw new Error(`No payment gateway called ${String(gateway)}.`);
  }
}
