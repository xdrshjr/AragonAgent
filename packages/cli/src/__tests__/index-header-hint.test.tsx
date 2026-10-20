/**
 * Header affordances for Ctrl+I (project index) and Ctrl+L (new terminal).
 *
 * The header is the ONLY place these bindings are discoverable before they are
 * pressed, so its states are contract: collapsed names the key and the noun
 * ('^L branch', '^I Index'), the Ctrl+G expanded state spells the actions
 * ('^L new branch', '^I build index'), and a terminal too narrow to afford all
 * three drops them in priority order - ^I first, then the branch NOUN (leaving
 * the bare `^L`), and never the ^G detail toggle, which is the only way back to
 * hidden status fields (tui-branch-terminal-shortcut 3.8 / D-11).
 */

import React from 'react';
import { describe, expect, it } from 'vitest';
import { render } from 'ink-testing-library';
import stringWidth from 'string-width';
import { Header } from '../ui/Header.js';
import { getTheme } from '../ui/theme.js';

const caps = { unicode: false, colorLevel: 0 } as const;
const theme = getTheme('cool', caps);

function header(props: {
  columns: number;
  statusExpanded?: boolean;
  scrolledLines?: number;
  overlayOpen?: boolean;
}): string {
  const view = render(
    <Header
      columns={props.columns}
      cwd="/work/demo"
      provider="provider"
      model="model"
      hasKey
      variant="bar"
      theme={theme}
      caps={caps}
      statusExpanded={props.statusExpanded ?? false}
      scrolledLines={props.scrolledLines ?? 0}
      overlayOpen={props.overlayOpen ?? false}
    />,
  );
  const text = view.lastFrame()!;
  view.unmount();
  return text;
}

describe('Header ^I index hint', () => {
  it('collapsed: shows ^I Index left of ^G more on a wide terminal', () => {
    const text = header({ columns: 120 });
    expect(text).toContain('^I Index');
    expect(text).toContain('^G more');
    expect(text.indexOf('^I Index')).toBeLessThan(text.indexOf('^G more'));
    expect(text.split('\n')).toHaveLength(1);
    expect(stringWidth(text)).toBeLessThanOrEqual(120);
  });

  it('expanded (Ctrl+G): spells the action as ^I build index beside ^G less', () => {
    const text = header({ columns: 120, statusExpanded: true });
    expect(text).toContain('^I build index');
    expect(text).toContain('^G less');
    expect(text).not.toContain('^I Index');
    expect(stringWidth(text)).toBeLessThanOrEqual(120);
  });

  it('narrow terminal: drops the ^I hint, keeps the scroll chip and ^G toggle', () => {
    const text = header({ columns: 40, scrolledLines: 10000 });
    expect(text).not.toContain('^I');
    expect(text).toContain('^9999+');
    expect(text).toContain('^G more');
    expect(stringWidth(text)).toBeLessThanOrEqual(40);
  });

  it('overlay open: no key hints, the Details state replaces both', () => {
    const text = header({ columns: 120, overlayOpen: true });
    expect(text).not.toContain('^I');
    expect(text).not.toContain('^G');
    expect(text).toContain('Details off');
  });

  it('collapsed: also shows ^L branch, left of the index hint', () => {
    const text = header({ columns: 120 });
    expect(text).toContain('^L branch');
    expect(text.indexOf('^L branch')).toBeLessThan(text.indexOf('^I Index'));
    expect(stringWidth(text)).toBeLessThanOrEqual(120);
  });

  it('expanded: spells the branch action out as ^L new branch', () => {
    const text = header({ columns: 120, statusExpanded: true });
    expect(text).toContain('^L new branch');
    expect(text).not.toContain('^L branch');
    expect(stringWidth(text)).toBeLessThanOrEqual(120);
  });

  it('overlay open: hides ^L as well, because the overlay owns the keyboard', () => {
    const text = header({ columns: 120, overlayOpen: true });
    expect(text).not.toContain('^L');
    expect(text).toContain('Details off');
  });

  it('40 columns: no ^L, because the chip and ^G are what must survive there', () => {
    const text = header({ columns: 40, scrolledLines: 10000 });
    expect(text).not.toContain('^L');
    expect(text).not.toContain('^I');
    expect(text).toContain('^G more');
    expect(stringWidth(text)).toBeLessThanOrEqual(40);
  });

  it('medium terminal: keeps ^L when ^I no longer fits (the 52-column ladder)', () => {
    // The visible consequence of the budget-driven planner (D-11): at 50 columns
    // the user still sees `^L branch`, and the ^I hint is the one that went.
    const text = header({ columns: 50 });
    expect(text).toContain('^L branch');
    expect(text).not.toContain('^I');
    expect(stringWidth(text)).toBeLessThanOrEqual(50);
  });
  it('scroll chip and the widest hint still fit together on one row', () => {
    const text = header({ columns: 72, statusExpanded: true, scrolledLines: 10000 });
    expect(text).toContain('^9999+');
    expect(text).toContain('^I build index');
    expect(text).toContain('^G less');
    expect(stringWidth(text)).toBeLessThanOrEqual(72);
  });
});

// DEFECT 12. The left half is `wrap="truncate"`, which draws its ellipsis in the
// LAST cell it owns; the right column used to start in the very next cell, so a
// narrow terminal read `aragon...Details off` as a single string. The row now
// spends `HEADER_HINT_LIMITS.separatorCells` blank cells between the two halves.
describe('Header separator between the two halves', () => {
  it('narrow: keeps two blank cells in front of the hint column', () => {
    const view = render(
      <Header
        columns={52}
        cwd="/work/a-very-long-project-name-that-cannot-fit"
        provider="anthropic"
        model="glm-5.1"
        hasKey
        variant="bar"
        theme={theme}
        caps={caps}
        overlayOpen
      />,
    );
    const text = view.lastFrame()!;
    view.unmount();
    const hintStart = text.indexOf('Details off');
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
