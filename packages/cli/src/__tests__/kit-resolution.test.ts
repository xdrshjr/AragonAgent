/**
 * Which kit is in effect, and how a session kit survives the two ways it can be
 * rebuilt (agent-model-kits AC-21 / AC-22 / AC-40, §4.3 / §4.8).
 *
 * `resolveActiveKit` is the ONE answer every surface reads, so its four shapes
 * (session / default / none x drifted or not) are asserted cell by cell here
 * rather than being re-derived in the chip, the root row and `/kit`.
 */

import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, type CliConfig } from '../config/schema.js';
import { normalizeModelProfiles } from '../config/model-profiles.js';
import { ALL_SLOTS, CURRENT_SETUP_NAME, applyHeldToLive, carrySessionKit,
  resolveActiveKit } from '../config/kit-resolution.js';
import type { AgentKit } from '../config/model-kits.js';

const kit = (over: Partial<AgentKit> = {}): AgentKit => ({ id: 'kit-1', name: 'Deep work',
  mainProfileId: 'p-main', fastProfileId: 'p-fast',
  subagent: { model: 'fast', modelProfileId: null }, ...over });

const library = normalizeModelProfiles({ version: 1, mainId: 'p-main', fastId: 'p-fast',
  entries: [
    { id: 'p-main', name: 'Opus', provider: 'anthropic', model: 'opus-4',
      baseUrl: null, apiKey: null, contextWindow: 200000 },
    { id: 'p-fast', name: 'Haiku', provider: 'anthropic', model: 'haiku-4',
      baseUrl: null, apiKey: null, contextWindow: 200000 },
  ],
  kits: [kit(), kit({ id: 'kit-2', name: 'Cheap', mainProfileId: 'p-fast' })],
  defaultKitId: 'kit-1', kitsVersion: 1 });

/** The live config a default kit produces: bindings AND projected connections. */
const config = (over: Partial<CliConfig> = {}): CliConfig => ({
  ...structuredClone(DEFAULT_CONFIG),
  provider: 'anthropic', model: 'opus-4', baseUrl: undefined,
  fast: { ...DEFAULT_CONFIG.fast, enabled: true, provider: 'anthropic', model: 'haiku-4',
    baseUrl: '' },
  team: { ...DEFAULT_CONFIG.team, model: 'fast' },
  modelProfiles: structuredClone(library),
  ...over,
} as unknown as CliConfig);

describe('resolveActiveKit: the four shapes', () => {
  it('reports the DEFAULT kit with all three slots held', () => {
    const active = resolveActiveKit(config());
    expect(active).toMatchObject({ source: 'default', id: 'kit-1', name: 'Deep work',
      held: [...ALL_SLOTS], modified: false, missingProfiles: [] });
  });

  it('reports Current setup when nothing points at a kit', () => {
    const active = resolveActiveKit(config({ modelProfiles: { ...library, defaultKitId: null } }));
    expect(active).toMatchObject({ source: 'none', id: null, name: CURRENT_SETUP_NAME,
      held: [], modified: false });
  });

  it('reports the SESSION kit and the slots it still holds', () => {
    const active = resolveActiveKit(config({
      sessionKit: { id: 'kit-2', held: ['main', 'fast'] }, provider: 'anthropic',
      model: 'haiku-4' }));
    expect(active).toMatchObject({ source: 'session', id: 'kit-2', name: 'Cheap',
      held: ['main', 'fast'] });
    // FEWER THAN THREE IS DRIFT: the user released a slot in a save, and the chip
    // has to be able to say so (§4.8).
    expect(active.modified).toBe(true);
    expect(active.driftReasons.join(' ')).toContain('holds main+fast');
  });

  it('reports drift when a connection no longer matches the kit', () => {
    const drifted = resolveActiveKit(config({ sessionKit: { id: 'kit-1', held: [...ALL_SLOTS] },
      model: 'something-else' }));
    expect(drifted.modified).toBe(true);
    expect(drifted.driftReasons).toContain('main: model changed');
  });

  it('treats an endpoint spelled "" and null as the same endpoint (RV-P2-4)', () => {
    const same = resolveActiveKit(config({ sessionKit: { id: 'kit-1', held: [...ALL_SLOTS] },
      baseUrl: '' }));
    expect(same.modified).toBe(false);
  });

  it('reports a missing profile instead of pretending the kit is intact', () => {
    const broken = { ...library, entries: library.entries.filter((e) => e.id !== 'p-main') };
    const active = resolveActiveKit(config({ modelProfiles: broken,
      sessionKit: { id: 'kit-1', held: [...ALL_SLOTS] } }));
    expect(active.missingProfiles).toContain('main');
    expect(active.modified).toBe(true);
  });

  it('falls back to Current setup when the session kit was deleted', () => {
    const active = resolveActiveKit(config({ sessionKit: { id: 'gone', held: [...ALL_SLOTS] } }));
    expect(active.source).toBe('default');
  });
});

