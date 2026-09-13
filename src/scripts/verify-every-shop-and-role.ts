/**
 * Offers work for every shop and every person in it: a shop opened today, and every shop already here.
 *
 *   A  A NEW SHOP, set up exactly as onboarding sets one up (roles, catalogue defaults, a Main Store,
 *      settings, an owner) with one person in each built-in role, then its first day with offers:
 *        - what each role can see and do, over HTTP, against what the role is meant to allow
 *        - an empty shop: no offers, no settings row, nothing to price against
 *        - the first offer, the first group customer, the first single-use codes, the first order
 *        - the till limit as a salesperson meets it, and as a manager does
 *        - somebody with no role, somebody switched off, and somebody from another shop
 *   B  EVERY SHOP ALREADY HERE, read only -- nothing is written to any of them:
 *        - every built-in role still holds the permissions a new shop's role would get
 *        - the offers list, choices, settings and every offer's own page load without throwing
 *        - every stored offer still passes today's checks, so it can be edited and started
 *        - every shop's live offers price a basket of its own real items without throwing, and
 *          the money adds up
 *
 * Part A uses a throwaway shop, deleted at the end. Needs the API running.
 *
 *   npx tsx src/scripts/verify-every-shop-and-role.ts
 */
import axios, { AxiosInstance } from 'axios';
import { prisma } from '../lib/prisma';
import { AuthService } from '../services/auth.service';
import { seedRolesForClient, RBAC_DATA } from '../services/rbac-seed.service';
import { seedCatalogDefaultsForClient } from '../services/catalog-seed.service';
import { inventoryMutationService } from '../services/inventory-mutation.service';
import { pricingQuoteService, priceBasket } from '../services/pricing';
import { offerService, offerInsightService, validateOffer } from '../services/offers';
import { getShopSettings, forgetShopSettings } from '../lib/clientSettings';
import { resolveVariantForLocation } from '../utils/variant-location';
import { toMinor } from '../services/pricing/money';
import { offersHealthService } from '../services/platform-health';

const BASE = process.env.VERIFY_API_URL || 'http://localhost:4006/api/v1';

let passed = 0, failed = 0;
const failures: string[] = [];
const check = (name: string, ok: boolean, detail?: string) => {
  if (ok) { passed++; console.log(`  [PASS] ${name}`); }
  else { failed++; failures.push(name); console.log(`  [FAIL] ${name}${detail ? `  -> ${detail}` : ''}`); }
};

