import { describe, expect, it, vi } from 'vitest';
import { createSkillTool } from '../skill-tool.js';
import { SkillRegistry } from '../skill-registry.js';
import { makeRecord } from './fixtures.js';

const textOf = (result: { content: Array<{ type: string; text?: string }> }): string =>
  result.content.map((c) => (c.type === 'text' ? c.text ?? '' : '')).join('');

function setup(records = [makeRecord({ name: 'pdf-forms', version: '1.2.0' })]) {
  const registry = new SkillRegistry();
  for (const r of records) registry.add(r);
  const loadBody = vi.fn(() => ({
    body: '# PDF Forms\n\nDo the thing.',
    files: [{ path: 'scripts/fill.py', bytes: 3174 }],
  }));
  return { registry, loadBody, tool: createSkillTool({ registry, loadBody }) };
}

describe('skill tool (Level 2)', () => {
  it('is named and labelled per D4', () => {
    const { tool } = setup();
    expect(tool.name).toBe('skill');
    expect(tool.label).toBe('Skill');
    expect(tool.parameters.required).toEqual(['name']);
  });

  it('returns the rendered body and marks the skill active', async () => {
    const { tool, registry } = setup();
    const out = textOf(await tool.execute('1', { name: 'pdf-forms' }, {}));
    expect(out).toContain('<skill name="pdf-forms" version="1.2.0"');
    expect(out).toContain('# PDF Forms');
    expect(out).toContain('scripts/fill.py (3.1 KB)');
    expect(registry.activeNames).toEqual(['pdf-forms']);
  });

  // W3 (AC-G11 / AC-G22): a repeat call used to re-send the entire body under a
  // one-line note that said re-reading was unnecessary. It now returns a digest.
  it('returns a digest on a repeat call instead of the whole body again', async () => {
    const { tool } = setup();
    await tool.execute('1', { name: 'pdf-forms' }, {});
    const second = textOf(await tool.execute('2', { name: 'pdf-forms' }, {}));
    expect(second).toContain('an earlier copy of this skill is above in this transcript');
    expect(second).toContain('body omitted');
    expect(second).not.toContain('# PDF Forms');
    // The two things the model still needs to keep working.
    expect(second).toContain('Does pdf-forms.');
    expect(second).toContain('scripts/fill.py');
  });

  it('passes arguments through', async () => {
    const { tool } = setup();
    const out = textOf(await tool.execute('1', { name: 'pdf-forms', arguments: 'a.pdf' }, {}));
    expect(out).toContain('<skill_arguments>\na.pdf\n</skill_arguments>');
  });

  it('error: unknown name suggests near misses', async () => {
    const { tool } = setup([
      makeRecord({ name: 'pdf-forms' }),
      makeRecord({ name: 'pdf-extract' }),
    ]);
    const result = await tool.execute('1', { name: 'pdf-form' }, {});
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('Unknown skill "pdf-form".');
    expect(textOf(result)).toContain('Did you mean:');
    expect(textOf(result)).toContain('Run /skills to list all.');
  });

  it('error: disabled', async () => {
    const { tool } = setup([makeRecord({ name: 'x', disabled: true })]);
    const result = await tool.execute('1', { name: 'x' }, {});
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('Skill "x" is disabled. Enable it with /skills enable x.');
  });

  it('error: invalid reports the failing code', async () => {
    const record = makeRecord({ name: 'x', invalid: true });
    record.issues = [{ level: 'error', code: 'SKILL_DESC_MISSING', message: 'description is required' }];
    const { tool } = setup([record]);
    const result = await tool.execute('1', { name: 'x' }, {});
    expect(textOf(result)).toContain('SKILL_DESC_MISSING - description is required');
  });

  it('error: a throwing loadBody becomes an errorResult — execute() never rejects (§5.2)', async () => {
    const registry = new SkillRegistry();
    registry.add(makeRecord({ name: 'x' }));
    const tool = createSkillTool({
      registry,
      loadBody: () => {
        throw new Error('EACCES: permission denied');
      },
    });
    const result = await tool.execute('1', { name: 'x' }, {});
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('Could not read SKILL.md for "x": EACCES: permission denied');
  });

  it('error: a missing name parameter is rejected without touching the host', async () => {
    const { tool, loadBody } = setup();
    const result = await tool.execute('1', {}, {});
    expect(result.isError).toBe(true);
    expect(loadBody).not.toHaveBeenCalled();
  });
});

describe('skill tool — frames, force and the policy snapshot (§7.1 / W1 / W3)', () => {
  it('enters the frame on a full load AND on a digest (§7.2)', async () => {
    // A repeat call is still the model saying "I am using this skill", so the
    // ceiling has to apply either way.
    const { tool, registry } = setup();
    await tool.execute('1', { name: 'pdf-forms' }, {});
    expect(registry.frameNames).toEqual(['pdf-forms']);

    registry.clearFrames();
    await tool.execute('2', { name: 'pdf-forms' }, {}); // digest path
    expect(registry.frameNames).toEqual(['pdf-forms']);
  });

  it('force=true re-sends the whole body even when already loaded (AC-G12)', async () => {
    const { tool } = setup();
    await tool.execute('1', { name: 'pdf-forms' }, {});
    const forced = textOf(await tool.execute('2', { name: 'pdf-forms', force: true }, {}));
    expect(forced).toContain('# PDF Forms');
    expect(forced).not.toContain('body omitted');
  });

  it('the digest names BOTH reasons to force, and never claims the copy is complete (AC-G22)', async () => {
    // The old wording promised "the full body is above in this transcript". W2
    // made that false for a routine path: `/big-skill` marks the skill active and
    // submits a body `bodyMaxBytes` may well have cut.
    const { tool } = setup();
    await tool.execute('1', { name: 'pdf-forms' }, {});
    const digest = textOf(await tool.execute('2', { name: 'pdf-forms' }, {}));
    expect(digest).not.toContain('the full body is above');
    expect(digest).toContain('or it was truncated');
    expect(digest).toContain('force=true');
  });

  it('takes the policy snapshot AFTER entering the frame (P1-3)', async () => {
    // Snapshotting first would render a permitted set missing the tools the
    // skill being loaded just granted — a wrong answer the model would act on.
    const registry = new SkillRegistry();
    registry.add(makeRecord({ name: 'pdf-forms', allowedTools: ['read_file'] }));
    const seen: string[][] = [];
    const tool = createSkillTool({
      registry,
      loadBody: () => ({ body: '# body', files: [] }),
      policySnapshot: () => {
        seen.push(registry.frameNames);
        return { mode: 'enforce', allowed: ['read_file', 'skill'] };
      },
    });
    const out = textOf(await tool.execute('1', { name: 'pdf-forms' }, {}));
    expect(seen).toEqual([['pdf-forms']]);
    expect(out).toContain('only these tools are permitted: read_file, skill');
  });

  it('renders no policy line at all when no snapshot port was injected (AC-G18)', async () => {
    const { tool } = setup([makeRecord({ name: 'pdf-forms', allowedTools: ['read_file'] })]);
    const out = textOf(await tool.execute('1', { name: 'pdf-forms' }, {}));
    expect(out).not.toContain('permitted');
    expect(out).not.toContain('declares it needs');
    expect(out).not.toContain('Suggested tools');
  });
});
