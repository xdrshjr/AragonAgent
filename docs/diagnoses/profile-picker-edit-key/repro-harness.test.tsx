/**
 * DIAGNOSIS REPRO HARNESS (diagnosis node output; not part of the test suite).
 * To run: copy this file into packages/cli/src/__tests__/ (imports are relative
 * to that directory), then: cd packages/cli && npx vitest run src/__tests__/<name>
 * Current-HEAD expectation: every case below PASSES, i.e. the bug reproduces.
 */
import React from 'react';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render } from 'ink';
import { createStdinFilter } from '../input/stdin-filter.js';
import { SettingsScreen, type SettingsValues } from '../ui/overlays/SettingsScreen.js';
import type { ModelSettingsDraft } from '../config/model-profile-store.js';
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

const profile = { id: 'profile-a', name: 'Shared', provider: 'openai', model: 'custom',
  baseUrl: null, apiKey: 'disk-secret' };
const draft = () => ({ diskRevision: 'disk', liveRevision: 0, baseline: {}, liveBaseline: {},
  patch: {}, activateRoles: [], profiles: { version: 1, entries: [profile], mainId: 'profile-a',
    fastId: 'profile-a' } }) as unknown as ModelSettingsDraft;
const initial: SettingsValues = { provider: 'openai', model: 'custom', baseUrl: '',
  thinkingLevel: 'off', showThinking: 'off', liveToolOutput: 'off', maxTokens: '', apiKey: '',
  logLevel: 'info', fastEnabled: 'off', fastModel: '', fastProvider: '', fastReview: '5',
  fastReviewBudget: '40', compactionEnabled: 'off', compactionThreshold: '90',
  compactionKeepTurns: '3', compactionSubagents: 'off', compactionArchive: 'off' };

async function mountSettings() {
  return mount(<SettingsScreen initial={initial} apiKeys={{}} cols={80} maxRows={24}
    scrollOffset={0} theme={getTheme('cool', caps)} caps={caps} draft={draft()}
    onProfileSave={vi.fn(() => ({ ok: false, persisted: false, status: 'rejected' as const,
      code: 'write_failed' as const }))} />);
}

describe('DIAG-2 Main-profile picker ignores e', () => {
  it('e on a configured profile in the Main profile picker does nothing', async () => {
    const view = await mountSettings();
    await view.send('\r');            // root 第 0 行 Enter -> Main profile 选择页
    await view.send('\x1b[B');        // 光标移到第一条已配置 profile
    await view.send('e');
    expect(view.frame()).toContain('Current custom');        // 仍停留在选择页
    expect(view.frame()).not.toContain('Credential mode');   // 编辑器没有打开
  });

  it('contrast: the editor is reachable only via Manage profiles + Enter Enter', async () => {
    const view = await mountSettings();
    await view.send('\x1b[B');
    await view.send('\x1b[B');
    await view.send('\r');            // Manage profiles
    await view.send('\r');            // 条目上 Enter -> 光标跳到 Edit 动作行
    await view.send('\r');            // Edit 动作行 Enter -> 编辑器
    expect(view.frame()).toContain('Edit profile');
  });
});
