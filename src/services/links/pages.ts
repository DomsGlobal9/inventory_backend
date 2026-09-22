/**
 * The small pages a visitor sees when a link does not open anything. Plain HTML, no scripts, no
 * outside files, nothing that says why ScaleEzy switched a link off.
 */

export type PageKind = 'ENDED' | 'SHOP_OFF' | 'UNAVAILABLE' | 'TOO_MANY' | 'HOME';

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export const endedOn = (d: Date) =>
  d.toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Asia/Kolkata' });

export function page(kind: PageKind, opts: { shopName?: string | null; expiredAt?: Date } = {}): string {
  const shop = opts.shopName?.trim() ? escapeHtml(opts.shopName.trim()) : null;
  const [title, body] = (() => {
    switch (kind) {
      case 'ENDED':
        return ['This offer has ended', opts.expiredAt ? `It ended on ${escapeHtml(endedOn(opts.expiredAt))}.` : ''];
      case 'SHOP_OFF':
        return ['This promotion is no longer available', ''];
      case 'TOO_MANY':
        return ['Please wait a minute', 'Too many links were opened from here just now. Try again in a minute.'];
      case 'HOME':
        return ['ScaleEzy short links', 'Links on this address are sent by shops on ScaleEzy.'];
      default:
        return ['This link is not available', ''];
    }
  })();
  // The shop's name only where the shop itself is the reason (ended, or switched off by the shop).
  const from = shop && (kind === 'ENDED' || kind === 'SHOP_OFF') ? `<p class="shop">${shop}</p>` : '';
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${escapeHtml(title)}</title>
<style>
:root{color-scheme:light dark;--bg:#f6f7f9;--card:#fff;--ink:#1d2433;--muted:#5b6475}
@media (prefers-color-scheme:dark){:root{--bg:#12151c;--card:#1b2029;--ink:#eef1f6;--muted:#a3abba}}
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:var(--bg);color:var(--ink);font:16px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;padding:16px;box-sizing:border-box}
main{background:var(--card);border-radius:14px;padding:28px 24px;max-width:420px;width:100%;text-align:center;box-shadow:0 1px 3px rgba(0,0,0,.08)}
h1{font-size:1.25rem;margin:0 0 8px}p{margin:0;color:var(--muted)}.shop{margin-top:14px;font-weight:600;color:var(--ink)}
</style></head>
<body><main><h1>${escapeHtml(title)}</h1>${body ? `<p>${body}</p>` : ''}${from}</main></body></html>`;
}
