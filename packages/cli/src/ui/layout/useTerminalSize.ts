/**
 * Terminal size hook (spec §4.11).
 *
 * Ink recomputes its own layout on resize, but the React layer needs the new
 * `rows` to update `height={frameHeight(rows)}`. Without this hook the frame
 * keeps its old height after the window grows and leaves a dead band at the
 * bottom of the screen.
 */

import { useEffect, useState } from 'react';
import { useStdout } from 'ink';
import { FALLBACK_COLS, FALLBACK_ROWS } from './frame.js';

export interface TerminalSize {
  rows: number;
  cols: number;
}

/** Coalesce the burst of resize events a window drag produces. */
const RESIZE_THROTTLE_MS = 50;

interface StdoutLike {
  rows?: number;
  columns?: number;
  on?: (event: 'resize', listener: () => void) => unknown;
  off?: (event: 'resize', listener: () => void) => unknown;
  removeListener?: (event: 'resize', listener: () => void) => unknown;
}

function readSize(stdout: StdoutLike | undefined): TerminalSize {
  const rows = stdout?.rows;
  const cols = stdout?.columns;
  return {
    rows: rows && rows > 0 ? rows : FALLBACK_ROWS,
    cols: cols && cols > 0 ? cols : FALLBACK_COLS,
  };
}

export function useTerminalSize(): TerminalSize {
  const { stdout } = useStdout();
  const [size, setSize] = useState<TerminalSize>(() => readSize(stdout as StdoutLike | undefined));

  useEffect(() => {
    const stream = stdout as StdoutLike | undefined;
    if (!stream || typeof stream.on !== 'function') return undefined;

    let timer: NodeJS.Timeout | null = null;
    const onResize = (): void => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        const next = readSize(stream);
        setSize((prev) => (prev.rows === next.rows && prev.cols === next.cols ? prev : next));
      }, RESIZE_THROTTLE_MS);
    };

    stream.on('resize', onResize);
    return () => {
      if (timer) clearTimeout(timer);
      if (typeof stream.off === 'function') stream.off('resize', onResize);
      else if (typeof stream.removeListener === 'function') stream.removeListener('resize', onResize);
    };
  }, [stdout]);

  return size;
}
