import React from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { Text } from 'ink';
import stripAnsi from 'strip-ansi';
import stringWidth from 'string-width';
import type { Entry } from '../agent/reducer.js';
import { getTheme } from '../ui/theme.js';
import type { TermCapabilities } from '../ui/capabilities.js';
import { createEntryRenderer, type EntryRenderer } from '../ui/scrollback/renderer.js';

const CAPS: TermCapabilities = { colorLevel: 0, unicode: false };
const THEME = getTheme('cool', CAPS);

let renderer: EntryRenderer | undefined;
function make(): EntryRenderer {
  renderer = createEntryRenderer({
    theme: THEME, caps: CAPS, density: 'comfortable', thinkingVisible: false, reducedMotion: true,
  });
  return renderer;
}
afterEach(() => renderer?.dispose());

const assistant = (text: string): Entry => ({
  id: 'a1', kind: 'assistant', text, thinkingOpen: false, streaming: false,
});

describe('scrollback entry renderer', () => {
  it('renders a settled assistant entry at the requested width', () => {
    const rows = make().renderEntry(assistant('hello world '.repeat(20)), undefined, 40);
    expect(rows.length).toBeGreaterThan(2);
    for (const row of rows) expect(stringWidth(stripAnsi(row))).toBeLessThanOrEqual(40);
    expect(stripAnsi(rows.join('\n'))).toContain('hello world');
  });

  it('rebuilds when the width changes', () => {
    const r = make();
    const text = 'word '.repeat(40);
    const wide = r.renderEntry(assistant(text), undefined, 80);
    const narrow = r.renderEntry(assistant(text), undefined, 30);
    expect(narrow.length).toBeGreaterThan(wide.length);
    for (const row of narrow) expect(stringWidth(stripAnsi(row))).toBeLessThanOrEqual(30);
  });

  it('prints a separator row before a user message that follows another entry', () => {
    const user: Entry = { id: 'u1', kind: 'user', text: 'question' };
    const r = make();
    const first = r.renderEntry(user, undefined, 40);
    const second = r.renderEntry(user, assistant('answer'), 40);
    // The separator is one extra row (the rail glyph in ASCII mode).
    expect(second.length).toBe(first.length + 1);
  });

  it('renders an empty settled assistant as no rows', () => {
    expect(make().renderEntry(assistant(''), undefined, 40)).toEqual([]);
  });

  it('caps a very tall entry with an ASCII notice row', () => {
    const r = make();
    const text = Array.from({ length: 600 }, (_, i) => `line ${i}`).join('\n');
    const rows = r.renderEntry(assistant(text), undefined, 40);
    expect(rows.length).toBe(400);
    expect(rows[399]).toMatch(/^\[\+\d+ rows not printed - scrollback entry cap\]$/);
    expect(r.stats().elidedRows).toBeGreaterThan(0);
  });

  it('degrades to one row when an entry cannot be rendered', () => {
    const r = make();
    const bad = {
      id: 'x', kind: 'assistant', thinkingOpen: false, streaming: false,
      get text(): string { throw new Error('boom'); },
    } as unknown as Entry;
    const rows = r.renderEntry(bad, undefined, 40);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toContain('could not be rendered');
    expect(r.stats().failures).toBe(1);
    // ... and the renderer keeps working afterwards (I-S12).
    expect(r.renderEntry(assistant('still fine'), undefined, 40).length).toBeGreaterThan(0);
  });

  it('renders arbitrary nodes', () => {
    const rows = make().renderNode(<Text>banner</Text>, 30);
    expect(stripAnsi(rows.join('\n'))).toBe('banner');
  });

  it('uses updated options for later renders', () => {
    const r = make();
    const entry: Entry = {
      id: 'a2', kind: 'assistant', text: 'body', thinking: 'secret reasoning',
      thinkingOpen: true, streaming: false,
    };
    const hidden = stripAnsi(r.renderEntry(entry, undefined, 60).join('\n'));
    expect(hidden).not.toContain('secret reasoning');
    r.setOptions({ thinkingVisible: true });
    const shown = stripAnsi(r.renderEntry(entry, undefined, 60).join('\n'));
    expect(shown).toContain('secret reasoning');
  });
});
