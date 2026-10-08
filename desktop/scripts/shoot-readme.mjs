/** Capture a README screenshot of the app against seeded demo data. */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repo = path.resolve(desktop, '..');
const userData = path.join(process.env.TEMP ?? '.', 'aragon-desktop-shot');
const out = path.join(repo, 'logo', 'desktop-screenshot.png');

rmSync(userData, { recursive: true, force: true });
const seed = spawnSync('node', [path.join('scripts', 'seed-demo.mjs'), userData], {
  cwd: desktop,
  stdio: 'inherit',
});
if (seed.status !== 0) process.exit(1);

mkdirSync(path.dirname(out), { recursive: true });
const shot = spawnSync('npx', ['electron', '.'], {
  cwd: desktop,
  stdio: 'inherit',
  shell: true,
  env: {
    ...process.env,
    ARAGON_DESKTOP_USER_DATA: userData,
    ARAGON_DESKTOP_SCREENSHOT: out,
  },
});
if (shot.status !== 0) {
  console.error('electron screenshot run failed');
  process.exit(1);
}
if (!existsSync(out)) {
  console.error('screenshot file missing');
  process.exit(1);
}
console.log(`screenshot at ${out}`);
