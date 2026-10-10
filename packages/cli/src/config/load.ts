/**
 * Layered config resolution: defaults › user file › env/.env › CLI flags.
 *
 * Also enforces the timeout invariant (spec §3.8 / R1): after merging all
 * layers, `idleTimeout` is re-derived to be strictly ≥ `toolTimeout` so a
 * legitimately long single tool run can never be watchdog-killed.
 */

import process from 'node:process';
import {
  DEFAULT_CONFIG,
  IDLE_TIMEOUT_MARGIN_MS,
  clampAskRounds,
  clampDensity,
  clampHumanTimeout,
  clampCompactionConfig,
  clampLogConfig,
  clampFastConfig,
  clampRetryConfig,
  clampSkillsConfig,
  clampTeamConfig,
  clampTodoConfig,
  clampBashConfig,
  clampUpdateConfig,
  clampTheme,
  clampThinkingLevel,
  clampContextWindow,
  clampMaxTokens,
  clampMaxRenderInterval,
  clampScrollResumeMs,
  clampTranscriptRetain,
  clampTranscriptWindow,
  coercePositiveInt,
  isAutoToken,
  isSkillsToolPolicyMode,
  parseThresholdInput,
  type CliConfig,
  type CompactionConfig,
  type DensityMode,
  type LogConfig,
  type PersistedConfig,
  type FastConfig,
  type RetryConfig,
  type SkillsConfig,
  type TeamConfig,
  type ThemeName,
  type TodoConfig,
  type BashConfig,
  type UpdateConfig,
} from './schema.js';
import { loadDotenv, readEnvConfig, readEnvDisabledSkills } from './env.js';
import { readConfigFile } from './store.js';
import { projectModelProfiles, resolveModelProfileState, resolveModelRoleKey }
  from './model-profile-resolution.js';
import type { ModelRole } from './model-profiles.js';
import { getConfigPath } from './app-paths.js';
import { setHistoryEnabled } from './prompt-history.js';
import { setEntryRetain } from '../agent/entry-limits.js';
import { readSubmitCount } from './ui-state.js';
import { getLogger } from '../logging/logger.js';
import { registerSecret, registerSecretsFrom } from '../logging/secret-registry.js';
import { detectCapabilities, resolveTuiCapabilities } from '../ui/capabilities.js';

/** Interpret a boolean-ish env value (`1/true/on/yes`) as `true`. */
function envFlagTrue(value: string | undefined): boolean {
  if (!value) return false;
  const v = value.trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'on' || v === 'yes';
}

// ---------------------------------------------------------------------------
// CLI flags (already parsed by commander)
// ---------------------------------------------------------------------------

