import { describe, expect, it } from 'vitest';
import { buildDispatchReport, findFileConflicts, truncateBytes } from '../team/report.js';
import { TEAM_LIMITS } from '../team/limits.js';
import type { DispatchOutcome, SubagentRun } from '../team/types.js';

function run(over: Partial<SubagentRun> = {}): SubagentRun {
  return {
    label: 'a1',
    description: 'read the auth middleware',
    phase: 'done',
    startedAt: 1000,
    endedAt: 23_100,
    turns: 4,
    toolCalls: 7,
    usage: { inputTokens: 10_000, outputTokens: 2_000 },
    filesTouched: [],
    messagesSent: 0,
    summary: 'auth is middleware-based; see src/auth/mw.ts',
    ...over,
  };
}

function outcome(over: Partial<DispatchOutcome> = {}): DispatchOutcome {
  const runs = over.runs ?? [run()];
  return {
    dispatchId: 'd1',
    runs,
    requested: runs.length,
    startedAt: 1000,
    endedAt: 85_200,
    aborted: false,
    leadMail: [],
    usage: { inputTokens: 41_200, outputTokens: 8_900 },
    ...over,
  };
}

describe('buildDispatchReport', () => {
  it('leads with the counts, the token totals and every per-agent section (AC-4)', () => {
    const report = buildDispatchReport(
      outcome({
        runs: [
          run({ label: 'a1' }),
          run({ label: 'a2', description: 'map the route table', turns: 6, toolCalls: 11 }),
          run({
            label: 'a3',
            description: 'check the migration',
            phase: 'failed',
            error: 'idle watchdog aborted the run',
            summary: undefined,
          }),
        ],
      }),
    );
    const lines = report.split('\n');
    expect(lines[0]).toContain('3 of 3 subagents finished (2 ok, 1 failed)');
    expect(lines[1]).toContain('Tokens: in 41.2k, out 8.9k');
    expect(report).toContain('### a1 "read the auth middleware"  [ok]');
    expect(report).toContain('### a2 "map the route table"  [ok]');
    expect(report).toContain('### a3 "check the migration"  [failed: idle watchdog aborted the run]');
    // A failed child never fails the dispatch (D-14), so the others are intact.
    expect(report).toContain('auth is middleware-based');
  });

  it('says "n of m requested" when the fan-out was capped (AC-7)', () => {
    const report = buildDispatchReport(outcome({ requested: 30, runs: [run(), run({ label: 'a2' })] }));
    expect(report).toContain('ran 2 of 30 requested subagents');
  });

  it('puts ABORTED on the FIRST line so partial work cannot read as complete', () => {
    const report = buildDispatchReport(outcome({ aborted: true, endedAt: 13_000 }));
    expect(report.split('\n')[0]).toContain('Team dispatch ABORTED after');
    expect(report.split('\n')[0]).toContain('partial results below');
  });

  it('renders a visible (no summary) rather than an empty section (R-12)', () => {
    const report = buildDispatchReport(outcome({ runs: [run({ summary: undefined, phase: 'done' })] }));
    expect(report).toContain('(no summary)');
  });

  it('warns about a shared file as a WARNING, not as a fact (R-2)', () => {
    const report = buildDispatchReport(
      outcome({
        runs: [
          run({ label: 'api', filesTouched: ['src/routes.ts', 'src/api.ts'] }),
          run({ label: 'docs', filesTouched: ['src/routes.ts'] }),
        ],
      }),
    );
    // `filesTouched` cannot see writes made through `bash`, so the wording has
    // to stop short of claiming the two definitely conflict.
    expect(report).toContain(
      'WARNING: agents "api" and "docs" both wrote src/routes.ts - review before trusting either.',
    );
    expect(report).toContain('files: src/routes.ts, src/api.ts');
  });

  it('emits no warning when nothing overlaps', () => {
    const report = buildDispatchReport(
      outcome({
        runs: [run({ label: 'a1', filesTouched: ['a.ts'] }), run({ label: 'a2', filesTouched: ['b.ts'] })],
      }),
    );
    expect(report).not.toContain('WARNING');
  });

  it('marks a turn-capped child as stopped rather than failed', () => {
    const report = buildDispatchReport(outcome({ runs: [run({ truncated: true })] }));
    expect(report).toContain('[stopped: turn cap reached]');
  });

  it('reports a subagent as failed when it produced nothing', () => {
    const report = buildDispatchReport(
      outcome({ runs: [run({ phase: 'failed', error: 'run produced no output', summary: undefined })] }),
    );
    expect(report).toContain('[failed: run produced no output]');
  });

  it('gives messages addressed to the lead their own section', () => {
    const report = buildDispatchReport(
      outcome({
        leadMail: [
          { from: 'a1', to: 'lead', subject: 'auth uses a second session store', body: 'see session.ts', at: 13_000 },
        ],
      }),
    );
    expect(report).toContain('### Messages to you');
    expect(report).toContain('[a1 -> lead] "auth uses a second session store" (12s in)');
    expect(report).toContain('see session.ts');
  });
});

