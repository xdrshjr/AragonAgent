/**
 * `aragon config get | list | edit | home`, plus the `log.*`, `team.*`,
 * `retry.*`, `fast.*` and `update.*` branches of `config set`.
 *
 * These live here rather than in `cli.tsx` because `runConfigSet` is already a
 * 21-case switch — well past the complexity ceiling this package writes down —
 * and `cli.tsx` has two other designs queued up against it. `cli.tsx` keeps the
 * wiring; the behaviour is here.
 */

import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, readFileSync } from 'node:fs';
import process from 'node:process';
import {
  getConfigBackupPath,
  getConfigPath,
  getHomeRoot,
  getLogsDir,
  getPromptHistoryPath,
  getUiStatePath,
  isHomeOverridden,
} from './app-paths.js';
import { getHomeMigrationBreadcrumbPath } from './migrate-home.js';
import { loadPersistedConfig, updatePersistedConfig } from './store.js';
import {
  clampFastConfig,
  clampRetryConfig,
  clampCompactionConfig,
  parseThresholdInput,
  clampUpdateConfig,
  coercePositiveInt,
  maskSecret,
  DEFAULT_FAST_CONFIG,
  DEFAULT_RETRY_CONFIG,
  DEFAULT_TEAM_CONFIG,
  DEFAULT_COMPACTION_CONFIG,
  DEFAULT_UPDATE_CONFIG,
  type FastConfig,
  type LogConfig,
  type PersistedConfig,
  type RetryConfig,
  type TeamConfig,
  type CompactionConfig,
  type UpdateConfig,
} from './schema.js';
import { clampLogLevel } from '../logging/levels.js';

/** Config keys under `log.` that `aragon config set` accepts. */
export const LOG_CONFIG_SET_KEYS = [
  'log.level',
  'log.toFile',
  'log.dir',
  'log.maxFileBytes',
  'log.maxFiles',
  'log.redactSecrets',
  'log.previewChars',
] as const;

/**
 * Config keys under `team.` that `aragon config set` accepts (team-subagents
 * §4.3).
 *
 * Handled here rather than in `cli.tsx`'s switch for the reason this module's
 * header already gives about `log.*`: that switch is past this package's
 * complexity ceiling, and a key added to the membership set but forgotten in the
 * switch falls through every case, writes nothing, and still prints
 * `Set team.enabled = false`.
 */
export const TEAM_CONFIG_SET_KEYS = [
  'team.enabled',
  'team.maxSubagents',
  'team.maxConcurrent',
  'team.subagentTimeoutMs',
  'team.dispatchTimeoutMs',
  'team.maxTurnsPerSubagent',
] as const;

/**
 * Config keys under `retry.` that `aragon config set` accepts
 * (llm-api-retry-backoff §8.2).
 *
 * Handled here rather than in `cli.tsx`'s switch for the reason this module's
 * header gives about `log.*` and `team.*`: that switch is past this package's
 * complexity ceiling, and a key added to the membership set but forgotten in the
 * switch falls through every case, writes nothing, and still prints
 * `Set retry.maxRetries = 0`.
 */
export const RETRY_CONFIG_SET_KEYS = [
  'retry.enabled',
  'retry.maxRetries',
  'retry.initialDelayMs',
  'retry.maxDelayMs',
  'retry.multiplier',
  'retry.jitter',
  'retry.respectRetryAfter',
  'retry.maxElapsedMs',
  'retry.onPartialStream',
] as const;

/**
 * Config keys under `fast.` that `aragon config set` accepts (fast-model-tier
 * §4.2).
 *
 * A DEDICATED SETTER RATHER THAN A GENERIC DOTTED WRITER, for the reason the
 * three sets above each record: a generic setter would write `fast` as a FLAT
 * string key (`"fast.model": "haiku"` at the top level of the file), the section
 * would silently never take effect, and `config set` would still print
 * `Set fast.model = haiku`.
 */
export const FAST_CONFIG_SET_KEYS = [
  'fast.enabled',
  'fast.provider',
  'fast.model',
  'fast.baseUrl',
  'fast.thinkingLevel',
  'fast.delegate',
  'fast.review',
  'fast.reviewEveryTurns',
  'fast.reviewContextTurns',
  'fast.reviewMaxChars',
  'fast.reviewMaxPerSession',
] as const;

