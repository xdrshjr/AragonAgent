'use client';

/** Left rail: brand, new chat, search, the session list, and settings. */

import { useMemo, useState } from 'react';
import { useStore } from '@lib/store';
import { formatRelativeTime, isRunning } from '@lib/format';
import { AragonWordmark } from './Logo';
import {
  PlusIcon,
  SearchIcon,
  SettingsIcon,
  TrashIcon,
} from './Icons';

export default function Sidebar() {
  const sessions = useStore((state) => state.sessions);
  const activeId = useStore((state) => state.activeId);
  const views = useStore((state) => state.views);
  const search = useStore((state) => state.search);
  const setSearch = useStore((state) => state.setSearch);
  const newSession = useStore((state) => state.newSession);
  const openSession = useStore((state) => state.openSession);
  const removeSession = useStore((state) => state.removeSession);
  const setSettingsOpen = useStore((state) => state.setSettingsOpen);
  const appInfo = useStore((state) => state.appInfo);
  const [confirmId, setConfirmId] = useState<string | null>(null);

  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (query.length === 0) return sessions;
    return sessions.filter((session) => session.title.toLowerCase().includes(query));
  }, [sessions, search]);

  return (
    <aside
      style={{
        background: 'var(--bg-sidebar)',
        borderRight: '1px solid var(--line)',
        display: 'flex',
        flexDirection: 'column',
        minHeight: 0,
      }}
    >
      <div style={{ padding: '18px 16px 10px', display: 'flex', alignItems: 'center', gap: 10 }}>
        <div>
          <AragonWordmark size={16} />
          <div style={{ fontSize: 11, color: 'var(--ink-3)', marginTop: 2 }}>
            {appInfo ? `v${appInfo.version}` : 'desktop'}
          </div>
        </div>
      </div>

      <div style={{ padding: '4px 12px 10px' }}>
        <button className="btn btn-primary" style={{ width: '100%', justifyContent: 'center', padding: '9px 14px' }} onClick={() => void newSession()}>
          <PlusIcon size={15} /> New chat
        </button>
      </div>

      <div style={{ padding: '0 12px 8px' }}>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 7,
            background: 'var(--surface)',
            border: '1px solid var(--line)',
            borderRadius: 'var(--radius-sm)',
            padding: '6px 9px',
          }}
        >
          <SearchIcon size={14} style={{ color: 'var(--ink-3)', flexShrink: 0 }} />
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search chats"
            style={{
              border: 'none',
              outline: 'none',
              background: 'transparent',
              width: '100%',
              fontSize: 13,
              color: 'var(--ink)',
            }}
          />
        </div>
      </div>

      <div
        className="session-list"
        style={{ flex: 1, overflowY: 'auto', padding: '4px 8px 8px', minHeight: 0 }}
      >
        {filtered.length === 0 ? (
          <div style={{ padding: '20px 10px', textAlign: 'center', color: 'var(--ink-3)', fontSize: 12.5 }}>
            {sessions.length === 0 ? 'No conversations yet.' : 'Nothing matches.'}
          </div>
        ) : null}
        {filtered.map((session) => {
          const view = views[session.id];
          const running = view ? isRunning(view.phase) : false;
          const active = session.id === activeId;
          return (
            <div
              key={session.id}
              className="session-item"
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                padding: '8px 9px',
                borderRadius: 'var(--radius-sm)',
                cursor: 'pointer',
                marginBottom: 2,
                background: active ? 'var(--surface)' : 'transparent',
                border: active ? '1px solid var(--line)' : '1px solid transparent',
                transition: 'background var(--speed) var(--ease)',
              }}
              onClick={() => void openSession(session.id)}
            >
              <div style={{ flex: 1, minWidth: 0 }}>
                <div
                  style={{
                    fontSize: 13,
                    fontWeight: active ? 600 : 450,
                    whiteSpace: 'nowrap',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    color: 'var(--ink)',
                  }}
                >
                  {session.title}
                </div>
                <div style={{ fontSize: 11, color: 'var(--ink-3)', marginTop: 1 }}>
                  {running ? (
                    <span style={{ color: 'var(--accent-ink)', fontWeight: 500 }}>running...</span>
                  ) : (
                    formatRelativeTime(session.updatedAt)
                  )}
                  {session.messageCount > 0 ? ` - ${session.messageCount} msg` : ''}
                </div>
              </div>
              {confirmId === session.id ? (
                <button
                  className="btn btn-ghost"
                  style={{ padding: '3px 6px', color: 'var(--danger)' }}
                  title="Confirm delete"
                  onClick={(event) => {
                    event.stopPropagation();
                    setConfirmId(null);
                    void removeSession(session.id);
                  }}
                >
                  <TrashIcon size={14} />
                </button>
              ) : (
                <button
                  className="btn item-delete"
                  style={{ padding: '3px 6px', color: 'var(--ink-faint)', opacity: 0 }}
                  title="Delete chat"
                  onClick={(event) => {
                    event.stopPropagation();
                    setConfirmId(session.id);
                    setTimeout(() => setConfirmId((current) => (current === session.id ? null : current)), 2600);
                  }}
                >
                  <TrashIcon size={14} />
                </button>
              )}
            </div>
          );
        })}
      </div>

      <div
        style={{
          borderTop: '1px solid var(--line)',
          padding: '10px 12px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
        }}
      >
        <button
          className="btn btn-ghost"
          style={{ fontSize: 13, padding: '6px 10px' }}
          onClick={() => setSettingsOpen(true)}
        >
          <SettingsIcon size={15} /> Settings
        </button>
        <span style={{ fontSize: 11, color: 'var(--ink-3)' }}>
          {appInfo?.runtimeSource === 'dev' ? 'dev' : ''}
        </span>
      </div>
    </aside>
  );
}
