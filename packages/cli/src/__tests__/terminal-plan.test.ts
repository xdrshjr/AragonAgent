/**
 * The terminal ladder and its four quoting dialects (tui-branch-terminal-shortcut
 * 7.1 T-19..T-29, plus v2's T-44 / T-47 / T-48).
 *
 * WHAT IS ACTUALLY BEING PROTECTED HERE: the command line. Everything else in this
 * feature degrades to a pasteable fallback, but a command line that reaches the
 * wrong parser opens a window that fails in a way the parent process can never
 * observe - `wt.exe` forwards and exits, so a rejected argument still produces a
 * successful `'spawn'`. These assertions are therefore about BYTES, not behaviour.
 */

import { describe, expect, it } from 'vitest';
import {
  defaultIsExecutable,
  encodePowerShellCommand,
  escapeAppleScriptText,
  pathDirsOf,
  planTerminalLaunch,
  posixQuote,
  posixScript,
  powerShellQuote,
  powerShellScript,
  quoteWin32Arg,
  resolveShell,
  truncateTitle,
  type ShellInvocation,
  type TerminalLaunchPlan,
  type TerminalPlanInput,
} from '../proc/terminal-plan.js';
import {
  renderManualCommand,
  resolveAragonCommand,
} from '../session/branch-invocation.js';

const COMMAND = ['aragon', '--resume', 'a4k2m9'];
const CWD = '/work/project';
const TITLE = 'aragon a4k2m9';
const MANUAL = 'aragon --resume a4k2m9';

/** The live defect's `kind: 'script'` shape: a spaced execPath plus a bare script path. */
const EXEC_WITH_SPACE = 'C:\\Program Files\\nodejs\\node.exe';
const SCRIPT_JS =
  'C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\@aragon-agent\\cli\\dist\\launcher.js';
const ID = 'a4k2m9';

const POWERSHELL: ShellInvocation = { path: 'powershell.exe', kind: 'powershell' };
const POSIX_SHELL: ShellInvocation = { path: 'bash', kind: 'posix' };

/** An `isExecutable` that answers for exactly the listed names. */
function only(names: readonly string[]): (name: string) => boolean {
  return (name) => names.includes(name);
}

function input(overrides: Partial<TerminalPlanInput> = {}): TerminalPlanInput {
  return {
    platform: 'linux',
    env: {},
    pathDirs: ['/usr/bin'],
    isExecutable: only([]),
    shell: POSIX_SHELL,
    command: COMMAND,
    title: TITLE,
    cwd: CWD,
    manual: MANUAL,
    ...overrides,
  };
}

