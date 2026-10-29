import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setLanguage } from '../../i18n/index.js';
import { makeView, startConfigServer, type ConfigServer } from '../../settings/__tests__/config-server.js';
import { ok, removeBridge } from '../../settings/__tests__/test-bridge.js';
import { useUi } from '../../store/ui-store.js';
import { Dialog } from '../../ui/overlay.js';
import { extractVariables, fillVariables } from '../prompt-vars.js';
import { exportPrompts, parsePromptImport } from '../prompt-io.js';
import { PromptPicker, orderForPicker } from '../PromptPicker.js';
import { usePrompts } from '../prompts-store.js';

const PROMPTS = [
  { id: 'a', title: 'Explain this repo', content: 'Explain the structure of this repository.', useCount: 0, updatedAt: 1 },
  { id: 'b', title: 'Find the bug', content: 'Find the bug in the failing test.', description: 'Debugging helper', useCount: 3, updatedAt: 2, favorite: true },
  { id: 'c', title: 'Review a file', content: 'Review {{file}} with a focus on {{focus}}.', tags: ['review'], useCount: 0, updatedAt: 3 },
];

let server: ConfigServer;

async function open(extra: Parameters<typeof startConfigServer>[1] = {}, view = makeView()): Promise<ReturnType<typeof userEvent.setup>> {
  server = await startConfigServer(view, { 'prompts:list': () => ok(PROMPTS), 'prompts:use': () => ok({ ok: true as const }), ...extra });
  render(<PromptPicker />);
  act(() => { useUi.getState().setPromptPickerOpen(true); });
  return userEvent.setup({ delay: null });
}

const searchBox = (): HTMLElement => screen.getByRole('combobox', { name: 'Search prompts' });
const titles = (): Array<string | undefined> =>
  within(screen.getByRole('listbox')).getAllByRole('option').map((option) => option.querySelector('.pp-item-title')?.textContent?.replace('fill-in', ''));

beforeEach(() => {
  setLanguage('en');
  usePrompts.setState({ prompts: [], loaded: false, error: null });
  useUi.setState({ promptPickerOpen: false, composerInsert: null });
});
afterEach(() => { cleanup(); removeBridge(); });

describe('picker order and search', () => {
  it('puts favourites first when nothing is typed', async () => {
    await open();
    await screen.findByRole('listbox');
    expect(titles()).toEqual(['Find the bug', 'Explain this repo', 'Review a file']);
  });

  it('narrows with the engine’s fuzzy search', async () => {
    const user = await open();
    await screen.findByRole('listbox');
    await user.type(searchBox(), 'bug');
    expect(titles()).toEqual(['Find the bug']);
    await user.clear(searchBox());
    await user.type(searchBox(), 'zzzz');
    expect(screen.getByText('No prompt matches "zzzz".')).toBeTruthy();
  });

  it('keeps a favourite ahead of a better match', () => {
    const order = orderForPicker(PROMPTS, 'e').map((prompt) => prompt.id);
    expect(order[0]).toBe('b');
  });
});

describe('choosing a prompt', () => {
  it('moves with the arrow keys and inserts the active prompt on Enter', async () => {
    const user = await open();
    await screen.findByRole('listbox');
    await user.keyboard('{ArrowDown}');
    expect(within(screen.getByRole('listbox')).getAllByRole('option')[1]!.getAttribute('aria-selected')).toBe('true');
    await user.keyboard('{Enter}');

    expect(useUi.getState().composerInsert?.text).toBe('Explain the structure of this repository.');
    expect(useUi.getState().promptPickerOpen).toBe(false);
    await waitFor(() => expect(server.bridge.calls('prompts:use')).toEqual([{ id: 'a' }]));
  });

  it('inserts a clicked prompt and counts the use', async () => {
    const user = await open();
    await user.click(await screen.findByRole('option', { name: /Find the bug/ }));
    expect(useUi.getState().composerInsert?.text).toBe('Find the bug in the failing test.');
    expect(server.bridge.calls('prompts:use')).toEqual([{ id: 'b' }]);
  });

  it('never treats the Enter that confirms an IME candidate as a choice', async () => {
    await open();
    await screen.findByRole('listbox');
    fireEvent.keyDown(searchBox(), { key: 'Enter', isComposing: true, keyCode: 229 });
    expect(useUi.getState().composerInsert).toBeNull();
    expect(useUi.getState().promptPickerOpen).toBe(true);
  });

  it('asks for the values of a template, previews the result and inserts it filled in', async () => {
    const user = await open();
    await user.click(await screen.findByRole('option', { name: /Review a file/ }));
    expect(useUi.getState().composerInsert).toBeNull();

    await user.type(screen.getByLabelText('file'), 'src/app.ts');
    await user.type(screen.getByLabelText('focus'), 'error handling');
    await user.click(screen.getByText('Preview'));
    expect(screen.getByText('Review src/app.ts with a focus on error handling.', { selector: 'pre' })).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Insert' }));

    expect(useUi.getState().composerInsert?.text).toBe('Review src/app.ts with a focus on error handling.');
    expect(useUi.getState().promptPickerOpen).toBe(false);
    expect(server.bridge.calls('prompts:use')).toEqual([{ id: 'c' }]);
  });

  it('goes back from the form to the list without inserting', async () => {
    const user = await open();
    await user.click(await screen.findByRole('option', { name: /Review a file/ }));
    await user.click(screen.getByRole('button', { name: 'Back' }));
    expect(await screen.findByRole('listbox')).toBeTruthy();
    expect(useUi.getState().composerInsert).toBeNull();
  });

  it('says the library is off when settings turn it off', async () => {
    await open({}, makeView({ prompts: { enabled: false, insertMode: 'insert' } }));
    expect(await screen.findByText(/prompt library is switched off/)).toBeTruthy();
    expect(screen.queryByRole('listbox')).toBeNull();
  });
});

