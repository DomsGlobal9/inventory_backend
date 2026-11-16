import { platformAdminService } from '../services/platform-admin.service';
import * as join from '../services/boutique/join';
import { Router, Request, Response, NextFunction } from 'express';
import { prisma } from '../lib/prisma';
import * as boutique from '../services/boutique';
import * as extra from '../services/boutique/more';
import * as buying from '../services/boutique/buying';
import * as reports from '../services/boutique/reports';
import * as racks from '../services/boutique/shelves';
import { factorOf } from '../lib/units';
import type { Actor } from '../services/boutique';
import { respondWithError } from '../utils/respondWithError';

/**
 * The boutique (CRM-B) on ScaleEzy Inventory: its items and their stock, nothing else (PLAN-boutique-sync.md §0).
 * Mounted at /api/v1/internal/boutique, behind verifyServiceToken and the per-service limit.
 *
 * The pass: an RS256 token signed with the boutique service's own key (registered in TRUSTED_SERVICES_KEYS), with
 *   scope       ["modules:boutique"]
 *   tenant      the boutique account it speaks for (CRM-B schema name)
 *   onBehalfOf  { userId, name, can }  the boutique person and what the boutique lets them do:
 *               products:write  add and change items       stock:write      receive, count, damage, sell, move
 *               stitching:issue hold, cut and use cloth for orders, record waste and unused returns
 *   exp         at most 15 minutes after iat
 * The shop is found from the tenant (boutique_links); a pass can never name its own shop.
 *
 * Every change carries a request id (Idempotency-Key header, or requestId in the body). The same id again gets the
 * first answer and changes nothing.
 */
const router = Router();
const KNOWN_CAN = ['products:write', 'stock:write', 'stitching:issue', 'stock:transfer', 'suppliers:write', 'reports:view'];
type Pass = { id: string; scopes: string[]; tenant?: string; clientId?: string; issuedAt?: number; expiresAt?: number; onBehalfOf?: { userId: string; name?: string; can?: string[] } };
const pass = (req: Request) => (req as any).service as Pass;
const fail = (res: Response, status: number, message: string) => res.status(status).json({ success: false, message });
const actorOf = (req: Request) => (req as any).boutiqueActor as Actor;
const requestIdOf = (req: Request) => req.get('Idempotency-Key') ?? req.body?.requestId;

router.use((req, res, next) => {
  const p = pass(req);
  if (!p?.scopes?.includes('modules:boutique')) return fail(res, 403, 'This service may not do that (needs modules:boutique).');
  if (typeof p.tenant !== 'string' || !p.tenant) return fail(res, 401, 'The pass must name the boutique account (tenant).');
  if (!p.expiresAt || !p.issuedAt || p.expiresAt - p.issuedAt > 15 * 60) return fail(res, 401, 'The pass must run out within 15 minutes of being signed (iat and exp).');
  const who = p.onBehalfOf;
  if (!who?.userId || typeof who.name !== 'string' || !who.name.trim()) return fail(res, 401, 'Say who this is: onBehalfOf needs userId and name.');
  if (!Array.isArray(who.can) || who.can.some(c => typeof c !== 'string')) return fail(res, 401, 'onBehalfOf.can must list what this person may do.');
  next();
});

/** Link this boutique account to a shop (new boutique-only shop, or an existing one with the owner's code). */
router.post('/link', async (req, res) => {
  try {
    const p = pass(req);
    const r = await boutique.link({ tenant: p.tenant, shopName: req.body?.shopName, linkCode: req.body?.linkCode });
    res.status(r.linked === 'new' ? 201 : 200).json({ success: true, data: r });
  } catch (e: any) { if (e?.statusCode) return fail(res, e.statusCode, e.message); return respondWithError(res, e, { status: 500 }); }
});

/*
 * A boutique-only client asks to join ScaleEzy Inventory (16 Nov). Before the "linked shop" gate: a client can ask
 * whether or not it was ever linked. The account comes from the pass, never the body; ScaleEzy accepts or declines in
 * the Platform Console.
 */
