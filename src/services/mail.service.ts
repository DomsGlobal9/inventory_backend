import { env } from '../config/env';
import { sendMail, emailConfigured, verifyMailConfiguration, SendResult } from '../lib/mailer';

/**
 * Every message this application is allowed to send.
 *
 * Deliberately a fixed list of named methods rather than a generic send. A `POST /email/send`
 * that accepts a recipient, a subject and an HTML body is an open relay behind an API key:
 * whoever reaches it can send mail that appears to come from your domain, and a shared sending
 * reputation is destroyed by one abuser. Adding a message here is a code change and a review,
 * which is the correct amount of friction.
 *
 * Every method returns whether it went, and never throws. The work that triggered the email has
 * already succeeded by the time these run.
 */

/** The plain-text half. Some clients show only this, and it must stand alone. */
function credentialText(input: {
  recipientName: string; email: string; password: string; roleLabel?: string; loginUrl: string;
}) {
  return [
    `Hi ${input.recipientName},`,
    '',
    `You have been added to the Scaleezy Inventory workspace${input.roleLabel ? ` as ${input.roleLabel}` : ''}.`,
    '',
    `Email: ${input.email}`,
    `Password: ${input.password}`,
    '',
    `Sign in: ${input.loginUrl}`,
    '',
    'Keep this message private. If you need the password changed, ask your Super Admin or Admin.'
  ].join('\n');
}

function credentialHtml(input: {
  recipientName: string; email: string; password: string; roleLabel?: string; loginUrl: string;
}) {
  // Inline styles and a table-free layout on purpose: mail clients strip <style> blocks, and
  // anything clever renders differently in Outlook than everywhere else.
  return `
<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;font-size:15px;color:#1a1a1a;line-height:1.6">
  <p>Hi ${escapeHtml(input.recipientName)},</p>
  <p>You have been added to the Scaleezy Inventory workspace${input.roleLabel ? ` as <strong>${escapeHtml(input.roleLabel)}</strong>` : ''}.</p>
  <div style="background:#f6f6f4;border:1px solid #e5e5e0;border-radius:8px;padding:16px;margin:20px 0">
    <div style="font-size:12px;color:#6b6b66;text-transform:uppercase;letter-spacing:.05em;margin-bottom:4px">Email</div>
    <div style="font-size:15px;margin-bottom:12px">${escapeHtml(input.email)}</div>
    <div style="font-size:12px;color:#6b6b66;text-transform:uppercase;letter-spacing:.05em;margin-bottom:4px">Password</div>
    <div style="font-size:16px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace">${escapeHtml(input.password)}</div>
  </div>
  <p><a href="${escapeHtml(input.loginUrl)}" style="display:inline-block;background:#1a1a1a;color:#fff;text-decoration:none;padding:10px 20px;border-radius:6px">Sign in</a></p>
  <p style="color:#6b6b66;font-size:13px">Keep this message private. If you need the password changed, ask your Super Admin or Admin.</p>
</div>`.trim();
}