describe('byte budgeting (D-8 / I-9)', () => {
  it('KEEPS THE HEADER AND STATUS LINES when the budget is exhausted', () => {
    // `ToolExecutor` truncates combined tool text at 100 000 BYTES, so a report
    // that lost its own failure count first would be the worst possible
    // casualty. Summaries are trimmed; the header is not.
    const runs = Array.from({ length: 5 }, (_, i) =>
      run({ label: `a${i}`, summary: 'x'.repeat(40_000), phase: i === 0 ? 'failed' : 'done', error: i === 0 ? 'boom' : undefined }),
    );
    const report = buildDispatchReport(outcome({ runs }));
    expect(Buffer.byteLength(report, 'utf8')).toBeLessThanOrEqual(TEAM_LIMITS.reportMaxBytes);
    expect(report).toContain('(4 ok, 1 failed)');
    for (let i = 0; i < 5; i += 1) expect(report).toContain(`### a${i} `);
    expect(report).toContain('[trimmed]');
  });

  it('counts CJK in BYTES, not characters', () => {
    // A 24 000-character CJK summary is 72 000 bytes. A character-denominated
    // cap would sail past the budget and let the executor chop the report
    // mid-section.
    const cjk = '中'.repeat(24_000);
    const report = buildDispatchReport(outcome({ runs: [run({ summary: cjk })] }));
    expect(report.length).toBeLessThan(cjk.length);
    expect(Buffer.byteLength(report, 'utf8')).toBeLessThanOrEqual(TEAM_LIMITS.reportMaxBytes);
  });

  it('clamps a single summary to summaryMaxBytes before any global trimming', () => {
    const report = buildDispatchReport(outcome({ runs: [run({ summary: 'y'.repeat(20_000) })] }));
    expect(Buffer.byteLength(report, 'utf8')).toBeLessThan(TEAM_LIMITS.summaryMaxBytes + 2000);
  });
});

describe('truncateBytes', () => {
  it('never splits a UTF-8 sequence', () => {
    // Slicing the buffer blindly at an arbitrary offset produces a replacement
    // character in the middle of a CJK report.
    const cjk = '中文测试';
    for (let n = 0; n <= Buffer.byteLength(cjk, 'utf8'); n += 1) {
      const cut = truncateBytes(cjk, n);
      expect(cut).not.toContain('�');
      expect(Buffer.byteLength(cut, 'utf8')).toBeLessThanOrEqual(n);
      expect(cjk.startsWith(cut)).toBe(true);
    }
  });

  it('returns the input unchanged when it already fits', () => {
    expect(truncateBytes('hello', 100)).toBe('hello');
  });
});

describe('what the lead learns about F-3 and F-4 (team-live-activity)', () => {
  it('AC-24: `blocked waits: N` appears only for a child that had one', () => {
    // A child that tried twice to reach a teammate and could not is a child
    // whose brief had a dependency the lead should not have split. One line, in
    // a section that is trimmed last.
    const withBlocked = buildDispatchReport(
      outcome({ runs: [run({ label: 'a1', blockedWaits: 2 })] }),
    );
    expect(withBlocked).toContain('blocked waits: 2 (no teammate could answer)');

    expect(buildDispatchReport(outcome({ runs: [run({ label: 'a1' })] })))
      .not.toContain('blocked waits');
    expect(buildDispatchReport(outcome({ runs: [run({ label: 'a1', blockedWaits: 0 })] })))
      .not.toContain('blocked waits');
  });

  it('`retried Nx` rides on the head line, which is never trimmed', () => {
    const report = buildDispatchReport(outcome({ runs: [run({ label: 'a1', retries: 1 })] }));
    expect(report).toContain('4 turns, 7 tools, retried 1x');
    expect(buildDispatchReport(outcome({ runs: [run({ label: 'a1' })] })))
      .not.toContain('retried');
  });

  it('both fragments survive the last-resort trim that drops every summary', () => {
    // The header, the status lines and these two are what a report must never
    // lose - a report that loses its own failure count is worse than one that
    // loses prose.
    const huge = 'z'.repeat(TEAM_LIMITS.reportMaxBytes);
    const report = buildDispatchReport(
      outcome({
        runs: [
          run({ label: 'a1', retries: 1, blockedWaits: 3, summary: huge }),
          run({ label: 'a2', summary: huge }),
        ],
      }),
    );
    expect(report).toContain('retried 1x');
    expect(report).toContain('blocked waits: 3');
  });
});

