/**
 * The Platform Console's onboarding form: what it refuses, and that every detail typed lands where
 * the app reads it -- the owner's mobile, the shop's phone and address, the first store, and GST
 * only when a GSTIN was given (GST is optional).
 *
 * Makes throwaway workspaces and deletes them. The credentials email goes to @example.com, the
 * reserved domain: it can never reach a person.
 *
 *   npx tsx src/scripts/verify-onboarding-form.ts
 */
import { prisma } from '../lib/prisma';
import { readOnboardingForm } from '../controllers/platform-admin.controller';
import { platformAdminService } from '../services/platform-admin.service';

let passed = 0, failed = 0;
const check = (name: string, ok: boolean, detail?: unknown) => {
  if (ok) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name}${detail !== undefined ? ` -- ${JSON.stringify(detail)}` : ''}`); }
};
const STAMP = Date.now();
const made: string[] = [];

async function main() {
  console.log('\nA. WHAT THE FORM REFUSES, IN WORDS');
  const base = { companyName: 'Lakshmi Silks', adminName: 'Lakshmi Narayanan', adminEmail: 'owner@example.com', ownerPhone: '98480 22338' };
  const p = (over: any) => (readOnboardingForm({ ...base, ...over }) as any).problem as string | undefined;
  check('no owner mobile: refused, asking for the owner\'s number', /owner/i.test(p({ ownerPhone: '' }) ?? ''), p({ ownerPhone: '' }));
  check('a mobile that is not a mobile (starts with 4): refused', /6, 7, 8 or 9/.test(p({ ownerPhone: '4848022338' }) ?? ''), p({ ownerPhone: '4848022338' }));
  check('a bad email: refused', /email/.test(p({ adminEmail: 'owner-at-shop' }) ?? ''));
  check('a bad GSTIN: refused, saying it is optional', /15 characters/.test(p({ gstin: '37ABC' }) ?? '') && /blank/.test(p({ gstin: '37ABC' }) ?? ''));
  check('a GSTIN from another state than the one chosen: refused, naming the state', /starts with 37/.test(p({ gstin: '37ABCDE1234F1Z5', stateCode: '36' }) ?? ''));
  check('a 5-digit PIN: refused', /6 digits/.test(p({ pin: '52000' }) ?? ''));
  const ok = readOnboardingForm({ ...base, shopPhone: '040 2345 6789', gstin: ' 37abcde1234f1z5 ' }) as any;
  check('a landline shop phone is fine; the mobile is stored as +91…; the GSTIN in capitals and its state taken from it',
    !ok.problem && ok.shopPhone === '040 2345 6789' && ok.ownerPhone === '+919848022338' && ok.gstin === '37ABCDE1234F1Z5' && ok.stateCode === '37', ok);

  console.log('\nB. A SHOP ONBOARDED WITH EVERYTHING');
  const full = readOnboardingForm({ ...base, companyName: `Onboard Full ${STAMP}`, adminEmail: `full-${STAMP}@example.com`, shopPhone: '040 2345 6789', address: '12-4-56, Main Bazaar', city: 'Vijayawada', stateCode: '37', pin: '520001', storeName: 'Lakshmi Main', gstin: '37ABCDE1234F1Z5' }) as any;
  const { companyName, adminName, adminEmail, ...more } = full;
  const r1 = await platformAdminService.onboardClient(companyName, adminName, adminEmail, null, more);
  made.push(r1.clientId);
  const s1 = await prisma.clientSettings.findUnique({ where: { clientId: r1.clientId } });
  const u1 = await prisma.user.findFirst({ where: { clientId: r1.clientId } });
  const st1 = await prisma.stockLocation.findFirst({ where: { clientId: r1.clientId } });
  const wa1 = await prisma.whatsAppSettings.findUnique({ where: { clientId: r1.clientId } });
  check('the owner\'s mobile is on the owner', u1?.phone === '+919848022338', u1?.phone);
  check('shop details: name, phone and the address as a bill prints it', s1?.businessName === companyName && s1?.businessPhone === '040 2345 6789' && s1?.businessAddress === '12-4-56, Main Bazaar, Vijayawada, Andhra Pradesh 520001', s1);
  check('GSTIN given: GST registered, GSTIN and state 37 saved', s1?.gstNumber === '37ABCDE1234F1Z5' && s1?.gstRegistration === 'REGULAR' && s1?.gstStateCode === '37', s1);
  check('the first store has the name typed, the address and the shop phone (the till prints these)', st1?.name === 'Lakshmi Main' && (st1 as any)?.address === s1?.businessAddress && (st1 as any)?.phone === '040 2345 6789', st1);
  check('the nightly Day Book is aimed at the owner\'s mobile (not the landline), and stays switched off', wa1?.dayBookTo === '919848022338' && !(wa1 as any)?.dayBookEnabled, wa1);

  console.log('\nC. A SHOP WITH NO GST AND ONLY WHAT IS REQUIRED');
  const min = readOnboardingForm({ ...base, companyName: `Onboard Min ${STAMP}`, adminEmail: `min-${STAMP}@example.com`, stateCode: '36' }) as any;
  const { companyName: c2, adminName: a2, adminEmail: e2, ...more2 } = min;
  const r2 = await platformAdminService.onboardClient(c2, a2, e2, null, more2);
  made.push(r2.clientId);
  const s2 = await prisma.clientSettings.findUnique({ where: { clientId: r2.clientId } });
  const st2 = await prisma.stockLocation.findFirst({ where: { clientId: r2.clientId } });
  check('no GSTIN: not registered (GST optional), no GSTIN, the state still kept', s2?.gstRegistration === 'UNREGISTERED' && !s2?.gstNumber && s2?.gstStateCode === '36', s2);
  check('no shop phone typed: the owner\'s mobile is the shop phone', s2?.businessPhone === '+919848022338', s2?.businessPhone);
  check('no store name typed: "Main Store"', st2?.name === 'Main Store', st2?.name);
}

main()
  .catch(e => { failed++; console.log('CRASHED:', e?.stack ?? e); })
  .finally(async () => {
    for (const id of made) await platformAdminService.deleteClientCompletely(id, id).catch((e: any) => console.log(`cleanup ${id}:`, e?.message));
    console.log(`\nRESULT: ${passed} passed | ${failed} failed`);
    await prisma.$disconnect();
    process.exit(failed ? 1 : 0);
  });
