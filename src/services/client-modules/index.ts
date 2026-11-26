import { prisma } from '../../lib/prisma';
import { moduleSubscriptions } from '../module-outbox';

/**
 * One-switch onboarding (26 Nov 2026, the owner; PLAN-onboarding-modules.md, agreed with CRM and POS).
 *
 * ONE record of which ScaleEzy modules a client has (client_modules), written by every door: the Console's Modules
 * box, the boutique API, the shop's own Logistics switch. On every change:
 *   1. the module's own switch runs first, and may refuse (a boutique account to link, parcels still out...);
 *   2. the change is recorded and the client's version goes up by one;
 *   3. Inventory's feeds follow (CRM gets Inventory's change feed only while CRM AND Inventory are on);
 *   4. every module with a door (POS, CRM) that the client has ON is told the whole picture (connect), and one switched
 *      OFF is told it is off (disconnect), through module_connects, retried until it answers (./connect.ts).
 * Modules never guess from each other: they read the picture sent, and ignore an older version than they applied.
 */
export const MODULES = ['inventory', 'pos', 'crm', 'boutique', 'logistics'] as const;
export type Module = typeof MODULES[number];
export const LABEL: Record<Module, string> = { inventory: 'Inventory', pos: 'POS', crm: 'CRM', boutique: 'Boutique', logistics: 'Logistics' };
/** Modules Inventory calls with the picture. Boutique (another team's app) and Logistics are read from Inventory's side. */
export const DOORS: readonly Module[] = ['pos', 'crm'];

export class ModulesError extends Error { constructor(public statusCode: number, message: string) { super(message); } }
const isModule = (m: unknown): m is Module => typeof m === 'string' && (MODULES as readonly string[]).includes(m);

export type By = { userId: string; name?: string | null } | null;
export type Source = 'console' | 'boutique-api' | 'pos-setup' | 'shop' | 'backfill';

/** The client's modules now: every module named (off when never set), its version, and its name. */
export async function state(clientId: string) {
  const [client, rows] = await Promise.all([
    prisma.platformClient.findUnique({ where: { clientId } }),
    prisma.clientModule.findMany({ where: { clientId } })
  ]);
  // Inventory never recorded counts as on (every client before 26 Nov); every other module, off.
  const on = Object.fromEntries(MODULES.map(m => { const r = rows.find(x => x.module === m); return [m, r ? r.on : m === 'inventory']; })) as Record<Module, boolean>;
  return {
    clientId, name: client?.name ?? clientId, version: client?.version ?? 0, on,
    modules: MODULES.filter(m => on[m]),
    since: Object.fromEntries(rows.map(r => [r.module, { on: r.on, changedAt: r.changedAt, changedBy: r.changedBy, source: r.source }]))
  };
}

/** The client as the platform knows it (made once, the name kept up to date). */
export async function ensureClient(clientId: string, name: string, by: By = null) {
  return prisma.platformClient.upsert({
    where: { clientId },
    create: { clientId, name: name.slice(0, 200) || clientId, createdBy: by?.userId ?? null },
    update: name ? { name: name.slice(0, 200) } : {}
  });
}

/** Is the Inventory app on for this client? A client never recorded counts as on (everyone before 26 Nov). */
const inventoryCache = new Map<string, { on: boolean; at: number }>();
export async function inventoryOn(clientId: string) {
  const hit = inventoryCache.get(clientId);
  if (hit && Date.now() - hit.at < 15_000) return hit.on;
  const row = await prisma.clientModule.findUnique({ where: { clientId_module: { clientId, module: 'inventory' } }, select: { on: true } });
  const on = row ? row.on : true;
  inventoryCache.set(clientId, { on, at: Date.now() });
  return on;
}
/** Is this module on for the client? (Not recorded: false, except Inventory, see inventoryOn.) */
export async function isOn(clientId: string, module: Module) {
  if (module === 'inventory') return inventoryOn(clientId);
  return (await prisma.clientModule.findUnique({ where: { clientId_module: { clientId, module } }, select: { on: true } }))?.on === true;
}

export type Change = {
  /** { pos: true, crm: false, ... }: only the modules to change. */
  modules: Partial<Record<Module, boolean>>;
  by: By;
  source: Source;
  /** Boutique switched on: the Boutique app account to link, and whether it runs the whole shop. */
  boutique?: { tenant?: string | null; handOver?: boolean } | null;
  /** The shop's name, for a client being made. */
  name?: string | null;
  /** No email to the owner (a client being made: its welcome email names every app already). */
  quiet?: boolean;
};

/**
 * Change a client's modules. Returns the new state and what each module was told.
 * Idempotent: asking for what is already so changes nothing and tells nobody.
 */
