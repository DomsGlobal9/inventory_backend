import { randomUUID } from 'crypto';
import sharp from 'sharp';
import { prisma } from '../../lib/prisma';
import { supabase } from '../../lib/supabase';
import { summary as orderSummary } from '../online-shop/checkout';
import { whoIs } from '../online-shop/otp';
import { OnlineShopRuleError } from '../online-shop/rules';

/**
 * Customer reviews and private feedback (5 Nov 2026, owner). Its own module: the shop collects and shows them, and
 * ScaleEzy CRM manages them (the owner: "editing and hiding from crm, we can't keep everything in inventory").
 * Inventory has no screen for them; CRM hears of each through the module outbox and acts through /internal routes.
 *
 * The rules:
 *  - Only someone whose order of this item was DELIVERED, with that number proved, can review it: one review per
 *    item per number, which they can change or take down themselves. So "Verified buyer" is always true.
 *  - A review shows at once. The shop can reply, and can hide one only for a stated reason. It cannot change what
 *    a customer wrote, and a low rating is not a reason: that is what keeps the average honest.
 *  - Feedback is private: for the shop, about an order. It never reaches a product page.
 *  - The public never sees a number: only a first name and an initial.
 */

const BUCKET = 'inventory-images';
const MAX_BODY = 1000, MAX_FEEDBACK = 1000, MAX_REPLY = 500, MAX_PHOTOS = 3, PAGE = 10;
const MAX_PHOTO_BYTES = 8 * 1024 * 1024;

export const REVIEW_TAGS = ['Good quality', 'True to photo', 'Fits well', 'Good colour', 'Value for money', 'Fast delivery'];
/** Why a shop may hide a review. "I don't like it" is not on the list, on purpose. */
export const HIDE_REASONS: Record<string, string> = {
  ABUSIVE: 'Abusive or offensive',
  NOT_ABOUT_ITEM: 'Not about the item',
  PERSONAL_DETAILS: 'Shows personal details',
  SPAM: 'Spam or advertising',
};

type Photo = { url: string; path: string };
const rule = (message: string) => new OnlineShopRuleError(message);
const photosOf = (v: unknown): Photo[] => (Array.isArray(v) ? (v as Photo[]) : []);
/** Printable text, one run of blank lines at most. React escapes it on the way out; this keeps it tidy. */
const clean = (v: unknown, max: number) => String(typeof v === 'string' ? v : '')
  .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
  .replace(/\n{3,}/g, '\n\n').trim().slice(0, max);