/** Names and roles are entered by users, so they are escaped before going into markup. */
function escapeHtml(value: string): string {
  return String(value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

export class MailService {
  /** Whether this deployment can send at all, so a screen can say so before anyone tries. */
  isConfigured(): boolean {
    return emailConfigured();
  }

  /** Checks the settings without sending. Used by the verification script and by support. */
  verify(): Promise<SendResult> {
    return verifyMailConfiguration();
  }

  /**
   * Sends a staff member their own login.
   *
   * The one message in this app that carries a secret, which is why it exists as its own
   * method: it is the thing to be careful about, and burying it in a generic sender would make
   * it invisible.
   *
   * A password in an inbox is a real tradeoff. It is accepted here because the alternative in
   * this product is worse -- today an admin pastes the same password into WhatsApp by hand,
   * where it sits in two devices' chat history and a backup, rather than one mailbox.
   */
  async sendCredentials(input: {
    recipientName: string;
    email: string;
    password: string;
    roleLabel?: string;
    /** A platform admin signs in somewhere else entirely. */
    audience?: 'shop' | 'platform';
  }): Promise<SendResult> {
    // Two different applications behind one hostname, with separate logins and separate
    // sessions. A platform admin sent to /login meets the shop sign-in page, types correct
    // credentials, and is told they are wrong -- because that form checks a different table.
    // The link has to match who the message is for.
    const base = env.FRONTEND_URL.replace(/\/$/, '');
    const loginUrl = input.audience === 'platform'
      ? `${base}/platformconsole/login`
      : `${base}/login`;
    const body = { ...input, loginUrl };

    return sendMail({
      to: input.email,
      subject: 'Your Scaleezy Inventory login',
      text: credentialText(body),
      html: credentialHtml(body),
      kind: 'credentials'
    });
  }

  /**
   * Confirms to an admin that a storefront stopped working.
   *
   * A delivery that dead-letters is currently only visible to someone who opens the storefront
   * screen and looks -- which nobody does until a customer complains that the website is
   * showing stock the shop does not have.
   */
  async sendStorefrontFailureAlert(input: {
    to: string;
    connectionName: string;
    reason: string;
    failedCount: number;
  }): Promise<SendResult> {
    const text = [
      `Updates to "${input.connectionName}" are not getting through.`,
      '',
      `${input.failedCount} update${input.failedCount === 1 ? '' : 's'} could not be delivered.`,
      `Reason: ${input.reason}`,
      '',
      'Until this is fixed, that storefront is showing stock levels that may be out of date.',
      '',
      `Open Settings then Storefront to see the delivery log: ${env.FRONTEND_URL.replace(/\/$/, '')}/settings`
    ].join('\n');

    return sendMail({
      to: input.to,
      subject: `Storefront updates are failing: ${input.connectionName}`,
      text,
      kind: 'storefront-failure'
    });
  }

  /**
   * Tells someone stock has run low.
   *
   * Deliberately a digest rather than one message per item: a shop crossing its reorder level
   * on forty lines at once should get one email, not forty. Forty emails is how a recipient
   * learns to filter everything from a sender into a folder they never open.
   */
  async sendLowStockDigest(input: {
    to: string;
    items: { title: string; sku: string; quantity: number; reorderLevel: number }[];
  }): Promise<SendResult> {
    if (input.items.length === 0) return { sent: false, reason: 'Nothing to report.' };

    const lines = input.items.map(i =>
      `  ${i.title} (${i.sku}) -- ${i.quantity} left, reorder at ${i.reorderLevel}`
    );

    const text = [
      `${input.items.length} item${input.items.length === 1 ? '' : 's'} at or below the reorder level:`,
      '',
      ...lines,
      '',
      `${env.FRONTEND_URL.replace(/\/$/, '')}/inventory?filter=low_stock`
    ].join('\n');

    return sendMail({
      to: input.to,
      subject: `${input.items.length} item${input.items.length === 1 ? '' : 's'} running low`,
      text,
      kind: 'low-stock-digest'
    });
  }
  /**
   * Sends a purchase order to the supplier who has to fill it.
   *
   * Until now the only way to get an order out of this app was "Send on WhatsApp", which opens
   * WhatsApp with the order pre-filled and relies on the merchant pressing send, and then on
   * them remembering to come back and press "Mark as Sent". A supplier with an email address
   * and no WhatsApp number could not be sent an order from here at all -- the merchant retyped
   * it into their own mail client, which is where transcription mistakes come from.
   *
   * The whole order goes in the body rather than as an attachment. A supplier reading this on a
   * phone should not have to open a PDF to find out how many pieces to pack, and a plain body
   * is also what they can reply to and quote back.
   */
  async sendPurchaseOrder(input: {
    to: string;
    supplierName: string;
    poNumber: string;
    shopName: string;
    orderedByName?: string;
    expectedDeliveryDate?: Date | null;
    notes?: string | null;
    items: { title: string; sku: string; variantLabel?: string; quantity: number; unitPrice: number }[];
    total: number;
  }): Promise<SendResult> {
    if (input.items.length === 0) return { sent: false, reason: 'This order has no items.' };

    const money = (n: number) =>
      `Rs ${Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    const deliverBy = input.expectedDeliveryDate
      ? new Date(input.expectedDeliveryDate).toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' })
      : null;

    const text = [
      `Hello ${input.supplierName},`,
      '',
      `Please supply the following against purchase order ${input.poNumber}.`,
      '',
      ...input.items.map(i =>
        `  ${i.quantity} x ${i.title}${i.variantLabel ? ` (${i.variantLabel})` : ''} [${i.sku}] @ ${money(i.unitPrice)} = ${money(i.quantity * i.unitPrice)}`
      ),
      '',
      `Order total: ${money(input.total)}`,
      ...(deliverBy ? ['', `Required by: ${deliverBy}`] : []),
      ...(input.notes ? ['', `Notes: ${input.notes}`] : []),
      '',
      `Ordered by ${input.orderedByName ? `${input.orderedByName}, ` : ''}${input.shopName}.`,
      `Please reply to this email quoting ${input.poNumber} to confirm.`
    ].join('\n');

    const rows = input.items.map(i => `
    <tr>
      <td style="padding:8px 10px;border-bottom:1px solid #eeeeea">
        ${escapeHtml(i.title)}${i.variantLabel ? `<div style="color:#6b6b66;font-size:13px">${escapeHtml(i.variantLabel)}</div>` : ''}
        <div style="color:#9a9a94;font-size:12px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace">${escapeHtml(i.sku)}</div>
      </td>
      <td style="padding:8px 10px;border-bottom:1px solid #eeeeea;text-align:right;white-space:nowrap">${i.quantity}</td>
      <td style="padding:8px 10px;border-bottom:1px solid #eeeeea;text-align:right;white-space:nowrap">${escapeHtml(money(i.unitPrice))}</td>
      <td style="padding:8px 10px;border-bottom:1px solid #eeeeea;text-align:right;white-space:nowrap">${escapeHtml(money(i.quantity * i.unitPrice))}</td>
    </tr>`).join('');

    const html = `
<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;font-size:15px;color:#1a1a1a;line-height:1.6">
  <p>Hello ${escapeHtml(input.supplierName)},</p>
  <p>Please supply the following against purchase order <strong>${escapeHtml(input.poNumber)}</strong>.</p>
  <table style="border-collapse:collapse;width:100%;margin:16px 0;font-size:14px">
    <thead>
      <tr style="background:#f6f6f4">
        <th style="padding:8px 10px;text-align:left;border-bottom:1px solid #e5e5e0">Item</th>
        <th style="padding:8px 10px;text-align:right;border-bottom:1px solid #e5e5e0">Qty</th>
        <th style="padding:8px 10px;text-align:right;border-bottom:1px solid #e5e5e0">Rate</th>
        <th style="padding:8px 10px;text-align:right;border-bottom:1px solid #e5e5e0">Amount</th>
      </tr>
    </thead>
    <tbody>${rows}</tbody>
    <tfoot>
      <tr>
        <td colspan="3" style="padding:10px;text-align:right;font-weight:600">Order total</td>
        <td style="padding:10px;text-align:right;font-weight:600;white-space:nowrap">${escapeHtml(money(input.total))}</td>
      </tr>
    </tfoot>
  </table>
  ${deliverBy ? `<p><strong>Required by:</strong> ${escapeHtml(deliverBy)}</p>` : ''}
  ${input.notes ? `<p><strong>Notes:</strong> ${escapeHtml(input.notes)}</p>` : ''}
  <p style="color:#6b6b66;font-size:13px">
    Ordered by ${input.orderedByName ? `${escapeHtml(input.orderedByName)}, ` : ''}${escapeHtml(input.shopName)}.<br>
    Please reply to this email quoting ${escapeHtml(input.poNumber)} to confirm.
  </p>
</div>`.trim();

    return sendMail({
      to: input.to,
      subject: `Purchase order ${input.poNumber} from ${input.shopName}`,
      text,
      html,
      kind: 'purchase-order'
    });
  }

}

export const mailService = new MailService();
