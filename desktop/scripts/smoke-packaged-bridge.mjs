/** Bridge check against the PACKAGED app (app:// protocol path). */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const exe = path.join(desktop, 'release', 'win-unpacked', 'AragonAgent.exe');

const child = spawn(exe, [], {
  env: { ...process.env, ARAGON_DESKTOP_BRIDGE_CHECK: '1' },
  stdio: ['ignore', 'pipe', 'pipe'],
});

let out = '';
child.stdout.on('data', (chunk) => {
  out += chunk;
  if (out.includes('[bridge-check]')) {
    console.log(out.trim());
    process.exit(out.includes('is object') ? 0 : 3);
  }
});
child.stderr.on('data', (chunk) => process.stdout.write(`[stderr] ${chunk}`));
child.on('exit', (code) => {
  console.log('exit code:', code);
  process.exit(code ?? 1);
});
setTimeout(() => {
  console.log('TIMEOUT waiting for bridge-check. stdout:', out.slice(0, 400));
  child.kill();
  process.exit(2);
}, 30000);
