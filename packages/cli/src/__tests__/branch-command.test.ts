/**
 * `/branch` and the command resolution behind it (tui-branch-terminal-shortcut
 * 7.1 T-1..T-10, plus v2's T-45).
 *
 * ONE FILE FOR TWO MODULES, the way `session-command.test.ts` covers the command
 * body and its port together: T-1..T-6 pin the pure functions
 * (`session/branch-invocation.ts`), T-7..T-10 and T-45 pin the body against a stub
 * port. The module rename (R-22) changed no file boundary.
 *
 * THE CHANNEL IS PART OF THE ASSERTION. "Success to the toast, failure to the
 * notice, cooldown to the toast" (D-12) is a decision with a reason behind each
 * arm - a failure the user must be able to read and copy may not vanish after
 * three seconds - so the tests distinguish them rather than counting `notify`.
 */

import { describe, expect, it, vi } from 'vitest';
import { initialViewState, type ViewAction } from '../agent/reducer.js';
import {
  BRANCH_COPY,
  runBranchCommand,
  type BranchCommandPort,
} from '../commands/branch-command.js';
import { CommandRegistry, type CommandContext } from '../commands/registry.js';
import { registerBuiltinCommands } from '../commands/builtins.js';
import {
  BRANCH_RESUME_FLAG,
  buildResumeInvocation,
  joinCommandLine,
  renderManualCommand,
  resolveAragonCommand,
  validateBranchId,
} from '../session/branch-invocation.js';
import { powerShellScript } from '../proc/terminal-plan.js';
import type { BranchOpenResult, BranchRequest } from '../session/branch-launch.js';
import type { SessionIdentity } from '../session/startup-session.js';

const IDENTITY: SessionIdentity = { id: 'a4k2m9-x7f2', kind: 'branch', parentId: 'a4k2m9' };

/**
 * The three session-bridge members `/branch` may touch, as spies.
 *
 * A FRESH OBJECT PER TEST (`{ ...SESSION_STUB }`): `checkpoint` / `rotate` are
 * asserted NOT to be called (I-5), so two tests sharing one stub would let a call
 * from one hide in the other's history.
 */
const SESSION_STUB = {
  identity: () => IDENTITY,
  checkpoint: vi.fn(),
  rotate: vi.fn(),
};

function context(overrides: Partial<CommandContext> = {}): CommandContext {
  return {
    args: '',
    state: initialViewState(),
    // The two members `/branch` reads, cast because a stub cannot satisfy 176
    // members of `AgentController` and these tests are about the two.
    controller: {
      getCwd: () => '/work/project',
      isRunning: () => false,
    } as unknown as CommandContext['controller'],
    dispatch: vi.fn<(action: ViewAction) => void>(),
    notify: vi.fn(),
    toast: vi.fn(),
    ...overrides,
  } as unknown as CommandContext;
}

/** A stub port that records its requests and answers with one fixed result. */
function port(result: BranchOpenResult): BranchCommandPort & { requests: BranchRequest[] } {
  const requests: BranchRequest[] = [];
  return {
    requests,
    open: async (request) => {
      requests.push(request);
      return result;
    },
  };
}

/** A successful answer; only `rung` is ever asserted on. */
function opened(rung: string): BranchOpenResult {
  return { ok: true, command: 'aragon --resume a4k2m9-x7f2', shell: 'bash', rung };
}

describe('T-1..T-3 / D-8: what the new window runs', () => {
  it('uses ARAGON_BRANCH_COMMAND as ONE executable and never splits it', () => {
    const resolved = resolveAragonCommand({
      argv: ['node', '/repo/packages/cli/dist/cli.js'],
      execPath: '/usr/bin/node',
      env: { ARAGON_BRANCH_COMMAND: '/opt/aragon wrap --flag' },
    });
    expect(resolved.kind).toBe('override');
    expect(resolved.parts).toEqual(['/opt/aragon wrap --flag']);
  });

  it('reconstructs a script invocation from execPath and an absolute argv[1]', () => {
    for (const extension of ['.js', '.cjs', '.mjs']) {
      const resolved = resolveAragonCommand({
        argv: ['node', `/repo/packages/cli/dist/cli${extension}`],
        execPath: '/usr/bin/node',
        env: {},
      });
      expect(resolved.kind).toBe('script');
      expect(resolved.parts).toEqual(['/usr/bin/node', `/repo/packages/cli/dist/cli${extension}`]);
    }
  });

  it('falls back to the bare bin name for a relative path, a .ts argv[1], or none', () => {
    for (const argv of [['node', 'packages/cli/dist/cli.js'], ['node', '/repo/cli.ts'], ['node']]) {
      const resolved = resolveAragonCommand({ argv, execPath: '/usr/bin/node', env: {} });
      expect(resolved.kind).toBe('bin');
      expect(resolved.parts).toEqual(['aragon']);
    }
  });
});

