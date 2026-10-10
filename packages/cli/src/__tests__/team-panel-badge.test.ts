import { describe, expect, it } from 'vitest';
import {
  activityBudget,
  activityWithBadge,
  overseerBadge,
  supervisorStatusLine,
} from '../ui/TeamPanel.js';
import { TEAM_LIMITS } from '../team/limits.js';
import type { SubagentRun } from '../team/types.js';

/**
 * The panel's supervisor affordances (subagent-overseer-v2 §7.1-7 / AC-5):
 * the per-row badge, its width degradation, and the one supervisor status
 * line. Pure functions, so the assertions are about content and width
 * arithmetic rather than rendered frames.
 */

const AT = 1_000_000;

function run(over: Partial<SubagentRun> = {}): SubagentRun {
  return {
    label: 'a1',
    description: 'check the api layer',
    phase: 'thinking',
    startedAt: AT - 60_000,
    turns: 2,
    toolCalls: 3,
    usage: { inputTokens: 0, outputTokens: 0 },
    filesTouched: [],
    messagesSent: 0,
    ...over,
  };
}

describe('overseerBadge (AC-5)', () => {
  it('names the action and the elapsed time since the ABSOLUTE stamp (R-P2-3)', () => {
    const nudged = run({
      lastIntervention: { action: 'nudge', at: AT - 123_000, reasonHead: 'circling' },
    });
    expect(overseerBadge(nudged, AT)).toBe('nudged 2m03s');
    const replaced = run({
      lastIntervention: { action: 'replace', at: AT - 2_000, reasonHead: 'wedged' },
    });
    expect(overseerBadge(replaced, AT)).toBe('replaced 2.0s');
    const abandoned = run({
      lastIntervention: { action: 'abandon', at: AT - 500, reasonHead: 'no' },
    });
    expect(overseerBadge(abandoned, AT)).toBe('abandoned 500ms');
    const waited = run({
      lastIntervention: { action: 'wait', at: AT - 61_000, reasonHead: '' },
    });
    expect(overseerBadge(waited, AT)).toBe('waited 1m01s');
  });

  it('is empty when the supervisor has not touched the child', () => {
    expect(overseerBadge(run(), AT)).toBe('');
  });

  it('never renders a negative age for clock skew', () => {
    const future = run({
      lastIntervention: { action: 'nudge', at: AT + 5_000, reasonHead: '' },
    });
    expect(overseerBadge(future, AT)).toBe('nudged 0ms');
  });
});

describe('activityWithBadge (width degradation, §8 risk table)', () => {
  const nudged = run({
    activity: 'auth flow notes',
    lastIntervention: { action: 'nudge', at: AT - 90_000, reasonHead: 'circling' },
  });

  it('composes badge and activity within the shared budget on a wide terminal', () => {
    const wide = TEAM_LIMITS.activityWideCols + 20;
    const line = activityWithBadge(nudged, wide, AT);
    expect(line.startsWith('nudged 1m30s; ')).toBe(true);
    expect(line).toContain('writing: auth flow notes');
    expect(line.length).toBeLessThanOrEqual(
      `nudged 1m30s; writing: `.length + activityBudget(wide),
    );
  });

  it('degrades to the action word alone on a narrow terminal', () => {
    const narrow = 60;
    expect(activityWithBadge(nudged, narrow, AT)).toBe('nudged');
  });

  it('leaves the activity line untouched when there is no badge', () => {
    const wide = TEAM_LIMITS.activityWideCols + 20;
    const withBadge = activityWithBadge(run({ activity: 'auth flow notes' }), wide, AT);
    expect(withBadge).toBe('writing: auth flow notes');
  });
});

describe('supervisorStatusLine (AC-5)', () => {
  it('reports the MOST RECENT intervention across the roster, with its reason head', () => {
    const line = supervisorStatusLine(
      [
        run({ label: 'a1', lastIntervention: { action: 'nudge', at: AT - 200_000, reasonHead: 'circling on tests' } }),
        run({ label: 'a2', lastIntervention: { action: 'wait', at: AT - 30_000, reasonHead: 'legitimately blocked' } }),
      ],
      AT,
    );
    expect(line).toBe('supervisor: waited a2 30.0s ago (legitimately blocked)');
  });

  it('is empty when the supervisor has not acted anywhere', () => {
    expect(supervisorStatusLine([run(), run({ label: 'a2' })], AT)).toBe('');
  });
});
