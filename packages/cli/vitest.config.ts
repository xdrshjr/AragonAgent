import * as os from 'node:os';
import { defineConfig } from 'vitest/config';

const availableProcessors = os.availableParallelism?.() ?? os.cpus().length;
const maxWorkers = Math.min(4, Math.max(1, availableProcessors - 1));

// Self-contained vitest config for @aragon-agent/cli so `npm test` here does not
// inherit the host repo's root vitest.config.ts. The CLI ships React/Ink
// components (.tsx); every source/test file imports React, so the default JSX
// transform works under either the oxc or esbuild pipeline.
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    // Ink render tests are CPU-heavy and several assert short event-loop waits.
    // Using every worker makes the release gate flaky on high-core-count hosts.
    maxWorkers,
  },
});
