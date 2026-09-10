/**
 * The worst cases, run against a real server rather than reasoned about.
 *
 * Everything here happens on a throwaway tenant this script creates and deletes. That is not
 * fussiness: two probes during an earlier audit were fired at a live shop, succeeded when they
 * should have been refused, and had to be unpicked by hand afterwards. A tenant that exists for
 * ninety seconds cannot be damaged.
 *
 * What it covers, in the order a shop would meet it:
 *
 *   EMPTY      a brand new workspace with nothing in it -- every screen must answer, not crash
 *   RBAC       a restricted member trying the things their role does not include
 *   RACE       the same stock, spent twice at once, and the same button pressed twice
 *   ATOMIC     an order where the second line is bad -- the first must not survive
 *   INPUT      names that are enormous, emoji, right-to-left, or trying to be HTML
 *   STALE      acting on something that was deleted a moment ago
 *
 *   npx ts-node src/scripts/verify-worst-cases.ts [--keep]
 */
import bcrypt from 'bcryptjs';
import { randomBytes } from 'crypto';
import { prisma } from '../lib/prisma';
import { AuthService } from '../services/auth.service';
import * as roles from '../services/role-management';

const PORT = process.env.PORT || 4006;
const BASE = `http://127.0.0.1:${PORT}/api/v1`;
const STAMP = Date.now();
const CLIENT = `qa-worstcase-${STAMP}`;
const KEEP = process.argv.includes('--keep');

type Res = { status: number; body: any };

async function call(token: string, method: string, path: string, body?: any, extra?: Record<string, string>): Promise<Res> {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
      ...(extra || {})
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await res.text();
  let parsed: any = text;
  try { parsed = JSON.parse(text); } catch { /* HTML or empty -- keep the raw text */ }
  return { status: res.status, body: parsed };
}

// ── reporting ────────────────────────────────────────────────────────────────
let pass = 0;
const failures: string[] = [];

function check(label: string, ok: boolean, detail: string) {
  if (ok) { pass++; console.log(`  ok   ${label}`); }
  else { failures.push(`${label} -- ${detail}`); console.log(`  FAIL ${label}  ${detail}`); }
}

/** The message a person would actually be shown, whatever envelope it arrived in. */
function said(r: Res): string {
  const b = r.body;
  if (typeof b === 'string') return b.slice(0, 90).replace(/\s+/g, ' ');
  return String(b?.message ?? b?.error ?? JSON.stringify(b)).slice(0, 90);
}

// ── setup ────────────────────────────────────────────────────────────────────
async function makeUser(name: string, email: string, roleId: string) {
  // Generated here and never reused: this account outlives the script by nothing.
  const password = randomBytes(9).toString('base64url');
  const user = await prisma.user.create({
    data: {
      clientId: CLIENT, name, email,
      password: await bcrypt.hash(password, 10),
      status: 'ACTIVE',
      roles: { create: { roleId } }
    }
  });
  return { id: user.id, token: AuthService.generateToken({ userId: user.id, clientId: CLIENT }) };
}

async function setup() {
  const ownerRole = await prisma.role.create({
    data: { clientId: CLIENT, name: 'SUPER_ADMIN', description: 'audit owner' }
  });
  const star = await prisma.permission.upsert({
    where: { key: '*' }, update: {}, create: { key: '*', description: 'Everything (account owner)' }
  });
  await prisma.rolePermission.create({ data: { roleId: ownerRole.id, permissionId: star.id } });

  const owner = await makeUser('Audit Owner', `owner-${STAMP}@example.com`, ownerRole.id);

  // The most restricted realistic job: sells, and is not meant to see a number about what the
  // shop paid. Composed through the real service so it holds exactly what the product offers.
  const actor: roles.Actor = { clientId: CLIENT, userId: owner.id, permissions: ['*'], roles: ['SUPER_ADMIN'] };
  const floorRole = await roles.createRole(actor, { name: 'QA shop floor', template: 'shop_floor' });
  const clerk = await makeUser('Audit Clerk', `clerk-${STAMP}@example.com`, floorRole.id);

  const held = await prisma.role.findUnique({
    where: { id: floorRole.id }, include: { permissions: { include: { permission: true } } }
  });
  console.log(`tenant ${CLIENT}`);
  console.log(`  clerk holds: ${held?.permissions.map(p => p.permission.key).join(', ') || '(nothing)'}\n`);

  return { owner, clerk };
}

