import { describe, expect, it } from 'vitest';
import { planComposerInput, type ComposerInputIntent } from '../ui/composer-input.js';
import { editorReducer, INITIAL_EDITOR_STATE } from '../ui/editor-reducer.js';
import { expandPastes } from '../ui/paste-tokens.js';
import { draftLimitRefusal } from '../ui/PromptInput.js';

const options = (intents: ComposerInputIntent[]) => ({
  editor: INITIAL_EDITOR_STATE,
  intents,
  resolveSubmit: (editor: typeof INITIAL_EDITOR_STATE) =>
    expandPastes(editor.buffer, editor.pastes).trim() ?
      expandPastes(editor.buffer, editor.pastes) : null,
  checkPasteLimit: draftLimitRefusal,
});

describe('纯输入事务规划', () => {
  it('按局部状态提交一次，同时给出保稿候选', () => {
    const plan = planComposerInput(options([
      { kind: 'text', text: 'a' }, { kind: 'newline' }, { kind: 'text', text: 'b' },
      { kind: 'submit' }, { kind: 'text', text: 'c' }, { kind: 'submit' },
    ]));
    expect(plan.submission).toBe('a\nb');
    expect(plan.nextEditor.buffer).toBe('c');
    expect(plan.rejectedEditor.buffer).toBe('a\nbc');
    expect(plan.notice).toContain('More input');
    expect(INITIAL_EDITOR_STATE.buffer).toBe('');
    expect(editorReducer(INITIAL_EDITOR_STATE, {
      type: 'adopt', state: plan.nextEditor,
    })).toEqual(plan.nextEditor);
  });

  it('仅保稿候选超限时也原子拒绝，不产生提交', () => {
    const plan = planComposerInput({
      ...options([
        { kind: 'paste', text: 'a\nb\nc\nd\ne\nf\ng', id: 1 }, { kind: 'submit' },
        { kind: 'paste', text: 'c\nd', id: 2 },
      ]),
      checkPasteLimit: (segments, editor) =>
        editor.pastes.size + segments.length > 1 ? 'limit' : null,
    });
    expect(plan.refusal).toBe('limit');
    expect(plan.submission).toBeUndefined();
    expect(plan.nextEditor).toBe(INITIAL_EDITOR_STATE);
    expect(plan.rejectedEditor).toBe(INITIAL_EDITOR_STATE);
  });

  it('首尾和连续空提交不生成消息', () => {
    const plan = planComposerInput(options([
      { kind: 'submit' }, { kind: 'newline' }, { kind: 'submit' },
    ]));
    expect(plan.submission).toBeUndefined();
    expect(plan.nextEditor.buffer).toBe('\n');
  });

  it('同回调 33 个未折叠短 paste 仍按完整输入块限额拒绝', () => {
    const intents: ComposerInputIntent[] = Array.from({ length: 33 }, (_, index) => ({
      kind: 'paste', text: 'x', id: index + 1,
    }));
    intents.splice(32, 0, { kind: 'submit' });
    const plan = planComposerInput(options(intents));
    expect(plan.refusal).toContain('Too many pasted blocks');
    expect(plan.submission).toBeUndefined();
    expect(plan.nextEditor).toBe(INITIAL_EDITOR_STATE);
    expect(plan.rejectedEditor).toBe(INITIAL_EDITOR_STATE);
  });

  it('同回调短 paste 的总字节在保稿候选累计预检', () => {
    const base = options([
      { kind: 'paste', text: 'abc', id: 1 }, { kind: 'submit' },
      { kind: 'paste', text: 'def', id: 2 },
    ]);
    const plan = planComposerInput({ ...base, checkPasteLimit: (segments) =>
      segments.reduce((total, segment) => total + Buffer.byteLength(segment.text), 0) > 5
        ? 'bytes limit' : null,
    });
    expect(plan.refusal).toBe('bytes limit');
    expect(plan.submission).toBeUndefined();
  });
});
