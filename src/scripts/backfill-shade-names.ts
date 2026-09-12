/**
 * Give every stored shade a name, and rename the variants that were saved without one.
 *
 * Shades used to be bare hex strings in the catalogue, and the product form labelled every
 * shade of a colour identically -- "Blue Shade", seven times over. That label is stored on the
 * variant and is what a supplier reads on a purchase order. Measured before this ran: on the
 * live tenant "Purple Shade" covered three different purples, "Blue Shade" and "Pink Shade"
 * two each.
 *
 * Two passes:
 *   1. catalog_template_items + client_catalog_items -- shades become { hex, name }.
 *   2. inventory_product_variants -- a variant whose colour name is a nameless "<Colour>
 *      Shade" is matched to the catalogue by its stored hex and renamed to that shade's name.
 *
 * SKUs are deliberately NOT regenerated. A SKU can already be on a printed barcode label and
 * in a supplier's own records; renaming the colour is safe, renumbering the stock code is not.
 * The three SKUs that were auto-suffixed -2 by the collision stay as they are.
 *
 * Dry run by default. Pass --apply to write.
 *
 *   npx tsx src/scripts/backfill-shade-names.ts
 *   npx tsx src/scripts/backfill-shade-names.ts --apply
 */

import { prisma } from '../lib/prisma';
import { normaliseShades, normaliseHex } from '../lib/colorNames';

const APPLY = process.argv.includes('--apply');

/** Was this colour name produced by the old unnamed-shade path? */
const isNamelessShadeLabel = (name: string | null) => /\bshade\b/i.test(String(name ?? ''));

async function backfillTemplates() {
  const items = await prisma.catalogTemplateItem.findMany({ where: { type: 'COLOR' } });
  let changed = 0;

  for (const item of items) {
    const meta = (item.metadata ?? {}) as Record<string, unknown>;
    const shades = normaliseShades(meta.shades, item.label);
    if (shades.length === 0) continue;

    const before = JSON.stringify(meta.shades);
    const after = JSON.stringify(shades);
    if (before === after) continue;

    changed++;
    console.log(`  template ${item.label.padEnd(8)} ${shades.map(s => s.name).join(', ')}`);
    if (APPLY) {
      await prisma.catalogTemplateItem.update({
        where: { id: item.id },
        data: { metadata: { ...meta, shades } }
      });
    }
  }
  return changed;
}

async function backfillClientColors() {
  const items = await prisma.clientCatalogItem.findMany({ where: { type: 'COLOR' } });
  let changed = 0;

  for (const item of items) {
    const meta = (item.metadata ?? {}) as Record<string, unknown>;
    const shades = normaliseShades(meta.shades, item.label);
    if (shades.length === 0) continue;
    if (JSON.stringify(meta.shades) === JSON.stringify(shades)) continue;

    changed++;
    if (APPLY) {
      await prisma.clientCatalogItem.update({
        where: { id: item.id },
        data: { metadata: { ...meta, shades } }
      });
    }
  }
  return changed;
}

/** hex -> shade name, for one client. Built from that client's own catalogue, never shared. */
async function shadeNamesFor(clientId: string) {
  const colors = await prisma.clientCatalogItem.findMany({
    where: { clientId, type: 'COLOR' },
    select: { label: true, metadata: true }
  });

  const byHex = new Map<string, string>();
  for (const color of colors) {
    for (const shade of normaliseShades((color.metadata as any)?.shades, color.label)) {
      // First wins. A hex that appears under two base colours -- #f5f5f5 is in both Black and
      // White -- keeps the name of whichever colour lists it first, which is the same one the
      // picker would have shown.
      if (!byHex.has(shade.hex)) byHex.set(shade.hex, shade.name);
    }
  }
  return byHex;
}

