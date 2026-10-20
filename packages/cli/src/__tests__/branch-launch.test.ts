/**
 * The branch port: flush, plan, spawn (tui-branch-terminal-shortcut 7.1
 * T-11..T-18, T-31..T-35, T-46, T-50).
 *
 * TWO PROPERTIES CARRY THIS FILE, and both are invisible in a screenshot:
 *
 *  1. ORDER. The checkpoint has to return `ok` before anything is spawned (I-1).
 *     The trace assertions below are the only way to see that the two line up, and
 *     a future "let me spawn first, it is faster" refactor fails here.
 *  2. THE LATE ERROR (I-10). A `once('error')` implementation passes every other
 *     test in this file and then kills the parent TUI the first time a child
 *     reports an error after `'spawn'`. T-35 is therefore written against the
 *     permanent listener specifically.
 */

import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BRANCH_COPY, type BranchCommandPort } from '../commands/branch-command.js';
import { renderManualCommand } from '../session/branch-invocation.js';
import { createBranchLauncher, type BranchLauncherDeps } from '../session/branch-launch.js';
import { BRANCH_TERMINAL_LIMITS } from '../session/limits.js';

const ID = 'a4k2m9';
const CWD = '/work/project';
const ENV = { PATH: '/usr/bin:/bin' } as Record<string, string | undefined>;

/** The live defect's shape: a spaced `process.execPath` and an npm-global launcher. */
const WIN_EXEC = 'C:\\Program Files\\nodejs\\node.exe';
const WIN_LAUNCHER =
  'C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\@aragon-agent\\cli\\dist\\launcher.js';
const WIN_ENV = { Path: 'C:\\Windows\\System32', WT_SESSION: 'a-guid' } as Record<
  string,
  string | undefined
>;
const WIN_CWD = 'C:\\work\\demo project';

/** A fake ChildProcess: enough surface for `trySpawn`, and observable. */
interface FakeChild extends EventEmitter {
  unref: () => void;
  emitSpawnAfterAttach: () => void;
  emitErrorAfterAttach: (error: Error) => void;
}

interface SpawnCall {
  file: string;
  args: readonly string[];
  options: Record<string, unknown>;
}

/**
 * Build a spawn stub. `behaviour` decides what each spawned child does, in order:
 * `'spawn'` emits the success event, `'error'` emits an ENOENT, `'silent'` emits
 * neither (which the probe must treat as success after the timeout).
 */
function spawnStub(
  behaviour: readonly ('spawn' | 'error' | 'silent')[],
  trace?: string[],
): {
  spawn: NonNullable<BranchLauncherDeps['spawn']>;
  calls: SpawnCall[];
  children: FakeChild[];
} {
  const calls: SpawnCall[] = [];
  const children: FakeChild[] = [];
  const spawn = ((file: string, args: readonly string[], options: Record<string, unknown>) => {
    const index = calls.length;
    calls.push({ file, args, options });
    trace?.push('spawn');
    const child = new EventEmitter() as FakeChild;
    child.unref = vi.fn();
    const mode = behaviour[index] ?? 'spawn';
    child.emitSpawnAfterAttach = () => queueMicrotask(() => child.emit('spawn'));
    child.emitErrorAfterAttach = (error: Error) => queueMicrotask(() => child.emit('error', error));
    if (mode === 'spawn') child.emitSpawnAfterAttach();
    if (mode === 'error') {
      const error = Object.assign(new Error('spawn konsole ENOENT'), { code: 'ENOENT' });
      child.emitErrorAfterAttach(error);
    }
    children.push(child);
    return child;
  }) as unknown as NonNullable<BranchLauncherDeps['spawn']>;
  return { spawn, calls, children };
}

function deps(
  overrides: Partial<BranchLauncherDeps> = {},
): BranchLauncherDeps & { trace: string[] } {
  const trace: string[] = [];
  return {
    trace,
    checkpoint: () => {
      trace.push('checkpoint');
      return { ok: true };
    },
    platform: 'linux',
    env: ENV,
    argv: ['node', '/repo/packages/cli/dist/cli.js'],
    execPath: '/usr/bin/node',
    isExecutable: (name: string) => name === 'konsole' || name === 'bash',
    logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn(), trace: vi.fn() },
    ...overrides,
  } as BranchLauncherDeps & { trace: string[] };
}

afterEach(() => {
  vi.useRealTimers();
});

/**
 * Windows deps: the live defect's `kind: 'script'` shape, `WT_SESSION` set so the
 * ladder has both rungs, and a probe that finds exactly `wt.exe` / `powershell.exe`.
 */
