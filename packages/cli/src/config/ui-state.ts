/**
 * `<home>/state.json` — UI bookkeeping (config-state-separation §4.4).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * WHAT MAY LIVE HERE: UI bookkeeping SCALARS. Counters, and "has this one-shot
 * notice been shown" flags. NOTHING ELSE.
 *
 * Anything carrying user content, and anything that grows with usage, opens its
 * own file. This rule is not a preference — it is the entire reason this module
 * exists. `config.json` became a place where a prompt-by-prompt transcript sat
 * next to the API key precisely because nobody had written a rule like this
 * down, and a file called `state.json` is the most inviting drawer in the
 * codebase (Q-4 / RV-8).
 * ══════════════════════════════════════════════════════════════════════════
 *
 * Nothing here is a preference: none of these fields has a flag, an env var or
 * a `config set` key, and none of them should ever get one. Losing the file
 * costs a composer hint reappearing once.
 *
 * FAILURE POLICY (C2): never throws, exactly like `prompt-history.ts` and
 * `skills/usage.ts`. Writes are immediate rather than debounced (D-7) — the
 * file is one small object, and a debounce would add a flush-on-exit obligation
 * whose failure mode is the counter silently not sticking.
 *
 * NOT the same thing as `migrate-legacy-state.ts`, despite the shared word:
 * that one is the 0.4.x legacy-to-current brand migration and has nothing to do
 * with this file.
 */

import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import process from 'node:process';
import { getHomeRoot, getUiStatePath } from './app-paths.js';

export const UI_STATE_FILENAME = 'state.json';
export const UI_STATE_SCHEMA = 1;

export interface UiState {
  schema: number;
  /** Lifetime submit count; drives the composer hint fade (`HINT_FADE_AFTER`). */
  submitCount: number;
  /**
   * Whether the one-shot "hold Shift to select text" notice has been shown.
   *
   * DELIBERATELY NOT READ BY THE LIVE GATE ANY MORE (tui-selection-and-scroll-
   * follow P1-8). It is kept in the shape so `importLegacyUiState` still has
   * somewhere to put a migrated value and so a file written by 0.6.2 round-trips
   * unchanged; `mouseNoticeVersion` below is what the notice now consults.
   */
  mouseNoticeSeen: boolean;
  /**
   * Which revision of the mouse notice this user has already been shown
   * (`0` = none).
   *
   * A VERSION BESIDE THE BOOLEAN, NOT A BUMPED SCHEMA, and this is the second
   * time this file has had to say so. The audience for the CORRECTED text — "drag
   * to select, releasing copies" — is exactly the set of users who already have
   * `mouseNoticeSeen: true` on disk from the old "hold Shift" text, so a boolean
   * can only say "shown", never "shown WHAT". And bumping `UI_STATE_SCHEMA`, the
   * nearest thing to "bump the key", makes `readFromDisk` discard the WHOLE
   * object: every user's `submitCount` resets and the composer hint un-fades for
   * all of them, to re-show one notice.
   *
   * `vtInputNoticeVersion` below is the precedent, written about this exact
   * situation one feature earlier.
   */
  mouseNoticeVersion: number;
  /**
   * Which revision of the "this Windows console cannot deliver Shift+Tab or the
   * wheel" notice this user has already been shown (`0` = none).
   *
   * A SEPARATE KEY FROM `mouseNoticeSeen`, AND THAT IS THE WHOLE POINT. The
   * people this notice exists for are precisely the ones who have already
   * started aragon, already been shown the mouse notice that does not apply to
   * them, and therefore already have `mouseNoticeSeen: true` on disk. Folding
   * the two would make the fix inert for its entire audience, in silence.
   *
   * A VERSION RATHER THAN A BOOLEAN, for the second turn of that same screw.
   * The predecessor of this field was `vtInputNoticeSeen: boolean`, written by
   * builds whose text knew nothing about `MODE_TOGGLE_KEYS.fallback` — and the
   * audience for the text that DOES name it is, once again, exactly the set of
   * users who already have the old flag set. A boolean can only say "shown",
   * never "shown WHAT", so the only way to reach them without re-showing the
   * notice on every launch is to let the wording carry a number. That old key
   * is deliberately not read: it is absent from the shape below, so a file
   * written by 0.6.1 reads as `0` and replays exactly once.
   *
   * NOT ADDED TO `UI_STATE_SCHEMA`: bumping the schema makes `readFromDisk`
   * discard the whole object, which would reset everyone's submit counter and
   * re-show the mouse notice. A new field simply reads as its default on an
   * older file, which is the behaviour wanted here anyway.
   */
  vtInputNoticeVersion: number;
}

const DEFAULT_UI_STATE: UiState = {
  schema: UI_STATE_SCHEMA,
  submitCount: 0,
  mouseNoticeSeen: false,
  mouseNoticeVersion: 0,
  vtInputNoticeVersion: 0,
};

let memory: UiState | null = null;

