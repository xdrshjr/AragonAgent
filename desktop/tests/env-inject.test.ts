import { describe, expect, it } from 'vitest';
import { buildProfileEnv, providerForMode } from '../electron/settings/env-inject';

describe('buildProfileEnv', () => {
  it('maps anthropic mode to the anthropic provider and key var', () => {
    const env = buildProfileEnv({
      mode: 'anthropic',
      model: 'claude-sonnet-4-6',
      baseUrl: '',
      thinking: 'off',
      apiKey: 'sk-ant-1',
    });
    expect(env.ARAGON_PROVIDER).toBe('anthropic');
    expect(env.ARAGON_MODEL).toBe('claude-sonnet-4-6');
    expect(env.ANTHROPIC_API_KEY).toBe('sk-ant-1');
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.ARAGON_BASE_URL).toBeUndefined();
    expect(env.ARAGON_THINKING).toBe('off');
  });

  it('maps openai mode to the openai provider and key var', () => {
    const env = buildProfileEnv({
      mode: 'openai',
      model: 'gpt-5.1',
      baseUrl: '',
      thinking: 'low',
      apiKey: 'sk-oai',
    });
    expect(env.ARAGON_PROVIDER).toBe('openai');
    expect(env.OPENAI_API_KEY).toBe('sk-oai');
    expect(env.ARAGON_THINKING).toBe('low');
  });

  it('runs custom mode as provider openai with a mandatory base URL', () => {
    const env = buildProfileEnv({
      mode: 'custom',
      model: 'deepseek-chat',
      baseUrl: 'https://api.deepseek.com/v1',
      thinking: 'off',
      apiKey: 'sk-ds',
    });
    expect(env.ARAGON_PROVIDER).toBe('openai');
    expect(env.ARAGON_BASE_URL).toBe('https://api.deepseek.com/v1');
    expect(env.OPENAI_API_KEY).toBe('sk-ds');
  });

  it('omits key vars when no key is stored so the parent env can supply one', () => {
    const env = buildProfileEnv({
      mode: 'anthropic',
      model: 'claude-haiku-4-5',
      baseUrl: '',
      thinking: 'off',
      apiKey: null,
    });
    expect('ANTHROPIC_API_KEY' in env).toBe(false);
  });

  it('passes a gateway base URL through for first-party modes too', () => {
    const env = buildProfileEnv({
      mode: 'anthropic',
      model: 'claude-sonnet-4-6',
      baseUrl: 'https://my-gateway.example.com',
      thinking: 'off',
      apiKey: 'k',
    });
    expect(env.ARAGON_BASE_URL).toBe('https://my-gateway.example.com');
  });
});

describe('providerForMode', () => {
  it('keeps custom endpoints on the openai adapter', () => {
    expect(providerForMode('anthropic')).toBe('anthropic');
    expect(providerForMode('openai')).toBe('openai');
    expect(providerForMode('custom')).toBe('openai');
  });
});
