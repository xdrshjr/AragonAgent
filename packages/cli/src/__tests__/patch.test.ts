/**
 * The diff algorithm (agent-activity-presentation §7.1).
 *
 * THE LARGEST NEW SURFACE, AND THE ONE WHERE A BUG IS SILENT: a wrong line
 * number looks entirely plausible. The round-trip case below (reconstruct both
 * files from the patch) is the one that actually catches that class, because it
 * checks the numbers against the content rather than against another number
 * derived the same way.
 */

import { describe, expect, it } from 'vitest';
import {
  NO_NEWLINE_NOTE,
  PATCH_LIMITS,
  TRUNCATION_MARK,
  buildPatch,
  type FilePatch,
  type PatchLine,
} from '../tools/patch.js';
import { renderUnifiedDiff } from '../tools/diff.js';
import { PREVIEW_TRUNCATION_MARK } from '../agent/reducer.js';

const OPTS = { path: 'a.ts' };

function allLines(patch: FilePatch): PatchLine[] {
  return patch.hunks.flatMap((h) => h.lines);
}

function lines(n: number, prefix = 'line'): string[] {
  return Array.from({ length: n }, (_, i) => `${prefix} ${i + 1}`);
}

describe('buildPatch — hunks', () => {
  it('reduces a one-line change in a 500-line file to ONE small hunk', () => {
    const old = lines(500);
    const next = [...old];
    next[249] = 'CHANGED';
    const patch = buildPatch(old.join('\n'), next.join('\n'), OPTS);

    expect(patch.hunks).toHaveLength(1);
    // 3 context + 1 del + 1 add + 3 context, at PATCH_LIMITS.context = 3.
    expect(patch.lineCount).toBe(8);
    expect(patch.added).toBe(1);
    expect(patch.removed).toBe(1);
    expect(patch.kind).toBe('update');
  });

  it('yields TWO hunks for two changes 800 lines apart, not one spanning both', () => {
    // Today's renderer produced one block covering everything in between. Assert
    // the COUNT, so a regression to `blockReplace` fails here rather than merely
    // looking verbose.
    const old = lines(1000);
    const next = [...old];
    next[49] = 'FIRST';
    next[849] = 'SECOND';
    const patch = buildPatch(old.join('\n'), next.join('\n'), OPTS);

    expect(patch.hunks).toHaveLength(2);
    expect(patch.added).toBe(2);
    expect(patch.removed).toBe(2);
    expect(patch.lineCount).toBeLessThan(20);
  });

  it('merges two changes four lines apart into one hunk (mergeGap)', () => {
    const old = lines(100);
    const next = [...old];
    next[49] = 'A';
    next[54] = 'B';
    const patch = buildPatch(old.join('\n'), next.join('\n'), OPTS);
    expect(patch.hunks).toHaveLength(1);
  });

  it('numbers every row correctly — verified by rebuilding BOTH files', () => {
    const old = lines(60);
    const next = [...old];
    next[9] = 'CHANGED 10';
    next.splice(30, 0, 'INSERTED');
    next.splice(45, 1);
    const oldText = old.join('\n');
    const newText = next.join('\n');
    const patch = buildPatch(oldText, newText, OPTS);

    for (const line of allLines(patch)) {
      if (line.text === NO_NEWLINE_NOTE) continue;
      if (line.oldLine !== undefined) expect(old[line.oldLine - 1], `old ${line.oldLine}`).toBe(line.text);
      if (line.newLine !== undefined) expect(next[line.newLine - 1], `new ${line.newLine}`).toBe(line.text);
    }

    // And the header numbers agree with the rows they describe.
    for (const hunk of patch.hunks) {
      const olds = hunk.lines.filter((l) => l.oldLine !== undefined);
      const news = hunk.lines.filter((l) => l.newLine !== undefined);
      expect(hunk.oldCount).toBe(olds.length);
      expect(hunk.newCount).toBe(news.length);
      if (olds.length > 0) expect(hunk.oldStart).toBe(olds[0]!.oldLine);
      if (news.length > 0) expect(hunk.newStart).toBe(news[0]!.newLine);
    }
  });
});