async function teardown() {
  if (KEEP) { console.log(`\nkept ${CLIENT}`); return; }
  const w = { clientId: CLIENT };
  // Children first -- nothing here relies on a cascade that may not be declared.
  await prisma.clientErrorLog.deleteMany({ where: w }).catch(() => {});
  await prisma.inventoryTransaction.deleteMany({ where: w });
  await prisma.inventoryStock.deleteMany({ where: w });
  await prisma.inventoryReservation.deleteMany({ where: w }).catch(() => {});
  await prisma.inventoryAlert.deleteMany({ where: w }).catch(() => {});
  await prisma.dispatchItem.deleteMany({ where: { dispatch: { clientId: CLIENT } } }).catch(() => {});
  await prisma.dispatch.deleteMany({ where: w }).catch(() => {});
  await prisma.salesOrderItem.deleteMany({ where: { salesOrder: { clientId: CLIENT } } }).catch(() => {});
  await prisma.salesOrder.deleteMany({ where: w }).catch(() => {});
  // Stock counts hold a row per variant, so they have to go before the variants do -- the
  // foreign key is not declared as a cascade and the delete fails outright without this.
  await prisma.stockCountItem.deleteMany({ where: { stockCount: { clientId: CLIENT } } }).catch(() => {});
  await prisma.stockCount.deleteMany({ where: w }).catch(() => {});
  await prisma.inventoryReservation.deleteMany({ where: w }).catch(() => {});
  await prisma.productVariant.deleteMany({ where: w });
  await prisma.product.deleteMany({ where: w });
  await prisma.stockLocation.deleteMany({ where: w });
  await prisma.customer.deleteMany({ where: w }).catch(() => {});
  const users = await prisma.user.findMany({ where: w, select: { id: true } });
  await prisma.userRole.deleteMany({ where: { userId: { in: users.map(u => u.id) } } });
  await prisma.user.deleteMany({ where: w });
  const rs = await prisma.role.findMany({ where: w, select: { id: true } });
  await prisma.rolePermission.deleteMany({ where: { roleId: { in: rs.map(r => r.id) } } });
  await prisma.role.deleteMany({ where: w });
  console.log(`\nremoved ${CLIENT}`);
}

// ── EMPTY: a workspace on its first morning ──────────────────────────────────
/**
 * Nothing here has any data yet. Every one of these screens is on the first-run path, so a
 * crash is not an edge case -- it is what a new customer sees before anything else.
 */
async function emptyStates(token: string) {
  console.log('EMPTY  a brand new workspace');
  const screens: [string, string][] = [
    ['dashboard', '/dashboard/summary'],
    ['inventory list', '/inventory/variants'],
    ['transactions', '/inventory/transactions'],
    ['products', '/products'],
    ['locations', '/locations'],
    ['customers', '/customers'],
    ['sales orders', '/sales-orders'],
    ['suppliers', '/suppliers'],
    ['purchase orders', '/purchase-orders'],
    ['stock counts', '/stock-counts'],
    ['returns', '/returns'],
    ['day book', '/daybook'],
    ['alerts', '/inventory/alerts'],
    ['reorder suggestions', '/reorder/suggestions'],
    ['team', '/team/members'],
    ['roles', '/roles'],
    ['support tickets', '/support-tickets']
  ];
  for (const [label, path] of screens) {
    const r = await call(token, 'GET', path);
    check(`${label} answers on an empty tenant`, r.status < 400, `${r.status} :: ${said(r)}`);
  }
  console.log('');
}

// ── RBAC: the restricted member ──────────────────────────────────────────────
/**
 * A shop-floor account trying the things that are not their job. Every one of these must be a
 * 403 with a sentence a person can act on -- not a 500, and emphatically not a 200.
 */
