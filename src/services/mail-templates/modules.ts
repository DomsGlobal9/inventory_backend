import { BRAND, button, esc, label, shell } from './brand';

/**
 * Emails about a client's ScaleEzy modules (26 Nov 2026, one-switch onboarding; the owner: "whenever we switch on or
 * whatever, the mail will go, best user friendly"). Owner only. One email per change, saying what is now on, how to
 * open each, the one thing to do first, and what was switched off (its data is kept).
 *   - POS sends its own welcome link (to set the POS password): this mail says to look for it, and never repeats it.
 *   - CRM signs in with the same ScaleEzy login: this mail gives the address.
 */
type Rendered = { subject: string; html: string; text: string };
export type ModuleName = 'inventory' | 'pos' | 'crm' | 'boutique' | 'logistics';

const firstName = (n: string) => (n || '').trim().split(/\s+/)[0] || 'there';
export const appUrls = (base: string) => ({
  inventory: `${base}/dashboard`,
  pos: (process.env.POS_APP_URL || 'https://pos.scaleezy.com').replace(/\/+$/, ''),
  // CRM's own address (CRM, 26 Nov: the root; it shows its sign-in, the same ScaleEzy email and password).
  crm: (process.env.CRM_APP_URL || 'https://scaleezy-crm-frontend.vercel.app').replace(/\/+$/, '') || null
});

/** What each module is, how to open it, and the first thing to do, in the owner's words. */
export function moduleSteps(base: string, modules: ModuleName[], opts: { boutiqueTenant?: string | null } = {}) {
  const url = appUrls(base);
  const out: { module: ModuleName; title: string; line: string; href: string | null }[] = [];
  if (modules.includes('inventory')) out.push({ module: 'inventory', title: 'ScaleEzy Inventory', line: 'Your products, stock, orders and online shop. Start by adding your products, or import them from Excel.', href: url.inventory });
  if (modules.includes('pos')) out.push({ module: 'pos', title: 'ScaleEzy POS (billing counter)', line: `Bill at your counter. POS emails you its own link to set your POS password; then sign in at ${url.pos.replace(/^https?:\/\//, '')}.`, href: url.pos });
  if (modules.includes('crm')) out.push({ module: 'crm', title: 'ScaleEzy CRM', line: url.crm ? `Your customers, follow-ups, wishes and offers. Open it at ${url.crm.replace(/^https?:\/\//, '')} and sign in with the same ScaleEzy email and password.` : 'Your customers, follow-ups, wishes and offers. Sign in with the same ScaleEzy email and password.', href: url.crm });
  if (modules.includes('boutique')) out.push({ module: 'boutique', title: 'Your Boutique app', line: `Linked to ScaleEzy${opts.boutiqueTenant ? ` (account ${opts.boutiqueTenant})` : ''}: its items, stock and orders now run on ScaleEzy.`, href: null });
  if (modules.includes('logistics')) out.push({ module: 'logistics', title: 'ScaleEzy Logistics', line: 'Pack an order in Inventory and Logistics books the courier; tracking shows on the order.', href: modules.includes('inventory') ? `${base}/sales-orders` : null });
  return out;
}

const NAME: Record<ModuleName, string> = { inventory: 'ScaleEzy Inventory', pos: 'ScaleEzy POS', crm: 'ScaleEzy CRM', boutique: 'the Boutique app link', logistics: 'ScaleEzy Logistics' };
/** What switching off keeps, in each module's own words (CRM's, 26 Nov). */
const KEPT: Partial<Record<ModuleName, string>> = { crm: 'Your customers stay in CRM; they are back as they were when it is switched on again.', pos: 'Your bills, staff and settings stay in POS; it opens as it was when switched on again.' };

