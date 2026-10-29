/**
 * Agent kits: the pure library layer (agent-model-kits AC-1..AC-7,
 * RV-P1-1, RV-P1-5, D-3, D-8, D-9).
 *
 * THE TWO CONTRADICTORY-LOOKING RULES ARE THE POINT OF THIS FILE: a kit's
 * STRUCTURE is validated (an object with a name and a main profile), while its
 * REFERENCES are not (a slot may name a profile that is gone). The second half is
 * what keeps one hand-edited `config.json` from taking the whole settings screen
 * down with it.
 */

import { describe, expect, it } from 'vitest';
import {
  KIT_LIMITS, createAgentKit, createKitFromCurrent, duplicateAgentKit, findKit,
  kitCandidate, kitMatches, kitSlotConnections, normalizeKits, validateKits,
  type AgentKit,
} from '../model/config/model-kits.js';
import {
  emptyModelProfiles, normalizeModelProfiles, removeModelProfile, validateModelProfiles,
  type ModelProfile, type ModelProfilesConfig,
} from '../model/config/model-profiles.js';
import { DEFAULT_CONFIG, type CliConfig } from '../model/config/schema.js';

const main: ModelProfile = { id: 'p-main', name: 'Opus', provider: 'anthropic',
  model: 'claude-opus-4-6', baseUrl: null, apiKey: null, contextWindow: 200000 };
const fast: ModelProfile = { id: 'p-fast', name: 'Haiku', provider: 'anthropic',
  model: 'claude-haiku-4-5', baseUrl: null, apiKey: null, contextWindow: 200000 };

const kit = (over: Partial<AgentKit> = {}): AgentKit => ({ id: 'kit-1', name: 'Deep work',
  mainProfileId: 'p-main', fastProfileId: 'p-fast',
  subagent: { model: 'fast', modelProfileId: null }, ...over });

const library = (kits: unknown[] = [kit()]): Record<string, unknown> => ({
  version: 1, entries: [main, fast], mainId: 'p-main', fastId: 'p-fast',
  kits, defaultKitId: 'kit-1', kitsVersion: 1,
});

describe('AC-1: kits are validated STRUCTURALLY, never by reference', () => {
  it('accepts a kit that points at a profile which does not exist', () => {
    // RV-P1-1: reference existence is a RESOLUTION-time concern, exactly as it is
    // for `team.modelProfileId`. A validator that disagreed would blank the whole
    // settings page for one hand-edited line.
    expect(validateModelProfiles(library([kit({ mainProfileId: 'nope' })]))).toEqual([]);
    expect(validateKits([kit({ fastProfileId: 'nope' })])).toEqual([]);
    expect(validateKits([kit({ subagent: { model: 'profile', modelProfileId: 'nope' } })]))
      .toEqual([]);
  });

  it('rejects the shapes a file cannot mean, with a path that names the row', () => {
    expect(validateKits('oops')[0]).toMatchObject({ path: 'modelProfiles.kits' });
    expect(validateKits(Array.from({ length: KIT_LIMITS.maxKits + 1 }, (_, index) =>
      kit({ id: `k${index}`, name: `k${index}` })))[0])
      .toMatchObject({ path: 'modelProfiles.kits' });
    expect(validateKits([kit({ name: 'x'.repeat(KIT_LIMITS.nameMaxChars + 1) })])[0])
      .toMatchObject({ path: 'modelProfiles.kits[0].name' });
    expect(validateKits([kit({ mainProfileId: '' })])[0])
      .toMatchObject({ path: 'modelProfiles.kits[0].mainProfileId' });
    expect(validateKits([kit({ id: 'same' }), kit({ id: 'same' })])[0])
      .toMatchObject({ path: 'modelProfiles.kits[1].id', code: 'duplicate_id' });
    expect(validateKits([kit({ subagent: { model: 'nope' as never, modelProfileId: null } })])[0])
      .toMatchObject({ path: 'modelProfiles.kits[0].subagent.model' });
  });

  it('treats a missing or empty kit list as valid (an older build wrote it)', () => {
    expect(validateKits(undefined)).toEqual([]);
    expect(validateKits(null)).toEqual([]);
    expect(validateKits([])).toEqual([]);
  });

  it('lets two kits share a name: duplicate names are legal (D-8/§6.6)', () => {
    expect(validateKits([kit({ id: 'a', name: 'Same' }), kit({ id: 'b', name: 'Same' })]))
      .toEqual([]);
  });
});

