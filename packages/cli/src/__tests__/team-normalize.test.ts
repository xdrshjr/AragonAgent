import { describe, expect, it } from 'vitest';
import { normalizeSubagentSpecs } from '../team/normalize.js';
import { TEAM_LIMITS } from '../team/limits.js';

/**
 * `normalizeSubagentSpecs` is where every bound on a `task` call is actually
 * enforced (team-subagents §3.3.1). The schema declares SHAPE only, deliberately,
 * because `ajv` is an optional dependency of core and putting limits there would
 * make the behaviour depend on whether an optional install step succeeded.
 */
describe('normalizeSubagentSpecs', () => {
  const spec = (over: Record<string, unknown> = {}) => ({
    description: 'read the auth middleware',
    prompt: 'Read src/auth and report what you find.',
    ...over,
  });

  it('DROPS FIRST, CAPS SECOND', () => {
    // The ordering is the whole rule. Capping first would let the two blank
    // entries consume slots the model meant for real work, so the fan-out would
    // silently be narrower than the model believed and nothing would say so.
    const raw = [
      spec({ description: '' }),
      spec({ prompt: '   ' }),
      spec({ label: 'a' }),
      spec({ label: 'b' }),
      spec({ label: 'c' }),
    ];
    const { specs, requested } = normalizeSubagentSpecs(raw, 3);
    expect(requested).toBe(5);
    expect(specs.map((s) => s.label)).toEqual(['a', 'b', 'c']);
  });

  it('reports `requested` from the RAW length so the report can say "n of m"', () => {
    const raw = Array.from({ length: 30 }, (_, i) => spec({ label: `x${i}` }));
    const { specs, requested } = normalizeSubagentSpecs(raw, 5);
    expect(requested).toBe(30);
    expect(specs).toHaveLength(5);
  });

  it('enforces the hard ceiling of 10 even when the config asks for more (R-g)', () => {
    // The requirement caps the fan-out at 10. `clampTeamConfig` also enforces
    // it, and this second enforcement is what makes a hand-edited config file
    // unable to raise it.
    const raw = Array.from({ length: 40 }, (_, i) => spec({ label: `x${i}` }));
    expect(normalizeSubagentSpecs(raw, 40).specs).toHaveLength(TEAM_LIMITS.hardMaxSubagents);
    expect(normalizeSubagentSpecs(raw, 999).specs).toHaveLength(TEAM_LIMITS.hardMaxSubagents);
  });

  it('never returns fewer than one slot for a nonsensical max', () => {
    expect(normalizeSubagentSpecs([spec()], 0).specs).toHaveLength(1);
    expect(normalizeSubagentSpecs([spec()], -5).specs).toHaveLength(1);
    expect(normalizeSubagentSpecs([spec()], Number.NaN).specs).toHaveLength(1);
  });

  it('slugifies labels and defaults a missing one to its position', () => {
    const { specs } = normalizeSubagentSpecs(
      [spec({ label: 'Read The API!' }), spec({}), spec({ label: '   ' })],
      5,
    );
    expect(specs[0]!.label).toBe('read-the-api');
    expect(specs[1]!.label).toBe('a2');
    expect(specs[2]!.label).toBe('a3');
    for (const s of specs) expect(s.label.length).toBeLessThanOrEqual(TEAM_LIMITS.labelChars);
  });

  it('dedupes labels case-insensitively', () => {
    // The bus ADDRESSES children by label, so a duplicate is a correctness
    // problem rather than a cosmetic one: `team_send` would be ambiguous.
    const { specs } = normalizeSubagentSpecs(
      [spec({ label: 'api' }), spec({ label: 'API' }), spec({ label: 'api' })],
      5,
    );
    expect(specs.map((s) => s.label)).toEqual(['api', 'api-2', 'api-3']);
    expect(new Set(specs.map((s) => s.label.toLowerCase())).size).toBe(3);
  });

  it('clamps description and prompt rather than rejecting them', () => {
    const { specs } = normalizeSubagentSpecs(
      [spec({ description: 'd'.repeat(500), prompt: 'p'.repeat(20_000) })],
      5,
    );
    expect(specs[0]!.description).toHaveLength(TEAM_LIMITS.descriptionChars);
    expect(specs[0]!.prompt).toHaveLength(TEAM_LIMITS.promptChars);
  });

  it('defaults readOnly to false and only accepts a real boolean true', () => {
    const { specs } = normalizeSubagentSpecs(
      [spec({}), spec({ readOnly: true }), spec({ readOnly: 'yes' })],
      5,
    );
    expect(specs.map((s) => s.readOnly)).toEqual([false, true, false]);
  });

  it('returns zero survivors for junk rather than throwing', () => {
    // Zero survivors is the caller's ONE hard failure; everything else is
    // repaired. A throw here would surface as a tool crash rather than as a
    // message the model can act on.
    for (const junk of [undefined, null, 'nope', 42, {}, [], [null, 3, 'x'], [{}]]) {
      expect(() => normalizeSubagentSpecs(junk, 5)).not.toThrow();
      expect(normalizeSubagentSpecs(junk, 5).specs).toEqual([]);
    }
  });
});
