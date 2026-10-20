import React from 'react';
import { readFileSync } from 'node:fs';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render } from 'ink';
import { createStdinFilter } from '../input/stdin-filter.js';
import { SettingsScreen, type SettingsValues } from '../ui/overlays/SettingsScreen.js';
import { createModelProfileState, modelProfileReducer }
  from '../ui/overlays/model-profile-state.js';
import { getTheme } from '../ui/theme.js';
import type { ModelCandidate, ModelProbe, ProbeRequest } from '../agent/model-probe.js';
import type { ModelSettingsDraft } from '../config/model-profile-store.js';

const profile = { id: 'profile-a', name: 'Sonnet', provider: 'anthropic',
  model: 'claude-sonnet-4-5-20250929', baseUrl: null, apiKey: 'disk-secret',
  contextWindow: null };
const draft = () => ({ diskRevision: 'disk', liveRevision: 0, baseline: {}, liveBaseline: {},
  patch: {}, activateRoles: [], profiles: { version: 1, entries: [profile],
    mainId: 'profile-a', fastId: null } }) as unknown as ModelSettingsDraft;
const initial: SettingsValues = { provider: 'anthropic', model: 'custom', baseUrl: '',
  thinkingLevel: 'off', showThinking: 'off', liveToolOutput: 'off', maxTokens: '',
  contextWindow: '', apiKey: '', logLevel: 'info', fastEnabled: 'off', fastModel: '',
  fastProvider: '', fastReview: '5', fastReviewBudget: '40', compactionEnabled: 'off',
  compactionThreshold: '90', compactionKeepTurns: '3', compactionSubagents: 'off',
  compactionArchive: 'off' };
const caps = { colorLevel: 0 as const, unicode: false };
const cleanups: (() => void)[] = [];
afterEach(() => { cleanups.splice(0).forEach((cleanup) => cleanup()); });
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 60));
const CLEAR = '\u001b[2J';

const fingerprint = (target: ProbeRequest): string =>
  `${target.provider}|${target.model}|${target.baseUrl ?? ''}|${target.apiKey ?? ''}`;

function makeProbe(over: Partial<ModelProbe> = {}) {
  const probe: ModelProbe = {
    test: vi.fn(async (request: ProbeRequest) => ({ ok: true, targetId: fingerprint(request),
      latencyMs: 812, reply: 'OK', usage: { inputTokens: 18, outputTokens: 4 } })),
    discover: vi.fn(async (request: ProbeRequest) => ({ ok: true,
      connectionId: fingerprint({ ...request, model: '' }),
      models: [{ id: 'claude-sonnet-4-5-20250929', name: 'Sonnet 4.5', contextWindow: 200_000,
        supportsTools: true }, { id: 'claude-haiku-4-5', name: 'Haiku 4.5', supportsTools: true }],
      truncated: false, total: 2 })),
    targetFingerprint: fingerprint,
    connectionFingerprint: (target) => fingerprint({ ...target, model: '' }),
    ...over,
  };
  return probe;
}

async function mount(probe: ModelProbe | undefined, size = { cols: 80, maxRows: 24 }) {
  const source = Object.assign(new PassThrough(), { isTTY: true, setRawMode: () => source,
    ref: () => source, unref: () => source });
  const filter = createStdinFilter(source as unknown as NodeJS.ReadStream,
    { mouse: false, paste: true });
  const output = Object.assign(new PassThrough(), { columns: size.cols, rows: size.maxRows,
    isTTY: true });
  let frame = '';
  output.on('data', (chunk) => { frame += String(chunk); });
  const app = render(<SettingsScreen initial={initial} apiKeys={{}} cols={size.cols}
    maxRows={size.maxRows} scrollOffset={0} theme={getTheme('cool', caps)} caps={caps}
    draft={draft()} probe={probe}
    onProfileSave={() => ({ ok: false, persisted: false, status: 'rejected' as const,
      code: 'write_failed' as const })}
    onClose={() => {}} />, { stdin: filter.stdin,
    stdout: output as unknown as NodeJS.WriteStream, exitOnCtrlC: false, patchConsole: false });
  cleanups.push(() => { app.unmount(); app.cleanup(); filter.dispose(); source.destroy(); });
  await tick();
  // The LAST painted frame: Ink only writes when something changed, so a keystroke
  // that changes nothing legitimately produces no output at all.
  const tail = (): string => {
    const at = frame.lastIndexOf(CLEAR);
    return at < 0 ? frame : frame.slice(at);
  };
  return { frame: () => frame, tail,
    send: async (text: string) => { source.write(text); await tick(); } };
}

