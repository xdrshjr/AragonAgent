/**
 * Header affordances after the shortcut drawer landed
 * (tui-shortcut-drawer-and-task-summary §4.2 / AC-1 / AC-2).
 *
 * THIS FILE REPLACES `index-header-hint.test.tsx`. That suite asserted the width
 * ladder: `^I Index` at 120 columns, `^I build index` in the expanded state, `^L
 * branch` left of it, `^L` surviving alone at 50, `^P prompts` taking over from the
 * branch label. Every one of those clauses is GONE by requirement - the header
 * teaches exactly one key now - so the file is rewritten rather than patched, and the
 * keys it used to advertise are asserted WHERE THEY NOW LIVE: the drawer.
 */

import React from 'react';
import { describe, expect, it } from 'vitest';
import { render } from 'ink-testing-library';
import stringWidth from 'string-width';
import { Header } from '../ui/Header.js';
import { getTheme } from '../ui/theme.js';
import { SHORTCUTS } from '../ui/shortcuts.js';

const caps = { unicode: false, colorLevel: 0 } as const;
const theme = getTheme('cool', caps);

function header(props: {
  columns: number;
  panel?: 'none' | 'shortcuts' | 'other';
  scrolledLines?: number;
  taskSummary?: { text: string; tone: 'model' | 'fallback' } | null;
  summaryEnabled?: boolean;
  cwd?: string;
}): string {
  const view = render(
    <Header
      columns={props.columns}
      cwd={props.cwd ?? '/work/demo'}
      provider="provider"
      model="model"
      hasKey
      variant="bar"
      theme={theme}
      caps={caps}
      panel={props.panel ?? 'none'}
      scrolledLines={props.scrolledLines ?? 0}
      taskSummary={props.taskSummary ?? null}
      summaryEnabled={props.summaryEnabled ?? true}
    />,
  );
  const text = view.lastFrame()!;
  view.unmount();
  return text;
}

describe('the header teaches exactly one key', () => {
  it('renders `^G more` and nothing else, at every width', () => {
    for (const columns of [40, 50, 72, 80, 120, 200]) {
      const text = header({ columns });
      expect(text, `cols=${columns}`).toContain('^G more');
      for (const retired of ['^L', '^I', '^K', '^P']) {
        expect(text.includes(retired), `${columns}/${retired}`).toBe(false);
      }
      expect(stringWidth(text)).toBeLessThanOrEqual(columns);
      expect(text.split('\n')).toHaveLength(1);
    }
  });

  it('keeps the scroll chip beside it, with the chip owning its spacing', () => {
    const text = header({ columns: 80, scrolledLines: 10_000 });
    expect(text).toContain('^9999+');
    expect(text).toContain('^G more');
    expect(stringWidth(text)).toBeLessThanOrEqual(80);
  });

  it('names the drawer key while the drawer is open, and Esc for any other overlay', () => {
    expect(header({ columns: 120, panel: 'shortcuts' })).toContain('^G close');
    expect(header({ columns: 120, panel: 'other' })).toContain('Esc close');
  });

  it('still advertises the retired keys where they live now (the table)', () => {
    const keys = SHORTCUTS.map((entry) => entry.keys);
    for (const key of ['Ctrl+I', 'Ctrl+K', 'Ctrl+P', 'Ctrl+L', 'Ctrl+O']) {
      expect(keys, key).toContain(key);
    }
  });
});

describe('the header task summary cell', () => {
  it('sits to the right of the working directory', () => {
    const text = header({
      columns: 120,
      taskSummary: { text: 'fix the failing build', tone: 'model' },
    });
    expect(text).toContain('fix the failing build');
    expect(text.indexOf('demo')).toBeLessThan(text.indexOf('fix the failing build'));
  });

  it('draws nothing while there is none, so the row does not move', () => {
    const without = header({ columns: 120 });
    const withPending = header({ columns: 120, taskSummary: null });
    expect(withPending).toBe(without);
  });

  it('is removed by the config switch without removing the words', () => {
    const text = header({
      columns: 120,
      taskSummary: { text: 'fix the failing build', tone: 'model' },
      summaryEnabled: false,
    });
    expect(text).not.toContain('fix the failing build');
    expect(text).toContain('demo');
  });

  it('never lets a long label push the directory out of the row', () => {
    const text = header({
      columns: 80,
      cwd: '/work/a-very-long-project-name-that-cannot-fit',
      taskSummary: { text: 'a label that is deliberately far too long to fit anywhere', tone: 'model' },
    });
    expect(stringWidth(text)).toBeLessThanOrEqual(80);
    expect(text).toContain('a-very-l');
  });
});

// DEFECT 12. The left half is `wrap="truncate"`, which draws its ellipsis in the LAST
// cell it owns; the right column used to start in the very next cell, so a narrow
// terminal read `aragon...Esc close` as a single string.
describe('Header separator between the two halves', () => {
  it('narrow: keeps two blank cells in front of the hint column', () => {
    const text = header({
      columns: 52,
      panel: 'other',
      cwd: '/work/a-very-long-project-name-that-cannot-fit',
    });
    const hintStart = text.indexOf('Esc close');
    expect(hintStart).toBeGreaterThan(0);
    expect(text.slice(hintStart - 2, hintStart)).toBe('  ');
    expect(stringWidth(text)).toBeLessThanOrEqual(52);
  });

  it('wide: the gap never eats into the hint column', () => {
    const text = header({ columns: 120 });
    expect(text.endsWith('^G more')).toBe(true);
    expect(stringWidth(text)).toBeLessThanOrEqual(120);
  });
});
