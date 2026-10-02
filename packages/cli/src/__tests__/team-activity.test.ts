import { describe, expect, it, vi } from 'vitest';
import type { AgentEvent } from '@aragon-agent/core';
import {
  describeToolActivity,
  pickActivityArgs,
  sanitizeActivity,
} from '../team/activity.js';
import { createSubagent, type SubagentAgentLike, type SubagentDeps } from '../team/subagent.js';
import { TeamBus } from '../team/bus.js';
import { TEAM_LIMITS } from '../team/limits.js';
import { Logger } from '../logging/logger.js';
import { attachTeamEvents, type TeamLogEvent } from '../logging/install.js';
import {
  DEFAULT_LOG_CONFIG,
  DEFAULT_SKILLS_CONFIG,
  DEFAULT_SKILLS_RUNTIME,
  DEFAULT_TEAM_CONFIG,
  DEFAULT_COMPACTION_CONFIG,
  DEFAULT_RETRY_CONFIG,
  DEFAULT_TODO_CONFIG,
  DEFAULT_BASH_CONFIG,
  type CliConfig,
} from '../config/schema.js';
import type { AgentMode } from '../agent/agent-mode.js';
import type { SubagentRun, SubagentSpec } from '../team/types.js';
import { DEFAULT_FAST_CONFIG, DEFAULT_UPDATE_CONFIG } from '../config/schema.js';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// AC-1 / AC-2 / AC-2a — the sanitizer
// ---------------------------------------------------------------------------

describe('sanitizeActivity', () => {
  it('AC-1: strips control characters, collapses whitespace and honours the cap', () => {
    // THE CONTROL STRIP IS A CORRECTNESS BOUNDARY. This string reaches an Ink
    // <Text> unescaped, so an ANSI escape in a `bash` argument would otherwise
    // clear the screen or move the cursor in the middle of a transcript.
    const raw = 'run\x1b[2Jnpm\ttest\n  -w\x07 cli';
    const out = sanitizeActivity(raw, 64);
    // eslint-disable-next-line no-control-regex
    expect(out).not.toMatch(/[\x00-\x1f\x7f]/);
    expect(out).toBe('run [2Jnpm test -w cli');
    expect(sanitizeActivity('x'.repeat(200), 20)).toHaveLength(20);
    expect(sanitizeActivity('x'.repeat(200), 20).endsWith('...')).toBe(true);
  });

  it('returns nothing at a non-positive cap and does not pad a short string', () => {
    expect(sanitizeActivity('anything', 0)).toBe('');
    expect(sanitizeActivity('anything', -5)).toBe('');
    expect(sanitizeActivity('short', 64)).toBe('short');
  });

  it('AC-2: never returns a lone HIGH surrogate when the cut lands mid-emoji', () => {
    // A split pair renders as a replacement character - the same failure
    // `truncateBytes` guards one layer down.
    const s = `${'a'.repeat(10)}${'\u{1f600}'.repeat(10)}`;
    for (let cap = 4; cap <= 30; cap += 1) {
      const out = sanitizeActivity(s, cap);
      expect(Buffer.from(out, 'utf8').toString('utf8'), `cap=${cap}`).toBe(out);
      expect(out.length, `cap=${cap}`).toBeLessThanOrEqual(cap);
    }
  });

  it('AC-2a: never returns a lone LOW surrogate at the head either (P2-3)', () => {
    // Exactly what `textTail.slice(-n)` produces when it cuts a pair: the caller
    // hands us the second half of a surrogate pair at index 0.
    const pair = '\u{1f600}';
    const lowHalf = pair.slice(1); // the trailing surrogate on its own
    const out = sanitizeActivity(`${lowHalf}rest of the line`, 64);
    expect(out).toBe('rest of the line');
    expect(Buffer.from(out, 'utf8').toString('utf8')).toBe(out);
  });
});

// ---------------------------------------------------------------------------
// AC-3 / AC-3a / AC-3b — the formatter and the arg picker
// ---------------------------------------------------------------------------

