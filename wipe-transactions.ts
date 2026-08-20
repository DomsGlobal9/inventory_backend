import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function main() {
  await prisma.inventoryTransaction.deleteMany({});
  console.log("Deleted all inventory transactions");
}
main().catch(console.error).finally(() => prisma.$disconnect());
