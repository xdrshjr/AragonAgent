import { describe, expect, it } from 'vitest';
import { maskConfig } from '../config/cli-commands.js';
import { DEFAULT_CONFIG } from '../config/schema.js';
import { getSecrets, registerProfileSecrets } from '../logging/secret-registry.js';

describe('profile output security', () => {
  it('hides future and malformed segments as a whole', () => {
    const config = { ...DEFAULT_CONFIG, modelProfiles: { version: 2,
      entries: [{ apiKey: 'short', arbitrary: 'private' }] } };
    expect(maskConfig(config as never).modelProfiles).toEqual({ invalid: true });
  });
  it('uses a field whitelist and fixed credential labels', () => {
    const config = { ...DEFAULT_CONFIG, modelProfiles: { version: 1, mainId: 'p', fastId: null,
      entries: [{ id: 'p', name: 'P', provider: 'openai', model: 'm', baseUrl: null,
        apiKey: 'tiny', unexpected: 'private' }] } };
    const output = JSON.stringify(maskConfig(config as never));
    expect(output).toContain('Configured');
    expect(output).not.toContain('tiny');
    expect(output).not.toContain('private');
  });
  it('registers profile secrets before schema validation without throwing on malformed entries', () => {
    registerProfileSecrets({ modelProfiles: { version: 99,
      entries: [null, 3, { apiKey: 'future-private-key' }, { apiKey: {} }] } });
    expect(getSecrets()).toContain('future-private-key');
  });
});
