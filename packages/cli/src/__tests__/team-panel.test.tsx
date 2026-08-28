import { describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import React from 'react';
import { render as inkRender } from 'ink';
import { render } from 'ink-testing-library';
import { TeamPanel, activityBudget, activityLine } from '../ui/TeamPanel.js';
import { TeamCard } from '../ui/entries/TeamCard.js';
import { StatusBar } from '../ui/StatusBar.js';
import { getTheme } from '../ui/theme.js';
import { TEAM_LIMITS } from '../team/limits.js';
import type { SubagentRun, TeamSnapshot } from '../team/types.js';

const RICH = { colorLevel: 3 as const, unicode: true };
const ASCII = { colorLevel: 0 as const, unicode: false };

// eslint-disable-next-line no-control-regex
const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, '');

function run(over: Partial<SubagentRun> = {}): SubagentRun {
  return {
    label: 'a1',
    description: 'read the auth middleware',
    tier: 'main',
    phase: 'tool',
    startedAt: 1000,
    turns: 4,
    toolCalls: 7,
    lastTool: 'grep',
    usage: { inputTokens: 10, outputTokens: 5 },
    filesTouched: [],
    messagesSent: 0,
    ...over,
  };
}

function snapshot(over: Partial<TeamSnapshot> = {}): TeamSnapshot {
  return {
    dispatchId: 'd1',
    active: true,
    runs: [run(), run({ label: 'a2', description: 'map the route table', phase: 'thinking' })],
    requested: 2,
    startedAt: 1000,
    messageCount: 0,
    ...over,
  };
}

function frameOf(node: React.ReactElement): string {
  const { lastFrame, unmount } = render(node);
  const out = stripAnsi(lastFrame() ?? '');
  unmount();
  return out;
}

describe('TeamPanel (§6.1)', () => {
  it('names each subagent, what it is doing, and how long it has been going', () => {
    const frame = frameOf(
      <TeamPanel
        snapshot={snapshot()}
        rows={40}
        cols={120}
        reducedMotion
        theme={getTheme('cool', RICH)}
        caps={RICH}
        now={23_100}
      />,
    );
    expect(frame).toContain('team');
    expect(frame).toContain('a1');
    expect(frame).toContain('read the auth middleware');
    // The middle column is the ACTIVITY line now, not the phase word (F-1): a
    // `grep` whose pattern the panel never saw degrades to the verb, and a
    // `grep` with one says what it is looking for.
    expect(frame).toContain('grep');
    expect(frame).not.toContain('tool: grep');
    expect(frame).toContain('2 running');
    expect(frame).toContain('0 done');
    expect(frame).toContain('22.1s');
  });

  it('caps the roster at five rows and says how many are hidden', () => {
    // Five is also the documented maximum number of simultaneous spinners, which
    // is why the row cap and the motion budget are the same number.
    const runs = Array.from({ length: 9 }, (_, i) => run({ label: `a${i + 1}` }));
    const frame = frameOf(
      <TeamPanel
        snapshot={snapshot({ runs, requested: 9 })}
        rows={40}
        cols={120}
        reducedMotion
        theme={getTheme('cool', RICH)}
        caps={RICH}
        now={2000}
      />,
    );
    expect(frame).toContain('a5');
    expect(frame).not.toContain('a6 ');
    expect(frame).toContain(`+${9 - TEAM_LIMITS.panelMaxRows} more`);
  });

  it('collapses to its single header line below 20 rows (§6.4)', () => {
    const frame = frameOf(
      <TeamPanel
        snapshot={snapshot()}
        rows={18}
        cols={120}
        reducedMotion
        theme={getTheme('cool', RICH)}
        caps={RICH}
        now={2000}
      />,
    );
    expect(frame).toContain('team');
    expect(frame).toContain('running');
    // The roster is what costs rows the transcript needs on a short terminal.
    expect(frame).not.toContain('read the auth middleware');
  });

  it('AC-9: emits no non-ASCII byte with caps.unicode === false', () => {
    const frame = frameOf(
      <TeamPanel
        snapshot={snapshot({
          messageCount: 2,
          lastMessage: { from: 'a1', to: 'lead', subject: 'second session store', body: '', at: 0 },
        })}
        rows={40}
        cols={120}
        reducedMotion
        theme={getTheme('cool', ASCII)}
        caps={ASCII}
        now={2000}
      />,
    );
    expect(frame).not.toMatch(/[^\x00-\x7f]/);
    expect(frame).toContain('second session store');
  });

  it('shows the mail counter and the latest message only when there is one', () => {
    const quiet = frameOf(
      <TeamPanel
        snapshot={snapshot()}
        rows={40}
        cols={120}
        reducedMotion
        theme={getTheme('cool', ASCII)}
        caps={ASCII}
        now={2000}
      />,
    );
    expect(quiet).not.toContain('-> lead');

    const chatty = frameOf(
      <TeamPanel
        snapshot={snapshot({
          messageCount: 2,
          lastMessage: { from: 'a1', to: 'lead', subject: 'found it', body: '', at: 0 },
        })}
        rows={40}
        cols={120}
        reducedMotion
        theme={getTheme('cool', ASCII)}
        caps={ASCII}
        now={2000}
      />,
    );
    expect(chatty).toContain('found it');
  });
});

