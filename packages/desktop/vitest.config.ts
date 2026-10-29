import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

const here = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'node',
          environment: 'node',
          env: { NODE_ENV: 'test' },
          include: ['src/{main,host,shared,preload}/**/*.test.ts', 'test/**/*.test.ts'],
          testTimeout: 20_000,
          // Tests that point ARAGON_HOME at a temp dir mutate process.env, so each file gets
          // its own process rather than sharing one with its neighbours.
          pool: 'forks',
        },
        resolve: { alias: [{ find: /^@\//, replacement: `${here}src/renderer/` }] },
      },
      {
        plugins: [react()],
        test: {
          name: 'jsdom',
          environment: 'jsdom',
          // Shells with NODE_ENV=production would load React's production build, where `act` does not exist.
          env: { NODE_ENV: 'test' },
          include: ['src/renderer/**/*.test.{ts,tsx}'],
          setupFiles: ['src/renderer/test-setup.ts'],
        },
        // The same `node:*` shims the production bundle uses (vite.config.ts): the view model
        // imports them, and jsdom has no such built-ins, so tests must resolve them identically.
        resolve: {
          alias: [
            { find: /^node:process$/, replacement: `${here}src/renderer/shims/process.ts` },
            { find: /^node:crypto$/, replacement: `${here}src/renderer/shims/crypto.ts` },
            { find: /^node:path$/, replacement: `${here}src/renderer/shims/path.ts` },
            { find: /^@\//, replacement: `${here}src/renderer/` },
          ],
        },
      },
    ],
  },
});
