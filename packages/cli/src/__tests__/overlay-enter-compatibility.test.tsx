import React from 'react';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, useInput } from 'ink';
import { ModelRegistry } from '@aragon-agent/core';
import { createStdinFilter } from '../input/stdin-filter.js';
import { ConfirmDialog } from '../ui/overlays/ConfirmDialog.js';
import { ModelPicker } from '../ui/overlays/ModelPicker.js';
import { SettingsScreen, type SettingsValues } from '../ui/overlays/SettingsScreen.js';
import { QuestionOverlay } from '../ui/overlays/QuestionOverlay.js';
import { PlanReviewOverlay } from '../ui/overlays/PlanReviewOverlay.js';
import { normalizePlan, normalizeQuestions } from '../tools/human-input.js';
import { getTheme } from '../ui/theme.js';
import { PromptInput } from '../ui/PromptInput.js';
import { PASTE_OPEN, PASTE_CLOSE } from '../input/limits.js';
import { ModelProfileEditor } from '../ui/overlays/ModelProfileEditor.js';
import { createProfileEditor } from '../ui/overlays/model-profile-state.js';

const caps = { colorLevel: 0 as const, unicode: false };
const common = { caps, theme: getTheme('cool', caps), cols: 80, maxRows: 30 };
const delay = () => new Promise<void>((resolve) => setTimeout(resolve, 20));
const cleanups: (() => void)[] = [];
const ENTER_ENCODINGS = ['\r', '\x1b[13u', '\x1b[13;1u'];
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
  return {
    frame: () => frame,
    send: async (bytes: string) => { source.write(bytes); await delay(); },
    sendParts: async (parts: string[]) => {
      for (const part of parts) source.write(part);
      await delay();
    },
  };
}

const initial: SettingsValues = {
  provider: 'anthropic', model: '', baseUrl: '', thinkingLevel: 'off',
  showThinking: 'off', liveToolOutput: 'off', maxTokens: '', apiKey: '', logLevel: 'info',
  fastEnabled: 'off', fastModel: '', fastProvider: '', fastReview: '', fastReviewBudget: '',
  compactionEnabled: 'off', compactionThreshold: '90', compactionKeepTurns: '3',
  compactionSubagents: 'off', compactionArchive: 'off',
};
const questions = normalizeQuestions([{
  id: 'choice', header: 'Choice', question: 'Choose?',
  options: [{ label: 'Default' }, { label: 'Alternative' }],
}]);
const plan = normalizePlan({ title: 'Plan', summary: 'Change', steps: [{ title: 'Implement' }] })!;

