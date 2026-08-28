/**
 * Level ordering, coercion, and the filter threshold.
 *
 * The ladder is a privacy contract as much as a verbosity one: `info` must never
 * enable a level that records conversation content, because "send me your log"
 * is only a safe thing to ask while that holds.
 */

import { describe, expect, it } from 'vitest';
import {
  LOG_LEVELS,
  LOG_LEVEL_NAMES,
  clampLogLevel,
  isLevelEnabled,
  isLogLevel,
} from '../logging/levels.js';

describe('level ordering', () => {
  it('is strictly increasing from silent to trace', () => {
    const values = LOG_LEVEL_NAMES.map((name) => LOG_LEVELS[name]);
    for (let i = 1; i < values.length; i += 1) {
      expect(values[i]!).toBeGreaterThan(values[i - 1]!);
    }
  });

  it('names and the table agree', () => {
    expect([...LOG_LEVEL_NAMES].sort()).toEqual(Object.keys(LOG_LEVELS).sort());
  });
});

describe('isLogLevel / clampLogLevel', () => {
  it('accepts the six names and rejects anything else', () => {
    for (const name of LOG_LEVEL_NAMES) expect(isLogLevel(name)).toBe(true);
    for (const bad of ['verbose', 'INFO', 42, null, {}, undefined]) {
      expect(isLogLevel(bad)).toBe(false);
    }
  });

  it('falls back instead of throwing, like every other clamp in the package', () => {
    expect(clampLogLevel('nonsense', 'info')).toBe('info');
    expect(clampLogLevel(undefined, 'warn')).toBe('warn');
    expect(clampLogLevel(7, 'error')).toBe('error');
  });

  it('tolerates case and surrounding whitespace from a hand-edited file', () => {
    expect(clampLogLevel('  DEBUG ', 'info')).toBe('debug');
    expect(clampLogLevel('Trace', 'info')).toBe('trace');
  });
});

describe('isLevelEnabled', () => {
  it('lets through everything at or above the threshold in severity', () => {
    expect(isLevelEnabled('error', 'info')).toBe(true);
    expect(isLevelEnabled('warn', 'info')).toBe(true);
    expect(isLevelEnabled('info', 'info')).toBe(true);
    expect(isLevelEnabled('debug', 'info')).toBe(false);
    expect(isLevelEnabled('trace', 'info')).toBe(false);
  });

  it('silent means silent — not even errors', () => {
    for (const name of LOG_LEVEL_NAMES) {
      expect(isLevelEnabled(name, 'silent')).toBe(false);
    }
  });

  it('trace admits every level', () => {
    for (const name of LOG_LEVEL_NAMES.filter((n) => n !== 'silent')) {
      expect(isLevelEnabled(name, 'trace')).toBe(true);
    }
  });
});
