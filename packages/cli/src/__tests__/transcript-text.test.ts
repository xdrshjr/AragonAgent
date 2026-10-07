import { describe, expect, it } from 'vitest';
import { renderTranscriptText } from '../ui/transcript-text.js';
import { pickGlyphs } from '../ui/glyphs.js';
import type { Entry } from '../agent/reducer.js';

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;]*[A-Za-z]/;

const UNI = pickGlyphs({ colorLevel: 3, unicode: true });
const ASCII = pickGlyphs({ colorLevel: 3, unicode: false });

const OPTS = {
  glyphs: UNI,
  usageTotal: { inputTokens: 12_300, outputTokens: 4100, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.08 },
  model: 'claude-sonnet-4-6',
  provider: 'anthropic',
  elapsedMs: 134_000,
};

const user = (id: string, text = 'explain this repo'): Entry => ({ id, kind: 'user', text });
const asst = (id: string, text = 'It is an agent engine.'): Entry => ({
  id,
  kind: 'assistant',
  text,
  thinkingOpen: false,
  streaming: false,
});
const tool = (id: string): Entry => ({
  id,
  kind: 'tool',
  toolCallId: id,
  name: 'read_file',
  label: 'read_file',
  argsRaw: '{"path":"README.md"}',
  args: { path: 'README.md' },
  status: 'done',
  durationMs: 12,
});

describe('renderTranscriptText', () => {
  it('retains every pending body when more than 200 messages await receipts', () => {
    const entries: Entry[] = Array.from({ length: 260 }, (_, i) =>
      ({ id: `q${i}`, queueId: `q${i}`, kind: 'queued', text: `unsent-${i}\nbody-${i}` }));
    entries.splice(100, 0, ...Array.from({ length: 250 }, (_, i) => user(`u${i}`)));
    const out = renderTranscriptText(entries, OPTS);
    for (let i = 0; i < 260; i += 1) {
      expect(out).toContain(`Queued but never sent: unsent-${i}\n`);
      expect(out).toContain(`body-${i}`);
    }
    expect(out).toContain('50 entries omitted');
    expect(out.indexOf('unsent-0\n')).toBeLessThan(out.indexOf('unsent-259\n'));
  });
  it('never folds pending messages out of the middle of a long history', () => {
    const entries = Array.from({ length: 250 }, (_, i) => user(`e${i}`, `history ${i}`));
    entries.splice(125, 0, { id: 'pending:a', kind: 'queued', text: 'unsent first\nunsent last' });
    const out = renderTranscriptText(entries, OPTS);
    expect(out).toContain('Queued but never sent: unsent first');
    expect(out).toContain('unsent last');
    expect(out.match(/unsent first/g)).toHaveLength(1);
    expect(out).toContain('50 entries omitted');
  });
  it('emits no ANSI escapes', () => {
    const out = renderTranscriptText([user('u1'), asst('a1'), tool('t1')], OPTS);
    expect(ANSI.test(out)).toBe(false);
  });

  it('leads with a one-line session summary', () => {
    const out = renderTranscriptText([user('u1')], OPTS);
    const first = out.split('\n')[0] ?? '';
    expect(first).toContain('aragon');
    expect(first).toContain('anthropic:claude-sonnet-4-6');
    expect(first).toContain('1 turn');
    expect(first).toContain('$0.08');
  });

  it('produces only the summary line for an empty session', () => {
    const out = renderTranscriptText([], OPTS);
    expect(out.trimEnd().split('\n')).toHaveLength(1);
    expect(out.trimEnd()).toContain('0 turns');
  });

  it('renders user / assistant / tool markers and the tool duration', () => {
    const out = renderTranscriptText([user('u1'), asst('a1'), tool('t1')], OPTS);
    expect(out).toContain('› explain this repo');
    expect(out).toContain('● It is an agent engine.');
    expect(out).toContain('read_file README.md (12ms)');
  });

  it('indents continuation lines under their marker', () => {
    const out = renderTranscriptText([asst('a1', 'line one\nline two')], OPTS);
    expect(out).toContain('● line one');
    expect(out).toContain('\n  line two');
  });

  it('collapses the middle when the entry count exceeds maxEntries', () => {
    const entries = Array.from({ length: 25 }, (_, i) => user(`u${i}`, `msg ${i}`));
    const out = renderTranscriptText(entries, { ...OPTS, maxEntries: 10 });
    expect(out).toContain('… 15 entries omitted · use /save before exiting');
    expect(out).toContain('msg 0');
    expect(out).toContain('msg 24');
    expect(out).not.toContain('msg 12');
  });

  it('does not collapse when the session fits', () => {
    const entries = Array.from({ length: 5 }, (_, i) => user(`u${i}`, `msg ${i}`));
    const out = renderTranscriptText(entries, { ...OPTS, maxEntries: 10 });
    expect(out).not.toContain('entries omitted');
  });

  it('degrades every marker to ASCII on a terminal without Unicode (P0-2)', () => {
    // The exit replay lands in the same terminal the TUI just left, so it must
    // follow the same glyph tier. It used to spell its own Unicode literals and
    // wrote mojibake straight into a legacy console's normal buffer.
    const out = renderTranscriptText([user('u1'), asst('a1'), tool('t1')], {
      ...OPTS,
      glyphs: ASCII,
    });
    expect(out).not.toMatch(/[^\x00-\x7f]/);
    expect(out).toContain('> explain this repo');
    expect(out).toContain('* It is an agent engine.');
  });
});
