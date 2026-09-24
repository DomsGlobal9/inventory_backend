import crypto from 'crypto';
import { prisma } from '../../lib/prisma';
import { normalisePhone } from '../../lib/phone';
import { whatsappClient, whatsappConfigured } from '../whatsapp/client';

/**
 * Proving the phone number somebody types into the signup form.
 *
 * Until now the form took a number and never checked it, so a lead could carry anything at all and
 * whoever rang it found out the hard way. This sends six digits to it on WhatsApp and asks for
 * them back.
 *
 * FROM SCALEEZY'S OWN NUMBER, not a shop's, because the person filling this in has no shop yet --
 * that is the whole point of the form. `whatsappClient.send({ from: 'scaleezy' })` is the same path
 * the nightly Day Book and the disconnection alerts already go out on.
 *
 * ITS OWN MODULE, deliberately. This looks like online-shop/otp.ts and is not the same thing: that
 * one is scoped to a shop and proves a SHOPPER to that shop, with a browser-bound secret because it
 * guards saved addresses. Here there is no shop, nothing to read back, and the only question is
 * whether the number on this one enquiry is real -- so it is keyed on the number alone. Folding the
 * two together would mean one of them carrying rules it does not need.
 *
 * THE CODE IS NEVER STORED. Only a hash of it, salted with the number.
 */

/** A refusal the person filling the form can act on, as opposed to something breaking. */
export class SignupVerifyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SignupVerifyError';
    (this as any).statusCode = 400;
  }
}

const DIGITS = 6;
const GOOD_FOR_MS = 10 * 60 * 1000;
/** How long a proved number stays proved -- long enough to finish typing out the rest of the form. */
const PROOF_LASTS_MS = 30 * 60 * 1000;
/** Wrong guesses before the code is thrown away. Six digits, five tries: one in two hundred thousand. */
const MAX_TRIES = 5;
/** Codes to one number inside one window. This is somebody else's phone; it must never be a way to pester them. */
const MAX_SENDS = 3;

const hash = (code: string, phone: string) =>
  crypto.createHash('sha256').update(`${phone}:${code}`).digest('hex');