async function rbac(clerk: string, ctx: { productId: string; variantId: string; locationId: string }) {
  console.log('RBAC   what a shop-floor account may not do');
  const attempts: [string, string, string, any?][] = [
    ['create a product', 'POST', '/products', { title: 'x', category: 'WOMEN', productType: 'READY_TO_WEAR', basePrice: 1 }],
    ['delete a product for good', 'DELETE', `/products/${ctx.productId}/hard`],
    ['archive a product', 'POST', `/products/${ctx.productId}/archive`, {}],
    ['adjust stock', 'POST', '/inventory/adjustment', { variantId: ctx.variantId, quantity: 5, locationId: ctx.locationId }],
    ['receive stock', 'POST', '/inventory/stock-in', { variantId: ctx.variantId, quantity: 5, locationId: ctx.locationId }],
    ['set the cost of stock', 'POST', '/inventory/set-cost', { variantId: ctx.variantId, unitCost: 1 }],
    ['open the team screen', 'GET', '/team/members'],
    ['read a colleague’s password', 'POST', '/team/members/x/password/view', {}],
    ['compose a role', 'POST', '/roles', { name: 'QA escalation', permissions: ['admin:users'] }],
    ['list roles', 'GET', '/roles'],
    ['add a location', 'POST', '/locations', { code: 'QA2', name: 'QA2', type: 'STORE' }],
    ['delete a location', 'DELETE', `/locations/${ctx.locationId}`],
    ['see the stock valuation report', 'GET', '/reports/inventory-value'],
    ['see the dead stock report', 'GET', '/reports/dead-stock'],
    ['see what the shop spent with suppliers', 'GET', '/reports/supplier-spend']
  ];
  for (const [label, method, path, body] of attempts) {
    const r = await call(clerk, method, path, body);
    check(`refused: ${label}`, r.status === 403, `expected 403, got ${r.status} :: ${said(r)}`);
  }
  console.log('');
}

/**
 * The escalation that matters most: can somebody who manages the team give themselves, or
 * anybody else, more than they hold? Composing the role and assigning the role are two
 * different code paths, and only one of them is obviously guarded.
 */
async function escalation(owner: string, ctx: { clerkId: string }) {
  console.log('RBAC   privilege escalation');

  // An account that manages people but sells nothing -- the realistic middle rank.
  const mk = await call(owner, 'POST', '/roles', {
    name: `QA manager ${STAMP}`, permissions: ['admin:users', 'product:view']
  });
  check('a manager role can be composed', mk.status < 400, `${mk.status} :: ${said(mk)}`);
  const managerRoleId = mk.body?.data?.id ?? mk.body?.id;
  if (!managerRoleId) { console.log('  (skipping, no role)\n'); return; }

  const invite = await call(owner, 'POST', '/team/members', {
    name: 'QA Manager', email: `manager-${STAMP}@example.com`, roleId: managerRoleId
  });
  const managerId = invite.body?.data?.id ?? invite.body?.id;
  check('the manager account is created', !!managerId, `${invite.status} :: ${said(invite)}`);
  if (!managerId) { console.log(''); return; }
  const manager = AuthService.generateToken({ userId: managerId, clientId: CLIENT });

  const probes: [string, () => Promise<Res>][] = [
    ['grant themselves total access', () => call(manager, 'POST', '/roles', { name: `QA all ${STAMP}`, permissions: ['*'] })],
    ['compose a role holding what they lack', () => call(manager, 'POST', '/roles', { name: `QA over ${STAMP}`, permissions: ['cost:manage'] })],
    ['widen their own role beyond itself', () => call(manager, 'PATCH', `/roles/${managerRoleId}`, { permissions: ['admin:users', 'cost:manage'] })],
    ['edit the owner role', () => call(manager, 'PATCH', '/roles/OWNER', { permissions: [] })]
  ];
  for (const [label, run] of probes) {
    const r = await run();
    check(`refused: ${label}`, r.status === 403 || r.status === 404, `expected 403/404, got ${r.status} :: ${said(r)}`);
  }

  // The one that is not obviously covered: assigning an EXISTING powerful role.
  const ownerRole = await prisma.role.findFirst({ where: { clientId: CLIENT, name: 'SUPER_ADMIN' } });
  if (ownerRole) {
    const r = await call(manager, 'PATCH', `/team/members/${ctx.clerkId}/role`, { roleId: ownerRole.id });
    check('refused: hand the owner role to somebody else', r.status === 403, `expected 403, got ${r.status} :: ${said(r)}`);
    const self = await call(manager, 'PATCH', `/team/members/${managerId}/role`, { roleId: ownerRole.id });
    check('refused: hand the owner role to themselves', self.status === 403, `expected 403, got ${self.status} :: ${said(self)}`);
  }
  console.log('');
}

// ── RACE: the same stock spent twice ─────────────────────────────────────────
/**
 * Two tills, one last dress. Both requests read "1 in stock" before either writes.
 *
 * applyMovement takes `SELECT ... FOR UPDATE` on the variant before it reads anything, which is
 * the right shape -- this proves it under real parallel load rather than trusting the comment.
 * Exactly one request may succeed; the rest must be refused, and the shelf must never go below
 * zero whatever order they landed in.
 */
