import { describe, expect, it, vi } from 'vitest';
import { createPointerRouter } from '../input/pointer-router.js';
import type { MouseEvent } from '../input/mouse-events.js';

describe('pointer ownership', () => {
  it('filters captured buttons but forwards wheels and cleans up subscriptions', () => {
    let deliver: (event: MouseEvent) => void = () => {};
    const unsubscribe = vi.fn();
    const handle = vi.fn((event: MouseEvent) => event.x === 80);
    const router = createPointerRouter({ source: { subscribe: (listener) => {
      deliver = listener; return unsubscribe;
    } }, handle });
    const selection = vi.fn();
    const remove = router.selectionSource.subscribe(selection);
    const base = { x: 80, y: 2, shift: false, alt: false, ctrl: false };
    deliver({ ...base, kind: 'press', button: 0 });
    expect(selection).not.toHaveBeenCalled();
    deliver({ ...base, kind: 'wheel', dir: 'up' });
    expect(selection).toHaveBeenCalledTimes(1);
    deliver({ ...base, x: 2, kind: 'press', button: 0 });
    expect(selection).toHaveBeenCalledTimes(2);
    remove();
    deliver({ ...base, x: 2, kind: 'release', button: 0 });
    expect(selection).toHaveBeenCalledTimes(2);
    router.dispose();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });
});