// ---------------------------------------------------------------------------
// team-live-activity F-1 / F-2 — the activity column and the row ranking
// ---------------------------------------------------------------------------

/**
 * `ink-testing-library` hardcodes `columns` at 100, so the narrow cases go
 * through Ink's own `render` with a stdout we control - the same pattern the
 * StatusBar block below uses.
 */
function panelAt(cols: number, node: React.ReactElement): string {
  const stdout = new EventEmitter() as EventEmitter & {
    columns: number;
    rows: number;
    write: (s: string) => void;
  };
  let last = '';
  stdout.columns = cols;
  stdout.rows = 40;
  stdout.write = (s: string) => {
    last = s;
  };
  const instance = inkRender(node, {
    stdout: stdout as unknown as NodeJS.WriteStream,
    patchConsole: false,
    exitOnCtrlC: false,
  });
  const out = stripAnsi(last);
  instance.unmount();
  return out;
}

describe('activityBudget / activityLine (F-1, P0-1)', () => {
  it('AC-3c: the budget is width-driven, monotonic, and bounded at both ends', () => {
    let previous = 0;
    for (let cols = 1; cols <= 400; cols += 1) {
      const budget = activityBudget(cols);
      expect(budget, `cols=${cols}`).toBeGreaterThanOrEqual(TEAM_LIMITS.activityMinChars);
      expect(budget, `cols=${cols}`).toBeLessThanOrEqual(TEAM_LIMITS.activityChars);
      expect(budget, `cols=${cols}`).toBeGreaterThanOrEqual(previous);
      previous = budget;
    }
    // The two ends of the range this actually has to serve.
    expect(activityBudget(40)).toBe(TEAM_LIMITS.activityMinChars);
    expect(activityBudget(400)).toBe(TEAM_LIMITS.activityChars);
    expect(activityBudget(80)).toBeLessThan(TEAM_LIMITS.activityChars);
  });

  it('AC-3c: a full-length prose tail is clamped AT RENDER against the terminal', () => {
    // v1's line was `writing: ${run.activity}` in both forms - a fixed 73
    // characters at every width, which on an 80-column terminal needs 94 columns
    // before the description gets one. `activityChars` is a STORAGE ceiling; a
    // terminal has a COLUMN budget, and the two are not the same number.
    const prose = 'the three panels that no longer render anything at all here';
    const thinking = run({ phase: 'thinking', activity: prose.slice(0, TEAM_LIMITS.activityChars) });

    const narrow = activityLine(thinking, 80);
    expect(narrow.startsWith('writing: ')).toBe(true);
    expect(narrow.length - 'writing: '.length).toBeLessThanOrEqual(activityBudget(80));
    expect(narrow.length).toBeLessThan(`writing: ${thinking.activity}`.length);

    const wide = activityLine(thinking, 200);
    expect(wide.length).toBeGreaterThan(narrow.length);
  });

  it('AC-6: prose renders only in `thinking`, and the tool phrase only in tool / waiting', () => {
    const prose = 'writing the summary now';
    expect(activityLine(run({ phase: 'thinking', activity: prose }), 120))
      .toBe(`writing: ${prose}`);
    // No delta yet in this turn: exactly as before this round.
    expect(activityLine(run({ phase: 'thinking' }), 120)).toBe('thinking');
    expect(
      activityLine(
        run({ phase: 'tool', lastTool: 'bash', activity: prose, activityArgs: { command: 'npm test' } }),
        120,
      ),
    ).toBe('bash: npm test');
    expect(
      activityLine(run({ phase: 'waiting', lastTool: 'team_wait', activityArgs: { from: 'a2' } }), 120),
    ).toBe('waiting for a2');
    // The phase word survives when neither source has anything to say.
    expect(activityLine(run({ phase: 'waiting', lastTool: undefined }), 120)).toBe('waiting for mail');
    expect(activityLine(run({ phase: 'tool', lastTool: undefined }), 120)).toBe('tool');
    expect(activityLine(run({ phase: 'queued' }), 120)).toBe('queued');
    expect(activityLine(run({ phase: 'done', turns: 6 }), 120)).toBe('done  6 turns');
    expect(activityLine(run({ phase: 'failed' }), 120)).toBe('failed');
    expect(activityLine(run({ phase: 'aborted' }), 120)).toBe('aborted');
  });

  it('AC-7: below activityWideCols a nested path renders as a basename', () => {
    const reading = run({ phase: 'tool', lastTool: 'read_file', activityArgs: { path: 'src/api/routes.ts' } });
    const narrow = activityLine(reading, TEAM_LIMITS.activityWideCols - 1);
    expect(narrow).toBe('read: routes.ts');
    expect(narrow).not.toContain('/');
    expect(activityLine(reading, TEAM_LIMITS.activityWideCols)).toBe('read: src/api/routes.ts');
  });

  it('a retrying child says so, because it is the one row that restarts its clock', () => {
    expect(activityLine(run({ phase: 'starting' }), 120)).toBe('starting');
    expect(activityLine(run({ phase: 'starting', retries: 1 }), 120)).toBe('starting (retry)');
  });
});

