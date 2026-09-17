/**
 * The shelf rule on its own: which shelves a movement touches, with no database.
 *
 * Every case checks the invariant afterwards -- shelf total never above the location's quantity, no
 * shelf below zero -- and that the same situation always gives the same answer.
 *
 *   npx tsx src/scripts/verify-shelf-plan.ts
 */
import { planShelfLegs, ShelfState, KnownSpot, PlanInput } from '../services/shelves/plan';
import { compareWalk, expandCodes, normaliseAddress, normaliseCode, parseLabel, walkKeys, labelPayload, newLabelCode } from '../services/shelves/addresses';

let passed = 0;
const failures: string[] = [];
const check = (name: string, ok: boolean, detail = '') => {
  if (ok) { passed++; if (!process.env.QUIET) console.log(`  ok   ${name}`); }
  else { failures.push(`${name} :: ${detail}`); console.log(`  FAIL ${name} :: ${detail}`); }
};
const throws = (fn: () => unknown): { status?: number; message?: string } | null => {
  try { fn(); return null; } catch (e: any) { return { status: e?.statusCode, message: e?.message }; }
};

// A shop: floor cupboard shelves A-03-2 (walk 10/30/20) and B-01-1 (walk 20/10/10), back room R04-1.
const spot = (spotId: string, address: string, isShopFloor: boolean, walkKey: number[], extra: Partial<KnownSpot> = {}): KnownSpot =>
  ({ spotId, address, isShopFloor, walkKey, active: true, hasChildren: false, ...extra });
const SPOTS = new Map<string, KnownSpot>([
  ['a', spot('a', 'FLOOR-A03-2', true, [10, 30, 20])],
  ['b', spot('b', 'FLOOR-B01-1', true, [10, 40, 10])],
  ['r', spot('r', 'STORE-R04-1', false, [20, 10, 10])],
  ['r2', spot('r2', 'STORE-R04-2', false, [20, 10, 20])],
  ['off', spot('off', 'STORE-R09-1', false, [20, 90, 10], { active: false })],
  ['cup', spot('cup', 'FLOOR-C1', true, [10, 50], { hasChildren: true })]
]);
const shelf = (spotId: string, quantity: number): ShelfState => {
  const s = SPOTS.get(spotId)!;
  return { spotId, address: s.address, isShopFloor: s.isShopFloor, walkKey: s.walkKey, quantity };
};

function run(input: Partial<PlanInput> & { shelves: ShelfState[]; officialBefore: number; delta: number; reason: PlanInput['reason'] }) {
  const full: PlanInput = { scanned: [], spots: SPOTS, itemName: 'Silk saree (SKU-1)', officialAfter: input.officialBefore + input.delta, ...input } as PlanInput;
  const result = planShelfLegs(full);
  // Invariant, after applying the legs.
  const after = new Map(full.shelves.map(s => [s.spotId, s.quantity]));
  for (const leg of result.legs) after.set(leg.spotId, (after.get(leg.spotId) ?? 0) + leg.quantity);
  const total = [...after.values()].reduce((t, q) => t + q, 0);
  const negative = [...after.entries()].filter(([, q]) => q < 0);
  const again = planShelfLegs(full);
  return {
    ...result,
    after,
    total,
    invariant: total <= full.officialAfter && negative.length === 0,
    deterministic: JSON.stringify(again) === JSON.stringify(result)
  };
}
const legOf = (r: ReturnType<typeof run>, spotId: string) => r.legs.filter(l => l.spotId === spotId).reduce((t, l) => t + l.quantity, 0);