describe('T-4 / T-5: the invocation and its one-line form', () => {
  it('appends --resume and the id, and matches joinCommandLine', () => {
    const aragon = { parts: ['aragon'], kind: 'bin' as const, origin: 'test' };
    const invocation = buildResumeInvocation({ id: 'a4k2m9', aragon });
    expect(invocation.parts).toEqual(['aragon', BRANCH_RESUME_FLAG, 'a4k2m9']);
    expect(invocation.command).toBe(joinCommandLine(invocation.parts));
    expect(invocation.command).toBe('aragon --resume a4k2m9');
  });

  it('double-quotes spaced and quoted pieces and renders an empty piece as ""', () => {
    expect(joinCommandLine(['C:\\Program Files\\node.exe', '--resume', 'a4k2m9']))
      .toBe('"C:\\Program Files\\node.exe" --resume a4k2m9');
    expect(joinCommandLine(['a"b'])).toBe('"a\\"b"');
    expect(joinCommandLine(['', 'x'])).toBe('"" x');
  });
});

describe('D-5 / D-6 / I-4: the paste block, per platform', () => {
  const PARTS = ['C:\\Program Files\\nodejs\\node.exe', '/repo/dist/cli.js', '--resume', 'a4k2m9'];

  it('T-6: win32 gets two ASCII lines, and the first is the window script verbatim', () => {
    const manual = renderManualCommand(PARTS, 'win32');
    const lines = manual.split('\n');
    expect(lines).toHaveLength(2);
    expect(manual).toMatch(/^[\x20-\x7E\n]*$/);
    // 11 columns each, so the two commands line up in a notice.
    expect(lines[0]!.startsWith('PowerShell: & ')).toBe(true);
    expect(lines[1]!.startsWith('cmd.exe   : ')).toBe(true);
    // I-1: the line the user pastes IS the payload the new window receives.
    expect(lines[0]!.slice('PowerShell: '.length)).toBe(powerShellScript(PARTS));
    // The `cmd.exe` half stays the double-quoted form, which cmd parses correctly.
    expect(lines[1]!.slice('cmd.exe   : '.length)).toBe(joinCommandLine(PARTS));
  });

  it('T-7: POSIX and macOS keep the single line they always printed', () => {
    for (const platform of ['linux', 'darwin'] as const) {
      const manual = renderManualCommand(PARTS, platform);
      expect(manual).toBe(joinCommandLine(PARTS));
      expect(manual).not.toContain('\n');
      expect(manual).not.toContain('PowerShell:');
    }
  });
});

describe('T-6 / D-9: the id gate', () => {
  it('accepts a legal id and rejects a path-like one with the value quoted back', () => {
    expect(validateBranchId('a4k2m9')).toBeNull();
    const rejection = validateBranchId('..\\x');
    expect(rejection).not.toBeNull();
    expect(rejection).toContain('..\\x');
    expect(rejection).toContain('not a legal file name');
    // The preview is bounded so a pathological id cannot flood the transcript.
    expect(rejection!.slice(0, 24)).toBe('Session id "..\\x" is not');
  });
});

describe('T-7 / T-8 / D-13: the two refusals before any IO', () => {
  it('says there is nothing to branch from when the build has no identity', async () => {
    const ctx = context();
    await runBranchCommand(ctx);
    expect(ctx.notify).toHaveBeenCalledWith('warn', BRANCH_COPY.noIdentity);
    expect(ctx.toast).not.toHaveBeenCalled();
  });

  it('says the build has no port rather than failing silently', async () => {
    const ctx = context({ session: { ...SESSION_STUB } });
    await runBranchCommand(ctx);
    expect(ctx.notify).toHaveBeenCalledWith('warn', BRANCH_COPY.unavailable);
  });

  it('reuses the /session sentence for the missing-identity state (R-10)', () => {
    expect(BRANCH_COPY.noIdentity.startsWith(
      'This session has no id (session recording is off for this build)',
    )).toBe(true);
  });
});

describe('T-9 / D-12: success', () => {
  it('confirms on the toast, leaves the transcript alone, and passes the cwd', async () => {
    const branch = port(opened('konsole'));
    const ctx = context({ session: { ...SESSION_STUB }, branch });

    await runBranchCommand(ctx);

    expect(ctx.toast).toHaveBeenCalledWith('info', BRANCH_COPY.opened(IDENTITY.id));
    expect(ctx.notify).not.toHaveBeenCalled();
    expect(branch.requests).toHaveLength(1);
    // D-16: the CONTROLLER's cwd, not `process.cwd()`, because `/cwd` can change it
    // and `--resume` never restores it.
    expect(branch.requests[0]).toMatchObject({ id: IDENTITY.id, cwd: '/work/project' });
    expect(typeof branch.requests[0]!.onLateError).toBe('function');
  });
});

