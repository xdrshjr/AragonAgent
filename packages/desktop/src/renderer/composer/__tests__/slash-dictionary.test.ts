import { describe, expect, it } from 'vitest';
import { COMMAND_MATRIX } from '../../../shared/parity-matrix.js';
import { catalogueKeys, lookupMessage, setLanguage } from '../../i18n/index.js';

describe('slash menu dictionary', () => {
  it('has a hint for every command in the parity matrix, in both languages', () => {
    const missing = (language: 'en' | 'zh-CN') => {
      const keys = new Set(catalogueKeys(language));
      return COMMAND_MATRIX.map((entry) => `slash.${entry.id}`).filter((key) => !keys.has(key));
    };
    expect(missing('en')).toEqual([]);
    expect(missing('zh-CN')).toEqual([]);
  });

  it('has no hint for a command that is not in the matrix (a stale key would never be shown)', () => {
    const ids = new Set(COMMAND_MATRIX.map((entry) => `slash.${entry.id}`));
    const stale = catalogueKeys('en').filter((key) => key.startsWith('slash.') && !ids.has(key));
    expect(stale).toEqual([]);
  });

  it('answers in the interface language and returns null for an unknown command', () => {
    setLanguage('zh-CN');
    expect(lookupMessage('slash.help')).toMatch(/命令面板/);
    setLanguage('en');
    expect(lookupMessage('slash.help')).toMatch(/Command palette/);
    expect(lookupMessage('slash.does-not-exist')).toBeNull();
  });
});
