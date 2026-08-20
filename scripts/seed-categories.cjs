const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

// Only adds CATEGORIES since everything else is already seeded
const data = [
  { type: 'CATEGORY', value: 'WOMEN', label: 'Women', sortOrder: 0 },
  { type: 'CATEGORY', value: 'MEN',   label: 'Men',   sortOrder: 1 },
  { type: 'CATEGORY', value: 'KIDS',  label: 'Kids',  sortOrder: 2 },
];

async function main() {
  const result = await prisma.catalogConfig.createMany({
    data,
    skipDuplicates: true,
  });
  console.log(`✅ ${result.count} categories inserted.`);
}

main().catch(console.error).finally(() => prisma.$disconnect());
