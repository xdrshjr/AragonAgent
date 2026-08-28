/**
 * Event mapping and — more importantly — the process-hook contracts.
 *
 * The hook cases are mechanical guards for a class of bug that compiles, passes
 * a smoke test, and only shows up when something has already gone wrong:
 * registering `uncaughtException` without exiting turns a crash into a hang, and
 * a signal handler that exits before the screen is restored leaves the user with
 * an unusable terminal. Neither is visible in ordinary use.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  attachAgentEvents,
  attachTeamEvents,
  installLogging,
  resetProcessHooksForTest,
  setScreenRestore,
  setSignalTerminator,
  type AgentLogEvent,
  type ProcessHookPort,
  type TeamLogEvent,
} from '../logging/install.js';
import { Logger } from '../logging/logger.js';
import { resetLoggerForTest } from '../logging/logger.js';
import { DEFAULT_LOG_CONFIG } from '../config/schema.js';
import { clearSecretsForTest, registerSecret } from '../logging/secret-registry.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'aragon-install-'));
  resetProcessHooksForTest();
  clearSecretsForTest();
});

afterEach(() => {
  resetLoggerForTest();
  resetProcessHooksForTest();
  rmSync(dir, { recursive: true, force: true });
});

interface ReadRecord {
  lv: string;
  scope: string;
  msg: string;
  data?: Record<string, unknown>;
}

function readRecords(): ReadRecord[] {
  const files = readdirSync(dir).filter((f) => f.endsWith('.log'));
  if (files.length === 0) return [];
  return readFileSync(join(dir, files[0] as string), 'utf-8')
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l));
}

/** The nine `AgentEvent` members, in the order the engine emits them. */
const NINE_EVENTS: AgentLogEvent[] = [
  { type: 'agent_start' },
  { type: 'turn_start' },
  { type: 'message_update', streamEvent: { type: 'text_delta' } },
  { type: 'tool_execution_start', toolCallId: 'c1', toolName: 'bash', args: { cmd: 'ls' } },
  { type: 'tool_execution_end', toolName: 'bash', duration: 12, isError: false, result: 'files' },
  { type: 'code_execution_start', language: 'python', code: 'print(1)' },
  { type: 'code_execution_end', duration: 7, output: '1' },
  { type: 'turn_end', usage: { inputTokens: 1284, outputTokens: 377 } },
  { type: 'agent_end', messages: [{}, {}, {}] },
];

function feed(logger: Logger, events: AgentLogEvent[]): void {
  let listener: ((event: AgentLogEvent) => void) | null = null;
  const controller = {
    subscribe: (fn: (event: AgentLogEvent) => void) => {
      listener = fn;
      return () => {
        listener = null;
      };
    },
    getConfig: () => ({ provider: 'anthropic', model: 'claude-sonnet-4-5', thinkingLevel: 'off' }),
  };
  attachAgentEvents(logger, controller);
  for (const event of events) (listener as unknown as (e: AgentLogEvent) => void)(event);
  logger.flushSync();
}

