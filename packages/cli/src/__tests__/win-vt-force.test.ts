/**
 * `forceWindowsVtInput` and its decision function
 * (shift-tab-mode-toggle-still-dead-on-windows, C1-M1).
 *
 * Every case below is a MEASURED outcome from the analysis, not an invented one.
 * The two `before` values are the two real samples: `0x0008` is the CLI's own
 * console after libuv raised raw mode, `0x01F7` is the fresh console a
 * `CREATE_NO_WINDOW` child gets handed instead (analysis sections 3.4 / 3.5).
 *
 * These run on every platform because `decideVtForceOutcome` is pure - which is
 * the entire reason it was split out. The failure this file exists to prevent is
 * a helper that exits 0, reports success, and configured somebody else's
 * console: green everywhere, with the feature silently doing nothing.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  buildHelperScript,
  decideVtForceOutcome,
  encodePowerShellCommand,
  ENABLE_VIRTUAL_TERMINAL_INPUT,
  forceWindowsVtInput,
  isRawConsoleMode,
  parseConsoleModes,
  resolvePowerShellExe,
} from '../ui/win-vt-force.js';

/** The CLI's own console, mid-session: raw mode up, VT input still off. */
const RAW_BEFORE = 0x0008;
/** A cooked console nobody is typing into - the `windowsHide: true` trap. */
const COOKED_BEFORE = 0x01f7;

const helperSaid = (before: number, after: number): string =>
  `before=0x${before.toString(16).toUpperCase().padStart(4, '0')}\n` +
  `after=0x${after.toString(16).toUpperCase().padStart(4, '0')}\n`;

