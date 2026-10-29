/** Every control-plane argument is hostile until it has been through its validator. */

import { describe, expect, it } from 'vitest';
import { IPC_CHANNELS, type IpcChannel } from '../../shared/ipc-contract.js';
import { INVALID, IPC_VALIDATORS } from '../ipc-validate.js';

const validate = (channel: IpcChannel, value: unknown): unknown => (IPC_VALIDATORS[channel] as (v: unknown) => unknown)(value);

describe('IPC_VALIDATORS', () => {
  it('has a validator for every channel the main process registers', () => {
    for (const channel of IPC_CHANNELS) expect(typeof IPC_VALIDATORS[channel], channel).toBe('function');
  });

  it('argument-less channels accept nothing but nothing', () => {
    expect(validate('config:get', undefined)).toBeUndefined();
    expect(validate('config:get', null)).toBeUndefined();
    expect(validate('config:get', { x: 1 })).toBe(INVALID);
  });

  it('session ids must match the session-store alphabet (no traversal, no separators)', () => {
    for (const id of ['../../etc/passwd', 'a/b', 'a\\b', '.hidden', '', 'x'.repeat(65), 'a b']) {
      expect(validate('sessions:close', { id }), JSON.stringify(id)).toBe(INVALID);
    }
    expect(validate('sessions:close', { id: 'a4k2m9-x7f2' })).toEqual({ id: 'a4k2m9-x7f2' });
  });

  it('rebuilds objects field by field and drops unknown fields', () => {
    expect(validate('sessions:pin', { id: 'abc', pinned: true, extra: 'x', __proto__: { polluted: 1 } }))
      .toEqual({ id: 'abc', pinned: true });
  });

  it('rejects wrong types and missing required fields', () => {
    expect(validate('sessions:pin', { id: 'abc', pinned: 'yes' })).toBe(INVALID);
    expect(validate('sessions:pin', { id: 'abc' })).toBe(INVALID);
    expect(validate('sessions:open', { cwd: '' })).toBe(INVALID);
    expect(validate('sessions:open', { cwd: 'C:/work', id: 'a/b' })).toBe(INVALID);
    expect(validate('sessions:open', 'C:/work')).toBe(INVALID);
  });

  it('caps string lengths and refuses NUL bytes', () => {
    expect(validate('config:patch', { baseRevision: 'x'.repeat(129), patch: {} })).toBe(INVALID);
    expect(validate('workspace:pick', undefined)).toBeUndefined();
    expect(validate('native:open-path', { sessionId: 'abc', relPath: 'a\0b' })).toBe(INVALID);
    expect(validate('native:notify', { title: '', body: 'x' })).toBe(INVALID);
  });

  it('refuses prototype-pollution keys anywhere in a config patch', () => {
    const polluted = JSON.parse('{"baseRevision":"r","patch":{"a":{"__proto__":{"x":1}}}}');
    expect(validate('config:patch', polluted)).toBe(INVALID);
    expect(validate('config:patch', { baseRevision: 'r', patch: { constructor: { prototype: {} } } })).toBe(INVALID);
    expect(validate('config:patch', { baseRevision: 'r', patch: { theme: 'light' } })).toEqual({ baseRevision: 'r', patch: { theme: 'light' } });
  });

  it('desktop-state:patch accepts only the documented keys', () => {
    expect(validate('desktop-state:patch', { language: 'en' })).toEqual({ language: 'en' });
    expect(validate('desktop-state:patch', { sessionAllowedTools: {} })).toBe(INVALID);
    expect(validate('desktop-state:patch', { schema: 2 })).toBe(INVALID);
  });

  it('sessions:remove demands an explicit boolean confirm field', () => {
    expect(validate('sessions:remove', { id: 'abc' })).toBe(INVALID);
    expect(validate('sessions:remove', { id: 'abc', confirm: false })).toEqual({ id: 'abc', confirm: false });
  });

  it('window:set-chrome accepts the three themes and nothing else', () => {
    for (const theme of ['dark', 'light', 'warm']) expect(validate('window:set-chrome', { theme })).toEqual({ theme });
    for (const bad of [{ theme: '#fff' }, { theme: 'cool' }, {}, { theme: 1 }, 'dark', null]) {
      expect(validate('window:set-chrome', bad), JSON.stringify(bad)).toBe(INVALID);
    }
  });

  it('window:set-chrome rebuilds the object, so an extra field never reaches the handler', () => {
    expect(validate('window:set-chrome', { theme: 'dark', color: 'red' })).toEqual({ theme: 'dark' });
  });
});
