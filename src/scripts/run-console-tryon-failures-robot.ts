/**
 * Runs PLAN-help/robot/check-console-tryon-failures.mjs: seeds try-on failures for a throwaway
 * shop id, signs a console session for an active platform admin (never printed), runs the robot,
 * and deletes the seeded rows whatever happens.
 *
 *   npx tsx src/scripts/run-console-tryon-failures-robot.ts
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { prisma } from '../lib/prisma';
import { AuthService } from '../services/auth.service';

const C = `tryon-ui-${Date.now()}`;

async function main() {
  const admin = await prisma.platformAdmin.findFirst({ where: { status: 'ACTIVE' }, select: { id: true, sessionVersion: true } });
  if (!admin) throw new Error('No active platform admin to sign in as.');
  // A real FAILED colour job (product lent by the demo help-shop) so the list can name it "Colour photos".
  const lent = await prisma.product.findFirst({ where: { clientId: 'lakshmi-silks-demo-helpshop-1791264977589' }, select: { id: true } });
  const colour = await prisma.photoJob.create({
    data: { clientId: C, productId: lent!.id, kind: 'COLOUR', status: 'FAILED', colourName: 'Red', colourKey: 'red', variantIds: [], sourceImageUrl: 'https://example.com/x.jpg', jobKey: 'colour-red', category: 'SAREE', modelId: 'saree1' } as any
  });
  await prisma.tryOnFailure.createMany({
    data: [
      ...Array.from({ length: 5 }, (_, i) => ({
        clientId: C, service: 'CATALOG_TRYON', place: 'PHOTO_JOB', httpStatus: 429, code: 'STUDIO_REFUSED',
        error: `RESOURCE_EXHAUSTED: monthly spending cap reached for this project (request ${i})`,
        shownMessage: 'The photo studio could not be reached just now. Your photos are safe -- please try again in a minute.',
        productId: 'product-ui', jobId: `job-ui-${i}`, attempt: 1
      })),
      { clientId: C, service: 'SHOPPER_TRYON', place: 'SHOP_PAGE', httpStatus: 504, code: 'TIMEOUT', error: 'No answer within 90 s; the request was stopped.', shownMessage: 'The try-on took too long and was stopped. Please try again.' },
      { clientId: C, service: 'CATALOG_TRYON', place: 'PHOTO_JOB', code: 'STUDIO_ERROR', error: 'COLOUR_RUN_BROKE: copying the colour failed', jobId: colour.id, attempt: 1 }
    ]
  });
  const run = spawnSync('node', ['check-console-tryon-failures.mjs'], {
    cwd: path.resolve(__dirname, '../../../PLAN-help/robot'), stdio: 'inherit',
    env: { ...process.env, TEST_CLIENT: C, CONSOLE_TOKEN: AuthService.generatePlatformAdminToken({ platformAdminId: admin.id, sessionVersion: admin.sessionVersion }) }
  });
  process.exitCode = run.status ?? 1;
}

main().catch(e => { console.error(e); process.exitCode = 1; }).finally(async () => {
  await prisma.tryOnFailure.deleteMany({ where: { clientId: C } });
  await prisma.photoJob.deleteMany({ where: { clientId: C } });
  await prisma.$disconnect();
});
