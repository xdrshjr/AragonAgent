/**
 * AC-G16 — the usage counters are visible and erasable (§9 / FG7).
 *
 * The file was being written from the first day the ranking shipped and could be
 * read by nobody and deleted by no one. "Visible and erasable" is the floor for
 * locally stored behavioural data however innocuous it is, and the reset path in
 * particular has a trap worth pinning: forgetting to clear the module-level
 * `dirty` flag makes the file reappear on the next flush, seconds after the user
 * asked for it to be gone, and only under some call orders.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const tmp = { root: '' };

vi.mock('../paths.js', async () => {
  const actual = await vi.importActual<typeof import('../paths.js')>('../paths.js');
  return { ...actual, getUserDataDir: () => join(tmp.root, 'data') };
});

const usage = await import('../usage.js');
const { runSkillsCommand } = await import('../cli-commands.js');
const { cleanup, makeTmpDir } = await import('./helpers.js');

beforeEach(() => {
  tmp.root = makeTmpDir('aragon-usage-surface-');
  mkdirSync(join(tmp.root, 'data'), { recursive: true });
  usage.resetUsageForTests();
});

afterEach(() => {
  usage.resetUsageForTests();
  cleanup(tmp.root);
});

describe('listUsage (§9)', () => {
  it('returns nothing when there is nothing recorded', () => {
    expect(usage.listUsage()).toEqual([]);
  });

  it('sorts most-recently-used first, breaking ties by name', () => {
    usage.recordUse('older', 1_000);
    usage.recordUse('newest', 3_000);
    usage.recordUse('b-tied', 2_000);
    usage.recordUse('a-tied', 2_000);

    expect(usage.listUsage().map((r) => r.name)).toEqual(['newest', 'a-tied', 'b-tied', 'older']);
  });

  it('reports the count and the timestamp, and nothing else', () => {
    // The privacy claim in the README is only true if this shape stays this
    // narrow — no arguments, no cwd, no machine id, ever.
    usage.recordUse('deploy', 5_000);
    usage.recordUse('deploy', 6_000);
    expect(usage.listUsage()).toEqual([{ name: 'deploy', useCount: 2, lastUsedAt: 6_000 }]);
  });

  it('still reads history after tracking is switched off', () => {
    // `usageTracking: false` stops new writes. Telling a user "nothing here"
    // while the file still exists would make the setting look like an erasure it
    // is not.
    usage.recordUse('deploy', 1_000);
    usage.flushUsage();
    usage.resetUsageForTests();
    expect(usage.listUsage().map((r) => r.name)).toEqual(['deploy']);
  });
});

describe('resetUsage (AC-G16 / P2-3)', () => {
  it('deletes the file, empties the list, and reports how much went', () => {
    usage.recordUse('a');
    usage.recordUse('b');
    usage.flushUsage();
    expect(existsSync(usage.getUsagePath())).toBe(true);

    expect(usage.resetUsage()).toBe(2);
    expect(usage.listUsage()).toEqual([]);
    expect(existsSync(usage.getUsagePath())).toBe(false);
  });

  it('a later flush does NOT resurrect the file (the `dirty` trap)', () => {
    // `recordUse` sets `dirty`; `flushUsage` only returns early while it is
    // false. Clearing the map without clearing the flag rebuilds the file from
    // an empty map on the very next flush — the user watches their deletion undo
    // itself, and only in certain call orders.
    usage.recordUse('a');
    usage.flushUsage();
    usage.resetUsage();
    usage.flushUsage();
    expect(existsSync(usage.getUsagePath())).toBe(false);
  });

  it('is idempotent and safe on an empty store', () => {
    expect(usage.resetUsage()).toBe(0);
    expect(usage.resetUsage()).toBe(0);
    expect(existsSync(usage.getUsagePath())).toBe(false);
  });

  it('counting works again straight after a reset', () => {
    usage.recordUse('a');
    usage.resetUsage();
    usage.recordUse('a', 9_000);
    usage.flushUsage();
    expect(usage.listUsage()).toEqual([{ name: 'a', useCount: 1, lastUsedAt: 9_000 }]);
    expect(existsSync(usage.getUsagePath())).toBe(true);
  });
});

describe('aragon skills usage (§9)', () => {
  let out: string[];
  let err: string[];
  let restore: Array<() => void>;

  beforeEach(() => {
    out = [];
    err = [];
    const so = process.stdout.write.bind(process.stdout);
    const se = process.stderr.write.bind(process.stderr);
    process.stdout.write = ((c: string) => {
      out.push(String(c));
      return true;
    }) as typeof process.stdout.write;
    process.stderr.write = ((c: string) => {
      err.push(String(c));
      return true;
    }) as typeof process.stderr.write;
    restore = [
      () => {
        process.stdout.write = so;
      },
      () => {
        process.stderr.write = se;
      },
    ];
  });

  afterEach(() => {
    for (const fn of restore) fn();
  });

  it('prints the path and the privacy statement even with nothing recorded', async () => {
    expect(await runSkillsCommand('usage', undefined, {}, {}, '0.0.0')).toBe(0);
    expect(out.join('')).toContain('No skill usage recorded yet.');
  });

  it('lists the counters and says where the file lives', async () => {
    usage.recordUse('deploy', 1_000);
    expect(await runSkillsCommand('usage', undefined, {}, {}, '0.0.0')).toBe(0);
    const text = out.join('');
    expect(text).toContain('deploy');
    expect(text).toContain('never transmitted');
    expect(text).toContain(usage.getUsagePath());
  });

  it('emits machine-readable output under --json', async () => {
    usage.recordUse('deploy', 1_000);
    await runSkillsCommand('usage', undefined, { json: true }, {}, '0.0.0');
    const parsed = JSON.parse(out.join('')) as { skills: Array<{ name: string }> };
    expect(parsed.skills.map((s) => s.name)).toEqual(['deploy']);
  });

  it('refuses --reset without --yes, and says which flag to add', async () => {
    // Same rule as every other mutating one-shot: no half-interactive prompt
    // that would hang in CI, and no destructive default.
    usage.recordUse('deploy');
    usage.flushUsage();
    expect(await runSkillsCommand('usage', undefined, { reset: true }, {}, '0.0.0')).toBe(2);
    expect(err.join('')).toContain('--yes');
    expect(existsSync(usage.getUsagePath())).toBe(true);
  });

  it('--reset --yes deletes the file and reports the count', async () => {
    usage.recordUse('deploy');
    usage.flushUsage();
    expect(await runSkillsCommand('usage', undefined, { reset: true, yes: true }, {}, '0.0.0')).toBe(
      0,
    );
    expect(out.join('')).toContain('Cleared 1 usage entry.');
    expect(existsSync(usage.getUsagePath())).toBe(false);
  });
});
