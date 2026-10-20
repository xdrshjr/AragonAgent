/**
 * Offscreen entry renderer (tui-native-terminal-scroll §4.5 / D4).
 *
 * Settled entries are rendered ONCE, to ANSI text, by a resident Ink instance that
 * writes to a fake stdout (`debug: true`: Ink then emits the complete layout in one
 * write per render and never touches log-update). The resulting rows go to the feed
 * and are printed; they are never mounted in the live React tree, so the per-frame
 * render cost stays proportional to what is on screen, not to the session length.
 *
 * Failure isolation (I-S12): one entry that throws while rendering degrades to a
 * single placeholder row. It must never block the queue or take the session down.
 */

import React from 'react';
import { EventEmitter } from 'node:events';
import { Box, render } from 'ink';
import type { Entry } from '../../agent/reducer.js';
import type { TermCapabilities } from '../capabilities.js';
import type { DensityMode } from '../density.js';
import type { Theme } from '../theme.js';
import { EntryView } from '../Transcript.js';
import { getLogger } from '../../logging/logger.js';
import { SCROLLBACK_LIMITS } from './limits.js';
import { elisionRow } from './overflow-print.js';

export interface EntryRenderOptions {
  theme: Theme;
  caps: TermCapabilities;
  density: DensityMode;
  thinkingVisible: boolean;
  reducedMotion: boolean;
}

export interface EntryRenderer {
  /** Rows for one entry at `cols` columns, capped at `maxRowsPerEntry`; `[]` when it renders as nothing. */
  renderEntry(entry: Entry, prev: Entry | undefined, cols: number, expanded?: boolean): string[];
  /**
   * The SAME rows, UNCAPPED.
   *
   * "Top give-way" (`overflow-print.ts`) slices one entry across two print passes, so it
   * needs the real row count and the real rows: `capRows` truncates before returning, and a
   * row budget computed from a truncated array puts the cut in the wrong place (a 800-row
   * answer would compute its cut on 400 rows and print rows the screen is still showing).
   * The cap is applied by the caller, once, where it knows how many rows are already printed.
   */
  renderEntryRows(
    entry: Entry, prev: Entry | undefined, cols: number, expanded?: boolean,
  ): string[];
  /** Rows for an arbitrary node (the startup header and opener). */
  renderNode(node: React.ReactNode, cols: number): string[];
  /** Options for LATER renders; already printed rows never change. */
  setOptions(partial: Partial<EntryRenderOptions>): void;
  stats(): { elidedRows: number; failures: number };
  dispose(): void;
}

interface Offscreen {
  cols: number;
  stdout: NodeJS.WriteStream;
  stdin: NodeJS.ReadStream;
  instance: ReturnType<typeof render>;
  /** The last chunk Ink wrote; `null` until it writes at all. */
  last: { value: string | null };
  /** Set by `RenderGuard` when a render throws; read synchronously after `rerender`. */
  failure: { error: unknown };
}

/**
 * Catches a throwing entry INSIDE the offscreen tree.
 *
 * Without it Ink's own boundary would print an error overview into the frame (which
 * would then be printed into the user's scrollback, forever) and unmount the
 * instance, so every later entry would fail too. With it the failure is a flag the
 * caller reads synchronously and the instance stays healthy (I-S12).
 */
class RenderGuard extends React.Component<
  { failure: { error: unknown }; children?: React.ReactNode },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }
  componentDidCatch(error: unknown): void {
    this.props.failure.error = error;
  }
  render(): React.ReactNode {
    return this.state.failed ? null : this.props.children;
  }
}

const NO_FAILURE = Symbol('no-failure');

function createOffscreen(cols: number): Offscreen {
  const last: { value: string | null } = { value: null };
  const stdout = Object.assign(new EventEmitter(), {
    columns: cols,
    rows: 1000,
    isTTY: false,
    write(chunk: string): boolean {
      last.value = chunk;
      return true;
    },
  }) as unknown as NodeJS.WriteStream;
  const stdin = Object.assign(new EventEmitter(), {
    isTTY: false,
    setEncoding() {},
    resume() {},
    pause() {},
    ref() {},
    unref() {},
  }) as unknown as NodeJS.ReadStream;
  const instance = render(null, {
    stdout, stdin, stderr: stdout, debug: true, exitOnCtrlC: false, patchConsole: false,
  });
  // A rejected exit promise nobody awaits is an unhandled rejection.
  void instance.waitUntilExit().catch(() => undefined);
  return { cols, stdout, stdin, instance, last, failure: { error: NO_FAILURE } };
}

/** A function, so the compiler does not narrow the mutable `last` box to `null`. */
function readFrame(target: Offscreen): string | null {
  return target.last.value;
}