/**
 * Config keys under `update.` that `aragon config set` accepts (cli-auto-update
 * §4.1).
 *
 * A DEDICATED SETTER RATHER THAN A GENERIC DOTTED WRITER, for the reason the
 * four sets above each record: a generic setter would write `update` as a FLAT
 * string key (`"update.mode": "notify"` at the top level of the file), the
 * section would silently never take effect, and `config set` would still print
 * `Set update.mode = notify`.
 */
export const UPDATE_CONFIG_SET_KEYS = [
  'update.mode',
  'update.checkIntervalMs',
  'update.registry',
  'update.distTag',
] as const;

/**
 * Config keys under `compaction.` that `aragon config set` accepts
 * (context-auto-compaction §4.2).
 *
 * A DEDICATED SETTER RATHER THAN A GENERIC DOTTED WRITER, for the reason the
 * five sets above each record: a generic setter would write `compaction` as a
 * FLAT string key (`"compaction.enabled": "false"` at the top level of the
 * file), the section would silently never take effect, and `config set` would
 * still print `Set compaction.enabled = false`.
 *
 * THIS SET IS WHAT MAKES THE KILL SWITCH REACHABLE FROM A SCRIPT. `config list`
 * enumerates the section dynamically and so shows these keys whether they are
 * here or not; `config set` does not, so without this block
 * `aragon config set compaction.enabled false` fails with "Unknown config key"
 * while the key is visibly listed one command over. Manual-test row 9 — the
 * persisted-off-survives-a-flagless-run check — runs exactly that command.
 */
export const COMPACTION_CONFIG_SET_KEYS = [
  'compaction.enabled',
  'compaction.threshold',
  'compaction.warnThreshold',
  'compaction.keepRecentTurns',
  'compaction.useFastTier',
  'compaction.onFailure',
  'compaction.subagents',
  'compaction.archive',
] as const;

function isTrue(value: string): boolean {
  return value === 'true' || value === '1';
}

/**
 * Translate a `log.*` dotted key into a patch, or `null` for anything else.
 *
 * The patch is a PARTIAL `log` section, which is safe only because
 * `updatePersistedConfig` deep-merges that section — with a shallow merge each
 * of these would silently reset every other log setting, `redactSecrets`
 * included.
 */
export function applyLogConfigSet(key: string, value: string): Partial<PersistedConfig> | null {
  const patch = (log: Partial<LogConfig>): Partial<PersistedConfig> =>
    ({ log } as Partial<PersistedConfig>);

  switch (key) {
    case 'log.level':
      return patch({ level: clampLogLevel(value, 'info') });
    case 'log.toFile':
      return patch({ toFile: isTrue(value) });
    case 'log.dir':
      return patch({ dir: value.trim() });
    case 'log.maxFileBytes':
      return patch({ maxFileBytes: coercePositiveInt(value, 5 * 1024 * 1024) });
    case 'log.maxFiles':
      return patch({ maxFiles: coercePositiveInt(value, 10) });
    case 'log.redactSecrets':
      return patch({ redactSecrets: isTrue(value) });
    case 'log.previewChars':
      return patch({ previewChars: Number.parseInt(value, 10) });
    default:
      return null;
  }
}

/**
 * Translate a `team.*` dotted key into a patch, or `null` for anything else.
 *
 * The patch is a PARTIAL `team` section, safe only because
 * `updatePersistedConfig` deep-merges that section — with a shallow merge,
 * setting the fan-out width would silently reset every timeout in the section.
 *
 * Values are CLAMPED rather than rejected, exactly like `theme` and
 * `skills.integrity`: hardening only the read path leaves a bad value on disk
 * that reverts to the default on every launch, which presents as "my setting
 * won't stick". `clampTeamConfig` is the one gate both directions pass through.
 */
