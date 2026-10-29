import { describe, expect, it } from 'vitest';
import { projectModelProfiles, resolveModelRoleKey, resolveModelProfileState }
  from '../model/config/model-profile-resolution.js';
import { DEFAULT_CONFIG, type CliConfig } from '../model/config/schema.js';

const modelProfiles = { version: 1 as const, entries: [
  { id: 'main', name: 'Main', provider: 'openai', model: 'same',
    baseUrl: 'https://main/v1', apiKey: 'main-secret', contextWindow: null },
  { id: 'fast', name: 'Fast', provider: 'openai', model: 'same',
    baseUrl: null, apiKey: 'fast-secret', contextWindow: null },
], mainId: 'main', fastId: 'fast' };
function config(): CliConfig {
  return { ...DEFAULT_CONFIG, provider: 'openai', model: 'same',
    baseUrl: 'https://main/v1', fast: { ...DEFAULT_CONFIG.fast, provider: 'openai', model: 'same' },
    modelProfiles, apiKeys: { openai: 'shared-secret' } } as unknown as CliConfig;
}
describe('profile-context-window projection', () => {
  it('a bound Main profile OWNS the denominator: both a number and null project', () => {
    const withWindow = { version: 1 as const, mainId: 'main', fastId: null, entries: [
      { ...modelProfiles.entries[0], contextWindow: 1_000_000 }] };
    const projection = projectModelProfiles({ ...DEFAULT_CONFIG, modelProfiles: withWindow });
    expect(projection.mainOwnsContextWindow).toBe(true);
    expect(projection.file.contextWindow).toBe(1_000_000);
    // NULL PROJECTS TOO (tradeoff B): 'the profile said auto' must stay
    // distinguishable from 'no profile is bound', so the legacy top-level key
    // does not resurface under a bound AUTO profile.
    const auto = { ...withWindow, entries: [{ ...withWindow.entries[0], contextWindow: null }] };
    const autoProjection = projectModelProfiles({ ...DEFAULT_CONFIG, modelProfiles: auto });
    expect(autoProjection.mainOwnsContextWindow).toBe(true);
    expect(autoProjection.file.contextWindow).toBeNull();
  });
  it('only the Main binding owns the window; Fast and unbound libraries do not', () => {
    const fastOnly = { ...modelProfiles, mainId: null };
    const projection = projectModelProfiles({ ...DEFAULT_CONFIG, modelProfiles: fastOnly });
    expect(projection.mainOwnsContextWindow).toBe(false);
    expect(projection.file.contextWindow).toBe(DEFAULT_CONFIG.contextWindow);
    const unbound = { ...modelProfiles, mainId: null, fastId: null };
    expect(projectModelProfiles({ ...DEFAULT_CONFIG, modelProfiles: unbound })
      .mainOwnsContextWindow).toBe(false);
    // AN INVALID LIBRARY NEVER owns anything - it falls back to custom
    // connections, and the window must fall back with them.
    const invalid = projectModelProfiles({ ...DEFAULT_CONFIG,
      modelProfiles: { version: 99, mainId: 'main', fastId: null,
        entries: [] } as never });
    expect(invalid.mainOwnsContextWindow).toBe(false);
    expect(invalid.issues.length).toBeGreaterThan(0);
  });
});
describe('role resolution', () => {
  it('projects connections without changing the persisted custom candidate', () => {
    const original = { ...DEFAULT_CONFIG, modelProfiles };
    const projection = projectModelProfiles(original);
    expect(projection.file.model).toBe('same');
    expect(projection.file.fast?.baseUrl).toBe('');
    expect(original.model).toBe(DEFAULT_CONFIG.model);
  });
  it('isolates same-provider and same-model credentials', () => {
    const live = config();
    expect(resolveModelRoleKey({ config: live, role: 'main', providerId: 'openai' }))
      .toBe('main-secret');
    expect(resolveModelRoleKey({ config: live, role: 'fast', providerId: 'openai' }))
      .toBe('fast-secret');
    expect(resolveModelRoleKey({ config: live, role: 'fast', providerId: 'google' }))
      .toBeUndefined();
  });
  it('allows model-only overrides but never transports a key to another endpoint', () => {
    const live = config();
    live.model = 'override';
    expect(resolveModelProfileState(live).main.appliedId).toBe('main');
    live.baseUrl = 'https://different';
    expect(resolveModelProfileState(live).main.appliedId).toBeNull();
    expect(resolveModelRoleKey({ config: live, role: 'main', providerId: 'openai' }))
      .toBe('shared-secret');
  });
  it('scopes the startup credential to its immutable target and main role', () => {
    const live = config();
    live.apiKeyOverride = 'startup-key';
    live.apiKeyOverrideTarget = { provider: 'openai', baseUrl: 'https://main/v1' };
    expect(resolveModelRoleKey({ config: live, role: 'main', providerId: 'openai' }))
      .toBe('startup-key');
    expect(resolveModelRoleKey({ config: live, role: 'fast', providerId: 'openai' }))
      .toBe('fast-secret');
    live.baseUrl = 'https://main/v1/';
    expect(resolveModelRoleKey({ config: live, role: 'main', providerId: 'openai' }))
      .toBe('shared-secret');
  });
  it('falls back safely for malformed raw profile data', () => {
    const live = config();
    live.modelProfiles = { version: 99, mainId: 'p', entries: null } as never;
    expect(resolveModelRoleKey({ config: live, role: 'main', providerId: 'openai' }))
      .toBe('shared-secret');
  });
  it('解除最后一个绑定后，已固定目标的启动密钥仍不得流向另一网关', () => {
    const live = config();
    live.modelProfiles = { ...modelProfiles, mainId: null, fastId: null };
    live.apiKeyOverride = 'startup-secret';
    live.apiKeyOverrideTarget = { provider: 'openai', baseUrl: 'https://main/v1' };
    live.baseUrl = 'https://other/v1';
    expect(resolveModelRoleKey({ config: live, role: 'main', providerId: 'openai' }))
      .toBe('shared-secret');
  });
});
