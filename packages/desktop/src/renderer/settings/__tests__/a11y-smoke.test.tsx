/**
 * A structural accessibility smoke test over every surface this area owns. It is NOT axe
 * (`axe-core` is not installed in this workspace): it checks the rules that are decidable
 * from the DOM alone and that this code base is most likely to break - every control has an
 * accessible name, every field has a label, ids are unique, dialogs are named, and no
 * interactive element is hidden from assistive technology.
 */

import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initialViewState } from '@aragon-agent/tui/model/agent/reducer';
import { useDrafts } from '../../lib/settings-drafts.js';
import { setLanguage } from '../../i18n/index.js';
import { CommandPalette } from '../../layout/CommandPalette.js';
import { ShortcutSheet } from '../../layout/ShortcutSheet.js';
import { Onboarding } from '../../onboarding/Onboarding.js';
import { InspectorPanel } from '../../panels/InspectorPanel.js';
import { mountSession, run, unmountSession } from '../../panels/__tests__/session-fixture.js';
import { PromptPicker } from '../../prompts/PromptPicker.js';
import { usePrompts } from '../../prompts/prompts-store.js';
import { useSessionsList } from '../../store/sessions-list-store.js';
import { useUi, type SettingsPage } from '../../store/ui-store.js';
import { SettingsShell } from '../SettingsShell.js';
import { makeView, startConfigServer } from './config-server.js';
import { ok, removeBridge } from './test-bridge.js';

vi.mock('../../store/actions.js', () => ({
  openSession: vi.fn(async () => ({ ok: true, sessionId: 'x' })),
  closeSession: vi.fn(async () => undefined),
  reconnectSession: vi.fn(async () => ({ ok: true, sessionId: 'x' })),
}));

function nameOf(element: Element): string {
  const labelledBy = element.getAttribute('aria-labelledby');
  if (labelledBy) {
    return labelledBy.split(/\s+/).map((id) => document.getElementById(id)?.textContent ?? '').join(' ').trim();
  }
  return (element.getAttribute('aria-label') ?? element.textContent ?? element.getAttribute('title') ?? '').trim();
}

function violations(root: ParentNode): string[] {
  const found: string[] = [];
  for (const button of root.querySelectorAll('button, [role="button"], [role="switch"], a[href]')) {
    if (nameOf(button) === '') found.push(`unnamed control: ${button.outerHTML.slice(0, 120)}`);
  }
  for (const field of root.querySelectorAll('input:not([type="hidden"]), select, textarea')) {
    const input = field as HTMLInputElement;
    const labelled = (input.labels?.length ?? 0) > 0 || field.hasAttribute('aria-label') || field.hasAttribute('aria-labelledby');
    if (!labelled) found.push(`unlabelled field: ${field.outerHTML.slice(0, 120)}`);
  }
  const seen = new Set<string>();
  for (const element of root.querySelectorAll('[id]')) {
    if (seen.has(element.id)) found.push(`duplicate id: ${element.id}`);
    seen.add(element.id);
  }
  for (const image of root.querySelectorAll('svg[role="img"], img')) {
    if (nameOf(image) === '' && !image.hasAttribute('alt')) found.push(`unnamed image: ${image.outerHTML.slice(0, 100)}`);
  }
  for (const dialog of root.querySelectorAll('[role="dialog"]')) {
    if (nameOf(dialog) === '' && !dialog.getAttribute('aria-labelledby')) found.push('unnamed dialog');
  }
  for (const hidden of root.querySelectorAll('[aria-hidden="true"]')) {
    // A modal dialog hides the page behind it on purpose (the `aria-hidden` package tags those).
    if (hidden.hasAttribute('data-aria-hidden')) continue;
    if (hidden.querySelector('button, input, select, textarea, a[href]')) found.push('interactive content inside aria-hidden');
  }
  return found;
}

const PAGES: SettingsPage[] = [
  'general', 'models', 'agent', 'team', 'todo', 'fast', 'context', 'retry', 'skills', 'governance',
  'prompts', 'shortcuts', 'diagnostics', 'updates', 'about',
];

const profile = { id: 'p1', name: 'Work', provider: 'anthropic', model: 'claude-x', baseUrl: null, contextWindow: null, key: { present: true, tail: '1234', source: 'file' } };

beforeEach(async () => {
  setLanguage('en');
  usePrompts.setState({ prompts: [], loaded: false, error: null });
  await startConfigServer(makeView({ modelProfiles: { version: 1, entries: [profile], mainId: 'p1', fastId: null, kits: [{ id: 'k1', name: 'Kit', mainProfileId: 'p1', fastProfileId: null, subagent: { model: 'main', modelProfileId: null } }] } }), {
    'prompts:list': () => ok([{ id: 'a', title: 'Explain', content: 'Explain {{x}}', useCount: 0, updatedAt: 1 }]),
    'desktop-state:get': () => ok({ language: 'auto', enterToSend: true, maxLiveHosts: 6, parkAfterIdleMinutes: 15, update: { channel: 'stable', lastCheckedAt: 0, skippedVersion: null, enabled: true, feedUrl: null } } as never),
    'app:info': () => ok({ versions: { desktop: '1', cli: '2', core: '3', tui: '4', electron: '5', node: '6' }, platform: 'win32', homeRoot: '/h', overridden: false, engineError: null, isPackaged: true }),
    'update:check': () => ok({ state: 'unsupported' as const }),
    'workspace:recent': () => ok(['D:/w']),
  });
  useSessionsList.setState({ rows: [] });
  useUi.setState({ paletteOpen: false, promptPickerOpen: false, shortcutsOpen: false, view: 'settings' });
});
afterEach(() => { cleanup(); unmountSession('s1'); removeBridge(); useDrafts.getState().discardAll(); });

