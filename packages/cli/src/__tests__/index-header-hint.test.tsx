/**
 * Header affordances for the Ctrl+I project-index trigger.
 *
 * The header is the ONLY place the Ctrl+I binding is discoverable before it
 * is pressed, so its two states are contract: collapsed names the key and the
 * noun ('^I Index'), the Ctrl+G expanded state spells the action
 * ('^I build index'), and a terminal too narrow to afford both hints drops
 * the index one - never the ^G detail toggle it sits beside.
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

  it('scroll chip and the widest hint still fit together on one row', () => {
    const text = header({ columns: 72, statusExpanded: true, scrolledLines: 10000 });
    expect(text).toContain('^9999+');
    expect(text).toContain('^I build index');
    expect(text).toContain('^G less');
    expect(stringWidth(text)).toBeLessThanOrEqual(72);
  });
});
