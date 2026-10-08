import { describe, expect, it } from 'vitest';
import { normalizeDraft, validateProfile, defaultProfiles } from '../electron/settings/profiles';
import type { ProfileDraftInput } from '../shared/protocol';

function draft(overrides: Partial<ProfileDraftInput> = {}): ProfileDraftInput {
  return {
    label: 'Test profile',
    mode: 'anthropic',
    model: 'claude-sonnet-4-6',
    baseUrl: '',
    thinking: 'off',
    ...overrides,
  };
}

describe('normalizeDraft', () => {
  it('trims and keeps valid fields', () => {
    const result = normalizeDraft(draft({ label: '  DeepSeek  ', model: ' deepseek-chat ' }));
    expect(result.label).toBe('DeepSeek');
    expect(result.model).toBe('deepseek-chat');
    expect(result.apiKey).toBeNull();
  });

  it('falls back to anthropic for an unknown mode', () => {
    const result = normalizeDraft(draft({ mode: 'weird' as ProfileDraftInput['mode'] }));
    expect(result.mode).toBe('anthropic');
  });

  it('falls back to off for an unknown thinking level', () => {
    const result = normalizeDraft(draft({ thinking: 'ultra' as ProfileDraftInput['thinking'] }));
    expect(result.thinking).toBe('off');
  });

  it('keeps a newly typed api key', () => {
    const result = normalizeDraft(draft({ apiKey: 'sk-test-123' }));
    expect(result.apiKey).toBe('sk-test-123');
  });
});

describe('validateProfile', () => {
  it('accepts a minimal anthropic profile', () => {
    expect(validateProfile(normalizeDraft(draft()), [])).toEqual([]);
  });

  it('rejects an empty label', () => {
    expect(validateProfile(normalizeDraft(draft({ label: '  ' })), [])).toContain('label_empty');
  });

  it('requires a model id', () => {
    expect(validateProfile(normalizeDraft(draft({ model: '' })), [])).toContain('model_empty');
  });

  it('requires a base URL in custom mode', () => {
    const issues = validateProfile(normalizeDraft(draft({ mode: 'custom', baseUrl: '' })), []);
    expect(issues).toContain('base_url_required_for_custom');
  });

  it('rejects a non-http base URL', () => {
    const issues = validateProfile(normalizeDraft(draft({ mode: 'openai', baseUrl: 'ftp://x' })), []);
    expect(issues).toContain('base_url_invalid');
  });

  it('accepts a valid custom endpoint', () => {
    const issues = validateProfile(
      normalizeDraft(draft({ mode: 'custom', baseUrl: 'https://api.deepseek.com/v1' })),
      [],
    );
    expect(issues).toEqual([]);
  });

  it('flags duplicate labels among siblings', () => {
    const issues = validateProfile(normalizeDraft(draft({ label: 'Work' })), ['Work']);
    expect(issues).toContain('duplicate_label');
  });
});

describe('defaultProfiles', () => {
  it('seeds exactly one usable anthropic profile with no key', () => {
    const profiles = defaultProfiles();
    expect(profiles).toHaveLength(1);
    expect(profiles[0].mode).toBe('anthropic');
    expect(profiles[0].hasKey).toBe(false);
    expect(profiles[0].model.length).toBeGreaterThan(0);
  });
});
