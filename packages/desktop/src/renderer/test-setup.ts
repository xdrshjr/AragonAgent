/** jsdom has no matchMedia, ResizeObserver or scrollIntoView; the components under test use all three. */
import { afterEach, vi } from 'vitest';

if (!window.matchMedia) {
  window.matchMedia = ((query: string) => ({
    matches: false, media: query, onchange: null,
    addEventListener: () => undefined, removeEventListener: () => undefined,
    addListener: () => undefined, removeListener: () => undefined, dispatchEvent: () => false,
  })) as typeof window.matchMedia;
}
class NoopObserver { observe(): void {} unobserve(): void {} disconnect(): void {} }
(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver ??= NoopObserver;
Element.prototype.scrollIntoView ??= (() => undefined) as typeof Element.prototype.scrollIntoView;

afterEach(() => { vi.restoreAllMocks(); });
