/**
 * `/perf` and `/perf reset` (tui-render-performance §5.4 / AC-9).
 *
 * Driven through `runSlashInput` rather than by calling the command object, so
 * the argument parsing is exercised the way a user reaches it.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { registerBuiltinCommands } from '../commands/builtins.js';
import { CommandRegistry, runSlashInput, type CommandContext } from '../commands/registry.js';
import {
  formatPerfReport,
  readPerfSnapshot,
  setFrameStatsProvider,
  setPerfResetHook,
  setPerfSnapshotProvider,
  type PerfSnapshot,
} from '../commands/perf.js';
import type { FrameWriterStats } from '../ui/frame-differ.js';
import { clearRenderCaches, highlightCached, renderCacheStats } from '../ui/render-cache.js';

const registry = new CommandRegistry();
registerBuiltinCommands(registry);

const SNAPSHOT: PerfSnapshot = {
  rung: 2,
  intervalMs: 80,
  lastCommitMs: 61.4,
  governorEnabled: true,
  totalEntries: 4213,
  retain: 1000,
  droppedEntries: 3213,
  mountedEntries: 38,
  heightsMeasured: 412,
  heightsEstimated: 6,
  cols: 132,
  mode: 'fullscreen',
  viewportRows: 44,
  offset: 0,
};

interface Harness {
  ctx: (args: string) => CommandContext;
  notices: string[];
  toasts: string[];
}

function harness(): Harness {
  const notices: string[] = [];
  const toasts: string[] = [];
  const ctx = (args: string): CommandContext =>
    ({
      args,
      notify: (_level: string, text: string) => notices.push(text),
      toast: (_level: string, text: string) => toasts.push(text),
    }) as unknown as CommandContext;
  return { ctx, notices, toasts };
}

const WRITER_STATS: FrameWriterStats = {
  framesTotal: 1842,
  framesDiffed: 1839,
  framesFull: 3,
  linesWritten: 2578,
  bytesWritten: 112_362,
  fallbacks: 0,
  repaints: 0,
};

afterEach(() => {
  setPerfSnapshotProvider(null);
  setPerfResetHook(null);
  setFrameStatsProvider(null);
  clearRenderCaches();
});

describe('formatPerfReport', () => {
  it('reports the six documented lines', () => {
    const report = formatPerfReport(SNAPSHOT);
    const lines = report.split('\n');
    expect(lines).toHaveLength(6);
    expect(lines[0]).toContain('render');
    expect(lines[1]).toContain('transcript');
    expect(lines[2]).toContain('heights');
    expect(lines[3]).toContain('caches');
    expect(lines[4]).toContain('mode');
    expect(lines[5]).toContain('writer');
  });

  it('names the frame writer counters when the writer is attached', () => {
    setFrameStatsProvider(() => WRITER_STATS);
    const report = formatPerfReport(SNAPSHOT);
    expect(report).toContain('frames 1842 (diffed 1839, full 3)');
    expect(report).toContain('fallbacks 0');
  });

  it('distinguishes "diff render off" from a crashed writer (§4.2)', () => {
    // No provider registered at all. Printing zeroes here would make the flag
    // being off indistinguishable from the writer having died.
    expect(formatPerfReport(SNAPSHOT)).toContain('writer     full  -  diff render off');
  });

  it('names the mounted count -- the number render-budget gates on (AC-9)', () => {
    expect(formatPerfReport(SNAPSHOT)).toContain('38 mounted');
    expect(formatPerfReport(SNAPSHOT)).toContain('3213 dropped');
    expect(formatPerfReport(SNAPSHOT)).toContain('1000 retained');
  });

  it('shows the eco marker only above rung 0 (I-L4-2)', () => {
    expect(formatPerfReport(SNAPSHOT)).toContain('eco');
    expect(formatPerfReport({ ...SNAPSHOT, rung: 0 })).not.toContain('eco');
  });

  it('says so when the governor is switched off', () => {
    expect(formatPerfReport({ ...SNAPSHOT, governorEnabled: false })).toContain('governor off');
  });

  it('stays ASCII, so it is safe on a legacy console', () => {
    expect(formatPerfReport(SNAPSHOT)).not.toMatch(/[^\x00-\x7f]/);
  });
});

describe('/perf', () => {
  it('prints the report as a notice', async () => {
    setPerfSnapshotProvider(() => SNAPSHOT);
    const h = harness();
    await runSlashInput(registry, '/perf', h.ctx);
    expect(h.notices).toHaveLength(1);
    expect(h.notices[0]).toContain('38 mounted');
  });

  it('says the TUI is not mounted rather than printing zeroes', async () => {
    // Reachable from a detached tree. A block of zeroes would read like a
    // renderer doing nothing, which is a different and wrong diagnosis.
    const h = harness();
    await runSlashInput(registry, '/perf', h.ctx);
    expect(h.notices[0]).toContain('not mounted');
  });

  it('rejects an unknown argument', async () => {
    const h = harness();
    await runSlashInput(registry, '/perf nonsense', h.ctx);
    expect(h.notices[0]).toContain('Unknown argument');
  });
});

describe('/perf reset', () => {
  it('clears the render caches and calls the reset hook', async () => {
    highlightCached('const a = 1;', 'ts');
    expect(renderCacheStats().highlightEntries).toBe(1);

    let resets = 0;
    setPerfResetHook(() => {
      resets += 1;
    });

    const h = harness();
    await runSlashInput(registry, '/perf reset', h.ctx);
    expect(renderCacheStats().highlightEntries).toBe(0);
    expect(resets).toBe(1);
    expect(h.toasts[0]).toContain('cleared');
  });

  it('works with no App mounted', async () => {
    const h = harness();
    await runSlashInput(registry, '/perf reset', h.ctx);
    expect(h.toasts).toHaveLength(1);
  });
});

describe('the snapshot channel', () => {
  it('detaches cleanly, so a torn-down tree cannot be read', () => {
    setPerfSnapshotProvider(() => SNAPSHOT);
    expect(readPerfSnapshot()).toEqual(SNAPSHOT);
    setPerfSnapshotProvider(null);
    expect(readPerfSnapshot()).toBeNull();
  });
});