function win32Deps(overrides: Partial<BranchLauncherDeps> = {}): BranchLauncherDeps {
  return deps({
    platform: 'win32',
    execPath: WIN_EXEC,
    argv: ['node', WIN_LAUNCHER],
    env: WIN_ENV,
    isExecutable: (name: string) => name === 'wt.exe' || name === 'powershell.exe',
    ...overrides,
  });
}

/** The `-EncodedCommand` payload a rung was actually spawned with. */
function encodedWord(call: SpawnCall): string {
  const last = call.args[call.args.length - 1]!;
  return last.slice(last.lastIndexOf(' ') + 1);
}

/** The win32 paste block, asserted by shape rather than by one long literal. */
function expectTwoLineBlock(command: string): void {
  expect(command.startsWith('PowerShell: & ')).toBe(true);
  expect(command).toContain('\ncmd.exe   : ');
  expect(command.split('\n')).toHaveLength(2);
}

describe('T-11 / T-12 / T-18 / I-1: the flush happens first', () => {
  it('forces a checkpoint before spawning, in that order', async () => {
    const trace: string[] = [];
    const spawn = spawnStub(['spawn'], trace);
    const flush = vi.fn(() => {
      trace.push('checkpoint');
      return { ok: true };
    });
    const launcher = createBranchLauncher({ ...deps(), checkpoint: flush, spawn: spawn.spawn });

    const result = await launcher.open({ id: ID, cwd: CWD });

    expect(result.ok).toBe(true);
    // `force: true` is not decoration: without it the writer short-circuits on an
    // unchanged fingerprint and the child can read a file that does not exist (D-3).
    expect(flush).toHaveBeenCalledWith({ force: true });
    // ORDER IS THE ASSERTION (I-1): the flush has already happened when the child
    // is created, because the child's first act is to read that file.
    expect(trace).toEqual(['checkpoint', 'spawn']);
  });

  it('spawns ZERO times when the checkpoint fails', async () => {
    const spawn = spawnStub(['spawn']);
    const launcher = createBranchLauncher({
      ...deps(),
      argv: ['node'],
      checkpoint: () => ({ ok: false, message: 'not-sendable' }),
      spawn: spawn.spawn,
    });

    const result = await launcher.open({ id: ID, cwd: CWD });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('checkpoint-failed');
    expect(spawn.calls).toHaveLength(0);
    expect(result.command).toBe('aragon --resume a4k2m9');
  });

  it('applies to a session whose first frame has not been written yet', async () => {
    const flush = vi.fn(() => ({ ok: true }));
    const spawn = spawnStub(['spawn']);
    const launcher = createBranchLauncher({ ...deps(), checkpoint: flush, spawn: spawn.spawn });

    await launcher.open({ id: ID, cwd: CWD });

    expect(flush).toHaveBeenCalledWith({ force: true });
    expect(spawn.calls).toHaveLength(1);
  });
});

describe('T-13 / T-14 / D-5 / I-3: what is spawned and how', () => {
  it('puts --resume and the id on the command line and checkpoints exactly once', async () => {
    const spawn = spawnStub(['spawn']);
    const flush = vi.fn(() => ({ ok: true }));
    // `argv[1]` is not an absolute script path here, so the command is the bare
    // bin name - the shape a global install produces (D-8).
    const launcher = createBranchLauncher({
      ...deps(), argv: ['node'], checkpoint: flush, spawn: spawn.spawn,
    });

    const result = await launcher.open({ id: ID, cwd: CWD });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.command).toBe('aragon --resume a4k2m9');
    expect(result.rung).toBe('konsole');
    expect(result.shell).toBe('bash');
    expect(spawn.calls[0]!.args.join(' ')).toContain('--resume');
    expect(spawn.calls[0]!.args.join(' ')).toContain(ID);
    // One flush, not two: the parent file is written by its own writer, once (I-2).
    expect(flush).toHaveBeenCalledTimes(1);
  });

  it('records WHICH aragon the new window ran, so "nothing happened" is answerable', async () => {
    // D-18's reason for a dedicated scope: the only trace of a subsystem whose
    // whole output goes to a window this process does not own. `origin` is the
    // field that answers "which aragon did it run" - `aragon` from PATH,
    // `node <script>`, or the env override - and it has no other consumer.
    const logger = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn(), trace: vi.fn() };
    const spawn = spawnStub(['spawn']);
    const launcher = createBranchLauncher({ ...deps(), spawn: spawn.spawn, logger });

    await launcher.open({ id: ID, cwd: CWD });

    expect(logger.info).toHaveBeenCalledWith('opened', expect.objectContaining({
      id: ID,
      rung: 'konsole',
      shell: 'bash',
      aragon: 'script',
      origin: 'process.execPath + process.argv[1]',
    }));
  });

  it('detaches, ignores stdio, inherits env, and passes the requested cwd', async () => {
    const spawn = spawnStub(['spawn']);
    const launcher = createBranchLauncher({ ...deps(), spawn: spawn.spawn });

    await launcher.open({ id: ID, cwd: CWD });

    const options = spawn.calls[0]!.options;
    expect(options.detached).toBe(true);
    // I-3: the child's streams must never join Ink's, or its bytes arrive as a
    // foreign write to the frame differ.
    expect(options.stdio).toBe('ignore');
    expect(options.windowsHide).toBe(false);
    // K-7: the WHOLE environment, because `ARAGON_HOME` is how the child finds the
    // same sessions directory and `ARAGON_*` is user configuration.
    expect(options.env).toBe(ENV);
    expect(options.cwd).toBe(CWD);
  });
});