export interface CliFlags {
  provider?: string;
  model?: string;
  baseUrl?: string;
  apiKey?: string;
  thinking?: string;
  maxTokens?: string | number;
  cwd?: string;
  theme?: string;
  color?: boolean;
  confirm?: boolean;
  toolTimeout?: string | number;
  idleTimeout?: string | number;
  /** `--no-exit-transcript` ⇒ false. */
  exitTranscript?: boolean;
  /** `--compact` ⇒ true, `--no-compact` ⇒ false, absent ⇒ undefined. */
  compact?: boolean;
  /** `--hints` ⇒ true, `--no-hints` ⇒ false, absent ⇒ undefined. */
  hints?: boolean;
  /** `--show-thinking` ⇒ true, `--no-show-thinking` ⇒ false, absent ⇒ undefined. */
  showThinking?: boolean;
  /**
   * `--live-tool-output` ⇒ true, `--no-live-tool-output` ⇒ false, absent ⇒ undefined
   * (agent-activity-presentation-live §4.1).
   */
  liveToolOutput?: boolean;
  /** `--mouse` ⇒ true, `--no-mouse` ⇒ false, absent ⇒ undefined. */
  mouse?: boolean;
  /**
   * `--mouse-select` ⇒ true, `--no-mouse-select` ⇒ false, absent ⇒ undefined
   * (tui-selection-and-scroll-follow §6.1).
   *
   * DECLARED AS A PAIR, and carried through `toFlags`, for the reason the
   * `mouse` note above it records: a flag that reaches neither `CliFlags` nor
   * `toFlags` is inert with no compile error and no runtime error. `mouseSelect`
   * is additionally PERSISTED and defaults to `true`, so a lone
   * `--no-mouse-select` would make commander default `opts.mouseSelect` to
   * `true` — indistinguishable from silence, and silently overriding a stored
   * `false` on every run (the `--todo-panel` trap).
   */
  mouseSelect?: boolean;
  /**
   * `--paste` ⇒ true, `--no-paste` ⇒ false, absent ⇒ undefined
   * (tui-paste-handling section 7.1).
   *
   * DECLARED AS A PAIR, and carried through `toFlags`, for the reason the two
   * notes above record. `paste` is additionally PERSISTED and defaults to
   * `true`, so a lone `--no-paste` would make commander default `opts.paste` to
   * `true` -- indistinguishable from silence, and silently overriding a stored
   * `false` on every run that passed no flag at all.
   */
  paste?: boolean;
  /**
   * `--keyboard-enhancement` ⇒ true, `--no-keyboard-enhancement` ⇒ false,
   * absent ⇒ undefined.
   *
   * DECLARED AS A PAIR and carried through `toFlags`, for the reason the
   * `paste` note above records: the key is persisted and defaults to
   * `true`, so a lone negative flag must not read as silence.
   */
  keyboardEnhancement?: boolean;
  /** `--no-skills` ⇒ false. Turns the whole skill subsystem off (§7.5). */
  skills?: boolean;
  /** `--skill <name>` ×N — force Level 2 injection for this run. */
  skill?: string[];
  /** `--skills-yes` — approve skill installs for this run only. */
  skillsYes?: boolean;
  /** `--skill-tool-policy <mode>` — override the tool ceiling for this run (§5.5). */
  skillToolPolicy?: string;
  /** `--plan` ⇒ true, `--no-plan` ⇒ false, absent ⇒ undefined (plan-mode §4.4). */
  plan?: boolean;
  /**
   * `--team` ⇒ true, `--no-team` ⇒ false, absent ⇒ undefined (team-subagents §4.4).
   *
   * BOTH commander forms must be declared and this field must be carried through
   * `toFlags`, or the flag is inert with no compile error and no runtime error —
   * the failure `cli.tsx` already records in its own words for `--no-mouse`
   * (P1-4). Declaring only the negative form additionally makes commander
   * default `opts.team` to `true`, at which point the flag is indistinguishable
   * from its own default and silently overrides `config.json` on EVERY run.
   */
  team?: boolean;
  /** `--team-max <n>` — override `team.maxSubagents` for this run (still clamped). */
  teamMax?: string | number;
  /**
   * `--todo` ⇒ true, `--no-todo` ⇒ false, absent ⇒ undefined
   * (todo-plan-execution §4.3).
   */
  todo?: boolean;
  /**
   * `--todo-panel` ⇒ true, `--no-todo-panel` ⇒ false, absent ⇒ undefined.
   *
   * DECLARED AS A PAIR, like `--todo` above, and unlike `--no-skills` (P1-8).
   * `panel` is a PERSISTED setting, so "not passed" has to stay distinguishable
   * from `true` — otherwise commander's lone-`--no-x` default silently
   * overwrites a config-file `panel: false` on every run that passes no flag at
   * all. `--no-skills` escapes the rule only because nothing needs to
   * distinguish `--skills` from silence.
   */
  todoPanel?: boolean;
  /**
   * `--todo-follow <mode>` — `notify` | `auto` | `off`
   * (todo-plan-followthrough §4.2).
   *
   * A VALUE FLAG, NOT A PAIR, so commander materializes it only when passed and
   * the `!== undefined` rule above applies to its presence rather than to a
   * synthesized `true`. Typed `string` and not `FollowThroughMode`: an
   * unrecognized value is CLAMPED to the default by `clampTodoConfig`, never
   * rejected, which is what every other key in this file does.
   */
  todoFollow?: string;
  /** `--log-level <lv>` — this run only, never persisted. */
  logLevel?: string;
  /** `--log-file` ⇒ true, `--no-log-file` ⇒ false, absent ⇒ undefined. */
  logFile?: boolean;
  /** `--log-dir <dir>` — this run only. */
  logDir?: string;
  /** `--transcript-retain <n>` — the `ViewState` ring cap for this run (L1). */
  transcriptRetain?: string | number;
  /**
   * `--render-governor` ⇒ true, `--no-render-governor` ⇒ false, absent ⇒
   * undefined (L4).
   *
   * DECLARED AS A PAIR for the reason `--todo-panel` records: `renderGovernor`
   * is PERSISTED, so a lone `--no-render-governor` would make commander default
   * `opts.renderGovernor` to `true` and silently overwrite a stored `false` on
   * every run that passed no flag at all.
   */
  renderGovernor?: boolean;
  /** `--max-render-interval <ms>` — the governor ceiling for this run (L4). */
  maxRenderInterval?: string | number;
  /**
   * `--diff-render` ⇒ true, `--no-diff-render` ⇒ false, absent ⇒ undefined
   * (tui-input-flicker-fix §5.2).
   *
   * DECLARED AS A PAIR for the reason `--render-governor` records one field up:
   * `diffRender` is PERSISTED and defaults to `true`, so a lone
   * `--no-diff-render` would make commander default `opts.diffRender` to `true`
   * and silently overwrite a stored `false` on every run that passed no flag at
   * all — i.e. the documented escape hatch would quietly un-set itself.
   */
  diffRender?: boolean;
  /** `--sync-output` ⇒ true, `--no-sync-output` ⇒ false, absent ⇒ undefined (§5.2). */
  syncOutput?: boolean;
  /**
   * `--retry` ⇒ true, `--no-retry` ⇒ false, absent ⇒ undefined
   * (llm-api-retry-backoff §6.2).
   *
   * DECLARED AS A PAIR, for the reason `--todo-panel` and `--render-governor`
   * each record: `retry.enabled` is PERSISTED, so a lone `--no-retry` would make
   * commander default `opts.retry` to `true` and silently overwrite a stored
   * `enabled: false` on every run that passed no flag at all.
   */
  retry?: boolean;
  /**
   * `--retry-max <n>` — override `retry.maxRetries` for this run (still clamped).
   *
   * `0` IS A LEGITIMATE VALUE HERE and is the flag's kill switch, which is why
   * `resolveRetryConfig` tests `!== undefined` rather than truthiness and why the
   * clamp is `clampIntAllowingZero`.
   */
  retryMax?: string | number;
  /**
   * `--fast` ⇒ true, `--no-fast` ⇒ false, absent ⇒ undefined
   * (fast-model-tier §4.3).
   *
   * DECLARED AS A PAIR — MANDATORY (C-9), for the reason `--team`,
   * `--todo-panel`, `--render-governor` and `--retry` each record in turn.
   * `fast.enabled` is PERSISTED and defaults to `false`, so a lone `--fast`
   * would be indistinguishable from silence and the DEFAULT-OFF guarantee (R-d)
   * would depend on a commander detail.
   */
  fast?: boolean;
  /** `--fast-model <id>` — implies nothing about `enabled` on its own. */
  fastModel?: string;
  /** `--fast-provider <id>` — `''` (absent) inherits the main provider. */
  fastProvider?: string;
  /**
   * `--fast-review <n|off>` — `off` sets `fast.review: false`, a number sets
   * `reviewEveryTurns`.
   *
   * ONE FLAG FOR TWO KEYS, and deliberately: "how often" and "at all" are one
   * decision to a user, and a separate `--no-fast-review` would be a fifth pair
   * to keep in step with `toFlags`.
   */
  fastReview?: string;
  /**
   * `--update` ⇒ true, `--no-update` ⇒ false, absent ⇒ undefined
   * (cli-auto-update §4.2).
   *
   * DECLARED AS A PAIR — MANDATORY (C-11), for the reason `--team`,
   * `--todo-panel`, `--render-governor`, `--retry` and `--fast` each record in
   * turn. `update.mode` is PERSISTED and defaults to `'auto'`, so a lone
   * `--no-update` would make commander default `opts.update` to `true` and
   * silently overwrite a stored `off` on every run that passed no flag at all —
   * i.e. the kill switch would un-set itself.
   *
   * A BOOLEAN FOR A TRI-STATE KEY, deliberately: the flag is a SESSION override
   * and `notify` is a preference, not something a user reaches for once. `true`
   * maps to `'auto'`, `false` to `'off'`; `notify` is reachable through the
   * config file and `ARAGON_UPDATE=notify`.
   */
  update?: boolean;
  /**
   * `--compaction` ⇒ true, `--no-compaction` ⇒ false, absent ⇒ undefined
   * (context-auto-compaction §4.3).
   *
   * DECLARED AS A PAIR — MANDATORY (C-13 / P1-5), for the reason `--team`,
   * `--todo-panel`, `--render-governor`, `--retry`, `--fast` and `--update` each
   * record in turn, and this one shares the WORST polarity with `--update`:
   * `compaction.enabled` is PERSISTED and defaults to `true`, so a lone
   * `--no-compaction` would make commander default `opts.compaction` to `true`,
   * at which point the flag is indistinguishable from its own default and
   * silently overwrites a stored `false` on EVERY run that passed no flag at all.
   *
   * That would make R-12's whole mitigation ("one config key restores the old
   * behaviour exactly") FALSE — for a feature that spends the user's money.
   */
  compaction?: boolean;
  /** `--compaction-threshold <0..1|N%>` — session override for `threshold`. */
  compactionThreshold?: string;
}