export function applyTeamConfigSet(key: string, value: string): Partial<PersistedConfig> | null {
  const patch = (team: Partial<TeamConfig>): Partial<PersistedConfig> =>
    ({ team } as Partial<PersistedConfig>);

  switch (key) {
    case 'team.enabled':
      return patch({ enabled: isTrue(value) });
    case 'team.maxSubagents':
      return patch({ maxSubagents: coercePositiveInt(value, DEFAULT_TEAM_CONFIG.maxSubagents) });
    case 'team.maxConcurrent':
      return patch({ maxConcurrent: coercePositiveInt(value, DEFAULT_TEAM_CONFIG.maxConcurrent) });
    case 'team.subagentTimeoutMs':
      return patch({
        subagentTimeoutMs: coercePositiveInt(value, DEFAULT_TEAM_CONFIG.subagentTimeoutMs),
      });
    case 'team.dispatchTimeoutMs':
      return patch({
        dispatchTimeoutMs: coercePositiveInt(value, DEFAULT_TEAM_CONFIG.dispatchTimeoutMs),
      });
    case 'team.maxTurnsPerSubagent':
      return patch({
        maxTurnsPerSubagent: coercePositiveInt(value, DEFAULT_TEAM_CONFIG.maxTurnsPerSubagent),
      });
    default:
      return null;
  }
}

/**
 * Translate a `retry.*` dotted key into a patch, or `null` for anything else.
 *
 * The patch is a PARTIAL `retry` section, safe only because
 * `updatePersistedConfig` deep-merges that section — with a shallow merge,
 * setting the retry count would silently reset `respectRetryAfter` and `jitter`.
 *
 * `maxRetries` GOES THROUGH `clampRetryConfig`, NOT `coercePositiveInt`, and that
 * is not a style choice (R-16): `coercePositiveInt` returns its fallback for
 * `n <= 0`, so `config set retry.maxRetries 0` would write **10** — the maximum
 * instead of the kill switch, silently. The whole section is routed through the
 * one gate so no key here can pick up the wrong coercion later; the caller echoes
 * the STORED value, which is what makes an out-of-range input visible.
 */
export function applyRetryConfigSet(key: string, value: string): Partial<PersistedConfig> | null {
  const patch = (retry: Partial<RetryConfig>): Partial<PersistedConfig> =>
    ({ retry } as Partial<PersistedConfig>);
  const clampOne = <K extends keyof RetryConfig>(field: K): Partial<RetryConfig> => {
    const merged = clampRetryConfig({ ...DEFAULT_RETRY_CONFIG, [field]: value });
    return { [field]: merged[field] } as Partial<RetryConfig>;
  };

  switch (key) {
    case 'retry.enabled':
      return patch({ enabled: isTrue(value) });
    case 'retry.maxRetries':
      return patch(clampOne('maxRetries'));
    case 'retry.initialDelayMs':
      return patch(clampOne('initialDelayMs'));
    case 'retry.maxDelayMs':
      return patch(clampOne('maxDelayMs'));
    case 'retry.multiplier':
      return patch(clampOne('multiplier'));
    case 'retry.jitter':
      return patch({ jitter: isTrue(value) });
    case 'retry.respectRetryAfter':
      return patch({ respectRetryAfter: isTrue(value) });
    case 'retry.maxElapsedMs':
      return patch(clampOne('maxElapsedMs'));
    case 'retry.onPartialStream':
      return patch({ onPartialStream: isTrue(value) });
    default:
      return null;
  }
}

/**
 * Translate a `fast.*` dotted key into a patch, or `null` for anything else.
 *
 * The patch is a PARTIAL `fast` section, safe only because
 * `updatePersistedConfig` deep-merges that section — with a shallow merge,
 * setting the cadence would silently switch the whole tier off (R-10).
 *
 * EVERY NUMERIC AND ENUM KEY ROUTES THROUGH `clampFastConfig`, not through
 * `coercePositiveInt` or a local parse, for the reason `applyRetryConfigSet`
 * records: one gate for both directions means no key here can pick up a
 * different coercion later, and `config set fast.reviewEveryTurns 400` writes
 * the clamped 50 while the caller echoes the STORED value (AC-13).
 */
