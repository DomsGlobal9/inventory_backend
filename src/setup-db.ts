import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function main() {
  try {
    await prisma.$executeRawUnsafe(`ALTER TABLE "inventory_product_variants" ADD CONSTRAINT "ck_inventory_variant_quantity_non_negative" CHECK (quantity >= 0);`);
    console.log('Constraint added successfully');
  } catch (e: any) {
    if (e.message.includes('already exists')) {
      console.log('Constraint already exists');
    } else {
      console.error(e.message);
    }
  } finally {
    await prisma.$disconnect();
  }
}
main();
