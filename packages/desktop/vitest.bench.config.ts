/** Benchmarks: the E2E launcher plus measurement. Run through `npm run bench`; never part of `npm test`. */
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { name: 'bench', environment: 'node', pool: 'forks', fileParallelism: false, include: ['test/bench/**/*.bench.ts'], env: { NODE_ENV: 'test' } },
});
