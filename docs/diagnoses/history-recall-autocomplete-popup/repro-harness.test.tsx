/**
 * DIAGNOSIS REPRO HARNESS (diagnosis node output; not part of the test suite).
 * To run: copy this file into packages/cli/src/__tests__/ (imports are relative
 * to that directory), then: cd packages/cli && npx vitest run src/__tests__/<name>
 * Current-HEAD expectation: every case below PASSES, i.e. the bug reproduces.
 */
import React from 'react';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { render } from 'ink';
import { createStdinFilter } from '../input/stdin-filter.js';
import { PromptInput, slashSuggestions } from '../ui/PromptInput.js';
import { editorReducer, INITIAL_EDITOR_STATE } from '../ui/editor-reducer.js';
import { getTheme } from '../ui/theme.js';

const caps = { colorLevel: 0 as const, unicode: false };
const common = { caps, theme: getTheme('cool', caps), cols: 80, maxRows: 30 };
const delay = () => new Promise<void>((resolve) => setTimeout(resolve, 60));
const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });

async function mount(element: React.ReactElement) {
  const source = Object.assign(new PassThrough(), {
    isTTY: true, setRawMode: () => source, ref: () => source, unref: () => source,
  });
  const filter = createStdinFilter(source as unknown as NodeJS.ReadStream,
    { mouse: false, paste: true });
  const output = Object.assign(new PassThrough(), { columns: 80, rows: 40, isTTY: true });
  let frame = '';
  output.on('data', (chunk) => { frame += String(chunk); });
  const app = render(element, {
    stdin: filter.stdin, stdout: output as unknown as NodeJS.WriteStream,
    stderr: output as unknown as NodeJS.WriteStream, exitOnCtrlC: false, patchConsole: false,
  });
  cleanups.push(() => { app.unmount(); app.cleanup(); filter.dispose(); source.destroy(); });
  await delay();
  return { frame: () => frame, send: async (bytes: string) => { source.write(bytes); await delay(); } };
}

const commands = [
  { name: 'clear', description: 'Clear the conversation history' },
  { name: 'compact', description: 'Compact the context' },
];

describe('DIAG-1 history Up re-arms the slash popup', () => {
  it('state level: recall does not dismiss, so suggestions re-arm', () => {
    const recalled = editorReducer(INITIAL_EDITOR_STATE,
      { type: 'recall', buffer: '/clear', cursor: 6, historyIndex: 1 });
    expect(recalled.buffer).toBe('/clear');
    expect(recalled.dismissed).toBe(false);                        // <- 弹窗重新武装
    expect(slashSuggestions(recalled.buffer, commands)!.length).toBeGreaterThan(0);
  });

  it('second Up moves the popup selection instead of stepping history', async () => {
    const view = await mount(<PromptInput {...common} isActive running={false}
      history={['older plain text', '/clear']} commands={commands} cwd={process.cwd()}
      onSubmit={() => ({ accepted: true })} />);
    await view.send('\x1b[A');                                     // 召回 /clear
    expect(view.frame()).toContain('/clear');
    expect(view.frame()).toContain('Clear the conversation history'); // 弹窗可见
    await view.send('\x1b[A');                                     // 应翻到更早历史
    expect(view.frame()).not.toContain('older plain text');        // BUG: 历史行走被吞
  });

  it('contrast: after Esc dismisses the popup, the same Up walk works', async () => {
    const view = await mount(<PromptInput {...common} isActive running={false}
      history={['older plain text', '/clear']} commands={commands} cwd={process.cwd()}
      onSubmit={() => ({ accepted: true })} />);
    await view.send('\x1b[A');
    await view.send('\x1b');                                       // Esc 关弹窗
    await view.send('\x1b[A');
    expect(view.frame()).toContain('older plain text');            // 行走恢复
  });
});