describe('TeamPanel rows (F-1 / F-2)', () => {
  const fiveRunning = Array.from({ length: 5 }, (_, i) =>
    run({
      label: `a${i + 1}`,
      description: 'x'.repeat(60),
      phase: 'tool',
      lastTool: 'bash',
      activityArgs: { command: 'npm run db:generate --workspace packages/cli' },
      startedAt: 1000 + i,
    }),
  );

  it('AC-3d: at 80 columns the elapsed column is on screen for every row', () => {
    // The user-visible form of P0-1, and the reason the activity cell is also
    // `flexShrink={1} overflow="hidden"`. At 100 columns v1 already fit, so the
    // test that matters is the narrow one.
    const frame = panelAt(
      80,
      <TeamPanel
        snapshot={snapshot({ runs: fiveRunning, requested: 5 })}
        rows={40}
        cols={80}
        reducedMotion
        theme={getTheme('cool', ASCII)}
        caps={ASCII}
        now={23_100}
      />,
    );
    const rows = frame.split('\n').filter((l) => /\ba[1-5]\b/.test(l));
    expect(rows).toHaveLength(5);
    for (const line of rows) {
      expect(line, line).toMatch(/22\.\ds/);
      expect(line.length, line).toBeLessThanOrEqual(80);
    }
  });

  it('AC-10: shows the RUNNING children rather than the five that finished first', () => {
    // The shipped panel sliced by array index, and the slot pool hands out
    // indices in order - so this snapshot rendered five green settled rows and
    // `+3 more` while three children were working.
    const runs = [
      ...Array.from({ length: 5 }, (_, i) =>
        run({ label: `done${i}`, phase: 'done', startedAt: 100, endedAt: 900 + i }),
      ),
      ...Array.from({ length: 3 }, (_, i) =>
        run({ label: `live${i}`, phase: 'thinking', startedAt: 2000 + i }),
      ),
    ];
    const frame = frameOf(
      <TeamPanel
        snapshot={snapshot({ runs, requested: 8 })}
        rows={40}
        cols={120}
        reducedMotion
        theme={getTheme('cool', ASCII)}
        caps={ASCII}
        now={3000}
      />,
    );
    expect(frame).toContain('live0');
    expect(frame).toContain('live1');
    expect(frame).toContain('live2');
    expect(frame).toContain('+3 more');
    // Nothing running is hidden, so the qualifier stays off.
    expect(frame).not.toContain('running)');
  });

  it('says how many hidden children are still working when any are', () => {
    const runs = Array.from({ length: 8 }, (_, i) =>
      run({ label: `a${i}`, phase: 'thinking', startedAt: 100 + i }),
    );
    const frame = frameOf(
      <TeamPanel
        snapshot={snapshot({ runs, requested: 8 })}
        rows={40}
        cols={120}
        reducedMotion
        theme={getTheme('cool', ASCII)}
        caps={ASCII}
        now={3000}
      />,
    );
    expect(frame).toContain('+3 more (3 running)');
  });

  it('renders the activity line and stays pure ASCII without Unicode support', () => {
    const runs = [
      run({ label: 'a1', phase: 'tool', lastTool: 'bash', activityArgs: { command: 'npm test -w cli' }, startedAt: 1000 }),
      run({ label: 'a2', phase: 'thinking', activity: 'mapping the route table', startedAt: 1000 }),
    ];
    const frame = frameOf(
      <TeamPanel
        snapshot={snapshot({ runs })}
        rows={40}
        cols={140}
        reducedMotion
        theme={getTheme('cool', ASCII)}
        caps={ASCII}
        now={2000}
      />,
    );
    expect(frame).toContain('bash: npm test -w cli');
    expect(frame).toContain('writing: mapping the route table');
    expect(frame).not.toMatch(/[^\x00-\x7f]/);
  });
});

