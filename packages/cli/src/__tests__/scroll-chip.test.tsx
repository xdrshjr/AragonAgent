/**
 * The scroll chip inside the composer's input box
 * (tui-selection-and-scroll-follow §4.2 / G7).
 *
 * The hint used to be the LAST ROW OF THE VIEWPORT, which spent a line of the
 * user's content exactly when the transcript was longest — and, worse, fed back
 * into its own derivation: the hint's presence shrank the viewport, which changed
 * `overflowLines`, which is the number the hint displayed (§3.3).
 */

import { describe, expect, it } from 'vitest';
import React from 'react';
import { PromptInput, scrollChip } from '../ui/PromptInput.js';
import { pickGlyphs } from '../ui/glyphs.js';
import { getTheme } from '../ui/theme.js';
import { renderRowsAtWidth } from './render-at-width.js';
import type { TermCapabilities } from '../ui/capabilities.js';

const RICH: TermCapabilities = { colorLevel: 3, unicode: true };
const ASCII: TermCapabilities = { colorLevel: 0, unicode: false };
const UNI = pickGlyphs(RICH);
const ASC = pickGlyphs(ASCII);

describe('scrollChip', () => {
  it('renders nothing while the viewport is pinned to the newest output', () => {
    expect(scrollChip(0, 120, UNI)).toBeNull();
    expect(scrollChip(-3, 120, UNI)).toBeNull();
  });

  it('says the whole sentence when the terminal is wide enough', () => {
    expect(scrollChip(12, 120, UNI)?.text).toBe('↓ 12 lines below · PgDn');
    expect(scrollChip(1, 120, UNI)?.text).toBe('↓ 1 line below · PgDn');
  });

  it('goes terse on a narrow terminal rather than wrapping', () => {
    // Wrapping is what took a SECOND viewport row on the old hint, i.e. it ate
    // the very content it existed to advertise.
    expect(scrollChip(12, 40, UNI)?.text).toBe('↓12');
  });

  it('T-23 / P2-4: the cell width does not change between 9, 99 and 999', () => {
    // ═══ THE CHIP IS THE ONLY THING ON THIS ROW WHOSE WIDTH MOVES WHILE THE
    //     USER IS TYPING ═══
    //
    // `↓ 9` becomes `↓ 10` becomes `↓ 100`, and every change would otherwise
    // re-wrap a draft that fills the line. A FIXED cell makes that transition
    // happen once, when the chip appears, instead of once per digit.
    const widths = [1, 9, 10, 99, 100, 999, 5000].map((n) => scrollChip(n, 120, UNI)!.cells);
    expect(new Set(widths).size).toBe(1);
    const terse = [1, 9, 999, 5000].map((n) => scrollChip(n, 40, UNI)!.cells);
    expect(new Set(terse).size).toBe(1);
  });

  it('clamps the number so the cell can be a constant', () => {
    expect(scrollChip(5000, 120, UNI)?.text).toContain('999+');
    expect(scrollChip(5000, 40, UNI)?.text).toBe('↓999+');
  });

  it('never exceeds the cell it is given, in either branch or either glyph tier', () => {
    // A half-truncated `↓ 12 new li` reads as a rendering bug and cuts off the
    // very number the chip exists to show (I-8).
    for (const glyphs of [UNI, ASC]) {
      for (const cols of [40, 120]) {
        for (const n of [1, 9, 12, 999, 5000]) {
          const chip = scrollChip(n, cols, glyphs)!;
          expect([...chip.text].length, `${n}@${cols}`).toBeLessThanOrEqual(chip.cells);
        }
      }
    }
  });

  it('I-5: every glyph comes from `pickGlyphs`, so a legacy console gets ASCII', () => {
    // Manual matrix row 10: `cmd.exe` must render `v12`, not mojibake.
    expect(scrollChip(12, 40, ASC)?.text).toBe('v12');
    expect(scrollChip(12, 120, ASC)?.text).toBe('v 12 lines below - PgDn');
    for (const cols of [40, 120]) {
      expect(scrollChip(12, cols, ASC)!.text).not.toMatch(/[^\x00-\x7f]/);
    }
  });
});

describe('PromptInput — the chip on the input row', () => {
  const base = {
    isActive: false,
    running: false,
    history: [],
    commands: [],
    cwd: process.cwd(),
    theme: getTheme('cool', RICH),
    caps: RICH,
    onSubmit: () => {},
  };

  it('T-22: renders inside the border at 12, and nothing at 0', () => {
    const shown = renderRowsAtWidth(
      <PromptInput {...base} scrolledLines={12} />,
      120,
    ).join('\n');
    expect(shown).toContain('12 lines below');
    const pinned = renderRowsAtWidth(
      <PromptInput {...base} scrolledLines={0} />,
      120,
    ).join('\n');
    expect(pinned).not.toContain('lines below');
  });

  it('AC-4: it really arrived in the box — same row as the prompt marker', () => {
    const rows = renderRowsAtWidth(
      <PromptInput {...base} scrolledLines={12} />,
      120,
    );
    const chipRow = rows.findIndex((r) => r.includes('lines below'));
    expect(chipRow).toBeGreaterThan(-1);
    // Inside the border means there is a frame row above it and below it.
    expect(rows[chipRow]).toContain('Send a message');
    expect(chipRow).toBeGreaterThan(0);
    expect(chipRow).toBeLessThan(rows.length - 1);
  });

  it('T-23: survives BOTH hint switches, because it is state and not a tutorial', async () => {
    // `showHint` is dropped on a short terminal and `hintsEnabled` is the user's
    // `--no-hints`. Both govern the TEACHING row below the box, which retires
    // keys the user has demonstrably learned. "You are 12 rows behind the newest
    // output" is neither learnable nor optional, so it must survive both.
    const { Composer } = await import('../ui/Composer.js');
    for (const [showHint, hintsEnabled] of [
      [false, true],
      [true, false],
      [false, false],
    ] as const) {
      const rows = renderRowsAtWidth(
        <Composer
          isActive
          running={false}
          history={[]}
          commands={[]}
          cwd={process.cwd()}
          showHint={showHint}
          submitCount={0}
          hintsEnabled={hintsEnabled}
          agentMode="build"
          scrolledLines={12}
          theme={getTheme('cool', RICH)}
          caps={RICH}
          onSubmit={() => {}}
        />,
        120,
      ).join('\n');
      expect(rows, `showHint=${showHint} hints=${hintsEnabled}`).toContain('12 lines below');
    }
  });

  it('pins to the FIRST row of a multi-line draft', () => {
    // Yoga's default `stretch` would size the chip box to the whole editor; it
    // lands on the top row either way today, and relying on that is how a later
    // `justifyContent` edit moves it without failing anything.
    const rows = renderRowsAtWidth(
      <PromptInput {...base} scrolledLines={7} />,
      120,
    );
    const chipRow = rows.findIndex((r) => r.includes('lines below'));
    const markerRow = rows.findIndex((r) => r.includes('Send a message'));
    expect(chipRow).toBe(markerRow);
  });
});
