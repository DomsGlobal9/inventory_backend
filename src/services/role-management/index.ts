/**
 * Roles, as a merchant composes them.
 *
 * Every rule that decides what a role may hold lives here rather than in the screen that draws
 * it. A browser can be bypassed with a terminal; if "you cannot give a role more than you have
 * yourself" is enforced by a disabled checkbox, it is not enforced at all.
 *
 * Four rules, and the reason for each:
 *
 * **The catalogue is the platform's.** A shop composes from it and cannot add to it, because a
 * permission is a promise the server keeps, and an invented one is a promise nothing enforces.
 *
 * **Implications are added server-side.** A role granted `report:financial` confers `cost:view`
 * whether or not the screen remembered, so the two can never disagree.
 *
 * **Nobody grants what they do not hold.** Otherwise this screen is a privilege escalation: a
 * manager with `admin:users` composes a role with `cost:manage`, assigns it to themselves, and
 * now holds it.
 *
 * **The owner's role cannot be edited or deleted.** It is the way back in when every other role
 * has been mis-configured.
 */
import { prisma } from '../../lib/prisma';
import {
  ALL_PERMISSION_KEYS, expandPermissions, getPermission, catalogueByGroup,
  WILDCARD_PERMISSION, holdsEverything, LEGACY_OWNER_ROLE_NAMES
} from '../../config/permissions';
import { ROLE_TEMPLATES, getTemplate } from './templates';

const fail = (message: string, statusCode: number, code?: string) =>
  Object.assign(new Error(message), { statusCode, code });

/** The identity doing the editing. */
export type Actor = {
  clientId: string;
  userId: string;
  permissions: string[];
  roles: string[];
};

const isOwnerRole = (name: string) => LEGACY_OWNER_ROLE_NAMES.includes(name);

/**
 * What this actor is allowed to hand out.
 *
 * The owner may grant anything in the catalogue. Everyone else may grant only what they
 * themselves hold, implications included, so a manager can build a role up to their own
 * authority and no further.
 */
function grantableBy(actor: Actor): Set<string> {
  if (holdsEverything(actor.permissions, actor.roles)) return new Set(ALL_PERMISSION_KEYS);
  return new Set([...expandPermissions(actor.permissions)].filter(k => k !== WILDCARD_PERMISSION));
}

/**
 * Cleans a requested permission list into what will actually be stored.
 *
 * Returns the deliberate choices only. Implied keys are resolved at check time rather than
 * frozen into the row, so an implication added later applies to roles that already exist.
 */
function sanitise(requested: string[], actor: Actor): string[] {
  if (requested.includes(WILDCARD_PERMISSION)) {
    throw fail(
      'Total access cannot be granted from this screen. It belongs to the account owner.',
      403, 'WILDCARD_NOT_GRANTABLE'
    );
  }

  // Checked after the wildcard, so "*" gets the answer that explains itself rather than being
  // lumped in with a typo.
  const unknown = requested.filter(k => !ALL_PERMISSION_KEYS.includes(k));
  if (unknown.length) {
    throw fail(`These are not things this product can do: ${unknown.join(', ')}`, 400, 'UNKNOWN_PERMISSION');
  }

  const allowed = grantableBy(actor);
  const overreach = requested.filter(k => !allowed.has(k));
  if (overreach.length) {
    const labels = overreach.map(k => getPermission(k)?.label ?? k);
    throw fail(
      `You cannot give a role something you do not have yourself: ${labels.join('; ')}`,
      403, 'CANNOT_GRANT_WHAT_YOU_LACK'
    );
  }

  // Store what was chosen. Implied keys are dropped rather than persisted -- keeping them would
  // show ticks nobody chose, and freeze today's implications into the row.
  const implied = new Set<string>();
  for (const key of requested) {
    for (const k of expandPermissions([key])) if (k !== key) implied.add(k);
  }
  return Array.from(new Set(requested.filter(k => !implied.has(k))));
}

