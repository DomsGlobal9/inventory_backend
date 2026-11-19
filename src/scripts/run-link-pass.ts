/**
 * LOCAL test helper: run the CRM link job once for the shops named (on a live server it runs by itself every 30 seconds,
 * services/crm-identity/links.ts). Used by PLAN-help/robot/check-crm-shop-flows.mjs, whose local server runs no
 * background jobs.   npx tsx src/scripts/run-link-pass.ts <clientId> [<clientId> ...]
 */
import { prisma } from '../lib/prisma';
import { runLinkPass } from '../services/crm-identity';

for (const k of ['DATABASE_URL', 'DIRECT_URL']) {
  if (!/localhost:55433/.test(process.env[k] ?? '')) { console.error(`Refusing: ${k} is not the local database.`); process.exit(2); }
}
const shops = process.argv.slice(2);
if (!shops.length) { console.error('Name at least one shop.'); process.exit(2); }
runLinkPass({ onlyClients: shops })
  .then(r => console.log(JSON.stringify(r)))
  .finally(() => prisma.$disconnect());
