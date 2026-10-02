/**
 * E4 — does a REPEATED `setRawMode(true)` clear a bit somebody else OR-ed in?
 *
 * This is the one assumption the C1 fix rests on and the only one round 2 never
 * measured. The shipped order is: raise raw mode ourselves, force the VT bit on
 * from a helper, then let Ink mount — and Ink's `useInput` calls
 * `stdin.setRawMode(true)` a second time. Section 3.3 measured that a raw-mode
 * TRANSITION (false -> true) wipes the bit; it inferred, from libuv's
 * `if (tty->tty.rd.mode == mode) return 0;`, that a repeat of the SAME mode does
 * not. If that inference is wrong the fix is dead on arrival, silently, on every
 * machine — exactly the shape of the bug it is fixing.
 *
 * Version-independent on purpose: the guard under test is libuv's cached-mode
 * check, not the flavour of raw mode Node asks for, so this measures the same
 * thing on Node 22.18 as on Node 20. The probe bit is `ENABLE_MOUSE_INPUT`
 * (0x0010) rather than `ENABLE_VIRTUAL_TERMINAL_INPUT`, so that on a new Node —
 * which already sets 0x0200 itself — the result cannot be confused with Node's
 * own doing.
 *
 * Run it from a REAL console window (it needs `stdin.isTTY`):
 *   powershell -NoProfile -ExecutionPolicy Bypass -File inject-rawmode-idempotent.ps1
 */

import { spawnSync } from 'node:child_process';
import { appendFileSync, writeFileSync } from 'node:fs';
import process from 'node:process';

const LOG = process.argv[2] ?? 'probe-out-rawmode-idempotent.txt';
const PROBE_BIT = 0x0010; // ENABLE_MOUSE_INPUT — inert, and nobody else sets it.

const say = (line) => {
  appendFileSync(LOG, `${line}\n`, 'utf-8');
  process.stdout.write(`${line}\n`);
};

/** Read (and optionally OR into) the console mode through CONIN$. */
function consoleMode(orBit = 0) {
  const ps = [
    "$ErrorActionPreference = 'Stop'",
    "Add-Type -TypeDefinition @'",
    'using System;',
    'using System.Runtime.InteropServices;',
    'public static class E4 {',
    '  [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)]',
    '  public static extern IntPtr CreateFileW(string name, uint access, uint share,',
    '    IntPtr sec, uint disp, uint flags, IntPtr tmpl);',
    '  [DllImport("kernel32.dll", SetLastError=true)]',
    '  public static extern bool GetConsoleMode(IntPtr h, out uint mode);',
    '  [DllImport("kernel32.dll", SetLastError=true)]',
    '  public static extern bool SetConsoleMode(IntPtr h, uint mode);',
    '}',
    "'@",
    // Decimal, not 0xC0000000: PowerShell 5.1 parses a high-bit hex literal as a
    // signed Int32 and the [uint32] cast then throws.
    "$h = [E4]::CreateFileW('CONIN$', ([uint32]2147483648 -bor [uint32]1073741824)," +
      ' [uint32]3, [IntPtr]::Zero, [uint32]3, [uint32]0, [IntPtr]::Zero)',
    '$m = [uint32]0',
    '[void][E4]::GetConsoleMode($h, [ref]$m)',
    `$orBit = [uint32]${orBit}`,
    'if ($orBit -ne 0) {',
    '  [void][E4]::SetConsoleMode($h, ($m -bor $orBit))',
    '  [void][E4]::GetConsoleMode($h, [ref]$m)',
    '}',
    'Write-Output ("mode=0x{0:X4}" -f $m)',
  ].join('\n');
  const r = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-NoLogo', '-EncodedCommand',
      Buffer.from(ps, 'utf16le').toString('base64')],
    { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: false, encoding: 'utf-8' },
  );
  const m = /mode=0x([0-9A-Fa-f]+)/.exec(r.stdout ?? '');
  return m ? Number.parseInt(m[1], 16) : NaN;
}

const hex = (n) => (Number.isNaN(n) ? 'READ-FAILED' : `0x${n.toString(16).toUpperCase().padStart(4, '0')}`);

writeFileSync(LOG, '', 'utf-8');
say(`node=${process.version} isTTY=${process.stdin.isTTY === true}`);
if (!process.stdin.isTTY) {
  say('VERDICT: INVALID — not a TTY. Run this from a real console window.');
  process.exit(2);
}

process.stdin.setRawMode(true);
say(`1. after our own setRawMode(true):        ${hex(consoleMode())}`);

const forced = consoleMode(PROBE_BIT);
say(`2. after an outside process OR-ed 0x0010: ${hex(forced)}`);
if ((forced & PROBE_BIT) === 0) {
  say('VERDICT: INVALID — the console refused the probe bit; nothing to measure.');
  process.exit(2);
}

// THE MEASUREMENT: exactly what Ink does at mount, on a handle already raw.
process.stdin.setRawMode(true);
const repeated = consoleMode();
say(`3. after a REPEATED setRawMode(true):     ${hex(repeated)}`);

// The control: a real transition, which section 3.3 says must clear it.
process.stdin.setRawMode(false);
process.stdin.setRawMode(true);
const cycled = consoleMode();
say(`4. after a full false->true transition:   ${hex(cycled)}`);

const survivedRepeat = (repeated & PROBE_BIT) !== 0;
const clearedByCycle = (cycled & PROBE_BIT) === 0;
say('');
say(`repeat kept the bit:      ${survivedRepeat}   <- C1 depends on this being true`);
say(`transition cleared it:    ${clearedByCycle}   <- section 3.3's finding, re-measured`);
say(`VERDICT: ${survivedRepeat ? 'ORDERING HOLDS' : 'ORDERING BROKEN — C1 cannot work as shipped'}`);

process.stdin.setRawMode(false);
process.exit(survivedRepeat ? 0 : 1);
