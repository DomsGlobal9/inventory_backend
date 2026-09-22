/**
 * Where a campaign's {link} goes, checked when the campaign is saved.
 *
 * Two choices today:
 *   - WHATSAPP: a chat with the shop, with a first line already typed ("Hi, I saw your offer...").
 *     Works for every shop, website or not.
 *   - EXTERNAL: a web page the owner types, usually the product on the shop's own website.
 * PRODUCT / SHOP / CAMPAIGN (pages of the ScaleEzy online shop) come with the online shop.
 *
 * The address itself is checked by the links module (https only, nothing internal, no other short
 * links). Only people who may send campaigns get here, and that is owners and admins.
 */
import { prisma } from '../../lib/prisma';
import { normalisePhone } from '../../lib/phone';
import { badRequest } from '../../utils/httpError';
import { links, LinkRuleError } from '../links';

export type LinkType = 'WHATSAPP' | 'EXTERNAL';

export interface CampaignLink {
  type: LinkType;
  /** The address the short link opens. */
  target: string;
  /** How long each customer's link works. */
  days: number;
  /** For WHATSAPP: the number and first line, kept so the editor can show them again. */
  phone?: string;
  chatText?: string;
}

const DEFAULT_DAYS = 90;
const MAX_CHAT_TEXT = 200;

/** The shop's own phone from Settings, for "Chat with the shop" -- the WhatsApp Service never gives the app its full number. */
export async function shopPhone(clientId: string): Promise<string | null> {
  const s = await prisma.clientSettings.findUnique({ where: { clientId }, select: { businessPhone: true } });
  const p = normalisePhone(s?.businessPhone ?? '');
  return p.ok ? p.value : null;
}

export async function checkCampaignLink(clientId: string, raw: unknown, ctx: { campaignName: string }): Promise<CampaignLink | null> {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== 'object' || Array.isArray(raw)) throw badRequest('Choose where the link goes.');
  const r = raw as Record<string, unknown>;
  if (!links.available()) throw badRequest('Links in campaigns are not switched on for ScaleEzy yet. Take {link} out, or send without a link for now.');

  const days = r.days === undefined || r.days === null || r.days === '' ? DEFAULT_DAYS : Number(r.days);
  if (!Number.isInteger(days) || days < 7 || days > 365) throw badRequest('The link can work for 7 to 365 days.');

  try {
    if (r.type === 'WHATSAPP') {
      const typed = typeof r.phone === 'string' && r.phone.trim() ? r.phone : await shopPhone(clientId);
      if (!typed) throw badRequest("Type the shop's WhatsApp number for customers to chat with, or save it as the shop's phone in Settings.");
      const phone = normalisePhone(typed);
      if (!phone.ok) throw badRequest(phone.reason.replace("the customer's", "the shop's"));
      const chatText = (typeof r.chatText === 'string' && r.chatText.trim() ? r.chatText.trim() : `Hi, I saw your offer: ${ctx.campaignName}`).slice(0, MAX_CHAT_TEXT);
      const target = links.checkLinkTarget(`https://wa.me/${phone.value.replace(/^\+/, '')}?text=${encodeURIComponent(chatText)}`, 'WHATSAPP');
      return { type: 'WHATSAPP', target, days, phone: phone.value, chatText };
    }
    if (r.type === 'EXTERNAL') {
      return { type: 'EXTERNAL', target: links.checkLinkTarget(r.url ?? r.target, 'EXTERNAL'), days };
    }
  } catch (e) {
    if (e instanceof LinkRuleError) throw badRequest(e.message);
    throw e;
  }
  throw badRequest('Choose where the link goes: a chat with the shop, or a web page.');
}

/** The link as stored, read back safely (old or hand-edited rows). */
export function storedLink(raw: unknown): CampaignLink | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as CampaignLink;
  if ((r.type !== 'WHATSAPP' && r.type !== 'EXTERNAL') || typeof r.target !== 'string') return null;
  return r;
}

/** How long the short address will be, for the 1,024-letter check (go.scaleezy.com/xxxxxxx). */
export const shortLinkLength = () => (links.available() ? links.shortUrl('xxxxxxx').length : 31);