describe('findFileConflicts', () => {
  it('is a set intersection over filesTouched, sorted by path', () => {
    const conflicts = findFileConflicts([
      run({ label: 'a', filesTouched: ['z.ts', 'a.ts'] }),
      run({ label: 'b', filesTouched: ['a.ts', 'z.ts'] }),
      run({ label: 'c', filesTouched: ['c.ts'] }),
    ]);
    expect(conflicts).toEqual([
      { path: 'a.ts', labels: ['a', 'b'] },
      { path: 'z.ts', labels: ['a', 'b'] },
    ]);
  });

  it('renders the Supervisor ledger and the per-run overseer/replaced counts (team-overseer)', () => {
    const report = buildDispatchReport(
      outcome({
        runs: [run({ interventions: 2, replacements: 1 })],
        interventions: [
          {
            label: 'a1',
            at: 31_000,
            action: 'nudge',
            reason: 'circling on the flaky suite',
            trigger: 'silence',
          },
          {
            label: 'a1',
            at: 62_000,
            action: 'replace',
            reason: 'wedged on a dead endpoint',
            trigger: 'clock',
          },
        ],
      }),
    );
    expect(report).toContain(', overseer 2, replaced 1x');
    expect(report).toContain('### Supervisor');
    expect(report).toContain('[silence 30s] a1: nudge - circling on the flaky suite');
    expect(report).toContain('[clock 61s] a1: replace - wedged on a dead endpoint');
  });

  it('omits the Supervisor section entirely when the supervisor never acted', () => {
    const report = buildDispatchReport(outcome());
    expect(report).not.toContain('### Supervisor');
    expect(report).not.toContain('overseer ');
  });
});

describe('supervisor accounting (subagent-overseer-v2 D-7 / D-10)', () => {
  it('renders the fast-tier spend line, priced at fastCost', () => {
    const report = buildDispatchReport(
      outcome({
        overseerUsage: { inputTokens: 2_100, outputTokens: 4_000 },
        overseerCalls: 3,
        interventions: [
          { label: 'a1', at: 31_000, action: 'nudge', reason: 'circling', trigger: 'silence' },
        ],
      }),
      { fastCost: { input: 0.8, output: 4 } },
    );
    expect(report).toContain('supervisor: 3 calls, 2.1k in / 4.0k out tokens (fast tier)');
    // Priced at the FAST table, not the lead's (R-P1-2): 2.1k in at 0.8/M
    // plus 4.0k out at 4/M is $0.0177 -> rendered, never folded into the
    // header's main-tier total.
    expect(report).toContain('(fast tier), $0.0177');
  });

  it('says pricing unknown instead of a fabricated $0.00 when the fast model is unpriced', () => {
    const report = buildDispatchReport(
      outcome({
        overseerUsage: { inputTokens: 100, outputTokens: 100 },
        overseerCalls: 1,
      }),
    );
    expect(report).toContain('supervisor: 1 call, 100 in / 100 out tokens (fast tier), pricing unknown');
    expect(report).not.toContain('supervisor: 1 call, 100 in / 100 out tokens (fast tier), $0.00');
  });

  it('omits the spend line entirely when no call was ever made', () => {
    // Better missing than false (D-7): zero calls means nothing to price.
    const report = buildDispatchReport(outcome());
    expect(report).not.toContain('supervisor:');
    expect(report).not.toContain('fast tier)');
  });

  it('renders ONE aggregated degraded note, not per-tick rows (D-10)', () => {
    const report = buildDispatchReport(
      outcome({
        overseerDegraded: true,
        overseerDegradedTicks: 7,
        interventions: [
          { label: 'a1', at: 31_000, action: 'nudge', reason: 'before the outage', trigger: 'silence' },
        ],
      }),
    );
    expect(report.match(/fast tier was unavailable/g)?.length).toBe(1);
    expect(report).toContain('unavailable for 7 cadence check(s)');
    expect(report).toContain('waited unassisted and none were killed');
  });

  it('renders ONE aggregated went-quiet note sourced from trigger:quiet entries (D-5 / D-10)', () => {
    const report = buildDispatchReport(
      outcome({
        interventions: [
          { label: 'a1', at: 31_000, action: 'wait', reason: 'budget', trigger: 'quiet' },
          { label: 'a2', at: 32_000, action: 'wait', reason: 'budget', trigger: 'quiet' },
          { label: 'team', at: 33_000, action: 'wait', reason: 'dispatch total', trigger: 'quiet' },
        ],
      }),
    );
    expect(report.match(/went quiet on/g)?.length).toBe(1);
    expect(report).toContain('went quiet on 2 children');
    // The team pseudo-label still reads as one ledger row, not a child.
    expect(report).toContain('[quiet 32s] team: wait - dispatch total');
  });

  it('keeps the ledger row format unchanged (R-P2-4 regression)', () => {
    const report = buildDispatchReport(
      outcome({
        interventions: [
          { label: 'a1', at: 31_000, action: 'nudge', reason: 'circling', trigger: 'clock' },
        ],
        overseerUsage: { inputTokens: 1, outputTokens: 1 },
        overseerCalls: 1,
      }),
    );
    expect(report).toContain('[clock 30s] a1: nudge - circling');
  });
});