const joinFail = (res: Response, e: any) => (e instanceof join.JoinError
  ? fail(res, e.statusCode, e.message)
  : respondWithError(res, e, { status: 500 }));
router.post('/join-request', async (req, res) => {
  try {
    const p = pass(req);
    const r = await join.ask(p.tenant, p.onBehalfOf?.name ?? null, req.body ?? {});
    res.status(r.already ? 200 : 201).json({ success: true, data: r });
  } catch (e) { joinFail(res, e); }
});
router.get('/join-request', async (req, res) => {
  try { res.json({ success: true, data: await join.statusFor(pass(req).tenant) }); } catch (e) { joinFail(res, e); }
});
router.delete('/join-request', async (req, res) => {
  try { res.json({ success: true, data: await join.cancel(pass(req).tenant) }); } catch (e) { joinFail(res, e); }
});

/** Everything else: the linked shop, and the person. */
router.use(async (req: Request, res: Response, next: NextFunction) => {
  try {
    const p = pass(req);
    const clientId = await boutique.linkedShop(p.tenant!);
    if (p.clientId && p.clientId !== clientId) return fail(res, 403, 'This pass is for another shop.');
    if (await platformAdminService.isClientSuspended(clientId)) return fail(res, 403, 'ScaleEzy has paused this shop. Contact ScaleEzy.');
    (req as any).boutiqueActor = { clientId, name: p.onBehalfOf!.name!.trim().slice(0, 80), can: p.onBehalfOf!.can!.filter(c => KNOWN_CAN.includes(c)) } satisfies Actor;
    next();
  } catch (e: any) { if (e?.statusCode) return fail(res, e.statusCode, e.message); return respondWithError(res, e, { status: 500 }); }
});

const read = (fn: (req: Request) => Promise<unknown>) => async (req: Request, res: Response) => {
  try { res.json({ success: true, data: await fn(req) }); }
  catch (e: any) { if (e?.statusCode) return fail(res, e.statusCode, e.message); return respondWithError(res, e, { status: 500 }); }
};
const write = (fn: (tx: boutique.Db, actor: Actor, req: Request) => Promise<{ status: number; answer: unknown }>) => async (req: Request, res: Response) => {
  try {
    const a = actorOf(req);
    const r = await boutique.once(a.clientId, requestIdOf(req), tx => fn(tx, a, req));
    res.status(r.status).set('Idempotent-Replay', r.repeat ? 'true' : 'false').json(r.answer);
  } catch (e: any) { if (e?.statusCode) return fail(res, e.statusCode, e.message); return respondWithError(res, e, { status: 500 }); }
};

// ── reading ──────────────────────────────────────────────────────────────────────────────────────
router.get('/stores', read(req => extra.listStores(actorOf(req), req.query as any)));
router.get('/stores/:id/items', read(req => extra.itemsAt(actorOf(req), String(req.params.id), req.query as any)));
router.get('/items', read(req => boutique.listItems(actorOf(req), req.query as any)));
// Fixed paths before /items/:itemCode, so they are not read as item codes.
router.get('/items/next-code', read(req => extra.nextCode(actorOf(req), req.query.prefix)));
router.get('/items/groups', read(req => extra.itemGroups(actorOf(req))));
router.post('/items/lookup', read(req => extra.lookupItems(actorOf(req), req.body?.itemCodes)));
router.get('/alerts', read(req => extra.alerts(actorOf(req))));
router.get('/movements', read(req => extra.listMovements(actorOf(req), req.query as any)));
router.get('/changes', read(req => extra.changes(actorOf(req), req.query as any)));
router.post('/availability', read(req => extra.availability(actorOf(req), req.body ?? {})));
router.post('/photos', read(req => extra.photoUploads(actorOf(req), req.body ?? {})));
router.get('/items/:itemCode', read(async req => {
  const r = await boutique.listItems(actorOf(req), { itemCode: req.params.itemCode, limit: 1 });
  if (!r.items.length) throw Object.assign(new Error(`No item ${req.params.itemCode} in this shop.`), { statusCode: 404 });
  return r.items[0];
}));
router.get('/items/:itemCode/history', read(req => boutique.history(actorOf(req), String(req.params.itemCode), Number(req.query.limit) || 50)));

