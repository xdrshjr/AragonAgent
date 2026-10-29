import { describe, expect, it } from 'vitest';
import { initialViewState, viewReducer } from '@aragon-agent/tui/model/agent/reducer';
import { contextPercent, formatCostBadge, formatSeconds, summarizeToolArgs, toolFamily } from '../chat-format.js';

const EN_DASH = String.fromCharCode(0x2013);

describe('chat formatting', () => {
  it('shows an en dash, never zero, when the cost is unknown', () => {
    expect(formatCostBadge(0)).toBe(EN_DASH);
    expect(formatCostBadge(Number.NaN)).toBe(EN_DASH);
    expect(formatCostBadge(0.5)).toBe('$0.50');
    expect(formatCostBadge(0.0042)).toBe('$0.0042');
  });

  it('reports the context percentage only when the window is known', () => {
    expect(contextPercent({ pct: 41.2, windowKnown: true })).toBe(41);
    expect(contextPercent({ pct: 41, windowKnown: false })).toBeNull();
    expect(contextPercent({ pct: 140, windowKnown: true })).toBe(100);
  });

  it('formats durations compactly', () => {
    expect(formatSeconds(4200)).toBe('4.2 s');
    expect(formatSeconds(12_400)).toBe('12 s');
    expect(formatSeconds(125_000)).toBe('2 m 05 s');
    expect(formatSeconds(-1)).toBe('');
  });

  it('classifies tool names', () => {
    expect(toolFamily('bash')).toBe('bash');
    expect(toolFamily('edit_file')).toBe('edit');
    expect(toolFamily('grep')).toBe('search');
    expect(toolFamily('something_new')).toBe('generic');
  });

  it('summarises tool arguments from the real entry shape', () => {
    let state = initialViewState();
    state = viewReducer(state, { type: 'toolCallStart', toolCallId: 't1', toolName: 'bash' });
    state = viewReducer(state, { type: 'toolCallEnd', toolCallId: 't1', args: { command: 'npm test\nsecond line' } });
    const entry = state.entries[0]!;
    expect(entry.kind).toBe('tool');
    if (entry.kind === 'tool') expect(summarizeToolArgs(entry)).toBe('npm test');
  });
});
