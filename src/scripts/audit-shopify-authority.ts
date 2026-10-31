/**
 * Is ScaleEzy winning in every connected Shopify store? READ-ONLY (30 Oct).
 *
 * ScaleEzy is the one place that decides price, GST and stock (owner, 26 Oct). This reads each live
 * store through the app's own connection and the database, and reports every place the two disagree:
 *
 *   1. the connection     installed, claimed, the permissions the app needs, store tax setting
 *   2. locations          Shopify locations paired with ours
 *   3. products           each synced product: status, every variant's price and compare-at price,
 *                         "charge tax" off, stock at every paired location -- against what ScaleEzy
 *                         would send right now
 *   4. products we skip   products in the store that ScaleEzy does not manage at all
 *   5. discounts          each mirrored offer's state (synced / drifted / refused)
 *   6. orders             Shopify orders here, GST worked out by ScaleEzy, orders still waiting (parked)
 *
 * Nothing is written anywhere: Shopify is only queried, the database only read.
 *   npx tsx src/scripts/audit-shopify-authority.ts            every connected store
 *   npx tsx src/scripts/audit-shopify-authority.ts --client=sphl
 */
import { prisma } from '../lib/prisma';
import { adminApiFor } from '../services/shopify-mapping/adminApi';
import { shopifyProductPushService } from '../services/shopify-products/push.service';
import { renderProduct } from '../services/shopify-products/render';

const ONLY = process.argv.find(a => a.startsWith('--client='))?.slice(9) || null;
const NEEDED_SCOPES = ['read_products', 'write_products', 'read_inventory', 'write_inventory', 'read_orders', 'read_locations', 'write_discounts'];
const problems: string[] = [];
const say = (s = '') => console.log(s);
const bad = (s: string) => { problems.push(s); console.log(`  ✗ ${s}`); };
const good = (s: string) => console.log(`  ✓ ${s}`);

const PRODUCT_Q = `query P($id: ID!) { product(id: $id) { id title status tags
  variants(first: 100) { nodes { id sku price compareAtPrice taxable
    inventoryItem { id tracked inventoryLevels(first: 20) { nodes { location { id } quantities(names: ["available"]) { quantity } } } } } } } }`;