router.post('/stores', write((tx, a, req) => boutique.addStore(tx, a, req.body ?? {})));
router.put('/stores/:id', write((tx, a, req) => extra.updateStore(tx, a, String(req.params.id), req.body ?? {})));
router.delete('/stores/:id', write((tx, a, req) => extra.removeStore(tx, a, String(req.params.id))));

// ── items ────────────────────────────────────────────────────────────────────────────────────────
router.put('/items/:itemCode', write((tx, a, req) => withOpening(tx, a, { ...(req.body ?? {}), itemCode: req.params.itemCode })));
router.delete('/items/:itemCode', write((tx, a, req) => boutique.archiveItem(tx, a, String(req.params.itemCode))));

/**
 * Many items at once (a first load, up to 200). Each row lands or is refused on its own; a row's id is the
 * request id plus its place, so sending the same batch again changes nothing.
 */
router.post('/items/import', async (req, res) => {
  try {
    const a = actorOf(req);
    const base = String(requestIdOf(req) ?? '');
    if (!/^[A-Za-z0-9._:-]{8,90}$/.test(base)) return fail(res, 400, 'Give the import a request id (8 to 90 letters, numbers, dots, dashes or colons).');
    const items = Array.isArray(req.body?.items) ? req.body.items : null;
    if (!items || !items.length || items.length > 200) return fail(res, 400, 'Send 1 to 200 items as "items".');
    const results: { row: number; itemCode: unknown; ok: boolean; message?: string }[] = [];
    for (let i = 0; i < items.length; i++) {
      try {
        const r = await boutique.once(a.clientId, `${base}:${i}`, tx => withOpening(tx, a, items[i] ?? {}));
        results.push({ row: i + 1, itemCode: items[i]?.itemCode, ok: (r.answer as any)?.success === true });
      } catch (e: any) {
        if (!e?.statusCode) throw e;
        results.push({ row: i + 1, itemCode: items[i]?.itemCode, ok: false, message: e.message });
      }
    }
    res.json({ success: true, data: { added: results.filter(r => r.ok).length, refused: results.filter(r => !r.ok).length, results } });
  } catch (e: any) { if (e?.statusCode) return fail(res, e.statusCode, e.message); return respondWithError(res, e, { status: 500 }); }
});

/**
 * An item, and for a NEW item its opening stock (openingStock: [{ quantity, locationId? }]) in the same step, so an
 * item never exists without the stock it was created with. For an item that already exists the opening stock is
 * not added again (a second import of the same list) and the answer says so.
 */
async function withOpening(tx: boutique.Db, a: Actor, row: any) {
  const r = await boutique.upsertItem(tx, a, row);
  // supplierId: the item's supplier (null clears it); left out keeps it.
  if (row?.supplierId !== undefined) await buying.setItemSupplier(tx, a, String(row.itemCode), row.supplierId);
  const opening = row?.openingStock;
  if (opening == null) return r;
  if (!Array.isArray(opening) || opening.length > 20) throw Object.assign(new Error('openingStock is a list of up to 20 { quantity, locationId }.'), { statusCode: 400 });
  if (r.status !== 201) return { ...r, answer: { ...(r.answer as any), data: { ...(r.answer as any).data, openingStock: 'not added: the item already existed' } } };
  for (const o of opening) await boutique.move(tx, a, { itemCode: row.itemCode, kind: 'OPENING_STOCK', quantity: o?.quantity, locationId: o?.locationId });
  // Read inside this transaction: the stock just added is not committed yet.
  const v = await tx.productVariant.findFirst({ where: { clientId: a.clientId, boutiqueRef: String(row.itemCode) }, include: { product: { select: { soldBy: true } } } });
  const sum = await tx.inventoryStock.aggregate({ where: { variantId: v!.id }, _sum: { quantity: true } });
  return { ...r, answer: { ...(r.answer as any), data: { ...(r.answer as any).data, stock: (sum._sum.quantity ?? 0) / factorOf(v!.product.soldBy as any) } } };
}

