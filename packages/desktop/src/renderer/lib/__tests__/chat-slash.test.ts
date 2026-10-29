import { describe, expect, it } from 'vitest';
import { COMMAND_MATRIX } from '../../../shared/parity-matrix.js';
import { buildSlashItems, SLASH_ACTIONS } from '../chat-slash.js';

describe('slash menu', () => {
  it('has a target for every mapped command in the parity matrix (a listed command must do something)', () => {
    const missing = COMMAND_MATRIX.filter((entry) => entry.status === 'mapped' && !SLASH_ACTIONS[entry.id]).map((entry) => entry.id);
    expect(missing).toEqual([]);
  });

  it('has no action for a command the matrix does not list', () => {
    const ids = new Set(COMMAND_MATRIX.map((entry) => entry.id));
    expect(Object.keys(SLASH_ACTIONS).filter((id) => !ids.has(id))).toEqual([]);
  });

  it('puts "runs now" first, then panels, then not-applicable', () => {
    const groups = buildSlashItems('').map((item) => item.group);
    const firstPanel = groups.indexOf('panel');
    const firstNa = groups.indexOf('na');
    expect(groups.slice(0, firstPanel).every((group) => group === 'run')).toBe(true);
    expect(firstPanel).toBeLessThan(firstNa);
  });

  it('runs-now commands are exactly the ones that act immediately (host slash, reset, save, branch)', () => {
    const runs = buildSlashItems('').filter((item) => item.group === 'run').map((item) => item.id).sort();
    expect(runs).toEqual(['branch', 'clear', 'compact', 'reset', 'save']);
  });

  it('greys not-applicable commands and keeps the substitute text', () => {
    const update = buildSlashItems('update').find((item) => item.id === 'update');
    expect(update?.group).toBe('na');
    expect(update?.action).toBeNull();
    expect(update?.target.length).toBeGreaterThan(0);
  });

  it('filters by prefix first', () => {
    const ids = buildSlashItems('co').map((item) => item.id);
    expect(ids).toContain('compact');
    expect(ids).not.toContain('help');
  });
});