describe('T-15 / I-4 / T-9: every failure is recoverable', () => {
  it('reports no-launcher with the pasteable command when nothing can be spawned', async () => {
    const launcher = createBranchLauncher({
      ...deps(),
      argv: ['node'],
      isExecutable: () => false,
      spawn: spawnStub(['spawn']).spawn,
    });

    const result = await launcher.open({ id: ID, cwd: CWD });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('no-launcher');
    expect(result.command).toBe('aragon --resume a4k2m9');
    expect(result.message).toContain(result.command);
  });
});

describe('T-17 / D-9: the id gate at the boundary', () => {
  it('refuses an illegal id without spawning', async () => {
    const spawn = spawnStub(['spawn']);
    const flush = vi.fn(() => ({ ok: true }));
    const launcher = createBranchLauncher({ ...deps(), checkpoint: flush, spawn: spawn.spawn });

    const result = await launcher.open({ id: '../etc/passwd', cwd: CWD });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('spawn-failed');
    expect(result.message).toContain('not a legal file name');
    expect(spawn.calls).toHaveLength(0);
  });
});

describe('T-31 / T-32 / D-10: the cooldown', () => {
  it('refuses a second press inside the window and accepts one after it', async () => {
    let clock = 1_000;
    const spawn = spawnStub(['spawn', 'spawn']);
    const launcher = createBranchLauncher({ ...deps(), spawn: spawn.spawn, now: () => clock });

    expect((await launcher.open({ id: ID, cwd: CWD })).ok).toBe(true);
    clock += 1;
    const blocked = await launcher.open({ id: ID, cwd: CWD });
    expect(blocked.ok).toBe(false);
    if (blocked.ok) return;
    expect(blocked.reason).toBe('cooldown');
    expect(blocked.retryInMs).toBeGreaterThan(0);
    expect(blocked.message).toBe(BRANCH_COPY.cooldown(blocked.retryInMs!));
    expect(spawn.calls).toHaveLength(1);

    clock += BRANCH_TERMINAL_LIMITS.cooldownMs;
    expect((await launcher.open({ id: ID, cwd: CWD })).ok).toBe(true);
    expect(spawn.calls).toHaveLength(2);
  });

  it('does NOT consume the cooldown when the attempt failed', async () => {
    // D-10's second clause: "it did not open" must be retryable immediately.
    const spawn = spawnStub(['error', 'spawn']);
    let clock = 1_000;
    const launcher = createBranchLauncher({ ...deps(), spawn: spawn.spawn, now: () => clock });

    const failed = await launcher.open({ id: ID, cwd: CWD });
    expect(failed.ok).toBe(false);
    clock += 1;
    const retried = await launcher.open({ id: ID, cwd: CWD });
    expect(retried.ok).toBe(true);
  });
});