// ── stock ────────────────────────────────────────────────────────────────────────────────────────
router.post('/movements', write((tx, a, req) => boutique.move(tx, a, req.body ?? {})));
router.post('/counts', write((tx, a, req) => boutique.count(tx, a, req.body ?? {})));
router.post('/transfers', write((tx, a, req) => boutique.transfer(tx, a, req.body ?? {})));

// ── cloth held for a stitching order ─────────────────────────────────────────────────────────────
router.post('/holds', write((tx, a, req) => boutique.reserve(tx, a, req.body ?? {})));
router.post('/holds/order', write((tx, a, req) => extra.holdOrder(tx, a, req.body ?? {})));
router.post('/holds/release-order', write((tx, a, req) => extra.releaseOrder(tx, a, req.body ?? {})));
router.post('/holds/:id/release', write((tx, a, req) => boutique.release(tx, a, { reservationId: req.params.id, quantity: req.body?.quantity })));
router.post('/holds/:id/issue', write((tx, a, req) => boutique.issueHeld(tx, a, { reservationId: req.params.id, quantity: req.body?.quantity, releaseRest: req.body?.releaseRest })));
router.get('/holds', read(async req => {
  const a = actorOf(req);
  const orderRef = req.query.orderRef ? String(req.query.orderRef) : undefined;
  const rows = await prisma.boutiqueReservation.findMany({ where: { clientId: a.clientId, ...(orderRef ? { orderRef } : {}), status: req.query.all ? undefined : 'ACTIVE' }, orderBy: { createdAt: 'desc' }, take: 200 });
  const variants = await prisma.productVariant.findMany({ where: { id: { in: rows.map(r => r.variantId) } }, include: { product: { select: { soldBy: true, title: true } } } });
  const byId = new Map(variants.map(v => [v.id, v]));
  return rows.map(r => { const v = byId.get(r.variantId); const f = factorOf((v?.product.soldBy ?? 'PIECE') as any); return { reservationId: r.id, itemCode: v?.boutiqueRef, name: v?.product.title, orderRef: r.orderRef, quantity: r.quantity / f, status: r.status, by: r.actorName, at: r.createdAt }; });
}));

// ── suppliers and purchase orders (CRM-B checklist section 4) ─────────────────────────────────────
router.get('/suppliers', read(req => buying.listSuppliers(actorOf(req), req.query as any)));
router.get('/suppliers/performance', read(req => buying.supplierPerformance(actorOf(req), req.query.supplierId ? String(req.query.supplierId) : undefined)));
router.post('/suppliers', write((tx, a, req) => buying.addSupplier(tx, a, req.body ?? {})));
router.put('/suppliers/:id', write((tx, a, req) => buying.changeSupplier(tx, a, String(req.params.id), req.body ?? {})));
router.get('/purchase-orders', read(req => buying.listOrders(actorOf(req), req.query as any)));
router.get('/purchase-orders/:id', read(req => buying.getOrder(actorOf(req), String(req.params.id))));
/**
 * Purchase orders run on the shop's own purchase-order code, which keeps its own transactions; the request ledger
 * (once) still holds the id, so a retry gets the first answer and makes no second order or receipt.
 */