/**
 * Resolve wheel region routing: flag › env › file › default `true`.
 *
 * Unlike `hints`, mouse routing accepts an environment override. Keep that
 * layer explicit so ARAGON_MOUSE works even when a wrapper owns the arguments.
 */
function resolveMouse(
  flags: CliFlags,
  env: Partial<PersistedConfig>,
  file: Partial<PersistedConfig>,
): boolean {
  if (flags.mouse !== undefined) return flags.mouse;
  if (env.mouse !== undefined) return env.mouse;
  if (file.mouse !== undefined) return file.mouse;
  return DEFAULT_CONFIG.mouse;
}

/**
 * Drag-select: flag › env › file › default `true`
 * (tui-selection-and-scroll-follow §6.1).
 *
 * SHAPED EXACTLY LIKE `resolveMouse` above, deliberately and not by copy-paste
 * habit: it has the same four layers, the same "a persisted `true` is a value
 * and not an opinion" property, and the same env var story. Reaching for the
 * `hints` shape instead — `flags.x !== undefined ? … : file.x ?? DEFAULT`, which
 * reads NO ENV AT ALL — would ship `ARAGON_MOUSE_SELECT` as documented-but-dead,
 * which is precisely the failure the note above `resolveMouse` records for
 * `ARAGON_MOUSE`.
 */
function resolveMouseSelect(
  flags: CliFlags,
  env: Partial<PersistedConfig>,
  file: Partial<PersistedConfig>,
): boolean {
  if (flags.mouseSelect !== undefined) return flags.mouseSelect;
  if (env.mouseSelect !== undefined) return env.mouseSelect;
  if (file.mouseSelect !== undefined) return file.mouseSelect;
  return DEFAULT_CONFIG.mouseSelect;
}

/**
 * Paste handling: flag > env > file > default `true` (tui-paste-handling
 * section 7.4).
 *
 * SHAPED EXACTLY LIKE `resolveMouse` above, for the reason its own note gives:
 * reaching for the `hints` shape -- `flags.x !== undefined ? ... : file.x ??
 * DEFAULT`, which reads NO ENV AT ALL -- would ship `ARAGON_PASTE` as
 * documented-but-dead.
 */
function resolvePaste(
  flags: CliFlags,
  env: Partial<PersistedConfig>,
  file: Partial<PersistedConfig>,
): boolean {
  if (flags.paste !== undefined) return flags.paste;
  if (env.paste !== undefined) return env.paste;
  if (file.paste !== undefined) return file.paste;
  return DEFAULT_CONFIG.paste;
}

/**
 * Keyboard enhancement: flag > env > file > default `true`. Shaped exactly
 * like `resolvePaste` above, for the reason its own note gives.
 */
function resolveKeyboardEnhancement(
  flags: CliFlags,
  env: Partial<PersistedConfig>,
  file: Partial<PersistedConfig>,
): boolean {
  if (flags.keyboardEnhancement !== undefined) return flags.keyboardEnhancement;
  if (env.keyboardEnhancement !== undefined) return env.keyboardEnhancement;
  if (file.keyboardEnhancement !== undefined) return file.keyboardEnhancement;
  return DEFAULT_CONFIG.keyboardEnhancement;
}

/**
 * Idle scroll-resume delay: env › file › default 5000, clamped to [0, 120000].
 *
 * NO FLAG LAYER, and the absence is the design rather than an omission (§6.1):
 * this key has no `--scroll-resume-ms`, so `CliFlags` carries no field for one
 * and a resolver that read it would be reading a value nothing can ever set.
 */
function resolveScrollResumeMs(
  env: Partial<PersistedConfig>,
  file: Partial<PersistedConfig>,
): number {
  const raw = env.scrollResumeMs ?? file.scrollResumeMs;
  return clampScrollResumeMs(raw, DEFAULT_CONFIG.scrollResumeMs);
}

