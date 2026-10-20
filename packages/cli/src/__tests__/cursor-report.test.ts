import { describe, expect, it } from 'vitest';
import {
  CURSOR_REPORT_QUERY,
  formatCursorReportQuery,
  isCursorReportPrefix,
  spaceBelowFromReport,
  splitCursorReports,
  trailingCprPrefixLength,
} from '../input/cursor-report.js';

const CPR = (row: number, col = 1): string => `\x1b[${row};${col}R`;

describe('splitCursorReports', () => {
  it('splits_one_report_out_of_text', () => {
    const split = splitCursorReports(`a${CPR(3, 4)}b`);
    expect(split.text).toBe('ab');
    expect(split.reports).toEqual([{ row: 3, col: 4 }]);
    expect(split.pending).toBe('');
  });

  it('keeps_a_private_mode_sequence_untouched', () => {
    const split = splitCursorReports('\x1b[?25l');
    expect(split.text).toBe('\x1b[?25l');
    expect(split.reports).toEqual([]);
    expect(split.pending).toBe('');
  });

  it('accepts_decxcpr_form', () => {
    const split = splitCursorReports('\x1b[?12;1R');
    expect(split.text).toBe('');
    expect(split.reports).toEqual([{ row: 12, col: 1 }]);
  });

  it('strips_every_report_and_keeps_the_rest_in_order', () => {
    const split = splitCursorReports(`${CPR(1)}x${CPR(2, 3)}y${CPR(4)}`);
    expect(split.text).toBe('xy');
    expect(split.reports.map((report) => report.row)).toEqual([1, 2, 4]);
  });

  it('holds_a_torn_report', () => {
    const split = splitCursorReports(`a${CPR(1).slice(0, 3)}`);
    expect(split.text).toBe('a');
    expect(split.pending).toBe('\x1b[1');
  });

  it('does_not_hold_an_arrow_key', () => {
    const split = splitCursorReports('\x1b[A');
    expect(split.text).toBe('\x1b[A');
    expect(split.pending).toBe('');
  });
});

describe('trailingCprPrefixLength', () => {
  it('trailing_prefix_length_covers_every_torn_shape', () => {
    for (const shape of ['\x1b', '\x1b[', '\x1b[?', '\x1b[12', '\x1b[12;', '\x1b[12;1']) {
      expect(trailingCprPrefixLength(shape)).toBe(shape.length);
      expect(isCursorReportPrefix(shape)).toBe(true);
    }
  });

  it('does_not_treat_a_finished_sequence_as_a_prefix', () => {
    expect(trailingCprPrefixLength('\x1b[A')).toBe(0);
    expect(trailingCprPrefixLength('\x1b[?25l')).toBe(0);
    expect(trailingCprPrefixLength('plain text')).toBe(0);
    expect(trailingCprPrefixLength('')).toBe(0);
  });

  it('counts only the tail, not the whole text', () => {
    expect(trailingCprPrefixLength(`hello${'\x1b[1'}`)).toBe(3);
  });
});

describe('spaceBelowFromReport', () => {
  it('counts the rows left below the reported row', () => {
    // Row 12 of a 31-row terminal is 1-based (index 11), so 19 rows follow it.
    expect(spaceBelowFromReport({ row: 12, col: 1 }, 31)).toBe(19);
    expect(spaceBelowFromReport({ row: 31, col: 1 }, 31)).toBe(0);
    expect(spaceBelowFromReport({ row: 1, col: 1 }, 31)).toBe(30);
  });

  it('does not guess without a height', () => {
    expect(spaceBelowFromReport({ row: 12, col: 1 }, undefined)).toBeNull();
  });
});

describe('formatCursorReportQuery', () => {
  it('is the DSR 6 query', () => {
    expect(CURSOR_REPORT_QUERY).toBe('\x1b[6n');
    expect(formatCursorReportQuery()).toBe(CURSOR_REPORT_QUERY);
  });
});
