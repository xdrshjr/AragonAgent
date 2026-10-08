'use client';

/** Per-tool glyph + status coloring for tool cards. */

import { CheckIcon, FolderIcon, GlobeIcon, SearchIcon, SparkIcon } from './Icons';

export function ToolGlyph({ name, done, error }: { name: string; done: boolean; error: boolean }) {
  const bg = error ? 'var(--danger-soft)' : done ? 'var(--ok-soft)' : 'var(--accent-soft)';
  const fg = error ? 'var(--danger)' : done ? 'var(--ok)' : 'var(--accent-ink)';
  return (
    <span
      style={{
        width: 22,
        height: 22,
        borderRadius: 7,
        background: bg,
        color: fg,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        flexShrink: 0,
      }}
    >
      {error ? (
        <span style={{ fontWeight: 700, fontSize: 12 }}>!</span>
      ) : done ? (
        <CheckIcon size={12} />
      ) : (
        <IconFor name={name} />
      )}
    </span>
  );
}

function IconFor({ name }: { name: string }) {
  if (name === 'bash') return <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, fontWeight: 700 }}>{'>_'}</span>;
  if (name === 'grep' || name === 'glob') return <SearchIcon size={12} />;
  if (name === 'list_dir') return <FolderIcon size={12} />;
  if (name === 'skill' || name === 'skill_find') return <SparkIcon size={12} />;
  if (name === 'read_file' || name === 'write_file' || name === 'edit_file') return <FileIcon />;
  if (name === 'task') return <GlobeIcon size={12} />;
  return <SparkIcon size={12} />;
}

function FileIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z" />
      <path d="M14 2v6h6" />
    </svg>
  );
}
