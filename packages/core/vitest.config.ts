import { defineConfig } from 'vitest/config';

// Self-contained vitest config for @argon-agent/core so `npm test` here does not
// inherit the host repo's root vitest.config.ts (which wires a frontend
// setupFile). Keeps the package's smoke suite (AC7) runnable in isolation.
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
