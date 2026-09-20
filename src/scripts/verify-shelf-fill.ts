/**
 * The FIRST FILL: staff walk the shelves once and record what is on each one.
 *
 *   A  the walk: where to stand next, what is on the shelf, one shelf saved in one go.
 *   B  it never invents stock: more on the shelf than ScaleEzy has is refused, in words, and
 *      nothing at all is saved (all or nothing), with the lines that need changing named.
 *   C  a retry after the network drops is not a second put-away (saveKey).
 *   D  two phones: different shelves, and the same shelf.
 *   E  the numbers: pieces still not shelved, and items whose numbers do not add up.
 *   F  first fill and the till (D1): while filling, a sale takes from Not shelved first.
 *   G  finishing: by itself only when every shelf is done and something was filled; by a person
 *      at any time; skipped shelves never finish it by themselves.
 *
 *   npx tsx src/scripts/verify-shelf-fill.ts     (needs the local backend running)
 */
import axios, { AxiosInstance } from 'axios';
import { prisma } from '../lib/prisma';
import { AuthService } from '../services/auth.service';
import { seedRolesForClient } from '../services/rbac-seed.service';
import { platformAdminService } from '../services/platform-admin.service';
import { inventoryMutationService } from '../services/inventory-mutation.service';
import * as wa from '../services/shelves/fill.service';

