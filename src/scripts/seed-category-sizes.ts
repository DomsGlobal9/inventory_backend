/**
 * Give sizes a category, the way dress types already have one.
 *
 * The seeded catalogue had six sizes -- XS to XXL -- with no category on any of them, so the
 * Add Product wizard offered the same six for womenswear, menswear and childrenswear alike. A
 * kids garment was sold in XS to XXL when children's clothes are sold by age, and the size
 * chart shown alongside was a women's bust/waist/hips table whatever the category.
 *
 * DRESS_TYPE has been category-scoped in this same table from the start (Saree@WOMEN,
 * Lehenga@WOMEN). This does the same for SIZE.
 *
 * Deliberately ADDITIVE. The existing uncategorised sizes are left exactly where they are:
 * products already carry them on their variants, and the frontend treats untagged sizes as
 * the fallback for any category that has none of its own. Nothing that exists stops working.
 *
 *   npx ts-node src/scripts/seed-category-sizes.ts          # template + every client
 *   npx ts-node src/scripts/seed-category-sizes.ts --dry    # show what would change
 */
import { prisma } from '../lib/prisma';

const DRY = process.argv.includes('--dry');

// Backfilling every tenant changes what other people's shops offer in their product wizard,
// so it is opt-in: --client=<id> does one, --all does the lot. With neither, only the template
// is seeded, which affects nothing that already exists and everything created from here on.
const ONLY_CLIENT = (process.argv.find(a => a.startsWith('--client=')) || '').split('=')[1] || null;
const ALL_CLIENTS = process.argv.includes('--all');

// Indian ready-to-wear conventions. A starting point for a new shop, not a standard -- every
// one of these is editable per client under Settings -> Catalog Configuration.
const SIZES_BY_CATEGORY: Record<string, string[]> = {
  WOMEN: ['XS', 'S', 'M', 'L', 'XL', 'XXL'],
  MEN: ['S', 'M', 'L', 'XL', 'XXL', '3XL'],
  // Age-based, because that is what a parent buys by.
  KIDS: [
    '0-6M', '6-12M', '1-2Y', '2-3Y', '3-4Y', '4-5Y',
    '5-6Y', '6-7Y', '7-8Y', '8-10Y', '10-12Y', '12-14Y'
  ]
};

/** Kept in the order listed above, after the untagged sizes a client may already have. */
function rowsFor(base: number) {
  const rows: { value: string; label: string; category: string; sortOrder: number }[] = [];
  let sortOrder = base;
  for (const [category, sizes] of Object.entries(SIZES_BY_CATEGORY)) {
    for (const value of sizes) {
      rows.push({ value, label: value, category, sortOrder: sortOrder++ });
    }
  }
  return rows;
}

async function seedTemplate() {
  const template = await prisma.catalogTemplate.findUnique({
    where: { name: 'Default' },
    include: { items: true }
  });
  if (!template) {
    console.log('  ! no "Default" catalog template — skipping template seed');
    return;
  }

  const have = new Set(
    template.items.map(i => `${i.type}|${i.value}|${i.category ?? ''}`)
  );
  const maxSort = template.items.reduce((m, i) => Math.max(m, i.sortOrder), 0);

  const toAdd = rowsFor(maxSort + 1)
    .filter(r => !have.has(`SIZE|${r.value}|${r.category}`))
    .map(r => ({ templateId: template.id, type: 'SIZE', ...r }));

  console.log(`  template "Default": ${toAdd.length} size(s) to add`);
  if (!DRY && toAdd.length) {
    await prisma.catalogTemplateItem.createMany({ data: toAdd });
  }
}

async function seedClients() {
  const tenants = ONLY_CLIENT
    ? [{ clientId: ONLY_CLIENT }]
    : await prisma.user.findMany({ distinct: ['clientId'], select: { clientId: true } });

  let added = 0;
  let touched = 0;

  for (const { clientId } of tenants) {
    const existing = await prisma.clientCatalogItem.findMany({
      where: { clientId, type: 'SIZE' },
      select: { value: true, category: true, sortOrder: true }
    });

    // A client with no sizes at all has never been seeded; leave them to
    // seedCatalogDefaultsForClient rather than half-populating them here.
    if (existing.length === 0) continue;

    const have = new Set(existing.map(i => `${i.value}|${i.category ?? ''}`));
    const maxSort = existing.reduce((m, i) => Math.max(m, i.sortOrder), 0);

    const rows = rowsFor(maxSort + 1)
      .filter(r => !have.has(`${r.value}|${r.category}`))
      .map(r => ({ clientId, type: 'SIZE', isSystem: true, isActive: true, ...r }));

    if (rows.length === 0) continue;

    touched++;
    added += rows.length;
    if (!DRY) {
      await prisma.clientCatalogItem.createMany({ data: rows, skipDuplicates: true });
    }
  }

  console.log(`  clients: ${added} size(s) added across ${touched} of ${tenants.length} tenant(s)`);
}

(async () => {
  console.log(DRY ? 'DRY RUN — nothing will be written\n' : 'Seeding category-scoped sizes\n');
  await seedTemplate();
  if (ONLY_CLIENT || ALL_CLIENTS) {
    await seedClients();
  } else {
    console.log('  clients: skipped (pass --all to backfill every tenant, or --client=<id> for one)');
  }
  console.log('\nDone. Existing uncategorised sizes were left untouched.');
  await prisma.$disconnect();
})().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
