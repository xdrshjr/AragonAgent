import { describe, expect, it } from 'vitest';
import { parseAnsi, stripAnsi } from '../chat-ansi.js';

const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);
const NUL = String.fromCharCode(0);

describe('ansi parsing', () => {
  it('maps colour and bold escapes to runs', () => {
    const runs = parseAnsi(`${ESC}[1;31merror${ESC}[0m done`);
    expect(runs).toEqual([
      { text: 'error', fg: 1, bold: true, dim: false },
      { text: ' done', fg: null, bold: false, dim: false },
    ]);
  });

  it('supports bright colours and resets the colour with 39', () => {
    const runs = parseAnsi(`${ESC}[92mok${ESC}[39m plain`);
    expect(runs[0]).toMatchObject({ text: 'ok', fg: 10 });
    expect(runs[1]).toMatchObject({ text: ' plain', fg: null });
  });

  it('drops cursor movement, OSC titles and stray control bytes instead of printing them', () => {
    expect(stripAnsi(`a${ESC}[2Kb${ESC}]0;title${BEL}c${BEL}d${NUL}e`)).toBe('abcde');
  });

  it('skips extended-colour parameters without mis-reading them as attributes', () => {
    const runs = parseAnsi(`${ESC}[38;5;196mred${ESC}[0m`);
    expect(runs[0]).toMatchObject({ text: 'red', fg: null, bold: false });
  });

  it('keeps tabs and newlines', () => {
    expect(stripAnsi('a\tb\nc')).toBe('a\tb\nc');
  });

  it('handles an unterminated escape without hanging', () => {
    expect(stripAnsi(`abc${ESC}[`)).toContain('abc');
  });
});