describe('AC-2 / AC-3 / AC-4: normalization round-trips and heals', () => {
  it('carries kits, the default pointer and the marker through a round trip', () => {
    const normalized = normalizeModelProfiles(library());
    expect(normalized.kits).toEqual([kit()]);
    expect(normalized.defaultKitId).toBe('kit-1');
    expect(normalized.kitsVersion).toBe(1);
    // TWICE, because a single write is not a round trip: the whitelist defect
    // (F-3/F-4) shows up on the SECOND normalization, after the first one dropped
    // a key it did not know.
    expect(normalizeModelProfiles(normalized)).toEqual(normalized);
  });

  it('heals a default pointer at a kit that is not there', () => {
    const normalized = normalizeModelProfiles({ ...library(), defaultKitId: 'gone' });
    expect(normalized.defaultKitId).toBeNull();
    expect(validateModelProfiles({ ...library(), defaultKitId: 'gone' })).toEqual([]);
  });

  it('forces subagent.modelProfileId to null unless the mode is profile (I-2)', () => {
    const normalized = normalizeKits([kit({ subagent: { model: 'main',
      modelProfileId: 'p-fast' } })]);
    expect(normalized.kits[0]!.subagent).toEqual({ model: 'main', modelProfileId: null });
  });

  it('normalizes kitsVersion to 1 whatever the file says (D-3 / RV-P1-5)', () => {
    for (const kitsVersion of [undefined, 0, 'two', 3.5, null]) {
      const normalized = normalizeModelProfiles({ ...library(), kitsVersion });
      expect(normalized.kitsVersion).toBe(1);
      // A KEY WITH NO FUNCTION MUST NOT CREATE A FAILURE PATH: a hand-edited
      // marker may not invalidate the library that holds the user's keys.
      expect(validateModelProfiles({ ...library(), kitsVersion })).toEqual([]);
    }
  });

  it('is TOTAL: no input to normalizeKits throws, and damage is counted', () => {
    const junk = [null, 'x', 42, { id: '' }, { id: 'a' }, kit({ name: '' }), kit()];
    const result = normalizeKits(junk, 'kit-1');
    expect(result.kits).toEqual([kit()]);
    expect(result.dropped).toBe(junk.length - 1);
    expect(normalizeKits('oops').kits).toEqual([]);
    expect(normalizeKits(undefined).kits).toEqual([]);
  });
});

describe('AC-5: create and duplicate', () => {
  it('creates a unique id and copies under a free name', () => {
    const created = createAgentKit({ name: 'Mine', mainProfileId: 'p-main',
      fastProfileId: null, subagent: { model: 'main', modelProfileId: null } });
    expect(created.id).toMatch(/[0-9a-f-]{36}/);
    expect(created.name).toBe('Mine');
    const copy = duplicateAgentKit(created, [created]);
    expect(copy.id).not.toBe(created.id);
    expect(copy.name).toBe('Mine (copy)');
    const second = duplicateAgentKit(created, [created, copy]);
    expect(second.name).toBe('Mine (copy 2)');
  });
});

describe('findKit / kitMatches: one parser for ctrl+K and /kit use', () => {
  const kits = [kit({ id: 'abcdef123456', name: 'Deep work' }),
    kit({ id: 'abcdef999999', name: 'Cheap' }), kit({ id: 'zz', name: 'Twin' }),
    kit({ id: 'yy', name: 'Twin' })];

  it('matches an exact id, an #prefix, or a unique name', () => {
    const lib = { ...emptyModelProfiles(), kits };
    expect(findKit(lib, 'zz')?.id).toBe('zz');
    expect(findKit(lib, '#abcdef1')?.id).toBe('abcdef123456');
    expect(findKit(lib, 'Deep work')?.id).toBe('abcdef123456');
  });

  it('refuses an ambiguous name or prefix instead of guessing', () => {
    const lib = { ...emptyModelProfiles(), kits };
    expect(findKit(lib, 'Twin')).toBeUndefined();
    expect(kitMatches(lib, 'Twin')).toHaveLength(2);
    expect(findKit(lib, '#abcdef')).toBeUndefined();
    expect(kitMatches(lib, '#abcdef')).toHaveLength(2);
  });

  it('returns nothing for a missing kit, an empty reference or no library', () => {
    expect(findKit(undefined, 'Deep work')).toBeUndefined();
    expect(findKit({ ...emptyModelProfiles(), kits }, '')).toBeUndefined();
    expect(findKit({ ...emptyModelProfiles(), kits }, 'Nope')).toBeUndefined();
  });
});

describe('kitSlotConnections: dereference, never throw (RV-P1-1 / I-8)', () => {
  const lib = { ...emptyModelProfiles(), entries: [main, fast],
    kits: [kit()] } as ModelProfilesConfig;

  it('dereferences all three slots', () => {
    const connections = kitSlotConnections(lib, kit());
    expect(connections.main).toMatchObject({ provider: 'anthropic', model: 'claude-opus-4-6',
      name: 'Opus' });
    expect(connections.fast).toMatchObject({ model: 'claude-haiku-4-5' });
    expect(connections.subagent).toMatchObject({ mode: 'fast', model: 'claude-haiku-4-5' });
  });

  it('reports a missing entry as null rather than throwing', () => {
    const gone = kitSlotConnections(lib, kit({ mainProfileId: 'nope' }));
    expect(gone.main).toBeNull();
    // The subagent slot follows its own mode: this kit asks for the fast tier, so
    // it stays resolvable even though MAIN is gone.
    expect(gone.subagent).toMatchObject({ mode: 'fast', name: 'Haiku' });
    const orphan = kitSlotConnections(lib, kit({ mainProfileId: 'nope',
      subagent: { model: 'profile', modelProfileId: 'nope' } }));
    expect(orphan.subagent).toMatchObject({ provider: null, name: null });
  });
});