console.log('\nA. TILL SALES (decision 1)');
{
  // The plan's worked example: A-03-2 4, B-01-1 3, Not shelved 2 (location 9). Sell 5.
  const r = run({ reason: 'SALE', officialBefore: 9, delta: -5, shelves: [shelf('b', 3), shelf('a', 4)] });
  check('sell 5 of 4+3 floor + 2 not shelved: A-03-2 -4, B-01-1 -1', legOf(r, 'a') === -4 && legOf(r, 'b') === -1 && r.legs.length === 2, JSON.stringify(r.legs));
  check('  ...Not shelved untouched (2), location 4, no issue, invariant, deterministic', r.total === 2 && r.issues.length === 0 && r.invariant && r.deterministic, JSON.stringify([...r.after]));
  check('  ...legs are AUTO', r.legs.every(l => l.source === 'AUTO'));
}
{
  const r = run({ reason: 'SALE', officialBefore: 9, delta: -8, shelves: [shelf('a', 4), shelf('b', 3)] });
  check('sell 8 of 4+3 floor + 2 not shelved: floor emptied, 1 from Not shelved, no issue', legOf(r, 'a') === -4 && legOf(r, 'b') === -3 && r.issues.length === 0 && r.total === 0 && r.invariant, JSON.stringify(r.legs));
}
{
  const r = run({ reason: 'SALE', officialBefore: 9, delta: -9, shelves: [shelf('a', 4), shelf('b', 3)] });
  check('sell all 9: shelves and Not shelved both to 0', r.total === 0 && r.issues.length === 0 && r.invariant);
}
{
  // Floor 2, back room 5, Not shelved 1 (location 8). Sell 6: 2 floor, 1 not shelved, 3 from back room.
  const r = run({ reason: 'SALE', officialBefore: 8, delta: -6, shelves: [shelf('a', 2), shelf('r', 3), shelf('r2', 2)] });
  check('sale beyond floor + Not shelved takes from the back room in walking order (R04-1 before R04-2)', legOf(r, 'a') === -2 && legOf(r, 'r') === -3 && legOf(r, 'r2') === 0, JSON.stringify(r.legs));
  check('  ...and raises SOLD_FROM_BACK_ROOM for exactly those 3 pieces', r.issues.length === 1 && r.issues[0].kind === 'SOLD_FROM_BACK_ROOM' && r.issues[0].quantity === 3 && r.issues[0].address === 'STORE-R04-1', JSON.stringify(r.issues));
  check('  ...invariant holds: shelves 2, location 2', r.total === 2 && r.invariant);
}
{
  const r = run({ reason: 'SALE', officialBefore: 5, delta: -2, shelves: [shelf('r', 5)] });
  check('only back room stocked, 0 Not shelved: sale takes back room and flags it', legOf(r, 'r') === -2 && r.issues[0]?.kind === 'SOLD_FROM_BACK_ROOM' && r.invariant);
}
{
  const r = run({ reason: 'SALE', officialBefore: 10, delta: -3, shelves: [shelf('r', 4)] });
  check('back room stocked but Not shelved covers the sale: no shelf touched, no issue', r.legs.length === 0 && r.issues.length === 0 && r.invariant);
}
{
  // Two floor shelves with identical walk keys: tie broken by address, always the same one first.
  const tieSpots = new Map(SPOTS);
  tieSpots.set('t1', spot('t1', 'FLOOR-Z9-2', true, [10, 30, 20]));
  tieSpots.set('t2', spot('t2', 'FLOOR-Z9-1', true, [10, 30, 20]));
  const base = { reason: 'SALE' as const, officialBefore: 4, delta: -1, spots: tieSpots, shelves: [
    { spotId: 't1', address: 'FLOOR-Z9-2', isShopFloor: true, walkKey: [10, 30, 20], quantity: 2 },
    { spotId: 't2', address: 'FLOOR-Z9-1', isShopFloor: true, walkKey: [10, 30, 20], quantity: 2 }
  ] };
  const r1 = run(base);
  const r2 = run({ ...base, shelves: [...base.shelves].reverse() });
  check('equal walking order: the lower address goes first, whatever order the rows arrive in', legOf(r1, 't2') === -1 && legOf(r2, 't2') === -1 && JSON.stringify(r1.legs) === JSON.stringify(r2.legs), JSON.stringify([r1.legs, r2.legs]));
}

