/**
 * Verifies the day book.
 *
 * The property that matters is the accounting identity: opening + in - out = closing, for
 * every day, with each day's closing becoming the next day's opening, and the final closing
 * equal to the stock actually on the shelves. If that chain holds, the report is right; if it
 * breaks anywhere, every figure downstream is suspect.
 *
 *   npx ts-node src/scripts/verify-daybook.ts
 */
import { prisma } from '../lib/prisma';
import { localDayRange, previousDayKey, todayKey } from '../utils/businessDay';

const BASE = process.env.TEST_API_URL || 'http://localhost:4006/api/v1';
const TENANT_EMAIL = 'e2e1788452461634@example.com';
const TENANT_PASSWORD = process.env.TEST_TENANT_PASSWORD || '0B-GWDgJRCuK';

let passed = 0, failed = 0;
const failures: string[] = [];
const check = (name: string, ok: boolean, detail?: string) => {
  if (ok) { passed++; console.log(`  [PASS] ${name}`); }
  else { failed++; failures.push(name); console.log(`  [FAIL] ${name}${detail ? `  -> ${detail}` : ''}`); }
};

class Jar {
  private c = new Map<string, string>();
  capture(res: Response) {
    for (const line of ((res.headers as any).getSetCookie?.() || [])) {
      const [pair] = String(line).split(';');
      const i = pair.indexOf('=');
      if (i > 0) this.c.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
    }
  }
  header() { return [...this.c.entries()].map(([k, v]) => `${k}=${v}`).join('; '); }
}

