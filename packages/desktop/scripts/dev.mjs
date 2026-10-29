#!/usr/bin/env node
// Development: build main + preload once, serve the renderer with Vite (hot reload), and start
// Electron pointed at it. The main process and host are NOT hot-reloaded; restart after editing
// them (`npm run build -- --only=main` is fast).
import { spawn, spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const port = 5273;

const built = spawnSync('node', ['scripts/build.mjs', '--only=main'], { cwd: root, stdio: 'inherit' });
if (built.status !== 0) process.exit(built.status ?? 1);
const preload = spawnSync('node', ['scripts/build.mjs', '--only=preload'], { cwd: root, stdio: 'inherit' });
if (preload.status !== 0) process.exit(preload.status ?? 1);

const { createServer } = await import('vite');
const server = await createServer({ configFile: join(root, 'vite.config.ts') });
await server.listen(port);
const electronPath = (await import('electron')).default;
// Some terminals (VS Code, Claude Code) export ELECTRON_RUN_AS_NODE=1, which makes Electron
// behave as plain Node: `import 'electron'` then resolves to the npm package and the app dies
// on its first import. It must never reach the app.
const env = { ...process.env, ARAGON_DESKTOP_DEV_URL: `http://localhost:${port}` };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(electronPath, ['.'], { cwd: root, stdio: 'inherit', env });
child.on('exit', async (code) => { await server.close(); process.exit(code ?? 0); });
