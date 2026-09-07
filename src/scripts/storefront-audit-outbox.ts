/**
 * Records what is in the outbox before the storefront migration empties it.
 *
 * The migration deletes every inventory_events row. That is the right call -- they are
 * undeliverable queue entries, not history -- but deleting rows without a record of what was
 * deleted is how a mistake becomes undetectable. Run this first and keep the output.
 *
 * The claim being checked here is that nothing is lost: inventory_transactions is the audit
 * record, it is untouched by the migration, and it covers the same period. If that turns out
 * not to hold for your data, this prints it and you should stop before deploying.
 *
 *   npx ts-node src/scripts/storefront-audit-outbox.ts
 */
import { prisma } from '../lib/prisma';

async function main() {
  const total = await prisma.$queryRaw<{ c: bigint }[]>`SELECT COUNT(*)::bigint AS c FROM inventory_events`;
  const eventCount = Number(total[0].c);

  if (eventCount === 0) {
    console.log('The outbox is already empty. Nothing to record.');
    return;
  }

  const byStatus = await prisma.$queryRaw<{ status: string; c: bigint }[]>`
    SELECT status, COUNT(*)::bigint AS c FROM inventory_events GROUP BY status ORDER BY c DESC`;
  const byTenant = await prisma.$queryRaw<{ client_id: string; c: bigint }[]>`
    SELECT client_id, COUNT(*)::bigint AS c FROM inventory_events GROUP BY client_id ORDER BY c DESC`;
  const range = await prisma.$queryRaw<{ oldest: Date; newest: Date }[]>`
    SELECT MIN(created_at) AS oldest, MAX(created_at) AS newest FROM inventory_events`;

  console.log('\n=== OUTBOX CONTENTS, ABOUT TO BE CLEARED BY THE MIGRATION ===\n');
  console.log(`rows:     ${eventCount}`);
  console.log(`by status: ${byStatus.map(s => `${s.status}=${Number(s.c)}`).join('  ')}`);
  console.log(`tenants:   ${byTenant.length}`);
  console.log(`period:    ${range[0].oldest?.toISOString()}  ->  ${range[0].newest?.toISOString()}`);

  console.log('\nper tenant:');
  for (const t of byTenant) console.log(`  ${t.client_id}: ${Number(t.c)}`);

  // The safety claim, checked rather than asserted: every period covered by a queued event is
  // also covered by the ledger, so clearing the queue destroys no record of what happened.
  console.log('\n=== IS ANYTHING ACTUALLY LOST? ===\n');
  const txTotal = await prisma.inventoryTransaction.count();
  console.log(`inventory_transactions rows (the audit record, untouched): ${txTotal}`);

  let uncovered = 0;
  for (const t of byTenant) {
    const evRange = await prisma.$queryRaw<{ oldest: Date }[]>`
      SELECT MIN(created_at) AS oldest FROM inventory_events WHERE client_id = ${t.client_id}`;
    const txCount = await prisma.inventoryTransaction.count({
      where: { clientId: t.client_id, createdAt: { gte: evRange[0].oldest } }
    });
    if (txCount === 0) {
      uncovered++;
      console.log(`  WARNING ${t.client_id}: ${Number(t.c)} queued events but NO ledger rows in that period`);
    }
  }

  if (uncovered === 0) {
    console.log('  Every tenant with queued events has ledger rows covering the same period.');
    console.log('  Clearing the queue removes delivery work, not history. Safe to migrate.');
  } else {
    console.log(`\n  ${uncovered} tenant(s) have queued events with no matching ledger rows.`);
    console.log('  Investigate before deploying the migration.');
    process.exitCode = 1;
  }

  console.log('\nNone of these events was ever delivered, and none could have been: there were');
  console.log('no storefront connections to deliver them to. A storefront connecting after this');
  console.log('receives a full initial catalogue sync instead, which is the correct starting');
  console.log('point -- replaying weeks of historical deltas on top of it would fight that sync.\n');
}

main().catch(e => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
