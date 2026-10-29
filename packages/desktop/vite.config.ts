/**
 * Renderer bundle. The page is served over the custom `app://` protocol in production and by
 * Vite's dev server in development; either way it runs sandboxed with no Node, so the few
 * `node:*` imports inside `@aragon-agent/tui/model/**` are redirected to tiny shims (the
 * view model is otherwise pure - a contract test keeps it that way).
 */
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const here = fileURLToPath(new URL('.', import.meta.url));
const shim = (name: string): string => `${here}src/renderer/shims/${name}.ts`;

export default defineConfig({
  root: `${here}src/renderer`,
  base: './',
  plugins: [react()],
  resolve: {
    alias: [
      { find: /^node:process$/, replacement: shim('process') },
      { find: /^node:crypto$/, replacement: shim('crypto') },
      { find: /^node:path$/, replacement: shim('path') },
      { find: /^@\//, replacement: `${here}src/renderer/` },
    ],
  },
  build: {
    outDir: `${here}dist/renderer`,
    emptyOutDir: true,
    target: 'chrome130',
    sourcemap: false,
    chunkSizeWarningLimit: 1200,
  },
  server: { port: 5273, strictPort: true },
});
