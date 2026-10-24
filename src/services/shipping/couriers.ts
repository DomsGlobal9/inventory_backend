import { prisma } from '../../lib/prisma';
import { badRequest, notFound, conflict } from '../../utils/httpError';

/**
 * THE SHOP'S COURIERS: Settings → Couriers, and the Courier list in Create Dispatch.
 *
 * Only names and a tracking page. Nothing here talks to a courier's computers: the shop books the
 * parcel with DTDC as it always has, then writes down here who took it and the number on the slip.
 *
 * A removed courier is kept (active = false), so a parcel sent with it still shows its name and
 * still opens its tracking page. Adding the same name again brings it back.
 */

/**
 * Couriers most Indian shops use, offered as one-tap choices when adding one.
 *
 * Every link was opened on 24 Oct 2026. Only Blue Dart's page takes the number in the link itself
 * ({number}); the others open their tracking page and the app copies the number for pasting. A
 * link guessed at (Delhivery's /track/package/<n> answers 404) would send a customer to an error
 * page, which is worse than no link -- so a courier nobody checked has none, and the shop can add it.
 */
export const COMMON_COURIERS: { name: string; trackingLink: string | null; needsNumber: boolean }[] = [
  { name: 'DTDC', trackingLink: 'https://www.dtdc.com/track-your-shipment/', needsNumber: true },
  { name: 'Delhivery', trackingLink: 'https://www.delhivery.com/tracking', needsNumber: true },
  { name: 'Blue Dart', trackingLink: 'https://www.bluedart.com/web/guest/trackdartresult?trackFor=0&trackNo={number}', needsNumber: true },
  { name: 'India Post', trackingLink: 'https://www.indiapost.gov.in/', needsNumber: true },
  { name: 'Xpressbees', trackingLink: 'https://www.xpressbees.com/shipment/tracking', needsNumber: true },
  { name: 'Own delivery', trackingLink: null, needsNumber: false }
];

const NAME_MAX = 40;
const LINK_MAX = 300;

const keyOf = (name: string) => name.toLowerCase();

function cleanName(raw: unknown): string {
  const name = String(raw ?? '').replace(/\s+/g, ' ').trim();
  if (!name) throw badRequest('Give the courier a name, for example DTDC.');
  if (name.length > NAME_MAX) throw badRequest(`Keep the courier's name under ${NAME_MAX} letters.`);
  return name;
}

/** An https address, or nothing. `{number}` may appear in it. */
function cleanLink(raw: unknown): string | null {
  if (raw === undefined || raw === null) return null;
  const link = String(raw).trim();
  if (!link) return null;
  if (link.length > LINK_MAX) throw badRequest('That tracking link is too long.');
  let url: URL;
  try {
    url = new URL(link.replace('{number}', 'X'));
  } catch {
    throw badRequest('The tracking link should be a web address starting with https://');
  }
  if (url.protocol !== 'https:') throw badRequest('The tracking link should be a web address starting with https://');
  return link;
}

/**
 * The link that opens one parcel's tracking. `copies` is true when the page does not take the
 * number in its address, so the screen copies it for pasting.
 */
export function trackingFor(link: string | null | undefined, number: string | null | undefined): { url: string; copies: boolean } | null {
  if (!link) return null;
  if (link.includes('{number}')) {
    // Nothing to put in the link yet: no button, rather than a tracking page asking for a number.
    if (!number) return null;
    return { url: link.split('{number}').join(encodeURIComponent(number)), copies: false };
  }
  return { url: link, copies: !!number };
}

const view = (c: any) => ({
  id: c.id,
  name: c.name,
  trackingLink: c.trackingLink,
  needsNumber: c.needsNumber,
  isDefault: c.isDefault
});

export async function list(clientId: string) {
  const rows = await prisma.shopCourier.findMany({
    where: { clientId, active: true },
    orderBy: [{ isDefault: 'desc' }, { name: 'asc' }]
  });
  const have = new Set(rows.map(r => r.key));
  return {
    couriers: rows.map(view),
    // The common ones the shop has not added yet, for the one-tap chips.
    suggestions: COMMON_COURIERS.filter(c => !have.has(keyOf(c.name)))
  };
}

/** One of this shop's couriers that is still in use, or a clear refusal. */
export async function usable(clientId: string, courierId: unknown) {
  const id = String(courierId ?? '');
  const c = id ? await prisma.shopCourier.findFirst({ where: { id, clientId, active: true } }) : null;
  if (!c) throw notFound('That courier is not in your list any more. Choose another or add it again.');
  return c;
}

export async function add(clientId: string, body: any) {
  const name = cleanName(body?.name);
  const trackingLink = cleanLink(body?.trackingLink);
  const needsNumber = body?.needsNumber === undefined ? true : !!body.needsNumber;
  const key = keyOf(name);

  const existing = await prisma.shopCourier.findUnique({ where: { clientId_key: { clientId, key } } });
  if (existing?.active) throw conflict(`${existing.name} is already in your couriers.`);

  return prisma.$transaction(async (tx) => {
    // The first courier is the default: the one most shops use for nearly everything.
    const any = await tx.shopCourier.count({ where: { clientId, active: true } });
    const isDefault = body?.isDefault === true || any === 0;
    if (isDefault) await tx.shopCourier.updateMany({ where: { clientId, isDefault: true }, data: { isDefault: false } });
    const row = existing
      ? await tx.shopCourier.update({ where: { id: existing.id }, data: { name, trackingLink, needsNumber, isDefault, active: true } })
      : await tx.shopCourier.create({ data: { clientId, name, key, trackingLink, needsNumber, isDefault } });
    return view(row);
  });
}

export async function edit(clientId: string, id: string, body: any) {
  const c = await usable(clientId, id);
  const data: any = {};
  if (body?.name !== undefined) {
    data.name = cleanName(body.name);
    data.key = keyOf(data.name);
    if (data.key !== c.key) {
      const clash = await prisma.shopCourier.findUnique({ where: { clientId_key: { clientId, key: data.key } } });
      if (clash?.active) throw conflict(`${clash.name} is already in your couriers.`);
      // A removed courier of that name is in the way of the unique name: it gives its name up.
      if (clash) await prisma.shopCourier.update({ where: { id: clash.id }, data: { key: `${clash.key}#${clash.id}` } });
    }
  }
  if (body?.trackingLink !== undefined) data.trackingLink = cleanLink(body.trackingLink);
  if (body?.needsNumber !== undefined) data.needsNumber = !!body.needsNumber;
  return prisma.$transaction(async (tx) => {
    if (body?.isDefault === true) {
      await tx.shopCourier.updateMany({ where: { clientId, isDefault: true, NOT: { id: c.id } }, data: { isDefault: false } });
      data.isDefault = true;
    } else if (body?.isDefault === false) {
      data.isDefault = false;
    }
    return view(await tx.shopCourier.update({ where: { id: c.id }, data }));
  });
}

export async function remove(clientId: string, id: string) {
  const c = await usable(clientId, id);
  await prisma.shopCourier.update({ where: { id: c.id }, data: { active: false, isDefault: false } });
  return { removed: true };
}
