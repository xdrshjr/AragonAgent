/**
 * The turn-scoped tool ceiling (spec §5) — resolution, decision, verdict.
 *
 * The cases worth staring at are the ones about the DIRECTION of failure:
 * a declaration this host cannot read must widen, never narrow (D-G4), and the
 * permitted set must never come back empty (I-G1 / I-G2). Both failure modes are
 * silent in production and catastrophic when they happen, which is why they are
 * pinned here rather than argued about in a comment.
 */

import { describe, expect, it } from 'vitest';
import {
  SKILL_TOOL_ALIASES,
  SKILL_TOOL_KNOWN_ABSENT,
  computeToolPolicy,
  evaluateToolCall,
  normalizeToolAlias,
  renderDenyEscalation,
  resolveDeclaredTool,
} from '../tool-policy.js';
import { makeRecord } from './fixtures.js';
import type { SkillToolPolicyMode } from '../types.js';

const HOST = ['read_file', 'write_file', 'edit_file', 'list_dir', 'glob', 'grep', 'bash', 'skill', 'skill_find', 'skill_install', 'skill_create'];
const FLOOR = ['read_file', 'list_dir', 'glob', 'grep', 'skill', 'skill_find'];

function decide(
  frame: ReturnType<typeof makeRecord>[],
  mode: SkillToolPolicyMode = 'enforce',
  registered: string[] = HOST,
): ReturnType<typeof computeToolPolicy> {
  return computeToolPolicy({
    frame,
    registered,
    floor: FLOOR.filter((f) => registered.includes(f)),
    mode,
  });
}

describe('normalizeToolAlias / resolveDeclaredTool (§5.3)', () => {
  it('normalizes case, underscores, dashes and spaces', () => {
    expect(normalizeToolAlias('Read')).toBe('read');
    expect(normalizeToolAlias('read_file')).toBe('readfile');
    expect(normalizeToolAlias('Str-Replace Editor')).toBe('strreplaceeditor');
  });

  it('resolves an exact registered name before anything else', () => {
    // The first step exists so a host that adds a tool needs no table edit.
    expect(resolveDeclaredTool('read_file', HOST)).toBe('read_file');
    expect(resolveDeclaredTool('some_future_tool', [...HOST, 'some_future_tool'])).toBe(
      'some_future_tool',
    );
  });

  it('maps the Claude Code vocabulary onto this host (AC-G4 / FG2)', () => {
    expect(resolveDeclaredTool('Read', HOST)).toBe('read_file');
    expect(resolveDeclaredTool('Write', HOST)).toBe('write_file');
    expect(resolveDeclaredTool('MultiEdit', HOST)).toBe('edit_file');
    expect(resolveDeclaredTool('Bash', HOST)).toBe('bash');
    expect(resolveDeclaredTool('LS', HOST)).toBe('list_dir');
  });

  it("drops tools this host simply does not have, rather than calling them unknown (D-G5)", () => {
    expect(resolveDeclaredTool('WebFetch', HOST)).toBe('absent');
    expect(resolveDeclaredTool('Task', HOST)).toBe('absent');
    expect(resolveDeclaredTool('TodoWrite', HOST)).toBe('absent');
  });

  it('returns null for a typo', () => {
    expect(resolveDeclaredTool('Reed', HOST)).toBeNull();
    expect(resolveDeclaredTool('', HOST)).toBeNull();
    expect(resolveDeclaredTool('   ', HOST)).toBeNull();
  });

  it('an alias whose target is not registered is a MISS, not a drop', () => {
    // Silently dropping it would narrow the author's declaration to the subset
    // we happened to understand — the very thing D-G4 exists to prevent.
    expect(resolveDeclaredTool('Bash', ['read_file'])).toBeNull();
  });

  it('the alias table wins over the absent table (step 2 before step 3)', () => {
    // Pinned so that mistakenly adding a real host tool to the absent set could
    // never silently downgrade every skill that declares it.
    for (const key of Object.keys(SKILL_TOOL_ALIASES)) {
      expect(SKILL_TOOL_KNOWN_ABSENT.has(key)).toBe(false);
    }
  });
});

