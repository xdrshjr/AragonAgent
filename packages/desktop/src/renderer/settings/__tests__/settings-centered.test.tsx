import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useDrafts } from '../../lib/settings-drafts.js';
import { setLanguage } from '../../i18n/index.js';
import { usePrompts } from '../../prompts/prompts-store.js';
import { useUi, type SettingsPage } from '../../store/ui-store.js';
import { useUpdates } from '../../store/update-store.js';
import { PAGES, SettingsShell } from '../SettingsShell.js';
import { makeView, startConfigServer } from './config-server.js';
import { removeBridge } from './test-bridge.js';

beforeEach(() => {
  setLanguage('en');
  usePrompts.setState({ prompts: [], loaded: false, error: null });
  useUpdates.setState({ status: null });
});
afterEach(() => { cleanup(); removeBridge(); useDrafts.getState().discardAll(); });

async function open(page: SettingsPage): Promise<void> {
  await startConfigServer(makeView(), {});
  useUi.setState({ view: 'settings', settingsPage: page, activeSessionId: null });
  render(<SettingsShell />);
  await screen.findByRole('heading', { level: 1 });
}

const cols = (selector: string): HTMLElement[] => [...document.querySelectorAll<HTMLElement>(`${selector} .settings-col`)];

describe('settings column (AC-102)', () => {
  it('declares which pages are wide: exactly models and prompts', () => {
    expect(PAGES.filter((page) => page.wide).map((page) => page.id)).toEqual(['models', 'prompts']);
  });

  for (const page of ['general', 'models', 'prompts'] as const) {
    it(`${page}: the title, the page and the footer all sit in a .settings-col, and only wide pages say so`, async () => {
      await open(page);
      const wide = PAGES.find((entry) => entry.id === page)!.wide === true;
      for (const band of ['.settings-head', '.settings-scroll', '.set-footer']) {
        const found = cols(band);
        expect(found, band).toHaveLength(1);
        expect(found[0]!.hasAttribute('data-wide'), `${band} data-wide`).toBe(wide);
      }
    });
  }

  it('the page content lives inside the column, not beside it', async () => {
    await open('general');
    const column = document.querySelector('.settings-scroll .settings-col')!;
    expect(column.querySelector('.set-page')).not.toBeNull();
    expect(document.querySelector('.settings-scroll > .set-page')).toBeNull();
  });

  it('the nav stays outside the column (the column centres in the pane to its right)', async () => {
    await open('general');
    expect(document.querySelector('.settings-nav .settings-col')).toBeNull();
    expect(document.querySelector('.settings-main')!.contains(document.querySelector('.settings-col'))).toBe(true);
  });
});
