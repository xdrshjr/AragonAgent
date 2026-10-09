/**
 * THE STARTUP GAP (frame-diff-lost-sync-at-startup · fixes A + A+).
 *
 * `frame-differ.test.ts` feeds the differ chunks this repository constructs;
 * `frame-differ-ink-shape.test.ts` ties those chunk shapes to
 * `ink/build/log-update.js` alone. NEITHER wires a real Ink `render()` to the
 * real writer stack — which is exactly why nothing failed while every launch
 * printed the fallback notice: the two writes Ink makes OUTSIDE log-update
 * were invisible to both suites.
 *
 *   · Ink's root `<App>` hides the cursor through the render stdout on mount
 *     and shows it on unmount (`components/App.js` → `cli-cursor`) — two exact
 *     six-byte chunks the differ cannot recognise.
 *   · On any height shrink Ink abandons log-update and writes
 *     `clearTerminal + frame` in one chunk (`ink.js`'s `outputHeight >= rows`
 *     branch, reached synchronously from its own `'resize'` listener while the
 *     React tree still holds the pre-shrink height).
 *
 * This file closes that gap: a real `render()` on the real
 * `wrapStdoutForFrames`/`createFrameDiffer` stack, against a TTY-shaped
 * EventEmitter. Every assertion is ORDER-FREE on purpose — which of the
 * mount write and the seed frame reaches the proxy first differs between the
 * real CLI and any harness (diagnosis §3.1), and both orders must end at
 * `fallbacks === 0` with the cursor bytes on the wire.
 *
 * The `frame-observer` of `cli.tsx` is deliberately absent: it is a read-only
 * observer and adds nothing to the path under test.
 */

import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import React from 'react';
import { Box, Text, render as inkRender } from 'ink';
import { createFrameDiffer } from '../ui/frame-differ.js';
import { wrapStdoutForFrames, type FrameWriterHandle } from '../ui/stdout-frame-writer.js';
import { frameHeight } from '../ui/layout/frame.js';

const CURSOR_HIDE = '\x1b[?25l';
const CURSOR_SHOW = '\x1b[?25h';
/** `ansiEscapes.clearTerminal` — the tall-frame prefix of `ink.js`'s fallback. */
const CLEAR_TERMINAL = '\x1b[2J\x1b[3J\x1b[H';
/** The erase-down sequence only `fullRepaint` emits — the "full" discriminator. */
const ERASE_DOWN = '\x1b[J';

/** A TTY-shaped stdout: rows/columns mutable, `'resize'` emitted by the driver. */
class FakeTty extends EventEmitter {
  rows: number;
  columns: number;
  readonly isTTY = true;
  private readonly chunks: string[] = [];

  constructor(rows: number, columns: number) {
    super();
    this.rows = rows;
    this.columns = columns;
  }

  write(chunk: string, _encoding?: unknown, cb?: unknown): boolean {
    this.chunks.push(chunk);
    if (typeof cb === 'function') (cb as () => void)();
    return true;
  }

  /** Everything that reached the wire, in order. */
  get bytes(): string {
    return this.chunks.join('');
  }

  /** The last non-empty write — the terminal's final state. */
  get lastWrite(): string {
    for (let i = this.chunks.length - 1; i >= 0; i -= 1) {
      if (this.chunks[i]!.length > 0) return this.chunks[i]!;
    }
    return '';
  }
}

/**
 * The AppShell shape from `ui/layout/AppShell.tsx`: a root box pinned to
 * `frameHeight(rows)` (invariant I-1), a header row, a flex viewport, a toast
 * row and a status row. `tick` stands in for the live spinner/clock content
 * that re-renders the real App a few times a second.
 */
function Frame({ rows, cols, tick }: { rows: number; cols: number; tick: number }) {
  return React.createElement(
    Box,
    { flexDirection: 'column', height: frameHeight(rows), width: cols, overflow: 'hidden' },
    React.createElement(Box, { height: 1, flexShrink: 0 }, React.createElement(Text, null, 'header')),
    React.createElement(
      Box,
      { flexDirection: 'column', flexGrow: 1, overflow: 'hidden' },
      React.createElement(Text, null, `viewport tick=${tick}`),
    ),
    React.createElement(Box, { height: 1, flexShrink: 0 }, React.createElement(Text, null, 'toast')),
    React.createElement(Box, { height: 1, flexShrink: 0 }, React.createElement(Text, null, 'status')),
  );
}

interface AppHandle {
  element: React.ReactNode;
  /** Force a re-render with new content, like the spinner tick does. */
  tick(n: number): void;
}

/**
 * The App plus its size state. The 50 ms debounced `'resize'` listener mirrors
 * `ui/layout/useTerminalSize.ts`: the React tree keeps the OLD height across
 * that window, which is precisely the state in which Ink's synchronous resize
 * render takes its tall-frame branch.
 */
