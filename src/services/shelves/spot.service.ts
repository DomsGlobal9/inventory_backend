import crypto from 'crypto';
import { Prisma, StorageSpotKind } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { badRequest, conflict, notFound } from '../../utils/httpError';
import {
  compareWalk, expandCodes, joinAddress, labelPayload, MAX_BULK, MAX_DEPTH, newLabelCode,
  normaliseCode, parseLabel, walkKeys, normaliseAddress
} from './addresses';
import { BulkSpotsInput, CreateSpotInput, UpdateSpotInput } from './shelf.schema';

/**
 * A location's rack tree: areas, racks and cupboards, shelves, boxes. Setting it up, changing it,
 * taking it down, and the labels. Stock on the shelves is shelf-stock.service; the rule that keeps it
 * honest is legs.ts, inside every stock movement.
 */

const TX = { maxWait: 20000, timeout: 60000 } as const;
const pieces = (n: number) => `${n} ${n === 1 ? 'piece' : 'pieces'}`;

type SpotRow = Prisma.StorageSpotGetPayload<{}>;

async function locationOf(clientId: string, locationId: string) {
  const location = await prisma.stockLocation.findFirst({ where: { id: locationId, clientId }, select: { id: true, name: true, code: true, active: true, type: true } });
  if (!location) throw notFound('That location was not found.');
  return location;
}

async function spotOf(clientId: string, spotId: string, tx: Prisma.TransactionClient = prisma) {
  const spot = await tx.storageSpot.findFirst({ where: { id: spotId, clientId } });
  if (!spot) throw notFound('That shelf or rack was not found.');
  return spot;
}

/** Ids of a spot and everything under it, children after parents. */
async function subtreeIds(tx: Prisma.TransactionClient, clientId: string, root: SpotRow): Promise<SpotRow[]> {
  const all = await tx.storageSpot.findMany({ where: { clientId, locationId: root.locationId } });
  const byParent = new Map<string, SpotRow[]>();
  for (const s of all) if (s.parentId) byParent.set(s.parentId, [...(byParent.get(s.parentId) ?? []), s]);
  const out: SpotRow[] = [];
  const queue = [all.find(s => s.id === root.id) ?? root];
  while (queue.length) {
    const s = queue.shift()!;
    out.push(s);
    queue.push(...(byParent.get(s.id) ?? []));
  }
  return out;
}

async function uniqueLabelCodes(tx: Prisma.TransactionClient, clientId: string, count: number): Promise<string[]> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const codes = new Set<string>();
    while (codes.size < count) codes.add(newLabelCode());
    const taken = await tx.storageSpot.findMany({ where: { clientId, labelCode: { in: [...codes] } }, select: { labelCode: true } });
    if (taken.length === 0) return [...codes];
  }
  throw conflict('Could not make label codes just now. Try again.');
}

function explainUnique(error: any): never {
  if (error?.code === 'P2002') {
    const target = String(error?.meta?.target ?? '');
    if (target.includes('address')) throw conflict('That address is already used in this location. Choose another code.');
    throw conflict('Somebody saved this at the same moment. Refresh and try again.');
  }
  throw error;
}

function shapeSpot(s: SpotRow & { pieces?: number; items?: number }) {
  return {
    id: s.id, parentId: s.parentId, kind: s.kind, code: s.code, address: s.address, name: s.name,
    depth: s.depth, walkOrder: s.walkOrder, isShopFloor: s.isShopFloor, labelCode: s.labelCode,
    colour: s.colour, capacity: s.capacity, isTemporary: s.isTemporary, active: s.active,
    pieces: s.pieces ?? 0, items: s.items ?? 0
  };
}

