import { describe, expect, it } from 'vitest';
import React from 'react';
import { render } from 'ink-testing-library';
import { SessionOpener } from '../ui/SessionOpener.js';
import { pickOpenerVariant } from '../ui/Logo.js';
import { getTheme } from '../ui/theme.js';
import type { TermCapabilities } from '../ui/capabilities.js';

const RICH: TermCapabilities = { colorLevel: 3, unicode: true };
const ASCII: TermCapabilities = { colorLevel: 3, unicode: false };

// eslint-disable-next-line no-control-regex
const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, '');

function open(
  props: Partial<React.ComponentProps<typeof SessionOpener>> = {},
  caps: TermCapabilities = RICH,
) {
  const theme = getTheme('auto', caps);
  return render(
    <SessionOpener
      variant="banner"
      version="0.4.0"
      cwd="/work"
      hasKey
      viewportRows={20}
      theme={theme}
      caps={caps}
      {...props}
    />,
  );
}

describe('SessionOpener', () => {
  it('always states the no-sandbox warning, at every tier', () => {
    // The one line that must survive every degradation: it is the only warning
    // that bash and file writes run unsandboxed.
    for (const variant of ['art', 'banner', 'none'] as const) {
      for (const viewportRows of [4, 9, 10, 20]) {
        const { lastFrame, unmount } = open({ variant, viewportRows });
        expect(stripAnsi(lastFrame() ?? ''), `${variant}/${viewportRows}`).toContain(
          'Full permission, no sandbox',
        );
        unmount();
      }
    }
  });

  it('stays within its row budget (4 rows plus the wordmark)', () => {
    // The card it replaces was 8 rows, 4 of them a border and two blank lines --
    // over half an empty session's viewport on a short terminal.
    const { lastFrame, unmount } = open({ variant: 'none' });
    expect((lastFrame() ?? '').split('\n').length).toBeLessThanOrEqual(4);
    unmount();

    const art = open({ variant: 'art' });
    // 6 wordmark rows + meta + warning + example.
    expect((art.lastFrame() ?? '').split('\n').length).toBeLessThanOrEqual(10);
    art.unmount();
  });

  it('collapses to the warning alone on a very short viewport', () => {
    const { lastFrame, unmount } = open({ variant: 'art', viewportRows: 6 });
    const lines = (lastFrame() ?? '').split('\n');
    expect(lines.length).toBeLessThanOrEqual(2);
    expect(stripAnsi(lines.join('\n'))).toContain('Full permission');
    expect(stripAnsi(lines.join('\n'))).not.toContain('v0.4.0');
    unmount();
  });

  it('swaps the getting-started prompt in when no key is configured', () => {
    const { lastFrame, unmount } = open({ hasKey: false });
    expect(stripAnsi(lastFrame() ?? '')).toContain('/settings');
    unmount();
  });

  it('emits no non-ASCII on a terminal without Unicode', () => {
    // `banner`/`none` are the only tiers reachable there, and both must be clean.
    for (const variant of ['banner', 'none'] as const) {
      const { lastFrame, unmount } = open({ variant, hasKey: false }, ASCII);
      expect(stripAnsi(lastFrame() ?? ''), variant).not.toMatch(/[^\x00-\x7f]/);
      unmount();
    }
  });
});

describe('pickOpenerVariant + SessionOpener agree', () => {
  it('never selects `art` on a terminal that cannot render it', () => {
    expect(pickOpenerVariant(40, 200, ASCII)).not.toBe('art');
    expect(pickOpenerVariant(40, 200, { colorLevel: 1, unicode: true })).not.toBe('art');
  });

  it('drops to `none` when the terminal is too narrow even for the banner', () => {
    expect(pickOpenerVariant(40, 47, RICH)).toBe('none');
    const { lastFrame, unmount } = open({ variant: 'none' });
    expect(stripAnsi(lastFrame() ?? '')).not.toContain('AragonAgent');
    unmount();
  });
});
