/**
 * Make the front view the main photograph, for colours generated before that was the rule.
 *
 * From now on a newly published product marks its front view as the main photograph. Products
 * generated before that lead with whatever the shop uploaded first -- usually the flat-lay, which
 * is the garment on a table rather than on a person.
 *
 * DRY RUN unless you pass --apply. This changes what shoppers see on shops that are already
 * open, so it prints exactly what it would do and does nothing until asked twice.
 *
 * It deliberately leaves alone any colour whose main photograph is ALREADY a generated view: that
 * is a shop having chosen a different angle on purpose, and a tidy-up script does not get to
 * overrule somebody's choice.
 *
 *   npx tsx src/scripts/support/frontViewLeads.ts            # show me what would change
 *   npx tsx src/scripts/support/frontViewLeads.ts --apply    # do it
 *   npx tsx src/scripts/support/frontViewLeads.ts --apply --client=demo-client
 */
import { prisma } from '../../lib/prisma';

async function main() {
  const apply = process.argv.includes('--apply');
  const only = process.argv.find(a => a.startsWith('--client='))?.split('=')[1];

  const fronts = await prisma.productImage.findMany({
    where: { view: 'front', NOT: { variantId: null }, ...(only ? { product: { clientId: only } } : {}) },
    select: {
      id: true, variantId: true, isPrimary: true, altText: true,
      product: { select: { clientId: true, title: true } }
    }
  });

  let already = 0, chosenOtherwise = 0;
  const toPromote: { id: string; variantId: string; label: string }[] = [];

  for (const front of fronts) {
    if (front.isPrimary) { already++; continue; }

    // What leads this colour today, if anything.
    const current = await prisma.productImage.findFirst({
      where: { variantId: front.variantId, isPrimary: true },
      select: { generated: true, view: true, altText: true }
    });

    // A generated view already leading means the shop picked that angle. Left alone.
    if (current?.generated) { chosenOtherwise++; continue; }

    toPromote.push({
      id: front.id,
      variantId: front.variantId!,
      label: `${front.product?.clientId} / ${front.product?.title} :: ${front.altText}` +
             (current ? `  (replacing "${current.altText}")` : '  (nothing led this colour)')
    });
  }

  console.log(`front views found:                 ${fronts.length}`);
  console.log(`  already the main photograph:     ${already}`);
  console.log(`  a generated view leads already:  ${chosenOtherwise}  (left alone -- somebody chose it)`);
  console.log(`  would be promoted:               ${toPromote.length}`);
  for (const t of toPromote) console.log(`      ${t.label}`);

  if (!apply) {
    console.log('\nNothing changed. Run it again with --apply to make these the main photographs.');
    return;
  }

  let done = 0;
  for (const t of toPromote) {
    // One main photograph per colour, so the old one steps down in the same breath as the new one
    // steps up -- two shops' worth of photographs showing PRIMARY twice is worse than neither.
    await prisma.$transaction([
      prisma.productImage.updateMany({ where: { variantId: t.variantId, isPrimary: true }, data: { isPrimary: false } }),
      prisma.productImage.update({ where: { id: t.id }, data: { isPrimary: true } })
    ]);
    done++;
  }
  console.log(`\npromoted ${done} front view(s) to be the main photograph of their colour.`);
}

main().catch(e => { console.error('STOPPED:', e?.message); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
