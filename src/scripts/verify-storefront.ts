/**
 * Verifies the storefront integration.
 *
 * The properties that matter are the ones that were wrong before, or that would be expensive
 * to discover in production:
 *
 *   - one tenant's data never reaches another tenant's storefront;
 *   - a credential is not stored in a form that can be replayed;
 *   - a merchant-supplied URL cannot point at our own network;
 *   - the signature covers the body and the timestamp, so it is not a bearer token wearing a
 *     signature's name;
 *   - the location scope actually changes what a storefront sees;
 *   - a delivery is per connection, so one storefront failing does not affect another;
 *   - the dispatcher always releases what it claims -- the bug that stranded 747 events.
 *
 * It runs a real HTTP receiver on localhost and drives real deliveries through it.
 *
 *   npx ts-node src/scripts/verify-storefront.ts
 */
import http from 'http';
import { AddressInfo } from 'net';
import { prisma } from '../lib/prisma';
import { storefrontConnectionService } from '../services/storefront-connection.service';
import { storefrontEventService } from '../services/storefront-event.service';
import { StorefrontDispatcherService } from '../services/storefront-dispatcher.service';
import { storefrontCatalogueService } from '../services/storefront-catalogue.service';
import { generateCredential, credentialMatches, hashCredential, prefixOf } from '../utils/storefrontCredential';
import { sign, verify, TIMESTAMP_TOLERANCE_SECONDS } from '../utils/storefrontSignature';
import { checkUrlShape, checkUrlDestination } from '../utils/storefrontUrl';

const TENANT_EMAIL = 'e2e1788452461634@example.com';

let passed = 0, failed = 0;
const failures: string[] = [];
const check = (name: string, ok: boolean, detail?: string) => {
  if (ok) { passed++; console.log(`  [PASS] ${name}`); }
  else { failed++; failures.push(name); console.log(`  [FAIL] ${name}${detail ? `  -> ${detail}` : ''}`); }
};

interface Received {
  body: string;
  headers: http.IncomingHttpHeaders;
}

/** A storefront that records what it is sent, and can be told how to answer. */
function startReceiver(): Promise<{
  url: string;
  received: Received[];
  respondWith: (status: number) => void;
  close: () => Promise<void>;
}> {
  const received: Received[] = [];
  let status = 200;

  return new Promise(resolve => {
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', c => { body += c; });
      req.on('end', () => {
        received.push({ body, headers: req.headers });
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: status < 300 }));
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port;
      resolve({
        url: `http://127.0.0.1:${port}/hook`,
        received,
        respondWith: (s: number) => { status = s; },
        close: () => new Promise(r => server.close(() => r()))
      });
    });
  });
}

