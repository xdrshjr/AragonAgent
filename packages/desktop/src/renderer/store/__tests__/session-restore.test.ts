/** What a window had open is remembered across a renderer crash, and never trusted blindly. */
import { describe, expect, it } from 'vitest';
import { parseSnapshot } from '../session-restore.js';

describe('parseSnapshot', () => {
  it('reads a well-formed snapshot', () => {
    const raw = JSON.stringify({ sessions: [{ id: 'a', cwd: '/work/a' }, { id: 'b', cwd: '/work/b' }], active: 'b' });
    expect(parseSnapshot(raw)).toEqual({ sessions: [{ id: 'a', cwd: '/work/a' }, { id: 'b', cwd: '/work/b' }], active: 'b' });
  });

  it('nothing stored, or garbage, is "no snapshot" - so a fresh launch still opens the welcome page', () => {
    expect(parseSnapshot(null)).toBeNull();
    expect(parseSnapshot('')).toBeNull();
    expect(parseSnapshot('not json')).toBeNull();
    expect(parseSnapshot('{"sessions":"no"}')).toBeNull();
    expect(parseSnapshot('42')).toBeNull();
  });

  it('drops entries without an id or a folder, and a non-string active', () => {
    const raw = JSON.stringify({ sessions: [{ id: 'a', cwd: '' }, { id: 1, cwd: '/x' }, { cwd: '/y' }, { id: 'ok', cwd: '/z' }], active: 7 });
    expect(parseSnapshot(raw)).toEqual({ sessions: [{ id: 'ok', cwd: '/z' }], active: null });
  });

  it('caps how many sessions one snapshot can re-open', () => {
    const sessions = Array.from({ length: 100 }, (_unused, index) => ({ id: `s${index}`, cwd: '/w' }));
    expect(parseSnapshot(JSON.stringify({ sessions, active: null }))?.sessions).toHaveLength(24);
  });

  it('stores ids and folders only - never conversation text', () => {
    const raw = JSON.stringify({ sessions: [{ id: 'a', cwd: '/w', text: 'secret', transcript: ['x'] }], active: 'a' });
    expect(JSON.stringify(parseSnapshot(raw))).not.toContain('secret');
  });
});
