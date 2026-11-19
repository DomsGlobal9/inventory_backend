import crypto from 'crypto';
import { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { normalisePhone } from '../../lib/phone';
import { counterCustomer } from '../customer.service';
import { removeForCrm } from '../customer-delete';
import { inboundSecret } from './config';
import type { CrmCustomer } from './client';
import { applyMerged, applyUnmerged } from './merges';

/**
 * ScaleEzy CRM telling Inventory what changed about a customer it owns (POST /api/v1/webhooks/crm/events).
 *
 *   { id, kind, clientId, subjectId, occurredAt, payload }
 *   X-CRM-Event-Id: <id>   X-CRM-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<raw body>">
 *
 * Checked before anything is read: the signature with the shared secret, and a time no more than five minutes
 * off. Each event is applied once (crm_inbound_events); one sent again is answered "already have it".
 * A 2xx means "received": CRM sends anything else again later, in order. So an event that cannot be applied
 * as it stands (a number another customer here holds) is still received, with the reason kept, and never
 * blocks the shop's later events.
 *
 * What CRM owns is who the person is: name, phone, email, birthday, anniversary. Addresses, GST number,
 * notes, points, credit and bills are Inventory's and are never touched here.
 */
const TOLERANCE_S = 300;

export type Reply = { status: number; body: Record<string, unknown> };
const say = (status: number, message: string, extra: Record<string, unknown> = {}): Reply => ({ status, body: { success: status < 300, message, ...extra } });

export function verifySignature(secret: string, header: string | undefined, raw: string, now = Math.floor(Date.now() / 1000)): { ok: true } | { ok: false; why: string } {
  if (!header) return { ok: false, why: 'missing signature' };
  const parts = Object.fromEntries(header.split(',').map(p => p.trim().split('=') as [string, string]).filter(p => p.length === 2));
  const t = Number(parts.t);
  if (!Number.isInteger(t) || !parts.v1) return { ok: false, why: 'signature not in the form t=…,v1=…' };
  if (Math.abs(now - t) > TOLERANCE_S) return { ok: false, why: 'signature too old or from the future' };
  const want = Buffer.from(crypto.createHmac('sha256', secret).update(`${t}.${raw}`).digest('hex'), 'utf8');
  const got = Buffer.from(String(parts.v1), 'utf8');
  if (want.length !== got.length || !crypto.timingSafeEqual(want, got)) return { ok: false, why: 'signature does not match' };
  return { ok: true };
}

/** The whole delivery: check, then apply once. Never throws; a 5xx asks CRM to send it again. */
export async function receive(raw: string, headers: { signature?: string; eventId?: string }): Promise<Reply> {
  const secret = inboundSecret();
  if (!secret) return say(503, 'Inventory is not set up to take ScaleEzy CRM events yet.');
  const v = verifySignature(secret, headers.signature, raw);
  if (!v.ok) return say(401, `The event's signature was not accepted: ${v.why}.`);
  let e: any;
  try { e = JSON.parse(raw); } catch { return say(400, 'The event is not JSON.'); }
  if (!e || typeof e.id !== 'string' || !e.id || typeof e.kind !== 'string' || typeof e.clientId !== 'string') {
    return say(400, 'An event needs id, kind and clientId.');
  }
  if (headers.eventId && headers.eventId !== e.id) return say(400, 'X-CRM-Event-Id does not match the event id.');
  if (await prisma.crmInboundEvent.findUnique({ where: { id: e.id }, select: { id: true } })) {
    return say(200, 'Already have this event.', { duplicate: true });
  }
  let outcome: string;
  let detail: Record<string, unknown> | undefined;
  try {
    const crmOn = await prisma.moduleSubscription.findUnique({ where: { clientId_module: { clientId: e.clientId, module: 'crm' } }, select: { clientId: true } });
    if (!crmOn) {
      outcome = 'crm-off';
    } else if (e.kind === 'customer.changed') {
      ({ outcome, detail } = await applyChanged(e.clientId, e.payload?.customer as CrmCustomer));
    } else if (e.kind === 'customer.removed') {
      // { customerId (CRM's), ids: [{ module, id }] (every module id they had), erased }; subjectId is CRM's id.
      const p = e.payload ?? {};
      const crmId = String(p.customerId ?? p.customer?.id ?? e.subjectId ?? '');
      const ids = Array.isArray(p.ids) ? p.ids : Array.isArray(p.customer?.ids) ? p.customer.ids : [];
      ({ outcome, detail } = await applyRemoved(e.clientId, { id: crmId, ids, removed: true } as unknown as CrmCustomer));
    } else if (e.kind === 'customer.merged') {
      const r = await applyMerged(e.clientId, e.id, String(e.payload?.from ?? e.subjectId), String(e.payload?.into ?? ''));
      outcome = r.outcome; detail = r as any;
    } else if (e.kind === 'customer.unmerged') {
      const r = await applyUnmerged(e.clientId, e.id, String(e.payload?.restored ?? e.subjectId), String(e.payload?.from ?? ''));
      outcome = r.outcome; detail = r as any;
    } else {
      outcome = 'ignored';
    }
  } catch (err) {
    console.error(`[crm-identity] event ${e.id} (${e.kind}) could not be applied; CRM will send it again.`, err);
    return say(500, 'Inventory could not apply this event just now. Send it again later.');
  }
  await prisma.crmInboundEvent.create({
    data: { id: e.id, clientId: e.clientId, kind: e.kind, subjectId: typeof e.subjectId === 'string' ? e.subjectId : null, outcome, detail: (detail ?? undefined) as any }
  }).catch(err => { if (err?.code !== 'P2002') throw err; });
  return say(200, 'Received.', { outcome });
}

type Applied = { outcome: string; detail?: Record<string, unknown> };
type Tx = Prisma.TransactionClient;

/** Inventory's live copies of this CRM customer: linked by CRM's id, or named by CRM as Inventory's ids. */
async function copiesFor(tx: Tx, clientId: string, c: CrmCustomer) {
  const linked = await tx.crmCustomerLink.findMany({ where: { clientId, crmCustomerId: c.id }, select: { customerId: true } });
  // CRM names Inventory's copies by the module's name; its token name is accepted too.
  const named = (c.ids ?? []).filter(i => (i.module === 'inventory' || i.module === 'scaleezy-inventory') && typeof i.id === 'string').map(i => i.id);
  const ids = [...new Set([...linked.map(l => l.customerId), ...named])];
  if (!ids.length) return [];
  return tx.customer.findMany({
    where: { clientId, id: { in: ids }, deletedAt: null },
    select: { id: true, name: true, phone: true, email: true, birthday: true, anniversary: true },
    orderBy: { createdAt: 'asc' }
  });
}

async function link(tx: Tx, clientId: string, customerId: string, crmId: string) {
  await tx.crmCustomerLink.upsert({
    where: { customerId },
    create: { customerId, clientId, crmCustomerId: crmId, linkedAt: new Date() },
    update: { crmCustomerId: crmId, linkedAt: new Date(), lastError: null }
  });
}

const DAY = /^\d{2}-\d{2}$/;

export async function applyChanged(clientId: string, c: CrmCustomer | undefined): Promise<Applied> {
  if (!c || typeof c.id !== 'string') return { outcome: 'ignored', detail: { why: 'no customer in the event' } };
  if (c.removed) return applyRemoved(clientId, c);
  if (c.mergedInto) return { outcome: 'merged-elsewhere' };
  const phone = c.phone ? normalisePhone(c.phone) : null;
  const goodPhone = phone && phone.ok ? phone.value : null;

  return prisma.$transaction(async tx => {
    // The number is locked for the length of this change, the same lock every other write of a number takes.
    if (goodPhone) await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`customer:${clientId}:${goodPhone}`}))`;
    let copies = await copiesFor(tx, clientId, c);
    let created = false;
    if (!copies.length && goodPhone) {
      const holder = await tx.customer.findFirst({ where: { clientId, phone: goodPhone, deletedAt: null }, select: { id: true } });
      if (holder) {
        copies = await tx.customer.findMany({ where: { id: holder.id }, select: { id: true, name: true, phone: true, email: true, birthday: true, anniversary: true } });
      } else {
        // Somebody added in CRM, or at a till that tells CRM directly: the shop's Inventory gets its copy.
        const made = await counterCustomer(tx, clientId, { phone: goodPhone, name: c.name || 'Customer', email: c.email ?? null });
        copies = await tx.customer.findMany({ where: { id: made.id }, select: { id: true, name: true, phone: true, email: true, birthday: true, anniversary: true } });
        created = true;
      }
    }
    if (!copies.length) return { outcome: 'no-copy', detail: { why: 'CRM customer without a phone that Inventory does not have' } };

    const notes: string[] = [];
    for (const copy of copies) {
      const data: Prisma.CustomerUpdateInput = {};
      if (c.name && c.name !== copy.name) data.name = c.name;
      if (c.email !== undefined && (c.email ?? null) !== copy.email) data.email = c.email ?? null;
      for (const k of ['birthday', 'anniversary'] as const) {
        const v = c[k];
        if (v === null && copy[k] !== null) data[k] = null;
        else if (typeof v === 'string' && DAY.test(v) && v !== copy[k]) data[k] = v;
      }
      if (goodPhone && goodPhone !== copy.phone) {
        const other = await tx.customer.findFirst({ where: { clientId, phone: goodPhone, deletedAt: null, id: { not: copy.id } }, select: { customerCode: true } });
        if (other) notes.push(`${goodPhone} is ${other.customerCode}'s here; kept ${copy.phone ?? 'no number'} until CRM joins them.`);
        else data.phone = goodPhone;
      }
      if (Object.keys(data).length) await tx.customer.update({ where: { id: copy.id }, data });
      await link(tx, clientId, copy.id, c.id);
    }
    return notes.length
      ? { outcome: 'phone-clash', detail: { notes } }
      : { outcome: created ? 'created' : 'applied', detail: { copies: copies.map(x => x.id) } };
  });
}

export async function applyRemoved(clientId: string, c: CrmCustomer): Promise<Applied> {
  const copies = await prisma.$transaction(tx => copiesFor(tx, clientId, c));
  if (!copies.length) return { outcome: 'nothing-here' };
  const results: Record<string, string> = {};
  let blocked = false;
  for (const copy of copies) {
    const r = await removeForCrm(clientId, copy.id);
    if (r.done) results[copy.id] = r.mode;
    else { results[copy.id] = r.why; blocked = true; }
  }
  return { outcome: blocked ? 'blocked' : 'removed', detail: results };
}
