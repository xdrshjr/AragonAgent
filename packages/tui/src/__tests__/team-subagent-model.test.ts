/**
 * The subagent model resolution matrix (subagent-model-and-question-controls
 * §7.1 cases 1-7).
 *
 * `resolveSubagentModel` is PURE, so the whole surface is a table test: every
 * mode, every fallback reason, and the key-assembly rules a profile carries.
 * The DEFAULT row is the AC-1 anchor - an upgraded config with no `team.model`
 * resolves to exactly the main connection - and the clamp row pins the
 * typo-changes-nothing discipline on the write path.
 */

import { describe, expect, it } from 'vitest';
import type { ModelRole } from '../model/config/model-profiles.js';
import {
  DEFAULT_FAST_CONFIG,
  DEFAULT_JOBS_CONFIG,
  DEFAULT_TEAM_CONFIG,
  clampTeamConfig,
  type CliConfig,
} from '../model/config/schema.js';
import {
  priceTeamUsage,
  resolveSubagentKey,
  resolveSubagentModel,
  type HasApiKey,
} from '../model/team/model.js';

function config(over: Partial<CliConfig> = {}): CliConfig {
  return {
    provider: 'anthropic',
    model: 'claude-sonnet-4-5-20250929',
    thinkingLevel: 'high',
    showThinking: false,
    liveToolOutput: false,
    developerMode: false,
    contextWindow: null,
    theme: 'auto',
    reducedMotion: false,
    exitTranscript: true,
    transcriptWindow: 300,
    transcriptRetain: 1000,
    renderGovernor: true,
    maxRenderIntervalMs: 320,
    diffRender: true,
    syncOutput: true,
    confirmTools: false,
    toolTimeoutMs: 180_000,
    idleTimeoutMs: 210_000,
    apiKeys: { anthropic: 'k-main', openai: 'k-shared' },
    historyEnabled: true,
    density: 'comfortable',
    hints: true,
    mouse: true,
    mouseSelect: true,
    paste: true,
    scrollResumeMs: 5000,
    startInPlanMode: false,
    planModeHumanTimeoutMs: 1_800_000,
    team: { ...DEFAULT_TEAM_CONFIG },
    todo: { enabled: true, panel: false } as CliConfig['todo'],
    log: { level: 'info' } as CliConfig['log'],
    fast: { ...DEFAULT_FAST_CONFIG },
    retry: { enabled: true } as CliConfig['retry'],
    compaction: { enabled: false } as CliConfig['compaction'],
    update: {} as CliConfig['update'],
    skills: {} as CliConfig['skills'],
    skillsRuntime: {} as CliConfig['skillsRuntime'],
    bash: {} as CliConfig['bash'],
    jobs: { ...DEFAULT_JOBS_CONFIG },
    submitCount: 0,
    cwd: process.cwd(),
    color: true,
    keyboardEnhancement: false,
    ...over,
  };
}

const hasAllKeys: HasApiKey = () => true;
/** Only anthropic resolves; anything else is keyless. */
const hasAnthropicOnly: HasApiKey = (id) => id === 'anthropic';

const profile = { id: 'p1', name: 'cheap', provider: 'openai', model: 'gpt-5-mini',
  baseUrl: 'https://gw.example', apiKey: null, contextWindow: null };
const keyedProfile = { ...profile, id: 'p2', apiKey: 'entry-key' };