/** The catalogue and the templates, as the roles screen needs them. */
export function getCatalogue(actor: Actor) {
  const allowed = grantableBy(actor);
  return {
    groups: catalogueByGroup().map(g => ({
      group: g.group,
      permissions: g.permissions.map(p => ({
        key: p.key,
        label: p.label,
        implies: p.implies ?? [],
        exposesCost: !!p.exposesCost,
        sensitive: !!p.sensitive,
        // Shown greyed rather than hidden. "You cannot grant this" is information the person
        // composing the role needs; hiding it makes the screen look broken instead.
        grantable: allowed.has(p.key)
      }))
    })),
    templates: ROLE_TEMPLATES.map(t => ({
      key: t.key,
      name: t.name,
      description: t.description,
      permissions: t.permissions.filter(k => allowed.has(k))
    }))
  };
}

export async function listRoles(actor: Actor) {
  const roles = await prisma.role.findMany({
    where: { clientId: actor.clientId },
    include: { permissions: { include: { permission: true } }, _count: { select: { users: true } } },
    orderBy: { name: 'asc' }
  });

  return roles.map(role => {
    const granted = role.permissions.map(rp => rp.permission.key);
    const owner = granted.includes(WILDCARD_PERMISSION) || isOwnerRole(role.name);
    return {
      id: role.id,
      name: role.name,
      description: role.description,
      /** What somebody deliberately ticked. */
      permissions: granted.filter(k => k !== WILDCARD_PERMISSION),
      /** What that actually confers, which is what the person is really asking about. */
      effectivePermissions: owner
        ? ALL_PERMISSION_KEYS.slice()
        : Array.from(expandPermissions(granted)),
      memberCount: role._count.users,
      isOwner: owner,
      /** The owner's role is the way back in, so it is not editable from here. */
      editable: !owner,
      canSeeCost: owner || Array.from(expandPermissions(granted)).includes('cost:view')
    };
  });
}

export async function createRole(
  actor: Actor,
  input: { name?: string; description?: string; permissions?: string[]; template?: string }
) {
  const name = (input.name || '').trim();
  if (!name) throw fail('Give the role a name', 400);
  if (name.length > 40) throw fail('That name is too long -- 40 characters at most', 400);
  if (isOwnerRole(name)) throw fail(`"${name}" is reserved for the account owner`, 400, 'RESERVED_NAME');

  const existing = await prisma.role.findFirst({ where: { clientId: actor.clientId, name } });
  if (existing) throw fail(`You already have a role called "${name}"`, 409, 'DUPLICATE_NAME');

  const template = input.template ? getTemplate(input.template) : undefined;
  if (input.template && !template) throw fail('No such starting point', 400);

  const permissions = sanitise(input.permissions ?? template?.permissions ?? [], actor);
  const rows = await permissionRows(permissions);

  const role = await prisma.role.create({
    data: {
      clientId: actor.clientId,
      name,
      description: (input.description || template?.description || '').trim() || null,
      permissions: { create: rows }
    }
  });
  return { id: role.id, name: role.name };
}

export async function updateRole(
  actor: Actor,
  roleId: string,
  input: { name?: string; description?: string; permissions?: string[] }
) {
  const role = await requireOwnRole(actor, roleId);
  assertNotOwnerRole(role, 'changed');

  const name = input.name?.trim();
  if (name && isOwnerRole(name)) throw fail(`"${name}" is reserved for the account owner`, 400, 'RESERVED_NAME');
  if (name && name !== role.name) {
    const clash = await prisma.role.findFirst({ where: { clientId: actor.clientId, name } });
    if (clash) throw fail(`You already have a role called "${name}"`, 409, 'DUPLICATE_NAME');
  }

  const permissions = input.permissions ? sanitise(input.permissions, actor) : undefined;
  const rows = permissions ? await permissionRows(permissions) : undefined;

  await prisma.$transaction(async tx => {
    await tx.role.update({
      where: { id: roleId },
      data: {
        ...(name ? { name } : {}),
        ...(input.description !== undefined ? { description: input.description?.trim() || null } : {})
      }
    });
    if (rows) {
      // Replaced wholesale rather than diffed. The screen sends the finished list, and a diff
      // that goes wrong leaves a role holding something nobody chose.
      await tx.rolePermission.deleteMany({ where: { roleId } });
      if (rows.length) {
        await tx.rolePermission.createMany({
          data: rows.map(r => ({ roleId, permissionId: r.permissionId })),
          skipDuplicates: true
        });
      }
    }
  });

  return { id: roleId };
}