async function raceStock(owner: string, ctx: { variantId: string; locationId: string }) {
  console.log('RACE   the same stock, spent at the same moment');

  const AVAILABLE = 5;
  const RACERS = 8;
  await call(owner, 'POST', '/inventory/adjustment', {
    variantId: ctx.variantId, locationId: ctx.locationId, quantity: AVAILABLE, reason: 'MANUAL_ADJUSTMENT'
  });
  const before = await stockOf(ctx);
  check(`shelf starts at ${AVAILABLE}`, before === AVAILABLE, `it is ${before}`);

  // Every racer wants the WHOLE shelf. Only one can be right.
  const results = await Promise.all(
    Array.from({ length: RACERS }, () =>
      call(owner, 'POST', '/inventory/stock-out', {
        variantId: ctx.variantId, locationId: ctx.locationId, quantity: AVAILABLE, reason: 'SALE'
      })
    )
  );
  const won = results.filter(r => r.status < 400).length;
  const after = await stockOf(ctx);

  check(`only one of ${RACERS} simultaneous sales succeeds`, won === 1, `${won} succeeded`);
  check('the shelf lands on zero, not below', after === 0, `it is ${after}`);
  const codes = results.map(r => r.status).sort().join(',');
  check('the losers are told why, not crashed', !results.some(r => r.status >= 500), `statuses ${codes}`);
  console.log('');
}

/** Every stock row for this variant at this location, read straight from the database. */
async function stockOf(ctx: { variantId: string; locationId: string }) {
  const rows = await prisma.inventoryStock.findMany({ where: { variantId: ctx.variantId } });
  return rows.reduce((s, r) => s + r.quantity, 0);
}

/**
 * The double-click. Not a race between two people -- one person, one button, two requests,
 * because the first was slow and the screen did not say so.
 */
async function doubleSubmit(owner: string, ctx: { locationId: string }) {
  console.log('RACE   the same button, pressed twice');

  // Two identical customers, sent together.
  const email = `qa-double-${STAMP}@example.com`;
  const pair = await Promise.all([
    call(owner, 'POST', '/customers', { name: 'QA Double', email, phone: '9000000001' }),
    call(owner, 'POST', '/customers', { name: 'QA Double', email, phone: '9000000001' })
  ]);
  const madeCustomers = await prisma.customer.count({ where: { clientId: CLIENT, email } });
  check('a double-submitted customer is created once',
    madeCustomers === 1, `${madeCustomers} rows, statuses ${pair.map(p => p.status).join(',')}`);

  // Two identical locations, same code, sent together. The code is uniquely keyed per tenant,
  // so the database can catch this even if the service does not -- the question is whether the
  // second one comes back as a sentence or as a crash.
  const code = `QA-DUP-${STAMP}`;
  const locs = await Promise.all([
    call(owner, 'POST', '/locations', { code, name: 'QA Dup', type: 'STORE' }),
    call(owner, 'POST', '/locations', { code, name: 'QA Dup', type: 'STORE' })
  ]);
  const madeLocs = await prisma.stockLocation.count({ where: { clientId: CLIENT, code } });
  check('a double-submitted location is created once', madeLocs === 1, `${madeLocs} rows`);
  check('the second attempt is a message, not a crash',
    !locs.some(l => l.status >= 500), `statuses ${locs.map(l => l.status).join(',')}`);
  console.log('');
}

// ── ATOMIC: half a change is worse than none ─────────────────────────────────
/**
 * An order whose second line names a variant that does not exist. If the first line is written
 * before the second is checked, the shop is left holding a phantom order it never agreed to --
 * and, worse, stock reserved against it.
 */
async function atomicity(owner: string, ctx: { variantId: string; locationId: string; customerId: string }) {
  console.log('ATOMIC an order where the second line is bad');

  const ordersBefore = await prisma.salesOrder.count({ where: { clientId: CLIENT } });
  const stockBefore = await stockOf(ctx);

  const r = await call(owner, 'POST', '/sales-orders/full', {
    locationId: ctx.locationId,
    customer: { id: ctx.customerId },
    items: [
      { variantId: ctx.variantId, quantity: 1, unitPrice: 100 },
      { variantId: '00000000-0000-0000-0000-000000000000', quantity: 1, unitPrice: 100 }
    ]
  });
  const ordersAfter = await prisma.salesOrder.count({ where: { clientId: CLIENT } });
  const stockAfter = await stockOf(ctx);

  check('the bad order is refused', r.status >= 400, `${r.status} :: ${said(r)}`);
  check('no half-written order is left behind', ordersAfter === ordersBefore, `${ordersBefore} -> ${ordersAfter}`);
  check('no stock moved for it', stockAfter === stockBefore, `${stockBefore} -> ${stockAfter}`);
  console.log('');
}