describe('StatusBar team cluster (§6.2 / D-20 / P2-1)', () => {
  /**
   * `ink-testing-library` hardcodes `columns` at 100, so the narrow case is
   * driven through Ink's own `render` with a stdout we control — the same
   * pattern `mouse-routing.test.tsx` uses for the scroll indicator.
   */
  const bar = (cols: number, teamActive?: { running: number; total: number }): string => {
    const stdout = new EventEmitter() as EventEmitter & {
      columns: number;
      rows: number;
      write: (s: string) => void;
    };
    let last = '';
    stdout.columns = cols;
    stdout.rows = 24;
    stdout.write = (s: string) => {
      last = s;
    };

    const instance = inkRender(
      <StatusBar
        model="claude-sonnet-4-5"
        provider="anthropic"
        usageTotal={{ inputTokens: 10, outputTokens: 5, costUsd: 0.24 }}
        contextTokens={1000}
        contextWindow={200_000}
        contextWindowKnown
        status="running"
        elapsedMs={1000}
        thinkingLevel="off"
        tokPerSec={0}
        theme={getTheme('cool', ASCII)}
        caps={ASCII}
        {...(teamActive ? { teamActive } : {})}
      />,
      { stdout: stdout as unknown as NodeJS.WriteStream, patchConsole: false, exitOnCtrlC: false },
    );
    const out = stripAnsi(last);
    instance.unmount();
    return out;
  };

  it('renders `agents 3/5` on a wide terminal', () => {
    expect(bar(120, { running: 3, total: 5 })).toContain('agents 3/5');
  });

  it('degrades to `[3]` under 100 columns, so the context gauge keeps its columns', () => {
    // The left cluster is `flexShrink={0}`, so every column it takes comes out
    // of the gauge and the cost readout opposite it — and the gauge is how a
    // user notices they are about to run out of context. The team counter has
    // two other homes; it is the one readout here that can afford to degrade.
    const narrow = bar(80, { running: 3, total: 5 });
    expect(narrow).toContain('[3]');
    expect(narrow).not.toContain('agents 3/5');
  });

  it('renders nothing at all when no dispatch is running', () => {
    const idle = bar(120);
    expect(idle).not.toContain('agents');
    expect(idle).not.toContain('[3]');
  });
});

