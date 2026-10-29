/**
 * The tool voice (tui-subagent-persona-and-developer-mode §3.2 / AC-4, AC-5, AC-6, AC-14).
 *
 * Developer voice must reproduce the pre-feature wording byte for byte (it is the
 * regression baseline AND the rollback); friendly voice must never print a raw tool
 * identifier, must not depend on the clock, and must treat model-controlled strings
 * as hostile.
 */

import { describe, expect, it } from 'vitest';
import { describeToolActivity } from '../model/team/activity.js';
import type { SubagentRun } from '../model/team/types.js';
import { teamRowCells, activityLine } from '../ui/layout/team-row.js';
import { pickGlyphs } from '../ui/glyphs.js';
import {
  DEVELOPER_VOICE,
  bindVoiceScope,
  friendlyActivity,
  humanize,
  teamPhaseText,
  toolGerund,
  toolPhrase,
  toolTitle,
  type VoiceContext,
} from '../ui/tool-voice.js';

const FRIENDLY: VoiceContext = {
  mode: 'friendly',
  reducedMotion: false,
  nameOf: (label) => (label === 'a2' ? 'Kit' : ''),
};
const CALM: VoiceContext = { ...FRIENDLY, reducedMotion: true };

const KNOWN_TOOLS = [
  'read_file', 'write_file', 'edit_file', 'list_dir', 'glob', 'grep', 'bash', 'bash_output',
  'bash_kill', 'job_list', 'job_wait', 'task', 'ask_user', 'submit_plan', 'todo_write',
  'skill_create', 'skill_install', 'team_send', 'team_wait', 'gov_dispatch', 'gov_run',
  'gov_scan', 'gov_read', 'gov_view', 'gov_submit_work', 'gov_submit_review', 'gov_submit_test',
  'ledger_apply', 'ledger_rule', 'ledger_settle', 'ledger_standings',
];
const PHRASED_TOOLS = [
  'read_file', 'write_file', 'edit_file', 'list_dir', 'glob', 'grep', 'bash', 'team_send', 'team_wait',
];
const SNAKE = /\b[a-z]+_[a-z_]+\b/;

function run(over: Partial<SubagentRun> = {}): SubagentRun {
  return {
    label: 'a1', description: 'scan', phase: 'tool', turns: 1, toolCalls: 0,
    usage: { inputTokens: 0, outputTokens: 0 }, filesTouched: [], messagesSent: 0, ...over,
  };
}

describe('layer 1: titles and gerunds', () => {
  it('every known tool has a friendly title and gerund with no identifier in it', () => {
    for (const tool of KNOWN_TOOLS) {
      const title = toolTitle(tool, 'friendly');
      const gerund = toolGerund(tool, 'friendly');
      expect(title).not.toBe(tool);
      expect(title.length).toBeLessThanOrEqual(16);
      expect(gerund.length).toBeLessThanOrEqual(24);
      expect(title).not.toMatch(SNAKE);
      expect(gerund).not.toMatch(SNAKE);
    }
  });

  it('developer mode returns the raw identifier, always', () => {
    for (const tool of [...KNOWN_TOOLS, 'weird_mcp_tool']) {
      expect(toolTitle(tool, 'developer')).toBe(tool);
      expect(toolGerund(tool, 'developer')).toBe(tool);
    }
  });

  it('an unregistered tool is humanized, not invented', () => {
    expect(toolTitle('skill_find', 'friendly')).toBe('Skill find');
    expect(toolGerund('skill_find', 'friendly')).toBe('Running Skill find');
    expect(humanize('mcp.server:do-thing')).toBe('Mcp server do thing');
  });

  it('humanize treats the name as hostile: no control characters, bounded length', () => {
    const hostile = `evil\u001b[2J\u0000name\n${'x'.repeat(100)}`;
    const out = humanize(hostile);
    // eslint-disable-next-line no-control-regex
    expect(out).not.toMatch(/[\u0000-\u001f\u007f]/);
    expect(out.length).toBeLessThanOrEqual(24);
    expect(humanize('')).toBe('Tool');
  });
});