function trimTrailingBlank(rows: string[]): string[] {
  let end = rows.length;
  while (end > 0 && rows[end - 1]!.trim().length === 0) end -= 1;
  return end === rows.length ? rows : rows.slice(0, end);
}

export function createEntryRenderer(initial: EntryRenderOptions): EntryRenderer {
  let options = initial;
  /**
   * Resident offscreen instances, keyed by width.
   *
   * TWO SLOTS, NOT ONE. Ink reads `columns` once, at creation, so a width change needs a new
   * instance - but a width change happens WITHIN one promotion pass as soon as the plan
   * measures at the box width (`previewCols`) and prints at `contentCols`, and a single slot
   * would then dispose and rebuild a complete Ink root on every such frame. Two slots cover
   * both widths of the current geometry; a third width (an actual resize) evicts the oldest.
   */
  const slots = new Map<number, Offscreen>();
  const MAX_SLOTS = 2;
  let elidedRows = 0;
  let failures = 0;
  let guardKey = 0;

  const disposeSlot = (cols: number): void => {
    const target = slots.get(cols);
    if (!target) return;
    slots.delete(cols);
    try {
      target.instance.unmount();
      target.instance.cleanup();
    } catch {
      // Tearing down a fake stream must never throw into an exit path.
    }
  };

  const dispose = (): void => {
    for (const cols of [...slots.keys()]) disposeSlot(cols);
  };

  /** Ink reads `columns` once, at creation, so a width change rebuilds the instance. */
  const ensure = (cols: number): Offscreen => {
    const resident = slots.get(cols);
    if (resident) {
      // Refresh the recency order so the OTHER width is the eviction candidate.
      slots.delete(cols);
      slots.set(cols, resident);
      return resident;
    }
    const evictable = [...slots.keys()][0];
    if (evictable !== undefined && slots.size >= MAX_SLOTS) disposeSlot(evictable);
    const created = createOffscreen(cols);
    slots.set(cols, created);
    return created;
  };

  const capRows = (rows: string[]): string[] => {
    const cap = SCROLLBACK_LIMITS.maxRowsPerEntry;
    if (rows.length <= cap) return rows;
    const hidden = rows.length - (cap - 1);
    elidedRows += hidden;
    return [...rows.slice(0, cap - 1), elisionRow(hidden)];
  };

  const renderFrame = (node: React.ReactNode, cols: number): string[] => {
    const target = ensure(Math.max(1, Math.floor(cols)));
    target.last.value = null;
    target.failure.error = NO_FAILURE;
    guardKey += 1;
    target.instance.rerender(
      <Box flexDirection="column" width={target.cols}>
        <RenderGuard key={guardKey} failure={target.failure}>{node}</RenderGuard>
      </Box>,
    );
    const frame = readFrame(target);
    const failure = target.failure.error;
    target.instance.rerender(null);
    if (failure !== NO_FAILURE) throw failure;
    if (frame === null) throw new Error('offscreen Ink instance produced no frame');
    return trimTrailingBlank(frame.split('\n'));
  };

  const failureRow = (label: string): string[] => {
    failures += 1;
    return [`[aragon] ${label} could not be rendered`];
  };

  const entryFrame = (
    entry: Entry, prev: Entry | undefined, cols: number, expanded: boolean,
  ): string[] => renderFrame(
    <EntryView
      entry={entry}
      prev={prev}
      expanded={expanded}
      thinkingVisible={options.thinkingVisible}
      reducedMotion={options.reducedMotion}
      density={options.density}
      theme={options.theme}
      caps={options.caps}
    />,
    cols,
  );

  const renderEntryRows = (
    entry: Entry, prev: Entry | undefined, cols: number, expanded = false,
  ): string[] => {
    try {
      return entryFrame(entry, prev, cols, expanded);
    } catch (error) {
      getLogger().warn('cli', 'entry_render_failed', {
        id: entry.id, kind: entry.kind, error: String(error),
      });
      return failureRow(`entry ${entry.id} (${entry.kind})`);
    }
  };

  return {
    renderEntry(entry, prev, cols, expanded = false) {
      return capRows(renderEntryRows(entry, prev, cols, expanded));
    },
    renderEntryRows,
    renderNode(node, cols) {
      try {
        return capRows(renderFrame(node, cols));
      } catch (error) {
        getLogger().warn('cli', 'node_render_failed', { error: String(error) });
        return failureRow('startup banner');
      }
    },
    setOptions(partial) {
      options = { ...options, ...partial };
    },
    stats: () => ({ elidedRows, failures }),
    dispose,
  };
}