export function applyFastConfigSet(key: string, value: string): Partial<PersistedConfig> | null {
  const patch = (fast: Partial<FastConfig>): Partial<PersistedConfig> =>
    ({ fast } as Partial<PersistedConfig>);
  const clampOne = <K extends keyof FastConfig>(field: K): Partial<FastConfig> => {
    const merged = clampFastConfig({ ...DEFAULT_FAST_CONFIG, [field]: value });
    return { [field]: merged[field] } as Partial<FastConfig>;
  };

  switch (key) {
    case 'fast.enabled':
      return patch({ enabled: isTrue(value) });
    case 'fast.provider':
      return patch(clampOne('provider'));
    case 'fast.model':
      return patch(clampOne('model'));
    case 'fast.baseUrl':
      return patch(clampOne('baseUrl'));
    case 'fast.thinkingLevel':
      return patch(clampOne('thinkingLevel'));
    case 'fast.delegate':
      return patch({ delegate: isTrue(value) });
    case 'fast.review':
      return patch({ review: isTrue(value) });
    case 'fast.reviewEveryTurns':
      return patch(clampOne('reviewEveryTurns'));
    case 'fast.reviewContextTurns':
      return patch(clampOne('reviewContextTurns'));
    case 'fast.reviewMaxChars':
      return patch(clampOne('reviewMaxChars'));
    case 'fast.reviewMaxPerSession':
      return patch(clampOne('reviewMaxPerSession'));
    default:
      return null;
  }
}

/**
 * Translate an `update.*` dotted key into a patch, or `null` for anything else.
 *
 * The patch is a PARTIAL `update` section, safe only because
 * `updatePersistedConfig` deep-merges that section — with a shallow merge,
 * setting the mode would silently reset the interval, the registry mirror and
 * the dist-tag (C-4 / R-10).
 *
 * EVERY KEY ROUTES THROUGH `clampUpdateConfig`, not through a local parse, for
 * the reason `applyRetryConfigSet` and `applyFastConfigSet` both record: one
 * gate for both directions means no key here can pick up a different coercion
 * later, and `config set update.checkIntervalMs 5` writes the clamped 900000
 * while the caller echoes the STORED value (AC-20).
 */
export function applyUpdateConfigSet(key: string, value: string): Partial<PersistedConfig> | null {
  const patch = (update: Partial<UpdateConfig>): Partial<PersistedConfig> =>
    ({ update } as Partial<PersistedConfig>);
  const clampOne = <K extends keyof UpdateConfig>(field: K): Partial<UpdateConfig> => {
    const merged = clampUpdateConfig({ ...DEFAULT_UPDATE_CONFIG, [field]: value });
    return { [field]: merged[field] } as Partial<UpdateConfig>;
  };

  switch (key) {
    case 'update.mode':
      return patch(clampOne('mode'));
    case 'update.checkIntervalMs':
      return patch(clampOne('checkIntervalMs'));
    case 'update.registry':
      return patch(clampOne('registry'));
    case 'update.distTag':
      return patch(clampOne('distTag'));
    default:
      return null;
  }
}

/**
 * Translate a `compaction.*` dotted key into a patch, or `null` for anything
 * else (context-auto-compaction §4.2).
 *
 * EVERY KEY ROUTES THROUGH `clampCompactionConfig`, not through a local parse,
 * for the reason `applyRetryConfigSet`, `applyFastConfigSet` and
 * `applyUpdateConfigSet` all record: one gate for both directions means no key
 * here can pick up a different coercion later, and `config set
 * compaction.threshold 0.2` writes the clamped `0.5` while the caller echoes the
 * STORED value.
 *
 * `threshold` and `warnThreshold` additionally accept a PERCENTAGE, because that
 * is the unit the status bar shows and `/compact threshold` accepts.
 *
 * A VALUE THE PARSER REJECTS RESOLVES TO THE DEFAULT, NOT TO THE CURRENT SETTING
 * — the same thing `config set retry.maxRetries banana` does, because `clampOne`
 * merges the field onto `DEFAULT_COMPACTION_CONFIG` before clamping it. That is
 * the house behaviour and it is not silent: `cli.tsx` echoes the STORED value, so
 * a typo prints the number that was actually written rather than the one that was
 * typed. Unlike the settings screen and `/compact threshold`, both of which
 * genuinely ignore an unparseable value, this surface has no third state.
 */
