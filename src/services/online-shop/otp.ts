import crypto from 'crypto';
import { prisma } from '../../lib/prisma';
import { getShopSettings } from '../../lib/clientSettings';
import { whatsappClient, whatsappConfigured } from '../whatsapp/client';
import { normalisePhone } from '../../lib/phone';
import { OnlineShopRuleError } from './rules';

/**
 * Proving that the phone number typed at a checkout belongs to whoever typed it.
 *
 * Without this a shop open to the internet can be emptied by somebody entering a made-up number
 * twenty times: every order holds real stock. It also decides something quieter but just as
 * important -- whether an online order may be attached to the shop's REAL customer record. The
 * rule the rest of this codebase already follows is that a number typed at a checkout is not proof
 * of who somebody is, so an unproved order makes its own customer row. Proved, it is the same
 * person the till knows, and their points and their history follow them online.
 *
 * The code is sent on WhatsApp, from the shop's own number, so it arrives in the chat the customer
 * already has with the shop rather than as an SMS from a name they do not recognise.
 *
 * THE CODE IS NEVER STORED. Only a hash of it, so a copy of this table is not a list of live codes
 * for every checkout in progress.
 */

/** Six digits: long enough that guessing is hopeless once tries are capped, short enough to type. */
const DIGITS = 6;
const GOOD_FOR_MS = 10 * 60 * 1000;
/** How long a proved number stays proved, so choosing for ten minutes is not punished. */
const PROOF_LASTS_MS = 60 * 60 * 1000;
/** Wrong guesses before the code is thrown away. Six digits, five tries: one in two hundred thousand. */
const MAX_TRIES = 5;
/** Codes to one number in ten minutes. This is somebody else's phone; it must not become a way to ring it. */
const MAX_SENDS = 3;

const digitsOnly = (v: unknown) => String(v ?? '').replace(/\D/g, '');

/** The number in the one stored form, or a refusal a shopper can act on. */
function asPhone(raw: unknown): string {
  const typed = typeof raw === 'string' ? raw.trim() : '';
  const result = normalisePhone(typed);
  if (!result.ok) throw new OnlineShopRuleError('That phone number does not look right. Check it and try again.');
  return result.value;
}

/*
 * Compared without leaking how much of the code was right.
 *
 * A plain === on two hashes is already constant-length here, but timingSafeEqual says what is
 * meant and cannot be quietly broken by somebody later comparing the codes themselves.
 */
const hash = (code: string, phone: string) =>
  crypto.createHash('sha256').update(`${phone}:${code}`).digest('hex');