describe('buildPatch — degenerate inputs', () => {
  it('treats a null old side as a create: all adds, removed 0', () => {
    const patch = buildPatch(null, 'a\nb\nc\n', OPTS);
    expect(patch.kind).toBe('create');
    expect(patch.removed).toBe(0);
    expect(patch.added).toBe(3);
    expect(allLines(patch).every((l) => l.kind === 'add')).toBe(true);
  });

  it('calls a null old side WITH a reason an update, not a create', () => {
    // "Created a file" and "overwrote a 5 MB file we declined to read" are
    // different events, and the card names them differently.
    const patch = buildPatch(null, 'x\n', { ...OPTS, degraded: 'too-large' });
    expect(patch.kind).toBe('update');
    expect(patch.degraded).toBe('too-large');
  });

  it('yields zero hunks and zero counts for identical input', () => {
    const patch = buildPatch('a\nb\nc\n', 'a\nb\nc\n', OPTS);
    expect(patch.hunks).toHaveLength(0);
    expect(patch.added).toBe(0);
    expect(patch.removed).toBe(0);
    expect(patch.lineCount).toBe(0);
  });

  it('never throws, for any pair of strings including empty ones', () => {
    const samples = ['', '\n', 'a', 'a\n', '\n\n\n', 'a\r\nb\r\n', 'x'.repeat(5000)];
    for (const a of samples) {
      for (const b of samples) {
        expect(() => buildPatch(a, b, OPTS), `${JSON.stringify(a)} -> ${JSON.stringify(b)}`).not.toThrow();
        expect(() => buildPatch(null, b, OPTS)).not.toThrow();
      }
    }
  });
});

describe('buildPatch — newline and CRLF edges', () => {
  it('emits the no-newline note and no phantom blank line', () => {
    const patch = buildPatch('a\nb', 'a\nb\n', OPTS);
    const texts = allLines(patch).map((l) => l.text);
    expect(texts).toContain(NO_NEWLINE_NOTE);
    // The phantom line a naive `split('\n')` leaves behind would show up as a
    // trailing empty row.
    expect(texts.filter((t) => t === '')).toHaveLength(0);
  });

  it('strips CR from rendered text and still reports CRLF -> LF as a change', () => {
    const patch = buildPatch('a\r\nb\r\n', 'a\nb\n', OPTS);
    for (const line of allLines(patch)) expect(line.text).not.toContain('\r');
    expect(patch.added + patch.removed).toBeGreaterThan(0);
  });
});

