import crypto from 'crypto';
import { prisma } from '../../lib/prisma';
import { supabase } from '../../lib/supabase';
import { prepareIcon, ICON_SIDE } from '../../lib/imagePrep';
import { OnlineShopRuleError } from './rules';

/**
 * The shop's icon: the small square a browser puts in its tab, in a bookmark, and on a phone's
 * home screen when somebody saves the shop there.
 *
 * It exists separately from the logo because the two jobs want different pictures. A logo is
 * usually a WORDMARK -- the shop's name set in type, wide and short -- and it is exactly right at
 * the top of the page and useless at sixteen pixels, where the words become a grey smear. An icon
 * wants one mark: a monogram, a motif, a single strong shape.
 *
 * A shop that never sets one loses nothing. The page falls back to the logo, which is still far
 * better than the browser's blank default page icon, which is what every shop had before.
 */

const BUCKET = 'inventory-images';
const FOLDER = 'shop-icons';

/** Quietly; a picture nothing points at any more is not worth failing a request over. */
async function forget(path: string | null | undefined) {
  if (!path) return;
  await supabase.storage.from(BUCKET).remove([path]).catch(() => {});
}

export async function setIcon(clientId: string, input: { base64?: unknown }) {
  const shop = await prisma.onlineShop.findUnique({
    where: { clientId },
    select: { id: true, iconPath: true }
  });
  if (!shop) throw new OnlineShopRuleError('Choose your shop’s web address first.');

  const raw = typeof input.base64 === 'string'
    ? input.base64.replace(/^data:image\/[a-z+]+;base64,/i, '')
    : '';
  if (!raw) throw new OnlineShopRuleError('Choose a picture for the icon.');

  let buf: Buffer;
  try { buf = Buffer.from(raw, 'base64'); }
  catch { throw new OnlineShopRuleError('That picture did not arrive intact. Please choose it again.'); }

  const { png } = await prepareIcon(buf);

  // A name nobody can guess, like the banners': the address of a shop's file should say nothing
  // about the shop.
  const iconPath = `${FOLDER}/${crypto.randomBytes(16).toString('hex')}.png`;
  const { error } = await supabase.storage.from(BUCKET).upload(iconPath, png, {
    contentType: 'image/png',
    cacheControl: '3600',
    upsert: false
  });
  if (error) throw new OnlineShopRuleError('The picture could not be saved just now. Please try again.');

  const iconUrl = supabase.storage.from(BUCKET).getPublicUrl(iconPath).data.publicUrl;

  const previous = shop.iconPath;
  try {
    await prisma.onlineShop.update({ where: { clientId }, data: { iconUrl, iconPath } });
  } catch (e) {
    // The row did not take it, so the file it points at is now litter. Remove the NEW one, not
    // the old: the shop still has the icon it had a moment ago.
    await forget(iconPath);
    throw e;
  }
  // Only once the row is safely pointing at the new file.
  await forget(previous);

  return { iconUrl, side: ICON_SIDE };
}

export async function clearIcon(clientId: string) {
  const shop = await prisma.onlineShop.findUnique({
    where: { clientId },
    select: { iconPath: true }
  });
  if (!shop) throw new OnlineShopRuleError('Choose your shop’s web address first.');

  await prisma.onlineShop.update({ where: { clientId }, data: { iconUrl: null, iconPath: null } });
  await forget(shop.iconPath);
  return { iconUrl: null };
}
