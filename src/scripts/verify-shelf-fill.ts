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
  } finally {
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
  process.exit(1);
});