// ── INPUT: what people actually type ─────────────────────────────────────────
/**
 * Not attacks -- a shop in India naming a product in Hindi, somebody pasting a description out
 * of Word, a customer whose name has an apostrophe. The rule is the same for all of them: the
 * server either stores it faithfully or refuses it with a sentence. What it must never do is
 * accept it and hand back something different, or fall over.
 */
async function awkwardInput(owner: string) {
  console.log('INPUT  names people actually type');

  const cases: [string, string][] = [
    ['a Hindi name', 'साड़ी — बनारसी सिल्क'],
    ['emoji', 'Party Dress 🎉👗✨'],
    ['right-to-left text', 'فستان سهرة'],
    ['an apostrophe', "Ladies' Kurti"],
    ['angle brackets', '<script>alert(1)</script> Dress'],
    ['a quote and a backslash', 'Silk "A" \ Line'],
    ['leading and trailing spaces', '   Spaced Kurti   '],
    ['a newline in the middle', 'Two\nLines Kurti'],
    ['zero-width joiners', 'Kurti‍​Blend']
  ];

  for (const [label, title] of cases) {
    const r = await call(owner, 'POST', '/products', {
      title, category: 'WOMEN', productType: 'READY_TO_WEAR', basePrice: 100, status: 'DRAFT'
    });
    if (r.status >= 500) { check(`${label}`, false, `crashed: ${r.status} :: ${said(r)}`); continue; }
    if (r.status >= 400) { check(`${label} is refused with a reason`, true, `${r.status}`); continue; }

    const id = r.body?.data?.id ?? r.body?.id;
    const stored = id ? await prisma.product.findUnique({ where: { id }, select: { title: true } }) : null;
    // Trimming is a legitimate, expected change; anything else is not.
    const ok = stored?.title === title || stored?.title === title.trim();
    check(`${label} comes back as it went in`, ok, `stored ${JSON.stringify(stored?.title)}`);
  }

  // Length. Somewhere there must be a limit, and hitting it must be a sentence rather than a
  // database error leaking through.
  const huge = 'क'.repeat(20000);
  const big = await call(owner, 'POST', '/products', {
    title: huge, category: 'WOMEN', productType: 'READY_TO_WEAR', basePrice: 100, status: 'DRAFT'
  });
  check('a 20,000-character name does not crash the server', big.status < 500, `${big.status} :: ${said(big)}`);

  // An empty name, and a name that is only whitespace -- the same thing to a person.
  for (const [label, title] of [['an empty name', ''], ['a name of only spaces', '     ']] as [string, string][]) {
    const r = await call(owner, 'POST', '/products', {
      title, category: 'WOMEN', productType: 'READY_TO_WEAR', basePrice: 100, status: 'DRAFT'
    });
    check(`${label} is refused`, r.status === 400, `${r.status} :: ${said(r)}`);
  }
  console.log('');
}

/**
 * A name of only spaces, everywhere somebody can type one.
 *
 * The product title was the one that got noticed -- it saved happily and then sat in every
 * list as a blank row, impossible to find by searching and awkward even to click. But
 * `z.string().min(1)` counts the spaces, so every field written that way had the same hole:
 * a supplier nobody can look up, a stock count with no name on the report, a variant whose
 * SKU is whitespace, and a support ticket whose subject is blank to the person who has to
 * answer it.
 *
 * Checked here rather than trusted to a grep, because the fix is one call in a schema and
 * the next field somebody adds will be written the old way unless something says otherwise.
 */
async function blankNames(owner: string, ctx: { productId: string; locationId: string }) {
  console.log('INPUT  a name of only spaces, wherever one can be typed');

  const attempts: [string, string, string, any][] = [
    ['a product', 'POST', '/products',
      { title: '   ', category: 'WOMEN', productType: 'READY_TO_WEAR', basePrice: 100, status: 'DRAFT' }],
    ['a customer', 'POST', '/customers', { name: '   ', phone: `9${STAMP}`.slice(0, 10) }],
    ['a supplier', 'POST', '/suppliers', { name: '   ' }],
    ['a stock count', 'POST', '/stock-counts', { name: '   ', locationId: ctx.locationId }],
    ['a support ticket', 'POST', '/support-tickets', { subject: '   ', description: 'x' }],
    ['a support ticket description', 'POST', '/support-tickets', { subject: 'x', description: '   ' }],
    ['a variant SKU', 'POST', `/products/${ctx.productId}/variants`, { sku: '   ', size: 'M', color: 'Red' }],
    ['a storefront connection', 'POST', '/storefront-connections',
      { name: '   ', baseUrl: 'https://example.com' }]
  ];

  for (const [label, method, path, body] of attempts) {
    const r = await call(owner, method, path, body);
    check(`${label} named only spaces is refused`, r.status === 400, `got ${r.status} :: ${said(r)}`);
  }

  // And the everyday case still works, trimmed rather than rejected.
  const padded = await call(owner, 'POST', '/suppliers', { name: `  QA Padded ${STAMP}  ` });
  const supplierId = padded.body?.data?.id ?? padded.body?.id;
  check('a name with spaces around it is accepted', padded.status < 400, `${padded.status} :: ${said(padded)}`);
  if (supplierId) {
    const stored = await prisma.supplier.findUnique({ where: { id: supplierId }, select: { name: true } });
    check('and is stored without them', stored?.name === `QA Padded ${STAMP}`, JSON.stringify(stored?.name));
  }
  console.log('');
}

