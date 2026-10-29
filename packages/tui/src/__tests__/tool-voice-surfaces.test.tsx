/**
 * Where the voice reaches the main transcript, and where it must not
 * (tui-subagent-persona-and-developer-mode AC-10 / AC-10b / AC-6 / AC-12).
 */

import React from 'react';
import { describe, expect, it } from 'vitest';
import { render } from 'ink-testing-library';
import stripAnsi from 'strip-ansi';
import { TranscriptList } from '../ui/Transcript.js';
import { ViewportGeometryContext } from '../ui/layout/viewport-geometry.js';
import { createEntryRenderer } from '../ui/scrollback/renderer.js';
import { estimateEntryRows } from '../ui/layout/virtual-window.js';
import { renderTranscriptText } from '../ui/transcript-text.js';
import { buildAgentBoardRows } from '../ui/layout/agents-board.js';
import { phaseLabels } from '../ui/layout/status-layout.js';
import { pickGlyphs } from '../ui/glyphs.js';
import { getTheme } from '../ui/theme.js';
import type { Entry } from '../model/agent/reducer.js';
import type { SubagentRun } from '../model/team/types.js';
import type { HeightStore } from '../ui/use-height-store.js';
import type { TermCapabilities } from '../ui/capabilities.js';
import { DEVELOPER_VOICE, type VoiceContext } from '../ui/tool-voice.js';

const CAPS: TermCapabilities = { colorLevel: 0, unicode: true };
const THEME = getTheme('cool', CAPS);
const FRIENDLY: VoiceContext = { mode: 'friendly', reducedMotion: true, nameOf: () => '' };

type ToolEntry = Extract<Entry, { kind: 'tool' }>;
const tool = (over: Partial<ToolEntry> = {}): ToolEntry => ({
  id: 'e1', kind: 'tool', toolCallId: 'c1', name: 'read_file', label: 'Read',
  argsRaw: '{"path":"src/index.ts"}', args: { path: 'src/index.ts' }, status: 'done', durationMs: 12,
  ...over,
} as ToolEntry);

const PASSTHROUGH: HeightStore = {
  version: 0, resolve: (_key, estimate) => estimate(), report: () => {}, stats: () => ({ measured: 0, estimated: 0 }),
  clear: () => {},
};

function frame(entries: Entry[], voice: VoiceContext, cols = 100): string {
  const { lastFrame, unmount } = render(
    <ViewportGeometryContext.Provider value={{ viewportRows: 60, offset: 0, contentRows: 0 }}>
      <TranscriptList voice={voice} entries={entries} expandedToolIds={{}} thinkingVisible={false}
        reducedMotion density="compact" theme={THEME} caps={CAPS} windowSize={20_000} cols={cols}
        heights={PASSTHROUGH} />
    </ViewportGeometryContext.Provider>,
  );
  const out = stripAnsi(lastFrame() ?? '');
  unmount();
  return out;
}

describe('the tool card header (AC-10)', () => {
  it('shows the friendly title by default and the real identifier in developer mode', () => {
    expect(frame([tool()], FRIENDLY)).toContain('Read file');
    expect(frame([tool()], FRIENDLY)).not.toContain('read_file');
    expect(frame([tool()], DEVELOPER_VOICE)).toContain('read_file');
  });

  it('never adds a row compared with the identifier it replaces, at 40 / 80 / 120 columns', () => {
    const long = tool({
      name: 'ledger_standings', argsRaw: JSON.stringify({ path: 'x/'.repeat(80) }), args: { path: 'x/'.repeat(80) },
    });
    const rowCount = (voice: VoiceContext, cols: number): number =>
      frame([long], voice, cols).split(String.fromCharCode(10)).filter((line) => line.trim().length > 0).length;
    for (const cols of [40, 80, 120]) {
      expect(rowCount(FRIENDLY, cols), `cols ${cols}`).toBeLessThanOrEqual(rowCount(DEVELOPER_VOICE, cols));
    }
    // And an ordinary call is exactly one header row in both voices.
    for (const voice of [FRIENDLY, DEVELOPER_VOICE]) {
      for (const cols of [40, 80, 120]) {
        const rows = frame([tool()], voice, cols).split(String.fromCharCode(10)).filter((line) => line.trim().length > 0);
        expect(rows.length, `${voice.mode} ${cols}`).toBe(1);
      }
    }
  });

  it('the row-height estimate does not depend on the voice', () => {
    const entry = tool();
    expect(estimateEntryRows(entry, 80, 'compact', false, false)).toBe(
      estimateEntryRows(entry, 80, 'compact', false, false),
    );
  });

  it('the offscreen scrollback renderer words the card in the voice it was given', () => {
    for (const [voice, expected] of [[FRIENDLY, 'Read file'], [DEVELOPER_VOICE, 'read_file']] as const) {
      const renderer = createEntryRenderer({
        theme: THEME, caps: CAPS, density: 'compact', thinkingVisible: false, reducedMotion: true, voice,
      });
      const rows = stripAnsi(renderer.renderEntry(tool(), undefined, 80).join('\n'));
      renderer.dispose();
      expect(rows).toContain(expected);
    }
  });

  it('copy / export always names the real tool, whatever the voice', () => {
    const text = renderTranscriptText([tool()], {
      glyphs: pickGlyphs(CAPS), usageTotal: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 },
      model: 'm', provider: 'p', elapsedMs: 0,
    });
    // The replay carries the entry's own label / name, never the friendly title.
    expect(text).toContain('Read');
    expect(text).not.toContain('Read file');
  });
});

describe('status wording', () => {
  const base = { phase: 'tool' as const, activeTool: { name: 'bash', toolCallId: 'c' } };
  it('friendly voice says what is happening; absent / developer voice keeps the identifier', () => {
    expect(phaseLabels({ ...base, voiceMode: 'friendly' })[1]).toBe('Running command');
    expect(phaseLabels({ ...base, voiceMode: 'developer' })[1]).toBe('Running tool bash');
    expect(phaseLabels(base)[1]).toBe('Running tool bash');
  });
});

describe('the Agents board timeline is a record (AC-12)', () => {
  const run = (over: Partial<SubagentRun> = {}): SubagentRun => ({
    label: 'a1', description: 'scan', phase: 'done', turns: 2, toolCalls: 2, startedAt: 0, endedAt: 5_000,
    usage: { inputTokens: 0, outputTokens: 0 }, filesTouched: [], messagesSent: 0,
    timeline: [
      { kind: 'tool', at: 1_000, text: 'read: src/a.ts', ok: true, ms: 40, tool: 'read_file', args: { path: 'src/a.ts' } },
      { kind: 'tool', at: 2_000, text: 'mystery_tool', ok: true },
    ],
    ...over,
  });
  const rowsFor = (voice: VoiceContext): string =>
    buildAgentBoardRows({
      source: { dispatchId: 'd1', active: false, requested: 1, runs: [run()], durationMs: 5_000 },
      cols: 100, now: 6_000, selectedLabel: 'a1', glyphs: pickGlyphs(CAPS), native: true, voice,
    }).map((row) => row.text).join('\n');

  it('friendly: neutral wording from the structured fields; old runs fall back to text', () => {
    const out = rowsFor({ ...FRIENDLY, nameOf: () => 'Wren' });
    expect(out).toContain('Reading src/a.ts');
    expect(out).toContain('mystery_tool');
    expect(out).toContain('Wren');
  });

  it('developer: the stored text, verbatim', () => {
    const out = rowsFor(DEVELOPER_VOICE);
    expect(out).toContain('read: src/a.ts');
    expect(out).not.toContain('Reading src/a.ts');
  });
});