function stepTable(steps: ReturnType<typeof moduleSteps>) {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${steps.map((s, i) => `
  <tr><td valign="top" style="padding:10px 0;${i < steps.length - 1 ? `border-bottom:1px solid ${BRAND.wash};` : ''}">
    ${s.href ? `<a href="${esc(s.href)}" target="_blank" style="font-size:15px;font-weight:600;color:${BRAND.deep};text-decoration:none">${esc(s.title)} &rsaquo;</a>` : `<span style="font-size:15px;font-weight:600;color:${BRAND.deep}">${esc(s.title)}</span>`}
    <div style="font-size:13px;line-height:1.5;color:${BRAND.muted}">${esc(s.line)}</div>
  </td></tr>`).join('')}
</table>`;
}

/** "Your WhatsApp number" step: the shop links its own number once; every app sends from it. */
export function whatsappStep(base: string, modules: ModuleName[]) {
  const where = modules.includes('pos') ? 'POS → Settings → WhatsApp' : modules.includes('inventory') ? 'Inventory → Settings → WhatsApp' : null;
  return where ? `Link your shop's WhatsApp number once in ${where}: scan the QR with the shop's phone. Bills, offers and follow-ups then go from your own number.` : null;
}

/** A change after the client was made: what is now on (how to open it), what is off (data kept), and everything now on. */
export function modulesChangedEmail(input: {
  base: string; recipientName: string; email: string; shopName: string;
  on: ModuleName[]; off: ModuleName[]; now: ModuleName[]; boutiqueTenant?: string | null;
}): Rendered {
  const shop = input.shopName?.trim() || 'Your shop';
  const added = moduleSteps(input.base, input.on, { boutiqueTenant: input.boutiqueTenant });
  const wa = input.on.some(m => m === 'pos' || m === 'crm') ? whatsappStep(input.base, input.now) : null;
  const offNames = input.off.map(m => NAME[m]);
  const subject = input.on.length && !input.off.length
    ? `${added.map(a => a.title.replace(/ \(.*\)$/, '')).join(' and ')} ${added.length === 1 ? 'is' : 'are'} now on for ${shop}`
    : !input.on.length ? `${offNames.join(' and ')} switched off for ${shop}` : `Your ScaleEzy apps changed for ${shop}`;

  const body = `
${added.length ? `<p style="margin:0 0 14px">Good news, ${esc(firstName(input.recipientName))}: ${esc(shop)} now has ${esc(added.map(a => a.title).join(', '))}. Everything is connected for you; there is nothing to set up between the apps.</p>
${label('What is new')}
${stepTable(added)}` : ''}
${wa ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:14px 0"><tr><td style="background:#f7faf3;border-radius:10px;padding:12px 14px;font-size:13px;line-height:1.6;color:${BRAND.ink}"><b>One thing to do:</b> ${esc(wa)}</td></tr></table>` : ''}
${input.off.length ? `${label('Switched off')}<p style="margin:0 0 14px;font-size:14px;line-height:1.6">${esc(offNames.join(', '))} ${input.off.length === 1 ? 'is' : 'are'} now off for ${esc(shop)}. ${esc(input.off.map(m => KEPT[m]).filter(Boolean).join(' ') || 'Nothing is deleted: everything is kept, and ScaleEzy can switch it back on at any time, just as it was.')}</p>` : ''}
${input.now.length ? `${label('Your ScaleEzy apps now')}<p style="margin:0 0 10px;font-size:14px">${esc(moduleSteps(input.base, input.now, { boutiqueTenant: input.boutiqueTenant }).map(s => s.title).join(' · '))}</p>` : ''}
${added[0]?.href ? button(added[0].href, `Open ${added[0].title.replace(/ \(.*\)$/, '')}`) : ''}`;

  const html = shell({
    base: input.base,
    preheader: subject,
    title: added.length ? `${added.map(a => a.title.replace(/^ScaleEzy /, '').replace(/ \(.*\)$/, '')).join(' and ')} ${added.length === 1 ? 'is' : 'are'} on` : 'A change to your apps',
    subtitle: shop,
    body,
    footer: `You are getting this because you are the owner of ${esc(shop)} on ScaleEzy (${esc(input.email)}). Questions? Reply to ScaleEzy support from inside any app.`
  });
  const text = [
    `Hi ${firstName(input.recipientName)},`, '',
    ...(added.length ? [`${shop} now has: ${added.map(a => a.title).join(', ')}. Everything is connected for you.`, '', ...added.map(a => `- ${a.title}: ${a.line}${a.href ? `\n  ${a.href}` : ''}`), ''] : []),
    ...(wa ? [`One thing to do: ${wa}`, ''] : []),
    ...(input.off.length ? [`Switched off: ${offNames.join(', ')}. Nothing is deleted; ScaleEzy can switch it back on at any time.`, ''] : []),
    ...(input.now.length ? [`Your ScaleEzy apps now: ${moduleSteps(input.base, input.now).map(s => s.title).join(', ')}.`] : [])
  ].join('\n');
  return { subject, html, text };
}
