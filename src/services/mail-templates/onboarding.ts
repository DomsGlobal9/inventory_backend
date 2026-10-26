/**
 * The two messages a new shop owner gets, and the login message everyone else gets.
 *
 *   loginEmail     the credentials. Short, private, one job: get them signed in. Sent to the owner
 *                  at onboarding and to every staff member when they are added.
 *   welcomeEmail   the owner's welcome. No password in it on purpose -- it is the long, friendly,
 *                  forwardable one, and a password does not belong in a mail people forward. Sent
 *                  to the OWNER ONLY (the user's rule, 26 Oct).
 *
 * Pure: in goes who and where, out come subject, HTML and text. mail.service decides when to send.
 * No phone number anywhere: help is the Help Center and the in-app support tickets, which the
 * ScaleEzy team answers.
 */
import { BRAND, esc, button, label, shell } from './brand';

export interface Rendered { subject: string; html: string; text: string }

/** Role names as a shop says them. A custom role keeps the name the shop gave it. */
export function friendlyRole(role?: string | null): string | null {
  if (!role) return null;
  const known: Record<string, string> = {
    SUPER_ADMIN: 'Owner', ADMIN: 'Admin', INVENTORY_MANAGER: 'Inventory manager',
    WAREHOUSE: 'Warehouse', SALES: 'Sales', RETURNS_ONLY: 'Returns'
  };
  return known[role] ?? role;
}

const firstName = (name: string) => String(name || '').trim().split(/\s+/)[0] || 'there';

export function loginEmail(input: {
  base: string;
  recipientName: string;
  email: string;
  password: string;
  shopName?: string | null;
  roleLabel?: string | null;
  audience?: 'shop' | 'platform';
}): Rendered {
  const platform = input.audience === 'platform';
  const loginUrl = platform ? `${input.base}/platformconsole/login` : `${input.base}/login`;
  const role = platform ? 'Platform admin' : friendlyRole(input.roleLabel);
  const place = platform ? 'the ScaleEzy Platform Console' : (input.shopName ? input.shopName : 'your shop on ScaleEzy');
  const subject = platform
    ? 'Your ScaleEzy Platform Console login'
    : `Your ScaleEzy login${input.shopName ? ` for ${input.shopName}` : ''}`;

  const body = `
${label('Your login')}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${BRAND.card};border:1px solid ${BRAND.cardLine};border-radius:10px">
  <tr><td style="padding:14px 16px">
    <div style="font-size:12px;color:${BRAND.muted}">Email</div>
    <div style="font-size:15px;color:${BRAND.ink};margin-bottom:10px;word-break:break-all">${esc(input.email)}</div>
    <div style="font-size:12px;color:${BRAND.muted}">Temporary password</div>
    <div style="font-size:17px;color:${BRAND.ink};font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;letter-spacing:.03em;word-break:break-all">${esc(input.password)}</div>
  </td></tr>
</table>
${button(loginUrl, platform ? 'Sign in to the Console' : 'Sign in to ScaleEzy')}
<div style="font-size:13px;color:${BRAND.muted};text-align:center;margin-bottom:12px">${platform
    ? 'Keep it safe; another platform admin can reset it if needed.'
    : 'After signing in, you can change it under Settings, General.'}</div>`;

  const html = shell({
    base: input.base,
    preheader: `Your email and temporary password for ${platform ? 'the Platform Console' : place}.`,
    title: `Your login, ${firstName(input.recipientName)}`,
    subtitle: [place, role].filter(Boolean).join(' · '),
    body,
    footer: 'Keep this email private: it holds your password. ScaleEzy will never ask you for it by email, phone or WhatsApp.'
  });

  const text = [
    `Hi ${input.recipientName},`,
    '',
    `Here is your login for ${place}${role ? ` (${role})` : ''}.`,
    '',
    `Email: ${input.email}`,
    `Temporary password: ${input.password}`,
    '',
    `Sign in: ${loginUrl}`,
    '',
    'Keep this email private: it holds your password. ScaleEzy will never ask you for it.'
  ].join('\n');

  return { subject, html, text };
}