describe('T-33 / K-1: the ladder', () => {
  it('falls to the next rung when the first reports ENOENT', async () => {
    // Two POSIX candidates exist, so the ladder has a second step to take.
    const spawn = spawnStub(['error', 'spawn']);
    const launcher = createBranchLauncher({
      ...deps(),
      isExecutable: (name: string) => name === 'konsole' || name === 'xterm',
      spawn: spawn.spawn,
    });

    const result = await launcher.open({ id: ID, cwd: CWD });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rung).toBe('xterm');
    expect(spawn.calls).toHaveLength(2);
  });

  it('reports spawn-failed when every rung fails, and stops at maxRungs', async () => {
    const spawn = spawnStub(['error', 'error', 'error', 'error']);
    const launcher = createBranchLauncher({
      ...deps(),
      isExecutable: () => true,
      spawn: spawn.spawn,
    });

    const result = await launcher.open({ id: ID, cwd: CWD });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('spawn-failed');
    expect(result.message).toContain('ENOENT');
    expect(result.message).toContain(result.command);
    expect(spawn.calls).toHaveLength(BRANCH_TERMINAL_LIMITS.maxRungs);
  });
});

describe('T-34 / K-8: a missing spawn event counts as success', () => {
  it('treats the probe timeout as an opened window', async () => {
    vi.useFakeTimers();
    const spawn = spawnStub(['silent']);
    const launcher = createBranchLauncher({ ...deps(), spawn: spawn.spawn });

    const pending = launcher.open({ id: ID, cwd: CWD });
    await vi.advanceTimersByTimeAsync(BRANCH_TERMINAL_LIMITS.spawnProbeMs + 10);
    const result = await pending;

    // Reporting a failure here produces the worse error: the window IS open and the
    // UI says it is not (K-8).
    expect(result.ok).toBe(true);
  });
});

describe('T-35 / I-10 / R-3: the late error', () => {
  it('routes an error that arrives after success to onLateError, and never throws', async () => {
    const spawn = spawnStub(['spawn']);
    const logger = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn(), trace: vi.fn() };
    const onLateError = vi.fn();
    const launcher = createBranchLauncher({ ...deps(), spawn: spawn.spawn, logger });

    const result = await launcher.open({ id: ID, cwd: CWD, onLateError });
    expect(result.ok).toBe(true);

    // The child reports a failure AFTER the window opened. A `once('error')` probe
    // would have consumed its listener by now and this emit would reach the process
    // top level - the parent TUI's death, which is what I-10 exists to forbid.
    spawn.children[0]!.emit('error', new Error('terminal vanished'));

    expect(onLateError).toHaveBeenCalledWith(BRANCH_COPY.lateError('terminal vanished'));
    expect(logger.warn).toHaveBeenCalledWith(
      'late_error',
      expect.objectContaining({ message: 'terminal vanished' }),
    );
  });

  it('does not re-settle the probe when the first error already failed the rung', async () => {
    const spawn = spawnStub(['error', 'spawn']);
    const onLateError = vi.fn();
    const launcher = createBranchLauncher({
      ...deps(),
      isExecutable: (name: string) => name === 'konsole' || name === 'xterm',
      spawn: spawn.spawn,
    });

    const result = await launcher.open({ id: ID, cwd: CWD, onLateError });
    expect(result.ok).toBe(true);
    // The first rung's child emits a SECOND error after it already failed: it is a
    // late error for the user, not a reason to try a third rung.
    spawn.children[0]!.emit('error', new Error('again'));
    expect(onLateError).toHaveBeenCalledTimes(1);
  });
});

describe('T-46 / R-7: an over-long command line is refused before any spawn', () => {
  it('reports spawn-failed with zero spawns and keeps the command in the result', async () => {
    const spawn = spawnStub(['spawn']);
    const launcher = createBranchLauncher({
      ...deps(),
      env: {
        ...ENV,
        ARAGON_BRANCH_COMMAND: `/${'x'.repeat(BRANCH_TERMINAL_LIMITS.maxCommandLineCells)}`,
      },
      spawn: spawn.spawn,
    });

    const result = await launcher.open({ id: ID, cwd: CWD });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('spawn-failed');
    // A COMPLETE SENTENCE, NOT THE REASON CODE (I-4 / appendix A). `command line too
    // long` alone is the kind of internal answer that leaves a user with nothing to
    // do; the sentence has to carry the pasteable fallback like every other failure.
    expect(result.message).toBe(BRANCH_COPY.spawnFailed('command line too long', result.command));
    expect(result.message).toContain('Run this in another terminal:');
    expect(result.message).toContain(result.command);
    expect(result.command.length).toBeGreaterThan(BRANCH_TERMINAL_LIMITS.maxCommandLineCells);
    // A truncated `cmd` line opens a window that fails where nobody can see it.
    expect(spawn.calls).toHaveLength(0);
  });
});

