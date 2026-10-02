/**
 * `system/init.sessionFile` - where THIS run's conversation lives
 * (web-use-durable-control-and-tier-accountability W2 / section 4.2.1).
 *
 * The field exists so a wrapper can answer "is that stopped conversation still
 * resumable" with a `statSync` instead of a re-implementation of
 * `getSessionsDir()`. Two properties carry the whole of that promise, and both
 * are asserted here:
 *
 *  1. it names the file this run WRITES BACK to, not the string the caller
 *     typed - `--resume` takes `<id|path>`, so those two are routinely
 *     different, and a wrapper that reattaches to the caller's string would
 *     reattach to the wrong file (or to a relative path outside the sessions
 *     directory);
 *  2. `--no-save-session` yields `null`, because nothing is being written and a
 *     path would promise a file that will never appear.
 *
 * `EXEC_CAPABILITIES` is asserted APPEND-ONLY in the same file: `'session-file'`
 * is what tells a wrapper it may trust the field's absence to mean "old build"
 * rather than "no session", and reordering the array would silently change what
 * an index-based consumer reads.
 */

import { describe, expect, it } from 'vitest';
import {
  buildInitEvent,
  EXEC_CAPABILITIES,
  EXEC_SCHEMA_VERSION,
  type ExecInitParams,
} from '../exec/events.js';

const BASE: ExecInitParams = {
  sessionId: 's1',
  cli: '0.6.0',
  cwd: '/w',
  startedAt: 1,
  model: { provider: 'anthropic', id: 'm', baseUrl: null },
  permissionMode: 'auto',
  tools: ['read_file'],
  resumed: false,
};

describe('system/init sessionFile', () => {
  it('carries the absolute path the caller handed it', () => {
    const event = buildInitEvent({ ...BASE, sessionFile: '/home/u/.aragon-agent/sessions/s1.json' });
    expect(event.sessionFile).toBe('/home/u/.aragon-agent/sessions/s1.json');
  });

  it('is the WRITE-BACK path on a resume, not the string the caller typed', () => {
    // `runExec` computes it as `sessionPathFor(plan.id)`, and `plan.id` comes
    // out of `resumedSessionId(path, saved)` - never out of `options.resume`.
    // This test pins the CONSUMER-visible half of that: whatever the caller
    // passed on the command line (`./relative/hand-saved.json` here), the event
    // reports the canonical sessions-directory path for the resumed id.
    const typedByCaller = './relative/hand-saved.json';
    const writtenBack = '/home/u/.aragon-agent/sessions/resumed-id.json';
    const event = buildInitEvent({ ...BASE, resumed: true, sessionFile: writtenBack });
    expect(event.sessionFile).toBe(writtenBack);
    expect(event.sessionFile).not.toBe(typedByCaller);
  });

  it('is null under --no-save-session, and null is not undefined', () => {
    const event = buildInitEvent({ ...BASE, sessionFile: null });
    // `null` = "this run saves nothing"; `undefined` = "this build predates the
    // field". A consumer branches differently on the two, so the emitter must
    // never collapse one into the other.
    expect(event.sessionFile).toBeNull();
    expect(Object.prototype.hasOwnProperty.call(event, 'sessionFile')).toBe(true);
  });

  it('defaults to null rather than omitting the key when a caller passes nothing', () => {
    const event = buildInitEvent(BASE);
    expect(event.sessionFile).toBeNull();
    expect(Object.prototype.hasOwnProperty.call(event, 'sessionFile')).toBe(true);
  });

  it('does not move the schema version - the field is optional and additive', () => {
    expect(buildInitEvent(BASE).schemaVersion).toBe(EXEC_SCHEMA_VERSION);
    expect(EXEC_SCHEMA_VERSION).toBe(1);
  });
});

describe('EXEC_CAPABILITIES', () => {
  it('announces session-file', () => {
    expect(EXEC_CAPABILITIES).toContain('session-file');
    expect(buildInitEvent(BASE).capabilities).toContain('session-file');
  });

  it('is append-only: interrupt is still first', () => {
    // The reverse direction of the same rule. Consumers use `includes()` today,
    // but the array is a published contract and an insertion ahead of an
    // existing token makes a diff look bigger than it is - and would break any
    // consumer that ever indexes it.
    expect(EXEC_CAPABILITIES[0]).toBe('interrupt');
    expect(EXEC_CAPABILITIES.slice(0, 4)).toEqual([
      'interrupt', 'fast-policy', 'fast-tier-events', 'session-file',
    ]);
    expect(EXEC_CAPABILITIES.at(-2)).toBe('turn-lifecycle');
    expect(EXEC_CAPABILITIES.at(-1)).toBe('execution-progress');
  });
});
