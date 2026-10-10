/**
 * ctrl-c-clear-draft-exit — the armed Ctrl+C ladder clears a draft first.
 *
 * Two levels:
 * - Component: the `draftClearNonce` prop drives PromptInput's `'clear'`
 *   dispatch (downward channel) and the presence transition flows back
 *   through `onDraftChange` (upward channel, unchanged shape).
 * - App: armed x hasDraft composes the rungs — with a draft x2 clears (and
 *   the feedback switches to the exit prompt) and x3 exits; an empty input
 *   keeps the previous x2 exit. `controller.abort` is the exit witness:
 *   `doExit()` calls it before Ink's `exit()`.
 */
import React from 'react';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render } from 'ink';
import stripAnsi from 'strip-ansi';
import type { AgentEvent } from '@aragon-agent/core';
import type { CompactionEvent } from '../compaction/types.js';
import { AgentController } from '../agent/controller.js';
import { App } from '../ui/App.js';
import { PromptInput } from '../ui/PromptInput.js';
import { projectStatusFeedback } from '../ui/status-feedback.js';
import { createStdinFilter } from '../input/stdin-filter.js';
import { DEFAULT_CONFIG, DEFAULT_SKILLS_RUNTIME, type CliConfig } from '../config/schema.js';
import { createTerminalHarness, settleTerminal } from './helpers/terminal-harness.js';
import { getTheme } from '../ui/theme.js';

vi.mock('../config/prompt-history.js', () => ({ loadPromptHistory: () => [],
  appendPrompt: () => [] }));
vi.mock('../config/ui-state.js', () => ({ bumpSubmitCount: () => 1,
  setMouseNoticeVersion: () => {}, setVtInputNoticeVersion: () => {} }));

const caps = { colorLevel: 0 as const, unicode: false };
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
  let lastFrameText = '';
  output.on('data', (chunk) => { frame += String(chunk); lastFrameText = String(chunk); });
  const app = render(element, {
    stdin: filter.stdin, stdout: output as unknown as NodeJS.WriteStream,
    stderr: output as unknown as NodeJS.WriteStream, exitOnCtrlC: false, patchConsole: false,
  });
  cleanups.push(() => { app.unmount(); app.cleanup(); filter.dispose(); source.destroy(); });
  await delay();
  return { frame: () => frame, lastFrame: () => stripAnsi(lastFrameText),
    rerender: (el: React.ReactElement) => { app.rerender(el); },
    send: async (bytes: string) => { source.write(bytes); await delay(); } };
}

describe('组件级：draftClearNonce 下行通道', () => {
  it('nonce 递增触发 clear：草稿归零并上报 hasDraft:false', async () => {
    const onDraftChange = vi.fn();
    const element = (nonce: number) => <PromptInput isActive running={false}
      history={[]} commands={[]} cwd={process.cwd()} caps={caps}
      theme={getTheme('cool', caps)} cols={80} draftClearNonce={nonce}
      onSubmit={() => ({ accepted: true })} onDraftChange={onDraftChange} />;
    const view = await mount(element(0));
    await view.send('keep this draft');
    expect(view.frame()).toContain('keep this draft');
    expect(onDraftChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ hasDraft: true }));
    await view.send('\x03');                 // Ctrl+C 字节在组件层被放行（App 拥有所有权）
    expect(view.frame()).toContain('keep this draft');   // 组件不自行清空
    view.rerender(element(1));               // nonce 0 -> 1：App 请求清空
    await delay();
    expect(view.lastFrame()).not.toContain('keep this draft');   // 只看最新帧
    expect(onDraftChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ hasDraft: false }));
  });
});