// ── STALE: the screen is out of date ─────────────────────────────────────────
/**
 * Two tabs open, or one tab left open over lunch. Somebody deletes a thing in the first and then
 * acts on it in the second. The answer must be "that is gone" -- 404 -- and never a 500, which
 * is what a bare `throw new Error('not found')` used to produce and which put every stale
 * bookmark on the Platform Console's crash page.
 */
async function staleData(owner: string, ctx: { locationId: string }) {
  console.log('STALE  acting on something already deleted');

  const made = await call(owner, 'POST', '/products', {
    title: `QA doomed ${STAMP}`, category: 'WOMEN', productType: 'READY_TO_WEAR', basePrice: 100, status: 'DRAFT'
  });
  const id = made.body?.data?.id ?? made.body?.id;
  if (!id) { check('a product to delete', false, `${made.status} :: ${said(made)}`); console.log(''); return; }

  // Removed straight from the database, because that is what the OTHER tab did -- the API's own
  // hard delete deliberately refuses until the product has sat in the bin for seven days, which
  // is a good rule and not what this probe is about.
  await prisma.productVariant.deleteMany({ where: { productId: id } });
  await prisma.product.delete({ where: { id } });

  const after: [string, string, string, any?][] = [
    ['open it', 'GET', `/products/${id}`],
    ['rename it', 'PATCH', `/products/${id}`, { title: 'too late' }],
    ['archive it', 'POST', `/products/${id}/archive`, {}],
    ['restore it', 'POST', `/products/${id}/restore`, {}],
    ['bin it', 'POST', `/products/${id}/trash`, {}],
    ['delete it', 'DELETE', `/products/${id}/hard`],
    ['add a variant to it', 'POST', `/products/${id}/variants`, { sku: `QA-STALE-${STAMP}`, size: 'M', color: 'Red' }]
  ];
  for (const [label, method, path, body] of after) {
    const r = await call(owner, method, path, body);
    check(`${label} after it is gone says 404`, r.status === 404, `got ${r.status} :: ${said(r)}`);
  }

  // An id that is not a uuid at all -- what a hand-edited URL looks like.
  const junk = await call(owner, 'GET', '/products/not-a-real-id');
  check('a nonsense id is a 4xx, not a crash', junk.status >= 400 && junk.status < 500, `${junk.status} :: ${said(junk)}`);
  console.log('');
}

// ── BIN: a product waiting to be deleted ────────────────────────────────
/**
 * Trash is not deletion -- the product sits there for seven days first. The question is what it
 * is still allowed to do while it waits. A product in the bin is on its way out of the shop;
 * anything that adds to it, or quietly puts it back into circulation, is a surprise nobody asked
 * for and a stock figure nobody is watching.
 */
async function binnedProduct(owner: string) {
  console.log('BIN    what a binned product still allows');

  const made = await call(owner, 'POST', '/products', {
    title: `QA binned ${STAMP}`, category: 'WOMEN', productType: 'READY_TO_WEAR', basePrice: 100, status: 'ACTIVE'
  });
  const id = made.body?.data?.id ?? made.body?.id;
  if (!id) { check('a product to bin', false, `${made.status} :: ${said(made)}`); console.log(''); return; }

  const binned = await call(owner, 'POST', `/products/${id}/trash`, {});
  check('the product goes to the bin', binned.status < 400, `${binned.status} :: ${said(binned)}`);

  const addVariant = await call(owner, 'POST', `/products/${id}/variants`, {
    sku: `QA-BIN-${STAMP}`, size: 'L', color: 'Blue'
  });
  check('a binned product will not take a new variant',
    addVariant.status >= 400, `got ${addVariant.status} :: ${said(addVariant)}`);

  const archived = await call(owner, 'POST', `/products/${id}/archive`, {});
  check('a binned product cannot be archived out of the bin',
    archived.status >= 400, `got ${archived.status} :: ${said(archived)}`);

  const state = await prisma.product.findUnique({ where: { id }, select: { status: true } });
  check('it is still in the bin afterwards', state?.status === 'TRASHED', `it is ${state?.status}`);
  console.log('');
}

