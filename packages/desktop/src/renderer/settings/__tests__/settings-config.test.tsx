import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HARD_MAX_SUBAGENTS } from '@aragon-agent/tui/model/config/schema';
import { useDrafts } from '../../lib/settings-drafts.js';
import { setLanguage } from '../../i18n/index.js';
import { useConfig } from '../../store/config-store.js';
import { useUi, type SettingsPage } from '../../store/ui-store.js';
import { SettingsShell } from '../SettingsShell.js';
import { makeView, startConfigServer, type ConfigServer } from './config-server.js';
import { removeBridge } from './test-bridge.js';

let server: ConfigServer;

async function open(page: SettingsPage, view = makeView()): Promise<void> {
  server = await startConfigServer(view);
  useUi.setState({ view: 'settings', settingsPage: page });
  render(<SettingsShell />);
}

const card = (name: string): HTMLElement => screen.getByRole('region', { name });

beforeEach(() => { setLanguage('en'); });
afterEach(() => { cleanup(); removeBridge(); useDrafts.getState().discardAll(); });

describe('saving a section', () => {
  it('sends only the edited key, against the revision the page was based on', async () => {
    await open('team');
    const user = userEvent.setup();
    const field = within(card('Team')).getByLabelText('Turn limit per sub-agent');
    await user.clear(field);
    await user.type(field, '12');
    expect(within(card('Team')).getByText('Modified')).toBeTruthy();
    await user.click(within(card('Team')).getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(server.patches).toHaveLength(1));
    expect(server.patches[0]).toEqual({ baseRevision: 'r1', patch: { team: { maxTurnsPerSubagent: 12 } } });
    await waitFor(() => expect(within(card('Team')).getByText('Saved.')).toBeTruthy());
    expect(within(card('Team')).queryByText('Modified')).toBeNull();
    expect(useConfig.getState().result?.revision).toBe('r2');
  });

  it('shows the value the file will hold when the engine clamps the input', async () => {
    await open('team');
    const user = userEvent.setup();
    const field = within(card('Team')).getByLabelText('Most sub-agents per dispatch');
    await user.clear(field);
    await user.type(field, '9999');
    expect(within(card('Team')).getAllByText(new RegExp(`Will be saved as ${HARD_MAX_SUBAGENTS}`)).length).toBeGreaterThan(0);
  });

  it('blocks Save and names the problem when the input is not a number', async () => {
    await open('team');
    const user = userEvent.setup();
    const field = within(card('Team')).getByLabelText('Turn limit per sub-agent');
    await user.clear(field);
    await user.type(field, 'lots');
    expect(within(card('Team')).getByRole('alert').textContent).toBe('Enter a whole number.');
    expect((within(card('Team')).getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('reverts the draft', async () => {
    await open('retry');
    const user = userEvent.setup();
    const field = within(card('Retry')).getByLabelText('Most retries') as HTMLInputElement;
    const original = field.value;
    await user.clear(field);
    await user.type(field, '1');
    await user.click(within(card('Retry')).getByRole('button', { name: 'Revert' }));
    expect((within(card('Retry')).getByLabelText('Most retries') as HTMLInputElement).value).toBe(original);
    expect(server.patches).toHaveLength(0);
  });

  it('keeps a draft when the user visits another page and comes back', async () => {
    await open('team');
    const user = userEvent.setup();
    const field = within(card('Team')).getByLabelText('Turn limit per sub-agent');
    await user.clear(field);
    await user.type(field, '7');
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    await user.click(screen.getByRole('button', { name: 'Team' }));
    expect((within(card('Team')).getByLabelText('Turn limit per sub-agent') as HTMLInputElement).value).toBe('7');
  });
});

describe('dangerous switches', () => {
  it('asks before turning off tool confirmation and writes nothing until confirmed', async () => {
    await open('agent', makeView({ confirmTools: true }));
    const user = userEvent.setup();
    await user.click(within(card('Agent behaviour')).getByRole('switch', { name: 'Ask before running tools' }));
    await user.click(within(card('Agent behaviour')).getByRole('button', { name: 'Save' }));

    const dialog = await screen.findByRole('dialog', { name: 'Turn off a safeguard?' });
    expect(server.patches).toHaveLength(0);
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(server.patches).toHaveLength(0);

    await user.click(within(card('Agent behaviour')).getByRole('button', { name: 'Save' }));
    await user.click(within(await screen.findByRole('dialog', { name: 'Turn off a safeguard?' })).getByRole('button', { name: 'Turn it off' }));
    await waitFor(() => expect(server.patches).toHaveLength(1));
    expect(server.patches[0]!.patch).toEqual({ confirmTools: false });
  });

  it('does not ask when the switch is turned ON', async () => {
    await open('agent');
    const user = userEvent.setup();
    await user.click(within(card('Agent behaviour')).getByRole('switch', { name: 'Ask before running tools' }));
    await user.click(within(card('Agent behaviour')).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(server.patches).toHaveLength(1));
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

describe('two writers', () => {
  async function editAndLoseTheRace(): Promise<ReturnType<typeof userEvent.setup>> {
    await open('general');
    const user = userEvent.setup();
    await user.selectOptions(within(card('Appearance')).getByLabelText('Theme'), 'warm');
    server.writeElsewhere({ hints: false });
    await user.click(within(card('Appearance')).getByRole('button', { name: 'Save' }));
    return user;
  }

  it('surfaces a conflict with three choices and never retries on its own', async () => {
    await editAndLoseTheRace();
    const dialog = await screen.findByRole('dialog', { name: 'The configuration changed elsewhere' });
    expect(within(dialog).getByRole('button', { name: 'Apply my changes on top of the latest' })).toBeTruthy();
    expect(within(dialog).getByRole('button', { name: 'Discard my changes' })).toBeTruthy();
    expect(within(dialog).getByRole('button', { name: 'View differences' })).toBeTruthy();
    expect(server.patches).toHaveLength(1);
    expect(server.view().theme).toBe('auto');
  });

  it('applies my edit on top of the latest file, keeping the other writer’s change', async () => {
    const user = await editAndLoseTheRace();
    const dialog = await screen.findByRole('dialog', { name: 'The configuration changed elsewhere' });
    await user.click(within(dialog).getByRole('button', { name: 'Apply my changes on top of the latest' }));
    await waitFor(() => expect(server.patches).toHaveLength(2));
    expect(server.patches[1]).toEqual({ baseRevision: 'r2', patch: { theme: 'warm' } });
    expect(server.view()).toMatchObject({ theme: 'warm', hints: false });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('discards my edit on request and writes nothing more', async () => {
    const user = await editAndLoseTheRace();
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Discard my changes' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(server.patches).toHaveLength(1);
    expect(server.view().theme).toBe('auto');
    expect((within(card('Appearance')).getByLabelText('Theme') as HTMLSelectElement).value).toBe('auto');
  });

  it('shows my value next to the one on disk', async () => {
    const user = await editAndLoseTheRace();
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'View differences' }));
    const table = await screen.findByRole('table');
    expect(within(table).getByText('theme')).toBeTruthy();
    expect(within(table).getByText('warm')).toBeTruthy();
    expect(within(table).getByText('auto')).toBeTruthy();
  });

  it('warns when the file changes under unsaved edits, and keeps them on request', async () => {
    await open('general');
    const user = userEvent.setup();
    await user.selectOptions(within(card('Appearance')).getByLabelText('Theme'), 'warm');
    server.writeElsewhere({ hints: false });
    await useConfig.getState().refresh();

    const banner = await screen.findByText('The configuration on disk changed.');
    expect(banner).toBeTruthy();
    expect((within(card('Appearance')).getByLabelText('Theme') as HTMLSelectElement).value).toBe('warm');
    await user.click(screen.getByRole('button', { name: 'Keep my edits' }));
    expect(screen.queryByText('The configuration on disk changed.')).toBeNull();
    expect((within(card('Appearance')).getByLabelText('Theme') as HTMLSelectElement).value).toBe('warm');

    await user.click(within(card('Appearance')).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(server.patches).toHaveLength(1));
    expect(server.patches[0]).toEqual({ baseRevision: 'r2', patch: { theme: 'warm' } });
  });

  it('drops the draft when the user chooses to reload', async () => {
    await open('general');
    const user = userEvent.setup();
    await user.selectOptions(within(card('Appearance')).getByLabelText('Theme'), 'warm');
    server.writeElsewhere({ theme: 'light' });
    await useConfig.getState().refresh();
    await user.click(await screen.findByRole('button', { name: 'Reload (discard my edits)' }));
    expect((within(card('Appearance')).getByLabelText('Theme') as HTMLSelectElement).value).toBe('light');
    expect(screen.queryByText('The configuration on disk changed.')).toBeNull();
  });

  it('refreshes silently when there is no draft', async () => {
    await open('general');
    server.writeElsewhere({ theme: 'light' });
    await useConfig.getState().refresh();
    await waitFor(() => expect((within(card('Appearance')).getByLabelText('Theme') as HTMLSelectElement).value).toBe('light'));
    expect(screen.queryByText('The configuration on disk changed.')).toBeNull();
  });
});

describe('page footer', () => {
  it('says running terminals need /reload and counts the settings it keeps untouched', async () => {
    await open('retry');
    expect(screen.getByText('Running terminals pick this up after /reload.')).toBeTruthy();
    expect(screen.getByText('2 terminal-only settings are kept untouched.')).toBeTruthy();
  });

  it('never writes a desktop-only preference into config.json', async () => {
    await open('general', makeView());
    server.bridge.set('desktop-state:get', () => ({ ok: true, value: { language: 'auto', enterToSend: true, maxLiveHosts: 6, parkAfterIdleMinutes: 15 } as never }));
    server.bridge.set('desktop-state:patch', (arg: never) => ({ ok: true, value: { language: 'auto', enterToSend: true, maxLiveHosts: 6, parkAfterIdleMinutes: 15, ...(arg as object) } as never }));
    cleanup();
    render(<SettingsShell />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('switch', { name: 'Enter sends the message' }));
    await waitFor(() => expect(server.bridge.calls('desktop-state:patch')).toEqual([{ enterToSend: false }]));
    expect(server.patches).toHaveLength(0);
  });
});