describe('computeToolPolicy (§5.2)', () => {
  it('off short-circuits without touching the frame (AC-G8)', () => {
    // Asserted through a frame that would THROW if it were read, so this cannot
    // pass by accident on a decision that merely happens to be null.
    const exploding = new Proxy([] as never[], {
      get(target, prop) {
        if (prop === Symbol.iterator || prop === 'length') throw new Error('frame was read');
        return Reflect.get(target, prop);
      },
    });
    const decision = computeToolPolicy({
      frame: exploding,
      registered: HOST,
      floor: FLOOR,
      mode: 'off',
    });
    expect(decision.allowed).toBeNull();
  });

  it('an empty frame imposes no ceiling', () => {
    expect(decide([]).allowed).toBeNull();
  });

  it('a skill that declares nothing is not a source and lifts nothing (AC-G6)', () => {
    const decision = decide([
      makeRecord({ name: 'a', allowedTools: ['read_file'] }),
      makeRecord({ name: 'b' }),
    ]);
    expect(decision.sourceNames).toEqual(['a']);
    expect(decision.allowed?.has('read_file')).toBe(true);
    expect(decision.allowed?.has('bash')).toBe(false);
  });

  it('unions the declarations of every frame member (D-G6 / AC-G6)', () => {
    const decision = decide([
      makeRecord({ name: 'a', allowedTools: ['read_file'] }),
      makeRecord({ name: 'b', allowedTools: ['bash'] }),
    ]);
    expect(decision.sourceNames).toEqual(['a', 'b']);
    expect(decision.allowed?.has('bash')).toBe(true);
    expect(decision.allowed?.has('write_file')).toBe(false);
  });

  it('always adds the floor, so read-only work never trips (D-G6 / AC-G2)', () => {
    const decision = decide([makeRecord({ name: 'a', allowedTools: ['write_file'] })]);
    for (const tool of FLOOR) expect(decision.allowed?.has(tool)).toBe(true);
  });

  it('waives a skill ENTIRELY when any declared name is unresolvable (D-G4 / AC-G5)', () => {
    const decision = decide([makeRecord({ name: 'a', allowedTools: ['read_file', 'Reed'] })]);
    // Not "the half we understood" — honouring `read_file` alone would enforce a
    // restriction the author never wrote and give no clue where it came from.
    expect(decision.allowed).toBeNull();
    expect(decision.ignored).toEqual([{ name: 'a', unresolved: ['Reed'] }]);
  });

  it('a waived skill does not lift a healthy one', () => {
    const decision = decide([
      makeRecord({ name: 'broken', allowedTools: ['Reed'] }),
      makeRecord({ name: 'good', allowedTools: ['read_file'] }),
    ]);
    expect(decision.allowed).not.toBeNull();
    expect(decision.sourceNames).toEqual(['good']);
    expect(decision.ignored.map((i) => i.name)).toEqual(['broken']);
  });

  it('keeps the ceiling when a declaration merely names an absent tool (AC-G5)', () => {
    const decision = decide([makeRecord({ name: 'a', allowedTools: ['Read', 'WebFetch'] })]);
    expect(decision.allowed?.has('read_file')).toBe(true);
    expect(decision.allowed?.has('bash')).toBe(false);
    expect(decision.ignored).toEqual([]);
  });

  it('skips disabled, invalid and activation: always records (AC-G7)', () => {
    const decision = decide([
      makeRecord({ name: 'off', allowedTools: ['read_file'], disabled: true }),
      makeRecord({ name: 'bad', allowedTools: ['read_file'], invalid: true }),
      makeRecord({ name: 'ambient', allowedTools: ['read_file'], activation: 'always' }),
    ]);
    expect(decision.allowed).toBeNull();
  });

  it('sources are sorted and carry the raw declaration verbatim (C1)', () => {
    const decision = decide([
      makeRecord({ name: 'zed', allowedTools: ['Bash'] }),
      makeRecord({ name: 'alpha', allowedTools: ['Read', 'WebFetch'] }),
    ]);
    expect(decision.sources.map((s) => s.name)).toEqual(['alpha', 'zed']);
    // `declared` is what the author typed; `granted` is what it resolved to.
    expect(decision.sources[0]!.declared).toEqual(['Read', 'WebFetch']);
    expect(decision.sources[0]!.granted).toEqual(['read_file']);
  });
});