// ── CODES: two records, one number ─────────────────────────────────────
/**
 * Customer codes, order numbers and the rest are handed out in sequence. A generator that reads
 * the highest number and adds one is a race: under load two records get CUS-0007 and the unique
 * key rejects one of them -- which the person sees as a save that failed for no reason.
 */
async function sequentialCodes(owner: string) {
  console.log('CODES  ten records created at once');

  const N = 10;
  const results = await Promise.all(
    Array.from({ length: N }, (_, i) =>
      call(owner, 'POST', '/customers', {
        name: `QA Race ${i}`, phone: `98000000${String(i).padStart(2, '0')}`
      })
    )
  );
  const ok = results.filter(r => r.status < 400).length;
  const rows = await prisma.customer.findMany({
    where: { clientId: CLIENT, name: { startsWith: 'QA Race' } }, select: { customerCode: true }
  });
  const codes = new Set(rows.map(r => r.customerCode));

  check(`all ${N} are saved`, ok === N, `${ok} saved, statuses ${results.map(r => r.status).sort().join(',')}`);
  check('every one gets its own code', codes.size === rows.length, `${rows.length} rows, ${codes.size} distinct codes`);
  check('none of them crashed', !results.some(r => r.status >= 500), 'a 5xx came back');
  console.log('');
}

// ── STATES: the same step, taken twice ──────────────────────────────────
/**
 * Every workflow in this product has states, and every one of them can be asked to repeat a
 * step it has already taken -- a slow connection, a double click, two people on two tills, a
 * tab left open. That is not an error in the shop; it is Tuesday.
 *
 * What a refusal must NOT be is a 500. A 5xx says the server broke, invites the caller to
 * retry something that can never succeed, and -- because errorHandler persists only 5xx --
 * writes the refusal onto the Platform Console's Errors page, where a real crash then has to
 * be found among hundreds of them.
 *
 * 409 is the honest answer: the request was fine, the thing has moved on.
 */
async function stateMachines(owner: string, ctx: { locationId: string; variantId: string; customerId: string }) {
  console.log('STATES the same step, taken twice');

  // ── a sales order, confirmed twice ──
  const order = await call(owner, 'POST', '/sales-orders/full', {
    locationId: ctx.locationId,
    customer: { id: ctx.customerId },
    items: [{ variantId: ctx.variantId, quantity: 1, unitPrice: 100 }]
  });
  const orderId = order.body?.data?.id ?? order.body?.id;
  if (orderId) {
    // Something to actually reserve, or the first confirm fails for an unrelated reason.
    await call(owner, 'POST', '/inventory/adjustment', {
      variantId: ctx.variantId, locationId: ctx.locationId, quantity: 10, reason: 'MANUAL_ADJUSTMENT'
    });
    const first = await call(owner, 'POST', `/sales-orders/${orderId}/confirm`, {});
    check('an order confirms once', first.status < 400, `${first.status} :: ${said(first)}`);

    const again = await call(owner, 'POST', `/sales-orders/${orderId}/confirm`, {});
    check('confirming it again is refused, not a crash',
      again.status === 409 || again.status === 400, `got ${again.status} :: ${said(again)}`);
    // Deliberately case-SENSITIVE for the enum names: "confirmed" is the English word and is
    // exactly right in a sentence, while "CONFIRMED" is the database's spelling leaking out.
    const words = said(again);
    check('and says so in words a shopkeeper can act on',
      !/transition|status:|(DRAFT|CONFIRMED|CANCELLED|DISPATCHED|PARTIALLY_DISPATCHED|TRASHED|ARCHIVED|IN_PROGRESS|COMPLETED)/.test(words),
      `it says: ${words}`);

    // Cancelling a dispatched order, and cancelling twice.
    const cancel = await call(owner, 'POST', `/sales-orders/${orderId}/cancel`, {});
    check('a confirmed order can be cancelled', cancel.status < 400, `${cancel.status} :: ${said(cancel)}`);
    const cancelAgain = await call(owner, 'POST', `/sales-orders/${orderId}/cancel`, {});
    check('cancelling it again is refused, not a crash',
      cancelAgain.status === 409 || cancelAgain.status === 400, `got ${cancelAgain.status} :: ${said(cancelAgain)}`);
  } else {
    check('an order to confirm', false, `${order.status} :: ${said(order)}`);
  }

  // ── a stock count, started twice and completed twice ──
  const count = await call(owner, 'POST', '/stock-counts', {
    name: `QA audit ${STAMP}`, locationId: ctx.locationId
  });
  const countId = count.body?.data?.id ?? count.body?.id;
  if (countId) {
    const started = await call(owner, 'POST', `/stock-counts/${countId}/start`, {});
    check('an audit starts once', started.status < 400, `${started.status} :: ${said(started)}`);

    const restart = await call(owner, 'POST', `/stock-counts/${countId}/start`, {});
    check('starting it again is refused, not a crash',
      restart.status === 409 || restart.status === 400, `got ${restart.status} :: ${said(restart)}`);

    const done = await call(owner, 'POST', `/stock-counts/${countId}/complete`, {});
    check('an audit completes', done.status < 400, `${done.status} :: ${said(done)}`);
    const doneAgain = await call(owner, 'POST', `/stock-counts/${countId}/complete`, {});
    check('completing it again is refused, not a crash',
      doneAgain.status === 409 || doneAgain.status === 400, `got ${doneAgain.status} :: ${said(doneAgain)}`);
  } else {
    check('an audit to start', false, `${count.status} :: ${said(count)}`);
  }

  // ── nothing above may have been filed as a backend crash ──
  const crashes = await prisma.clientErrorLog.count({
    where: { clientId: CLIENT, source: 'BACKEND', statusCode: { gte: 500 } }
  });
  check('none of it was logged as a server crash', crashes === 0, `${crashes} logged`);
  console.log('');
}


