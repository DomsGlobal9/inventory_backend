/**
 * LOCAL ONLY. Shops for the end-to-end UI robots (PLAN-help/robot/check-nocrm-flows.mjs and check-crm-identity-ui.mjs):
 *   - "nocrm-ui-test": a shop WITHOUT CRM (Inventory + the POS till only);
 *   - "crm-identity-test": CRM's test shop (its Inventory side made by setup-crm-identity-ui.ts).
 * Each gets one store, a saree in stock (25), and a till key (a POS connection, as a real till holds). The owner
 * token and the till key are written to PLAN-help/robot/demo-nocrm.json and tills.json (local robot files, never in
 * git; the key is a test key for this local database only). Safe to run again: it renews the key and the token.
 *
 *   DATABASE_URL/DIRECT_URL=local npx tsx src/scripts/setup-ui-flows.ts
 */
import fs from 'node:fs';
import { prisma } from '../lib/prisma';
import { AuthService } from '../services/auth.service';
import { seedRolesForClient } from '../services/rbac-seed.service';
import { generateCredential } from '../utils/storefrontCredential';
import { POS_BASE_URL } from '../utils/posConnection';

for (const k of ['DATABASE_URL', 'DIRECT_URL']) {
  if (!/localhost:55433/.test(process.env[k] ?? '')) { console.error(`Refusing: ${k} is not the local database.`); process.exit(2); }
}
const ROBOT = 'D:/villy/inventory/PLAN-help/robot';

async function shop(clientId: string, name: string) {
  const roles = await seedRolesForClient(clientId);
  await prisma.clientSettings.upsert({
    where: { clientId },
    create: { clientId, businessName: name, timezone: 'Asia/Kolkata', setupDoneAt: new Date() } as any,
    update: { setupDoneAt: new Date() } as any
  });
  const store = await prisma.stockLocation.findFirst({ where: { clientId, type: 'STORE' } })
    ?? await prisma.stockLocation.create({ data: { clientId, code: 'MAIN', name: 'Main Store', type: 'STORE' } });
  const email = `${clientId}-owner@example.invalid`;
  let owner = await prisma.user.findFirst({ where: { clientId, role: undefined, email } as any })
    ?? await prisma.user.findFirst({ where: { clientId, roles: { some: { roleId: roles.SUPER_ADMIN } } } });
  if (!owner) {
    // No password anyone types: the robots sign in with a token.
    owner = await prisma.user.create({ data: { clientId, email, name: `${name} Owner`, password: await AuthService.hashPassword(`x-${Date.now()}-${Math.random()}`), status: 'ACTIVE' as any, tourSeenAt: new Date() } as any });
    await prisma.userRole.create({ data: { userId: owner.id, roleId: roles.SUPER_ADMIN } });
  }
  const code = `${clientId.toUpperCase().slice(0, 6)}-SAREE`;
  let product = await prisma.product.findFirst({ where: { clientId, productCode: code } });
  if (!product) {
    product = await prisma.product.create({ data: {
      clientId, productCode: code, slug: code.toLowerCase(), title: 'Cotton saree', category: 'WOMEN' as any, productType: 'READY_TO_WEAR' as any,
      dressType: 'Saree', fabric: 'Cotton', basePrice: 3000, status: 'ACTIVE' as any, publishedAt: new Date(),
      hsnCode: '5208', taxRateBps: 500, taxSlabbed: false, priceIsExclusive: false
    } as any });
  }
  let variant = await prisma.productVariant.findFirst({ where: { productId: product.id } });
  if (!variant) {
    variant = await prisma.productVariant.create({ data: { productId: product.id, clientId, colorName: 'Indigo', size: 'Free Size', variantCode: `${code}-IND`, sku: `${code}-IND`, sellingPrice: 3000 } as any });
  }
  const stock = await prisma.inventoryStock.findFirst({ where: { variantId: variant.id, locationId: store.id } });
  if (stock) await prisma.inventoryStock.update({ where: { id: stock.id }, data: { quantity: 25 } });
  else await prisma.inventoryStock.create({ data: { clientId, variantId: variant.id, locationId: store.id, quantity: 25 } as any });
  await prisma.storefrontConnection.deleteMany({ where: { clientId, name: 'UI robot till' } });
  const cred = generateCredential();
  await prisma.storefrontConnection.create({ data: { clientId, name: 'UI robot till', baseUrl: POS_BASE_URL, credentialHash: cred.hash, credentialPrefix: cred.prefix, status: 'ACTIVE', locationIds: [store.id] } as any });
  const token = AuthService.generateToken({ userId: owner.id, clientId, sessionVersion: (owner as any).sessionVersion });
  return { clientId, storeId: store.id, ownerName: owner.name, token, tillKey: cred.plaintext, itemCode: variant.variantCode };
}

(async () => {
  const off = await shop('nocrm-ui-test', 'No CRM Silks');
  await prisma.moduleSubscription.deleteMany({ where: { clientId: off.clientId, module: 'crm' } }); // never CRM
  const on = await shop('crm-identity-test', 'CRM Identity Silks');
  fs.writeFileSync(`${ROBOT}/demo-nocrm.json`, JSON.stringify({ clientId: off.clientId, storeId: off.storeId, note: 'shop WITHOUT CRM (setup-ui-flows.ts)', people: { owner: { name: off.ownerName, token: off.token } } }, null, 2));
  fs.writeFileSync(`${ROBOT}/tills.json`, JSON.stringify({ [off.clientId]: { key: off.tillKey, itemCode: off.itemCode }, [on.clientId]: { key: on.tillKey, itemCode: on.itemCode } }, null, 2));
  console.log(`ready: ${off.clientId} (no CRM) and ${on.clientId} (CRM), each with a till key and a saree in stock`);
  await prisma.$disconnect();
})().catch(async e => { console.error(e); await prisma.$disconnect(); process.exit(1); });
