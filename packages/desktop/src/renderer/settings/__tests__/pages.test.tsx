import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { initialViewState } from '@aragon-agent/tui/model/agent/reducer';
import { useDrafts } from '../../lib/settings-drafts.js';
import { setLanguage } from '../../i18n/index.js';
import { mountSession, unmountSession } from '../../panels/__tests__/session-fixture.js';
import { usePrompts } from '../../prompts/prompts-store.js';
import { useUpdates, watchUpdates } from '../../store/update-store.js';
import { useUi, type SettingsPage } from '../../store/ui-store.js';
import { SettingsShell } from '../SettingsShell.js';
import { makeView, startConfigServer, type ConfigServer } from './config-server.js';
import { fail, ok, removeBridge } from './test-bridge.js';

let server: ConfigServer;

async function open(page: SettingsPage, view = makeView(), extra: Parameters<typeof startConfigServer>[1] = {}): Promise<ReturnType<typeof userEvent.setup>> {
  server = await startConfigServer(view, extra);
  useUi.setState({ view: 'settings', settingsPage: page, activeSessionId: null });
  render(<SettingsShell />);
  return userEvent.setup({ delay: null });
}

const card = (name: string): HTMLElement => screen.getByRole('region', { name });

beforeEach(() => {
  setLanguage('en');
  usePrompts.setState({ prompts: [], loaded: false, error: null });
  useUpdates.setState({ status: null });
});
afterEach(() => { cleanup(); unmountSession('s1'); removeBridge(); useDrafts.getState().discardAll(); });

describe('Skills', () => {
  const installed = [
    { name: 'review', source: 'user', description: 'Review a diff', enabled: true, invalid: false },
    { name: 'deploy', source: 'project', description: 'Ship it', enabled: true, invalid: false },
  ];
  const withSkills = (skills = installed) => ({ 'skills:list': () => ok({ skills }) });

  it('lists the installed skills with no session open and switches one off with one write', async () => {
    const user = await open('skills', makeView({ skills: { ...makeView().skills, disabled: ['legacy'] } }), withSkills());
    const review = await screen.findByRole('switch', { name: 'Skill review' });
    expect(screen.getByText('Review a diff')).toBeTruthy();
    expect(screen.getByText('project')).toBeTruthy();
    // A name switched off in the config but no longer installed is still there, marked, and off.
    expect((screen.getByRole('switch', { name: 'Skill legacy' }) as HTMLElement).getAttribute('aria-checked')).toBe('false');
    expect(screen.getByText('not installed')).toBeTruthy();
    await user.click(review);
    await waitFor(() => expect(server.patches).toHaveLength(1));
    expect(server.patches[0]!.patch).toEqual({ skills: { disabled: ['legacy', 'review'] } });
  });

  it('turns a skill back on', async () => {
    const user = await open('skills', makeView({ skills: { ...makeView().skills, disabled: ['legacy'] } }), withSkills([]));
    await user.click(await screen.findByRole('switch', { name: 'Skill legacy' }));
    await waitFor(() => expect(server.patches).toHaveLength(1));
    expect(server.patches[0]!.patch).toEqual({ skills: { disabled: [] } });
  });

  it('says so when nothing is installed', async () => {
    await open('skills', makeView(), withSkills([]));
    expect(await screen.findByText(/No skills are installed/)).toBeTruthy();
  });

  it('shows why the listing failed instead of an empty list that looks like "none installed"', async () => {
    await open('skills', makeView(), { 'skills:list': () => fail('host_unavailable', 'engine not found') });
    expect((await screen.findByRole('alert')).textContent).toBe('Could not list skills: engine not found');
    expect(screen.queryByText(/No skills are installed/)).toBeNull();
  });

  it('shows the failure instead of toggling silently', async () => {
    const user = await open('skills', makeView({ skills: { ...makeView().skills, disabled: ['legacy'] } }), {
      ...withSkills([]),
      'config:patch': () => ok({ ok: false as const, code: 'write_failed', revision: 'r1' }),
    });
    await user.click(await screen.findByRole('switch', { name: 'Skill legacy' }));
    expect((await screen.findByRole('alert')).textContent).toBe('Could not save (write_failed). Nothing was changed.');
  });
});