describe('resolveSubagentModel - the mode matrix', () => {
  it('1. default (no team.model): mode/effective main, ref equals the main connection', () => {
    const cfg = config();
    const out = resolveSubagentModel(cfg, hasAllKeys);
    expect(out.mode).toBe('main');
    expect(out.effective).toBe('main');
    expect(out.ref).toEqual({
      providerId: 'anthropic',
      modelId: 'claude-sonnet-4-5-20250929',
    });
    expect(out.thinkingLevel).toBe('high');
    expect(out.keyRole).toBe('main');
    expect(out.profile).toBeNull();
    expect(out.fallbackReason).toBeUndefined();
  });

  it('2. model fast with a live tier: the fast ref, fast thinking level and fast key role', () => {
    const cfg = config({
      team: { ...DEFAULT_TEAM_CONFIG, model: 'fast' },
      fast: { ...DEFAULT_FAST_CONFIG, enabled: true, model: 'claude-haiku-4-5',
        thinkingLevel: 'low' },
    });
    const out = resolveSubagentModel(cfg, hasAllKeys);
    expect(out.mode).toBe('fast');
    expect(out.effective).toBe('fast');
    expect(out.ref).toEqual({ providerId: 'anthropic', modelId: 'claude-haiku-4-5' });
    expect(out.thinkingLevel).toBe('low');
    expect(out.keyRole).toBe('fast');
    expect(out.fallbackReason).toBeUndefined();
  });

  it.each(['disabled', 'no_model', 'no_adapter', 'no_key'] as const)(
    '3. model fast but tier %s: degrades to main with fast_unavailable',
    (reason) => {
      const cfg = config({
        team: { ...DEFAULT_TEAM_CONFIG, model: 'fast' },
        fast:
          reason === 'disabled'
            ? { ...DEFAULT_FAST_CONFIG, enabled: false, model: 'claude-haiku-4-5' }
            : reason === 'no_model'
            ? { ...DEFAULT_FAST_CONFIG, enabled: true, model: '' }
            : reason === 'no_adapter'
            ? { ...DEFAULT_FAST_CONFIG, enabled: true, model: 'm', provider: 'nope' }
            : { ...DEFAULT_FAST_CONFIG, enabled: true, model: 'm', provider: 'openai' },
      });
      const out = resolveSubagentModel(cfg, reason === 'no_key' ? hasAnthropicOnly : hasAllKeys);
      expect(out.mode).toBe('fast');
      expect(out.effective).toBe('main');
      expect(out.fallbackReason).toBe('fast_unavailable');
      // The fallback is ALWAYS a usable connection: the main one, verbatim.
      expect(out.ref).toEqual({
        providerId: 'anthropic',
        modelId: 'claude-sonnet-4-5-20250929',
      });
      expect(out.thinkingLevel).toBe('high');
      expect(out.keyRole).toBe('main');
    },
  );

  it('4. model profile hit: the entry connection and the entry on the resolution', () => {
    const cfg = config({
      team: { ...DEFAULT_TEAM_CONFIG, model: 'profile', modelProfileId: 'p1' },
      modelProfiles: { version: 1, entries: [profile], mainId: null, fastId: null },
    });
    const out = resolveSubagentModel(cfg, hasAllKeys);
    expect(out.mode).toBe('profile');
    expect(out.effective).toBe('profile');
    expect(out.ref).toEqual({
      providerId: 'openai',
      modelId: 'gpt-5-mini',
      baseUrl: 'https://gw.example',
    });
    expect(out.profile).toEqual(profile);
    expect(out.keyRole).toBe('main');
    expect(out.thinkingLevel).toBe('high');
  });

  it('4b. profile entry without its own key and no shared key: profile_no_key fallback', () => {
    const cfg = config({
      apiKeys: {},
      team: { ...DEFAULT_TEAM_CONFIG, model: 'profile', modelProfileId: 'p1' },
      modelProfiles: { version: 1, entries: [profile], mainId: null, fastId: null },
    });
    const out = resolveSubagentModel(cfg, hasAnthropicOnly);
    expect(out.effective).toBe('main');
    expect(out.fallbackReason).toBe('profile_no_key');
    expect(out.profile).toBeNull();
  });

  it('4c. a shared-layer key is enough for a keyless entry', () => {
    const cfg = config({
      team: { ...DEFAULT_TEAM_CONFIG, model: 'profile', modelProfileId: 'p1' },
      modelProfiles: { version: 1, entries: [profile], mainId: null, fastId: null },
    });
    expect(resolveSubagentModel(cfg, hasAllKeys).effective).toBe('profile');
  });

  it.each([
    ['a dangling id', 'p-gone'],
    ['no id at all', null],
    ['no library', undefined],
  ])('5. model profile with %s: profile_missing', (_label, id) => {
    const cfg = config({
      team: { ...DEFAULT_TEAM_CONFIG, model: 'profile', ...(id !== undefined ? { modelProfileId: id } : {}) },
      ...(id === undefined ? {} : { modelProfiles: { version: 1, entries: [profile], mainId: null, fastId: null } }),
    });
    const out = resolveSubagentModel(cfg, hasAllKeys);
    expect(out.effective).toBe('main');
    expect(out.fallbackReason).toBe('profile_missing');
  });

  it('6. resolveSubagentKey: entry key first, shared fallback, other providers by keyRole', () => {
    const base = config({
      team: { ...DEFAULT_TEAM_CONFIG, model: 'profile', modelProfileId: 'p2' },
      modelProfiles: { version: 1, entries: [keyedProfile], mainId: null, fastId: null },
    });
    const shared = (providerId: string, role: ModelRole): string | undefined =>
      `${providerId}:${role}`;
    const keyed = resolveSubagentModel(base, hasAllKeys);
    // The bound provider: the entry's OWN key wins over the shared layer.
    expect(resolveSubagentKey(base, keyed, 'openai', shared)).toBe('entry-key');
    // A keyless entry falls back to the shared layer at the main role.
    const keyless = resolveSubagentModel(
      config({
        team: { ...DEFAULT_TEAM_CONFIG, model: 'profile', modelProfileId: 'p1' },
        modelProfiles: { version: 1, entries: [profile], mainId: null, fastId: null },
      }),
      hasAllKeys,
    );
    expect(resolveSubagentKey(config(), keyless, 'openai', shared)).toBe('openai:main');
    // Any other provider (and every non-profile mode) resolves by keyRole.
    const fast = resolveSubagentModel(
      config({
        team: { ...DEFAULT_TEAM_CONFIG, model: 'fast' },
        fast: { ...DEFAULT_FAST_CONFIG, enabled: true, model: 'claude-haiku-4-5' },
      }),
      hasAllKeys,
    );
    expect(resolveSubagentKey(config(), fast, 'anthropic', shared)).toBe('anthropic:fast');
    expect(resolveSubagentKey(config(), fast, 'openai', shared)).toBe('openai:fast');
  });

  it('7. a hand-edited illegal enum clamps back to main (typo changes nothing)', () => {
    const clamped = clampTeamConfig({ model: 'fats' });
    expect(clamped.model).toBe('main');
    expect(clamped.modelProfileId).toBeNull();
    // Legal values stick, and an explicit id survives the round trip.
    expect(clampTeamConfig({ model: 'profile', modelProfileId: 'p1' }).model).toBe('profile');
    expect(clampTeamConfig({ model: 'fast' }).model).toBe('fast');
    // Junk types are nulled rather than rejected, like every scalar clamp.
    expect(clampTeamConfig({ model: 'profile', modelProfileId: 42 }).modelProfileId).toBeNull();
    const long = 'x'.repeat(129);
    expect(clampTeamConfig({ model: 'profile', modelProfileId: long }).modelProfileId).toBeNull();
    expect(clampTeamConfig({ model: 'profile', modelProfileId: 'x'.repeat(128) }).modelProfileId)
      .toBe('x'.repeat(128));
  });
});

describe('priceTeamUsage (SA-7)', () => {
  const usage = { inputTokens: 1_000_000, outputTokens: 0 };
  const mainCost = { input: 15, output: 75 };
  const fastCost = { input: 1, output: 5 };
  const fastRef = { providerId: 'anthropic', modelId: 'haiku' };
  const book = (priced: boolean) => ({
    mainCost,
    isPriced: () => priced,
    costFor: () => fastCost,
  });
  const resolved = (effective: 'main' | 'fast' | 'profile') => ({
    mode: effective,
    effective,
    ref: fastRef,
    thinkingLevel: 'off' as const,
    keyRole: 'main' as const,
    profile: null,
  });

  it('prices main mode at the lead table, byte for byte', () => {
    expect(priceTeamUsage(resolved('main'), usage, book(false))).toBe(15);
  });

  it('prices a fast or profile child at ITS table, not the lead', () => {
    expect(priceTeamUsage(resolved('fast'), usage, book(true))).toBe(1);
    expect(priceTeamUsage(resolved('profile'), usage, book(true))).toBe(1);
  });

  it('contributes zero for a child model no table prices, never the lead price', () => {
    expect(priceTeamUsage(resolved('fast'), usage, book(false))).toBe(0);
  });
});
