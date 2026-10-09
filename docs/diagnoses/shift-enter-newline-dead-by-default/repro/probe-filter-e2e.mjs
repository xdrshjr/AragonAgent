/**
 * E2E probe: run the REAL stdin filter against REAL terminal bytes.
 *
 * Raw mode like Ink, push ?9001h exactly like `enableKeyboardEnhancement`
 * does on win32, build the production `createStdinFilter` with
 * `enhancedKeys: true`, and dump every translated byte the filter hands to
 * Ink. The inject harness drives the shared console; what lands in the JSONL
 * is what the composer would receive.
 *
 *   node probe-filter-e2e.mjs <seconds> <outFile>
 */
import fs from 'node:fs';
import process from 'node:process';

const seconds = Number(process.argv[2] ?? 14);
const outFile = process.argv[3] ?? 'filter-e2e-out.jsonl';
const out = fs.createWriteStream(outFile, { flags: 'a' });
const log = (obj) => out.write(`${JSON.stringify(obj)}\n`);

const filterUrl = new URL(
  '../../../../packages/cli/dist/input/stdin-filter.js',
  import.meta.url,
);
const { createStdinFilter } = await import(filterUrl.href);

log({
  event: 'start',
  node: process.version,
  stdinIsTTY: !!process.stdin.isTTY,
  stdoutIsTTY: !!process.stdout.isTTY,
  WT_SESSION: process.env.WT_SESSION ? '<set>' : undefined,
});

if (process.stdin.isTTY) process.stdin.setRawMode(true);
const filter = createStdinFilter(process.stdin, {
  mouse: false,
  paste: true,
  enhancedKeys: true,
});
filter.stdin.on('data', (chunk) => {
  log({ event: 'ink', hex: Buffer.from(chunk).toString('hex') });
});
process.stdin.resume();

// Same bytes `enableKeyboardEnhancement` writes on win32 with VT input.
if (process.stdout.isTTY) process.stdout.write('\x1b[?9001h');

const stop = () => {
  if (process.stdout.isTTY) process.stdout.write('\x1b[?9001l');
  filter.dispose();
  log({ event: 'stop' });
  out.end(() => process.exit(0));
};
setTimeout(stop, seconds * 1000);
