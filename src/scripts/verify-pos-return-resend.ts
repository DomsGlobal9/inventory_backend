/**
 * A till credit note sent AGAIN (20 Nov 2026, found by the POS session's Boutique counter run), against the REAL local
 * server and database.
 *
 * Before: a return already applied, sent again (a till retrying, or going back over its queue), was checked for
 * quantities first, counted against itself ("2 pieces returned against 1 sold") and refused QTY_EXCEEDS_SOLD -- while
 * the same resend of a SALE answers ALREADY_APPLIED. Now a credit note we already hold is answered from what we did
 * with it, and the quantity rule still stops a NEW credit note that would return more than was sold.
 *
 * One throwaway shop (posresend-*), removed at the end. Local only.
 *   DATABASE_URL=<local> DIRECT_URL=<local> VERIFY_API_URL=http://localhost:4036/api/v1 npx tsx src/scripts/verify-pos-return-resend.ts
 */
import { prisma } from '../lib/prisma';
import { generateCredential } from '../utils/storefrontCredential';
import { POS_BASE_URL } from '../utils/posConnection';

const BASE = process.env.VERIFY_API_URL || 'http://localhost:4036/api/v1';
for (const k of ['DATABASE_URL', 'DIRECT_URL']) {
  if (!/localhost:55433/.test(process.env[k] ?? '')) { console.error(`Refusing: ${k} is not the local database.`); process.exit(2); }
}
if (!/localhost|127\.0\.0\.1/.test(BASE)) { console.error('Refusing: VERIFY_API_URL is not a local server.'); process.exit(2); }