const STAMP = Date.now();
const SHOP = `new-shop-${STAMP}`;
const un = (r: any) => (r?.data?.data !== undefined ? r.data.data : r?.data);
const brief = (r: any) => `${r.status} ${JSON.stringify(r.data).slice(0, 160)}`;
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const leaks = (t: string) => /(\\|\/)src(\\|\/)|node_modules|prisma\.|PrismaClient|Invalid `|postgres(ql)?:\/\/|at [A-Za-z]+ \(/i.test(t);

async function login(userId: string, clientId: string): Promise<AxiosInstance> {
  const token = AuthService.generateToken({ userId, clientId });
  return axios.create({ baseURL: BASE, headers: { Authorization: `Bearer ${token}` }, validateStatus: () => true });
}

/** The 100-requests-a-minute limiter is per address; a pause every so often keeps this run under it. */
let calls = 0;
async function paced<T>(fn: () => Promise<T>): Promise<T> {
  if (++calls % 60 === 0) { console.log('     (pausing a minute for the rate limiter)'); await sleep(61_000); }
  return fn();
}

async function partA() {
  console.log(`A. A SHOP OPENED TODAY  (${BASE})`);

  // ── Set up the way platform-admin onboardClient does, minus the email ──
  const roleIds = await seedRolesForClient(SHOP);
  await seedCatalogDefaultsForClient(SHOP);
  const store = await prisma.stockLocation.create({ data: { clientId: SHOP, code: 'MAIN-STORE', name: 'Main Store', type: 'STORE', active: true } });
  await prisma.clientSettings.upsert({ where: { clientId: SHOP }, create: { clientId: SHOP, businessName: 'New Boutique' }, update: {} });

  const people: Record<string, { id: string; api: AxiosInstance }> = {};
  for (const role of ['SUPER_ADMIN', 'ADMIN', 'SALES', 'WAREHOUSE', 'INVENTORY_MANAGER']) {
    const u = await prisma.user.create({ data: { clientId: SHOP, email: `${role.toLowerCase()}-${STAMP}@example.com`, name: role, password: 'unused', status: 'ACTIVE' } });
    await prisma.userRole.create({ data: { userId: u.id, roleId: roleIds[role] } });
    people[role] = { id: u.id, api: await login(u.id, SHOP) };
  }
  const nobody = await prisma.user.create({ data: { clientId: SHOP, email: `norole-${STAMP}@example.com`, name: 'No role', password: 'unused', status: 'ACTIVE' } });
  const noRole = await login(nobody.id, SHOP);
  const leaver = await prisma.user.create({ data: { clientId: SHOP, email: `left-${STAMP}@example.com`, name: 'Left', password: 'unused', status: 'INACTIVE' } });
  await prisma.userRole.create({ data: { userId: leaver.id, roleId: roleIds.ADMIN } });
  const switchedOff = await login(leaver.id, SHOP);
  const owner = people.SUPER_ADMIN.api;

  // ── An empty shop ──
  console.log('\n  -- An empty shop --');
  const emptyList = await paced(() => owner.get('/offers'));
  check('the offers list of a shop with no offers loads, empty', emptyList.status === 200 && Array.isArray(un(emptyList)) && un(emptyList).length === 0, brief(emptyList));
  const emptyOptions = await paced(() => owner.get('/offers/options'));
  check('  ...and so do the choices for a new offer', emptyOptions.status === 200, brief(emptyOptions));
  await prisma.clientSettings.deleteMany({ where: { clientId: SHOP } });
  forgetShopSettings(SHOP);
  const noRow = await paced(() => owner.get('/offers/settings'));
  check('a shop with no settings row at all: no till limit, not an error', noRow.status === 200 && un(noRow)?.manualDiscountMaxPercent == null, brief(noRow));
  check('  ...and pricing falls back to India time for it', (await getShopSettings(SHOP)).timezone === 'Asia/Kolkata', JSON.stringify(await getShopSettings(SHOP)));
  const missing = await paced(() => owner.get('/offers/00000000-0000-0000-0000-000000000000'));
  check('an offer page for an offer that does not exist says so plainly', missing.status === 404 && !leaks(JSON.stringify(missing.data)), brief(missing));

  const p = await prisma.product.create({ data: { clientId: SHOP, productCode: 'PRD-000001', title: 'First Saree', slug: `first-saree-${STAMP}`, category: 'WOMEN', dressType: 'Saree', basePrice: 5000, status: 'ACTIVE', productType: 'READY_TO_WEAR' } });
  const v = await prisma.productVariant.create({ data: { clientId: SHOP, productId: p.id, sku: `FIRST-${STAMP}`, variantCode: `VC-FIRST-${STAMP}`, size: 'Free', colorName: 'Red', sellingPrice: 5000 } });
  await inventoryMutationService.applyMovement({ clientId: SHOP, variantId: v.id, locationId: store.id, movementType: 'IN', reason: 'PURCHASE_RECEIPT', quantityDelta: 20, unitCost: 2500 });
  const line = [{ variantId: v.id, quantity: 1 }];
  const plain = await paced(() => people.SALES.api.post('/pricing/quote', { locationId: store.id, lines: line }));
  check('a basket in a shop with no offers is priced at the tag, nothing off', plain.status === 200 && un(plain)?.total === 5000 && un(plain)?.discountTotal === 0, brief(plain));

  // ── What each role may do ──
  console.log('\n  -- What each role may do --');
  const draftFor = (name: string) => ({ name, trigger: 'AUTOMATIC', level: 'LINE', valueType: 'PERCENTAGE', value: 10, scope: 'ALL', startsAt: new Date(Date.now() - 60_000).toISOString() });
  const matrix: { role: string; see: boolean; create: boolean; settings: boolean; codes: boolean; quote: boolean }[] = [
    { role: 'SUPER_ADMIN', see: true, create: true, settings: true, codes: true, quote: true },
    { role: 'ADMIN', see: true, create: true, settings: true, codes: true, quote: true },
    { role: 'SALES', see: true, create: false, settings: false, codes: false, quote: true },
    { role: 'WAREHOUSE', see: true, create: false, settings: false, codes: false, quote: false },
    { role: 'INVENTORY_MANAGER', see: true, create: false, settings: false, codes: false, quote: false }
  ];
  const probe = await offerService.create(SHOP, draftFor('Role probe') as any, people.SUPER_ADMIN.id) as any;
  check("a new shop's offers are numbered from OFR-000001", probe.offerCode === 'OFR-000001', probe.offerCode);
  for (const m of matrix) {
    const api = people[m.role].api;
    const allowed = (r: any, yes: boolean) => (yes ? r.status < 400 : r.status === 403);
    const list = await paced(() => api.get('/offers'));
    const page = await paced(() => api.get(`/offers/${probe.id}`));
    const create = await paced(() => api.post('/offers', draftFor(`By ${m.role}`)));
    const settings = await paced(() => api.put('/offers/settings', { manualDiscountMaxPercent: null }));
    const codes = await paced(() => api.get(`/offers/${probe.id}/codes`));
    const quote = await paced(() => api.post('/pricing/quote', { locationId: store.id, lines: line }));
    const results = [
      ['sees the offers list', allowed(list, m.see), list],
      ['opens an offer page', allowed(page, m.see), page],
      [m.create ? 'creates an offer' : 'is refused creating an offer', allowed(create, m.create), create],
      [m.settings ? 'changes the till limit' : 'is refused changing the till limit', allowed(settings, m.settings), settings],
      [m.codes ? 'lists single-use codes' : 'is refused listing single-use codes', allowed(codes, m.codes), codes],
      [m.quote ? 'prices a basket' : 'is refused pricing a basket', allowed(quote, m.quote), quote]
    ] as const;
    const wrong = results.filter(r => !r[1]);
    check(`${m.role}: ${results.map(r => r[0]).join(', ')}`, wrong.length === 0, wrong.map(w => `${w[0]} -> ${brief(w[2])}`).join(' | '));
    const refusals = [create, settings, codes, quote].filter(r => r.status === 403);
    check(`  ...every refusal for ${m.role} is a sentence, not a stack`, refusals.every(r => typeof r.data?.message === 'string' && !leaks(JSON.stringify(r.data))));
  }
  await prisma.offerVersion.deleteMany({ where: { offer: { clientId: SHOP } } });
  await prisma.offer.deleteMany({ where: { clientId: SHOP } });

  const noRoleList = await paced(() => noRole.get('/offers'));
  check('somebody with no role at all is refused, in words', noRoleList.status === 403 && typeof noRoleList.data?.message === 'string', brief(noRoleList));
  const offList = await paced(() => switchedOff.get('/offers'));
  check('somebody whose account was switched off is turned away', offList.status === 401, brief(offList));

  // ── The first day with offers ──
  console.log('\n  -- The first day with offers --');
  const first = await paced(() => owner.post('/offers', { ...draftFor('Opening week 10%'), scope: 'DRESS_TYPE', targets: [{ scope: 'DRESS_TYPE', refId: 'saree' }] }));
  const firstId = un(first)?.id;
  check('the first real offer is saved over HTTP, with the next number', first.status === 201 && /^OFR-\d{6}$/.test(un(first)?.offerCode ?? '') && un(first)?.offerCode !== 'OFR-000001', brief(first));
  const started = await paced(() => owner.post(`/offers/${firstId}/status`, { status: 'ACTIVE' }));
  check('  ...and started', started.status === 200, brief(started));
  const firstQuote = await paced(() => people.SALES.api.post('/pricing/quote', { locationId: store.id, lines: line }));
  check('  ...a salesperson now prices the saree at 10% off', un(firstQuote)?.discountTotal === 500, brief(firstQuote));

  const vipCustomer = await paced(() => people.SALES.api.post('/customers', { name: 'First VIP', phone: `7${String(STAMP).slice(-9)}`, tags: ['VIP'] }));
  const vipId = un(vipCustomer)?.id;
  check("a salesperson adds the shop's first customer, straight into the VIP group", vipCustomer.status === 201 && (un(vipCustomer)?.tags ?? []).includes('VIP'), brief(vipCustomer));
  const walkIn = await prisma.customer.create({ data: { clientId: SHOP, customerCode: 'CUS-W', name: 'Walk-in', status: 'ACTIVE' } });
  const vipOffer = await offerService.create(SHOP, { ...draftFor('VIP extra 5%'), value: 5, stackable: true, customerTags: ['vip'] } as any, people.ADMIN.id) as any;
  await offerService.setStatus(SHOP, vipOffer.id, 'ACTIVE', people.ADMIN.id);
  const forVip = un(await paced(() => people.SALES.api.post('/pricing/quote', { locationId: store.id, customerId: vipId, lines: line })));
  const forWalkIn = un(await paced(() => people.SALES.api.post('/pricing/quote', { locationId: store.id, customerId: walkIn.id, lines: line })));
  check('the VIP gets the group offer on top (500 + 225)', forVip?.discountTotal === 725, JSON.stringify(forVip?.discounts));
  check('  ...the walk-in does not', forWalkIn?.discountTotal === 500, JSON.stringify(forWalkIn?.discounts));
  const wrongPerson = await paced(() => people.SALES.api.post('/sales-orders/full', { locationId: store.id, quoteId: forVip?.quoteId, customer: { id: walkIn.id }, items: line }));
  check("  ...and the VIP's price cannot be rung up for the walk-in", wrongPerson.status === 400 && /different customer/.test(wrongPerson.data?.message ?? ''), brief(wrongPerson));
  const vipOrder = await paced(() => people.SALES.api.post('/sales-orders/full', { locationId: store.id, quoteId: forVip?.quoteId, customer: { id: vipId }, items: line, status: 'CONFIRMED' }));
  check("the shop's first order goes through at the quoted price", vipOrder.status === 201 && Number(un(vipOrder)?.total) === 4275, brief(vipOrder));

  const cards = await offerService.create(SHOP, { ...draftFor('Welcome card 300'), trigger: 'CODE', uniqueCodes: true, level: 'ORDER', valueType: 'FIXED_AMOUNT', value: 300, stackable: true } as any, people.ADMIN.id) as any;
  const made = await paced(() => people.ADMIN.api.post(`/offers/${cards.id}/codes`, { prefix: 'WELCOME', count: 3 }));
  check('a manager makes the first batch of single-use cards', made.status === 201 && un(made)?.made === 3, brief(made));
  const cardList = await paced(() => people.ADMIN.api.get(`/offers/${cards.id}/codes`, { params: { all: 1 } }));
  const [card] = (un(cardList)?.codes ?? []).map((c: any) => c.code);
  await offerService.setStatus(SHOP, cards.id, 'ACTIVE', people.ADMIN.id);
  const withCard = un(await paced(() => people.SALES.api.post('/pricing/quote', { locationId: store.id, customerId: walkIn.id, lines: line, couponCodes: [String(card).toLowerCase()] })));
  check('  ...and a salesperson takes one at the till, typed in lower case', withCard?.discountTotal === 800, JSON.stringify({ d: withCard?.discountTotal, r: withCard?.rejected }));

  const firstPage = await paced(() => people.WAREHOUSE.api.get(`/offers/${firstId}`));
  check('a packer opens the first offer and sees it was used once', firstPage.status === 200 && un(firstPage)?.stats?.timesUsed === 1, brief(firstPage));
  const copy = await paced(() => people.ADMIN.api.post(`/offers/${firstId}/duplicate`));
  check('a manager copies it for next week, as a draft', copy.status === 201 && un(copy)?.status === 'DRAFT', brief(copy));

  // ── The till limit ──
  console.log('\n  -- The till limit --');
  const setLimit = await paced(() => owner.put('/offers/settings', { manualDiscountMaxPercent: 10 }));
  check('the owner sets a 10% till limit on a shop that had no settings row', setLimit.status === 200 && un(setLimit)?.manualDiscountMaxPercent === 10, brief(setLimit));
  await offerService.setStatus(SHOP, firstId, 'PAUSED', people.SUPER_ADMIN.id);
  await offerService.setStatus(SHOP, vipOffer.id, 'PAUSED', people.SUPER_ADMIN.id);
  await offerService.setStatus(SHOP, cards.id, 'PAUSED', people.SUPER_ADMIN.id);
  const byHand = (amount: number) => ({ locationId: store.id, customer: { id: walkIn.id }, items: [{ variantId: v.id, quantity: 1, manualDiscount: { amount, reason: 'Small stain on the pallu' } }] });
  const salesFine = await paced(() => people.SALES.api.post('/sales-orders/full', byHand(500)));
  check('a salesperson takes 10% off by hand', salesFine.status === 201, brief(salesFine));
  const salesOver = await paced(() => people.SALES.api.post('/sales-orders/full', byHand(750)));
  check('  ...15% is refused, and told a manager has to', salesOver.status === 403 && /manager/i.test(salesOver.data?.message ?? ''), brief(salesOver));
  const adminOver = await paced(() => people.ADMIN.api.post('/sales-orders/full', byHand(750)));
  check('a manager (ADMIN) may take 15% off', adminOver.status === 201, brief(adminOver));
  const ownerOver = await paced(() => owner.post('/sales-orders/full', byHand(1000)));
  check('  ...and so may the owner', ownerOver.status === 201, brief(ownerOver));
  const warehouseHand = await paced(() => people.WAREHOUSE.api.post('/sales-orders/full', byHand(100)));
  check('a packer cannot take money off at all', warehouseHand.status === 403, brief(warehouseHand));

  // ── What the platform console sees of this shop ──
  console.log('\n  -- The platform console (Offers & Shopify) --');
  // Spend every remaining card, park a Shopify order, and take a permission away from the shop's
  // salespeople -- the three things the screen exists to point at.
  await offerService.setStatus(SHOP, cards.id, 'ACTIVE', people.ADMIN.id);
  await prisma.offerCode.updateMany({ where: { offerId: cards.id, usedAt: null }, data: { usedAt: new Date() } });
  await prisma.shopifyOrderInbox.create({ data: { clientId: SHOP, shopDomain: `${SHOP}.myshopify.com`, shopifyOrderId: String(STAMP), topic: 'orders/create', payload: {}, reason: 'UNMAPPED_VARIANT' } });
  const salesManual = await prisma.permission.findUniqueOrThrow({ where: { key: 'offer:manual_discount' } });
  await prisma.rolePermission.deleteMany({ where: { roleId: roleIds.SALES, permissionId: salesManual.id } });
  const health = await offersHealthService.overview();
  const mine = health.clients.find(c => c.clientId === SHOP);
  check('the console lists the new shop', !!mine);
  check('  ...with its running offers and the uses of the last 30 days', (mine?.offers.running ?? 0) >= 1 && (mine?.last30Days.uses ?? 0) >= 2, JSON.stringify({ offers: mine?.offers, used: mine?.last30Days }));
  check('  ...the till limit it set', mine?.tillLimitPercent === 10, String(mine?.tillLimitPercent));
  check('  ...and says, in words, that its cards ran out, a Shopify order is waiting and a role lost a permission',
    !!mine && mine.offers.outOfCodes === 1 && mine.shopify.ordersWaiting === 1
      && mine.attention.some(a => /no single-use codes left/.test(a))
      && mine.attention.some(a => /Shopify order is waiting/.test(a))
      && mine.attention.some(a => /missing offer permissions/.test(a))
      && mine.rolesMissingOfferPermissions.some(r => /^SALES: offer:manual_discount$/.test(r)),
    JSON.stringify(mine?.attention) + ' ' + JSON.stringify(mine?.rolesMissingOfferPermissions));
  check('  ...and a shop needing attention is listed before the ones that do not', health.clients.findIndex(c => c.clientId === SHOP) < health.clients.findIndex(c => c.attention.length === 0) || health.clients.every(c => c.attention.length > 0));
  const overHttp = await paced(() => owner.get('/admin/offers-health'));
  check("a shop's own owner cannot reach the console's screen", overHttp.status === 404 || overHttp.status === 401 || overHttp.status === 403, brief(overHttp));
  await prisma.shopifyOrderInbox.deleteMany({ where: { clientId: SHOP } });

  // ── Another shop ──
  console.log('\n  -- Another shop --');
  const demoOffer = await prisma.offer.findFirst({ where: { clientId: { not: SHOP } }, select: { id: true } });
  if (demoOffer) {
    const peek = await paced(() => owner.get(`/offers/${demoOffer.id}`));
    check("the new shop's owner cannot open another shop's offer", peek.status === 404, brief(peek));
  } else {
    check("the new shop's owner cannot open another shop's offer (no other offers exist to try)", true);
  }
}

async function partB() {
  console.log('\nB. EVERY SHOP ALREADY HERE (read only)');
  const shops = (await prisma.user.findMany({ where: { NOT: { clientId: { startsWith: 'new-shop-' } } }, distinct: ['clientId'], select: { clientId: true } })).map(u => u.clientId);
  console.log(`     ${shops.length} shops`);

  // Roles: what a built-in role in an existing shop is missing compared with a new shop's.
  const drift: string[] = [];
  for (const shop of shops) {
    const roles = await prisma.role.findMany({
      where: { clientId: shop, name: { in: Object.keys(RBAC_DATA.roles) } },
      select: { name: true, permissions: { select: { permission: { select: { key: true } } } } }
    });
    for (const r of roles) {
      const expected = (RBAC_DATA.roles as any)[r.name].permissions as readonly string[];
      if (expected.includes('*')) continue;
      const held = new Set(r.permissions.map(x => x.permission.key));
      const lacking = expected.filter(k => k.startsWith('offer:') && !held.has(k));
      if (lacking.length) drift.push(`${shop}/${r.name}: ${lacking.join(',')}`);
    }
  }
  check('every built-in role in every shop holds the offer permissions a new shop gets', drift.length === 0, drift.slice(0, 12).join(' | '));

  let listed = 0, pages = 0, invalid: string[] = [], priced = 0, broken: string[] = [], thrown: string[] = [];
  for (const shop of shops) {
    try {
      const [list] = await Promise.all([offerService.list(shop), offerInsightService.options(shop), offerService.getSettings(shop)]);
      listed++;
      for (const o of list as any[]) {
        await offerInsightService.detail(shop, o.id);
        pages++;
        if (o.status === 'ARCHIVED') continue;
        const full = await prisma.offer.findUniqueOrThrow({ where: { id: o.id }, include: { targets: true, exclusions: true } });
        const problems = validateOffer({
          ...full, value: Number(full.value),
          maxDiscount: full.maxDiscount == null ? null : Number(full.maxDiscount),
          minSubtotal: full.minSubtotal == null ? null : Number(full.minSubtotal),
          targets: full.targets.map(t => ({ scope: t.scope, refId: t.refId })),
          exclusions: full.exclusions.map(t => ({ scope: t.scope, refId: t.refId })),
          // An end date that has simply passed is time, not a broken offer.
          endsAt: full.endsAt && full.endsAt <= new Date() ? null : full.endsAt
        } as any);
        if (problems.length) invalid.push(`${shop}/${full.offerCode}: ${problems.join(' ')}`);
      }

      // Price a basket of up to five of this shop's own real items, at each open location, against
      // its live offers -- through the same loading and arithmetic a quote uses, without saving one.
      const locations = await prisma.stockLocation.findMany({ where: { clientId: shop, active: true }, select: { id: true } });
      const variants = await prisma.productVariant.findMany({
        where: { clientId: shop, product: { status: 'ACTIVE' } }, take: 5,
        include: { locationProfiles: true, product: { select: { id: true, category: true, dressType: true, basePrice: true, title: true } } }
      });
      for (const loc of locations) {
        for (const channel of ['POS', 'ONLINE']) {
          const offers = await pricingQuoteService.liveOffers(shop, channel, loc.id, null, []);
          await pricingQuoteService.publicOffers(shop, channel, loc.id);
          const basket = variants.map(vr => {
            const r = resolveVariantForLocation(vr as any, loc.id, Number(vr.product.basePrice));
            return r.isAvailable ? {
              variantId: vr.id, productId: vr.product.id, category: vr.product.category, dressType: vr.product.dressType,
              quantity: 2, listUnitPriceMinor: toMinor(r.price ?? 0)
            } : null;
          }).filter(Boolean) as any[];
          if (basket.length === 0) continue;
          const out = priceBasket(basket, offers, []);
          priced++;
          const sum = out.lines.reduce((s, l) => s + l.lineTotalMinor, 0);
          if (out.totalMinor < 0 || sum !== out.totalMinor || out.discountTotalMinor > out.subtotalMinor || out.lines.some(l => l.lineTotalMinor < 0)) {
            broken.push(`${shop}@${loc.id}/${channel}: total ${out.totalMinor}, lines ${sum}, off ${out.discountTotalMinor} of ${out.subtotalMinor}`);
          }
        }
      }
    } catch (e: any) {
      thrown.push(`${shop}: ${e?.message ?? e}`);
    }
  }
  check(`the offers list, choices and settings load for every shop (${listed} of ${shops.length})`, thrown.length === 0 && listed === shops.length, thrown.slice(0, 5).join(' | '));
  check(`every offer's own page loads (${pages} offers)`, thrown.length === 0);
  check('every offer still running or waiting passes today\'s checks, so it can be edited and started', invalid.length === 0, invalid.slice(0, 8).join(' | '));
  check(`every shop's live offers price its own items, and the money adds up (${priced} baskets)`, broken.length === 0, broken.slice(0, 5).join(' | '));

  const badTags = await prisma.$queryRaw<{ n: bigint }[]>`SELECT COUNT(*) AS n FROM customers WHERE tags IS NULL`;
  check('no customer anywhere has a missing group list', Number(badTags[0].n) === 0, String(badTags[0].n));
}

