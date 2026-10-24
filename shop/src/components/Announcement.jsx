import React from 'react';
import { Link } from 'react-router-dom';
import { linkPath } from './Banners';

/**
 * The shop's one line across the top of every page ("Diwali sale: 10% off till 5 Nov"). The server sends
 * it only while it is switched on and inside its days, so this only shows what it is given. A tap goes
 * wherever the shop pointed it, the same way a banner does.
 */
export default function Announcement({ slug, announcement }) {
  if (!announcement?.text) return null;
  const to = linkPath(slug, announcement.link);
  return to
    ? <Link className="announce" to={to}>{announcement.text}<span aria-hidden="true"> ›</span></Link>
    : <div className="announce">{announcement.text}</div>;
}
