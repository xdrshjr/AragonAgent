/**
 * Settings screen — edit provider / model / base URL / thinking / max tokens /
 * API key for the active provider (spec §3.5 / §5.2). Up/Down move between
 * fields; Left/Right cycle enum fields; typing edits text/secret fields;
 * Enter saves; Esc (handled by the App) closes without saving.
 *
 * The API key is never printed: it renders as dots while editing and masked
 * otherwise.
 */

import React, { useEffect, useReducer, useRef, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import {
  DEFAULT_MAX_OUTPUT_TOKENS,
  resolveOutputTokens,
  type ThinkingLevel,
} from '@aragon-agent/core';
import {
  ADAPTER_PROVIDERS,
  THINKING_LEVELS,
  maskSecret,
  parseMaxTokensInput,
  parseThresholdInput,
  type CompactionConfig,
  type FastConfig,
} from '../../config/schema.js';
import { LOG_LEVEL_NAMES, type LogLevelName } from '../../logging/levels.js';
import type { Theme } from '../theme.js';
import type { TermCapabilities } from '../capabilities.js';
import { pickGlyphs } from '../glyphs.js';
import { OverlayFrame } from '../layout/OverlayFrame.js';
import { stripPasteFrames } from '../paste-frames.js';
import { stripEnterFrames } from '../enter-frames.js';
import type { ModelSettingsDraft, ModelSettingsPatch,
  ModelSettingsSaveResult } from '../../config/model-profile-store.js';
import { emptyModelProfiles } from '../../config/model-profiles.js';
import { registerSecret } from '../../logging/secret-registry.js';
import { ModelProfilePicker, useProfileScroll } from './ModelProfilePicker.js';
import { ModelProfileEditor } from './ModelProfileEditor.js';
import { createModelProfileState, createCustomProfile, modelProfileReducer,
  profileUsers } from './model-profile-state.js';

export interface SettingsValues {
  provider: string;
  model: string;
  baseUrl: string;
  thinkingLevel: ThinkingLevel;
  /**
   * Whether the transcript draws the reasoning (agent-activity-presentation
   * §4.3). `'on' | 'off'` rather than a boolean because this screen edits an
   * enum row and reads it back as one; `App` converts at both ends.
   */
  showThinking: 'on' | 'off';
  /**
   * Whether a running tool card draws a live output tail
   * (agent-activity-presentation-live §4.1). `'on' | 'off'` for the reason its
   * neighbour records: this screen edits an enum row and reads it back as one.
   *
   * PERSIST-ONLY, unlike `showThinking`. The store is allocated in
   * `AgentController`'s constructor and there is no setter, so this row takes
   * effect on the next launch -- which is also what manual row 8 asks for.
   */
  liveToolOutput: 'on' | 'off';
  maxTokens: string;
  apiKey: string;
  /**
   * Only the LEVEL is editable here. The rest of `LogConfig` — and above all
   * `redactSecrets` — stays command-line-only, so the one switch that can put
   * credentials on disk cannot be flipped by a stray arrow key.
   */
  logLevel: LogLevelName;
  /**
   * The fast tier (fast-model-tier §4.5, extended by the hardening round §4.4).
   *
   * FIVE ROWS, and only the first is always meaningful — the other four
   * describe a tier that may not be on. They are `string` rather than their
   * config types because this screen edits TEXT: `fastReview` accepts a number
   * or `off`, and a typo must change nothing rather than resolve to a default
   * (the discipline `maxTokens` already follows here).
   */
  fastEnabled: 'on' | 'off';
  fastModel: string;
  fastProvider: string;
  fastReview: string;
  /** The session review budget. `fastReview` is the PACE, this is the TOTAL. */
  fastReviewBudget: string;
  /**
   * Context compaction (context-auto-compaction §4.5).
   *
   * THREE ROWS, NOT SIX. `onFailure` and `useFastTier` are file- and
   * `/compact`-only on purpose: this screen is for the settings a user CHANGES,
   * not for every setting that exists, and "what should it do if the summarizer
   * 500s" is not a question a user reaches for with arrow keys.
   *
   * `string` rather than their config types because this screen edits TEXT, and
   * a typo must change NOTHING rather than resolve to a default — the discipline
   * `maxTokens` and `fastReview` already follow here.
   */
  compactionEnabled: 'on' | 'off';
  /** A percentage the user types, e.g. `90`. Parsed on save; a typo is ignored. */
  compactionThreshold: string;
  compactionKeepTurns: string;
  /**
   * The two hardening toggles (context-auto-compaction-hardening §4.6).
   *
   * FIVE ROWS NOW, NOT THREE, and these two earn their place where `onFailure`
   * did not: each one names a THING THE SESSION WILL DO - spend money inside a
   * fan-out, and write conversation content to disk - rather than a policy for a
   * failure the user has never seen. Both are questions a user reaches for
   * deliberately.
   */
  compactionSubagents: 'on' | 'off';
  compactionArchive: 'on' | 'off';
}

interface SettingsScreenProps {
  isActive?: boolean;
  initial: SettingsValues;
  /** Resolved keys per provider so switching providers reloads the right key. */
  apiKeys: Record<string, string | undefined>;
  maxRows: number;
  cols: number;
  /** Owned by `App`, like every other overlay scroll offset. */
  scrollOffset: number;
  /** Clamped offset reported back to `App`; see `OverlayFrame`. */
  onScrollClamp?: (offset: number) => void;
  theme: Theme;
  caps: TermCapabilities;
  onSave?: (values: SettingsValues) => void;
  draft?: ModelSettingsDraft;
  onProfileSave?: (draft: ModelSettingsDraft) => ModelSettingsSaveResult;
  onClose?: () => void;
  onReload?: () => ModelSettingsDraft;
  /**
   * `API retries` READ-ONLY row (llm-api-retry-backoff §6.9), e.g. `10` or `off`.
   *
   * A STRING FROM `App`, NOT A `SettingsValues` FIELD, and that distinction is the
   * whole design: `SettingsValues` is what Enter WRITES, and routing retry through
   * it would mean nine more editable rows (or one row whose Enter silently
   * rewrote a section it does not own). `/retry` is the discoverable control;
   * this row exists so "is it on, and how many" is answerable without leaving the
   * screen. Absent = omit the row entirely.
   */
  retrySummary?: string;
}

type FieldKey = keyof SettingsValues;
interface FieldDef {
  key: FieldKey;
  label: string;
  kind: 'enum' | 'text' | 'secret';
  options?: readonly string[];
}

const SHOW_THINKING_OPTIONS = ['off', 'on'] as const;
const LIVE_OUTPUT_OPTIONS = ['off', 'on'] as const;
const FAST_ENABLED_OPTIONS = ['off', 'on'] as const;
const COMPACTION_ENABLED_OPTIONS = ['off', 'on'] as const;
/**
 * `(inherit)` IS THE EMPTY STRING, rendered as a word.
 *
 * An empty enum cell would read as "unset and therefore broken"; the truth is
 * that an empty `fast.provider` INHERITS the main provider, which is the setting
 * most users want and the one they should not have to type (§3.2 rule 2).
 */
const FAST_INHERIT_PROVIDER = '(inherit)';
const FAST_PROVIDER_OPTIONS = [FAST_INHERIT_PROVIDER, ...ADAPTER_PROVIDERS] as const;

/**
 * The derived, non-editable line under the five fast rows — the sibling of
 * `effectiveCapLine`, and it exists for the same reason (§4.5).
 *
 * A SETTINGS SCREEN THAT LETS A USER SWITCH A TIER ON AND GIVES NO SIGNAL THAT
 * IT CANNOT RESOLVE is the failure `effectiveCapLine` was added to fix for
 * `maxTokens`, one screen later. `keyFor` is the same resolver the controller
 * uses, so this line and the runtime cannot disagree.
 *
 * IT DOES NOT TAKE `fastReviewBudget` AND MUST NOT (§4.4 part 5): this line
 * describes what the tier IS, not what it is allowed to spend.
 */
export function fastTierLine(
  values: Pick<SettingsValues, 'provider' | 'fastEnabled' | 'fastModel' | 'fastProvider' | 'fastReview'>,
  hasKey: (providerId: string) => boolean,
): string {
  if (values.fastEnabled !== 'on') return 'Fast tier: off';
  const model = values.fastModel.trim();
  if (model.length === 0) return 'Fast tier: off  (fast.model is not set)';
  const provider =
    values.fastProvider === FAST_INHERIT_PROVIDER || values.fastProvider.trim().length === 0
      ? values.provider
      : values.fastProvider;
  if (!hasKey(provider)) {
    return `Fast tier: ${provider}:${model}  (no API key for ${provider} - the tier will stay off)`;
  }
  const review = values.fastReview.trim().toLowerCase();
  const cadence =
    review === 'off'
      ? 'review off'
      : /^\d+$/.test(review)
      ? `review every ${review} turns`
      : 'review every 5 turns';
  return `Fast tier: ${provider}:${model}  (key set)  ${cadence}`;
}

/**
 * The five editable fast rows, as a config patch (§4.5 / hardening §4.4).
 *
 * PURE AND EXPORTED so `App`'s save handler holds no parsing of its own, and so
 * the round trip `fastSettingsFrom(config)` -> edit -> `readFastSettings` can be
 * tested without a terminal.
 *
 * A TYPO IN `fastReview` CHANGES NOTHING — the `review` / `reviewEveryTurns`
 * keys are simply omitted from the patch, so `clampFastConfig`'s merge keeps
 * whatever was there. That is the `Max tokens` discipline this screen already
 * follows, and the alternative (resolving a typo to the default) silently
 * discards the cadence the user actually set. `fastReviewBudget` follows the
 * same rule; an out-of-range NUMBER is passed through to `clampFastConfig`'s
 * `REVIEW_SESSION_RANGE` rather than being validated a second time here, so a
 * row edit and a hand-edited `config.json` land on the same value.
 */
export function readFastSettings(
  values: Pick<
    SettingsValues,
    'fastEnabled' | 'fastModel' | 'fastProvider' | 'fastReview' | 'fastReviewBudget'
  >,
): Partial<FastConfig> {
  const review = values.fastReview.trim().toLowerCase();
  const parsed = /^\d+$/.test(review) ? Number.parseInt(review, 10) : Number.NaN;
  const budget = values.fastReviewBudget.trim();
  const parsedBudget = /^\d+$/.test(budget) ? Number.parseInt(budget, 10) : Number.NaN;
  return {
    enabled: values.fastEnabled === 'on',
    model: values.fastModel.trim(),
    provider:
      values.fastProvider === FAST_INHERIT_PROVIDER ? '' : values.fastProvider.trim(),
    ...(review === 'off' ? { review: false } : {}),
    ...(Number.isFinite(parsed) && parsed > 0
      ? { review: true, reviewEveryTurns: parsed }
      : {}),
    ...(Number.isFinite(parsedBudget) ? { reviewMaxPerSession: parsedBudget } : {}),
  };
}

/**
 * The inverse: seed the five rows from a resolved config.
 *
 * OMITTING A KEY HERE IS THE SILENT HALF OF ADDING A ROW (§4.4 part 4): the row
 * renders empty, `readFastSettings` sees an unparseable value, and an untouched
 * save writes the clamp's default over whatever the user had.
 */
export function fastSettingsFrom(
  fast: FastConfig,
): Pick<
  SettingsValues,
  'fastEnabled' | 'fastModel' | 'fastProvider' | 'fastReview' | 'fastReviewBudget'
> {
  return {
    fastEnabled: fast.enabled ? 'on' : 'off',
    fastModel: fast.model,
    fastProvider: fast.provider.trim().length > 0 ? fast.provider : FAST_INHERIT_PROVIDER,
    fastReview: fast.review ? String(fast.reviewEveryTurns) : 'off',
    fastReviewBudget: String(fast.reviewMaxPerSession),
  };
}

/**
 * Read the three compaction rows back into a config patch.
 *
 * A TYPO CHANGES NOTHING — the discipline `readFastSettings` states one function
 * up, and the reason is the same: a threshold that silently resolved to the
 * default on a mistyped keystroke would be a setting the user believes they
 * changed and did not. `parseThresholdInput` returns `null` for anything that is
 * not a ratio or a percentage, and the key is then simply absent from the patch.
 */
export function readCompactionSettings(
  values: Pick<
    SettingsValues,
    | 'compactionEnabled'
    | 'compactionThreshold'
    | 'compactionKeepTurns'
    | 'compactionSubagents'
    | 'compactionArchive'
  >,
): Partial<CompactionConfig> {
  const threshold = parseThresholdInput(values.compactionThreshold);
  const keep = values.compactionKeepTurns.trim();
  const parsedKeep = /^\d+$/.test(keep) ? Number.parseInt(keep, 10) : Number.NaN;
  return {
    enabled: values.compactionEnabled === 'on',
    ...(threshold !== null ? { threshold } : {}),
    ...(Number.isFinite(parsedKeep) && parsedKeep > 0 ? { keepRecentTurns: parsedKeep } : {}),
    // AN ENUM ROW CANNOT BE MISTYPED, so unlike the two text rows above these are
    // written unconditionally.
    subagents: values.compactionSubagents === 'on',
    archive: values.compactionArchive === 'on',
  };
}

/**
 * The inverse: seed the three rows from a resolved config.
 *
 * OMITTING A KEY HERE IS THE SILENT HALF OF ADDING A ROW, exactly as it is for
 * the fast rows above: the row renders empty, `readCompactionSettings` sees an
 * unparseable value, and an untouched save writes the clamp's default over
 * whatever the user had.
 */
export function compactionSettingsFrom(
  compaction: CompactionConfig,
): Pick<
  SettingsValues,
  | 'compactionEnabled'
  | 'compactionThreshold'
  | 'compactionKeepTurns'
  | 'compactionSubagents'
  | 'compactionArchive'
> {
  return {
    compactionEnabled: compaction.enabled ? 'on' : 'off',
    // A PERCENTAGE, because that is the unit the status bar shows and the unit a
    // user thinks in. `parseThresholdInput` accepts it back.
    compactionThreshold: String(Math.round(compaction.threshold * 100)),
    compactionKeepTurns: String(compaction.keepRecentTurns),
    compactionSubagents: compaction.subagents ? 'on' : 'off',
    compactionArchive: compaction.archive ? 'on' : 'off',
  };
}

const FIELDS: FieldDef[] = [
  { key: 'provider', label: 'Provider', kind: 'enum', options: ADAPTER_PROVIDERS },
  { key: 'model', label: 'Model', kind: 'text' },
  { key: 'baseUrl', label: 'Base URL', kind: 'text' },
  { key: 'thinkingLevel', label: 'Thinking', kind: 'enum', options: THINKING_LEVELS },
  // Directly under `Thinking`, so the effort setting and the display setting are
  // read together. `Show thinking` is 13 characters, inside the 18-column label
  // budget `.padEnd(18)` enforces below and that IF-H7 records as silently
  // overflowing.
  { key: 'showThinking', label: 'Show thinking', kind: 'enum', options: SHOW_THINKING_OPTIONS },
  // Beside `Show thinking`, because the two are the transcript's only display
  // switches. `Live output` is 11 characters, inside the 18-column label budget
  // `.padEnd(18)` enforces below and that IF-H7 records as silently overflowing.
  { key: 'liveToolOutput', label: 'Live output', kind: 'enum', options: LIVE_OUTPUT_OPTIONS },
  { key: 'maxTokens', label: 'Max tokens', kind: 'text' },
  // The fast tier sits AFTER `Max tokens` and BEFORE `API key`, because the key
  // row is the one a user scrolls to deliberately and putting five rows past it
  // would bury it (fast-model-tier §4.5). The rationale survives a fifth row;
  // the count in it did not.
  //
  // `Fast review budget` is a `'text'` row, NOT a new numeric kind (D-H12):
  // `SettingsRow.kind` is `'enum' | 'text' | 'secret'`, and `Max tokens` and
  // `Fast review` are both bounded numbers already living as text plus an
  // adapter parse. A fourth kind for one row would be a new interaction pattern
  // in a screen whose whole design is that it edits text.
  //
  // ITS LABEL IS SHORT BECAUSE THE LABEL COLUMN IS A BUDGET, NOT A HINT SLOT.
  // Labels render `.padEnd(18)` below, so one that reaches 18 does not truncate
  // and does not wrap - it pushes ITS OWN value right (or butts against it at
  // exactly 18) while every other row's value stays put, and the column stops
  // being a column. So no `(1-500)` here: no other bounded row carries its range
  // either (`Max tokens`, `Fast review`), `clampFastConfig` is the enforcement,
  // and `/fast budget` states the range in the one place a user meets it - when
  // it refuses a bad one. The name matches that command for the same reason.
  { key: 'fastEnabled', label: 'Fast tier', kind: 'enum', options: FAST_ENABLED_OPTIONS },
  { key: 'fastModel', label: 'Fast model', kind: 'text' },
  { key: 'fastProvider', label: 'Fast provider', kind: 'enum', options: FAST_PROVIDER_OPTIONS },
  { key: 'fastReview', label: 'Fast review', kind: 'text' },
  { key: 'fastReviewBudget', label: 'Fast budget', kind: 'text' },
  // Context compaction sits after the fast rows and still BEFORE `API key`, for
  // the reason recorded above that row: the key is the one a user scrolls to
  // deliberately, and burying it further would be worse than the ordering is
  // better. Three rows, and every label is inside the 18-column budget
  // `.padEnd(18)` enforces below.
  //
  // `Compact at` is a PERCENTAGE and carries no `(50-95)` hint, for the reason
  // `Fast budget` records: no other bounded row carries its range either,
  // `clampCompactionConfig` is the enforcement, and `/compact threshold` states
  // the range in the one place a user meets it — when it refuses a bad one.
  { key: 'compactionEnabled', label: 'Auto-compaction', kind: 'enum', options: COMPACTION_ENABLED_OPTIONS },
  { key: 'compactionThreshold', label: 'Compact at %', kind: 'text' },
  { key: 'compactionKeepTurns', label: 'Keep turns', kind: 'text' },
  // Both labels are inside the 18-column budget `.padEnd(18)` enforces below.
  { key: 'compactionSubagents', label: 'Compact children', kind: 'enum', options: COMPACTION_ENABLED_OPTIONS },
  { key: 'compactionArchive', label: 'Archive dropped', kind: 'enum', options: COMPACTION_ENABLED_OPTIONS },
  { key: 'apiKey', label: 'API key', kind: 'secret' },
  { key: 'logLevel', label: 'Log level', kind: 'enum', options: LOG_LEVEL_NAMES },
];

/**
 * The cap this setting will ACTUALLY produce against the selected model.
 *
 * Exported for the tests, and computed on every render rather than in an effect:
 * `resolveOutputTokens` is pure, allocation-light and does no I/O — the ceiling
 * lookup is a `Map.get` plus at most seven regex tests.
 *
 * Without this row the settings screen can only show what the user typed, and
 * "I set 64000 but answers still stop early" has no answer anywhere in the UI.
 */
export function effectiveCapLine(values: Pick<SettingsValues, 'provider' | 'model' | 'maxTokens'>): string {
  const parsed = parseMaxTokensInput(values.maxTokens);
  if (parsed.kind === 'invalid') return 'Effective: -  (not a number; use a value or "auto")';

  const requested = parsed.kind === 'value' ? parsed.value : undefined;
  const resolution = resolveOutputTokens({
    providerId: values.provider,
    modelId: values.model,
    ...(requested !== undefined ? { requested } : {}),
  });

  if (resolution.clampedBy === 'ceiling') {
    const ambition = requested ?? DEFAULT_MAX_OUTPUT_TOKENS;
    return `Effective: ${resolution.value}  (clamped from ${ambition} by the ${values.model} ceiling)`;
  }
  if (requested === undefined) return `Effective: ${resolution.value}  (auto)`;
  return `Effective: ${resolution.value}`;
}

export function SettingsScreen(props: SettingsScreenProps): React.ReactElement {
  return props.draft ? <ProfileSettingsScreen {...props} draft={props.draft} />
    : <LegacySettingsScreen {...props} />;
}

function LegacySettingsScreen({
  isActive = true,
  initial,
  apiKeys,
  maxRows,
  cols,
  scrollOffset,
  onScrollClamp,
  theme,
  caps,
  onSave,
  retrySummary,
}: SettingsScreenProps): React.ReactElement {
  const [values, setValues] = useState<SettingsValues>(initial);
  const [index, setIndex] = useState(0);
  const glyphs = pickGlyphs(caps);

  const field = FIELDS[index]!;
  const focusedOffset = useProfileScroll({ maxRows, cols, scrollOffset, onScrollClamp, theme, caps }, index);

  const cycle = (dir: 1 | -1) => {
    if (field.kind !== 'enum' || !field.options) return;
    const opts = field.options;
    const cur = opts.indexOf(String(values[field.key]));
    const next = (cur + dir + opts.length) % opts.length;
    const nextVal = opts[next]!;
    setValues((prev) => {
      const updated = { ...prev, [field.key]: nextVal } as SettingsValues;
      // Clear the key editor on provider switch. Never round-trip a resolved
      // (possibly env-only) key into the editor — saving would then persist a
      // secret the user never typed into the 0600 config file.
      if (field.key === 'provider') {
        updated.apiKey = '';
      }
      return updated;
    });
  };

  useInput((input, key) => {
    if (!isActive) return;
    if (key.escape) return; // App closes the overlay.

    if (key.upArrow) {
      setIndex((i) => (i - 1 + FIELDS.length) % FIELDS.length);
      return;
    }
    // `&& !key.shift` is a real key collision, not a style choice: Shift+Tab is
    // the global mode toggle, and without the guard it would also advance the
    // field cursor here — the user changes mode and their selection jumps
    // (AC-P4). The mode toggle itself is a no-op while an overlay is open, so
    // this branch simply has to stay out of the way.
    if (key.downArrow || (key.tab && !key.shift)) {
      setIndex((i) => (i + 1) % FIELDS.length);
      return;
    }
    if (key.return) {
      onSave?.(values);
      return;
    }
    if (field.kind === 'enum') {
      if (key.leftArrow) cycle(-1);
      if (key.rightArrow) cycle(1);
      return;
    }
    // text / secret editing
    if (key.backspace || key.delete) {
      setValues((prev) => ({ ...prev, [field.key]: String(prev[field.key]).slice(0, -1) }));
      return;
    }
    if (input && !key.ctrl && !key.meta) {
      // `stripPasteFrames`, NOT `input` (I-12 / P0-2). `useInput` is a BROADCAST,
      // so this handler sees the NUL-framed paste the composer was sent. An API
      // key is ~100 characters with no line break, which trips the filter's Tier
      // 2 burst rule and gets framed -- and nothing downstream would remove the
      // NULs: `trim()` does not treat U+0000 as whitespace, `maskDot` hides the
      // damage, and the value is handed to `registerSecret()` and
      // `controller.setApiKey()`. The user is told the settings were saved and
      // every request afterwards fails to authenticate with nothing on screen to
      // explain it. Pasting IS how a key enters this process.
      // `stripEnterFrames` INSIDE (tui-shift-enter-copy-queue 3.5): the same
      // broadcast carries the newline frame a Shift+Enter produced, and this
      // composition order is the one that leaves no NUL in the field -- the
      // outer paste strip removes the frame's newline for a single-line field
      // exactly as it removes a bare Ctrl+J today, while the reverse order
      // would leak the frame's letter as visible text.
      const text = stripPasteFrames(stripEnterFrames(input));
      if (text.length === 0) return;
      setValues((prev) => ({ ...prev, [field.key]: String(prev[field.key]) + text }));
    }
  });

  const displayValue = (f: FieldDef, selected: boolean): string => {
    const raw = String(values[f.key] ?? '');
    if (f.kind === 'secret') {
      // Indicate an already-configured key (env or file) without revealing it or
      // its length — the editor stays empty until the user types a replacement.
      const configured = (apiKeys[values.provider] ?? '').length > 0;
      if (raw.length > 0) {
        return selected
          ? glyphs.maskDot.repeat(Math.min(raw.length, 24))
          : maskSecret(raw, { maskChar: glyphs.maskDot, ellipsis: glyphs.ellipsis });
      }
      if (configured) return selected ? '(configured - type to replace)' : '(configured)';
      return selected ? '(type to set)' : '(none)';
    }
    if (f.kind === 'enum') return raw;
    // An empty cap field is AUTO, not "unset". `(none)` would read as a missing
    // setting, which is the one thing this field can never be.
    if (f.key === 'maxTokens' && raw.length === 0) return 'auto';
    // `(not set)` and NOT `(same as main)`, which is the honest reading of §3.2
    // rule 3: an empty `fast.model` does not inherit, it means the tier is
    // unconfigured. `(same as main)` is a fact the derived line below states
    // when the value literally equals the main model — never a placeholder.
    if (f.key === 'fastModel' && raw.length === 0) {
      return selected ? '(type a model id)' : '(not set)';
    }
    if (f.key === 'fastReview' && raw.length === 0) return 'every 5 turns';
    return raw.length > 0 ? raw : selected ? '(type to set)' : '(none)';
  };

  // One element per row, each `wrap="truncate"` — the contract for OverlayFrame's
  // controlled mode. The old title alone was 68 characters and wrapped below 70
  // columns, adding a row the frame could not account for (P2-9 / R-8).
  const rows: React.ReactElement[] = FIELDS.map((f, i) => {
    const selected = i === index;
    return (
      <Text key={f.key} wrap="truncate">
        <Text color={selected ? theme.accent : theme.muted}>
          {selected ? `${glyphs.caret} ` : '  '}
        </Text>
        <Text color={selected ? theme.assistant : theme.muted}>
          {(f.key === 'apiKey' ? `API key (${values.provider})` : f.label).padEnd(18)}
        </Text>
        <Text color={selected ? theme.primary : theme.muted}>{displayValue(f, selected)}</Text>
        {f.kind === 'enum' && selected && (
          <Text color={theme.muted}>
            {' ('}
            {glyphs.arrowLeft}/{glyphs.arrowRight}
            {')'}
          </Text>
        )}
      </Text>
    );
  });
  // One element, `wrap="truncate"`, pushed like every other row — OverlayFrame's
  // controlled mode slices by ELEMENT, so a row that wraps desynchronises the
  // position indicator.
  rows.push(
    <Text key="__effective" wrap="truncate" color={theme.muted}>
      {effectiveCapLine(values)}
    </Text>,
  );
  rows.push(
    <Text key="__fast" wrap="truncate" color={theme.muted}>
      {fastTierLine(values, (id) => (apiKeys[id] ?? '').length > 0)}
    </Text>,
  );
  /**
   * ONE ROW, NOT NINE (llm-api-retry-backoff §6.9).
   *
   * READ-ONLY, and deliberately so: the nine `retry.*` keys belong to `config set`
   * and `config.json`, and a settings screen that exposed a jitter checkbox is a
   * settings screen nobody reads. What a user needs HERE is the answer to "is it
   * on, and how many" — the discoverable control is `/retry`, which this row names.
   */
  if (retrySummary) {
    rows.push(
      <Text key="__retry" wrap="truncate" color={theme.muted}>
        {'  '}
        {'API retries'.padEnd(18)}
        {retrySummary}
      </Text>,
    );
  }
  rows.push(
    <Text key="__save" wrap="truncate" color={theme.muted}>
      Enter saves. Keys persist to the config file (0600).
    </Text>,
  );

  return (
    <OverlayFrame
      title="Settings"
      hint={`${glyphs.arrowUp}${glyphs.arrowDown} field ${glyphs.midDot} ${glyphs.arrowLeft}${glyphs.arrowRight} change ${glyphs.midDot} Enter save ${glyphs.midDot} Esc close`}
      maxRows={maxRows}
      cols={cols}
      rows={rows}
      scrollOffset={focusedOffset}
      onScrollClamp={onScrollClamp}
      theme={theme}
      caps={caps}
    />
  );
}

const PROFILE_FIELDS = FIELDS.filter((field) => ![
  'provider', 'model', 'baseUrl', 'apiKey', 'fastProvider', 'fastModel', 'fastEnabled',
].includes(field.key));

function profileSettingsValues(initial: SettingsValues,
  draft: ModelSettingsDraft): SettingsValues {
  const file = draft.baseline;
  return { ...initial, provider: file.provider ?? initial.provider,
    model: file.model ?? initial.model,
    baseUrl: file.baseUrl ?? '', apiKey: '', fastModel: file.fast?.model ?? '',
    fastProvider: file.fast?.provider || FAST_INHERIT_PROVIDER };
}

/** Only fields changed by the user belong in a settings transaction. */
export function readDirtySettings(initial: SettingsValues,
  values: SettingsValues): ModelSettingsPatch {
  const patch: ModelSettingsPatch = {};
  const dirty = (key: FieldKey) => initial[key] !== values[key];
  if (dirty('provider')) patch.provider = values.provider;
  if (dirty('model')) patch.model = values.model.trim();
  if (dirty('baseUrl')) patch.baseUrl = values.baseUrl.trim();
  if (dirty('apiKey') && values.apiKey.trim()) {
    patch.apiKeys = { [values.provider]: values.apiKey.trim() };
  }
  if (dirty('thinkingLevel')) patch.thinkingLevel = values.thinkingLevel;
  if (dirty('showThinking')) patch.showThinking = values.showThinking === 'on';
  if (dirty('liveToolOutput')) patch.liveToolOutput = values.liveToolOutput === 'on';
  if (dirty('logLevel')) patch.log = { level: values.logLevel };
  if (dirty('maxTokens')) {
    const parsed = parseMaxTokensInput(values.maxTokens);
    if (parsed.kind === 'invalid') throw new Error('Max tokens: use a number or auto.');
    patch.maxTokens = parsed.kind === 'auto' ? null : parsed.value;
  }
  const fast: Partial<FastConfig> = {};
  const parsedFast = readFastSettings(values);
  if (dirty('fastModel')) fast.model = parsedFast.model;
  if (dirty('fastProvider')) fast.provider = parsedFast.provider;
  if (dirty('fastEnabled')) fast.enabled = parsedFast.enabled;
  if (dirty('fastReview')) {
    if (parsedFast.review === undefined) throw new Error('Fast review: use a turn count or off.');
    fast.review = parsedFast.review;
    if (parsedFast.reviewEveryTurns !== undefined) {
      fast.reviewEveryTurns = parsedFast.reviewEveryTurns;
    }
  }
  if (dirty('fastReviewBudget')) {
    if (parsedFast.reviewMaxPerSession === undefined) {
      throw new Error('Fast budget: use a number.');
    }
    fast.reviewMaxPerSession = parsedFast.reviewMaxPerSession;
  }
  if (Object.keys(fast).length) patch.fast = fast;
  const compaction: Partial<CompactionConfig> = {};
  const parsedCompaction = readCompactionSettings(values);
  const mapping = { compactionEnabled: 'enabled', compactionThreshold: 'threshold',
    compactionKeepTurns: 'keepRecentTurns', compactionSubagents: 'subagents',
    compactionArchive: 'archive' } as const;
  for (const [field, key] of Object.entries(mapping)) {
    if (!dirty(field as FieldKey)) continue;
    const value = parsedCompaction[key];
    if (value === undefined) {
      const label = FIELDS.find((item) => item.key === field)!.label;
      throw new Error(`${label}: use a number.`);
    }
    Object.assign(compaction, { [key]: value });
  }
  if (Object.keys(compaction).length) patch.compaction = compaction;
  return patch;
}

function saveError(result: ModelSettingsSaveResult): string {
  if (result.persisted) return 'Saved; not fully applied. Close and restart. Save disabled.';
  const errors: Record<string, string> = {
    busy: 'Busy. Wait for running work to finish, then save again.',
    conflict: 'Config changed elsewhere. Reload before saving.',
    read_failed: 'Cannot read config. Repair with aragon config edit, then reload.',
    write_failed: 'Could not save. Your changes are still here; retry Save.',
    invalid: 'Invalid settings. Review the highlighted field and retry.',
  };
  return errors[result.code ?? ''] ?? 'Could not save. Review settings and retry.';
}

type ProfileSettingsProps = SettingsScreenProps & { draft: ModelSettingsDraft };

function useProfileSettingsState(props: ProfileSettingsProps) {
  const [state, dispatch] = useReducer(modelProfileReducer, props.draft, createModelProfileState);
  const [initial, setInitial] = useState(() => profileSettingsValues(props.initial, props.draft));
  const [values, setValues] = useState(initial);
  const [index, setIndex] = useState(0);
  const [error, setError] = useState<string>();
  const [persisted, setPersisted] = useState(false);
  const [confirmIndex, setConfirmIndex] = useState(0);
  const [reloadPending, setReloadPending] = useState(false);
  const offset = useProfileScroll(props, index);
  const previousPage = useRef(state.page);
  useEffect(() => {
    const previous = previousPage.current;
    previousPage.current = state.page;
    if (state.page !== 'root' || previous === 'discard-confirm') return;
    setIndex(0);
    props.onScrollClamp?.(0);
  }, [state.page]);
  const library = state.draft.profiles ?? emptyModelProfiles();
  const glyphs = pickGlyphs(props.caps);
  const dirty = state.dirty || Object.keys(values).some((key) =>
    values[key as FieldKey] !== initial[key as FieldKey]);
  const fields = [FIELDS.find((item) => item.key === 'fastEnabled')!,
    ...FIELDS.filter((item) => library.mainId === null
      && ['provider', 'model', 'baseUrl', 'apiKey'].includes(item.key)),
    ...FIELDS.filter((item) => library.fastId === null
      && ['fastModel', 'fastProvider'].includes(item.key)), ...PROFILE_FIELDS];
  const count = fields.length + 5;
  const field = fields[index - 3];
  const readError = state.draft.readError;
  const confirming = state.page === 'delete-confirm' || state.page === 'discard-confirm';
  return { state, dispatch, initial, setInitial, values, setValues, index, setIndex,
    error, setError, persisted, setPersisted, confirmIndex, setConfirmIndex,
    reloadPending, setReloadPending, offset, library, glyphs, dirty, fields, count,
    field, readError, confirming };
}

type ProfileSettingsState = ReturnType<typeof useProfileSettingsState>;

function saveProfileSettings(props: ProfileSettingsProps, view: ProfileSettingsState): void {
  const { persisted, readError, initial, values, fields, state,
    setError, setIndex, setPersisted } = view;
  if (persisted || readError || !props.onProfileSave) return;
  let patch: ModelSettingsPatch;
  try { patch = readDirtySettings(initial, values); }
  catch (failure) {
    const message = (failure as Error).message;
    setError(message);
    const at = fields.findIndex((item) => message.startsWith(`${item.label}:`));
    if (at >= 0) setIndex(at + 3);
    return;
  }
  const result = props.onProfileSave({
    ...state.draft, patch: { ...state.draft.patch, ...patch },
  });
  if (!result.ok) { setError(saveError(result)); setPersisted(result.persisted); }
}

function reloadProfileSettings(props: ProfileSettingsProps, view: ProfileSettingsState): void {
  const { dispatch, setInitial, setValues, setError, setIndex, setReloadPending } = view;
  if (!props.onReload) return;
  const next = props.onReload();
  dispatch({ type: 'reload', draft: next });
  const live = next.liveBaseline;
  const refreshed = { ...props.initial, provider: live.provider, model: live.model,
    baseUrl: live.baseUrl ?? '', thinkingLevel: live.thinkingLevel,
    showThinking: live.showThinking ? 'on' : 'off',
    liveToolOutput: live.liveToolOutput ? 'on' : 'off',
    maxTokens: live.maxTokens === undefined ? '' : String(live.maxTokens),
    logLevel: live.log?.level ?? props.initial.logLevel,
    ...(live.fast ? fastSettingsFrom(live.fast) : {}),
    ...(live.compaction ? compactionSettingsFrom(live.compaction) : {}),
  } as SettingsValues;
  const nextValues = profileSettingsValues(refreshed, next);
  setInitial(nextValues); setValues(nextValues); setError(undefined); setIndex(0);
  setReloadPending(false);
}

function cancelProfileSettings(props: ProfileSettingsProps, view: ProfileSettingsState,
  reloading = false): void {
  const { persisted, dirty, setReloadPending, setConfirmIndex, dispatch } = view;
  if (persisted) { props.onClose?.(); return; }
  if (!dirty) {
    if (reloading) reloadProfileSettings(props, view);
    else props.onClose?.();
    return;
  }
  setReloadPending(reloading); setConfirmIndex(0);
  dispatch({ type: 'page', page: 'discard-confirm' });
}

function activateRootSetting(props: ProfileSettingsProps, view: ProfileSettingsState): void {
  const { index, count, readError, persisted, dispatch } = view;
  if (index === count - 1) { cancelProfileSettings(props, view, true); return; }
  if (readError || persisted) return;
  if (index < 2) dispatch({ type: 'page', page: 'picker', role: index === 0 ? 'main' : 'fast' });
  else if (index === 2) dispatch({ type: 'page', page: 'manager' });
  else saveProfileSettings(props, view);
}

function useRootSettingsInput(props: ProfileSettingsProps, view: ProfileSettingsState): void {
  const { index, count, field, readError, persisted, values, state, setIndex, setValues } = view;
  useInput((input, key) => {
    if (props.isActive === false) return;
    if (key.escape) { cancelProfileSettings(props, view); return; }
    if (key.ctrl && input === 's') { saveProfileSettings(props, view); return; }
    if (key.upArrow || (key.tab && key.shift)) { setIndex((index - 1 + count) % count); return; }
    if (key.downArrow || key.tab) { setIndex((index + 1) % count); return; }
    if (key.return) { activateRootSetting(props, view); return; }
    if (!field || readError || persisted || key.ctrl || key.meta) return;
    if (field.kind === 'enum') {
      if (!key.leftArrow && !key.rightArrow) return;
      const options = field.options!;
      const at = options.indexOf(String(values[field.key]));
      setValues({ ...values, ...(field.key === 'provider' ? { apiKey: '' } : {}),
        [field.key]: options[(at + (key.leftArrow ? -1 : 1) + options.length) % options.length] });
      return;
    }
    const text = stripPasteFrames(stripEnterFrames(input));
    const value = key.backspace || key.delete
      ? [...String(values[field.key])].slice(0, -1).join('') : String(values[field.key]) + text;
    if (field.key === 'apiKey') registerSecret(value);
    if (key.backspace || key.delete || text) setValues({ ...values, [field.key]: value });
  }, { isActive: state.page === 'root' });
}

function useSettingsConfirmationInput(props: ProfileSettingsProps,
  view: ProfileSettingsState): void {
  const { state, dispatch, confirmIndex, setConfirmIndex, reloadPending, confirming } = view;
  useInput((_input, key) => {
    if (props.isActive === false) return;
    if (key.escape) { dispatch({ type: 'page', page: state.page === 'delete-confirm'
      ? 'manager' : 'root' }); return; }
    if (key.upArrow || key.downArrow || key.leftArrow || key.rightArrow || key.tab) {
      setConfirmIndex((confirmIndex + 1) % 2); return;
    }
    if (!key.return) return;
    if (state.page === 'delete-confirm') {
      dispatch(confirmIndex === 1 ? { type: 'confirm-delete' }
        : { type: 'page', page: 'manager' });
    } else if (confirmIndex === 0) dispatch({ type: 'page', page: 'root' });
    else if (reloadPending) reloadProfileSettings(props, view);
    else props.onClose?.();
  }, { isActive: confirming });
}

function renderSettingsConfirmation(props: ProfileSettingsProps,
  view: ProfileSettingsState): React.ReactElement {
  const { state, library, confirmIndex, glyphs } = view;
  const deleting = state.page === 'delete-confirm';
  const name = library.entries.find((entry) => entry.id === state.deleteId)?.name ?? '';
  const labels = deleting ? ['Cancel', 'Delete'] : ['Continue', 'Discard'];
  return <OverlayFrame {...props}
    title={deleting ? `Delete ${name}?` : 'Discard unsaved changes?'}
    hint="Enter choose | Esc continue" rows={labels
      .map((label, at) => <Text key={label} wrap="truncate" color={props.theme.primary}>
        {confirmIndex === at ? `${glyphs.caret} ` : '  '}{label}
      </Text>)} scrollOffset={confirmIndex} />;
}

function renderProfileSubpage(props: ProfileSettingsProps,
  view: ProfileSettingsState): React.ReactElement | null {
  const { state, library, dispatch, setConfirmIndex } = view;
  if (state.page === 'editor' && state.editor) return <ModelProfileEditor {...props}
    editor={state.editor} users={profileUsers(library, state.editor.original.id)}
    error={state.error} dispatch={dispatch} />;
  if (state.page === 'picker' || state.page === 'manager') return <ModelProfilePicker {...props}
    profiles={library} savedProfiles={state.draft.baseline.modelProfiles} role={state.role}
    customProfile={createCustomProfile(state.draft, state.role)}
    manager={state.page === 'manager'} error={state.error}
    onSelect={(id) => dispatch({ type: 'select', role: state.role, id })}
    onCreate={() => dispatch({ type: 'edit', profile: createCustomProfile(state.draft, state.role),
      bindNew: state.page === 'picker' })}
    onEdit={(profile) => dispatch({ type: 'edit', profile })}
    onDuplicate={(id) => dispatch({ type: 'duplicate', id })}
    onDelete={(id) => { setConfirmIndex(0); dispatch({ type: 'delete', id }); }}
    onCancel={() => dispatch({ type: 'page', page: 'root' })} />;
  return null;
}

function buildRootSettingsRows(props: ProfileSettingsProps,
  view: ProfileSettingsState): React.ReactElement[] {
  const { library, fields, values, persisted, readError, index, glyphs, state } = view;
  const name = (id: string | null) => {
    const entry = library.entries.find((candidate) => candidate.id === id);
    if (!entry) return 'Current custom';
    const missing = !entry.apiKey && !props.apiKeys[entry.provider];
    return `${entry.name}  ${entry.provider}:${entry.model}${missing ? ' [Missing API key]' : ''}`;
  };
  const lines = [`Main profile      ${name(library.mainId)}`,
    `Fast profile      ${name(library.fastId)}`,
    `Manage profiles   ${library.entries.length} saved`,
    ...fields.map((item) => `${item.label.padEnd(18)}${item.key === 'apiKey'
      ? values.apiKey ? 'Configured (replacement)' : props.apiKeys[values.provider]
        ? 'Configured (type to replace)' : '(type to set)'
      : values[item.key] || (item.key === 'maxTokens' ? 'auto' : '(not set)')}`),
    persisted || readError ? 'Save (disabled)' : 'Save settings', 'Reload settings'];
  const rows = lines.map((line, at) => <Text key={at} wrap="truncate"
    color={at === index ? props.theme.accent : props.theme.muted}>
    {at === index ? `${glyphs.caret} ` : '  '}{line}
  </Text>);
  rows.push(<Text key="effective" wrap="truncate" color={props.theme.muted}>
    {effectiveCapLine(values)}
  </Text>);
  const overrides = state.draft.liveBaseline.modelProfileState;
  if (overrides?.main.overriddenFields.length || overrides?.fast.overriddenFields.length) {
    rows.push(<Text key="overrides" wrap="truncate" color={props.theme.muted}>
      Startup overrides active; explicit selection applies now. Restart uses startup overrides.
    </Text>);
  }
  if (props.retrySummary) rows.push(<Text key="retry" wrap="truncate" color={props.theme.muted}>
    API retries: {props.retrySummary}
  </Text>);
  return rows;
}

function ProfileSettingsScreen(props: ProfileSettingsProps): React.ReactElement {
  const view = useProfileSettingsState(props);
  useRootSettingsInput(props, view);
  useSettingsConfirmationInput(props, view);
  if (view.confirming) return renderSettingsConfirmation(props, view);
  const subpage = renderProfileSubpage(props, view);
  if (subpage) return subpage;
  const { error, readError, dirty, persisted, index, offset } = view;
  return <OverlayFrame {...props} rows={buildRootSettingsRows(props, view)} scrollOffset={offset}
    title={error ?? (readError ? 'Cannot read config. Repair with aragon config edit; Reload.'
      : dirty ? 'Settings | Unsaved changes' : 'Settings')}
    hint={persisted ? 'Esc close; restart to apply' : index < 3
      ? 'Enter select/edit | Ctrl+S save | Esc cancel'
      : 'Enter save/action | Ctrl+S save | Esc cancel'} />;
}
