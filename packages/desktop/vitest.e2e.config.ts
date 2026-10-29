/**
 * End-to-end tests: a REAL Electron window driven by Playwright, talking to a scripted local model.
 *
 * A separate configuration FILE, not a third `project` in `vitest.config.ts`: `vitest run` runs
 * every project in a config, so adding one there would make `npm test` launch Electron (and fail
 * on any machine without a display). `test/e2e-isolation.test.ts` pins that separation.
 *
 *   npm run test:e2e                       against the source build (`electron .`)
 *   ARAGON_E2E_APP=<exe> npm run test:e2e  against a packaged E2E-flavor build
 */
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'e2e',
    environment: 'node',
    pool: 'forks',
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 120_000,
    include: ['test/e2e/**/*.e2e.ts'],
    env: { NODE_ENV: 'test' },
  },
});
