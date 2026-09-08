/**
 * The shopper try-on flow against the REAL gateway, end to end.
 *
 * verify-shopper-tryon-e2e.ts proves the logic with a stand-in gateway and is the one to run
 * routinely -- it is fast, free and deterministic. This one proves the parts a stand-in cannot:
 * that the base URL is right, that the key authenticates, that the microservice behind the
 * gateway accepts what we actually send it, and that a real image comes back.
 *
 * It COSTS a real generation and takes 10-25 seconds, so it is deliberately not part of the
 * routine suite.
 *
 *   npx ts-node src/scripts/verify-shopper-tryon-live.ts
 */
import express from 'express';
import { AddressInfo } from 'net';
import { prisma } from '../lib/prisma';
import { env } from '../config/env';
import { tryOnUsageService } from '../services/tryon';
import { shopperTryOnProductService } from '../services/shopper-tryon';
import publicRoutes from '../routes/shopper-tryon-public.routes';

let passed = 0, failed = 0;
const failures: string[] = [];
const check = (name: string, ok: boolean, detail?: string) => {
  if (ok) { passed++; console.log(`  [PASS] ${name}`); }
  else { failed++; failures.push(name); console.log(`  [FAIL] ${name}${detail ? `  -> ${detail}` : ''}`); }
};

/** The try-on app's own model asset -- a person, publicly fetchable, and ours to use. */
const HUMAN = 'https://www.tryon2buy.com/assets/ui/tryon-models.png';

const GATEWAY_CATEGORIES = ['SAREE', 'LEHANGA', 'ANARKALI', 'SHARARA', 'KURTHI', 'DEFAULT'];

