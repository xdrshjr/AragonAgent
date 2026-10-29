import { describe, expect, it } from 'vitest';
import { splitMarkdownBlocks } from '../chat-markdown-blocks.js';

const rejoin = (text: string): string => splitMarkdownBlocks(text).join('\n');

describe('markdown block splitting', () => {
  it('splits on blank lines and loses nothing', () => {
    const text = '# Title\n\npara one\nstill one\n\n- a\n- b\n\nlast';
    expect(splitMarkdownBlocks(text)).toHaveLength(4);
    expect(rejoin(text)).toBe(text);
  });

  it('never splits inside a fenced code block, even across blank lines', () => {
    const text = 'before\n\n```ts\nconst a = 1;\n\nconst b = 2;\n```\n\nafter';
    const blocks = splitMarkdownBlocks(text);
    expect(blocks.some((block) => block.includes('const a = 1;') && block.includes('const b = 2;'))).toBe(true);
    expect(rejoin(text)).toBe(text);
  });

  it('keeps an unclosed fence (a streaming message) in one block', () => {
    const text = 'intro\n\n```py\nprint(1)\n\nprint(2)';
    const blocks = splitMarkdownBlocks(text);
    expect(blocks[blocks.length - 1]).toContain('print(2)');
    expect(blocks[blocks.length - 1]).toContain('```py');
  });

  it('merges an indented continuation into the previous block', () => {
    const text = '1. item\n\n   continued paragraph\n\n2. next';
    expect(splitMarkdownBlocks(text)).toHaveLength(2);
    expect(rejoin(text)).toBe(text);
  });

  it('changes only the last block while a message streams', () => {
    const before = splitMarkdownBlocks('para one\n\npara two is gr');
    const after = splitMarkdownBlocks('para one\n\npara two is growing');
    expect(after[0]).toBe(before[0]);
    expect(after[1]).not.toBe(before[1]);
  });

  it('handles empty input', () => {
    expect(splitMarkdownBlocks('')).toEqual([]);
  });
});
