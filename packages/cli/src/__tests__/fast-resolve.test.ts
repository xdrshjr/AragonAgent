/**
 * Tier resolution (fast-model-tier §3.2 / §8.1).
 *
 * The resolver is the SINGLE AUTHORITY every consumer reads, so its matrix is
 * asserted directly rather than through a controller: a UI that shows a chip for
 * a tier that refuses every call is the failure this function exists to prevent.
 */

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_FAST_CONFIG,
  DEFAULT_UPDATE_CONFIG,
  DEFAULT_LOG_CONFIG,
  DEFAULT_COMPACTION_CONFIG,
  DEFAULT_RETRY_CONFIG,
  DEFAULT_SKILLS_CONFIG,
  DEFAULT_SKILLS_RUNTIME,
  DEFAULT_TEAM_CONFIG,
  DEFAULT_TODO_CONFIG,
  DEFAULT_BASH_CONFIG,
  type CliConfig,
  type FastConfig,
} from '../config/schema.js';
import { describeFastTierProblem, resolveFastTier } from '../fast/resolve.js';

function config(fast: Partial<FastConfig> = {}, over: Partial<CliConfig> = {}): CliConfig {
  return {
    provider: 'anthropic',
    model: 'claude-sonnet-4-5-20250929',
    thinkingLevel: 'off',
    showThinking: false,
    liveToolOutput: false,
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
    apiKeys: { anthropic: 'k' },
    historyEnabled: true,
    density: 'comfortable',
    hints: true,
    mouse: true,
    mouseSelect: true,
    paste: true,
    scrollResumeMs: 5000,
    startInPlanMode: false,
    planModeMaxAskRounds: 4,
    planModeHumanTimeoutMs: 1_800_000,
    skills: DEFAULT_SKILLS_CONFIG,
    skillsRuntime: DEFAULT_SKILLS_RUNTIME,
    log: DEFAULT_LOG_CONFIG,
    team: DEFAULT_TEAM_CONFIG,
    todo: DEFAULT_TODO_CONFIG,
    bash: DEFAULT_BASH_CONFIG,
    retry: DEFAULT_RETRY_CONFIG,
    // The NINTH nested section. `enabled: false` on purpose: these fixtures
    // are about other subsystems, and the same `enabled: false` appears above
    // for `skills`, `team` and `todo` for exactly that reason.
    compaction: { ...DEFAULT_COMPACTION_CONFIG, enabled: false },
    fast: { ...DEFAULT_FAST_CONFIG, ...fast },
    update: DEFAULT_UPDATE_CONFIG,
    submitCount: 0,
    cwd: '/tmp',
    color: true,
    ...over,
  };
}

const hasKey = (ids: string[]) => (id: string): boolean => ids.includes(id);

describe('resolveFastTier - the rules, in order (§3.2)', () => {
  it('rule 1: a disabled tier reports `disabled` and nothing else', () => {
    const tier = resolveFastTier(config({ enabled: false, model: 'haiku' }), hasKey(['anthropic']));
    expect(tier).toEqual({ ok: false, reason: 'disabled' });
  });

  it('rule 2: an empty provider INHERITS the main provider', () => {
    const tier = resolveFastTier(
      config({ enabled: true, model: 'claude-haiku-4-5' }),
      hasKey(['anthropic']),
    );
    expect(tier.ok).toBe(true);
    if (!tier.ok) throw new Error('unreachable');
    expect(tier.ref.providerId).toBe('anthropic');
    expect(tier.ref.modelId).toBe('claude-haiku-4-5');
  });

  it('rule 3: an empty model is NOT CONFIGURED and never inherits (D-4)', () => {
    const tier = resolveFastTier(config({ enabled: true, model: '  ' }), hasKey(['anthropic']));
    expect(tier).toEqual({ ok: false, reason: 'no_model' });
  });

  it('rule 4: a provider with no adapter reports `no_adapter`', () => {
    const tier = resolveFastTier(
      config({ enabled: true, model: 'm', provider: 'nope' }),
      hasKey(['nope']),
    );
    expect(tier).toEqual({ ok: false, reason: 'no_adapter' });
  });

  it('rule 5: a provider with no key reports `no_key`, and reports it SEPARATELY', () => {
    const tier = resolveFastTier(
      config({ enabled: true, model: 'm', provider: 'openai' }),
      hasKey(['anthropic']),
    );
    // Not `no_adapter`: openai HAS an adapter, it has no key. The two send the
    // user to different settings, which is why they are distinct reasons.
    expect(tier).toEqual({ ok: false, reason: 'no_key' });
  });

  it('rule 6: a SAME-provider tier inherits the base URL, a different one does not', () => {
    const sameProvider = resolveFastTier(
      config({ enabled: true, model: 'haiku' }, { baseUrl: 'https://gw.example' }),
      hasKey(['anthropic']),
    );
    expect(sameProvider.ok && sameProvider.ref.baseUrl).toBe('https://gw.example');

    const otherProvider = resolveFastTier(
      config({ enabled: true, model: 'gpt', provider: 'openai' }, { baseUrl: 'https://gw.example' }),
      hasKey(['anthropic', 'openai']),
    );
    // A base URL belongs to ONE API; borrowing it across vendors is an
    // immediate 404 rather than a convenience.
    expect(otherProvider.ok && otherProvider.ref.baseUrl).toBeUndefined();
  });

  it('rule 6: an EXPLICIT fast base URL wins over both', () => {
    const tier = resolveFastTier(
      config(
        { enabled: true, model: 'haiku', baseUrl: 'https://fast.example' },
        { baseUrl: 'https://main.example' },
      ),
      hasKey(['anthropic']),
    );
    expect(tier.ok && tier.ref.baseUrl).toBe('https://fast.example');
  });

  it('rule 7: fast == main resolves ok with `sameAsMain` (R-e), and is not skipped', () => {
    const tier = resolveFastTier(
      config({ enabled: true, model: 'claude-sonnet-4-5-20250929' }),
      hasKey(['anthropic']),
    );
    expect(tier.ok).toBe(true);
    if (!tier.ok) throw new Error('unreachable');
    expect(tier.sameAsMain).toBe(true);
    // The tier still RESOLVES, which is the whole of R-e: the user is allowed to
    // choose it, and no branch anywhere may read `sameAsMain` to skip work
    // (R-13).
    expect(tier.ref.modelId).toBe('claude-sonnet-4-5-20250929');
  });

  it('carries the per-tier thinking level, which defaults to `off` (D-13)', () => {
    const dflt = resolveFastTier(config({ enabled: true, model: 'h' }), hasKey(['anthropic']));
    expect(dflt.ok && dflt.thinkingLevel).toBe('off');
    const raised = resolveFastTier(
      config({ enabled: true, model: 'h', thinkingLevel: 'low' }),
      hasKey(['anthropic']),
    );
    expect(raised.ok && raised.thinkingLevel).toBe('low');
  });
});

describe('describeFastTierProblem - the startup notice (§3.3)', () => {
  it('says NOTHING for a tier the user simply left off', () => {
    expect(describeFastTierProblem({ ok: false, reason: 'disabled' }, 'anthropic')).toBeNull();
  });

  it('names the fix for the two mistakes that are otherwise invisible', () => {
    expect(describeFastTierProblem({ ok: false, reason: 'no_model' }, 'anthropic')).toContain(
      '/fast model',
    );
    expect(describeFastTierProblem({ ok: false, reason: 'no_key' }, 'openai')).toContain('openai');
  });
});