function makeApp(tty: FakeTty): AppHandle {
  let setTick: ((n: number) => void) | undefined;
  const App = () => {
    const [size, setSize] = React.useState({ rows: tty.rows, cols: tty.columns });
    const [tick, setTickState] = React.useState(0);
    setTick = setTickState;
    React.useEffect(() => {
      const onResize = () =>
        setTimeout(() => setSize({ rows: tty.rows, cols: tty.columns }), 50);
      tty.on('resize', onResize);
      return () => {
        tty.off('resize', onResize);
      };
    }, []);
    return React.createElement(Frame, { rows: size.rows, cols: size.cols, tick });
  };
  return { element: React.createElement(App), tick: (n) => setTick?.(n) };
}

interface Session {
  tty: FakeTty;
  writer: FrameWriterHandle;
  notices: string[];
  tick(n: number): void;
  unmount(): void;
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Mount the real stack on a fake TTY of `rows` rows — `cli.tsx` in miniature. */
function startSession(rows: number): Session {
  const tty = new FakeTty(rows, 100);
  const notices: string[] = [];
  const writer = wrapStdoutForFrames(
    tty as unknown as NodeJS.WriteStream,
    createFrameDiffer({
      sync: true,
      rows: () => tty.rows,
      cols: () => tty.columns,
      onFirstFallback: () => notices.push('raised'),
    }),
  );
  const app = makeApp(tty);
  const instance = inkRender(app.element, {
    exitOnCtrlC: false,
    patchConsole: false,
    stdout: writer.stdout,
  });
  return {
    tty,
    writer,
    notices,
    tick: app.tick,
    unmount: () => instance.unmount(),
  };
}

describe('real Ink on the real writer stack — startup (fix A)', () => {
  it('mounts and re-renders with zero fallbacks, and the cursor bytes still reach the terminal', async () => {
    const s = startSession(24);
    try {
      await sleep(120);
      s.tick(1);
      await sleep(120);
      s.tick(2);
      await sleep(120);

      const stats = s.writer.stats();
      // (a) The startup cascade — cursor-mode writes plus the seed frame — is
      // no longer mistaken for a desync, in EITHER arrival order.
      expect(stats.fallbacks).toBe(0);
      expect(s.notices).toHaveLength(0);
      // The differ was genuinely in the loop (not a geometry stand-down), so
      // `fallbacks === 0` above means something.
      expect(stats.framesTotal).toBeGreaterThan(0);

      // (b) Absorbed is not dropped: Ink's mount-time hide reached the wire
      // untransformed and uncounted.
      expect(s.tty.bytes).toContain(CURSOR_HIDE);
    } finally {
      s.unmount();
    }
    // And the symmetric unmount write lands too.
    expect(s.tty.bytes).toContain(CURSOR_SHOW);
    expect(s.writer.stats().fallbacks).toBe(0);
  });

  it('keeps a cursor sequence glued to real content conservative (miss => counted)', async () => {
    // Fail-safe direction: only the EXACT six-byte chunk is absorbed. A cursor
    // sequence mixed into a longer write is still a write the differ cannot
    // reason about, and must stay a counted fallback rather than be swallowed.
    const s = startSession(24);
    try {
      await sleep(120);
      s.writer.stdout.write(`${CURSOR_HIDE}trailing bytes`);
      await sleep(50);
      expect(s.writer.stats().fallbacks).toBe(1);
      expect(s.notices).toHaveLength(1);
      expect(s.tty.bytes).toContain(`${CURSOR_HIDE}trailing bytes`);
    } finally {
      s.unmount();
    }
  });
});

describe('real Ink on the real writer stack — shrink resize (fix A+)', () => {
  it('a one-row shrink stays uncounted and the next addressed frame is a full repaint', async () => {
    const s = startSession(24);
    try {
      await sleep(120);
      s.tick(1);
      await sleep(120);
      const before = s.writer.stats();
      expect(before.framesTotal).toBeGreaterThan(0); // warm cache, differ active

      // Shrink by one row. Ink re-renders SYNCHRONOUSLY from its own resize
      // listener while the tree still holds 24-row geometry, so its 23-line
      // frame takes the `outputHeight >= rows` branch: clearTerminal + frame.
      s.tty.rows = 23;
      s.tty.emit('resize');
      await sleep(200); // past the 50 ms size debounce; new-height frame painted

      const after = s.writer.stats();
      expect(after.fallbacks).toBe(0); // (c) Ink's own write, not a desync
      expect(s.notices).toHaveLength(0);
      // The clearTerminal bytes passed through (nothing swallowed) …
      expect(s.tty.bytes).toContain(CLEAR_TERMINAL);
      // … the cache it invalidated made the next addressed frame a FULL repaint.
      expect(after.framesFull).toBeGreaterThan(before.framesFull);
      expect(after.framesFull - before.framesFull).toBe(1);
      expect(s.tty.lastWrite).toContain(ERASE_DOWN);
    } finally {
      s.unmount();
    }
  });
});

describe('real Ink WITHOUT the writer — the --no-diff-render path', () => {
  it('writes Ink raw output untouched: cursor bytes in, nothing of the differ', async () => {
    // `--no-diff-render` builds no writer at all, so the fix must be invisible
    // here. Pinned structurally: Ink's own control bytes present, and not one
    // byte of differ vocabulary (DEC 2026 envelope, erase-down full repaint).
    const tty = new FakeTty(24, 100);
    const app = makeApp(tty);
    const instance = inkRender(app.element, {
      exitOnCtrlC: false,
      patchConsole: false,
      stdout: tty as unknown as NodeJS.WriteStream,
    });
    try {
      await sleep(120);
      app.tick(1);
      await sleep(120);
    } finally {
      instance.unmount();
    }

    expect(tty.bytes).toContain(CURSOR_HIDE);
    expect(tty.bytes).toContain(CURSOR_SHOW);
    expect(tty.bytes).toContain('viewport tick=0'); // frames really were written
    expect(tty.bytes).not.toContain('\x1b[?2026h');
    expect(tty.bytes).not.toContain(ERASE_DOWN);
    expect(tty.bytes).not.toContain('Frame diffing lost sync');
  });
});


describe('product fixed composer ANSI writes', () => {
  it.each(['at-last-column', 'virtual-column'] as const)(
    'skips unchanged input rows with %s pending wrap', async model => {
      const { createTerminalHarness, settleTerminal } = await import('./helpers/terminal-harness.js');
      const { createVtScreen } = await import('./helpers/vt-screen.js');
      const { AppShell } = await import('../ui/layout/AppShell.js');
      const { Composer } = await import('../ui/Composer.js');
      const { ScrollViewport } = await import('../ui/layout/ScrollViewport.js');
      const { getTheme } = await import('../ui/theme.js');
      const terminal = createTerminalHarness(80, 24, false);
      const screen = createVtScreen(24, 80, model);
      const caps = { unicode: false, colorLevel: 0 } as const;
      const theme = getTheme('cool', caps);
      const differ = createFrameDiffer({ sync: false, rows: () => 24 });
      const writer = wrapStdoutForFrames(terminal.stdout, differ);
      terminal.stdout.on('data', (chunk: Buffer) => screen.write(chunk.toString()));
      const node = (n: number, expanded = false) => React.createElement(AppShell, {
        rows: 24, cols: 80, header: React.createElement(Text, null, 'Header'),
        viewportRows: expanded ? 17 : 18, composerSlotRows: 3, statusRows: expanded ? 2 : 1,
        status: React.createElement(Text, null, 'Idle C? Th:O --t/s 0s'),
        details: React.createElement(Text, null, '^G less'),
        composer: React.createElement(Composer, { cols: 79, terminalRows: 24, isActive: true,
          cursorVisible: false, reducedMotion: true, running: false, history: [], commands: [],
          cwd: process.cwd(), showHint: false, submitCount: 0, hintsEnabled: true,
          agentMode: 'build', theme, caps, onSubmit: () => ({ accepted: true }) }),
        viewport: React.createElement(ScrollViewport, { theme, caps, cols: 79,
          children: React.createElement(Text, null, 'body ' + n + '\n' + 'history\n'.repeat(n)) }),
      });
      const instance = inkRender(node(1), { stdout: writer.stdout, stdin: terminal.stdin,
        stderr: terminal.stdout, exitOnCtrlC: false, patchConsole: false });
      try {
        await settleTerminal(); await settleTerminal();
        // Ink initial raw mount primes the writer; establish its first parsed frame.
        instance.rerender(node(0)); await settleTerminal();
        expect(differ.stats().framesFull).toBe(1);
        const initialFallbacks = differ.stats().fallbacks;
        const baseline = [19, 20, 21].map(row => screen.line(row));
        for (let n = 2; n <= 20; n++) {
          screen.resetTouchedRows();
          const chunkStart = terminal.frames.length;
          instance.rerender(node(n)); await settleTerminal();
          expect([19, 20, 21].map(row => screen.line(row))).toEqual(baseline);
          expect(screen.touchedRows().filter(row => row >= 19 && row <= 21),
            JSON.stringify({ n, stats: differ.stats(), chunks: terminal.frames.slice(chunkStart) })).toEqual([]);
          expect(differ.stats().fallbacks).toBe(initialFallbacks);
        }
        instance.rerender(node(21, true)); await settleTerminal();
        expect(screen.line(19)).toContain('Ask a question');
        expect(differ.stats().fallbacks).toBe(initialFallbacks);
      } finally { instance.unmount(); instance.cleanup(); writer.dispose(); terminal.dispose(); }
    });
});
