/**
 * What a new terminal window looks like from the outside (tui-branch-terminal-shortcut
 * 3.7).
 *
 * ASCII ONLY - `src/proc/**` is inside `glyphs.test.ts::inScope`.
 *
 * PURE, AND THAT IS THE POINT. Three platforms, at least ten terminal emulators,
 * four exec-argument conventions and Windows' three layers of parsing (we -> `cmd`
 * -> `PowerShell`) all collapse into "what should we spawn, with which argv". A
 * command body that called `spawn('cmd', ['/c','start', ...])` inline would bury
 * the only testable part of this feature - the command line itself - inside
 * untestable IO. `proc/readiness.ts` and `proc/classify.ts` set the same precedent
 * inside this directory.
 *
 * WHY SESSION CODE MAY DEPEND ON THIS MODULE: it imports nothing from
 * `node:child_process`, reads no configuration and creates no process. The single
 * place a process is created stays in `session/branch-launch.ts`, so `proc/` keeps
 * meaning "processes" and `session/` keeps meaning "sessions".
 *
 * EVERY RUNG CARRIES ITS OWN WORKING DIRECTORY (D-16 / D-23 / I-9). This is the
 * one thing a reviewer will assume is free and is not: `spawn({ cwd })` decides the
 * cwd of the process WE start, and for `wt -w 0 nt` (a new tab in an already
 * running Windows Terminal) or `osascript` (a new Terminal.app window) that
 * process merely forwards the request - the window opens in the terminal's own
 * default directory. So `wt` passes `-d`, and both script rungs start with
 * `cd <cwd> &&`. `--resume` does not restore a cwd, so a window that opens in the
 * wrong place can never be corrected from inside the branch.
 */

import { statSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

/** The three ladders, collapsed from `NodeJS.Platform` (win32 / darwin / everything else). */
export type TerminalPlatform = 'win32' | 'darwin' | 'posix';

export interface ShellInvocation {
  /** Executable: an absolute path or a name resolved through PATH. */
  path: string;
  /** Which command syntax the aragon command has to be encoded for. */
  kind: 'powershell' | 'posix';
}

export interface TerminalLaunchPlan {
  /** The program we spawn. */
  file: string;
  args: string[];
  /** True only for the `cmd` rung, whose command line `cmd.exe` must see verbatim. */
  windowsVerbatimArguments: boolean;
  /** Ladder name, for the log and for the success toast's debug detail. */
  rung: string;
}

export type TerminalPlanResult =
  | { ok: true; plans: TerminalLaunchPlan[]; shell: ShellInvocation; manual: string }
  | { ok: false; reason: 'no-launcher'; shell: ShellInvocation; manual: string };

export interface TerminalPlanInput {
  platform: NodeJS.Platform;
  env: Record<string, string | undefined>;
  pathDirs: readonly string[];
  isExecutable?: (name: string) => boolean;
  shell: ShellInvocation;
  /** The aragon command's argv pieces (`session/branch-invocation.ts`'s product). */
  command: readonly string[];
  /** New window title, ASCII, already truncated to the cell budget. */
  title: string;
  cwd: string;
  /**
   * `renderManualCommand(command, platform)`'s product: two lines on win32
   * (`PowerShell:` / `cmd.exe   :`), one line everywhere else.
   */
  manual: string;
}

/** ONE candidate per terminal emulator, in the order they should be tried. */
interface PosixCandidate {
  /** Display name, and the rung name when it is chosen. */
  name: string;
  /** The value to probe. `$TERMINAL` is substituted from the environment. */
  probe: string;
  /** Arguments that make the emulator run a command (before the shell itself). */
  execArgs: string[];
}

/**
 * The POSIX ladder (D-6), most-specific first.
 *
 * `--` TERMINATES THE EMULATOR'S OWN OPTION PARSING for `gnome-terminal`, `kitty`
 * and `wezterm` (which spells it `start --`). Without it their parsers eat the
 * `-c` that belongs to the shell we are starting, and the window opens with the
 * emulator's own error instead of our command - the same class of defect the
 * `wt` rung has (D-23 / R-16).
 */
const POSIX_CANDIDATES: readonly PosixCandidate[] = Object.freeze([
  { name: 'terminal-env', probe: '$TERMINAL', execArgs: ['-e'] },
  { name: 'x-terminal-emulator', probe: 'x-terminal-emulator', execArgs: ['-e'] },
  { name: 'gnome-terminal', probe: 'gnome-terminal', execArgs: ['--'] },
  { name: 'konsole', probe: 'konsole', execArgs: ['-e'] },
  { name: 'xfce4-terminal', probe: 'xfce4-terminal', execArgs: ['-x'] },
  { name: 'kitty', probe: 'kitty', execArgs: ['--'] },
  { name: 'wezterm', probe: 'wezterm', execArgs: ['start', '--'] },
  { name: 'alacritty', probe: 'alacritty', execArgs: ['-e'] },
  { name: 'xterm', probe: 'xterm', execArgs: ['-e'] },
]);

/** The env var that overrides the shell the new window runs (D-7). */
export const ARAGON_BRANCH_SHELL_ENV = 'ARAGON_BRANCH_SHELL';

/**
 * A bare word is one PowerShell will not read as anything else.
 *
 * THE FIRST CHARACTER IS THE LOAD-BEARING PART (D-3). `@name` in argument position
 * is the SPLAT operator: `& node.exe -p 'process.argv.length' @foo` hands node an
 * EMPTY argument list, exits 0 and prints nothing (measured on Windows PowerShell
 * 5.1, branch-terminal-powershell-fix appendix B-11). As the only word on the line
 * it is not even parseable - `error col=1 id=SplattingNotPermitted`. Nothing after
 * the first character can do that, which is why the class differs in the first
 * position. `-` stays allowed there so that every flag this feature emits
 * (`--resume`) keeps its bare form, and quoting it would change nothing except the
 * look of the fallback line (appendix B-6 A/B, quoting is transparent to a native
 * exe).
 */
const BARE_POWER_SHELL_WORD_RE = /^[A-Za-z0-9._\\/:+=\-][A-Za-z0-9._\\/:+=@\-]*$/;

/**
 * Build the ladder for this platform, most-preferred rung first.
 *
 * The return value is a LIST because the failures this feature can actually hit
 * are synchronous argument rejections (ENOENT on `wt.exe`, no X display), and a
 * list lets `branch-launch.ts` walk down it without knowing anything about
 * terminals. Rung COUNT is bounded by the caller (`BRANCH_TERMINAL_LIMITS.maxRungs`),
 * so there is exactly one place that number lives.
 */
export function planTerminalLaunch(input: TerminalPlanInput): TerminalPlanResult {
  const isExecutable = input.isExecutable ?? defaultIsExecutable(input.platform, input.pathDirs);
  const platform = normalizePlatform(input.platform);
  if (platform === 'win32') {
    return {
      ok: true,
      plans: windowsPlans(input, isExecutable),
      shell: input.shell,
      manual: input.manual,
    };
  }
  const script = posixWindowScript(input.cwd, input.shell, input.command);
  const plans =
    platform === 'darwin'
      ? darwinPlans(isExecutable, script)
      : posixPlans(input, isExecutable, script);
  if (plans.length === 0) {
    // NOT AN ERROR STATE TO APOLOGISE FOR (K-2): an SSH session or a container has
    // no terminal emulator, and the honest answer - one pasteable command - is the
    // whole reason the manual line exists (I-4).
    return { ok: false, reason: 'no-launcher', shell: input.shell, manual: input.manual };
  }
  return { ok: true, plans, shell: input.shell, manual: input.manual };
}

function normalizePlatform(platform: NodeJS.Platform): TerminalPlatform {
  if (platform === 'win32') return 'win32';
  if (platform === 'darwin') return 'darwin';
  return 'posix';
}

/**
 * Windows: `wt` when we are demonstrably inside Windows Terminal, then `cmd`.
 *
 * THE `WT_SESSION` TEST IS NOT A CAPABILITY TEST, IT IS THE ONLY HONEST ONE WE
 * HAVE. Probing for `wt.exe` proves the binary exists, not that a Windows Terminal
 * is listening; `WT_SESSION` is set for every process a pane starts, so its
 * presence is the one signal that a new tab will land somewhere.
 */
function windowsPlans(
  input: TerminalPlanInput,
  isExecutable: (name: string) => boolean,
): TerminalLaunchPlan[] {
  const plans: TerminalLaunchPlan[] = [];
  const encoded = encodePowerShellCommand(powerShellScript(input.command));
  const inWindowsTerminal = (input.env.WT_SESSION ?? '').length > 0;
  if (inWindowsTerminal && isExecutable('wt.exe')) {
    plans.push({
      file: 'wt.exe',
      // `-d` IS THE CWD (D-16). `-w 0` reuses the current window, `nt` opens a new
      // tab, and `--` stops `wt` parsing the single-dash switches that belong to
      // PowerShell. This failure is UNOBSERVABLE: `wt.exe` forwards the request and
      // exits, so a rejected argument still produces a successful `'spawn'` event
      // and the ladder cannot fall back (K-1 / D-23).
      args: ['-w', '0', 'nt', '-d', input.cwd, '--title', input.title, '--', input.shell.path,
        '-NoExit', '-EncodedCommand', encoded],
      windowsVerbatimArguments: false,
      rung: 'wt',
    });
  }
  plans.push({
    file: 'cmd.exe',
    // `start`'s FIRST argument is the window title, and it must be present: an
    // empty string is what most snippets use, but naming the window is how a user
    // tells three branches apart in the taskbar (AC-1). The cwd needs no argument
    // at all - `cmd.exe` inherits the cwd we pass to `spawn` (I-9).
    args: ['/d', '/s', '/c', cmdStartLine(input.title, input.shell.path, encoded)],
    windowsVerbatimArguments: true,
    rung: 'cmd',
  });
  return plans;
}

/** `start "<title>" <shell> -NoExit -EncodedCommand <base64>`, one verbatim `cmd` line. */
function cmdStartLine(title: string, shellPath: string, encoded: string): string {
  return `start ${quoteWin32Arg(title)} ${quoteWin32Arg(shellPath)}` +
    ` -NoExit -EncodedCommand ${encoded}`;
}

/** macOS: Terminal.app via AppleScript; the script owns the cwd and the held-open shell. */
function darwinPlans(
  isExecutable: (name: string) => boolean,
  script: string,
): TerminalLaunchPlan[] {
  // `osascript` IS PROBED, unlike `cmd.exe`. It lives at `/usr/bin/osascript` on
  // every macOS install, so a failed probe means a broken PATH or a system without
  // the tool - and in that case "no terminal could be opened here" plus a pasteable
  // command is the honest answer (T-29), not a spawn that is certain to fail.
  if (!isExecutable('osascript')) return [];
  return [{
    file: 'osascript',
    args: [
      '-e',
      `tell application "Terminal" to do script "${escapeAppleScriptText(script)}"`,
      '-e',
      'tell application "Terminal" to activate',
    ],
    windowsVerbatimArguments: false,
    rung: 'osascript',
  }];
}

/** Every POSIX candidate that exists, in ladder order. */
function posixPlans(
  input: TerminalPlanInput,
  isExecutable: (name: string) => boolean,
  script: string,
): TerminalLaunchPlan[] {
  const plans: TerminalLaunchPlan[] = [];
  for (const candidate of POSIX_CANDIDATES) {
    const file = resolveCandidate(candidate, input.env);
    if (file === null || !isExecutable(file)) continue;
    plans.push({
      file,
      // The `cd` lives INSIDE the script, not in the emulator's argv: `-e` / `--` /
      // `-x` conventions all pass the rest of the argv to the shell unchanged, so a
      // script that starts with `cd` is correct for every rung - including rungs
      // that do not exist yet (D-16 / D-23).
      args: [...candidate.execArgs, input.shell.path, '-c', script],
      windowsVerbatimArguments: false,
      rung: candidate.name,
    });
  }
  return plans;
}

/**
 * The `$TERMINAL` escape hatch, with the D-7 trade-off spelled out: a value with
 * spaces (`"/usr/bin/code --reuse-window"`) is used as ONE executable path and
 * never split, because splitting needs a shell parser and a shell parser is what
 * re-introduces the quoting problem. Not found means "skip this rung".
 */
function resolveCandidate(
  candidate: PosixCandidate,
  env: Record<string, string | undefined>,
): string | null {
  if (candidate.probe !== '$TERMINAL') return candidate.probe;
  const value = env.TERMINAL;
  if (value === undefined || value.length === 0) return null;
  return value;
}

/**
 * The window script, used verbatim by both the AppleScript payload and `-c`.
 *
 * `cd` FIRST, THEN THE COMMAND, THEN `exec <shell> -i`. The trailing `exec` keeps
 * the window alive after `aragon` exits: the TUI writes its final transcript on
 * exit (`ui/exit-snapshot.ts`), and a window that closes at that instant swallows
 * the last screenful the user was about to read. `-c`, not `-lc` (R-15): a LOGIN
 * shell sources `~/.bash_profile` / `~/.zprofile`, which can be slow, noisy, or
 * PATH-changing, and holding the window open is already `exec ... -i`'s job.
 */
function posixWindowScript(
  cwd: string,
  shell: ShellInvocation,
  command: readonly string[],
): string {
  return `cd ${posixQuote(cwd)} && ${posixScript(command)} ; exec ${posixQuote(shell.path)} -i`;
}

/**
 * The PowerShell statement that runs the aragon command (D-1).
 *
 * THE LEADING `&` IS NOT DECORATION. In command position PowerShell reads a quoted
 * string as an EXPRESSION, so `'C:\Program Files\nodejs\node.exe' <script>` is a
 * parse error - "unexpected token ..." at column 36 - and the child is never
 * created, while the parent still believes the window opened (K-1: `wt`/`start`
 * forward and exit). That is exactly the report this branch exists to fix.
 * `&` is the call operator: it takes the following word as a command name whatever
 * its shape, and it does not change name resolution (`& 'npm.cmd'` still finds
 * `npm` through PATH/PATHEXT, appendix B-8).
 *
 * `posixScript` MUST NOT be given the same treatment: in sh `&` means run in the
 * background, so the window would reach the trailing `exec <shell> -i` immediately
 * and the branch would start behind a prompt that looks idle (I-3 / K-1).
 */
export function powerShellScript(parts: readonly string[]): string {
  // TOTAL, NOT THROWING (D-4): an empty argv cannot arise from
  // `resolveAragonCommand` (T-3 pins that), and an empty script is a parse-valid
  // no-op rather than a throw inside a key handler.
  if (parts.length === 0) return '';
  return ['&', ...parts.map(powerShellQuote)].join(' ');
}

/** Bare words stay bare; everything else becomes a single-quoted literal. */
export function powerShellQuote(value: string): string {
  if (BARE_POWER_SHELL_WORD_RE.test(value)) return value;
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * `-EncodedCommand` takes base64 of UTF-16LE, which needs no shell quoting at all.
 *
 * The alphabet is `A-Za-z0-9+/=` - no spaces, no quotes, no `cmd` metacharacters -
 * so the blob survives all three of Windows' parsers as an ordinary word. This is
 * the same trick `ui/win-vt-force.ts` uses, for the same reason: encode the fragile
 * thing into a form nothing can argue with, at construction time. Our command line
 * necessarily contains spaced paths (`C:\Program Files\nodejs\node.exe`), so the
 * fragile thing is not hypothetical.
 */
export function encodePowerShellCommand(script: string): string {
  return Buffer.from(script, 'utf16le').toString('base64');
}

/** POSIX single-quote escaping: `'` becomes `'\''`. */
export function posixQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

export function posixScript(parts: readonly string[]): string {
  return parts.map(posixQuote).join(' ');
}

/** AppleScript string literals only need `\` and `"` escaped. */
export function escapeAppleScriptText(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/**
 * Win32 argv quoting for the `cmd` rung's title and shell path: quote when it
 * contains whitespace, otherwise leave it alone.
 *
 * THE INPUT DOMAIN EXCLUDES `"` BY CONSTRUCTION (R-17/T-48): Windows paths cannot
 * contain it, and the title is `aragon <id>` where an id is `[A-Za-z0-9._-]`. If a
 * future source can contain a quote, this must switch to `cmd`'s rule (`""`) and
 * not to the POSIX `\"` written here - the two are not interchangeable.
 */
export function quoteWin32Arg(value: string): string {
  return /\s/.test(value) ? `"${value}"` : value;
}

/** PATH entries for `name` probing: both spellings on Windows, `:` on POSIX. */
export function pathDirsOf(
  env: Record<string, string | undefined>,
  platform: NodeJS.Platform,
): string[] {
  if (normalizePlatform(platform) === 'win32') {
    // `Path` and `PATH` genuinely coexist in a Windows env object (Node copies what
    // it was given), and reading only one of them is how a probe silently finds
    // nothing. Both are read, in that order, deduplicated.
    const dirs: string[] = [];
    for (const key of ['Path', 'PATH']) {
      const value = env[key];
      if (value === undefined || value.length === 0) continue;
      for (const dir of value.split(';')) {
        if (dir.length > 0 && !dirs.includes(dir)) dirs.push(dir);
      }
    }
    return dirs;
  }
  const value = env.PATH ?? '';
  return value.split(':').filter((dir) => dir.length > 0);
}

/**
 * The default probe: is this a file we could execute?
 *
 * An absolute or separator-bearing value is stat'd directly (that is the
 * `ARAGON_BRANCH_SHELL=/usr/local/bin/fish` case); a bare name is looked up in the
 * PATH directories, trying `name` and - on Windows - `name + '.exe'`, because a
 * user typing `pwsh` and a probe looking for `pwsh.exe` are the same request.
 *
 * EVERY EXCEPTION RETURNS FALSE: one failed stat means "this candidate is not
 * here", not "the feature is broken", and a missing terminal must degrade to the
 * manual command rather than throw out of a key handler.
 */
export function defaultIsExecutable(
  platform: NodeJS.Platform,
  pathDirs?: readonly string[],
): (name: string) => boolean {
  const windows = normalizePlatform(platform) === 'win32';
  const dirs = pathDirs ?? pathDirsOf(process.env as Record<string, string | undefined>, platform);
  return (name: string): boolean => {
    if (name.length === 0) return false;
    const suffixes = windows && !/\.exe$/i.test(name) ? [name, `${name}.exe`] : [name];
    if (isAbsolute(name) || /[\\/]/.test(name)) {
      return suffixes.some((suffix) => isFile(suffix));
    }
    return dirs.some((dir) => suffixes.some((suffix) => isFile(join(dir, suffix))));
  };
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * Which shell the new window runs (D-7), first match wins.
 *
 * The requirement says "PowerShell / bash", and both platforms have two answers
 * worth distinguishing: PowerShell 7 (`pwsh.exe`) when the user installed it,
 * Windows PowerShell 5.1 otherwise; `$SHELL` when the user's login shell is not
 * bash, then bash, then `/bin/sh` as the one path that exists everywhere.
 * `ARAGON_BRANCH_SHELL` is the escape hatch - an ENV VALUE, not a config key
 * (D-17): a "Ctrl+L opens no terminal" switch would create the one state this
 * feature must never have.
 */
export function resolveShell(input: {
  platform: NodeJS.Platform;
  env: Record<string, string | undefined>;
  isExecutable?: (name: string) => boolean;
  pathDirs: readonly string[];
}): ShellInvocation {
  // `pathDirs` is FORWARDED, not dropped: a caller that supplies its own PATH
  // (a test, or `branch-launch.ts` with the injected env) must not have the shell
  // probe silently fall back to `process.env`'s PATH.
  const isExecutable = input.isExecutable ?? defaultIsExecutable(input.platform, input.pathDirs);
  const override = input.env[ARAGON_BRANCH_SHELL_ENV];
  const platform = normalizePlatform(input.platform);
  if (platform === 'win32') {
    if (override !== undefined && override.length > 0 && isExecutable(override)) {
      return { path: override, kind: 'powershell' };
    }
    if (isExecutable('pwsh.exe')) return { path: 'pwsh.exe', kind: 'powershell' };
    return { path: 'powershell.exe', kind: 'powershell' };
  }
  if (override !== undefined && override.length > 0) {
    return { path: override, kind: 'posix' };
  }
  const loginShell = input.env.SHELL;
  if (loginShell !== undefined && isAbsolute(loginShell)) {
    return { path: loginShell, kind: 'posix' };
  }
  if (isExecutable('bash')) return { path: 'bash', kind: 'posix' };
  return { path: '/bin/sh', kind: 'posix' };
}

/**
 * Fit a window title into `maxCells` columns (R-7 / T-47).
 *
 * THE TITLE IS THE ONLY THING THIS TOUCHES. An id can be 64 characters long, so
 * `aragon <id>` exceeds the 60-cell budget by construction for the longest ids -
 * and truncating the id anywhere else (the command line, `--resume`) would produce
 * a branch that cannot find its own parent. Code points, not bytes: the title is
 * ASCII today, and a future non-ASCII title must not be cut through a surrogate
 * pair.
 */
export function truncateTitle(title: string, maxCells: number): string {
  const chars = Array.from(title);
  // A budget that is not a usable number is a caller bug, not a reason to destroy
  // the title: clamping to one character would be silently worse than not cutting.
  if (!Number.isFinite(maxCells) || maxCells < 1) return title;
  if (chars.length <= maxCells) return title;
  return chars.slice(0, Math.floor(maxCells)).join('');
}