async function main() {
  await partA();
  await partB();
}

main()
  .catch(e => { failed++; failures.push(`crashed: ${e?.message ?? e}`); console.error(e); })
  .finally(async () => {
    const c = SHOP;
    try {
      await prisma.inventoryAlert.deleteMany({ where: { clientId: c } });
      await prisma.salesOrderItemDiscount.deleteMany({ where: { salesOrderItem: { salesOrder: { clientId: c } } } });
      await prisma.salesOrderDiscount.deleteMany({ where: { salesOrder: { clientId: c } } });
      await prisma.inventoryReservation.deleteMany({ where: { clientId: c } });
      await prisma.salesOrderItem.deleteMany({ where: { salesOrder: { clientId: c } } });
      await prisma.salesOrder.deleteMany({ where: { clientId: c } });
      await prisma.pricingQuote.deleteMany({ where: { clientId: c } });
      await prisma.offerRedemption.deleteMany({ where: { clientId: c } });
      await prisma.offerCode.deleteMany({ where: { clientId: c } });
      await prisma.offerVersion.deleteMany({ where: { offer: { clientId: c } } });
      await prisma.offer.deleteMany({ where: { clientId: c } });
      await prisma.inventoryEvent.deleteMany({ where: { variant: { clientId: c } } });
      await prisma.inventoryTransaction.deleteMany({ where: { clientId: c } });
      await prisma.inventoryStock.deleteMany({ where: { clientId: c } });
      await prisma.productVariant.deleteMany({ where: { clientId: c } });
      await prisma.product.deleteMany({ where: { clientId: c } });
      await prisma.customer.deleteMany({ where: { clientId: c } });
      await prisma.auditLog.deleteMany({ where: { clientId: c } });
      await prisma.stockLocation.deleteMany({ where: { clientId: c } });
      await prisma.userRole.deleteMany({ where: { user: { clientId: c } } });
      await prisma.user.deleteMany({ where: { clientId: c } });
      await prisma.rolePermission.deleteMany({ where: { role: { clientId: c } } });
      await prisma.role.deleteMany({ where: { clientId: c } });
      await prisma.clientCatalogItem.deleteMany({ where: { clientId: c } });
      await prisma.dailyLocationSnapshot.deleteMany({ where: { clientId: c } }).catch(() => {});
      await prisma.dailyInventorySnapshot.deleteMany({ where: { clientId: c } }).catch(() => {});
      await prisma.clientSettings.deleteMany({ where: { clientId: c } });
      await prisma.clientSequence.deleteMany({ where: { clientId: c } });
      const left = await prisma.user.count({ where: { clientId: c } }) + await prisma.offer.count({ where: { clientId: c } }) + await prisma.product.count({ where: { clientId: c } });
      check('the throwaway shop is gone', left === 0, String(left));
    } catch (e: any) {
      failed++; failures.push(`cleanup: ${e?.message ?? e}`); console.error(e);
    }
    await prisma.$disconnect();
    console.log(`\nRESULT: ${passed} passed | ${failed} failed`);
    if (failures.length) console.log('Failures:\n  - ' + failures.join('\n  - '));
    process.exit(failed ? 1 : 0);
  });
