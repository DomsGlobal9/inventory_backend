/**
 * Inventory's side of WhatsApp, against a FAKE WhatsApp Service started inside this script.
 * Nothing here sends a real message.
 *
 *   A  sending a document: the recipient comes from the shop's own records (supplier, customer),
 *      never from the request; the right service kind, text, file and idempotency key; one row per
 *      press; the same press twice is one message.
 *   B  refused, in words: no permission, another shop's id, a cancelled order, an online order's
 *      "bill", an unfinished return, no phone / a bad phone, not a PDF, a PDF over 5 MB, no send id.
 *   C  linking: only whatsapp:manage (owner, admin with team rights); code needs a valid number.
 *   D  ticks from the service: signature checked; each event handled once; out of order never goes
 *      backwards; a finished message stays finished; a purchase order becomes SENT only when
 *      WhatsApp has it, and only from DRAFT.
 *   E  the nightly Day Book: owner only; time and number checked; sent once per night after the
 *      chosen time and never before; a failure hands the night back; a real PDF; "send now" has
 *      its own key; the shop's time zone decides the day.
 *   F  the service down or refusing: a plain sentence, nothing recorded as sent.
 *   G  the shop's WhatsApp dropping: the owner is told on WhatsApp at the Day Book number.
 *
 *   npx ts-node --transpile-only src/scripts/verify-whatsapp.ts
 */
import http from 'http';
import crypto from 'crypto';

// The fake service, and the settings that point this process at it -- before any app module loads.
const STUB_PORT = 18099;
process.env.WHATSAPP_SERVICE_URL = `http://127.0.0.1:${STUB_PORT}`;
process.env.WHATSAPP_SERVICE_KEY = 'verify-stub-key-0123456789';
process.env.WHATSAPP_WEBHOOK_SECRET = 'verify-stub-secret-0123456789';

type StubReq = { method: string; path: string; body: any; key: string | undefined };
const seen: StubReq[] = [];
let mode: 'ok' | 'down' | 'unreachable' | 'notLinked' | 'optedOut' = 'ok';
const ids = new Map<string, string>();

const stub = http.createServer((req, res) => {
  let raw = '';
  req.on('data', c => { raw += c; });
  req.on('end', () => {
    const body = raw ? JSON.parse(raw) : undefined;
    seen.push({ method: req.method!, path: req.url!, body, key: req.headers['x-module-key'] as string | undefined });
    const send = (status: number, json: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(json)); };
    if (mode === 'unreachable') { req.socket.destroy(); return; }
    // Refusals in the real service's own shape: { error: { code, message } }.
    if (mode === 'down') return send(503, { error: { code: 'engine_unavailable', message: 'The WhatsApp engine is not responding. Please try again in a minute.' } });
    if (mode === 'notLinked' && req.url === '/v1/messages') return send(409, { error: { code: 'not_linked', message: "This shop's WhatsApp is not linked. Link it in Settings > WhatsApp." } });
    if (mode === 'optedOut' && req.url === '/v1/messages') return send(403, { error: { code: 'forbidden', message: 'This person replied STOP, so WhatsApp messages are not sent to them from this number.' } });
    if (req.url === '/v1/messages' && req.method === 'POST') {
      const existing = ids.get(body.idempotencyKey);
      const id = existing ?? crypto.randomUUID();
      ids.set(body.idempotencyKey, id);
      return send(202, { id, status: 'QUEUED', ...(existing ? { duplicate: true } : {}) });
    }
    if (/\/link$/.test(req.url!)) return send(200, body?.method === 'code' ? { status: 'LINKING', pairingCode: 'ABCD-EFGH' } : { status: 'LINKING', qr: 'data:image/png;base64,iVBORw0KGgo=' });
    if (/\/disconnect$/.test(req.url!)) return send(200, { status: 'LOGGED_OUT', phone: null, linkedAt: null, lastSeenAt: null });
    if (req.url!.startsWith('/v1/accounts/client/')) return send(200, { status: 'CONNECTED', phone: '••••4642', linkedAt: new Date().toISOString(), lastSeenAt: null });
    send(404, { message: 'No such route.' });
  });
});

