/**
 * Dialog, Popover, Tooltip, Tabs: Radix primitives with our skin. Radix supplies what is
 * tedious to get right by hand - the focus trap, returning focus to the trigger on close, Esc,
 * `aria-modal`, portalling - so every overlay behaves the same and none of it is reimplemented.
 */

import * as DialogPrimitive from '@radix-ui/react-dialog';
import * as PopoverPrimitive from '@radix-ui/react-popover';
import * as TabsPrimitive from '@radix-ui/react-tabs';
import * as TooltipPrimitive from '@radix-ui/react-tooltip';
import { useEffect, useRef, type ReactNode } from 'react';
import { cn } from './primitives.js';
import './ui.css';

export function Dialog(props: {
  open: boolean;
  onOpenChange(open: boolean): void;
  title: string;
  description?: string;
  children: ReactNode;
  actions?: ReactNode;
  size?: 'md' | 'lg';
  /** A modal that must be answered (an approval) cannot be dismissed with Esc or a click-out. */
  dismissible?: boolean;
}) {
  const dismissible = props.dismissible !== false;
  return (
    <DialogPrimitive.Root open={props.open} onOpenChange={props.onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="overlay-backdrop" />
        <DialogPrimitive.Content
          className="dialog selectable"
          data-size={props.size}
          onEscapeKeyDown={dismissible ? undefined : (event) => event.preventDefault()}
          onPointerDownOutside={dismissible ? undefined : (event) => event.preventDefault()}
          onInteractOutside={dismissible ? undefined : (event) => event.preventDefault()}
        >
          <DialogPrimitive.Title className="dialog-title">{props.title}</DialogPrimitive.Title>
          {props.description
            ? <DialogPrimitive.Description className="dialog-desc">{props.description}</DialogPrimitive.Description>
            : <DialogPrimitive.Description className="sr-only">{props.title}</DialogPrimitive.Description>}
          {props.children}
          {props.actions ? <div className="dialog-actions">{props.actions}</div> : null}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

export function Popover(props: {
  trigger: ReactNode;
  children: ReactNode;
  open?: boolean;
  onOpenChange?(open: boolean): void;
  align?: 'start' | 'center' | 'end';
  side?: 'top' | 'bottom' | 'left' | 'right';
  className?: string;
}) {
  return (
    <PopoverPrimitive.Root open={props.open} onOpenChange={props.onOpenChange}>
      <PopoverPrimitive.Trigger asChild>{props.trigger}</PopoverPrimitive.Trigger>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content className={cn('popover', 'selectable', props.className)}
          align={props.align ?? 'start'} side={props.side ?? 'top'} sideOffset={6} collisionPadding={8}>
          {props.children}
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}

export function TooltipProvider({ children }: { children: ReactNode }) {
  return <TooltipPrimitive.Provider delayDuration={400} skipDelayDuration={150}>{children}</TooltipPrimitive.Provider>;
}

/** A tooltip may enhance a label but never replace it (touch and keyboard users never see it). */
export function Tooltip({ content, children, side = 'bottom' }: {
  content: ReactNode; children: ReactNode; side?: 'top' | 'bottom' | 'left' | 'right';
}) {
  return (
    <TooltipPrimitive.Root>
      <TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
      <TooltipPrimitive.Portal>
        <TooltipPrimitive.Content className="tooltip" side={side} sideOffset={6}>{content}</TooltipPrimitive.Content>
      </TooltipPrimitive.Portal>
    </TooltipPrimitive.Root>
  );
}

export const Tabs = TabsPrimitive.Root;
const TAB_EDGE_PEEK = 16;

/** Scroll the strip (never an ancestor: `scrollIntoView` bubbles) so the active tab is fully visible. */
export function revealActiveTab(list: HTMLElement): void {
  const active = list.querySelector<HTMLElement>('[data-state="active"]');
  if (!active) return;
  const left = active.offsetLeft;
  const right = left + active.offsetWidth;
  if (left < list.scrollLeft) list.scrollLeft = Math.max(0, left - TAB_EDGE_PEEK);
  else if (right > list.scrollLeft + list.clientWidth) list.scrollLeft = right - list.clientWidth + TAB_EDGE_PEEK;
}

/** Which ends of the strip have more tabs beyond them; drives the fade mask. Absent when everything fits. */
function overflowSide(list: HTMLElement): 'start' | 'end' | 'both' | undefined {
  if (list.scrollWidth <= list.clientWidth + 1) return undefined;
  const atStart = list.scrollLeft <= 1;
  const atEnd = list.scrollLeft + list.clientWidth >= list.scrollWidth - 1;
  if (atStart && atEnd) return undefined;
  if (atStart) return 'end';
  return atEnd ? 'start' : 'both';
}

export function TabsList({ children, label }: { children: ReactNode; label: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const list = ref.current;
    if (!list) return undefined;
    const sync = (): void => {
      const side = overflowSide(list);
      if (side) list.dataset.overflow = side;
      else delete list.dataset.overflow;
    };
    const reveal = (): void => { revealActiveTab(list); sync(); };
    reveal();
    list.addEventListener('scroll', sync, { passive: true });
    const resize = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(reveal);
    resize?.observe(list);
    // Radix flips `data-state` on the triggers when the value changes (including from a shortcut).
    const mutation = new MutationObserver(reveal);
    mutation.observe(list, { attributes: true, attributeFilter: ['data-state'], subtree: true, childList: true });
    return () => { list.removeEventListener('scroll', sync); resize?.disconnect(); mutation.disconnect(); };
  }, []);
  return <TabsPrimitive.List ref={ref} className="tabs-list" aria-label={label}>{children}</TabsPrimitive.List>;
}
export function Tab({ value, children }: { value: string; children: ReactNode }) {
  return <TabsPrimitive.Trigger className="tab" value={value}>{children}</TabsPrimitive.Trigger>;
}
export const TabPanel = TabsPrimitive.Content;
