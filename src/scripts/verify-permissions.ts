/**
 * The permission catalogue is a contract. This is what holds it to it.
 *
 * Every module that will ever talk to Inventory — POS, Shopify, Accounts — asks the same
 * question of the same catalogue. That only stays true if the catalogue itself is consistent:
 * no key guarding a route while missing from the list, no key granting nothing, no implication
 * that loops, and no route that quietly hands the shop's costs to whoever asks.
 *
 * The scenarios below are written as people, not as keys, because that is how the mistakes
 * happen. "A salesperson can read the shop's profit" is a sentence somebody would have caught;
 * "SALES holds dashboard:view" is one nobody did, for as long as this product has existed.
 *
 *   npx ts-node src/scripts/verify-permissions.ts
 */
import { readFileSync, readdirSync, existsSync } from 'fs';
import {
  PERMISSIONS, ALL_PERMISSION_KEYS, expandPermissions, grants, getPermission, catalogueByGroup,
  WILDCARD_PERMISSION, holdsEverything
} from '../config/permissions';
import { RBAC_DATA } from '../services/rbac-seed.service';

let passed = 0, failed = 0;
const failures: string[] = [];
const check = (name: string, ok: boolean, detail?: string) => {
  if (ok) { passed++; console.log(`  [PASS] ${name}`); }
  else { failed++; failures.push(name); console.log(`  [FAIL] ${name}${detail ? `  -> ${detail}` : ''}`); }
};

/** Every permission named in a route file, with the file it came from. */
function permissionsUsedInRoutes(): Map<string, string[]> {
  const dir = 'src/routes';
  const used = new Map<string, string[]>();
  for (const file of readdirSync(dir).filter(f => f.endsWith('.ts'))) {
    const src = readFileSync(`${dir}/${file}`, 'utf8');
    for (const m of src.matchAll(/requirePermission\('([a-z_]+:[a-z_]+)'\)/g)) {
      const key = m[1];
      if (!used.has(key)) used.set(key, []);
      if (!used.get(key)!.includes(file)) used.get(key)!.push(file);
    }
  }
  return used;
}