const S = Date.now().toString(36);
const CLIENT = `posresend-${S}`;
let bad = 0, good = 0;
const check = (name: string, ok: boolean, detail: unknown = '') => {
  ok ? good++ : bad++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : ` :: ${typeof detail === 'string' ? detail : JSON.stringify(detail)?.slice(0, 500)}`}`);
};

async function main() {
  const store = await prisma.stockLocation.create({ data: { clientId: CLIENT, name: 'Main', code: `PR-${S}`, type: 'STORE' as any, active: true } });
  const product = await prisma.product.create({ data: { clientId: CLIENT, productCode: `PR-${S}`, slug: `pr-${S}`, title: 'Blouse', category: 'WOMEN' as any, productType: 'READY_TO_WEAR' as any, basePrice: 1499, status: 'ACTIVE' as any, publishedAt: new Date(), sellInShop: true } as any });
  const v = await prisma.productVariant.create({ data: { clientId: CLIENT, productId: product.id, variantCode: `PRV-${S}`, sku: `PRS-${S}`, colorName: 'Maroon', size: '38', sellingPrice: 1499 } as any });
  await prisma.inventoryStock.create({ data: { clientId: CLIENT, variantId: v.id, locationId: store.id, quantity: 10 } as any });
  const cred = generateCredential();
  await prisma.storefrontConnection.create({ data: { clientId: CLIENT, name: 'Till', baseUrl: POS_BASE_URL, credentialHash: cred.hash, credentialPrefix: cred.prefix, status: 'ACTIVE' as any, locationIds: [store.id] } });
  const h = { 'content-type': 'application/json', 'x-storefront-key': cred.plaintext };
  const send = async (body: unknown) => { const r = await fetch(`${BASE}/pos/v1/events`, { method: 'POST', headers: h, body: JSON.stringify(body) }); return { status: r.status, data: ((await r.json().catch(() => null)) as any)?.data }; };
  const settled = async (no: string) => {
    const end = Date.now() + 90_000;
    while (Date.now() < end) {
      const s = ((await (await fetch(`${BASE}/pos/v1/events/status?invoiceNo=${encodeURIComponent(no)}`, { headers: h })).json().catch(() => null)) as any)?.data;
      if (s && ['APPLIED', 'REJECTED'].includes(s.status)) return s;
      await new Promise(r => setTimeout(r, 1000));
    }
    return null;
  };
  const stock = async () => (await prisma.inventoryStock.findFirst({ where: { variantId: v.id } }))!.quantity;

  const INV = 'INV/2026-27/0001';
  const sale = await send({ kind: 'sale.completed', invoiceNo: INV, occurredAt: new Date().toISOString(), lines: [{ itemCode: v.variantCode, qty: 1, unitPricePaise: 149900, lineTotalPaise: 149900 }], totals: { roundOffPaise: 0 }, payments: [{ method: 'CASH', amountPaise: 149900 }] });
  const saleDone = await settled(INV);
  check('a bill for one blouse is applied; stock 10 -> 9', sale.status === 202 && saleDone?.status === 'APPLIED' && (await stock()) === 9, { sale, saleDone });

  const CN = 'CN/2026-27/0001';
  const ret = { kind: 'sale.returned', creditNoteNo: CN, againstInvoiceNo: INV, occurredAt: new Date().toISOString(), lines: [{ itemCode: v.variantCode, qty: 1, lineTotalPaise: 149900 }], totals: {}, refunds: [{ method: 'CASH', amountPaise: 149900 }] };
  const first = await send(ret);
  const firstDone = await settled(CN);
  check('its return is applied; stock back to 10', [200, 202].includes(first.status) && firstDone?.status === 'APPLIED' && (await stock()) === 10, { first, firstDone });

  const again = await send(ret);
  check('THE SAME credit note sent again: 200 ALREADY_APPLIED (was 422 QTY_EXCEEDS_SOLD)', again.status === 200 && again.data?.answer === 'ALREADY_APPLIED', again);
  check('...stock still 10, not 11; one return row', (await stock()) === 10 && (await prisma.salesOrder.count({ where: { clientId: CLIENT, externalOrderId: CN } })) <= 1, await stock());
  const thrice = await send(ret);
  check('...and a third time: the same answer', thrice.status === 200 && thrice.data?.answer === 'ALREADY_APPLIED', thrice);

  const other = await send({ ...ret, creditNoteNo: 'CN/2026-27/0002' });
  check('a NEW credit note for the same piece: still refused QTY_EXCEEDS_SOLD (the rule is kept)', other.status === 422 && other.data?.answer === 'QTY_EXCEEDS_SOLD', other);
  check('...stock unchanged', (await stock()) === 10);

  // A return refused once (wrong amount), then sent right: a resend of a REJECTED one is checked again, as before.
  const INV2 = 'INV/2026-27/0002';
  await send({ kind: 'sale.completed', invoiceNo: INV2, occurredAt: new Date().toISOString(), lines: [{ itemCode: v.variantCode, qty: 1, unitPricePaise: 149900, lineTotalPaise: 149900 }], totals: { roundOffPaise: 0 }, payments: [{ method: 'CASH', amountPaise: 149900 }] });
  await settled(INV2);
  const wrong = await send({ ...ret, creditNoteNo: 'CN/2026-27/0003', againstInvoiceNo: INV2, lines: [{ itemCode: v.variantCode, qty: 1, lineTotalPaise: 999900 }] });
  check('a return with the wrong amount: refused at the door, nothing written', wrong.status === 422 && wrong.data?.answer === 'AMOUNT_MISMATCH' && !(await prisma.posInboundEvent.count({ where: { clientId: CLIENT, invoiceNo: 'CN/2026-27/0003' } })), wrong);
  const right = await send({ ...ret, creditNoteNo: 'CN/2026-27/0003', againstInvoiceNo: INV2 });
  const rightDone = await settled('CN/2026-27/0003');
  check('...sent again with the right amount: applied', [200, 202].includes(right.status) && rightDone?.status === 'APPLIED' && (await stock()) === 10, { right, rightDone });
}

async function cleanup() {
  const tables = await prisma.$queryRaw<{ table_name: string }[]>`SELECT DISTINCT table_name FROM information_schema.columns WHERE table_schema = 'public' AND column_name = 'client_id'`;
  for (let round = 0; round < 8; round++) {
    let left = 0;
    for (const t of tables) { try { await prisma.$executeRawUnsafe(`DELETE FROM "${t.table_name}" WHERE client_id = $1`, CLIENT); } catch { left++; } }
    if (!left) break;
  }
}

main()
  .catch(e => { bad++; console.error('CRASH', e); })
  .finally(async () => { await cleanup().catch(e => console.error('cleanup failed', e)); console.log(`${good} passed, ${bad} problems`); await prisma.$disconnect(); process.exit(bad ? 1 : 0); });
