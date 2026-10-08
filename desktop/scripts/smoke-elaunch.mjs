/** Verify the packaged Electron binary can run the staged runtime as Node (ESM check). */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const exe = path.join(desktop, 'release', 'win-unpacked', 'AragonAgent.exe');
const launcher = path.join(
  desktop,
  'agent-runtime',
  'node_modules',
  '@aragon-agent',
  'cli',
  'dist',
  'launcher.js',
);

const child = spawn(exe, [
  launcher,
  'exec',
  '--output-format', 'stream-json',
  '--no-save-session',
  '--max-turns', '1',
  '--session-id', 'desktop-elaunch-test',
  'hi',
], {
  cwd: process.env.TEMP,
  env: {
    ...process.env,
    ELECTRON_RUN_AS_NODE: '1',
    ARAGON_HOME: path.join(process.env.TEMP, 'aragon-elaunch'),
    ARAGON_PROVIDER: 'anthropic',
    ARAGON_MODEL: 'claude-sonnet-4-6',
    ANTHROPIC_API_KEY: 'sk-invalid-elaunch-test',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});

let buffer = '';
child.stdout.on('data', (chunk) => {
  buffer += chunk;
  const line = buffer.split('\n')[0];
  try {
    const event = JSON.parse(line);
    console.log('FIRST EVENT:', event.type, event.subtype ?? '', event.model ? JSON.stringify(event.model) : '');
    console.log('ELECTRON_RUN_AS_NODE LAUNCH OK');
    child.kill();
    process.exit(0);
  } catch {
    // first line incomplete; wait for more data
  }
});
child.stderr.on('data', (chunk) => process.stdout.write(`[stderr] ${chunk}`));
child.on('error', (error) => {
  console.error('spawn failed:', error.message);
  process.exit(1);
});
setTimeout(() => {
  console.log('TIMEOUT. stdout so far:', buffer.slice(0, 300));
  child.kill();
  process.exit(1);
}, 30000);
