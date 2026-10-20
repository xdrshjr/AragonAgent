import { describe, expect, it } from 'vitest';
import stringWidth from 'string-width';
import {
  formatTable,
  isRule,
  isTableDivider,
  parseHeading,
  parseInline,
  parseMarkdownBlocks,
  parseTableRow,
  tableAlignments,
} from '../ui/markdown-blocks.js';

describe('parseHeading', () => {
  it('reports the level so the six tiers can render differently', () => {
    // All six used to render as an identical bold+primary line, which made an
    // answer's structure invisible.
    expect(parseHeading('# One')).toEqual({ kind: 'heading', level: 1, text: 'One' });
    expect(parseHeading('### Three')).toEqual({ kind: 'heading', level: 3, text: 'Three' });
    expect(parseHeading('###### Six')?.level).toBe(6);
  });

  it('is not fooled by things that merely start with #', () => {
    expect(parseHeading('#nospace')).toBeNull();
    expect(parseHeading('####### seven hashes')).toBeNull();
    expect(parseHeading('text # mid')).toBeNull();
  });
});

describe('isRule', () => {
  it('accepts the three thematic-break spellings', () => {
    expect(isRule('---')).toBe(true);
    expect(isRule('***')).toBe(true);
    expect(isRule('___')).toBe(true);
    expect(isRule('  -----  ')).toBe(true);
  });

  it('rejects a setext underline or a list item', () => {
    expect(isRule('--')).toBe(false);
    expect(isRule('- item')).toBe(false);
    expect(isRule('*** bold')).toBe(false);
  });
});

describe('tables', () => {
  it('recognises a header row followed by a divider', () => {
    expect(parseTableRow('| a | b |')).toEqual(['a', 'b']);
    expect(isTableDivider('|---|---|')).toBe(true);
    expect(isTableDivider('|:--|--:|')).toBe(true);
    expect(isTableDivider('| a | b |')).toBe(false);
    expect(parseTableRow('no pipes here')).toBeNull();
  });

  it('reads the alignment markers', () => {
    expect(tableAlignments('|:--|--:|:-:|')).toEqual(['left', 'right', 'center']);
  });

  it('aligns columns AND draws the header rule and column separators', () => {
    // A bare two-space join left a table with no visible structure at all, and
    // the `|---|` divider was consumed by the parser to read alignment, so it
    // never rendered. Both halves are restored here: the returned array is
    // [header, divider, ...body], index 0 header and index 1 divider.
    const out = formatTable(
      [
        ['name', 'qty'],
        ['apples', '3'],
      ],
      ['left', 'right'],
    );
    expect(out).toHaveLength(3);
    expect(out[0]).toBe('name   | qty');
    expect(out[1]).toBe('------ | ---');
    expect(out[2]).toBe('apples |   3');
    // The separators are the point: a --no-color tier has no bold to fall back on.
    expect(out.every((r) => r.includes('|'))).toBe(true);
  });

  it('takes the separator and the rule from the caller (no glyph is hardcoded)', () => {
    // `markdown-blocks.ts` is inside the ASCII-only scan, so the renderer has to
    // inject `glyphs.railVertical` / `glyphs.hrule`; the defaults stay ASCII.
    const out = formatTable([['a', 'b'], ['c', 'd']], ['left'], {
      separator: '#',
      rule: '=',
    });
    expect(out).toEqual(['a # b', '= # =', 'c # d']);
  });

  it('pads by display width, so a double-width cell still lines up', () => {
    // `品` is one UTF-16 code unit but two terminal columns. Padding by
    // `.length` shifted every column after it by one cell.
    const out = formatTable(
      [
        ['品', 'qty'],
        ['apples', '3'],
      ],
      ['left', 'left'],
    );
    expect(out[0]).toBe(`品${' '.repeat(4)} | qty`);
    expect(out[1]).toBe('------ | ---');
    // The separator must land on the same terminal column in every row: counted
    // in code units the CJK row's pipe is one column early, which is the bug.
    const separatorColumn = (row: string): number => stringWidth(row.slice(0, row.indexOf('|')));
    expect(separatorColumn(out[0])).toBe(7);
    expect(separatorColumn(out[2])).toBe(7);
    expect(stringWidth(out[0])).toBe(stringWidth(out[1]));
  });

  it('survives a ragged table without throwing', () => {
    const out = formatTable([['a', 'b', 'c'], ['x']], ['left']);
    expect(out).toHaveLength(3);
    expect(out[2]).toBe('x');
  });
});

