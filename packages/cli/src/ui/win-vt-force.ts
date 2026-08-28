/**
 * Turn `ENABLE_VIRTUAL_TERMINAL_INPUT` on for THIS console, from outside Node
 * (shift-tab-mode-toggle-still-dead-on-windows, C1-M1).
 *
 * ASCII ONLY - this tree is inside the glyph scanner's scope.
 *
 * `win-vt-input.ts` answers "will this console ever deliver `CSI Z`?". This
 * module answers "can we MAKE it deliver one?", and the measured answer is yes.
 * The bit is a property of the console input buffer, not of Node, so any process
 * attached to the same console can set it - and libuv's pre-22.17 translator
 * forwards whatever characters the console generates, `ESC` `[` `Z` included.
 * On Node 20.19.0, in one run, one injected `Shift+Tab` went from `09` to
 * `1b 5b 5a` the instant an outside process OR-ed `0x0200` in (analysis section
 * 3.2; raw probe data under `docs/diagnoses/.../repro/`).
 *
 * Node ships no FFI, so the outside process is `powershell.exe` calling
 * `SetConsoleMode` through P/Invoke. Measured cost end to end: 722 ms, roughly
 * 280 ms of process start plus 300 ms of `Add-Type` compiling C# at run time
 * (analysis section 3.4). That is the whole price of not adding a native
 * dependency, and it is paid ONCE, only on an affected Windows console.
 *
 * THREE TRAPS ARE ENCODED HERE, all of them measured rather than imagined:
 *
 *  1. `windowsHide: true` maps to `CREATE_NO_WINDOW`, which hands the child its
 *     OWN console. The helper then reads, sets and reports success against a
 *     console nobody is typing into: exit code 0, `SetConsoleMode` true, log
 *     clean, and no effect whatsoever - indistinguishable from "the fix was
 *     never written" (analysis section 3.5). Hence `windowsHide: false`.
 *  2. The helper must open `CONIN$` with `CreateFileW`, never
 *     `GetStdHandle(STD_INPUT_HANDLE)`: it is spawned with stdin `ignore`, so
 *     its standard input is `NUL`. Sharing the real stdin instead is not an
 *     option - that handle is being reconfigured underneath it.
 *  3. The `before` mode is the ONLY signal that distinguishes trap 1 from
 *     success, so the helper reports it and `decideVtForceOutcome` checks it.
 *     The check is a POSITIVE bitmask ("is this console already in raw mode"),
 *     not `before !== 0x01F7`: that number is one machine's default and varies
 *     with QuickEdit, with the host, and with a user who already turned VT input
 *     on. A magic-number comparison passes silently on the first machine whose
 *     default happens to differ, which puts trap 1 straight back (review R-3).
 *
 * WHAT UNDOES IT: `setRawMode(false)`. libuv rewrites the whole console mode on
 * every raw-mode transition and its pre-22.17 path does not know about this bit,
 * so one transition clears it (analysis section 3.3). That is why the caller
 * must raise raw mode BEFORE calling this, and it is also the entire restore
 * path - the bit outlives the process otherwise, and neither Windows nor the
 * console clears it (analysis section 3.5b).
 *
 * FAILURE IS ALWAYS GRACEFUL. Constrained Language Mode disables `Add-Type`
 * outright, and enterprise fleets ship it by policy - exactly the "another PC"
 * population this bug is about. Every failure returns `ok: false` with a reason
 * for the log and nothing else happens; the alternate mode-toggle key
 * (`MODE_TOGGLE_KEYS.fallback`) is the rung below that needs none of this.
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';

/** Console input mode bits (`consoleapi.h`). */
export const ENABLE_PROCESSED_INPUT = 0x0001;
export const ENABLE_LINE_INPUT = 0x0002;
export const ENABLE_ECHO_INPUT = 0x0004;
export const ENABLE_WINDOW_INPUT = 0x0008;
export const ENABLE_VIRTUAL_TERMINAL_INPUT = 0x0200;

/**
 * The three bits a cooked console has and a raw one does not.
 *
 * This is the fingerprint of "libuv has already put this console in raw mode",
 * and it is what tells the two measured samples apart: `0x0008` (the CLI's own
 * console, raw) versus `0x01F7` (a fresh `CREATE_NO_WINDOW` console, cooked).
 */
export const COOKED_INPUT_BITS = ENABLE_PROCESSED_INPUT | ENABLE_LINE_INPUT | ENABLE_ECHO_INPUT;

