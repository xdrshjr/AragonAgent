/**
 * AC-16 / D19 — every budget is UTF-8 BYTES, never `String.length`.
 *
 * The fixtures are pure CJK on purpose: with ASCII text the two units agree and
 * a regression to `String.length` would sail through. At 3 bytes per character
 * they diverge by 3x, which is exactly the gap that used to let a body sail past
 * `ToolExecutor`'s 100 000-byte ceiling and get its closing tag chopped off.
 */

import { describe, expect, it } from 'vitest';
import { ToolExecutor } from '../../tools/executor.js';
import { ToolRegistry } from '../../tools/registry.js';
import {
  byteLength,
  renderSkillBody,
  renderSkillCatalog,
  renderSkillInvocation,
  truncateToBytes,
} from '../disclosure.js';
import { createSkillTool } from '../skill-tool.js';
import { SkillRegistry } from '../skill-registry.js';
import {
  SKILL_BODY_MAX_BYTES,
  SKILL_CATALOG_MAX_BYTES,
  SKILL_DIGEST_MAX_BYTES,
  SKILL_INVOCATION_MAX_BYTES,
  SKILL_RESULT_MAX_BYTES,
} from '../constants.js';
import { makeRecord } from './fixtures.js';

/** `ToolExecutor`'s own ceiling — the thing our self-imposed cap must stay under. */
const EXECUTOR_MAX_OUTPUT_BYTES = 100_000;

const CJK_BODY = '中'.repeat(30_000); // 30 000 characters === 90 000 bytes

describe('truncateToBytes', () => {
  it('cuts on a byte budget without splitting a code point', () => {
    // 10 bytes into a stream of 3-byte characters lands mid-character.
    const out = truncateToBytes('中'.repeat(10), 10);
    expect(byteLength(out)).toBeLessThanOrEqual(10);
    expect(out).toBe('中中中');
    expect(out).not.toContain('�');
  });

  it('returns the input untouched when it already fits', () => {
    expect(truncateToBytes('abc', 100)).toBe('abc');
  });
});

describe('AC-16 — a 30 000-character CJK skill survives the executor intact', () => {
  const record = makeRecord({
    name: 'big',
    body: CJK_BODY,
    files: [{ path: 'reference/a.md', bytes: 1024 }],
  });

  it('renderSkillBody stays under the self-imposed result ceiling', () => {
    const out = renderSkillBody(record);
    expect(byteLength(out)).toBeLessThanOrEqual(SKILL_RESULT_MAX_BYTES);
  });

  it('both closing tags survive the byte reclaim', () => {
    const out = renderSkillBody(record);
    expect(out).toContain('</skill>');
    expect(out).toContain('</skill_files>');
    expect(out).not.toContain('�');
  });

  it('even the clamp upper bound (50 000) leaves headroom under the executor cap', () => {
    const out = renderSkillBody(record, { bodyMaxBytes: 50_000, resultMaxBytes: 60_000 });
    expect(byteLength(out)).toBeLessThan(EXECUTOR_MAX_OUTPUT_BYTES);
  });

  it('the real ToolExecutor does NOT append its truncation suffix', async () => {
    const registry = new SkillRegistry();
    registry.add(record);
    const tool = createSkillTool({
      registry,
      loadBody: () => ({ body: CJK_BODY, files: [{ path: 'reference/a.md', bytes: 1024 }] }),
    });

    const toolRegistry = new ToolRegistry();
    toolRegistry.register(tool);
    const executed = await new ToolExecutor(toolRegistry).execute('t1', 'skill', { name: 'big' });

    const text = executed.result.content.map((c) => (c.type === 'text' ? c.text : '')).join('');
    expect(text).not.toContain('... [truncated]');
    expect(text).toContain('</skill_files>');
    expect(Buffer.byteLength(text, 'utf-8')).toBeLessThanOrEqual(EXECUTOR_MAX_OUTPUT_BYTES);
  });

  it('the default body budget is enforced in bytes, not characters', () => {
    const out = renderSkillBody(record, { bodyMaxBytes: SKILL_BODY_MAX_BYTES });
    // 90 000 bytes of body cannot fit a 30 000-byte allowance.
    expect(out).toContain('[skill body truncated at');
  });
});

