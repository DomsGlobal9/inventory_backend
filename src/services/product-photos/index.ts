import crypto from 'node:crypto';
import dns from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { prisma } from '../../lib/prisma';
import { supabase } from '../../lib/supabase';
import { badRequest, notFound } from '../../utils/httpError';
import { imageService } from '../image.service';

/**
 * Photos for many products at once (29 Oct): the step after a sheet import, and any time after.
 *
 *   match()    -- which product, and which colour, each file name is for. A folder of photos named by
 *                 SKU ("KS-104.jpg"), variant code or product code, with the colour and a number if
 *                 there are more ("KS-104-green-2.jpg"). Nothing is uploaded here; the browser puts each
 *                 file in storage itself (the product page's own upload-url + register), so a big folder
 *                 never passes through this server.
 *   fromLink() -- a photo the shop already has online (the sheet's Photos column): fetched here, checked
 *                 to be a real picture, put in storage, and registered like an upload. Only public https
 *                 addresses: never this machine, a private network, or a cloud's metadata address.
 *
 * A colour's photo is registered against every size of that colour (one file, one row per variant),
 * as the product page does, so the shop shows it whichever size is chosen.
 */

export const MAX_FILES = 1000;
export const MAX_BYTES = 15 * 1024 * 1024;
const MAX_POSITION = 20;
const PICTURE = /\.(jpe?g|png|webp)$/i;
const APPLE = /\.(heic|heif)$/i;

/** One spelling: lower case, spaces and underscores as hyphens, no doubled hyphens. */
const norm = (s: string) => s.trim().toLowerCase().replace(/[\s_]+/g, '-').replace(/-{2,}/g, '-').replace(/^-|-$/g, '');

type Variant = { id: string; sku: string; variantCode: string; colorName: string | null };
type Product = { id: string; title: string; productCode: string; status: string; variants: Variant[]; hasPhotos: boolean };

export type Match = {
  name: string;
  status: 'MATCHED' | 'UNMATCHED' | 'NOT_A_PHOTO';
  reason?: string;
  productId?: string; productTitle?: string; productCode?: string; productStatus?: string;
  /** The colour the photo shows (null: the piece as a whole), and every variant of it. */
  colour?: string | null; variantIds?: string[];
  /** Its place among that colour's photos, when the name says (KS-104-green-2.jpg -> 2). */
  position?: number | null;
  hasPhotos?: boolean;
  /** This product already has a photo by this exact file name: most likely the same folder added twice. */
  already?: boolean;
};

async function catalogue(clientId: string): Promise<Product[]> {
  const rows = await prisma.product.findMany({
    where: { clientId, trashedAt: null, status: { not: 'TRASHED' as any } },
    select: {
      id: true, title: true, productCode: true, status: true,
      variants: { select: { id: true, sku: true, variantCode: true, colorName: true } },
      images: { where: { imageType: { in: ['COVER', 'GALLERY'] as any } }, select: { id: true }, take: 1 }
    }
  });
  return rows.map(r => ({ id: r.id, title: r.title, productCode: r.productCode, status: String(r.status), variants: r.variants, hasPhotos: r.images.length > 0 }));
}

