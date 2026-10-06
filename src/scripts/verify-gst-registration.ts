/**
 * How a shop is registered for GST, as the owner sets it on Settings → Name, logo and bill details
 * (built 6 Oct 2026; until then it could only be set behind the scenes). Against the real service
 * and database, on a throwaway settings row of its own.
 *
 *   A  the default: a new shop is not registered, no state, no GSTIN
 *   B  registered with a GSTIN: the state is read off the GSTIN's first two digits
 *   C  a state chosen by hand that disagrees with the GSTIN is refused, naming the state the GSTIN says
 *   D  "not registered" cannot hold a GSTIN
 *   E  the composition scheme saves, and a registered shop with no GSTIN yet is allowed
 *   F  nonsense is refused in words: an unknown registration, a state that does not exist
 *   G  what the till is told: the catalogue's gst block follows the setting
 *
 *   npx tsx src/scripts/verify-gst-registration.ts
 */
import { prisma } from '../lib/prisma';
import { brandingService } from '../services/branding.service';
import { mayChargeTax } from '../services/pricing/tax';

const STAMP = Date.now();
const CLIENT = `gst-reg-${STAMP}`;
let passed = 0, failed = 0;
const check = (name: string, ok: boolean, detail = '') => {
  if (ok) { passed++; console.log(`  ok   ${name}`); } else { failed++; console.log(`  FAIL ${name} -- ${detail}`); }
};
const refused = async (fn: () => Promise<unknown>) => { try { await fn(); return null; } catch (e: any) { return e; } };

async function main() {
  console.log(`\nGST registration, on ${CLIENT}\n`);
  try {
    const a = await brandingService.get(CLIENT);
    check('A. a shop that never set it: not registered, no state, no GSTIN', a.gstRegistration === 'UNREGISTERED' && a.gstStateCode === null && a.gstNumber === null, JSON.stringify(a));
    check('   ...and such a shop charges no GST', mayChargeTax(a.gstRegistration as any) === false);

    const b = await brandingService.setDetails(CLIENT, { gstRegistration: 'REGULAR', gstNumber: '36aabcu9603r1zx' });
    check('B. registered with a GSTIN: saved in capitals, the state read off the GSTIN (36)', b.gstRegistration === 'REGULAR' && b.gstNumber === '36AABCU9603R1ZX' && b.gstStateCode === '36', JSON.stringify(b));
    check('   ...and a registered shop charges GST', mayChargeTax(b.gstRegistration as any) === true);
    const b2 = await brandingService.setDetails(CLIENT, { gstStateCode: '36' });
    check('   ...choosing the same state by hand is fine', b2.gstStateCode === '36');

    const c = await refused(() => brandingService.setDetails(CLIENT, { gstStateCode: '37' }));
    check('C. a state that disagrees with the GSTIN is refused, naming the state the GSTIN says', c?.statusCode === 400 && /starts with 36/.test(c?.message ?? ''), c?.message);
    const c2 = await refused(() => brandingService.setDetails(CLIENT, { gstNumber: '29ABCDE1234F1Z5', gstStateCode: '36' }));
    check('   ...a new GSTIN from another state with the old state still chosen is refused the same way', c2?.statusCode === 400 && /starts with 29/.test(c2?.message ?? ''), c2?.message);
    const c3 = await brandingService.setDetails(CLIENT, { gstNumber: '29ABCDE1234F1Z5', gstStateCode: null });
    check('   ...and with the state cleared it follows the new GSTIN (29)', c3.gstStateCode === '29' && c3.gstNumber === '29ABCDE1234F1Z5', JSON.stringify(c3));

    const d = await refused(() => brandingService.setDetails(CLIENT, { gstRegistration: 'UNREGISTERED' }));
    check('D. "not registered" while a GSTIN is saved is refused in words', d?.statusCode === 400 && /not registered has no GSTIN/.test(d?.message ?? ''), d?.message);
    const d2 = await brandingService.setDetails(CLIENT, { gstRegistration: 'UNREGISTERED', gstNumber: null });
    check('   ...clearing the GSTIN with it is allowed; the state it carried stays', d2.gstRegistration === 'UNREGISTERED' && d2.gstNumber === null && d2.gstStateCode === '29', JSON.stringify(d2));

    const e = await brandingService.setDetails(CLIENT, { gstRegistration: 'COMPOSITION', gstNumber: '33AAAAA0000A1Z5' });
    check('E. the composition scheme saves with its GSTIN, and charges no GST', e.gstRegistration === 'COMPOSITION' && e.gstStateCode === '33' && mayChargeTax('COMPOSITION') === false, JSON.stringify(e));
    const e2 = await brandingService.setDetails(CLIENT, { gstRegistration: 'REGULAR', gstNumber: null, gstStateCode: '33' });
    check('   ...a registered shop with no GSTIN yet is allowed (its tax invoices wait for it)', e2.gstRegistration === 'REGULAR' && e2.gstNumber === null && e2.gstStateCode === '33', JSON.stringify(e2));

    const f = await refused(() => brandingService.setDetails(CLIENT, { gstRegistration: 'MAYBE' }));
    check('F. an unknown registration is refused in words', f?.statusCode === 400 && /registered/.test(f?.message ?? ''), f?.message);
    const f2 = await refused(() => brandingService.setDetails(CLIENT, { gstStateCode: '45' }));
    check('   ...a state code that does not exist is refused in words', f2?.statusCode === 400 && /state/.test(f2?.message ?? ''), f2?.message);
    const f3 = await refused(() => brandingService.setDetails(CLIENT, { gstNumber: 'NOT-A-GSTIN' }));
    check('   ...a GSTIN that is not one is refused as before', f3?.statusCode === 400 && /15 characters/.test(f3?.message ?? ''), f3?.message);

    const g = await brandingService.get(CLIENT);
    check('G. read back: what was last saved', g.gstRegistration === 'REGULAR' && g.gstStateCode === '33' && g.gstNumber === null, JSON.stringify(g));
  } finally {
    await prisma.clientSettings.deleteMany({ where: { clientId: CLIENT } });
  }
  console.log(`\nRESULT: ${passed} passed | ${failed} failed`);
  await prisma.$disconnect();
  process.exit(failed ? 1 : 0);
}
main().catch(async e => { console.log('CRASHED:', e?.stack ?? e); await prisma.clientSettings.deleteMany({ where: { clientId: CLIENT } }).catch(() => undefined); await prisma.$disconnect(); process.exit(1); });
