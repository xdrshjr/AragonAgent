import { describe, expect, it } from 'vitest';
import { countLines, HIGHLIGHT_MAX_LINES, tokenize } from '../chat-tokenize.js';

const join = (code: string, lang: string): string => tokenize(code, lang).map((token) => token.text).join('');

describe('code tokenizer', () => {
  it('is lossless for every language family', () => {
    const samples: Array<[string, string]> = [
      ['const a = "x"; // note\n/* c */ return 42;', 'ts'],
      ['def f():\n  return "a" # c', 'python'],
      ['{"a": [1, 2.5, true, null]}', 'json'],
      ['@@ -1 +1 @@\n-old\n+new\n ctx', 'diff'],
      ['whatever', 'unknown-lang'],
    ];
    for (const [code, lang] of samples) expect(join(code, lang)).toBe(code);
  });

  it('classifies comments, numbers and keywords', () => {
    const types = new Map(tokenize('const n = 42; // hi "not a string"', 'ts').map((token) => [token.text.trim(), token.type]));
    expect(types.get('const')).toBe('keyword');
    expect(types.get('42')).toBe('number');
    expect(types.get('// hi "not a string"')).toBe('comment');
  });

  it('does not treat a # inside a string as a comment', () => {
    const tokens = tokenize('x = "a # b"', 'python');
    expect(tokens.some((token) => token.type === 'comment')).toBe(false);
    expect(tokens.some((token) => token.type === 'string' && token.text === '"a # b"')).toBe(true);
  });

  it('colours diff lines by their marker', () => {
    const types = tokenize('+a\n-b\n c', 'diff').map((token) => token.type);
    expect(types).toEqual(['add', 'del', 'plain']);
  });

  it('degrades past the line limit to one plain token', () => {
    const big = Array.from({ length: HIGHLIGHT_MAX_LINES + 5 }, () => 'const a = 1;').join('\n');
    expect(tokenize(big, 'ts')).toEqual([{ text: big, type: 'plain' }]);
  });

  it('counts lines', () => {
    expect(countLines('a')).toBe(1);
    expect(countLines('a\nb\nc')).toBe(3);
  });

  it('terminates on an unterminated string or block comment', () => {
    expect(join('"abc', 'ts')).toBe('"abc');
    expect(join('/* open', 'ts')).toBe('/* open');
  });
});
