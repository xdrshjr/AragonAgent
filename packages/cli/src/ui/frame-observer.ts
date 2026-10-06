import stripAnsi from 'strip-ansi';
import stringWidth from 'string-width';
import { parseInkFrame } from './frame-parser.js';
import { pickGlyphs } from './glyphs.js';
import type { ScrollbarBridge } from './scrollbar-controller.js';

export interface FrameSummary {
  columns: number;
  rows: number;
  trackTop: number;
  trackRows: number;
}

function summarizeFrame(chunk: unknown, rows: number, cols: number): FrameSummary | null {
  const lines = typeof chunk === 'string' ? parseInkFrame(chunk) : null;
  if (!lines || rows < 12 || cols < 40 || lines.length !== rows - 1) return null;
  const unicode = pickGlyphs({ unicode: true, colorLevel: 0 });
  const cells = new Set(['|', '#', unicode.scrollTrack, unicode.scrollThumb]);
  const plain = lines.map((line) => stripAnsi(line));
  const track = plain.slice(1, rows - 3);
  if (plain.some((line) => stringWidth(line) > cols) ||
    !track.every((line) => stringWidth(line) === cols && cells.has(line.slice(-1)))) return null;
  return { columns: cols, rows, trackTop: 2, trackRows: rows - 4 };
}

/** Observe before differ transformation, but acknowledge only after downstream write returns. */
export function createFrameObserver(options: {
  stdout: NodeJS.WriteStream;
  terminal: NodeJS.WriteStream;
  scrollbar: ScrollbarBridge;
}): { stdout: NodeJS.WriteStream; dispose(): void; invalidate(): void } {
  const { stdout, terminal, scrollbar } = options;
  let summary: FrameSummary | null = null;
  let disposed = false;
  let resizeTimer: ReturnType<typeof setTimeout> | null = null;
  const invalidate = (): void => { summary = null; scrollbar.invalidate(); };
  const onResize = (): void => {
    invalidate();
    if (resizeTimer) clearTimeout(resizeTimer);
    // Ink suppresses identical frames when a resize burst returns to its starting size.
    // Wait past the 50 ms React size debounce, then request a normal redraw if needed.
    resizeTimer = setTimeout(() => {
      resizeTimer = null;
      if (!disposed && !scrollbar.frameReady) scrollbar.requestRedraw?.();
    }, 60);
    resizeTimer.unref?.();
  };
  const match = (): void => {
    const g = scrollbar.geometry;
    scrollbar.frameReady = !!summary && !!g && summary.columns === terminal.columns &&
      summary.rows === terminal.rows && g.trackCol === summary.columns &&
      g.trackTop === summary.trackTop && g.trackRows === summary.trackRows;
  };
  const observe = (chunk: unknown): void => {
    summary = summarizeFrame(chunk, terminal.rows, terminal.columns);
    if (!summary) { invalidate(); return; }
    match();
  };
  scrollbar.onGeometry = match;
  terminal.on('resize', onResize);
  const bound = new Map<PropertyKey, unknown>();
  const proxy = new Proxy(stdout, {
    get(target, prop) {
      if (prop === 'write') return (...args: Parameters<NodeJS.WriteStream['write']>) => {
        const result = Reflect.apply(target.write, target, args) as boolean;
        if (!disposed) observe(args[0]);
        return result;
      };
      const value: unknown = Reflect.get(target, prop, target);
      if (typeof value !== 'function') return value;
      if (!bound.has(prop)) bound.set(prop, value.bind(target));
      return bound.get(prop);
    },
  });
  return { stdout: proxy, invalidate, dispose: () => {
    disposed = true;
    if (resizeTimer) clearTimeout(resizeTimer);
    resizeTimer = null;
    terminal.off('resize', onResize);
    scrollbar.onGeometry = undefined;
    invalidate();
  } };
}
