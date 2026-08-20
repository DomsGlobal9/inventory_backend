const { PrismaClient } = require('@prisma/client');
const crypto = require('crypto');
const prisma = new PrismaClient();

const generateRandomCode = (prefix) => {
  return `${prefix}-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
};

async function main() {
  const variants = await prisma.productVariant.findMany({
    where: {
      OR: [
        { variantCode: null },
        { barcode: null }
      ]
    }
  });

  console.log(`Found ${variants.length} variants needing migration.`);

  for (const v of variants) {
    const variantCode = v.variantCode || generateRandomCode('VAR');
    const barcode = v.barcode || generateRandomCode('SVM');
    
    await prisma.productVariant.update({
      where: { id: v.id },
      data: { variantCode, barcode }
    });
    console.log(`Updated variant ${v.id} with ${variantCode} / ${barcode}`);
  }

  console.log('Done!');
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
