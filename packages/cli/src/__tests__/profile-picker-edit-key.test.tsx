/**
 * profile-picker-edit-key — `e` edits the focused profile from the picker.
 *
 * The editor, `onEdit` wiring and `returnPage: 'picker'` state machine already
 * existed; the only missing piece was the keystroke. These cases pin the entry
 * key on BOTH pages (the manager page gains the same shortcut on purpose), the
 * `Current custom` no-op boundary, and that searching keeps `e` a query
 * character.
 */
import React from 'react';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render } from 'ink';
import { createStdinFilter } from '../input/stdin-filter.js';
import { SettingsScreen, type SettingsValues } from '../ui/overlays/SettingsScreen.js';
import type { ModelSettingsDraft } from '../config/model-profile-store.js';
import type { ModelProfile } from '../config/model-profiles.js';
import { getTheme } from '../ui/theme.js';

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
  output.on('data', (chunk) => { frame += String(chunk); });
  const app = render(element, {
    stdin: filter.stdin, stdout: output as unknown as NodeJS.WriteStream,
    stderr: output as unknown as NodeJS.WriteStream, exitOnCtrlC: false, patchConsole: false,
  });
  cleanups.push(() => { app.unmount(); app.cleanup(); filter.dispose(); source.destroy(); });
  await delay();
  return { frame: () => frame, send: async (bytes: string) => { source.write(bytes); await delay(); } };
}

function profile(id: string, name: string): ModelProfile {
  return { id, name, provider: 'openai', model: 'custom', baseUrl: null, apiKey: 'disk-secret' };
}

function draft(entries: ModelProfile[]): ModelSettingsDraft {
  return { diskRevision: 'disk', liveRevision: 0, baseline: {}, liveBaseline: {},
    patch: {}, activateRoles: [], profiles: { version: 1, entries,
      mainId: entries[0]!.id, fastId: entries[0]!.id } } as unknown as ModelSettingsDraft;
}

const initial: SettingsValues = { provider: 'openai', model: 'custom', baseUrl: '',
  thinkingLevel: 'off', showThinking: 'off', liveToolOutput: 'off', maxTokens: '', apiKey: '',
  logLevel: 'info', fastEnabled: 'off', fastModel: '', fastProvider: '', fastReview: '5',
  fastReviewBudget: '40', compactionEnabled: 'off', compactionThreshold: '90',
  compactionKeepTurns: '3', compactionSubagents: 'off', compactionArchive: 'off' };

async function mountSettings(entries: ModelProfile[] = [profile('profile-a', 'Shared')]) {
  return mount(<SettingsScreen initial={initial} apiKeys={{}} cols={80} maxRows={24}
    scrollOffset={0} theme={getTheme('cool', caps)} caps={caps} draft={draft(entries)}
    onProfileSave={vi.fn(() => ({ ok: false, persisted: false, status: 'rejected' as const,
      code: 'write_failed' as const }))} />);
}

describe('ModelProfilePicker 的 e 编辑快捷键', () => {
  it('Main profile 选择页：光标在已配置 profile 上按 e 直接打开编辑器', async () => {
    const view = await mountSettings();
    await view.send('\r');            // root 第 0 行 Enter -> Main profile 选择页
    await view.send('\x1b[B');        // 光标移到第一条已配置 profile
    await view.send('e');
    // `frame()` 累积了所有历史帧，负向断言只对「从未出现过」的标记有意义；
    // `Edit profile` 标题只在编辑器页渲染，出现即证明已离开选择页。
    expect(view.frame()).toContain('Edit profile');
  });

  it('Manage profiles 管理页：同一 e 分支同样直达编辑器（有意的对称行为）', async () => {
    const view = await mountSettings();
    await view.send('\x1b[B');
    await view.send('\x1b[B');
    await view.send('\r');            // Manage profiles
    await view.send('e');             // 光标默认落在第一条条目上
    expect(view.frame()).toContain('Edit profile');
  });

  it('光标在 Current custom 行按 e 无操作：只编辑已配置的 profile', async () => {
    const view = await mountSettings();
    await view.send('\r');            // 进入选择页，光标默认在 Current custom 行
    await view.send('e');
    expect(view.frame()).toContain('Current custom');       // 仍停留在选择页
    expect(view.frame()).not.toContain('Edit profile');     // 编辑器没有打开
  });

  it('搜索态下 e 仍进查询框，不被快捷键劫持', async () => {
    const entries = Array.from({ length: 9 }, (_, i) => profile(`p${i}`, `alpha${i}`));
    const view = await mountSettings(entries);   // 9 条 -> searchable
    await view.send('\r');
    await view.send('/');
    await view.send('e');
    expect(view.frame()).toContain('Search: e');
    expect(view.frame()).not.toContain('Edit profile');
  });
});