describe('五种弹层通过真实过滤器和 Ink 保持 Enter 兼容', () => {
  it.each(ENTER_ENCODINGS)('配置编辑器净化密钥帧且 %j 仅合入子草稿', async (enter) => {
    const dispatch = vi.fn();
    const editor = createProfileEditor({ id: 'new', name: 'Custom', provider: 'openai',
      model: 'custom', baseUrl: null, apiKey: null });
    editor.credentialMode = 'replace';
    const view = await mount(<ModelProfileEditor {...common} scrollOffset={0}
      editor={editor} users="Main + Fast" dispatch={dispatch} />);
    for (let index = 0; index < 5; index++) await view.send('\x1b[B');
    await view.send('a\x1b[13;2ub\x1b[13u');
    expect(dispatch).toHaveBeenLastCalledWith({ type: 'editor-field', field: 'apiKey', value: 'ab' });
    expect(dispatch).not.toHaveBeenCalledWith({ type: 'merge-editor' });
    await view.send('\x13');
    expect(dispatch).not.toHaveBeenCalledWith({ type: 'merge-editor' });
    await view.send(enter);
    expect(dispatch.mock.calls.filter(([action]) => action.type === 'merge-editor')).toHaveLength(1);
  });

  it.each(ENTER_ENCODINGS)('设置字段净化后由 %j 保存一次', async (enter) => {
    const onSave = vi.fn();
    const view = await mount(<SettingsScreen {...common} initial={initial} apiKeys={{}}
      scrollOffset={0} onSave={onSave} />);
    await view.send('\x1b[B');
    await view.send('a\x1b[13;2ub\x1b[13u');
    expect(onSave).not.toHaveBeenCalled();
    await view.send(enter);
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave.mock.calls[0]![0].model).toBe('ab');
  });

  it.each(ENTER_ENCODINGS)('问题弹层 Shift+Enter 不推进，%j 推进并提交一次', async (enter) => {
    const onSubmit = vi.fn();
    const view = await mount(<QuestionOverlay {...common} questions={questions}
      onSubmit={onSubmit} />);
    await view.send('\x1b[13;2u');
    expect(onSubmit).not.toHaveBeenCalled();
    await view.send(enter);
    expect(view.frame()).toContain('Review your answers');
    expect(onSubmit).not.toHaveBeenCalled();
    await view.send(enter);
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it('问题自定义答案净化混合 CR、paste 和 newline，直到独立 Enter 才提交', async () => {
    const onSubmit = vi.fn();
    const view = await mount(<QuestionOverlay {...common} questions={questions}
      onSubmit={onSubmit} />);
    await view.send('\x1b[B');
    await view.send('\x1b[B');
    await view.send('\x1b[13u');
    await view.send('a\x1b[200~b\nc\x1b[201~\x1b[13;2ud\x1b[13;1u');
    expect(onSubmit).not.toHaveBeenCalled();
    await view.send('\x1b[13u');
    expect(onSubmit).not.toHaveBeenCalled();
    await view.send('\x1b[13;1u');
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit.mock.calls[0]![0][0].custom).toBe('abcd');
  });

  it.each(ENTER_ENCODINGS)('计划卡片 %j 不批准，修改字段由它提交', async (enter) => {
    const onVerdict = vi.fn();
    const view = await mount(<PlanReviewOverlay {...common} plan={plan} scrollOffset={0}
      onScrollClamp={() => {}} onVerdict={onVerdict} />);
    await view.send(enter);
    expect(onVerdict).not.toHaveBeenCalled();
    await view.send('r');
    await view.send('a\x1b[13;2ub\x1b[13u');
    expect(onVerdict).not.toHaveBeenCalled();
    await view.send(enter);
    expect(onVerdict).toHaveBeenCalledExactlyOnceWith({ decision: 'revise', feedback: 'ab' });
  });

  it.each(ENTER_ENCODINGS)('确认弹层 Shift+Enter 和混合帧无动作，%j 保持拒绝', async (enter) => {
    const resolve = vi.fn();
    const onClose = vi.fn();
    const view = await mount(<ConfirmDialog {...common} state={{ summary: 'Execute?', resolve }}
      onClose={onClose} />);
    await view.send('\x1b[13;2u');
    await view.send('x\x1b[13u');
    expect(resolve).not.toHaveBeenCalled();
    await view.send(enter);
    expect(resolve).toHaveBeenCalledExactlyOnceWith(false);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it.each(ENTER_ENCODINGS)('第三方模型选择器只在独立 %j 选择一次', async (enter) => {
    const registry = new ModelRegistry();
    const model = registry.getModels('anthropic')[0]!;
    const onSelect = vi.fn();
    const view = await mount(<ModelPicker {...common} registry={registry}
      currentProvider="anthropic" currentModel={model.id} onSelect={onSelect} />);
    await view.send('\x1b[13;2u');
    await view.send('x\x1b[13u');
    expect(onSelect).not.toHaveBeenCalled();
    await view.send(enter);
    expect(onSelect).toHaveBeenCalledExactlyOnceWith('anthropic', model.id);
  });
});

describe('编辑器通过真实过滤器和 Ink 消费合并流', () => {
  function InputProbe({ received }: { received: string[] }) {
    useInput((input) => { received.push(input); });
    return null;
  }

  it.each(ENTER_ENCODINGS)('分次写入 bracketed paste 与 %j，Ink 合并后仍提交全文',
    async (enter) => {
      const onSubmit = vi.fn((_text: string) => ({ accepted: true }));
      const received: string[] = [];
      const view = await mount(<>
        <PromptInput {...common} isActive running={false} history={[]} commands={[]}
          cwd={process.cwd()} onSubmit={onSubmit} />
        <InputProbe received={received} />
      </>);
      await view.sendParts(['\x1b[200~a\nb\x1b[201~', enter]);
      expect(received).toEqual([`${PASTE_OPEN}a\nb${PASTE_CLOSE}\r`]);
      expect(onSubmit).toHaveBeenCalledExactlyOnceWith('a\nb');
    });

  it('burst、修饰 Enter、正文和普通 Enter 按顺序形成一次完整提交', async () => {
    const onSubmit = vi.fn((_text: string) => ({ accepted: true }));
    const view = await mount(<PromptInput {...common} isActive running={false}
      history={[]} commands={[]} cwd={process.cwd()} onSubmit={onSubmit} />);
    await view.send('a\nb\x1b[13;2uc\x1b[13;1ud');
    expect(onSubmit).toHaveBeenCalledExactlyOnceWith('a\nb\nc');
    await view.send('\x1b[13u');
    expect(onSubmit).toHaveBeenNthCalledWith(2, 'd');
  });
});
