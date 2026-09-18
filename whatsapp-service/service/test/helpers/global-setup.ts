import { execSync } from 'node:child_process';
import { loadDotEnv } from '../../src/lib/dotenv';

// Brings the throwaway test database to the current schema before the resilience tests.
export default function setup(): void {
  loadDotEnv();
  const url = process.env.TEST_DATABASE_URL;
  if (!url) {
    process.stdout.write('TEST_DATABASE_URL not set: resilience tests will be skipped.\n');
    return;
  }
  // Tests empty its tables between cases: never let it point at a real database.
  const dbName = new URL(url).pathname.replace(/^\//, '');
  if (!/test/i.test(dbName)) throw new Error(`TEST_DATABASE_URL must name a test database (got "${dbName}"); the tests empty its tables.`);
  execSync('npx prisma migrate deploy', {
    env: { ...process.env, DATABASE_URL: url, PRISMA_HIDE_UPDATE_MESSAGE: '1' },
    stdio: 'ignore',
  });
}
