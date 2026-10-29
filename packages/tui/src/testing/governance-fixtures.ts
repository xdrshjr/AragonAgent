/**
 * Snapshot / card fixtures for the governance TUI tests. The engine is built by another
 * agent, so every UI test runs against these hand-built shapes.
 */

import type {
  GovernanceCardData,
  GovernanceSnapshot,
  PipelineStep,
  RosterRow,
} from '../model/governance/types.js';

export const NOW = 1_000_000;

export function rosterRow(over: Partial<RosterRow> = {}): RosterRow {
  return {
    id: 'dev1',
    role: 'DEV',
    generation: 0,
    state: 'working',
    wpId: 'auth-api',
    activity: 'login endpoint + session',
    confirmed: 100,
    provisional: 0,
    label: 'NORMAL',
    lastDelta: null,
    replacedBy: null,
    ...over,
  };
}

export function pipeline(active: PipelineStep['key'] = 'review'): PipelineStep[] {
  const keys: PipelineStep['key'][] = ['intake', 'dev', 'review', 'test', 'settle', 'integrate'];
  const at = keys.indexOf(active);
  return keys.map((key, index) => ({
    key,
    state: index < at ? 'done' : index === at ? 'active' : 'pending',
  }));
}

/** The six-member roster of the spec's 10.3 sketch. */
export function sketchRoster(): RosterRow[] {
  return [
    rosterRow({ id: 'dev1', state: 'submitted', confirmed: 100, provisional: 15, activity: '' }),
    rosterRow({
      id: 'dev2', wpId: 'ui-form', state: 'submitted', confirmed: 80, label: 'WARNING',
      activity: 'rework 1/3',
    }),
    rosterRow({
      id: 'rev1', role: 'REV', state: 'working', wpId: 'auth-api',
      activity: 'grep "sanitize" src/auth',
    }),
    rosterRow({
      id: 'rev2', role: 'REV', state: 'working', wpId: 'ui-form',
      activity: 'read_file ui/Form.tsx',
    }),
    rosterRow({ id: 'tst1', role: 'TEST', state: 'queued', wpId: null, activity: '' }),
    rosterRow({
      id: 'insp', role: 'INSP', state: 'idle', wpId: null, activity: '', confirmed: null,
      label: 'NOT_SCORED',
    }),
  ];
}

export function snapshot(over: Partial<GovernanceSnapshot> = {}): GovernanceSnapshot {
  return {
    runId: 'gmh3k7f3a',
    goal: 'ship the login flow',
    status: 'executing',
    phase: 2,
    phaseCount: 3,
    stage: 'review',
    stageRunning: true,
    startedAt: NOW - 842_000,
    pipeline: pipeline('review'),
    roster: sketchRoster(),
    health: 88,
    recent: [
      { at: NOW - 3000, agentId: 'rev2', code: 'R2', delta: 10, provisional: false, reason: 'valid finding' },
      { at: NOW - 2000, agentId: 'dev2', code: 'D5', delta: -20, provisional: false, reason: 'rework' },
      { at: NOW - 1000, agentId: 'dev1', code: 'D1', delta: 15, provisional: true, reason: 'review pass' },
    ],
    usage: { inputTokens: 300_000, outputTokens: 112_000, costUsd: 0.42 },
    budgetTokens: 0,
    alerts: [],
    reworkNote: 'rework 1/3 (ui-form)',
    rev: 1,
    ...over,
  };
}

export function manyAgents(count: number): RosterRow[] {
  return Array.from({ length: count }, (_, i) =>
    rosterRow({ id: `dev${i + 1}`, wpId: `wp-${i + 1}` }),
  );
}

export function card(over: Partial<GovernanceCardData> = {}): GovernanceCardData {
  return {
    variant: 'phase',
    runId: 'gmh3k7f3a',
    title: 'phase 2 integrated',
    headline: 'integration passed (attempt 1)   3 contracts checked   npm test: 214 ok',
    tone: 'ok',
    rows: [
      { id: 'dev1', role: 'DEV', confirmed: 115, deltaText: '+15P->C D1  +10 D12  +5 C1' },
      { id: 'dev2', role: 'DEV', confirmed: 90, deltaText: '-20 D5  +10 D12  +5 C1' },
      { id: 'rev1', role: 'REV', confirmed: 110, deltaText: '+10P->C R1  +10 R10' },
      { id: 'tst1', role: 'TEST', confirmed: 105, deltaText: '+10P->C T1  +5 C1' },
    ],
    notes: ['dev2 reworked once', 'no eliminations', 'health 96'],
    ...over,
  };
}
