/**
 * Config store — read/atomic-write the user config JSON. Paths come from
 * `app-paths.ts`; nothing here does its own path arithmetic. The file may hold
 * secrets, so it is written with `0600` permissions on POSIX (spec §3.5 / §6.1).
 *
 * There is deliberately no `getConfigDir()` / `getSkillsDir()` here any more.
 * The first would now return the entire user root under a name that says
 * otherwise (see the test-isolation contract in `app-paths.ts`); the second was
 * a second name for `skills/paths.ts::getUserSkillsDir()`, which is precisely
 * the drift the header of that module warns about.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
import process from 'node:process';
import { getConfigPath, getSessionsDir } from './app-paths.js';
import { registerSecretsFrom } from '../logging/secret-registry.js';
import {
  clampBashConfig,
  CONFIG_VERSION,
  DEFAULT_CONFIG,
  clampCompactionConfig,
  clampFastConfig,
  clampLogConfig,
  clampMaxTokens,
  clampRetryConfig,
  clampSkillsConfig,
  clampTeamConfig,
  clampTodoConfig,
  clampContextWindow,
  clampUpdateConfig,
  isAutoToken,
  stripLegacyStateKeys,
  type PersistedConfig,
} from './schema.js';

/**
 * Normalize `maxTokens` for both directions of the config file.
 *
 * `null` MEANS AUTO and must survive untouched; a number is clamped to the
 * accepted range; anything else on a hand-edited file (a string, a float, a
 * negative) becomes AUTO rather than a silent default. Same discipline as
 * `clampSkillsConfig` — read AND write pass through one gate, or a bad value on
 * disk reverts on every launch and presents as "my setting won't stick".
 */
function normalizeMaxTokens(v: unknown): number | null {
  if (v === undefined) return DEFAULT_CONFIG.maxTokens;
  if (v === null || isAutoToken(v)) return null;
  return clampMaxTokens(v) ?? null;
}

/**
 * Normalize `contextWindow` for both directions of the config file.
 *
 * THE SAME TRI-STATE DISCIPLINE AS `maxTokens` ABOVE, and for the same reason:
 * hardening only the read path leaves a bad value on disk that reverts on every
 * launch and presents as "my setting won't stick". `null` is AUTO and survives
 * untouched; `auto` / `0` / an empty string mean AUTO too; a number is clamped;
 * anything else on a hand-edited file becomes AUTO rather than a silent default.
 */
function normalizeContextWindow(v: unknown): number | null {
  if (v === undefined) return DEFAULT_CONFIG.contextWindow;
  if (v === null || isAutoToken(v)) return null;
  return clampContextWindow(v, null);
}

// Re-exported so the many existing importers of `store.js` keep working; the
// definitions live in `app-paths.ts` because they are pure path arithmetic.
export { getConfigPath, getSessionsDir };

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

export interface ConfigFileRead {
  /** Only the keys the user actually wrote, or `null` when absent/unusable. */
  config: Partial<PersistedConfig> | null;
  /** Set when the file EXISTS but could not be parsed. Otherwise undefined. */
  parseError?: string;
}

/**
 * Read the persisted config file.
 *
 * A corrupt config file still must never crash the CLI — the fallback to
 * defaults is unchanged. What changed is that it is no longer SILENT: a single
 * stray comma used to reset the model, theme, timeouts, skills and (as far as
 * the user could tell) the API key, with nothing anywhere saying why. Now the
 * failure travels out of band in `parseError`, and `loadConfig()` turns it into
 * a log record plus one visible line. Hand-editing this file is a supported
 * workflow, so the failure mode had to become visible.
 */
