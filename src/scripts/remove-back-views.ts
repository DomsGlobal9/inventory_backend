/**
 * Takes every generated BACK view off every product (29 Oct, owner: "we don't need the back view").
 *
 * The photo studio no longer makes one and the app refuses one; this clears the ones already made,
 * so they leave the admin gallery, the online shop and (re-pushed) Shopify at once.
 *
 * KEPT, SO IT CAN BE UNDONE: only the rows go. The picture files stay in storage, and every row is
 * written to a backup file first (all its fields), so a row can be put back exactly. A shop's own
 * photograph is never touched -- only rows the studio made (generated) and labelled back.
 *
 * A back view that was a colour's main photograph (its front never arrived) hands that role to the
 * colour's front, or else its first remaining picture, so no colour is left without one.
 *
 *   npx tsx src/scripts/remove-back-views.ts                 dry run: says what it would do
 *   npx tsx src/scripts/remove-back-views.ts --apply         does it
 *   ... --client=<id>                                        one shop only
 *   BACKUP_DIR=<dir> (default D:/downloads/back-views)       where the backup goes
 */
import fs from 'fs';
import path from 'path';
import { prisma } from '../lib/prisma';
import { markProductForShopify } from '../services/shopify-products/dirty';

const APPLY = process.argv.includes('--apply');
const CLIENT = process.argv.find(a => a.startsWith('--client='))?.slice('--client='.length) || null;
const BACKUP_DIR = process.env.BACKUP_DIR || 'D:/downloads/back-views';

async function main() {
  const where = { generated: true, view: 'back', ...(CLIENT ? { product: { clientId: CLIENT } } : {}) };
  const rows = await prisma.productImage.findMany({ where, include: { product: { select: { clientId: true, title: true } } } });
  const products = [...new Set(rows.map(r => r.productId).filter(Boolean))] as string[];
  const byShop = new Map<string, number>();
  for (const r of rows) byShop.set(r.product?.clientId ?? '?', (byShop.get(r.product?.clientId ?? '?') ?? 0) + 1);

  console.log(`${APPLY ? 'REMOVING' : 'DRY RUN --'} back views${CLIENT ? ` for ${CLIENT}` : ' on every shop'}`);
  console.log(`  ${rows.length} back views on ${products.length} products`);
  for (const [shop, n] of byShop) console.log(`    ${shop}: ${n}`);
  const mains = rows.filter(r => r.isPrimary);
  console.log(`  ${mains.length} of them are a colour's main photograph; that role moves to another picture of the colour`);
  if (!rows.length) return;

  if (!APPLY) { console.log('\nNothing changed. Run again with --apply to remove them.'); return; }

  // The backup, before anything is touched.
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const backup = path.join(BACKUP_DIR, `back-views-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  fs.writeFileSync(backup, JSON.stringify(rows.map(({ product, ...r }) => r), null, 2));
  console.log(`  backup written: ${backup}`);

  let moved = 0;
  for (const r of mains) {
    // The colour's front first, then whatever is left in its order. The same colour = same variant.
    const next = await prisma.productImage.findFirst({
      // view: null said out loud. NOT { view: 'back' } alone is "view <> 'back'" in SQL, which is
      // never true for a NULL -- and the shop's own photographs are exactly the ones with no view.
      where: { productId: r.productId, variantId: r.variantId, id: { not: r.id }, OR: [{ view: null }, { view: { not: 'back' } }] },
      orderBy: [{ orderIndex: 'asc' }, { createdAt: 'asc' }]
    });
    const front = await prisma.productImage.findFirst({
      where: { productId: r.productId, variantId: r.variantId, view: 'front', id: { not: r.id } }
    });
    const heir = front ?? next;
    if (heir && !heir.isPrimary) { await prisma.productImage.update({ where: { id: heir.id }, data: { isPrimary: true } }); moved++; }
  }

  const gone = await prisma.productImage.deleteMany({ where: { id: { in: rows.map(r => r.id) } } });
  for (const id of products) await markProductForShopify(id);

  const left = await prisma.productImage.count({ where });
  console.log(`  removed ${gone.count}; main photograph moved on ${moved} colours; ${products.length} products queued for Shopify (only those on Shopify are sent)`);
  console.log(`  back views left: ${left}`);
}

main()
  .catch(e => { console.error('STOPPED:', e?.message ?? e); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