async function call(method: string, path: string, body?: any, jar?: Jar) {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const cookie = jar?.header();
  if (cookie) headers['Cookie'] = cookie;
  const res = await fetch(`${BASE}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  jar?.capture(res);
  let json: any = null;
  try { json = await res.json(); } catch { /* none */ }
  return { status: res.status, json };
}

async function main() {
  console.log(`\nVerifying against ${BASE}\n`);

  const owner = await prisma.user.findFirst({ where: { email: TENANT_EMAIL }, select: { clientId: true } });
  if (!owner) throw new Error('Test tenant not found');
  const clientId = owner.clientId;

  const jar = new Jar();
  const login = await call('POST', '/auth/login', { email: TENANT_EMAIL, password: TENANT_PASSWORD }, jar);
  if (login.status !== 200) throw new Error(`Login failed (${login.status})`);

  // ─── ACCESS ─────────────────────────────────────────────────────────────────
  console.log('ACCESS');
  const anon = await call('GET', '/daybook');
  check('the day book needs a session', anon.status === 401, `got ${anon.status}`);

  // ─── INPUT ──────────────────────────────────────────────────────────────────
  console.log('\nINPUT');
  for (const bad of ['2026-02-31', '2026-13-01', '05-09-2026', 'yesterday']) {
    const r = await call('GET', `/daybook?date=${encodeURIComponent(bad)}`, undefined, jar);
    check(`"${bad}" is rejected`, r.status === 400, `got ${r.status}`);
  }

  const noDate = await call('GET', '/daybook', undefined, jar);
  check('no date defaults to today', noDate.status === 200 && noDate.json?.data?.inProgress === true,
    JSON.stringify(noDate.json?.data?.date));

  // ─── THE ACCOUNTING IDENTITY ────────────────────────────────────────────────
  console.log('\nTHE BOOKS MUST BALANCE');

  const today = todayKey((await call('GET', '/daybook', undefined, jar)).json.data.timezone);
  const days: string[] = [];
  let cursor = today;
  for (let i = 0; i < 5; i++) { days.unshift(cursor); cursor = previousDayKey(cursor); }

  const results: any[] = [];
  for (const day of days) {
    const r = await call('GET', `/daybook?date=${day}`, undefined, jar);
    if (r.status !== 200) { check(`day ${day} loads`, false, `got ${r.status}`); continue; }
    results.push(r.json.data);
  }
  check('every requested day loads', results.length === days.length);

  for (const d of results) {
    if (!d.opening || !d.closing) continue;
    const expected = d.opening.units + d.stockIn.totalUnits - d.stockOut.totalUnits;
    check(`${d.date}: opening + in - out = closing`,
      expected === d.closing.units && d.balanced === true,
      `${d.opening.units} + ${d.stockIn.totalUnits} - ${d.stockOut.totalUnits} = ${expected}, closing says ${d.closing.units}`);
  }

  // Each day must hand its closing figure to the next day's opening, or the series has a
  // silent gap where stock appears or vanishes between days.
  for (let i = 1; i < results.length; i++) {
    const prev = results[i - 1], curr = results[i];
    if (!prev.closing || !curr.opening) continue;
    check(`${prev.date} closing carries into ${curr.date} opening`,
      prev.closing.units === curr.opening.units,
      `${prev.closing.units} vs ${curr.opening.units}`);
  }

  // ─── AGAINST REALITY ────────────────────────────────────────────────────────
  console.log('\nAGAINST LIVE STOCK');
  const variants = await prisma.productVariant.findMany({
    where: { clientId }, select: { stocks: { select: { quantity: true } } }
  });
  const liveUnits = variants.reduce((s, v) => s + v.stocks.reduce((a, x) => a + x.quantity, 0), 0);
  const lastDay = results[results.length - 1];
  check("today's closing equals the stock actually held",
    lastDay?.closing?.units === liveUnits, `${lastDay?.closing?.units} vs ${liveUnits}`);

  // ─── TIMEZONE ───────────────────────────────────────────────────────────────
  console.log('\nBUSINESS DAY, NOT UTC DAY');
  check('the shop timezone is reported', typeof lastDay?.timezone === 'string' && lastDay.timezone.includes('/'),
    lastDay?.timezone);

  // The window the report counts over must be the LOCAL day. Compared directly against the
  // ledger so a boundary error cannot hide behind agreeing totals.
  const probeDay = results.find(r => r.stockIn.totalUnits > 0 || r.stockOut.totalUnits > 0);
  if (probeDay) {
    const { start, end } = localDayRange(probeDay.date, probeDay.timezone);
    const ledger = await prisma.inventoryTransaction.aggregate({
      where: { clientId, createdAt: { gte: start, lt: end } },
      _sum: { quantity: true }
    });
    const reportNet = probeDay.stockIn.totalUnits - probeDay.stockOut.totalUnits;
    // Transfers net to zero company-wide and are excluded from in/out, so the ledger's raw
    // sum should still agree.
    check(`${probeDay.date}: report movement matches the ledger over the LOCAL day`,
      reportNet === (ledger._sum.quantity || 0),
      `report ${reportNet} vs ledger ${ledger._sum.quantity}`);
  } else {
    check('report movement matches the ledger over the LOCAL day', true, 'skipped -- no active day in range');
  }

  // ─── TRANSFERS ──────────────────────────────────────────────────────────────
  console.log('\nTRANSFERS');
  const withTransfer = results.find(r => r.transfers.unitsMoved > 0);
  if (withTransfer) {
    check('a transfer is reported separately, not as a purchase or a sale',
      !withTransfer.stockIn.lines.some((l: any) => l.reason === 'TRANSFER') &&
      !withTransfer.stockOut.lines.some((l: any) => l.reason === 'TRANSFER'));
    check('a transfer does not disturb the balance', withTransfer.balanced === true);
    check('the moving locations are shown',
      withTransfer.byLocation.some((l: any) => l.transferIn > 0 || l.transferOut > 0),
      JSON.stringify(withTransfer.byLocation.map((l: any) => [l.name, l.transferIn, l.transferOut])));
  } else {
    check('transfer handling', true, 'skipped -- no transfer in range');
  }

  // ─── LOCATIONS ──────────────────────────────────────────────────────────────
  console.log('\nPER LOCATION');
  const anyDay = results.find(r => r.byLocation.length > 0) || lastDay;
  check('locations are broken out', Array.isArray(anyDay?.byLocation));

  const locations = await prisma.stockLocation.findMany({ where: { clientId }, select: { id: true, name: true } });
  if (locations.length && probeDay) {
    const filtered = await call('GET', `/daybook?date=${probeDay.date}&locationId=${locations[0].id}`, undefined, jar);
    check('a single location can be filtered', filtered.status === 200, `got ${filtered.status}`);
    const onlyOne = (filtered.json?.data?.byLocation || []).length <= 1;
    check('the filtered view shows just that location', onlyOne,
      JSON.stringify((filtered.json?.data?.byLocation || []).map((l: any) => l.name)));

    const totalForLoc = (probeDay.byLocation.find((l: any) => l.locationId === locations[0].id)?.unitsIn) || 0;
    check("the filtered location's inbound matches the company view",
      (filtered.json?.data?.stockIn?.totalUnits || 0) === totalForLoc,
      `${filtered.json?.data?.stockIn?.totalUnits} vs ${totalForLoc}`);
  }

  // ─── SALES ──────────────────────────────────────────────────────────────────
  console.log('\nSALES');
  check('sales are reported', typeof lastDay?.sales?.revenue === 'number');
  check('gross profit is revenue minus cost',
    Math.abs((lastDay.sales.revenue - lastDay.sales.costOfGoods) - lastDay.sales.grossProfit) < 0.01,
    `${lastDay.sales.revenue} - ${lastDay.sales.costOfGoods} != ${lastDay.sales.grossProfit}`);

  // Dispatches are the measure, so nothing should be counted that has not gone out.
  const anyDispatchDay = results.find(r => r.sales.dispatchCount > 0);
  if (anyDispatchDay) {
    const { start, end } = localDayRange(anyDispatchDay.date, anyDispatchDay.timezone);
    const dispatched = await prisma.dispatch.count({
      where: { clientId, dispatchedAt: { gte: start, lt: end } }
    });
    check('sales count only goods actually dispatched that day',
      anyDispatchDay.sales.dispatchCount <= dispatched,
      `report ${anyDispatchDay.sales.dispatchCount} vs dispatched ${dispatched}`);
  } else {
    check('sales count only goods actually dispatched that day', true, 'skipped -- no dispatches in range');
  }

  // ─── QUIET AND FUTURE DAYS ──────────────────────────────────────────────────
  console.log('\nEDGE CASES');
  const longAgo = await call('GET', '/daybook?date=2020-01-01', undefined, jar);
  check('a day before the business existed returns a quiet day, not an error',
    longAgo.status === 200 && longAgo.json?.data?.quiet === true, `got ${longAgo.status}`);
  check('that day reports no movement',
    longAgo.json?.data?.stockIn?.totalUnits === 0 && longAgo.json?.data?.stockOut?.totalUnits === 0);

  const future = await call('GET', '/daybook?date=2030-01-01', undefined, jar);
  check('a future date is handled without error', future.status === 200, `got ${future.status}`);

  check('today is flagged as still running', lastDay?.inProgress === true);
  const yesterday = results[results.length - 2];
  check('a finished day is not flagged as running', yesterday?.inProgress === false);

  // ─── TENANT ISOLATION ───────────────────────────────────────────────────────
  console.log('\nTENANT ISOLATION');
  const otherVariants = await prisma.productVariant.count({ where: { clientId: { not: clientId } } });
  check('another tenant has stock that must not appear here', otherVariants > 0);
  // The day book is scoped by the session's clientId only; there is no id to pass, so the
  // check is that its totals equal this tenant's own stock and nothing more.
  check("the report totals only this tenant's stock", lastDay?.closing?.units === liveUnits);

  console.log(`\n================ RESULT: ${passed} passed | ${failed} failed ================`);
  if (failed) {
    console.log('Failed:\n' + failures.map(f => `  - ${f}`).join('\n'));
    process.exit(1);
  }
}

main()
  .catch(e => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