export function isRawConsoleMode(mode: number): boolean {
  return (mode & COOKED_INPUT_BITS) === 0;
}

export type VtForceFailure =
  | 'not_windows'
  | 'spawn_failed'
  | 'helper_failed'
  | 'no_before'
  | 'wrong_console'
  | 'bit_not_set';

export interface VtForceResult {
  ok: boolean;
  /** Absent on success; a stable machine token on failure, for the log. */
  reason?: VtForceFailure;
  before?: number;
  after?: number;
  /** Free-form context for the log line. Never shown to the user. */
  detail?: string;
}

/**
 * The PowerShell side, as a string.
 *
 * A LITERAL HERE-STRING (`@'` ... `'@`) around the C# so PowerShell expands
 * nothing inside it, and `'CONIN$'` in single quotes for the same reason - the
 * `$` is part of the device name, not a variable.
 *
 * Shipped inline rather than as a `.ps1` next to the build output, and that is a
 * capability difference rather than tidiness: ExecutionPolicy blocks script
 * FILES and does not apply to `-EncodedCommand`, so a locked-down machine - the
 * population this bug keeps landing on - can still run it. It also removes the
 * "where did my file go after packaging" class of failure entirely.
 */
export function buildHelperScript(): string {
  return [
    "$ErrorActionPreference = 'Stop'",
    'try {',
    '  Add-Type -TypeDefinition @' + "'",
    'using System;',
    'using System.Runtime.InteropServices;',
    'public static class AragonVtInput {',
    '  [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)]',
    '  public static extern IntPtr CreateFileW(string name, uint access, uint share,',
    '    IntPtr sec, uint disp, uint flags, IntPtr tmpl);',
    '  [DllImport("kernel32.dll", SetLastError=true)]',
    '  public static extern bool GetConsoleMode(IntPtr h, out uint mode);',
    '  [DllImport("kernel32.dll", SetLastError=true)]',
    '  public static extern bool SetConsoleMode(IntPtr h, uint mode);',
    '}',
    "'" + '@',
    '} catch { Write-Output "error=addtype"; exit 3 }',
    // GENERIC_READ | GENERIC_WRITE, FILE_SHARE_READ | FILE_SHARE_WRITE, OPEN_EXISTING.
    //
    // DECIMAL, NOT `0xC0000000`. Windows PowerShell 5.1 - which is what
    // `resolvePowerShellExe` finds, on every machine - parses a hex literal with
    // the high bit set as a SIGNED Int32, so `[uint32]0xC0000000` throws
    // "Cannot convert value -1073741824" before `CreateFileW` is ever reached.
    // With `$ErrorActionPreference = 'Stop'` that is a terminating error outside
    // the `try`, so the helper dies with no `before=` line and the whole feature
    // degrades to `no_before` on 100% of consoles - working code, never once
    // executed. Round 2's own probe helper carries the same comment.
    "$h = [AragonVtInput]::CreateFileW('CONIN$', ([uint32]2147483648 -bor [uint32]1073741824)," +
      ' [uint32]3, [IntPtr]::Zero, [uint32]3, [uint32]0, [IntPtr]::Zero)',
    'if ($h -eq [IntPtr]::Zero -or $h.ToInt64() -eq -1) { Write-Output "error=conin"; exit 4 }',
    '$before = [uint32]0',
    'if (-not [AragonVtInput]::GetConsoleMode($h, [ref]$before)) {',
    '  Write-Output "error=getmode"; exit 5',
    '}',
    'Write-Output ("before=0x{0:X4}" -f $before)',
    'if (-not [AragonVtInput]::SetConsoleMode($h, ($before -bor 0x0200))) {',
    '  Write-Output "error=setmode"; exit 6',
    '}',
    '$after = [uint32]0',
    'if (-not [AragonVtInput]::GetConsoleMode($h, [ref]$after)) {',
    '  Write-Output "error=recheck"; exit 7',
    '}',
    'Write-Output ("after=0x{0:X4}" -f $after)',
    'exit 0',
  ].join('\n');
}

/** `-EncodedCommand` takes base64 of UTF-16LE, which needs no shell quoting. */
export function encodePowerShellCommand(script: string): string {
  return Buffer.from(script, 'utf16le').toString('base64');
}