export async function setModules(clientId: string, change: Change) {
  const asked = change.modules ?? {};
  for (const [m, v] of Object.entries(asked)) {
    if (!isModule(m)) throw new ModulesError(400, `"${m}" is not a module. The modules are ${MODULES.join(', ')}.`);
    if (typeof v !== 'boolean') throw new ModulesError(400, `Say ${m}: true or false.`);
  }
  const before = await state(clientId);
  const recorded = new Set((await prisma.clientModule.findMany({ where: { clientId }, select: { module: true } })).map(r => r.module));
  const after = { ...before.on, ...asked } as Record<Module, boolean>;
  // Logistics ships Inventory's orders: it goes with Inventory.
  if (after.logistics && !after.inventory) {
    if (asked.logistics === true) throw new ModulesError(409, 'Logistics ships orders made in Inventory. Switch Inventory on too.');
    after.logistics = false;
  }
  const changed = MODULES.filter(m => after[m] !== before.on[m]);
  // Asked for, never recorded (a client being made): written down too, though nothing changes for it.
  const toRecord = MODULES.filter(m => changed.includes(m) || (m in asked && !recorded.has(m)));
  if (!changed.length && !toRecord.length) return { ...before, told: [] as Module[], changed: { on: [] as Module[], off: [] as Module[] } };
  const turnedOn = changed.filter(m => after[m]), turnedOff = changed.filter(m => !after[m]);
  const byText = change.by ? `${change.by.name ?? change.by.userId}` : null;

  // 1. Each module's own switch first: any of them may refuse, and then nothing is recorded.
  if (turnedOff.includes('logistics')) {
    const logistics = await import('../logistics/parcels');
    await logistics.switchLogistics(clientId, false, { id: change.by?.userId ?? null }).catch((e: any) => { throw new ModulesError(e?.statusCode ?? 409, e?.message ?? 'Logistics could not be switched off.'); });
  }
  if (turnedOn.includes('logistics')) {
    const logistics = await import('../logistics/parcels');
    await logistics.switchLogistics(clientId, true, { id: change.by?.userId ?? null });
  }
  if (turnedOn.includes('boutique')) {
    const boutique = await import('../boutique');
    const linked = await prisma.boutiqueLink.findUnique({ where: { clientId }, select: { tenant: true, unlinkedAt: true } });
    const tenant = String(change.boutique?.tenant ?? (linked && !linked.unlinkedAt ? linked.tenant : '') ?? '').trim().toLowerCase();
    if (!tenant) throw new ModulesError(400, 'Say which Boutique app account runs this shop (its account name).');
    try {
      await boutique.enableForClient(clientId, tenant, change.name ?? before.name ?? null, { handOver: change.boutique?.handOver === true });
    } catch (e: any) { throw new ModulesError(e?.statusCode ?? 409, e?.message ?? 'The Boutique app account could not be linked.'); }
  }
  if (turnedOff.includes('boutique')) {
    const boutique = await import('../boutique');
    try { await boutique.disableForClient(clientId); } catch (e: any) { throw new ModulesError(e?.statusCode ?? 409, e?.message ?? 'The Boutique module could not be switched off.'); }
  }

  // 2. Recorded, version up.
  const version = await prisma.$transaction(async tx => {
    for (const m of toRecord) {
      await tx.clientModule.upsert({
        where: { clientId_module: { clientId, module: m } },
        create: { clientId, module: m, on: after[m], changedBy: byText, source: change.source },
        update: { on: after[m], changedAt: new Date(), changedBy: byText, source: change.source }
      });
    }
    const c = await tx.platformClient.upsert({
      where: { clientId },
      create: { clientId, name: (change.name ?? before.name ?? clientId).slice(0, 200), version: 1, createdBy: change.by?.userId ?? null },
      update: { version: { increment: 1 } }
    });
    return c.version;
  });
  inventoryCache.delete(clientId);

  // 3. Inventory's feed to CRM: only while CRM and Inventory are both on. CRM's hand-over (moved) is kept across off/on.
  await syncCrmFeed(clientId, after.crm && after.inventory, change.by);

  // 4. Tell the modules with a door: every one ON gets the picture; one switched OFF is told it is off.
  const told: Module[] = [];
  for (const m of DOORS) {
    const action = after[m] ? 'connect' : turnedOff.includes(m) ? 'disconnect' : null;
    if (!action) continue;
    await prisma.moduleConnect.upsert({
      where: { clientId_module: { clientId, module: m } },
      create: { clientId, module: m, action, version, status: 'PENDING' },
      update: { action, version, status: 'PENDING', attempts: 0, nextAttemptAt: new Date(), lockedAt: null, lastError: null, answer: undefined, doneAt: null }
    });
    told.push(m);
  }
  const { kick } = await import('./connect');
  kick(clientId, { by: change.by, source: change.source, changed: { on: turnedOn, off: turnedOff } });
  const now = await state(clientId);
  // The owner hears of it, in one email: what is new and how to open it, what is off (kept), and every app now.
  if (!change.quiet) void tellOwner(clientId, turnedOn, turnedOff, now.modules).catch(e => console.error('[modules] owner email:', e?.message ?? e));
  return { ...now, told, changed: { on: turnedOn, off: turnedOff } };
}