const lastTen = (phone: unknown) => String(phone ?? '').replace(/\D/g, '').slice(-10);
/** "Kavya Reddy" reads "Kavya R". No name: nothing, and the page says "Verified buyer". */
function publicName(name: unknown): string | null {
  const parts = String(name ?? '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return null;
  return parts.length > 1 ? `${parts[0]} ${parts[parts.length - 1][0].toUpperCase()}` : parts[0];
}

async function productOf(clientId: string, codeRaw: unknown) {
  const productCode = String(codeRaw ?? '').trim();
  if (!productCode) throw rule('That item could not be found.');
  const p = await prisma.product.findFirst({
    where: { clientId, productCode, status: 'ACTIVE', trashedAt: null },
    select: { id: true, title: true, productCode: true }
  });
  if (!p) throw rule('That item could not be found.');
  return p;
}

/**
 * The delivered order of this item on this number, newest first, or null. Delivered as the customer's order page
 * says it (orderSummary): every parcel arrived. The number itself was proved when `phone` came from whoIs, so the
 * order's own "proved at checkout" flag does not matter here.
 */
async function deliveredOrder(clientId: string, phone: string, productId: string) {
  const ten = lastTen(phone);
  if (ten.length !== 10) return null;
  const rows = await prisma.onlineShopOrder.findMany({
    where: {
      clientId, customerPhone: { in: [phone, ten, `0${ten}`, `91${ten}`, `+91${ten}`] },
      salesOrder: { items: { some: { variant: { productId } } } }
    },
    orderBy: { createdAt: 'desc' }, take: 20,
    select: { id: true, token: true, salesOrder: { select: { customerName: true, items: { where: { variant: { productId } }, select: { variant: { select: { variantCode: true, colorName: true, size: true } } } } } } }
  });
  for (const row of rows) {
    const s: any = await orderSummary(clientId, row.token).catch(() => null);
    if (s?.delivered) return row;
  }
  return null;
}

// ─── What the shop's pages read ────────────────────────────────────────────────────────────

/** The average and the bars, over what the public can see. */
export async function summaryOf(productId: string) {
  const rows = await prisma.shopReview.groupBy({ by: ['rating'], where: { productId, status: 'PUBLISHED' }, _count: { _all: true } });
  const counts: Record<string, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  let total = 0, sum = 0;
  for (const r of rows) { counts[r.rating] = r._count._all; total += r._count._all; sum += r.rating * r._count._all; }
  return { count: total, average: total ? Math.round((sum / total) * 10) / 10 : null, counts };
}

/** One page of a product's reviews. Nothing about who wrote them but the name, the size and the day. */
export async function listPublic(clientId: string, codeRaw: unknown, opts: { page?: unknown; sort?: unknown; rating?: unknown } = {}) {
  const product = await productOf(clientId, codeRaw);
  const page = Math.max(1, Math.min(Number(opts.page) || 1, 1000));
  const rating = [1, 2, 3, 4, 5].includes(Number(opts.rating)) ? Number(opts.rating) : undefined;
  const orderBy = opts.sort === 'HIGH' ? [{ rating: 'desc' as const }, { createdAt: 'desc' as const }]
    : opts.sort === 'LOW' ? [{ rating: 'asc' as const }, { createdAt: 'desc' as const }]
    : [{ createdAt: 'desc' as const }];
  const where = { productId: product.id, status: 'PUBLISHED', ...(rating ? { rating } : {}) };
  const [rows, matching, summary] = await Promise.all([
    prisma.shopReview.findMany({ where, orderBy, skip: (page - 1) * PAGE, take: PAGE }),
    prisma.shopReview.count({ where }),
    summaryOf(product.id)
  ]);
  return {
    summary,
    tagsOffered: REVIEW_TAGS,
    page, hasMore: page * PAGE < matching,
    reviews: rows.map(r => ({
      id: r.id, rating: r.rating, body: r.body, tags: r.tags,
      photos: photosOf(r.photos).map(p => p.url),
      name: publicName(r.customerName), verified: true,
      variant: r.variantLabel, at: r.createdAt, edited: !!r.editedAt,
      reply: r.reply ? { text: r.reply, at: r.replyAt } : null
    }))
  };
}

/** For the person looking: may they review this, and what they wrote already. */
export async function mine(clientId: string, token: unknown, codeRaw: unknown) {
  const product = await productOf(clientId, codeRaw);
  const phone = await whoIs(clientId, token);
  if (!phone) return { signedIn: false, canReview: false, review: null };
  const [review, order] = await Promise.all([
    prisma.shopReview.findUnique({ where: { productId_phone: { productId: product.id, phone } } }),
    deliveredOrder(clientId, phone, product.id)
  ]);
  return {
    signedIn: true,
    canReview: !!order || !!review,
    review: review ? {
      id: review.id, rating: review.rating, body: review.body, tags: review.tags,
      photos: photosOf(review.photos).map(p => p.url), hidden: review.status === 'HIDDEN',
      reply: review.reply ? { text: review.reply, at: review.replyAt } : null
    } : null
  };
}

/** Save, or change, this person's review of this item. */
export async function save(clientId: string, token: unknown, codeRaw: unknown, input: { rating?: unknown; body?: unknown; tags?: unknown; photos?: unknown; variantCode?: unknown }) {
  const product = await productOf(clientId, codeRaw);
  const phone = await whoIs(clientId, token);
  if (!phone) throw rule('Sign in with your WhatsApp number to review this item.');

  const rating = Number(input.rating);
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) throw rule('Choose a rating from 1 to 5 stars.');
  const body = clean(input.body, MAX_BODY) || null;
  const tags = Array.isArray(input.tags) ? [...new Set(input.tags.filter((t): t is string => REVIEW_TAGS.includes(t as string)))] : [];

  const existing = await prisma.shopReview.findUnique({ where: { productId_phone: { productId: product.id, phone } } });
  const order = await deliveredOrder(clientId, phone, product.id);
  if (!order && !existing) throw rule('You can review this item once your order of it has been delivered.');

  // Only photographs uploaded for this shop, and that are this review's or fresh from the upload just now.
  const wanted = Array.isArray(input.photos) ? (input.photos as unknown[]).slice(0, MAX_PHOTOS + 1) : [];
  if (wanted.length > MAX_PHOTOS) throw rule(`Add up to ${MAX_PHOTOS} photos.`);
  const prefix = `reviews/${clientId}/`;
  const photos: Photo[] = [];
  for (const raw of wanted) {
    const url = String(raw ?? '');
    const known = photosOf(existing?.photos).find(p => p.url === url);
    if (known) { photos.push(known); continue; }
    const at = url.indexOf(prefix);
    const path = at >= 0 ? url.slice(at).split('?')[0] : '';
    if (!path || !/^reviews\/[^/]+\/[\w-]+\.jpg$/.test(path)) throw rule('One of those photos could not be used. Add it again.');
    photos.push({ url: supabase.storage.from(BUCKET).getPublicUrl(path).data.publicUrl, path });
  }

  const item = order?.salesOrder.items.find(i => i.variant?.variantCode === input.variantCode) ?? order?.salesOrder.items[0];
  const label = item?.variant ? [item.variant.colorName, item.variant.size].filter(v => v && !/^(none|free)$/i.test(v)).join(', ') || null : null;
  const customer = await prisma.customer.findFirst({ where: { clientId, phone, deletedAt: null }, select: { name: true } });
  const name = customer?.name ?? order?.salesOrder.customerName ?? existing?.customerName ?? null;

  const saved = existing
    ? await prisma.shopReview.update({ where: { id: existing.id }, data: { rating, body, tags, photos, editedAt: new Date(), customerName: name } })
    : await prisma.shopReview.create({ data: {
        clientId, productId: product.id, phone, rating, body, tags, photos, customerName: name,
        onlineOrderId: order?.id ?? null, variantCode: item?.variant?.variantCode ?? null, variantLabel: label
      } }).catch(async (e: any) => {
        // Two taps racing: the first won, so this is an edit of it.
        if (e?.code !== 'P2002') throw e;
        return prisma.shopReview.update({ where: { productId_phone: { productId: product.id, phone } }, data: { rating, body, tags, photos, editedAt: new Date() } });
      });

  if (existing) void removePhotos(photosOf(existing.photos).filter(p => !photos.some(n => n.path === p.path)));
  return { id: saved.id, rating: saved.rating, summary: await summaryOf(product.id), hidden: saved.status === 'HIDDEN' };
}