describe('describeToolActivity', () => {
  it('AC-3: names every builtin plus both comm tools, in the wide form', () => {
    const wide = true;
    expect(describeToolActivity('read_file', { path: 'src/api/routes.ts' }, wide))
      .toBe('read: src/api/routes.ts');
    expect(describeToolActivity('write_file', { path: 'src/a.ts' }, wide)).toBe('write: src/a.ts');
    expect(describeToolActivity('edit_file', { path: 'src/a.ts' }, wide)).toBe('edit: src/a.ts');
    expect(describeToolActivity('list_dir', {}, wide)).toBe('list: .');
    expect(describeToolActivity('glob', { pattern: 'src/**/*.ts' }, wide)).toBe('glob: src/**/*.ts');
    expect(describeToolActivity('grep', { pattern: 'TODO' }, wide)).toBe('grep: TODO');
    expect(describeToolActivity('bash', { command: 'npm test -w cli' }, wide))
      .toBe('bash: npm test -w cli');
    expect(describeToolActivity('team_send', { to: 'a2' }, wide)).toBe('messaging a2');
    expect(describeToolActivity('team_wait', { from: 'a2' }, wide)).toBe('waiting for a2');
  });

  it('AC-3: falls back to the bare tool name for a tool it has not been taught', () => {
    // A name is always true. Inventing an argument mapping for `skill_find` - or
    // for whatever a later round registers on a child - is how a formatter
    // starts lying.
    expect(describeToolActivity('skill_find', { path: 'x' }, true)).toBe('skill_find');
    expect(describeToolActivity('skill_find', undefined, false)).toBe('skill_find');
  });

  it('AC-3: degrades to a verb when the salient argument is missing or empty', () => {
    expect(describeToolActivity('bash', {}, true)).toBe('bash');
    expect(describeToolActivity('read_file', { path: '   ' }, true)).toBe('read');
    expect(describeToolActivity('team_wait', {}, true)).toBe('waiting for mail');
    expect(describeToolActivity('team_send', {}, true)).toBe('messaging');
  });

  it('AC-3: the narrow form of a path argument is its basename, on both separators', () => {
    expect(describeToolActivity('read_file', { path: 'src/api/routes.ts' }, false))
      .toBe('read: routes.ts');
    expect(describeToolActivity('write_file', { path: 'src\\api\\routes.ts' }, false))
      .toBe('write: routes.ts');
  });

  it('AC-3a: the narrow form of `bash` is the PROGRAM NAME, not `basename(command)`', () => {
    // `basename` splits on `/`, so the first of these comes back WHOLE and the
    // second comes back as `build.sh --prod`. Neither is shorter, and the second
    // is a lie about what ran (P1-6).
    expect(describeToolActivity('bash', { command: 'npm test -w cli' }, false)).toBe('bash: npm');
    expect(describeToolActivity('bash', { command: './scripts/build.sh --prod' }, false))
      .toBe('bash: build.sh');
    expect(describeToolActivity('bash', { command: '  /usr/bin/env node x.js' }, false))
      .toBe('bash: env');
  });
});