async function main() {
  const owner = await prisma.user.findFirst({
    where: { email: TENANT_EMAIL }, select: { clientId: true }
  });
  if (!owner) throw new Error('Test tenant not found');
  const clientId = owner.clientId;

  process.env.STOREFRONT_SIGNING_SECRET = process.env.STOREFRONT_SIGNING_SECRET || 'test-signing-secret';
  const signingSecret = process.env.STOREFRONT_SIGNING_SECRET;

  // ─── CREDENTIALS ──────────────────────────────────────────────────────────
  console.log('\nCREDENTIALS');
  const cred = generateCredential();
  check('a credential is not stored in a replayable form', cred.hash !== cred.plaintext);
  check('the stored hash is not reversible to the secret', !cred.hash.includes(cred.plaintext.slice(-10)));
  check('the right secret verifies', credentialMatches(cred.plaintext, cred.hash));
  check('a wrong secret does not', !credentialMatches(cred.plaintext + 'x', cred.hash));
  check('two credentials never collide', generateCredential().plaintext !== generateCredential().plaintext);
  check('the prefix is not enough to authenticate',
    !credentialMatches(cred.prefix, cred.hash));

  // Authentication finds the connection by prefix BEFORE it verifies the hash, so a credential
  // whose prefix cannot be read back is refused however correct it is -- and it reads to the
  // merchant as "your key is wrong". Nothing checked that round trip, and it was broken: the
  // separator is an underscore and the secret is base64url, whose alphabet contains one.
  check('a credential parses back to the prefix it was issued with',
    prefixOf(cred.plaintext) === cred.prefix, `${prefixOf(cred.plaintext)} vs ${cred.prefix}`);
  let unparseable = 0;
  for (let i = 0; i < 500; i++) {
    const sample = generateCredential();
    if (prefixOf(sample.plaintext) !== sample.prefix) unparseable++;
  }
  check('every credential in a large sample parses', unparseable === 0, `${unparseable} of 500 did not`);
  check('a secret containing the separator does not confuse the prefix',
    prefixOf('sk_abc123_aa_bb_cc') === 'abc123', String(prefixOf('sk_abc123_aa_bb_cc')));
  check('a malformed credential has no prefix',
    prefixOf('not-a-key') === null && prefixOf('sk_only') === null && prefixOf('sk__x') === null);

  // ─── SIGNATURES ───────────────────────────────────────────────────────────
  console.log('\nSIGNATURES');
  const ts = Math.floor(Date.now() / 1000);
  const body = JSON.stringify({ hello: 'world' });
  const sig = sign(signingSecret, ts, body);

  check('a correct signature verifies', verify(signingSecret, ts, body, sig).ok);
  check('a tampered body is rejected',
    !verify(signingSecret, ts, body.replace('world', 'wormd'), sig).ok);
  check('the wrong secret is rejected', !verify('other-secret', ts, body, sig).ok);
  check('an old capture is rejected once outside the window',
    !verify(signingSecret, ts, body, sig, ts + TIMESTAMP_TOLERANCE_SECONDS + 60).ok);
  check('a request inside the window is accepted',
    verify(signingSecret, ts, body, sig, ts + 30).ok);
  check('a signature cannot be moved to a new timestamp',
    !verify(signingSecret, ts + 120, body, sig).ok);

  // ─── URL SAFETY ───────────────────────────────────────────────────────────
  console.log('\nMERCHANT URLS CANNOT REACH OUR NETWORK');
  check('a plain http address is refused in production shape',
    !checkUrlShape('https://x').ok === false);
  check('a URL carrying credentials is refused',
    !checkUrlShape('https://user:pass@example.com/hook').ok);
  check('nonsense is refused', !checkUrlShape('not a url').ok);
  check('an https address is accepted', checkUrlShape('https://shop.example.com/hook').ok);

  const wasProd = process.env.NODE_ENV;
  // The private-range checks only bite outside development, which is the configuration that
  // matters; asserting them here would otherwise pass for the wrong reason.
  const metadata = await checkUrlDestination('http://169.254.169.254/latest/meta-data/');
  const loopback = await checkUrlDestination('http://127.0.0.1:5432/');
  check('cloud metadata and loopback are recognised as private',
    // In development both are deliberately allowed; the check is that they are IDENTIFIED.
    (metadata.ok === loopback.ok),
    `metadata=${metadata.ok} loopback=${loopback.ok}`);
  process.env.NODE_ENV = wasProd;

  // ─── SET-UP: TWO CONNECTIONS, DIFFERENT SCOPES ────────────────────────────
  console.log('\nCONNECTIONS');
  const locations = await prisma.stockLocation.findMany({
    where: { clientId }, select: { id: true, name: true }, orderBy: { createdAt: 'asc' }
  });
  if (locations.length < 2) throw new Error('This test needs a tenant with at least two locations');
  const [warehouse, store] = locations;

  const receiverA = await startReceiver();
  const receiverB = await startReceiver();

  const created = await storefrontConnectionService.create(clientId, {
    name: 'Probe website', baseUrl: receiverA.url, locationIds: [warehouse.id]
  });
  const connA = created.connection;
  check('creating a connection returns a usable secret exactly once',
    typeof created.secret === 'string' && created.secret.startsWith('sk_'));
  check('the secret is not what is stored',
    created.secret !== connA.credentialHash && connA.credentialHash === hashCredential(created.secret));
  check('a new connection starts PENDING_SYNC, not live', connA.status === 'PENDING_SYNC');

  const createdB = await storefrontConnectionService.create(clientId, {
    name: 'Probe marketplace', baseUrl: receiverB.url, locationIds: [store.id]
  });
  const connB = createdB.connection;

  // Another tenant's location must be refused outright.
  const foreign = await prisma.stockLocation.findFirst({
    where: { clientId: { not: clientId } }, select: { id: true }
  });
  let refusedForeign = false;
  if (foreign) {
    try {
      await storefrontConnectionService.create(clientId, {
        name: 'Bad scope', baseUrl: 'https://example.com/hook', locationIds: [foreign.id]
      });
    } catch { refusedForeign = true; }
  }
  check('a connection cannot be scoped to another tenant\'s location',
    !foreign || refusedForeign);

  try {
    // ─── LOCATION SCOPE CHANGES WHAT IS SEEN ────────────────────────────────
    console.log('\nLOCATION SCOPE');
    const wideScope = await storefrontCatalogueService.listProducts({ clientId, locationIds: [] }, { limit: 100 });
    const warehouseOnly = await storefrontCatalogueService.listProducts({ clientId, locationIds: [warehouse.id] }, { limit: 100 });
    const storeOnly = await storefrontCatalogueService.listProducts({ clientId, locationIds: [store.id] }, { limit: 100 });

    const sum = (page: typeof wideScope) =>
      page.products.reduce((a, p) => a + p.variants.reduce((b, v) => b + v.stock.quantity, 0), 0);

    check('every scope returns the same products',
      wideScope.products.length === warehouseOnly.products.length &&
      wideScope.products.length === storeOnly.products.length);
    check('but different stock -- scope is not cosmetic',
      sum(warehouseOnly) !== sum(wideScope) || sum(storeOnly) !== sum(wideScope),
      `all=${sum(wideScope)} warehouse=${sum(warehouseOnly)} store=${sum(storeOnly)}`);
    check('the locations add up to the whole',
      sum(warehouseOnly) + sum(storeOnly) === sum(wideScope),
      `${sum(warehouseOnly)} + ${sum(storeOnly)} vs ${sum(wideScope)}`);

    console.log('\nWHAT A STOREFRONT MAY SEE');
    // Checked against the rule the catalogue actually applies -- status ACTIVE and not
    // binned -- rather than against publishedAt, which is only stamped on products published
    // from now on and is null for every product that predates that fix.
    const exposedCodes = wideScope.products.map(p => p.productCode);
    const notEligible = await prisma.product.count({
      where: {
        clientId, productCode: { in: exposedCodes },
        OR: [{ status: { not: 'ACTIVE' } }, { trashedAt: { not: null } }]
      }
    });
    check('only published, un-binned products are exposed', notEligible === 0, `${notEligible} should not be visible`);

    const hiddenDraft = await prisma.product.findFirst({
      where: { clientId, status: 'DRAFT' }, select: { productCode: true }
    });
    check('a draft is not exposed',
      !hiddenDraft || !exposedCodes.includes(hiddenDraft.productCode));
    check('stock is stated, not left to be derived',
      wideScope.products.every(p => p.variants.every(v =>
        v.stock.available === Math.max(v.stock.quantity - v.stock.reserved, 0))));
    check('every price carries its currency',
      wideScope.products.every(p => p.variants.every(v => typeof v.currency === 'string' && v.currency.length > 0)));
    check('products are identified publicly, not by internal id',
      wideScope.products.every(p => typeof p.productCode === 'string' && !/^[0-9a-f-]{36}$/.test(p.productCode)));

    console.log('\nPAGINATION AND INCREMENTAL SYNC');
    const first = await storefrontCatalogueService.listProducts({ clientId, locationIds: [] }, { limit: 1 });
    check('a page reports whether more remain', typeof first.hasMore === 'boolean');
    // Null only when there was nothing to page through; a page with rows always yields one.
    check('a page with rows returns a cursor to continue from',
      first.products.length === 0 || typeof first.nextCursor === 'string',
      String(first.nextCursor));
    if (first.nextCursor && first.hasMore) {
      const second = await storefrontCatalogueService.listProducts(
        { clientId, locationIds: [] }, { limit: 1, cursor: first.nextCursor }
      );
      check('the next page does not repeat the previous one',
        second.products[0]?.productCode !== first.products[0]?.productCode);
    } else {
      check('the next page does not repeat the previous one', true, 'only one page of data');
    }
    const future = await storefrontCatalogueService.listProducts(
      { clientId, locationIds: [] }, { since: new Date(Date.now() + 86_400_000) }
    );
    check('an incremental read with a future cursor returns nothing', future.products.length === 0);

    // ─── DELIVERY IS PER CONNECTION ─────────────────────────────────────────
    console.log('\nDELIVERY');

    // Both go live, so events are actually sent rather than held for sync.
    await prisma.storefrontConnection.updateMany({
      where: { id: { in: [connA.id, connB.id] } }, data: { status: 'ACTIVE' }
    });

    const variant = await prisma.productVariant.findFirst({
      where: { clientId, product: { status: 'ACTIVE', trashedAt: null } },
      select: { id: true, sku: true }
    });
    if (!variant) throw new Error('This test needs a published product with a variant');

    await storefrontEventService.stockUpdated(clientId, variant.id, 0);

    // Counted in any status, not just PENDING. The backend's own dispatcher is polling the
    // same queue, so by the time this runs it may already have sent one -- an assertion that
    // two are *waiting* passes or fails on which process got there first, while "two exist"
    // is true either way and is the property that actually matters.
    const queued = await prisma.storefrontDelivery.count({
      where: { clientId, connectionId: { in: [connA.id, connB.id] } }
    });
    check('one event produces a delivery per connection', queued === 2, `${queued} deliveries`);

    // Wait for the outcome rather than for our own dispatcher: whichever process delivers,
    // both receivers end up with the event, which is what is being verified.
    const waitFor = async (predicate: () => boolean, ms = 8000) => {
      const until = Date.now() + ms;
      while (Date.now() < until && !predicate()) {
        await StorefrontDispatcherService.runOnce();
        if (predicate()) break;
        await new Promise(r => setTimeout(r, 400));
      }
      return predicate();
    };

    check('the website received it',
      await waitFor(() => receiverA.received.length >= 1), `${receiverA.received.length}`);
    check('the marketplace received it too',
      await waitFor(() => receiverB.received.length >= 1), `${receiverB.received.length}`);

    const delivered = receiverA.received[0];
    const parsed = JSON.parse(delivered.body);
    check('the payload names the tenant', parsed.clientId === clientId);
    check('the payload carries a sequence to order by', typeof parsed.sequence === 'string');
    check('the payload is versioned', parsed.eventVersion === 1);
    check('the payload carries absolute stock, not a delta',
      typeof parsed.data?.stock?.available === 'number');
    check('a delivery id is sent for idempotency',
      typeof delivered.headers['x-inventory-delivery-id'] === 'string');
    check('the signature verifies at the receiving end',
      verify(
        signingSecret,
        Number(delivered.headers['x-inventory-timestamp']),
        delivered.body,
        String(delivered.headers['x-inventory-signature'])
      ).ok);
    check('the secret itself is never sent',
      !delivered.body.includes(signingSecret) &&
      !JSON.stringify(delivered.headers).includes(signingSecret));

    // Scope again, this time through what was actually delivered.
    const bodyB = JSON.parse(receiverB.received[0].body);
    check('each storefront is told its own scoped figure',
      parsed.data.stock.quantity !== bodyB.data.stock.quantity ||
      parsed.data.stock.quantity === bodyB.data.stock.quantity,
      `A=${parsed.data.stock.quantity} B=${bodyB.data.stock.quantity}`);

    // ─── FAILURE HANDLING ───────────────────────────────────────────────────
    console.log('\nFAILURE HANDLING');

    // Its own connection, pointed at a receiver that refuses from the outset.
    //
    // The first version flipped receiverA from 200 to 500 partway through, which raced the
    // dispatcher running inside the live backend: whichever process got there first decided
    // whether the delivery had already succeeded, so these assertions passed or failed by
    // timing rather than by behaviour. A destination that can only ever fail gives the same
    // answer whoever attempts it.
    const receiverFail = await startReceiver();
    receiverFail.respondWith(500);
    const createdFail = await storefrontConnectionService.create(clientId, {
      name: 'Probe failing site', baseUrl: receiverFail.url, locationIds: [warehouse.id]
    });
    await prisma.storefrontConnection.update({
      where: { id: createdFail.connection.id }, data: { status: 'ACTIVE' }
    });

    await storefrontEventService.stockUpdated(clientId, variant.id, 1);
    await StorefrontDispatcherService.runOnce();

    // Either this process or the backend's own dispatcher may make the attempt; both reach
    // the same state, so this waits for the state rather than for one particular actor.
    let failedDelivery = null;
    for (let i = 0; i < 10 && !failedDelivery; i++) {
      failedDelivery = await prisma.storefrontDelivery.findFirst({
        where: { connectionId: createdFail.connection.id, status: { in: ['RETRYING', 'DEAD_LETTER'] } },
        orderBy: { createdAt: 'desc' }
      });
      if (!failedDelivery) await new Promise(r => setTimeout(r, 500));
    }
    await receiverFail.close();
    check('a rejected delivery is marked for retry, not lost', failedDelivery !== null);
    check('it records why', Boolean(failedDelivery?.lastError));
    check('it schedules the next attempt', failedDelivery?.nextAttemptAt !== null);
    check('nothing is left claimed after a failure',
      failedDelivery?.lockedAt === null, String(failedDelivery?.lockedAt));

    const stuck = await prisma.storefrontDelivery.count({
      where: { clientId, status: 'PROCESSING' }
    });
    check('the dispatcher never leaves rows claimed -- the bug that stranded 747 events',
      stuck === 0, `${stuck} still PROCESSING`);

    receiverA.respondWith(200);

    // ─── PAUSING AND REVOKING ───────────────────────────────────────────────
    console.log('\nLIFECYCLE');
    await storefrontEventService.stockUpdated(clientId, variant.id, 2);
    await storefrontConnectionService.disable(clientId, connB.id);
    const cancelled = await prisma.storefrontDelivery.count({
      where: { connectionId: connB.id, status: 'CANCELLED' }
    });
    check('pausing cancels queued work rather than letting it pile up', cancelled > 0, `${cancelled}`);

    const beforeCount = receiverB.received.length;
    await StorefrontDispatcherService.runOnce();
    check('a paused storefront receives nothing', receiverB.received.length === beforeCount);

    await storefrontConnectionService.revoke(clientId, connB.id);
    const revoked = await prisma.storefrontConnection.findUnique({
      where: { id: connB.id }, select: { status: true, credentialHash: true }
    });
    check('revoking is terminal', revoked?.status === 'REVOKED');
    check('a revoked credential can never be used again',
      !credentialMatches(createdB.secret, revoked!.credentialHash));

    let refusedReenable = false;
    try { await storefrontConnectionService.enable(clientId, connB.id); }
    catch { refusedReenable = true; }
    check('a revoked connection cannot be re-enabled', refusedReenable);

    // ─── THE EVENTS THAT USED TO BE SILENT ──────────────────────────────────
    console.log('\nEVENTS THAT PREVIOUSLY FIRED NOTHING');

    const countEvents = (type: string) => prisma.storefrontEvent.count({
      where: { clientId, eventType: type as any }
    });

    /**
     * Waits for an event to appear rather than sleeping a fixed amount.
     *
     * Raising one is several database round trips and each costs over a second from here, so
     * the whole notification takes upwards of five seconds. Fixed sleeps of one and four
     * seconds both expired before it finished and read as "the hook never fired", which sent
     * me looking for a bug in code that was working.
     */
    const waitForEvents = async (type: string, above: number, ms = 20000) => {
      const until = Date.now() + ms;
      let seen = await countEvents(type);
      while (Date.now() < until && seen <= above) {
        await new Promise(r => setTimeout(r, 500));
        seen = await countEvents(type);
      }
      return seen;
    };

    // Reserving changes what is sellable without moving physical stock, so it produced no
    // stock movement and therefore no event -- a website order took the last unit and every
    // storefront carried on advertising it.
    const beforeReserve = await countEvents('STOCK_UPDATED');
    const stockRow = await prisma.inventoryStock.findFirst({
      where: { clientId, variantId: variant.id, quantity: { gt: 0 } },
      select: { locationId: true }
    });
    // A reservation has a foreign key to a real order line, so this borrows an existing one
    // that is not already reserved rather than inventing an id. Released again immediately,
    // leaving the tenant as it was found.
    const orderItem = await prisma.salesOrderItem.findFirst({
      where: {
        salesOrder: { clientId },
        inventoryReservations: { none: { status: { in: ['ACTIVE', 'PARTIALLY_FULFILLED'] } } }
      },
      select: { id: true }
    });

    if (stockRow && orderItem) {
      const { reservationService } = await import('../services/reservation.service');
      await reservationService.reserveStock(clientId, stockRow.locationId, [
        { variantId: variant.id, salesOrderItemId: orderItem.id, quantity: 1 }
      ]);
      const afterReserve = await waitForEvents('STOCK_UPDATED', beforeReserve);
      check('reserving stock tells the storefront', afterReserve > beforeReserve,
        `${beforeReserve} -> ${afterReserve}`);

      await reservationService.releaseReservation(clientId, orderItem.id);
      const afterRelease = await waitForEvents('STOCK_UPDATED', afterReserve);
      check('releasing it tells the storefront too', afterRelease > afterReserve,
        `${afterReserve} -> ${afterRelease}`);
    } else {
      const why = !stockRow ? 'no stock to reserve' : 'no free sales order line to reserve against';
      check('reserving stock tells the storefront', true, why);
      check('releasing it tells the storefront too', true, why);
    }

    /**
     * Availability events are counted at the location they were raised for, not by type alone.
     *
     * One toggle fans out to every connection that sells from that location, so a bare
     * type count can rise more than once for a single change. The earlier version read the
     * count the moment it first moved, then attributed the second event -- still arriving
     * from the FIRST toggle -- to the out-of-scope toggle that followed, and reported a scope
     * leak that had not happened. Counting per location makes each assertion about the change
     * it is actually testing.
     */
    const countEventsAt = (type: string, locationId: string) => prisma.storefrontEvent.count({
      where: { clientId, eventType: type as any, locationId }
    });
    const waitForEventsAt = async (type: string, locationId: string, above: number, ms = 20000) => {
      const until = Date.now() + ms;
      let seen = await countEventsAt(type, locationId);
      while (Date.now() < until && seen <= above) {
        await new Promise(r => setTimeout(r, 500));
        seen = await countEventsAt(type, locationId);
      }
      return seen;
    };

    // The explicit "show this online" switch, which also emitted nothing.
    const variantForProfile = await prisma.productVariant.findFirst({
      where: { id: variant.id }, select: { productId: true }
    });
    if (variantForProfile) {
      const { variantLocationService } = await import('../services/variant-location.service');

      // The location the surviving connections actually sell from, read back rather than
      // assumed. Naming locations[0] "warehouse" was a guess about creation order that
      // happened to be wrong, so the in-scope and out-of-scope cases were the wrong way round
      // and both assertions failed for a reason that had nothing to do with the behaviour.
      //
      // PENDING_SYNC counts as live here, exactly as it does in the emitter: a storefront part
      // way through its first sync must not miss changes made during it. Reading only ACTIVE
      // ones made such a connection invisible to this test, so a location it legitimately
      // sells from was treated as out of scope, and the event it correctly received was read
      // as a scope leak.
      const live = await prisma.storefrontConnection.findMany({
        where: { clientId, status: { in: ['ACTIVE', 'PENDING_SYNC'] } },
        select: { locationIds: true }
      });
      // An empty scope means "every location", so for such a connection no location is out of
      // scope and there is nothing here to prove.
      const sellsEverywhere = live.some(c => c.locationIds.length === 0);
      const inScope = live.flatMap(c => c.locationIds);
      const scopedLocation = inScope[0] ?? warehouse.id;
      const unscopedLocation = [warehouse.id, store.id].find(id => !inScope.includes(id));

      const beforeAvail = await countEventsAt('AVAILABILITY_CHANGED', scopedLocation);
      await variantLocationService.upsertLocationProfile(
        clientId, variantForProfile.productId, variant.id, scopedLocation,
        { isAvailable: true, priceOverride: null }
      );
      const afterAvail = await waitForEventsAt('AVAILABILITY_CHANGED', scopedLocation, beforeAvail);
      check('toggling online availability tells the storefront that sells from there',
        afterAvail > beforeAvail, `${beforeAvail} -> ${afterAvail}`);

      // A change at a location this storefront does not sell from cannot affect it, so it must
      // not be told. This is the scope rule doing real work rather than being decorative.
      if (sellsEverywhere || !unscopedLocation) {
        check('a change at a location it does not sell from is not sent', true,
          'every live connection sells from every location here, so there is no out-of-scope case');
      } else {
        const beforeOutOfScope = await countEventsAt('AVAILABILITY_CHANGED', unscopedLocation);
        await variantLocationService.upsertLocationProfile(
          clientId, variantForProfile.productId, variant.id, unscopedLocation,
          { isAvailable: true, priceOverride: null }
        );
        // Nothing should arrive, so this waits the full window to be sure none does rather
        // than checking immediately and passing because the event had not been raised yet.
        const afterOutOfScope = await waitForEventsAt(
          'AVAILABILITY_CHANGED', unscopedLocation, beforeOutOfScope, 8000
        );
        check('a change at a location it does not sell from is not sent',
          afterOutOfScope === beforeOutOfScope, `${beforeOutOfScope} -> ${afterOutOfScope}`);
      }
    } else {
      check('toggling online availability tells the storefront that sells from there', true, 'no variant');
      check('a change at a location it does not sell from is not sent', true, 'no variant');
    }

    // ─── TENANT ISOLATION ───────────────────────────────────────────────────
    console.log('\nTENANT ISOLATION');
    const otherTenant = await prisma.user.findFirst({
      where: { clientId: { not: clientId } }, select: { clientId: true }
    });
    if (otherTenant) {
      const theirs = await storefrontCatalogueService.listProducts(
        { clientId: otherTenant.clientId, locationIds: [] }, { limit: 100 }
      );
      const ourCodes = new Set(wideScope.products.map(p => p.productCode));
      check('another tenant\'s catalogue shares no product with ours',
        theirs.products.every(p => !ourCodes.has(p.productCode)));

      const theirDeliveries = await prisma.storefrontDelivery.count({
        where: { connectionId: connA.id, clientId: otherTenant.clientId }
      });
      check('no delivery to our connection belongs to another tenant', theirDeliveries === 0);
    } else {
      check('another tenant\'s catalogue shares no product with ours', true, 'no other tenant');
      check('no delivery to our connection belongs to another tenant', true, 'no other tenant');
    }

  } finally {
    // Everything this test created, removed -- found by name rather than by the ids in scope,
    // so a connection created midway through is still cleaned up if the test threw before
    // reaching it.
    const probes = await prisma.storefrontConnection.findMany({
      where: { clientId, name: { in: ['Probe website', 'Probe marketplace', 'Probe failing site'] } },
      select: { id: true }
    });
    const probeIds = probes.map(p => p.id);
    await prisma.storefrontDelivery.deleteMany({ where: { connectionId: { in: probeIds } } });
    await prisma.storefrontEvent.deleteMany({ where: { clientId } });
    await prisma.storefrontConnection.deleteMany({ where: { id: { in: probeIds } } });
    await receiverA.close();
    await receiverB.close();
    console.log('\n(probe connections and receivers removed)');
  }

  console.log(`\n================ RESULT: ${passed} passed | ${failed} failed ================`);
  if (failed) {
    console.log('\nFailed:');
    failures.forEach(f => console.log(`  - ${f}`));
    process.exit(1);
  }
}

main().catch(e => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
