/**
 * `DiffView` (agent-activity-presentation §3.4 / AC-11..AC-15, AC-19).
 *
 * The column assertion is the load-bearing one: `estimateEntryRows` charges a
 * diff card one row per patch line, so anything that made a row wrap — or the
 * gutter widen mid-card — would be an UNDER-estimate, the direction
 * `virtual-window.ts` names as unsafe.
 */

import { describe, expect, it } from 'vitest';
import React from 'react';
import { render } from 'ink-testing-library';
import stripAnsi from 'strip-ansi';
import { DiffView, DIFF_COLLAPSED_LINES, diffRows } from '../ui/entries/DiffView.js';
import { renderRowsAtWidth } from './render-at-width.js';
import { buildPatch, type FilePatch } from '../tools/patch.js';
import { estimateEntryRows } from '../ui/layout/virtual-window.js';
import { getTheme } from '../ui/theme.js';
import type { Entry } from '../agent/reducer.js';
import type { TermCapabilities } from '../ui/capabilities.js';

const RICH: TermCapabilities = { colorLevel: 3, unicode: true };
const ASCII: TermCapabilities = { colorLevel: 0, unicode: false };

function lines(n: number, prefix = 'line'): string[] {
  return Array.from({ length: n }, (_, i) => `${prefix} ${i + 1}`);
}

function frameOf(patch: FilePatch, expanded = false, caps = RICH): string[] {
  const { lastFrame, unmount } = render(
    <DiffView patch={patch} expanded={expanded} theme={getTheme('cool', caps)} />,
  );
  const out = stripAnsi(lastFrame() ?? '').split('\n');
  unmount();
  return out;
}

/** A 6-add / 5-remove patch: the design's own worked example. */
function samplePatch(): FilePatch {
  const old = lines(40);
  const next = [...old];
  next.splice(19, 5, 'A', 'B', 'C', 'D', 'E', 'F');
  return buildPatch(old.join('\n'), next.join('\n'), { path: 'a.ts' });
}

describe('DiffView — the summary row', () => {
  it('reads `+6 -5`', () => {
    const patch = samplePatch();
    expect(patch.added).toBe(6);
    expect(patch.removed).toBe(5);
    expect(frameOf(patch)[0]).toContain('+6 -5');
  });

  it('does not repeat the path — `ToolCard`\'s header already renders it', () => {
    expect(frameOf(samplePatch()).join('\n')).not.toContain('a.ts');
  });

  it('says `(truncated)` when a clipped patch still reports the whole change', () => {
    const patch = buildPatch(null, lines(300).join('\n'), { path: 'big.ts' });
    const summary = frameOf(patch, true)[0]!;
    expect(summary).toContain('+300 -0');
    expect(summary).toContain('(truncated)');
  });

  it('names the reason when the old side could not be read (AC-18)', () => {
    const patch = buildPatch(null, 'x\n', { path: 'big.bin', degraded: 'too-large' });
    expect(frameOf(patch)[0]).toContain('old side not read: too-large');
  });
});

describe('DiffView — layout', () => {
  it('starts every row at the same column after the gutter', () => {
    // The gutter is `padStart`ed to ONE width for the whole card, so every sign
    // column — and therefore every line of text — lands on the same offset. A
    // per-row width would look plausible and read as ragged.
    const body = frameOf(samplePatch(), true).slice(1, -1);
    const first = /^(\s*\d*) ([+\- ]) /.exec(body[0]!);
    expect(first, body[0]).not.toBeNull();
    const shape = new RegExp(`^.{${first![1]!.length}} [+\\- ] `);
    for (const row of body) expect(shape.test(row), row).toBe(true);
  });

  it('renders one terminal row per patch line, at 120 and at 40 columns', () => {
    // `wrap="truncate"` is a correctness requirement, not a taste one.
    const patch = samplePatch();
    const expected = 1 + Math.min(diffRows(patch).length, DIFF_COLLAPSED_LINES) + 1;
    // A REAL width sweep: `ink-testing-library`'s stdout stub hard-codes 100
    // columns, so `render(tree, { columns })` is silently ignored and asserts
    // nothing at all.
    for (const columns of [120, 40]) {
      const rows = renderRowsAtWidth(
        <DiffView patch={patch} theme={getTheme('cool', RICH)} />,
        columns,
      );
      expect(rows, `cols=${columns}`).toHaveLength(expected);
      for (const row of rows) expect(row.length, `cols=${columns}`).toBeLessThanOrEqual(columns);
    }
  });

  it('separates hunks with a `@@` row and puts none before the first', () => {
    const old = lines(400);
    const next = [...old];
    next[9] = 'A';
    next[299] = 'B';
    const patch = buildPatch(old.join('\n'), next.join('\n'), { path: 'a.ts' });
    expect(patch.hunks).toHaveLength(2);

    const rows = diffRows(patch);
    expect(rows.filter((r) => r.kind === 'meta')).toHaveLength(1);
    expect(rows[0]!.kind).not.toBe('meta');
  });

  it('is pure ASCII in both glyph tiers', () => {
    // `caps` is not even a prop: `+`, `-` and `@@` are the diff's own vocabulary
    // and are spelled literally, so there is no tier to get wrong.
    for (const caps of [RICH, ASCII]) {
      for (const row of frameOf(samplePatch(), true, caps)) {
        expect(row, row).not.toMatch(/[^\x20-\x7e]/);
      }
    }
  });
});

describe('DiffView — collapse (AC-11 / AC-15)', () => {
  it('collapses a 25-row patch to 12 with a `+N lines (Ctrl+O)` footer', () => {
    const old = lines(60);
    const next = [...old];
    for (let i = 20; i < 32; i += 1) next[i] = `changed ${i}`;
    const patch = buildPatch(old.join('\n'), next.join('\n'), { path: 'a.ts' });
    const total = diffRows(patch).length;
    expect(total).toBeGreaterThan(DIFF_COLLAPSED_LINES);

    const collapsed = frameOf(patch);
    expect(collapsed).toHaveLength(1 + DIFF_COLLAPSED_LINES + 1);
    expect(collapsed[collapsed.length - 1]).toBe(
      `+${total - DIFF_COLLAPSED_LINES} lines (Ctrl+O)`,
    );

    const expanded = frameOf(patch, true);
    expect(expanded).toHaveLength(1 + total + 1);
    expect(expanded[expanded.length - 1]).toBe('(Ctrl+O to collapse)');
  });

  it('draws exactly one footer row, ever — the height estimate charges one', () => {
    for (const expanded of [false, true]) {
      const frame = frameOf(samplePatch(), expanded);
      expect(frame.filter((row) => row.includes('Ctrl+O')).length).toBeLessThanOrEqual(1);
    }
  });
});

describe('estimateEntryRows never under-estimates a diff card (AC-19)', () => {
  it('matches or exceeds the rendered height, collapsed and expanded', () => {
    const patch = samplePatch();
    const entry: Entry = {
      id: 'e1',
      kind: 'tool',
      toolCallId: 't1',
      name: 'edit_file',
      label: 'Edit File',
      argsRaw: '{}',
      status: 'done',
      preview: 'Applied edit to a.ts:',
      patch,
    };
    for (const expanded of [false, true]) {
      // `+ 1` for the card header row, which `DiffView` does not draw itself.
      const drawn = frameOf(patch, expanded).length + 1;
      const estimate = estimateEntryRows(entry, 120, 'compact', expanded);
      expect(estimate, `expanded=${expanded}`).toBeGreaterThanOrEqual(drawn);
    }
  });
});
