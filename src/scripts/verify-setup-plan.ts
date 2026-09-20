/**
 * "Describe your shop" on its own: answers -> spots to create, with no database.
 *
 * The contract (PLAN-shelves-onboarding.md step 1.5):
 *   A  the shape of the answers: perParent, limits, depth, codes -- refused on the server, in words.
 *   B  deterministic: same answers + same shop = same rows, however the snapshot is shuffled.
 *   C  additive: answering again creates nothing; smaller answers remove nothing.
 *   D  branch-local trouble: switched off, renamed away, holding stock -- the racks either side of it
 *      are still created.
 *   E  never changes what is there: kind, shop floor / back room and walking order are left alone.
 *
 *   npx tsx src/scripts/verify-setup-plan.ts
 */
import { planSetup, SetupSpec, Snapshot, SnapshotSpot, PlannedSpot } from '../services/shelves/setup-plan';

let passed = 0;
const failures: string[] = [];
const check = (name: string, ok: boolean, detail: unknown = '') => {
  if (ok) { passed++; if (!process.env.QUIET) console.log(`  ok   ${name}`); }
  else {
    const text = typeof detail === 'string' ? detail : JSON.stringify(detail);
    failures.push(`${name} :: ${text}`);
    console.log(`  FAIL ${name} :: ${text}`);
  }
};
const refused = (fn: () => unknown): string | null => {
  try { fn(); return null; } catch (e: any) { return String(e?.message ?? e); }
};
const plain = (m: string | null) => !!m && /[a-z]{3}/i.test(m) && !/undefined|null|Error:|at \w+ \(/.test(m);

// A shop, as the snapshot sees it.
let seq = 0;
const spot = (address: string, extra: Partial<SnapshotSpot> = {}): SnapshotSpot => {
  const parts = address.split('-');
  return {
    id: `id-${address}-${++seq}`,
    parentId: parts.length > 1 ? `id-${parts.slice(0, -1).join('-')}` : null,
    address,
    kind: (parts.length === 1 ? 'AREA' : parts.length === 2 ? 'RACK' : 'SHELF') as SnapshotSpot['kind'],
    depth: parts.length,
    active: true,
    isShopFloor: parts[0] === 'FLOOR',
    walkOrder: parts.length * 10,
    hasStock: false,
    ...extra
  };
};
const snap = (spots: SnapshotSpot[] = [], renamedAway: { oldAddress: string; newAddress: string }[] = []): Snapshot =>
  ({ spots, renamedAway });

const racks = (kind: SnapshotSpot['kind'] = 'RACK') => ({ kind, range: { from: 1, to: 5, prefix: 'R', pad: 2 } });
const shelves = (perParent?: number[]) => ({ kind: 'SHELF' as const, range: { from: 1, to: 6 }, perParent });
const area = (code: string) => ({ kind: 'AREA' as const, range: { codes: [code] } });

const SPEC: SetupSpec = { isShopFloor: false, levels: [area('STORE'), racks(), shelves([6, 4, 4, 5, 3])] };
const made = (p: { spots: PlannedSpot[] }, outcome: string) => p.spots.filter(s => s.outcome === outcome).map(s => s.address);

console.log('\nA. THE ANSWERS ARE CHECKED ON THE SERVER');
{
  const p = planSetup(SPEC, snap());
  check('5 racks with 6, 4, 4, 5 and 3 shelves: 1 area + 5 racks + 22 shelves', p.counts.created === 28, p.counts);
  check('each rack gets the first n shelf codes', JSON.stringify(p.addresses.filter(a => a.startsWith('STORE-R02-'))) === JSON.stringify(['STORE-R02-1', 'STORE-R02-2', 'STORE-R02-3', 'STORE-R02-4']), p.addresses.filter(a => a.startsWith('STORE-R02-')));
  check('the last rack too', JSON.stringify(p.addresses.filter(a => a.startsWith('STORE-R05-'))) === JSON.stringify(['STORE-R05-1', 'STORE-R05-2', 'STORE-R05-3']), p.addresses.filter(a => a.startsWith('STORE-R05-')));

  const one = (levels: any[]) => refused(() => planSetup({ isShopFloor: true, levels } as SetupSpec, snap()));
  const wrongLength = one([area('STORE'), racks(), shelves([6, 4])]);
  check('a list shorter than the racks is refused, saying how many are needed', /one number for each of the 5/.test(wrongLength ?? ''), wrongLength);
  check('a fraction is refused', /whole number/.test(one([area('STORE'), racks(), shelves([6, 4, 4, 5, 1.5])]) ?? ''));
  check('a negative is refused', /whole number/.test(one([area('STORE'), racks(), shelves([6, 4, 4, 5, -1])]) ?? ''));
  check('more than the codes named is refused', /more than the 6 codes/.test(one([area('STORE'), racks(), shelves([9, 4, 4, 5, 3])]) ?? ''));
  check('a per-parent list on the first level is refused', /first level has one parent/.test(one([{ ...area('STORE'), perParent: [1] }, racks()]) ?? ''));
  check('0 for one rack is allowed (that rack gets no shelves)', planSetup({ isShopFloor: false, levels: [area('STORE'), racks(), shelves([6, 0, 4, 5, 3])] }, snap()).addresses.filter(a => a.startsWith('STORE-R02-')).length === 0);
  check('a level that makes nothing, with levels inside it, is refused', /cannot be made/.test(one([area('STORE'), { ...racks(), perParent: undefined }, { kind: 'SHELF', range: { from: 1, to: 2 }, perParent: [0, 0, 0, 0, 0] }, { kind: 'BOX', range: { letterFrom: 'A', letterTo: 'B' } }]) ?? ''));

  const tooMany = one([area('STORE'), { kind: 'RACK', range: { from: 1, to: 50, prefix: 'R', pad: 2 } }, { kind: 'SHELF', range: { from: 1, to: 40 } }]);
  check('over 2000 spots is refused before anything is worked out, with the number', /2000/.test(tooMany ?? '') && /2051|2050/.test(tooMany ?? ''), tooMany);
  check('five levels deep is refused', /At most 4/.test(one([area('STORE'), racks(), shelves(), { kind: 'BOX', range: { letterFrom: 'A', letterTo: 'B' } }, { kind: 'OTHER', range: { codes: ['X'] } }]) ?? ''));
  check('a bad code is refused in words', plain(one([area('STORE'), { kind: 'RACK', range: { codes: ['R/1'] } }])));
  check('every refusal is a sentence, never a dump', [wrongLength, tooMany].every(m => plain(m)));
}

console.log('\nB. THE SAME ANSWERS ALWAYS GIVE THE SAME PLAN');
{
  const shop = [spot('STORE'), spot('STORE-R01'), spot('STORE-R01-1'), spot('FLOOR'), spot('FLOOR-C1')];
  const a = planSetup(SPEC, snap(shop));
  const b = planSetup(SPEC, snap([...shop].reverse()));
  const c = planSetup(SPEC, snap([shop[2], shop[0], shop[4], shop[1], shop[3]]));
  check('the shop rows in any order give the same plan', JSON.stringify(a) === JSON.stringify(b) && JSON.stringify(a) === JSON.stringify(c));
  check('planning twice gives the same plan', JSON.stringify(planSetup(SPEC, snap(shop))) === JSON.stringify(a));
  check('no ids or label codes are invented here (that belongs to saving)', !JSON.stringify(a.spots.map(s => ({ ...s, existingId: undefined, parentId: undefined }))).match(/[0-9a-f]{8}-[0-9a-f]{4}/));
  const walks = a.spots.filter(s => s.outcome === 'created' && s.parentAddress === 'STORE-R01').map(s => s.walkOrder);
  check('new shelves are numbered after the shelf already on that rack (it is at 30)', walks[0] === 40 && walks.every((w, i) => i === 0 || w === walks[i - 1] + 10), walks);
}

console.log('\nC. ANSWERING AGAIN ADDS, NEVER REPLACES');
{
  const first = planSetup(SPEC, snap());
  const shop = first.spots.filter(s => s.outcome === 'created').map(s => spot(s.address));
  const again = planSetup(SPEC, snap(shop));
  check('the same answers a second time create nothing', again.counts.created === 0 && again.counts.alreadyThere === 28, again.counts);

  const bigger = planSetup({ isShopFloor: false, levels: [area('STORE'), { kind: 'RACK', range: { from: 1, to: 7, prefix: 'R', pad: 2 } }, shelves([6, 4, 4, 5, 3, 2, 2])] }, snap(shop));
  check('7 racks after 5: only the two new racks and their shelves are created', JSON.stringify(bigger.addresses) === JSON.stringify(['STORE-R06', 'STORE-R07', 'STORE-R06-1', 'STORE-R06-2', 'STORE-R07-1', 'STORE-R07-2']), bigger.addresses);

  const smaller = planSetup({ isShopFloor: false, levels: [area('STORE'), { kind: 'RACK', range: { from: 1, to: 3, prefix: 'R', pad: 2 } }, shelves([6, 4, 4])] }, snap(shop));
  check('3 racks after 5: nothing is created and nothing is removed', smaller.counts.created === 0 && smaller.spots.every(s => s.outcome === 'already_exists'), smaller.counts);
  check('the plan never says to change or remove anything', smaller.spots.every(s => ['created', 'already_exists', 'conflict', 'skipped'].includes(s.outcome)));
}

console.log('\nD. SOMETHING IN THE WAY STOPS THAT BRANCH ONLY');
{
  // P1: a rack the shop switched off.
  const off = planSetup(SPEC, snap([spot('STORE'), spot('STORE-R03', { active: false })]));
  check('a switched-off rack is a conflict, not quietly used', off.spots.find(s => s.address === 'STORE-R03')?.outcome === 'conflict');
  check('its shelves are skipped, and say which rack to look at', made(off, 'skipped').every(a => a.startsWith('STORE-R03-')) && /switched off/.test(off.spots.find(s => s.address === 'STORE-R03-1')?.reason ?? ''), off.spots.find(s => s.address === 'STORE-R03-1'));
  check('the other racks are still created: 4 racks + 18 shelves', off.addresses.includes('STORE-R02-1') && off.addresses.includes('STORE-R04-1') && off.counts.created === 22, off.counts);

  // P2: a rack renamed since (R01 -> SILK).
  const renamed = planSetup(SPEC, snap([spot('STORE'), spot('STORE-SILK')], [{ oldAddress: 'STORE-R01', newAddress: 'STORE-SILK' }]));
  check('a rack renamed away is not made a second time', renamed.spots.find(s => s.address === 'STORE-R01')?.outcome === 'conflict' && !renamed.addresses.includes('STORE-R01'));
  check('and it says what it is called now', /renamed to STORE-SILK/.test(renamed.spots.find(s => s.address === 'STORE-R01')?.reason ?? ''), renamed.spots.find(s => s.address === 'STORE-R01'));
  check('the racks either side are still created', renamed.addresses.includes('STORE-R02') && renamed.addresses.includes('STORE-R05'));
  const goneAgain = planSetup(SPEC, snap([spot('STORE')], [{ oldAddress: 'STORE-R01', newAddress: 'STORE-SILK' }]));
  check('a rename to something that is no longer there does not block it', goneAgain.addresses.includes('STORE-R01'));

  // P3: a shelf that already holds stock, with boxes asked for inside it.
  const boxes: SetupSpec = { isShopFloor: false, levels: [area('STORE'), racks(), shelves([1, 1, 1, 1, 1]), { kind: 'BOX', range: { letterFrom: 'A', letterTo: 'B' } }] };
  const stocked = planSetup(boxes, snap([spot('STORE'), spot('STORE-R02'), spot('STORE-R02-1', { hasStock: true })]));
  check('a shelf holding stock keeps its pieces: no boxes are made inside it', !stocked.addresses.some(a => a.startsWith('STORE-R02-1-')), stocked.addresses.filter(a => a.startsWith('STORE-R02')));
  check('it says to move the stock off first', /holds stock/.test(stocked.spots.find(s => s.address === 'STORE-R02-1-A')?.reason ?? ''));
  check('boxes on the other racks are still created', stocked.addresses.includes('STORE-R01-1-A') && stocked.addresses.includes('STORE-R05-1-B'));
  check('one shelf holding stock never fails the whole answer (P3)', stocked.counts.created > 0);

  const leaf = planSetup({ isShopFloor: false, levels: [area('STORE'), racks(), shelves([1, 1, 1, 1, 1])] }, snap([spot('STORE'), spot('STORE-R02'), spot('STORE-R02-1', { hasStock: true })]));
  check('a shelf holding stock with nothing asked inside it is simply already there', leaf.spots.find(s => s.address === 'STORE-R02-1')?.outcome === 'already_exists');
}

console.log('\nE. WHAT IS THERE IS LEFT EXACTLY AS IT IS');
{
  const there = [spot('STORE'), spot('STORE-R01', { kind: 'CUPBOARD', walkOrder: 70 })];
  const p = planSetup(SPEC, snap(there));
  const row = p.spots.find(s => s.address === 'STORE-R01')!;
  check('a rack the shop calls a cupboard stays a cupboard', row.outcome === 'already_exists' && row.kind === 'CUPBOARD' && /kept as it is/.test(row.note ?? ''), row);
  check('its walking order is not moved', row.walkOrder === 70);

  const floor = planSetup({ isShopFloor: true, levels: [area('STORE'), racks(), shelves([1, 1, 1, 1, 1])] }, snap([spot('STORE', { isShopFloor: false })]));
  const areaRow = floor.spots.find(s => s.address === 'STORE')!;
  check('an area saved as the back room is not flipped to the shop floor by a new answer', areaRow.outcome === 'already_exists' && areaRow.isShopFloor === false && /back room/.test(areaRow.note ?? ''), areaRow);
  check('and its racks follow the area as it really is', floor.spots.filter(s => s.parentAddress === 'STORE').every(s => s.isShopFloor === false));

  const fresh = planSetup({ isShopFloor: true, levels: [area('FLOOR'), racks(), shelves([1, 1, 1, 1, 1])] }, snap());
  check('a new area takes the answer: shop floor', fresh.spots.every(s => s.isShopFloor === true));
}

console.log(`\nRESULT: ${passed} passed | ${failures.length} failed`);
if (failures.length) console.log('Failed:\n - ' + failures.join('\n - '));
process.exit(failures.length ? 1 : 0);