describe('decideVtForceOutcome', () => {
  it('accepts the measured success: raw console in, VT bit out', () => {
    const r = decideVtForceOutcome({
      status: 0,
      stdout: helperSaid(RAW_BEFORE, RAW_BEFORE | ENABLE_VIRTUAL_TERMINAL_INPUT),
    });
    expect(r).toEqual({ ok: true, before: 0x0008, after: 0x0208 });
  });

  it('rejects a cooked `before` even though the helper exited 0 (trap 1)', () => {
    // THE case this function exists for. Exit code 0, `SetConsoleMode` returned
    // true, the bit is set in `after` - and none of it happened on the console
    // the user is typing into (analysis section 3.5). Without this check the
    // outcome is indistinguishable from the fix never having been written.
    const r = decideVtForceOutcome({
      status: 0,
      stdout: helperSaid(COOKED_BEFORE, COOKED_BEFORE | ENABLE_VIRTUAL_TERMINAL_INPUT),
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('wrong_console');
  });

  it('rejects a cooked console whose default is NOT 0x01F7 (review R-3)', () => {
    // The guard has to be a positive bitmask, never `before !== 0x01F7`. That
    // number is one machine's default; it moves with QuickEdit, with the console
    // host, and with a user who already turned VT input on. A magic-number
    // comparison passes silently on the first machine that differs, which puts
    // the trap above straight back - on somebody else's machine, not ours.
    const oddCookedDefault = 0x0007 | 0x0080; // line+echo+processed, no QuickEdit
    const r = decideVtForceOutcome({
      status: 0,
      stdout: helperSaid(oddCookedDefault, oddCookedDefault | ENABLE_VIRTUAL_TERMINAL_INPUT),
    });
    expect(r.reason).toBe('wrong_console');
  });

  it('rejects a console that accepted the call and dropped the bit', () => {
    // Old console hosts take `SetConsoleMode` and silently discard bits they do
    // not implement, so the re-read is the only proof (analysis section 3.9).
    const r = decideVtForceOutcome({ status: 0, stdout: helperSaid(RAW_BEFORE, RAW_BEFORE) });
    expect(r.reason).toBe('bit_not_set');
    expect(r.before).toBe(0x0008);
  });

  it('reports a non-zero exit with its first line, for the log', () => {
    // Constrained Language Mode disables `Add-Type` outright, and enterprise
    // fleets ship it by policy - the same "another PC" population as the bug.
    const r = decideVtForceOutcome({ status: 3, stdout: 'error=addtype\n' });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('helper_failed');
    expect(r.detail).toContain('exit=3');
    expect(r.detail).toContain('error=addtype');
  });

  it('reports `no_before` when the helper printed nothing usable', () => {
    expect(decideVtForceOutcome({ status: 0, stdout: '' })).toEqual({
      ok: false,
      reason: 'no_before',
    });
  });
});

describe('isRawConsoleMode', () => {
  it('separates the two measured samples', () => {
    expect(isRawConsoleMode(RAW_BEFORE)).toBe(true);
    expect(isRawConsoleMode(COOKED_BEFORE)).toBe(false);
  });

  it('rejects a console with any one cooked bit still set', () => {
    for (const bit of [0x0001, 0x0002, 0x0004]) {
      expect(isRawConsoleMode(RAW_BEFORE | bit), `bit 0x${bit.toString(16)}`).toBe(false);
    }
  });
});

describe('parseConsoleModes', () => {
  it('reads both values out of the helper transcript', () => {
    expect(parseConsoleModes(helperSaid(0x0008, 0x0208))).toEqual({ before: 8, after: 0x208 });
  });

  it('omits what is absent rather than inventing a zero', () => {
    // `before: 0` and "no before at all" mean opposite things: the first is a
    // console with every bit clear, the second is a helper that never spoke.
    expect(parseConsoleModes('after=0x0208\n')).toEqual({ after: 0x208 });
    expect(parseConsoleModes('nonsense')).toEqual({});
  });
});

describe('buildHelperScript', () => {
  const script = buildHelperScript();

  it('opens CONIN$ instead of the standard input handle (trap 2)', () => {
    // The helper is spawned with stdin `ignore`, so `GetStdHandle` would hand it
    // `NUL`. Sharing the real stdin is not an option either - that is the handle
    // whose mode is being rewritten underneath it.
    expect(script).toContain("CreateFileW('CONIN$'");
    expect(script).not.toContain('GetStdHandle');
  });

  it('reports `before` and re-reads `after`, which is what makes the checks possible', () => {
    expect(script).toContain('before=0x{0:X4}');
    expect(script).toContain('after=0x{0:X4}');
  });

  it('uses no high-bit hex literal, which Windows PowerShell cannot cast', () => {
    // MEASURED, on PowerShell 5.1.26100: `[uint32]0xC0000000` raises
    //   Cannot convert value "-1073741824" to type "System.UInt32"
    // because 5.1 parses a hex literal with the high bit set as a signed Int32.
    // `powershell.exe` IS 5.1 on every Windows machine - `resolvePowerShellExe`
    // points straight at it - and with `$ErrorActionPreference = 'Stop'` outside
    // the `try`, the helper dies before `CreateFileW`, exit 1, no `before=`.
    //
    // The failure is total and completely silent: the caller sees an ordinary
    // `helper_failed`, degrades to the fallback key exactly as designed, and the
    // whole of C1 never runs on a single console. That is why this is asserted
    // on the GENERATED script rather than trusted to review - the code was
    // written this way once already, next to a probe script carrying the
    // warning in a comment.
    expect(script).not.toMatch(/\[uint32\]\s*0x[89a-fA-F]/);
    expect(script).toContain('2147483648'); // GENERIC_READ, in decimal
  });

  it('ORs the bit in rather than assigning the mode', () => {
    // Assignment would drop `ENABLE_WINDOW_INPUT` and whatever else libuv set,
    // reconfiguring the console instead of adding one capability to it.
    expect(script).toContain('-bor 0x0200');
  });
});

describe('encodePowerShellCommand', () => {
  it('produces base64 of UTF-16LE, which is what -EncodedCommand takes', () => {
    const encoded = encodePowerShellCommand('exit 0');
    expect(Buffer.from(encoded, 'base64').toString('utf16le')).toBe('exit 0');
  });

  it('needs no shell quoting even for a script full of quotes and dollars', () => {
    expect(encodePowerShellCommand(buildHelperScript())).toMatch(/^[A-Za-z0-9+/=]+$/);
  });
});

describe('resolvePowerShellExe', () => {
  it('falls back to the bare name when there is no SystemRoot to anchor to', () => {
    expect(resolvePowerShellExe({})).toBe('powershell.exe');
  });
});

describe('forceWindowsVtInput', () => {
  it('does nothing at all off Windows, without spawning', () => {
    let spawned = 0;
    const r = forceWindowsVtInput({
      platform: 'linux',
      run: () => {
        spawned += 1;
        return { status: 0, stdout: '', stderr: '' };
      },
    });
    expect(r).toEqual({ ok: false, reason: 'not_windows' });
    expect(spawned).toBe(0);
  });

  it('turns a spawn failure into a result instead of throwing', () => {
    // This runs during startup, before Ink mounts. A throw here would be a CLI
    // that refuses to start on a machine missing PowerShell, to fix a key.
    const r = forceWindowsVtInput({
      platform: 'win32',
      run: () => {
        throw new Error('ENOENT powershell.exe');
      },
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('spawn_failed');
    expect(r.detail).toContain('ENOENT');
  });

  it('passes the helper through -EncodedCommand and reports the verdict', () => {
    const seen: { exe: string; args: string[] } = { exe: '', args: [] };
    const r = forceWindowsVtInput({
      platform: 'win32',
      run: (exe, args) => {
        seen.exe = exe;
        seen.args = args;
        return { status: 0, stdout: helperSaid(RAW_BEFORE, 0x0208), stderr: '' };
      },
    });
    expect(r.ok).toBe(true);
    expect(seen.exe.toLowerCase()).toContain('powershell.exe');
    expect(seen.args).toContain('-NoProfile');
    // `-NoProfile` and `-EncodedCommand` together are what make this survive a
    // machine with a hostile profile and an ExecutionPolicy that blocks .ps1
    // FILES - the population this bug keeps landing on.
    expect(seen.args).toContain('-EncodedCommand');
  });
});

describe('the spawn options nothing else can observe', () => {
  it('keeps `windowsHide: false`, the single line trap 1 turns on', () => {
    // `windowsHide: true` maps to CREATE_NO_WINDOW, which hands the child its
    // OWN console; the helper then succeeds loudly against a console nobody is
    // typing into (analysis section 3.5). `defaultRun` is not injectable and no
    // unit test can see this flag at runtime, so it is pinned as source. It
    // reads like tidiness and is the difference between working and not.
    //
    // MATCHED AS A PROPERTY, NOT AS A SUBSTRING. The module header has to spell
    // out `windowsHide: true` to explain the trap at all, so `not.toContain` is
    // unsatisfiable - and its cheapest "fix" is deleting the one comment that
    // stops the next reader from tidying the flag. Assert the code instead.
    const src = readFileSync(
      fileURLToPath(new URL('../ui/win-vt-force.ts', import.meta.url)),
      'utf-8',
    );
    const settings = [...src.matchAll(/^\s*windowsHide:\s*(true|false)\s*,/gm)].map((m) => m[1]);
    expect(settings).toEqual(['false']);
  });
});
