/**
 * A campaign's words, made personal for one customer.
 *
 * {name} is the first name ("Lakshmi", not "Lakshmi Devi Rao"), {shop} the shop's name, {points}
 * and {points_value} what they hold now, {link} their own short link. The STOP line is always added
 * and cannot be removed: it is what keeps a shop's number from being reported, and the customer's
 * right under the DPDP Act.
 */
import { badRequest } from '../../utils/httpError';

export const MAX_TEXT = 1000;
export const PLACEHOLDERS = ['{name}', '{shop}', '{points}', '{points_value}', '{link}'] as const;
/** WhatsApp's limit for the words under a picture (the WhatsApp Service refuses longer). */
export const MAX_CAPTION = 1024;

export function checkText(raw: unknown): string {
  if (typeof raw !== 'string' || !raw.trim()) throw badRequest('Write the message.');
  const text = raw.replace(/\r\n/g, '\n').trim();
  if (text.length > MAX_TEXT) throw badRequest(`Keep the message under ${MAX_TEXT} letters. It is ${text.length}.`);
  const unknown = (text.match(/\{[^{}\s]{1,30}\}/g) ?? []).filter(p => !(PLACEHOLDERS as readonly string[]).includes(p));
  if (unknown.length) {
    throw badRequest(`${unknown[0]} is not something ScaleEzy can fill in. Use ${PLACEHOLDERS.join(', ')}.`);
  }
  return text;
}

/**
 * {link} and the link choice go together: a link chosen but not placed would never be seen, and
 * {link} with nowhere to go would be sent as the word "{link}".
 */
export function checkLinkPlacement(text: string, hasLink: boolean) {
  const count = (text.match(/\{link\}/g) ?? []).length;
  if (hasLink && count === 0) throw badRequest('Put {link} in the message where the link should go. The "Link" button adds it.');
  if (!hasLink && count > 0) throw badRequest('Choose where the link goes, or take {link} out of the message.');
  if (count > 1) throw badRequest('Use {link} once. One link per message keeps it from looking like spam.');
}

export function checkName(raw: unknown): string {
  if (typeof raw !== 'string' || !raw.trim()) throw badRequest('Give the campaign a name, so you can find it again.');
  const name = raw.trim();
  if (name.length > 80) throw badRequest('Keep the name under 80 letters.');
  return name;
}

export const firstName = (full: string | null | undefined) => {
  const first = (full ?? '').trim().split(/\s+/)[0];
  return first || 'there';
};

export const stopLine = (shop: string) => `_${shop}. Reply STOP to stop these messages._`;

export function render(text: string, v: { name: string | null; shop: string; points: number; pointsValue: string; link?: string | null }) {
  const body = text
    .replace(/\{name\}/g, firstName(v.name))
    .replace(/\{shop\}/g, v.shop)
    .replace(/\{points\}/g, Math.max(0, v.points).toLocaleString('en-IN'))
    .replace(/\{points_value\}/g, v.pointsValue)
    .replace(/\{link\}/g, v.link ?? '');
  return `${body}\n\n${stopLine(v.shop)}`;
}

/**
 * The longest the message can come out, for the 1,024-letter limit under a picture: a long first
 * name, a big points balance, the full short address. Checked when saved and again at Start, so a
 * campaign never reaches customers only to be refused one by one.
 */
export function longestRendering(text: string, shop: string, linkLength: number) {
  return render(text, { name: 'x'.repeat(20), shop, points: 9_999_999, pointsValue: '₹99,99,999', link: 'x'.repeat(linkLength) }).length;
}

export function checkCaption(text: string, shop: string, linkLength: number) {
  const longest = longestRendering(text, shop, linkLength);
  if (longest > MAX_CAPTION) {
    throw badRequest(`With a picture, WhatsApp allows ${MAX_CAPTION.toLocaleString('en-IN')} letters under it, and this message can come to ${longest.toLocaleString('en-IN')} with names, points, the link and the STOP line. Shorten it by ${(longest - MAX_CAPTION).toLocaleString('en-IN')}.`);
  }
}
