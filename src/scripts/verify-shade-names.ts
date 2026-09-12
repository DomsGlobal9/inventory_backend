/**
 * A shade has a name, the name is its own, and editing a colour does not destroy it.
 *
 * The fault this guards: every shade of a colour was labelled identically -- "Blue Shade",
 * seven times over -- and that label is stored on the variant, printed on the purchase order
 * a supplier reads, and shortened into the SKU. On the live tenant it had already produced
 * three different purples sharing one name and three SKUs auto-suffixed -2 by the collision.
 *
 * Checked against real rows rather than only against fixtures, because the naming rule is
 * order-dependent: which shade claims "Grey" depends on what else is in the list. A test that
 * only ever sees a two-item list would never find that an approximate match at the top can
 * shunt an exact one off its own name.
 *
 *   npx tsx src/scripts/verify-shade-names.ts
 */
import { prisma } from '../lib/prisma';
import { normaliseShades, nameForHex, exactNameFor, normaliseHex } from '../lib/colorNames';
import { resolveColorMetadata, readColorMetadata } from '../lib/catalogMetadata';
import { HttpError } from '../utils/httpError';

let passed = 0, failed = 0;
const failures: string[] = [];
const check = (name: string, ok: boolean, detail?: string) => {
  if (ok) { passed++; console.log(`  [PASS] ${name}`); }
  else { failed++; failures.push(name); console.log(`  [FAIL] ${name}${detail ? `  -> ${detail}` : ''}`); }
};

const refuses = (fn: () => unknown): string | null => {
  try { fn(); return null; } catch (e: any) { return e instanceof HttpError ? e.message : `threw ${e?.name}`; }
};

function namingRules() {
  console.log('\nTHE NAME DESCRIBES THE COLOUR');

  check('An exact CSS colour keeps its own name', nameForHex('#4169e1') === 'Royal Blue', nameForHex('#4169e1'));
  check('Casing and short hex do not matter', normaliseHex('#ABC') === '#aabbcc' && nameForHex('#4169E1') === 'Royal Blue');

  // The bug that made the family restriction necessary: a pale green in the GREEN shade list
  // was named "Light Grey", because the numerically nearest entry happened to be a grey.
  check('A pale green is named from the greens', nameForHex('#c1e1c1') === 'Pale Green', nameForHex('#c1e1c1'));
  check('A grey is not given an invented hue', /grey/i.test(nameForHex('#555555')), nameForHex('#555555'));

  const blacks = normaliseShades(
    ['#000000', '#2f2f2f', '#555555', '#808080', '#a9a9a9', '#c0c0c0', '#e0e0e0', '#f5f5f5'],
    'Black'
  );
  const named = new Map(blacks.map(s => [s.hex, s.name]));
  // Every one of these IS that CSS colour. An approximate match arriving first must not be
  // allowed to take the name off the shade that owns it.
  check('#808080 keeps Grey', named.get('#808080') === 'Grey', named.get('#808080'));
  check('#a9a9a9 keeps Dark Grey', named.get('#a9a9a9') === 'Dark Grey', named.get('#a9a9a9'));
  check('#c0c0c0 keeps Silver', named.get('#c0c0c0') === 'Silver', named.get('#c0c0c0'));
  check('No shade of one colour shares a name', new Set(blacks.map(s => s.name)).size === blacks.length);
  check('Shades stay in palette order', blacks[0]?.hex === '#000000' && blacks[7]?.hex === '#f5f5f5');

  // A name that is merely near is better than a numbered one -- but only while it still fits.
  // "Light Grey" on a dark charcoal is what a supplier would act on.
  const dark = named.get('#555555') ?? '';
  check('A displaced name that no longer fits is refused', !/light/i.test(dark), dark);

  console.log('\nTHE SHOPKEEPER OVERRULES THE DEFAULT');

  const custom = normaliseShades([
    { hex: '#4169e1', name: 'Ramar Blue' },
    { hex: '#00008b' }
  ], 'Blue');
  check('A typed name is kept verbatim', custom[0]?.name === 'Ramar Blue', custom[0]?.name);
  check('An untyped one beside it is still named', custom[1]?.name === 'Dark Blue', custom[1]?.name);

  const collide = normaliseShades([
    { hex: '#4169e1', name: 'Royal Blue' },
    { hex: '#0000cd' },
    { hex: '#87ceeb', name: 'Royal Blue' }
  ], 'Blue');
  check('Two typed names the same are numbered, not refused',
    collide.filter(s => /^royal blue/i.test(s.name)).length === 2
    && new Set(collide.map(s => s.name)).size === 3,
    JSON.stringify(collide.map(s => s.name)));

  console.log('\nADDING A SHADE DOES NOT RENAME THE OTHERS');

  // The property that makes stored names safe. Naming is order-dependent, so if the list were
  // re-derived from hexes every time, inserting one shade could rename the ones already
  // written onto variants -- and the variant would then disagree with the palette forever.
  const before = normaliseShades(['#00008b', '#4169e1', '#87ceeb'], 'Blue');
  const after = normaliseShades([...before, { hex: '#0000cd' }], 'Blue');
  const unchanged = before.every(b => after.find(a => a.hex === b.hex)?.name === b.name);
  check('Existing shade names survive an addition', unchanged, JSON.stringify(after.map(s => s.name)));

  console.log('\nDUPLICATES AND RUBBISH');

  const dupes = normaliseShades(['#ff0000', '#FF0000', '#f00'], 'Red');
  check('One colour listed three ways is one shade', dupes.length === 1, JSON.stringify(dupes));

  const mixed = normaliseShades(['#ff0000', 'not-a-colour', null, 42, { hex: '#00008b' }], 'Red');
  check('Entries that are not colours are dropped', mixed.length === 2, JSON.stringify(mixed));
  check('A non-array shade list is empty, not a crash', normaliseShades('blue' as any).length === 0);
}