async function main() {
  const used = permissionsUsedInRoutes();

  // ── THE CATALOGUE IS COMPLETE AND HONEST ─────────────────────────────────
  console.log('THE CATALOGUE COVERS EVERY ROUTE, AND NOTHING IT CANNOT');

  const missing = [...used.keys()].filter(k => !ALL_PERMISSION_KEYS.includes(k));
  // A route guarded by a key nobody can be granted is a route only SUPER_ADMIN can reach --
  // and it fails silently, as a 403 that looks like a policy decision.
  check('no route is guarded by a key that is not in the catalogue', missing.length === 0, missing.join(', '));

  // A permission that guards nothing teaches people that ticking boxes has no effect. The one
  // legitimate exception is a field-level key: cost:view is enforced on the way out, on the
  // response body, not on the way in -- and the catalogue says so itself.
  const unused = ALL_PERMISSION_KEYS.filter(k => !used.has(k) && !getPermission(k)?.fieldLevel);
  check('every route-level permission guards a route', unused.length === 0, unused.join(', '));

  const fieldLevelOnARoute = PERMISSIONS.filter(p => p.fieldLevel && used.has(p.key));
  // The reverse mistake: gating a whole route on cost:view would turn a redaction into a 403
  // and hide screens people are meant to see, just without the money on them.
  check('no field-level permission is used to gate a route', fieldLevelOnARoute.length === 0,
    fieldLevelOnARoute.map(p => p.key).join(', '));

  const unlabelled = PERMISSIONS.filter(p => !p.label || p.label.length < 8);
  check('every permission has a sentence a shopkeeper could read', unlabelled.length === 0,
    unlabelled.map(p => p.key).join(', '));

  const dupes = ALL_PERMISSION_KEYS.filter((k, i) => ALL_PERMISSION_KEYS.indexOf(k) !== i);
  check('no key is defined twice', dupes.length === 0, dupes.join(', '));

  // ── IMPLICATION ───────────────────────────────────────────────────────────
  console.log('\nIMPLICATION IS CLOSED, AND CANNOT LOOP');

  const danglingImplies = PERMISSIONS
    .flatMap(p => (p.implies ?? []).map(i => ({ from: p.key, to: i })))
    .filter(x => !ALL_PERMISSION_KEYS.includes(x.to));
  check('nothing implies a key that does not exist', danglingImplies.length === 0,
    danglingImplies.map(x => `${x.from} -> ${x.to}`).join(', '));

  // expandPermissions walks a stack and skips what it has already seen, so a cycle terminates
  // rather than hanging. Proving it here means nobody has to reason about it later.
  const everything = expandPermissions(ALL_PERMISSION_KEYS);
  check('expanding the whole catalogue terminates', everything.size >= ALL_PERMISSION_KEYS.length,
    `${everything.size} keys`);

  check('report:financial confers report:view and cost:view without storing either',
    grants(['report:financial'], 'report:view') && grants(['report:financial'], 'cost:view'));
  check('cost:manage confers cost:view', grants(['cost:manage'], 'cost:view'));
  check('receiving stock confers seeing it', grants(['inventory:receive'], 'inventory:view'));
  check('finishing a count confers entering one', grants(['stock_count:complete'], 'stock_count:view'));
  check('sending goods out confers seeing the order it is against', grants(['dispatch:create'], 'sales_order:view'));

  // The direction that must NOT hold.
  check('seeing stock does not confer changing it', !grants(['inventory:view'], 'inventory:adjust'));
  check('seeing money reports does not confer restating cost', !grants(['report:financial'], 'cost:manage'));
  check('managing the team does not confer reading a password',
    !grants(['admin:users'], 'team:view_password'));

  // ── THE PEOPLE ────────────────────────────────────────────────────────────
  console.log('\nA SALESPERSON CANNOT READ THE SHOP\'S MONEY');
  // The finding this whole change exists for. Every seeded role held dashboard:view, and
  // dashboard:view carried inventory value, supplier spend, dead stock and the day book.
  const sales: string[] = [...RBAC_DATA.roles.SALES.permissions];
  check('they can still see the dashboard', grants(sales, 'dashboard:view'));
  check('but not what the stock is worth', !grants(sales, 'report:financial'));
  check('nor what the shop paid', !grants(sales, 'cost:view'));
  check('nor what it pays its suppliers', !grants(sales, 'supplier:view'));
  check('nor its purchase orders', !grants(sales, 'purchase_order:view'));
  check('they can still take an order', grants(sales, 'sales_order:create'));
  check('and see the products they are selling', grants(sales, 'product:view'));

  console.log('\nWAREHOUSE STAFF MOVE STOCK WITHOUT SEEING MONEY');
  const wh: string[] = [...RBAC_DATA.roles.WAREHOUSE.permissions];
  check('they can receive stock', grants(wh, 'inventory:receive'));
  check('and receive goods against an order', grants(wh, 'purchase_order:receive'));
  // Receiving a PO means seeing the PO, and a purchase order IS what you pay. This is the one
  // place the boundary is genuinely awkward, and it is recorded rather than pretended away.
  check('which necessarily shows them that order\'s prices', grants(wh, 'purchase_order:view'));
  check('but they cannot restate what stock cost', !grants(wh, 'cost:manage'));
  check('nor see the shop\'s total value', !grants(wh, 'report:financial'));
  check('nor change a selling price', !grants(wh, 'product:update'));
  check('nor spend the try-on allowance', !grants(wh, 'tryon:generate'));

  console.log('\nA BUYER SEES MONEY, AND STILL CANNOT MANAGE PEOPLE');
  const im: string[] = [...RBAC_DATA.roles.INVENTORY_MANAGER.permissions];
  check('they see what things cost', grants(im, 'cost:view'));
  check('and the money reports', grants(im, 'report:financial'));
  check('and can restate a cost that was wrong', grants(im, 'cost:manage'));
  check('but cannot manage the team', !grants(im, 'admin:users'));
  check('nor read anyone\'s password', !grants(im, 'team:view_password'));

  console.log('\nAN ADMIN CAN DO THE JOB, AND IS STILL NOT SUPER_ADMIN');
  const admin: string[] = [...RBAC_DATA.roles.ADMIN.permissions];
  check('they manage the team', grants(admin, 'admin:users'));
  check('they see the money', grants(admin, 'report:financial'));
  check('they hold no wildcard', !admin.includes('*'));

  console.log('\nTOTAL ACCESS IS A GRANT, NOT A ROLE NAME');
  check('the wildcard satisfies anything', grants(['*'], 'cost:manage') && grants(['*'], 'team:view_password'));
  check('and it is the only role that has it',
    Object.entries(RBAC_DATA.roles).filter(([, r]) => (r.permissions as readonly string[]).includes('*'))
      .every(([name]) => name === 'SUPER_ADMIN'));

  // Total access must not be a box on the roles screen. A merchant who wants a second full
  // administrator composes one from the catalogue, which leaves a record of what was granted.
  check('the wildcard is not in the catalogue, so it cannot be ticked',
    !ALL_PERMISSION_KEYS.includes(WILDCARD_PERMISSION)
    && !catalogueByGroup().some(g => g.permissions.some(p => p.key === WILDCARD_PERMISSION)));

  // The regression this whole change exists to undo. Authorization used to read a role NAME and
  // return early, so most users' stored permissions were never consulted and drifted unnoticed.
  const guardSrc = readFileSync('src/middleware/permission.middleware.ts', 'utf8');
  const bypass = guardSrc.split('\n')
    .filter(l => !l.trim().startsWith('//') && !l.trim().startsWith('*'))
    .filter(l => /roles.*includes\(\s*'SUPER_ADMIN'/.test(l));
  check('requirePermission decides nothing from a role name', bypass.length === 0, bypass.join(' | '));

  // The seed must actually issue the grant, or removing that bypass locks out every owner.
  check('the seed grants the wildcard to SUPER_ADMIN',
    (RBAC_DATA.roles.SUPER_ADMIN.permissions as readonly string[]).includes(WILDCARD_PERMISSION));
  const seedSrc = readFileSync('src/services/rbac-seed.service.ts', 'utf8');
  check('and no longer skips SUPER_ADMIN when writing role permissions',
    !/roleName === 'SUPER_ADMIN'\)\s*return \[\]/.test(seedSrc));
  check('and creates the wildcard permission row itself', seedSrc.includes('WILDCARD_PERMISSION'));

  // The migration is what makes the two safe to ship together.
  const mig = readFileSync('prisma/migrations/20260909210000_split_money_permissions/migration.sql', 'utf8');
  check('the migration grants the wildcard before any code stops reading names',
    /INSERT INTO "role_permissions"[\s\S]*'\*'[\s\S]*r\."name" = 'SUPER_ADMIN'/.test(mig));

  // ── WHAT A MODULE WOULD NEED ──────────────────────────────────────────────
  console.log('\nA POS IDENTITY NEEDS NO MONEY PERMISSION');
  // Designing the boundary before anything depends on it. A till sells at the price on the
  // tag; it has no reason to know what the shop paid.
  const pos = ['product:view', 'inventory:view', 'sales_order:create', 'sales_order:confirm', 'dispatch:create'];
  check('it can take a sale all the way to stock leaving', grants(pos, 'dispatch:create'));
  check('and read the order it dispatched', grants(pos, 'sales_order:view'));
  check('without seeing cost', !grants(pos, 'cost:view'));
  check('without seeing purchase orders', !grants(pos, 'purchase_order:view'));
  check('and without touching the team', !grants(pos, 'admin:users'));

  console.log('\nAN ACCOUNTS IDENTITY IS THE ONE THAT SHOULD SEE MONEY');
  const accounts = ['sales_order:view', 'purchase_order:view', 'report:financial'];
  check('it sees the money reports', grants(accounts, 'report:financial'));
  check('and cost, through them', grants(accounts, 'cost:view'));
  check('but cannot move stock', !grants(accounts, 'inventory:adjust') && !grants(accounts, 'dispatch:create'));

  // ── THE SEED ONLY GRANTS REAL KEYS ────────────────────────────────────────
  console.log('\nEVERY SEEDED ROLE GRANTS ONLY KEYS THAT EXIST');
  const bad: string[] = [];
  for (const [name, role] of Object.entries(RBAC_DATA.roles)) {
    for (const key of role.permissions as readonly string[]) {
      if (key !== '*' && !ALL_PERMISSION_KEYS.includes(key)) bad.push(`${name}: ${key}`);
    }
  }
  check('no seeded role grants a key that is not in the catalogue', bad.length === 0, bad.join(', '));

  console.log('\nTHE OWNER WORKS WHETHER OR NOT THE DATABASE HAS MIGRATED');
  // The failure this section exists for: the code was changed to require the '*' grant in the
  // same breath as the migration that creates it, so a server pointed at a database that had
  // not migrated yet refused every account owner -- an owner opening her own dashboard was
  // told she did not have permission to see it. Code and data can never be required to change
  // in the same instant, so both signals are accepted until the grant exists everywhere.

  // After the migration.
  check('an owner holding the grant passes, whatever their role is called',
    holdsEverything(['*'], ['Owner']) && holdsEverything(['*'], []));

  // Before it -- Akshaya today: a role named SUPER_ADMIN whose stored permissions are stale
  // and do not even include dashboard:view.
  const staleOwner = ['customer:view', 'inventory:view', 'sales_order:view'];
  check('an owner who predates the grant still passes on the role name',
    holdsEverything(staleOwner, ['SUPER_ADMIN']));
  check('and can therefore still open the dashboard',
    holdsEverything(staleOwner, ['SUPER_ADMIN']) || grants(staleOwner, 'dashboard:view'));

  // The compatibility must not widen to anyone else.
  check('a role with no grant and another name does not pass',
    !holdsEverything(staleOwner, ['MANAGER']) && !holdsEverything(staleOwner, []));
  check('an empty identity does not pass', !holdsEverything([], []) && !holdsEverything());
  check('and staff are unaffected by any of it',
    !holdsEverything([...RBAC_DATA.roles.SALES.permissions], ['SALES']));

  console.log('\nNOTHING ANYWHERE DECIDES AUTHORITY FROM A ROLE NAME');
  // Repo-wide, not just the middleware. This pattern was in four places at once: two in the
  // permission middleware, one deciding who may read a colleague's password, one deciding who
  // may change their own. Each looked local and harmless; together they meant most of the
  // platform's users were authorised by a string.
  const offenders: string[] = [];
  for (const dir of ['src/middleware', 'src/controllers', 'src/services', 'src/routes']) {
    for (const file of readdirSync(dir).filter(f => f.endsWith('.ts'))) {
      readFileSync(`${dir}/${file}`, 'utf8').split('\n').forEach((line, i) => {
        const code = line.split('//')[0];
        if (/roles.*(includes|indexOf)\(\s*['\"]SUPER_ADMIN/.test(code)) {
          offenders.push(`${dir}/${file}:${i + 1}`);
        }
      });
    }
  }
  check('no role-name check decides what an identity may do', offenders.length === 0, offenders.join(', '));

  // The one legitimate home for the legacy name, and it must be marked as temporary so it is
  // removed rather than becoming permanent by neglect.
  const cat = readFileSync('src/config/permissions.ts', 'utf8');
  check('the legacy owner name lives only in the catalogue, marked transitional',
    cat.includes('LEGACY_OWNER_ROLE_NAMES') && cat.includes('TRANSITIONAL'));

  console.log('\nREADING A COLLEAGUE\'S PASSWORD LEAVES A TRAIL');
  check('the credential audit is its own service',
    existsSync('src/services/credential-audit/index.ts'));
  const teamCtl = readFileSync('src/controllers/team.controller.ts', 'utf8');
  check('the password view records the disclosure', teamCtl.includes("outcome: 'DISCLOSED'"));
  // The event the general activity logger cannot capture, because it drops anything >= 400.
  check('and records refused attempts too', teamCtl.includes("outcome: 'REFUSED'"));
  check('it carries actor, target, reason and request id',
    ['actorUserId', 'targetUserId', 'reason', 'requestId'].every(f => teamCtl.includes(f)));
  // A disclosure nobody can prove happened is worse for the person whose password it was than
  // a disclosure that did not happen, so a failed write declines rather than continuing.
  check('and a password that cannot be logged is not shown', teamCtl.includes('503'));

  console.log('\nAND THE SCREEN CAN RENDER IT');
  const groups = catalogueByGroup();
  check('every permission falls into a group', groups.reduce((n, g) => n + g.permissions.length, 0) === PERMISSIONS.length);
  check('no group is empty', groups.every(g => g.permissions.length > 0), groups.map(g => `${g.group}:${g.permissions.length}`).join(' '));
  check('the sensitive ones are marked',
    PERMISSIONS.filter(p => p.sensitive).length >= 6,
    PERMISSIONS.filter(p => p.sensitive).map(p => p.key).join(', '));

  console.log(`\n================ RESULT: ${passed} passed | ${failed} failed ================`);
  if (failures.length) { console.log('\nFailed:'); failures.forEach(f => console.log('  - ' + f)); process.exitCode = 1; }
}

main().catch(e => { console.error('\nSuite did not finish:', e?.message ?? e); process.exitCode = 1; });
