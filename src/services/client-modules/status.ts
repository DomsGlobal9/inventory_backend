import { prisma } from '../../lib/prisma';
import { LABEL, MODULES, state, type Module } from './index';

/**
 * The Connections checklist (26 Nov 2026): one list of plain-English lines per module, green / amber / red.
 * Inventory writes the lines about what it holds itself (the owner's login, stores, WhatsApp, its feeds, the till key,
 * the boutique link); POS and CRM answer for themselves (their status doors), and the Console shows what they say.
 * A module that is still being told, or refused, says so first.
 */
export type Line = { key: string; label: string; state: 'ok' | 'warn' | 'bad'; says: string; action?: { label: string; href?: string; retry?: string } };
export type Group = { module: Module | 'shop'; label: string; on: boolean; lines: Line[] };

const ago = (d: Date | string | null | undefined) => {
  if (!d) return null;
  const mins = Math.round((Date.now() - new Date(d).getTime()) / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  if (mins < 48 * 60) return `${Math.round(mins / 60)} h ago`;
  return new Date(d).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: 'Asia/Kolkata' });
};
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;
const fromModule = (l: any): Line | null => {
  if (!l || typeof l !== 'object' || typeof l.label !== 'string') return null;
  const st = ['ok', 'warn', 'bad'].includes(l.state) ? l.state : 'warn';
  return { key: String(l.key ?? l.label).slice(0, 60), label: l.label.slice(0, 120), state: st, says: String(l.says ?? '').slice(0, 300), ...(l.action?.label ? { action: { label: String(l.action.label).slice(0, 40), ...(l.action.href ? { href: String(l.action.href) } : {}) } } : {}) };
};

/** "Being told" / "refused" lines for a module with a door; null when it has answered. */
async function tellingLine(clientId: string, module: Module): Promise<{ line: Line | null; done: boolean }> {
  const row = await prisma.moduleConnect.findUnique({ where: { clientId_module: { clientId, module } } });
  if (!row) return { line: { key: `${module}-told`, label: `${LABEL[module]} reports here`, state: 'warn', says: `Set up before this checklist existed, so ${LABEL[module]} has not reported yet. "Tell it now" sends it this client's modules; it keeps working as it is meanwhile.`, action: { label: 'Tell it now', retry: module } }, done: false };
  if (row.status === 'DONE') return { line: null, done: true };
  if (row.status === 'REFUSED') return { line: { key: `${module}-told`, label: `${LABEL[module]} connects to this client`, state: 'bad', says: `${LABEL[module]} said: ${row.lastError ?? 'no'}`, action: { label: 'Try again', retry: module } }, done: false };
  const next = row.nextAttemptAt.getTime() - Date.now();
  const when = next <= 5_000 ? 'now' : next < 60_000 ? `in ${Math.round(next / 1000)} s` : `in ${Math.round(next / 60_000)} min`;
  return {
    line: { key: `${module}-told`, label: `${LABEL[module]} connects to this client`, state: 'warn',
      says: row.attempts ? `Waiting for ${LABEL[module]} to answer (tried ${plural(row.attempts, 'time')}, again ${when}).` : `Being told now.`,
      action: { label: 'Try again', retry: module } },
    done: false
  };
}