async function main() {
  console.log('CONFIGURATION');
  check('a shopper gateway url is set', !!env.SHOPPER_TRYON_GATEWAY_URL, String(env.SHOPPER_TRYON_GATEWAY_URL));
  check('a shared fallback key is set', !!env.SHOPPER_TRYON_API_KEY,
    env.SHOPPER_TRYON_API_KEY ? `${env.SHOPPER_TRYON_API_KEY.slice(0, 12)}...` : 'missing');
  check('a scan destination is set', !!env.SHOPPER_TRYON_APP_URL, String(env.SHOPPER_TRYON_APP_URL));

  if (!env.SHOPPER_TRYON_GATEWAY_URL || !env.SHOPPER_TRYON_API_KEY) {
    console.log('\nNot configured; stopping before spending a generation.');
    process.exitCode = 1;
    return;
  }

  // A real published garment with a real, publicly reachable photograph.
  const anyImage = await prisma.productImage.findFirst({
    where: { url: { startsWith: 'https://' }, product: { status: 'ACTIVE' } },
    select: { product: { select: { id: true, clientId: true, productCode: true, title: true } } },
    orderBy: { createdAt: 'desc' }
  });
  if (!anyImage?.product) {
    console.log('No published product with an image to test against.');
    return;
  }

  const { id: productId, clientId, productCode, title } = anyImage.product;

  // The garment the tag leads with, ordered the way the service orders it. Comparing against
  // the most RECENTLY UPLOADED image instead is what failed this check on the first run -- and
  // the service was right: a shopper scanning a tag should see the primary photograph, not
  // whichever one staff happened to add last.
  const image = (await prisma.productImage.findFirst({
    where: { productId },
    orderBy: [{ isPrimary: 'desc' }, { orderIndex: 'asc' }],
    select: { url: true }
  }))!;
  console.log(`\nUsing ${clientId} / ${productCode} -- "${title}"`);

  console.log('\nBOTH IMAGES ARE FETCHABLE BY THE GATEWAY');
  // The gateway downloads these itself. If either is unreachable the generation fails deep
  // inside it, twenty seconds after a shopper pressed the button -- so it is checked up front.
  for (const [label, url] of [['the garment', image.url], ['the person', HUMAN]] as const) {
    const got = await fetch(url, { headers: { Range: 'bytes=0-64' } }).catch(() => null);
    check(`${label} is publicly reachable`, !!got && got.status < 400,
      got ? `${got.status} ${got.headers.get('content-type')}` : 'unreachable');
  }

  const app = express();
  app.use(express.json());
  app.use('/public/tryon', publicRoutes);
  const server = app.listen(0, '127.0.0.1');
  await new Promise(r => server.once('listening', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/public/tryon`;

  try {
    console.log('\nSCANNING THE PRINTED CODE');
    console.log(`  the QR would carry: ${shopperTryOnProductService.scanUrlFor(clientId, productCode)}`);

    const scan = await fetch(`${base}/${clientId}/${productCode}`);
    const scanBody: any = await scan.json();
    check('the code resolves to the garment', scan.status === 200, String(scan.status));
    check('with the photograph the tag leads with', scanBody?.data?.imageUrl === image.url,
      `${String(scanBody?.data?.imageUrl).slice(-40)} vs ${image.url.slice(-40)}`);
    check('and a category the gateway accepts',
      GATEWAY_CATEGORIES.includes(scanBody?.data?.category), String(scanBody?.data?.category));

    console.log('\nA REAL GENERATION, THROUGH THE REAL GATEWAY');
    console.log('  (10-25 seconds, and it spends one real generation)');
    const usageBefore = await tryOnUsageService.summary(clientId, undefined, 'SHOPPER_TRYON');

    const startedAt = Date.now();
    const gen = await fetch(`${base}/${clientId}/${productCode}/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ humanImageUrl: HUMAN })
    });
    const genBody: any = await gen.json().catch(() => ({}));
    const took = Date.now() - startedAt;

    check('the gateway accepted our request', gen.status === 200,
      `${gen.status} ${JSON.stringify(genBody).slice(0, 220)}`);
    check('a finished picture came back',
      typeof genBody?.data?.resultImageUrl === 'string' && genBody.data.resultImageUrl.startsWith('http'),
      String(genBody?.data?.resultImageUrl));
    console.log(`         (took ${(took / 1000).toFixed(1)}s)`);

    if (genBody?.data?.resultImageUrl) {
      console.log(`  RESULT: ${genBody.data.resultImageUrl}`);
      const fetched = await fetch(genBody.data.resultImageUrl, { headers: { Range: 'bytes=0-64' } })
        .catch(() => null);
      // A URL that does not resolve is the same as no result to the shopper looking at it.
      check('and the picture it points at actually loads', !!fetched && fetched.status < 400,
        fetched ? String(fetched.status) : 'unreachable');
    }

    // No key material may appear anywhere in what reaches the browser.
    check('the key is nowhere in the response',
      !JSON.stringify(genBody).includes(env.SHOPPER_TRYON_API_KEY as string));

    console.log('\nIT WAS METERED AGAINST THE RIGHT SHOP AND THE RIGHT SERVICE');
    const catalogBefore = await tryOnUsageService.summary(clientId, undefined, 'CATALOG_TRYON');

    const settle = async (reached: (s: any) => boolean) => {
      const t0 = Date.now();
      let last = await tryOnUsageService.summary(clientId, undefined, 'SHOPPER_TRYON');
      while (!reached(last) && Date.now() - t0 < 10000) {
        await new Promise(r => setTimeout(r, 150));
        last = await tryOnUsageService.summary(clientId, undefined, 'SHOPPER_TRYON');
      }
      return last;
    };

    const after = await settle(s => s.generations > usageBefore.generations);
    check('the shopper meter went up by one',
      after.generations === usageBefore.generations + 1,
      `${usageBefore.generations} -> ${after.generations}`);

    // The reason TryOnUsage needed a service column at all.
    const catalogAfter = await tryOnUsageService.summary(clientId, undefined, 'CATALOG_TRYON');
    check('and the catalog meter did not move',
      catalogAfter.generations === catalogBefore.generations,
      `${catalogBefore.generations} -> ${catalogAfter.generations}`);

    console.log(`\n================ RESULT: ${passed} passed | ${failed} failed ================`);
    if (failures.length) {
      console.log('\nFailed:');
      for (const f of failures) console.log(`  - ${f}`);
      process.exitCode = 1;
    }
  } finally {
    server.close();
    await prisma.$disconnect();
  }
}

main().catch(error => {
  console.error('\nSuite did not finish:', error?.message ?? error);
  process.exitCode = 1;
});
