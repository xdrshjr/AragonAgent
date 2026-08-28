import { describe, expect, it } from 'vitest';
import {
  CARRY_MAX_CHARS,
  LIVE_ROW_MAX_CHARS,
  TAB_WIDTH,
  TRUNCATION_MARK,
  sanitizeChunk,
  stripAnsi,
  toDisplayRow,
} from '../tools/terminal-output.js';
import { TRUNCATION_MARK as PATCH_TRUNCATION_MARK } from '../tools/patch.js';

/** Feed a whole corpus one chunk at a time, returning rows plus the final tail. */
function feed(chunks: string[]): { rows: string[]; tail: string } {
  let carry = '';
  const rows: string[] = [];
  for (const chunk of chunks) {
    const out = sanitizeChunk(carry, chunk);
    rows.push(...out.rows);
    carry = out.carry;
  }
  return { rows, tail: toDisplayRow(carry) };
}

/** The progress bar §7.3 row 3 uses, as bytes: `\r` only, never `\n`. */
function bar(pct: number): string {
  const filled = Math.floor(pct / 5);
  return `\rdownloading [${'#'.repeat(filled)}${' '.repeat(20 - filled)}] ${pct}%`;
}

describe('stripAnsi (agent-activity-presentation-live §3.2 step 2)', () => {
  it('removes CSI, OSC and two-byte escapes, and every C0/C1 control but tab/CR/LF', () => {
    expect(stripAnsi('\x1b[31mred\x1b[0m')).toBe('red');
    expect(stripAnsi('\x1b[2K\x1b[1;32Hmoved')).toBe('moved');
    expect(stripAnsi('\x1b]0;a window title\x07after')).toBe('after');
    expect(stripAnsi('\x1b]0;st form\x1b\\after')).toBe('after');
    expect(stripAnsi('a\x1bMb')).toBe('ab');
    expect(stripAnsi('a\x00b\x07c\x08d\x7fe')).toBe('abcde');
    expect(stripAnsi('a\x9bb')).toBe('ab');
    // The three that MUST survive: they are the line structure, not decoration.
    expect(stripAnsi('a\tb\rc\nd')).toBe('a\tb\rc\nd');
  });
});