/** Which product (and colour) each file name is for. Names only; the files stay in the browser. */
export async function match(clientId: string, rawNames: unknown): Promise<{ files: Match[]; withoutPhotos: { id: string; title: string; productCode: string }[] }> {
  if (!Array.isArray(rawNames) || rawNames.length === 0) throw badRequest('Choose some photos first.');
  if (rawNames.length > MAX_FILES) throw badRequest(`That is ${rawNames.length} photos. Add up to ${MAX_FILES} at a time.`);
  const names = rawNames.map(n => String(n ?? '').split(/[\\/]/).pop()!.slice(0, 200));

  const products = await catalogue(clientId);
  const byVariant = new Map<string, { p: Product; v: Variant }>();
  const byProduct = new Map<string, Product>();
  for (const p of products) {
    byProduct.set(norm(p.productCode), p);
    for (const v of p.variants) { byVariant.set(norm(v.sku), { p, v }); byVariant.set(norm(v.variantCode), { p, v }); }
  }
  const colourOf = (p: Product, colour: string | null) => {
    const vs = colour == null ? [] : p.variants.filter(v => (v.colorName ?? '') === colour);
    return { colour, variantIds: vs.map(v => v.id) };
  };
  const findColour = (p: Product, word: string) => {
    const want = norm(word);
    const hit = p.variants.find(v => v.colorName && norm(v.colorName) === want);
    return hit?.colorName ?? null;
  };

  /** A stem that is a code exactly, or a code then a colour of that product. */
  const resolve = (stem: string): Omit<Match, 'name' | 'status' | 'position'> | null => {
    const asVariant = byVariant.get(stem);
    if (asVariant) return { productId: asVariant.p.id, ...colourOf(asVariant.p, asVariant.v.colorName ?? null), product: asVariant.p } as any;
    const asProduct = byProduct.get(stem);
    if (asProduct) return { productId: asProduct.id, colour: null, variantIds: [], product: asProduct } as any;
    // "<code>-<colour>": every place the name could split, longest code first.
    const parts = stem.split('-');
    for (let i = parts.length - 1; i >= 1; i--) {
      const code = parts.slice(0, i).join('-'), word = parts.slice(i).join('-');
      const hit = byVariant.get(code)?.p ?? byProduct.get(code);
      if (!hit) continue;
      const colour = findColour(hit, word);
      if (colour) return { productId: hit.id, ...colourOf(hit, colour), product: hit } as any;
    }
    return null;
  };

  const files: Match[] = names.map(name => {
    if (APPLE.test(name)) return { name, status: 'NOT_A_PHOTO', reason: 'An iPhone HEIC photo. Save it as JPG (or set the camera to "Most compatible") and add it again.' };
    if (!PICTURE.test(name)) return { name, status: 'NOT_A_PHOTO', reason: 'Not a JPG, PNG or WebP photo.' };
    const stem = norm(name.replace(PICTURE, ''));
    // Whole name first: "KS-104" is a code, not KS with photo number 104.
    let found = resolve(stem), position: number | null = null;
    if (!found) {
      const m = /^(.*?)-?\(?(\d{1,2})\)?$/.exec(stem);
      if (m && m[1] && Number(m[2]) >= 1 && Number(m[2]) <= MAX_POSITION) {
        found = resolve(norm(m[1]));
        if (found) position = Number(m[2]);
      }
    }
    if (!found) return { name, status: 'UNMATCHED', reason: 'No product, SKU or colour with that name.' };
    const p: Product = (found as any).product;
    return {
      name, status: 'MATCHED', productId: p.id, productTitle: p.title, productCode: p.productCode, productStatus: p.status,
      colour: found.colour ?? null, variantIds: found.variantIds ?? [], position, hasPhotos: p.hasPhotos
    };
  });

  // A file name this product already has a photo by: the folder added a second time. Shown, and left
  // out of the upload unless the person ticks it back in.
  const matched = files.filter(f => f.status === 'MATCHED');
  if (matched.length) {
    const have = await prisma.productImage.findMany({
      where: { productId: { in: [...new Set(matched.map(f => f.productId!))] }, fileName: { in: [...new Set(matched.map(f => f.name))] } },
      select: { productId: true, fileName: true }
    });
    const seen = new Set(have.map(h => `${h.productId}|${h.fileName}`));
    for (const f of matched) f.already = seen.has(`${f.productId}|${f.name}`);
  }

  // Drafts with no photo, and nothing in this folder for them either: what still needs a picture.
  const covered = new Set(files.filter(f => f.status === 'MATCHED').map(f => f.productId));
  const withoutPhotos = products.filter(p => p.status === 'DRAFT' && !p.hasPhotos && !covered.has(p.id))
    .slice(0, 200).map(p => ({ id: p.id, title: p.title, productCode: p.productCode }));
  return { files, withoutPhotos };
}

/** For a photo whose name matched nothing: products by name, code or SKU, with their colours, to pick from. */
export async function find(clientId: string, raw: unknown) {
  const q = String(raw ?? '').trim().slice(0, 60);
  if (q.length < 2) return [];
  const rows = await prisma.product.findMany({
    where: {
      clientId, trashedAt: null, status: { not: 'TRASHED' as any },
      OR: [
        { title: { contains: q, mode: 'insensitive' } },
        { productCode: { contains: q, mode: 'insensitive' } },
        { variants: { some: { sku: { contains: q, mode: 'insensitive' } } } }
      ]
    },
    orderBy: { updatedAt: 'desc' }, take: 8,
    select: {
      id: true, title: true, productCode: true, status: true,
      variants: { select: { id: true, colorName: true } },
      images: { where: { imageType: { in: ['COVER', 'GALLERY'] as any } }, select: { id: true }, take: 1 }
    }
  });
  return rows.map(r => {
    const colours = new Map<string, string[]>();
    for (const v of r.variants) if (v.colorName) colours.set(v.colorName, [...(colours.get(v.colorName) ?? []), v.id]);
    return {
      id: r.id, title: r.title, productCode: r.productCode, status: String(r.status), hasPhotos: r.images.length > 0,
      colours: [...colours.entries()].map(([colour, variantIds]) => ({ colour, variantIds }))
    };
  });
}

