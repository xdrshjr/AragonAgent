import { act, cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { Tab, Tabs, TabsList, revealActiveTab } from '../overlay.js';

afterEach(cleanup);

function strip(active: string) {
  return (
    <Tabs value={active}>
      <TabsList label="inspector">
        {['changes', 'plan', 'agents', 'jobs', 'context', 'governance'].map((id) => <Tab key={id} value={id}>{id}</Tab>)}
      </TabsList>
    </Tabs>
  );
}

/** jsdom lays nothing out: give the list and its tabs fixed geometry (100px list, 80px tabs). */
function fakeGeometry(list: HTMLElement): void {
  Object.defineProperty(list, 'clientWidth', { value: 100, configurable: true });
  Object.defineProperty(list, 'scrollWidth', { value: 480, configurable: true });
  [...list.querySelectorAll<HTMLElement>('.tab')].forEach((tab, index) => {
    Object.defineProperty(tab, 'offsetLeft', { value: index * 80, configurable: true });
    Object.defineProperty(tab, 'offsetWidth', { value: 80, configurable: true });
  });
}

describe('revealActiveTab', () => {
  it('scrolls the strip itself so a tab beyond the right edge becomes fully visible', () => {
    const { container } = render(strip('governance'));
    const list = container.querySelector<HTMLElement>('.tabs-list')!;
    fakeGeometry(list);
    list.scrollLeft = 0;
    revealActiveTab(list);
    const active = list.querySelector<HTMLElement>('[data-state="active"]')!;
    expect(active.textContent).toBe('governance');
    expect(list.scrollLeft).toBeGreaterThanOrEqual(400 + 80 - 100); // the active tab's right edge is inside the viewport
    expect(list.scrollLeft).toBeLessThanOrEqual(400); // and so is its left edge
  });

  it('scrolls back left for a tab before the left edge, and leaves a visible tab alone', () => {
    const { container } = render(strip('changes'));
    const list = container.querySelector<HTMLElement>('.tabs-list')!;
    fakeGeometry(list);
    list.scrollLeft = 300;
    revealActiveTab(list);
    expect(list.scrollLeft).toBe(0);
    list.scrollLeft = 0;
    revealActiveTab(list);
    expect(list.scrollLeft).toBe(0);
  });

  it('follows a value change made elsewhere (a shortcut), without scrollIntoView', async () => {
    const { container, rerender } = render(strip('changes'));
    const list = container.querySelector<HTMLElement>('.tabs-list')!;
    fakeGeometry(list);
    list.scrollLeft = 0;
    await act(async () => { rerender(strip('governance')); });
    await waitFor(() => expect(list.scrollLeft).toBeGreaterThan(0));
  });

  it('is a no-op with no active tab', () => {
    const list = document.createElement('div');
    list.scrollLeft = 7;
    revealActiveTab(list);
    expect(list.scrollLeft).toBe(7);
  });
});
