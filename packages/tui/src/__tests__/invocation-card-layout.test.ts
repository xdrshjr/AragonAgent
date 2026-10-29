/**
 * `ui/layout/invocation-card.ts` + the height/revision/replay seams that must agree with
 * it (tui-invocation-cards I-4, sections 2.4 / 3.7).
 */

import { describe, expect, it } from 'vitest';
import { buildInvocationCard, INVOCATION_LIMITS } from '../model/agent/invocation-card.js';
import {
  invocationCardLines,
  invocationCardRows,
  invocationHeaderSegments,
  invocationHiddenText,
  invocationInputText,
} from '../ui/layout/invocation-card.js';
import { cellWidth } from '../ui/layout/cells.js';
import { pickGlyphs } from '../ui/glyphs.js';
import { entryRevision, estimateEntryRows } from '../ui/layout/virtual-window.js';
import { GUTTER_WIDTH } from '../ui/layout/Gutter.js';
import { renderTranscriptText } from '../ui/transcript-text.js';
import type { Entry } from '../model/agent/reducer.js';

const UNI = pickGlyphs({ colorLevel: 3, unicode: true });
const ASCII = pickGlyphs({ colorLevel: 3, unicode: false });
const textOf = (segments: Array<{ text: string }>): string => segments.map((s) => s.text).join('');

const skill = (over: Partial<Parameters<typeof buildInvocationCard>[0]> = {}) =>
  buildInvocationCard({
    variant: 'skill', name: 'pdf-forms', commandLine: '/skill:pdf-forms a.pdf',
    input: 'a.pdf', facts: ['v1.2.0', 'user', '31 KB', '4 files'], ...over,
  });

describe('invocationHeaderSegments', () => {
  it('lays out label, name and facts, and uses the glyph set for the separators', () => {
    expect(textOf(invocationHeaderSegments(skill(), UNI, 100)))
      .toBe('skill · pdf-forms  v1.2.0 · user · 31 KB · 4 files');
    expect(textOf(invocationHeaderSegments(skill(), ASCII, 100)))
      .toBe('skill - pdf-forms  v1.2.0 - user - 31 KB - 4 files');
  });

  it('team has no name and leaves no dangling separator', () => {
    const team = buildInvocationCard({
      variant: 'team', commandLine: '/team x', facts: ['4 subagents', 'read-only'],
    });
    expect(textOf(invocationHeaderSegments(team, UNI, 100))).toBe('team  4 subagents · read-only');
    const bare = buildInvocationCard({ variant: 'team', commandLine: '/team x' });
    expect(textOf(invocationHeaderSegments(bare, UNI, 100))).toBe('team');
  });

  it('never exceeds the usable width: facts go first, then the name is shortened', () => {
    for (const width of [80, 50, 30, 20, 14, 9, 4, 1]) {
      for (const glyphs of [UNI, ASCII]) {
        const text = textOf(invocationHeaderSegments(skill(), glyphs, width));
        expect(cellWidth(text)).toBeLessThanOrEqual(width);
      }
    }
    // Facts are dropped whole from the right rather than cut mid-word.
    expect(textOf(invocationHeaderSegments(skill(), UNI, 39))).toBe('skill · pdf-forms  v1.2.0 · user');
    const long = skill({ name: 'a-very-long-skill-name-indeed' });
    expect(textOf(invocationHeaderSegments(long, ASCII, 20))).toMatch(/\.\.\.$/);
  });

  it('is one logical row of text (no newline can reach the header)', () => {
    expect(textOf(invocationHeaderSegments(skill({ name: 'a\nb' }), UNI, 80))).not.toContain('\n');
  });
});