/**
 * Resolve whether logs reach a file: flag › env › an explicit `false` in the
 * file › default `true`.
 *
 * Shaped exactly like `resolveFullscreen` above, and for the same reason: the
 * config file's DEFAULT `true` must not be mistaken for an opinion, or
 * `--no-log-file` would be the only way to ever turn logging off and a stored
 * `toFile: false` would be unreachable.
 */
function resolveLogToFile(
  flags: CliFlags,
  env: Partial<PersistedConfig>,
  file: Partial<PersistedConfig>,
): boolean {
  if (flags.logFile !== undefined) return flags.logFile;
  if (env.log?.toFile !== undefined) return env.log.toFile;
  if (file.log?.toFile === false) return false;
  return true;
}

/**
 * Merge the `team` section across all four layers (defaults › file › env ›
 * flags), team-subagents §3.10.
 *
 * `flags.team !== undefined` rather than a truthiness check, and that is the
 * whole point (P1-4): a truthiness check cannot tell `--no-team` from "not
 * passed", so `--no-team` would resolve to the config file's value and the off
 * switch would not be off. `--no-skills` gets away with a one-directional test
 * only because nothing ever needs to distinguish `--skills` from silence.
 */
function resolveTeamConfig(
  flags: CliFlags,
  env: Partial<PersistedConfig>,
  file: Partial<PersistedConfig>,
): TeamConfig {
  return clampTeamConfig({
    ...DEFAULT_CONFIG.team,
    ...(file.team ?? {}),
    ...(env.team ?? {}),
    ...(flags.team !== undefined ? { enabled: flags.team } : {}),
    ...(flags.teamMax !== undefined && flags.teamMax !== ''
      ? { maxSubagents: flags.teamMax }
      : {}),
  });
}

/**
 * Merge the `todo` section across all four layers (defaults › file › env ›
 * flags), todo-plan-execution §4.3.
 *
 * `!== undefined` ON BOTH FLAGS, and that is the whole point (P1-8). `commander`
 * materializes a lone `--no-x` as `opts.x = true` when the flag is absent, so a
 * truthiness check cannot tell `--no-todo-panel` from "not passed" — and both
 * keys here are persisted, so both need the distinction. This is the same rule
 * `resolveTeamConfig` above states, one feature later.
 */
function resolveTodoConfig(
  flags: CliFlags,
  env: Partial<PersistedConfig>,
  file: Partial<PersistedConfig>,
): TodoConfig {
  return clampTodoConfig({
    ...DEFAULT_CONFIG.todo,
    ...(file.todo ?? {}),
    ...(env.todo ?? {}),
    ...(flags.todo !== undefined ? { enabled: flags.todo } : {}),
    ...(flags.todoPanel !== undefined ? { panel: flags.todoPanel } : {}),
    // `!== undefined` for the third time, though for a value flag the risk is
    // milder: commander leaves `opts.todoFollow` absent unless it was passed.
    // Written this way anyway so the three lines read as one rule.
    ...(flags.todoFollow !== undefined ? { followThrough: flags.todoFollow } : {}),
  });
}

/**
 * Merge the `bash` section across the three layers that supply it
 * (defaults > file > env), background-service-supervision §5.4.
 *
 * THREE LAYERS, NOT FOUR, AND THAT IS NOT AN OVERSIGHT. There is deliberately no
 * `--no-background` flag: the two switches this section carries are already
 * reachable from `config.json` (a per-machine preference) and from the
 * environment (the channel a container entrypoint has), which is the two-part
 * test every knob in this file is held to. A third spelling would be a third
 * place for the answer to differ.
 */
function resolveBashConfig(
  env: Partial<PersistedConfig>,
  file: Partial<PersistedConfig>,
): BashConfig {
  return clampBashConfig({
    ...DEFAULT_CONFIG.bash,
    ...(file.bash ?? {}),
    ...(env.bash ?? {}),
  });
}

/**
 * Merge the `retry` section across all four layers (defaults › file › env ›
 * flags), llm-api-retry-backoff §6.2.
 *
 * `!== undefined` ON BOTH FLAGS, and that is the whole point — the rule
 * `resolveTeamConfig` and `resolveTodoConfig` each state once. Commander
 * materialises a lone `--no-retry` as `opts.retry = true` when the flag is
 * ABSENT, so a truthiness check cannot tell `--no-retry` from "not passed"; and
 * `flags.retryMax` may legitimately be `0`, which a truthiness check would drop
 * on the floor and replace with the default 10 (R-16).
 */
function resolveRetryConfig(
  flags: CliFlags,
  env: Partial<PersistedConfig>,
  file: Partial<PersistedConfig>,
): RetryConfig {
  return clampRetryConfig({
    ...DEFAULT_CONFIG.retry,
    ...(file.retry ?? {}),
    ...(env.retry ?? {}),
    ...(flags.retry !== undefined ? { enabled: flags.retry } : {}),
    ...(flags.retryMax !== undefined && flags.retryMax !== ''
      ? { maxRetries: flags.retryMax }
      : {}),
  });
}

/**
 * Merge the `fast` section across all four layers (defaults › file › env ›
 * flags), fast-model-tier §3.7.
 *
 * `!== undefined` ON `flags.fast`, which is the rule `resolveTeamConfig`,
 * `resolveTodoConfig` and `resolveRetryConfig` each state once (C-9): commander
 * materialises a lone `--no-fast` as `opts.fast = true` when the flag is absent,
 * so a truthiness check cannot tell `--no-fast` from "not passed" — and here the
 * damage would run the other way from usual, silently turning a default-OFF
 * feature ON for every run that passed no flag at all.
 *
 * `--fast-review` maps onto TWO keys, so it is parsed rather than spread: `off`
 * is `review: false`, a number is `reviewEveryTurns`, and anything else is
 * ignored (the clamp discipline every other key in this file follows).
 */
