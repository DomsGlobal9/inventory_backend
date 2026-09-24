import { prisma } from '../../lib/prisma';
import { normalisePhone } from '../../lib/phone';
import { generateSequentialCode } from '../../utils/codeGenerator';
import { OnlineShopRuleError } from './rules';
import { whoIs } from './otp';

/**
 * The addresses a customer has saved, so a returning shopper picks instead of typing.
 *
 * WHO THIS IS, DECIDED PROPERLY. Every call here is made with the secret the browser was given
 * when it typed its code back -- never with a phone number from the request. That distinction is
 * the whole of the security of this file: a number is something a neighbour knows, and these are
 * people's home addresses. `isVerified(clientId, phone)` is deliberately NOT used here, though it
 * is right where it is used, for deciding whose order an order is.
 *
 * The addresses belong to the shop's real Customer row, the same one the till knows, so an address
 * saved online is there when they walk in. Which is only possible because the number was proved.
 */

/** A person has a few: their own, their mother's, the office. Not forty. */
const MOST = 8;
const PINCODE = /^[1-9][0-9]{5}$/;

const text = (raw: unknown, max: number) =>
  (typeof raw === 'string' ? raw.trim().replace(/\s+/g, ' ') : '').slice(0, max);

export type SavedAddress = {
  id: string;
  label: string | null;
  name: string;
  phone: string;
  line: string;
  pincode: string;
  isDefault: boolean;
};

const view = (a: any): SavedAddress => ({
  id: a.id,
  label: a.label ?? null,
  name: a.name,
  phone: a.phone,
  line: a.line,
  pincode: a.pincode,
  isDefault: a.isDefault
});

/**
 * Whose book this is.
 *
 * Returns the customer row only when one already exists; saving makes it, reading does not. A
 * shopper who proves a number and never saves anything should not appear in a shop's customer list.
 */
async function bookOwner(clientId: string, token: unknown) {
  const phone = await whoIs(clientId, token);
  if (!phone) {
    throw new OnlineShopRuleError('Confirm your number to see the addresses you have saved.');
  }
  const customer = await prisma.customer.findFirst({
    where: { clientId, phone, deletedAt: null },
    select: { id: true }
  });
  return { phone, customerId: customer?.id ?? null };
}

/** Everything this customer has saved, the default one first. */
export async function mine(clientId: string, token: unknown): Promise<{ addresses: SavedAddress[] }> {
  const { customerId } = await bookOwner(clientId, token);
  if (!customerId) return { addresses: [] };
  const rows = await prisma.customerAddress.findMany({
    where: { clientId, customerId, deletedAt: null },
    orderBy: [{ isDefault: 'desc' }, { updatedAt: 'desc' }]
  });
  return { addresses: rows.map(view) };
}

export type AddressInput = {
  id?: unknown;
  label?: unknown;
  name?: unknown;
  phone?: unknown;
  line?: unknown;
  pincode?: unknown;
  isDefault?: unknown;
};

/**
 * Save one, new or changed.
 *
 * The same rules the checkout applies to an address typed once, because this IS that address --
 * refusing it here and accepting it there would mean a saved address that cannot be ordered to.
 */