/** A customer takes their own review down. For good, with its photographs. */
export async function removeOwn(clientId: string, token: unknown, codeRaw: unknown) {
  const product = await productOf(clientId, codeRaw);
  const phone = await whoIs(clientId, token);
  if (!phone) throw rule('Sign in with your WhatsApp number first.');
  const existing = await prisma.shopReview.findUnique({ where: { productId_phone: { productId: product.id, phone } } });
  if (existing) {
    await prisma.shopReview.delete({ where: { id: existing.id } });
    void removePhotos(photosOf(existing.photos));
  }
  return { removed: !!existing, summary: await summaryOf(product.id) };
}

/**
 * A photograph for a review. Only from someone who can review this item. Re-drawn here, which proves it is a
 * picture and strips what a phone hides in the file (above all, where it was taken).
 */
export async function addPhoto(clientId: string, token: unknown, codeRaw: unknown, photoRaw: unknown) {
  const product = await productOf(clientId, codeRaw);
  const phone = await whoIs(clientId, token);
  if (!phone) throw rule('Sign in with your WhatsApp number first.');
  const allowed = (await prisma.shopReview.findUnique({ where: { productId_phone: { productId: product.id, phone } }, select: { id: true } }))
    || await deliveredOrder(clientId, phone, product.id);
  if (!allowed) throw rule('You can add photos once your order of this item has been delivered.');

  const base64 = typeof photoRaw === 'string' ? photoRaw.replace(/^data:image\/[a-z0-9.+-]+;base64,/i, '') : '';
  if (!base64) throw rule('Choose a photo first.');
  const bytes = Buffer.from(base64, 'base64');
  if (bytes.length > MAX_PHOTO_BYTES) throw rule('That photo is too large. Choose a smaller one.');
  let jpeg: Buffer;
  try {
    jpeg = await sharp(bytes, { failOn: 'error' }).rotate().resize({ width: 1400, height: 1400, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 80 }).toBuffer();
  } catch {
    throw rule('That file could not be read as a photo. Choose a JPG or PNG.');
  }
  const path = `reviews/${clientId}/${randomUUID()}.jpg`;
  const { error } = await supabase.storage.from(BUCKET).upload(path, jpeg, { contentType: 'image/jpeg', upsert: false });
  if (error) {
    console.error('[shop-reviews] a photo could not be stored:', error.message);
    throw rule('That photo could not be saved. Please try again.');
  }
  return { url: supabase.storage.from(BUCKET).getPublicUrl(path).data.publicUrl };
}