// ── main ─────────────────────────────────────────────────────────────────────
async function main() {
  const ping = await fetch(`${BASE}/health`).catch(() => null);
  if (!ping) { console.log(`Nothing is answering on ${BASE}. Start the server first.`); return; }

  const { owner, clerk } = await setup();

  // Empty first, before anything exists -- that is the whole point of it.
  await emptyStates(owner.token);

  // Then the minimum a shop needs to be worth testing.
  const loc = await call(owner.token, 'POST', '/locations', { code: 'MAIN-STORE', name: 'QA Main', type: 'STORE' });
  const locationId = loc.body?.data?.id ?? loc.body?.id;
  const prod = await call(owner.token, 'POST', '/products', {
    title: `QA Kurti ${STAMP}`, category: 'WOMEN', productType: 'READY_TO_WEAR', basePrice: 999, status: 'ACTIVE'
  });
  const productId = prod.body?.data?.id ?? prod.body?.id;
  const variant = await call(owner.token, 'POST', `/products/${productId}/variants`, {
    sku: `QA-${STAMP}`, size: 'M', color: 'Red', quantity: 0
  });
  const variantId = variant.body?.data?.id ?? variant.body?.id;
  const cust = await call(owner.token, 'POST', '/customers', {
    name: 'QA Customer', phone: '9000000000', email: `cust-${STAMP}@example.com`
  });
  const customerId = cust.body?.data?.id ?? cust.body?.id;

  if (!locationId || !productId || !variantId) {
    console.log('Could not build the fixture:');
    console.log('  location', loc.status, said(loc));
    console.log('  product ', prod.status, said(prod));
    console.log('  variant ', variant.status, said(variant));
    await teardown();
    await prisma.$disconnect();
    return;
  }

  const ctx = { productId, variantId, locationId, customerId, clerkId: clerk.id };

  await rbac(clerk.token, ctx);
  await escalation(owner.token, ctx);
  await raceStock(owner.token, ctx);
  await doubleSubmit(owner.token, ctx);
  await atomicity(owner.token, ctx);
  await awkwardInput(owner.token);
  await blankNames(owner.token, ctx);
  await staleData(owner.token, ctx);
  await binnedProduct(owner.token);
  await sequentialCodes(owner.token);
  await stateMachines(owner.token, ctx);

  console.log('─'.repeat(70));
  console.log(`${pass} passed, ${failures.length} failed`);
  if (failures.length) {
    console.log('\nWhat needs looking at:');
    failures.forEach(f => console.log(`  - ${f}`));
  }

  await teardown();
  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await teardown().catch(() => {});
  await prisma.$disconnect();
  process.exit(1);
});