describe('sanitizeChunk (§3.2)', () => {
  it('splits complete rows and keeps the incomplete tail in the carry', () => {
    const first = sanitizeChunk('', 'alpha\nbeta\ngam');
    expect(first.rows).toEqual(['alpha', 'beta']);
    expect(first.carry).toBe('gam');
    const second = sanitizeChunk(first.carry, 'ma\n');
    expect(second.rows).toEqual(['gamma']);
    expect(second.carry).toBe('');
  });

  it('treats CRLF as one line ending, leaving no stray CR', () => {
    const { rows, tail } = feed(['a\r\nb\r\n']);
    expect(rows).toEqual(['a', 'b']);
    expect(tail).toBe('');
    expect(rows.join('')).not.toContain('\r');
  });

  /**
   * AC-25 / AC-39 / P0-1 — THE CASE THE ROUND EXISTS FOR.
   *
   * npm, pip, curl and docker emit NO `\n` for the whole run, so every rewrite
   * lives in the incomplete tail. A rule that collapsed only completed lines
   * would never run here: the tail would stay empty, `showLive` false, and the
   * card the single `running` row this round replaces.
   */
  describe('a carry-only progress bar (P0-1)', () => {
    const ticks = Array.from({ length: 200 }, (_, i) => bar(Math.floor((i * 100) / 199)));

    it('yields NO completed rows, one display row, and no CR — fed as 200 chunks', () => {
      const { rows, tail } = feed(ticks);
      expect(rows).toEqual([]);
      expect(tail).toBe('downloading [####################] 100%');
      expect(tail).not.toContain('\r');
    });

    it('yields the same single row when the whole run arrives as ONE chunk', () => {
      // The two paths differ — one crosses `carry` 200 times, the other never —
      // so both are asserted rather than one standing in for the other.
      const { rows, tail } = feed([ticks.join('')]);
      expect(rows).toEqual([]);
      expect(tail).toBe('downloading [####################] 100%');
    });

    it('shows the LATEST state mid-run, not the first (AC-25)', () => {
      const { tail } = feed(ticks.slice(0, 60));
      expect(tail).toContain('%');
      expect(tail).not.toContain('0%]');
      expect(tail.startsWith('downloading [')).toBe(true);
    });

    it('never lets the carry grow with the number of rewrites', () => {
      const short = sanitizeChunk('', ticks.slice(0, 5).join('')).carry.length;
      const long = sanitizeChunk('', ticks.join('')).carry.length;
      expect(long).toBeLessThanOrEqual(short + 8);
    });
  });

  it('collapses `\\x1b[2K\\r` progress ticks that DO end in a newline to one row', () => {
    const { rows } = feed([
      '\x1b[2K\rstep 1/3\x1b[2K\rstep 2/3\x1b[2K\rstep 3/3\n',
    ]);
    expect(rows).toEqual(['step 3/3']);
  });

  it('overwrites a PREFIX rather than truncating, so content is not lost (R-6)', () => {
    // A real terminal leaves whatever the shorter write did not cover.
    const { rows } = feed(['abcdefgh\rXY\n']);
    expect(rows).toEqual(['XYcdefgh']);
  });

  it('round-trips a chunk split mid-escape through the carry', () => {
    const a = sanitizeChunk('', 'red \x1b[3');
    expect(a.rows).toEqual([]);
    // The half-written escape must not surface as a bare `[3` (AC-24).
    expect(toDisplayRow(a.carry)).toBe('red ');
    const b = sanitizeChunk(a.carry, '1mtext\n');
    expect(b.rows).toEqual(['red text']);
  });

  it('round-trips a chunk that ends on a lone ESC', () => {
    const a = sanitizeChunk('', 'x\x1b');
    expect(toDisplayRow(a.carry)).toBe('x');
    const b = sanitizeChunk(a.carry, '[0my\n');
    expect(b.rows).toEqual(['xy']);
  });

  it('expands tabs to the next multiple of TAB_WIDTH', () => {
    const { rows } = feed(['a\tb\n', '\tc\n']);
    expect(rows[0]).toBe(`a${' '.repeat(TAB_WIDTH - 1)}b`);
    expect(rows[1]).toBe(`${' '.repeat(TAB_WIDTH)}c`);
  });

  it('clips a 10 000-char row at LIVE_ROW_MAX_CHARS plus the mark', () => {
    const { rows } = feed([`${'x'.repeat(10_000)}\n`]);
    expect(rows[0]).toBe('x'.repeat(LIVE_ROW_MAX_CHARS) + TRUNCATION_MARK);
  });

  it('flushes a genuinely long single line once the carry passes its bound', () => {
    // Step 4 collapses a progress bar to one row however often it redraws, so
    // reaching this bound needs a line that is really that long.
    const { rows, tail } = feed(['y'.repeat(CARRY_MAX_CHARS + 1)]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toBe('y'.repeat(LIVE_ROW_MAX_CHARS) + TRUNCATION_MARK);
    expect(tail).toBe('');
  });

  it('spells the truncation mark identically to `patch.ts` (no silent drift)', () => {
    expect(TRUNCATION_MARK).toBe(PATCH_TRUNCATION_MARK);
  });

  /** AC-24 — stated as a property over the whole corpus, not row by row. */
  it('never emits a control byte, an escape or a CR on any row (AC-24)', () => {
    const corpus = [
      '\x1b[31mred\x1b[0m\n',
      '\x1b]0;title\x07body\n',
      '\x1b[2K\rbar 1\rbar 22\n',
      'tab\there\n',
      'nul\x00byte\x7f\n',
      'c1\x85control\n',
      ...Array.from({ length: 20 }, (_, i) => bar(i * 5)),
    ];
    const { rows, tail } = feed(corpus);
    // eslint-disable-next-line no-control-regex
    const unsafe = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/;
    for (const row of [...rows, tail]) expect(unsafe.test(row), row).toBe(false);
  });

  /** Totality — `sanitizeChunk` must never throw, whatever a child writes. */
  it('is total over a hostile corpus, including a 4 MB newline-free chunk', () => {
    const cases = [
      '',
      '\x1b',
      '\x1b[',
      '\x1b]',
      '\x00'.repeat(100),
      '\uD800',
      `lone surrogate \uDC00 and \uD83D`,
      '\r\r\r\r',
      '\n\n\n',
      '\r\n\r\n',
      '\t'.repeat(500),
      'x'.repeat(4 * 1024 * 1024),
      '\u{1F600}\u{1F600}\n',
    ];
    let carry = '';
    let threw = 0;
    for (const c of cases) {
      try {
        const out = sanitizeChunk(carry, c);
        carry = out.carry;
      } catch {
        threw += 1;
      }
    }
    expect(threw).toBe(0);
    // And it stays bounded across every one of them.
    expect(carry.length).toBeLessThanOrEqual(CARRY_MAX_CHARS + 64);
  });

  it('tolerates a non-string carry or chunk rather than throwing', () => {
    const out = sanitizeChunk(undefined as unknown as string, undefined as unknown as string);
    expect(out).toEqual({ rows: [], carry: '' });
  });
});