console.log('\nB. OTHER WAYS STOCK LEAVES');
{
  const r = run({ reason: 'TRANSFER', officialBefore: 9, delta: -2, shelves: [shelf('a', 4), shelf('b', 3)] });
  check('transfer out covered by Not shelved: no shelf touched, no issue', r.legs.length === 0 && r.issues.length === 0 && r.invariant);
}
{
  const r = run({ reason: 'DAMAGE', officialBefore: 9, delta: -4, shelves: [shelf('a', 4), shelf('b', 3)] });
  check('damage of 4 with 2 not shelved: 2 off shelves in walking order (A-03-2), flagged AUTO_TAKEN_FROM_SHELF', legOf(r, 'a') === -2 && r.issues.length === 1 && r.issues[0].kind === 'AUTO_TAKEN_FROM_SHELF' && r.issues[0].quantity === 2 && r.invariant, JSON.stringify(r));
}
{
  const r = run({ reason: 'DAMAGE', officialBefore: 9, delta: -2, shelves: [shelf('a', 4), shelf('b', 3)], scanned: [{ spotId: 'b', quantity: -2 }] });
  check('damage with the shelf chosen: exactly that shelf, SCANNED, no issue', legOf(r, 'b') === -2 && r.legs[0].source === 'SCANNED' && r.issues.length === 0 && r.invariant, JSON.stringify(r));
}
{
  const r = run({ reason: 'RETURN_TO_VENDOR', officialBefore: 9, delta: -5, shelves: [shelf('a', 4), shelf('b', 3)], scanned: [{ spotId: 'b', quantity: -1 }] });
  check('partly chosen (1 from B-01-1) and 4 more: 1 scanned, 2 Not shelved, 2 auto from A-03-2 with an issue', legOf(r, 'b') === -1 && legOf(r, 'a') === -2 && r.issues.length === 1 && r.invariant, JSON.stringify(r));
}
for (const reason of ['AUDIT_CORRECTION', 'AUDIT', 'MANUAL_CORRECTION'] as const) {
  // Floor 3, back room 4 + 2, location 10 -> count says 6. Shelves 9 > 6: 3 must come off, back room first, last in walk first.
  const r = run({ reason, officialBefore: 10, delta: -4, shelves: [shelf('a', 3), shelf('r', 4), shelf('r2', 2)] });
  check(`${reason} below shelf total: taken from the back room first, last shelf in the walk first (R04-2 then R04-1)`, legOf(r, 'r2') === -2 && legOf(r, 'r') === -1 && legOf(r, 'a') === 0, JSON.stringify(r.legs));
  check('  ...every piece taken is a COUNT_BELOW_SHELVES issue, never silent', r.issues.length === 2 && r.issues.every(i => i.kind === 'COUNT_BELOW_SHELVES') && r.issues.reduce((t, i) => t + i.quantity, 0) === 3 && r.invariant);
}
{
  const r = run({ reason: 'AUDIT_CORRECTION', officialBefore: 10, delta: -1, shelves: [shelf('a', 3), shelf('r', 4)] });
  check('count lower but still above the shelf total: shelves untouched, no issue', r.legs.length === 0 && r.issues.length === 0 && r.invariant);
}
{
  const r = run({ reason: 'AUDIT_CORRECTION', officialBefore: 7, delta: -7, shelves: [shelf('a', 3), shelf('r', 4)] });
  check('count finds none at all: every shelf emptied, all flagged', r.total === 0 && r.issues.reduce((t, i) => t + i.quantity, 0) === 7 && r.invariant);
}