describe('T-50 / R-19: the no-identity checkpoint answer', () => {
  it('repeats the /session sentence instead of printing the internal reason code', async () => {
    const spawn = spawnStub(['spawn']);
    const launcher = createBranchLauncher({
      ...deps(),
      checkpoint: () => ({ ok: false, message: 'no-identity' }),
      spawn: spawn.spawn,
    });

    const result = await launcher.open({ id: ID, cwd: CWD });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toBe(BRANCH_COPY.noIdentity);
    // "Could not checkpoint this session (no-identity)" reads like disk corruption;
    // it is only "this frame has no id yet".
    expect(result.message).not.toContain('no-identity');
    expect(spawn.calls).toHaveLength(0);
  });
});

describe('R-13 / K-14: resolution is cached, failures are not', () => {
  it('resolves the shell once across two opens', async () => {
    let clock = 1_000;
    const probe = vi.fn((name: string) => name === 'konsole' || name === 'bash');
    const spawn = spawnStub(['spawn', 'spawn']);
    const launcher = createBranchLauncher({
      ...deps(),
      isExecutable: probe,
      spawn: spawn.spawn,
      now: () => clock,
    });

    await launcher.open({ id: ID, cwd: CWD });
    const shellProbesAfterFirst = probe.mock.calls.filter((call) => call[0] === 'bash').length;
    clock += BRANCH_TERMINAL_LIMITS.cooldownMs + 1;
    await launcher.open({ id: ID, cwd: CWD });

    // `resolveShell` runs once per process: `$SHELL` -> `bash` -> `/bin/sh` is up to
    // three PATH walks, and paying them on every keypress is a frame of jitter. The
    // terminal LADDER is deliberately re-probed (a terminal may have been installed
    // in between), which is why only the shell probe is counted here.
    expect(shellProbesAfterFirst).toBe(1);
    expect(probe.mock.calls.filter((call) => call[0] === 'bash')).toHaveLength(1);
    expect(spawn.calls).toHaveLength(2);
  });
});

describe('T-12 / D-1 / I-1: the win32 window receives a script starting with &', () => {
  const EXPECTED = `& '${WIN_EXEC}' ${WIN_LAUNCHER} --resume ${ID}`;

  it('encodes the same call-operator script for both rungs', async () => {
    const spawn = spawnStub(['error', 'spawn']);
    const launcher = createBranchLauncher({ ...win32Deps(), spawn: spawn.spawn });

    const result = await launcher.open({ id: ID, cwd: WIN_CWD });

    // The first rung's child reports ENOENT, so BOTH rungs are really spawned -
    // which is what makes this an assertion about the payload rather than about the
    // one rung the ladder happened to stop on.
    expect(result.ok).toBe(true);
    expect(spawn.calls.map((call) => call.file)).toEqual(['wt.exe', 'cmd.exe']);
    for (const call of spawn.calls) {
      const script = Buffer.from(encodedWord(call), 'base64').toString('utf16le');
      expect(script).toBe(EXPECTED);
    }
  });
});

