/**
 * Environment + `.env` loading and mapping to config fields.
 *
 * Recognized keys (spec §3.5):
 *   - Provider secrets: ANTHROPIC_API_KEY, OPENAI_API_KEY, GOOGLE_API_KEY /
 *     GEMINI_API_KEY.
 *   - Overrides: ARAGON_PROVIDER, ARAGON_MODEL, ARAGON_BASE_URL, ARAGON_THINKING,
 *     ARAGON_SHOW_THINKING,
 *     ARAGON_MAX_TOKENS (a number, or `auto` / `0` for the per-model ceiling),
 *     ARAGON_THEME, ARAGON_MOUSE, ARAGON_PASTE, ARAGON_PLAN, ARAGON_TEAM,
 *     ARAGON_TEAM_MAX, ARAGON_RETRY, ARAGON_RETRY_MAX, ARAGON_FAST,
 *     ARAGON_FAST_PROVIDER, ARAGON_FAST_MODEL, ARAGON_FAST_BASE_URL,
 *     ARAGON_LOG_LEVEL,
 *     ARAGON_LOG_FILE, ARAGON_LOG_DIR, ARAGON_TRANSCRIPT_RETAIN,
 *     ARAGON_RENDER_GOVERNOR, ARAGON_MAX_RENDER_INTERVAL_MS,
 *     ARAGON_DIFF_RENDER, ARAGON_SYNC_OUTPUT,
 *     ARAGON_UPDATE,
 *     ARAGON_COMPACTION, ARAGON_COMPACTION_THRESHOLD,
 *     ARAGON_COMPACTION_KEEP_TURNS, ARAGON_COMPACTION_SUBAGENTS,
 *     ARAGON_COMPACTION_ARCHIVE.
 *
 * READ ELSEWHERE, ON PURPOSE: `ARAGON_UPDATE_REGISTRY` and `npm_config_registry`
 * are resolved by `update/registry.ts::resolveRegistryUrl`, NOT here, because
 * §3.3 puts them BELOW `config.update.registry` in precedence — the opposite of
 * the env-beats-file rule this file implements. Writing them into `partial`
 * would silently invert that order and make a config-file mirror unreachable on
 * any machine where npm exports its own registry (which is every machine npm
 * runs a script on).
 *
 * NOT here: `ARAGON_HOME`. It is read when `config/app-paths.ts` is first
 * evaluated, which is long before `loadDotenv()` runs, so a `.env` can never
 * supply it. README and §5.2 of the design say so explicitly — otherwise "I set
 * ARAGON_HOME in .env and it did nothing" is an unexplainable bug report.
 */

import { join } from 'node:path';
import process from 'node:process';
import dotenv from 'dotenv';
import { registerSecretsFrom } from '../logging/secret-registry.js';
import { clampLogLevel } from '../logging/levels.js';
import {
  clampContextWindow,
  clampMaxTokens,
  clampTheme,
  clampThinkingLevel,
  isAutoToken,
  parseThresholdInput,
  type PersistedConfig,
} from './schema.js';

/**
 * Load a project `.env` from the given directory into `process.env` (existing
 * process env wins — dotenv never overrides already-set variables).
 */
export function loadDotenv(cwd: string): void {
  dotenv.config({ path: join(cwd, '.env') });
}

/** Provider -> the env vars that may carry its key (first non-empty wins). */
const PROVIDER_ENV_KEYS: Record<string, string[]> = {
  anthropic: ['ANTHROPIC_API_KEY'],
  openai: ['OPENAI_API_KEY'],
  google: ['GOOGLE_API_KEY', 'GEMINI_API_KEY'],
};

function firstEnv(names: string[]): string | undefined {
  for (const name of names) {
    const v = process.env[name];
    if (v && v.trim().length > 0) return v.trim();
  }
  return undefined;
}

export interface EnvConfig {
  /** Non-secret overrides sourced from ARAGON_* env vars. */
  partial: Partial<PersistedConfig>;
  /** Resolved provider -> key from provider env vars. */
  apiKeys: Record<string, string | undefined>;
}

