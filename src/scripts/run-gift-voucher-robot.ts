/**
 * Runs PLAN-help/robot/check-gift-vouchers-ui.mjs on sphl (a test shop) with four real vouchers sold
 * through the same sell() the till calls -- one open, one open and expiring soon, one expired, one
 * used up -- then an owner and a Sales person work the screens. Everything made here is deleted
 * afterwards and the shop's voucher settings are put back as they were.
 *
 * Writes no VOUCHER payment rows and no voucher holds (the deploy-first rule): selling a voucher
 * only touches gift_vouchers and gift_voucher_entries.
 *
 *   npx tsx src/scripts/run-gift-voucher-robot.ts     (needs the local backend :4006 and frontend :5173)
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { prisma } from '../lib/prisma';
import { AuthService } from '../services/auth.service';
import * as giftVouchers from '../services/gift-vouchers';

const C = 'sphl';
const STAMP = Date.now().toString(36);
const KEY = `robot-gv-${STAMP}`;

async function token(role: string) {
  const u = await prisma.user.findFirst({ where: { clientId: C, status: 'ACTIVE', roles: { some: { role: { name: role } } } }, select: { id: true, sessionVersion: true } });
  return u ? AuthService.generateToken({ userId: u.id, clientId: C, sessionVersion: u.sessionVersion }) : null;
}

async function main() {
  const before = await prisma.giftVoucherSettings.findUnique({ where: { clientId: C } });
  const store = await prisma.stockLocation.findFirstOrThrow({ where: { clientId: C, type: 'STORE' as any, active: true }, orderBy: { createdAt: 'asc' }, select: { id: true, name: true } });
  const till = { connectionId: `robot-${STAMP}`, locationId: store.id };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gv-robot-'));
  try {
    await prisma.giftVoucherSettings.upsert({ where: { clientId: C }, create: { clientId: C, enabled: true }, update: { enabled: true, validMonths: 12, minPaise: 50000, maxPaise: 5000000 } });
    const sell = (n: string, rupees: number, payments: any[], buyer: any) =>
      giftVouchers.sell(C, till, { idempotencyKey: `${KEY}-${n}`, amountPaise: rupees * 100, payments, buyer }) as Promise<any>;
    const open = await sell('a', 1000, [{ method: 'CASH', amountPaise: 100000 }], { name: 'Robot Meena', phone: '+919000016001' });
    const soon = await sell('b', 2500, [{ method: 'UPI', amountPaise: 250000, reference: `UTR${STAMP}B` }], { name: 'Robot Arjun', phone: '+919000016002' });
    const old = await sell('c', 500, [{ method: 'CASH', amountPaise: 50000 }], { name: 'Robot Kavya', phone: '+919000016003' });
    const spent = await sell('d', 700, [{ method: 'CARD', amountPaise: 70000, reference: `CARD${STAMP}D` }], { name: 'Robot Ravi', phone: '+919000016004' });
    // Put two of them where a real shop's would be weeks later: one expired, one spent to nothing.
    await prisma.giftVoucher.update({ where: { clientId_code: { clientId: C, code: soon.code } }, data: { expiresAt: new Date(Date.now() + 10 * 86_400_000) } });
    await prisma.giftVoucher.update({ where: { clientId_code: { clientId: C, code: old.code } }, data: { expiresAt: new Date(Date.now() - 2 * 86_400_000) } });
    await prisma.giftVoucher.update({ where: { clientId_code: { clientId: C, code: spent.code } }, data: { balancePaise: 0 } });

    const owner = await token('ADMIN') ?? await token('OWNER') ?? await token('SUPER_ADMIN');
    const sales = await token('SALES');
    if (!owner) throw new Error('sphl has no ADMIN or OWNER user to drive the screens with.');
    fs.writeFileSync(path.join(dir, 'owner'), owner);
    if (sales) fs.writeFileSync(path.join(dir, 'sales'), sales);
    fs.writeFileSync(path.join(dir, 'vouchers.json'), JSON.stringify({ store: store.name, open: open.code, soon: soon.code, old: old.code, spent: spent.code }));

    const run = spawnSync('node', ['check-gift-vouchers-ui.mjs'], {
      cwd: path.resolve(__dirname, '../../../PLAN-help/robot'), stdio: 'inherit',
      env: { ...process.env, OWNER_TOKEN_FILE: path.join(dir, 'owner'), SALES_TOKEN_FILE: sales ? path.join(dir, 'sales') : '', VOUCHERS_FILE: path.join(dir, 'vouchers.json') }
    });
    process.exitCode = run.status ?? 1;
  } finally {
    const mine = await prisma.giftVoucher.findMany({ where: { clientId: C, idempotencyKey: { startsWith: KEY } }, select: { id: true } });
    await prisma.giftVoucherEntry.deleteMany({ where: { clientId: C, voucherId: { in: mine.map(v => v.id) } } });
    await prisma.giftVoucher.deleteMany({ where: { id: { in: mine.map(v => v.id) } } });
    if (before) await prisma.giftVoucherSettings.update({ where: { clientId: C }, data: { enabled: before.enabled, validMonths: before.validMonths, minPaise: before.minPaise, maxPaise: before.maxPaise } });
    else await prisma.giftVoucherSettings.deleteMany({ where: { clientId: C } });
    fs.rmSync(dir, { recursive: true, force: true });
    const left = await prisma.giftVoucher.count({ where: { clientId: C, idempotencyKey: { startsWith: KEY } } });
    console.log(`\ncleaned up: ${mine.length} vouchers deleted, ${left} left, settings ${before ? 'restored' : 'removed (there were none)'}`);
    await prisma.$disconnect();
  }
}
main().catch(e => { console.error(e); process.exit(1); });