export function welcomeEmail(input: {
  base: string;
  recipientName: string;
  email: string;
  shopName: string;
}): Rendered {
  const b = input.base;
  const shop = input.shopName?.trim() || 'Your shop';
  const steps: { title: string; line: string; href: string }[] = [
    { title: 'Add your products', line: 'One by one, with photos and sizes, or import your whole list from Excel.', href: `${b}/products` },
    { title: 'Bring in your stock', line: 'Enter what you have today, or receive it from a purchase order.', href: `${b}/inventory` },
    { title: 'Bill at the counter', line: 'Connect the POS till. Every bill updates your stock by itself.', href: `${b}/settings?section=POS` },
    { title: 'Sell online', line: 'Open your own online shop, or connect your Shopify store. Stock stays in step.', href: `${b}/settings?section=ONLINE_SHOP` },
    { title: 'Invite your team', line: 'Add each person with only what they need: billing, stock or everything.', href: `${b}/settings?section=USERS` }
  ];
  const highlights = [
    { title: 'Try-on', line: 'customers see it on themselves' },
    { title: 'WhatsApp', line: 'day book and offers' },
    { title: 'Shelves', line: 'find any piece in seconds' }
  ];

  const stepRows = steps.map((s, i) => `
  <tr>
    <td valign="top" width="36" style="padding:10px 0;${i < steps.length - 1 ? `border-bottom:1px solid ${BRAND.wash};` : ''}">
      <div style="width:26px;height:26px;line-height:26px;border-radius:13px;background:${BRAND.deep};color:${BRAND.lime};text-align:center;font-size:13px;font-weight:600">${i + 1}</div>
    </td>
    <td valign="top" style="padding:10px 0;${i < steps.length - 1 ? `border-bottom:1px solid ${BRAND.wash};` : ''}">
      <a href="${esc(s.href)}" target="_blank" style="font-size:15px;font-weight:600;color:${BRAND.deep};text-decoration:none">${esc(s.title)} &rsaquo;</a>
      <div style="font-size:13px;line-height:1.5;color:${BRAND.muted}">${esc(s.line)}</div>
    </td>
  </tr>`).join('');

  const highlightCells = highlights.map(h => `
    <td width="33%" valign="top" style="padding:4px">
      <div style="background:#f7faf3;border-radius:8px;padding:10px 6px;text-align:center">
        <div style="font-size:13px;font-weight:600;color:${BRAND.deep}">${esc(h.title)}</div>
        <div style="font-size:11px;line-height:1.4;color:${BRAND.muted}">${esc(h.line)}</div>
      </div>
    </td>`).join('');

  const body = `
<p style="margin:0 0 18px">Thank you for choosing ScaleEzy, ${esc(firstName(input.recipientName))}. ${esc(shop)} is set up and ready: your stock, your counter and your online sales, in one place.</p>
${label('Your first week')}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${stepRows}
</table>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:16px"><tr>${highlightCells}
</tr></table>
${button(`${b}/dashboard`, 'Open ScaleEzy')}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:14px 0 8px">
  <tr><td bgcolor="${BRAND.deep}" style="background:${BRAND.deep};border-radius:10px;padding:14px 16px;font-size:13px;line-height:1.6;color:#e6f2dc">
    <span style="color:${BRAND.lime};font-weight:600">Need a hand?</span>
    Read the <a href="${esc(`${b}/help`)}" target="_blank" style="color:#ffffff">Help Center</a> in English, हिन्दी, తెలుగు, தமிழ் or ಕನ್ನಡ,
    or <a href="${esc(`${b}/settings?section=SUPPORT`)}" target="_blank" style="color:#ffffff">contact ScaleEzy support</a>
    from inside the app (Settings, Help and support). Our team answers there.
  </td></tr>
</table>`;

  const html = shell({
    base: b,
    preheader: `${shop} is ready on ScaleEzy. Five steps for your first week, and where to get help.`,
    title: `Welcome aboard, ${firstName(input.recipientName)}`,
    subtitle: `${shop} is set up and ready. Your login came in a separate email.`,
    body,
    footer: `You are getting this because ${esc(shop)} was set up on ScaleEzy with ${esc(input.email)} as the owner. Your password is in the separate login email, never in this one.`
  });

  const text = [
    `Welcome aboard, ${firstName(input.recipientName)}.`,
    '',
    `Thank you for choosing ScaleEzy. ${shop} is set up and ready. Your login came in a separate email.`,
    '',
    'YOUR FIRST WEEK',
    ...steps.map((s, i) => `${i + 1}. ${s.title}: ${s.line}\n   ${s.href}`),
    '',
    `Open ScaleEzy: ${b}/dashboard`,
    '',
    `Need a hand? Help Center: ${b}/help`,
    `Contact ScaleEzy support from inside the app: Settings, Help and support (${b}/settings?section=SUPPORT).`
  ].join('\n');

  return { subject: `Welcome to ScaleEzy, ${shop}`, html, text };
}