async function shopLines(clientId: string, on: Record<Module, boolean>): Promise<Line[]> {
  const lines: Line[] = [];
  const owner = await prisma.user.findFirst({ where: { clientId, roles: { some: { role: { name: 'SUPER_ADMIN' } } } }, orderBy: { createdAt: 'asc' }, select: { email: true, status: true, lastLoginAt: true } });
  if (!owner) lines.push({ key: 'owner', label: 'Owner can sign in', state: on.boutique && !on.inventory ? 'ok' : 'bad', says: on.boutique && !on.inventory ? 'The Boutique app signs its people in.' : 'No owner login for this client.' });
  else if (owner.status !== 'ACTIVE') lines.push({ key: 'owner', label: 'Owner can sign in', state: 'bad', says: 'The owner\'s login is switched off.' });
  else if (owner.lastLoginAt) lines.push({ key: 'owner', label: 'Owner can sign in', state: 'ok', says: `Signed in ${ago(owner.lastLoginAt)}.` });
  else lines.push({ key: 'owner', label: 'Owner can sign in', state: 'warn', says: `Not signed in yet. The welcome email went to ${owner.email}.` });

  const { whatsappClient, whatsappConfigured } = await import('../whatsapp/client');
  if (whatsappConfigured()) {
    try {
      const a = await whatsappClient.account(clientId);
      const digits = (a.phone ?? '').replace(/\D/g, '');
      const where = on.pos ? 'POS → Settings → WhatsApp' : 'Inventory → Settings → WhatsApp';
      if (a.status === 'CONNECTED') lines.push({ key: 'whatsapp', label: 'Shop\'s WhatsApp number', state: 'ok', says: `••••${digits.slice(-4)} connected.` });
      else if (a.status === 'NOT_LINKED') lines.push({ key: 'whatsapp', label: 'Shop\'s WhatsApp number', state: 'warn', says: `Not linked yet. Someone at the shop scans the QR in ${where}.` });
      else lines.push({ key: 'whatsapp', label: 'Shop\'s WhatsApp number', state: 'bad', says: `${digits ? `••••${digits.slice(-4)} ` : ''}${a.status === 'LINKING' ? 'is being linked' : 'is disconnected'}. Link it again in ${where}.` });
    } catch { lines.push({ key: 'whatsapp', label: 'Shop\'s WhatsApp number', state: 'warn', says: 'WhatsApp could not be checked just now.' }); }
  }
  return lines;
}

async function inventoryLines(clientId: string, on: Record<Module, boolean>): Promise<Line[]> {
  const lines: Line[] = [];
  const stores = await prisma.stockLocation.count({ where: { clientId, active: true } });
  lines.push(stores ? { key: 'stores', label: 'Stores', state: 'ok', says: `${plural(stores, 'store')} switched on.` } : { key: 'stores', label: 'Stores', state: 'bad', says: 'No store is switched on. Add one in Inventory → Stock locations.' });
  if (on.crm) lines.push(await feedLine(clientId, 'crm', 'Inventory changes reach CRM'));
  return lines;
}

/** How Inventory's change feed to a module is doing: the last delivery, and anything stuck or given up. */
async function feedLine(clientId: string, module: string, label: string): Promise<Line> {
  const [last, stuck, dead, sub] = await Promise.all([
    prisma.moduleEvent.findFirst({ where: { clientId, module, status: 'DELIVERED' as any }, orderBy: { sequence: 'desc' }, select: { deliveredAt: true } }),
    prisma.moduleEvent.count({ where: { clientId, module, status: { in: ['PENDING', 'RETRYING'] as any }, createdAt: { lt: new Date(Date.now() - 5 * 60_000) } } }),
    prisma.moduleEvent.count({ where: { clientId, module, status: 'DEAD_LETTER' as any } }),
    prisma.moduleSubscription.findUnique({ where: { clientId_module: { clientId, module } } })
  ]);
  if (!sub) return { key: `feed-${module}`, label, state: 'bad', says: 'Not switched on yet.' };
  if (dead) return { key: `feed-${module}`, label, state: 'bad', says: `${plural(dead, 'change')} could not be delivered and stopped retrying.` };
  if (stuck) return { key: `feed-${module}`, label, state: 'warn', says: `${plural(stuck, 'change')} waiting over 5 minutes${last?.deliveredAt ? `; last delivered ${ago(last.deliveredAt)}` : ''}.` };
  return { key: `feed-${module}`, label, state: 'ok', says: last?.deliveredAt ? `Last change delivered ${ago(last.deliveredAt)}.` : 'Switched on. Nothing to deliver yet.' };
}