async function syncCrmFeed(clientId: string, want: boolean, by: By) {
  const sub = await prisma.moduleSubscription.findUnique({ where: { clientId_module: { clientId, module: 'crm' } } });
  if (want && !sub) {
    await moduleSubscriptions.enable(clientId, 'crm', by ? `console:${by.userId}` : 'modules');
    const kept = (await prisma.clientModule.findUnique({ where: { clientId_module: { clientId, module: 'crm' } }, select: { kept: true } }))?.kept as any;
    if (kept?.moved) await prisma.moduleSubscription.update({ where: { clientId_module: { clientId, module: 'crm' } }, data: { moved: kept.moved } });
  } else if (!want && sub) {
    if (sub.moved) await prisma.clientModule.update({ where: { clientId_module: { clientId, module: 'crm' } }, data: { kept: { moved: sub.moved } } }).catch(() => undefined);
    await moduleSubscriptions.disable(clientId, 'crm');
  }
}

/** The whole picture sent to every module (the agreed body, 26 Nov 2026). */
export async function pictureOf(clientId: string, extra: { by?: By; source?: Source | string; changed?: { on: Module[]; off: Module[] } } = {}) {
  const s = await state(clientId);
  const [settings, login, client, stores] = await Promise.all([
    prisma.clientSettings.findUnique({ where: { clientId }, select: { businessName: true } }),
    prisma.user.findFirst({ where: { clientId, roles: { some: { role: { name: 'SUPER_ADMIN' } } } }, orderBy: { createdAt: 'asc' }, select: { name: true, email: true, phone: true } }),
    prisma.platformClient.findUnique({ where: { clientId }, select: { owner: true } }),
    s.on.inventory ? prisma.stockLocation.findMany({ where: { clientId, active: true }, select: { id: true, code: true, name: true }, orderBy: { createdAt: 'asc' } }) : Promise.resolve([])
  ]);
  return {
    clientId, version: s.version, at: new Date().toISOString(),
    shopName: settings?.businessName?.trim() || s.name,
    // The owner's login here; for a client with none (a boutique made by the Boutique app), the owner it named.
    owner: login ? { name: login.name ?? 'Owner', email: login.email ?? null, phone: login.phone ?? null } : ((client?.owner as any) ?? null),
    stores, modules: s.modules,
    changed: extra.changed ?? { on: [], off: [] },
    by: extra.by ?? null, source: extra.source ?? 'console'
  };
}

async function tellOwner(clientId: string, on: Module[], off: Module[], now: Module[]) {
  const owner = await prisma.user.findFirst({ where: { clientId, status: 'ACTIVE' as any, roles: { some: { role: { name: 'SUPER_ADMIN' } } } }, orderBy: { createdAt: 'asc' }, select: { name: true, email: true } });
  if (!owner?.email) return; // a boutique-only shop: the Boutique app tells its own people
  const [settings, link] = await Promise.all([
    prisma.clientSettings.findUnique({ where: { clientId }, select: { businessName: true } }),
    prisma.boutiqueLink.findUnique({ where: { clientId }, select: { tenant: true, unlinkedAt: true } })
  ]);
  const { mailService } = await import('../mail.service');
  await mailService.sendModulesChanged({
    recipientName: owner.name ?? 'there', email: owner.email, shopName: settings?.businessName?.trim() || (await state(clientId)).name,
    on, off, now, boutiqueTenant: link && !link.unlinkedAt ? link.tenant : null
  });
}

/** The owner a client with no owner login here names (the Boutique app): { name, email?, phone? }. */
export async function setOwner(clientId: string, owner: unknown, name?: string | null) {
  const o: any = owner && typeof owner === 'object' ? owner : null;
  if (!o) return;
  const ownerName = typeof o.name === 'string' ? o.name.trim().slice(0, 120) : '';
  const email = typeof o.email === 'string' && o.email.trim() ? o.email.trim().toLowerCase().slice(0, 160) : null;
  const phone = typeof o.phone === 'string' && o.phone.trim() ? o.phone.trim().slice(0, 20) : null;
  if (ownerName.length < 2 || (!email && !phone)) throw new ModulesError(400, "The owner needs a name, and an email or phone: they sign in to POS with it.");
  if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new ModulesError(400, "That owner email does not look right.");
  await prisma.platformClient.upsert({ where: { clientId }, create: { clientId, name: (name ?? clientId).slice(0, 200), owner: { name: ownerName, email, phone } }, update: { owner: { name: ownerName, email, phone } } });
}
