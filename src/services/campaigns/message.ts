/**
 * A campaign's words, made personal for one customer.
 *
 * {name} is the first name ("Lakshmi", not "Lakshmi Devi Rao"), {shop} the shop's name, {points}
 * and {points_value} what they hold now. The STOP line is always added and cannot be removed: it
 * is what keeps a shop's number from being reported, and the customer's right under the DPDP Act.
 */
import { badRequest } from '../../utils/httpError';

export const MAX_TEXT = 1000;
export const PLACEHOLDERS = ['{name}', '{shop}', '{points}', '{points_value}'] as const;

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

export function render(text: string, v: { name: string | null; shop: string; points: number; pointsValue: string }) {
  const body = text
    .replace(/\{name\}/g, firstName(v.name))
    .replace(/\{shop\}/g, v.shop)
    .replace(/\{points\}/g, Math.max(0, v.points).toLocaleString('en-IN'))
    .replace(/\{points_value\}/g, v.pointsValue);
  return `${body}\n\n_${v.shop}. Reply STOP to stop these messages._`;
}