export const spotService = {
  /** The whole tree of a location, in walking order, with how much each spot and its branch holds. */
  async tree(clientId: string, locationId: string) {
    const location = await locationOf(clientId, locationId);
    const [spots, stock] = await Promise.all([
      prisma.storageSpot.findMany({ where: { clientId, locationId } }),
      prisma.spotStock.groupBy({ by: ['spotId'], where: { clientId, locationId }, _sum: { quantity: true }, _count: { variantId: true } })
    ]);
    const held = new Map(stock.map(s => [s.spotId, { pieces: s._sum.quantity ?? 0, items: s._count.variantId }]));
    const keys = walkKeys(spots);
    type Node = ReturnType<typeof shapeSpot> & { branchPieces: number; children: Node[] };
    const nodes = new Map<string, Node>(spots.map(s => [s.id, { ...shapeSpot({ ...s, ...held.get(s.id) }), branchPieces: 0, children: [] }]));
    const roots: Node[] = [];
    const sorted = [...spots].sort((a, b) => compareWalk({ walkKey: keys.get(a.id)!, address: a.address }, { walkKey: keys.get(b.id)!, address: b.address }));
    for (const s of sorted) {
      const node = nodes.get(s.id)!;
      if (s.parentId && nodes.has(s.parentId)) nodes.get(s.parentId)!.children.push(node);
      else roots.push(node);
    }
    const sum = (n: Node): number => (n.branchPieces = n.pieces + n.children.reduce((t, c) => t + sum(c), 0));
    roots.forEach(sum);

    const official = await prisma.inventoryStock.aggregate({ where: { clientId, locationId }, _sum: { quantity: true } });
    const shelved = stock.reduce((t, s) => t + (s._sum.quantity ?? 0), 0);
    return {
      location,
      spots: roots,
      count: spots.length,
      pieces: { total: official._sum.quantity ?? 0, onShelves: shelved, notShelved: Math.max(0, (official._sum.quantity ?? 0) - shelved) }
    };
  },

  async create(clientId: string, locationId: string, input: CreateSpotInput, userId: string | null) {
    await locationOf(clientId, locationId);
    const code = normaliseCode(input.code);
    try {
      return await prisma.$transaction(async tx => {
        let parent: SpotRow | null = null;
        if (input.parentId) {
          // Locked, so nobody puts stock on the parent while a child is being added under it.
          await tx.$queryRaw`SELECT id FROM storage_spots WHERE id = ${input.parentId} FOR UPDATE`;
          parent = await tx.storageSpot.findFirst({ where: { id: input.parentId, clientId, locationId } });
          if (!parent) throw notFound('The rack or shelf to add this under was not found in this location.');
          if (parent.depth >= MAX_DEPTH) throw badRequest(`${parent.address} is already ${MAX_DEPTH} levels deep, so nothing more fits under it.`);
          const onIt = await tx.spotStock.aggregate({ where: { spotId: parent.id }, _sum: { quantity: true } });
          if ((onIt._sum.quantity ?? 0) > 0) {
            throw conflict(`${parent.address} holds ${pieces(onIt._sum.quantity ?? 0)}. Move them off it first, then add shelves or boxes inside it.`);
          }
        }
        if (input.isShopFloor !== undefined && parent) {
          throw badRequest('Shop floor or back room is set on the area, and everything inside it follows.');
        }
        const siblings = await tx.storageSpot.aggregate({ where: { clientId, locationId, parentId: parent?.id ?? null }, _max: { walkOrder: true } });
        const [labelCode] = await uniqueLabelCodes(tx, clientId, 1);
        const created = await tx.storageSpot.create({
          data: {
            clientId, locationId, parentId: parent?.id ?? null, kind: input.kind as StorageSpotKind, code,
            address: joinAddress(parent?.address ?? null, code),
            name: input.name?.trim() || null,
            depth: (parent?.depth ?? 0) + 1,
            walkOrder: input.walkOrder ?? (siblings._max.walkOrder ?? 0) + 10,
            isShopFloor: parent ? parent.isShopFloor : !!input.isShopFloor,
            labelCode,
            colour: input.colour?.trim() || null,
            capacity: input.capacity ?? null,
            isTemporary: !!input.isTemporary,
            createdBy: userId
          }
        });
        return shapeSpot(created);
      }, TX);
    } catch (error) {
      return explainUnique(error);
    }
  },

  /**
   * Quick create: "area STORE, racks R01-R20, shelves 1-5, boxes A-D" in one go. Spots that already
   * exist at an address are reused as parents and not made twice. With `preview`, nothing is saved.
   */
  async bulk(clientId: string, locationId: string, input: BulkSpotsInput, userId: string | null) {
    await locationOf(clientId, locationId);
    const levels = input.levels.map((l, i) => ({ kind: l.kind as StorageSpotKind, codes: expandCodes(l.range as any, `Level ${i + 1}`) }));

    const run = async (tx: Prisma.TransactionClient, save: boolean) => {
      let parent: SpotRow | null = null;
      if (input.parentId) {
        if (save) await tx.$queryRaw`SELECT id FROM storage_spots WHERE id = ${input.parentId} FOR UPDATE`;
        parent = await tx.storageSpot.findFirst({ where: { id: input.parentId, clientId, locationId } });
        if (!parent) throw notFound('The rack or shelf to add these under was not found in this location.');
      }
      if (parent && input.isShopFloor !== undefined) throw badRequest('Shop floor or back room is set on the area, and everything inside it follows.');
      if ((parent?.depth ?? 0) + levels.length > MAX_DEPTH) {
        throw badRequest(`That would be ${(parent?.depth ?? 0) + levels.length} levels deep. At most ${MAX_DEPTH}: area, rack, shelf, box.`);
      }

      let total = 1;
      for (const l of levels) total *= l.codes.length;
      if (total > MAX_BULK) throw badRequest(`That makes ${total} spots. At most ${MAX_BULK} at once: split it into smaller groups.`);

      const existing = await tx.storageSpot.findMany({ where: { clientId, locationId } });
      const byAddress = new Map(existing.map(s => [s.address, s]));
      const stocked = new Set((await tx.spotStock.findMany({ where: { clientId, locationId }, select: { spotId: true }, distinct: ['spotId'] })).map(s => s.spotId));

      type Planned = { id: string; parentId: string | null; kind: StorageSpotKind; code: string; address: string; depth: number; walkOrder: number; isShopFloor: boolean };
      const toCreate: Planned[] = [];
      const reused: string[] = [];
      const nextWalk = new Map<string, number>();
      const walkAfter = (parentId: string | null) => {
        const key = parentId ?? '__root__';
        if (!nextWalk.has(key)) {
          const max = existing.filter(s => s.parentId === parentId).reduce((m, s) => Math.max(m, s.walkOrder), 0);
          nextWalk.set(key, max);
        }
        const value = nextWalk.get(key)! + 10;
        nextWalk.set(key, value);
        return value;
      };

      let frontier: { id: string | null; address: string | null; depth: number; isShopFloor: boolean; stocked: boolean }[] =
        [{ id: parent?.id ?? null, address: parent?.address ?? null, depth: parent?.depth ?? 0, isShopFloor: parent?.isShopFloor ?? !!input.isShopFloor, stocked: parent ? stocked.has(parent.id) : false }];

      for (const level of levels) {
        const next: typeof frontier = [];
        for (const holder of frontier) {
          if (holder.stocked) throw conflict(`${holder.address} holds stock. Move it off first, then add shelves or boxes inside it.`);
          for (const code of level.codes) {
            const address = joinAddress(holder.address, code);
            const found = byAddress.get(address);
            if (found) {
              if (found.parentId !== holder.id) throw conflict(`${address} already exists somewhere else in this location.`);
              reused.push(address);
              next.push({ id: found.id, address, depth: found.depth, isShopFloor: found.isShopFloor, stocked: stocked.has(found.id) });
              continue;
            }
            const planned: Planned = {
              id: crypto.randomUUID(), parentId: holder.id, kind: level.kind, code, address,
              depth: holder.depth + 1, walkOrder: walkAfter(holder.id), isShopFloor: holder.isShopFloor
            };
            toCreate.push(planned);
            byAddress.set(address, { ...planned } as any);
            next.push({ id: planned.id, address, depth: planned.depth, isShopFloor: planned.isShopFloor, stocked: false });
          }
        }
        frontier = next;
      }

      if (toCreate.length > MAX_BULK) throw badRequest(`That makes ${toCreate.length} spots. At most ${MAX_BULK} at once.`);
      const preview = { create: toCreate.length, alreadyThere: reused.length, addresses: toCreate.slice(0, 50).map(p => p.address), more: Math.max(0, toCreate.length - 50) };
      if (!save || toCreate.length === 0) return { ...preview, saved: false };

      const labels = await uniqueLabelCodes(tx, clientId, toCreate.length);
      // Parents are always planned before their children, and createMany keeps the order.
      await tx.storageSpot.createMany({
        data: toCreate.map((p, i) => ({
          id: p.id, clientId, locationId, parentId: p.parentId, kind: p.kind, code: p.code, address: p.address,
          depth: p.depth, walkOrder: p.walkOrder, isShopFloor: p.isShopFloor, labelCode: labels[i], createdBy: userId
        }))
      });
      return { ...preview, saved: true };
    };

    if (input.preview) return run(prisma, false);
    try {
      return await prisma.$transaction(tx => run(tx, true), TX);
    } catch (error) {
      return explainUnique(error);
    }
  },

  async update(clientId: string, spotId: string, input: UpdateSpotInput, userId: string | null) {
    try {
      return await prisma.$transaction(async tx => {
        const spot = await spotOf(clientId, spotId, tx);
        const branch = await subtreeIds(tx, clientId, spot);
        // Everything in the branch is locked: no put-away can land on it while it changes.
        await tx.$queryRaw`SELECT id FROM storage_spots WHERE id IN (${Prisma.join(branch.map(b => b.id))}) FOR UPDATE`;
        const branchStock = await tx.spotStock.aggregate({ where: { spotId: { in: branch.map(b => b.id) } }, _sum: { quantity: true } });
        const held = branchStock._sum.quantity ?? 0;

        const data: Prisma.StorageSpotUpdateInput = {};
        if (input.name !== undefined) data.name = input.name?.trim() || null;
        if (input.walkOrder !== undefined) data.walkOrder = input.walkOrder;
        if (input.colour !== undefined) data.colour = input.colour?.trim() || null;
        if (input.capacity !== undefined) data.capacity = input.capacity;
        if (input.isTemporary !== undefined) data.isTemporary = input.isTemporary;
        if (input.kind !== undefined) data.kind = input.kind as StorageSpotKind;

        if (input.active === false && spot.active) {
          if (held > 0) throw conflict(`${spot.address} ${branch.length > 1 ? 'and what is inside it hold' : 'holds'} ${pieces(held)}. Move ${held === 1 ? 'it' : 'them'} first, then switch it off.`);
          await tx.storageSpot.updateMany({ where: { id: { in: branch.map(b => b.id) } }, data: { active: false } });
        }
        if (input.active === true && !spot.active) {
          if (spot.parentId) {
            const parent = await tx.storageSpot.findUnique({ where: { id: spot.parentId }, select: { active: true, address: true } });
            if (parent && !parent.active) throw badRequest(`${parent.address} is switched off. Switch that on first.`);
          }
          data.active = true;
        }

        if (input.isShopFloor !== undefined && input.isShopFloor !== spot.isShopFloor) {
          if (spot.parentId) throw badRequest('Shop floor or back room is set on the area, and everything inside it follows.');
          await tx.storageSpot.updateMany({ where: { id: { in: branch.map(b => b.id) } }, data: { isShopFloor: input.isShopFloor } });
        }

        if (input.code !== undefined) {
          const code = normaliseCode(input.code);
          if (code !== spot.code) {
            const parentAddress = spot.parentId ? spot.address.slice(0, spot.address.length - spot.code.length - 1) : null;
            const newRoot = joinAddress(parentAddress, code);
            const renamed = branch.map(b => ({ id: b.id, old: b.address, next: newRoot + b.address.slice(spot.address.length) }));
            const clash = await tx.storageSpot.findFirst({
              where: { clientId, locationId: spot.locationId, address: { in: renamed.map(r => r.next) }, id: { notIn: branch.map(b => b.id) } },
              select: { address: true }
            });
            if (clash) throw conflict(`${clash.address} already exists in this location. Choose another code.`);
            // Old addresses out of the way first, so a swap within the branch cannot collide.
            for (const r of renamed) await tx.storageSpot.update({ where: { id: r.id }, data: { address: `TMP${r.id.replace(/-/g, '').slice(0, 9).toUpperCase()}` } });
            for (const r of renamed) await tx.storageSpot.update({ where: { id: r.id }, data: { address: r.next, ...(r.id === spot.id ? { code } : {}) } });
            await tx.storageSpotAddressChange.createMany({
              data: renamed.map(r => ({ clientId, spotId: r.id, oldAddress: r.old, newAddress: r.next, changedBy: userId }))
            });
            // Legs and issues keep the address they were written with: history says where it was then.
          }
        }

        if (Object.keys(data).length > 0) await tx.storageSpot.update({ where: { id: spot.id }, data });
        const saved = await tx.storageSpot.findUniqueOrThrow({ where: { id: spot.id } });
        return shapeSpot(saved);
      }, TX);
    } catch (error) {
      return explainUnique(error);
    }
  },

  /** Removes a spot and everything under it. Only when all of it is empty. */
  async remove(clientId: string, spotId: string) {
    return prisma.$transaction(async tx => {
      const spot = await spotOf(clientId, spotId, tx);
      const branch = await subtreeIds(tx, clientId, spot);
      await tx.$queryRaw`SELECT id FROM storage_spots WHERE id IN (${Prisma.join(branch.map(b => b.id))}) FOR UPDATE`;
      const held = await tx.spotStock.aggregate({ where: { spotId: { in: branch.map(b => b.id) } }, _sum: { quantity: true } });
      if ((held._sum.quantity ?? 0) > 0) {
        throw conflict(`${spot.address} ${branch.length > 1 ? 'and what is inside it hold' : 'holds'} ${pieces(held._sum.quantity ?? 0)}. Move ${(held._sum.quantity ?? 0) === 1 ? 'it' : 'them'} to another shelf first.`);
      }
      // Deepest first: a parent cannot go while a child still points at it.
      for (let depth = MAX_DEPTH; depth >= spot.depth; depth--) {
        const ids = branch.filter(b => b.depth === depth).map(b => b.id);
        if (ids.length) await tx.storageSpot.deleteMany({ where: { id: { in: ids } } });
      }
      return { removed: branch.length, address: spot.address };
    }, TX);
  },

  /** A scanned label, or an address typed for a location. */
  async resolve(clientId: string, raw: string, locationId?: string) {
    const labelCode = parseLabel(raw);
    if (labelCode) {
      const spot = await prisma.storageSpot.findFirst({ where: { clientId, labelCode } });
      if (spot) return spot;
    }
    const address = normaliseAddress(raw);
    if (address && locationId) {
      const spot = await prisma.storageSpot.findFirst({ where: { clientId, locationId, address } });
      if (spot) return spot;
      // The same address typed while standing in the wrong store: "no shelf matches that" sends
      // someone looking for a label that is fine. Name the store it belongs to instead.
      const elsewhere = await prisma.storageSpot.findFirst({
        where: { clientId, address },
        include: { location: { select: { name: true } } }
      });
      if (elsewhere) throw notFound(`${elsewhere.address} is in ${elsewhere.location?.name ?? 'another store'}, not here.`);
    }
    throw notFound('No shelf matches that label or address.');
  },

  async history(clientId: string, spotId: string) {
    await spotOf(clientId, spotId);
    return prisma.storageSpotAddressChange.findMany({ where: { clientId, spotId }, orderBy: { changedAt: 'desc' }, take: 50 });
  },

  /**
   * Addresses from a spreadsheet, one row each: FLOOR-C2-1, name, colour, capacity, shop floor. Parents
   * that do not exist are made on the way (area, rack, shelf, box by depth), rows keep their order as
   * the walking order, and nothing is saved unless every row is valid.
   */
  async importRows(clientId: string, locationId: string, rows: unknown, preview: boolean, userId: string | null) {
    await locationOf(clientId, locationId);
    if (!Array.isArray(rows) || rows.length === 0) throw badRequest('The file has no rows.');
    if (rows.length > MAX_BULK) throw badRequest(`At most ${MAX_BULK} rows at once. Split the file.`);
    const KINDS = new Set(Object.values(StorageSpotKind));
    const DEFAULT_KIND: StorageSpotKind[] = ['AREA', 'RACK', 'SHELF', 'BOX'];
    const errors: { row: number; message: string }[] = [];
    type Row = { row: number; address: string; kind?: StorageSpotKind; name?: string | null; colour?: string | null; capacity?: number | null; shopFloor?: boolean };
    const parsed: Row[] = [];
    const seenRows = new Set<string>();
    rows.forEach((raw: any, i) => {
      const row = i + 1;
      const address = normaliseAddress(raw?.address);
      if (!address) { errors.push({ row, message: `"${String(raw?.address ?? '').slice(0, 40)}" is not an address. Use up to 4 parts of letters and digits joined by "-", such as FLOOR-C2-1.` }); return; }
      if (seenRows.has(address)) { errors.push({ row, message: `${address} is listed twice.` }); return; }
      seenRows.add(address);
      const kindText = typeof raw?.kind === 'string' && raw.kind.trim() ? raw.kind.trim().toUpperCase().replace(/[\s-]+/g, '_') : undefined;
      if (kindText && !KINDS.has(kindText as StorageSpotKind)) { errors.push({ row, message: `"${raw.kind}" is not a kind. Use area, rack, cupboard, shelf, box, stack, bundle, rail, rail section, counter, drawer, display, trunk or other.` }); return; }
      const capacity = raw?.capacity === undefined || raw?.capacity === null || raw?.capacity === '' ? null : Number(raw.capacity);
      if (capacity !== null && (!Number.isInteger(capacity) || capacity < 1 || capacity > 100000)) { errors.push({ row, message: 'Capacity is a whole number of pieces, at least 1.' }); return; }
      const name = typeof raw?.name === 'string' ? raw.name.trim().slice(0, 80) || null : null;
      const colour = typeof raw?.colour === 'string' ? raw.colour.trim().slice(0, 24) || null : null;
      const sf = typeof raw?.shopFloor === 'boolean' ? raw.shopFloor
        : typeof raw?.shopFloor === 'string' && raw.shopFloor.trim() ? /^(y|yes|true|1|floor|shop floor)$/i.test(raw.shopFloor.trim()) : undefined;
      parsed.push({ row, address, kind: kindText as StorageSpotKind | undefined, name, colour, capacity, shopFloor: sf });
    });

    const existing = await prisma.storageSpot.findMany({ where: { clientId, locationId } });
    const byAddress = new Map(existing.map(s => [s.address, s]));
    const stocked = new Set((await prisma.spotStock.findMany({ where: { clientId, locationId }, select: { spotId: true }, distinct: ['spotId'] })).map(s => s.spotId));

    // Shop floor belongs to the area; rows under one new area must agree.
    const areaFloor = new Map<string, { value: boolean; row: number }>();
    for (const r of parsed) {
      if (r.shopFloor === undefined) continue;
      const area = r.address.split('-')[0];
      const existingArea = byAddress.get(area);
      if (existingArea && existingArea.isShopFloor !== r.shopFloor) { errors.push({ row: r.row, message: `${area} already exists as ${existingArea.isShopFloor ? 'shop floor' : 'back room'}. Change it on the area instead.` }); continue; }
      const seen = areaFloor.get(area);
      if (seen && seen.value !== r.shopFloor) { errors.push({ row: r.row, message: `Rows under ${area} disagree about shop floor (see row ${seen.row}).` }); continue; }
      areaFloor.set(area, { value: r.shopFloor, row: r.row });
    }

    type Planned = { id: string; parentId: string | null; parentAddress: string | null; kind: StorageSpotKind; code: string; address: string; depth: number; walkOrder: number; isShopFloor: boolean; name: string | null; colour: string | null; capacity: number | null };
    const planned = new Map<string, Planned>();
    const alreadyThere: string[] = [];
    const nextWalk = new Map<string, number>();
    const walkAfter = (parentKey: string, parentId: string | null) => {
      if (!nextWalk.has(parentKey)) nextWalk.set(parentKey, existing.filter(s => s.parentId === parentId).reduce((m, s) => Math.max(m, s.walkOrder), 0));
      const v = nextWalk.get(parentKey)! + 10;
      nextWalk.set(parentKey, v);
      return v;
    };
    for (const r of parsed) {
      const parts = r.address.split('-');
      if (byAddress.has(r.address)) { alreadyThere.push(r.address); continue; }
      for (let depth = 1; depth <= parts.length; depth++) {
        const address = parts.slice(0, depth).join('-');
        if (byAddress.has(address) || planned.has(address)) continue;
        const parentAddress = depth === 1 ? null : parts.slice(0, depth - 1).join('-');
        const parentExisting = parentAddress ? byAddress.get(parentAddress) : null;
        if (parentExisting && stocked.has(parentExisting.id)) { errors.push({ row: r.row, message: `${parentAddress} holds stock, so nothing can be placed under it.` }); break; }
        const leaf = depth === parts.length;
        const area = parts[0];
        const isShopFloor = byAddress.get(area)?.isShopFloor ?? areaFloor.get(area)?.value ?? false;
        planned.set(address, {
          id: crypto.randomUUID(), parentId: parentExisting?.id ?? null, parentAddress, code: parts[depth - 1], address, depth,
          kind: leaf && r.kind ? r.kind : DEFAULT_KIND[depth - 1],
          walkOrder: walkAfter(parentAddress ?? '__root__', parentExisting?.id ?? null),
          isShopFloor, name: leaf ? r.name ?? null : null, colour: leaf ? r.colour ?? null : null, capacity: leaf ? r.capacity ?? null : null
        });
      }
    }
    // Parents planned in this same file: link by address.
    for (const p of planned.values()) if (!p.parentId && p.parentAddress) p.parentId = planned.get(p.parentAddress)?.id ?? byAddress.get(p.parentAddress)?.id ?? null;

    const list = [...planned.values()].sort((a, b) => a.depth - b.depth);
    const summary = {
      create: list.length, alreadyThere: alreadyThere.length, errors: errors.sort((a, b) => a.row - b.row).slice(0, 100),
      addresses: list.slice(0, 50).map(p => p.address), more: Math.max(0, list.length - 50),
      areas: [...new Set(list.filter(p => p.depth === 1).map(p => `${p.address}: ${p.isShopFloor ? 'shop floor' : 'back room'}`))]
    };
    if (errors.length > 0 || preview || list.length === 0) return { ...summary, saved: false };
    if (list.length > MAX_BULK) throw badRequest(`That makes ${list.length} spots. At most ${MAX_BULK} at once.`);

    try {
      await prisma.$transaction(async tx => {
        const labels = await uniqueLabelCodes(tx, clientId, list.length);
        await tx.storageSpot.createMany({
          data: list.map((p, i) => ({
            id: p.id, clientId, locationId, parentId: p.parentId, kind: p.kind, code: p.code, address: p.address, depth: p.depth,
            walkOrder: p.walkOrder, isShopFloor: p.isShopFloor, labelCode: labels[i], name: p.name, colour: p.colour, capacity: p.capacity, createdBy: userId
          }))
        });
      }, TX);
    } catch (error) {
      return explainUnique(error);
    }
    return { ...summary, saved: true };
  },

  /** What a sheet of labels needs: the QR payload, the address, the name, the location. */
  async labels(clientId: string, locationId: string, spotIds?: string[]) {
    const location = await locationOf(clientId, locationId);
    const spots = await prisma.storageSpot.findMany({
      where: { clientId, locationId, active: true, ...(spotIds?.length ? { id: { in: spotIds } } : {}) }
    });
    const keys = walkKeys(spots);
    return spots
      .sort((a, b) => compareWalk({ walkKey: keys.get(a.id)!, address: a.address }, { walkKey: keys.get(b.id)!, address: b.address }))
      .map(s => ({ id: s.id, address: s.address, name: s.name, kind: s.kind, colour: s.colour, labelCode: s.labelCode, qr: labelPayload(s.labelCode), location: location.name }));
  }
};
