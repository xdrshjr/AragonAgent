/**
 * Round-2 experiment E2: the production-shaped mechanism.
 *
 * The CLI itself (raw mode already on) spawns a helper that opens CONIN$ and ORs
 * ENABLE_VIRTUAL_TERMINAL_INPUT into the shared console input mode. Measures the
 * wall cost of that spawn, which is the number the trade-off table needs.
 *
 *   node probe-vt2.mjs <durationSeconds> <outFile> <helperPs1> <spawnAtSeconds>
 */

import fs from 'node:fs';
import process from 'node:process';
import { spawn } from 'node:child_process';

const seconds = Number(process.argv[2] ?? 9);
const outFile = process.argv[3] ?? 'probe-vt2.jsonl';
const helper = process.argv[4];
const spawnAt = Number(process.argv[5] ?? 2.5);
const out = fs.createWriteStream(outFile, { flags: 'a' });

const t0 = Date.now();
const log = (obj) => out.write(`${JSON.stringify({ t: Date.now() - t0, ...obj })}\n`);

log({ event: 'start', node: process.version, uv: process.versions.uv, stdinIsTTY: !!process.stdin.isTTY });

if (process.stdin.isTTY) process.stdin.setRawMode(true);
process.stdin.resume();

process.stdin.on('data', (buf) => {
  log({ event: 'data', hex: buf.toString('hex'), text: JSON.stringify(buf.toString('latin1')) });
});

setTimeout(() => {
  const started = Date.now();
  log({ event: 'helper_spawn_begin' });
  // stdio all 'ignore' ON PURPOSE: this is what a real CLI would do rather than
  // let a helper share the raw-mode stdin it is about to reconfigure.
  const child = spawn(
    'powershell.exe',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', helper, '-LogFile', `${outFile}.helper.log`],
    // windowsHide MUST stay false: Node maps it to CREATE_NO_WINDOW, which gives
    // the child a BRAND NEW console. The helper then reconfigures that one,
    // reports success, and changes nothing the CLI can observe.
    { stdio: ['ignore', 'ignore', 'ignore'], windowsHide: false },
  );
  child.on('exit', (code) => {
    log({ event: 'helper_exit', code, elapsedMs: Date.now() - started });
  });
  child.on('error', (err) => log({ event: 'helper_error', message: String(err) }));
}, spawnAt * 1000);

setTimeout(() => {
  log({ event: 'stop' });
  out.end(() => process.exit(0));
}, seconds * 1000);