const sameHash = (a: string, b: string) => {
  const x = Buffer.from(a, 'utf8');
  const y = Buffer.from(b, 'utf8');
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

/**
 * Whether THIS shop can prove a number at all.
 *
 * This used to ask only whether WhatsApp was set up for ScaleEzy, which is a fact about the
 * platform and says nothing about the shop. A code goes out on the SHOP's own linked number, so a
 * shop that has never linked one -- or whose phone has since been logged out -- cannot send a code
 * at all, and every press of "Send me a code" went past this guard, wrote a code to the database,
 * and then failed at the send with "Something went wrong at the shop".
 *
 * Asked of the WhatsApp service, because it is the only thing that knows. Remembered for a minute
 * because this is a network hop and it is now asked on every checkout page load from the open
 * internet; a shop that links its number waits at most that long for its own button to appear.
 */
const LINK_REMEMBERED_MS = 60_000;
const linkSeen = new Map<string, { can: boolean; at: number }>();

export async function canVerify(clientId: string): Promise<boolean> {
  if (!whatsappConfigured()) return false;

  const seen = linkSeen.get(clientId);
  if (seen && Date.now() - seen.at < LINK_REMEMBERED_MS) return seen.can;

  let can = false;
  try {
    // CONNECTED and nothing else. A queued message is fine for a bill and useless for a code that
    // dies in ten minutes, so "it will go out when the phone comes back" is not good enough here.
    can = (await whatsappClient.account(clientId)).status === 'CONNECTED';
  } catch {
    // The WhatsApp service being unreachable is neither the shop's fault nor the shopper's. It
    // means "cannot prove a number just now", not "break the checkout page".
    can = false;
  }
  linkSeen.set(clientId, { can, at: Date.now() });
  return can;
}

/** Forget what we believed about a shop's link, so the next ask is a real one. */
const forgetLink = (clientId: string) => { linkSeen.delete(clientId); };

/**
 * Send a code to the number, or refuse and say why.
 *
 * Answers the same way whether or not a code was actually sent, except where the shopper can do
 * something about it: "wait a moment" for too many, and a plain refusal for a number that is not
 * a number. Nothing here says whether that number has ever shopped here before.
 */
export async function sendCode(clientId: string, rawPhone: unknown) {
  if (!(await canVerify(clientId))) {
    throw new OnlineShopRuleError('This shop cannot send a code just now. Place your order and it will ring you.');
  }
  const phone = asPhone(rawPhone);
  const now = new Date();

  const held = await prisma.onlineShopPhoneCode.findUnique({
    where: { clientId_phone: { clientId, phone } }
  });

  // Already proved, and the proof has not run out: nothing to send.
  if (held?.verifiedAt && now.getTime() - held.verifiedAt.getTime() < PROOF_LASTS_MS) {
    return { sent: false, alreadyVerified: true, expiresInSeconds: 0 };
  }

  const fresh = held && held.expiresAt > now;
  if (fresh && held.sentCount >= MAX_SENDS) {
    throw new OnlineShopRuleError(
      'A few codes have already gone to that number. Wait a few minutes, or place your order and the shop will ring you.'
    );
  }

  const code = String(crypto.randomInt(0, 10 ** DIGITS)).padStart(DIGITS, '0');
  const expiresAt = new Date(now.getTime() + GOOD_FOR_MS);

  const settings = await getShopSettings(clientId).catch(() => null);
  const shop = await prisma.onlineShop.findUnique({ where: { clientId }, select: { displayName: true } });
  const name = shop?.displayName?.trim() || settings?.businessName?.trim() || 'the shop';

  /*
   * SENT FIRST, AND RECORDED ONLY IF IT WENT.
   *
   * The other way round -- which is how this was written -- counted a code against the shopper
   * that had never left the building. A shop whose WhatsApp was not linked failed at the send
   * every time, but each attempt still wrote a row and raised `sentCount`, so after three presses
   * the shopper was told "a few codes have already gone to that number" about a number that had
   * received nothing, and was then locked out of trying again once the link came back.
   *
   * The cap is not weakened by this: only a code that really went out is counted, which is what
   * the cap was always meant to count. The per-caller limiter on the route covers the rest.
   */
  const { sendShopText } = await import('../whatsapp/service');
  try {
    await sendShopText({
      clientId,
      to: digitsOnly(phone),
      /*
       * Short, and it says what the code is for. A bare number arriving from a shop is the shape of
       * every scam message these customers are warned about; naming the shop and the reason is what
       * makes it believable, and the warning not to pass it on is the one line that matters.
       */
      text: `${code} is your code to confirm your order with ${name}.\n\nIt lasts 10 minutes. Do not share it with anyone.`,
      kind: 'ORDER_UPDATE',
      referenceId: null,
      // One code, one send, however many times the request is retried.
      idempotencyKey: `SHOP:OTP:${clientId}:${phone}:${Math.floor(now.getTime() / 1000)}`,
      sentBy: null,
      linkPreview: false
    });
  } catch (e) {
    /*
     * The service refusing -- the shop logged out on its phone since we last asked, the number is
     * not on WhatsApp, the service is down -- is not a crash to show somebody halfway through an
     * order. It is a sentence, and it points at the way round: the order can still be placed.
     */
    forgetLink(clientId);
    console.warn('[online-shop] a code could not be sent:', (e as Error)?.message);
    throw new OnlineShopRuleError(
      'That code could not be sent just now. Place your order and the shop will ring you to confirm it.'
    );
  }

  await prisma.onlineShopPhoneCode.upsert({
    where: { clientId_phone: { clientId, phone } },
    create: { clientId, phone, codeHash: hash(code, phone), expiresAt, tries: 0, sentCount: 1 },
    update: {
      codeHash: hash(code, phone),
      expiresAt,
      tries: 0,
      // Counted within the window, and started again once the window has passed.
      sentCount: fresh ? { increment: 1 } : 1,
      verifiedAt: null
    }
  });

  return { sent: true, alreadyVerified: false, expiresInSeconds: Math.round(GOOD_FOR_MS / 1000) };
}

/** Check a code the shopper typed back. */
export async function checkCode(clientId: string, rawPhone: unknown, rawCode: unknown) {
  const phone = asPhone(rawPhone);
  const code = digitsOnly(rawCode);
  if (code.length !== DIGITS) throw new OnlineShopRuleError(`The code is ${DIGITS} digits. Check the message and try again.`);

  const held = await prisma.onlineShopPhoneCode.findUnique({
    where: { clientId_phone: { clientId, phone } }
  });
  if (!held || held.expiresAt <= new Date()) {
    throw new OnlineShopRuleError('That code has run out. Ask for a new one.');
  }
  if (held.tries >= MAX_TRIES) {
    throw new OnlineShopRuleError('That code has been tried too many times. Ask for a new one.');
  }

  if (!sameHash(held.codeHash, hash(code, phone))) {
    const after = await prisma.onlineShopPhoneCode.update({
      where: { id: held.id }, data: { tries: { increment: 1 } }, select: { tries: true }
    });
    const left = MAX_TRIES - after.tries;
    throw new OnlineShopRuleError(
      left > 0 ? `That code is not right. ${left} ${left === 1 ? 'try' : 'tries'} left.` : 'That code is not right. Ask for a new one.'
    );
  }

  await prisma.onlineShopPhoneCode.update({ where: { id: held.id }, data: { verifiedAt: new Date(), tries: 0 } });
  return { verified: true };
}

/**
 * Was this number proved recently? Read by the checkout when the order is placed.
 *
 * Deliberately not something the browser can claim: the page sends the number, and the answer
 * comes from what this shop actually sent and what was actually typed back.
 */
export async function isVerified(clientId: string, rawPhone: unknown): Promise<boolean> {
  const result = normalisePhone(typeof rawPhone === 'string' ? rawPhone.trim() : '');
  if (!result.ok) return false;
  const held = await prisma.onlineShopPhoneCode.findUnique({
    where: { clientId_phone: { clientId, phone: result.value } },
    select: { verifiedAt: true }
  });
  return !!held?.verifiedAt && Date.now() - held.verifiedAt.getTime() < PROOF_LASTS_MS;
}

/** Codes nobody will ever type again. Called by housekeeping. */
export async function forgetOldCodes(before: Date) {
  const { count } = await prisma.onlineShopPhoneCode.deleteMany({ where: { expiresAt: { lt: before } } });
  return count;
}