export function applyCompactionConfigSet(
  key: string,
  value: string,
): Partial<PersistedConfig> | null {
  const patch = (compaction: Partial<CompactionConfig>): Partial<PersistedConfig> =>
    ({ compaction } as Partial<PersistedConfig>);
  const clampOne = <K extends keyof CompactionConfig>(
    field: K,
    raw: unknown = value,
  ): Partial<CompactionConfig> => {
    const merged = clampCompactionConfig({ ...DEFAULT_COMPACTION_CONFIG, [field]: raw });
    return { [field]: merged[field] } as Partial<CompactionConfig>;
  };

  switch (key) {
    case 'compaction.enabled':
      return patch(clampOne('enabled', isTrue(value)));
    case 'compaction.threshold':
      return patch(clampOne('threshold', parseThresholdInput(value) ?? undefined));
    case 'compaction.warnThreshold':
      return patch(clampOne('warnThreshold', parseThresholdInput(value) ?? undefined));
    case 'compaction.keepRecentTurns':
      return patch(clampOne('keepRecentTurns'));
    case 'compaction.useFastTier':
      return patch(clampOne('useFastTier', isTrue(value)));
    case 'compaction.onFailure':
      return patch(clampOne('onFailure'));
    case 'compaction.subagents':
      return patch(clampOne('subagents', isTrue(value)));
    case 'compaction.archive':
      return patch(clampOne('archive', isTrue(value)));
    default:
      return null;
  }
}

/**
 * `log.redactSecrets false` is the one setting that lets credentials reach the
 * disk. It is command-line-only (there is no settings-screen entry) and it says
 * so out loud, because a user who turns it off and forgets is the user who
 * later pastes a log into an issue.
 */
export function warnIfRedactionDisabled(key: string, value: string): void {
  if (key !== 'log.redactSecrets' || isTrue(value)) return;
  process.stdout.write(
    'WARNING: secret redaction is OFF. API keys may now be written to the log files ' +
      `in ${getLogsDir()}. Re-enable with: aragon config set log.redactSecrets true\n`,
  );
}

// ---------------------------------------------------------------------------
// get / list
// ---------------------------------------------------------------------------

/** Every secret is masked wherever it is printed, `--json` included (R-12). */
function maskConfig(config: PersistedConfig): Record<string, unknown> {
  const apiKeys: Record<string, string> = {};
  for (const [provider, key] of Object.entries(config.apiKeys)) {
    apiKeys[provider] = maskSecret(key);
  }
  return { ...config, apiKeys };
}

/**
 * The human-readable label for a value whose raw form would mislead, or
 * `undefined` to leave the caller's own formatting alone.
 *
 * `maxTokens: null` is AUTO, not "unset". Printing a bare `null` reads as a
 * missing setting and sends the user looking for a bug that is not there.
 * `get` and `list` format everything else differently (unquoted vs. JSON), so
 * this deliberately overrides one case rather than replacing both renderers.
 */
function displayOverride(key: string, value: unknown): string | undefined {
  if (key === 'maxTokens' && value === null) return 'auto';
  // The SECOND tri-state key, and it needs this for the same reason (§4.5):
  // `contextWindow: null` is AUTO ("use the model table"), not "unset", and a
  // bare `null` sends the user looking for a bug that is not there.
  if (key === 'contextWindow' && value === null) return 'auto';
  return undefined;
}

/** Resolve a flat or one-level-dotted key against the persisted config. */
function readKey(config: Record<string, unknown>, key: string): unknown {
  const [head, tail] = key.split('.', 2);
  const top = config[head as string];
  if (tail === undefined) return top;
  if (!top || typeof top !== 'object') return undefined;
  return (top as Record<string, unknown>)[tail];
}

export function runConfigGet(key: string): void {
  const masked = maskConfig(loadPersistedConfig());
  const value = readKey(masked, key);
  if (value === undefined) {
    process.stderr.write(`Unknown config key "${key}".\n`);
    process.exitCode = 2;
    return;
  }
  const shown = displayOverride(key, value)
    ?? (typeof value === 'string' ? value : JSON.stringify(value));
  process.stdout.write(`${shown}\n`);
}

