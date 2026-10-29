/**
 * Pieces every inspector panel shares: an honest empty state, a titled block, and `usePanelCommand`,
 * which runs a host command and turns a refusal into visible, actionable text. A panel button
 * that fails must never look like it did nothing.
 */

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useT } from '../i18n/index.js';
import { commandFailureText } from '../lib/panels-format.js';
import type { CommandResult, HostCommand } from '../../shared/port-protocol.js';
import { sessionStore } from '../store/session-store.js';
import './panels.css';

export function PanelEmpty(props: { title: string; body: string; children?: ReactNode }) {
  return (
    <div className="panel-empty">
      <p className="panel-empty-title">{props.title}</p>
      <p>{props.body}</p>
      {props.children}
    </div>
  );
}

export function PanelBlock(props: { title: string; aside?: ReactNode; children: ReactNode }) {
  return (
    <section className="panel-block">
      <header className="panel-block-head">
        <h3>{props.title}</h3>
        {props.aside ? <span className="panel-aside">{props.aside}</span> : null}
      </header>
      {props.children}
    </section>
  );
}

export interface PanelCommand {
  busy: boolean;
  error: string | null;
  run(cmd: HostCommand): Promise<CommandResult>;
  clearError(): void;
}

export function usePanelCommand(sessionId: string): PanelCommand {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);
  useEffect(() => () => { mounted.current = false; }, []);

  const run = useCallback(async (cmd: HostCommand): Promise<CommandResult> => {
    setBusy(true);
    setError(null);
    const result = await sessionStore.command(sessionId, cmd);
    if (mounted.current) {
      setBusy(false);
      if (!result.ok) setError(commandFailureText(t, result));
    }
    return result;
  }, [sessionId, t]);

  return { busy, error, run, clearError: () => setError(null) };
}

export function PanelError({ message }: { message: string | null }) {
  return message ? <p className="panel-error" role="alert">{message}</p> : null;
}
