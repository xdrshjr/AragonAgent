'use client';

/**
 * The root shell: boots the store, subscribes to IPC, and lays out the
 * sidebar + chat columns with the settings overlay above everything.
 */

import { useEffect } from 'react';
import { useStore } from '@lib/store';
import Sidebar from './Sidebar';
import ChatView from './ChatView';
import SettingsOverlay from './SettingsOverlay';

export default function AppShell() {
  const init = useStore((state) => state.init);
  const bridgeOk = useStore((state) => state.bridgeOk);
  const settingsOpen = useStore((state) => state.settingsOpen);

  useEffect(() => {
    void init();
  }, [init]);

  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: '274px 1fr',
        height: '100vh',
        overflow: 'hidden',
      }}
    >
      <Sidebar />
      <ChatView />
      {settingsOpen ? <SettingsOverlay /> : null}
      {!bridgeOk ? <NoBridgeHint /> : null}
    </div>
  );
}

function NoBridgeHint() {
  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(240,238,230,0.92)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 100,
      }}
    >
      <div
        className="card"
        style={{
          background: 'var(--surface)',
          border: '1px solid var(--line)',
          borderRadius: 'var(--radius-lg)',
          boxShadow: 'var(--shadow-2)',
          padding: '28px 32px',
          maxWidth: 420,
          textAlign: 'center',
        }}
      >
        <div style={{ fontFamily: 'var(--font-display)', fontSize: 18, marginBottom: 8 }}>
          Open this app through Electron
        </div>
        <div style={{ color: 'var(--ink-2)', fontSize: 13.5 }}>
          The desktop bridge is unavailable in a plain browser tab. Run{' '}
          <code style={{ fontFamily: 'var(--font-mono)', fontSize: 12.5 }}>npm run dev</code> in{' '}
          <code style={{ fontFamily: 'var(--font-mono)', fontSize: 12.5 }}>desktop/</code> to launch
          the app shell.
        </div>
      </div>
    </div>
  );
}
