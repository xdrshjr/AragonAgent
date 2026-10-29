/**
 * Render an Ink tree at a CHOSEN terminal width.
 *
 * `ink-testing-library`'s `render` takes the tree and nothing else, and its
 * stdout stub hard-codes `get columns() { return 100 }` — so a second argument
 * spelling `{ columns: 40 }` is silently ignored and any assertion built on it
 * is VACUOUS while looking exactly like a real one. (`budget.test.ts` records the
 * same stub's missing `rows` for the same reason.)
 *
 * This is that library's `render`, verbatim, with the one number made a
 * parameter. Nothing else about the harness changes: `debug: true` is what makes
 * every frame arrive whole rather than as cursor movements.
 */

import { EventEmitter } from 'node:events';
import type { ReactElement } from 'react';
import { render as inkRender } from 'ink';
import stripAnsi from 'strip-ansi';

class WidthStdout extends EventEmitter {
  readonly frames: string[] = [];
  private last: string | undefined;

  constructor(readonly columns: number) {
    super();
  }

  write = (frame: string): void => {
    this.frames.push(frame);
    this.last = frame;
  };

  lastFrame = (): string | undefined => this.last;
}

class NullStream extends EventEmitter {
  write = (): void => {};
  isTTY = true;
  setEncoding(): void {}
  setRawMode(): void {}
  resume(): void {}
  pause(): void {}
  ref(): void {}
  unref(): void {}
  read = (): null => null;
}

/** The stripped rows of one frame rendered at `columns`, then unmounted. */
export function renderRowsAtWidth(tree: ReactElement, columns: number): string[] {
  const stdout = new WidthStdout(columns);
  const instance = inkRender(tree, {
    stdout: stdout as unknown as NodeJS.WriteStream,
    stderr: new NullStream() as unknown as NodeJS.WriteStream,
    stdin: new NullStream() as unknown as NodeJS.ReadStream,
    debug: true,
    exitOnCtrlC: false,
    patchConsole: false,
  });
  const frame = stripAnsi(stdout.lastFrame() ?? '');
  instance.unmount();
  instance.cleanup();
  return frame.split('\n');
}
