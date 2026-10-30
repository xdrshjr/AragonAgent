import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearActionToasts, getActionToasts, pushActionToast, resetActionToasts } from '../action-toast-store.js';
import { ToastStack } from '../ToastStack.js';
import { mountSession, unmountSession } from './kit.js';

beforeEach(() => { vi.useFakeTimers(); resetActionToasts(); mountSession(); });
afterEach(() => { cleanup(); unmountSession(); vi.useRealTimers(); resetActionToasts(); });

const push = (onRun = vi.fn(), ttlMs = 8000) =>
  act(() => { pushActionToast('s1', { level: 'info', text: 'Removed a.png', action: { label: 'Undo', onRun }, ttlMs }); });

describe('action toast store', () => {
  it('keeps toasts per session with their own id namespace and a stable snapshot', () => {
    const before = getActionToasts('s1');
    expect(getActionToasts('s1')).toBe(before);
    const id = pushActionToast('s1', { level: 'info', text: 'x', action: { label: 'Undo', onRun: () => undefined } });
    expect(id).toMatch(/^act-\d+$/);
    expect(getActionToasts('s2')).toHaveLength(0);
    clearActionToasts('s1');
    expect(getActionToasts('s1')).toHaveLength(0);
  });
});

describe('ToastStack with an action', () => {
  it('shows the button, runs it once and closes the toast', () => {
    const run = vi.fn();
    render(<ToastStack sessionId="s1" />);
    push(run);
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    expect(run).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('Removed a.png')).toBeNull();
  });

  it('disappears on its own after the time to live', () => {
    render(<ToastStack sessionId="s1" />);
    push();
    act(() => { vi.advanceTimersByTime(7900); });
    expect(screen.queryByText('Removed a.png')).not.toBeNull();
    act(() => { vi.advanceTimersByTime(200); });
    expect(screen.queryByText('Removed a.png')).toBeNull();
  });

  it('stops the clock while hovered and resumes with the time that was LEFT, not a fresh one', () => {
    render(<ToastStack sessionId="s1" />);
    push();
    const row = screen.getByText('Removed a.png').parentElement!;
    act(() => { vi.advanceTimersByTime(5000); });
    fireEvent.mouseEnter(row);
    act(() => { vi.advanceTimersByTime(60_000); });
    expect(screen.queryByText('Removed a.png')).not.toBeNull();
    fireEvent.mouseLeave(row);
    act(() => { vi.advanceTimersByTime(2900); });
    expect(screen.queryByText('Removed a.png')).not.toBeNull();
    act(() => { vi.advanceTimersByTime(200); });
    expect(screen.queryByText('Removed a.png')).toBeNull();
  });

  it('stays while keyboard focus is inside, even after the pointer leaves', () => {
    render(<ToastStack sessionId="s1" />);
    push();
    const row = screen.getByText('Removed a.png').parentElement!;
    const button = screen.getByRole('button', { name: 'Undo' });
    fireEvent.mouseEnter(row);
    fireEvent.focus(button);
    fireEvent.mouseLeave(row);
    act(() => { vi.advanceTimersByTime(60_000); });
    expect(screen.queryByText('Removed a.png')).not.toBeNull();
    fireEvent.blur(button);
    act(() => { vi.advanceTimersByTime(8100); });
    expect(screen.queryByText('Removed a.png')).toBeNull();
  });

  it('renders a plain engine toast beside it with no action button of its own', () => {
    render(<ToastStack sessionId="s1" />);
    push();
    expect(screen.getAllByRole('button', { name: 'Undo' })).toHaveLength(1);
  });
});