export function runConfigList(opts: { json?: boolean } = {}): void {
  const masked = maskConfig(loadPersistedConfig());
  // `--json` stays RAW on purpose: it mirrors the file, and a consumer parsing
  // it must see the `null` that is actually on disk.
  if (opts.json) {
    process.stdout.write(`${JSON.stringify(masked, null, 2)}\n`);
    return;
  }
  for (const [key, value] of Object.entries(masked)) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      for (const [sub, subValue] of Object.entries(value as Record<string, unknown>)) {
        process.stdout.write(`${key}.${sub} = ${JSON.stringify(subValue)}\n`);
      }
      continue;
    }
    process.stdout.write(`${key} = ${displayOverride(key, value) ?? JSON.stringify(value)}\n`);
  }
}

// ---------------------------------------------------------------------------
// edit / home
// ---------------------------------------------------------------------------

function pickEditor(): string {
  const configured = process.env.VISUAL?.trim() || process.env.EDITOR?.trim();
  if (configured) return configured;
  return process.platform === 'win32' ? 'notepad' : 'vi';
}

/**
 * Open `config.json` in the user's editor.
 *
 * Backs the file up FIRST and re-parses afterwards. Hand-editing is a supported
 * workflow here, and a stray comma otherwise resets every setting the next time
 * the CLI starts, with nothing connecting the two events. Telling the user
 * immediately — and naming the backup — turns a confusing regression into a
 * one-command recovery.
 */
export async function runConfigEdit(): Promise<void> {
  const file = getConfigPath();
  if (!existsSync(file)) {
    // Materialise defaults so the editor has something to show.
    updatePersistedConfig({});
  }

  const backup = getConfigBackupPath();
  try {
    copyFileSync(file, backup);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    process.stderr.write(`Could not write ${backup}: ${reason}\n`);
    process.exitCode = 1;
    return;
  }

  const editor = pickEditor();
  // A shell is needed on Windows so an `EDITOR` pointing at a `.cmd` / `.bat`
  // launcher (`code.cmd`, most of them) still runs — but a shell re-splits the
  // command line, so the path has to be quoted or `C:\Users\Jane Doe\...` would
  // reach the editor as two arguments and open two empty buffers.
  const useShell = process.platform === 'win32';
  const target = useShell ? `"${file}"` : file;
  const result = spawnSync(editor, [target], { stdio: 'inherit', shell: useShell });
  if (result.error) {
    process.stderr.write(`Could not launch "${editor}": ${result.error.message}\n`);
    process.exitCode = 1;
    return;
  }

  try {
    JSON.parse(readFileSync(file, 'utf-8'));
    process.stdout.write(`${file} saved.\n`);
  } catch (err) {
    process.stderr.write(
      `${file} is not valid JSON (${err instanceof Error ? err.message : String(err)}).\n` +
        `The previous version is still at ${backup}.\n`,
    );
    process.exitCode = 1;
  }
}

export function runConfigHome(): void {
  process.stdout.write(`${getHomeRoot()}\n`);
  if (isHomeOverridden()) process.stdout.write('  (overridden by ARAGON_HOME)\n');

  // Named here because config.json no longer holds either of them, and a user
  // looking for "where did my prompt history go" has to land somewhere.
  process.stdout.write(`  prompt history: ${getPromptHistoryPath()}\n`);
  process.stdout.write(`  ui state: ${getUiStatePath()}\n`);

  const breadcrumb = getHomeMigrationBreadcrumbPath();
  if (!existsSync(breadcrumb)) return;

  // The env-paths directories are left in place on purpose so reinstalling an
  // older build stays lossless; pointing at them is how the user knows they can
  // be deleted once the new location has proved itself.
  try {
    const parsed = JSON.parse(readFileSync(breadcrumb, 'utf-8')) as {
      from?: { config?: string; data?: string };
    };
    if (parsed.from?.config) process.stdout.write(`  previously: ${parsed.from.config}\n`);
    if (parsed.from?.data) process.stdout.write(`  previously: ${parsed.from.data}\n`);
  } catch {
    // A damaged breadcrumb is a lost diagnostic, not an error worth reporting.
  }
}
