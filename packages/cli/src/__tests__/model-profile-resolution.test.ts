import { describe, expect, it } from 'vitest';
import { projectModelProfiles, resolveModelRoleKey, resolveModelProfileState }
  from '../config/model-profile-resolution.js';
import { DEFAULT_CONFIG, type CliConfig } from '../config/schema.js';

const modelProfiles = { version: 1 as const, entries: [
  { id: 'main', name: 'Main', provider: 'openai', model: 'same',
    baseUrl: 'https://main/v1', apiKey: 'main-secret' },
  { id: 'fast', name: 'Fast', provider: 'openai', model: 'same',
    baseUrl: null, apiKey: 'fast-secret' },
], mainId: 'main', fastId: 'fast' };
function config(): CliConfig {
  return { ...DEFAULT_CONFIG, provider: 'openai', model: 'same',
    baseUrl: 'https://main/v1', fast: { ...DEFAULT_CONFIG.fast, provider: 'openai', model: 'same' },
    modelProfiles, apiKeys: { openai: 'shared-secret' } } as unknown as CliConfig;
}
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
