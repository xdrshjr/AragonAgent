import { describe, expect, it } from 'vitest';
import {
  classifyDiffLine,
  bashBadge,
  parseWriteFile,
  parseListRow,
} from '../ui/entries/ToolPreview.js';
import { renderUnifiedDiff } from '../tools/diff.js';

describe('classifyDiffLine (meta-first ordering — P2-8)', () => {
  it('classifies +/- content lines', () => {
    expect(classifyDiffLine('+ added line')).toBe('add');
    expect(classifyDiffLine('- removed line')).toBe('remove');
    expect(classifyDiffLine('  context line')).toBe('context');
  });

  it('classifies multi-char headers as meta before single-char signs', () => {
    expect(classifyDiffLine('--- path/to/file')).toBe('meta');
    expect(classifyDiffLine('+++ path/to/file')).toBe('meta');
    expect(classifyDiffLine('@@ -1,2 +1,3 @@')).toBe('meta');
  });

  it('treats the edit_file lead-in as context', () => {
    expect(classifyDiffLine('Applied edit to src/a.ts:')).toBe('context');
  });
});

describe('bashBadge (status-authoritative + best-effort footer — P1-2)', () => {
  it('derives exit 0 / failed from status', () => {
    expect(bashBadge('done', '$ ls\nfile\n')).toEqual({ text: 'exit 0', ok: true });
    expect(bashBadge('error', '$ nope\nboom\n')).toEqual({ text: 'failed', ok: false });
  });

  it('parses the real bracketed footer for the exact number', () => {
    expect(bashBadge('error', '$ x\nout\n[exit code 3]')).toEqual({ text: 'exit 3', ok: false });
    expect(bashBadge('done', '$ x\nout\n[exit code 0]')).toEqual({ text: 'exit 0', ok: true });
    expect(bashBadge('error', '$ x\n[signal SIGTERM]')).toEqual({
      text: 'signal SIGTERM',
      ok: false,
    });
  });

  it('falls back to the status label when the footer is truncated away', () => {
    expect(bashBadge('error', '$ x\nlots of output\n…')).toEqual({ text: 'failed', ok: false });
  });

  it('never uses the wrong "exit code: N" pattern', () => {
    expect(bashBadge('done', 'exit code: 0').text).toBe('exit 0'); // status-derived, not parsed
  });
});

describe('parseWriteFile (bytes + path only — P2-7)', () => {
  it('parses the real Wrote result', () => {
    expect(parseWriteFile('Wrote 42 bytes to src/a.ts')).toEqual({ bytes: 42, path: 'src/a.ts' });
  });

  it('returns null when the text is not a write result', () => {
    expect(parseWriteFile('something else')).toBeNull();
  });
});

describe('parseListRow (list_dir vs glob — P2-9)', () => {
  it('splits dir and file rows with sizes', () => {
    expect(parseListRow('dir   src/')).toEqual({ kind: 'dir', name: 'src' });
    expect(parseListRow('file  a.txt  (12b)')).toEqual({ kind: 'file', name: 'a.txt', size: '12b' });
    expect(parseListRow('file  b.txt')).toEqual({ kind: 'file', name: 'b.txt', size: undefined });
  });

  it('returns null for a flat glob path (no dir/file annotation)', () => {
    expect(parseListRow('src/components/App.tsx')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// agent-activity-presentation — `renderUnifiedDiff` now emits `@@` headers, and
// the fallback renderer must still classify them (D-10 / AC-17)
// ---------------------------------------------------------------------------

describe('the text fallback renders a hunk-headed diff correctly (D-10)', () => {
  it('classifies every row a real edit_file result now produces', () => {
    const old = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join('\n');
    const next = old.replace('line 15', 'CHANGED');
    const text = `Applied edit to a.ts:\n${renderUnifiedDiff(old, next, { path: 'a.ts' })}`;

    const classes = text.split('\n').map(classifyDiffLine);
    expect(classes[0]).toBe('context'); // the `Applied edit to` lead-in
    expect(classes[1]).toBe('meta'); // `--- a.ts`
    expect(classes[2]).toBe('meta'); // `+++ a.ts`
    expect(classes[3]).toBe('meta'); // `@@ ... @@`, which is new this round
    expect(classes).toContain('remove');
    expect(classes).toContain('add');
    expect(classes).toContain('context');
  });

  it('still defaults to TWO context rows, so the model-facing diff did not widen', () => {
    // `fs-tools.ts` passes no override, and `PATCH_LIMITS.context` is 3. A single
    // shared constant would add two rows to EVERY model-facing diff (D-20).
    const old = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join('\n');
    const next = old.replace('line 15', 'CHANGED');
    const rows = renderUnifiedDiff(old, next).split('\n');
    expect(rows.filter((r) => r.startsWith('  '))).toHaveLength(4);
  });
});
