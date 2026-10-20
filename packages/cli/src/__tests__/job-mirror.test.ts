/**
 * `JobLogMirror` — the escape hatch (long-task-jobs AC-32).
 *
 * Every assertion here is about the mirror NOT becoming a new failure mode: it
 * is bounded, it is optional, and it never throws into the job that is running.
 */

import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JobLogMirror, pruneJobLogSessions } from '../proc/log-mirror.js';
import { PROC_LIMITS } from '../proc/limits.js';

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), 'aragon-job-mirror-'));
}

/** The mirror flushes on a timer; dispose() flushes synchronously. */
function settle(mirror: JobLogMirror): void {
  mirror.dispose();
}

describe('JobLogMirror', () => {
  it('appends what the job printed, under <root>/<id>.log', () => {
    const root = tempRoot();
    try {
      const mirror = new JobLogMirror({ root: () => root, flushMs: 0 });
      mirror.write('t1', 'epoch 1\n');
      settle(mirror);
      expect(mirror.pathOf('t1')).toBe(join(root, 't1.log'));
      expect(readFileSync(join(root, 't1.log'), 'utf8')).toContain('epoch 1');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('stops at the byte cap and says so once', () => {
    const root = tempRoot();
    try {
      const mirror = new JobLogMirror({ root: () => root, maxBytes: 20, flushMs: 0 });
      mirror.write('t1', 'x'.repeat(50));
      mirror.write('t1', 'y'.repeat(50));
      settle(mirror);
      const body = readFileSync(join(root, 't1.log'), 'utf8');
      expect(body.length).toBeLessThan(60);
      expect(body).toContain('[mirror truncated]');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('creates no directory until a job actually prints', () => {
    const root = tempRoot();
    try {
      const mirror = new JobLogMirror({ root: () => join(root, 'jobs', 's1') });
      // `open()` is the only thing that touches the filesystem.
      expect(existsSync(join(root, 'jobs'))).toBe(false);
      mirror.write('t9', '');
      settle(mirror);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('AC-32: a filesystem error is swallowed, never thrown at the job', () => {
    // A FILE sitting where the directory must go is the reproducible stand-in for
    // ENOSPC / EACCES: `mkdirSync` fails and the mirror stays degraded.
    const root = tempRoot();
    try {
      writeFileSync(join(root, 'blocked'), 'not a directory');
      const mirror = new JobLogMirror({ root: () => join(root, 'blocked', 'nested') });
      mirror.write('t1', 'hello\n');
      expect(() => settle(mirror)).not.toThrow();
      expect(mirror.pathOf('t1')).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('retention keeps only the newest directories', () => {
    const root = tempRoot();
    try {
      for (let i = 0; i < PROC_LIMITS.mirrorRetainDirs + 3; i += 1) {
        const dir = join(root, `s${i}`);
        const mirror = new JobLogMirror({ root: () => dir, flushMs: 0 });
        mirror.write('t1', `run ${i}\n`);
        settle(mirror);
      }
      pruneJobLogSessions(root);
      expect(readdirSync(root).length).toBeLessThanOrEqual(PROC_LIMITS.mirrorRetainDirs);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