describe('Team: force a fan-out', () => {
  it('needs an open session, and says so', async () => {
    await open('team');
    expect(await screen.findByText(/Open a session first/)).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Arm for the next message' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('arms the open session with the chosen count and confirms what the engine adopted', async () => {
    const host = mountSession('s1', initialViewState(), { handler: (command) => (command.c === 'team.arm-forced' ? { ok: true, value: { armed: command.count } } : { ok: true }) });
    const user = await open('team');
    useUi.setState({ activeSessionId: 's1' });
    const box = await screen.findByLabelText('Number of sub-agents');
    await user.clear(box);
    await user.type(box, '3');
    await user.click(screen.getByRole('button', { name: 'Arm for the next message' }));
    await waitFor(() => expect(host.commands).toContainEqual({ c: 'team.arm-forced', count: 3 }));
    expect(await screen.findByText(/fan out to 3 sub-agents/)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Disarm' }));
    await waitFor(() => expect(host.commands).toContainEqual({ c: 'team.disarm' }));
    await waitFor(() => expect(screen.queryByText(/fan out to 3/)).toBeNull());
  });

  it('refuses a count above the configured maximum without sending anything', async () => {
    const host = mountSession('s1', initialViewState());
    const user = await open('team');
    useUi.setState({ activeSessionId: 's1' });
    const box = await screen.findByLabelText('Number of sub-agents');
    await user.clear(box);
    await user.type(box, '99');
    expect((await screen.findByRole('alert')).textContent).toMatch(/whole number from 1 to/);
    expect((screen.getByRole('button', { name: 'Arm for the next message' }) as HTMLButtonElement).disabled).toBe(true);
    expect(host.commands.filter((c) => c.c === 'team.arm-forced')).toHaveLength(0);
  });
});

describe('Prompts', () => {
  const library = [
    { id: 'a', title: 'Explain', content: 'Explain it', useCount: 1, updatedAt: 1 },
    { id: 'b', title: 'Debug', content: 'Debug it', description: 'Find bugs', tags: ['dev'], favorite: true, useCount: 0, updatedAt: 2 },
  ];
  const handlers = () => ({
    'prompts:list': () => ok(library),
    'prompts:create': () => ok({ id: 'new' }),
    'prompts:update': () => ok({ ok: true as const }),
    'prompts:delete': () => ok({ ok: true as const }),
    'prompts:favorite': () => ok({ ok: true as const }),
  });

  it('lists the library and toggles a favourite', async () => {
    const user = await open('prompts', makeView(), handlers());
    expect(await screen.findByText('Explain')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Add to favourites' }));
    await waitFor(() => expect(server.bridge.calls('prompts:favorite')).toEqual([{ id: 'a', favorite: true }]));
    expect(screen.getByRole('button', { name: 'Remove from favourites' }).getAttribute('aria-pressed')).toBe('true');
  });

  it('creates a prompt, validating with the engine\u2019s own rules before asking the main process', async () => {
    const user = await open('prompts', makeView(), handlers());
    await screen.findByText('Explain');
    await user.click(screen.getByRole('button', { name: 'New prompt' }));
    const dialog = await screen.findByRole('dialog', { name: 'New prompt' });
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(within(dialog).getByText('Give the prompt a title.')).toBeTruthy();
    expect(server.bridge.calls('prompts:create')).toHaveLength(0);

    await user.type(within(dialog).getByLabelText('Title'), 'Summarise');
    await user.type(within(dialog).getByLabelText('Tags'), 'a, b');
    await user.click(within(dialog).getByLabelText('Prompt text'));
    await user.paste('Summarise {{topic}}');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(server.bridge.calls('prompts:create')).toHaveLength(1));
    expect(server.bridge.calls('prompts:create')[0]).toEqual({
      title: 'Summarise', content: 'Summarise {{topic}}', description: '', tags: ['a', 'b'], favorite: false,
    });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'New prompt' })).toBeNull());
  });

  it('edits an existing prompt through update', async () => {
    const user = await open('prompts', makeView(), handlers());
    await screen.findByText('Debug');
    await user.click(screen.getAllByRole('button', { name: 'Edit' })[1]!);
    const dialog = await screen.findByRole('dialog', { name: 'Edit prompt' });
    expect((within(dialog).getByLabelText('Tags') as HTMLInputElement).value).toBe('dev');
    await user.clear(within(dialog).getByLabelText('Title'));
    await user.type(within(dialog).getByLabelText('Title'), 'Debug more');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(server.bridge.calls('prompts:update')).toHaveLength(1));
    expect(server.bridge.calls('prompts:update')[0]).toMatchObject({ id: 'b', patch: { title: 'Debug more', favorite: true } });
  });

  it('asks before deleting, then deletes', async () => {
    const user = await open('prompts', makeView(), handlers());
    await screen.findByText('Explain');
    await user.click(screen.getAllByRole('button', { name: 'Delete' })[0]!);
    expect(server.bridge.calls('prompts:delete')).toHaveLength(0);
    await user.click(within(await screen.findByRole('dialog', { name: 'Delete this prompt?' })).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(server.bridge.calls('prompts:delete')).toEqual([{ id: 'a' }]));
  });

  it('shows the main process\u2019s refusal', async () => {
    const user = await open('prompts', makeView(), { ...handlers(), 'prompts:delete': () => fail('invalid_argument', 'Official prompts are read-only.') });
    await screen.findByText('Explain');
    await user.click(screen.getAllByRole('button', { name: 'Delete' })[0]!);
    await user.click(within(await screen.findByRole('dialog', { name: 'Delete this prompt?' })).getByRole('button', { name: 'Delete' }));
    expect(await screen.findByText('Official prompts are read-only.')).toBeTruthy();
  });

  it('imports a JSON file, skipping what the library would refuse', async () => {
    await open('prompts', makeView(), handlers());
    await screen.findByText('Explain');
    const file = new File([JSON.stringify([{ title: 'One', content: 'first' }, { title: '', content: 'bad' }, { title: 'Two', content: 'second' }])], 'p.json', { type: 'application/json' });
    fireEvent.change(screen.getByLabelText('Import JSON', { selector: 'input' }), { target: { files: [file] } });
    expect(await screen.findByText('Imported 2 prompts, skipped 1.')).toBeTruthy();
    expect(server.bridge.calls('prompts:create')).toHaveLength(2);
  });

  it('says a file with nothing usable cannot be imported', async () => {
    await open('prompts', makeView(), handlers());
    await screen.findByText('Explain');
    fireEvent.change(screen.getByLabelText('Import JSON', { selector: 'input' }), { target: { files: [new File(['nope'], 'p.json')] } });
    expect(await screen.findByText('That file is not valid JSON.')).toBeTruthy();
    expect(server.bridge.calls('prompts:create')).toHaveLength(0);
  });

  it('says when the library could not be read', async () => {
    await open('prompts', makeView(), { 'prompts:list': () => fail('read_failed', 'disk gone') });
    expect(await screen.findByText('The prompt library could not be read: disk gone')).toBeTruthy();
  });
});

