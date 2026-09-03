import { prisma } from '../lib/prisma';
import { seedCatalogDefaultsForClient } from '../services/catalog-seed.service';

async function main() {
  const clients = await prisma.user.findMany({ distinct: ['clientId'], select: { clientId: true } });
  console.log(`Backfilling catalog defaults for ${clients.length} clients...`);

  for (const { clientId } of clients) {
    const result = await seedCatalogDefaultsForClient(clientId);
    console.log(`  ${clientId}: ensured ${result.itemCount} default items`);
  }

  console.log('Done.');
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
