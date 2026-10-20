/**
 * `/session` and the identity half of `/resume` (tui-session-id-resume 7.1
 * T-26..T-30, T-45 / D-10 / D-14 / D-15).
 *
 * THE REFUSAL CASES MATTER AS MUCH AS THE REPORT: a command that answers an
 * unknown argument by doing something is a surface that lies about what it
 * understood, and `/session` has a side effect (`pin`) that must not fire on a
 * typo.
 */

import { afterAll, describe, expect, it, vi } from 'vitest';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { registerBuiltinCommands } from '../commands/builtins.js';
import { CommandRegistry, type CommandContext } from '../commands/registry.js';
import { initialViewState, type ViewAction } from '../agent/reducer.js';
import type { CheckpointResult } from '../session/checkpoint.js';
import { runSessionCommand, type SessionCommandPort } from '../commands/session-command.js';
import type { SessionIdentity } from '../session/startup-session.js';

// A TEMP DIRECTORY, NOT ONE UNDER THE PACKAGE. Fixtures written into the tree
// survive a crash or `--bail` (the `afterAll` below never runs) and collide with
// a concurrent run; the other six suites in this directory already use `tmpdir`.
const DIRECTORY = join(tmpdir(), `aragon-session-command-${process.pid}`);
mkdirSync(DIRECTORY, { recursive: true });
afterAll(() => rmSync(DIRECTORY, { recursive: true, force: true }));

const registry = new CommandRegistry();
registerBuiltinCommands(registry);

const OK: CheckpointResult = { ok: true, path: 'x', bytes: 1, repaired: 0, settled: 0 };

function port(identity: SessionIdentity | undefined): SessionCommandPort & {
  pinCalls: Array<{ pin?: boolean } | undefined>;
  rotations: string[];
} {
  const pinCalls: Array<{ pin?: boolean } | undefined> = [];
  const rotations: string[] = [];
  return {
    pinCalls,
    rotations,
    identity: () => identity,
    checkpoint: (opts) => {
      pinCalls.push(opts);
      return OK;
    },
    rotate: (loadedPath) => {
      rotations.push(loadedPath);
      return { id: 'a4k2m9-x7f2', kind: 'branch', parentId: 'a4k2m9' };
    },
  };
}

function context(overrides: Partial<CommandContext> = {}): CommandContext {
  return {
    args: '',
    state: initialViewState(),
    controller: {},
    dispatch: vi.fn(),
    notify: vi.fn(),
    toast: vi.fn(),
    ...overrides,
  } as unknown as CommandContext;
}

const IDENTITY: SessionIdentity = { id: 'a4k2m9-x7f2', kind: 'branch', parentId: 'a4k2m9' };

describe('T-26 / D-14: the report', () => {
  it('reports the id, the file and both commands, as ONE notice', () => {
    const ctx = context({ session: port(IDENTITY) });
    runSessionCommand(ctx);

    // ONE notice with six lines, not six notices: six cards would fragment the
    // transcript and replay as fragments on exit (R-20).
    expect(ctx.notify).toHaveBeenCalledTimes(1);
    const [level, text] = vi.mocked(ctx.notify).mock.calls[0]!;
    expect(level).toBe('info');
    expect(text).toContain('id        a4k2m9-x7f2');
    expect(text).toContain('file      ');
    expect(text).toContain('a4k2m9-x7f2.json');
    // The branch line names the parent AND the promise that goes with it.
    expect(text).toContain('branch    a4k2m9 (this session does not write to it)');
    expect(text).toContain('pinned    no');
    // The two paste-ready commands, verbatim.
    expect(text).toContain('resume    aragon --resume a4k2m9-x7f2');
    expect(text).toContain('save as   aragon --save <new-id>');
    // The file line is NOT truncated, even though a Windows path overflows a
    // narrow terminal: it is there to be copied (R-20).
    expect(text.split('\n')).toHaveLength(6);
  });

  it('says so when the session has no branch parent', () => {
    const ctx = context({ session: port({ id: 'a4k2m9', kind: 'fresh' }) });
    runSessionCommand(ctx);
    const text = String(vi.mocked(ctx.notify).mock.calls[0]![1]);
    expect(text).toContain('branch    (none - this session started here)');
    expect(text).toContain('pinned    no');
  });
});

describe('T-27 / D-14: /session copy', () => {
  it('sends the resume command through the copy door', async () => {
    const requestCopy = vi.fn(async () => ({ status: 'confirmed' as const, via: 'native' as const }));
    const ctx = context({ args: 'copy', session: port(IDENTITY), requestCopy });
    runSessionCommand(ctx);

    expect(requestCopy).toHaveBeenCalledWith({ text: 'aragon --resume a4k2m9-x7f2', lines: 1 });
    await vi.waitFor(() => expect(ctx.toast).toHaveBeenCalledWith(
      'info', 'Copied aragon --resume a4k2m9-x7f2',
    ));
  });

  it('reports a refused copy instead of claiming success', async () => {
    const requestCopy = vi.fn(async () => ({ status: 'busy' as const }));
    const ctx = context({ args: 'copy', session: port(IDENTITY), requestCopy });
    runSessionCommand(ctx);
    await vi.waitFor(() => expect(ctx.notify).toHaveBeenCalledWith(
      'warn', expect.stringContaining('busy'),
    ));
    expect(ctx.toast).not.toHaveBeenCalled();
  });
});

