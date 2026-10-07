import crypto from 'crypto';
import { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { encryptCredential, decryptCredential } from '../../lib/credentialEncryption';
import { OnlineShopRuleError } from '../online-shop/rules';
import {
  gatewayFor, PaymentGateway, GatewayMode, RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET, razorpayMode, maskKeyId
} from './gateway';

/**
 * Settings -> Online shop -> Payments: the shop connects its own Razorpay account.
 *
 * "The keys screen is the product" (PLAN-online-shop-payments.md): a shopkeeper finding API keys in
 * a dashboard and pasting them in is where onboarding dies, so every answer here is a sentence the
 * owner can act on, and nothing is ever half-saved.
 *
 * What never leaves this file: the key secret and the webhook secret. describe() is the only shape a
 * browser sees, and it carries the key id masked, the mode and the last check -- nothing else. The
 * webhook secret is shown ONCE, in the answer to the save that created it (or to "make a new one"),
 * because the owner has to paste it into Razorpay and there is no other way to hand it over.
 */

export const RAZORPAY_PRICING_URL = 'https://razorpay.com/pricing/';
export const RAZORPAY_KEYS_HELP_URL = 'https://razorpay.com/docs/payments/dashboard/account-settings/api-keys/';
export const RAZORPAY_WEBHOOKS_HELP_URL = 'https://razorpay.com/docs/webhooks/';

/** The events the webhook in Razorpay's dashboard must be ticked for. */
export const WEBHOOK_EVENTS = ['payment.captured', 'payment.failed', 'order.paid', 'refund.processed', 'refund.failed', 'qr_code.credited'];

/** Where Razorpay sends webhooks for one shop. The token finds the shop before the signature is checked. */
export const webhookPath = (token: string) => `/api/v1/payments/webhooks/razorpay/${token}`;

const newSecret = (bytes: number) => crypto.randomBytes(bytes).toString('base64url');

/**
 * Whether TEST keys may take (pretend) money on this deployment.
 *
 * Off unless whoever runs the server sets PAYMENTS_ALLOW_TEST_KEYS=true, because a Razorpay test
 * payment is a real CAPTURED payment as far as the API is concerned -- it just involves no money.
 * A shop left on test keys in front of real customers would ship real sarees against pretend
 * payments, marked paid, and the Day Book would count money that never arrived.
 *
 * It used to refuse in production whatever the flag said, which also left a shop with no way to
 * try the checkout before its Live keys arrive. The decision now belongs to the operator, who is
 * the only one who can weigh it: one switch, off by default, for the whole deployment.
 */
export const testKeysAllowed = () => process.env.PAYMENTS_ALLOW_TEST_KEYS === 'true';

/**
 * A shop whose account could be in the middle of moving money: a customer paying right now, or a
 * refund that has not finished. The account must not be pulled out from under either -- with no
 * keys, a payment in flight can neither be confirmed nor returned, and the customer's money sits
 * in the shop's Razorpay account with no order and nobody told.
 *
 * Read here directly rather than from online-payment.service, which imports this file.
 */
async function moneyInFlight(clientId: string): Promise<{ paying: number; refunding: number }> {
  const [paying, refunding] = await Promise.all([
    prisma.onlinePayment.count({ where: { clientId, status: { in: ['STARTING', 'WAITING'] } } }),
    prisma.onlineRefund.count({ where: { clientId, status: { in: ['REQUESTING', 'PENDING'] } } })
  ]);
  return { paying, refunding };
}

function refuseWhileMoneyMoves(f: { paying: number; refunding: number }, doing: string) {
  if (f.paying > 0) {
    throw new OnlineShopRuleError(
      `A customer is paying right now, so the account cannot be ${doing} yet. Try again in 20 minutes -- ` +
      'every payment in progress finishes or lapses by then.'
    );
  }
  if (f.refunding > 0) {
    throw new OnlineShopRuleError(
      `${f.refunding === 1 ? 'A refund is' : `${f.refunding} refunds are`} still going through Razorpay, so the ` +
      `account cannot be ${doing} yet. Try again once ${f.refunding === 1 ? 'it has' : 'they have'} finished.`
    );
  }
}

export interface PaymentAccountView {
  connected: boolean;
  gateway: 'RAZORPAY' | null;
  keyIdMasked: string | null;
  mode: GatewayMode | null;
  status: 'UNCHECKED' | 'CONNECTED' | 'FAILED' | null;
  checkedAt: Date | null;
  checkMessage: string | null;
  webhookUrl: string | null;
  webhookEvents: string[];
  /** True only when the keys work AND they are live keys: the one state customers could pay in. */
  readyForCustomers: boolean;
  /** UPI QR at the POS till: the owner's opt-in (Razorpay charges per payment). */
  upiQrEnabled: boolean;
  help: { pricing: string; apiKeys: string; webhooks: string };
}

type Row = Prisma.ShopPaymentAccountGetPayload<{}>;

function view(row: Row | null, apiBase: string): PaymentAccountView {
  const help = { pricing: RAZORPAY_PRICING_URL, apiKeys: RAZORPAY_KEYS_HELP_URL, webhooks: RAZORPAY_WEBHOOKS_HELP_URL };
  if (!row) {
    return {
      connected: false, gateway: null, keyIdMasked: null, mode: null, status: null, checkedAt: null,
      checkMessage: null, webhookUrl: null, webhookEvents: WEBHOOK_EVENTS, readyForCustomers: false, upiQrEnabled: false, help
    };
  }
  return {
    connected: true,
    gateway: row.gateway as 'RAZORPAY',
    keyIdMasked: maskKeyId(row.keyId),
    mode: row.mode as GatewayMode,
    status: row.status as PaymentAccountView['status'],
    checkedAt: row.checkedAt,
    checkMessage: row.checkMessage,
    webhookUrl: `${apiBase}${webhookPath(row.webhookToken)}`,
    webhookEvents: WEBHOOK_EVENTS,
    readyForCustomers: isReady(row),
    upiQrEnabled: row.upiQrEnabled,
    help
  };
}

/** The one rule for "customers may pay this shop online", used by every gate that asks. */
function isReady(row: { status: string; mode: string } | null): boolean {
  if (!row || row.status !== 'CONNECTED') return false;
  return row.mode === 'LIVE' || testKeysAllowed();
}

export class PaymentAccountService {
  async describe(clientId: string, apiBase: string): Promise<PaymentAccountView> {
    const row = await prisma.shopPaymentAccount.findUnique({ where: { clientId } });
    return view(row, apiBase);
  }

  /**
   * Save the shop's keys, then check them at once.
   *
   * A new account gets a webhook secret and address; the answer carries the secret this one time.
   * Replacing the keys of an existing account keeps its webhook address and secret -- the owner has
   * already pasted those into Razorpay, and making them do it again for a key change is a support
   * call waiting to happen.
   */
  async save(
    clientId: string,
    userId: string | null,
    input: { keyId?: unknown; keySecret?: unknown },
    apiBase: string
  ): Promise<{ account: PaymentAccountView; webhookSecret: string | null }> {
    const keyId = typeof input.keyId === 'string' ? input.keyId.trim() : '';
    const keySecret = typeof input.keySecret === 'string' ? input.keySecret.trim() : '';

    if (!RAZORPAY_KEY_ID.test(keyId)) {
      throw new OnlineShopRuleError('That does not look like a Razorpay Key ID. It starts with rzp_live_ (or rzp_test_) and is on the API Keys page in your Razorpay dashboard.');
    }
    if (!RAZORPAY_KEY_SECRET.test(keySecret)) {
      throw new OnlineShopRuleError('That does not look like a Razorpay Key Secret. It is shown once, when the key is generated -- if you no longer have it, generate a new key in Razorpay and paste both again.');
    }

    // Two shops, one account: the money of one would land in the other's bank.
    const elsewhere = await prisma.shopPaymentAccount.findFirst({
      where: { gateway: 'RAZORPAY', keyId, NOT: { clientId } },
      select: { id: true }
    });
    if (elsewhere) {
      throw new OnlineShopRuleError('This Razorpay account is already connected to another shop on ScaleEzy. Each shop connects its own account.');
    }

    const existing = await prisma.shopPaymentAccount.findUnique({ where: { clientId } });
    // Moving to a DIFFERENT Razorpay account while a customer is paying into the old one would leave
    // that payment with no keys that can see it. New keys for the SAME account are fine -- the
    // account's payments stay visible to them -- but from here the two cannot be told apart.
    if (existing && existing.keyId !== keyId) {
      refuseWhileMoneyMoves(await moneyInFlight(clientId), 'changed');
    }
    const webhookSecret = existing ? null : newSecret(24);
    const data = {
      gateway: 'RAZORPAY',
      keyId,
      keySecretEncrypted: encryptCredential(keySecret),
      mode: razorpayMode(keyId),
      status: 'UNCHECKED',
      checkedAt: null,
      checkMessage: null,
      addedById: userId
    };

    try {
      if (existing) {
        await prisma.shopPaymentAccount.update({ where: { clientId }, data });
      } else {
        await prisma.shopPaymentAccount.create({
          data: {
            ...data,
            clientId,
            webhookSecretEncrypted: encryptCredential(webhookSecret!),
            webhookToken: newSecret(18)
          }
        });
      }
    } catch (e) {
      // Two shops pasting the same key at the same moment: the unique index decides.
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw new OnlineShopRuleError('This Razorpay account is already connected to another shop on ScaleEzy. Each shop connects its own account.');
      }
      throw e;
    }

    const account = await this.check(clientId, apiBase);
    return { account, webhookSecret };
  }

  /** "Check it works". Records the answer, so the screen shows it again tomorrow. */
  async check(clientId: string, apiBase: string): Promise<PaymentAccountView> {
    const gateway = await this.gatewayFor(clientId);
    if (!gateway) throw new OnlineShopRuleError('Connect your Razorpay account first.');
    const result = await gateway.check();
    const row = await prisma.shopPaymentAccount.update({
      where: { clientId },
      data: { status: result.ok ? 'CONNECTED' : 'FAILED', checkedAt: new Date(), checkMessage: result.message }
    });
    return view(row, apiBase);
  }

  /**
   * A new webhook secret, shown once. For the owner who closed the screen before copying it: the
   * old one stops working the moment this is saved, so the answer says to paste the new one in.
   */
  async newWebhookSecret(clientId: string, apiBase: string): Promise<{ account: PaymentAccountView; webhookSecret: string }> {
    const existing = await prisma.shopPaymentAccount.findUnique({ where: { clientId }, select: { id: true } });
    if (!existing) throw new OnlineShopRuleError('Connect your Razorpay account first.');
    const webhookSecret = newSecret(24);
    const row = await prisma.shopPaymentAccount.update({
      where: { clientId },
      data: { webhookSecretEncrypted: encryptCredential(webhookSecret) }
    });
    return { account: view(row, apiBase), webhookSecret };
  }

  /**
   * Disconnect. Removes the keys outright -- nothing of them is kept.
   *
   * Refused while money is moving, and it switches paying online off in the same step: a shop with
   * no keys that still offered "Pay online" would take a customer as far as the Pay button and then
   * refuse them, which is worse than never offering it.
   */
  /** The owner's switch for UPI QR at the POS till. Only with an account connected. */
  async setUpiQr(clientId: string, enabled: unknown, apiBase: string): Promise<PaymentAccountView> {
    if (typeof enabled !== 'boolean') throw new OnlineShopRuleError('Say on or off.');
    const done = await prisma.shopPaymentAccount.updateMany({ where: { clientId }, data: { upiQrEnabled: enabled } });
    if (!done.count) throw new OnlineShopRuleError('Connect your Razorpay account first.');
    return this.describe(clientId, apiBase);
  }

  async remove(clientId: string, apiBase: string): Promise<PaymentAccountView> {
    refuseWhileMoneyMoves(await moneyInFlight(clientId), 'disconnected');
    await prisma.$transaction([
      prisma.shopPaymentAccount.deleteMany({ where: { clientId } }),
      prisma.onlineShop.updateMany({ where: { clientId, payOnline: true }, data: { payOnline: false } })
    ]);
    return view(null, apiBase);
  }

  /** Whether this shop's customers may pay online right now, and if not, why -- in the owner's words. */
  async readiness(clientId: string): Promise<{ ready: boolean; why: string | null }> {
    const row = await prisma.shopPaymentAccount.findUnique({ where: { clientId }, select: { status: true, mode: true } });
    if (!row) return { ready: false, why: 'Connect your Razorpay account first, in Settings → Online shop → Payments.' };
    if (row.status !== 'CONNECTED') {
      return { ready: false, why: 'Your Razorpay keys are not working. Check them in Settings → Online shop → Payments.' };
    }
    if (!isReady(row)) {
      return {
        ready: false,
        why: 'These are Razorpay TEST keys, which cannot take real money. Connect your LIVE keys to take payments.'
          + ' (To try the checkout with test keys first, ask us to switch test mode on for your shop.)'
      };
    }
    return { ready: true, why: null };
  }

  /**
   * The shop's gateway, keys decrypted, for the code that takes money. Null when the shop has not
   * connected one -- and never, ever anybody else's: there is no platform fallback for payments.
   */
  async gatewayFor(clientId: string): Promise<PaymentGateway | null> {
    const row = await prisma.shopPaymentAccount.findUnique({ where: { clientId } });
    if (!row) return null;
    return gatewayFor(row.gateway as 'RAZORPAY', {
      keyId: row.keyId,
      keySecret: decryptCredential(row.keySecretEncrypted),
      webhookSecret: decryptCredential(row.webhookSecretEncrypted)
    });
  }

  /** For the webhook: the shop a delivery is for, found by the token in its address. */
  async byWebhookToken(token: string): Promise<{ clientId: string; gateway: PaymentGateway } | null> {
    if (!/^[A-Za-z0-9_-]{16,64}$/.test(token)) return null;
    const row = await prisma.shopPaymentAccount.findUnique({ where: { webhookToken: token }, select: { clientId: true } });
    if (!row) return null;
    const gateway = await this.gatewayFor(row.clientId);
    return gateway ? { clientId: row.clientId, gateway } : null;
  }
}

export const paymentAccounts = new PaymentAccountService();
