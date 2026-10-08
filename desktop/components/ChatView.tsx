'use client';

/**
 * The main column: header (title, cwd, profile, usage), the transcript, and
 * the composer. Also owns the empty/welcome state for a fresh session.
 */

import { useState } from 'react';
import { useStore } from '@lib/store';
import { bridge } from '@lib/ipc';
import { formatCost, formatTokens, isRunning, shortenDir } from '@lib/format';
import { AragonArtLogo } from './Logo';
import Transcript from './Transcript';
import Composer from './Composer';
import { ChevronIcon, CopyIcon, ExternalIcon, FolderIcon, RefreshIcon, SparkIcon } from './Icons';

export default function ChatView() {
  const activeId = useStore((state) => state.activeId);
  const view = useStore((state) => (state.activeId ? state.views[state.activeId] : undefined));
  const rev = useStore((state) => (state.activeId ? state.views[state.activeId]?.rev ?? 0 : 0));
  const settings = useStore((state) => state.settings);
  const changeActiveCwd = useStore((state) => state.changeActiveCwd);
  const setSettingsOpen = useStore((state) => state.setSettingsOpen);
  const newSession = useStore((state) => state.newSession);
  const setActiveProfile = useStore((state) => state.setActiveProfile);
  const clearContextActive = useStore((state) => state.clearContextActive);
  const [profileMenu, setProfileMenu] = useState(false);
  const [cwdMenu, setCwdMenu] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);

  void rev; // subscription dependency: fold mutates in place

  if (!view) {
    return (
      <main style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--bg)' }}>
        <Welcome onNewChat={() => void newSession()} onSettings={() => setSettingsOpen(true)} />
      </main>
    );
  }

  const profile = settings?.profiles.find((entry) => entry.id === view.meta.profileId);
  const hasAnyKey = settings?.profiles.some((entry) => entry.hasKey) ?? false;
  const usage = view.fold.usage;

  return (
    <main
      style={{
        display: 'flex',
        flexDirection: 'column',
        minHeight: 0,
        background: 'var(--bg)',
        position: 'relative',
      }}
    >
      <header
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          padding: '12px 20px',
          borderBottom: '1px solid var(--line)',
          // Solid background + an explicit stacking level: a backdrop-filter
          // here would create a stacking context that traps the profile
          // dropdown's z-index under the transcript AND turn the dropdown's
          // fixed click-catcher into a header-sized containing block.
          background: 'var(--bg)',
          position: 'relative',
          zIndex: 20,
        }}
      >
        <div
          style={{
            fontFamily: 'var(--font-display)',
            fontSize: 16.5,
            fontWeight: 600,
            letterSpacing: '-0.01em',
            flex: 1,
            minWidth: 0,
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
        >
          {view.meta.title}
        </div>

        <div style={{ position: 'relative' }}>
          <button
            className="chip"
            title={view.meta.cwd}
            onClick={() => {
              setCwdMenu((open) => !open);
              setProfileMenu(false);
            }}
          >
            <FolderIcon size={13} />
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {shortenDir(view.meta.cwd)}
            </span>
            <ChevronIcon size={12} />
          </button>
          {cwdMenu ? (
            <>
              <div
                style={{ position: 'fixed', inset: 0, zIndex: 40 }}
                onClick={() => setCwdMenu(false)}
              />
              <div
                style={{
                  position: 'absolute',
                  top: 'calc(100% + 6px)',
                  left: 0,
                  zIndex: 41,
                  background: 'var(--surface-raised)',
                  border: '1px solid var(--line)',
                  borderRadius: 'var(--radius-md)',
                  boxShadow: 'var(--shadow-2)',
                  padding: 5,
                  minWidth: 260,
                  maxWidth: 380,
                }}
              >
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    padding: '7px 9px',
                    fontFamily: 'var(--font-mono)',
                    fontSize: 11.5,
                    color: 'var(--ink-2)',
                    wordBreak: 'break-all',
                  }}
                >
                  <span style={{ flex: 1 }}>{view.meta.cwd}</span>
                  <button
                    className="btn btn-ghost"
                    style={{ padding: 3, color: 'var(--ink-3)' }}
                    title="Copy path"
                    onClick={() => {
                      void navigator.clipboard.writeText(view.meta.cwd);
                      setCwdMenu(false);
                    }}
                  >
                    <CopyIcon size={13} />
                  </button>
                </div>
                <div style={{ height: 1, background: 'var(--line)', margin: '5px 4px' }} />
                <button
                  className="btn btn-ghost"
                  style={{ width: '100%', justifyContent: 'flex-start', padding: '7px 10px', fontSize: 13 }}
                  onClick={async () => {
                    setCwdMenu(false);
                    const dir = await bridge().dialogs.pickDirectory();
                    if (dir) await changeActiveCwd(dir);
                  }}
                >
                  <FolderIcon size={14} /> Change folder...
                </button>
                <button
                  className="btn btn-ghost"
                  style={{ width: '100%', justifyContent: 'flex-start', padding: '7px 10px', fontSize: 13 }}
                  onClick={async () => {
                    setCwdMenu(false);
                    const error = await bridge().shell.openPath(view.meta.cwd);
                    if (error) console.error('[cwd] open failed:', error);
                  }}
                >
                  <ExternalIcon size={14} /> Open in file manager
                </button>
              </div>
            </>
          ) : null}
        </div>

        <div style={{ position: 'relative' }}>
          <button className="chip" onClick={() => {
            setProfileMenu((open) => !open);
            setCwdMenu(false);
          }}>
              <SparkIcon size={13} style={{ color: 'var(--accent)' }} />
            {profile ? `${profile.label} - ${profile.model}` : 'no profile'}
            <ChevronIcon size={12} />
          </button>
          {profileMenu ? (
            <>
              <div style={{ position: 'fixed', inset: 0, zIndex: 40 }} onClick={() => setProfileMenu(false)} />
              <div
                style={{
                  position: 'absolute',
                  top: 'calc(100% + 6px)',
                  right: 0,
                  zIndex: 41,
                  background: 'var(--surface-raised)',
                  border: '1px solid var(--line)',
                  borderRadius: 'var(--radius-md)',
                  boxShadow: 'var(--shadow-2)',
                  padding: 5,
                  minWidth: 230,
                }}
              >
                {(settings?.profiles ?? []).map((entry) => (
                  <button
                    key={entry.id}
                    className="btn btn-ghost"
                    style={{
                      width: '100%',
                      justifyContent: 'flex-start',
                      padding: '7px 10px',
                      fontSize: 13,
                      background: entry.id === view.meta.profileId ? 'var(--surface-sunken)' : undefined,
                      borderRadius: 'var(--radius-sm)',
                    }}
                    onClick={() => {
                      setProfileMenu(false);
                      void setActiveProfile(entry.id);
                    }}
                  >
                    <span style={{ fontWeight: 600 }}>{entry.label}</span>
                    <span style={{ color: 'var(--ink-3)', fontSize: 12 }}>{entry.model}</span>
                  </button>
                ))}
                <div style={{ height: 1, background: 'var(--line)', margin: '5px 4px' }} />
                <button
                  className="btn btn-ghost"
                  style={{ width: '100%', justifyContent: 'flex-start', padding: '7px 10px', fontSize: 13 }}
                  onClick={() => {
                    setProfileMenu(false);
                    setSettingsOpen(true);
                  }}
                >
                  Manage profiles...
                </button>
              </div>
            </>
          ) : null}
        </div>

        {confirmClear ? (
          <button
            className="chip"
            style={{ color: 'var(--danger)', borderColor: 'var(--danger)' }}
            title="Confirm: discard the current context window"
            onClick={() => {
              setConfirmClear(false);
              void clearContextActive();
            }}
          >
            Clear context?
          </button>
        ) : (
          <button
            className="chip"
            title="Clear context: the model starts a fresh window; chat history stays visible"
            onClick={() => {
              setConfirmClear(true);
              setTimeout(() => setConfirmClear((current) => (current ? false : current)), 2600);
            }}
          >
            <RefreshIcon size={13} /> Clear
          </button>
        )}

        <span
          className="chip"
          style={{ cursor: 'default', fontSize: 11.5 }}
          title="Session token usage and cost"
        >
          {formatTokens(usage.totalTokens)} tok
          {formatCost(usage.costAmount, usage.costKnown) ? ` - ${formatCost(usage.costAmount, usage.costKnown)}` : ''}
        </span>
      </header>

      {!hasAnyKey ? (
        <div
          style={{
            margin: '12px 20px 0',
            padding: '10px 14px',
            borderRadius: 'var(--radius-md)',
            background: 'var(--warn-soft)',
            border: '1px solid #e5d5b3',
            fontSize: 13,
            color: '#6b5320',
            display: 'flex',
            alignItems: 'center',
            gap: 10,
          }}
        >
          <span style={{ flex: 1 }}>
            No API key stored yet - set one up before your first message.
          </span>
          <button
            className="btn btn-secondary"
            style={{ padding: '5px 12px', fontSize: 12.5 }}
            onClick={() => setSettingsOpen(true)}
          >
            Open settings
          </button>
        </div>
      ) : null}

      <Transcript view={view} />

      <Composer
        disabled={false}
        running={isRunning(view.phase)}
        draft={view.draft}
        onDraft={(text) => useStore.getState().setDraft(view.meta.id, text)}
        onSend={(text) => void useStore.getState().sendActive(text)}
        onInterrupt={() => void useStore.getState().interruptActive()}
        fatal={view.fatal}
        phase={view.phase}
      />
    </main>
  );
}