async function posLines(clientId: string, on: Record<Module, boolean>): Promise<Line[]> {
  const lines: Line[] = [];
  const told = await tellingLine(clientId, 'pos');
  if (told.line) lines.push(told.line);
  if (on.inventory) {
    const doctor = await import('../pos-switch/doctor');
    const finding = await doctor.diagnose(clientId).catch(() => null);
    const key = await prisma.storefrontConnection.findFirst({ where: { clientId, baseUrl: 'pos://counter', name: 'POS', status: 'ACTIVE' } as any, orderBy: { createdAt: 'desc' }, select: { lastUsedAt: true } });
    const words: Record<string, string> = { NO_KEY: 'No till key yet. It is made when POS is told.', STORE_CLOSED: 'The till\'s store is switched off. A new key follows by itself.', STOCK_MOVED: 'The till sells from an empty store. A new key follows by itself.', NOT_USED: 'POS has not used its key for a while. A new one follows by itself.' };
    lines.push(finding ? { key: 'till-key', label: 'Till is linked to Inventory', state: 'warn', says: words[finding] ?? finding } : { key: 'till-key', label: 'Till is linked to Inventory', state: 'ok', says: key?.lastUsedAt ? `In use, last ${ago(key.lastUsedAt)}.` : 'Key made.' });
  }
  if (told.done) {
    const pos = await import('../pos-switch');
    try {
      const said = await pos.connection(clientId);
      if (said?.lines) lines.push(...said.lines.map(fromModule).filter((l): l is Line => !!l));
      else {
        const s: any = await pos.status(clientId);
        lines.push(s?.posOn ? { key: 'pos-on', label: 'POS is on', state: 'ok', says: `${s.shop?.name ?? 'The shop'} bills at ${s.posAddress ?? 'POS'}.${s.owner?.signInWith ? ` The owner signs in with ${s.owner.signInWith}.` : ''}` } : { key: 'pos-on', label: 'POS is on', state: 'bad', says: 'POS says this shop is switched off.' });
      }
    } catch { lines.push({ key: 'pos-said', label: 'POS answers', state: 'warn', says: 'POS did not answer just now.' }); }
  }
  return lines;
}

async function crmLines(clientId: string): Promise<Line[]> {
  const lines: Line[] = [];
  const told = await tellingLine(clientId, 'crm');
  if (told.line) lines.push(told.line);
  if (told.done) {
    const { callCrm } = await import('../crm-identity/client');
    try {
      const said = await callCrm<{ lines: any[] }>('GET', '/platform/client', clientId, undefined, { scope: ['crm:platform'], timeoutMs: 6_000 });
      lines.push(...(said?.lines ?? []).map(fromModule).filter((l): l is Line => !!l));
    } catch { lines.push({ key: 'crm-said', label: 'CRM answers', state: 'warn', says: 'CRM did not answer just now.' }); }
  }
  return lines;
}

async function boutiqueLines(clientId: string): Promise<Line[]> {
  const l = await prisma.boutiqueLink.findUnique({ where: { clientId }, select: { tenant: true, linkedAt: true, unlinkedAt: true } });
  if (!l || l.unlinkedAt) return [{ key: 'boutique-link', label: 'Linked to a Boutique app account', state: 'bad', says: 'Not linked.' }];
  const items = await prisma.productVariant.count({ where: { clientId, boutiqueRef: { not: null } } as any });
  return [
    { key: 'boutique-link', label: 'Linked to a Boutique app account', state: 'ok', says: `Account ${l.tenant}, since ${ago(l.linkedAt)}.` },
    { key: 'boutique-items', label: 'Boutique items in ScaleEzy', state: items ? 'ok' : 'warn', says: items ? `${plural(items, 'item')} from the Boutique app.` : 'No items from the Boutique app yet.' }
  ];
}

/** The whole checklist for a client: one group per module it has, the shop's own lines first. */
export async function checklist(clientId: string) {
  const s = await state(clientId);
  const on = s.on;
  const groups: Group[] = [{ module: 'shop', label: 'The shop', on: true, lines: await shopLines(clientId, on) }];
  const build: Record<Module, () => Promise<Line[]>> = {
    inventory: () => inventoryLines(clientId, on), pos: () => posLines(clientId, on), crm: () => crmLines(clientId),
    boutique: () => boutiqueLines(clientId), logistics: async () => [await feedLine(clientId, 'logistics', 'Parcels reach Logistics')]
  };
  const built = await Promise.all(MODULES.filter(m => on[m]).map(async m => ({ module: m, label: LABEL[m], on: true, lines: await build[m]().catch(() => [{ key: `${m}-check`, label: `${LABEL[m]} checked`, state: 'warn' as const, says: 'Could not be checked just now.' }]) })));
  groups.push(...built);
  const all = groups.flatMap(g => g.lines);
  return { clientId, version: s.version, modules: s.modules, overall: all.some(l => l.state === 'bad') ? 'bad' : all.some(l => l.state === 'warn') ? 'warn' : 'ok', groups };
}
