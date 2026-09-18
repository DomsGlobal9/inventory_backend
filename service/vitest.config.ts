import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/unit/**/*.test.ts', 'test/resilience/**/*.test.ts'],
    environment: 'node',
    globalSetup: ['test/helpers/global-setup.ts'],
    // Resilience tests share one test database: run files one after another.
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
