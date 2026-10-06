import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFrameObserver } from '../ui/frame-observer.js';
import { createScrollbarBridge } from '../ui/scrollbar-controller.js';
import { eraseLinesPrefix } from '../ui/frame-differ.js';
import { parseInkFrame } from '../ui/frame-parser.js';

const frame = (cols = 80, rows = 24) => [
  'header', ...Array.from({ length: rows - 4 }, () => ' '.repeat(cols - 1) + '|'),
  'activity', 'status', '',
].join('\n');

function setup() {
  const terminal = Object.assign(new PassThrough(), { columns: 80, rows: 24,
    isTTY: true }) as unknown as NodeJS.WriteStream;
  terminal.resume();
  const bridge = createScrollbarBridge(() => true);
  const observer = createFrameObserver({ stdout: terminal, terminal, scrollbar: bridge });
  const layout = (cols = 80, rows = 24) => {
    bridge.geometry = { trackCol: cols, trackTop: 2, trackRows: rows - 4,
      contentRows: 100, offset: 0, thumb: { start: 16, size: 4 }, revision: 1 };
    bridge.onGeometry?.();
  };
  return { terminal, bridge, observer, layout };
}

describe('output-confirmed scrollbar geometry', () => {
  afterEach(() => vi.useRealTimers());
  it('requests one redraw after a resize burst without a confirming frame', () => {
    vi.useFakeTimers();
    const { terminal, bridge, observer, layout } = setup();
    const requestRedraw = vi.fn();
    bridge.requestRedraw = requestRedraw;
    try {
      layout(); observer.stdout.write(frame());
      terminal.columns = 81; terminal.emit('resize');
      expect(bridge.frameReady).toBe(false);
      vi.advanceTimersByTime(40);
      terminal.columns = 80; terminal.emit('resize');
      vi.advanceTimersByTime(59);
      expect(requestRedraw).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(requestRedraw).toHaveBeenCalledTimes(1);
      expect(bridge.frameReady).toBe(false);
      observer.stdout.write(frame());
      expect(bridge.frameReady).toBe(true);
      vi.advanceTimersByTime(100);
      expect(requestRedraw).toHaveBeenCalledTimes(1);
    } finally { observer.dispose(); terminal.destroy(); }
  });
  it('skips recovery after a valid frame and cancels pending recovery on dispose', () => {
    vi.useFakeTimers();
    const { terminal, bridge, observer, layout } = setup();
    const requestRedraw = vi.fn();
    bridge.requestRedraw = requestRedraw;
    try {
      layout(); observer.stdout.write(frame());
      terminal.emit('resize');
      observer.stdout.write(frame());
      vi.advanceTimersByTime(60);
      expect(requestRedraw).not.toHaveBeenCalled();
      terminal.emit('resize');
      observer.dispose();
      vi.advanceTimersByTime(60);
      expect(requestRedraw).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    } finally { observer.dispose(); terminal.destroy(); }
  });
  it('accepts the first frame before layout and preserves write callback semantics', async () => {
    const { terminal, bridge, observer, layout } = setup();
    try {
      const callback = vi.fn();
      observer.stdout.write(frame(), callback);
      expect(bridge.frameReady).toBe(false);
      layout();
      expect(bridge.frameReady).toBe(true);
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(callback).toHaveBeenCalledTimes(1);
    } finally { observer.dispose(); terminal.destroy(); }
  });
  it('invalidates raw resize immediately and waits for the new matching output', () => {
    const { terminal, bridge, observer, layout } = setup();
    try {
      layout(); observer.stdout.write(frame());
      expect(bridge.frameReady).toBe(true);
      terminal.columns = 90; terminal.rows = 30; terminal.emit('resize');
      expect(bridge.frameReady).toBe(false);
      observer.stdout.write(eraseLinesPrefix(24) + frame());
      expect(bridge.frameReady).toBe(false);
      layout(90, 30);
      expect(bridge.frameReady).toBe(false);
      observer.stdout.write(eraseLinesPrefix(24) + frame(90, 30));
      expect(bridge.frameReady).toBe(true);
      observer.stdout.write('foreign output');
      layout(90, 30);
      expect(bridge.frameReady).toBe(false);
    } finally {
      observer.dispose();
      expect(terminal.listenerCount('resize')).toBe(0);
      terminal.destroy();
    }
  });
  it('rejects partial and cursor-moving writes', () => {
    expect(parseInkFrame('text')).toBeNull();
    expect(parseInkFrame('\x1b[2Jtext\n')).toBeNull();
    expect(parseInkFrame(eraseLinesPrefix(2) + '\x1b[32mtext\x1b[0m\n'))
      .toEqual(['\x1b[32mtext\x1b[0m']);
  });
});