/**
 * W2 — the `/<skill-name>` path used to have NO budget whatsoever (FG3).
 *
 * The scanner accepts a 512 KB `SKILL.md`, so `/big-skill` submitted half a
 * megabyte as one user message while `skills.bodyMaxBytes` sat there being
 * silently ignored on the only delivery path a human triggers by hand.
 */
describe('renderSkillInvocation budget (§6 / AC-G9 / AC-G10)', () => {
  const huge = makeRecord({ name: 'big-skill', body: 'A'.repeat(400_000) });

  it('a 400 KB SKILL.md is capped, marked, and keeps its closing tag (AC-G9)', () => {
    const out = renderSkillInvocation(huge, '');
    expect(byteLength(out)).toBeLessThanOrEqual(SKILL_INVOCATION_MAX_BYTES);
    expect(out).toContain('skill body truncated at');
    expect(out).toContain('</skill>');
    expect(out.trimEnd().endsWith('The user invoked this skill directly. Follow its instructions for this request.')).toBe(true);
  });

  it('bodyMaxBytes now moves BOTH delivery paths together (AC-G10)', () => {
    const record = makeRecord({ name: 'x', body: 'B'.repeat(50_000) });
    const slash = renderSkillInvocation(record, '', { bodyMaxBytes: 1000 });
    const tool = renderSkillBody(record, { bodyMaxBytes: 1000 });
    for (const out of [slash, tool]) {
      expect(out).toContain('skill body truncated at 1000 bytes');
      expect(byteLength(out)).toBeLessThan(4000);
    }
  });

  it('substitutes arguments BEFORE truncating, so $ARGUMENTS never gets cut off', () => {
    // The other order silently drops the user's arguments whenever the
    // placeholder happens to sit past the cut.
    const record = makeRecord({ name: 'x', body: `$ARGUMENTS\n${'C'.repeat(50_000)}` });
    expect(renderSkillInvocation(record, 'invoice.pdf', { bodyMaxBytes: 200 })).toContain(
      'invoice.pdf',
    );
  });

  it('a CJK body keeps the closing tag under the invocation ceiling', () => {
    const cjk = makeRecord({ name: 'x', body: CJK_BODY });
    const out = renderSkillInvocation(cjk, '');
    expect(byteLength(out)).toBeLessThanOrEqual(SKILL_INVOCATION_MAX_BYTES);
    expect(out).toContain('</skill>');
  });
});

describe('digest ceiling (§7.2 / AC-G11)', () => {
  it('stays under SKILL_DIGEST_MAX_BYTES even with a huge body and 50 files', () => {
    const files = Array.from({ length: 50 }, (_, i) => ({
      path: `references/very-long-file-name-number-${i}.md`,
      bytes: 1000,
    }));
    const record = makeRecord({ name: 'x', body: CJK_BODY, files, description: '描述'.repeat(200) });
    const out = renderSkillBody(record, { mode: 'digest' });
    expect(byteLength(out)).toBeLessThanOrEqual(SKILL_DIGEST_MAX_BYTES);
    // Structure is never what gets sacrificed — file rows are.
    expect(out).toContain('</skill>');
    expect(out).toContain('body omitted');
  });

  it('is dramatically cheaper than the full body it replaces', () => {
    const record = makeRecord({ name: 'x', body: CJK_BODY });
    expect(byteLength(renderSkillBody(record, { mode: 'digest' }))).toBeLessThan(
      byteLength(renderSkillBody(record)) / 10,
    );
  });
});

describe('the catalog budget is bytes too', () => {
  it('a CJK catalog respects SKILL_CATALOG_MAX_BYTES', () => {
    const records = Array.from({ length: 60 }, (_, i) =>
      makeRecord({ name: `skill-${String(i).padStart(3, '0')}`, description: '描述'.repeat(100) }),
    );
    const out = renderSkillCatalog(records);
    expect(byteLength(out)).toBeLessThanOrEqual(SKILL_CATALOG_MAX_BYTES);
    expect(out).toContain('more skills not shown');
    expect(out.trimEnd().endsWith('</available_skills>')).toBe(true);
  });
});
