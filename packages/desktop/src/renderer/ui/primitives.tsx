/**
 * The base components. Thin by design: each is a styled element with the accessibility
 * behaviour already right (visible focus from `base.css`, real `<button>`s, `aria-*` where a
 * state exists), so feature code composes them instead of re-deciding any of it.
 */

import clsx from 'clsx';
import { AlertTriangle } from 'lucide-react';
import {
  Component,
  forwardRef,
  type ButtonHTMLAttributes,
  type ErrorInfo,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react';
import * as SwitchPrimitive from '@radix-ui/react-switch';
import './ui.css';

export const cn = clsx;

type ButtonVariant = 'default' | 'primary' | 'ghost' | 'danger';
type Size = 'sm' | 'md' | 'lg';

export const Button = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant; size?: Size;
}>(function Button({ variant = 'default', size = 'md', className, type = 'button', ...props }, ref) {
  return <button ref={ref} type={type} className={cn('btn', className)} data-variant={variant} data-size={size} {...props} />;
});

/** An icon-only button MUST carry a label: the glyph alone is not an accessible name. */
export const IconButton = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement> & {
  label: string; size?: 'sm' | 'md'; active?: boolean;
}>(function IconButton({ label, size = 'md', active, className, type = 'button', children, ...props }, ref) {
  return (
    <button ref={ref} type={type} className={cn('icon-btn', className)} aria-label={label} title={label}
      data-size={size} data-active={active ? 'true' : undefined} aria-pressed={active} {...props}>
      {children}
    </button>
  );
});

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  function Input({ className, ...props }, ref) {
    return <input ref={ref} className={cn('field', className)} {...props} />;
  },
);

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(
  function Textarea({ className, ...props }, ref) {
    return <textarea ref={ref} className={cn('field', className)} {...props} />;
  },
);

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(
  function Select({ className, ...props }, ref) {
    return <select ref={ref} className={cn('field', className)} {...props} />;
  },
);

export function Switch(props: {
  checked: boolean; onCheckedChange(checked: boolean): void; label: string; disabled?: boolean; id?: string;
}) {
  return (
    <SwitchPrimitive.Root className="switch" checked={props.checked} onCheckedChange={props.onCheckedChange}
      aria-label={props.label} disabled={props.disabled} id={props.id}>
      <SwitchPrimitive.Thumb className="switch-thumb" />
    </SwitchPrimitive.Root>
  );
}

export function Badge({ tone, children, className }: {
  tone?: 'brand' | 'warning' | 'danger' | 'info'; children: ReactNode; className?: string;
}) {
  return <span className={cn('badge', className)} data-tone={tone}>{children}</span>;
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="kbd">{children}</kbd>;
}

export function Skeleton({ width, height = 12, className }: { width?: number | string; height?: number | string; className?: string }) {
  return <div className={cn('skeleton', className)} style={{ width: width ?? '100%', height }} aria-hidden="true" />;
}

export function Spinner({ label }: { label?: string }) {
  return <span className="spinner" role="status" aria-label={label ?? 'Loading'} />;
}

export type DotKind = 'running' | 'ready' | 'parked' | 'waiting' | 'error' | 'locked' | 'idle';

/** A status dot. `label` is the accessible name: colour/shape is never the only carrier. */
export function StatusDot({ kind, label }: { kind: DotKind; label: string }) {
  return <span className="dot" data-kind={kind} role="img" aria-label={label} title={label} />;
}

/**
 * Contains a crash to one region: the panel shows "this area failed - retry - copy details"
 * instead of the whole window going blank.
 */
export class ErrorBoundary extends Component<
  { children: ReactNode; title: string; retryLabel: string; copyLabel: string; onError?: (error: Error, info: ErrorInfo) => void },
  { error: Error | null }
> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error): { error: Error } {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    this.props.onError?.(error, info);
  }

  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="error-panel" role="alert" style={{ margin: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontWeight: 600 }}>
          <AlertTriangle size={16} aria-hidden="true" /> {this.props.title}
        </div>
        <pre className="selectable" style={{ whiteSpace: 'pre-wrap', margin: '8px 0', color: 'var(--fg-light)', font: '12px var(--font-mono)' }}>
          {error.message}
        </pre>
        <div style={{ display: 'flex', gap: 8 }}>
          <Button size="sm" onClick={() => this.setState({ error: null })}>{this.props.retryLabel}</Button>
          <Button size="sm" variant="ghost" onClick={() => void navigator.clipboard?.writeText(`${error.message}\n${error.stack ?? ''}`)}>
            {this.props.copyLabel}
          </Button>
        </div>
      </div>
    );
  }
}