describe('Fast tier', () => {
  it('asks for a model when none is bound, and defers to the profile when one is', async () => {
    await open('fast');
    expect(within(card('Fast tier')).getByLabelText('Model')).toBeTruthy();
    cleanup();
    removeBridge();
    const bound = makeView({
      modelProfiles: { version: 1, entries: [{ id: 'p1', name: 'Cheap', provider: 'openai', model: 'mini', baseUrl: null, contextWindow: null, key: { present: true, tail: '1', source: 'file' } }], mainId: 'p1', fastId: 'p1', kits: [] },
    });
    await open('fast', bound);
    expect(await screen.findByText(/comes from the profile "Cheap"/)).toBeTruthy();
    expect(within(card('Fast tier')).queryByLabelText('Model')).toBeNull();
  });
});

describe('Governance page', () => {
  it('opens the governance panel in the inspector and leaves settings', async () => {
    const user = await open('governance');
    await user.click(screen.getByRole('button', { name: 'Open the governance panel' }));
    expect(useUi.getState()).toMatchObject({ view: 'session', inspectorTab: 'governance', inspectorOpen: true });
  });
});

describe('Diagnostics, Updates and About', () => {
  it('exports diagnostics and shows where they went, or that it was cancelled, or why it failed', async () => {
    const user = await open('diagnostics', makeView(), {
      'app:info': () => ok({ versions: { desktop: '1', cli: '2', core: '3', tui: '4', electron: '5', node: '6' }, platform: 'win32', homeRoot: 'C:/home/.aragon-agent', overridden: false, engineError: null, isPackaged: true }),
      'diagnostics:export': () => ok({ savedTo: 'C:/Users/me/diag.zip' }),
    });
    expect(await screen.findByText('C:/home/.aragon-agent')).toBeTruthy();
    expect(screen.getByText('/home/.aragon-agent/config.json', { exact: false })).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Export diagnostics' }));
    expect(await screen.findByText('Saved to C:/Users/me/diag.zip')).toBeTruthy();
    server.bridge.set('diagnostics:export', () => ok({ savedTo: null }));
    await user.click(screen.getByRole('button', { name: 'Export diagnostics' }));
    expect(await screen.findByText('Export cancelled.')).toBeTruthy();
    server.bridge.set('diagnostics:export', () => fail('internal', 'zip failed'));
    await user.click(screen.getByRole('button', { name: 'Export diagnostics' }));
    expect(await screen.findByText('The export failed: zip failed')).toBeTruthy();
  });

  it('is honest that this build has no update feed, in the words the service gave', async () => {
    await open('updates', makeView(), {
      'update:check': () => ok({ state: 'unsupported' as const, message: 'This build has no update feed configured.' }),
    });
    expect(await screen.findByText('This build has no update feed configured.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Open download page' })).toBeNull();
  });

  it('follows the update status broadcasts and offers the download page when a version appears', async () => {
    await open('updates', makeView(), { 'update:check': () => ok({ state: 'uptodate' as const, checkedAt: 1 }) });
    const stop = watchUpdates(); // after the bridge exists: the App wires this once at startup
    try {
      expect(await screen.findByText('You are up to date.')).toBeTruthy();
      act(() => { server.bridge.emit('update:status', { state: 'available', version: '2.0.0', downloadUrl: 'https://d.example.com/x' }); });
      expect(await screen.findByText('Version 2.0.0 is available.')).toBeTruthy();
      expect(screen.getByRole('button', { name: 'Open download page' })).toBeTruthy();
    } finally {
      stop();
    }
  });

  it('shows the four versions', async () => {
    await open('about', makeView(), {
      'app:info': () => ok({ versions: { desktop: '1.0.1', cli: '2.0.2', core: '3.0.3', tui: '4.0.4', electron: '45', node: '22' }, platform: 'win32', homeRoot: '/h', overridden: false, engineError: null, isPackaged: true }),
    });
    for (const version of ['1.0.1', '2.0.2', '3.0.3', '4.0.4']) expect(await screen.findByText(version)).toBeTruthy();
  });
});

describe('Shortcuts page', () => {
  it('is a read-only table of desktop shortcuts and terminal-key equivalents', async () => {
    await open('shortcuts');
    expect(screen.getByRole('region', { name: 'In this app' })).toBeTruthy();
    expect(screen.getByRole('region', { name: 'Terminal keys' })).toBeTruthy();
    expect(screen.queryByRole('textbox')).toBeNull();
  });
});

describe('navigation', () => {
  it('opens every page from the left navigation and marks the current one', async () => {
    const user = await open('general');
    const nav = screen.getByRole('navigation', { name: 'Settings sections' });
    const names = within(nav).getAllByRole('button').map((button) => button.textContent);
    expect(names).toContain('Models');
    await user.click(within(nav).getByRole('button', { name: 'Skills' }));
    expect(useUi.getState().settingsPage).toBe('skills');
    expect(within(nav).getByRole('button', { name: 'Skills' }).getAttribute('aria-current')).toBe('page');
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Skills');
    await user.click(within(nav).getByRole('button', { name: 'Back to sessions' }));
    expect(useUi.getState().view).toBe('session');
  });
});
