'use client';

/**
 * The settings overlay: model profiles (Anthropic / OpenAI / custom
 * OpenAI-compatible), encrypted API keys, default working directory, and a
 * live connection test.
 *
 * All edits mutate a local draft; Save validates on the main process and
 * either applies atomically or reports per-profile issues.
 */

import { useEffect, useMemo, useState } from 'react';
import { useStore } from '@lib/store';
import { bridge } from '@lib/ipc';
import { MODE_META, MODEL_SUGGESTIONS } from '@lib/format';
import type {
  ProfileDraftInput,
  ProfileIssue,
  SaveSettingsResult,
  TestOutcome,
} from '@shared/protocol';
import {
  CheckIcon,
  CloseIcon,
  FolderIcon,
  PlusIcon,
  SparkIcon,
  TrashIcon,
} from './Icons';

interface Draft extends ProfileDraftInput {
  hasKey: boolean;
  keyPreview: string;
}

const ISSUE_TEXT: Record<ProfileIssue, string> = {
  label_empty: 'Give this profile a name.',
  label_too_long: 'Name is too long.',
  model_empty: 'Model id is required.',
  model_too_long: 'Model id is too long.',
  base_url_invalid: 'Base URL must be a valid http(s) URL.',
  base_url_required_for_custom: 'Custom mode needs a base URL.',
  key_required: 'Store an API key or export one in your environment.',
  duplicate_label: 'Another profile already uses this name.',
};

