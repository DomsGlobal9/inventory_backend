import { prisma } from '../../lib/prisma';
import { normalisePhone } from '../../lib/phone';
import { sendMail } from '../../lib/mailer';
import { signupVerify, SignupVerifyError } from '../signup-verify';
import { whatsappClient, whatsappConfigured } from './client';

/**
 * Changing the number a shop says is its own.
 *
 * `ClientSettings.businessPhone` is the number printed on a purchase order, shown on the counter
 * receipt, published on the online shop because the law requires a seller contact, and compared
 * against whatever WhatsApp is linked. It matters enough that it should not simply be a text box
 * anybody can retype -- but it must also never become a locked field a shop has to raise a support
 * ticket to move, because real shops change numbers: a lost SIM, a new business line, an owner who
 * has left, or a signup filled in on somebody's personal mobile.
 *
 * So: they may change it themselves, and they prove the new number the same way they proved the
 * first one -- a code on WhatsApp from ScaleEzy's own number.
 *
 * THE CODE GOES TO THE NEW NUMBER, not the old one. We are not asking them to prove they still
 * hold the number they are leaving; we are asking them to prove the one they are moving to is real
 * and in their hand. A shop whose old phone is lost is exactly the shop that needs this to work.
 *
 * What replaces the safety of an approval queue is TELLING EVERYONE, at once: the old number and
 * every owner's email hear about the change the moment it happens. Somebody quietly redirecting a
 * shop's number is noticed in seconds rather than waiting in a queue for a person who may not be
 * watching.
 */

export { SignupVerifyError };

type Actor = { id: string; clientId: string; name?: string | null };

const digitsOf = (raw: string) => raw.replace(/\D/g, '');
const masked = (raw: string) => {
  const d = digitsOf(raw);
  return d ? `••••${d.slice(-4)}` : '';
};

/** Read what the shop currently says is its number. */
export async function current(clientId: string) {
  const row = await prisma.clientSettings.findUnique({
    where: { clientId }, select: { businessPhone: true, businessName: true }
  });
  return {
    phone: row?.businessPhone ?? null,
    masked: row?.businessPhone ? masked(row.businessPhone) : null,
    businessName: row?.businessName ?? null
  };
}

/**
 * Step one: send a code to the number they want to move to.
 *
 * Refusals here always leave a way forward -- the same number they already have is not an error
 * worth stopping for, it is simply nothing to do.
 */
export async function startChange(actor: Actor, rawPhone: unknown) {
  const wanted = normalisePhone(typeof rawPhone === 'string' ? rawPhone.trim() : '');
  if (!wanted.ok) throw new SignupVerifyError('That phone number does not look right.');

  const now = await current(actor.clientId);
  if (now.phone && digitsOf(now.phone).slice(-10) === digitsOf(wanted.value).slice(-10)) {
    // Not a failure: they asked for what they already have.
    return { sent: false, alreadyYours: true, phone: masked(wanted.value) };
  }

  /*
   * The code itself is the signup module's -- one way of proving a phone with ScaleEzy's own
   * WhatsApp, used twice -- but its SENTENCES are written for somebody filling in the signup form.
   * "Send your enquiry anyway and we will ring you" makes no sense to a shop owner in Settings who
   * has no enquiry to send, so the wording is put right for where it is actually being read.
   */
  try {
    const out: any = await signupVerify.sendCode(wanted.value);
    return { sent: out.sent !== false, alreadyYours: false, phone: masked(wanted.value) };
  } catch (e) {
    if (!(e instanceof SignupVerifyError)) throw e;
    const why = e.message;
    if (/not on whatsapp/i.test(why)) {
      throw new SignupVerifyError('That number is not on WhatsApp. Use a number that has WhatsApp on it.');
    }
    if (/already gone to that number/i.test(why)) {
      throw new SignupVerifyError('A few codes have already gone to that number. Wait a few minutes and try again.');
    }
    throw new SignupVerifyError(
      'We could not send a code just now, so the number has not changed. Try again in a few minutes.'
    );
  }
}

/**
 * Step two: they type the code back, and the number changes.
 *
 * Everyone who should know is told afterwards, never inside the write -- a message that fails must
 * not undo a change the shop has already been shown as done.
 */
export async function finishChange(actor: Actor, rawPhone: unknown, code: unknown) {
  const wanted = normalisePhone(typeof rawPhone === 'string' ? rawPhone.trim() : '');
  if (!wanted.ok) throw new SignupVerifyError('That phone number does not look right.');

  // Throws its own plain sentence when the code is wrong, expired or tried too often.
  await signupVerify.checkCode(wanted.value, code);

  const before = await current(actor.clientId);
  await prisma.clientSettings.upsert({
    where: { clientId: actor.clientId },
    create: { clientId: actor.clientId, businessPhone: wanted.value },
    update: { businessPhone: wanted.value }
  });

  void tellEverybody(actor, before.phone, wanted.value, before.businessName).catch(e =>
    console.warn('[shop-number] could not announce the change:', (e as Error)?.message));

  return { changed: true, phone: masked(wanted.value) };
}

/**
 * The old number and every owner's inbox, told at once.
 *
 * This is what makes self-service safe enough to not need an approval queue. The WhatsApp goes
 * from ScaleEzy's own number, because the shop's number may not be linked -- and because a shop
 * being told "your number changed" by the very number it is moving away from would be no warning
 * at all if somebody else had done it.
 */
async function tellEverybody(actor: Actor, oldPhone: string | null, newPhone: string, shopName: string | null) {
  const name = shopName || 'your shop';
  const line =
    `${name}'s contact number on ScaleEzy was changed to ${masked(newPhone)}` +
    `${actor.name ? ` by ${actor.name}` : ''}. ` +
    'If this was not you, sign in and change it back, or tell ScaleEzy straight away.';

  const owners = await prisma.user.findMany({
    where: { clientId: actor.clientId, status: 'ACTIVE', roles: { some: { role: { name: 'SUPER_ADMIN' } } } },
    select: { email: true, name: true }
  });
  for (const o of owners) {
    await sendMail({
      to: o.email,
      subject: `${name}: contact number changed`,
      text: `Hello ${o.name},\n\n${line}\n\nScaleEzy`,
      kind: 'shop-number-changed'
    }).catch(e => console.warn('[shop-number] email not sent:', (e as Error)?.message));
  }

  if (oldPhone && whatsappConfigured()) {
    await whatsappClient.send({
      from: 'scaleezy',
      to: digitsOf(oldPhone),
      text: line,
      kind: 'TEST',
      reference: 'NUMBER_CHANGED',
      idempotencyKey: `SHOP:NUMBER:${actor.clientId}:${Date.now()}`
    }).catch(e => console.warn('[shop-number] old number not told:', (e as Error)?.message));
  }
}
