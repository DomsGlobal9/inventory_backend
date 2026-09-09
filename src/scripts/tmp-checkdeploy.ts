import { prisma } from '../lib/prisma';
(async () => {
  const rows: any = await prisma.$queryRawUnsafe(
    `SELECT column_name FROM information_schema.columns WHERE table_name='support_tickets' AND column_name='ticket_number'`
  );
  console.log('ticket_number column present:', rows.length > 0);
  const t: any = await prisma.$queryRawUnsafe(
    `SELECT COUNT(*)::int AS total, COUNT(ticket_number)::int AS numbered FROM support_tickets`
  );
  console.log('tickets:', JSON.stringify(t[0]));
  await prisma.$disconnect();
})();
