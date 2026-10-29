/**
 * `extractProgress` — the ordered extraction table (long-task-jobs AC-16 / AC-17).
 *
 * EVERY ROW IS A REGRESSION GUARD FOR A REAL OUTPUT FORMAT: a tqdm bar, a
 * Hugging Face download, a PyTorch epoch line, a `[100%] built target` build
 * line, and the decoration that must produce NO progress rather than a fake 0%.
 */

import { describe, expect, it } from 'vitest';
import { extractProgress } from '../model/proc/progress.js';
import { PROC_LIMITS } from '../model/proc/limits.js';

describe('extractProgress: the table', () => {
  it('AC-16a: a percentage', () => {
    expect(extractProgress(['epoch 1: 47%'], '')).toMatchObject({ text: '47%', kind: 'percent' });
  });

  it('AC-16b: a decimal percentage keeps its decimals', () => {
    expect(extractProgress(['  12.5% done'], '')?.text).toBe('12.5%');
  });

  it('AC-16c: epoch n/m is rendered with its keyword', () => {
    expect(extractProgress(['Epoch 3/10 loss=0.42'], '')).toMatchObject({
      text: 'epoch 3/10',
      kind: 'epoch',
    });
  });

  it('AC-16d: step n/m likewise', () => {
    expect(extractProgress(['step 812/1000 loss 0.4182'], '')).toMatchObject({
      text: 'step 812/1000',
      kind: 'epoch',
    });
  });

  it('AC-16e: a bare fraction is a ratio', () => {
    expect(extractProgress(['  [812/1000] chunks'], '')).toMatchObject({
      text: '812/1000',
      kind: 'ratio',
    });
  });

  it('AC-16f: byte progress keeps the total unit, not the current one', () => {
    expect(extractProgress(['downloading 1.2 GiB / 3.4 GiB'], '')).toMatchObject({
      text: '1.2/3.4 GiB',
      kind: 'bytes',
    });
  });

  it('AC-16g: bytes beat the generic ratio, which would read this line as 2/3', () => {
    // `1.2/3.4` satisfies `\d+/\d+` as "2/3", so the table order is what makes
    // this assertion possible at all - see the module comment.
    expect(extractProgress(['1.2/3.4 GiB'], '')?.text).not.toBe('2/3');
  });

  it('AC-16h: plain text falls back to the last line that says something', () => {
    expect(extractProgress(['compiling shaders'], '')).toMatchObject({
      text: 'compiling shaders',
      kind: 'text',
    });
  });

  it('AC-16i: decoration alone yields NO progress', () => {
    expect(extractProgress(['...', '|', '-', '  ===='], '')).toBeUndefined();
  });
});

describe('extractProgress: carry lines and ETA', () => {
  it('AC-17: a \\r progress bar is read from the carry line', () => {
    const progress = extractProgress([], 'Epoch 1: 47%|#####     | 47/100');
    expect(progress).toMatchObject({ text: '47%', kind: 'percent', source: 'carry' });
  });

  it('the carry line outranks a completed row above it', () => {
    const progress = extractProgress(['step 10/100'], 'step 47/100');
    expect(progress).toMatchObject({ source: 'carry', text: 'step 47/100' });
  });

  it('an ETA in the same window is merged once', () => {
    const progress = extractProgress(['47% ETA 13m'], '');
    expect(progress?.text).toBe('47%  ETA 13m');
  });

  it('the newest structured row wins over a stale 100% above it', () => {
    // R-4's practical failure: a build prints `[100%]` for the previous phase and
    // the live line is far below it.
    const progress = extractProgress(['[100%] built target foo', 'epoch 2: 12%'], '');
    expect(progress?.text).toBe('12%');
  });

  it('the text is clipped to the one-line budget', () => {
    const long = `compiling ${'x'.repeat(200)}`;
    const progress = extractProgress([long], '');
    expect(progress?.kind).toBe('text');
    expect(progress?.text.length).toBeLessThanOrEqual(PROC_LIMITS.waitProgressChars);
    expect(progress?.text.endsWith('...')).toBe(true);
  });
});

describe('extractProgress: fraction (extended-job-wait AC-23)', () => {
  const fractionOf = (row: string, carry = ''): number | null | undefined =>
    extractProgress([row], carry)?.fraction;

  it.each([
    ['47%', 0.47],
    ['epoch 3/10', 0.3],
    ['812/1000', 0.812],
    ['12/10', 1],
  ])('%s -> %s', (row, expected) => {
    expect(fractionOf(row)).toBeCloseTo(expected, 5);
  });

  it('reads bytes only when the two sides share (or omit) a unit', () => {
    expect(fractionOf('1.2/3.4 GiB')).toBeCloseTo(1.2 / 3.4, 5);
    expect(fractionOf('2 GiB/4 GiB')).toBeCloseTo(0.5, 5);
    expect(fractionOf('512 MiB/3 GiB')).toBeNull();
  });

  it('is null when there is nothing to divide', () => {
    expect(fractionOf('0/0')).toBeNull();
    expect(fractionOf('compiling foo.c')).toBeNull();
  });

  it('keeps the whole ETA token (1h02m used to be cut to 1h)', () => {
    expect(extractProgress(['47%  ETA 1h02m'], '')?.text).toContain('ETA 1h02m');
  });
});