export async function save(clientId: string, token: unknown, input: AddressInput): Promise<SavedAddress> {
  const { phone: owner, customerId: existing } = await bookOwner(clientId, token);

  const name = text(input.name, 80);
  if (name.length < 2) throw new OnlineShopRuleError('Who is this address for?');

  // Whoever receives it, which is not always the person saving it: a gift goes to somebody else,
  // and it is THEIR number the delivery person rings.
  const reach = normalisePhone(text(input.phone, 20) || owner);
  if (!reach.ok) throw new OnlineShopRuleError('That phone number does not look right.');

  const line = typeof input.line === 'string' ? input.line.trim().slice(0, 500) : '';
  if (line.length < 10) {
    throw new OnlineShopRuleError('Write out the full address, with the house, the street and the area.');
  }

  const pincode = (typeof input.pincode === 'string' ? input.pincode : '').replace(/\D/g, '');
  if (!PINCODE.test(pincode)) throw new OnlineShopRuleError('That PIN code does not look right. It is six digits.');

  const label = text(input.label, 24) || null;
  const wantsDefault = input.isDefault === true;
  const id = typeof input.id === 'string' && input.id.trim() ? input.id.trim() : null;

  return prisma.$transaction(async (tx) => {
    /*
     * The customer row is made HERE, on the first save, rather than when a number is proved --
     * otherwise every shopper who taps "send me a code" and wanders off becomes a customer in
     * somebody's books. Proved, so this is the shop's real customer, exactly as an order does it.
     */
    let customerId = existing;
    if (!customerId) {
      customerId = (await tx.customer.create({
        data: {
          clientId,
          customerCode: await generateSequentialCode(clientId, 'CUS', 'CUSTOMER', tx as any),
          name, phone: owner, shippingAddress: `${line}\n${pincode}`,
          customerType: 'REGISTERED', status: 'ACTIVE'
        },
        select: { id: true }
      })).id;
    }

    let row;
    if (id) {
      // Scoped to this customer, so an id belonging to somebody else edits nothing.
      const held = await tx.customerAddress.findFirst({
        where: { id, clientId, customerId, deletedAt: null }, select: { id: true }
      });
      if (!held) throw new OnlineShopRuleError('That address could not be found.');
      row = await tx.customerAddress.update({
        where: { id: held.id },
        data: { label, name, phone: reach.value, line, pincode, isDefault: wantsDefault }
      });
    } else {
      const howMany = await tx.customerAddress.count({ where: { clientId, customerId, deletedAt: null } });
      if (howMany >= MOST) {
        throw new OnlineShopRuleError(`You can keep ${MOST} addresses. Remove one you no longer use.`);
      }
      row = await tx.customerAddress.create({
        data: {
          clientId, customerId, label, name, phone: reach.value, line, pincode,
          // The first one saved is the one offered first, without anybody having to say so.
          isDefault: wantsDefault || howMany === 0
        }
      });
    }

    // At most one default. Done after the write so the row just saved is the one that keeps it.
    if (row.isDefault) {
      await tx.customerAddress.updateMany({
        where: { clientId, customerId, deletedAt: null, id: { not: row.id } },
        data: { isDefault: false }
      });
    }

    return view(row);
  });
}

/**
 * Put one away.
 *
 * Marked rather than deleted: an order carries the address as TEXT, copied when it was placed, so
 * nothing that has already been sent is touched either way -- but a row that disappears from under
 * a half-finished checkout is a checkout that breaks in the customer's hands.
 */
export async function remove(clientId: string, token: unknown, rawId: unknown): Promise<{ removed: boolean }> {
  const { customerId } = await bookOwner(clientId, token);
  if (!customerId) return { removed: false };
  const id = typeof rawId === 'string' ? rawId.trim() : '';

  const held = await prisma.customerAddress.findFirst({
    where: { id, clientId, customerId, deletedAt: null },
    select: { id: true, isDefault: true }
  });
  if (!held) throw new OnlineShopRuleError('That address could not be found.');

  await prisma.customerAddress.update({ where: { id: held.id }, data: { deletedAt: new Date(), isDefault: false } });

  // Somebody has to be first. Removing the default promotes the most recently used.
  if (held.isDefault) {
    const next = await prisma.customerAddress.findFirst({
      where: { clientId, customerId, deletedAt: null },
      orderBy: { updatedAt: 'desc' }, select: { id: true }
    });
    if (next) await prisma.customerAddress.update({ where: { id: next.id }, data: { isDefault: true } });
  }
  return { removed: true };
}

/**
 * Remember the address an order was just sent to, unless it is already there.
 *
 * Called after a proved order. It is what makes the book fill itself: a customer who orders twice
 * never types their address a second time, and nobody had to tick anything.
 */
export async function rememberFromOrder(
  clientId: string, customerId: string, who: { name: string; phone: string; line: string; pincode: string }
): Promise<'saved' | 'already' | 'skipped'> {
  try {
    const line = who.line.trim();
    if (line.length < 10 || !PINCODE.test(who.pincode)) return 'skipped';

    const same = await prisma.customerAddress.findFirst({
      where: { clientId, customerId, pincode: who.pincode, line, deletedAt: null },
      select: { id: true }
    });
    if (same) return 'already';

    const howMany = await prisma.customerAddress.count({ where: { clientId, customerId, deletedAt: null } });
    // Quietly stops at the limit rather than refusing the order that prompted it.
    if (howMany >= MOST) return 'skipped';

    await prisma.customerAddress.create({
      data: {
        clientId, customerId, label: null,
        name: who.name, phone: who.phone, line, pincode: who.pincode,
        isDefault: howMany === 0
      }
    });
    return 'saved';
  } catch (e) {
    // The order stands whatever happens here.
    console.warn('[online-shop] could not remember an address:', (e as Error)?.message);
    return 'skipped';
  }
}