async function removePhotos(photos: Photo[]) {
  const paths = photos.map(p => p.path).filter(Boolean);
  if (!paths.length) return;
  const { error } = await supabase.storage.from(BUCKET).remove(paths);
  if (error) console.error('[shop-reviews] photos left in storage:', error.message);
}

/** On a delivered order's page: what they rated already, and the private note they left. The link is the proof. */
export async function forOrder(clientId: string, orderToken: unknown) {
  const s: any = await orderSummary(clientId, orderToken);
  const row = await prisma.onlineShopOrder.findUnique({ where: { token: String(orderToken).trim() }, select: { id: true, customerPhone: true } });
  if (!row) throw rule('That order could not be found.');
  const codes = [...new Set((s.items ?? []).map((i: any) => i.productCode).filter(Boolean))] as string[];
  const ten = lastTen(row.customerPhone);
  const [reviews, feedback] = await Promise.all([
    ten ? prisma.shopReview.findMany({
      where: { clientId, phone: { endsWith: ten }, product: { productCode: { in: codes } } },
      select: { rating: true, product: { select: { productCode: true } } }
    }) : Promise.resolve([]),
    prisma.shopOrderFeedback.findUnique({ where: { onlineOrderId: row.id }, select: { body: true } })
  ]);
  return {
    delivered: !!s.delivered,
    ratings: Object.fromEntries(reviews.map(r => [r.product.productCode, r.rating])),
    feedback: feedback?.body ?? null
  };
}