describe('buildPatch — budgets', () => {
  it('clips a 5000-line rewrite but still reports the UNTRUNCATED counts', () => {
    const old = lines(5000, 'old');
    const next = lines(5000, 'new');
    const patch = buildPatch(old.join('\n'), next.join('\n'), OPTS);

    expect(patch.truncated).toBe(true);
    expect(patch.lineCount).toBeLessThanOrEqual(PATCH_LIMITS.maxLines);
    const chars = allLines(patch).reduce((n, l) => n + l.text.length, 0);
    expect(chars).toBeLessThanOrEqual(PATCH_LIMITS.maxChars);
    // The `+N -M` summary describes the REAL change even when the body is clipped.
    expect(patch.added).toBe(5000);
    expect(patch.removed).toBe(5000);
  });

  it('keeps rows rather than dropping the only hunk entirely', () => {
    // A 300-line create is ONE hunk of 300 add rows against a 200-row ceiling.
    // Whole-hunk dropping alone would leave zero, and the card would render a
    // `+300 -0` summary over nothing — the "reported as a byte count" failure
    // this feature exists to fix.
    const patch = buildPatch(null, lines(300).join('\n'), OPTS);
    expect(patch.hunks.length).toBeGreaterThan(0);
    expect(patch.lineCount).toBe(PATCH_LIMITS.maxLines);
    expect(patch.truncated).toBe(true);
    expect(patch.added).toBe(300);
  });

  it('truncates one very long row with the shared mark', () => {
    const long = 'x'.repeat(PATCH_LIMITS.maxLineChars + 500);
    const patch = buildPatch('short\n', `${long}\n`, OPTS);
    const added = allLines(patch).find((l) => l.kind === 'add')!;
    expect(added.text.endsWith(TRUNCATION_MARK)).toBe(true);
    expect(added.text.length).toBe(PATCH_LIMITS.maxLineChars + TRUNCATION_MARK.length);
  });

  it('spells the truncation mark exactly as the stored preview does', () => {
    // The two are deliberately independent constants (`tools/` takes no runtime
    // dependency on the view model for one three-character string), so the pair
    // is pinned here rather than by an import.
    expect(TRUNCATION_MARK).toBe(PREVIEW_TRUNCATION_MARK);
  });

  it('falls back to a block replace on a pathological input, and fast', () => {
    // Above `lcsCellBudget` with no unique anchors on either side: every line is
    // one of two repeated strings, so `pickAnchors` finds nothing.
    const old = Array.from({ length: 600 }, (_, i) => (i % 2 ? 'a' : 'b')).join('\n');
    const next = Array.from({ length: 600 }, (_, i) => (i % 2 ? 'c' : 'd')).join('\n');
    const started = Date.now();
    const patch = buildPatch(old, next, OPTS);
    expect(Date.now() - started).toBeLessThan(100);
    expect(patch.added).toBe(600);
    expect(patch.removed).toBe(600);
  });

  it('keeps lineCount equal to the summed hunk rows (entryRevision depends on it)', () => {
    for (const [a, b] of [
      ['a\nb\nc\n', 'a\nB\nc\n'],
      [lines(200).join('\n'), lines(200, 'x').join('\n')],
      ['', 'one\ntwo\n'],
    ] as [string, string][]) {
      const patch = buildPatch(a, b, OPTS);
      expect(patch.lineCount).toBe(patch.hunks.reduce((n, h) => n + h.lines.length, 0));
    }
  });
});

describe('renderUnifiedDiff on top of buildPatch (AC-17 / D-20)', () => {
  it('keeps a 2-row context default, so the model-facing diff does not widen', () => {
    const old = lines(40);
    const next = [...old];
    next[19] = 'CHANGED';
    const text = renderUnifiedDiff(old.join('\n'), next.join('\n'), { path: 'a.ts' });
    const rows = text.split('\n');

    expect(rows[0]).toBe('--- a.ts');
    expect(rows[1]).toBe('+++ a.ts');
    expect(rows[2]!.startsWith('@@')).toBe(true);
    // 2 context + 1 del + 1 add + 2 context = today's rows, plus one `@@`.
    expect(rows).toHaveLength(2 + 1 + 6);
    expect(rows).toContain('- line 20');
    expect(rows).toContain('+ CHANGED');
  });

  it('honours an explicit context override (the UI passes 3)', () => {
    const old = lines(40);
    const next = [...old];
    next[19] = 'CHANGED';
    const wide = renderUnifiedDiff(old.join('\n'), next.join('\n'), { context: 3 });
    expect(wide.split('\n')).toHaveLength(1 + 8);
  });

  it('is strictly smaller than a block replace for a multi-region edit', () => {
    const old = lines(400);
    const next = [...old];
    next[9] = 'A';
    next[299] = 'B';
    const text = renderUnifiedDiff(old.join('\n'), next.join('\n'));
    // The old renderer emitted every line from 10 to 300 twice, ~580 rows.
    expect(text.split('\n').length).toBeLessThan(30);
    expect(text.split('\n').filter((l) => l.startsWith('@@'))).toHaveLength(2);
  });

  it('caps the model-facing text at modelDiffMaxChars', () => {
    const old = lines(5000, 'old').join('\n');
    const next = lines(5000, 'new').join('\n');
    const text = renderUnifiedDiff(old, next, { path: 'big.ts' });
    expect(text.length).toBeLessThanOrEqual(PATCH_LIMITS.modelDiffMaxChars + 64);
    expect(text).toContain('(diff truncated)');
  });

  it('reports an unchanged pair rather than stray context rows', () => {
    expect(renderUnifiedDiff('a\nb\n', 'a\nb\n')).toBe('(no textual change)');
  });
});