/**
 * Read ARAGON_* overrides and provider secrets from the current environment.
 * Must be called after `loadDotenv()` so `.env` values are visible.
 */
export function readEnvConfig(): EnvConfig {
  const partial: Partial<PersistedConfig> = {};

  const provider = process.env.ARAGON_PROVIDER?.trim();
  if (provider) partial.provider = provider;

  const model = process.env.ARAGON_MODEL?.trim();
  if (model) partial.model = model;

  const baseUrl = process.env.ARAGON_BASE_URL?.trim();
  if (baseUrl) partial.baseUrl = baseUrl;

  if (process.env.ARAGON_THINKING) {
    partial.thinkingLevel = clampThinkingLevel(process.env.ARAGON_THINKING.trim(), 'off');
  }

  const showThinking = process.env.ARAGON_SHOW_THINKING?.trim().toLowerCase();
  if (showThinking !== undefined && showThinking.length > 0) {
    partial.showThinking =
      showThinking === '1' ||
      showThinking === 'true' ||
      showThinking === 'on' ||
      showThinking === 'yes';
  }

  // The same positive-list parse as its neighbour, and the same "a non-empty
  // value is an ANSWER" rule -- which is what lets `ARAGON_LIVE_TOOL_OUTPUT=0`
  // turn a default-ON feature off (agent-activity-presentation-live §4.1).
  const liveToolOutput = process.env.ARAGON_LIVE_TOOL_OUTPUT?.trim().toLowerCase();
  if (liveToolOutput !== undefined && liveToolOutput.length > 0) {
    partial.liveToolOutput =
      liveToolOutput === '1' ||
      liveToolOutput === 'true' ||
      liveToolOutput === 'on' ||
      liveToolOutput === 'yes';
  }

  // `auto` / `0` mean AUTO (`null`); a number is clamped to the accepted range.
  // Anything else is LEFT ABSENT rather than written as `null`: a typo here used
  // to become AUTO and silently discard the number in the config file under it,
  // which is the opposite of what the user asked for.
  const maxTokens = process.env.ARAGON_MAX_TOKENS?.trim();
  if (maxTokens !== undefined && maxTokens.length > 0) {
    if (isAutoToken(maxTokens)) {
      partial.maxTokens = null;
    } else {
      const clamped = clampMaxTokens(maxTokens);
      if (clamped !== undefined) partial.maxTokens = clamped;
    }
  }

  // `auto` / `0` mean AUTO (`null`); a number is clamped. Anything else is LEFT
  // ABSENT rather than written as `null`, the rule `ARAGON_MAX_TOKENS` states one
  // block up: a typo must not silently discard the number in the config file.
  const contextWindow = process.env.ARAGON_CONTEXT_WINDOW?.trim();
  if (contextWindow !== undefined && contextWindow.length > 0) {
    if (isAutoToken(contextWindow)) {
      partial.contextWindow = null;
    } else {
      const clamped = clampContextWindow(contextWindow, null);
      if (clamped !== null) partial.contextWindow = clamped;
    }
  }

  if (process.env.ARAGON_THEME) {
    partial.theme = clampTheme(process.env.ARAGON_THEME.trim(), 'auto');
  }

  // a config file is reachable (containers, SSH, being spawned by another tool).

  const mouse = process.env.ARAGON_MOUSE?.trim().toLowerCase();
  if (mouse !== undefined && mouse.length > 0) {
    partial.mouse = mouse === '1' || mouse === 'true' || mouse === 'on' || mouse === 'yes';
  }

  // ARAGON_MOUSE_SELECT=0 turns drag-select off while leaving the wheel alone —
  // the third rung of the mouse ladder (`--no-mouse` is the first two). Parsed by
  // the POSITIVE list, exactly as its neighbour above is.
  const mouseSelect = process.env.ARAGON_MOUSE_SELECT?.trim().toLowerCase();
  if (mouseSelect !== undefined && mouseSelect.length > 0) {
    partial.mouseSelect =
      mouseSelect === '1' ||
      mouseSelect === 'true' ||
      mouseSelect === 'on' ||
      mouseSelect === 'yes';
  }

  // ARAGON_PASTE=0 turns paste recognition off, which is the documented one-env
  // revert to v0.6.3 input handling (tui-paste-handling section 7.2). Parsed by
  // the POSITIVE list, exactly as its two neighbours above are.
  const paste = process.env.ARAGON_PASTE?.trim().toLowerCase();
  if (paste !== undefined && paste.length > 0) {
    partial.paste = paste === '1' || paste === 'true' || paste === 'on' || paste === 'yes';
  }

  // ARAGON_SCROLL_RESUME_MS=<n> — idle delay before a paused viewport returns to
  // the newest line; `0` disables auto-resume. THE ONLY CHANNEL BESIDES THE
  // CONFIG FILE, because §6.1 gives this key no CLI flag on purpose. `load.ts`
  // clamps it to [0, 120000]; a non-numeric value is LEFT ABSENT rather than
  // written, so a typo falls through to the config file underneath instead of
  // silently replacing it (the rule `ARAGON_MAX_TOKENS` above already follows).
  const scrollResume = process.env.ARAGON_SCROLL_RESUME_MS?.trim();
  if (scrollResume !== undefined && scrollResume.length > 0) {
    const n = Number.parseInt(scrollResume, 10);
    if (Number.isFinite(n) && n >= 0) partial.scrollResumeMs = n;
  }

  const plan = process.env.ARAGON_PLAN?.trim().toLowerCase();
  if (plan !== undefined && plan.length > 0) {
    partial.planModeDefault = plan === '1' || plan === 'true' || plan === 'on' || plan === 'yes';
  }

  // ARAGON_SKILLS=0 is the kill switch for the whole skill subsystem; the other
  // two skill env vars (ARAGON_SKILLS_PATH, ARAGON_SKILLS_DISABLED) are read where
  // they are used — the search-root resolver and the service respectively —
  // because neither maps onto a single persisted field.
  const skills = process.env.ARAGON_SKILLS?.trim().toLowerCase();
  if (skills !== undefined && skills.length > 0) {
    partial.skills = {
      ...(partial.skills ?? {}),
      enabled: !(skills === '0' || skills === 'false' || skills === 'off' || skills === 'no'),
    } as PersistedConfig['skills'];
  }

  const team = process.env.ARAGON_TEAM?.trim().toLowerCase();
  const teamMax = process.env.ARAGON_TEAM_MAX?.trim();
  if ((team !== undefined && team.length > 0) || (teamMax !== undefined && teamMax.length > 0)) {
    const section: Partial<PersistedConfig['team']> = {};
    if (team !== undefined && team.length > 0) {
      section.enabled = team === '1' || team === 'true' || team === 'on' || team === 'yes';
    }
    if (teamMax !== undefined && teamMax.length > 0) {
      const parsed = Number.parseInt(teamMax, 10);
      // Left ABSENT when unparseable rather than written as a default, so the
      // config file can still win. A resolved default here would make the env
      // var look permanently supplied.
      if (Number.isFinite(parsed) && parsed > 0) section.maxSubagents = parsed;
    }
    // A PARTIAL section, safe only because every consumer deep-merges it — the
    // same contract `partial.skills` and `partial.log` rely on.
    if (Object.keys(section).length > 0) partial.team = section as PersistedConfig['team'];
  }

  const todo = process.env.ARAGON_TODO?.trim().toLowerCase();
  const todoFollow = process.env.ARAGON_TODO_FOLLOW?.trim().toLowerCase();
  if ((todo !== undefined && todo.length > 0) ||
      (todoFollow !== undefined && todoFollow.length > 0)) {
    // Keyed by `TodoConfig` but VALUED `unknown`, which is what lets the mode be
    // written through unvalidated (below) while still failing to compile if a
    // future key is misspelled.
    const section: Partial<Record<keyof PersistedConfig['todo'], unknown>> = {};
    if (todo !== undefined && todo.length > 0) {
      section.enabled = todo === '1' || todo === 'true' || todo === 'on' || todo === 'yes';
    }
    // Written through unvalidated: `clampTodoConfig` clamps an unrecognized mode
    // to the default rather than rejecting it, so validating here would be a
    // second gate that can disagree with the first.
    if (todoFollow !== undefined && todoFollow.length > 0) {
      section.followThrough = todoFollow;
    }
    // A PARTIAL section, safe only because every consumer deep-merges it — the
    // same contract `partial.skills`, `partial.log` and `partial.team` rely on.
    if (Object.keys(section).length > 0) partial.todo = section as PersistedConfig['todo'];
  }

  const bashBackground = process.env.ARAGON_BASH_BACKGROUND?.trim().toLowerCase();
  const bashAuto = process.env.ARAGON_BASH_AUTO_BACKGROUND?.trim().toLowerCase();
  if ((bashBackground !== undefined && bashBackground.length > 0) ||
      (bashAuto !== undefined && bashAuto.length > 0)) {
    const section: Partial<Record<keyof PersistedConfig['bash'], unknown>> = {};
    if (bashBackground !== undefined && bashBackground.length > 0) {
      section.background =
        bashBackground === '1' ||
        bashBackground === 'true' ||
        bashBackground === 'on' ||
        bashBackground === 'yes';
    }
    if (bashAuto !== undefined && bashAuto.length > 0) {
      section.autoBackground =
        bashAuto === '1' || bashAuto === 'true' || bashAuto === 'on' || bashAuto === 'yes';
    }
    // A PARTIAL section, safe only because every consumer deep-merges it - the
    // same contract `partial.skills`, `partial.log`, `partial.team` and
    // `partial.todo` rely on.
    if (Object.keys(section).length > 0) partial.bash = section as PersistedConfig['bash'];
  }

  const retry = process.env.ARAGON_RETRY?.trim().toLowerCase();
  const retryMax = process.env.ARAGON_RETRY_MAX?.trim();
  if ((retry !== undefined && retry.length > 0) || (retryMax !== undefined && retryMax.length > 0)) {
    const section: Partial<PersistedConfig['retry']> = {};
    if (retry !== undefined && retry.length > 0) {
      section.enabled = retry === '1' || retry === 'true' || retry === 'on' || retry === 'yes';
    }
    if (retryMax !== undefined && retryMax.length > 0) {
      const parsed = Number.parseInt(retryMax, 10);
      if (Number.isFinite(parsed) && parsed >= 0) section.maxRetries = parsed;
    }
    // A PARTIAL section, safe only because every consumer deep-merges it — the
    // same contract `partial.skills` / `partial.log` / `partial.team` rely on.
    if (Object.keys(section).length > 0) partial.retry = section as PersistedConfig['retry'];
  }

  const fast = process.env.ARAGON_FAST?.trim().toLowerCase();
  const fastProvider = process.env.ARAGON_FAST_PROVIDER?.trim();
  const fastModel = process.env.ARAGON_FAST_MODEL?.trim();
  const fastBaseUrl = process.env.ARAGON_FAST_BASE_URL?.trim();
  if (
    (fast !== undefined && fast.length > 0) ||
    (fastProvider !== undefined && fastProvider.length > 0) ||
    (fastModel !== undefined && fastModel.length > 0) ||
    (fastBaseUrl !== undefined && fastBaseUrl.length > 0)
  ) {
    const section: Partial<PersistedConfig['fast']> = {};
    if (fast !== undefined && fast.length > 0) {
      section.enabled = fast === '1' || fast === 'true' || fast === 'on' || fast === 'yes';
    }
    if (fastProvider !== undefined && fastProvider.length > 0) section.provider = fastProvider;
    if (fastModel !== undefined && fastModel.length > 0) section.model = fastModel;
    if (fastBaseUrl !== undefined && fastBaseUrl.length > 0) section.baseUrl = fastBaseUrl;
    // A PARTIAL section, safe only because every consumer deep-merges it — the
    // same contract the four sections above rely on.
    if (Object.keys(section).length > 0) partial.fast = section as PersistedConfig['fast'];
  }

  const compaction = process.env.ARAGON_COMPACTION?.trim().toLowerCase();
  const compactionThreshold = process.env.ARAGON_COMPACTION_THRESHOLD?.trim();
  const compactionKeepTurns = process.env.ARAGON_COMPACTION_KEEP_TURNS?.trim();
  // The two hardening kill switches (context-auto-compaction-hardening §4.3).
  // They pass the same test the three above do: both name a behaviour that a
  // container or an automated harness may need to switch off with no flag and no
  // config file in reach - sub-agent compaction because it changes what a
  // dispatch costs, and the archive because it writes conversation content to
  // disk in an environment that may not permit it.
  const compactionSubagents = process.env.ARAGON_COMPACTION_SUBAGENTS?.trim().toLowerCase();
  const compactionArchive = process.env.ARAGON_COMPACTION_ARCHIVE?.trim().toLowerCase();
  const positive = (v: string): boolean => v === '1' || v === 'true' || v === 'on' || v === 'yes';
  if (
    (compaction !== undefined && compaction.length > 0) ||
    (compactionThreshold !== undefined && compactionThreshold.length > 0) ||
    (compactionKeepTurns !== undefined && compactionKeepTurns.length > 0) ||
    (compactionSubagents !== undefined && compactionSubagents.length > 0) ||
    (compactionArchive !== undefined && compactionArchive.length > 0)
  ) {
    const section: Partial<PersistedConfig['compaction']> = {};
    if (compaction !== undefined && compaction.length > 0) {
      section.enabled = positive(compaction);
    }
    if (compactionSubagents !== undefined && compactionSubagents.length > 0) {
      section.subagents = positive(compactionSubagents);
    }
    if (compactionArchive !== undefined && compactionArchive.length > 0) {
      section.archive = positive(compactionArchive);
    }
    if (compactionThreshold !== undefined && compactionThreshold.length > 0) {
      // Left ABSENT on a bad value rather than clamped to a default, so a typo
      // falls through to the config layer instead of masking it for the session.
      const parsed = parseThresholdInput(compactionThreshold);
      if (parsed !== null) section.threshold = parsed;
    }
    if (compactionKeepTurns !== undefined && compactionKeepTurns.length > 0) {
      const n = Number.parseInt(compactionKeepTurns, 10);
      if (Number.isFinite(n) && n > 0) section.keepRecentTurns = n;
    }
    // A PARTIAL section, safe only because every consumer deep-merges it — the
    // same contract the five sections above rely on.
    if (Object.keys(section).length > 0) {
      partial.compaction = section as PersistedConfig['compaction'];
    }
  }

  // ARAGON_UPDATE=0|off|false turns auto-update off; `notify` reports without
  // installing; 1|on|true|yes turns it on (cli-auto-update §4.2).
  //
  // A TRI-STATE, so it is parsed by an EXPLICIT POSITIVE LIST PER OUTCOME rather
  // than by the boolean positive list its neighbours use — and emphatically not
  // by `envBool` below, whose NEGATIVE list would resolve `ARAGON_UPDATE=disable`
  // to `true`.
  //
  // ANYTHING UNRECOGNISED IS LEFT ABSENT, which is the invariant this file
  // states three times over (`ARAGON_TEAM_MAX`, `ARAGON_RETRY_MAX`,
  // `ARAGON_MAX_TOKENS`): a value that resolves to a default looks PERMANENTLY
  // SUPPLIED, and the config file underneath can then never win again. For a
  // kill switch that is the worst possible failure — `ARAGON_UPDATE=disabled`
  // would read as "on" while the user believes they turned it off.
  //
  // `ARAGON_TODO_FOLLOW` is the tri-state precedent: the recognised string is
  // written through and `clampUpdateConfig` stays the single gate, so there is
  // never a second validator that can disagree with the first.
  const update = process.env.ARAGON_UPDATE?.trim().toLowerCase();
  if (update !== undefined && update.length > 0) {
    const mode =
      update === '0' || update === 'false' || update === 'off' || update === 'no'
        ? 'off'
        : update === 'notify'
        ? 'notify'
        : update === '1' || update === 'true' || update === 'on' || update === 'yes'
        ? 'auto'
        : undefined;
    if (mode !== undefined) {
      partial.update = { mode } as PersistedConfig['update'];
    }
  }

  const retain = process.env.ARAGON_TRANSCRIPT_RETAIN?.trim();
  if (retain !== undefined && retain.length > 0) {
    const parsed = Number.parseInt(retain, 10);
    if (Number.isFinite(parsed) && parsed > 0) partial.transcriptRetain = parsed;
  }

  const governor = process.env.ARAGON_RENDER_GOVERNOR?.trim().toLowerCase();
  if (governor !== undefined && governor.length > 0) {
    partial.renderGovernor =
      governor === '1' || governor === 'true' || governor === 'on' || governor === 'yes';
  }

  const renderInterval = process.env.ARAGON_MAX_RENDER_INTERVAL_MS?.trim();
  if (renderInterval !== undefined && renderInterval.length > 0) {
    const parsed = Number.parseInt(renderInterval, 10);
    if (Number.isFinite(parsed) && parsed > 0) partial.maxRenderIntervalMs = parsed;
  }

  const diffRender = process.env.ARAGON_DIFF_RENDER?.trim().toLowerCase();
  if (diffRender !== undefined && diffRender.length > 0) {
    partial.diffRender =
      diffRender === '1' || diffRender === 'true' || diffRender === 'on' || diffRender === 'yes';
  }

  const syncOutput = process.env.ARAGON_SYNC_OUTPUT?.trim().toLowerCase();
  if (syncOutput !== undefined && syncOutput.length > 0) {
    partial.syncOutput =
      syncOutput === '1' || syncOutput === 'true' || syncOutput === 'on' || syncOutput === 'yes';
  }

  const log = readEnvLogConfig();
  if (log) partial.log = log as PersistedConfig['log'];

  const apiKeys: Record<string, string | undefined> = {};
  for (const [prov, names] of Object.entries(PROVIDER_ENV_KEYS)) {
    apiKeys[prov] = firstEnv(names);
  }

  // Registration site 2 (§4.4.3). A key that only ever lives in the environment
  // never passes through `updatePersistedConfig`, so this is its only chance to
  // reach the redactor's backstop.
  registerSecretsFrom(apiKeys);

  return { partial, apiKeys };
}