function Welcome({ onNewChat, onSettings }: { onNewChat: () => void; onSettings: () => void }) {
  const sessions = useStore((state) => state.sessions);
  return (
    <div style={{ textAlign: 'center', maxWidth: 520, padding: '0 24px' }}>
      <div style={{ marginBottom: 26 }}>
        <AragonArtLogo scale={1.15} />
      </div>
      <div
        style={{
          fontFamily: 'var(--font-display)',
          fontSize: 30,
          fontWeight: 600,
          letterSpacing: '-0.02em',
          marginBottom: 10,
        }}
      >
        What should we work on?
      </div>
      <div style={{ color: 'var(--ink-2)', marginBottom: 26, fontSize: 14.5 }}>
        A coding agent with real tools - files, shell, search - running right here on your machine.
      </div>
      <div style={{ display: 'flex', gap: 10, justifyContent: 'center' }}>
        <button className="btn btn-primary" style={{ padding: '9px 18px' }} onClick={onNewChat}>
          Start a chat
        </button>
        <button className="btn btn-secondary" style={{ padding: '9px 18px' }} onClick={onSettings}>
          Configure model
        </button>
      </div>
      {sessions.length === 0 ? null : (
        <div style={{ marginTop: 18, fontSize: 12.5, color: 'var(--ink-3)' }}>
          or pick a previous conversation from the list
        </div>
      )}
    </div>
  );
}
