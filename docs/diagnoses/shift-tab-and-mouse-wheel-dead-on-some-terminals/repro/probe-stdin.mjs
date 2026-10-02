/**
 * Throwaway stdin probe — the §11 "Phase 0" probe the mouse-wheel spec asked for
 * and that was never run (mouse-wheel-region-routing/spec.md §11, "NOT RUN").
 *
 * Puts stdin in raw mode exactly the way Ink does, asks the terminal for SGR
 * mouse reporting exactly the way `ui/screen.ts` does, and dumps every byte that
 * comes back. Run it, then press Shift+Tab / Tab / Shift+Up and spin the wheel.
 *
 *   node probe-stdin.mjs [durationSeconds] [outFile]
 *
 * Writes one JSON line per chunk to `outFile` (default: probe-out.jsonl).
 */

import fs from 'node:fs';
import process from 'node:process';

const seconds = Number(process.argv[2] ?? 8);
const outFile = process.argv[3] ?? 'probe-out.jsonl';
const out = fs.createWriteStream(outFile, { flags: 'a' });

const log = (obj) => out.write(`${JSON.stringify(obj)}\n`);

log({
  event: 'start',
  node: process.version,
  uv: process.versions.uv,
  platform: process.platform,
  release: process.release?.name,
  stdinIsTTY: !!process.stdin.isTTY,
  stdoutIsTTY: !!process.stdout.isTTY,
  env: {
    TERM: process.env.TERM,
    TERM_PROGRAM: process.env.TERM_PROGRAM,
    WT_SESSION: process.env.WT_SESSION ? '<set>' : undefined,
    COLORTERM: process.env.COLORTERM,
    ConEmuANSI: process.env.ConEmuANSI,
    MSYSTEM: process.env.MSYSTEM,
    SSH_TTY: process.env.SSH_TTY,
    SESSIONNAME: process.env.SESSIONNAME,
  },
});

if (process.stdin.isTTY) process.stdin.setRawMode(true);
process.stdin.resume();

// Same pair `ui/screen.ts::ENABLE_MOUSE` writes.
if (process.stdout.isTTY) process.stdout.write('\x1b[?1000h\x1b[?1006h');

process.stdin.on('data', (buf) => {
  log({ event: 'data', hex: buf.toString('hex'), text: JSON.stringify(buf.toString('latin1')) });
});

const stop = () => {
  if (process.stdout.isTTY) process.stdout.write('\x1b[?1006l\x1b[?1000l');
  log({ event: 'stop' });
  out.end(() => process.exit(0));
};

setTimeout(stop, seconds * 1000);