describe('T-19..T-21 / D-6 / D-20: the Windows ladder', () => {
  it('prefers wt when Windows Terminal is listening, then falls back to cmd', () => {
    const result = planTerminalLaunch(input({
      platform: 'win32',
      env: { WT_SESSION: 'a-guid' },
      isExecutable: only(['wt.exe']),
      shell: POWERSHELL,
    }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plans.map((plan) => plan.rung)).toEqual(['wt', 'cmd']);
  });

  it('uses only the cmd rung outside Windows Terminal, with verbatim arguments', () => {
    const result = planTerminalLaunch(input({
      platform: 'win32',
      env: {},
      isExecutable: only(['wt.exe']),
      shell: POWERSHELL,
    }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plans).toHaveLength(1);
    expect(result.plans[0]!.rung).toBe('cmd');
    // `cmd.exe` must see the line unquoted, or Node's argv quoting becomes a
    // fourth parser in the chain (D-20's whole reason).
    expect(result.plans[0]!.windowsVerbatimArguments).toBe(true);
  });

  it('spells the cmd line as /d /s /c start "<title>" <shell> -NoExit -EncodedCommand', () => {
    const result = planTerminalLaunch(input({
      platform: 'win32',
      env: {},
      isExecutable: only([]),
      shell: POWERSHELL,
    }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const args = result.plans[0]!.args;
    expect(args.slice(0, 3)).toEqual(['/d', '/s', '/c']);
    const line = args[3]!;
    // The TITLE, not the `start ""` empty-string idiom: an empty first argument
    // throws the window name away (R-1's sibling), and the user cannot tell three
    // branches apart in the taskbar without it.
    expect(line.startsWith(`start "${TITLE}" powershell.exe -NoExit -EncodedCommand `)).toBe(true);
    const encoded = line.slice(line.lastIndexOf(' ') + 1);
    // The base64 alphabet has no space, no quote and no cmd metacharacter, which is
    // the entire point of `-EncodedCommand` (D-20).
    expect(encoded).toMatch(/^[A-Za-z0-9+/=]+$/);
  });
});

describe('T-22..T-24 / D-20: the four encoding dialects', () => {
  it('round-trips the encoded command through UTF-16LE', () => {
    const script = powerShellScript(["C:\\Program Files\\aragon", '--resume', 'a4k2m9']);
    expect(Buffer.from(encodePowerShellCommand(script), 'base64').toString('utf16le')).toBe(script);
    // Added with D-1: the payload the child parses has to start with the call
    // operator, and the round trip above would happily preserve a broken one.
    expect(Buffer.from(encodePowerShellCommand(script), 'base64').toString('utf16le'))
      .toMatch(/^& /);
  });

  it('T-4 / T-23 / I-6 / D-3: bare words stay bare, except a leading @', () => {
    expect(powerShellQuote('aragon')).toBe('aragon');
    expect(powerShellQuote('C:\\Program Files\\node.exe')).toBe("'C:\\Program Files\\node.exe'");
    expect(powerShellQuote("it's")).toBe("'it''s'");
    // The two lines D-3 adds. `@name` in argument position is PowerShell's SPLAT
    // operator: unquoted it silently eats the whole argument (appendix B-11).
    expect(powerShellQuote('@foo')).toBe("'@foo'");
    // Only the FIRST character matters, so an embedded `@` (every npm global path
    // on Windows has one) must keep its bare form.
    expect(powerShellQuote('C:\\a\\@b\\c.js')).toBe('C:\\a\\@b\\c.js');
    // The flag this feature emits keeps its bare form, so the fallback line a user
    // reads still looks like the command they would type (appendix B-6 A/B).
    expect(powerShellQuote('--resume')).toBe('--resume');
  });

  it('escapes a single quote for POSIX and leaves the rest literal', () => {
    expect(posixQuote("a'b")).toBe("'a'\\''b'");
    expect(posixScript(['aragon', '--resume', 'a4k2m9'])).toBe("'aragon' '--resume' 'a4k2m9'");
  });

  it('escapes backslash and double quote for AppleScript literals', () => {
    expect(escapeAppleScriptText('a\\"b')).toBe('a\\\\\\"b');
  });
});

describe('T-25 / T-29: macOS and the no-launcher exit', () => {
  it('drives Terminal.app through osascript, and the script owns the cwd', () => {
    const result = planTerminalLaunch(input({
      platform: 'darwin',
      isExecutable: only(['osascript']),
      shell: POSIX_SHELL,
    }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plans).toHaveLength(1);
    expect(result.plans[0]!.file).toBe('osascript');
    const expressions = result.plans[0]!.args.filter((arg) => arg !== '-e');
    expect(expressions).toHaveLength(2);
    const script = expressions[0]!;
    // Terminal.app's new window uses ITS default directory, so `cd` has to be in
    // the payload - `spawn({cwd})` never reaches that window (D-16 / D-23).
    expect(script).toContain(`cd '${CWD}' && `);
    expect(script).toContain(`exec 'bash' -i`);
    expect(expressions[1]).toContain('activate');
  });

  it('reports no-launcher with the caller manual line untouched', () => {
    for (const platform of ['linux', 'darwin'] as const) {
      const result = planTerminalLaunch(input({ platform, isExecutable: only([]) }));
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason).toBe('no-launcher');
      // I-4: the fallback IS the input; composing a second sentence here is how
      // two different manual commands would end up in front of one user.
      expect(result.manual).toBe(MANUAL);
    }
  });
});

describe('T-26 / D-6: the POSIX candidate ladder', () => {
  it('picks the first existing candidate and its exec arguments', () => {
    const result = planTerminalLaunch(input({ isExecutable: only(['konsole']) }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plans[0]!.rung).toBe('konsole');
    expect(result.plans[0]!.args[0]).toBe('-e');
    expect(result.plans[0]!.args.slice(1, 3)).toEqual(['bash', '-c']);
  });

  it('terminates option parsing for the emulators that parse their own argv', () => {
    const kitty = planTerminalLaunch(input({ isExecutable: only(['kitty']) }));
    const wezterm = planTerminalLaunch(input({ isExecutable: only(['wezterm']) }));
    expect(kitty.ok && kitty.plans[0]!.args[0]).toBe('--');
    expect(wezterm.ok && wezterm.plans[0]!.args.slice(0, 2)).toEqual(['start', '--']);
  });

  it('uses $TERMINAL when it is set and findable', () => {
    const result = planTerminalLaunch(input({
      env: { TERMINAL: '/usr/bin/foot' },
      isExecutable: only(['/usr/bin/foot']),
    }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plans[0]!.file).toBe('/usr/bin/foot');
    expect(result.plans[0]!.args[0]).toBe('-e');
  });
});

describe('T-27 / T-28 / D-7: shell resolution', () => {
  it('prefers pwsh.exe on Windows and falls back to Windows PowerShell', () => {
    expect(resolveShell({
      platform: 'win32',
      env: {},
      pathDirs: [],
      isExecutable: only(['pwsh.exe']),
    })).toEqual({ path: 'pwsh.exe', kind: 'powershell' });
    expect(resolveShell({ platform: 'win32', env: {}, pathDirs: [], isExecutable: only([]) }))
      .toEqual({ path: 'powershell.exe', kind: 'powershell' });
  });

  it('honours $SHELL on POSIX, then bash, then /bin/sh', () => {
    expect(resolveShell({
      platform: 'linux', env: { SHELL: '/usr/bin/fish' }, pathDirs: [], isExecutable: only([]),
    })).toEqual({ path: '/usr/bin/fish', kind: 'posix' });
    expect(resolveShell({ platform: 'linux', env: {}, pathDirs: [], isExecutable: only(['bash']) }))
      .toEqual({ path: 'bash', kind: 'posix' });
    expect(resolveShell({ platform: 'linux', env: {}, pathDirs: [], isExecutable: only([]) }))
      .toEqual({ path: '/bin/sh', kind: 'posix' });
  });

  it('lets ARAGON_BRANCH_SHELL win when it is executable', () => {
    expect(resolveShell({
      platform: 'win32',
      env: { ARAGON_BRANCH_SHELL: 'C:\\PowerShell\\7\\pwsh.exe' },
      pathDirs: [],
      isExecutable: only(['C:\\PowerShell\\7\\pwsh.exe']),
    }).path).toBe('C:\\PowerShell\\7\\pwsh.exe');
  });
});

describe('T-44 / D-16 / D-23 / I-9: every rung carries its own cwd', () => {
  it('passes -d <cwd> to wt, because a new tab ignores the spawn cwd', () => {
    const result = planTerminalLaunch(input({
      platform: 'win32',
      env: { WT_SESSION: 'x' },
      isExecutable: only(['wt.exe']),
      shell: POWERSHELL,
    }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const args = result.plans[0]!.args;
    expect(args[args.indexOf('-d') + 1]).toBe(CWD);
  });

  it('terminates wt option parsing with -- before the shell switches', () => {
    const result = planTerminalLaunch(input({
      platform: 'win32',
      env: { WT_SESSION: 'x' },
      isExecutable: only(['wt.exe']),
      shell: POWERSHELL,
    }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const args = result.plans[0]!.args;
    const separator = args.indexOf('--');
    expect(separator).toBeGreaterThan(args.indexOf('-d'));
    // Everything the shell needs sits AFTER the separator (K-1). A rejected
    // argument here is invisible to the parent, so the shape is the only defence.
    expect(args.slice(separator + 1, separator + 3)).toEqual(['powershell.exe', '-NoExit']);
    expect(args[separator + 3]).toBe('-EncodedCommand');
  });

  it('leaves the cmd rung without a cwd argument, because cmd inherits it', () => {
    const result = planTerminalLaunch(input({
      platform: 'win32',
      env: {},
      isExecutable: only([]),
      shell: POWERSHELL,
    }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plans[0]!.args.join(' ')).not.toContain(CWD);
  });

  it('starts both script rungs with cd <cwd> &&', () => {
    const posix = planTerminalLaunch(input({ isExecutable: only(['konsole']) }));
    expect(posix.ok).toBe(true);
    if (posix.ok) expect(posix.plans[0]!.args[3]!.startsWith(`cd '${CWD}' && `)).toBe(true);
    const mac = planTerminalLaunch(input({
      platform: 'darwin',
      isExecutable: only(['osascript']),
    }));
    expect(mac.ok).toBe(true);
    if (mac.ok) expect(mac.plans[0]!.args[1]!).toContain(`cd '${CWD}' && `);
  });
});

describe('T-47 / R-7: the title is what gets truncated, never the id', () => {
  it('fits the title into the cell budget while the command line keeps the whole id', () => {
    const id = 'a'.repeat(64);
    const title = truncateTitle(`aragon ${id}`, 60);
    expect(title.length).toBe(60);
    const result = planTerminalLaunch(input({
      isExecutable: only(['konsole']),
      command: ['aragon', '--resume', id],
      title,
    }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plans[0]!.args[3]!).toContain(id);
  });
});

describe('T-48 / R-17: quoteWin32Arg never emits a POSIX escape', () => {
  it('quotes only when there is whitespace, and never uses a backslash escape', () => {
    expect(quoteWin32Arg('C:\\Program Files\\aragon.exe')).toBe('"C:\\Program Files\\aragon.exe"');
    expect(quoteWin32Arg('powershell.exe')).toBe('powershell.exe');
    for (const value of ['a b', 'plain', 'C:\\Program Files\\x.exe']) {
      expect(quoteWin32Arg(value)).not.toContain('\\"');
    }
  });
});

describe('T-1 / T-2 / T-14 / I-2 / D-1 / D-4: the script opens with the call operator', () => {
  it('T-1: spells the bin form with a leading &', () => {
    expect(powerShellScript(['aragon', '--resume', 'a4k2m9'])).toBe('& aragon --resume a4k2m9');
  });

  it('T-2: quotes a spaced execPath and still puts & first', () => {
    const parts = [EXEC_WITH_SPACE, SCRIPT_JS, '--resume', ID];
    const script = powerShellScript(parts);
    // The `startsWith` is the platform-independent LOWER BOUND of the fix (K-2):
    // drop the `&` again and this goes red on every OS, not only on Windows.
    expect(script.startsWith("& '")).toBe(true);
    expect(script).toBe(`& '${EXEC_WITH_SPACE}' ${SCRIPT_JS} --resume ${ID}`);
  });

  it('T-14: an empty argv is an empty script, never a throw', () => {
    // D-4: this runs inside a key handler, where a throw is the worst failure mode.
    expect(powerShellScript([])).toBe('');
  });

  it('T-5 / I-3: posixScript never emits & , because there it means background', () => {
    const cases: readonly (readonly string[])[] = [
      ['aragon', '--resume', 'a4k2m9'],
      ['/usr/bin/node', '/repo/dist/cli.js', '--resume', 'a4k2m9'],
      ['a b'],
      ["it's"],
      [''],
    ];
    for (const parts of cases) expect(posixScript(parts)).not.toContain('&');
  });
});

describe('T-3 / D-4: every resolution rule yields at least one argv piece', () => {
  it('returns a non-empty parts array for override, script and bin', () => {
    const execPath = '/usr/bin/node';
    const spaced = 'C:\\Program Files\\aragon.cmd';
    const script = '/repo/dist/cli.js';
    const cases = [
      // `override`, with a spaced executable path - the shape that used to break.
      { argv: ['node'], execPath, env: { ARAGON_BRANCH_COMMAND: spaced } },
      // `override` set to the empty string falls through to the next rule.
      { argv: ['node', script], execPath, env: { ARAGON_BRANCH_COMMAND: '' } },
      // `script`, the live path of the reported defect.
      { argv: ['node', script], execPath, env: {} },
      // `bin`.
      { argv: ['node'], execPath, env: {} },
    ];
    for (const entry of cases) {
      expect(resolveAragonCommand(entry).parts.length).toBeGreaterThanOrEqual(1);
    }
  });
});

describe('T-8 / I-1: one command, one artefact', () => {
  /** The `-EncodedCommand` payload of a rung: the last word of its last argument. */
  function encodedOf(plan: TerminalLaunchPlan): string {
    const line = plan.args[plan.args.length - 1]!;
    return line.slice(line.lastIndexOf(' ') + 1);
  }

  it('matches the decoded payload of BOTH rungs, byte for byte', () => {
    const parts = [EXEC_WITH_SPACE, SCRIPT_JS, '--resume', ID];
    // The manual block is the user-facing half of the same command; deriving it from
    // the same `parts` is what makes "one command, one artefact" checkable at all.
    const manual = renderManualCommand(parts, 'win32');
    const result = planTerminalLaunch(input({
      platform: 'win32',
      env: { WT_SESSION: 'a-guid' },
      isExecutable: only(['wt.exe']),
      shell: POWERSHELL,
      command: parts,
      manual,
    }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const firstLine = result.manual.split('\n')[0]!.replace('PowerShell: ', '');
    expect(result.plans).toHaveLength(2);
    for (const plan of result.plans) {
      expect(Buffer.from(encodedOf(plan), 'base64').toString('utf16le')).toBe(firstLine);
    }
  });
});

describe('T-10 / T-11: the encoding path is not ASCII-only and not unbounded', () => {
  it('T-10: a CJK cwd and path survive quoting and encoding unchanged', () => {
    // "work" / "node" written in Chinese: real Windows account names are like this,
    // and `-EncodedCommand`'s UTF-16LE payload is exactly why it still works.
    const cjkPath = 'C:\\\u5de5\u4f5c\\\u8282\u70b9\\node.exe';
    const parts = [cjkPath, 'C:\\\u5de5\u4f5c\\cli.js', '--resume', ID];
    const result = planTerminalLaunch(input({
      platform: 'win32',
      env: {},
      isExecutable: only([]),
      shell: POWERSHELL,
      command: parts,
      manual: renderManualCommand(parts, 'win32'),
    }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const line = result.plans[0]!.args[3]!;
    const decoded = Buffer.from(line.slice(line.lastIndexOf(' ') + 1), 'base64')
      .toString('utf16le');
    expect(decoded.startsWith(`& '${cjkPath}' `)).toBe(true);
    expect(decoded).toContain('--resume a4k2m9');
    expect(decoded).not.toContain('\uFFFD');
  });

  it('T-11: the worst legal input stays an order of magnitude below the 8191 cap', () => {
    // MAX_PATH-sized execPath and script path, plus the longest legal id (64).
    const parts = ['C:\\' + 'a'.repeat(257), 'C:\\' + 'b'.repeat(257), '--resume', 'c'.repeat(64)];
    const result = planTerminalLaunch(input({
      platform: 'win32',
      env: {},
      isExecutable: only([]),
      shell: POWERSHELL,
      command: parts,
      title: truncateTitle(`aragon ${'c'.repeat(64)}`, 60),
      manual: renderManualCommand(parts, 'win32'),
    }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // `maxCommandLineCells` (8000, session/limits.ts) is NOT raised here: this is the
    // boundary evidence that it does not need to be (spec 3.8).
    expect(result.plans[0]!.args[3]!.length).toBeLessThan(4096);
  });
});

describe('path probing helpers', () => {
  it('reads both Path spellings on Windows and splits POSIX on a colon', () => {
    expect(pathDirsOf({ Path: 'C:\\a;C:\\b', PATH: 'C:\\b;C:\\c' }, 'win32'))
      .toEqual(['C:\\a', 'C:\\b', 'C:\\c']);
    expect(pathDirsOf({ PATH: '/usr/bin:/bin::' }, 'linux')).toEqual(['/usr/bin', '/bin']);
  });

  it('answers false instead of throwing for a path that is not there', () => {
    expect(defaultIsExecutable('win32', ['C:\\definitely-not-here'])('nope.exe')).toBe(false);
    expect(defaultIsExecutable('linux', ['/definitely-not-here'])('nope')).toBe(false);
  });
});
