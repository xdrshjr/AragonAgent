/** AC-E3: a launch that dies on startup names its likely cause instead of Playwright's bare message. */
import { describe, expect, it } from 'vitest';
import { explainLaunchFailure } from './e2e/fixtures/launch.js';

const CLOSED = new Error('electron.launch: Target page, context or browser has been closed');

describe('explainLaunchFailure', () => {
  it('points at the single-instance lock when the app quits right after starting', () => {
    const explained = explainLaunchFailure(CLOSED, { sourceNewerThanDist: false });
    expect(explained.message).toContain('single-instance lock');
    expect(explained.message).toContain('--e2e-user-data');
    expect(explained.message).toContain(CLOSED.message);
    expect(explained.cause).toBe(CLOSED);
  });

  it('points at a stale build when src is newer than dist', () => {
    expect(explainLaunchFailure(CLOSED, { sourceNewerThanDist: true }).message).toContain('npm run build');
  });

  it('names a busy port', () => {
    const explained = explainLaunchFailure(new Error('listen EADDRINUSE 127.0.0.1:4010'), { sourceNewerThanDist: false });
    expect(explained.message).toContain('port is already in use');
  });

  it('returns an unrecognized error untouched', () => {
    const odd = new Error('something else entirely');
    expect(explainLaunchFailure(odd, { sourceNewerThanDist: false })).toBe(odd);
  });

  it('wraps a non-Error rejection', () => {
    expect(explainLaunchFailure('boom', { sourceNewerThanDist: false }).message).toBe('boom');
  });
});