function resolveFastConfig(
  flags: CliFlags,
  env: Partial<PersistedConfig>,
  file: Partial<PersistedConfig>,
): FastConfig {
  const reviewFlag = flags.fastReview?.trim().toLowerCase();
  const reviewPatch: Partial<Record<keyof FastConfig, unknown>> = {};
  if (reviewFlag !== undefined && reviewFlag.length > 0) {
    if (reviewFlag === 'off') {
      reviewPatch.review = false;
    } else {
      const n = Number.parseInt(reviewFlag, 10);
      if (Number.isFinite(n) && n > 0) reviewPatch.reviewEveryTurns = n;
    }
  }
  return clampFastConfig({
    ...DEFAULT_CONFIG.fast,
    ...(file.fast ?? {}),
    ...(env.fast ?? {}),
    ...(flags.fast !== undefined ? { enabled: flags.fast } : {}),
    ...(flags.fastModel !== undefined && flags.fastModel !== ''
      ? { model: flags.fastModel }
      : {}),
    ...(flags.fastProvider !== undefined && flags.fastProvider !== ''
      ? { provider: flags.fastProvider }
      : {}),
    ...reviewPatch,
  });
}

/**
 * Merge the `update` section across all four layers (defaults › file › env ›
 * flags), cli-auto-update §4.2.
 *
 * `!== undefined` ON `flags.update`, which is the rule `resolveTeamConfig`,
 * `resolveTodoConfig`, `resolveRetryConfig` and `resolveFastConfig` each state
 * once (C-11): commander materialises a lone `--no-update` as
 * `opts.update = true` when the flag is absent, so a truthiness check cannot
 * tell `--no-update` from "not passed" — and here that would silently re-enable
 * a subsystem the user turned off, which is the one direction this feature must
 * never fail in.
 *
 * The flag maps onto `mode` rather than carrying its own key, so there is
 * exactly one place that says whether the updater runs.
 */
function resolveUpdateConfig(
  flags: CliFlags,
  env: Partial<PersistedConfig>,
  file: Partial<PersistedConfig>,
): UpdateConfig {
  return clampUpdateConfig({
    ...DEFAULT_CONFIG.update,
    ...(file.update ?? {}),
    ...(env.update ?? {}),
    ...(flags.update !== undefined ? { mode: flags.update ? 'auto' : 'off' } : {}),
  });
}

/**
 * Merge the `compaction` section across all four layers (defaults › file › env ›
 * flags), context-auto-compaction §4.3.
 *
 * `!== undefined` ON `flags.compaction`, WHICH IS THE WHOLE POINT (C-13 / P1-5).
 * The rule `resolveTeamConfig`, `resolveTodoConfig`, `resolveRetryConfig`,
 * `resolveFastConfig` and `resolveUpdateConfig` each state once: commander
 * materialises a lone `--no-compaction` as `opts.compaction = true` when the flag
 * is absent, so a truthiness check cannot tell `--no-compaction` from "not
 * passed" — and here the damage runs in the worst direction, silently re-enabling
 * a subsystem the user turned off, on every flagless run, for a feature that
 * spends money.
 *
 * `--compaction-threshold` is PARSED rather than spread, because `90%` and `0.9`
 * are both legitimate spellings and a typo must change NOTHING rather than
 * resolve to a default (`parseThresholdInput` returns `null`).
 */
function resolveCompactionConfig(
  flags: CliFlags,
  env: Partial<PersistedConfig>,
  file: Partial<PersistedConfig>,
): CompactionConfig {
  const thresholdFlag =
    flags.compactionThreshold !== undefined ? parseThresholdInput(flags.compactionThreshold) : null;
  return clampCompactionConfig({
    ...DEFAULT_CONFIG.compaction,
    ...(file.compaction ?? {}),
    ...(env.compaction ?? {}),
    ...(flags.compaction !== undefined ? { enabled: flags.compaction } : {}),
    ...(thresholdFlag !== null ? { threshold: thresholdFlag } : {}),
  });
}

/**
 * Resolve the adaptive render governor: flag › env › file › default `true`
 * (tui-render-performance L4).
 *
 * Shaped like `resolveMouse` rather than like `resolveFullscreen`: there are no
 * heuristics for an explicit `true` to override, so a persisted `true` is just a
 * value and not an opinion that has to be told apart from silence. `!==
 * undefined` on the flag is what makes `--no-render-governor` beat a config file
 * that turned it on (P1-4's rule, one feature later).
 */
function resolveRenderGovernor(
  flags: CliFlags,
  env: Partial<PersistedConfig>,
  file: Partial<PersistedConfig>,
): boolean {
  if (flags.renderGovernor !== undefined) return flags.renderGovernor;
  if (env.renderGovernor !== undefined) return env.renderGovernor;
  if (file.renderGovernor !== undefined) return file.renderGovernor;
  return DEFAULT_CONFIG.renderGovernor;
}

/**
 * Resolve per-line frame diffing: flag › env › file › default `true`
 * (tui-input-flicker-fix §5.1).
 *
 * Shaped exactly like `resolveRenderGovernor` above, and for the same reason:
 * there are no heuristics for an explicit `true` to override, so a persisted
 * `true` is a value rather than an opinion that has to be told apart from
 * silence. `!== undefined` on the flag is what makes `--no-diff-render` beat a
 * config file that left the key at its default.
 */
function resolveDiffRender(
  flags: CliFlags,
  env: Partial<PersistedConfig>,
  file: Partial<PersistedConfig>,
): boolean {
  if (flags.diffRender !== undefined) return flags.diffRender;
  if (env.diffRender !== undefined) return env.diffRender;
  if (file.diffRender !== undefined) return file.diffRender;
  return DEFAULT_CONFIG.diffRender;
}

/** Same ladder for the DEC 2026 envelope (§5.1). */
function resolveSyncOutput(
  flags: CliFlags,
  env: Partial<PersistedConfig>,
  file: Partial<PersistedConfig>,
): boolean {
  if (flags.syncOutput !== undefined) return flags.syncOutput;
  if (env.syncOutput !== undefined) return env.syncOutput;
  if (file.syncOutput !== undefined) return file.syncOutput;
  return DEFAULT_CONFIG.syncOutput;
}