export default function SettingsOverlay() {
  const settings = useStore((state) => state.settings);
  const saveSettings = useStore((state) => state.saveSettings);
  const testProfile = useStore((state) => state.testProfile);
  const setSettingsOpen = useStore((state) => state.setSettingsOpen);
  const refreshSessions = useStore((state) => state.refreshSessions);

  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [activeDraft, setActiveDraft] = useState<number>(0);
  const [activeProfileId, setActiveProfileId] = useState('');
  const [defaultCwd, setDefaultCwd] = useState('');
  const [issues, setIssues] = useState<{ profileIndex: number; code: ProfileIssue }[]>([]);
  const [saveError, setSaveError] = useState('');
  const [test, setTest] = useState<TestOutcome | null>(null);
  const [testing, setTesting] = useState(false);

  useEffect(() => {
    if (!settings || drafts.length > 0) return;
    setDrafts(
      settings.profiles.map((profile) => ({
        id: profile.id,
        label: profile.label,
        mode: profile.mode,
        model: profile.model,
        baseUrl: profile.baseUrl,
        thinking: profile.thinking,
        apiKey: null,
        hasKey: profile.hasKey,
        keyPreview: profile.keyPreview,
      })),
    );
    setActiveProfileId(settings.activeProfileId);
    setDefaultCwd(settings.defaultCwd);
  }, [settings, drafts.length]);

  const current = drafts[activeDraft];
  const currentIssues = useMemo(
    () => issues.filter((issue) => issue.profileIndex === activeDraft).map((issue) => issue.code),
    [issues, activeDraft],
  );

  if (!settings) return null;

  const update = (patch: Partial<Draft>) => {
    setDrafts((list) => list.map((draft, index) => (index === activeDraft ? { ...draft, ...patch } : draft)));
  };

  const addProfile = () => {
    setDrafts((list) => [
      ...list,
      {
        id: undefined,
        label: 'New profile',
        mode: 'openai',
        model: '',
        baseUrl: '',
        thinking: 'off',
        apiKey: null,
        hasKey: false,
        keyPreview: '',
      },
    ]);
    setActiveDraft(drafts.length);
    setTest(null);
  };

  const removeProfile = (index: number) => {
    setDrafts((list) => list.filter((_draft, at) => at !== index));
    setActiveDraft(0);
    setTest(null);
  };

  const save = async () => {
    setIssues([]);
    setSaveError('');
    setTest(null);
    const result: SaveSettingsResult = await saveSettings({
      profiles: drafts,
      activeProfileId,
      defaultCwd,
    });
    if (result.ok) {
      await refreshSessions();
      setSettingsOpen(false);
      return;
    }
    if (result.issues.length === 0) {
      setSaveError('Could not save settings (invalid active profile).');
      return;
    }
    setIssues(result.issues);
    setActiveDraft(result.issues[0].profileIndex);
  };

  const runTest = async () => {
    if (!current) return;
    setTesting(true);
    setTest(null);
    const outcome = await testProfile({
      id: current.id ?? undefined,
      label: current.label,
      mode: current.mode,
      model: current.model,
      baseUrl: current.baseUrl,
      thinking: current.thinking,
      apiKey: current.apiKey ?? undefined,
    });
    setTest(outcome);
    setTesting(false);
  };

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(25,25,25,0.32)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 50,
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) setSettingsOpen(false);
      }}
    >
      <div
        style={{
          width: 'min(880px, 92vw)',
          // DEFINITE height + a minmax(0,1fr) row: a bare maxHeight lets the
          // implicit row grow to content height, so the right column's flex
          // footer rendered below the clipped area and the editor never
          // scrolled on short windows.
          height: 'min(660px, 86vh)',
          background: 'var(--surface)',
          border: '1px solid var(--line)',
          borderRadius: 'var(--radius-lg)',
          boxShadow: 'var(--shadow-3)',
          display: 'grid',
          gridTemplateColumns: '236px 1fr',
          gridTemplateRows: 'minmax(0, 1fr)',
          overflow: 'hidden',
        }}
      >
        {/* Left: profile list */}
        <div style={{ borderRight: '1px solid var(--line)', background: 'var(--bg-sidebar)', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
          <div style={{ padding: '18px 16px 10px', fontFamily: 'var(--font-display)', fontWeight: 600, fontSize: 17 }}>
            Settings
          </div>
          <div style={{ flex: 1, overflowY: 'auto', padding: '0 8px', minHeight: 0 }}>
            {drafts.map((draft, index) => (
              <button
                key={index}
                onClick={() => {
                  setActiveDraft(index);
                  setTest(null);
                }}
                style={{
                  width: '100%',
                  textAlign: 'left',
                  padding: '8px 10px',
                  borderRadius: 'var(--radius-sm)',
                  marginBottom: 2,
                  background: index === activeDraft ? 'var(--surface)' : 'transparent',
                  border: index === activeDraft ? '1px solid var(--line)' : '1px solid transparent',
                }}
              >
                <div style={{ fontSize: 13, fontWeight: 600, display: 'flex', gap: 6, alignItems: 'center' }}>
                  {activeProfileId === draft.id ? (
                    <span style={{ color: 'var(--accent)' }}>* </span>
                  ) : null}
                  {draft.label || 'Untitled'}
                </div>
                <div style={{ fontSize: 11.5, color: 'var(--ink-3)' }}>
                  {MODE_META[draft.mode].label} - {draft.model || 'no model'}
                </div>
              </button>
            ))}
          </div>
          <div style={{ padding: 10, borderTop: '1px solid var(--line)' }}>
            <button className="btn btn-ghost" style={{ width: '100%', justifyContent: 'center', fontSize: 13 }} onClick={addProfile}>
              <PlusIcon size={14} /> Add profile
            </button>
          </div>
        </div>

        {/* Right: editor */}
        <div style={{ display: 'flex', flexDirection: 'column', minHeight: 0 }}>
          <div style={{ padding: '18px 22px 0', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <div style={{ fontFamily: 'var(--font-display)', fontWeight: 600, fontSize: 17 }}>
              {current ? current.label || 'New profile' : 'No profiles'}
            </div>
            <button className="btn btn-ghost" style={{ padding: 6 }} onClick={() => setSettingsOpen(false)}>
              <CloseIcon size={16} />
            </button>
          </div>

          <div style={{ flex: 1, overflowY: 'auto', padding: '14px 22px 20px', minHeight: 0 }}>
            {!current ? (
              <div style={{ color: 'var(--ink-3)', padding: '20px 0' }}>
                No profiles yet - add one to start chatting.
              </div>
            ) : (
              <div style={{ display: 'grid', gap: 16 }}>
                {/* Mode cards */}
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8 }}>
                  {(['anthropic', 'openai', 'custom'] as const).map((mode) => (
                    <button
                      key={mode}
                      onClick={() => update({ mode })}
                      style={{
                        textAlign: 'left',
                        border:
                          current.mode === mode
                            ? '1.5px solid var(--accent)'
                            : '1px solid var(--line-strong)',
                        background: current.mode === mode ? 'var(--accent-soft)' : 'var(--surface-raised)',
                        borderRadius: 'var(--radius-md)',
                        padding: '10px 12px',
                      }}
                    >
                      <div style={{ fontWeight: 600, fontSize: 13.5, display: 'flex', gap: 6, alignItems: 'center' }}>
                        {mode === 'anthropic' ? <SparkIcon size={13} /> : null}
                        {MODE_META[mode].label}
                      </div>
                      <div style={{ fontSize: 11.5, color: 'var(--ink-3)', marginTop: 3, lineHeight: 1.45 }}>
                        {MODE_META[mode].blurb}
                      </div>
                    </button>
                  ))}
                </div>

                <div className="field">
                  <label>Profile name</label>
                  <input value={current.label} onChange={(event) => update({ label: event.target.value })} placeholder="e.g. Work DeepSeek" />
                </div>

                <div className="field">
                  <label>Model id</label>
                  <input
                    value={current.model}
                    onChange={(event) => update({ model: event.target.value })}
                    placeholder={MODEL_SUGGESTIONS[current.mode][0]}
                    list={`models-${current.mode}`}
                  />
                  <datalist id={`models-${current.mode}`}>
                    {MODEL_SUGGESTIONS[current.mode].map((model) => (
                      <option key={model} value={model} />
                    ))}
                  </datalist>
                  <span className="hint">Free text - pick a suggestion or type any id your endpoint serves.</span>
                </div>

                <div className="field">
                  <label>API key</label>
                  <input
                    type="password"
                    value={current.apiKey ?? ''}
                    onChange={(event) => update({ apiKey: event.target.value, hasKey: event.target.value.length > 0 || current.hasKey })}
                    placeholder={
                      current.hasKey ? 'stored - type to replace' : MODE_META[current.mode].keyHint
                    }
                    autoComplete="off"
                  />
                  <span className="hint">
                    {current.hasKey && !current.apiKey
                      ? 'A key is stored encrypted on this device (DPAPI/Keychain).'
                      : 'Stored encrypted on this device; never leaves it except to your endpoint.'}
                  </span>
                </div>

                <div className="field">
                  <label>Base URL {current.mode === 'custom' ? '(required)' : '(optional override)'}</label>
                  <input
                    value={current.baseUrl}
                    onChange={(event) => update({ baseUrl: event.target.value })}
                    placeholder={
                      current.mode === 'custom'
                        ? 'https://api.deepseek.com/v1'
                        : current.mode === 'anthropic'
                          ? 'https://api.anthropic.com (default)'
                          : 'https://api.openai.com/v1 (default)'
                    }
                  />
                  <span className="hint">
                    {current.mode === 'custom'
                      ? 'Any OpenAI-compatible endpoint: DeepSeek, Qwen, Ollama, one-api...'
                      : 'Point at a gateway or proxy only if you need one.'}
                  </span>
                </div>

                <div className="field">
                  <label>Thinking budget</label>
                  <select value={current.thinking} onChange={(event) => update({ thinking: event.target.value as Draft['thinking'] })}>
                    <option value="off">Off</option>
                    <option value="minimal">Minimal</option>
                    <option value="low">Low</option>
                    <option value="medium">Medium</option>
                    <option value="high">High</option>
                    <option value="xhigh">Extra high</option>
                  </select>
                </div>

                <div className="field">
                  <label>Default working directory</label>
                  <div style={{ display: 'flex', gap: 8 }}>
                    <input
                      value={defaultCwd}
                      onChange={(event) => setDefaultCwd(event.target.value)}
                      placeholder="Pick where new chats start"
                      style={{ flex: 1 }}
                    />
                    <button
                      className="btn btn-secondary"
                      style={{ padding: '7px 12px' }}
                      onClick={async () => {
                        const dir = await bridge().dialogs.pickDirectory();
                        if (dir) setDefaultCwd(dir);
                      }}
                    >
                      <FolderIcon size={14} />
                    </button>
                  </div>
                </div>

                {currentIssues.length > 0 ? (
                  <div style={{ color: 'var(--danger)', fontSize: 12.5 }}>
                    {currentIssues.map((code) => (
                      <div key={code}>- {ISSUE_TEXT[code]}</div>
                    ))}
                  </div>
                ) : null}
                {saveError ? <div style={{ color: 'var(--danger)', fontSize: 12.5 }}>{saveError}</div> : null}

                <div style={{ display: 'flex', alignItems: 'center', gap: 10, borderTop: '1px solid var(--line)', paddingTop: 14 }}>
                  <button className="btn btn-secondary" style={{ padding: '7px 16px', fontSize: 13 }} disabled={testing} onClick={() => void runTest()}>
                    {testing ? 'Testing...' : 'Test connection'}
                  </button>
                  {testing ? (
                    <span style={{ display: 'inline-flex', gap: 4 }}>
                      <span className="dot" />
                      <span className="dot" />
                      <span className="dot" />
                    </span>
                  ) : null}
                  {test ? <TestBadge outcome={test} /> : null}
                  <span style={{ flex: 1 }} />
                  <button
                    className="btn btn-ghost"
                    style={{ color: 'var(--danger)', padding: '7px 10px' }}
                    disabled={drafts.length <= 1}
                    title={drafts.length <= 1 ? 'Keep at least one profile' : 'Delete this profile'}
                    onClick={() => removeProfile(activeDraft)}
                  >
                    <TrashIcon size={14} /> Remove
                  </button>
                </div>
              </div>
            )}
          </div>

          <div
            style={{
              borderTop: '1px solid var(--line)',
              padding: '12px 22px',
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              background: 'var(--bg)',
            }}
          >
            <span style={{ fontSize: 12, color: 'var(--ink-3)' }}>
              Active profile
            </span>
            <select
              value={activeProfileId}
              onChange={(event) => setActiveProfileId(event.target.value)}
              style={{
                border: '1px solid var(--line-strong)',
                borderRadius: 'var(--radius-sm)',
                background: 'var(--surface-raised)',
                padding: '5px 9px',
                fontSize: 12.5,
              }}
            >
              <option value="">(none)</option>
              {drafts.map((draft, index) => (
                <option key={draft.id ?? `draft-${index}`} value={draft.id ?? ''}>
                  {draft.label || 'Untitled'}
                </option>
              ))}
            </select>
            <span style={{ flex: 1 }} />
            <button className="btn btn-ghost" style={{ fontSize: 13 }} onClick={() => setSettingsOpen(false)}>
              Cancel
            </button>
            <button className="btn btn-primary" style={{ padding: '7px 18px', fontSize: 13 }} onClick={() => void save()}>
              <CheckIcon size={14} /> Save
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function TestBadge({ outcome }: { outcome: TestOutcome }) {
  if (outcome.kind === 'cancelled') return null;
  if (outcome.kind === 'ok') {
    return (
      <span style={{ fontSize: 12.5, color: 'var(--ok)', display: 'inline-flex', gap: 5, alignItems: 'center' }}>
        <CheckIcon size={13} /> Connected to {outcome.model} in {(outcome.durationMs / 1000).toFixed(1)}s
      </span>
    );
  }
  return (
    <span style={{ fontSize: 12.5, color: 'var(--danger)', maxWidth: 340 }}>
      Failed: {outcome.message}
    </span>
  );
}