const viaLedger = (fn: (a: Actor, req: Request, key: string) => Promise<unknown>, status = 200) => async (req: Request, res: Response) => {
  try {
    const a = actorOf(req);
    const key = String(requestIdOf(req) ?? '');
    const r = await boutique.once(a.clientId, key, async () => ({ status, answer: { success: true, data: await fn(a, req, key) } }));
    res.status(r.status).set('Idempotent-Replay', r.repeat ? 'true' : 'false').json(r.answer);
  } catch (e: any) { if (e?.statusCode) return fail(res, e.statusCode, e.message); return respondWithError(res, e, { status: 500 }); }
};
router.post('/purchase-orders', viaLedger((a, req) => buying.createOrder(a, req.body ?? {}), 201));
router.put('/purchase-orders/:id', viaLedger((a, req) => buying.changeOrder(a, String(req.params.id), req.body ?? {})));
router.post('/purchase-orders/:id/receive', viaLedger((a, req, key) => buying.receiveOrder(a, String(req.params.id), req.body ?? {}, key)));
// ── reports (CRM-B checklist section 9): each needs reports:view ───────────────────────────────────
router.get('/reports/purchase-spend', read(req => { reports.mustReport(actorOf(req)); return buying.purchaseSpend(actorOf(req), req.query as any); }));
router.get('/reports/stock-summary', read(req => reports.stockSummary(actorOf(req), req.query as any)));
router.get('/reports/low-stock', read(req => reports.lowStock(actorOf(req))));
router.get('/reports/consumption', read(req => reports.consumption(actorOf(req), req.query as any)));
router.get('/reports/loss-rates', read(req => reports.lossRates(actorOf(req), req.query as any)));
router.get('/reports/cost-per-order', read(req => reports.costPerOrder(actorOf(req), req.query as any)));
router.get('/reports/order-usage', read(req => reports.orderUsage(actorOf(req), String(req.query.orderRef ?? ''))));
router.get('/reports/movement-summary', read(req => reports.movementSummary(actorOf(req), req.query as any)));
router.get('/reports/daybook', read(req => reports.daybook(actorOf(req), req.query as any)));
router.get('/reports/supplier-performance', read(req => { reports.mustReport(actorOf(req)); return buying.supplierPerformance(actorOf(req)); }));

// ── racks and shelves (CRM-B checklist section 3) ─────────────────────────────────────────────────
router.get('/stores/:id/spots', read(req => racks.tree(actorOf(req), String(req.params.id))));
router.get('/stores/:id/labels', read(req => racks.labels(actorOf(req), String(req.params.id), req.query.spotIds ? String(req.query.spotIds).split(',') : undefined)));
router.get('/stores/:id/not-shelved', read(req => racks.notShelved(actorOf(req), String(req.params.id), req.query.page)));
router.get('/stores/:id/count-queue', read(req => racks.countQueue(actorOf(req), String(req.params.id))));
router.get('/spots/scan', read(req => racks.scan(actorOf(req), req.query.code, req.query.locationId ? String(req.query.locationId) : undefined)));
router.get('/spots/:spotId', read(req => racks.onSpot(actorOf(req), String(req.params.spotId))));
router.get('/spots/:spotId/history', read(req => racks.spotHistory(actorOf(req), String(req.params.spotId))));
router.get('/where', read(req => racks.find(actorOf(req), req.query.search, req.query.locationId ? String(req.query.locationId) : undefined)));
router.get('/items/:itemCode/where', read(req => racks.whereIs(actorOf(req), String(req.params.itemCode), req.query.locationId ? String(req.query.locationId) : undefined)));
router.get('/shelf-problems', read(req => racks.problems(actorOf(req), req.query as any)));
// Shelf changes run on the shelves' own code and transactions; the request ledger still makes a retry land once.
router.post('/stores/:id/spots', viaLedger((a, req) => racks.addSpot(a, String(req.params.id), req.body ?? {}), 201));
router.post('/stores/:id/spots/bulk', viaLedger((a, req) => racks.addSpots(a, String(req.params.id), req.body ?? {})));
router.put('/spots/:spotId', viaLedger((a, req) => racks.changeSpot(a, String(req.params.spotId), req.body ?? {})));
router.delete('/spots/:spotId', viaLedger((a, req) => racks.removeSpot(a, String(req.params.spotId))));
router.post('/shelf-moves', viaLedger((a, req) => racks.moveOnShelves(a, req.body ?? {})));
router.post('/shelf-moves/whole-shelf', viaLedger((a, req) => racks.moveWholeShelf(a, req.body ?? {})));
router.post('/spots/:spotId/count', viaLedger((a, req) => racks.countShelf(a, String(req.params.spotId), req.body ?? {})));
router.post('/shelf-problems/:id/fix', viaLedger((a, req) => racks.fixProblem(a, String(req.params.id), req.body ?? {})));

export default router;
