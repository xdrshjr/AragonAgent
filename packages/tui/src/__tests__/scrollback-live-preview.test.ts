import { describe, expect, it } from 'vitest';
import stringWidth from 'string-width';
import type { Entry } from '../model/agent/reducer.js';
import { buildLivePreview } from '../ui/scrollback/live-preview.js';

const assistant = (text: string, extra: Partial<Extract<Entry, { kind: 'assistant' }>> = {}): Entry => ({
  id: 'a', kind: 'assistant', text, thinkingOpen: false, streaming: true, ...extra,
});

const base = { cols: 30, rows: 6, thinkingVisible: false };

describe('buildLivePreview', () => {
  it('returns the last rows of a long streaming answer, each within the width', () => {
    const text = Array.from({ length: 40 }, (_, i) => `line number ${i}`).join('\n');
    const rows = buildLivePreview({ ...base, unsettled: [assistant(text)] });
    expect(rows).toHaveLength(6);
    expect(rows.at(-1)).toBe('line number 39');
    for (const row of rows) expect(stringWidth(row)).toBeLessThanOrEqual(30);
  });

  it('wraps a long single line to the content width', () => {
    const rows = buildLivePreview({ ...base, unsettled: [assistant('word '.repeat(40))] });
    expect(rows.length).toBeGreaterThan(1);
    for (const row of rows) expect(stringWidth(row)).toBeLessThanOrEqual(30);
  });

  it('shows a thinking marker before any text arrives', () => {
    expect(buildLivePreview({ ...base, unsettled: [assistant('')] })).toEqual(['thinking...']);
    const thinking = assistant('', { thinking: 'first\nweighing options' });
    expect(buildLivePreview({ ...base, thinkingVisible: true, unsettled: [thinking] }))
      .toEqual(['thinking: weighing options']);
  });

  it('renders a running tool as a header plus its live tail', () => {
    const tool: Entry = {
      id: 't', kind: 'tool', toolCallId: 't', name: 'bash', label: 'bash npm test',
      argsRaw: '{}', status: 'running', live: ['ok 1', 'ok 2'],
    };
    expect(buildLivePreview({ ...base, unsettled: [tool] }))
      .toEqual(['> bash npm test', '  ok 1', '  ok 2']);
  });

  it('takes the tail across several unsettled entries', () => {
    const rows = buildLivePreview({
      ...base, rows: 2,
      unsettled: [
        { id: 'u', kind: 'user', text: 'question' },
        assistant('one\ntwo\nthree'),
      ],
    });
    expect(rows).toEqual(['two', 'three']);
  });

  it('skips non-terminal service cards and returns nothing for zero rows', () => {
    const svc = {
      id: 's', kind: 'service', serviceId: 's1', command: 'x', status: 'running', exitCode: null,
      startedAt: 0, rows: [], rowsSeen: 0, jobKind: 'service', lastOutputAt: 0,
    } as Entry;
    expect(buildLivePreview({ ...base, unsettled: [svc] })).toEqual([]);
    expect(buildLivePreview({ ...base, rows: 0, unsettled: [assistant('x')] })).toEqual([]);
  });

  it('summarises team, todo, compaction and retry cards in a row or two', () => {
    // A SETTLED dispatch card: the live one projects nothing at all (next case).
    const team: Entry = {
      id: 'm', kind: 'team', dispatchId: 'd', requested: 2, aborted: false, active: false,
      durationMs: 1_000,
      runs: [
        { label: 'alpha', phase: 'done' },
        { label: 'beta', phase: 'failed' },
      ] as never,
    };
    const rows = buildLivePreview({ ...base, rows: 10, unsettled: [team] });
    // The headline is the CARD's own sentence, not a `running` fraction: only settled
    // cards reach here, so a fraction could only ever print `0/2 running`.
    expect(rows[0]).toBe('Team: 1 ok, 1 failed');
    expect(rows).toContain('  alpha done');
  });

  it('projects NOTHING for a live team card: the roster is the only live surface (A-2)', () => {
    // This projection is the text fallback for the same slot `LiveTail` fills, so a
    // `Team: 1/2 running` line here would be the reporter's second block again, one
    // level down. The counting itself now comes from `team-status.ts`.
    const live: Entry = {
      id: 'm', kind: 'team', dispatchId: 'd', requested: 2, aborted: false, active: true,
      runs: [
        { label: 'alpha', phase: 'tool' },
        { label: 'beta', phase: 'queued' },
      ] as never,
    };
    expect(buildLivePreview({ ...base, rows: 10, unsettled: [live] })).toEqual([]);
  });
});