/**
 * Prefer the absolute path so a sanitized or hijacked `PATH` cannot decide what
 * runs; fall back to the bare name, which is still better than not trying.
 */
export function resolvePowerShellExe(env: NodeJS.ProcessEnv = process.env): string {
  const root = env.SystemRoot ?? env.windir;
  if (root) {
    const abs = join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    if (existsSync(abs)) return abs;
  }
  return 'powershell.exe';
}

/** Pull `before=` / `after=` back out of the helper's stdout. */
export function parseConsoleModes(stdout: string): { before?: number; after?: number } {
  const read = (label: string): number | undefined => {
    const m = new RegExp(`^${label}=0x([0-9a-fA-F]+)\\s*$`, 'm').exec(stdout);
    if (!m) return undefined;
    const n = Number.parseInt(m[1] ?? '', 16);
    return Number.isFinite(n) ? n : undefined;
  };
  const before = read('before');
  const after = read('after');
  return { ...(before !== undefined ? { before } : {}), ...(after !== undefined ? { after } : {}) };
}

/**
 * PURE, and the reason this feature is testable without a Windows box: every
 * interesting outcome - including the `0x01F7` wrong-console trap that returns
 * exit code 0 - is decided here from two strings and a number.
 */
export function decideVtForceOutcome(run: {
  status: number | null;
  stdout: string;
  stderr?: string;
}): VtForceResult {
  const { before, after } = parseConsoleModes(run.stdout);
  const carry = before !== undefined ? { before } : {};
  if (run.status !== 0) {
    const note = (run.stdout.trim() || run.stderr?.trim() || '').split('\n')[0] ?? '';
    return { ok: false, reason: 'helper_failed', detail: `exit=${run.status} ${note}`, ...carry };
  }
  if (before === undefined) return { ok: false, reason: 'no_before' };
  // Trap 1. Exit code and API return value both said success; only this tells us
  // the helper was talking to a different console than the one being typed into.
  if (!isRawConsoleMode(before)) return { ok: false, reason: 'wrong_console', before };
  if (after === undefined || (after & ENABLE_VIRTUAL_TERMINAL_INPUT) === 0) {
    // Old conhosts accept `SetConsoleMode` and drop bits they do not implement,
    // so the re-read is not paranoia - it is the only proof (analysis 3.9).
    return { ok: false, reason: 'bit_not_set', before, ...(after !== undefined ? { after } : {}) };
  }
  return { ok: true, before, after };
}

export interface VtForceOptions {
  platform?: string;
  timeoutMs?: number;
  /** Injected by the tests; defaults to a real `spawnSync`. */
  run?: (exe: string, args: string[]) => { status: number | null; stdout: string; stderr: string };
}

/**
 * Set the bit on the console this process is attached to.
 *
 * SYNCHRONOUS on purpose. The caller has to know the answer before it decides
 * whether the mouse can report and whether to warn the user, and at the one
 * moment this runs - after raw mode is up, before Ink renders - there is nothing
 * else for the event loop to do. An async version would buy nothing and would
 * spread the ordering across two files.
 *
 * NEVER THROWS.
 */
export function forceWindowsVtInput(opts: VtForceOptions = {}): VtForceResult {
  const platform = opts.platform ?? process.platform;
  if (platform !== 'win32') return { ok: false, reason: 'not_windows' };
  const exe = resolvePowerShellExe();
  const args = [
    '-NoProfile',
    '-NonInteractive',
    '-NoLogo',
    '-EncodedCommand',
    encodePowerShellCommand(buildHelperScript()),
  ];
  try {
    const run = opts.run ?? defaultRun(opts.timeoutMs ?? 5000);
    return decideVtForceOutcome(run(exe, args));
  } catch (err) {
    return { ok: false, reason: 'spawn_failed', detail: (err as Error).message };
  }
}

function defaultRun(timeoutMs: number) {
  return (exe: string, args: string[]) => {
    const r = spawnSync(exe, args, {
      // stdin `ignore` is trap 2's premise: the helper must not share the handle
      // whose mode is being rewritten. stdout/stderr are pipes because `before`
      // has to come back - a log file would be a second failure surface.
      stdio: ['ignore', 'pipe', 'pipe'],
      // TRAP 1. Do not "tidy" this to `true`; see the module header.
      windowsHide: false,
      timeout: timeoutMs,
      encoding: 'utf-8',
    });
    if (r.error) throw r.error;
    return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
  };
}
