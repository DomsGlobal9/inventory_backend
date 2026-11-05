/**
 * Load a shop's earlier customers and bills from a cleaned file. Real people's data: this prints counts only,
 * and the file itself never goes in git.
 *
 *   npx tsx src/scripts/import-past-customers.ts --client <clientId> --source <name> --file <path>          what it would do; writes nothing
 *   npx tsx src/scripts/import-past-customers.ts --client <clientId> --source <name> --file <path> --apply  load it
 *   npx tsx src/scripts/import-past-customers.ts --client <clientId> --source <name> --undo                 what undo would take out
 *   npx tsx src/scripts/import-past-customers.ts --client <clientId> --source <name> --undo --apply         take it back out
 *
 * It uses whichever database DATABASE_URL points at, and says which host before doing anything.
 */
import fs from 'fs';
import { prisma } from '../lib/prisma';
import { applyImport, hashOf, ImportFile, ImportRefused, plan, undoImport } from '../services/past-purchases/importer';

const argv = process.argv.slice(2);
const value = (name: string) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : undefined; };
const flag = (name: string) => argv.includes(`--${name}`);
const host = () => { try { return new URL(process.env.DATABASE_URL ?? '').hostname; } catch { return 'unknown'; } };

async function main() {
  const clientId = value('client'), source = value('source'), path = value('file');
  if (!clientId || !source) throw new ImportRefused('Say which shop and which load: --client <clientId> --source <name>.');
  console.log(`Database: ${host()}`);
  console.log(`Shop: ${clientId}   Load: ${source}`);

  const users = await prisma.user.count({ where: { clientId } });
  if (!users) throw new ImportRefused(`There is no shop with the client id ${clientId} here (no users). Nothing was changed.`);

  if (flag('undo')) {
    const [bills, made] = await Promise.all([
      prisma.pastPurchase.count({ where: { clientId, source } }),
      prisma.customer.count({ where: { clientId, importSource: source } })
    ]);
    console.log(`Past bills in this load: ${bills}. Customers it made: ${made}.`);
    if (!flag('apply')) { console.log('Nothing changed. Add --apply to take it back out.'); return; }
    const r = await undoImport(clientId, source);
    console.log(`Done. Bills removed: ${r.billsRemoved}. Customers removed: ${r.customersRemoved}. Kept because something real has happened to them: ${r.customersKept}.`);
    return;
  }

  if (!path) throw new ImportRefused('Say which file: --file <path>.');
  const text = fs.readFileSync(path, 'utf8');
  const file = JSON.parse(text) as ImportFile;
  const hash = hashOf(text);
  const p = await plan(clientId, source, file, hash);
  console.log(`Customers this shop has now: ${p.liveCustomers}. CRM switched on: ${p.crmOn ? 'yes' : 'no'}.`);
  console.log(`In the file: ${p.customersInFile} customers, ${p.billsInFile} bills.`);
  console.log(`New customers: ${p.customersToCreate}. Already here, details left alone: ${p.customersAlreadyHere}.`);
  console.log(`Bills to add: ${p.billsToAdd}. Already here: ${p.billsAlreadyHere}.`);
  if (p.numbersLeftOut) console.log(`Numbers that cannot be phones, left out: ${p.numbersLeftOut}, with ${p.billsLeftOutWithThem} bills.`);
  if (p.customersWithNoName) console.log(`No name in the file, saved as "Customer" + the last 4 digits: ${p.customersWithNoName}.`);
  if (p.finishedAt) console.log(`This load already finished on ${p.finishedAt.toISOString()}.`);
  if (p.sameFile === false) console.log('This load was started from a different file.');

  if (!flag('apply')) { console.log('Nothing changed. Add --apply to load it.'); return; }
  const r = await applyImport(clientId, source, file, hash, (done, total) => console.log(`  ${done} of ${total}`));
  if (r.already) { console.log('Already loaded, so nothing changed.'); return; }
  console.log(`Done. Customers made: ${r.created}. Already here: ${r.matched}. Bills added: ${r.added}. Nothing was sent to anyone.`);
}

main()
  .catch(e => {
    console.error(e instanceof ImportRefused ? `Refused: ${e.message}` : `Failed: ${e?.message ?? e}`);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
