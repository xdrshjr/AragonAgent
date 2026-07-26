import { describe, expect, it } from 'vitest';
import {
  formatTable,
  isRule,
  isTableDivider,
  parseHeading,
  parseInline,
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

  it('pads columns to a common width without drawing borders', () => {
    // Borders inside an already-indented gutter wrap on any real terminal, so
    // the table is aligned text rather than a box.
    const out = formatTable(
      [
        ['name', 'qty'],
        ['apples', '3'],
      ],
      ['left', 'right'],
    );
    expect(out[0]).toBe('name    qty');
    expect(out[1]).toBe('apples    3');
    expect(out.every((r) => !r.includes('|'))).toBe(true);
  });

  it('survives a ragged table without throwing', () => {
    const out = formatTable([['a', 'b', 'c'], ['x']], ['left']);
    expect(out).toHaveLength(2);
    expect(out[1]).toBe('x');
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