console.log('\nC. STOCK ARRIVING');
for (const reason of ['PURCHASE_RECEIPT', 'CUSTOMER_RETURN', 'TRANSFER', 'INITIAL_STOCK'] as const) {
  const r = run({ reason, officialBefore: 7, delta: 5, shelves: [shelf('a', 4), shelf('b', 3)] });
  check(`${reason} with no shelf named lands in Not shelved: no legs`, r.legs.length === 0 && r.issues.length === 0 && r.invariant);
}
{
  const r = run({ reason: 'PURCHASE_RECEIPT', officialBefore: 0, delta: 5, shelves: [], scanned: [{ spotId: 'r', quantity: 3 }] });
  check('receiving straight onto a shelf: 3 SCANNED onto R04-1, 2 Not shelved', legOf(r, 'r') === 3 && r.invariant);
}
{
  const e = throws(() => run({ reason: 'PURCHASE_RECEIPT', officialBefore: 0, delta: 5, shelves: [], scanned: [{ spotId: 'r', quantity: 6 }] }));
  check('receiving 5 but putting 6 on a shelf is refused (400)', e?.status === 400, JSON.stringify(e));
}
{
  const e = throws(() => run({ reason: 'PURCHASE_RECEIPT', officialBefore: 0, delta: 5, shelves: [], scanned: [{ spotId: 'r', quantity: -1 }] }));
  check('stock arriving cannot take pieces off a shelf (400)', e?.status === 400, JSON.stringify(e));
}

console.log('\nD. PUT AWAY AND MOVE (SHELF_MOVE)');
{
  const r = run({ reason: 'SHELF_MOVE', officialBefore: 9, delta: 0, shelves: [shelf('a', 4), shelf('b', 3)], scanned: [{ spotId: 'r', quantity: 2 }] });
  check('put away 2 of 2 Not shelved onto R04-1', legOf(r, 'r') === 2 && r.total === 9 && r.invariant);
}
{
  const e = throws(() => run({ reason: 'SHELF_MOVE', officialBefore: 9, delta: 0, shelves: [shelf('a', 4), shelf('b', 3)], scanned: [{ spotId: 'r', quantity: 3 }] }));
  check('put away 3 when only 2 are not shelved: refused (409) and says 2', e?.status === 409 && /Only 2 pieces/.test(e?.message ?? ''), JSON.stringify(e));
}
{
  const e = throws(() => run({ reason: 'SHELF_MOVE', officialBefore: 7, delta: 0, shelves: [shelf('a', 4), shelf('b', 3)], scanned: [{ spotId: 'r', quantity: 1 }] }));
  check('put away when everything is already shelved: refused (409) with a pointer to Move', e?.status === 409 && /already on a shelf/.test(e?.message ?? ''), JSON.stringify(e));
}
{
  const r = run({ reason: 'SHELF_MOVE', officialBefore: 7, delta: 0, shelves: [shelf('a', 4), shelf('b', 3)], scanned: [{ spotId: 'a', quantity: -4 }, { spotId: 'r', quantity: 4 }] });
  check('move 4 from A-03-2 to R04-1: two SCANNED legs, total unchanged', legOf(r, 'a') === -4 && legOf(r, 'r') === 4 && r.total === 7 && r.invariant);
}
{
  const e = throws(() => run({ reason: 'SHELF_MOVE', officialBefore: 7, delta: 0, shelves: [shelf('a', 4), shelf('b', 3)], scanned: [{ spotId: 'a', quantity: -5 }, { spotId: 'r', quantity: 5 }] }));
  check('move 5 off a shelf holding 4: refused (409), says "Only 4 pieces"', e?.status === 409 && /Only 4 pieces/.test(e?.message ?? ''), JSON.stringify(e));
}
{
  const e = throws(() => run({ reason: 'SHELF_MOVE', officialBefore: 7, delta: 0, shelves: [shelf('a', 4)], scanned: [{ spotId: 'r', quantity: -1 }] }));
  check('taking from a shelf that holds none of it: refused (409) "There is no"', e?.status === 409 && /There is no/.test(e?.message ?? ''), JSON.stringify(e));
}
{
  const r = run({ reason: 'SHELF_MOVE', officialBefore: 7, delta: 0, shelves: [shelf('a', 4), shelf('b', 3)], scanned: [{ spotId: 'a', quantity: -1 }] });
  check('take 1 off a shelf back to Not shelved', legOf(r, 'a') === -1 && r.total === 6 && r.invariant);
}
{
  const e = throws(() => run({ reason: 'SHELF_MOVE', officialBefore: 7, delta: 0, shelves: [shelf('a', 4)], scanned: [{ spotId: 'a', quantity: -1 }, { spotId: 'off', quantity: 1 }] }));
  check('moving onto a switched-off shelf: refused (400)', e?.status === 400 && /switched off/.test(e?.message ?? ''), JSON.stringify(e));
}
{
  const e = throws(() => run({ reason: 'SHELF_MOVE', officialBefore: 7, delta: 0, shelves: [shelf('a', 4)], scanned: [{ spotId: 'a', quantity: -1 }, { spotId: 'cup', quantity: 1 }] }));
  check('moving onto a cupboard that has shelves inside: refused (400)', e?.status === 400 && /inside it/.test(e?.message ?? ''), JSON.stringify(e));
}
{
  const e = throws(() => run({ reason: 'SHELF_MOVE', officialBefore: 7, delta: 0, shelves: [shelf('a', 4)], scanned: [{ spotId: 'someone-elses', quantity: 1 }] }));
  check('a shelf id from another location or shop: 404', e?.status === 404, JSON.stringify(e));
}
{
  const e = throws(() => run({ reason: 'SHELF_MOVE', officialBefore: 7, delta: 0, shelves: [shelf('a', 4)], scanned: [] }));
  check('a move naming no shelf: refused (400)', e?.status === 400, JSON.stringify(e));
}
{
  const e = throws(() => run({ reason: 'SHELF_MOVE', officialBefore: 7, delta: -1, shelves: [shelf('a', 4)], scanned: [{ spotId: 'a', quantity: -1 }] }));
  check('a "move" that changes the location quantity: refused (400)', e?.status === 400, JSON.stringify(e));
}
{
  const e = throws(() => run({ reason: 'SHELF_MOVE', officialBefore: 7, delta: 0, shelves: [shelf('a', 4)], scanned: [{ spotId: 'a', quantity: -1.5 }, { spotId: 'r', quantity: 1.5 }] }));
  check('half a piece: refused (400)', e?.status === 400, JSON.stringify(e));
}