let passed = 0, failed = 0;
const failures: string[] = [];
const check = (name: string, ok: boolean, detail?: unknown) => {
  if (ok) { passed++; console.log(`  [PASS] ${name}`); }
  else { failed++; failures.push(name); console.log(`  [FAIL] ${name}${detail !== undefined ? `  -> ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`); }
};
const said = async (p: Promise<unknown>) => {
  try { await p; return { ok: true as const, status: 200, message: '' }; }
  catch (e: any) { return { ok: false as const, status: e?.statusCode ?? 500, message: String(e?.message ?? e) }; }
};
const plain = (m: string) => /[a-z]{3}/i.test(m) && !/undefined|null|Error:|stack|at \w+ \(/.test(m);

const STAMP = Date.now();
const SHOP = `verify-wa-${STAMP}`;
const OTHER = `verify-wa-other-${STAMP}`;

// A real, small PDF: the shape the browser sends.
const PDF = Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n').toString('base64');
const nonce = () => crypto.randomUUID();

async function main() {
  await new Promise<void>(r => stub.listen(STUB_PORT, '127.0.0.1', () => r()));
  const { prisma } = require('../lib/prisma');
  const { seedRolesForClient, RBAC_DATA } = require('../services/rbac-seed.service');
  const { platformAdminService } = require('../services/platform-admin.service');
  const { COUNTER_SOURCE } = require('../services/counter-sale/counter-sale.service');
  const wa = require('../services/whatsapp/service');

  try {
    console.log('SETUP: a shop with a supplier, orders, a counter sale and returns; and another shop');
    await seedRolesForClient(SHOP);
    await prisma.clientSettings.upsert({ where: { clientId: SHOP }, create: { clientId: SHOP, businessName: 'Lakshmi Silks', timezone: 'Asia/Kolkata' }, update: {} });
    const store = await prisma.stockLocation.create({ data: { clientId: SHOP, code: 'MAIN', name: 'Main Store', type: 'STORE', active: true } });
    const supplier = await prisma.supplier.create({ data: { clientId: SHOP, supplierCode: `SUP-W-${STAMP}`, name: 'Kanchi Weavers', phone: '98480 22338' } });
    const noPhone = await prisma.supplier.create({ data: { clientId: SHOP, supplierCode: `SUP-N-${STAMP}`, name: 'Silent Mills' } });
    const badPhone = await prisma.supplier.create({ data: { clientId: SHOP, supplierCode: `SUP-B-${STAMP}`, name: 'Odd Number Co', phone: '12345' } });
    const po = await prisma.purchaseOrder.create({ data: { clientId: SHOP, poNumber: `PO-W-${STAMP}`, supplierId: supplier.id, locationId: store.id, status: 'DRAFT' } });
    const poNoPhone = await prisma.purchaseOrder.create({ data: { clientId: SHOP, poNumber: `PO-N-${STAMP}`, supplierId: noPhone.id, locationId: store.id } });
    const poBadPhone = await prisma.purchaseOrder.create({ data: { clientId: SHOP, poNumber: `PO-B-${STAMP}`, supplierId: badPhone.id, locationId: store.id } });
    const poCancelled = await prisma.purchaseOrder.create({ data: { clientId: SHOP, poNumber: `PO-C-${STAMP}`, supplierId: supplier.id, locationId: store.id, status: 'CANCELLED' } });
    const grn = await prisma.purchaseReceipt.create({ data: { clientId: SHOP, receiptNumber: `GRN-W-${STAMP}`, poId: po.id, locationId: store.id } });
    const customer = await prisma.customer.create({ data: { clientId: SHOP, customerCode: `CUS-W-${STAMP}`, name: 'Farah Khan', phone: '+91 97000 11122' } });
    const sale = await prisma.salesOrder.create({ data: { clientId: SHOP, orderNumber: `SO-W-${STAMP}`, customerId: customer.id, locationId: store.id, sourceSystem: COUNTER_SOURCE, status: 'DISPATCHED' } });
    const online = await prisma.salesOrder.create({ data: { clientId: SHOP, orderNumber: `SO-O-${STAMP}`, customerId: customer.id, locationId: store.id, sourceSystem: 'SHOPIFY' } });
    const doneReturn = await prisma.salesReturn.create({ data: { clientId: SHOP, returnNumber: `RTN-W-${STAMP}`, salesOrderId: sale.id, reason: 'DEFECTIVE', status: 'COMPLETED' } });
    const openReturn = await prisma.salesReturn.create({ data: { clientId: SHOP, returnNumber: `RTN-O-${STAMP}`, salesOrderId: sale.id, reason: 'DEFECTIVE', status: 'REQUESTED' } });

    await seedRolesForClient(OTHER);
    const otherStore = await prisma.stockLocation.create({ data: { clientId: OTHER, code: 'MAIN', name: 'Other Store', type: 'STORE', active: true } });
    const otherSupplier = await prisma.supplier.create({ data: { clientId: OTHER, supplierCode: `SUP-X-${STAMP}`, name: 'Their Supplier', phone: '9848011111' } });
    const otherPo = await prisma.purchaseOrder.create({ data: { clientId: OTHER, poNumber: `PO-X-${STAMP}`, supplierId: otherSupplier.id, locationId: otherStore.id } });

    const roleActor = (name: string, role: string) => ({ id: crypto.randomUUID(), clientId: SHOP, name, roles: [role], permissions: RBAC_DATA.roles[role].permissions });
    const owner = { id: crypto.randomUUID(), clientId: SHOP, name: 'Lakshmi Owner', roles: ['SUPER_ADMIN'], permissions: ['*'] };
    const admin = roleActor('Asha Admin', 'ADMIN');
    const sales = roleActor('Anjali Sales', 'SALES');
    const warehouse = roleActor('Ravi Stockroom', 'WAREHOUSE');
    const manager = roleActor('Kiran Manager', 'INVENTORY_MANAGER');

    console.log('\nA. SENDING A DOCUMENT');
    seen.length = 0;
    const press = nonce();
    const r1 = await wa.sendDocument(owner, { kind: 'PURCHASE_ORDER', id: po.id, pdfBase64: PDF, fileName: `${po.poNumber}.pdf`, nonce: press });
    const call1 = seen.find(s => s.path === '/v1/messages');
    check('the owner sends the purchase order', r1?.status === 'QUEUED', r1);
    check('it goes to the supplier on file, as digits with the country code', call1?.body?.to === '919848022338', call1?.body?.to);
    check('from this shop\'s own number', call1?.body?.from?.clientId === SHOP, call1?.body?.from);
    check('as kind C1, with the PDF and a plain message naming the order', call1?.body?.kind === 'C1' && call1?.body?.document?.mimeType === 'application/pdf'
      && call1?.body?.document?.fileName === `${po.poNumber}.pdf` && call1?.body?.text?.includes(po.poNumber) && call1?.body?.text?.includes('Lakshmi Silks'), call1?.body?.text);
    check('with the module key and an idempotency key made of document and press', call1?.key === process.env.WHATSAPP_SERVICE_KEY && call1?.body?.idempotencyKey === `PURCHASE_ORDER:${po.id}:${press}`);
    check('the screen is told who it went to, never the full number', r1.recipientName === 'Kanchi Weavers' && r1.to === '••••2338', r1);
    const again = await wa.sendDocument(owner, { kind: 'PURCHASE_ORDER', id: po.id, pdfBase64: PDF, nonce: press });
    const rows = await prisma.whatsAppMessage.count({ where: { clientId: SHOP, kind: 'PURCHASE_ORDER', referenceId: po.id } });
    check('the same press sent twice is one message and one row', again.id === r1.id && rows === 1, { rows });
    const smuggle = await wa.sendDocument(owner, { kind: 'PURCHASE_ORDER', id: po.id, pdfBase64: PDF, nonce: nonce(), to: '919999999999' } as any);
    check('a "to" put in the request is ignored: still the supplier on file', seen.filter(s => s.path === '/v1/messages').at(-1)?.body?.to === '919848022338', smuggle);

    const g = await wa.sendDocument(warehouse, { kind: 'GOODS_RECEIPT', id: grn.id, pdfBase64: PDF, nonce: nonce() });
    const gc = seen.filter(s => s.path === '/v1/messages').at(-1)?.body;
    check('the stock room sends the goods receipt to the supplier, kind C3', g?.status === 'QUEUED' && gc?.to === '919848022338' && gc?.kind === 'C3' && gc?.text?.includes(grn.receiptNumber), gc);
    const b = await wa.sendDocument(sales, { kind: 'BILL', id: sale.id, pdfBase64: PDF, nonce: nonce() });
    const bc = seen.filter(s => s.path === '/v1/messages').at(-1)?.body;
    check('a salesperson sends the bill to the customer, kind C2', b?.status === 'QUEUED' && bc?.to === '919700011122' && bc?.kind === 'C2' && bc?.text?.includes('Farah Khan'), bc);
    const rn = await wa.sendDocument(owner, { kind: 'RETURN_NOTE', id: doneReturn.id, pdfBase64: PDF, nonce: nonce() });
    const rc = seen.filter(s => s.path === '/v1/messages').at(-1)?.body;
    check('the return note goes to the customer, kind C5', rn?.status === 'QUEUED' && rc?.to === '919700011122' && rc?.kind === 'C5', rc);
    const latest = await wa.latestFor(owner, 'PURCHASE_ORDER', po.id);
    check('the Send button can read where the latest one has got to', latest?.status === 'QUEUED' && latest?.to === '••••2338', latest);
    check('another shop reading this order\'s status gets nothing', (await wa.latestFor({ ...owner, clientId: OTHER }, 'PURCHASE_ORDER', po.id)) === null);

    console.log('\nB. REFUSED, IN WORDS');
    const cases: [string, () => Promise<unknown>, number, RegExp][] = [
      ['a salesperson may not send a purchase order', () => wa.sendDocument(sales, { kind: 'PURCHASE_ORDER', id: po.id, pdfBase64: PDF, nonce: nonce() }), 403, /permission/],
      ['another shop\'s purchase order is "not found"', () => wa.sendDocument(owner, { kind: 'PURCHASE_ORDER', id: otherPo.id, pdfBase64: PDF, nonce: nonce() }), 404, /not found/],
      ['a cancelled purchase order is not sent', () => wa.sendDocument(owner, { kind: 'PURCHASE_ORDER', id: poCancelled.id, pdfBase64: PDF, nonce: nonce() }), 409, /cancelled/],
      ['a supplier with no phone: say so', () => wa.sendDocument(owner, { kind: 'PURCHASE_ORDER', id: poNoPhone.id, pdfBase64: PDF, nonce: nonce() }), 400, /Silent Mills has no phone number/],
      ['a supplier with a bad phone: say why', () => wa.sendDocument(owner, { kind: 'PURCHASE_ORDER', id: poBadPhone.id, pdfBase64: PDF, nonce: nonce() }), 400, /Odd Number Co's phone number cannot be used/],
      ['an online order has no bill', () => wa.sendDocument(owner, { kind: 'BILL', id: online.id, pdfBase64: PDF, nonce: nonce() }), 409, /counter/],
      ['an unfinished return has no note yet', () => wa.sendDocument(owner, { kind: 'RETURN_NOTE', id: openReturn.id, pdfBase64: PDF, nonce: nonce() }), 409, /not finished/],
      ['a file that is not a PDF', () => wa.sendDocument(owner, { kind: 'PURCHASE_ORDER', id: po.id, pdfBase64: Buffer.from('hello there').toString('base64'), nonce: nonce() }), 400, /not a PDF/],
      ['a PDF over 5 MB', () => wa.sendDocument(owner, { kind: 'PURCHASE_ORDER', id: po.id, pdfBase64: Buffer.concat([Buffer.from('%PDF-'), Buffer.alloc(5 * 1024 * 1024 + 10)]).toString('base64'), nonce: nonce() }), 413, /5 MB/],
      ['a request without its send id', () => wa.sendDocument(owner, { kind: 'PURCHASE_ORDER', id: po.id, pdfBase64: PDF, nonce: '' }), 400, /send id/],
      ['a kind of document that does not exist', () => wa.sendDocument(owner, { kind: 'INVOICE', id: po.id, pdfBase64: PDF, nonce: nonce() }), 400, /cannot be sent/],
      ['a missing document id', () => wa.sendDocument(owner, { kind: 'BILL', id: 'x', pdfBase64: PDF, nonce: nonce() }), 400, /missing/]
    ];
    const before = seen.filter(s => s.path === '/v1/messages').length;
    for (const [name, run, status, re] of cases) {
      const r = await said(run());
      check(`${name} (${status})`, !r.ok && r.status === status && re.test(r.message) && plain(r.message), r);
    }
    check('none of those reached WhatsApp', seen.filter(s => s.path === '/v1/messages').length === before);

    console.log('\nC. LINKING');
    const l1 = await wa.link(owner, 'qr');
    check('the owner starts linking and gets a QR', l1?.status === 'LINKING' && /^data:image/.test(l1?.qr), l1);
    const l2 = await wa.link(admin, 'code', '98480 22338');
    const lc = seen.filter(s => /\/link$/.test(s.path)).at(-1)?.body;
    check('an admin with team rights links with a code, number sent as digits', l2?.pairingCode === 'ABCD-EFGH' && lc?.phone === '919848022338', lc);
    for (const who of [sales, warehouse, manager]) {
      const r = await said(wa.link(who, 'qr'));
      check(`${who.name.split(' ')[1].toLowerCase()} may not link the shop's WhatsApp`, !r.ok && r.status === 403 && plain(r.message), r);
    }
    const noNumber = await said(wa.link(owner, 'code', ''));
    check('a code without a number says so', !noNumber.ok && noNumber.status === 400 && /phone/i.test(noNumber.message), noNumber);
    const weird = await said(wa.link(owner, 'fax'));
    check('an unknown way of linking says so', !weird.ok && weird.status === 400, weird);
    const test = await wa.sendTest(owner, '+91 81424 24642', nonce());
    const tc = seen.filter(s => s.path === '/v1/messages').at(-1)?.body;
    check('a test message goes from the shop\'s number to the number typed', test?.status === 'QUEUED' && tc?.from?.clientId === SHOP && tc?.to === '918142424642' && tc?.kind === 'TEST', tc);
    const ov = await wa.getOverview(owner);
    check('the owner\'s overview: configured, linked, may manage, sees the Day Book choice', ov.configured && ov.account?.status === 'CONNECTED' && ov.canManage && ov.isOwner && ov.dayBook?.time === '22:00', ov);
    const ovSales = await wa.getOverview(sales);
    check('a salesperson\'s overview: may not manage, no Day Book choice', ovSales.canManage === false && ovSales.dayBook === null, ovSales);

    console.log('\nD. TICKS FROM THE SERVICE');
    const body = Buffer.from(JSON.stringify({ id: 'x', type: 'message.status', data: {} }));
    const sig = `sha256=${crypto.createHmac('sha256', process.env.WHATSAPP_WEBHOOK_SECRET!).update(body).digest('hex')}`;
    check('a correct signature is accepted', wa.verifySignature(body, sig));
    check('a wrong or missing signature is not', !wa.verifySignature(body, sig.replace(/.$/, '0')) && !wa.verifySignature(body, undefined) && !wa.verifySignature(Buffer.from('{}'), sig));

    const ev = (type: string, data: any) => ({ id: crypto.randomUUID(), type, occurredAt: new Date().toISOString(), data });
    const msgId = ids.get(`PURCHASE_ORDER:${po.id}:${press}`)!;
    const sent = ev('message.status', { messageId: msgId, status: 'SENT' });
    await wa.handleEvent(sent);
    const afterSent = await prisma.whatsAppMessage.findUnique({ where: { serviceMessageId: msgId } });
    const poNow = await prisma.purchaseOrder.findUnique({ where: { id: po.id } });
    check('SENT is recorded, and the draft purchase order becomes SENT', afterSent?.status === 'SENT' && poNow?.status === 'SENT', { msg: afterSent?.status, po: poNow?.status });
    const dup = await wa.handleEvent(sent);
    check('the same event twice is handled once', dup.duplicate === true);
    await wa.handleEvent(ev('message.status', { messageId: msgId, status: 'READ' }));
    await wa.handleEvent(ev('message.status', { messageId: msgId, status: 'DELIVERED' }));
    check('DELIVERED arriving after READ does not go backwards', (await prisma.whatsAppMessage.findUnique({ where: { serviceMessageId: msgId } }))?.status === 'READ');
    await wa.handleEvent(ev('message.status', { messageId: msgId, status: 'FAILED', failReason: 'x' }));
    check('a READ message stays READ', (await prisma.whatsAppMessage.findUnique({ where: { serviceMessageId: msgId } }))?.status === 'READ');
    const billId = ids.get([...ids.keys()].find(k => k.startsWith(`BILL:${sale.id}`))!)!;
    await wa.handleEvent(ev('message.status', { messageId: billId, status: 'FAILED', failReason: 'This number is not on WhatsApp.' }));
    await wa.handleEvent(ev('message.status', { messageId: billId, status: 'DELIVERED' }));
    const billRow = await prisma.whatsAppMessage.findUnique({ where: { serviceMessageId: billId } });
    check('a FAILED message keeps its reason and stays FAILED', billRow?.status === 'FAILED' && billRow?.failReason === 'This number is not on WhatsApp.', billRow);
    await prisma.purchaseOrder.update({ where: { id: po.id }, data: { status: 'PARTIALLY_RECEIVED' } });
    const po2Press = nonce();
    await wa.sendDocument(owner, { kind: 'PURCHASE_ORDER', id: po.id, pdfBase64: PDF, nonce: po2Press });
    await wa.handleEvent(ev('message.status', { messageId: ids.get(`PURCHASE_ORDER:${po.id}:${po2Press}`), status: 'DELIVERED' }));
    check('re-sending a part-received order does not roll it back to SENT', (await prisma.purchaseOrder.findUnique({ where: { id: po.id } }))?.status === 'PARTIALLY_RECEIVED');
    const unknown = await wa.handleEvent(ev('message.status', { messageId: crypto.randomUUID(), status: 'SENT' }));
    check('a tick for a message this app never sent changes nothing', unknown.handled === false);
    const junk = await wa.handleEvent({ id: 5, type: null } as any);
    check('a malformed event is ignored', junk.handled === false);

    console.log('\nE. THE NIGHTLY DAY BOOK');
    const notOwner = await said(wa.saveDayBookSettings(admin, { enabled: true, time: '22:00', to: '8142424642' }));
    check('only the owner chooses it (an admin is refused)', !notOwner.ok && notOwner.status === 403 && /owner/.test(notOwner.message), notOwner);
    for (const [t, why] of [['25:00', 'an hour past 23'], ['10pm', 'words'], ['', 'blank']]) {
      const r = await said(wa.saveDayBookSettings(owner, { enabled: true, time: t, to: '8142424642' }));
      check(`a time of "${t}" (${why}) is refused`, !r.ok && r.status === 400 && /22:00/.test(r.message), r);
    }
    const noTo = await said(wa.saveDayBookSettings(owner, { enabled: true, time: '22:00', to: '' }));
    check('switching it on without a number says so', !noTo.ok && /number/.test(noTo.message), noTo);
    const off = await wa.saveDayBookSettings(owner, { enabled: false, time: '22:00', to: '' });
    check('it can be left off with no number', off.enabled === false && off.to === null, off);
    const on = await wa.saveDayBookSettings(owner, { enabled: true, time: '22:00', to: '81424 24642' });
    check('the owner switches it on for 22:00 at their number', on.enabled && on.time === '22:00' && on.to === '+918142424642', on);

    // The shop's clock decides: 21:59 IST is before, 22:05 IST after (IST = UTC+5:30).
    const istDay = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
    const at = (hhmm: string) => new Date(`${istDay}T${hhmm}:00+05:30`);
    const dayBookSends = () => seen.filter(s => s.path === '/v1/messages' && s.body?.kind === 'S6');
    const n0 = dayBookSends().length;
    await wa.runDayBookTick(at('21:59'), { onlyClients: [SHOP] });
    check('before 22:00 in the shop\'s time zone, nothing is sent', dayBookSends().length === n0);
    // (runDayBookTick reads "today" from the real clock; these checks only run on the same IST day.)
    await wa.runDayBookTick(at('22:05'), { onlyClients: [SHOP] });
    const first = dayBookSends().at(-1)?.body;
    check('after 22:00 the Day Book goes, from the ScaleEzy number, to the owner', dayBookSends().length === n0 + 1 && first?.from === 'scaleezy' && first?.to === '918142424642', first);
    check('it carries a real Day Book PDF', Buffer.from(first?.document?.base64 ?? '', 'base64').subarray(0, 5).toString() === '%PDF-' && first?.document?.fileName === `day-book-${istDay}.pdf`);
    check('its key is the shop and the day', first?.idempotencyKey === `DAY_BOOK:${SHOP}:${istDay}`, first?.idempotencyKey);
    await wa.runDayBookTick(at('22:10'), { onlyClients: [SHOP] });
    await Promise.all([wa.runDayBookTick(at('22:15'), { onlyClients: [SHOP] }), wa.runDayBookTick(at('22:15'), { onlyClients: [SHOP] })]);
    check('later ticks, even two at once, send nothing more that night', dayBookSends().length === n0 + 1);

    await prisma.whatsAppSettings.update({ where: { clientId: SHOP }, data: { dayBookLastSentFor: null } });
    mode = 'down';
    const n1 = dayBookSends().length;
    const down = await wa.runDayBookTick(at('22:20'), { onlyClients: [SHOP] });
    const s1 = await prisma.whatsAppSettings.findUnique({ where: { clientId: SHOP } });
    check('with the service down, the night is handed back for the next tick', down.failed >= 1 && s1?.dayBookLastSentFor === null, { down, last: s1?.dayBookLastSentFor });
    mode = 'ok';
    await wa.runDayBookTick(at('22:25'), { onlyClients: [SHOP] });
    check('and the next tick sends it', dayBookSends().length === n1 + 2 /* the failed attempt reached the stub too */ || dayBookSends().length === n1 + 1);
    const now1 = await wa.sendDayBookNow(owner, nonce());
    const nowCall = dayBookSends().at(-1)?.body;
    check('"send it now" sends with its own key, never standing in for tonight\'s', now1.to === '••••4642' && nowCall?.idempotencyKey?.startsWith(`DAY_BOOK_NOW:${SHOP}:`), nowCall?.idempotencyKey);
    const nowAdmin = await said(wa.sendDayBookNow(admin, nonce()));
    check('only the owner can have it sent now', !nowAdmin.ok && nowAdmin.status === 403, nowAdmin);
    await wa.saveDayBookSettings(owner, { enabled: false, time: '22:00', to: '8142424642' });
    await prisma.whatsAppSettings.update({ where: { clientId: SHOP }, data: { dayBookLastSentFor: null } });
    const n2 = dayBookSends().length;
    await wa.runDayBookTick(at('22:30'), { onlyClients: [SHOP] });
    check('switched off, nothing is sent', dayBookSends().length === n2);

    console.log('\nE2. THE DAY BOOK PAGE: SEND ANY DAY, OR A RANGE OF DAYS');
    {
      const { dayBookService, MAX_RANGE_DAYS } = require('../services/daybook.service');
      const keyBack = (n: number) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date(Date.now() - n * 86400000));
      const [k3, k2, k1, k0] = [3, 2, 1, 0].map(keyBack);
      const noon = (k: string) => new Date(`${k}T12:00:00+05:30`);
      const product = await prisma.product.create({ data: { clientId: SHOP, productCode: `DB-${STAMP}`, slug: `db-${STAMP}`, title: 'Range Saree', status: 'DRAFT', category: 'WOMEN', productType: 'READY_TO_WEAR', basePrice: 0 }, select: { id: true } });
      const variant = await prisma.productVariant.create({ data: { clientId: SHOP, productId: product.id, variantCode: `DBV-${STAMP}`, sku: `DB-${STAMP}-A`, barcode: `DB${STAMP}`, size: 'M', colorName: 'Red' }, select: { id: true } });
      const move = (k: string, quantity: number, reason: string, before: number) => ({
        clientId: SHOP, variantId: variant.id, locationId: store.id, type: quantity > 0 ? 'IN' : 'OUT', reason, quantity, unitCost: 100,
        balanceBefore: before, balanceAfter: before + quantity, createdBy: 'range-test', createdAt: noon(k)
      });
      await prisma.inventoryTransaction.createMany({ data: [move(k3, 20, 'PURCHASE', 0), move(k2, -5, 'DAMAGE', 20), move(k0, 3, 'PURCHASE', 15)] });

      // The range is the same arithmetic as its days, over a longer window.
      const [r, first, last] = await Promise.all([dayBookService.getRange(SHOP, k3, k0), dayBookService.getDay(SHOP, k3), dayBookService.getDay(SHOP, k0)]);
      check('a range covers its days, first and last included, with a row for each', r.range?.from === k3 && r.range?.to === k0 && r.range?.dayCount === 4 && r.days?.map((d: any) => d.date).join() === [k3, k2, k1, k0].join(), r.range);
      check('its opening is the first day\'s opening and its closing is the last day\'s closing', r.opening?.units === first.opening?.units && r.closing?.units === last.closing?.units, { r: [r.opening?.units, r.closing?.units], first: first.opening?.units, last: last.closing?.units });
      check('what came in and went out is the days added up', r.stockIn.totalUnits === 23 && r.stockOut.totalUnits === 5
        && r.days.reduce((a: number, d: any) => a + d.unitsIn, 0) === r.stockIn.totalUnits && r.days.reduce((a: number, d: any) => a + d.unitsOut, 0) === r.stockOut.totalUnits, { in: r.stockIn.totalUnits, out: r.stockOut.totalUnits });
      const rowOf = (k: string) => r.days.find((d: any) => d.date === k);
      check('each row lands on its own day; a day with nothing carries the count forward', rowOf(k3).unitsIn === 20 && rowOf(k2).unitsOut === 5 && rowOf(k1).unitsIn === 0 && rowOf(k1).unitsOut === 0
        && rowOf(k1).closingUnits === rowOf(k2).closingUnits && rowOf(k0).closingUnits === r.closing?.units, r.days);
      check('the range still checks its closing against the shelves', r.balanced !== undefined && r.measuredClosing !== undefined);
      const oneDay = await dayBookService.getDay(SHOP, k2);
      check('one day is unchanged: no range, no rows', oneDay.range === null && oneDay.days === null && oneDay.date === k2 && oneDay.stockOut.totalUnits === 5, { range: oneDay.range });
      const forStore = await dayBookService.getRange(SHOP, k3, k0, store.id);
      check('a range for one location counts that location', forStore.stockIn.totalUnits === 23 && forStore.range?.dayCount === 4);
      const monthBack = keyBack(MAX_RANGE_DAYS - 1);
      check(`${MAX_RANGE_DAYS} days is allowed`, (await dayBookService.getRange(SHOP, monthBack, k0)).range?.dayCount === MAX_RANGE_DAYS);
      for (const [name, run, pattern] of [
        ['one day more is refused', () => dayBookService.getRange(SHOP, keyBack(MAX_RANGE_DAYS), k0), /31 days or fewer/],
        ['a backwards range is refused', () => dayBookService.getRange(SHOP, k0, k3), /must not be after/],
        ['a range into the future is refused', () => dayBookService.getRange(SHOP, k1, keyBack(-2)), /cannot be after today/],
      ] as const) {
        const out = await said(run());
        check(name, !out.ok && out.status === 400 && pattern.test(out.message), out);
      }

      // The page's Send button.
      const holds = (a: any) => a.permissions.includes('*') || a.permissions.includes('report:financial');
      const reader = [admin, manager, warehouse, sales].find(holds)!;
      const stranger = [sales, warehouse, manager].find(a => !holds(a))!;
      check('setup: one role may see money reports and one may not', Boolean(reader) && Boolean(stranger), { reader: reader?.name, stranger: stranger?.name });

      const info = await wa.getDayBookSending(reader);
      check('the button knows where it sends (masked), and how many are left today', info.configured === true && info.to === '••••4642' && info.limit === 10 && info.sentToday === 1 && info.isOwner === false, info);

      const past = await wa.sendDayBookFromPage(reader, { date: k2, nonce: nonce() });
      const pastCall = dayBookSends().at(-1)?.body;
      check('a finished day goes from the ScaleEzy number to the owner\'s saved number', past.to === '••••4642' && pastCall?.from === 'scaleezy' && pastCall?.to === '918142424642' && pastCall?.kind === 'S6', pastCall && { from: pastCall.from, to: pastCall.to });
      check('as that day\'s real PDF, named for the day, with no "up to" time', Buffer.from(pastCall?.document?.base64 ?? '', 'base64').subarray(0, 5).toString() === '%PDF-'
        && pastCall?.document?.fileName === `day-book-${k2}.pdf` && !/up to/.test(pastCall?.text) && pastCall?.reference === `DAY_BOOK:${k2}`, pastCall?.text);
      check('with a key of its own per press', pastCall?.idempotencyKey?.startsWith(`DAY_BOOK_PAGE:${SHOP}:`), pastCall?.idempotencyKey);

      await wa.sendDayBookFromPage(owner, { date: k0, nonce: nonce() });
      check('today says how far it has got ("up to ...")', /up to \d\d:\d\d/.test(dayBookSends().at(-1)?.body?.text), dayBookSends().at(-1)?.body?.text);

      const ranged = await wa.sendDayBookFromPage(reader, { from: k3, to: k0, nonce: nonce() });
      const rangeCall = dayBookSends().at(-1)?.body;
      check('a range goes as one PDF named for both ends, saying so in words', rangeCall?.document?.fileName === `day-book-${k3}-to-${k0}.pdf` && rangeCall?.reference === `DAY_BOOK:${k3}..${k0}`
        && / to /.test(rangeCall?.text) && Buffer.from(rangeCall?.document?.base64 ?? '', 'base64').subarray(0, 5).toString() === '%PDF-', rangeCall?.text);
      const chip = await wa.dayBookMessage(reader, ranged.id);
      check('the chip beside the button can follow it', chip?.status === 'QUEUED' && chip?.to === '••••4642' && chip?.referenceId === `${k3}..${k0}`, chip);
      const otherOwner = { id: crypto.randomUUID(), clientId: OTHER, name: 'Other Owner', roles: ['SUPER_ADMIN'], permissions: ['*'] };
      check('another shop cannot follow it', (await wa.dayBookMessage(otherOwner, ranged.id)) === null);

      await wa.sendDayBookFromPage(reader, { date: k2, locationId: store.id, nonce: nonce() });
      check('for one location, the message names it', /\(Main Store\)/.test(dayBookSends().at(-1)?.body?.text), dayBookSends().at(-1)?.body?.text);

      const press = nonce();
      await wa.sendDayBookFromPage(reader, { date: k1, nonce: press });
      const keyA = dayBookSends().at(-1)?.body?.idempotencyKey;
      await wa.sendDayBookFromPage(reader, { date: k1, nonce: press });
      check('the same press retried carries the same key (the service sends it once)', keyA && dayBookSends().at(-1)?.body?.idempotencyKey === keyA, keyA);

      const smuggle = await wa.sendDayBookFromPage(reader, { date: k2, phone: '919999999999', number: '919999999999', nonce: nonce() } as any);
      check('a number from the browser is ignored: it still goes to the saved one', smuggle.to === '••••4642' && dayBookSends().at(-1)?.body?.to === '918142424642');

      for (const [name, run, status, pattern] of [
        ['someone who may not see money reports cannot send it', () => wa.sendDayBookFromPage(stranger, { date: k2, nonce: nonce() }), 403, /permission/i],
        ['nor learn where it goes', () => wa.getDayBookSending(stranger), 403, /permission/i],
        ['no day at all', () => wa.sendDayBookFromPage(reader, { nonce: nonce() }), 400, /which day/i],
        ['a date that does not exist', () => wa.sendDayBookFromPage(reader, { date: '2026-02-31', nonce: nonce() }), 400, /which day/i],
        ['half a range', () => wa.sendDayBookFromPage(reader, { from: k3, nonce: nonce() }), 400, /which day/i],
        ['a day that has not come yet', () => wa.sendDayBookFromPage(reader, { date: keyBack(-1), nonce: nonce() }), 400, /not come yet/],
        ['a range that is too long', () => wa.sendDayBookFromPage(reader, { from: keyBack(40), to: k0, nonce: nonce() }), 400, /31 days or fewer/],
        ['a backwards range', () => wa.sendDayBookFromPage(reader, { from: k0, to: k3, nonce: nonce() }), 400, /must not be after/],
        ['another shop\'s location', () => wa.sendDayBookFromPage(reader, { date: k2, locationId: otherStore.id, nonce: nonce() }), 404, /location was not found/],
        ['a location that is not an id', () => wa.sendDayBookFromPage(reader, { date: k2, locationId: "x' OR 1=1", nonce: nonce() }), 400, /location was not found/],
        ['a message id that is not an id', () => wa.dayBookMessage(reader, 'nope'), 400, /which message/i],
      ] as const) {
        const before = dayBookSends().length;
        const out = await said(run());
        check(name, !out.ok && out.status === status && pattern.test(out.message) && dayBookSends().length === before, out);
      }

      mode = 'down';
      const downOut = await said(wa.sendDayBookFromPage(reader, { date: k2, nonce: nonce() }));
      mode = 'ok';
      check('with the service down: one plain sentence, not a crash', !downOut.ok && downOut.status === 503 && /try again/i.test(downOut.message), downOut);

      await prisma.whatsAppSettings.update({ where: { clientId: SHOP }, data: { dayBookTo: null } });
      const noNumberOwner = await said(wa.sendDayBookFromPage(owner, { date: k2, nonce: nonce() }));
      const noNumberReader = await said(wa.sendDayBookFromPage(reader, { date: k2, nonce: nonce() }));
      check('no number saved: the owner is told to save one', !noNumberOwner.ok && noNumberOwner.status === 400 && /Save the WhatsApp number/.test(noNumberOwner.message), noNumberOwner);
      check('and anyone else is told to ask the owner', !noNumberReader.ok && noNumberReader.status === 400 && /shop owner has not saved/.test(noNumberReader.message), noNumberReader);
      check('the button then shows no number', (await wa.getDayBookSending(reader)).to === null);
      await prisma.whatsAppSettings.update({ where: { clientId: SHOP }, data: { dayBookTo: '918142424642' } });

      // Ten on request a day; the nightly one is apart from that.
      const askedSoFar = (await wa.getDayBookSending(reader)).sentToday;
      for (let i = askedSoFar; i < 10; i++) await wa.sendDayBookFromPage(reader, { date: k2, nonce: nonce() });
      const beforeLimit = dayBookSends().length;
      const eleventh = await said(wa.sendDayBookFromPage(reader, { date: k2, nonce: nonce() }));
      check('the eleventh Day Book asked for in a day is refused, in words', !eleventh.ok && eleventh.status === 429 && /limit/.test(eleventh.message) && dayBookSends().length === beforeLimit, eleventh);
      const nowAtLimit = await said(wa.sendDayBookNow(owner, nonce()));
      check('"send it now" in Settings counts towards the same ten', !nowAtLimit.ok && nowAtLimit.status === 429, nowAtLimit);
      check('the button says none are left', (await wa.getDayBookSending(reader)).sentToday === 10);
      await wa.saveDayBookSettings(owner, { enabled: true, time: '22:00', to: '8142424642' });
      await prisma.whatsAppSettings.update({ where: { clientId: SHOP }, data: { dayBookLastSentFor: null } });
      await wa.runDayBookTick(at('22:40'), { onlyClients: [SHOP] });
      check('the nightly Day Book still goes: it is not one of the ten', dayBookSends().length === beforeLimit + 1 && dayBookSends().at(-1)?.body?.idempotencyKey === `DAY_BOOK:${SHOP}:${istDay}`, dayBookSends().at(-1)?.body?.idempotencyKey);
      await wa.saveDayBookSettings(owner, { enabled: false, time: '22:00', to: '8142424642' });
      await prisma.whatsAppMessage.updateMany({ where: { clientId: SHOP, kind: 'DAY_BOOK', sentBy: { not: null } }, data: { createdAt: new Date(Date.now() - 2 * 86400000) } });
      check('tomorrow the ten start again', (await wa.getDayBookSending(reader)).sentToday === 0);
    }

    console.log('\nF. THE SERVICE DOWN OR REFUSING');
    for (const m of ['down', 'unreachable', 'notLinked', 'optedOut'] as const) {
      mode = m;
      const r = await said(wa.sendDocument(owner, { kind: 'BILL', id: sale.id, pdfBase64: PDF, nonce: nonce() }));
      check(`service ${m}: a plain sentence, not an error dump`, !r.ok && plain(r.message), r);
    }
    mode = 'notLinked';
    const nl = await said(wa.sendDocument(owner, { kind: 'BILL', id: sale.id, pdfBase64: PDF, nonce: nonce() }));
    check("the service's own sentence reaches the person: not linked", /not linked/.test(nl.message) && nl.status === 409, nl);
    mode = 'optedOut';
    const oo = await said(wa.sendDocument(owner, { kind: 'BILL', id: sale.id, pdfBase64: PDF, nonce: nonce() }));
    check("the service's own sentence reaches the person: replied STOP", /replied STOP/.test(oo.message) && oo.status === 403, oo);
    mode = 'ok';
    const ovDown = await (async () => { mode = 'down'; const o = await wa.getOverview(owner); mode = 'ok'; return o; })();
    check('the overview says WhatsApp could not be reached, and still loads', ovDown.problem && /WhatsApp|engine/i.test(ovDown.problem) && ovDown.account === null, ovDown);

    console.log('\nG. THE SHOP\'S WHATSAPP DROPS');
    await wa.saveDayBookSettings(owner, { enabled: false, time: '22:00', to: '8142424642' });
    const n3 = seen.filter(s => s.path === '/v1/messages' && s.body?.kind === 'S4').length;
    await wa.handleEvent(ev('account.disconnected', { kind: 'CLIENT', clientId: SHOP, status: 'DISCONNECTED' }));
    const s4 = seen.filter(s => s.path === '/v1/messages' && s.body?.kind === 'S4');
    check('the owner is told on WhatsApp, from the ScaleEzy number, at their Day Book number', s4.length === n3 + 1 && s4.at(-1)?.body?.from === 'scaleezy' && s4.at(-1)?.body?.to === '918142424642' && /Settings > WhatsApp/.test(s4.at(-1)?.body?.text), s4.at(-1)?.body);
    // Recorder in place of real email BEFORE any ScaleEzy event: these would go to the real admins.
    const alerts: Array<{ to: string; subject: string; text: string }> = [];
    const realSend = wa.platformAlertMail.send, realTo = wa.platformAlertMail.to;
    wa.platformAlertMail.send = async (m: any) => { alerts.push(m); return { sent: true }; };
    wa.platformAlertMail.to = () => undefined; // first: no list set, so every active admin
    const fire = async (e: any) => { const r = await wa.handleEvent(e); await wa.platformAlertMail.settled(); return r; };
    try {
      const admins = await prisma.platformAdmin.count({ where: { status: 'ACTIVE' } });
      await fire(ev('account.disconnected', { kind: 'SCALEEZY', clientId: null, status: 'LOGGED_OUT', previousStatus: 'CONNECTED' }));
      check('ScaleEzy\'s own number dropping tells no shop owner', seen.filter(s => s.body?.kind === 'S4').length === n3 + 1);
      check('every active platform admin gets an email', admins > 0 && alerts.length === admins, { admins, alerts: alerts.length });
      check('it says logged out, what stops, and how to link again', /logged out/.test(alerts[0]?.subject) && /Day Book/.test(alerts[0]?.text) && /npm run link:scaleezy/.test(alerts[0]?.text) && /Leave any "ScaleEzy \(Chrome\)"/.test(alerts[0]?.text), alerts[0]?.text);
      await fire(ev('account.disconnected', { kind: 'SCALEEZY', clientId: null, status: 'LOGGED_OUT', previousStatus: 'CONNECTED' }));
      check('the same drop again within 6 hours sends nothing more', alerts.length === admins);
      await fire(ev('account.disconnected', { kind: 'SCALEEZY', clientId: null, status: 'DISCONNECTED', previousStatus: 'CONNECTED' }));
      check('a different drop (phone offline) is its own email, and says it usually comes back', alerts.length === 2 * admins && /not connected/.test(alerts.at(-1)!.subject) && /comes back by itself/.test(alerts.at(-1)!.text));
      await fire(ev('account.connected', { kind: 'SCALEEZY', clientId: null, status: 'CONNECTED', previousStatus: 'LOGGED_OUT' }));
      check('coming back after a reported drop sends "back"', alerts.length === 3 * admins && /is back/.test(alerts.at(-1)!.subject));
      await fire(ev('account.connected', { kind: 'SCALEEZY', clientId: null, status: 'CONNECTED', previousStatus: 'DISCONNECTED' }));
      check('a second "back" with no new drop in between sends nothing', alerts.length === 3 * admins);
      await wa.handleEvent(ev('account.connected', { kind: 'CLIENT', clientId: SHOP, status: 'CONNECTED' }));
      await wa.handleEvent(ev('account.disconnected', { kind: 'CLIENT', clientId: SHOP, status: 'DISCONNECTED' }));
      check("a shop's number dropping or coming back never emails ScaleEzy's admins", alerts.length === 3 * admins);
      const n4 = alerts.length;
      wa.platformAlertMail.forget();
      let tries = 0;
      wa.platformAlertMail.send = async () => { tries++; throw new Error('smtp down'); };
      const r = await fire(ev('account.disconnected', { kind: 'SCALEEZY', clientId: null, status: 'LOGGED_OUT' }));
      check('email failing never fails the event (it is still recorded as handled)', r.handled === true && tries === admins && alerts.length === n4, { r, tries });
      wa.platformAlertMail.send = async (m: any) => { alerts.push(m); return { sent: true }; };
      await fire(ev('account.disconnected', { kind: 'SCALEEZY', clientId: null, status: 'LOGGED_OUT' }));
      check('after a failed email, the next drop tries again (a mail outage does not silence it for 6 hours)', alerts.length === n4 + admins);
      wa.platformAlertMail.forget();
      const n5 = alerts.length;
      wa.platformAlertMail.to = () => ' ops@example.com, second@example.com ';
      await fire(ev('account.disconnected', { kind: 'SCALEEZY', clientId: null, status: 'LOGGED_OUT' }));
      const listed = alerts.slice(n5).map(a => a.to);
      check('with WHATSAPP_ALERT_EMAILS set, only those addresses get it (no admin)', listed.length === 2 && listed[0] === 'ops@example.com' && listed[1] === 'second@example.com', listed);
      wa.platformAlertMail.forget();
      let n8 = alerts.length;
      wa.platformAlertMail.to = () => 'ops@example.com, not-an-address, ';
      await fire(ev('account.disconnected', { kind: 'SCALEEZY', clientId: null, status: 'LOGGED_OUT' }));
      check('a typo in the list is skipped; the good address still gets it', alerts.slice(n8).map(a => a.to).join() === 'ops@example.com', alerts.slice(n8).map(a => a.to));
      wa.platformAlertMail.forget();
      n8 = alerts.length;
      wa.platformAlertMail.to = () => 'typo-only';
      await fire(ev('account.disconnected', { kind: 'SCALEEZY', clientId: null, status: 'LOGGED_OUT' }));
      check('a list with no usable address falls back to the admins (nobody told is never the result)', alerts.length - n8 === admins, alerts.length - n8);
      wa.platformAlertMail.forget();
      const n6 = alerts.length;
      wa.platformAlertMail.to = () => 'ops@example.com';
      wa.platformAlertMail.send = async (m: any) => { await new Promise(res => setTimeout(res, 12_000)); alerts.push(m); return { sent: true }; };
      const t0 = Date.now();
      const slow = await wa.handleEvent(ev('account.disconnected', { kind: 'SCALEEZY', clientId: null, status: 'DISCONNECTED' }));
      const tookMs = Date.now() - t0;
      check('email taking 12 s: the service still gets its answer at once (it gives up after 10 s)', slow.handled === true && tookMs < 3000, { tookMs });
      await wa.platformAlertMail.settled();
      check('and the email still goes out afterwards', alerts.length === n6 + 1);
      wa.platformAlertMail.forget();
      wa.platformAlertMail.send = async (m: any) => { await new Promise(res => setTimeout(res, 300)); alerts.push(m); return { sent: true }; };
      const n7 = alerts.length;
      await Promise.all([1, 2, 3].map(() => wa.handleEvent(ev('account.disconnected', { kind: 'SCALEEZY', clientId: null, status: 'LOGGED_OUT' }))));
      await new Promise(res => setTimeout(res, 1000));
      check('three drop events at the same moment: one email, not three', alerts.length === n7 + 1, alerts.length - n7);
      wa.platformAlertMail.forget();
    } finally {
      wa.platformAlertMail.send = realSend;
      wa.platformAlertMail.to = realTo;
    }

    console.log('\nH. HANDLED EVENTS ARE NOT KEPT FOR EVER');
    const { HousekeepingScheduler } = require('../jobs/housekeeping.scheduler');
    const oldId = `verify-old-${STAMP}`, newId = `verify-new-${STAMP}`;
    await prisma.whatsAppEventSeen.createMany({ data: [
      { id: oldId, receivedAt: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000) },
      { id: newId, receivedAt: new Date(Date.now() - 1 * 24 * 60 * 60 * 1000) }
    ] });
    await HousekeepingScheduler.runOnce();
    check('an event id older than a week is forgotten', !(await prisma.whatsAppEventSeen.findUnique({ where: { id: oldId } })));
    check('a recent one is still remembered (a repeat is still recognised)', !!(await prisma.whatsAppEventSeen.findUnique({ where: { id: newId } })));
    await prisma.whatsAppEventSeen.deleteMany({ where: { id: newId } });

    console.log(`\n================ RESULT: ${passed} passed | ${failed} failed ================`);
    if (failures.length) { console.log('\nFailed:'); failures.forEach(x => console.log('  - ' + x)); process.exitCode = 1; }
  } finally {
    for (const id of [SHOP, OTHER]) {
      await prisma.whatsAppMessage.deleteMany({ where: { clientId: id } }).catch(() => {});
      await prisma.whatsAppSettings.deleteMany({ where: { clientId: id } }).catch(() => {});
      await platformAdminService.deleteClientCompletely(id, id).catch((e: any) => console.log(`cleanup ${id}:`, e?.message));
    }
    const left = await prisma.purchaseOrder.count({ where: { clientId: { in: [SHOP, OTHER] } } })
      + await prisma.whatsAppMessage.count({ where: { clientId: { in: [SHOP, OTHER] } } });
    console.log(`\n(test shops removed, rows left: ${left})`);
    await prisma.$disconnect();
    stub.close();
  }
}

main().catch(e => { console.error('\nSuite did not finish:', e?.message ?? e); process.exitCode = 1; stub.close(); });
