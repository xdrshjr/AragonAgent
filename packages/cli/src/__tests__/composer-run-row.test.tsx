/**
 * The run status row inside `Composer` (tui-scrollbar-edge-and-run-row §3.3.4 /
 * T7, T8): spinner + phrase + `steer / interrupt / exit` on ONE row ABOVE the
 * input box, replacing (never duplicating) the hint row below it.
 */

import { describe, expect, it } from 'vitest';
import React from 'react';
import { Composer, hintTextForTest, runningHintClauses, type RunRowProps } from '../ui/Composer.js';
import { pickGlyphs } from '../ui/glyphs.js';
import { getTheme } from '../ui/theme.js';
import type { TermCapabilities } from '../ui/capabilities.js';
import type { AgentMode } from '../agent/agent-mode.js';
import { renderRowsAtWidth } from './render-at-width.js';

const RICH: TermCapabilities = { colorLevel: 3, unicode: true };
const ASCII: TermCapabilities = { colorLevel: 0, unicode: false };
const STARTED = 1_700_000_000_000;

function runRow(over: Partial<RunRowProps['activity']> = {}, live = false): RunRowProps {
  return {
    activity: { startedAt: STARTED, elapsedMs: 1_000, reducedMotion: true, ...over },
    live,
  };
}

function rowsOf(opts: {
  cols: number;
  caps?: TermCapabilities;
  running?: boolean;
  runRow?: RunRowProps | null;
  mode?: AgentMode;
  services?: number;
}): string[] {
  const caps = opts.caps ?? RICH;
  return renderRowsAtWidth(
    <Composer
      cols={opts.cols}
      isActive
      running={opts.running ?? true}
      runRow={opts.runRow}
      history={[]}
      commands={[]}
      cwd={process.cwd()}
      showHint
      submitCount={0}
      hintsEnabled
      agentMode={opts.mode ?? 'build'}
      services={opts.services ?? 0}
      theme={getTheme('cool', caps)}
      caps={caps}
      onSubmit={() => {}}
    />,
    opts.cols,
  );
}

const glyphs = pickGlyphs(RICH);

describe('Composer run status row (T7)', () => {
  it('puts the row exactly one line above the input box and removes the hint row below', () => {
    const rows = rowsOf({ cols: 100, runRow: runRow() });
    const top = rows.findIndex((row) => row.includes('╭'));
    expect(top).toBeGreaterThan(0);
    const above = rows[top - 1]!;
    expect(above).toContain(' steer');
    expect(above).toContain(`esc${glyphs.times}2 interrupt`);
    expect(above).toContain(`ctrl+c${glyphs.times}2 exit`);
    // The hint row below the box is gone: `interrupt` appears exactly once.
    expect(rows.join('\n').match(/esc×2 interrupt/g)).toHaveLength(1);
    expect(rows.slice(top).join('\n')).not.toContain(`esc${glyphs.times}2 interrupt`);
  });

  it('leads with the animation glyph and phrase, before the clauses', () => {
    const above = rowsOf({ cols: 100, runRow: runRow() }).find((r) => r.includes('interrupt'))!;
    const steerAt = above.indexOf('steer');
    expect(above.slice(0, steerAt)).toMatch(/\S+\s+\S+/); // glyph then a phrase
    expect(above.trimStart()[0]).not.toBe(glyphs.enterKey);
  });

  it('keeps the total row count the same as the idle hint layout', () => {
    const idle = rowsOf({ cols: 100, running: false, runRow: null });
    const running = rowsOf({ cols: 100, runRow: runRow() });
    expect(running).toHaveLength(idle.length);
  });

  it('renders the same clause text as hintText (single source)', () => {
    const joined = runningHintClauses({ glyphs, services: 0 }).join(` ${glyphs.midDot} `);
    expect(hintTextForTest({
      running: true, submitCount: 0, glyphs, mode: 'build', toggleKey: 'shift+tab', services: 0,
    })).toBe(joined);
    const services = runningHintClauses({ glyphs, services: 2 });
    expect(services).toEqual([
      `${glyphs.enterKey} steer`,
      `esc${glyphs.times}2 interrupt`,
      'ctrl+c stop 2',
      `ctrl+c${glyphs.times}2 exit`,
    ]);
    expect(hintTextForTest({
      running: true, submitCount: 0, glyphs, mode: 'build', toggleKey: 'shift+tab', services: 2,
    })).toBe(services.join(` ${glyphs.midDot} `));
  });

  it('at 39 columns (a 40-column terminal) keeps `esc x2 interrupt` whole and truncates only the label', () => {
    const rows = rowsOf({ cols: 39, runRow: runRow({ runningTool: 'mcp__playwright__browser_navigate' }) });
    const above = rows.find((row) => row.includes('interrupt'))!;
    expect(above).toContain(`esc${glyphs.times}2 interrupt`);
    expect(above).not.toMatch(/inter\S*[.…]/);
    expect(above).not.toContain('exit'); // dropped whole, not cut
    expect(above).toContain('…'); // the label is the one that gives way
  });

  it('shows the plan chip right-aligned when there is room, and drops it first', () => {
    const wide = rowsOf({ cols: 100, mode: 'plan', runRow: runRow() }).find((r) => r.includes('interrupt'))!;
    expect(wide.trimEnd().endsWith('PLAN')).toBe(true);
    const narrow = rowsOf({ cols: 61, mode: 'plan', runRow: runRow() }).find((r) => r.includes('interrupt'))!;
    expect(narrow).not.toContain('PLAN');
    expect(narrow).toContain('exit');
  });

  it('uses ASCII glyphs on a legacy console', () => {
    const above = rowsOf({ cols: 100, caps: ASCII, runRow: runRow() }).find((r) => r.includes('interrupt'))!;
    expect(above).not.toMatch(/[^\x20-\x7e]/);
    expect(above).toContain('Enter steer - esc');
  });

  it('draws a still glyph when not live and the animation when live', () => {
    const still = rowsOf({ cols: 100, runRow: runRow({ reducedMotion: false }, false) });
    expect(still.join('\n')).not.toMatch(/[⠀-⣿]/);
    const live = rowsOf({ cols: 100, runRow: runRow({ reducedMotion: false }, true) });
    expect(live.join('\n')).toMatch(/[⠀-⣿]/);
  });
});

describe('Composer without a run row (T8)', () => {
  it('keeps the hint row below the input while running when no runRow is passed', () => {
    const rows = rowsOf({ cols: 100, runRow: undefined });
    const top = rows.findIndex((row) => row.includes('╭'));
    expect(rows[top - 1] ?? '').not.toContain('steer');
    expect(rows.slice(top).join('\n')).toContain('steer');
  });

  it('is unchanged while idle even if a runRow object is supplied', () => {
    const withRow = rowsOf({ cols: 100, running: false, runRow: runRow() });
    const without = rowsOf({ cols: 100, running: false, runRow: null });
    expect(withRow).toEqual(without);
  });
});