/**
 * Who this change affects, before it is made.
 *
 * Editing a role is not a small action -- it changes what other people can do tomorrow morning,
 * and whoever is editing it usually cannot name them off the top of their head.
 */
export async function roleImpact(actor: Actor, roleId: string, proposed?: string[]) {
  const role = await requireOwnRole(actor, roleId);
  const members = await prisma.userRole.findMany({
    where: { roleId },
    include: { user: { select: { id: true, name: true, email: true, status: true } } }
  });

  const current = expandPermissions(role.permissions.map(rp => rp.permission.key));
  const next = proposed ? expandPermissions(proposed) : current;
  const describe = (keys: string[]) => keys.map(k => ({ key: k, label: getPermission(k)?.label ?? k }));

  return {
    roleId,
    name: role.name,
    memberCount: members.length,
    members: members.map(m => ({
      id: m.user.id, name: m.user.name, email: m.user.email, status: m.user.status
    })),
    losing: describe([...current].filter(k => !next.has(k))),
    gaining: describe([...next].filter(k => !current.has(k)))
  };
}

export async function deleteRole(actor: Actor, roleId: string) {
  const role = await requireOwnRole(actor, roleId);
  assertNotOwnerRole(role, 'deleted');

  const inUse = await prisma.userRole.count({ where: { roleId } });
  if (inUse > 0) {
    // Refused rather than cascaded. Deleting a role people hold would silently strip their
    // access, and whoever deleted it would hear about it from a colleague, not from us.
    throw fail(
      `${inUse} ${inUse === 1 ? 'person is' : 'people are'} using this role. Move them to another role first.`,
      409, 'ROLE_IN_USE'
    );
  }

  await prisma.role.delete({ where: { id: roleId } });
  return { id: roleId };
}

// ── helpers ──────────────────────────────────────────────────────────────────

type RoleWithPermissions = { name: string; permissions: { permission: { key: string } }[] };

function assertNotOwnerRole(role: RoleWithPermissions, verb: string) {
  const owner = isOwnerRole(role.name)
    || role.permissions.some(rp => rp.permission.key === WILDCARD_PERMISSION);
  if (owner) {
    throw fail(
      `The owner role cannot be ${verb}. It is what gets you back in if another role is set up wrongly.`,
      403, 'OWNER_ROLE_PROTECTED'
    );
  }
}

async function requireOwnRole(actor: Actor, roleId: string) {
  const role = await prisma.role.findFirst({
    where: { id: roleId, clientId: actor.clientId },
    include: { permissions: { include: { permission: true } } }
  });
  // Scoped to the client, so a role id from another tenant is "no such role" rather than a
  // permission error -- which would confirm it exists.
  if (!role) throw fail('No such role', 404);
  return role;
}

/** Permission rows, creating any the database has not seen yet. */
async function permissionRows(keys: string[]) {
  if (!keys.length) return [];
  const found = await prisma.permission.findMany({ where: { key: { in: keys } } });
  const byKey = new Map(found.map(p => [p.key, p.id]));

  const missing = keys.filter(k => !byKey.has(k));
  if (missing.length) {
    // A catalogue key with no row means this database has not run the latest migration.
    // Created rather than failed: the alternative is a role silently missing what was ticked.
    await prisma.permission.createMany({
      data: missing.map(key => ({ key, description: getPermission(key)?.label ?? key })),
      skipDuplicates: true
    });
    for (const p of await prisma.permission.findMany({ where: { key: { in: missing } } })) {
      byKey.set(p.key, p.id);
    }
  }
  return keys
    .map(k => ({ permissionId: byKey.get(k) as string }))
    .filter(r => !!r.permissionId);
}