describe('TeamCard (§6.3)', () => {
  it('summarizes a finished dispatch and offers the summaries behind Ctrl+O', () => {
    const frame = frameOf(
      <TeamCard
        requested={3}
        runs={[
          run({ label: 'a1', phase: 'done', endedAt: 23_100, summary: 'auth is middleware-based' }),
          run({ label: 'a2', phase: 'done', endedAt: 32_600, filesTouched: ['a.ts', 'b.ts'] }),
          run({ label: 'a3', phase: 'failed', endedAt: 85_000, error: 'idle watchdog aborted the run' }),
        ]}
        aborted={false}
        durationMs={84_200}
        active={false}
        theme={getTheme('cool', ASCII)}
        caps={ASCII}
      />,
    );
    expect(frame).toContain('team');
    expect(frame).toContain('3 subagents');
    expect(frame).toContain('(2 ok, 1 failed)');
    expect(frame).toContain('idle watchdog aborted the run');
    expect(frame).toContain('2 files');
    expect(frame).toContain('(Ctrl+O)');
    // Collapsed: the summaries are behind the key, not on screen.
    expect(frame).not.toContain('auth is middleware-based');
  });

  it('expands to the per-agent summaries', () => {
    const frame = frameOf(
      <TeamCard
        requested={1}
        runs={[run({ phase: 'done', endedAt: 23_100, summary: 'auth is middleware-based' })]}
        aborted={false}
        durationMs={22_100}
        active={false}
        expanded
        theme={getTheme('cool', ASCII)}
        caps={ASCII}
      />,
    );
    expect(frame).toContain('auth is middleware-based');
    expect(frame).toContain('(Ctrl+O to collapse)');
  });

  it('says `n of m requested` when the fan-out was capped', () => {
    const frame = frameOf(
      <TeamCard
        requested={30}
        runs={[run({ phase: 'done', endedAt: 2000 })]}
        aborted={false}
        durationMs={1000}
        active={false}
        theme={getTheme('cool', ASCII)}
        caps={ASCII}
      />,
    );
    expect(frame).toContain('1 of 30 requested');
  });

  it('P1-5: a resumed dispatch reads as interrupted, not as a dispatch that lost', () => {
    // `0.0s (0 ok, 3 failed)` would be the alternative, and it describes
    // something that never happened.
    const frame = frameOf(
      <TeamCard
        requested={3}
        runs={[run({ phase: 'thinking' })]}
        aborted
        active={false}
        theme={getTheme('cool', ASCII)}
        caps={ASCII}
      />,
    );
    expect(frame).toContain('interrupted (session resumed)');
  });

  it('AC-9: emits no non-ASCII byte with caps.unicode === false', () => {
    const frame = frameOf(
      <TeamCard
        requested={2}
        runs={[run({ phase: 'done', endedAt: 2000 }), run({ label: 'a2', phase: 'failed', error: 'boom' })]}
        aborted={false}
        durationMs={1000}
        active={false}
        theme={getTheme('cool', ASCII)}
        caps={ASCII}
      />,
    );
    expect(frame).not.toMatch(/[^\x00-\x7f]/);
  });
});