export function readConfigFile(): ConfigFileRead {
  const file = getConfigPath();
  if (!existsSync(file)) return { config: null };
  try {
    const raw = readFileSync(file, 'utf-8');
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object') {
      // Retired layout preference: tolerate old files without restoring a UI mode.
      delete (parsed as Record<string, unknown>).fullscreen;
      return { config: parsed as Partial<PersistedConfig> };
    }
    return { config: null, parseError: `${file} does not contain a JSON object` };
  } catch (err) {
    return {
      config: null,
      parseError: `${file}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

// ---------------------------------------------------------------------------
// Write (atomic + 0600)
// ---------------------------------------------------------------------------

function ensureDir(dir: string): void {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

/**
 * Atomically write the persisted config: write a temp file in the same
 * directory, then rename over the target, then re-apply `0600` on POSIX.
 */
export function writeConfigFile(config: PersistedConfig): void {
  const file = getConfigPath();
  ensureDir(dirname(file));

  const tmp = `${file}.${process.pid}.tmp`;
  const json = `${JSON.stringify(config, null, 2)}\n`;
  writeFileSync(tmp, json, { encoding: 'utf-8', mode: 0o600 });
  renameSync(tmp, file);

  // rename may not preserve mode on every platform; re-chmod on POSIX.
  if (process.platform !== 'win32') {
    try {
      chmodSync(file, 0o600);
    } catch {
      // Non-fatal: permission tightening is best-effort.
    }
  }
}

/**
 * Load the persisted config merged over defaults (a fully-populated object).
 * Unlike `readConfigFile`, this always returns a complete `PersistedConfig`.
 */
export function loadPersistedConfig(): PersistedConfig {
  // STRIP BEFORE THE SPREAD, not after. `partial` is the raw file, so any
  // `promptHistory` / `submitCount` / `mouseNoticeSeen` / `recentModels` left
  // on disk would otherwise ride the spread into `merged` and be written back
  // out by `updatePersistedConfig` — the "I deleted it and it grew back" bug
  // that `stripLegacyStateKeys` exists to make impossible (§4.5).
  const partial = stripLegacyStateKeys(readConfigFile().config ?? {});
  return {
    ...DEFAULT_CONFIG,
    ...partial,
    version: CONFIG_VERSION,
    // Own-property aware, because `null` is the value we need to preserve: a
    // spread cannot tell "the key is absent" (⇒ the default) from "the key is
    // null" (⇒ AUTO), and those are different settings.
    maxTokens: Object.prototype.hasOwnProperty.call(partial, 'maxTokens')
      ? normalizeMaxTokens(partial.maxTokens)
      : DEFAULT_CONFIG.maxTokens,
    // Own-property aware for the reason its neighbour records: `null` is AUTO
    // and a spread cannot tell it from an absent key.
    contextWindow: Object.prototype.hasOwnProperty.call(partial, 'contextWindow')
      ? normalizeContextWindow(partial.contextWindow)
      : DEFAULT_CONFIG.contextWindow,
    apiKeys: { ...DEFAULT_CONFIG.apiKeys, ...(partial.apiKeys ?? {}) },
    // `skills` is the second nested object in this file and needs the same
    // treatment `apiKeys` gets — see the note on updatePersistedConfig below.
    skills: clampSkillsConfig({ ...DEFAULT_CONFIG.skills, ...(partial.skills ?? {}) }),
    // `log` is the third. Same one-level rule, same merge.
    log: clampLogConfig({ ...DEFAULT_CONFIG.log, ...(partial.log ?? {}) }),
    // `team` is the fourth. Same one-level rule, same merge.
    team: clampTeamConfig({ ...DEFAULT_CONFIG.team, ...(partial.team ?? {}) }),
    // `todo` is the fifth. Same one-level rule, same merge — and this line is
    // the READ half of the pair that keeps `/todo panel off` from silently
    // unregistering the tool on the next launch (P0-1 / AC-35).
    todo: clampTodoConfig({ ...DEFAULT_CONFIG.todo, ...(partial.todo ?? {}) }),
    // `retry` is the sixth. The READ half: without it a config file with no
    // `retry` key yields `undefined` and `toRetryPolicy` throws on the value it
    // is handed (R-9 / AC-20).
    retry: clampRetryConfig({ ...DEFAULT_CONFIG.retry, ...(partial.retry ?? {}) }),
    // `fast` is the seventh. Same one-level rule, same merge — and this is the
    // READ half of the pair that keeps `/fast review 8` from silently switching
    // the whole tier off on the next launch (C-3 / R-10).
    fast: clampFastConfig({ ...DEFAULT_CONFIG.fast, ...(partial.fast ?? {}) }),
    // `update` is the eighth. Same one-level rule, same merge — and the READ
    // half is what supplies a whole section to every user whose `config.json`
    // predates auto-update, which is all of them. Without it `config.update.mode`
    // reads `undefined`, and the §3.8 gate tests `!== 'off'`.
    update: clampUpdateConfig({ ...DEFAULT_CONFIG.update, ...(partial.update ?? {}) }),
    // `compaction` is the ninth. Same one-level rule, same merge — and the READ
    // half supplies a whole section to every user whose `config.json` predates
    // this feature, which is all of them. Without it `config.compaction.enabled`
    // reads `undefined`, which is FALSY, so a feature that is `true` by default
    // would arrive off for every existing user.
    compaction: clampCompactionConfig({
      ...DEFAULT_CONFIG.compaction,
      ...(partial.compaction ?? {}),
    }),
    // `bash` is the tenth. Same one-level rule, same merge — and the READ half
    // supplies a whole section to every user whose `config.json` predates
    // background services, which is all of them. Without it
    // `config.bash.background` reads `undefined`, which is FALSY, so a feature
    // that is `true` by default would arrive off for every existing user.
    //
    // A SIBLING OF `compaction`, NOT A KEY INSIDE ITS ARGUMENT. Nesting it one
    // level too deep type-checks — `...DEFAULT_CONFIG` above already supplies a
    // `bash`, so nothing is missing from the return type — and hands
    // `clampCompactionConfig` a key it drops on the floor. The section then
    // reaches callers straight off the shallow `...partial` spread: unclamped,
    // and NOT merged over the defaults, which is verbatim the failure the
    // paragraph above says this line prevents.
    bash: clampBashConfig({ ...DEFAULT_CONFIG.bash, ...(partial.bash ?? {}) }),
  };
}

/**
 * Read the persisted config, apply a patch, write it back atomically, and
 * return the merged result. This is the single write path used by the settings
 * screen and `aragon config set` so env-provided keys never leak into the file.
 *
 * NESTED OBJECTS MUST BE DEEP-MERGED HERE. The top-level spread is shallow, so
 * a patch of `{ skills: { disabled: ['x'] } }` — which is exactly what
 * `/skills disable x` sends — would otherwise REPLACE the whole `skills`
 * section and take `trustedProjectDirs`, `allowedHosts` and `requireApproval`
 * with it. The user's symptom would be that disabling one skill quietly makes
 * every previously-trusted project folder prompt again, with nothing anywhere
 * explaining why.
 *
 * `SkillsConfig` is therefore capped at ONE level of nesting (scalars and
 * string arrays only). A third level requires replacing this hand-written merge
 * with a real deep-merge utility first, or the same bug returns. `LogConfig` is
 * a third SECTION, but it is still one level deep (scalars only), so the same
 * hand-written merge covers it — and it must stay that way for that reason.
 */
export function updatePersistedConfig(patch: Partial<PersistedConfig>): PersistedConfig {
  // Registration site 5. Whatever route a key took to get here, this is the one
  // function that writes it to disk, so this is the last place it can be added
  // to the redactor's backstop before it also starts appearing in log records.
  registerSecretsFrom(patch.apiKeys);

  const current = loadPersistedConfig();
  const merged: PersistedConfig = {
    ...current,
    ...patch,
    version: CONFIG_VERSION,
    // The write half of the gate: without it `config set maxTokens 900000` puts
    // a number on disk that the read path silently rewrites on every launch.
    maxTokens: Object.prototype.hasOwnProperty.call(patch, 'maxTokens')
      ? normalizeMaxTokens(patch.maxTokens)
      : current.maxTokens,
    // The write half of the same gate: without it `config set contextWindow
    // 99999999` puts a number on disk that the read path silently rewrites.
    contextWindow: Object.prototype.hasOwnProperty.call(patch, 'contextWindow')
      ? normalizeContextWindow(patch.contextWindow)
      : current.contextWindow,
    apiKeys: { ...current.apiKeys, ...(patch.apiKeys ?? {}) },
    skills: clampSkillsConfig({ ...current.skills, ...(patch.skills ?? {}) }),
    // Without this line, changing the log level from the settings screen would
    // replace the whole section and quietly revert `maxFiles`, `previewChars`
    // and — worst of all — `redactSecrets`.
    log: clampLogConfig({ ...current.log, ...(patch.log ?? {}) }),
    // The fourth section, and it needs the merge for the same reason: `/team max
    // 4` sends `{ team: { maxSubagents: 4 } }`, which a shallow spread would
    // turn into "changing the fan-out width silently reverted every timeout".
    team: clampTeamConfig({ ...current.team, ...(patch.team ?? {}) }),
    // The fifth section, and its omission is the worst of the five (P0-1):
    // `/todo panel off` sends `{ todo: { panel: false } }`, which a shallow
    // spread turns into "turning the panel off silently unregisters the tool",
    // permanently, from the next launch onward, with nothing anywhere saying so.
    todo: clampTodoConfig({ ...current.todo, ...(patch.todo ?? {}) }),
    // The sixth section. `/retry max 5` sends `{ retry: { maxRetries: 5 } }`,
    // which a shallow spread turns into "changing the retry count silently
    // reverted `respectRetryAfter` and `jitter`" (R-9 / AC-19).
    retry: clampRetryConfig({ ...current.retry, ...(patch.retry ?? {}) }),
    // The seventh section, and THE WRITE HALF IS THE ONE THAT BITES (R-10).
    // `/fast review 8` sends `{ fast: { reviewEveryTurns: 8 } }`; without this
    // line the shallow top-level spread REPLACES the section, `enabled` is
    // written absent, and the tier the user configured yesterday is gone
    // tomorrow with no error anywhere. This package has paid for that once
    // already, in `todo` (P0-1).
    fast: clampFastConfig({ ...current.fast, ...(patch.fast ?? {}) }),
    // The eighth section, and the third time this file records the same trap.
    // `config set update.mode notify` sends `{ update: { mode: 'notify' } }`;
    // without this line the shallow top-level spread REPLACES the section,
    // `checkIntervalMs` / `registry` / `distTag` are written absent, and an
    // enterprise mirror the user configured last month is gone with no error
    // anywhere. AC-20 is the assertion that proves both halves exist.
    update: clampUpdateConfig({ ...current.update, ...(patch.update ?? {}) }),
    // The ninth section, and the fourth time this file records the same trap.
    // `/compact threshold 0.8` sends `{ compaction: { threshold: 0.8 } }`;
    // without this line the shallow top-level spread REPLACES the section,
    // `enabled` is written absent, and a user who deliberately turned compaction
    // OFF finds it back on tomorrow — a feature that spends money on their behalf
    // re-enabling itself because they nudged a threshold.
    compaction: clampCompactionConfig({ ...current.compaction, ...(patch.compaction ?? {}) }),
    // The tenth section, and the fifth time this file records the same trap.
    // A patch carrying only `{ bash: { autoBackground: false } }` — turning the
    // CLASSIFIER off — would, without this line, be spread shallowly over the
    // top level and write `background` absent, silently unregistering
    // `bash_output` / `bash_kill` from the next launch onward.
    bash: clampBashConfig({ ...current.bash, ...(patch.bash ?? {}) }),
  };
  writeConfigFile(merged);
  return merged;
}