/** root -> Kit pack -> Manage profiles (four fixed rows precede it) -> Edit. */
async function openEditor(view: Awaited<ReturnType<typeof mount>>) {
  await view.send('\u001b[B');
  await view.send('\u001b[B');
  await view.send('\u001b[B');
  await view.send('\u001b[B');
  await view.send('\r');
  await view.send('\u001b[B');
  await view.send('\u001b[B');
  await view.send('\r');
}

describe('编辑器里的两个动作行', () => {
  it('渲染 Test connection 与 Discover models，并保留既有提示行', async () => {
    const view = await mount(makeProbe());
    await openEditor(view);
    expect(view.tail()).toContain('Test connection');
    expect(view.tail()).toContain('Discover models');
    expect(view.tail()).toContain('Target: anthropic Default URL');
    expect(view.tail()).toContain('Apply to settings draft');
  });
  it('没有 probe 端口时两行显示 (unavailable) 且按键不抛异常', async () => {
    const view = await mount(undefined);
    await openEditor(view);
    expect(view.tail()).toContain('(unavailable)');
    await view.send('\u0012');
    await view.send('\u0006');
    await tick();
    // 没有端口时两个快捷键都是 no-op：仍然停在编辑器上。
    expect(view.tail()).toContain('Test connection');
  });
  it('Enter 在 Test connection 行用解析后的 key 发起一次探测', async () => {
    const probe = makeProbe();
    const view = await mount(probe);
    await openEditor(view);
    for (let step = 0; step < 7; step++) await view.send('\u001b[B');
    await view.send('\r');
    expect(probe.test).toHaveBeenCalledTimes(1);
    expect(vi.mocked(probe.test).mock.calls[0]![0]).toMatchObject({ provider: 'anthropic',
      model: 'claude-sonnet-4-5-20250929', apiKey: 'disk-secret' });
    expect(view.tail()).toContain('OK in 812 ms');
    expect(view.tail()).toContain('Reply: "OK"');
  });
  it('Ctrl+R 也能测试，且 frame 不含 key 字面值', async () => {
    const probe = makeProbe();
    const view = await mount(probe);
    await openEditor(view);
    await view.send('\u0012');
    expect(probe.test).toHaveBeenCalledTimes(1);
    expect(view.tail()).toContain('Last test:');
    expect(view.frame()).not.toContain('disk-secret');
  });
  it('Ctrl+F 打开模型列表页，且在飞探测不被自己取消', async () => {
    const probe = makeProbe();
    const view = await mount(probe);
    await openEditor(view);
    await view.send('\u0006');
    // A second tick: the first proves the keystroke, the next proves the list painted
    // (IF-10 - Ink writes a frame only when the output actually changes).
    await tick();
    expect(probe.discover).toHaveBeenCalledTimes(1);
    expect(vi.mocked(probe.discover).mock.calls[0]![0].signal?.aborted).toBe(false);
    expect(view.tail()).toContain('Models | anthropic');
    expect(view.tail()).toContain('claude-sonnet-4-5-20250929');
  });
  it('列表页 Enter 写回 model 并回到编辑器', async () => {
    const view = await mount(makeProbe());
    await openEditor(view);
    await view.send('\u0006');
    await tick();
    await view.send('\u001b[B');
    await view.send('\r');
    expect(view.tail()).toContain('Edit profile');
    expect(view.tail()).toContain('claude-haiku-4-5');
  });
  it('列表页 Esc 回编辑器后结果仍在（指纹未变）', async () => {
    const view = await mount(makeProbe());
    await openEditor(view);
    await view.send('\u0012');
    await view.send('\u0006');
    await tick();
    await view.send('\u001b');
    expect(view.tail()).toContain('Edit profile');
    expect(view.tail()).toContain('OK in 812 ms');
  });
  it('改模型后旧结果立刻退化为未测试', async () => {
    const view = await mount(makeProbe());
    await openEditor(view);
    await view.send('\u0012');
    expect(view.tail()).toContain('OK in 812 ms');
    // Ctrl+R 不动光标，所以焦点还在 Name 行：按两次到 Model 行。
    for (let step = 0; step < 2; step++) await view.send('\u001b[B');
    await view.send('x');
    expect(view.tail()).not.toContain('OK in 812 ms');
    expect(view.tail()).toContain('Not tested for this profile yet.');
  });
  it('探测进行中 Esc 只取消探测，草稿字段不丢', async () => {
    let release: (() => void) | undefined;
    const probe = makeProbe({ test: vi.fn((request: ProbeRequest) => new Promise<
    { ok: boolean; targetId: string; latencyMs: number }>((resolve) => {
      release = () => resolve({ ok: true, targetId: fingerprint(request), latencyMs: 5 });
    })) });
    const view = await mount(probe);
    await openEditor(view);
    await view.send('\u0012');
    expect(view.tail()).toContain('testing...');
    const signal = vi.mocked(probe.test).mock.calls[0]![0].signal;
    await view.send('\u001b');
    expect(signal?.aborted).toBe(true);
    expect(view.tail()).toContain('Edit profile');
    expect(view.tail()).toContain('claude-sonnet-4-5-20250929');
    release?.();
  });
  it('没有 key 的档案不发起任何探测', async () => {
    const probe = makeProbe();
    const view = await mount(probe);
    await openEditor(view);
    // 第 6 行是 Credential mode（0..5 之后），右移到 replace 即「没有 key」。
    for (let step = 0; step < 5; step++) await view.send('\u001b[B');
    await view.send('\u001b[C');
    expect(view.tail()).toContain('(no key)');
    await view.send('\u0012');
    expect(probe.test).not.toHaveBeenCalled();
    await view.send('\u0006');
    await tick();
    expect(probe.discover).not.toHaveBeenCalled();
  });
});