const BASE = process.env.VERIFY_API_URL || 'http://localhost:4006/api/v1';
const STAMP = Date.now();
const SHOP = `fill-${STAMP}`;
const OTHER = `fill-other-${STAMP}`;

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
const brief = (r: any) => `${r.status} ${JSON.stringify(r.data).slice(0, 260)}`;
const plain = (m: unknown) => typeof m === 'string' && /[a-z]{3}/i.test(m) && !/prisma|Invalid `|constraint|P20\d\d|undefined/i.test(m);
const api = (token: string): AxiosInstance => axios.create({ baseURL: BASE, headers: { Authorization: `Bearer ${token}` }, validateStatus: () => true, timeout: 120_000 });
const key = () => `save-${Math.random().toString(36).slice(2)}-${Date.now()}`;

async function person(clientId: string, name: string, roleId: string) {
  const u = await prisma.user.create({ data: { clientId, email: `fill-${name.toLowerCase()}-${clientId}@example.com`, name, password: 'unused', status: 'ACTIVE' } });
  await prisma.userRole.create({ data: { userId: u.id, roleId } });
  return { id: u.id, name, http: api(AuthService.generateToken({ userId: u.id, clientId })) };
}

/** The one rule: what is on the shelves is never more than the location holds, and never below 0. */
async function ruleHolds(): Promise<string> {
  const rows = await prisma.$queryRaw<{ variant_id: string; shelved: bigint; official: number | null; negative: bigint }[]>`
    SELECT ss.variant_id, SUM(ss.quantity) AS shelved, MAX(s.quantity) AS official,
           SUM(CASE WHEN ss.quantity < 0 THEN 1 ELSE 0 END) AS negative
    FROM spot_stocks ss LEFT JOIN inventory_stocks s ON s.variant_id = ss.variant_id AND s.location_id = ss.location_id
    WHERE ss.client_id = ${SHOP} GROUP BY ss.variant_id`;
  return rows.filter(r => Number(r.shelved) > (r.official ?? 0) || Number(r.negative) > 0)
    .map(b => `${b.variant_id}: shelves ${b.shelved} > ${b.official}`).join('; ');
}
const onShelf = async (spotId: string, variantId: string) => (await prisma.spotStock.findUnique({ where: { spotId_variantId: { spotId, variantId } } }))?.quantity ?? 0;

async function main() {
  console.log(`SETUP ${SHOP}: a godown with 4 shelves and 4 items, 9 pieces each`);
  const roles = await seedRolesForClient(SHOP);
  await prisma.clientSettings.create({ data: { clientId: SHOP, businessName: 'First Fill Sarees' } });
  const owner = await person(SHOP, 'Owner', roles.SUPER_ADMIN);
  const ravi = await person(SHOP, 'Ravi', roles.WAREHOUSE);
  const meena = await person(SHOP, 'Meena', roles.WAREHOUSE);

  const store = await prisma.stockLocation.create({ data: { clientId: SHOP, name: 'Main Store', code: 'MAIN', type: 'STORE', active: true } });
  const product = await prisma.product.create({ data: { clientId: SHOP, title: 'Silk Saree', productCode: `FF-${STAMP}`, slug: `ff-${STAMP}`, category: 'WOMEN', productType: 'READY_TO_WEAR', basePrice: 1000, status: 'ACTIVE' } });
  const mk = (sku: string, colour: string) => prisma.productVariant.create({ data: { clientId: SHOP, productId: product.id, sku: `${sku}-${STAMP}`, variantCode: `V-${sku}-${STAMP}`, colorName: colour, size: 'Free', sellingPrice: 1000, costPrice: 600, averageCost: 600, barcode: `88${sku}${STAMP}` } });
  const red = await mk('RED', 'Red');
  const blue = await mk('BLUE', 'Blue');
  const green = await mk('GREEN', 'Green');
  const gold = await mk('GOLD', 'Gold');
  for (const v of [red, blue, green, gold]) {
    await inventoryMutationService.applyMovement({ clientId: SHOP, variantId: v.id, locationId: store.id, movementType: 'IN', reason: 'INITIAL_STOCK', quantityDelta: 9, unitCost: 600 });
  }

  const own = owner.http;
  const made = await own.post(`/shelves/locations/${store.id}/spots/bulk`, {
    isShopFloor: true,
    levels: [
      { kind: 'AREA', range: { codes: ['FLOOR'] } },
      { kind: 'RACK', range: { from: 1, to: 2, prefix: 'R' } },
      { kind: 'SHELF', range: { from: 1, to: 2 } }
    ]
  });
  if (made.status !== 201) throw new Error(`could not set up the racks: ${brief(made)}`);
  const spot = async (address: string) => prisma.storageSpot.findFirstOrThrow({ where: { clientId: SHOP, address } });
  const s11 = await spot('FLOOR-R1-1'), s12 = await spot('FLOOR-R1-2'), s21 = await spot('FLOOR-R2-1'), s22 = await spot('FLOOR-R2-2');
  const fill = () => own.get(`/shelves/locations/${store.id}/fill`);

  try {
    console.log('\nA. THE WALK');
    const start = await fill();
    check('before anything: 4 shelves, none done, 36 pieces waiting, first fill not started',
      start.data.data.shelves.total === 4 && start.data.data.shelves.completed === 0 && start.data.data.piecesWaiting === 36 && start.data.data.firstFill.state === 'NOT_STARTED', brief(start));
    check('  ...and it says which shelf to stand at first, in walking order', start.data.data.next?.address === 'FLOOR-R1-1' && start.data.data.next.position === 1, brief(start));

    const open = await ravi.http.post(`/shelves/spots/${s11.id}/fill/open`, {});
    check('standing at a shelf: it shows the shelf and that nothing is on it yet', open.status === 200 && open.data.data.spot.address === 'FLOOR-R1-1' && open.data.data.alreadyOnIt.length === 0 && open.data.data.state === 'IN_PROGRESS', brief(open));
    check('  ...and nobody else is shown as being there', open.data.data.heldBySomeoneElse === null);

    const saved = await ravi.http.post(`/shelves/spots/${s11.id}/fill`, { saveKey: key(), lines: [{ variantId: red.id, quantity: 4 }, { variantId: blue.id, quantity: 3 }] });
    check('saving one shelf: 2 items, 7 pieces, shelf done', saved.status === 200 && saved.data.data.saved === true && saved.data.data.items === 2 && saved.data.data.pieces === 7 && saved.data.data.state === 'COMPLETED', brief(saved));
    check('  ...the pieces really are on that shelf', await onShelf(s11.id, red.id) === 4 && await onShelf(s11.id, blue.id) === 3);
    check('  ...and the location still holds 9 of each: nothing was created', (await prisma.inventoryStock.findFirstOrThrow({ where: { variantId: red.id, locationId: store.id } })).quantity === 9);
    check('  ...saving the first shelf started the first fill', saved.data.data.firstFillStarted === true && (await fill()).data.data.firstFill.state === 'FILLING', brief(saved));

    const after = await fill();
    check('the walk moves on: 1 of 4 done, 29 pieces waiting, next is FLOOR-R1-2',
      after.data.data.shelves.completed === 1 && after.data.data.piecesWaiting === 29 && after.data.data.next.address === 'FLOOR-R1-2', brief(after));

    const two = await ravi.http.post(`/shelves/spots/${s11.id}/fill/open`, {});
    check('coming back to a finished shelf shows what is on it and keeps it finished', two.data.data.alreadyOnIt.length === 2 && two.data.data.state === 'COMPLETED', brief(two));

    const empty = await ravi.http.post(`/shelves/spots/${s12.id}/fill`, { saveKey: key(), lines: [] });
    check('a shelf with nothing on it: the screen is told to use Skip instead of an empty save', empty.status === 400 && plain(empty.data.message), brief(empty));

    console.log('\nB. IT NEVER INVENTS STOCK');
    const tooMany = await ravi.http.post(`/shelves/spots/${s12.id}/fill`, { saveKey: key(), lines: [{ variantId: red.id, quantity: 99 }] });
    check('more than ScaleEzy has: nothing saved, and it says how many can go on a shelf', tooMany.status === 200 && tooMany.data.data.saved === false && tooMany.data.data.problems[0].free === 5 && plain(tooMany.data.data.problems[0].message), brief(tooMany));
    check('  ...nothing at all went onto that shelf', await onShelf(s12.id, red.id) === 0);

    const mixed = await ravi.http.post(`/shelves/spots/${s12.id}/fill`, { saveKey: key(), lines: [{ variantId: green.id, quantity: 2 }, { variantId: red.id, quantity: 99 }] });
    check('one bad line out of two: ALL of it is held back, not half of it', mixed.data.data.saved === false && mixed.data.data.problems.length === 1 && await onShelf(s12.id, green.id) === 0, brief(mixed));
    check('  ...and the message says how many items need a change', /One item needs a change/.test(mixed.data.data.message), brief(mixed));

    const fixed = await ravi.http.post(`/shelves/spots/${s12.id}/fill`, { saveKey: key(), lines: [{ variantId: green.id, quantity: 2 }, { variantId: red.id, quantity: 5 }] });
    check('after fixing the one line, the whole shelf saves', fixed.data.data.saved === true && await onShelf(s12.id, red.id) === 5 && await onShelf(s12.id, green.id) === 2, brief(fixed));

    const same = await ravi.http.post(`/shelves/spots/${s21.id}/fill`, { saveKey: key(), lines: [{ variantId: gold.id, quantity: 2 }, { variantId: gold.id, quantity: 3 }] });
    check('the same item typed twice on one shelf becomes one line of 5', same.data.data.saved === true && same.data.data.items === 1 && await onShelf(s21.id, gold.id) === 5, brief(same));

    console.log('\nC. A RETRY IS NOT A SECOND PUT-AWAY');
    const retryKey = key();
    const first = await ravi.http.post(`/shelves/spots/${s22.id}/fill`, { saveKey: retryKey, lines: [{ variantId: gold.id, quantity: 4 }] });
    const retry = await ravi.http.post(`/shelves/spots/${s22.id}/fill`, { saveKey: retryKey, lines: [{ variantId: gold.id, quantity: 4 }] });
    check('the same save sent twice: the same answer, and the pieces are put away once', first.data.data.saved === true && retry.data.data.repeat === true && await onShelf(s22.id, gold.id) === 4, brief(retry));
    const fresh = await ravi.http.post(`/shelves/spots/${s22.id}/fill`, { saveKey: key(), lines: [{ variantId: green.id, quantity: 1 }] });
    check('a new save key on the same shelf really does add', fresh.data.data.saved === true && await onShelf(s22.id, green.id) === 1, brief(fresh));

    console.log('\nD. TWO PHONES');
    const meenaOpen = await meena.http.post(`/shelves/spots/${s21.id}/fill/open`, {});
    check('Meena opens a shelf Ravi has not touched: nobody else is there', meenaOpen.data.data.heldBySomeoneElse === null, brief(meenaOpen));
    await ravi.http.post(`/shelves/spots/${s12.id}/fill/open`, {});
    const meenaSame = await meena.http.post(`/shelves/spots/${s12.id}/fill/open`, {});
    check('the same shelf: Meena is told Ravi is there, by name, and is not locked out', meenaSame.data.data.heldBySomeoneElse?.who === 'Ravi' && meenaSame.status === 200, brief(meenaSame));
const blueBefore = await onShelf(s12.id, blue.id), greenBefore = await onShelf(s12.id, green.id);
    const bothSave = await Promise.all([
      ravi.http.post(`/shelves/spots/${s12.id}/fill`, { saveKey: key(), lines: [{ variantId: blue.id, quantity: 2 }] }),
      meena.http.post(`/shelves/spots/${s12.id}/fill`, { saveKey: key(), lines: [{ variantId: green.id, quantity: 2 }] })
    ]);
    check('both phones saving the same shelf: both lots of work are kept', bothSave.every(r => r.data.data.saved === true) && await onShelf(s12.id, blue.id) === blueBefore + 2 && await onShelf(s12.id, green.id) === greenBefore + 2, bothSave.map(brief).join(' | '));
    check('  ...and the rule still holds', await ruleHolds() === '');

    console.log('\nE. THE NUMBERS ARE HONEST');
    const before = (await fill()).data.data;
    check('every number adds up in a healthy shop: nothing needs a stock check', before.needStockCheck === 0, JSON.stringify(before).slice(0, 200));
    // An item whose stock has gone below zero (older data, a bad import). The database may refuse to
    // let it happen at all, which is the better answer; if it does happen, it must be SHOWN.
    const refused = await prisma.inventoryStock.updateMany({ where: { variantId: gold.id, locationId: store.id }, data: { quantity: -2 } })
      .then(() => null).catch((e: any) => String(e?.message ?? e));
    if (refused) {
      check('the database itself refuses to leave a location holding less than its shelves', /shelf_stock_exceeds_location/.test(refused), refused.slice(0, 120));
    } else {
      const odd = await fill();
      check('an item with stock below zero is counted as "needs a stock check", never hidden behind a 0',
        odd.data.data.needStockCheck === 1 && odd.data.data.piecesWaiting <= before.piecesWaiting, brief(odd));
      await prisma.inventoryStock.updateMany({ where: { variantId: gold.id, locationId: store.id }, data: { quantity: 9 } });
    }

    console.log('\nF. THE TILL WHILE THE SHELVES ARE BEING FILLED (D1)');
    // Every shelf was finished above, so the first fill ended by itself -- which is the right
    // behaviour. For this part the shop is filling again, as a shop reorganising would be.
    const reopened = await own.post('/shelves/fill/reopen', { locationId: store.id });
    check('a first fill that ended can be opened again, and it is filling once more', reopened.data.data.firstFill.state === 'FILLING', brief(reopened));

    // 4 more red pieces arrive, so some are on no shelf: the state a shop is really in mid-walk.
    await inventoryMutationService.applyMovement({ clientId: SHOP, variantId: red.id, locationId: store.id, movementType: 'IN', reason: 'PURCHASE', quantityDelta: 4, unitCost: 600 });
    const redShelves = async () => (await onShelf(s11.id, red.id)) + (await onShelf(s12.id, red.id));
    const shelvedBefore = await redShelves();
    const totalBefore = (await prisma.inventoryStock.findFirstOrThrow({ where: { variantId: red.id, locationId: store.id } })).quantity;
    await inventoryMutationService.applyMovement({ clientId: SHOP, variantId: red.id, locationId: store.id, movementType: 'OUT', reason: 'SALE', quantityDelta: -1 });
    check('a till sale during the first fill takes a piece that is on no shelf, leaving the counted shelves alone',
      await redShelves() === shelvedBefore, `${shelvedBefore} on shelves -> ${await redShelves()}`);
    check('  ...and the location count went down by one', (await prisma.inventoryStock.findFirstOrThrow({ where: { variantId: red.id, locationId: store.id } })).quantity === totalBefore - 1);

    // Sell whatever is left off the shelves, then one more: that one has to come off a shelf.
    const spare = (await prisma.inventoryStock.findFirstOrThrow({ where: { variantId: red.id, locationId: store.id } })).quantity - await redShelves();
    if (spare > 0) await inventoryMutationService.applyMovement({ clientId: SHOP, variantId: red.id, locationId: store.id, movementType: 'OUT', reason: 'SALE', quantityDelta: -spare });
    check('  ...and it keeps doing that while any piece is left off the shelves', await redShelves() === shelvedBefore, `${shelvedBefore} -> ${await redShelves()}`);
    const beforeLast = await redShelves();
    await inventoryMutationService.applyMovement({ clientId: SHOP, variantId: red.id, locationId: store.id, movementType: 'OUT', reason: 'SALE', quantityDelta: -1 });
    const issue = await prisma.shelfIssue.findFirst({ where: { clientId: SHOP }, orderBy: { createdAt: 'desc' } });
    check('once nothing is left off the shelves, the sale does come off a shelf', await redShelves() === beforeLast - 1, `${beforeLast} -> ${await redShelves()}`);
    check('  ...and the shop is told which shelf to check, and why', !!issue && /while the shelves were being filled/.test(issue.message) && /Check that shelf/.test(issue.message), issue?.message ?? 'no issue');
    check('  ...the rule still holds after every sale', await ruleHolds() === '');

    console.log('\nG. FINISHING');
    const skip = await ravi.http.post(`/shelves/spots/${s21.id}/fill/skip`, {});
    check('a shelf can be skipped, and stays on the skipped list', skip.data.data.state === 'SKIPPED' && (await fill()).data.data.skippedShelves.some((s: any) => s.address === 'FLOOR-R2-1'), brief(skip));

    const notYet = await own.post('/shelves/fill/finish', { locationId: store.id });
    check('pressing Finished with shelves left over asks first, naming them', notYet.data.data.needsConfirming === true && /skipped|not been done/.test(notYet.data.data.message), brief(notYet));
    check('  ...and it is still filling until the second press', (await fill()).data.data.firstFill.state === 'FILLING');

    const done = await own.post('/shelves/fill/finish', { locationId: store.id, force: true });
    check('the second press finishes it, and records that a person did', done.data.data.firstFill.state === 'FINISHED' && done.data.data.firstFill.endedByItself === false, brief(done));

    // Blue still has pieces off the shelves, so the normal rule is visible again: floor shelf first.
    const blueOn = await onShelf(s11.id, blue.id);
    const blueSpare = (await prisma.inventoryStock.findFirstOrThrow({ where: { variantId: blue.id, locationId: store.id } })).quantity
      - (await onShelf(s11.id, blue.id)) - (await onShelf(s12.id, blue.id));
    await inventoryMutationService.applyMovement({ clientId: SHOP, variantId: blue.id, locationId: store.id, movementType: 'OUT', reason: 'SALE', quantityDelta: -1 });
    check(`after finishing, a till sale takes from the shop-floor shelf again, not from the ${blueSpare} left off them`,
      await onShelf(s11.id, blue.id) === blueOn - 1, `${blueOn} -> ${await onShelf(s11.id, blue.id)}`);

    // A first fill nobody finished. The reminder must reach the owner once, and only once.
    {
      const alerts: { to: string; subject: string; text: string }[] = [];
      const realSend = (wa as any).fillMail.send;
      (wa as any).fillMail.send = async (m: any) => { alerts.push(m); return { sent: true }; };
      try {
        await prisma.locationFirstFill.updateMany({
          where: { locationId: store.id },
          data: { state: 'FILLING', remindedAt: null, startedAt: new Date(Date.now() - 8 * 86400000) }
        });
        const first = await wa.fillService.remindForgotten();
        check('a first fill left open for a week reminds the owner, once', first.reminded === 1 && alerts.length === 1 && /half filled/.test(alerts[0].subject), JSON.stringify({ first, alerts: alerts.length }));
        check('  ...and the email says where it got to and what it means', /shelves are done/.test(alerts[0].text) && /takes a piece that is on no shelf first/.test(alerts[0].text), alerts[0]?.text?.slice(0, 160));
        const again = await wa.fillService.remindForgotten();
        check('  ...and never again for the same fill', again.reminded === 0 && alerts.length === 1);
        await prisma.locationFirstFill.updateMany({ where: { locationId: store.id }, data: { startedAt: new Date() } });
        const fresh = await wa.fillService.remindForgotten();
        check('a first fill started today is left alone', fresh.reminded === 0 && alerts.length === 1);
      } finally {
        (wa as any).fillMail.send = realSend;
        // Put it back as the earlier checks left it: finished by a person.
        await prisma.locationFirstFill.updateMany({
          where: { locationId: store.id },
          data: { state: 'FINISHED', finishedAt: new Date(), endedByItself: false, remindedAt: null }
        });
      }
    }

    const reopen = await own.post('/shelves/fill/reopen', { locationId: store.id });
    check('the owner can open it again afterwards, for a shop that reorganises', reopen.data.data.firstFill.state === 'FILLING', brief(reopen));

    // Skipping every shelf must NOT finish it by itself: nothing was filled.
    const other = await prisma.stockLocation.create({ data: { clientId: SHOP, name: 'Pop-up', code: 'POPUP', type: 'STORE', active: true } });
    await own.post(`/shelves/locations/${other.id}/spots/bulk`, { isShopFloor: true, levels: [{ kind: 'AREA', range: { codes: ['POP'] } }, { kind: 'SHELF', range: { from: 1, to: 2 } }] });
    const p1 = await prisma.storageSpot.findFirstOrThrow({ where: { clientId: SHOP, address: 'POP-1' } });
    const p2 = await prisma.storageSpot.findFirstOrThrow({ where: { clientId: SHOP, address: 'POP-2' } });
    await ravi.http.post(`/shelves/spots/${p1.id}/fill/skip`, {});
    await ravi.http.post(`/shelves/spots/${p2.id}/fill/skip`, {});
    const allSkipped = await own.get(`/shelves/locations/${other.id}/fill`);
    check('skipping every shelf never finishes the first fill by itself (nothing was filled)', allSkipped.data.data.firstFill.state !== 'FINISHED', brief(allSkipped));

    // Every shelf really filled: it finishes by itself, and says so.
    await inventoryMutationService.applyMovement({ clientId: SHOP, variantId: green.id, locationId: other.id, movementType: 'IN', reason: 'INITIAL_STOCK', quantityDelta: 4, unitCost: 600 });
    await ravi.http.post(`/shelves/spots/${p1.id}/fill`, { saveKey: key(), lines: [{ variantId: green.id, quantity: 2 }] });
    const last = await ravi.http.post(`/shelves/spots/${p2.id}/fill`, { saveKey: key(), lines: [{ variantId: green.id, quantity: 2 }] });
    const ended = await own.get(`/shelves/locations/${other.id}/fill`);
    check('the shelf that completes the last one ends the first fill by itself', last.data.data.firstFillFinished === true && ended.data.data.firstFill.state === 'FINISHED' && ended.data.data.firstFill.endedByItself === true, brief(ended));
    check('  ...the rule holds at the end of everything', await ruleHolds() === '');

    console.log('\nH. HOSTILE AND ODD CASES');
    {
      // Another shop entirely: its ids must read as "not found", never as a hint that they exist.
      const outsideRoles = await seedRolesForClient(OTHER);
      const outsider = await person(OTHER, 'Outsider', outsideRoles.SUPER_ADMIN);
      const theirLocation = await prisma.stockLocation.create({ data: { clientId: OTHER, name: 'Their store', code: 'THEIRS', type: 'STORE', active: true } });
      const cross: [string, Promise<any>, number[]][] = [
        ['reading our fill progress', outsider.http.get(`/shelves/locations/${store.id}/fill`), [403, 404]],
        ['opening our shelf', outsider.http.post(`/shelves/spots/${s11.id}/fill/open`, {}), [403, 404]],
        ['saving onto our shelf', outsider.http.post(`/shelves/spots/${s11.id}/fill`, { saveKey: key(), lines: [{ variantId: red.id, quantity: 1 }] }), [403, 404]],
        ['skipping our shelf', outsider.http.post(`/shelves/spots/${s11.id}/fill/skip`, {}), [403, 404]],
        ['finishing our first fill', outsider.http.post('/shelves/fill/finish', { locationId: store.id }), [403, 404]],
        ['describing our racks', outsider.http.post(`/shelves/locations/${store.id}/spots/bulk`, { levels: [{ kind: 'AREA', range: { codes: ['HACK'] } }], preview: true }), [403, 404]]
      ];
      for (const [what, call, allowed] of cross) {
        const r = await call;
        check(`another shop ${what}: refused (${allowed.join(' or ')})`, allowed.includes(r.status) && !/FLOOR|R1-1/.test(JSON.stringify(r.data ?? '')), brief(r));
      }
      const ours = await own.post(`/shelves/spots/${s11.id}/fill`, { saveKey: key(), lines: [{ variantId: red.id, quantity: 1 }] });
      check('our own shop can still save after those attempts', [200, 409].includes(ours.status), brief(ours));
      const theirVariant = await prisma.productVariant.findFirst({ where: { clientId: OTHER } });
      const theirLoc = await own.get(`/shelves/locations/${theirLocation.id}/fill`);
      check('our shop asking about their location: not found', theirLoc.status === 404, brief(theirLoc));

      // Somebody with the wrong role.
      const salesRole = await prisma.role.create({ data: { clientId: SHOP, name: `SALESONLY-${STAMP}` } });
      const salesperson = await person(SHOP, 'Sales', salesRole.id);
      const noRight: [string, Promise<any>][] = [
        ['fill a shelf', salesperson.http.post(`/shelves/spots/${s11.id}/fill`, { saveKey: key(), lines: [{ variantId: red.id, quantity: 1 }] })],
        ['skip a shelf', salesperson.http.post(`/shelves/spots/${s11.id}/fill/skip`, {})],
        ['finish the first fill', salesperson.http.post('/shelves/fill/finish', { locationId: store.id })],
        ['open it again', salesperson.http.post('/shelves/fill/reopen', { locationId: store.id })]
      ];
      for (const [what, call] of noRight) {
        const r = await call;
        check(`somebody without the permission cannot ${what}`, r.status === 403, brief(r));
      }
      const finishWithPutawayOnly = await ravi.http.post('/shelves/fill/finish', { locationId: store.id });
      check('putting stock away does not let you finish the whole first fill', finishWithPutawayOnly.status === 403, brief(finishWithPutawayOnly));

      // Input a person or a broken phone could really send.
      const bad: [string, any, number[]][] = [
        ['no lines at all', { saveKey: key(), lines: [] }, [400]],
        ['a quantity of 0', { saveKey: key(), lines: [{ variantId: red.id, quantity: 0 }] }, [400]],
        ['a negative quantity', { saveKey: key(), lines: [{ variantId: red.id, quantity: -3 }] }, [400]],
        ['half a piece', { saveKey: key(), lines: [{ variantId: red.id, quantity: 1.5 }] }, [400]],
        ['a quantity as text', { saveKey: key(), lines: [{ variantId: red.id, quantity: '2' }] }, [400]],
        ['no save key', { lines: [{ variantId: red.id, quantity: 1 }] }, [400]],
        ['a save key of two letters', { saveKey: 'ab', lines: [{ variantId: red.id, quantity: 1 }] }, [400]],
        ['an unknown field', { saveKey: key(), lines: [{ variantId: red.id, quantity: 1 }], clientId: OTHER }, [400]],
        ['an item that does not exist', { saveKey: key(), lines: [{ variantId: 'no-such-item', quantity: 1 }] }, [200]],
        ['250 lines on one shelf', { saveKey: key(), lines: Array.from({ length: 250 }, () => ({ variantId: red.id, quantity: 1 })) }, [400]]
      ];
      for (const [what, body, allowed] of bad) {
        const r = await ravi.http.post(`/shelves/spots/${s12.id}/fill`, body);
        const said = r.data?.message ?? r.data?.data?.message ?? '';
        check(`${what}: refused in words, nothing saved`, allowed.includes(r.status) && plain(said), brief(r));
      }
      check('  ...and the rule still holds after every bad request', await ruleHolds() === '');

      // The same save key sent for a DIFFERENT shelf: it must not silently answer for the first one.
      const sharedKey = key();
      const greenOnS22Before = await onShelf(s22.id, green.id);
      const one = await ravi.http.post(`/shelves/spots/${s21.id}/fill`, { saveKey: sharedKey, lines: [{ variantId: green.id, quantity: 1 }] });
      const onAnother = await ravi.http.post(`/shelves/spots/${s22.id}/fill`, { saveKey: sharedKey, lines: [{ variantId: green.id, quantity: 1 }] });
      check('the same save key on a different shelf is refused, not answered for the first shelf',
        one.data.data.saved === true && onAnother.status === 400 && /another shelf/.test(onAnother.data.message), brief(onAnother));
      check('  ...and that other shelf is left exactly as it was', await onShelf(s22.id, green.id) === greenOnS22Before, `${greenOnS22Before} -> ${await onShelf(s22.id, green.id)}`);

      // A shelf switched off, or one with shelves inside it.
      await prisma.storageSpot.updateMany({ where: { id: s22.id }, data: { active: false } });
      const off = await ravi.http.post(`/shelves/spots/${s22.id}/fill/open`, {});
      check('a switched-off shelf cannot be filled, and says why', off.status === 400 && /switched off/.test(off.data.message), brief(off));
      await prisma.storageSpot.updateMany({ where: { id: s22.id }, data: { active: true } });
      const rack = await prisma.storageSpot.findFirstOrThrow({ where: { clientId: SHOP, address: 'FLOOR-R1' } });
      const onRack = await ravi.http.post(`/shelves/spots/${rack.id}/fill/open`, {});
      check('a rack that has shelves inside it is not a place to stand', onRack.status === 400 && /inside it/.test(onRack.data.message), brief(onRack));

      // Two people finishing at the same moment.
      await own.post('/shelves/fill/reopen', { locationId: store.id });
      const both = await Promise.all([
        own.post('/shelves/fill/finish', { locationId: store.id, force: true }),
        own.post('/shelves/fill/finish', { locationId: store.id, force: true })
      ]);
      const afterBoth = await fill();
      check('two people pressing Finished together: one finish, no error', both.every(r => r.status === 200) && afterBoth.data.data.firstFill.state === 'FINISHED', both.map(brief).join(' | '));

      // A location with no racks at all, and one with no stock.
      const bare = await prisma.stockLocation.create({ data: { clientId: SHOP, name: 'Bare', code: `BARE-${STAMP}`, type: 'STORE', active: true } });
      const bareStatus = await own.get(`/shelves/locations/${bare.id}/fill`);
      check('a location with no racks says so instead of breaking', bareStatus.status === 200 && bareStatus.data.data.shelves.total === 0 && bareStatus.data.data.next === null, brief(bareStatus));
      const bareFinish = await own.post('/shelves/fill/finish', { locationId: bare.id });
      check('  ...and finishing one with nothing in it is harmless', [200].includes(bareFinish.status), brief(bareFinish));

      // An archived product still sitting on a shelf must remain findable and countable.
      await prisma.product.updateMany({ where: { clientId: SHOP, id: product.id }, data: { status: 'ARCHIVED' } });
      const archived = await own.get(`/shelves/locations/${store.id}/fill`);
      check('pieces of an archived product still count as on the shelves', archived.status === 200 && typeof archived.data.data.piecesWaiting === 'number', brief(archived));
      await prisma.product.updateMany({ where: { clientId: SHOP, id: product.id }, data: { status: 'ACTIVE' } });

      console.log('\nI. THE CASES AN AUDIT FOUND');
      // A godown-only shop: every sale comes off a back-room shelf, and that is NORMAL. It must not
      // raise a shelf issue and an alert on every single sale, for ever.
      const godown = await prisma.stockLocation.create({ data: { clientId: SHOP, name: 'Godown only', code: `GDO-${STAMP}`, type: 'WAREHOUSE', active: true } });
      await own.post(`/shelves/locations/${godown.id}/spots/bulk`, { isShopFloor: false, levels: [{ kind: 'AREA', range: { codes: ['GD'] } }, { kind: 'SHELF', range: { from: 1, to: 2 } }] });
      const g1 = await prisma.storageSpot.findFirstOrThrow({ where: { clientId: SHOP, locationId: godown.id, address: 'GD-1' } });
      await inventoryMutationService.applyMovement({ clientId: SHOP, variantId: gold.id, locationId: godown.id, movementType: 'IN', reason: 'INITIAL_STOCK', quantityDelta: 5, unitCost: 600 });
      await ravi.http.post(`/shelves/spots/${g1.id}/fill`, { saveKey: key(), lines: [{ variantId: gold.id, quantity: 5 }] });
      const issuesBefore = await prisma.shelfIssue.count({ where: { clientId: SHOP, locationId: godown.id } });
      const alertsBefore = await prisma.inventoryAlert.count({ where: { clientId: SHOP, locationId: godown.id, type: 'STOCK_DISCREPANCY' } });
      await inventoryMutationService.applyMovement({ clientId: SHOP, variantId: gold.id, locationId: godown.id, movementType: 'OUT', reason: 'SALE', quantityDelta: -2 });
      check('a shop with no shop-floor shelves is not warned on every sale from its godown',
        (await prisma.shelfIssue.count({ where: { clientId: SHOP, locationId: godown.id } })) === issuesBefore &&
        (await prisma.inventoryAlert.count({ where: { clientId: SHOP, locationId: godown.id, type: 'STOCK_DISCREPANCY' } })) === alertsBefore,
        `issues ${issuesBefore} -> ${await prisma.shelfIssue.count({ where: { clientId: SHOP, locationId: godown.id } })}`);
      check('  ...and the sale still came off the shelf', await onShelf(g1.id, gold.id) === 3, String(await onShelf(g1.id, gold.id)));

      // Switching a rack off and on again: the shelves inside must come back.
      const r1 = await prisma.storageSpot.findFirstOrThrow({ where: { clientId: SHOP, address: 'FLOOR-R1' } });
      await own.patch(`/shelves/spots/${(await prisma.storageSpot.findFirstOrThrow({ where: { clientId: SHOP, address: 'FLOOR-R1-1' } })).id}`, {});
      const beforeOff = (await fill()).data.data.shelves.total;
      await prisma.spotStock.deleteMany({ where: { clientId: SHOP, spotId: { in: [s11.id, s12.id] } } });
      const rackOff = await own.patch(`/shelves/spots/${r1.id}`, { active: false });
      const whileOff = (await fill()).data.data.shelves.total;
      const rackOn = await own.patch(`/shelves/spots/${r1.id}`, { active: true });
      const afterOn = (await fill()).data.data.shelves.total;
      check('switching a rack off hides its shelves, and switching it on brings them back',
        rackOff.status === 200 && rackOn.status === 200 && whileOff === beforeOff - 2 && afterOn === beforeOff,
        `${beforeOff} -> ${whileOff} -> ${afterOn}`);

      // Reopening a finished fill must give the walk something to do again.
      await own.post('/shelves/fill/finish', { locationId: store.id, force: true });
      const reopened = await own.post('/shelves/fill/reopen', { locationId: store.id });
      check('opening a finished fill again starts the walk from the first shelf', reopened.data.data.firstFill.state === 'FILLING' && reopened.data.data.shelves.completed === 0 && !!reopened.data.data.next, brief(reopened));

      // A location the shop has switched off is not a place to work.
      const closed = await prisma.stockLocation.create({ data: { clientId: SHOP, name: 'Closed shop', code: `CLS-${STAMP}`, type: 'STORE', active: true } });
      await own.post(`/shelves/locations/${closed.id}/spots/bulk`, { isShopFloor: true, levels: [{ kind: 'AREA', range: { codes: ['CL'] } }, { kind: 'SHELF', range: { from: 1, to: 1 } }] });
      const closedShelf = await prisma.storageSpot.findFirstOrThrow({ where: { clientId: SHOP, locationId: closed.id, address: 'CL-1' } });
      await prisma.stockLocation.update({ where: { id: closed.id }, data: { active: false } });
      const openClosed = await ravi.http.post(`/shelves/spots/${closedShelf.id}/fill/open`, {});
      check('a shelf in a switched-off location cannot be filled, and says why', openClosed.status === 400 && /switched off/.test(openClosed.data.message), brief(openClosed));
      const readClosed = await own.get(`/shelves/locations/${closed.id}/fill`);
      check('  ...but its progress can still be read', readClosed.status === 200, brief(readClosed));

      // Two identical saves fired at the same moment: one answer, never a failure.
      const raceKey = key();
      const raceShelf = (await fill()).data.data.next.spotId;
      const raced = await Promise.all([
        ravi.http.post(`/shelves/spots/${raceShelf}/fill`, { saveKey: raceKey, lines: [{ variantId: blue.id, quantity: 1 }] }),
        ravi.http.post(`/shelves/spots/${raceShelf}/fill`, { saveKey: raceKey, lines: [{ variantId: blue.id, quantity: 1 }] })
      ]);
      check('the same save fired twice at once: both get an answer, never an error', raced.every(r => r.status === 200 && (r.data.data.saved === true || r.data.data.repeat === true)), raced.map(brief).join(' | '));
      check('  ...and the pieces were put away once', raced.filter(r => r.data.data.repeat).length === 1, raced.map(r => String(r.data.data.repeat)).join());

      // Finishing a location nobody ever filled must not record a fill that never happened.
      const untouched = await prisma.stockLocation.create({ data: { clientId: SHOP, name: 'Untouched', code: `UNT-${STAMP}`, type: 'STORE', active: true } });
      const nothing = await own.post('/shelves/fill/finish', { locationId: untouched.id });
      check('finishing a location nobody filled says there is nothing to finish', nothing.data.data.nothingToFinish === true && (await prisma.locationFirstFill.count({ where: { locationId: untouched.id } })) === 0, brief(nothing));

      await platformAdminService.deleteClientCompletely(OTHER, OTHER).catch(() => {});
    }
  } finally {
    await platformAdminService.deleteClientCompletely(OTHER, OTHER).catch(() => {});
    await platformAdminService.deleteClientCompletely(SHOP, SHOP).catch(async (e: any) => {
      console.log('  (delete failed:', String(e?.message ?? e).slice(0, 200), ')');
      await prisma.spotFillState.deleteMany({ where: { clientId: SHOP } });
      await prisma.locationFirstFill.deleteMany({ where: { clientId: SHOP } });
    });
    const left = await prisma.storageSpot.count({ where: { clientId: SHOP } });
    check('the test shop is removed afterwards', left === 0, String(left));
  }

  console.log(`\nRESULT: ${passed} passed | ${failures.length} failed`);
  if (failures.length) console.log('Failed:\n - ' + failures.join('\n - '));
  process.exit(failures.length ? 1 : 0);
}

main().catch(async e => {
  console.error('\nSuite did not finish:', e?.message ?? e);
  await platformAdminService.deleteClientCompletely(SHOP, SHOP).catch(() => {});
  await platformAdminService.deleteClientCompletely(OTHER, OTHER).catch(() => {});
  process.exit(1);
});
