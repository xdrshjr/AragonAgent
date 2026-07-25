import { defineConfig } from 'vitest/config';

// Self-contained vitest config for @argon-agent/cli so `npm test` here does not
// inherit the host repo's root vitest.config.ts. The CLI ships React/Ink
// components (.tsx); every source/test file imports React, so the default JSX
// transform works under either the oxc or esbuild pipeline.
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
  },
});
