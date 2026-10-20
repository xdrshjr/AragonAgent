/**
 * `kitCandidate` → disk, and back (agent-model-kits AC-6 / AC-7).
 *
 * THE ROUND TRIP IS THE ASSERTION THAT MATTERS: `mergePersistedConfig` clamps
 * through `clampTeamConfig` / `clampFastConfig`, and a clamp that turned an
 * explicit `null` into a default would make "this kit turns the fast tier off"
 * unsaveable - the value would survive the candidate and evaporate at the write.
 */

import { describe, expect, it } from 'vitest';
import { mergePersistedConfig } from '../config/store.js';
import { DEFAULT_CONFIG, type PersistedConfig } from '../config/schema.js';
import { emptyModelProfiles, normalizeModelProfiles } from '../config/model-profiles.js';
import { kitCandidate, type AgentKit } from '../config/model-kits.js';

const kit = (over: Partial<AgentKit> = {}): AgentKit => ({ id: 'kit-1', name: 'Deep work',
  mainProfileId: 'p-main', fastProfileId: 'p-fast',
  subagent: { model: 'fast', modelProfileId: null }, ...over });

const library = normalizeModelProfiles({ version: 1, mainId: 'p-main', fastId: 'p-fast',
  entries: [
    { id: 'p-main', name: 'Opus', provider: 'anthropic', model: 'claude-opus-4-6',
      baseUrl: null, apiKey: null, contextWindow: 200000 },
    { id: 'p-fast', name: 'Haiku', provider: 'anthropic', model: 'claude-haiku-4-5',
      baseUrl: null, apiKey: null, contextWindow: 200000 },
  ],
  kits: [kit()], defaultKitId: 'kit-1', kitsVersion: 1 });

const disk = (): PersistedConfig => ({ ...structuredClone(DEFAULT_CONFIG),
  modelProfiles: structuredClone(library) });

describe('AC-6: the one mapping from a kit to a patch', () => {
  it('binds main and fast and switches the tier with the fast slot', () => {
    const bound = kitCandidate({ library, kit: kit() });
    expect(bound.modelProfiles.mainId).toBe('p-main');
    expect(bound.modelProfiles.fastId).toBe('p-fast');
    expect(bound.fast).toEqual({ enabled: true });
    const off = kitCandidate({ library, kit: kit({ fastProfileId: null }) });
    expect(off.modelProfiles.fastId).toBeNull();
    expect(off.fast).toEqual({ enabled: false });
  });

  it('never rewrites the entries it references (D-1: references, not copies)', () => {
    const candidate = kitCandidate({ library, kit: kit() });
    expect(candidate.modelProfiles.entries).toBe(library.entries);
  });
});

describe('AC-7: the patch survives the clamp that writes it', () => {
  it('keeps team.model and an explicit null modelProfileId', () => {
    const merged = mergePersistedConfig(disk(),
      kitCandidate({ library, kit: kit({ subagent: { model: 'main', modelProfileId: null } }) }));
    expect(merged.team.model).toBe('main');
    expect(merged.team.modelProfileId).toBeNull();
    expect(merged.modelProfiles?.fastId).toBe('p-fast');
  });

  it('keeps a fast-off kit off, including the explicit fastId null', () => {
    const merged = mergePersistedConfig(disk(),
      kitCandidate({ library, kit: kit({ fastProfileId: null }) }));
    expect(merged.fast.enabled).toBe(false);
    expect(merged.modelProfiles?.fastId).toBeNull();
    expect(normalizeModelProfiles(merged.modelProfiles).fastId).toBeNull();
  });

  it('carries the three kit keys through a write and a re-normalize (F-3/F-4)', () => {
    const merged = mergePersistedConfig(disk(),
      kitCandidate({ library, kit: kit(), defaultKitId: 'kit-1' }));
    const reread = normalizeModelProfiles(merged.modelProfiles);
    expect(reread.kits).toEqual([kit()]);
    expect(reread.defaultKitId).toBe('kit-1');
    expect(reread.kitsVersion).toBe(1);
  });

  it('leaves a library with no kits exactly empty rather than inventing one', () => {
    const empty = { ...disk(), modelProfiles: emptyModelProfiles() };
    const merged = mergePersistedConfig(empty, { thinkingLevel: 'high' });
    expect(merged.modelProfiles?.kits).toEqual([]);
    expect(merged.modelProfiles?.defaultKitId).toBeNull();
  });
});