async function backfillVariants() {
  const variants = await prisma.productVariant.findMany({
    where: { colorName: { contains: 'Shade', mode: 'insensitive' } },
    select: { id: true, clientId: true, sku: true, colorName: true, hexCode: true }
  });

  const byClient = new Map<string, typeof variants>();
  for (const v of variants) {
    if (!byClient.has(v.clientId)) byClient.set(v.clientId, []);
    byClient.get(v.clientId)!.push(v);
  }

  let renamed = 0;
  const skipped: string[] = [];

  for (const [clientId, rows] of byClient) {
    const names = await shadeNamesFor(clientId);
    console.log(`\n  ${clientId} (${rows.length} shade variants, ${names.size} named shades in catalogue)`);

    for (const v of rows) {
      if (!isNamelessShadeLabel(v.colorName)) continue;

      const hex = normaliseHex(v.hexCode);
      const name = hex ? names.get(hex) : undefined;

      if (!name) {
        // No hex stored, or a hex the shop has since removed from its palette. Left alone:
        // inventing a name for a colour nobody can look up would be worse than the vague one
        // that is already there, and the shopkeeper can rename the variant themselves.
        skipped.push(`${clientId} ${v.sku} "${v.colorName}" hex=${v.hexCode ?? 'none'}`);
        continue;
      }

      renamed++;
      console.log(`    ${v.sku.padEnd(32)} "${v.colorName}" -> "${name}"`);
      if (APPLY) {
        await prisma.productVariant.update({ where: { id: v.id }, data: { colorName: name } });
      }
    }
  }

  if (skipped.length) {
    console.log(`\n  Left alone (${skipped.length}) -- no matching shade in the shop's palette:`);
    skipped.forEach(s => console.log(`    ${s}`));
  }
  return renamed;
}

/**
 * Make a variant's stored swatch agree with the shop's palette.
 *
 * Found while checking that no colour name covers two different colours: on demo-client,
 * "Red" was stored against #EF4444 on some variants and #FF0000 on others, "Blue" against
 * #3B82F6 and #0000ff. Those are the colours of a hardcoded palette that predates the
 * catalogue -- so two variants a shopkeeper calls Red draw as two visibly different reds.
 * Seven more rows differed only in the CASE of the hex, which is invisible on screen and
 * makes every comparison in code lie.
 *
 * Only variants whose colour name IS a colour in that shop's own catalogue are touched, and
 * only the swatch changes. The palette is what "Red" means in that shop; the variant is not.
 */
async function alignBaseColorHexes() {
  const colors = await prisma.clientCatalogItem.findMany({
    where: { type: 'COLOR' },
    select: { clientId: true, label: true, metadata: true }
  });

  const paletteHex = new Map<string, string>();
  for (const c of colors) {
    const hex = normaliseHex((c.metadata as any)?.hex);
    if (hex) paletteHex.set(`${c.clientId}|${c.label.toLowerCase()}`, hex);
  }

  const variants = await prisma.productVariant.findMany({
    where: { hexCode: { not: null }, colorName: { not: null } },
    select: { id: true, clientId: true, sku: true, colorName: true, hexCode: true }
  });

  let changed = 0;
  const summary = new Map<string, number>();

  for (const v of variants) {
    const want = paletteHex.get(`${v.clientId}|${String(v.colorName).toLowerCase()}`);
    if (!want || v.hexCode === want) continue;

    changed++;
    const key = `${v.clientId} ${v.colorName}: ${v.hexCode} -> ${want}`;
    summary.set(key, (summary.get(key) ?? 0) + 1);
    if (APPLY) {
      await prisma.productVariant.update({ where: { id: v.id }, data: { hexCode: want } });
    }
  }

  [...summary.entries()].forEach(([k, n]) => console.log(`  ${String(n).padStart(3)}  ${k}`));
  return changed;
}

async function main() {
  console.log(APPLY ? 'APPLYING shade names.\n' : 'DRY RUN -- nothing is written. Pass --apply to write.\n');

  console.log('Catalogue templates (new shops inherit these):');
  const templates = await backfillTemplates();
  console.log(`  ${templates} template colours updated`);

  const clientColors = await backfillClientColors();
  console.log(`\nShop palettes: ${clientColors} colours updated`);

  console.log('\nVariants saved with a nameless shade label:');
  const variants = await backfillVariants();

  console.log('\nVariants whose swatch disagrees with the shop\'s palette:');
  const realigned = await alignBaseColorHexes();

  console.log(`\n${APPLY ? 'Done' : 'Would change'}: ${templates} template colours, ${clientColors} shop colours, ${variants} variants renamed, ${realigned} swatches realigned.`);
}

main()
  .catch(e => { console.error(e); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