/** Private feedback about an order: delivered orders only, one per order, which can be changed until handled. */
export async function saveFeedback(clientId: string, orderToken: unknown, bodyRaw: unknown) {
  const s: any = await orderSummary(clientId, orderToken);
  if (!s.delivered) throw rule('You can send feedback once your order has been delivered.');
  const body = clean(bodyRaw, MAX_FEEDBACK);
  if (!body) throw rule('Type your feedback first.');
  const row = await prisma.onlineShopOrder.findUnique({
    where: { token: String(orderToken).trim() },
    select: { id: true, customerPhone: true, salesOrder: { select: { orderNumber: true, customerName: true } } }
  });
  if (!row) throw rule('That order could not be found.');
  await prisma.shopOrderFeedback.upsert({
    where: { onlineOrderId: row.id },
    create: { clientId, onlineOrderId: row.id, body, phone: row.customerPhone, customerName: row.salesOrder.customerName, orderNumber: row.salesOrder.orderNumber },
    update: { body, handledAt: null, handledBy: null }
  });
  return { saved: true };
}

// ─── What CRM asks for (routes/internal-crm.routes.ts) ─────────────────────────────────────

const crmRow = (r: any) => ({
  id: r.id, rating: r.rating, body: r.body, tags: r.tags, photos: photosOf(r.photos).map((p: Photo) => p.url),
  status: r.status, hiddenReason: r.hiddenReason, hiddenAt: r.hiddenAt, hiddenBy: r.hiddenBy,
  reply: r.reply, replyAt: r.replyAt, replyBy: r.replyBy, editedAt: r.editedAt, createdAt: r.createdAt,
  phone: r.phone, customerName: r.customerName, variant: r.variantLabel, variantCode: r.variantCode, onlineOrderId: r.onlineOrderId,
  product: r.product ? { id: r.product.id, productCode: r.product.productCode, title: r.product.title } : undefined
});

async function reviewFor(clientId: string, id: unknown) {
  const r = await prisma.shopReview.findFirst({ where: { id: String(id ?? ''), clientId }, include: { product: { select: { id: true, productCode: true, title: true } } } });
  if (!r) throw Object.assign(new Error('That review could not be found.'), { statusCode: 404 });
  return r;
}