describe('Escape', () => {
  it('closes the picker first and reaches nothing underneath', async () => {
    const underneath = vi.fn();
    const bubbling = vi.fn((event: KeyboardEvent) => { if (event.key === 'Escape') underneath(); });
    window.addEventListener('keydown', bubbling);
    server = await startConfigServer(makeView(), { 'prompts:list': () => ok(PROMPTS) });
    const closed = vi.fn();
    render(<><Dialog open onOpenChange={closed} title="Underneath"><button>inside</button></Dialog><PromptPicker /></>);
    act(() => { useUi.getState().setPromptPickerOpen(true); });
    await screen.findByRole('listbox');

    await userEvent.setup({ delay: null }).keyboard('{Escape}');

    expect(useUi.getState().promptPickerOpen).toBe(false);
    expect(underneath).not.toHaveBeenCalled();
    expect(closed).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog', { name: 'Underneath' })).toBeTruthy();
    window.removeEventListener('keydown', bubbling);

    // With the picker gone, Escape belongs to the next layer again.
    await userEvent.setup({ delay: null }).keyboard('{Escape}');
    await waitFor(() => expect(closed).toHaveBeenCalledWith(false));
  });

  it('does not close on the Escape that cancels an IME composition', async () => {
    await open();
    await screen.findByRole('listbox');
    fireEvent.keyDown(searchBox(), { key: 'Escape', isComposing: true, keyCode: 229 });
    expect(useUi.getState().promptPickerOpen).toBe(true);
  });

  it('starts fresh each time it opens', async () => {
    const user = await open();
    await screen.findByRole('listbox');
    await user.type(searchBox(), 'bug');
    await user.keyboard('{Escape}');
    act(() => { useUi.getState().setPromptPickerOpen(true); });
    expect((await screen.findByRole('combobox', { name: 'Search prompts' }) as HTMLInputElement).value).toBe('');
  });
});

describe('template variables', () => {
  it('finds each distinct name once, in order', () => {
    expect(extractVariables('{{b}} then {{ a }} then {{b}}')).toEqual(['b', 'a']);
  });

  it('leaves braces that are not variables alone', () => {
    expect(extractVariables('const x = {{ "json": 1 }};')).toEqual([]);
    expect(fillVariables('const x = {{ "json": 1 }};', {})).toBe('const x = {{ "json": 1 }};');
  });

  it('fills every occurrence and blanks a missing value', () => {
    expect(fillVariables('{{a}} and {{a}} and {{b}}', { a: 'x' })).toBe('x and x and ');
  });
});

describe('import and export', () => {
  it('round-trips the library', () => {
    const parsed = parsePromptImport(exportPrompts(PROMPTS));
    expect(parsed.ok && parsed.drafts.map((draft) => draft.title)).toEqual(['Explain this repo', 'Find the bug', 'Review a file']);
    expect(parsed.ok && parsed.drafts[1]).toMatchObject({ description: 'Debugging helper', favorite: true });
  });

  it('skips what the library would refuse and says how many', () => {
    const parsed = parsePromptImport(JSON.stringify([{ title: 'ok', content: 'fine' }, { title: '', content: 'no title' }, { title: 'x' }, 7]));
    expect(parsed).toEqual({ ok: true, drafts: [{ title: 'ok', content: 'fine' }], skipped: 3 });
  });

  it('refuses a file that is not JSON or holds nothing usable', () => {
    expect(parsePromptImport('not json')).toEqual({ ok: false, reason: 'not_json' });
    expect(parsePromptImport('[]')).toEqual({ ok: false, reason: 'no_prompts' });
    expect(parsePromptImport('{"prompts":[{"nope":1}]}')).toEqual({ ok: false, reason: 'no_prompts' });
  });
});