describe('invocationCardRows', () => {
  const wrap = (text: string, usable: number): number =>
    text.split('\n').reduce((sum, line) => sum + Math.max(1, Math.ceil(line.length / usable)), 0);

  it('counts header + wrapped input + hidden tail + note', () => {
    expect(invocationCardRows(skill({ input: '' }), 80, wrap)).toBe(1);
    expect(invocationCardRows(skill({ input: 'one line' }), 80, wrap)).toBe(2);
    expect(invocationCardRows(skill({ input: 'a\nb\nc' }), 80, wrap)).toBe(4);
    const cut = skill({ input: 'z'.repeat(2000) });
    expect(cut.inputHidden).toBeGreaterThan(0);
    expect(invocationCardRows(cut, 80, wrap)).toBe(1 + wrap('z'.repeat(480), 80) + 1);
    expect(invocationCardRows(skill({ input: '', note: 'Asked for 12.' }), 80, wrap)).toBe(2);
  });

  it('is bounded whatever the input', () => {
    const huge = skill({ input: Array.from({ length: 500 }, () => 'w'.repeat(200)).join('\n') });
    const rows = invocationCardRows(huge, 40, wrap);
    expect(rows).toBeLessThanOrEqual(1 + INVOCATION_LIMITS.inputMaxLines + 12 + 2);
  });

  it('expands tabs for painting and measuring alike', () => {
    expect(invocationInputText(skill({ input: 'a\tb' }))).not.toContain('\t');
  });

  it('the hidden tail pluralises and uses the glyph ellipsis', () => {
    expect(invocationHiddenText({ ...skill(), inputHidden: 1 }, ASCII)).toBe('... +1 char not shown');
    expect(invocationHiddenText({ ...skill(), inputHidden: 9 }, UNI)).toBe('… +9 chars not shown');
  });
});

describe('virtual-window agrees with the painter (I-4)', () => {
  it('estimates a card entry by invocationCardRows, not by its command line', () => {
    const card = skill({ input: 'x'.repeat(2000), commandLine: `/skill:pdf-forms ${'x'.repeat(2000)}` });
    const entry: Entry = { id: 'e1', kind: 'user', text: card.commandLine, invocation: card };
    const cols = 80;
    const usable = cols - GUTTER_WIDTH;
    const wrap = (text: string): number => Math.ceil(text.length / usable);
    const expected = invocationCardRows(card, usable, (text) => wrap(text));
    expect(estimateEntryRows(entry, cols, 'compact', false)).toBe(expected);
    const plain: Entry = { id: 'e2', kind: 'user', text: card.commandLine };
    expect(estimateEntryRows(plain, cols, 'compact', false)).not.toBe(expected);
    // Comfortable density charges the separator row exactly as for any other entry.
    expect(estimateEntryRows(entry, cols, 'comfortable', false)).toBe(expected + 1);
  });

  it('entryRevision tells a card from a plain user entry (queued -> user re-measures)', () => {
    const card = skill();
    const withCard: Entry = { id: 'e1', kind: 'user', text: 't', invocation: card };
    const plain: Entry = { id: 'e1', kind: 'user', text: 't' };
    const queued: Entry = { id: 'e1', kind: 'queued', text: 't', queueId: 'q', invocation: card };
    expect(entryRevision(plain)).toBe('u');
    expect(entryRevision(withCard)).not.toBe('u');
    expect(entryRevision(queued)).not.toBe(entryRevision(withCard));
    expect(entryRevision(withCard)).not.toBe(entryRevision({ ...withCard, invocation: skill({ note: 'n' }) }));
  });
});

describe('the exit replay / export (section 2.4)', () => {
  const opts = {
    glyphs: UNI,
    usageTotal: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 },
    model: 'm', provider: 'p', elapsedMs: 1000,
  };

  it('prints the command line and one bracketed fact line', () => {
    expect(invocationCardLines(skill())).toEqual(['    [skill pdf-forms v1.2.0 - user - 31 KB - 4 files]']);
    const note = skill({ note: 'Asked for 12; team.maxSubagents is 8.' });
    expect(invocationCardLines(note).at(-1)).toBe('    Asked for 12; team.maxSubagents is 8.');
  });

  it('puts the card under the user line, and leaves plain user entries untouched', () => {
    const card = skill();
    const text = renderTranscriptText([{ id: 'e1', kind: 'user', text: card.commandLine, invocation: card }], opts);
    expect(text).toContain('/skill:pdf-forms a.pdf\n    [skill pdf-forms v1.2.0 - user - 31 KB - 4 files]');
    const plain = renderTranscriptText([{ id: 'e1', kind: 'user', text: 'hello' }], opts);
    expect(plain).not.toContain('[');
  });
});
