/**
 * A till invoice number sent again with a DIFFERENT bill (25 Nov 2026, the owner: "refuse it loudly"), against the REAL
 * local server and database. Found by the POS session: its test shop's numbering restarted, the new bills reused old
 * numbers, and Inventory answered ALREADY_APPLIED from the old bills -- the new sales were lost without a word.
 *
 *   - the same bill again (a till retrying): 200 ALREADY_APPLIED, nothing moves -- as before;
 *   - the same number, other items or other quantities: 422 INVOICE_REUSED with a sentence for the owner;
 *     no second order, no stock moved;
 *   - also when the bill was recorded long ago and its queue row is gone (the worker's own check);
 *   - a REJECTED bill may still be fixed and sent again under its number (the owner's Retry).
 *
 * One throwaway shop (posreuse-*), removed at the end. Local only.
 *   DATABASE_URL=<local> DIRECT_URL=<local> VERIFY_API_URL=http://localhost:4036/api/v1 npx tsx src/scripts/verify-pos-invoice-reused.ts
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
const CLIENT = `posreuse-${S}`;
let bad = 0, good = 0;
const check = (name: string, ok: boolean, detail: unknown = '') => {
  ok ? good++ : bad++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : ` :: ${typeof detail === 'string' ? detail : JSON.stringify(detail)?.slice(0, 500)}`}`);
};

async function main() {
  const store = await prisma.stockLocation.create({ data: { clientId: CLIENT, name: 'Main', code: `PU-${S}`, type: 'STORE' as any, active: true } });
  const make = async (n: number, title: string, sellInShop = true) => {
    const p = await prisma.product.create({ data: { clientId: CLIENT, productCode: `PU-${S}-${n}`, slug: `pu-${S}-${n}`, title, category: 'WOMEN' as any, productType: 'READY_TO_WEAR' as any, basePrice: 1000, status: 'ACTIVE' as any, publishedAt: new Date(), sellInShop } as any });
    const v = await prisma.productVariant.create({ data: { clientId: CLIENT, productId: p.id, variantCode: `PUV-${S}-${n}`, sku: `PUS-${S}-${n}`, colorName: 'Maroon', size: '38', sellingPrice: 1000 } as any });
    await prisma.inventoryStock.create({ data: { clientId: CLIENT, variantId: v.id, locationId: store.id, quantity: 10 } as any });
    return v;
  };
  const blouse = await make(1, 'Blouse'), dupatta = await make(2, 'Dupatta'), thread = await make(3, 'Zari thread', false);
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
  const stock = async (v: { id: string }) => (await prisma.inventoryStock.findFirst({ where: { variantId: v.id } }))!.quantity;
  const orders = () => prisma.salesOrder.count({ where: { clientId: CLIENT } });
  const bill = (no: string, item: { variantCode: string }, qty = 1) => ({ kind: 'sale.completed', invoiceNo: no, occurredAt: new Date().toISOString(),
    lines: [{ itemCode: item.variantCode, qty, unitPricePaise: 100000, lineTotalPaise: 100000 * qty }], totals: { roundOffPaise: 0 }, payments: [{ method: 'CASH', amountPaise: 100000 * qty }] });

  console.log('A BILL, AND THE SAME BILL AGAIN');
  const INV = 'INV/2026-27/0001';
  const first = await send(bill(INV, blouse));
  const done = await settled(INV);
  check('a bill for one blouse is applied: one order, blouse 10 -> 9', first.status === 202 && done?.status === 'APPLIED' && await stock(blouse) === 9 && await orders() === 1, { first, done });
  const again = await send(bill(INV, blouse));
  check('the SAME bill again (a till retrying): 200 ALREADY_APPLIED, nothing moves', again.status === 200 && again.data?.answer === 'ALREADY_APPLIED' && await stock(blouse) === 9 && await orders() === 1, again);

  console.log('\nTHE SAME NUMBER, ANOTHER BILL');
  const other = await send(bill(INV, dupatta));
  check('the same number with another item: 422 INVOICE_REUSED', other.status === 422 && other.data?.answer === 'INVOICE_REUSED', other);
  check('...the sentence names the number and says what to do', /INV\/2026-27\/0001/.test(other.data?.detail ?? '') && /new number/.test(other.data?.detail ?? ''), other.data?.detail);
  check('...no second order, no dupatta taken off', await orders() === 1 && await stock(dupatta) === 10);
  const more = await send(bill(INV, blouse, 2));
  check('the same number, same item, another quantity: 422 INVOICE_REUSED, nothing moves', more.status === 422 && more.data?.answer === 'INVOICE_REUSED' && await stock(blouse) === 9, more);

  console.log('\nA BILL RECORDED LONG AGO (its queue row gone)');
  await prisma.posInboundEvent.deleteMany({ where: { clientId: CLIENT, invoiceNo: INV } });
  const late = await send(bill(INV, dupatta));
  const lateDone = await settled(INV);
  check('another item under that number: stopped by the worker, REJECTED as INVOICE_REUSED', [200, 202, 422].includes(late.status) && lateDone?.status === 'REJECTED' && lateDone?.answer === 'INVOICE_REUSED', { late, lateDone });
  check('...still one order, the dupatta untouched', await orders() === 1 && await stock(dupatta) === 10);
  await prisma.posInboundEvent.deleteMany({ where: { clientId: CLIENT, invoiceNo: INV } });
  const lateSame = await send(bill(INV, blouse));
  const lateSameDone = await settled(INV);
  check('the true bill again under that number: applied as ALREADY_APPLIED, never refused', lateSameDone?.status === 'APPLIED' && ['ALREADY_APPLIED', 'APPLIED'].includes(lateSameDone?.answer) && await stock(blouse) === 9 && await orders() === 1, { lateSame, lateSameDone });

  console.log('\nA REJECTED BILL, FIXED AND SENT AGAIN');
  const INV3 = 'INV/2026-27/0003';
  await send(bill(INV3, thread));
  const rej = await settled(INV3);
  check('a bill with a material is rejected (not for sale)', rej?.status === 'REJECTED' && /not for sale/.test(rej?.detail ?? ''), rej);
  const fixed = await send(bill(INV3, dupatta));
  const fixedDone = await settled(INV3);
  check('...the owner fixes it (another item) and Retry sends it under the same number: accepted and applied', fixed.status === 202 && fixedDone?.status === 'APPLIED' && await stock(dupatta) === 9, { fixed, fixedDone });

  console.log('\nA NEW NUMBER');
  const INV2 = 'INV/2026-27/0002';
  const next = await send(bill(INV2, dupatta));
  check('a new number: a normal sale', next.status === 202 && (await settled(INV2))?.status === 'APPLIED' && await stock(dupatta) === 8);
}

async function cleanup() {
  const tables = await prisma.$queryRaw<{ table_name: string }[]>`SELECT DISTINCT table_name FROM information_schema.columns WHERE table_schema = 'public' AND column_name = 'client_id'`;
  for (let round = 0; round < 8; round++) {
    let left = 0;
    for (const t of tables) { try { await prisma.$executeRawUnsafe(`DELETE FROM "${t.table_name}" WHERE client_id = $1`, CLIENT); } catch { left++; } }
    if (!left) break;
  }
  console.log('\ncleaned up');
}

main()
  .catch(e => { bad++; console.error('CRASH', e); })
  .finally(async () => { await cleanup().catch(e => console.error('cleanup failed', e)); console.log(`${good} passed, ${bad} problems`); await prisma.$disconnect(); process.exit(bad ? 1 : 0); });