/** Non-negative integer or `fallback`; shared by both numeric fields. */
function coerceCount(value: unknown, fallback: number): number {
  const n = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return Math.floor(n);
}

/**
 * Per-field tolerance: one nonsense value must not take the other field with
 * it. A wrong SCHEMA is different — the shape is no longer known, so the whole
 * object falls back (the rule `skills/usage.ts` already follows).
 */
function readFromDisk(): UiState {
  const path = getUiStatePath();
  if (!existsSync(path)) return { ...DEFAULT_UI_STATE };
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as Partial<UiState>;
    if (!parsed || typeof parsed !== 'object') return { ...DEFAULT_UI_STATE };
    if (parsed.schema !== UI_STATE_SCHEMA) return { ...DEFAULT_UI_STATE };
    return {
      schema: UI_STATE_SCHEMA,
      submitCount: coerceCount(parsed.submitCount, DEFAULT_UI_STATE.submitCount),
      mouseNoticeSeen:
        typeof parsed.mouseNoticeSeen === 'boolean'
          ? parsed.mouseNoticeSeen
          : DEFAULT_UI_STATE.mouseNoticeSeen,
      mouseNoticeVersion: coerceCount(
        parsed.mouseNoticeVersion,
        DEFAULT_UI_STATE.mouseNoticeVersion,
      ),
      vtInputNoticeVersion: coerceCount(
        parsed.vtInputNoticeVersion,
        DEFAULT_UI_STATE.vtInputNoticeVersion,
      ),
    };
  } catch {
    return { ...DEFAULT_UI_STATE };
  }
}

/** Read the state, caching it for the life of the process. Never throws. */
export function loadUiState(): UiState {
  if (memory === null) memory = readFromDisk();
  return memory;
}

/**
 * Atomic write: temp file, rename, re-chmod.
 *
 * `mkdirSync` first for the reason spelled out in `prompt-history.ts`: `<home>`
 * is not guaranteed to exist, and without it the counter would silently never
 * persist on a fresh install that also turned file logging off (RV-2).
 * The `chmodSync` matches `store.ts` — rename does not preserve mode on every
 * platform (RV-6).
 */
function writeToDisk(state: UiState): void {
  const path = getUiStatePath();
  const tmp = `${path}.tmp-${process.pid}`;
  try {
    mkdirSync(getHomeRoot(), { recursive: true });
    writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, { encoding: 'utf-8', mode: 0o600 });
    renameSync(tmp, path);
    if (process.platform !== 'win32') chmodSync(path, 0o600);
  } catch {
    try {
      rmSync(tmp, { force: true });
    } catch {
      // Nothing further to try; the value simply stays in memory (C2).
    }
  }
}

function update(patch: Partial<Omit<UiState, 'schema'>>): UiState {
  const next: UiState = { ...loadUiState(), ...patch, schema: UI_STATE_SCHEMA };
  memory = next;
  writeToDisk(next);
  return next;
}

export function readSubmitCount(): number {
  return loadUiState().submitCount;
}

/** Increment, persist, and return the new value. */
export function bumpSubmitCount(): number {
  return update({ submitCount: readSubmitCount() + 1 }).submitCount;
}

export function getMouseNoticeSeen(): boolean {
  return loadUiState().mouseNoticeSeen;
}

export function setMouseNoticeSeen(seen: boolean): void {
  update({ mouseNoticeSeen: seen });
}

/** `0` on a file written before the field existed — see the field's comment. */
export function getMouseNoticeVersion(): number {
  return loadUiState().mouseNoticeVersion;
}

export function setMouseNoticeVersion(version: number): void {
  update({ mouseNoticeVersion: version });
}

/** `0` on a file written before the field existed — see the field's comment. */
export function getVtInputNoticeVersion(): number {
  return loadUiState().vtInputNoticeVersion;
}

export function setVtInputNoticeVersion(version: number): void {
  update({ vtInputNoticeVersion: version });
}

/**
 * Migration-only: fill in fields that are still at their default, and never
 * overwrite a value already here. A second import — after a half-finished
 * migration retries — must not walk the counter backwards.
 */
export function importLegacyUiState(
  patch: Partial<Pick<UiState, 'submitCount' | 'mouseNoticeSeen'>>,
): void {
  const current = loadUiState();
  const next: Partial<Omit<UiState, 'schema'>> = {};
  if (
    patch.submitCount !== undefined &&
    current.submitCount === DEFAULT_UI_STATE.submitCount
  ) {
    next.submitCount = coerceCount(patch.submitCount, DEFAULT_UI_STATE.submitCount);
  }
  if (
    patch.mouseNoticeSeen !== undefined &&
    current.mouseNoticeSeen === DEFAULT_UI_STATE.mouseNoticeSeen
  ) {
    next.mouseNoticeSeen = patch.mouseNoticeSeen === true;
  }
  if (Object.keys(next).length === 0) return;
  update(next);
}

/** Test-only: forget the cached state. */
export function resetUiStateForTests(): void {
  memory = null;
}
