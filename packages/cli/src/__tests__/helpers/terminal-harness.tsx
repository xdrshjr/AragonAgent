import React from 'react';
import { PassThrough } from 'node:stream';
import { render } from 'ink';
import stripAnsi from 'strip-ansi';

/** Real Yoga sizing and input streams, independent of the host terminal dimensions. */
export function createTerminalHarness(columns = 80, rows = 24, debug = true) {
  const output = new PassThrough();
  const stdout = Object.assign(output, { columns, rows, isTTY: true,
    getColorDepth: () => 1 }) as unknown as NodeJS.WriteStream;
  const stdin = Object.assign(new PassThrough(), {
    isTTY: true, setRawMode: () => stdin, ref: () => stdin, unref: () => stdin,
  }) as unknown as NodeJS.ReadStream;
  const frames: string[] = [];
  output.on('data', (chunk: Buffer) => { frames.push(chunk.toString()); });
  let instance: ReturnType<typeof render> | undefined;
  return { stdout, stdin, frames,
    mount(node: React.ReactElement) {
      instance = render(node, { stdout, stdin, stderr: stdout, debug,
        exitOnCtrlC: false, patchConsole: false });
    },
    rerender(node: React.ReactElement) { instance!.rerender(node); },
    resize(nextCols: number, nextRows: number) {
      stdout.columns = nextCols;
      stdout.rows = nextRows;
      stdout.emit('resize');
    },
    lastFrame: () => stripAnsi(frames.at(-1) ?? ''),
    input(text: string) { (stdin as unknown as PassThrough).write(text); },
    dispose() { instance?.unmount(); instance?.cleanup(); output.destroy(); stdin.destroy(); },
  };
}

export const settleTerminal = () => new Promise<void>((resolve) => setTimeout(resolve, 70));