describe('T-9a / T-9b / D-7 / I-4: every win32 failure carries the two-line block', () => {
  /** A launcher plus the id it will be asked to open. */
  interface FailureScenario {
    label: string;
    id: string;
    launcher: BranchCommandPort;
  }

  function scenarios(): FailureScenario[] {
    const tooLong = `/${'x'.repeat(BRANCH_TERMINAL_LIMITS.maxCommandLineCells)}`;
    const spawns = (behaviour: readonly ('spawn' | 'error' | 'silent')[]) =>
      spawnStub(behaviour).spawn;
    return [
      {
        label: 'checkpoint-failed',
        id: ID,
        launcher: createBranchLauncher({
          ...win32Deps(),
          checkpoint: () => ({ ok: false, message: 'not-sendable' }),
          spawn: spawns(['spawn']),
        }),
      },
      {
        label: 'illegal-id',
        id: '../etc/passwd',
        launcher: createBranchLauncher({ ...win32Deps(), spawn: spawns(['spawn']) }),
      },
      {
        label: 'too-long',
        id: ID,
        launcher: createBranchLauncher({
          ...win32Deps({ env: { ...WIN_ENV, ARAGON_BRANCH_COMMAND: tooLong } }),
          spawn: spawns(['spawn']),
        }),
      },
      {
        label: 'spawn-failed',
        id: ID,
        launcher: createBranchLauncher({ ...win32Deps(), spawn: spawns(['error', 'error']) }),
      },
    ];
  }

  it('T-9a: every reachable failure reason returns the two-line block', async () => {
    const collected: { label: string; command: string }[] = [];
    for (const scenario of scenarios()) {
      const result = await scenario.launcher.open({ id: scenario.id, cwd: WIN_CWD });
      expect(result.ok).toBe(false);
      collected.push({ label: scenario.label, command: result.command });
    }

    // The cooldown arm too: it never displays the block, but the result type has one
    // meaning for `command` and this is the arm where that is easiest to forget.
    let clock = 1_000;
    const cool = createBranchLauncher({
      ...win32Deps(),
      spawn: spawnStub(['spawn', 'spawn']).spawn,
      now: () => clock,
    });
    expect((await cool.open({ id: ID, cwd: WIN_CWD })).ok).toBe(true);
    clock += 1;
    const throttled = await cool.open({ id: ID, cwd: WIN_CWD });
    expect(throttled.ok).toBe(false);
    collected.push({ label: 'cooldown', command: throttled.command });

    expect(collected.map((entry) => entry.label)).toEqual([
      'checkpoint-failed', 'illegal-id', 'too-long', 'spawn-failed', 'cooldown',
    ]);
    for (const entry of collected) expectTwoLineBlock(entry.command);
  });

  it('T-9b: only noLauncher and spawnFailed embed the block in their sentence', async () => {
    // I-4's ACCURATE BOUNDARY (R-4): the two failures whose sentence exists to say
    // "here is a command" carry it; the two whose sentence exists to explain WHY
    // nothing opened do not, or the user reads two unrelated statements at once.
    const [checkpoint, illegalId, , everyRungFailed] = scenarios();

    const failed = await checkpoint!.launcher.open({ id: checkpoint!.id, cwd: WIN_CWD });
    expect(failed.ok).toBe(false);
    if (failed.ok) return;
    expect(failed.message).toBe(BRANCH_COPY.checkpointFailed('not-sendable'));
    expect(failed.message).not.toContain(failed.command);
    expectTwoLineBlock(failed.command);

    const invalid = await illegalId!.launcher.open({ id: illegalId!.id, cwd: WIN_CWD });
    expect(invalid.ok).toBe(false);
    if (invalid.ok) return;
    expect(invalid.message).not.toContain(invalid.command);
    expectTwoLineBlock(invalid.command);

    const spawnFailed = await everyRungFailed!.launcher.open({
      id: everyRungFailed!.id,
      cwd: WIN_CWD,
    });
    expect(spawnFailed.ok).toBe(false);
    if (spawnFailed.ok) return;
    expect(spawnFailed.message).toContain(spawnFailed.command);
    expect(spawnFailed.message.startsWith('Could not start the terminal (')).toBe(true);
  });

  it('AC-5a: noLauncher prints the block verbatim, one labelled line per shell', () => {
    // `no-launcher` is UNREACHABLE on win32 - `windowsPlans()` pushes the `cmd.exe`
    // rung unconditionally, so a Windows ladder is never empty (see the implementation
    // note appended to the spec). The block and its sentence are therefore asserted
    // through the same pair of functions the launcher calls, which is what AC-5a
    // actually wants to pin.
    const parts = [WIN_EXEC, WIN_LAUNCHER, '--resume', ID];
    expect(BRANCH_COPY.noLauncher(renderManualCommand(parts, 'win32'))).toBe(
      'No terminal window could be opened here. Run this in another terminal:\n' +
      `PowerShell: & '${WIN_EXEC}' ${WIN_LAUNCHER} --resume ${ID}\n` +
      `cmd.exe   : "${WIN_EXEC}" ${WIN_LAUNCHER} --resume ${ID}`,
    );
  });

  it('keeps the POSIX no-launcher fallback a SINGLE line', async () => {
    const launcher = createBranchLauncher({
      ...deps(),
      argv: ['node'],
      isExecutable: () => false,
      spawn: spawnStub(['spawn']).spawn,
    });

    const result = await launcher.open({ id: ID, cwd: CWD });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    // C-7: the win32 two-line block must not leak into the POSIX path.
    expect(result.command).toBe('aragon --resume a4k2m9');
    expect(result.command).not.toContain('\n');
  });
});

describe('T-13 / C-7: the POSIX command line is byte-for-byte what it was', () => {
  it('still reports `aragon --resume <id>` on linux', async () => {
    const launcher = createBranchLauncher({
      ...deps(), argv: ['node'], spawn: spawnStub(['spawn']).spawn,
    });

    const result = await launcher.open({ id: ID, cwd: CWD });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.command).toBe('aragon --resume a4k2m9');
  });
});