console.log('\nE. RANDOMISED: 5000 movements, the invariant never breaks');
{
  const reasons = ['SALE', 'DAMAGE', 'TRANSFER', 'AUDIT_CORRECTION', 'PURCHASE_RECEIPT', 'CUSTOMER_RETURN', 'SHELF_MOVE'] as const;
  const ids = ['a', 'b', 'r', 'r2'];
  let seed = 42;
  const rnd = (n: number) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
  let official = 20;
  let state = new Map<string, number>([['a', 5], ['b', 5], ['r', 5], ['r2', 0]]);
  let broken = '';
  let refusals = 0;
  let issuesSeen = 0;
  for (let i = 0; i < 5000 && !broken; i++) {
    const reason = reasons[rnd(reasons.length)];
    const shelves = ids.filter(id => (state.get(id) ?? 0) > 0).map(id => shelf(id, state.get(id)!));
    let delta = 0;
    const scanned: { spotId: string; quantity: number }[] = [];
    if (reason === 'SHELF_MOVE') {
      const from = ids[rnd(ids.length)], to = ids[rnd(ids.length)];
      const q = 1 + rnd(4);
      if (rnd(3) === 0) scanned.push({ spotId: to, quantity: q });
      else { scanned.push({ spotId: from, quantity: -q }); if (to !== from && rnd(4) !== 0) scanned.push({ spotId: to, quantity: q }); }
    } else if (reason === 'PURCHASE_RECEIPT' || reason === 'CUSTOMER_RETURN') {
      delta = 1 + rnd(6);
      if (rnd(2) === 0) scanned.push({ spotId: ids[rnd(ids.length)], quantity: rnd(delta + 1) });
    } else {
      delta = -Math.min(official, 1 + rnd(5));
      if (delta === 0) continue;
      if (rnd(3) === 0) { const id = ids[rnd(ids.length)]; scanned.push({ spotId: id, quantity: -Math.min(state.get(id) ?? 0, -delta, 1 + rnd(2)) }); }
    }
    try {
      const r = run({ reason, officialBefore: official, delta, shelves, scanned: scanned.filter(s => s.quantity !== 0) });
      if (!r.invariant) broken = `step ${i} ${reason} ${delta} ${JSON.stringify(scanned)} -> ${JSON.stringify([...r.after])} official ${official + delta}`;
      if (!r.deterministic) broken = `step ${i} not deterministic`;
      official += delta;
      state = new Map(ids.map(id => [id, r.after.get(id) ?? 0]));
      issuesSeen += r.issues.length;
    } catch (e: any) {
      if (typeof e?.statusCode !== 'number') broken = `step ${i} crashed: ${e?.message}`;
      refusals++;
    }
  }
  check('5000 random sales, damages, transfers, counts, receipts, returns, put-aways and moves keep shelves <= location and no shelf < 0', !broken, broken);
  check(`  ...refusals were sentences with a status, not crashes (${refusals} refused, ${issuesSeen} issues raised)`, !broken);
}