// ---- A photo the shop already has online ---------------------------------------------------------

/** Share links that open a page rather than the picture, turned into the picture itself. */
export function directLink(raw: string): string {
  const u = new URL(raw);
  if (/(^|\.)drive\.google\.com$/.test(u.hostname)) {
    const id = /\/file\/d\/([^/]+)/.exec(u.pathname)?.[1] ?? u.searchParams.get('id');
    if (id) return `https://drive.google.com/uc?export=download&id=${encodeURIComponent(id)}`;
  }
  if (/(^|\.)dropbox\.com$/.test(u.hostname)) { u.searchParams.set('dl', '1'); return u.toString(); }
  return u.toString();
}

/** Addresses a shop's sheet must never make this server fetch: this machine, private networks, cloud metadata. */
export function isPrivateAddress(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  const v = ip.toLowerCase();
  // An IPv4 address written as IPv6 (::ffff:127.0.0.1, or ::ffff:7f00:1): judged as the IPv4 it is,
  // and refused when it is in the hex spelling rather than guessed at.
  if (v.startsWith('::ffff:')) return net.isIPv4(v.slice(7)) ? isPrivateAddress(v.slice(7)) : true;
  return v === '::1' || v === '::' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe80');
}

/**
 * One exact origin a local test suite serves its own pictures from (PHOTO_LINKS_TEST_ORIGIN, e.g.
 * http://127.0.0.1:18201). Never in production, and only that origin: every other private address is
 * still refused in the same run, so the suite can prove the refusals too.
 */
export const isTestOrigin = (u: URL) => process.env.NODE_ENV !== 'production'
  && !!process.env.PHOTO_LINKS_TEST_ORIGIN && u.origin === process.env.PHOTO_LINKS_TEST_ORIGIN;

async function assertPublic(u: URL) {
  if (u.username || u.password) throw badRequest('That photo link has a password in it. Use a plain public link.');
  if (isTestOrigin(u)) return;
  if (u.protocol !== 'https:') throw badRequest('Only https links can be used for photos.');
  if (u.port && u.port !== '443') throw badRequest('That photo link is not a normal public address.');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  const ips = net.isIP(host) ? [host] : (await dns.lookup(host, { all: true }).catch(() => [])).map(a => a.address);
  if (ips.length === 0) throw badRequest('That photo link\'s website could not be found.');
  if (ips.some(isPrivateAddress)) throw badRequest('That photo link is not a public address.');
}

/** What the bytes really are (not what the website claims). */
function pictureType(b: Buffer): 'image/jpeg' | 'image/png' | 'image/webp' | null {
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length > 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (b.length > 12 && b.subarray(0, 4).toString('ascii') === 'RIFF' && b.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  return null;
}

/**
 * The address is checked again at the moment of connecting, not only before: a name can answer a public
 * address to the first look-up and a private one to the second (DNS rebinding). Node asks this for every
 * connection it opens, so what it connects to is exactly what was checked.
 */
function checkedLookup(hostname: string, options: any, cb: (...a: any[]) => void) {
  dns.lookup(hostname, { all: true }).then(addrs => {
    if (!addrs.length) return cb(Object.assign(new Error('not found'), { code: 'ENOTFOUND' }));
    if (addrs.some(a => isPrivateAddress(a.address))) return cb(Object.assign(new Error('private address'), { code: 'EPRIVATE' }));
    if (options?.all) return cb(null, addrs);
    cb(null, addrs[0].address, addrs[0].family);
  }, err => cb(err));
}

type Answer = { status: number; location: string | null; length: number; body: http.IncomingMessage };

function ask(url: URL): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const lib = url.protocol === 'https:' ? https : http;
    const req = lib.get(url, {
      headers: { 'user-agent': 'ScaleEzy-photo-import', accept: 'image/*' },
      timeout: 20_000,
      ...(isTestOrigin(url) ? {} : { lookup: checkedLookup as any })
    }, res => resolve({
      status: res.statusCode ?? 0,
      location: typeof res.headers.location === 'string' ? res.headers.location : null,
      length: Number(res.headers['content-length'] ?? 0),
      body: res
    }));
    req.on('timeout', () => req.destroy(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })));
    req.on('error', reject);
  });
}

