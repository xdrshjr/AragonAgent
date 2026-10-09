import { afterEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import chalk from 'chalk';
import { Box, Text, useApp } from 'ink';
import { renderTui } from '../ui/ink-runtime.js';
import { resolveTuiCapabilities } from '../ui/capabilities.js';
import { pickGlyphs } from '../ui/glyphs.js';
import { Markdown } from '../ui/Markdown.js';
import { getTheme } from '../ui/theme.js';
import stripAnsi from 'strip-ansi';
import { createTerminalHarness, settleTerminal } from './helpers/terminal-harness.js';

const require = createRequire(import.meta.url);
const inkRequire = createRequire(require.resolve('ink'));
const inkChalk = (await import(pathToFileURL(inkRequire.resolve('chalk')).href)).default;
const highlightRequire = createRequire(require.resolve('cli-highlight'));
const highlightChalk = (await import(pathToFileURL(highlightRequire.resolve('chalk')).href)).default;
const originalLevel = chalk.level;
const originalInkLevel = inkChalk.level;
const originalHighlightLevel = highlightChalk.level;
afterEach(() => {
  chalk.level = originalLevel;
  inkChalk.level = originalInkLevel;
  highlightChalk.level = originalHighlightLevel;
  vi.unstubAllEnvs();
});

describe('TUI renderer output', () => {
  it.each([true, false])('renders Unicode with colors enabled=%s and restores Chalk', async (color) => {
    chalk.level = 1;
    inkChalk.level = 1;
    highlightChalk.level = color ? 0 : 1;
    vi.stubEnv('TERM', 'dumb');
    vi.stubEnv('FORCE_COLOR', '1');
    const caps = resolveTuiCapabilities({}, color);
    const terminal = createTerminalHarness();
    const instance = renderTui(
      <Box flexDirection="column" borderStyle={pickGlyphs(caps).boxStyle} borderColor="#123456">
        <Text bold color="#123456">display-probe</Text>
        <Markdown text={'```js\nconst displayProbe = 123;\n```'} caps={caps}
          theme={getTheme('warm', caps)} />
      </Box>,
      { stdout: terminal.stdout, stdin: terminal.stdin, stderr: terminal.stdout,
        debug: true, patchConsole: false, exitOnCtrlC: false }, caps,
    );
    try {
      await settleTerminal();
      const output = terminal.frames.join('');
      expect(output).toContain('display-probe');
      expect(stripAnsi(output)).toContain('const displayProbe = 123;');
      if (color) expect(output).toMatch(/\x1b\[[\d;]*mconst\x1b\[[\d;]*m/);
      expect(output).toContain('\u256d');
      expect(output.includes('\x1b[38;2;18;52;86m')).toBe(color);
      if (!color) expect(output).not.toMatch(/\x1b\[[\d;]*m/);
      expect(process.env.FORCE_COLOR).toBe('1');
      expect(process.env.TERM).toBe('dumb');
    } finally {
      instance.unmount();
      await instance.waitUntilExit();
      instance.cleanup();
      terminal.dispose();
    }
    expect(chalk.level).toBe(1);
    expect(inkChalk.level).toBe(1);
    expect(highlightChalk.level).toBe(color ? 0 : 1);
  });

  it.each([false, true])('restores rendering after useApp exit, error=%s', async (failed) => {
    chalk.level = 0;
    inkChalk.level = 0;
    let exit!: (error?: Error) => void;
    function Probe() { exit = useApp().exit; return <Text>exit-probe</Text>; }
    const terminal = createTerminalHarness();
    const instance = renderTui(<Probe />, { stdout: terminal.stdout, stdin: terminal.stdin,
      debug: true, patchConsole: false }, resolveTuiCapabilities({}));
    try {
      await settleTerminal();
      expect(inkChalk.level).toBe(3);
      const done = instance.waitUntilExit();
      exit(failed ? new Error('render-exit-probe') : undefined);
      if (failed) await expect(done).rejects.toThrow('render-exit-probe');
      else await done;
      expect(chalk.level).toBe(0);
      expect(inkChalk.level).toBe(0);
    } finally {
      instance.unmount();
      instance.cleanup();
      terminal.dispose();
    }
  });

  it('restores rendering if mounting throws synchronously', () => {
    chalk.level = 1;
    inkChalk.level = 1;
    expect(() => renderTui(<Text>never mounted</Text>, {
      get stdout(): NodeJS.WriteStream { throw new Error('mount-probe'); },
    }, resolveTuiCapabilities({}))).toThrow('mount-probe');
    expect(chalk.level).toBe(1);
    expect(inkChalk.level).toBe(1);
  });

  it.each(['render-error', 'layout-exit', 'layout-error'])(
    'settles and restores rendering when the initial mount triggers %s', async (kind) => {
      chalk.level = 0;
      inkChalk.level = 0;
      highlightChalk.level = 0;
      const failure = new Error('initial-mount-probe');
      function Probe(): React.ReactElement {
        const { exit } = useApp();
        React.useLayoutEffect(() => {
          if (kind !== 'render-error') exit(kind === 'layout-error' ? failure : undefined);
        }, [exit]);
        if (kind === 'render-error') throw failure;
        return <Text>initial-mount-probe</Text>;
      }
      const terminal = createTerminalHarness();
      const instance = renderTui(<Probe />, { stdout: terminal.stdout, stdin: terminal.stdin,
        stderr: terminal.stdout, debug: true, patchConsole: false }, resolveTuiCapabilities({}));
      try {
        const outcome = await Promise.race([
          instance.waitUntilExit().then(() => 'exited', error => error),
          new Promise(resolve => setTimeout(() => resolve('pending'), 200)),
        ]);
        expect(outcome).toBe(kind === 'layout-exit' ? 'exited' : failure);
        expect(chalk.level).toBe(0);
        expect(inkChalk.level).toBe(0);
        expect(highlightChalk.level).toBe(0);
      } finally {
        instance.unmount();
        instance.cleanup();
        terminal.dispose();
      }
    },
  );
});
