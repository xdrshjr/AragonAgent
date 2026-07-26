import { describe, expect, it } from 'vitest';
import { parseFrontmatter } from '../frontmatter.js';
import { FRONTMATTER_MAX_LINES } from '../constants.js';

describe('parseFrontmatter (§4.3 rules)', () => {
  it('rule 1: strips a BOM and normalizes CRLF', () => {
    const src = '﻿---\r\nname: pdf-forms\r\ndescription: Fill PDFs\r\n---\r\n\r\n# Body\r\n';
    const parsed = parseFrontmatter(src);
    expect(parsed).not.toBeNull();
    expect(parsed!.data.name).toBe('pdf-forms');
    expect(parsed!.data.description).toBe('Fill PDFs');
    expect(parsed!.body).toBe('# Body\n');
  });

  it('rule 2: no opening delimiter returns null (not an exception)', () => {
    expect(parseFrontmatter('# Just markdown\n')).toBeNull();
  });

  it('rule 2: an unterminated block returns null', () => {
    expect(parseFrontmatter('---\nname: x\nstill going\n')).toBeNull();
  });

  it('rule 2: leading blank lines before --- are tolerated, and ... closes', () => {
    const parsed = parseFrontmatter('\n\n---\nname: x\n...\nbody');
    expect(parsed?.data.name).toBe('x');
    expect(parsed?.body).toBe('body');
  });

  it('rule 3: an invalid key is recorded and skipped', () => {
    const parsed = parseFrontmatter('---\nname: x\nbad key!: y\n---\n');
    expect(parsed!.data['bad key!']).toBeUndefined();
    expect(parsed!.errors.join(' ')).toMatch(/invalid key/);
  });

  it('rule 4b: inline arrays split on commas and dequote', () => {
    const parsed = parseFrontmatter('---\nkeywords: [pdf, forms, "acro form"]\n---\n');
    expect(parsed!.data.keywords).toEqual(['pdf', 'forms', 'acro form']);
  });

  it('rule 4a: block arrays collect indented "- " items', () => {
    const parsed = parseFrontmatter('---\nallowed-tools:\n  - read_file\n  - bash\nname: x\n---\n');
    expect(parsed!.data['allowed-tools']).toEqual(['read_file', 'bash']);
    expect(parsed!.data.name).toBe('x');
  });

  it('rule 4c: quotes are removed, honouring \\" and \\\\', () => {
    const parsed = parseFrontmatter('---\na: "say \\"hi\\""\nb: \'plain\'\nc: "back\\\\slash"\n---\n');
    expect(parsed!.data.a).toBe('say "hi"');
    expect(parsed!.data.b).toBe('plain');
    expect(parsed!.data.c).toBe('back\\slash');
  });

  it('rule 5: # comments strip, but a URL fragment survives', () => {
    const parsed = parseFrontmatter(
      '---\nhomepage: https://example.com/x#v1.2.0\nname: x # trailing note\n---\n',
    );
    expect(parsed!.data.homepage).toBe('https://example.com/x#v1.2.0');
    expect(parsed!.data.name).toBe('x');
  });

  it('rule 5: a # inside a quoted value is not a comment', () => {
    const parsed = parseFrontmatter('---\ndescription: "uses # for headings"\n---\n');
    expect(parsed!.data.description).toBe('uses # for headings');
  });

  it('rule 6: tab indentation lands in errors and the line is skipped', () => {
    const parsed = parseFrontmatter('---\nname: x\n\tnope: y\n---\n');
    expect(parsed!.errors.join(' ')).toMatch(/tab indentation/);
    expect(parsed!.data.nope).toBeUndefined();
  });

  it('rule 7: a duplicate key keeps the last value and records a warning', () => {
    const parsed = parseFrontmatter('---\nname: first\nname: second\n---\n');
    expect(parsed!.data.name).toBe('second');
    expect(parsed!.errors.join(' ')).toMatch(/duplicate key "name"/);
  });

  it('rule 8: a block over the line limit returns null', () => {
    const many = Array.from({ length: FRONTMATTER_MAX_LINES + 1 }, (_, i) => `k${i}: v`).join('\n');
    expect(parseFrontmatter(`---\n${many}\n---\n`)).toBeNull();
  });

  it('rule 8: a block over the byte limit returns null', () => {
    const huge = `name: ${'x'.repeat(9000)}`;
    expect(parseFrontmatter(`---\n${huge}\n---\n`)).toBeNull();
  });

  it('an empty value with no list behind it stays a scalar, but [] stays an array', () => {
    const parsed = parseFrontmatter('---\nauthor:\nkeywords: []\n---\n');
    expect(parsed!.data.author).toBe('');
    expect(parsed!.data.keywords).toEqual([]);
  });

  it('unknown keys are preserved verbatim (forward compat, D9)', () => {
    const parsed = parseFrontmatter('---\nname: x\nfuture-anthropic-key: hello\n---\n');
    expect(parsed!.data['future-anthropic-key']).toBe('hello');
  });
});
