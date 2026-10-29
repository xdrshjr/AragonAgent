/**
 * A `role="menu"` list with the keyboard behavior people expect from a native menu: focus lands on
 * the first enabled item, Up/Down/Home/End move (skipping disabled items and wrapping), Enter and
 * Space activate, Esc is left to the surrounding popover (which also returns focus to its trigger).
 * Roving tabindex: only the current item is in the tab order. Hand-rolled because it is ~60 lines and
 * the alternative is a new dependency for one menu.
 */

import { useEffect, useRef, type KeyboardEvent, type ReactNode } from 'react';
import { cn } from './primitives.js';

export interface MenuItemData {
  id: string;
  label: string;
  icon?: ReactNode;
  hint?: ReactNode;
  disabled?: boolean;
  /** Shown as the tooltip and read out for a disabled item. */
  disabledReason?: string;
  separatorBefore?: boolean;
}

/** Index of the next enabled item from `from` in `step` direction, wrapping; -1 when none. */
export function nextEnabled(items: readonly MenuItemData[], from: number, step: 1 | -1): number {
  const count = items.length;
  for (let offset = 1; offset <= count; offset += 1) {
    const index = (((from + step * offset) % count) + count) % count;
    if (!items[index]?.disabled) return index;
  }
  return -1;
}

export function MenuList(props: { items: readonly MenuItemData[]; label: string; onSelect(id: string): void }) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const { items } = props;

  const focusAt = (index: number): void => {
    if (index >= 0) refs.current[index]?.focus();
  };

  useEffect(() => { focusAt(nextEnabled(items, -1, 1)); }, [items]);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const current = refs.current.findIndex((element) => element === document.activeElement);
    switch (event.key) {
      case 'ArrowDown': focusAt(nextEnabled(items, current, 1)); break;
      case 'ArrowUp': focusAt(nextEnabled(items, current < 0 ? 0 : current, -1)); break;
      case 'Home': focusAt(nextEnabled(items, -1, 1)); break;
      case 'End': focusAt(nextEnabled(items, 0, -1)); break;
      default: return;
    }
    event.preventDefault();
  };

  return (
    <div role="menu" aria-label={props.label} className="menu-list" onKeyDown={onKeyDown}>
      {items.map((item, index) => (
        <div key={item.id} role="none">
          {item.separatorBefore ? <div role="separator" className="menu-sep" /> : null}
          <button
            type="button" role="menuitem" ref={(element) => { refs.current[index] = element; }}
            className={cn('menu-item', item.disabled && 'is-disabled')}
            tabIndex={-1} aria-disabled={item.disabled ? true : undefined}
            title={item.disabled ? item.disabledReason : undefined}
            onClick={() => { if (!item.disabled) props.onSelect(item.id); }}>
            {item.icon ? <span className="menu-icon" aria-hidden="true">{item.icon}</span> : null}
            <span className="menu-label">{item.label}</span>
            {item.disabled && item.disabledReason ? <span className="sr-only">{item.disabledReason}</span> : null}
            {item.hint ? <span className="menu-hint">{item.hint}</span> : null}
          </button>
        </div>
      ))}
    </div>
  );
}