function metadataRules() {
  console.log('\nEDITING A COLOUR DOES NOT DELETE ITS SHADES');

  const stored = { hex: '#0000ff', shades: [{ hex: '#4169e1', name: 'Royal Blue' }, { hex: '#87ceeb', name: 'Sky Blue' }] };

  // The exact shape the edit form sends when someone corrects a colour's spelling. Before the
  // merge, this replaced metadata wholesale and both shades vanished.
  const afterRename = resolveColorMetadata({ hex: '#0000ff' }, stored);
  check('A hex-only update keeps the shades', afterRename.shades.length === 2, JSON.stringify(afterRename.shades));
  check('...and keeps their names', afterRename.shades[0]?.name === 'Royal Blue');

  const cleared = resolveColorMetadata({ hex: '#0000ff', shades: [] }, stored);
  check('An explicitly empty list does clear them', cleared.shades.length === 0);

  const hexOnly = resolveColorMetadata(undefined, stored);
  check('No metadata at all changes nothing', hexOnly.shades.length === 2 && hexOnly.hex === '#0000ff');

  console.log('\nWHAT THE ROUTE REFUSES');

  check('A missing hex is refused', refuses(() => resolveColorMetadata({ shades: [] }, null)) !== null);
  check('A junk hex is refused', refuses(() => resolveColorMetadata({ hex: 'blue' }, null)) !== null);
  check('A junk shade is refused by name', (refuses(() => resolveColorMetadata({ hex: '#0000ff', shades: ['nope'] }, null)) ?? '').includes('nope'));
  check('Shades that are not a list are refused', refuses(() => resolveColorMetadata({ hex: '#0000ff', shades: 'red' }, null)) !== null);
  check('An absurd number of shades is refused',
    refuses(() => resolveColorMetadata({ hex: '#0000ff', shades: Array(50).fill('#ff0000') }, null)) !== null);
  check('Metadata that is not an object is refused', refuses(() => resolveColorMetadata([1, 2], null)) !== null);

  console.log('\nOLD ROWS STILL READ');

  // Every shade in the database was a bare hex string before this change. A browser must not
  // need a backfill to have run in order to show a name.
  const legacy = readColorMetadata({ hex: '#0000FF', shades: ['#00008b', '#4169e1'] }, 'Blue');
  check('Bare hex strings are named on the way out',
    legacy?.shades[0]?.name === 'Dark Blue' && legacy?.shades[1]?.name === 'Royal Blue',
    JSON.stringify(legacy?.shades));
  check('A colour with no hex reads as nothing rather than throwing', readColorMetadata({}, 'Blue') === null);
}