async function main() {
  const installs = await prisma.shopifyInstallation.findMany({
    where: { uninstalledAt: null, ...(ONLY ? { clientId: ONLY } : {}) },
    select: { id: true, shopDomain: true, clientId: true, scopes: true, claimedAt: true, installedAt: true }
  });
  say(`Connected Shopify stores: ${installs.length}${ONLY ? ` (only ${ONLY})` : ''}`);

  for (const inst of installs) {
    say(`\n════════ ${inst.shopDomain}  →  ${inst.clientId ?? '(not claimed by any shop)'}`);
    if (!inst.clientId) { bad(`${inst.shopDomain}: installed but not claimed by a ScaleEzy shop, so nothing is kept in step`); continue; }
    const api = await adminApiFor(inst.id, inst.shopDomain);

    say('\n1. The connection');
    const head: any = await api.graphql(`{ shop { name currencyCode taxesIncluded } currentAppInstallation { accessScopes { handle } } }`);
    const scopes: string[] = (head?.currentAppInstallation?.accessScopes ?? []).map((s: any) => s.handle);
    const missing = NEEDED_SCOPES.filter(s => !scopes.includes(s) && !scopes.includes(s.replace('read_', 'write_')));
    missing.length ? bad(`permissions missing: ${missing.join(', ')}`) : good(`permissions in place (${scopes.length} granted)`);
    const settings = await prisma.clientSettings.findUnique({ where: { clientId: inst.clientId }, select: { currency: true } as any }).catch(() => null) as any;
    say(`  store "${head?.shop?.name}", currency ${head?.shop?.currencyCode}${settings?.currency ? ` (ScaleEzy ${settings.currency})` : ''}, prices include tax: ${head?.shop?.taxesIncluded}`);
    if (settings?.currency && settings.currency !== head?.shop?.currencyCode) bad(`currency differs: Shopify ${head?.shop?.currencyCode}, ScaleEzy ${settings.currency}`);

    say('\n2. Locations');
    const pairs = await prisma.shopifyLocationMap.findMany({ where: { installationId: inst.id }, select: { locationId: true, shopifyLocationId: true } });
    const locs: any = await api.graphql(`{ locations(first: 50) { nodes { id name isActive fulfillsOnlineOrders } } }`);
    const names = new Map((locs?.locations?.nodes ?? []).map((l: any) => [l.id.split('/').pop(), l.name]));
    pairs.length ? good(`${pairs.length} paired: ${pairs.map(p => names.get(p.shopifyLocationId) ?? p.shopifyLocationId).join(', ')}`) : bad('no location paired: orders park and no stock is sent');
    const unpaired = (locs?.locations?.nodes ?? []).filter((l: any) => l.isActive && l.fulfillsOnlineOrders && !pairs.some(p => p.shopifyLocationId === l.id.split('/').pop()));
    if (unpaired.length) bad(`Shopify sells from locations ScaleEzy does not keep: ${unpaired.map((l: any) => l.name).join(', ')} (their stock is Shopify's own)`);

    say('\n3. Products ScaleEzy keeps in step');
    const mirrors = await prisma.shopifyProductMirror.findMany({
      where: { installationId: inst.id },
      select: { id: true, origin: true, status: true, wanted: true, problem: true, shopifyProductId: true, productId: true, stockPending: true,
        product: { select: { productCode: true, title: true, status: true } } }
    });
    const by = (f: (m: any) => boolean) => mirrors.filter(f).length;
    say(`  ${mirrors.length} on Shopify: ${by(m => m.origin === 'CREATED')} made by ScaleEzy, ${by(m => m.origin === 'MATCHED')} built in Shopify and matched by SKU`);
    say(`  status: ${by(m => m.status === 'SYNCED')} synced, ${by(m => m.status === 'PENDING')} waiting to send, ${by(m => m.status === 'FAILED')} failed, ${by(m => m.status === 'ARCHIVED')} archived`);
    for (const m of mirrors.filter(m => m.status === 'FAILED' || m.problem)) bad(`${m.product.productCode} ${m.product.title}: ${m.problem ?? m.status}`);

    const scope = await (shopifyProductPushService as any).scope(inst.id);
    let checked = 0, clean = 0;
    for (const m of mirrors.filter(m => m.wanted && m.status !== 'ARCHIVED' && m.shopifyProductId)) {
      const live: any = (await api.graphql(PRODUCT_Q, { id: `gid://shopify/Product/${m.shopifyProductId}` }))?.product;
      const label = `${m.product.productCode} ${m.product.title.slice(0, 40)}`;
      checked++;
      if (!live) { bad(`${label}: gone from Shopify (ScaleEzy should put it back)`); continue; }
      const p = await (shopifyProductPushService as any).productForShopify(inst.clientId, scope.ourLocationIds, m.product.productCode);
      const eligible = !!p && m.product.status === 'ACTIVE';
      const want = p ? renderProduct(p) : null;
      const wantBySku = new Map((want?.variants ?? []).map(v => [v.sku.trim().toUpperCase(), v]));
      const ourVariants = await prisma.productVariant.findMany({ where: { productId: m.productId }, select: { id: true, sku: true } });
      const ourIdBySku = new Map(ourVariants.map(v => [v.sku.trim().toUpperCase(), v.id]));
      const stock: Map<string, number> = await (shopifyProductPushService as any).stockFor(ourVariants.map(v => v.id), scope, eligible);
      const diffs: string[] = [];
      if (m.origin === 'CREATED' && eligible && live.status !== 'ACTIVE') diffs.push(`status ${live.status} (ours: active)`);
      for (const v of live.variants.nodes) {
        const key = String(v.sku ?? '').trim().toUpperCase();
        const w = wantBySku.get(key);
        if (!w) { if (m.origin === 'CREATED') diffs.push(`variant ${v.sku || '(no SKU)'} is in Shopify but not ours`); continue; }
        if (eligible && Number(v.price) !== Number(w.price)) diffs.push(`${v.sku} price ${v.price} (ours ${w.price})`);
        const theirCmp = v.compareAtPrice ? Number(v.compareAtPrice) : null, ourCmp = w.compareAtPrice ? Number(w.compareAtPrice) : null;
        if (eligible && theirCmp !== ourCmp) diffs.push(`${v.sku} compare-at ${theirCmp ?? '-'} (ours ${ourCmp ?? '-'})`);
        if (v.taxable) diffs.push(`${v.sku} "charge tax" is ON in Shopify (must be off: the price is final)`);
        const ourId = ourIdBySku.get(key);
        for (const pair of scope.pairs) {
          const lvl = v.inventoryItem?.inventoryLevels?.nodes?.find((n: any) => n.location.id.endsWith(`/${pair.shopifyLocationId}`));
          const theirs = lvl?.quantities?.[0]?.quantity ?? null;
          const ours = ourId ? (stock.get(`${ourId}|${pair.ourLocationId}`) ?? 0) : 0;
          if (theirs !== ours) diffs.push(`${v.sku} stock at ${names.get(pair.shopifyLocationId) ?? pair.shopifyLocationId}: ${theirs ?? 'not stocked'} (ours ${ours})`);
        }
      }
      if (diffs.length) bad(`${label} [${m.origin}${m.status !== 'SYNCED' ? ', ' + m.status : ''}${m.stockPending ? ', stock queued' : ''}]: ${diffs.slice(0, 6).join('; ')}`);
      else clean++;
    }
    if (checked) good(`${clean} of ${checked} products match ScaleEzy exactly (price, compare-at, tax off, stock, status)`);

    say('\n4. Products in the store that ScaleEzy does not manage');
    const all: any[] = [];
    let after: string | null = null;
    do {
      const page: any = await api.graphql(`query($a: String) { products(first: 100, after: $a, query: "status:active") { pageInfo { hasNextPage endCursor } nodes { id title } } }`, { a: after });
      all.push(...page.products.nodes);
      after = page.products.pageInfo.hasNextPage ? page.products.pageInfo.endCursor : null;
    } while (after);
    const ours = new Set(mirrors.filter(m => m.shopifyProductId).map(m => m.shopifyProductId));
    const strangers = all.filter(p => !ours.has(p.id.split('/').pop()));
    strangers.length
      ? bad(`${strangers.length} of ${all.length} active Shopify products are not linked to ScaleEzy -- Shopify alone decides their price and stock, and their orders park: ${strangers.slice(0, 5).map(p => p.title).join(', ')}${strangers.length > 5 ? ', …' : ''}`)
      : good(`all ${all.length} active Shopify products are linked to ScaleEzy`);

    say('\n5. Discounts (offers mirrored to Shopify)');
    const offers = await prisma.offerExternalMirror.findMany({ where: { installationId: inst.id }, select: { status: true, problem: true, offer: { select: { name: true } } } as any }) as any[];
    if (!offers.length) say('  none mirrored');
    const os = new Map<string, number>(); for (const o of offers) os.set(o.status, (os.get(o.status) ?? 0) + 1);
    if (offers.length) say(`  ${[...os].map(([s, n]) => `${n} ${s.toLowerCase()}`).join(', ')}`);
    for (const o of offers.filter(o => o.status !== 'SYNCED' && o.status !== 'NOT_MIRRORABLE')) bad(`offer "${o.offer?.name}": ${o.status}${o.problem ? ' - ' + o.problem : ''}`);
    const autoDiscounts: any = await api.graphql(`{ discountNodes(first: 50, query: "status:active") { nodes { id discount { __typename ... on DiscountAutomaticBasic { title tags } ... on DiscountCodeBasic { title tags } } } } }`).catch(() => null);
    const liveDisc = autoDiscounts?.discountNodes?.nodes ?? [];
    const foreign = liveDisc.filter((d: any) => !(d.discount?.tags ?? []).some((t: string) => /^scaleezy/i.test(t)));
    if (foreign.length) bad(`${foreign.length} active discount(s) made in Shopify, not by ScaleEzy: ${foreign.map((d: any) => d.discount?.title).join(', ')}`);
    else if (liveDisc.length) good(`all ${liveDisc.length} active Shopify discounts come from ScaleEzy offers`);

    say('\n6. Orders');
    const orders = await prisma.salesOrder.findMany({
      where: { clientId: inst.clientId, sourceSystem: 'SHOPIFY' }, orderBy: { createdAt: 'desc' }, take: 50,
      select: { orderNumber: true, total: true, taxAmount: true, documentKind: true, createdAt: true, status: true }
    });
    say(`  ${orders.length} Shopify orders recorded in ScaleEzy (newest ${orders[0]?.orderNumber ?? '-'})`);
    const parked = await prisma.shopifyOrderInbox.groupBy({ by: ['reason'], where: { shopDomain: inst.shopDomain, resolvedAt: null }, _count: { id: true } });
    parked.length ? bad(`orders waiting (parked): ${parked.map(p => `${p._count.id} ${p.reason}`).join(', ')}`) : good('no Shopify order is waiting to be placed');
    const updates = await prisma.shopifyOrderUpdate.groupBy({ by: ['status'], where: { clientId: inst.clientId }, _count: { id: true } }).catch(() => [] as any[]);
    if (updates.length) say(`  updates sent back to Shopify: ${updates.map((u: any) => `${u._count.id} ${String(u.status).toLowerCase()}`).join(', ')}`);
    for (const u of updates.filter((u: any) => /FAIL|WAITING/.test(u.status))) bad(`${u._count.id} order update(s) to Shopify ${String(u.status).toLowerCase()}`);
  }

  say(`\n════════ ${problems.length ? `${problems.length} place(s) where ScaleEzy is NOT winning` : 'ScaleEzy wins everywhere it was checked'}`);
}

main()
  .catch(e => { console.error('STOPPED:', e?.message ?? e); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