describe('钩子的契约与视口', () => {
  it('假 probe 异步 reject 时折成 unknown 而不是停在 testing', async () => {
    const probe = makeProbe({ test: vi.fn(async () => { throw new Error('registry exploded'); }) });
    const view = await mount(probe);
    await openEditor(view);
    await view.send('\u0012');
    const frame = view.tail();
    expect(frame).toContain('FAILED - The connection test could not run.');
    expect(frame.lastIndexOf('testing...')).toBeLessThan(frame.lastIndexOf('FAILED'));
  });
  it('40 列窄帧下结果行仍在帧内可见', async () => {
    const view = await mount(makeProbe(), { cols: 40, maxRows: 14 });
    await openEditor(view);
    for (let step = 0; step < 7; step++) await view.send('\u001b[B');
    await view.send('\r');
    expect(view.tail()).toContain('Last test:');
    expect(view.tail()).toContain('Reply:');
  });
  it('假 probe 同步抛错时同样折成 unknown（钩子永不 reject）', async () => {
    const exploding = vi.fn(() => { throw new Error('registry exploded'); }) as never;
    const probe = makeProbe({ test: exploding });
    const view = await mount(probe);
    await openEditor(view);
    await view.send('\u0012');
    expect(view.tail()).toContain('FAILED - The connection test could not run.');
    await view.send('\u0012');
    // 第二次仍然可用：状态没有卡在 testing 上。
    expect(view.tail()).toContain('FAILED - The connection test could not run.');
  });
  it('关闭覆盖层会 abort 在飞的探测（AC-11）', async () => {
    const hanging = vi.fn(() => new Promise(() => { /* never settles */ })) as never;
    const probe = makeProbe({ test: hanging });
    const view = await mount(probe);
    await openEditor(view);
    await view.send('\u0012');
    const signal = vi.mocked(probe.test).mock.calls[0]![0].signal;
    expect(signal?.aborted).toBe(false);
    cleanups.splice(0).forEach((cleanup) => cleanup());
    await tick();
    expect(signal?.aborted).toBe(true);
  });
});

/** Key names for the new binds, spelled without escape sequences. */
const CTRL_R = String.fromCharCode(18);
const CTRL_F = String.fromCharCode(6);
const UP_ARROW = String.fromCharCode(27) + '[A';
const DOWN_ARROW = String.fromCharCode(27) + '[B';
const ESCAPE_KEY = String.fromCharCode(27);

/** SGR escape sequence, built without a literal control byte in source. */
const SGR = new RegExp(String.fromCharCode(27) + '[[0-9;?]*[A-Za-z]', 'g');
const stripAnsi = (text: string): string => text.replace(SGR, '');