describe('投影级：armed x hasDraft 的反馈二分', () => {
  it('armed 且有草稿 -> clear-input；armed 且无草稿 -> exit', () => {
    const base = { interactionPhase: 'idle' as const };
    const armed = projectStatusFeedback({ ...base, ctrlCArmed: true, hasDraft: true });
    expect(armed.feedback?.kind).toBe('clear-input');
    expect(armed.feedback?.text).toBe('Press Ctrl+C again to clear input');
    const exit = projectStatusFeedback({ ...base, ctrlCArmed: true, hasDraft: false });
    expect(exit.feedback?.kind).toBe('exit');
    expect(exit.feedback?.text).toBe('Press Ctrl+C again to exit');
    // hasDraft 缺省（旧调用方）等价于无草稿：保持既有 exit 行为。
    const legacy = projectStatusFeedback({ ...base, ctrlCArmed: true });
    expect(legacy.feedback?.kind).toBe('exit');
  });
});

function appFixture() {
  const config = { ...DEFAULT_CONFIG, cwd: process.cwd(), color: false, unicode: false,
    reducedMotion: true, showThinking: true, startInPlanMode: false, submitCount: 20,
    skillsRuntime: DEFAULT_SKILLS_RUNTIME, apiKeys: { anthropic: 'fixture' },
    skills: { ...DEFAULT_CONFIG.skills, enabled: false },
    compaction: { ...DEFAULT_CONFIG.compaction, enabled: false },
    team: { ...DEFAULT_CONFIG.team, enabled: false },
    fast: { ...DEFAULT_CONFIG.fast, enabled: false },
  } as CliConfig;
  const controller = new AgentController(config, { notify: () => {} });
  let receive!: (event: AgentEvent) => void;
  vi.spyOn(controller, 'subscribe').mockImplementation((listener) => {
    receive = listener; return () => {};
  });
  let receiveCompaction!: (event: CompactionEvent) => void;
  vi.spyOn(controller, 'subscribeCompaction').mockImplementation((listener) => {
    receiveCompaction = listener; return () => {};
  });
  const abortSpy = vi.spyOn(controller, 'abort').mockImplementation(() => {});
  return { controller, abortSpy };
}

describe('App 级：Ctrl+C 阶梯（armed x hasDraft）', () => {
  it('有草稿：x1 arm 提示清空，x2 清空草稿且不退出，反馈切为 exit', async () => {
    const terminal = createTerminalHarness();
    const { controller, abortSpy } = appFixture();
    try {
      terminal.mount(<App controller={controller} version="test" />);
      await settleTerminal();
      terminal.input('precious draft');
      await settleTerminal();
      terminal.input('\x03');
      await settleTerminal();
      expect(terminal.lastFrame()).toContain('^C clear');
      expect(abortSpy).not.toHaveBeenCalled();
      terminal.input('\x03');
      await settleTerminal();
      expect(abortSpy).not.toHaveBeenCalled();          // 未退出
      expect(stripAnsi(terminal.lastFrame())).not.toContain('precious draft'); // 草稿已清
      expect(terminal.lastFrame()).toContain('^C exit');    // 反馈已切为 exit
    } finally { terminal.dispose(); controller.dispose(); }
  });

  it('有草稿：x3 才退出（doExit 经 controller.abort 可见）', async () => {
    const terminal = createTerminalHarness();
    const { controller, abortSpy } = appFixture();
    try {
      terminal.mount(<App controller={controller} version="test" />);
      await settleTerminal();
      terminal.input('draft to lose');
      await settleTerminal();
      terminal.input('\x03');
      await settleTerminal();
      terminal.input('\x03');
      await settleTerminal();
      expect(abortSpy).not.toHaveBeenCalled();
      terminal.input('\x03');
      await settleTerminal();
      expect(abortSpy).toHaveBeenCalledTimes(1);        // 第三击才 doExit
    } finally { terminal.dispose(); controller.dispose(); }
  });

  it('空输入：x2 直接退出，与旧行为一致', async () => {
    const terminal = createTerminalHarness();
    const { controller, abortSpy } = appFixture();
    try {
      terminal.mount(<App controller={controller} version="test" />);
      await settleTerminal();
      terminal.input('\x03');
      await settleTerminal();
      expect(terminal.lastFrame()).toContain('^C exit');
      expect(abortSpy).not.toHaveBeenCalled();
      terminal.input('\x03');
      await settleTerminal();
      expect(abortSpy).toHaveBeenCalledTimes(1);
    } finally { terminal.dispose(); controller.dispose(); }
  });
});
