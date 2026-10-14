/**
 * Every permission the app asks for exists on the Roles screen, and the built-in roles hold what
 * they should. Reads the code and the database; changes nothing.
 *
 *   A  every key the server checks (requirePermission / grants / may / can in routes, controllers,
 *      services) is in the catalogue (config/permissions.ts) -- otherwise no role could ever be given it
 *   B  every key the screens check (can('...'), Guard permission/anyOf/allOf, Sidebar) is in the catalogue
 *   C  every catalogue key is used somewhere (a key nobody checks is a switch that does nothing)
 *   D  the built-in role templates hold only real keys
 *   E  every shop's built-in roles in the database match what a new shop would get for the keys the
 *      new features use (an old shop must not be missing a permission a new one has)
 *
 *   npx tsx src/scripts/verify-permission-catalogue.ts
 */
import fs from 'node:fs';
import path from 'node:path';
import { prisma } from '../lib/prisma';
import { ALL_PERMISSION_KEYS, expandPermissions } from '../config/permissions';
import { RBAC_DATA } from '../services/rbac-seed.service';

let passed = 0, failed = 0;
const check = (name: string, ok: boolean, detail?: unknown) => {
  if (ok) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name}${detail !== undefined ? ` -- ${JSON.stringify(detail)}` : ''}`); }
};

function walk(dir: string, exts: string[], out: string[] = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (!['node_modules', 'scripts', 'dist', 'help'].includes(e.name)) walk(p, exts, out); }
    else if (exts.some(x => p.endsWith(x))) out.push(p);
  }
  return out;
}
const KEY = /['"`]([a-z_]+:[a-z_]+)['"`]/g;
// Only strings in a permission-checking position, so "a:b" in a label or a URL is not mistaken for one.
const CHECKS = /(requirePermission|grants|may|can|canAny|hasPermission|permission=|anyOf=|allOf=|permission:|requiredPermission:)\s*\(?\s*\{?\s*\[?[^;\n]*/g;
function keysIn(files: string[]) {
  const found = new Map<string, string>();
  for (const f of files) {
    // Comments explain permissions as well as check them -- only code counts.
    const text = fs.readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
    for (const m of text.matchAll(CHECKS)) for (const k of m[0].matchAll(KEY)) if (!found.has(k[1])) found.set(k[1], path.relative(process.cwd(), f));
  }
  return found;
}

async function main() {
  const catalogue = new Set(ALL_PERMISSION_KEYS);
  const backendKeys = keysIn(walk(path.resolve(__dirname, '..'), ['.ts']));
  const frontendKeys = keysIn(walk(path.resolve(__dirname, '../../../frontend/src'), ['.js', '.jsx', '.ts', '.tsx']));
  // Not permission keys: things that look like one (a SKU-ish pair, a TS type) -- none expected; listed if any.
  console.log('\nA. SERVER CHECKS');
  const missingBe = [...backendKeys].filter(([k]) => !catalogue.has(k));
  check(`all ${backendKeys.size} keys the server checks are on the Roles screen`, missingBe.length === 0, missingBe);
  console.log('\nB. SCREEN CHECKS');
  const missingFe = [...frontendKeys].filter(([k]) => !catalogue.has(k));
  check(`all ${frontendKeys.size} keys the screens check are on the Roles screen`, missingFe.length === 0, missingFe);
  console.log('\nC. UNUSED KEYS');
  const used = new Set([...backendKeys.keys(), ...frontendKeys.keys()]);
  const unused = [...catalogue].filter(k => !used.has(k));
  check('every key on the Roles screen is checked somewhere', unused.length === 0, unused);
  console.log('\nD. BUILT-IN ROLE TEMPLATES');
  for (const [name, r] of Object.entries(RBAC_DATA.roles)) {
    const bad = (r.permissions as readonly string[]).filter(k => k !== '*' && !catalogue.has(k));
    check(`${name}: holds only real keys`, bad.length === 0, bad);
  }
  console.log('\nE. EXISTING SHOPS vs A NEW SHOP');
  const roles = await prisma.role.findMany({
    where: { name: { in: Object.keys(RBAC_DATA.roles) } },
    select: { clientId: true, name: true, permissions: { select: { permission: { select: { key: true } } } } }
  });
  const gaps = new Map<string, Set<string>>();
  for (const role of roles) {
    if (role.name === 'SUPER_ADMIN') continue;
    const template = (RBAC_DATA.roles as any)[role.name].permissions as string[];
    const held = expandPermissions(role.permissions.map(p => p.permission.key));
    for (const k of template) if (!held.has(k)) {
      const key = `${role.name} lacks ${k}`;
      if (!gaps.has(key)) gaps.set(key, new Set());
      gaps.get(key)!.add(role.clientId);
    }
  }
  const shops = new Set(roles.map(r => r.clientId)).size;
  check(`all ${shops} shops' built-in roles hold everything a new shop's would`, gaps.size === 0,
    [...gaps].map(([g, s]) => `${g} (${s.size} shop${s.size === 1 ? '' : 's'})`));
}

main().catch(e => { failed++; console.error(e); }).finally(async () => {
  console.log(`\n${passed} passed, ${failed} failed`);
  await prisma.$disconnect();
  process.exit(failed ? 1 : 0);
});