/** The row Ink marked with the caret: the cursor lives in exactly one place. */
function focusedRow(view: { tail(): string }): string {
  return stripAnsi(view.tail()).split('\n')
    .find((line) => /(^|\| )> /.test(line)) ?? '';
}

/**
 * Wait for the LAST painted frame to contain `needle`.
 *
 * Ink paints on its own schedule (IF-10): a keystroke that changes state does not
 * promise the next frame is already on the stream, and a 400-row list takes several
 * renders to lay out. Polling the tail is the only stable way to assert on arrival.
 */
async function waitFor(view: { tail(): string }, needle: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (view.tail().includes(needle)) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`the last frame never contained: ${needle}`);
}

/** A discovery outcome whose connectionId matches the editor's draft target. */
function listing(models: ModelCandidate[], truncated = false, total?: number) {
  return vi.fn(async () => ({ ok: true,
    connectionId: fingerprint({ provider: 'anthropic', model: '', baseUrl: null,
      apiKey: 'disk-secret' }),
    models, truncated, ...(total === undefined ? {} : { total }) }));
}

const MODELS_12: ModelCandidate[] = ['claude-sonnet-4-5-20250929',
  ...Array.from({ length: 11 }, (_unused, at) => `model-${String(at + 2).padStart(2, '0')}`)]
  .map((id) => ({ id, name: id, supportsTools: true }));

describe('列表页的搜索、光标与截断（AC-25）', () => {
  it('初始光标落在当前模型上，Up/Down 环绕且只移动光标', async () => {
    const view = await mount(makeProbe({ discover: listing(MODELS_12) }));
    await openEditor(view);
    await view.send(CTRL_F);
    await waitFor(view, 'Models | anthropic (12)');
    // `rankCandidates` 把当前模型置顶，所以光标初始就在它上面。
    expect(focusedRow(view)).toContain('claude-sonnet-4-5-20250929');
    await view.send(UP_ARROW);
    await waitFor(view, '> model-12');
    expect(focusedRow(view)).toContain('model-12');
    await view.send(DOWN_ARROW);
    await waitFor(view, '> claude-sonnet-4-5-20250929');
    expect(focusedRow(view)).toContain('claude-sonnet-4-5-20250929');
  });
  it('过滤串变化后光标复位到 0：Enter 选中的是第一条匹配', async () => {
    const view = await mount(makeProbe({ discover: listing(MODELS_12) }));
    await openEditor(view);
    await view.send(CTRL_F);
    await waitFor(view, 'Models | anthropic (12)');
    await view.send(DOWN_ARROW);
    await view.send(DOWN_ARROW);
    await view.send('/');
    await view.send('model-1');
    await waitFor(view, 'Search: model-1');
    await view.send('\r');
    await waitFor(view, 'Edit profile');
    expect(view.tail()).toContain('model-10');
  });
  it('搜索态下 Esc 只退出搜索，第二次才回编辑器', async () => {
    const view = await mount(makeProbe({ discover: listing(MODELS_12) }));
    await openEditor(view);
    await view.send(CTRL_F);
    await waitFor(view, 'Models | anthropic (12)');
    await view.send('/');
    await view.send('model-1');
    await waitFor(view, 'Search: model-1');
    await view.send(ESCAPE_KEY);
    await waitFor(view, 'Search: (/ to search)');
    expect(view.tail()).toContain('Models | anthropic');
    await view.send(ESCAPE_KEY);
    await waitFor(view, 'Edit profile');
  });
  it('搜索态下 r 是普通过滤字符，不发起重试', async () => {
    const discover = listing(MODELS_12);
    const view = await mount(makeProbe({ discover }));
    await openEditor(view);
    await view.send(CTRL_F);
    await waitFor(view, 'Models | anthropic (12)');
    await view.send('/');
    await view.send('r');
    await waitFor(view, 'Search: r');
    expect(discover).toHaveBeenCalledTimes(1);
  });
  it('无匹配时给出可执行的提示，而不是伪装成空列表', async () => {
    const view = await mount(makeProbe({ discover: listing(MODELS_12) }));
    await openEditor(view);
    await view.send(CTRL_F);
    await waitFor(view, 'Models | anthropic (12)');
    await view.send('/');
    await view.send('zzz');
    await waitFor(view, 'No model matches "zzz". Esc clears the search.');
  });
  it('被截断时底部固定一行真实总数，且能滚进视口（RV-P2-7）', async () => {
    const bulk: ModelCandidate[] = Array.from({ length: 405 }, (_unused, at) =>
      ({ id: `bulk-${at}`, name: `Bulk ${at}`, supportsTools: true }));
    const view = await mount(makeProbe({ discover: listing(bulk, true, 405) }));
    await openEditor(view);
    await view.send(CTRL_F);
    await waitFor(view, 'Models | anthropic (405)');
    // 截断行在列表底部：把光标绕到最后一行，滚动跟过去。
    await view.send(UP_ARROW);
    await waitFor(view, 'Showing first 400 of 405. Narrow with search.');
    expect(focusedRow(view)).toContain('bulk-404');
  });
  it('列表不超过 8 条时不出现搜索行', async () => {
    const view = await mount(makeProbe());
    await openEditor(view);
    await view.send(CTRL_F);
    await waitFor(view, 'Models | anthropic (2)');
    // `unicode: false` 的整帧必须是纯 ASCII（AC-22）：一个非 ASCII 字节就是回归。
    expect([...Buffer.from(view.tail(), 'utf8')].every((byte) => byte < 0x80)).toBe(true);
    expect(view.tail()).not.toContain('/ search');
    await view.send('/');
    expect(view.tail()).not.toContain('Search: ');
  });
});

