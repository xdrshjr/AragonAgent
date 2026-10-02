/**
 * Round-2 probe: same as probe-stdin.mjs, plus
 *   - a monotonic timestamp on every chunk so injections can be aligned, and
 *   - a scheduled setRawMode(false)->setRawMode(true) round trip at `toggleAt`
 *     seconds, which is what Ink does on unmount/remount and what would clobber
 *     an externally forced ENABLE_VIRTUAL_TERMINAL_INPUT if libuv re-applies it.
 *
 *   node probe-vt.mjs <durationSeconds> <outFile> <toggleAtSeconds>
 */

import fs from 'node:fs';
import process from 'node:process';

const seconds = Number(process.argv[2] ?? 8);
const outFile = process.argv[3] ?? 'probe-vt.jsonl';
const toggleAt = Number(process.argv[4] ?? 0);
const out = fs.createWriteStream(outFile, { flags: 'a' });

const t0 = Date.now();
const log = (obj) => out.write(`${JSON.stringify({ t: Date.now() - t0, ...obj })}\n`);

log({
  event: 'start',
  node: process.version,
  uv: process.versions.uv,
  platform: process.platform,
  stdinIsTTY: !!process.stdin.isTTY,
  stdoutIsTTY: !!process.stdout.isTTY,
});

if (process.stdin.isTTY) process.stdin.setRawMode(true);
process.stdin.resume();
if (process.stdout.isTTY) process.stdout.write('\x1b[?1000h\x1b[?1006h');

process.stdin.on('data', (buf) => {
  log({ event: 'data', hex: buf.toString('hex'), text: JSON.stringify(buf.toString('latin1')) });
});

if (toggleAt > 0) {
  setTimeout(() => {
    log({ event: 'rawmode_toggle_begin' });
    process.stdin.setRawMode(false);
    process.stdin.setRawMode(true);
    log({ event: 'rawmode_toggle_end' });
  }, toggleAt * 1000);
}

setTimeout(() => {
  if (process.stdout.isTTY) process.stdout.write('\x1b[?1006l\x1b[?1000l');
  log({ event: 'stop' });
  out.end(() => process.exit(0));
}, seconds * 1000);