describe('T-45 / D-22 / R-5: branching while the agent runs', () => {
  it('reports success on BOTH channels while running, toast only when idle', async () => {
    const ok = opened('xterm');
    const running = context({
      controller: {
        getCwd: () => '/work/project',
        isRunning: () => true,
      } as unknown as CommandContext['controller'],
      session: { ...SESSION_STUB },
      branch: port(ok),
    });
    await runBranchCommand(running);
    // The status row's feedback slot belongs to the activity phrase while a run is
    // in flight, so a toast alone is a success the user cannot see.
    expect(running.toast).toHaveBeenCalledTimes(1);
    expect(running.notify).toHaveBeenCalledTimes(1);
    const notice = vi.mocked(running.notify).mock.calls[0]![1];
    expect(notice).toBe(vi.mocked(running.toast).mock.calls[0]![1]);

    const idle = context({
      session: { ...SESSION_STUB },
      branch: port(ok),
    });
    await runBranchCommand(idle);
    expect(idle.toast).toHaveBeenCalledTimes(1);
    expect(idle.notify).not.toHaveBeenCalled();
  });
});

describe('T-10 / D-12 / I-4: the four failure classes and their channels', () => {
  const cases = [
    {
      label: 'cooldown',
      result: {
        ok: false as const,
        reason: 'cooldown' as const,
        message: BRANCH_COPY.cooldown(1500),
        command: 'aragon --resume a4k2m9-x7f2',
        retryInMs: 1500,
      },
      channel: 'toast' as const,
      text: BRANCH_COPY.cooldown(1500),
      // I-4 names only the two spawn failures: a checkpoint failure means NOTHING
      // was opened, so the pasteable line belongs to the result, not the sentence.
      showsCommand: false,
    },
    {
      label: 'checkpoint-failed',
      result: {
        ok: false as const,
        reason: 'checkpoint-failed' as const,
        message: BRANCH_COPY.checkpointFailed('not-sendable'),
        command: 'aragon --resume a4k2m9-x7f2',
      },
      channel: 'notify' as const,
      text: BRANCH_COPY.checkpointFailed('not-sendable'),
      showsCommand: false,
    },
    {
      label: 'no-launcher',
      result: {
        ok: false as const,
        reason: 'no-launcher' as const,
        message: BRANCH_COPY.noLauncher('aragon --resume a4k2m9-x7f2'),
        command: 'aragon --resume a4k2m9-x7f2',
      },
      channel: 'notify' as const,
      text: BRANCH_COPY.noLauncher('aragon --resume a4k2m9-x7f2'),
      showsCommand: true,
    },
    {
      label: 'spawn-failed',
      result: {
        ok: false as const,
        reason: 'spawn-failed' as const,
        message: BRANCH_COPY.spawnFailed('ENOENT', 'aragon --resume a4k2m9-x7f2'),
        command: 'aragon --resume a4k2m9-x7f2',
      },
      channel: 'notify' as const,
      text: BRANCH_COPY.spawnFailed('ENOENT', 'aragon --resume a4k2m9-x7f2'),
      showsCommand: true,
    },
  ];

  it('sends the cooldown to the toast and every real failure to the notice', async () => {
    for (const testCase of cases) {
      const ctx = context({
        session: { ...SESSION_STUB },
        branch: port(testCase.result),
      });
      await runBranchCommand(ctx);
      if (testCase.channel === 'toast') {
        expect(ctx.toast, testCase.label).toHaveBeenCalledWith('info', testCase.text);
        expect(ctx.notify, testCase.label).not.toHaveBeenCalled();
      } else {
        expect(ctx.notify, testCase.label).toHaveBeenCalledWith('warn', testCase.text);
        expect(ctx.toast, testCase.label).not.toHaveBeenCalled();
        // I-4: the two spawn failures must be recoverable from the sentence alone,
        // and every failure carries the command on the result.
        expect(testCase.result.command, testCase.label).not.toBe('');
        if (testCase.showsCommand) {
          expect(testCase.text, testCase.label).toContain(testCase.result.command);
        }
      }
    }
  });

  it('keeps the cooldown sentence short enough to read while it is still true', () => {
    expect(BRANCH_COPY.cooldown(2000)).toBe('A branch was just opened - try again in 2000 ms.');
  });
});

describe('T-16 / I-5: the command body touches no session data', () => {
  it('only reads the identity and asks the port; it never writes the session', async () => {
    const identity = vi.fn(() => IDENTITY);
    const checkpoint = vi.fn();
    const rotate = vi.fn();
    const dispatch = vi.fn<(action: ViewAction) => void>();
    const submit = vi.fn();
    const ctx = context({
      session: { identity, checkpoint, rotate },
      dispatch,
      submit,
      branch: port(opened('xterm')),
    });
    await runBranchCommand(ctx);
    expect(identity).toHaveBeenCalledTimes(1);
    // No second checkpoint: the port owns the forced flush (I-1), and a body that
    // also wrote one would make "who flushed" unanswerable.
    expect(checkpoint).not.toHaveBeenCalled();
    expect(rotate).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
  });
});

describe('registration', () => {
  it('registers /branch as a command so the key and the word share one path', () => {
    const registry = new CommandRegistry();
    registerBuiltinCommands(registry);
    const command = registry.get('branch');
    expect(command).toBeDefined();
    expect(command!.description).toContain('Ctrl+L');
  });
});