describe('pickActivityArgs', () => {
  it('AC-3b: keeps five named strings and drops everything else', () => {
    // THE ASSERTION THAT KEEPS A FILE BODY OUT OF THE TRANSCRIPT. `publish()`
    // copies the run into the snapshot and into every `agent_update`, and
    // `dispatch()` copies it again into the outcome `TeamCard` holds for the
    // session - so `event.args` whole would keep a 2 MB write alive per file,
    // one `JSON.stringify` away from a log.
    const picked = pickActivityArgs({ path: 'a.txt', content: 'z'.repeat(1_000_000) });
    expect(picked).toEqual({ path: 'a.txt' });
    expect('content' in picked).toBe(false);
    expect(JSON.stringify(picked).length).toBeLessThan(1024);
  });

  it('AC-3b: elides each picked string to activityArgChars', () => {
    const picked = pickActivityArgs({ command: 'x'.repeat(5000), pattern: 'y'.repeat(5000) });
    expect(picked.command).toHaveLength(TEAM_LIMITS.activityArgChars);
    expect(picked.pattern).toHaveLength(TEAM_LIMITS.activityArgChars);
    expect(JSON.stringify(picked).length).toBeLessThan(1024);
  });

  it('tolerates a missing, null or non-object args value without throwing', () => {
    expect(pickActivityArgs(undefined)).toEqual({});
    expect(pickActivityArgs(null)).toEqual({});
    expect(pickActivityArgs('nonsense')).toEqual({});
    expect(pickActivityArgs({ path: 42, command: '' })).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// AC-4 / AC-5 / AC-8 — the wiring in `createSubagent`
// ---------------------------------------------------------------------------

const SPEC: SubagentSpec = {
  label: 'a1',
  description: 'read the auth middleware',
  prompt: 'Read src/auth and report.',
  readOnly: false,
  tier: 'main',
};

function config(): CliConfig {
  return {
    fast: DEFAULT_FAST_CONFIG,
    update: DEFAULT_UPDATE_CONFIG,
    provider: 'anthropic',
    model: 'm',
    thinkingLevel: 'off',
    showThinking: false,
    liveToolOutput: false,
    contextWindow: null,
    theme: 'auto',
    reducedMotion: false,
    exitTranscript: true,
    transcriptWindow: 300,
    transcriptRetain: 1000,
    renderGovernor: true,
    maxRenderIntervalMs: 320,
    diffRender: true,
    syncOutput: true,
    confirmTools: false,
    toolTimeoutMs: 180_000,
    idleTimeoutMs: 210_000,
    apiKeys: { anthropic: 'k' },
    historyEnabled: true,
    density: 'comfortable',
    hints: true,
    mouse: true,
    mouseSelect: true,
    paste: true,
    scrollResumeMs: 5000,
    submitCount: 0,
    startInPlanMode: false,
    planModeMaxAskRounds: 4,
    planModeHumanTimeoutMs: 1_800_000,
    skills: DEFAULT_SKILLS_CONFIG,
    skillsRuntime: DEFAULT_SKILLS_RUNTIME,
    log: DEFAULT_LOG_CONFIG,
    team: DEFAULT_TEAM_CONFIG,
    todo: DEFAULT_TODO_CONFIG,
    bash: DEFAULT_BASH_CONFIG,
    retry: DEFAULT_RETRY_CONFIG,
    // The NINTH nested section. `enabled: false` on purpose: these fixtures
    // are about other subsystems, and the same `enabled: false` appears above
    // for `skills`, `team` and `todo` for exactly that reason.
    compaction: { ...DEFAULT_COMPACTION_CONFIG, enabled: false },
    cwd: process.cwd(),
    color: true,
  };
}

/** A child whose event stream this test drives by hand. Nothing goes near a network. */
function instrumented(): { run: SubagentRun; feed: (e: AgentEvent) => void; updates: SubagentRun[] } {
  let listener: ((event: AgentEvent) => void) | null = null;
  const agent: SubagentAgentLike = {
    prompt: async () => {},
    abort: () => {},
    pauseIdleWatchdog: () => {},
    resumeIdleWatchdog: () => {},
    /** The narrow member `SubagentAgentLike` gained for child compaction (W3). */
    state: { messages: [] },
    subscribe: (fn) => {
      listener = fn;
      return () => {
        listener = null;
      };
    },
  };
  const deps: SubagentDeps = {
    bus: new TeamBus([SPEC.label, 'a2']),
    config: config(),
    providerRegistry: {} as SubagentDeps['providerRegistry'],
    getCwd: () => process.cwd(),
    getMode: (): AgentMode => 'build',
    getApiKey: () => 'k',
    confirmTools: false,
    agentFactory: () => agent,
  };
  const updates: SubagentRun[] = [];
  const handle = createSubagent(SPEC, deps, {
    onUpdate: (r) => updates.push(r),
    onUsage: () => {},
  });
  return {
    run: handle.run,
    feed: (e) => (listener as unknown as (event: AgentEvent) => void)(e),
    updates,
  };
}

const delta = (text: string): AgentEvent =>
  ({ type: 'message_update', streamEvent: { type: 'text_delta', delta: text } }) as AgentEvent;

describe('activity wiring in createSubagent (F-1)', () => {
  it('AC-4: the rolling tail stays bounded however many deltas arrive', async () => {
    const child = instrumented();
    for (let i = 0; i < 10_000; i += 1) child.feed(delta('abcdefghij'));
    // Past the coalescing window so the next delta actually publishes a frame.
    await sleep(TEAM_LIMITS.agentUpdateThrottleMs + 20);
    child.feed(delta('END'));

    // 100 003 characters went in; `textTail` holds exactly the last
    // `activityTailChars` of them, and the published value is that window
    // clamped to the storage ceiling. Pinned as an equality rather than as a
    // bound so the test fails if either limit stops being applied - a 160-char
    // buffer that is never sliced passes a length check against 160.
    const expectedTail = `${'abcdefghij'.repeat(10_000)}END`.slice(-TEAM_LIMITS.activityTailChars);
    expect(expectedTail).toHaveLength(TEAM_LIMITS.activityTailChars);
    expect(child.run.activity).toBe(sanitizeActivity(expectedTail, TEAM_LIMITS.activityChars));
    expect(child.run.activity!.length).toBeLessThanOrEqual(TEAM_LIMITS.activityChars);
  });

  it('AC-5: BOTH activity and activityArgs are cleared on turn_start', () => {
    const child = instrumented();
    child.feed({ type: 'tool_execution_start', toolCallId: '1', toolName: 'bash', args: { command: 'ls' } } as AgentEvent);
    expect(child.run.activityArgs).toEqual({ command: 'ls' });

    child.feed({ type: 'turn_start' } as AgentEvent);
    expect(child.run.activity).toBeUndefined();
    expect(child.run.activityArgs).toBeUndefined();
  });

  it('AC-5: ...and on tool_execution_end, which is what bounds the retention (P1-5)', () => {
    // v1 cleared only `activity`, which turned the args retention from a
    // per-tool-call one into a whole-run one.
    const child = instrumented();
    child.feed({
      type: 'tool_execution_start',
      toolCallId: '1',
      toolName: 'write_file',
      args: { path: 'a.ts', content: 'z'.repeat(1_000_000) },
    } as AgentEvent);
    expect(child.run.activityArgs).toEqual({ path: 'a.ts' });

    child.feed({
      type: 'tool_execution_end',
      toolCallId: '1',
      toolName: 'write_file',
      result: { content: [] },
      isError: false,
      duration: 1,
    } as AgentEvent);
    expect(child.run.activity).toBeUndefined();
    expect(child.run.activityArgs).toBeUndefined();
  });

  it('AC-8: 500 deltas in one throttle window produce at most ONE onUpdate', () => {
    // This is the claim that made F-1 affordable - the coalescing budget was
    // ALREADY being paid, and text deltas simply carried nothing into the run.
    // It is a test, not a comment.
    const child = instrumented();
    for (let i = 0; i < 500; i += 1) child.feed(delta('x'));
    expect(child.updates.length).toBeLessThanOrEqual(1);
  });

  it('records `retryable` structurally off a stream error, and clears prose on a tool call', () => {
    const child = instrumented();
    const err = Object.assign(new Error('rate limited'), {
      errorType: 'rate_limit',
      retryable: true,
    });
    child.feed({ type: 'message_update', streamEvent: { type: 'error', error: err } } as AgentEvent);
    expect(child.run.retryable).toBe(true);
    expect(child.run.error).toContain('rate limited');
  });
});

// ---------------------------------------------------------------------------
// AC-9 — the activity line is never logged, at any level
// ---------------------------------------------------------------------------

describe('AC-9: activity never reaches the log (§3.6)', () => {
  it('records no `activity` / `activityArgs` key at any level, from both ends', () => {
    // `lastTool` already answers the diagnostic question this record exists for
    // ("what was it doing when it died"); the argument adds liability without
    // adding diagnosis - the same rule that keeps a `team_send` body out.
    const records: Array<{ level: string; msg: string; data?: Record<string, unknown> }> = [];
    const logger = new Logger();
    for (const level of ['error', 'warn', 'info', 'debug', 'trace'] as const) {
      vi.spyOn(logger, level).mockImplementation(
        (_scope: unknown, msg: string, data?: Record<string, unknown>) => {
          records.push({ level, msg, ...(data ? { data } : {}) });
        },
      );
    }

    let listener: ((event: TeamLogEvent) => void) | null = null;
    attachTeamEvents(logger, {
      subscribeTeam: (fn: (event: TeamLogEvent) => void) => {
        listener = fn;
        return () => {
          listener = null;
        };
      },
    });
    const feed = (e: TeamLogEvent): void =>
      (listener as unknown as (event: TeamLogEvent) => void)(e);

    feed({ type: 'dispatch_start', dispatchId: 'd1', requested: 1, specs: [{ label: 'a1' }] });
    feed({
      type: 'agent_update',
      dispatchId: 'd1',
      // The projection type has no such member, so this cast is the only way to
      // put one on the wire - which is exactly what a future careless edit to
      // `publish()` would do.
      run: {
        label: 'a1',
        phase: 'tool',
        lastTool: 'bash',
        activity: 'the secret prose tail',
        activityArgs: { command: 'psql "postgres://user:hunter2@db/prod"' },
      } as TeamLogEvent extends { run?: infer R } ? R : never,
    });

    const dumped = JSON.stringify(records);
    expect(records.length).toBeGreaterThan(0);
    expect(dumped).not.toContain('activity');
    expect(dumped).not.toContain('hunter2');
    expect(dumped).not.toContain('the secret prose tail');
    // ...and the record it DOES emit still carries the diagnostic fields.
    expect(dumped).toContain('bash');
    vi.restoreAllMocks();
  });
});