describe('invariants I-G1 / I-G2 (AC-G23, evaluated P1-10)', () => {
  it('I-G1: no registered tools means NO ceiling, never an empty one', () => {
    // Reachable for real: `toolNames()` returns [] while the controller is still
    // being constructed. An empty permitted set there would lock the agent out
    // of every tool it has, for a reason nobody could deduce.
    const decision = computeToolPolicy({
      frame: [makeRecord({ name: 'a', allowedTools: ['read_file'] })],
      registered: [],
      floor: [],
      mode: 'enforce',
    });
    expect(decision.allowed).toBeNull();
    expect(decision.allowed).not.toEqual(new Set());
  });

  it('I-G2: a non-null ceiling always contains floor ∩ registered and is never empty', () => {
    const cases = [
      decide([makeRecord({ name: 'a', allowedTools: ['bash'] })]),
      decide([makeRecord({ name: 'a', allowedTools: ['Read'] })]),
      decide([makeRecord({ name: 'a', allowedTools: ['read_file'] })], 'warn'),
      // Floor mostly missing from the host: still non-empty, still a superset of
      // whatever floor DOES exist.
      computeToolPolicy({
        frame: [makeRecord({ name: 'a', allowedTools: ['bash'] })],
        registered: ['bash', 'read_file'],
        floor: ['read_file'],
        mode: 'enforce',
      }),
    ];
    for (const decision of cases) {
      if (decision.allowed === null) continue;
      expect(decision.allowed.size).toBeGreaterThan(0);
      expect(decision.allowed.has('read_file')).toBe(true);
    }
  });

  it('I-G2: a declaration of nothing but absent tools does not produce an empty set', () => {
    const decision = computeToolPolicy({
      frame: [makeRecord({ name: 'a', allowedTools: ['WebFetch'] })],
      registered: ['bash'],
      floor: [], // none of the floor is registered here
      mode: 'enforce',
    });
    expect(decision.allowed).toBeNull();
  });
});

describe('evaluateToolCall (§5.2)', () => {
  const decision = decide([makeRecord({ name: 'pdf-forms', allowedTools: ['read_file', 'write_file'] })]);

  it('permits anything inside the ceiling and everything when there is none', () => {
    expect(evaluateToolCall('read_file', decision).allow).toBe(true);
    expect(evaluateToolCall('write_file', decision).allow).toBe(true);
    expect(evaluateToolCall('skill', decision).allow).toBe(true);
    expect(evaluateToolCall('bash', decide([])).allow).toBe(true);
  });

  it('refuses with the documented five-line, actionable message (§5.2)', () => {
    const verdict = evaluateToolCall('bash', decision);
    expect(verdict.allow).toBe(false);
    expect(verdict.message).toBe(
      [
        'Tool "bash" is not permitted while skill "pdf-forms" is in effect.',
        '- "pdf-forms" declares allowed-tools: read_file, write_file',
        'Permitted right now: glob, grep, list_dir, read_file, skill, skill_find, write_file.',
        'Use one of those, or tell the user "bash" must be added to allowed-tools.',
        'Do not retry this tool for the rest of this turn.',
      ].join('\n'),
    );
  });

  it('names EVERY source when several are in the frame (C1)', () => {
    // Picking one would be wrong in some arrangement every time, and a
    // confidently wrong attribution is worse than a longer sentence.
    const multi = decide([
      makeRecord({ name: 'a', allowedTools: ['read_file'] }),
      makeRecord({ name: 'b', allowedTools: ['write_file'] }),
    ]);
    const verdict = evaluateToolCall('bash', multi);
    expect(verdict.message).toContain('while skills "a", "b" is in effect');
    expect(verdict.message).toContain('- "a" declares allowed-tools: read_file');
    expect(verdict.message).toContain('- "b" declares allowed-tools: write_file');
  });

  it('quotes the ORIGINAL declaration, not the mapped names', () => {
    // An author has to be able to find this word in the frontmatter they wrote.
    const claudeStyle = decide([makeRecord({ name: 'c', allowedTools: ['Read', 'WebFetch'] })]);
    const verdict = evaluateToolCall('bash', claudeStyle);
    expect(verdict.message).toContain('declares allowed-tools: Read, WebFetch');
  });

  it('warn passes the call through but still speaks up (AC-G8)', () => {
    const warned = decide([makeRecord({ name: 'a', allowedTools: ['read_file'] })], 'warn');
    const verdict = evaluateToolCall('bash', warned);
    expect(verdict.allow).toBe(true);
    expect(verdict.message).toBeUndefined();
    expect(verdict.notice).toContain('outside the tool ceiling');
  });

  it('the user-facing notice names the escape hatch', () => {
    // The command it names has to actually work mid-turn — see AC-G25.
    expect(evaluateToolCall('bash', decision).notice).toContain('/skills policy off');
  });

  it('the escalation line tells the model to stop rather than repeating itself', () => {
    expect(renderDenyEscalation('bash', 3)).toContain('refused "bash" 3 times this turn');
    expect(renderDenyEscalation('bash', 3)).toContain('Stop calling it');
  });
});