console.log('\nF. ADDRESSES AND LABELS');
check('codes: "c 2" -> C2, 03 stays 03', normaliseCode('c 2') === 'C2' && normaliseCode('03') === '03');
check('codes: a dash, a slash, 13 characters and empty are refused (400)', ['C-2', 'C/2', 'ABCDEFGHIJKLM', ''].every(c => throws(() => normaliseCode(c))?.status === 400));
check('typed address "floor - c2 - 1" -> FLOOR-C2-1; 5 parts or junk -> null', normaliseAddress('floor - c2 - 1') === 'FLOOR-C2-1' && normaliseAddress('A-B-C-D-E') === null && normaliseAddress('A_B') === null);
{
  const code = newLabelCode();
  check('label codes: 10 characters, no 0/O/1/I/L; "SEZ:" payload and bare code both parse', /^[A-HJKMNP-Z2-9]{10}$/.test(code) && parseLabel(labelPayload(code)) === code && parseLabel(code.toLowerCase()) === code && parseLabel('FLOOR-C2-1') === null, code);
}
check('quick create: R, 1-12, pad 2 -> R01..R12', JSON.stringify(expandCodes({ from: 1, to: 12, pad: 2, prefix: 'R' }, 'Racks')) === JSON.stringify(Array.from({ length: 12 }, (_, i) => `R${String(i + 1).padStart(2, '0')}`)));
check('quick create: letters A-D, and refusals for D-A, 1-0, duplicates, over 2000', expandCodes({ letterFrom: 'a', letterTo: 'd' }, 'Boxes').join('') === 'ABCD'
  && throws(() => expandCodes({ letterFrom: 'D', letterTo: 'A' }, 'x'))?.status === 400
  && throws(() => expandCodes({ from: 1, to: 0 }, 'x'))?.status === 400
  && throws(() => expandCodes({ codes: ['A', 'a'] }, 'x'))?.status === 400
  && throws(() => expandCodes({ from: 1, to: 2001 }, 'x'))?.status === 400);
{
  const rows = [
    { id: 'area2', parentId: null, walkOrder: 20, address: 'STORE' },
    { id: 'area1', parentId: null, walkOrder: 10, address: 'FLOOR' },
    { id: 'r1', parentId: 'area2', walkOrder: 10, address: 'STORE-R1' },
    { id: 'c9', parentId: 'area1', walkOrder: 90, address: 'FLOOR-C9' },
    { id: 's1', parentId: 'c9', walkOrder: 10, address: 'FLOOR-C9-1' }
  ];
  const keys = walkKeys(rows);
  const order = rows.map(r => ({ walkKey: keys.get(r.id)!, address: r.address })).sort(compareWalk).map(r => r.address);
  check('walking order follows the tree: everything in the first area before the second, whatever the rack numbers', JSON.stringify(order) === JSON.stringify(['FLOOR', 'FLOOR-C9', 'FLOOR-C9-1', 'STORE', 'STORE-R1']), JSON.stringify(order));
}

console.log(`\nRESULT: ${passed} passed | ${failures.length} failed`);
if (failures.length) console.log('Failed:\n - ' + failures.join('\n - '));
process.exit(failures.length ? 1 : 0);