async function realData() {
  console.log('\nEVERY SHOP\'S STORED PALETTE, AS IT ACTUALLY IS');

  const colors = await prisma.clientCatalogItem.findMany({
    where: { type: 'COLOR' },
    select: { clientId: true, label: true, metadata: true }
  });
  check('There are colours to check', colors.length > 0, `${colors.length}`);

  const nameless: string[] = [];
  const colliding: string[] = [];
  for (const c of colors) {
    const shades = normaliseShades((c.metadata as any)?.shades, c.label);
    for (const s of shades) {
      if (!s.name?.trim()) nameless.push(`${c.clientId}/${c.label}/${s.hex}`);
      // The original fault, stated as a check: never two shades of one colour under one name.
      if (/^(.*) shade$/i.test(s.name)) nameless.push(`${c.clientId}/${c.label}/${s.hex} "${s.name}"`);
    }
    if (new Set(shades.map(s => s.name.toLowerCase())).size !== shades.length) {
      colliding.push(`${c.clientId}/${c.label}`);
    }
  }
  check('No stored shade is nameless', nameless.length === 0, nameless.slice(0, 5).join(', '));
  check('No colour has two shades under one name', colliding.length === 0, colliding.join(', '));

  console.log('\nVARIANTS ALREADY SAVED');

  const stale = await prisma.productVariant.findMany({
    where: { colorName: { contains: 'Shade', mode: 'insensitive' } },
    select: { clientId: true, sku: true, colorName: true }
  });
  check('No variant is left with a nameless shade label', stale.length === 0,
    stale.slice(0, 5).map(v => `${v.clientId}/${v.sku} "${v.colorName}"`).join(', '));

  // The measured symptom from before the fix: one colour name covering several real colours.
  //
  // lower(hex_code), not hex_code. The first version of this check compared the stored strings
  // and reported demo-client's "Red" as two colours because seven rows across the platform
  // held #FF0000 where others held #ff0000 -- identical on screen, different to a GROUP BY. It
  // also found a real fault underneath the noise: nine variants carried the colours of a
  // hardcoded palette that predates the catalogue, so two variants both called Red drew as two
  // different reds. Both are fixed by backfill-shade-names.ts.
  const ambiguous: any[] = await prisma.$queryRawUnsafe(`
    SELECT client_id, color_name, COUNT(DISTINCT lower(hex_code))::int AS hexes
    FROM inventory_product_variants
    WHERE hex_code IS NOT NULL AND color_name IS NOT NULL
    GROUP BY client_id, color_name
    HAVING COUNT(DISTINCT lower(hex_code)) > 1
  `);
  check('No colour name covers two different colours', ambiguous.length === 0,
    ambiguous.map(r => `${r.client_id}/${r.color_name} x${r.hexes}`).join(', '));

  console.log('\nEXACT NAMES ARE NOT DISPLACED IN ANY REAL PALETTE');

  const displaced: string[] = [];
  for (const c of colors) {
    for (const s of normaliseShades((c.metadata as any)?.shades, c.label)) {
      const exact = exactNameFor(s.hex);
      // A shade that IS a named colour should be wearing that name, unless the shopkeeper
      // renamed it on purpose -- which, for the seeded palettes, nobody has.
      if (exact && s.name !== exact) displaced.push(`${c.clientId}/${c.label}/${s.hex} "${s.name}" should be "${exact}"`);
    }
  }
  check('Exact matches wear their own name', displaced.length === 0, displaced.slice(0, 5).join(', '));
}

async function main() {
  namingRules();
  metadataRules();
  await realData();

  console.log(`\n${failed === 0 ? 'ALL PASSED' : 'FAILURES'}: ${passed} passed, ${failed} failed`);
  if (failed) { failures.forEach(f => console.log(`  - ${f}`)); process.exitCode = 1; }
}

main()
  .catch(e => { console.error(e); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