describe('applyHeldToLive: only the held slots, only for the live side', () => {
  it('re-applies held slots and reports the ones whose profile vanished', () => {
    const candidate = { ...DEFAULT_CONFIG, modelProfiles: { ...library, mainId: 'p-fast' },
      team: { ...DEFAULT_CONFIG.team, model: 'main' } } as never;
    const applied = applyHeldToLive(candidate, { id: 'kit-1', held: ['main', 'subagent'] });
    expect(applied.candidate.modelProfiles?.mainId).toBe('p-main');
    expect(applied.candidate.team.model).toBe('fast');
    expect(applied.dropped).toEqual([]);
  });

  it('drops a slot whose kit no longer exists and says which', () => {
    const candidate = { ...DEFAULT_CONFIG, modelProfiles: library } as never;
    const applied = applyHeldToLive(candidate, { id: 'gone', held: [...ALL_SLOTS] });
    expect(applied.dropped).toEqual([...ALL_SLOTS]);
    expect(applied.candidate.modelProfiles?.mainId).toBe('p-main');
  });

  it('is a no-op without a session kit, so a plain save is byte-identical', () => {
    const candidate = { ...DEFAULT_CONFIG, modelProfiles: library } as never;
    expect(applyHeldToLive(candidate, null).candidate).toBe(candidate);
    expect(applyHeldToLive(candidate, undefined).candidate).toBe(candidate);
  });
});

describe('carrySessionKit: reload keeps the session kit (AC-21)', () => {
  const previous = (): CliConfig => config({
    sessionKit: { id: 'kit-2', held: [...ALL_SLOTS] },
    provider: 'anthropic', model: 'haiku-4',
    team: { ...DEFAULT_CONFIG.team, model: 'main' },
  });

  it('rebinds and RE-PROJECTS so the live config still matches its own bindings', () => {
    // `resolved` is what the file says (kit-1's bindings); the session kit says
    // otherwise, and the projection has to follow the session.
    const resolved = config();
    const carried = carrySessionKit({ resolved, previous: previous() });
    expect(carried.sessionKit).toEqual({ id: 'kit-2', held: [...ALL_SLOTS] });
    expect(carried.modelProfiles?.mainId).toBe('p-fast');
    expect(carried.model).toBe('haiku-4');
    expect(carried.modelProfileState?.main.appliedId).toBe('p-fast');
    // THE KIT WINS OVER THE PRE-RELOAD LIVE VALUE: `previous` had subagent=main
    // (i.e. it had drifted), and carrying the kit means re-applying the kit's own
    // definition, not preserving the drift.
    expect(carried.team.model).toBe('fast');
  });

  it('releases the session kit when the kit was deleted on disk (AC-22)', () => {
    const resolved = config({ modelProfiles: { ...library, kits: [] } });
    const carried = carrySessionKit({ resolved, previous: previous() });
    expect(carried.sessionKit).toBeUndefined();
  });

  it('is a no-op when there is no session kit', () => {
    const resolved = config();
    expect(carrySessionKit({ resolved, previous: config() })).toBe(resolved);
  });
});