async function download(raw: string): Promise<{ bytes: Buffer; type: string }> {
  let url = new URL(directLink(raw));
  for (let hop = 0; hop < 4; hop++) {
    await assertPublic(url);
    const res = await ask(url).catch((e: any) => {
      if (e?.code === 'EPRIVATE') throw badRequest('That photo link is not a public address.');
      if (e?.code === 'ETIMEDOUT') throw badRequest('That photo link took too long to answer. Try it again, or use another link.');
      throw badRequest('That photo could not be downloaded. Check the link opens in a browser without signing in.');
    });
    if (res.status >= 300 && res.status < 400 && res.location) {
      res.body.resume();
      // Every hop is checked again: a public address may not hand us on to a private one.
      url = new URL(res.location, url);
      continue;
    }
    if (res.status < 200 || res.status >= 300) {
      res.body.resume();
      throw badRequest(`That photo link answered ${res.status}. Check it opens in a browser without signing in.`);
    }
    if (res.length > MAX_BYTES) { res.body.destroy(); throw badRequest('That photo is bigger than 15 MB.'); }
    const chunks: Buffer[] = []; let total = 0;
    try {
      for await (const chunk of res.body) {
        total += chunk.length;
        if (total > MAX_BYTES) { res.body.destroy(); throw badRequest('That photo is bigger than 15 MB.'); }
        chunks.push(chunk);
      }
    } catch (e: any) {
      if (e?.statusCode) throw e;
      throw badRequest('That photo stopped downloading halfway. Try it again.');
    }
    const bytes = Buffer.concat(chunks);
    const type = pictureType(bytes);
    if (!type) throw badRequest('That link is not a JPG, PNG or WebP photo (it may be a web page asking to sign in).');
    return { bytes, type };
  }
  throw badRequest('That photo link sends you round too many times.');
}

/**
 * One photo from a link onto a product (and every size of a colour). `position` 1 with no cover yet
 * becomes the product's main photo. Returns how many rows it registered.
 */
export async function fromLink(clientId: string, input: { productId?: unknown; colour?: unknown; url?: unknown; position?: unknown }) {
  const productId = typeof input.productId === 'string' ? input.productId : '';
  const url = typeof input.url === 'string' ? input.url.trim() : '';
  if (!productId) throw badRequest('Which product is missing.');
  if (!url) throw badRequest('Which photo link is missing.');
  try { new URL(url); } catch { throw badRequest('That is not a web link.'); }
  const product = await prisma.product.findFirst({
    where: { id: productId, clientId, trashedAt: null },
    select: { id: true, title: true, status: true, variants: { select: { id: true, colorName: true } }, images: { where: { isPrimary: true }, select: { variantId: true } } }
  });
  if (!product) throw notFound('That product could not be found.');
  const colour = typeof input.colour === 'string' && input.colour.trim() ? input.colour.trim() : null;
  const variantIds = colour ? product.variants.filter(v => (v.colorName ?? '').toLowerCase() === colour.toLowerCase()).map(v => v.id) : [];
  if (colour && variantIds.length === 0) throw badRequest(`This product has no colour called ${colour}.`);
  const position = Number.isInteger(Number(input.position)) ? Math.max(1, Math.min(MAX_POSITION, Number(input.position))) : 1;

  // The same sheet imported twice must not add the same photo twice: the link's fingerprint is kept in
  // the file name, and a link this product already has is left alone.
  const mark = `link-${crypto.createHash('sha256').update(url).digest('hex').slice(0, 12)}`;
  const already = await prisma.productImage.findFirst({ where: { productId, fileName: { startsWith: mark } }, select: { id: true } });
  const said = { productId, productTitle: product.title, productStatus: String(product.status) };
  if (already) return { ...said, registered: 0, already: true };

  const { bytes, type } = await download(url);
  const ext = type === 'image/png' ? 'png' : type === 'image/webp' ? 'webp' : 'jpg';
  const storagePath = `${clientId}/${productId}/${Date.now()}_${mark}.${ext}`;
  const { error } = await supabase.storage.from('inventory-images').upload(storagePath, bytes, { contentType: type, upsert: false });
  if (error) {
    console.error('[product-photos] storage refused a photo:', error.message);
    throw { statusCode: 502, message: 'The photo could not be saved just now. Try again in a minute.' };
  }
  const publicUrl = supabase.storage.from('inventory-images').getPublicUrl(storagePath).data.publicUrl;
  // A primary is per set (the piece, or one size of a colour), as addImage keeps it: the first photo
  // of a set that has none becomes its main one, and a set that already has one keeps it.
  const hasPrimary = new Set(product.images.map(i => i.variantId ?? ''));
  const targets = variantIds.length ? variantIds : [undefined];
  for (const variantId of targets) {
    await imageService.addImage(productId, clientId, {
      url: publicUrl, storagePath, imageType: 'GALLERY', orderIndex: position - 1, generated: false,
      isPrimary: position === 1 && !hasPrimary.has(variantId ?? ''), fileName: `${mark}.${ext}`, fileSize: bytes.length,
      ...(variantId ? { variantId } : {})
    });
  }
  return { ...said, registered: targets.length, already: false, storagePath, publicUrl };
}