/** Merge the `log` section across all four layers (defaults › file › env › flags). */
function resolveLogConfig(
  flags: CliFlags,
  env: Partial<PersistedConfig>,
  file: Partial<PersistedConfig>,
): LogConfig {
  const merged = clampLogConfig({
    ...DEFAULT_CONFIG.log,
    ...(file.log ?? {}),
    ...(env.log ?? {}),
    ...(flags.logLevel ? { level: flags.logLevel } : {}),
    ...(flags.logDir ? { dir: flags.logDir } : {}),
  });
  return { ...merged, toFile: resolveLogToFile(flags, env, file) };
}

// ---------------------------------------------------------------------------
// loadConfig
// ---------------------------------------------------------------------------

function pick<T>(...vals: (T | undefined | null)[]): T | undefined {
  for (const v of vals) {
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return undefined;
}

function hasOwn(obj: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

/**
 * Resolve the output cap: flag › env › file › default, where an EXPLICIT `null`
 * at any layer means AUTO (`undefined` — let the resolver pick per model).
 *
 * THIS CANNOT USE `pick()`, and that is the whole point. `pick` skips `null`, so
 * a config file holding `"maxTokens": null` silently resolves to 64000 and AUTO
 * is unreachable through every supported write path. Detecting it needs an
 * own-property test, not a truthiness test — `null` is exactly the value we are
 * looking for.
 *
 * An unparseable layer falls through to the next one rather than becoming AUTO:
 * a typo in `ARAGON_MAX_TOKENS` must not silently discard the number in the
 * config file underneath it.
 */
function resolveMaxTokens(
  flags: CliFlags,
  env: Partial<PersistedConfig>,
  file: Partial<PersistedConfig>,
): number | undefined {
  const layers: Array<{ name: string; value: unknown }> = [
    { name: '--max-tokens', value: flags.maxTokens },
    { name: 'ARAGON_MAX_TOKENS', value: hasOwn(env, 'maxTokens') ? env.maxTokens : undefined },
    { name: 'config.json maxTokens', value: hasOwn(file, 'maxTokens') ? file.maxTokens : undefined },
  ];

  for (const layer of layers) {
    if (layer.value === undefined) continue; // this layer said nothing
    if (layer.value === null || isAutoToken(layer.value)) return undefined; // AUTO
    const n = clampMaxTokens(layer.value);
    if (n !== undefined) return n;
    getLogger().warn('config', 'max_tokens_unusable', {
      source: layer.name,
      value: String(layer.value),
    });
  }

  return DEFAULT_CONFIG.maxTokens ?? undefined;
}

/**
 * Resolve the context-window override: env > file > default, where an EXPLICIT
 * `null` at either layer means AUTO (context-usage-gauge-accuracy §3.6).
 *
 * IT CANNOT USE `pick()` FOR THE REASON `resolveMaxTokens` GIVES: `pick` skips
 * `null`, and `null` is exactly the value being looked for. NO CLI FLAG feeds
 * this - it is a per-installation correction for a model table entry, not a
 * per-invocation choice, so `config set` and the environment variable are the
 * two surfaces the design names.
 */
function resolveContextWindow(
  env: Partial<PersistedConfig>,
  file: Partial<PersistedConfig>,
): number | null {
  const layers: Array<{ name: string; value: unknown }> = [
    {
      name: 'ARAGON_CONTEXT_WINDOW',
      value: hasOwn(env, 'contextWindow') ? env.contextWindow : undefined,
    },
    {
      name: 'config.json contextWindow',
      value: hasOwn(file, 'contextWindow') ? file.contextWindow : undefined,
    },
  ];

  for (const layer of layers) {
    if (layer.value === undefined) continue; // this layer said nothing
    if (layer.value === null || isAutoToken(layer.value)) return null; // AUTO
    const n = clampContextWindow(layer.value, null);
    if (n !== null) return n;
    getLogger().warn('config', 'context_window_unusable', {
      source: layer.name,
      value: String(layer.value),
    });
  }

  return DEFAULT_CONFIG.contextWindow;
}

/**
 * Resolve the effective config by merging all layers, then derive the runtime
 * (non-persisted) fields and enforce the timeout invariant.
 */
export function loadConfig(
  flags: CliFlags = {},
  options: { interactive?: boolean } = {},
): CliConfig {
  const cwd = flags.cwd ? flags.cwd : process.cwd();

  // `.env` must be loaded before reading env overrides.
  loadDotenv(cwd);

  const read = readConfigFile();
  const projection = projectModelProfiles(read.config ?? {});
  const file: Partial<PersistedConfig> = projection.file;
  const env = readEnvConfig();

  if (read.parseError) {
    getLogger().error('config', 'config_parse_failed', { error: read.parseError });
  }
  if (projection.issues.length) {
    getLogger().warn('config', 'model_profiles_invalid', {
      error: 'Invalid model profiles; using custom connections. Repair with aragon config edit.',
    });
  }

  const provider =
    pick(flags.provider, env.partial.provider, file.provider) ?? DEFAULT_CONFIG.provider;
  const model = pick(flags.model, env.partial.model, file.model) ?? DEFAULT_CONFIG.model;
  const baseUrl = pick<string>(
    flags.baseUrl,
    env.partial.baseUrl ?? undefined,
    file.baseUrl ?? undefined,
  );

  const thinkingLevel = clampThinkingLevel(
    pick(flags.thinking, env.partial.thinkingLevel, file.thinkingLevel),
    DEFAULT_CONFIG.thinkingLevel,
  );

  // BESIDE ITS SIBLING, and through the same three layers (§4.1 / P1-2). This is
  // the ONLY place flags, environment and file are joined, so a key resolved
  // anywhere else reaches the UI from at most one of them.
  const showThinking =
    pick(flags.showThinking, env.partial.showThinking, file.showThinking) ??
    DEFAULT_CONFIG.showThinking;

  // THE SAME THREE LAYERS, in the same one place (§4.1). Round 1's P1-2 and the
  // fast tier's round-2 IF both record the identical failure: a key resolved
  // anywhere else reaches the UI from at most one of flags, environment and file.
  const liveToolOutput =
    pick(flags.liveToolOutput, env.partial.liveToolOutput, file.liveToolOutput) ??
    DEFAULT_CONFIG.liveToolOutput;

  const maxTokens = resolveMaxTokens(flags, env.partial, file);
  const contextWindow = resolveContextWindow(env.partial, file);

  // `clampTheme` is also where the v0.3.0 `dark` name is migrated to `cool`,
  // so reading a legacy config file needs no extra step here (§4.5 / R-4).
  const theme: ThemeName = clampTheme(
    pick(flags.theme, env.partial.theme, file.theme),
    DEFAULT_CONFIG.theme,
  );

  const density: DensityMode =
    flags.compact !== undefined
      ? flags.compact
        ? 'compact'
        : 'comfortable'
      : clampDensity(file.density, DEFAULT_CONFIG.density);

  const hints = flags.hints !== undefined ? flags.hints : file.hints ?? DEFAULT_CONFIG.hints;

  const confirmTools =
    flags.confirm !== undefined ? flags.confirm : file.confirmTools ?? DEFAULT_CONFIG.confirmTools;

  // Plan mode: defaults -> file -> env -> flags, the same order as every other
  // field. `pick` keeps an explicit `false`, so `--no-plan` really does override
  // a config file that turned plan mode on.
  const startInPlanMode =
    pick<boolean>(flags.plan, env.partial.planModeDefault, file.planModeDefault) ??
    DEFAULT_CONFIG.planModeDefault;

  const planModeMaxAskRounds = clampAskRounds(
    file.planModeMaxAskRounds,
    DEFAULT_CONFIG.planModeMaxAskRounds,
  );
  const planModeHumanTimeoutMs = clampHumanTimeout(
    file.planModeHumanTimeoutMs,
    DEFAULT_CONFIG.planModeHumanTimeoutMs,
  );

  const toolTimeoutMs = coercePositiveInt(
    pick(flags.toolTimeout, file.toolTimeoutMs),
    DEFAULT_CONFIG.toolTimeoutMs,
  );

  let idleTimeoutMs = coercePositiveInt(
    pick(flags.idleTimeout, file.idleTimeoutMs),
    DEFAULT_CONFIG.idleTimeoutMs,
  );

  // Timeout invariant (R1): idle must be strictly greater than the tool ceiling
  // so a long single tool run is never aborted by the idle watchdog.
  idleTimeoutMs = Math.max(idleTimeoutMs, toolTimeoutMs + IDLE_TIMEOUT_MARGIN_MS);

  // Resolve API keys: config-file key wins over the provider env var.
  const fileKeys = file.apiKeys ?? {};
  const apiKeys: Record<string, string | undefined> = {};
  const providerSet = new Set([
    ...Object.keys(env.apiKeys),
    ...Object.keys(fileKeys),
    provider,
  ]);
  for (const prov of providerSet) {
    const fileKey = fileKeys[prov];
    apiKeys[prov] =
      fileKey && fileKey.trim().length > 0 ? fileKey.trim() : env.apiKeys[prov];
  }

  // Skills: file › env › flags, with `--no-skills` as the final word. The env
  // layer only ever carries `enabled`, so the file's other fields survive it.
  const skills: SkillsConfig = clampSkillsConfig({
    ...DEFAULT_CONFIG.skills,
    ...(file.skills ?? {}),
    ...(env.partial.skills ?? {}),
    ...(flags.skills === false ? { enabled: false } : {}),
    disabled: [
      ...new Set([...(file.skills?.disabled ?? []), ...readEnvDisabledSkills()]),
    ],
  });

  // Registration site 3 (§4.4.3): the merged view plus the one-shot `--api-key`,
  // which exists nowhere else. Overlaps with sites 1 and 2 on purpose —
  // registering twice costs a `Set.add`, missing once costs a credential.
  registerSecretsFrom(apiKeys);
  registerSecret(flags.apiKey);

  const caps = options.interactive
    ? resolveTuiCapabilities(process.env, flags.color)
    : detectCapabilities(process.env, process.stdout);
  const color = options.interactive
    ? caps.colorLevel !== 0
    : flags.color !== undefined ? flags.color : !process.env.NO_COLOR;

  // `--no-color` implies calmer chrome; env / file may also opt in explicitly.
  const reducedMotion =
    envFlagTrue(process.env.ARAGON_REDUCED_MOTION) ||
    (file.reducedMotion ?? DEFAULT_CONFIG.reducedMotion) ||
    !color;

  // Detect terminal capabilities once; force monochrome when color is disabled.
  const colorLevel: 0 | 1 | 2 | 3 = color ? caps.colorLevel : 0;

  // No flag and no env var: a privacy switch you set once, not a per-run knob.
  const historyEnabled = file.historyEnabled ?? DEFAULT_CONFIG.historyEnabled;
  // The prompt-history store is a module-level singleton, so the resolved value
  // has to be pushed into it — this is the ONLY place that happens.
  setHistoryEnabled(historyEnabled);

  // Transcript bounds (tui-render-performance L1 / L3).
  //
  // `transcriptRetain` is RAISED TO `transcriptWindow` when the two conflict:
  // retaining fewer entries than the window can scroll to would silently make
  // part of the window unreachable, and the user would see a horizon they can
  // never actually reach.
  //
  // The raise is REPORTED, not just performed (§5.1). Overriding a value the
  // user typed and saying nothing is the one thing this feature is not allowed
  // to add — every other adjustment it makes is announced somewhere, and a
  // config key is the last place to start making exceptions.
  const transcriptWindow = clampTranscriptWindow(
    pick(env.partial.transcriptWindow, file.transcriptWindow),
    DEFAULT_CONFIG.transcriptWindow,
  );
  const requestedRetain = clampTranscriptRetain(
    pick(flags.transcriptRetain, env.partial.transcriptRetain, file.transcriptRetain),
    DEFAULT_CONFIG.transcriptRetain,
  );
  const transcriptRetain = Math.max(transcriptWindow, requestedRetain);
  // `viewReducer` is pure and takes no config, so the resolved ring cap reaches
  // it through the same module-singleton channel `setHistoryEnabled` uses.
  setEntryRetain(transcriptRetain);

  const config: CliConfig = {
    modelProfiles: projection.issues.length ? undefined : file.modelProfiles,
    provider,
    model,
    baseUrl,
    thinkingLevel,
    showThinking,
    liveToolOutput,
    maxTokens,
    contextWindow,
    theme,
    reducedMotion,
    exitTranscript:
      flags.exitTranscript !== undefined
        ? flags.exitTranscript
        : file.exitTranscript ?? DEFAULT_CONFIG.exitTranscript,
    transcriptWindow,
    transcriptRetain,
    ...(requestedRetain < transcriptRetain ? { transcriptRetainRequested: requestedRetain } : {}),
    renderGovernor: resolveRenderGovernor(flags, env.partial, file),
    maxRenderIntervalMs: clampMaxRenderInterval(
      pick(flags.maxRenderInterval, env.partial.maxRenderIntervalMs, file.maxRenderIntervalMs),
      DEFAULT_CONFIG.maxRenderIntervalMs,
    ),
    diffRender: resolveDiffRender(flags, env.partial, file),
    syncOutput: resolveSyncOutput(flags, env.partial, file),
    confirmTools,
    toolTimeoutMs,
    idleTimeoutMs,
    apiKeys,
    historyEnabled,
    density,
    hints,
    mouse: resolveMouse(flags, env.partial, file),
    mouseSelect: resolveMouseSelect(flags, env.partial, file),
    paste: resolvePaste(flags, env.partial, file),
    keyboardEnhancement: resolveKeyboardEnhancement(flags, env.partial, file),
    scrollResumeMs: resolveScrollResumeMs(env.partial, file),
    // From `<home>/state.json`, not the config file — see `ui-state.ts`.
    submitCount: readSubmitCount(),
    startInPlanMode,
    planModeMaxAskRounds,
    planModeHumanTimeoutMs,
    skills,
    skillsRuntime: {
      forcedSkills: flags.skill ?? [],
      approveAll: flags.skillsYes === true,
      // Left ABSENT when the flag was not given (or was given a bad value), so
      // `effectiveToolPolicy()` can fall through to the config layer. Writing a
      // resolved default here instead would make the flag look permanently
      // supplied and mask the config file for the whole session.
      ...(isSkillsToolPolicyMode(flags.skillToolPolicy)
        ? { toolPolicy: flags.skillToolPolicy }
        : {}),
    },
    log: resolveLogConfig(flags, env.partial, file),
    team: resolveTeamConfig(flags, env.partial, file),
    todo: resolveTodoConfig(flags, env.partial, file),
    retry: resolveRetryConfig(flags, env.partial, file),
    fast: resolveFastConfig(flags, env.partial, file),
    update: resolveUpdateConfig(flags, env.partial, file),
    compaction: resolveCompactionConfig(flags, env.partial, file),
    bash: resolveBashConfig(env.partial, file),
    cwd,
    color,
    colorLevel,
    unicode: caps.unicode,
    apiKeyOverride: flags.apiKey && flags.apiKey.trim().length > 0 ? flags.apiKey.trim() : undefined,
  };
  config.modelProfileState = resolveModelProfileState(
    config, config.modelProfiles, projection.issues.length > 0,
  );
  if (config.apiKeyOverride && (config.modelProfiles?.mainId || config.modelProfiles?.fastId)) {
    config.apiKeyOverrideTarget = { provider, baseUrl: baseUrl?.trim() || null };
  }
  recordResolvedConfig(config);
  return config;
}

/**
 * One record naming the values this run actually resolved to.
 *
 * "I changed the model in config.json and it still uses the old one" was, until
 * this line existed, unanswerable after the fact: four layers feed this
 * function and none of them left a trace. Now the answer is in the log next to
 * the path the values came from.
 *
 * NO SECRET VALUES — only whether a key was found. `logging/redact.ts` would
 * catch one anyway, but a record that never carries the secret does not depend
 * on that backstop being configured.
 */
function recordResolvedConfig(config: CliConfig): void {
  getLogger().info('config', 'config_loaded', {
    provider: config.provider,
    model: config.model,
    baseUrl: config.baseUrl,
    thinkingLevel: config.thinkingLevel,
    // Four layers feed this one and none of them used to leave a trace, so
    // "why is my output truncated" was unanswerable after the fact.
    maxTokens: config.maxTokens ?? 'auto',
    theme: config.theme,
    toolTimeoutMs: config.toolTimeoutMs,
    idleTimeoutMs: config.idleTimeoutMs,
    historyEnabled: config.historyEnabled,
    logLevel: config.log.level,
    // Four layers feed this one too, and none of them would otherwise leave a
    // trace — so "why did my failing call sit there for three minutes" (or
    // "why did it not retry at all") has an answer after the fact.
    retry: config.retry.enabled ? config.retry.maxRetries : 'off',
    hasApiKey: Boolean(config.apiKeys[config.provider]),
    configPath: getConfigPath(),
  });
}

/**
 * Build the `getApiKey(providerId)` resolver the core `Agent` consumes.
 * The one-shot `--api-key` override wins, but only for the active provider.
 */
export function makeGetApiKey(
  config: CliConfig, role: ModelRole = 'main',
): (providerId: string) => string | undefined {
  return (providerId) => resolveModelRoleKey({ config, role, providerId });
}
