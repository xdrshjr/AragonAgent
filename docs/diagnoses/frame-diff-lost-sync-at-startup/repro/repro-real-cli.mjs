/**
 * End-to-end repro: launch the REAL aragon TUI inside a real PTY (node-pty),
 * let it start, and capture every byte it emits. The frame-differ fallback
 * notice is expected to appear within the first seconds of startup.
 *
 * Run from the repo root:
 *   node docs/diagnoses/frame-diff-lost-sync-at-startup/repro/repro-real-cli.mjs
 */

import { spawn } from 'node:child_process';
import * as pty from 'node-pty';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const home = join(here, '.aragon-home');
mkdirSync(home, { recursive: true });

const env = {
  ...process.env,
  ARAGON_HOME: home,
  ARAGON_UPDATE: 'off', // keep the run offline and deterministic
  CI: '',               // never take ink's is-ci branch
};

const term = process.platform === 'win32' ? 'windows-pty' : 'xterm-256color';
const proc = pty.spawn(
  process.execPath,
  [join(here, '..', '..', '..', '..', 'packages', 'cli', 'dist', 'cli.js')],
  { name: term, cols: 100, rows: 24, cwd: here, env, useConpty: true },
);

let out = '';
proc.onData((data) => { out += data; });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await sleep(6000); // let the TUI mount and settle

try { proc.write('/exit\r'); } catch { /* already gone */ }
await sleep(1500);
try { proc.kill(); } catch { /* already gone */ }
await sleep(500);

const NOTICE = 'Frame diffing lost sync';
const idx = out.indexOf(NOTICE);
const esc = (s) => s.replace(/\x1b/g, 'ESC');

console.log('=== real aragon CLI in a PTY (24 rows x 100 cols) ===');
console.log(`bytes captured        : ${out.length}`);
console.log(`notice text present   : ${idx >= 0 ? 'YES  <-- the reported bug' : 'no'}`);
console.log(`cursor-hide (ESC[?25l): ${out.includes('\x1b[?25l') ? 'written at startup' : 'absent'}`);
console.log(`clearTerminal(ESC[2J\\x1b[3J\\x1b[H right after it: ${out.includes('\x1b[2J\x1b[3J\x1b[H') ? 'present (ink.js:121)' : 'absent'}`);
if (idx >= 0) {
  console.log('\n--- context around the notice (escaped) ---');
  console.log(esc(out.slice(Math.max(0, idx - 400), idx + 220)));
}
writeFileSync(join(here, 'pty-capture.txt'), out, 'utf8');
console.log(`\nraw capture saved to docs/diagnoses/frame-diff-lost-sync-at-startup/repro/pty-capture.txt`);

// Silence an unused-import lint in some setups; spawn is kept for debugging.
void spawn;
