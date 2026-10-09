/**
 * Keyboard-encoding probe for the Shift+Enter newline fix.
 *
 * Puts stdin in raw mode exactly the way Ink does, writes ONE keyboard
 * enhancement mode (selected by argv), then dumps every byte chunk that comes
 * back as one JSON line. The inject-*.ps1 harness pushes synthetic key events
 * through the shared console, so the bytes below are exactly what the stdin
 * filter would see for those keys in that mode.
 *
 *   node probe-keys.mjs <mode> <seconds> <outFile>
 *
 * mode: none | kitty1 | mok2 | win32 | query
 */
import fs from 'node:fs';
import process from 'node:process';

const mode = process.argv[2] ?? 'none';
const seconds = Number(process.argv[3] ?? 10);
const outFile = process.argv[4] ?? `probe-out-${mode}.jsonl`;
const out = fs.createWriteStream(outFile, { flags: 'a' });

const log = (obj) => out.write(`${JSON.stringify(obj)}\n`);

const ENABLE = {
  none: '',
  // kitty progressive enhancement: push flags=1 (disambiguate), pop one level.
  kitty1: '\x1b[>1u',
  // xterm modifyOtherKeys level 2; reset with `CSI > 4 m`.
  mok2: '\x1b[>4;2m',
  // Windows win32-input-mode (private mode 9001).
  win32: '\x1b[?9001h',
  // push kitty flags then ask the terminal what flags are active (CSI ? u).
  query: '\x1b[>1u\x1b[?u',
}[mode];
const DISABLE = {
  none: '',
  kitty1: '\x1b[<u',
  mok2: '\x1b[>4m',
  win32: '\x1b[?9001l',
  query: '\x1b[<u',
}[mode];

log({
  event: 'start',
  mode,
  node: process.version,
  platform: process.platform,
  stdinIsTTY: !!process.stdin.isTTY,
  stdoutIsTTY: !!process.stdout.isTTY,
  env: {
    TERM: process.env.TERM,
    TERM_PROGRAM: process.env.TERM_PROGRAM,
    WT_SESSION: process.env.WT_SESSION ? '<set>' : undefined,
  },
});

if (process.stdin.isTTY) process.stdin.setRawMode(true);
process.stdin.resume();
if (process.stdout.isTTY && ENABLE) process.stdout.write(ENABLE);

process.stdin.on('data', (buf) => {
  log({ event: 'data', hex: buf.toString('hex'), text: JSON.stringify(buf.toString('latin1')) });
});

const stop = () => {
  if (process.stdout.isTTY && DISABLE) process.stdout.write(DISABLE);
  log({ event: 'stop' });
  out.end(() => process.exit(0));
};

setTimeout(stop, seconds * 1000);