describe('parseMarkdownBlocks fences', () => {
  const codeBlocks = (text: string) =>
    parseMarkdownBlocks(text).filter((b) => b.kind === 'code');

  it('opens a block for an info string with symbols in it', () => {
    // `(\w*)` rejected both of these, so the body degraded to prose and the
    // closing fence was swallowed as a new, empty code block.
    expect(codeBlocks('```c++\nint x;\n```')).toEqual([
      { kind: 'code', code: 'int x;', lang: 'c++' },
    ]);
    expect(codeBlocks('```objective-c\n[x doIt];\n```')).toEqual([
      { kind: 'code', code: '[x doIt];', lang: 'objective-c' },
    ]);
  });

  it('reports the FIRST token of the info string as the language', () => {
    expect(codeBlocks('```ts title="a.ts"\nconst a = 1;\n```')[0]).toMatchObject({
      lang: 'ts',
    });
  });

  it('accepts a fence of four backticks and lets it contain three-backtick lines', () => {
    // The only way to show a fenced block inside a fenced block.
    const text = '````md\n```ts\ninner\n```\n````';
    expect(codeBlocks(text)).toEqual([
      { kind: 'code', code: '```ts\ninner\n```', lang: 'md' },
    ]);
  });

  it('does not end a block on a closing run shorter than the opener', () => {
    // A three-backtick line cannot close a four-backtick fence: it is content.
    const blocks = parseMarkdownBlocks('````md\nline one\n```\nline two\n````');
    expect(blocks).toEqual([
      { kind: 'code', code: 'line one\n```\nline two', lang: 'md' },
    ]);
  });

  it('splits a CRLF document without leaving a carriage return in the code', () => {
    const blocks = parseMarkdownBlocks('```ts\r\nconst a = 1;\r\nconst b = 2;\r\n```\r\n');
    expect(blocks[0]).toEqual({ kind: 'code', code: 'const a = 1;\nconst b = 2;', lang: 'ts' });
    expect(blocks.some((b) => b.kind === 'code' && b.code.includes('\r'))).toBe(false);
    // The same split feeds the table parser, which needs a divider on the very
    // next line to see a header at all.
    expect(parseMarkdownBlocks('| a | b |\r\n| --- | --- |\r\n| 1 | 2 |')).toEqual([
      { kind: 'table', rows: [['a', 'b'], ['1', '2']], align: ['left', 'left'] },
    ]);
  });
});

describe('parseInline (two-pass, §4.7)', () => {
  it('handles emphasis wrapped around inline code', () => {
    // The old single alternating regex matched neither branch here and rendered
    // the asterisks literally.
    expect(parseInline('**bold with `code` inside**')).toEqual([
      { kind: 'text', text: '**bold with ' },
      { kind: 'code', text: 'code' },
      { kind: 'text', text: ' inside**' },
    ]);
  });

  it('leaves asterisks inside a code span literal', () => {
    // A shell snippet like `rm *.log` must not turn into italics.
    expect(parseInline('run `rm *.log` now')).toEqual([
      { kind: 'text', text: 'run ' },
      { kind: 'code', text: 'rm *.log' },
      { kind: 'text', text: ' now' },
    ]);
  });

  it('parses bold, italic and strikethrough outside code', () => {
    expect(parseInline('**b** and *i* and ~~s~~')).toEqual([
      { kind: 'bold', text: 'b' },
      { kind: 'text', text: ' and ' },
      { kind: 'italic', text: 'i' },
      { kind: 'text', text: ' and ' },
      { kind: 'strike', text: 's' },
    ]);
  });

  it('returns plain text unchanged and never loses characters', () => {
    for (const input of [
      'nothing special',
      '',
      'a `b` c **d** e ~~f~~ g',
      '**unclosed',
      '`unclosed',
      '*a* *b* *c*',
    ]) {
      const rebuilt = parseInline(input)
        .map((s) => {
          switch (s.kind) {
            case 'code':
              return `\`${s.text}\``;
            case 'bold':
              return `**${s.text}**`;
            case 'italic':
              return `*${s.text}*`;
            case 'strike':
              return `~~${s.text}~~`;
            default:
              return s.text;
          }
        })
        .join('');
      expect(rebuilt, JSON.stringify(input)).toBe(input);
    }
  });

  it('is re-runnable (the module-level regexes do not leak lastIndex)', () => {
    const input = 'a `b` **c**';
    expect(parseInline(input)).toEqual(parseInline(input));
    expect(parseInline(input)).toEqual(parseInline(input));
  });
});