describe('AC-6: kitCandidate is the ONE mapping to a config patch', () => {
  const lib = { ...emptyModelProfiles(), entries: [main, fast], mainId: 'p-main',
    fastId: 'p-fast', kits: [kit()] } as ModelProfilesConfig;

  it('binds the three roles and turns the tier off for a fast-off kit', () => {
    const off = kitCandidate({ library: lib, kit: kit({ fastProfileId: null }) });
    expect(off.modelProfiles.mainId).toBe('p-main');
    expect(off.modelProfiles.fastId).toBeNull();
    expect(off.fast).toEqual({ enabled: false });
    expect(off.team).toEqual({ model: 'fast', modelProfileId: null });
  });

  it('moves the default pointer ONLY when one is passed', () => {
    const withDefault = { ...lib, defaultKitId: 'kit-1' };
    expect(kitCandidate({ library: withDefault, kit: kit() }).modelProfiles.defaultKitId)
      .toBe('kit-1');
    expect(kitCandidate({ library: withDefault, kit: kit(), defaultKitId: 'other' })
      .modelProfiles.defaultKitId).toBe('other');
    expect(kitCandidate({ library: withDefault, kit: kit(), defaultKitId: null })
      .modelProfiles.defaultKitId).toBeNull();
  });

  it('keeps team.modelProfileId null for non-profile modes (I-2)', () => {
    const candidate = kitCandidate({ library: lib, kit: kit({ subagent: { model: 'profile',
      modelProfileId: 'p-fast' } }) });
    expect(candidate.team).toEqual({ model: 'profile', modelProfileId: 'p-fast' });
  });
});

describe('D-9: the library refuses to orphan a kit silently', () => {
  it('names the kits that reference the entry it will not remove', () => {
    const lib = normalizeModelProfiles(library());
    expect(() => removeModelProfile(lib, 'p-main')).toThrow(/still in use/i);
    const unbound = { ...lib, mainId: null };
    expect(() => removeModelProfile(unbound, 'p-main')).toThrow(/kit "Deep work"/);
  });

  it('removes an entry no kit and no binding names', () => {
    const lib = normalizeModelProfiles({ ...library(), mainId: 'p-fast',
      kits: [] as unknown[] });
    expect(removeModelProfile(lib, 'p-main').entries.map((entry) => entry.id))
      .toEqual(['p-fast']);
  });
});

describe('createKitFromCurrent: the first kit is never a blank form (D-13)', () => {
  const config = (): CliConfig => ({
    ...structuredClone(DEFAULT_CONFIG),
    modelProfiles: { version: 1, entries: [main, fast], mainId: 'p-main', fastId: 'p-fast' },
    // The tier must be ON for a fast slot to have anything to prefill: an off
    // tier whose endpoint is pre-populated would silently turn back on at Save.
    fast: { ...DEFAULT_CONFIG.fast, enabled: true },
    team: { ...DEFAULT_CONFIG.team, model: 'fast' },
  }) as unknown as CliConfig;

  it('prefills the three bindings this machine already runs', () => {
    const prefilled = createKitFromCurrent({ config: config() });
    expect(prefilled.mainProfileId).toBe('p-main');
    expect(prefilled.fastProfileId).toBe('p-fast');
    expect(prefilled.subagent.model).toBe('fast');
    expect(prefilled.name).toBe('My setup');
  });

  it('prefills fast as OFF when the tier is off, whatever the binding says', () => {
    const off = { ...config(), fast: { ...DEFAULT_CONFIG.fast, enabled: false } } as CliConfig;
    expect(createKitFromCurrent({ config: off }).fastProfileId).toBeNull();
  });

  it('carries the subagent PROFILE, so the prefill cannot degrade it to main', () => {
    // I-2: mode `profile` with no id is the one kit shape that resolves to a
    // fallback. A prefill that dropped the id would therefore record a different
    // answer than the one the machine is actually running.
    const profiled = { ...config(),
      team: { ...DEFAULT_CONFIG.team, model: 'profile' as const, modelProfileId: 'p-fast' },
    } as CliConfig;
    expect(createKitFromCurrent({ config: profiled }).subagent)
      .toEqual({ model: 'profile', modelProfileId: 'p-fast' });
    expect(createKitFromCurrent({ config: config() }).subagent)
      .toEqual({ model: 'fast', modelProfileId: null });
  });
});
