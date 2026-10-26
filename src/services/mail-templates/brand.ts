/**
 * The ScaleEzy look for email: deep green header, lime button, one white card.
 *
 * Email is not the web. Gmail strips <style> blocks, Outlook ignores flexbox and most of CSS, and
 * many apps hide images until asked -- so everything here is tables and inline styles, the logo has
 * a text twin that shows when images are off, and every message has a plain-text half that stands
 * on its own. Widths top out at 560px and collapse to the screen on a phone.
 */

export const BRAND = {
  deep: '#164B1E',
  lime: '#A6D92B',
  ink: '#0B2410',
  paleLime: '#cfe3c4',
  wash: '#eef2ea',
  card: '#f4f8ee',
  cardLine: '#dbe8c8',
  muted: '#5f6b5a',
  faint: '#8a9484',
  font: "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif"
};

/** Anything a person typed (names, shop names) is escaped before it goes into markup. */
export function esc(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** The big lime button. A table, because Outlook ignores padding on a bare <a>. */
export function button(href: string, label: string): string {
  return `
<table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center" style="margin:20px auto 8px">
  <tr><td align="center" bgcolor="${BRAND.lime}" style="border-radius:8px">
    <a href="${esc(href)}" target="_blank" style="display:inline-block;padding:13px 30px;font-family:${BRAND.font};font-size:15px;font-weight:600;color:${BRAND.ink};text-decoration:none;border-radius:8px">${esc(label)}</a>
  </td></tr>
</table>`;
}

/** A small uppercase label above a section. */
export function label(text: string): string {
  return `<div style="font-family:${BRAND.font};font-size:12px;letter-spacing:.06em;color:${BRAND.muted};text-transform:uppercase;margin:0 0 8px">${esc(text)}</div>`;
}

/**
 * The whole message: preheader (the grey line an inbox shows beside the subject), header with
 * logo, title and subtitle, the body, and a footer line.
 */
export function shell(input: {
  base: string;
  preheader: string;
  title: string;
  subtitle: string;
  body: string;
  footer: string;
}): string {
  const logo = `${input.base}/scaleezy-logo-dark.png`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light only"><title>${esc(input.title)}</title></head>
<body style="margin:0;padding:0;background:${BRAND.wash}">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:${BRAND.wash}">${esc(input.preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${BRAND.wash}" style="background:${BRAND.wash}">
  <tr><td align="center" style="padding:24px 12px">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;background:#ffffff;border-radius:14px;overflow:hidden;border:1px solid #d9e2d3">
      <tr><td bgcolor="${BRAND.deep}" style="background:${BRAND.deep};padding:24px 28px 22px">
        <img src="${esc(logo)}" width="132" alt="scaleezy" style="display:block;width:132px;max-width:132px;height:auto;border:0;font-family:${BRAND.font};font-size:22px;font-weight:700;color:${BRAND.lime}">
        <div style="font-family:${BRAND.font};font-size:24px;line-height:1.3;font-weight:600;color:#ffffff;margin-top:16px">${esc(input.title)}</div>
        <div style="font-family:${BRAND.font};font-size:14px;line-height:1.5;color:${BRAND.paleLime};margin-top:6px">${esc(input.subtitle)}</div>
      </td></tr>
      <tr><td style="padding:24px 28px 8px;font-family:${BRAND.font};font-size:15px;line-height:1.6;color:#1a1a1a">
        ${input.body}
      </td></tr>
      <tr><td style="padding:14px 28px 22px;border-top:1px solid ${BRAND.wash};font-family:${BRAND.font};font-size:12px;line-height:1.5;color:${BRAND.faint}">
        ${input.footer}
      </td></tr>
    </table>
    <div style="font-family:${BRAND.font};font-size:11px;color:${BRAND.faint};margin-top:12px">ScaleEzy · inventory, billing and selling for your shop</div>
  </td></tr>
</table>
</body></html>`;
}