describe('settings pages', () => {
  for (const page of PAGES) {
    it(`${page} has named controls, labelled fields and unique ids`, async () => {
      useUi.setState({ settingsPage: page });
      const { container } = render(<SettingsShell />);
      await screen.findByRole('heading', { level: 1 });
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
      expect(violations(container)).toEqual([]);
    });
  }

  it('keeps the edit dialogs accessible too', async () => {
    useUi.setState({ settingsPage: 'models' });
    render(<SettingsShell />);
    const user = userEvent.setup({ delay: null });
    await user.click(await screen.findByRole('button', { name: 'Edit' }));
    expect(violations(document.body)).toEqual([]);
  });
});

describe('panels', () => {
  for (const tab of ['changes', 'plan', 'agents', 'jobs', 'context', 'governance'] as const) {
    it(`${tab} is accessible when empty and when populated`, async () => {
      mountSession('s1', initialViewState());
      const empty = render(<InspectorPanel sessionId="s1" tab={tab} />);
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
      expect(violations(empty.container)).toEqual([]);
      empty.unmount();
      unmountSession('s1');

      mountSession('s1', run([
        { type: 'toolCallStart', toolCallId: 't', toolName: 'edit' },
        { type: 'toolCallEnd', toolCallId: 't', args: { path: 'a.ts' } },
        { type: 'toolExecStart', toolCallId: 't' },
        { type: 'toolExecEnd', toolCallId: 't', isError: false, duration: 1, preview: '', patch: { path: 'a.ts', kind: 'update', added: 1, removed: 0, truncated: false, lineCount: 1, hunks: [{ oldStart: 1, oldCount: 0, newStart: 1, newCount: 1, lines: [{ kind: 'add', newLine: 1, text: 'x' }] }] } },
        { type: 'todoUpdate', snapshot: { items: [{ content: 'a', activeForm: 'a', status: 'pending' }], total: 1, doneCount: 0, activeIndex: 0, updatedAt: 1, acceptance: { items: [{ content: 'c', check: 'k', status: 'pending', evidence: 'e' }], total: 1, checkedCount: 0, passedCount: 0, failedCount: 0, updatedAt: 1 } } },
        { type: 'contextUsage', snapshot: { occupied: 10, window: 100, pct: 10, source: 'usage', deltaTokens: 0, windowKnown: true, windowOverridden: false } as never },
        { type: 'serviceStart', service: { id: 's1', kind: 'service', toolCallId: 'x', command: 'dev', cwd: '/', pid: 1, status: 'running', startedAt: 1, exitCode: null, signal: null, rows: [], rowsSeen: 0, truncated: false, lastOutputAt: 1 } },
      ]));
      const full = render(<InspectorPanel sessionId="s1" tab={tab} />);
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
      expect(violations(full.container)).toEqual([]);
    });
  }
});

describe('overlays', () => {
  it('the command palette', async () => {
    render(<CommandPalette />);
    act(() => { useUi.getState().setPaletteOpen(true); });
    await screen.findByRole('combobox');
    expect(violations(document.body)).toEqual([]);
  });

  it('the prompt picker, in its list and form steps', async () => {
    render(<PromptPicker />);
    act(() => { useUi.getState().setPromptPickerOpen(true); });
    const option = await screen.findByRole('option', { name: /Explain/ });
    expect(violations(document.body)).toEqual([]);
    await userEvent.setup({ delay: null }).click(option);
    await screen.findByLabelText('x');
    expect(violations(document.body)).toEqual([]);
  });

  it('the shortcut sheet', () => {
    render(<ShortcutSheet />);
    act(() => { useUi.getState().setShortcutsOpen(true); });
    expect(violations(document.body)).toEqual([]);
  });
});

describe('onboarding', () => {
  it('every step', async () => {
    const { container } = render(<Onboarding onFinished={() => undefined} onSkip={() => undefined} />);
    const user = userEvent.setup({ delay: null });
    expect(violations(container)).toEqual([]);
    await user.click(screen.getByRole('radio', { name: /Custom endpoint/ }));
    expect(violations(container)).toEqual([]);
    await user.click(screen.getByRole('radio', { name: /Anthropic/ }));
    await user.click(screen.getByRole('button', { name: 'Next' }));
    expect(violations(container)).toEqual([]);
    await user.type(screen.getByLabelText('API key'), 'k');
    await user.type(screen.getByLabelText('Model'), 'm');
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await screen.findByText('Things you can ask for:').catch(() => undefined);
    expect(violations(container)).toEqual([]);
  });
});
