import nodemailer, { Transporter } from 'nodemailer';
import { env } from '../config/env';

/**
 * The one place that talks to an SMTP server.
 *
 * Three rules this file exists to hold.
 *
 * SENDING NEVER FAILS THE WORK THAT CAUSED IT. Adding a staff member is the real action; the
 * email is a courtesy on top of it. If SMTP is down, misconfigured, or simply not set up, the
 * user is still created and the caller is told the message did not go -- so the admin can fall
 * back to the WhatsApp/copy path that already exists. An inventory app must not become
 * unusable because a mail server is unreachable.
 *
 * NOTHING SECRET IS EVER LOGGED. These messages carry passwords. The log records that a
 * message was sent, to whom, and of what kind -- never the body, never the password.
 *
 * THERE IS NO "SEND ANYTHING TO ANYONE" FUNCTION. Every send is a named, purpose-built method
 * with a fixed shape. A generic endpoint that takes a recipient, a subject and an HTML body is
 * an open relay wearing a REST API: anyone who can reach it can send mail that appears to come
 * from your domain, and your sending reputation is gone in an afternoon.
 */

export interface SendResult {
  sent: boolean;
  /** Why not, in words an admin can act on. Never a raw SMTP dump. */
  reason?: string;
  messageId?: string;
}

let transporter: Transporter | null = null;
let configurationError: string | null = null;

function fromAddress(): string {
  const address = env.EMAIL_FROM_ADDRESS ?? env.EMAIL_HOST_USER ?? '';
  return `"${env.EMAIL_FROM_NAME}" <${address}>`;
}

/**
 * Builds the transport once, lazily.
 *
 * Lazily because the app must boot without email configured, and once because a new SMTP
 * connection per message is slow and gets a sender rate-limited quickly -- nodemailer pools
 * and reuses connections when the transport is kept.
 */
function getTransporter(): Transporter | null {
  if (transporter) return transporter;
  if (configurationError) return null;

  const { EMAIL_HOST, EMAIL_HOST_USER, EMAIL_HOST_PASSWORD, EMAIL_PORT, EMAIL_USE_TLS } = env;

  if (!EMAIL_HOST || !EMAIL_HOST_USER || !EMAIL_HOST_PASSWORD) {
    configurationError =
      'Email is not set up on this deployment. EMAIL_HOST, EMAIL_HOST_USER and ' +
      'EMAIL_HOST_PASSWORD must be set before messages can be sent.';
    return null;
  }

  transporter = nodemailer.createTransport({
    host: EMAIL_HOST,
    port: EMAIL_PORT,
    // `secure` is about IMPLICIT TLS, which is port 465 only. On 587 the connection starts
    // plain and is upgraded by STARTTLS, so secure must be false there -- setting it true on
    // 587 hangs until the socket times out, and looks exactly like a blocked port.
    secure: EMAIL_USE_TLS && EMAIL_PORT === 465,
    requireTLS: EMAIL_USE_TLS && EMAIL_PORT !== 465,
    auth: { user: EMAIL_HOST_USER, pass: EMAIL_HOST_PASSWORD },
    pool: true,
    maxConnections: 3,
    // A hung SMTP connection would otherwise hold an HTTP request open for minutes.
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000
  });

  return transporter;
}

/** True when this deployment can send at all. Lets a screen say so before anyone tries. */
export function emailConfigured(): boolean {
  return Boolean(env.EMAIL_HOST && env.EMAIL_HOST_USER && env.EMAIL_HOST_PASSWORD);
}

/**
 * Sends one message.
 *
 * Internal on purpose -- callers use the named methods in mail.service.ts rather than this.
 * Never throws: the result says what happened, because every caller's real work has already
 * succeeded by the time it gets here.
 */
export async function sendMail(input: {
  to: string;
  subject: string;
  text: string;
  html?: string;
  /** For the log line only. Never the content. */
  kind: string;
}): Promise<SendResult> {
  const transport = getTransporter();
  if (!transport) {
    return { sent: false, reason: configurationError ?? 'Email is not configured.' };
  }

  try {
    const info = await transport.sendMail({
      from: fromAddress(),
      to: input.to,
      subject: input.subject,
      text: input.text,
      html: input.html
    });

    // Recipient and kind, nothing else. These messages carry passwords.
    console.log(`[Mail] ${input.kind} -> ${input.to} (${info.messageId})`);
    return { sent: true, messageId: info.messageId };
  } catch (error: any) {
    // Translated rather than passed through: "535-5.7.8 Username and Password not accepted"
    // is accurate and useless to a shop owner, and the raw error can contain the credential.
    const code = String(error?.code ?? '');
    const reason =
      code === 'EAUTH' ? 'The mail account rejected our sign-in. The app password may have been revoked.'
      : code === 'ECONNECTION' || code === 'ETIMEDOUT' ? 'Could not reach the mail server.'
      : code === 'EENVELOPE' ? 'That address was rejected by the mail server.'
      : 'The message could not be sent.';

    console.error(`[Mail] ${input.kind} -> ${input.to} FAILED (${code || 'unknown'})`);
    return { sent: false, reason };
  }
}

/**
 * Checks the SMTP settings without sending anything.
 *
 * Worth having separately: it is the difference between "your password is wrong" discovered on
 * a deploy, and discovered by a shop owner whose new staff member never got their login.
 */
export async function verifyMailConfiguration(): Promise<SendResult> {
  const transport = getTransporter();
  if (!transport) return { sent: false, reason: configurationError ?? 'Email is not configured.' };

  try {
    await transport.verify();
    return { sent: true };
  } catch (error: any) {
    const code = String(error?.code ?? '');
    return {
      sent: false,
      reason: code === 'EAUTH'
        ? 'The mail server rejected the username or password.'
        : `Could not connect to ${env.EMAIL_HOST}:${env.EMAIL_PORT}.`
    };
  }
}

/** Test seam: forget the built transport so new settings are picked up. */
export function resetMailer() {
  transporter = null;
  configurationError = null;
}