describe('agent event mapping (all nine members)', () => {
  it('records the eight non-stream events at info/debug and never the stream one', () => {
    const logger = new Logger({ ...DEFAULT_LOG_CONFIG, dir, level: 'info' });
    feed(logger, NINE_EVENTS);
    const records = readRecords();

    expect(records.map((r) => r.msg)).toEqual([
      'run_start',
      'tool_end',
      'code_end',
      'turn_end',
      'run_end',
    ]);
    // Thousands per answer: recording these at debug would produce a log larger
    // than the conversation that caused it.
    expect(records.some((r) => r.msg === 'stream')).toBe(false);
    logger.closeSink();
  });

  it('records `stream` at trace, and without any content', () => {
    const logger = new Logger({ ...DEFAULT_LOG_CONFIG, dir, level: 'trace' });
    const secret = 'the model actually said this';
    feed(logger, [
      { type: 'message_update', streamEvent: { type: 'text_delta', delta: secret } },
    ]);
    const stream = readRecords().find((r) => r.msg === 'stream');
    expect(stream).toBeDefined();
    // The LENGTH of the increment, never the increment: this event fires
    // thousands of times per answer, so recording its text would make the log a
    // second copy of the conversation at the one level meant for volume.
    expect(stream!.data).toEqual({ type: 'text_delta', delta: secret.length });
    expect(JSON.stringify(stream)).not.toContain(secret);
    logger.closeSink();
  });

  it('takes run_start fields from the controller, since the event carries none', () => {
    const logger = new Logger({ ...DEFAULT_LOG_CONFIG, dir, level: 'info' });
    feed(logger, [{ type: 'agent_start' }]);
    expect(readRecords()[0]!.data).toEqual({
      provider: 'anthropic',
      model: 'claude-sonnet-4-5',
      thinking: 'off',
    });
    logger.closeSink();
  });

  it('derives turn_end.ms from turn_start, and in/out from the usage keys', () => {
    // `TurnEndEvent` is `{message, usage}` — no duration anywhere — so the
    // elapsed time has to be measured against `turn_start`.
    vi.useFakeTimers();
    const logger = new Logger({ ...DEFAULT_LOG_CONFIG, dir, level: 'info' });

    let listener: ((event: AgentLogEvent) => void) | null = null;
    attachAgentEvents(logger, {
      subscribe: (fn) => {
        listener = fn;
        return () => undefined;
      },
      getConfig: () => ({ provider: 'p', model: 'm', thinkingLevel: 'off' }),
    });
    const emit = listener as unknown as (e: AgentLogEvent) => void;

    emit({ type: 'turn_start' });
    vi.advanceTimersByTime(4210);
    emit({ type: 'turn_end', usage: { inputTokens: 1284, outputTokens: 377 } });
    logger.flushSync();
    vi.useRealTimers();

    expect(readRecords()[0]!.data).toEqual({ in: 1284, out: 377, ms: 4210 });
    logger.closeSink();
  });

  it('truncates tool arguments to previewChars at debug', () => {
    const logger = new Logger({ ...DEFAULT_LOG_CONFIG, dir, level: 'debug', previewChars: 10 });
    feed(logger, [
      { type: 'tool_execution_start', toolCallId: 'c', toolName: 'write', args: 'x'.repeat(500) },
    ]);
    const args = readRecords().find((r) => r.msg === 'tool_start')!.data!.args as string;
    expect(args.length).toBeLessThanOrEqual(11); // 10 + the ellipsis
    logger.closeSink();
  });

  it('returns the unsubscribe function the controller handed back', () => {
    const logger = new Logger({ ...DEFAULT_LOG_CONFIG, dir });
    const unsubscribe = vi.fn();
    const off = attachAgentEvents(logger, {
      subscribe: () => unsubscribe,
      getConfig: () => ({ provider: 'p', model: 'm', thinkingLevel: 'off' }),
    });
    off();
    expect(unsubscribe).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// Process hooks
// ---------------------------------------------------------------------------

class ExitCalled extends Error {
  constructor(readonly code: number) {
    super(`exit(${code})`);
  }
}

interface StubPort extends ProcessHookPort {
  listeners: Map<string, Array<(...args: unknown[]) => void>>;
  trace: string[];
}

function stubPort(trace: string[]): StubPort {
  const listeners = new Map<string, Array<(...args: unknown[]) => void>>();
  return {
    listeners,
    trace,
    on(event, listener) {
      const list = listeners.get(event) ?? [];
      list.push(listener);
      listeners.set(event, list);
      return this;
    },
    exit(code: number): never {
      trace.push(`exit(${code})`);
      throw new ExitCalled(code);
    },
    stderr: {
      write(chunk: string) {
        trace.push(`stderr:${chunk.split('\n')[0]}`);
        return true;
      },
    },
  };
}

function fire(port: StubPort, event: string, ...args: unknown[]): void {
  for (const listener of port.listeners.get(event) ?? []) {
    try {
      listener(...args);
    } catch (err) {
      if (!(err instanceof ExitCalled)) throw err;
    }
  }
}

describe('11 — uncaughtException / unhandledRejection contract (P0-1)', () => {
  it('logs, flushes, restores the screen, prints the stack, THEN exits', () => {
    const trace: string[] = [];
    const port = stubPort(trace);
    process.env.ARAGON_LOG_DIR = dir;
    installLogging({ argv: [], processPort: port });
    setScreenRestore(() => trace.push('restore'));

    fire(port, 'uncaughtException', new Error('boom'));

    // Restore BEFORE stderr, or the stack is printed into an alternate screen
    // that is about to disappear with it.
    expect(trace).toEqual(['restore', 'stderr:Error: boom', 'exit(1)']);
    // Without the exit, registering the listener has itself converted a crash
    // into a process that hangs with a broken UI.
    expect(trace[trace.length - 1]).toBe('exit(1)');
    delete process.env.ARAGON_LOG_DIR;
  });

  it('applies the same contract to an unhandled rejection', () => {
    const trace: string[] = [];
    const port = stubPort(trace);
    process.env.ARAGON_LOG_DIR = dir;
    installLogging({ argv: [], processPort: port });
    setScreenRestore(() => trace.push('restore'));

    fire(port, 'unhandledRejection', new Error('nope'));

    expect(trace).toEqual(['restore', 'stderr:Error: nope', 'exit(1)']);
    delete process.env.ARAGON_LOG_DIR;
  });

  it('writes the crash record to the log before exiting', () => {
    const trace: string[] = [];
    const port = stubPort(trace);
    process.env.ARAGON_LOG_DIR = dir;
    installLogging({ argv: [], processPort: port });

    fire(port, 'uncaughtException', new Error('recorded'));

    const crash = readRecords().find((r) => r.msg === 'uncaught_exception');
    expect(crash).toBeDefined();
    expect(crash!.lv).toBe('error');
    delete process.env.ARAGON_LOG_DIR;
  });
});

describe('12 — signal ownership (P0-2)', () => {
  it('registers exactly ONE listener per signal', () => {
    const trace: string[] = [];
    const port = stubPort(trace);
    installLogging({ argv: ['--no-log-file'], processPort: port });

    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
      expect(port.listeners.get(signal)?.length).toBe(1);
    }
  });

  it('defaults to a bare exit(128 + signo) — the headless / subcommand path', () => {
    // Those paths previously had NO signal handler at all, so Node terminated
    // by default and never ran the `exit` listeners: the queue went with it.
    const trace: string[] = [];
    const port = stubPort(trace);
    installLogging({ argv: ['--no-log-file'], processPort: port });

    fire(port, 'SIGINT');
    expect(trace).toEqual(['exit(130)']);

    trace.length = 0;
    fire(port, 'SIGTERM');
    expect(trace).toEqual(['exit(143)']);
  });

  it('restores the screen before exiting once full-screen takes ownership', () => {
    const trace: string[] = [];
    const port = stubPort(trace);
    installLogging({ argv: ['--no-log-file'], processPort: port });

    setSignalTerminator((signo) => {
      trace.push('restore');
      port.exit(128 + signo);
    });

    fire(port, 'SIGINT');
    expect(trace).toEqual(['restore', 'exit(130)']);
  });

  it('flushes on a normal exit', () => {
    const trace: string[] = [];
    const port = stubPort(trace);
    process.env.ARAGON_LOG_DIR = dir;
    const logger = installLogging({ argv: [], processPort: port });
    logger.info('cli', 'about_to_exit');

    fire(port, 'exit');

    expect(readRecords().some((r) => r.msg === 'about_to_exit')).toBe(true);
    delete process.env.ARAGON_LOG_DIR;
  });
});

describe('bootstrap level resolution', () => {
  it('honours --log-level, --log-level=, --verbose and --no-log-file', () => {
    const port = stubPort([]);
    process.env.ARAGON_LOG_DIR = dir;

    const traced = installLogging({ argv: ['--log-level', 'trace'], processPort: port });
    expect(traced.level).toBe('trace');
    resetLoggerForTest();
    expect(installLogging({ argv: ['--log-level=warn'], processPort: port }).level).toBe('warn');
    resetLoggerForTest();
    expect(installLogging({ argv: ['--verbose'], processPort: port }).level).toBe('debug');
    resetLoggerForTest();

    // `-vv` is deliberately NOT scanned: `-v` is already `--version`, so
    // commander would reject it before this level was ever consulted.
    expect(installLogging({ argv: ['-vv'], processPort: port }).level).toBe('info');
    delete process.env.ARAGON_LOG_DIR;
  });

  it('replays the notes accumulated before it existed', () => {
    const port = stubPort([]);
    process.env.ARAGON_LOG_DIR = dir;
    const logger = installLogging({
      argv: [],
      processPort: port,
      pending: [
        { level: 'info', scope: 'migrate', msg: 'migrate_home', data: { mode: 'renamed' } },
      ],
    });
    logger.flushSync();

    const note = readRecords().find((r) => r.msg === 'migrate_home');
    expect(note).toBeDefined();
    expect(note!.scope).toBe('migrate');
    delete process.env.ARAGON_LOG_DIR;
  });
});

// ---------------------------------------------------------------------------
// Team event mapping (team-subagents §3.13 / AC-17)
// ---------------------------------------------------------------------------

/**
 * `TeamEvent` is deliberately CLI-local (D-10), so `attachAgentEvents` cannot
 * see it — which means that without `attachTeamEvents` a dispatch leaves NO
 * trace in the log at all, for the one feature in this CLI that runs five
 * agents the user cannot watch (P1-2 / R-19).
 */
function feedTeam(logger: Logger, events: TeamLogEvent[]): void {
  let listener: ((event: TeamLogEvent) => void) | null = null;
  attachTeamEvents(logger, {
    subscribeTeam: (fn: (event: TeamLogEvent) => void) => {
      listener = fn;
      return () => {
        listener = null;
      };
    },
  });
  for (const event of events) (listener as unknown as (e: TeamLogEvent) => void)(event);
  logger.flushSync();
}

const DISPATCH: TeamLogEvent[] = [
  {
    type: 'dispatch_start',
    dispatchId: 'd1',
    requested: 3,
    specs: [
      { label: 'a1', description: 'read the auth middleware', prompt: 'Read src/auth.' },
      { label: 'a2', description: 'map the route table', prompt: 'Read src/routes.' },
    ],
  },
  { type: 'agent_update', dispatchId: 'd1', run: { label: 'a1', phase: 'tool', lastTool: 'grep' } },
  {
    type: 'dispatch_end',
    dispatchId: 'd1',
    outcome: {
      startedAt: 1_000,
      endedAt: 85_200,
      aborted: false,
      runs: [{ phase: 'done', filesTouched: ['src/auth/mw.ts'] }, { phase: 'failed', error: 'x' }],
      usage: { inputTokens: 41_200, outputTokens: 8_900 },
    },
  },
];

describe('team event mapping (AC-17)', () => {
  it('brackets a dispatch with info records carrying the counts and the usage', () => {
    const logger = new Logger({ ...DEFAULT_LOG_CONFIG, dir, level: 'info' });
    feedTeam(logger, DISPATCH);
    const records = readRecords();

    expect(records.map((r) => r.msg)).toEqual(['team_dispatch_start', 'team_dispatch_end']);
    expect(records[0]!.data).toEqual({
      dispatchId: 'd1',
      requested: 3,
      accepted: 2,
      labels: ['a1', 'a2'],
    });
    // The counts are the whole point: a report is written by the thing that
    // failed, so `ok` / `failed` / `aborted` have to come from somewhere else.
    expect(records[1]!.data).toEqual({
      dispatchId: 'd1',
      durationMs: 84_200,
      ok: 1,
      failed: 1,
      aborted: false,
      in: 41_200,
      out: 8_900,
      filesTouched: ['src/auth/mw.ts'],
    });
    logger.closeSink();
  });

  it('NEVER records a team_send body, at any level', () => {
    // The subject is enough to reconstruct who talked to whom and when, which is
    // the diagnostic question. The body is user content that reached no other
    // sink.
    const logger = new Logger({ ...DEFAULT_LOG_CONFIG, dir, level: 'trace' });
    const body = 'the auth flow uses a second session store at src/auth/session.ts';
    feedTeam(logger, [
      {
        type: 'message',
        dispatchId: 'd1',
        message: { from: 'a1', to: 'a2', subject: 'second session store', body },
      },
    ]);
    const record = readRecords().find((r) => r.msg === 'team_message');
    expect(record!.data).toEqual({
      dispatchId: 'd1',
      from: 'a1',
      to: 'a2',
      subject: 'second session store',
    });
    expect(JSON.stringify(readRecords())).not.toContain(body);
    logger.closeSink();
  });

  it('keeps a subagent brief at trace, and redacts it like everything else', () => {
    // A `prompt` is up to 8 000 characters of whatever the lead decided to say;
    // at `debug` it would dominate the file.
    const info = new Logger({ ...DEFAULT_LOG_CONFIG, dir, level: 'debug' });
    feedTeam(info, [DISPATCH[0] as TeamLogEvent]);
    expect(readRecords().some((r) => r.msg === 'team_subagent_brief')).toBe(false);
    info.closeSink();

    rmSync(dir, { recursive: true, force: true });
    dir = mkdtempSync(join(tmpdir(), 'aragon-install-'));

    const secret = 'sk-ant-not-a-real-key';
    registerSecret(secret);
    const trace = new Logger({ ...DEFAULT_LOG_CONFIG, dir, level: 'trace' });
    feedTeam(trace, [
      {
        type: 'dispatch_start',
        dispatchId: 'd1',
        requested: 1,
        specs: [{ label: 'a1', description: 'probe', prompt: `curl -H "${secret}" ...` }],
      },
    ]);
    const brief = readRecords().find((r) => r.msg === 'team_subagent_brief');
    expect(brief).toBeDefined();
    expect(JSON.stringify(brief)).not.toContain(secret);
    trace.closeSink();
  });

  it('records agent_update on PHASE TRANSITIONS, not on every coalescer tick', () => {
    // Five children at eight events a second each is 40 lines a second of noise
    // that would push the retention window down to minutes.
    const logger = new Logger({ ...DEFAULT_LOG_CONFIG, dir, level: 'debug' });
    feedTeam(logger, [
      { type: 'agent_update', dispatchId: 'd1', run: { label: 'a1', phase: 'tool' } },
      { type: 'agent_update', dispatchId: 'd1', run: { label: 'a1', phase: 'tool' } },
      { type: 'agent_update', dispatchId: 'd1', run: { label: 'a1', phase: 'thinking' } },
      { type: 'agent_update', dispatchId: 'd1', run: { label: 'a2', phase: 'tool' } },
    ]);
    expect(readRecords().filter((r) => r.msg === 'team_agent_update')).toHaveLength(3);
    logger.closeSink();
  });

  it('is a no-op for a controller with no team runtime', () => {
    const logger = new Logger({ ...DEFAULT_LOG_CONFIG, dir, level: 'trace' });
    expect(() => attachTeamEvents(logger, {})()).not.toThrow();
    logger.flushSync();
    expect(readRecords()).toEqual([]);
    logger.closeSink();
  });
});
