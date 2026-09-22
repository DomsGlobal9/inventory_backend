/**
 * Campaign templates: words, picture and link choice saved to start a campaign from again. Who it
 * goes to is not part of a template -- that is chosen fresh each time.
 *
 * Four starters come with every shop. Their words name the thing on offer in the message itself,
 * so the message still makes sense if the picture does not load on a customer's phone.
 */
import { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { badRequest, conflict, notFound } from '../../utils/httpError';
import { checkLinkPlacement, checkName, checkText } from './message';
import { checkCampaignLink, storedLink } from './link';
import { mediaView, ownMedia } from './media';

export const STARTERS = [
  {
    id: 'starter:festival',
    name: 'Festival offer',
    text: 'Hello {name}! 🎉 Our festival collection is here at {shop}: new silk and cotton sarees, with special prices this week.\n\nCome and see them before they go!'
  },
  {
    id: 'starter:new-arrivals',
    name: 'New arrivals',
    text: 'Hello {name}, new arrivals at {shop}! ✨ Fresh designs came in this week. Visit us to see them first.'
  },
  {
    id: 'starter:sale',
    name: 'Sale',
    text: 'Hello {name}! Our sale is on at {shop}: selected pieces at lower prices, only while stock lasts. 🛍️'
  },
  {
    id: 'starter:back-in-stock',
    name: 'Back in stock',
    text: 'Hello {name}, good news: a favourite is back in stock at {shop}. Visit us soon, it may not last long.'
  }
] as const;

const view = (t: { id: string; name: string; text: string; link: unknown; media?: { id: string; url: string; width: number; height: number; byteSize: number } | null; updatedAt?: Date }) => ({
  id: t.id, name: t.name, text: t.text, media: t.media ? mediaView(t.media) : null, link: storedLink(t.link), starter: t.id.startsWith('starter:'), updatedAt: t.updatedAt ?? null
});

const withMedia = { media: { select: { id: true, url: true, width: true, height: true, byteSize: true } } } as const;

export async function listTemplates(clientId: string) {
  const own = await prisma.campaignTemplate.findMany({ where: { clientId }, orderBy: { updatedAt: 'desc' }, include: withMedia, take: 100 });
  return [...own.map(view), ...STARTERS.map(s => view({ ...s, link: null, media: null }))];
}

/** Saved from the editor's words, or from a campaign (what it sent, if it was started). */
export async function saveTemplate(clientId: string, userId: string, input: Record<string, unknown>) {
  const name = checkName(input.name);
  let text: string;
  let mediaId: string | null;
  let link: unknown;
  if (typeof input.campaignId === 'string') {
    const c = await prisma.campaign.findFirst({ where: { id: input.campaignId, clientId } });
    if (!c) throw notFound('Campaign not found');
    const s = c.snapshot as any;
    text = s?.text ?? c.text;
    mediaId = s ? s.media?.id ?? null : c.mediaId;
    link = s ? s.link ?? null : c.link;
  } else {
    text = checkText(input.text);
    mediaId = (await ownMedia(clientId, input.mediaId))?.id ?? null;
    link = await checkCampaignLink(clientId, input.link, { campaignName: name });
  }
  checkLinkPlacement(text, !!storedLink(link));
  try {
    const t = await prisma.campaignTemplate.create({
      data: { clientId, name, text, mediaId, link: (link ?? Prisma.DbNull) as any, createdById: userId },
      include: withMedia
    });
    return view(t);
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') throw conflict(`You already have a template called "${name}". Choose another name.`);
    throw e;
  }
}

export async function deleteTemplate(clientId: string, id: string) {
  if (id.startsWith('starter:')) throw badRequest('The starter templates come with ScaleEzy and cannot be deleted.');
  const r = await prisma.campaignTemplate.deleteMany({ where: { id, clientId } });
  if (r.count === 0) throw notFound('Template not found');
  return { deleted: true };
}