describe('T-28 / D-14: /session pin', () => {
  it('writes with pinned set and says exactly what that means', () => {
    const session = port(IDENTITY);
    const ctx = context({ args: 'pin', session });
    runSessionCommand(ctx);

    expect(session.pinCalls).toEqual([{ pin: true }]);
    expect(ctx.toast).toHaveBeenCalledWith(
      'info',
      'Session a4k2m9-x7f2 pinned: aragon sessions prune will not delete it.',
    );
  });

  it('reports a failed pin rather than a false success', () => {
    const session: SessionCommandPort = {
      identity: () => IDENTITY,
      checkpoint: () => ({ ok: false, reason: 'write-failed', message: 'EACCES' }),
      rotate: () => undefined,
    };
    const ctx = context({ args: 'pin', session });
    runSessionCommand(ctx);
    expect(ctx.notify).toHaveBeenCalledWith('warn', expect.stringContaining('EACCES'));
    expect(ctx.toast).not.toHaveBeenCalled();
  });
});

describe('T-29: an unknown argument is refused without side effects', () => {
  it('rejects an unknown argument without side effects', () => {
    const session = port(IDENTITY);
    const ctx = context({ args: 'rename', session });
    runSessionCommand(ctx);

    expect(ctx.notify).toHaveBeenCalledWith(
      'warn', 'Unknown argument "rename" - use /session [copy|pin].',
    );
    expect(session.pinCalls).toEqual([]);
    expect(ctx.toast).not.toHaveBeenCalled();
  });
});

describe('T-30: honest when there is no identity', () => {
  it('reports honestly when there is no session identity', () => {
    const ctx = context();
    expect(() => runSessionCommand(ctx)).not.toThrow();
    expect(ctx.notify).toHaveBeenCalledWith(
      'warn', 'This session has no id (session recording is off for this build).',
    );
  });

  it('is registered under the name the help table advertises', () => {
    expect(registry.get('session')?.name).toBe('session');
  });
});

describe('T-45 / D-15 / D-10: /resume rotates and resets', () => {
  it('rotates the id onto the loaded path and resets the spend', () => {
    const loaded = join(DIRECTORY, 'a4k2m9.json');
    writeFileSync(loaded, JSON.stringify({ messages: [], entries: [] }));
    const before = readFileSync(loaded, 'utf-8');
    const session = port(IDENTITY);
    const dispatched: ViewAction[] = [];
    const ctx = context({
      args: loaded,
      session,
      controller: {
        isRunning: () => false,
        isModelSettingsBusy: () => false,
        getCwd: () => DIRECTORY,
        getConfig: () => ({ provider: 'anthropic', model: 'm' }),
        clearAllQueues: vi.fn(),
        replaceMessages: vi.fn(),
        restoreTodos: vi.fn(),
        setModel: vi.fn(),
      } as unknown as CommandContext['controller'],
      dispatch: (action: ViewAction) => {
        dispatched.push(action);
      },
    });

    registry.get('resume')!.run(ctx);

    // The id moved to the file that was actually adopted...
    expect(session.rotations).toEqual([loaded]);
    // ...the OLD file was not rewritten (I-5)...
    expect(readFileSync(loaded, 'utf-8')).toBe(before);
    // ...and the counter restarted in the same breath (D-10 / R-9).
    expect(dispatched).toContainEqual({ type: 'resetUsage' });
    expect(ctx.notify).toHaveBeenCalledWith(
      'info', `Resumed session from ${loaded} as a4k2m9-x7f2.`,
    );
  });

  it('does not reset the spend when the id did not change', () => {
    // D-10's criterion is "the id changed", not "the user typed /resume". A host
    // with no session port, or a claim that failed, keeps the id - and
    // restarting the counter there would report this conversation's spend as
    // somebody else's.
    const loaded = join(DIRECTORY, 'b7n3p1.json');
    writeFileSync(loaded, JSON.stringify({ messages: [], entries: [] }));
    const session = port(IDENTITY);
    session.rotate = () => undefined;
    const dispatched: ViewAction[] = [];
    const ctx = context({
      args: loaded,
      session,
      controller: {
        isRunning: () => false,
        isModelSettingsBusy: () => false,
        getCwd: () => DIRECTORY,
        getConfig: () => ({ provider: 'anthropic', model: 'm' }),
        clearAllQueues: vi.fn(),
        replaceMessages: vi.fn(),
        restoreTodos: vi.fn(),
        setModel: vi.fn(),
      } as unknown as CommandContext['controller'],
      dispatch: (action: ViewAction) => {
        dispatched.push(action);
      },
    });

    registry.get('resume')!.run(ctx);

    expect(dispatched).not.toContainEqual({ type: 'resetUsage' });
    // A failed rotation is the one case where the next checkpoint writes this
    // conversation into the id it still holds, so it is announced rather than
    // left to be discovered.
    expect(ctx.notify).toHaveBeenCalledWith(
      'warn', 'Could not claim a new session id; this conversation keeps the current one.',
    );
  });
});