describe('choose-model 缩减器（唯一写入点）', () => {
  const openModels = () => {
    const state = modelProfileReducer(createModelProfileState(draft()),
      { type: 'edit', profile });
    return modelProfileReducer(state, { type: 'page', page: 'models' });
  };
  it('只写 model 并回到编辑器，凭据/窗口/草稿都不动', () => {
    const state = openModels();
    const next = modelProfileReducer(state,
      { type: 'choose-model', model: 'claude-haiku-4-5' });
    expect(next.page).toBe('editor');
    expect(next.editor?.model).toBe('claude-haiku-4-5');
    // 换模型不是换端点：替换输入框、凭据模式与上下文窗口都保持原样。
    expect(next.editor?.apiKey).toBe('');
    expect(next.editor?.credentialMode).toBe('keep');
    expect(next.editor?.contextWindow).toBe('');
    expect(next.draft).toBe(state.draft);
  });
  it('不在列表页时不是合法动作', () => {
    const state = modelProfileReducer(createModelProfileState(draft()),
      { type: 'edit', profile });
    expect(modelProfileReducer(state, { type: 'choose-model', model: 'x' })).toBe(state);
  });
  it('没有编辑器时保持原状态', () => {
    const models = { ...createModelProfileState(draft()), page: 'models' as const };
    expect(modelProfileReducer(models, { type: 'choose-model', model: 'x' })).toBe(models);
  });
});

describe('快捷键不与全局输入冲突（AC-16）', () => {
  it('App 的全局分支不消费 Ctrl+R / Ctrl+F', () => {
    const app = readFileSync(new URL('../ui/App.tsx', import.meta.url), 'utf8');
    // Ctrl+F STAYS GLOBALLY UNCONSUMED - unchanged: the models page owns it.
    expect(app).not.toMatch(/key\.ctrl[^\n]*input\s*===\s*['"][fF]['"]/);
    expect(app).not.toMatch(/input\.toLowerCase\(\)\s*===\s*['"][rf]['"]/);
    // Ctrl+R IS CONSUMED GLOBALLY NOW (tui-branch-terminal-shortcut D-1 moved the
    // repaint off Ctrl+L onto Ctrl+R), so the guard can no longer be "the App has
    // no such branch". What it must still guarantee - AC-14, and the test below -
    // is that the branch DEFERS to an open overlay before doing anything, which is
    // how the editor keeps its own Ctrl+R (Test connection).
    const redrawBranch = app.indexOf("input === 'r'");
    expect(redrawBranch).toBeGreaterThan(-1);
    expect(app.slice(redrawBranch, redrawBranch + 200)).toContain('stateRef.current.overlay');
  });
  it('编辑器里的 Ctrl+R 触发测试而不是全局 toast', async () => {
    const probe = makeProbe();
    const view = await mount(probe);
    await openEditor(view);
    await view.send(CTRL_R);
    expect(probe.test).toHaveBeenCalledTimes(1);
    expect(view.tail()).not.toContain('Wait for the run');
  });
});