/** Compared in constant time, so the answer cannot be felt out one digit at a time. */
const sameHash = (a: string, b: string) => {
  const x = Buffer.from(a, 'utf8');
  const y = Buffer.from(b, 'utf8');
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

const asPhone = (raw: unknown): string => {
  const result = normalisePhone(typeof raw === 'string' ? raw.trim() : '');
  if (!result.ok) throw new SignupVerifyError('That phone number does not look right.');
  return result.value;
};

/**
 * Whether ScaleEzy can send a code at all right now.
 *
 * Not "is WhatsApp configured" -- that is a fact about the deployment and says nothing about
 * whether the number is actually linked and up. Remembered for a minute, because this is asked on
 * a public form and is a hop to another service.
 *
 * It matters far beyond hiding a button: the signup form REFUSES an unproved number only while
 * this is true. A form that turned everybody away because one phone dropped would cost real
 * customers, so when ScaleEzy cannot send, the enquiry is taken unproved and marked as such.
 */
const REMEMBER_MS = 60_000;

/*
 * WHAT WE LEARNED FROM ACTUALLY TRYING, rather than from asking.
 *
 * The first version asked `whatsappClient.account('scaleezy')`, and that endpoint does not exist
 * for ScaleEzy's own number: `/v1/accounts/client/:clientId` serves CLIENT accounts, and the
 * ScaleEzy account is a different kind with no clientId at all (see the WhatsApp service's
 * accounts/service.ts, which finds it by `kind: 'SCALEEZY'`). So it answered "not found", canSend
 * was false for ever, and signup verification would have been quietly dead in production too --
 * a pre-check that could never once have succeeded.
 *
 * There is no v1 endpoint to ask, so this stops asking. The only honest test of "can we send" is
 * a send, and we do one of those whenever somebody presses Verify. What that attempt taught us is
 * remembered here for a minute and is what the signup form's gate reads.
 */
let lastSend: { worked: boolean; at: number } | null = null;

const learned = (worked: boolean) => { lastSend = { worked, at: Date.now() }; };

/**
 * Whether a code could be sent, as far as anything here knows.
 *
 * UNKNOWN COUNTS AS NO, and that is the safe direction: it only decides whether an unproved
 * enquiry is REFUSED, so being wrong this way takes an enquiry we might have questioned, while
 * being wrong the other way turns away a real customer over a number we could never have texted.
 */
export async function canSend(): Promise<boolean> {
  if (!whatsappConfigured()) return false;
  if (lastSend && Date.now() - lastSend.at < REMEMBER_MS) return lastSend.worked;
  return false;
}

/** Forget what the last attempt taught us, so the next one is judged on its own. */
const forget = () => { lastSend = null; };

/**
 * Whether an enquiry must carry a proved number, which is not quite the same as whether we can ask.
 *
 *   always  demand it whatever WhatsApp is doing
 *   never   take every enquiry unproved -- for a known outage, or a trade show stand where people
 *           sign up on a borrowed laptop and their phone is in a bag somewhere
 *   unset   the sensible default: demand it only while a code could really have been sent
 *
 * Read from process.env at call time rather than through the parsed config, and that is deliberate
 * twice over. It can be flipped on a running instance during an outage without a deploy; and it is
 * the only way the suite can exercise BOTH branches on a developer's machine, where no WhatsApp is
 * linked and `canSend()` is therefore always false. Stubbing the module cannot do it -- an ES
 * namespace object is not writable, and an attempt to assign one fails silently, which is how the
 * first version of that suite came to pass while testing nothing at all.
 */
export async function mustProve(): Promise<boolean> {
  const said = (process.env.SIGNUP_PHONE_PROOF || '').trim().toLowerCase();
  if (said === 'always') return true;
  if (said === 'never') return false;
  return canSend();
}

/** Send a code to the number, or refuse and say why. */
export async function sendCode(rawPhone: unknown) {
  /*
   * The number is read FIRST. Asked the other way round, somebody who mistyped their number was
   * told "we cannot send a code just now" whenever WhatsApp happened to be down -- which sends
   * them off to wait for a service that was never the problem. A number that is not a number is
   * not a number whatever the state of anything else.
   */
  const phone = asPhone(rawPhone);

  /*
   * NO PRE-CHECK. Pressing Verify tries to send, and what happens is the answer -- there is no
   * endpoint that can tell us in advance about ScaleEzy's own number, and a guard built on one
   * that did not exist refused every press without ever attempting anything.
   */
  const now = new Date();

  const held = await prisma.signupPhoneCode.findUnique({ where: { phone } });

  // Already proved and still fresh: nothing to send.
  if (held?.verifiedAt && now.getTime() - held.verifiedAt.getTime() < PROOF_LASTS_MS) {
    return { sent: false, alreadyVerified: true, expiresInSeconds: 0 };
  }

  const fresh = held && held.expiresAt > now;
  if (fresh && held.sentCount >= MAX_SENDS) {
    throw new SignupVerifyError(
      'A few codes have already gone to that number. Wait a few minutes, or send your enquiry and we will ring you.'
    );
  }

  const code = String(crypto.randomInt(0, 10 ** DIGITS)).padStart(DIGITS, '0');

  /*
   * SENT FIRST, RECORDED ONLY IF IT WENT.
   *
   * The other way round counts a code against somebody that never left the building -- three
   * failed attempts and they are told "a few codes have already gone to that number" about a phone
   * that received none, then locked out of trying again. The shop's OTP had exactly that fault.
   */
  try {
    await whatsappClient.send({
      from: 'scaleezy',
      to: phone.replace(/^\+/, ''),
      // Says who it is from and what it is for. A bare number arriving out of nowhere is the shape
      // of every scam message people are warned about.
      text: `${code} is your code to confirm your number with ScaleEzy.\n\nIt lasts 10 minutes. Do not share it with anyone.`,
      kind: 'TEST',
      reference: 'SIGNUP',
      // One code per send, however many times the request is retried.
      idempotencyKey: `SIGNUP:OTP:${phone}:${Math.floor(now.getTime() / 1000)}`
    });
    learned(true);
  } catch (e) {
    learned(false);
    const why = (e as Error)?.message || '';
    console.warn('[signup] a code could not be sent:', why);
    /*
     * The service's own sentence when it is something the person can act on -- "this number is not
     * on WhatsApp" is worth repeating, "ECONNREFUSED" is not. Anything else becomes the plain
     * fallback, which always names the way round rather than leaving them stuck.
     */
    throw new SignupVerifyError(
      /not on whatsapp|not a whatsapp/i.test(why)
        ? 'That number is not on WhatsApp. Send your enquiry anyway and we will ring you.'
        : 'That code could not be sent just now. Send your enquiry anyway and we will ring you.'
    );
  }

  await prisma.signupPhoneCode.upsert({
    where: { phone },
    create: { phone, codeHash: hash(code, phone), expiresAt: new Date(now.getTime() + GOOD_FOR_MS), tries: 0, sentCount: 1 },
    update: {
      codeHash: hash(code, phone),
      expiresAt: new Date(now.getTime() + GOOD_FOR_MS),
      tries: 0,
      sentCount: fresh ? { increment: 1 } : 1,
      verifiedAt: null
    }
  });

  return { sent: true, alreadyVerified: false, expiresInSeconds: Math.round(GOOD_FOR_MS / 1000) };
}

/** Check a code typed back. */
export async function checkCode(rawPhone: unknown, rawCode: unknown) {
  const phone = asPhone(rawPhone);
  const code = (typeof rawCode === 'string' ? rawCode : '').replace(/\D/g, '');
  if (code.length !== DIGITS) {
    throw new SignupVerifyError(`The code is ${DIGITS} digits. Check the message and try again.`);
  }

  const held = await prisma.signupPhoneCode.findUnique({ where: { phone } });
  if (!held || held.expiresAt <= new Date()) {
    throw new SignupVerifyError('That code has run out. Ask for a new one.');
  }

  /*
   * ALREADY PROVED, AND THE PROOF IS STILL GOOD -- say yes again.
   *
   * A double tap on Confirm, or a slow line and an impatient thumb, used to land here a second
   * time. Scolding somebody for confirming what they have already confirmed is a refusal with
   * nothing behind it, so this answers the same way it did the first time. It grants nothing new:
   * the proof they are being shown is the one they already earned a moment ago.
   */
  if (held.verifiedAt && Date.now() - held.verifiedAt.getTime() < PROOF_LASTS_MS) {
    return { verified: true };
  }

  if (held.tries >= MAX_TRIES) {
    throw new SignupVerifyError('That code has been tried too many times. Ask for a new one.');
  }

  if (!sameHash(held.codeHash, hash(code, phone))) {
    const after = await prisma.signupPhoneCode.update({
      where: { id: held.id }, data: { tries: { increment: 1 } }, select: { tries: true }
    });
    const left = MAX_TRIES - after.tries;
    throw new SignupVerifyError(
      left > 0
        ? `That code is not right. ${left} ${left === 1 ? 'try' : 'tries'} left.`
        : 'That code is not right. Ask for a new one.'
    );
  }

  /*
   * SPENT. The hash is wiped, so those six digits can never be typed in again -- once the proof
   * window above has passed there is nothing left to replay, even for somebody who read the
   * message over a shoulder. `verifiedAt` is what carries the proof from here on, and it has its
   * own expiry.
   */
  await prisma.signupPhoneCode.update({
    where: { id: held.id }, data: { verifiedAt: new Date(), tries: 0, codeHash: '' }
  });
  return { verified: true };
}

/** Whether this number was proved recently. Read by the signup form before a lead is written. */
export async function isVerified(rawPhone: unknown): Promise<boolean> {
  const result = normalisePhone(typeof rawPhone === 'string' ? rawPhone.trim() : '');
  if (!result.ok) return false;
  const held = await prisma.signupPhoneCode.findUnique({
    where: { phone: result.value }, select: { verifiedAt: true }
  });
  return !!held?.verifiedAt && Date.now() - held.verifiedAt.getTime() < PROOF_LASTS_MS;
}