/** Interpret `0/false/off/no` as false; anything else non-empty as true. */
function envBool(value: string): boolean {
  const v = value.trim().toLowerCase();
  return !(v === '0' || v === 'false' || v === 'off' || v === 'no');
}

/**
 * Assemble the `log` section from the environment, or `undefined` when the user
 * said nothing about it. Same shape as the `partial.skills` assembly above: a
 * PARTIAL section, safe only because every consumer deep-merges it.
 */
function readEnvLogConfig(): Partial<PersistedConfig['log']> | undefined {
  const out: Partial<PersistedConfig['log']> = {};

  const level = process.env.ARAGON_LOG_LEVEL?.trim();
  if (level) out.level = clampLogLevel(level, 'info');

  const toFile = process.env.ARAGON_LOG_FILE?.trim();
  if (toFile !== undefined && toFile.length > 0) out.toFile = envBool(toFile);

  const dir = process.env.ARAGON_LOG_DIR?.trim();
  if (dir) out.dir = dir;

  return Object.keys(out).length > 0 ? out : undefined;
}

/** Skill names disabled for this run via `ARAGON_SKILLS_DISABLED` (comma-separated). */
export function readEnvDisabledSkills(): string[] {
  const raw = process.env.ARAGON_SKILLS_DISABLED;
  if (!raw || raw.trim().length === 0) return [];
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}