export const crm = {
  hideReasons: () => Object.entries(HIDE_REASONS).map(([key, label]) => ({ key, label })),

  /** Newest first, a page at a time. `needsReply`: visible, 3 stars or fewer, nobody has answered. */
  async list(clientId: string, q: { status?: unknown; rating?: unknown; needsReply?: unknown; productCode?: unknown; phone?: unknown; cursor?: unknown; limit?: unknown } = {}) {
    const limit = Math.max(1, Math.min(Number(q.limit) || 25, 100));
    const ten = lastTen(q.phone);
    const where: any = {
      clientId,
      ...(q.status === 'PUBLISHED' || q.status === 'HIDDEN' ? { status: q.status } : {}),
      ...([1, 2, 3, 4, 5].includes(Number(q.rating)) ? { rating: Number(q.rating) } : {}),
      ...(String(q.needsReply) === 'true' ? { status: 'PUBLISHED', rating: { lte: 3 }, reply: null } : {}),
      ...(q.productCode ? { product: { productCode: String(q.productCode) } } : {}),
      ...(ten.length === 10 ? { phone: { endsWith: ten } } : {})
    };
    const rows = await prisma.shopReview.findMany({
      where, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: limit + 1,
      ...(q.cursor ? { cursor: { id: String(q.cursor) }, skip: 1 } : {}),
      include: { product: { select: { id: true, productCode: true, title: true } } }
    });
    return { reviews: rows.slice(0, limit).map(crmRow), nextCursor: rows.length > limit ? rows[limit - 1].id : null };
  },

  async stats(clientId: string) {
    const [groups, needsReply, hidden, feedbackOpen] = await Promise.all([
      prisma.shopReview.groupBy({ by: ['rating'], where: { clientId, status: 'PUBLISHED' }, _count: { _all: true } }),
      prisma.shopReview.count({ where: { clientId, status: 'PUBLISHED', rating: { lte: 3 }, reply: null } }),
      prisma.shopReview.count({ where: { clientId, status: 'HIDDEN' } }),
      prisma.shopOrderFeedback.count({ where: { clientId, handledAt: null } })
    ]);
    const count = groups.reduce((t, g) => t + g._count._all, 0);
    const sum = groups.reduce((t, g) => t + g.rating * g._count._all, 0);
    return { count, average: count ? Math.round((sum / count) * 10) / 10 : null, needsReply, hidden, feedbackOpen };
  },

  async reply(clientId: string, id: unknown, textRaw: unknown, by: string) {
    await reviewFor(clientId, id);
    const text = clean(textRaw, MAX_REPLY);
    if (!text) throw new Error('Type your reply first.');
    await prisma.shopReview.update({ where: { id: String(id) }, data: { reply: text, replyAt: new Date(), replyBy: by } });
    return crmRow(await reviewFor(clientId, id));
  },

  async removeReply(clientId: string, id: unknown) {
    await reviewFor(clientId, id);
    await prisma.shopReview.update({ where: { id: String(id) }, data: { reply: null, replyAt: null, replyBy: null } });
    return crmRow(await reviewFor(clientId, id));
  },

  /** Off the shop's pages, and out of the average. Needs a reason from the list. Can be undone. */
  async hide(clientId: string, id: unknown, reasonRaw: unknown, by: string) {
    await reviewFor(clientId, id);
    const reason = String(reasonRaw ?? '');
    if (!HIDE_REASONS[reason]) throw new Error(`Choose why this is being hidden: ${Object.values(HIDE_REASONS).join(', ')}.`);
    await prisma.shopReview.update({ where: { id: String(id) }, data: { status: 'HIDDEN', hiddenReason: reason, hiddenAt: new Date(), hiddenBy: by } });
    return crmRow(await reviewFor(clientId, id));
  },

  async unhide(clientId: string, id: unknown) {
    await reviewFor(clientId, id);
    await prisma.shopReview.update({ where: { id: String(id) }, data: { status: 'PUBLISHED', hiddenReason: null, hiddenAt: null, hiddenBy: null } });
    return crmRow(await reviewFor(clientId, id));
  },

  async feedback(clientId: string, q: { open?: unknown; phone?: unknown; cursor?: unknown; limit?: unknown } = {}) {
    const limit = Math.max(1, Math.min(Number(q.limit) || 25, 100));
    const ten = lastTen(q.phone);
    const rows = await prisma.shopOrderFeedback.findMany({
      where: { clientId, ...(String(q.open) === 'true' ? { handledAt: null } : {}), ...(ten.length === 10 ? { phone: { endsWith: ten } } : {}) },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: limit + 1,
      ...(q.cursor ? { cursor: { id: String(q.cursor) }, skip: 1 } : {})
    });
    return { feedback: rows.slice(0, limit), nextCursor: rows.length > limit ? rows[limit - 1].id : null };
  },

  async setFeedbackHandled(clientId: string, id: unknown, handled: boolean, by: string) {
    const row = await prisma.shopOrderFeedback.findFirst({ where: { id: String(id ?? ''), clientId } });
    if (!row) throw Object.assign(new Error('That feedback could not be found.'), { statusCode: 404 });
    return prisma.shopOrderFeedback.update({ where: { id: row.id }, data: handled ? { handledAt: new Date(), handledBy: by } : { handledAt: null, handledBy: null } });
  },
};

/** A customer erased: their reviews and feedback go with them (services/customer-delete). Photographs after the rows. */
export async function forgetNumberRows(tx: any, clientId: string, phone: string) {
  const ten = lastTen(phone);
  if (ten.length !== 10) return [] as Photo[];
  const rows = await tx.shopReview.findMany({ where: { clientId, phone: { endsWith: ten } }, select: { photos: true } });
  await tx.shopReview.deleteMany({ where: { clientId, phone: { endsWith: ten } } });
  await tx.shopOrderFeedback.deleteMany({ where: { clientId, phone: { endsWith: ten } } });
  return rows.flatMap((r: any) => photosOf(r.photos));
}
export const forgetPhotos = removePhotos;
