/**
 * history-recall-autocomplete-popup — recalling history must not re-arm the
 * suggestion popup, and the walk must survive consecutive Up presses.
 *
 * The popup's only gate is `dismissed`; `recall` now forces it true, so both
 * the `/` command popup and the `@file` popup (same gate) stay closed over
 * recalled content. Typing over the recall re-arms it via DRAFT_FLAGS.
 */
import React from 'react';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render } from 'ink';
import { createStdinFilter } from '../input/stdin-filter.js';
import { PromptInput, slashSuggestions, fileTokenAt } from '../ui/PromptInput.js';
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

describe('历史召回不自动弹联想（history-recall-autocomplete-popup）', () => {
  it('状态级：recall 恒置 dismissed，/word 召回内容不再命中弹窗', () => {
    const recalled = editorReducer(INITIAL_EDITOR_STATE,
      { type: 'recall', buffer: '/clear', cursor: 6, historyIndex: 1 });
    expect(recalled.buffer).toBe('/clear');
    expect(recalled.dismissed).toBe(true);                       // 闸门被置位
    // 判定本身仍只看 buffer 内容——被抑制的唯一原因就是 dismissed。
    expect(slashSuggestions(recalled.buffer, commands)!.length).toBeGreaterThan(0);
  });

  it('组件级：召回 /clear 后弹窗不出现，连续 ↑ 能走到更早历史', async () => {
    const view = await mount(<PromptInput {...common} isActive running={false}
      history={['older plain text', '/clear']} commands={commands} cwd={process.cwd()}
      onSubmit={() => ({ accepted: true })} />);
    await view.send('\x1b[A');                                     // 召回 /clear
    expect(view.frame()).toContain('/clear');
    expect(view.frame()).not.toContain('Clear the conversation history'); // 弹窗不可见
    await view.send('\x1b[A');                                     // 第二次 ↑ 应翻历史
    expect(view.frame()).toContain('older plain text');            // 行走不再被打断
  });

  it('召回后继续键入：联想照常恢复（缓冲编辑复位 dismissed）', async () => {
    const view = await mount(<PromptInput {...common} isActive running={false}
      history={['older plain text', '/cle']} commands={commands} cwd={process.cwd()}
      onSubmit={() => ({ accepted: true })} />);
    await view.send('\x1b[A');                                     // 召回 /cle，无弹窗
    expect(view.frame()).not.toContain('Clear the conversation history');
    await view.send('a');                                          // 键入 -> /clea
    expect(view.frame()).toContain('Clear the conversation history'); // 联想恢复
  });

  it('@file 对称用例：同一 dismissed 闸门抑制召回内容上的文件弹窗', () => {
    const recalled = editorReducer(INITIAL_EDITOR_STATE,
      { type: 'recall', buffer: 'see @src', cursor: 8, historyIndex: 0 });
    // fileTokenAt 仍能找到 @ token（内容判定不受影响），弹窗被抑制的唯一
    // 原因就是 recall 置位的 dismissed——与 PromptInput 的 fileActive 同构。
    expect(fileTokenAt(recalled.buffer, recalled.cursor)).toEqual(
      expect.objectContaining({ query: 'src' }));
    expect(recalled.dismissed).toBe(true);
  });

  it('对照：键入 / 主动唤起的联想路径不受影响', async () => {
    const onSubmit = vi.fn(() => ({ accepted: true }));
    const view = await mount(<PromptInput {...common} isActive running={false}
      history={[]} commands={commands} cwd={process.cwd()} onSubmit={onSubmit} />);
    await view.send('/c');
    expect(view.frame()).toContain('Clear the conversation history'); // 键入路径照常弹出
  });
});