describe('layer 2: toolPhrase', () => {
  const input = (tool: string, over: Record<string, unknown> = {}) => ({
    tool, args: { path: 'src/api/routes.ts', pattern: 'retry policy', command: 'npm test -w cli' },
    wide: true, variantSeed: 0, budget: 60, ...over,
  });

  it('developer voice is describeToolActivity verbatim for every tool and width', () => {
    const args = { path: 'src/a/b.ts', pattern: '**/*.ts', command: './s/build.sh --prod', to: 'a2', from: 'a3' };
    for (const tool of [...KNOWN_TOOLS, 'skill_find']) {
      for (const wide of [true, false]) {
        expect(toolPhrase({ tool, args, wide, variantSeed: 7, budget: 5 }, DEVELOPER_VOICE))
          .toBe(describeToolActivity(tool, args, wide));
      }
    }
  });

  it('friendly output never contains a raw identifier (outside the argument detail)', () => {
    for (const tool of PHRASED_TOOLS) {
      for (let seed = 0; seed < 6; seed += 1) {
        for (const withArgs of [true, false]) {
          const out = toolPhrase({ ...input(tool), args: withArgs ? { path: 'p.ts' } : undefined, variantSeed: seed }, FRIENDLY);
          expect(out).not.toMatch(SNAKE);
          expect(out.length).toBeGreaterThan(0);
        }
      }
    }
  });

  it('variant 0 is the plain, neutral wording of each row (what records and reducedMotion use)', () => {
    const neutral: Record<string, string> = {
      read_file: 'Reading', write_file: 'Writing', edit_file: 'Editing', list_dir: 'Browsing',
      glob: 'Finding', grep: 'Searching for', bash: 'Running', team_send: 'Messaging',
      team_wait: 'Waiting for',
    };
    for (const tool of PHRASED_TOOLS) {
      expect(toolPhrase(input(tool, { variantSeed: 0 }), FRIENDLY).startsWith(neutral[tool]!)).toBe(true);
      expect(toolPhrase(input(tool, { variantSeed: 1 }), FRIENDLY).startsWith(neutral[tool]!)).toBe(false);
    }
  });

  it('changes with the call count and holds within one call', () => {
    const a = toolPhrase(input('grep', { variantSeed: 3 }), FRIENDLY);
    const b = toolPhrase(input('grep', { variantSeed: 3 }), FRIENDLY);
    const c = toolPhrase(input('grep', { variantSeed: 4 }), FRIENDLY);
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  it('reducedMotion and a tight budget both fall back to variant 0', () => {
    const calm = toolPhrase(input('grep', { variantSeed: 5 }), CALM);
    expect(calm).toBe(toolPhrase(input('grep', { variantSeed: 0 }), CALM));
    expect(toolPhrase(input('grep', { variantSeed: 5, budget: 16 }), FRIENDLY).startsWith('Searching for')).toBe(true);
  });

  it('team_send / team_wait address a teammate by persona name, `lead` as the lead', () => {
    const send = (to: string) => toolPhrase({ ...input('team_send'), args: { to }, variantSeed: 1 }, FRIENDLY);
    expect(send('a2')).toBe('Passing a note to Kit');
    expect(send('lead')).toBe('Passing a note to the lead');
    expect(send('a9')).toBe('Passing a note to a9');
    expect(toolPhrase({ ...input('team_send'), args: {} }, CALM)).toBe('Messaging a teammate');
  });

  it('model-controlled arguments are sanitized before they reach a cell', () => {
    const out = toolPhrase({ ...input('bash'), args: { command: 'rm \u001b[2J -rf /' + 'x'.repeat(200) }, budget: 40 }, CALM);
    // eslint-disable-next-line no-control-regex
    expect(out).not.toMatch(/[\u0000-\u001f\u007f]/);
    expect(out.length).toBeLessThanOrEqual(40);
  });
});

describe('friendly phase text and the terminal phases (D-7)', () => {
  const frame = { budget: 40, wide: true, at: 5_000, ellipsis: '...' };

  it('covers every live phase with a sentence and no identifier', () => {
    const phases: SubagentRun[] = [
      run({ phase: 'queued' }),
      run({ phase: 'starting' }),
      run({ phase: 'starting', retries: 1 }),
      run({ phase: 'thinking', startedAt: 1_000 }),
      run({ phase: 'thinking', activity: 'mapping routes', startedAt: 1_000 }),
      run({ phase: 'tool', lastTool: 'read_file', activityArgs: { path: 'a.ts' } }),
      run({ phase: 'tool', lastTool: undefined }),
      run({ phase: 'waiting', lastTool: 'team_wait', activityArgs: { from: 'a2' } }),
      run({ phase: 'waiting', lastTool: 'read_file' }),
    ];
    for (const r of phases) {
      const text = teamPhaseText(r, frame, FRIENDLY);
      expect(text.length).toBeGreaterThan(0);
      expect(text.replace(/^writing: .*/, '')).not.toMatch(SNAKE);
    }
    expect(teamPhaseText(run({ phase: 'starting', retries: 1 }), frame, FRIENDLY)).toBe('Trying again');
    expect(teamPhaseText(run({ phase: 'waiting', lastTool: 'read_file' }), frame, FRIENDLY)).toBe('Waiting for a reply');
  });

  it('thinking shows a word from the shared list and rotates; reducedMotion holds it', () => {
    const r = run({ phase: 'thinking', startedAt: 1_000, label: 'a1' });
    const early = teamPhaseText(r, { ...frame, at: 1_000 }, FRIENDLY);
    const later = teamPhaseText(r, { ...frame, at: 1_000 + 4_000 * 3 }, FRIENDLY);
    expect(early.endsWith('...')).toBe(true);
    expect(later).not.toBe(early);
    const still = [1_000, 9_000, 50_000].map((at) => teamPhaseText(r, { ...frame, at }, CALM));
    expect(new Set(still).size).toBe(1);
  });

  it('different rows do not open on the same word (label-seeded offset)', () => {
    const words = Array.from({ length: 8 }, (_, i) =>
      teamPhaseText(run({ phase: 'thinking', startedAt: 1_000, label: `a${i}` }), { ...frame, at: 1_000 }, FRIENDLY));
    expect(new Set(words).size).toBeGreaterThan(3);
  });

  it('done / failed / aborted are identical in both voices (activityLine owns them)', () => {
    for (const phase of ['done', 'failed', 'aborted'] as const) {
      const r = run({ phase, turns: 4, lastTool: 'read_file' });
      expect(activityLine(r, 120, 3, FRIENDLY)).toBe(activityLine(r, 120, 3, DEVELOPER_VOICE));
    }
    expect(friendlyActivity({ phase: 'done', calls: 1 }, { seed: 'x', ...frame }, FRIENDLY)).toBe('');
  });

  it('developer voice through activityLine equals the legacy wording', () => {
    const r = run({ phase: 'tool', lastTool: 'grep', activityArgs: { pattern: 'retry' } });
    expect(activityLine(r, 140, 3, DEVELOPER_VOICE)).toBe(activityLine(r, 140, 3));
  });
});

describe('persona name cell in the team row', () => {
  it('carries the persona name and keeps the label as the role', () => {
    const cells = teamRowCells(run({ label: 'a2' }), 100, 5_000, pickGlyphs({ colorLevel: 0, unicode: true }), FRIENDLY);
    expect(cells.name).toBe('Kit');
    expect(cells.label.trim()).toBe('a2');
  });

  it('without a voice the row is the pre-persona row (no name)', () => {
    const cells = teamRowCells(run(), 100, 5_000, pickGlyphs({ colorLevel: 0, unicode: true }));
    expect(cells.name).toBe('');
  });
});

describe('bindVoiceScope', () => {
  it('routes nameOf through nameIn with the bound scope', () => {
    const seen: string[] = [];
    const voice: VoiceContext = {
      ...FRIENDLY,
      nameIn: (scope, label) => { seen.push(`${scope}:${label}`); return `${scope}-${label}`; },
    };
    expect(bindVoiceScope(voice, 'd7').nameOf('a1')).toBe('d7-a1');
    expect(seen).toEqual(['d7:a1']);
    expect(bindVoiceScope(FRIENDLY, 'd7')).toBe(FRIENDLY);
  });
});
