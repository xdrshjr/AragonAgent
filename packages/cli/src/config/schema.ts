/**
 * Config schema — the persisted config-file shape, the in-memory effective
 * config, sane defaults, and small validation/masking helpers.
 *
 * See spec §3.5 (resolution pipeline), §6.1 (config file), and §3.8 (timeout
 * invariant).
 */

import { isAbsolute } from 'node:path';
import {
  ABSOLUTE_MAX_OUTPUT_TOKENS,
  DEFAULT_MAX_OUTPUT_TOKENS,
  DEFAULT_RETRY_POLICY,
  MIN_MAX_OUTPUT_TOKENS,
  RETRY_LIMITS,
  type RetryPolicy,
  type ThinkingLevel,
} from '@aragon-agent/core';
import { clampLogLevel, type LogLevelName } from '../logging/levels.js';
import { TEAM_LIMITS } from '../team/limits.js';
import type { FollowThroughMode } from '../todo/types.js';

// ---------------------------------------------------------------------------
// Provider set — only the adapter-backed providers are usable at run time (R5).
// ---------------------------------------------------------------------------

/**
 * `ModelRegistry` seeds builtin lists for five providers, but `initProviders()`
 * registers only three adapters. Running a model whose provider has no adapter
 * throws `Unknown LLM provider`, so the CLI only ever offers these three.
 */
export const ADAPTER_PROVIDERS = ['anthropic', 'openai', 'google'] as const;
export type AdapterProviderId = (typeof ADAPTER_PROVIDERS)[number];

export function isAdapterProvider(id: string): id is AdapterProviderId {
  return (ADAPTER_PROVIDERS as readonly string[]).includes(id);
}

// ---------------------------------------------------------------------------
// Thinking levels
// ---------------------------------------------------------------------------

export const THINKING_LEVELS: ThinkingLevel[] = [
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
];

export function isThinkingLevel(v: unknown): v is ThinkingLevel {
  return typeof v === 'string' && (THINKING_LEVELS as string[]).includes(v);
}

export function clampThinkingLevel(v: unknown, fallback: ThinkingLevel): ThinkingLevel {
  return isThinkingLevel(v) ? v : fallback;
}

// ---------------------------------------------------------------------------
// Theme
// ---------------------------------------------------------------------------

export const THEME_NAMES = ['auto', 'warm', 'cool', 'light'] as const;
export type ThemeName = (typeof THEME_NAMES)[number];

/** The v0.3.0 name for what is now `cool`. Accepted forever as an alias. */
export const LEGACY_DARK_THEME = 'dark';

export function isThemeName(v: unknown): v is ThemeName {
  return typeof v === 'string' && (THEME_NAMES as readonly string[]).includes(v);
}

/**
 * THE single gate for every theme write (spec §4.5 / R-4).
 *
 * All three write paths funnel through here — config resolution (`load.ts`),
 * `aragon config set theme`, and the `/theme` slash command — which is why the
 * `dark -> cool` migration lives here and nowhere else. Putting it in a
 * `load.ts` normalization step instead would migrate what users *read* but not
 * what they *write*, producing the worst kind of bug: "the flag works but the
 * setting won't stick."
 *
 * An unrecognized value still falls back silently (plus a warn toast at the call
 * site). Turning that into a hard exit would be an unannounced breaking change
 * and would not match `clampThinkingLevel` / `clampTranscriptWindow`.
 */
export function clampTheme(v: unknown, fallback: ThemeName): ThemeName {
  if (v === LEGACY_DARK_THEME) return 'cool';
  return isThemeName(v) ? v : fallback;
}

// ---------------------------------------------------------------------------
// Density / hints (v0.4.0)
// ---------------------------------------------------------------------------

export const DENSITY_MODES = ['comfortable', 'compact'] as const;
export type DensityMode = (typeof DENSITY_MODES)[number];

export function clampDensity(v: unknown, fallback: DensityMode): DensityMode {
  return v === 'comfortable' || v === 'compact' ? v : fallback;
}

/**
 * Submissions after which the composer hint collapses to `? help` (§4.6).
 * Only the IDLE hint fades; the running hint carries the abort key and is
 * always shown in full.
 */
export const HINT_FADE_AFTER = 8;

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

export const CONFIG_VERSION = 1;

export const DEFAULT_MODEL = 'claude-sonnet-4-5-20250929';

/** Per-tool executor ceiling (§3.8). Headroom for typical installs/builds. */
export const DEFAULT_TOOL_TIMEOUT_MS = 180_000;
/** Extra margin so idle timeout is strictly greater than the tool ceiling. */
export const IDLE_TIMEOUT_MARGIN_MS = 30_000;
/** Watchdog idle timeout (§3.8) — must stay ≥ toolTimeout so long tools survive. */
export const DEFAULT_IDLE_TIMEOUT_MS = DEFAULT_TOOL_TIMEOUT_MS + IDLE_TIMEOUT_MARGIN_MS;

/**
 * Cap on the recall list.
 *
 * The list itself now lives in `<home>/prompt-history.jsonl`; this constant is
 * consumed by `config/prompt-history.ts`, not by the UI.
 */
export const PROMPT_HISTORY_CAP = 100;

/**
 * The SCROLL HORIZON: entries older than this are not reachable inside the app
 * and render as the "N earlier entries collapsed" line instead (invariant I-3).
 *
 * It used to be a rendering budget as well, because yoga laid out every child
 * even when `overflow: hidden` clipped it. The viewport is virtualised now
 * (tui-render-performance L3) — off-screen entries are not mounted at all — so
 * the horizon costs O(entries) of arithmetic rather than O(characters) of layout
 * and the default rises 300 -> 1000 with a 20000 ceiling. An existing persisted
 * `300` is still valid and still clamps; no config migration is required.
 */
export const DEFAULT_TRANSCRIPT_WINDOW = 1000;
export const MIN_TRANSCRIPT_WINDOW = 50;
export const MAX_TRANSCRIPT_WINDOW = 20_000;

export function clampTranscriptWindow(v: unknown, fallback: number): number {
  const n = coercePositiveInt(v, fallback);
  return Math.min(MAX_TRANSCRIPT_WINDOW, Math.max(MIN_TRANSCRIPT_WINDOW, n));
}

// ---------------------------------------------------------------------------
// Context window override (context-usage-gauge-accuracy §3.6 / W5)
// ---------------------------------------------------------------------------

/**
 * Bounds for a hand-supplied context window.
 *
 * The floor is roughly the smallest window any current model ships with; the
 * ceiling is well above the largest, and both exist to keep a typo (a missing
 * or an extra zero) from producing a gauge that is permanently red or
 * permanently flat.
 */
export const MIN_CONTEXT_WINDOW = 8_000;
export const MAX_CONTEXT_WINDOW = 5_000_000;

/**
 * THE single gate for every `contextWindow` read AND write.
 *
 * TRI-STATE, AND `null` MUST PASS STRAIGHT THROUGH (RV-12). `null` means AUTO -
 * take the model table's number, or the 128k placeholder. Clamping it into
 * `[8000, ...]` yields 8000, which removes "auto" from the config permanently
 * and presents to the user as an 8k denominator with a permanently red bar and
 * no visible source. `maxTokens` above is the existing tri-state precedent and
 * this deliberately copies its shape rather than inventing a second convention.
 */
export function clampContextWindow(v: unknown, fallback: number | null): number | null {
  if (v === null) return null;
  if (v === undefined || v === '') return fallback;
  const n = typeof v === 'number' ? v : Number.parseInt(String(v), 10);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(MAX_CONTEXT_WINDOW, Math.max(MIN_CONTEXT_WINDOW, Math.floor(n)));
}

/**
 * Entries kept in `ViewState` at all (tui-render-performance L1 / R5).
 *
 * A DIFFERENT BOUND FROM `transcriptWindow`, and the two must not be merged:
 * the window is what the user can scroll to, this is what the process keeps in
 * memory and what `/save` can export. Dropped entries are COUNTED and reported
 * (`/perf`, and a leading line in the exported transcript) — never silent.
 */
export const DEFAULT_TRANSCRIPT_RETAIN = 1000;
export const MIN_TRANSCRIPT_RETAIN = 200;
export const MAX_TRANSCRIPT_RETAIN = 20_000;

export function clampTranscriptRetain(v: unknown, fallback: number): number {
  const n = coercePositiveInt(v, fallback);
  return Math.min(MAX_TRANSCRIPT_RETAIN, Math.max(MIN_TRANSCRIPT_RETAIN, n));
}

// ---------------------------------------------------------------------------
// Adaptive render governor (tui-render-performance L4 / R7)
// ---------------------------------------------------------------------------

/** Adaptive coalescing under load. On by default; `--no-render-governor` kills it. */
export const DEFAULT_RENDER_GOVERNOR = true;

/**
 * Ceiling of the governor ladder, in ms. `33` flattens the ladder to a single
 * rung, which is the pre-feature behaviour without needing the kill switch.
 */
export const DEFAULT_MAX_RENDER_INTERVAL_MS = 320;
const RENDER_INTERVAL_RANGE = { min: 33, max: 1000 };

export function clampMaxRenderInterval(v: unknown, fallback: number): number {
  return clampInt(v, fallback, RENDER_INTERVAL_RANGE);
}

// ---------------------------------------------------------------------------
// Frame diffing (tui-input-flicker-fix §5.1)
//
// TWO TROUBLESHOOTING SWITCHES, in the same class as `historyEnabled`: neither
// appears on the settings overlay, because a user who needs them is debugging a
// terminal, not adjusting a preference.
// ---------------------------------------------------------------------------

/**
 * Repaint only the frame lines that changed (full-screen only).
 *
 * ON by default, and `--no-diff-render` restores today's byte stream EXACTLY —
 * the interposer is not constructed at all, so a regression on an exotic
 * terminal is one flag away from being neutralised (§3.5 rung 2).
 */
export const DEFAULT_DIFF_RENDER = true;

/**
 * Wrap each repaint batch in DEC 2026 begin/end synchronized update.
 *
 * ON by default with NO capability probe (§3.3): terminals that do not implement
 * mode 2026 parse the CSI sequence, find an unknown private mode and discard it,
 * so a false positive costs nothing — and a false negative costs nothing either,
 * because the frame differ already removes the flicker on its own.
 */
export const DEFAULT_SYNC_OUTPUT = true;

// ---------------------------------------------------------------------------
// Selection + scroll follow (tui-selection-and-scroll-follow §6.1)
// ---------------------------------------------------------------------------

/**
 * Drag-select + copy, and — because §4.4.1 gates `\x1b[?1002h` on exactly this
 * value — whether motion reporting is requested from the terminal at all.
 *
 * That gating is what makes `false` BYTE-IDENTICAL to a pre-feature session
 * rather than merely equivalent (AC-8 / D-15). Ignored when `mouse` is false,
 * since there is no capture to select with.
 */
export const DEFAULT_MOUSE_SELECT = true;

/**
 * Idle delay before a paused viewport returns to the newest line, in ms.
 *
 * Five seconds is chosen to be LONGER than a glance and SHORTER than a read.
 * `0` disables auto-resume entirely, and it is a real value rather than a
 * sentinel-shaped default: `shouldArmResume` refuses on it before any timer is
 * created (AC-9), so the revert for Rule B is one config key.
 *
 * NO CLI FLAG (§6.1). It is a comfort preference, set once
 * (`aragon config set scrollResumeMs 8000`) and then forgotten — the same
 * argument this file already makes for `historyEnabled`. Adding a flag for every
 * scalar is how a CLI ends up with sixty of them.
 */
export const DEFAULT_SCROLL_RESUME_MS = 5000;
const SCROLL_RESUME_RANGE = { min: 0, max: 120_000 };

/**
 * `clampIntAllowingZero`, and the choice is load-bearing: `clampInt` delegates to
 * `coercePositiveInt`, which returns the FALLBACK for `n <= 0` — so `0` would
 * silently become 5000 and the documented off switch would not be an off switch.
 * Exactly the trap `retry.maxRetries` needed this helper for.
 */
export function clampScrollResumeMs(v: unknown, fallback: number): number {
  return clampIntAllowingZero(v, fallback, SCROLL_RESUME_RANGE);
}

// ---------------------------------------------------------------------------
// Plan mode (plan-mode §4.4)
//
// THREE FLAT KEYS, not a nested `planMode` object. `store.ts` documents that its
// nested-object merge is hand-written and capped at one level; three scalars do
// not justify a second `clampXConfig` gate plus two more merge sites, and flat
// keys mean `store.ts` needs ZERO changes.
// ---------------------------------------------------------------------------

/** `ask_user` calls allowed per user turn. */
export const DEFAULT_PLAN_MAX_ASK_ROUNDS = 4;
const ASK_ROUNDS_RANGE = { min: 1, max: 10 };

/**
 * Ceiling on ONE human wait, in ms. Thirty minutes is far outside "the user
 * went to get coffee", but a ceiling has to exist: an unattended terminal must
 * not wedge a CI job or a stale ssh session forever.
 */
export const DEFAULT_PLAN_HUMAN_TIMEOUT_MS = 1_800_000;
const HUMAN_TIMEOUT_RANGE = { min: 60_000, max: 7_200_000 };

export function clampAskRounds(v: unknown, fallback: number): number {
  return clampInt(v, fallback, ASK_ROUNDS_RANGE);
}

export function clampHumanTimeout(v: unknown, fallback: number): number {
  return clampInt(v, fallback, HUMAN_TIMEOUT_RANGE);
}

// ---------------------------------------------------------------------------
// Skills (spec §10.3)
// ---------------------------------------------------------------------------

export interface SkillsConfig {
  enabled: boolean;
  /** Skill names the user has switched off. */
  disabled: string[];
  /** Gate `skill_install` / `skill_create` behind a human confirmation (D12). */
  requireApproval: boolean;
  /** Hosts an install may fetch from. Anything else is refused (SSRF guard). */
  allowedHosts: string[];
  /** Project-relative skill roots, in ascending precedence. */
  projectDirs: string[];
  /** Absolute, normalized directories the user has trusted (D13 / §9.3). */
  trustedProjectDirs: string[];
  /** D19: BYTES, not characters. */
  catalogMaxBytes: number;
  /** D19: BYTES, not characters. Upper bound derives from SKILL_RESULT_MAX_BYTES. */
  bodyMaxBytes: number;
  /**
   * What to do when SKILL.md no longer matches the copy that was approved (§8.2).
   *
   * Defaults to `warn`, NOT `strict` (D-A13). Hand-editing an installed skill is
   * a legitimate workflow — the same one `update --force` exists to protect —
   * and a default that silently removed the edited skill from the catalog would
   * present as "I changed one line and it disappeared".
   */
  integrity: SkillsIntegrityMode;
  /**
   * Keep local per-skill use counters to rank the catalog (§9). Name, count and
   * timestamp only; never transmitted. `false` disables all reads and writes.
   */
  usageTracking: boolean;
  /**
   * How hard `allowed-tools` bites (§5.5).
   *
   * Defaults to `enforce`, NOT `warn` — the opposite of `integrity`, and the two
   * are not comparable. A false integrity alarm punishes a user for legitimately
   * editing a file they own; a false ceiling refusal requires a skill AUTHOR to
   * have under-declared what their own skill uses, which is a bug in the skill
   * and one that `doctor` reports before it can bite. Add the three narrowings
   * that already apply — one turn only, only for skills that declared anything,
   * and every read-only tool in the floor — and shipping it off by default would
   * just be a second decorative field.
   */
  toolPolicy: SkillsToolPolicyMode;
}

export const SKILLS_INTEGRITY_MODES = ['off', 'warn', 'strict'] as const;
export type SkillsIntegrityMode = (typeof SKILLS_INTEGRITY_MODES)[number];

export function clampSkillsIntegrity(v: unknown, fallback: SkillsIntegrityMode): SkillsIntegrityMode {
  return typeof v === 'string' && (SKILLS_INTEGRITY_MODES as readonly string[]).includes(v)
    ? (v as SkillsIntegrityMode)
    : fallback;
}

export const SKILLS_TOOL_POLICY_MODES = ['off', 'warn', 'enforce'] as const;
export type SkillsToolPolicyMode = (typeof SKILLS_TOOL_POLICY_MODES)[number];

export function isSkillsToolPolicyMode(v: unknown): v is SkillsToolPolicyMode {
  return typeof v === 'string' && (SKILLS_TOOL_POLICY_MODES as readonly string[]).includes(v);
}

export function clampSkillsToolPolicy(
  v: unknown,
  fallback: SkillsToolPolicyMode,
): SkillsToolPolicyMode {
  return isSkillsToolPolicyMode(v) ? v : fallback;
}

export const DEFAULT_ALLOWED_SKILL_HOSTS = [
  'github.com',
  'raw.githubusercontent.com',
  'codeload.github.com',
  'gitlab.com',
  'objects.githubusercontent.com',
];

export const DEFAULT_SKILLS_CONFIG: SkillsConfig = {
  enabled: true,
  disabled: [],
  requireApproval: true,
  allowedHosts: DEFAULT_ALLOWED_SKILL_HOSTS,
  projectDirs: ['.aragon/skills', '.claude/skills'],
  trustedProjectDirs: [],
  catalogMaxBytes: 6000,
  bodyMaxBytes: 30_000,
  integrity: 'warn',
  usageTracking: true,
  toolPolicy: 'enforce',
};

const CATALOG_BYTES_RANGE = { min: 500, max: 40_000 };
/**
 * Upper bound is 50 000, NOT the 90 000 an earlier draft used.
 * `SKILL_RESULT_MAX_BYTES` is 60 000 and must also fit the file list and the
 * head/tail guidance; 50 000 leaves that margin. A 90 000-CHARACTER body is
 * 270 000 bytes of CJK, which `ToolExecutor` would chop mid-tag (D19).
 */
const BODY_BYTES_RANGE = { min: 1000, max: 50_000 };

function clampInt(v: unknown, fallback: number, range: { min: number; max: number }): number {
  const n = coercePositiveInt(v, fallback);
  return Math.min(range.max, Math.max(range.min, n));
}

/**
 * `clampInt` for a key whose range legitimately includes ZERO.
 *
 * `clampInt` delegates to `coercePositiveInt`, which returns the FALLBACK for
 * `n <= 0` — so a range whose floor is `0` cannot express `0` through it, and the
 * value silently becomes the default. That trap is invisible at the call site and
 * is what `retry.maxRetries` needs this helper for: `0` is that key's documented
 * floor and its kill switch, and four documented controls send it
 * (`/retry max 0`, `--retry-max 0`, `ARAGON_RETRY_MAX=0`,
 * `aragon config set retry.maxRetries 0`). Through `clampInt` all four would set
 * the MAXIMUM instead of the minimum, with no error anywhere.
 *
 * Own coercion: `Number.parseInt`, reject only non-finite and negative, then
 * floor and clamp.
 */
function clampIntAllowingZero(
  v: unknown,
  fallback: number,
  range: { min: number; max: number },
): number {
  if (v === null || v === undefined || v === '') return clampToRange(fallback, range);
  const n = typeof v === 'number' ? v : Number.parseInt(String(v), 10);
  if (!Number.isFinite(n) || n < 0) return clampToRange(fallback, range);
  return clampToRange(Math.floor(n), range);
}

/**
 * `clampInt` for a key that is legitimately a FLOAT.
 *
 * `coercePositiveInt` floors, and `2.5` is a legitimate backoff factor — the same
 * coercion trap `clampIntAllowingZero` above closes for `0`, one type over.
 */
function clampNumber(v: unknown, fallback: number, range: { min: number; max: number }): number {
  if (v === null || v === undefined || v === '') return clampToRange(fallback, range);
  const n = typeof v === 'number' ? v : Number.parseFloat(String(v));
  if (!Number.isFinite(n)) return clampToRange(fallback, range);
  return clampToRange(n, range);
}

function clampToRange(n: number, range: { min: number; max: number }): number {
  return Math.min(range.max, Math.max(range.min, n));
}

function stringArray(v: unknown, fallback: string[]): string[] {
  if (!Array.isArray(v)) return fallback;
  const out = v.filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
  return out.map((s) => s.trim());
}

function bool(v: unknown, fallback: boolean): boolean {
  return typeof v === 'boolean' ? v : fallback;
}

/**
 * THE single gate for every skills-config read AND write (§10.3.1).
 *
 * Shared by `loadConfig()`, `loadPersistedConfig()` and `updatePersistedConfig()`
 * on purpose: hardening only the read path would leave a corrupt value on disk
 * that silently reverts to a default on every launch — the failure looks like
 * "my setting won't stick" with no error anywhere.
 */
export function clampSkillsConfig(raw: unknown): SkillsConfig {
  const src = (raw && typeof raw === 'object' ? raw : {}) as Partial<Record<keyof SkillsConfig, unknown>>;
  return {
    enabled: bool(src.enabled, DEFAULT_SKILLS_CONFIG.enabled),
    disabled: stringArray(src.disabled, DEFAULT_SKILLS_CONFIG.disabled),
    requireApproval: bool(src.requireApproval, DEFAULT_SKILLS_CONFIG.requireApproval),
    allowedHosts: stringArray(src.allowedHosts, DEFAULT_SKILLS_CONFIG.allowedHosts),
    projectDirs: stringArray(src.projectDirs, DEFAULT_SKILLS_CONFIG.projectDirs),
    trustedProjectDirs: stringArray(src.trustedProjectDirs, DEFAULT_SKILLS_CONFIG.trustedProjectDirs),
    catalogMaxBytes: clampInt(
      src.catalogMaxBytes,
      DEFAULT_SKILLS_CONFIG.catalogMaxBytes,
      CATALOG_BYTES_RANGE,
    ),
    bodyMaxBytes: clampInt(src.bodyMaxBytes, DEFAULT_SKILLS_CONFIG.bodyMaxBytes, BODY_BYTES_RANGE),
    integrity: clampSkillsIntegrity(src.integrity, DEFAULT_SKILLS_CONFIG.integrity),
    usageTracking: bool(src.usageTracking, DEFAULT_SKILLS_CONFIG.usageTracking),
    toolPolicy: clampSkillsToolPolicy(src.toolPolicy, DEFAULT_SKILLS_CONFIG.toolPolicy),
  };
}

/**
 * Run-time-only skill switches (§7.5). These come from flags / env and are
 * NEVER persisted, which is why they do not live in `SkillsConfig`.
 */
export interface SkillsRuntimeOptions {
  /** `--skill <name>` ×N — force Level 2 injection for this run only. */
  forcedSkills: string[];
  /** `--skills-yes` — approve installs for this run only. */
  approveAll: boolean;
  /**
   * `--skill-tool-policy <mode>` — override the ceiling mode for this run.
   *
   * Sits BETWEEN the session override and the config file (D-G19), not on top of
   * everything: the refusal text tells the user to run `/skills policy off`, and
   * a flag that outranked that command would make the documented escape hatch a
   * no-op with no message to explain it.
   */
  toolPolicy?: SkillsToolPolicyMode;
}

export const DEFAULT_SKILLS_RUNTIME: SkillsRuntimeOptions = { forcedSkills: [], approveAll: false };

// ---------------------------------------------------------------------------
// Logging (aragon-home-config-and-logging §4.3)
//
// The THIRD nested section in the persisted config, after `apiKeys` and
// `skills`. Every field here is a scalar, deliberately: `store.ts` merges these
// sections by hand and that merge is only correct while nesting stays one level
// deep. Adding a nested field here means replacing that merge first.
// ---------------------------------------------------------------------------

export interface LogConfig {
  level: LogLevelName;
  /** Whether records reach a file at all. */
  toFile: boolean;
  /** Absolute log directory; empty string means `<home>/logs`. */
  dir: string;
  /** Rotate a file once it would exceed this many bytes. */
  maxFileBytes: number;
  /** Files kept in the log directory; the oldest beyond this are deleted. */
  maxFiles: number;
  /**
   * Run every record through the redaction pipeline. The ONE switch a user can
   * flip to put credentials on disk, which is why turning it off prints a
   * warning and has no settings-screen entry (§4.3).
   */
  redactSecrets: boolean;
  /** Truncation length for user content at `debug`; `trace` is never truncated. */
  previewChars: number;
}

const DEFAULT_MAX_LOG_FILE_BYTES = 5 * 1024 * 1024;
const LOG_FILE_BYTES_RANGE = { min: 64 * 1024, max: 256 * 1024 * 1024 };
const LOG_MAX_FILES_RANGE = { min: 1, max: 200 };
const LOG_PREVIEW_CHARS_RANGE = { min: 0, max: 8192 };

export const DEFAULT_LOG_CONFIG: LogConfig = {
  level: 'info',
  toFile: true,
  dir: '',
  maxFileBytes: DEFAULT_MAX_LOG_FILE_BYTES,
  maxFiles: 10,
  redactSecrets: true,
  previewChars: 512,
};

/**
 * Coerce a log directory. Anything relative is discarded (falling back to
 * `<home>/logs`) rather than resolved: a relative path would silently mean a
 * different directory for every working directory the CLI is launched from, and
 * `debug`-level files carry prompt text (R-13).
 */
function logDir(v: unknown, fallback: string): string {
  if (typeof v !== 'string') return fallback;
  const trimmed = v.trim();
  if (trimmed.length === 0) return '';
  return isAbsolute(trimmed) ? trimmed : fallback;
}

/**
 * THE single gate for every log-config read AND write, exactly like
 * `clampSkillsConfig`: hardening only the read path leaves a bad value on disk
 * that reverts on every launch, which presents as "my setting won't stick".
 *
 * `previewChars` uses its own coercion because `coercePositiveInt` rejects `0`,
 * and `0` is a legitimate value here — it means "record that content existed,
 * but none of it".
 */
export function clampLogConfig(raw: unknown): LogConfig {
  const src = (raw && typeof raw === 'object' ? raw : {}) as Partial<
    Record<keyof LogConfig, unknown>
  >;
  const preview = typeof src.previewChars === 'number' || typeof src.previewChars === 'string'
    ? Number.parseInt(String(src.previewChars), 10)
    : Number.NaN;
  return {
    level: clampLogLevel(src.level, DEFAULT_LOG_CONFIG.level),
    toFile: bool(src.toFile, DEFAULT_LOG_CONFIG.toFile),
    dir: logDir(src.dir, DEFAULT_LOG_CONFIG.dir),
    maxFileBytes: clampInt(src.maxFileBytes, DEFAULT_LOG_CONFIG.maxFileBytes, LOG_FILE_BYTES_RANGE),
    maxFiles: clampInt(src.maxFiles, DEFAULT_LOG_CONFIG.maxFiles, LOG_MAX_FILES_RANGE),
    redactSecrets: bool(src.redactSecrets, DEFAULT_LOG_CONFIG.redactSecrets),
    previewChars: Number.isFinite(preview)
      ? Math.min(LOG_PREVIEW_CHARS_RANGE.max, Math.max(LOG_PREVIEW_CHARS_RANGE.min, preview))
      : DEFAULT_LOG_CONFIG.previewChars,
  };
}

// ---------------------------------------------------------------------------
// Team mode (team-subagents §4.3 / §5.4)
//
// The FOURTH nested section in the persisted config, after `apiKeys`, `skills`
// and `log` — and, like `log`, it is SCALARS ONLY, exactly one level deep.
// `store.ts` merges these sections by hand and that merge is only correct while
// nesting stays one level deep; a nested field here means replacing that merge
// first.
// ---------------------------------------------------------------------------

export interface TeamConfig {
  /** Register the `task` tool at all. Defaults to TRUE (R-b). */
  enabled: boolean;
  /** Children per dispatch. Clamped to [1, HARD_MAX_SUBAGENTS] (R-g). */
  maxSubagents: number;
  /**
   * Children in flight at once.
   *
   * A SEPARATE KNOB FROM `maxSubagents` on purpose (D-6): provider rate limits
   * are a different constraint from context economics, and folding them into one
   * number makes both wrong. Five simultaneous streams against one API key is a
   * reliable way to collect HTTP 429s, each of which lands in the report as a
   * failed subagent.
   */
  maxConcurrent: number;
  /** One child's wall clock before its own abort. */
  subagentTimeoutMs: number;
  /** The whole dispatch's wall clock. Also the `task` tool-timeout override. */
  dispatchTimeoutMs: number;
  /** Runaway-loop cap: turns one child may take before it is stopped. */
  maxTurnsPerSubagent: number;
}

/**
 * The requirement's ceiling on the fan-out (R-g).
 *
 * Re-exported from `TEAM_LIMITS` rather than re-spelled, because it is enforced
 * in TWO places — here on the config value, and again in
 * `normalizeSubagentSpecs` on what the model asked for — and two copies of the
 * same 10 is exactly how a hand-edited `config.json` ends up being able to raise
 * a ceiling the requirement fixed.
 */
export const HARD_MAX_SUBAGENTS = TEAM_LIMITS.hardMaxSubagents;

export const DEFAULT_TEAM_CONFIG: TeamConfig = {
  enabled: true,
  maxSubagents: 5,
  maxConcurrent: 3,
  subagentTimeoutMs: 300_000,
  dispatchTimeoutMs: 900_000,
  maxTurnsPerSubagent: 24,
};

const SUBAGENTS_RANGE = { min: 1, max: HARD_MAX_SUBAGENTS };
const CONCURRENT_RANGE = { min: 1, max: HARD_MAX_SUBAGENTS };
const SUBAGENT_TIMEOUT_RANGE = { min: 30_000, max: 1_800_000 };
const DISPATCH_TIMEOUT_RANGE = { min: 60_000, max: 3_600_000 };
const TURNS_RANGE = { min: 4, max: 100 };

/**
 * THE single gate for every team-config read AND write, mirroring
 * `clampSkillsConfig` / `clampLogConfig` for the reason those two record:
 * hardening only the read path leaves a bad value on disk that reverts to the
 * default on every launch, which presents to the user as "my setting won't
 * stick".
 *
 * `maxConcurrent` is additionally capped at `maxSubagents`: a pool wider than
 * the population it draws from is not wrong so much as meaningless, and letting
 * the two disagree would make the panel's `n/m` readout confusing for no gain.
 */
export function clampTeamConfig(raw: unknown): TeamConfig {
  const src = (raw && typeof raw === 'object' ? raw : {}) as Partial<
    Record<keyof TeamConfig, unknown>
  >;
  const maxSubagents = clampInt(src.maxSubagents, DEFAULT_TEAM_CONFIG.maxSubagents, SUBAGENTS_RANGE);
  return {
    enabled: bool(src.enabled, DEFAULT_TEAM_CONFIG.enabled),
    maxSubagents,
    maxConcurrent: Math.min(
      maxSubagents,
      clampInt(src.maxConcurrent, DEFAULT_TEAM_CONFIG.maxConcurrent, CONCURRENT_RANGE),
    ),
    subagentTimeoutMs: clampInt(
      src.subagentTimeoutMs,
      DEFAULT_TEAM_CONFIG.subagentTimeoutMs,
      SUBAGENT_TIMEOUT_RANGE,
    ),
    dispatchTimeoutMs: clampInt(
      src.dispatchTimeoutMs,
      DEFAULT_TEAM_CONFIG.dispatchTimeoutMs,
      DISPATCH_TIMEOUT_RANGE,
    ),
    maxTurnsPerSubagent: clampInt(
      src.maxTurnsPerSubagent,
      DEFAULT_TEAM_CONFIG.maxTurnsPerSubagent,
      TURNS_RANGE,
    ),
  };
}

// ---------------------------------------------------------------------------
// Todo planning (todo-plan-execution §4.2)
//
// The FIFTH nested section in the persisted config, after `apiKeys`, `skills`,
// `log` and `team` — and, like all of them, SCALARS ONLY, exactly one level
// deep. `store.ts` merges these sections BY HAND and that merge is only correct
// while nesting stays flat; a nested field here means replacing that merge
// first.
//
// BOTH OF `store.ts`'s MERGES MUST LEARN ABOUT THIS SECTION, AND THE OMISSION IS
// SILENT (P0-1 / R-11). `/todo panel off` sends `{ todo: { panel: false } }`;
// without the merge the shallow top-level spread REPLACES the whole section,
// `enabled` is written to disk as absent, `config.todo.enabled` reads
// `undefined` on the next launch, and `todo_write` is never registered — because
// the user turned a *panel* off. No crash, no log line, no notice. That is the
// failure this file's `skills` and `log` sections each already record once.
// ---------------------------------------------------------------------------

export interface TodoConfig {
  /** Register `todo_write` at all. Default TRUE. */
  enabled: boolean;
  /**
   * Render the right rail.
   *
   * INDEPENDENT OF `enabled` ON PURPOSE (D-16): a screen-reader user wants the
   * planning discipline without the column, and the prompt block varies one
   * sentence rather than disappearing (§3.7).
   */
  panel: boolean;
  /**
   * What happens when a run ends with unfinished steps
   * (todo-plan-followthrough §4.1). Default `'notify'`, which reproduces round
   * 1's behaviour byte for byte.
   *
   * THE THIRD SCALAR, and it stays a scalar for the reason the section header
   * above gives: `store.ts` merges this section BY HAND, and both of its merges
   * spread the whole object (`{ ...DEFAULT_CONFIG.todo, ...(partial.todo ?? {}) }`
   * and `{ ...current.todo, ...(patch.todo ?? {}) }`), so a third scalar key is
   * carried automatically and needs no change there. A NESTED field would not
   * be, and would mean replacing both merges first.
   */
  followThrough: FollowThroughMode;
}

export const DEFAULT_TODO_CONFIG: TodoConfig = {
  enabled: true,
  panel: true,
  followThrough: 'notify',
};

/**
 * There is no enum helper in this file, so this follows the `isThinkingLevel`
 * shape already here rather than inventing a second idiom.
 */
const FOLLOW_THROUGH_MODES: FollowThroughMode[] = ['notify', 'auto', 'off'];

function followMode(value: unknown, fallback: FollowThroughMode): FollowThroughMode {
  return typeof value === 'string' && (FOLLOW_THROUGH_MODES as string[]).includes(value)
    ? (value as FollowThroughMode)
    : fallback;
}

/**
 * THE single gate for every todo-config read AND write, mirroring
 * `clampSkillsConfig` / `clampLogConfig` / `clampTeamConfig` for the reason
 * those record: hardening only the read path leaves a bad value on disk that
 * reverts to the default on every launch, which presents to the user as "my
 * setting won't stick".
 */
export function clampTodoConfig(raw: unknown): TodoConfig {
  const src = (raw && typeof raw === 'object' ? raw : {}) as Partial<
    Record<keyof TodoConfig, unknown>
  >;
  return {
    enabled: bool(src.enabled, DEFAULT_TODO_CONFIG.enabled),
    panel: bool(src.panel, DEFAULT_TODO_CONFIG.panel),
    // CLAMPED TO THE DEFAULT, NEVER REJECTED — the discipline every other key in
    // this file follows, and the trade round 1 already made for `--thinking`.
    // `ARAGON_TODO_FOLLOW=garbage` therefore resolves to `'notify'` and throws
    // nothing (AC-5).
    followThrough: followMode(src.followThrough, DEFAULT_TODO_CONFIG.followThrough),
  };
}

// ---------------------------------------------------------------------------
// API retry (llm-api-retry-backoff §6.1)
//
// The SIXTH nested section in the persisted config, after `apiKeys`, `skills`,
// `log`, `team` and `todo` — and, like all of them, SCALARS ONLY, exactly one
// level deep. `store.ts` merges these sections BY HAND and that merge is only
// correct while nesting stays flat; a nested field here means replacing both
// merges first.
//
// BOTH OF `store.ts`'s MERGES MUST LEARN ABOUT THIS SECTION, AND THE OMISSION IS
// SILENT (R-9). `/retry max 5` sends `{ retry: { maxRetries: 5 } }`; without the
// write merge the shallow top-level spread REPLACES the whole section and
// `respectRetryAfter` / `jitter` silently revert to defaults on disk. Without the
// read merge a user with no `retry` key gets `undefined` and `toRetryPolicy`
// throws. That is the failure this file's `skills`, `log` and `todo` sections
// each already record once.
// ---------------------------------------------------------------------------

export interface RetryConfig {
  /**
   * The user's switch. KEPT SEPARATE FROM `maxRetries: 0` on purpose: `enabled`
   * survives round-tripping through the settings screen, while `maxRetries: 0` is
   * what `toRetryPolicy` produces from it. Folding them would make
   * `/retry off; /retry on` forget the user's chosen count.
   */
  enabled: boolean;
  /** Retries AFTER the initial attempt. `0` is the kill switch, not a typo. */
  maxRetries: number;
  initialDelayMs: number;
  maxDelayMs: number;
  /** Growth factor. THE ONLY FLOAT KEY in this section. */
  multiplier: number;
  jitter: boolean;
  respectRetryAfter: boolean;
  /** Wall-clock budget from the first failure of one request. */
  maxElapsedMs: number;
  /** Allow a restart after content has already streamed to the transcript. */
  onPartialStream: boolean;
}

export const DEFAULT_RETRY_CONFIG: RetryConfig = {
  enabled: true,
  maxRetries: DEFAULT_RETRY_POLICY.maxRetries,
  initialDelayMs: DEFAULT_RETRY_POLICY.initialDelayMs,
  maxDelayMs: DEFAULT_RETRY_POLICY.maxDelayMs,
  multiplier: DEFAULT_RETRY_POLICY.multiplier,
  jitter: DEFAULT_RETRY_POLICY.jitter,
  respectRetryAfter: DEFAULT_RETRY_POLICY.respectRetryAfter,
  maxElapsedMs: DEFAULT_RETRY_POLICY.maxElapsedMs,
  onPartialStream: DEFAULT_RETRY_POLICY.onPartialStream,
};

/**
 * `hardMaxRetries` re-exported rather than re-spelled, for the reason
 * `HARD_MAX_SUBAGENTS` records: the ceiling is enforced in TWO places — here on
 * the config value, and again by `normalizePolicy` inside the engine — and two
 * copies of the same 20 is exactly how a hand-edited `config.json` ends up able
 * to raise a ceiling the mechanism fixed.
 */
export const HARD_MAX_RETRIES = RETRY_LIMITS.hardMaxRetries;

/** FLOOR 0 — and `clampIntAllowingZero` is what makes that reachable. */
const RETRY_MAX_RANGE = { min: 0, max: HARD_MAX_RETRIES };
const RETRY_INITIAL_DELAY_RANGE = { min: 100, max: 30_000 };
const RETRY_MAX_DELAY_RANGE = { min: 1000, max: RETRY_LIMITS.absoluteMaxDelayMs };
const RETRY_MULTIPLIER_RANGE = { min: 1, max: 5 };
const RETRY_ELAPSED_RANGE = { min: 10_000, max: 1_800_000 };

/**
 * THE single gate for every retry-config read AND write, mirroring
 * `clampSkillsConfig` / `clampLogConfig` / `clampTeamConfig` / `clampTodoConfig`
 * for the reason those record: hardening only the read path leaves a bad value on
 * disk that reverts to the default on every launch, which presents to the user as
 * "my setting won't stick".
 *
 * Three invariants live inside the gate:
 *
 *  - `maxDelayMs = max(maxDelayMs, initialDelayMs)` — a ceiling under the floor
 *    makes the ladder a flat line and the countdown a lie.
 *  - `multiplier` goes through `clampNumber`, not `clampInt`: `2.5` is a
 *    legitimate factor and `coercePositiveInt` would floor it to 2.
 *  - `maxRetries` goes through `clampIntAllowingZero`. THIS IS THE ONE THAT SHIPS
 *    BROKEN WITHOUT IT (R-16): `clampInt` returns the fallback for `n <= 0`, so
 *    `clampRetryConfig({ maxRetries: 0 })` would yield 10 — the maximum instead
 *    of the minimum, silently, for the key that gates the whole feature.
 *
 * `maxElapsedMs` intentionally keeps plain `clampInt`: its floor is 10 000, so it
 * has no `0` to express.
 */
export function clampRetryConfig(raw: unknown): RetryConfig {
  const src = (raw && typeof raw === 'object' ? raw : {}) as Partial<
    Record<keyof RetryConfig, unknown>
  >;
  const initialDelayMs = clampInt(
    src.initialDelayMs,
    DEFAULT_RETRY_CONFIG.initialDelayMs,
    RETRY_INITIAL_DELAY_RANGE,
  );
  const maxDelayMs = Math.max(
    initialDelayMs,
    clampInt(src.maxDelayMs, DEFAULT_RETRY_CONFIG.maxDelayMs, RETRY_MAX_DELAY_RANGE),
  );
  return {
    enabled: bool(src.enabled, DEFAULT_RETRY_CONFIG.enabled),
    maxRetries: clampIntAllowingZero(
      src.maxRetries,
      DEFAULT_RETRY_CONFIG.maxRetries,
      RETRY_MAX_RANGE,
    ),
    initialDelayMs,
    maxDelayMs,
    multiplier: clampNumber(
      src.multiplier,
      DEFAULT_RETRY_CONFIG.multiplier,
      RETRY_MULTIPLIER_RANGE,
    ),
    jitter: bool(src.jitter, DEFAULT_RETRY_CONFIG.jitter),
    respectRetryAfter: bool(src.respectRetryAfter, DEFAULT_RETRY_CONFIG.respectRetryAfter),
    maxElapsedMs: clampInt(
      src.maxElapsedMs,
      DEFAULT_RETRY_CONFIG.maxElapsedMs,
      RETRY_ELAPSED_RANGE,
    ),
    onPartialStream: bool(src.onPartialStream, DEFAULT_RETRY_CONFIG.onPartialStream),
  };
}

/**
 * `RetryConfig` (user intent) -> `RetryPolicy` (engine policy), or `null` for
 * "the user said no".
 *
 * `null` rather than a policy with `maxRetries: 0` because `ProviderRegistry`
 * short-circuits on a null policy and returns the adapter's iterator DIRECTLY —
 * an opted-out session is then allocation-identical to a pre-feature build.
 *
 * TOTAL, AND IT ACCEPTS A MISSING SECTION. `loadConfig` always supplies one, but
 * a `CliConfig` built by hand — every controller test in this package does exactly
 * that, and so would an embedder — legitimately omits it, and a `TypeError` from a
 * pure translation function is the wrong way to find out. Routing through
 * `clampRetryConfig` also means an out-of-range hand-built value can never reach
 * the engine, which is the same "one gate, both directions" rule every other
 * section in this file follows.
 */
export function toRetryPolicy(cfg: RetryConfig | undefined): RetryPolicy | null {
  const safe = clampRetryConfig(cfg);
  if (!safe.enabled || safe.maxRetries <= 0) return null;
  return {
    maxRetries: safe.maxRetries,
    initialDelayMs: safe.initialDelayMs,
    maxDelayMs: safe.maxDelayMs,
    multiplier: safe.multiplier,
    jitter: safe.jitter,
    respectRetryAfter: safe.respectRetryAfter,
    maxElapsedMs: safe.maxElapsedMs,
    onPartialStream: safe.onPartialStream,
  };
}

// ---------------------------------------------------------------------------
// Fast model tier (fast-model-tier §4.2)
//
// The SEVENTH nested section in the persisted config, after `apiKeys`,
// `skills`, `log`, `team`, `todo` and `retry` — and, like all of them, SCALARS
// ONLY, exactly one level deep. `store.ts` merges these sections BY HAND and
// that merge is only correct while nesting stays flat (C-3).
//
// BOTH OF `store.ts`'s MERGES MUST LEARN ABOUT THIS SECTION, AND THE OMISSION IS
// SILENT (R-10). `/fast review 8` sends `{ fast: { reviewEveryTurns: 8 } }`;
// without the merge the shallow top-level spread REPLACES the whole section,
// `enabled` is written to disk as absent, and the tier the user configured
// yesterday is gone tomorrow with no error anywhere. That is the `todo` P0-1
// story, one feature later.
// ---------------------------------------------------------------------------

export interface FastConfig {
  /**
   * Resolve the tier at all. Defaults to FALSE (R-d).
   *
   * OFF IS BYTE-IDENTICAL (I-2): with this false the system prompt, `task`'s
   * schema, the tool array, the transcript, the status bar and the request
   * payloads are exactly what a pre-feature build produces.
   */
  enabled: boolean;
  /** `''` INHERITS the main provider — what makes `fast.model` alone a complete
   *  configuration for the common "same vendor, cheaper model" case. */
  provider: string;
  /** The fast model id. Empty means NOT CONFIGURED, never "same as main": that
   *  distinction is what keeps R-e (opt in to fast == main) from being
   *  indistinguishable from a typo (D-4). */
  model: string;
  /** `''` inherits only when the provider matches — a base URL belongs to one
   *  API, so a fast tier on a different vendor must not borrow it. */
  baseUrl: string;
  /** Applied to fast-tier children and to the review call. Defaults to `'off'`:
   *  a "fast" model asked to think for 32 768 tokens is not fast (D-13). */
  thinkingLevel: ThinkingLevel;
  /** Allow `model: "fast"` on `task`. */
  delegate: boolean;
  /** Run the periodic asynchronous review. */
  review: boolean;
  /** Completed turns between reviews. */
  reviewEveryTurns: number;
  /** Turn frames included in one digest. */
  reviewContextTurns: number;
  /** Ceiling on an injected critique, in characters. */
  reviewMaxChars: number;
  /**
   * Reviews STARTED per session, across all runs (fast-model-tier-hardening
   * §4.1 / W1).
   *
   * The one bound on spend the user never asked for. `reviewEveryTurns`
   * controls the PACE; this controls the TOTAL — and the two are different
   * questions, because a session is not one run. `reviewsThisRun` is reset by
   * every user message, so thirty messages buys thirty runs' worth of reviews
   * with nothing counting across them.
   *
   * DENOMINATED IN REVIEWS, NOT CURRENCY (D-H1). The fast tier is by
   * construction the likeliest place in the product to name a model the static
   * cost table has never seen, and `buildRuntimeModel` prices exactly those at
   * zero (C-11) — so a dollar budget would silently never trigger for the
   * configuration that most needs it. A count is exact for every model, and
   * because per-review cost is already bounded on both sides (a 4 000-char
   * digest in, 512 tokens out), `count x bound` is an honest ceiling.
   */
  reviewMaxPerSession: number;
}

export const DEFAULT_FAST_CONFIG: FastConfig = {
  // R-d, and the one default in this file that is a REQUIREMENT rather than a
  // judgement: a feature that silently spends money on a second provider is not
  // a default (D-3).
  enabled: false,
  provider: '',
  model: '',
  baseUrl: '',
  thinkingLevel: 'off',
  delegate: true,
  review: true,
  reviewEveryTurns: 5,
  reviewContextTurns: 3,
  reviewMaxChars: 280,
  // 40 is roughly 200 reviewed turns at the default cadence: comfortably past a
  // full working session, short of a runaway (D-H2).
  reviewMaxPerSession: 40,
};

const REVIEW_EVERY_RANGE = { min: 1, max: 50 };
const REVIEW_CONTEXT_RANGE = { min: 1, max: 10 };
const REVIEW_CHARS_RANGE = { min: 80, max: 600 };
/** No "unlimited" sentinel: a magic `0` reads as "disabled" to the next person
 *  who meets it, and 500 is already past any session a human sits through. */
const REVIEW_SESSION_RANGE = { min: 1, max: 500 };

/** Trim a string field, falling back when the value is not a string at all. */
function text(v: unknown, fallback: string): string {
  return typeof v === 'string' ? v.trim() : fallback;
}

/**
 * THE single gate for every fast-config read AND write, mirroring
 * `clampSkillsConfig` / `clampLogConfig` / `clampTeamConfig` / `clampTodoConfig`
 * for the reason those four record: hardening only the read path leaves a bad
 * value on disk that reverts to the default on every launch, which presents to
 * the user as "my setting won't stick".
 *
 * `provider` is CLAMPED TO `''` rather than rejected when it names something
 * with no adapter. `''` means "inherit the main provider", which is the safe
 * reading of a typo — and `resolveFastTier` reports `no_adapter` for the case a
 * user really did configure a dead vendor as the MAIN one.
 */
export function clampFastConfig(raw: unknown): FastConfig {
  const src = (raw && typeof raw === 'object' ? raw : {}) as Partial<
    Record<keyof FastConfig, unknown>
  >;
  const provider = text(src.provider, DEFAULT_FAST_CONFIG.provider);
  return {
    enabled: bool(src.enabled, DEFAULT_FAST_CONFIG.enabled),
    provider: provider.length === 0 || isAdapterProvider(provider) ? provider : '',
    model: text(src.model, DEFAULT_FAST_CONFIG.model),
    baseUrl: text(src.baseUrl, DEFAULT_FAST_CONFIG.baseUrl),
    thinkingLevel: clampThinkingLevel(src.thinkingLevel, DEFAULT_FAST_CONFIG.thinkingLevel),
    delegate: bool(src.delegate, DEFAULT_FAST_CONFIG.delegate),
    review: bool(src.review, DEFAULT_FAST_CONFIG.review),
    reviewEveryTurns: clampInt(
      src.reviewEveryTurns,
      DEFAULT_FAST_CONFIG.reviewEveryTurns,
      REVIEW_EVERY_RANGE,
    ),
    reviewContextTurns: clampInt(
      src.reviewContextTurns,
      DEFAULT_FAST_CONFIG.reviewContextTurns,
      REVIEW_CONTEXT_RANGE,
    ),
    reviewMaxChars: clampInt(
      src.reviewMaxChars,
      DEFAULT_FAST_CONFIG.reviewMaxChars,
      REVIEW_CHARS_RANGE,
    ),
    reviewMaxPerSession: clampInt(
      src.reviewMaxPerSession,
      DEFAULT_FAST_CONFIG.reviewMaxPerSession,
      REVIEW_SESSION_RANGE,
    ),
  };
}

// ---------------------------------------------------------------------------
// Auto-update (cli-auto-update §4.1)
//
// The EIGHTH nested section in the persisted config, after `apiKeys`, `skills`,
// `log`, `team`, `todo`, `retry` and `fast` — and, like all of them, SCALARS
// ONLY, exactly one level deep. `store.ts` merges these sections BY HAND and
// that merge is only correct while nesting stays flat (C-5).
//
// BOTH OF `store.ts`'s MERGES MUST LEARN ABOUT THIS SECTION, AND THE OMISSION IS
// SILENT (C-4 / R-10). `config set update.mode notify` sends
// `{ update: { mode: 'notify' } }`; without the write merge the shallow
// top-level spread REPLACES the whole section and `checkIntervalMs`, `registry`
// and `distTag` silently revert on disk. This package has paid for that twice
// already — `todo` P0-1 and `fast` R-10 — which is why it is written down a
// third time rather than assumed to be common knowledge.
//
// FOUR KEYS AND NO MORE (D-16). `mode` covers on / notify / off; a fifth key
// (`autoInstall`) would be a second way to say the same thing, and two ways to
// express one setting is how they end up disagreeing.
// ---------------------------------------------------------------------------

/** `auto` installs; `notify` only reports; `off` disables the subsystem. */
export const UPDATE_MODES = ['auto', 'notify', 'off'] as const;
export type UpdateMode = (typeof UPDATE_MODES)[number];

export function isUpdateMode(v: unknown): v is UpdateMode {
  return typeof v === 'string' && (UPDATE_MODES as readonly string[]).includes(v);
}

export interface UpdateConfig {
  /**
   * Whether the updater installs, merely reports, or does nothing at all.
   *
   * DEFAULTS TO `'auto'`, and that is a PRODUCT decision rather than a technical
   * one: this CLI's users are overwhelmingly on a stale version they did not
   * choose. The trade it makes — a wider supply-chain window in exchange for
   * users who are actually on the current release — is stated plainly in the
   * README (R-1), and `'off'` plus `ARAGON_UPDATE=0` are the documented kill
   * switches.
   */
  mode: UpdateMode;
  /** Minimum wall-clock between registry checks, MACHINE-WIDE (§3.7). */
  checkIntervalMs: number;
  /** `''` = derive: `ARAGON_UPDATE_REGISTRY` › `npm_config_registry` › npmjs. */
  registry: string;
  /** The dist-tag to track. */
  distTag: string;
}

export const DEFAULT_UPDATE_CONFIG: UpdateConfig = {
  mode: 'auto',
  // FOUR HOURS, in ms. `checkIntervalMs` and not `checkIntervalHours` (D-17):
  // every other duration in this config is in ms (`toolTimeoutMs`,
  // `idleTimeoutMs`, `team.dispatchTimeoutMs`, `retry.initialDelayMs`), and one
  // unit per file is worth more than one shorter number.
  checkIntervalMs: 14_400_000,
  registry: '',
  distTag: 'latest',
};

/** 15 minutes to 7 days. The floor is a politeness bound on the registry. */
const UPDATE_INTERVAL_RANGE = { min: 900_000, max: 604_800_000 };
/** npm's own dist-tag grammar, loosely: no slashes, no spaces, no `@`. */
const DIST_TAG_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/i;

/**
 * THE single gate for every update-config read AND write, mirroring
 * `clampSkillsConfig` / `clampLogConfig` / `clampTeamConfig` / `clampTodoConfig`
 * / `clampRetryConfig` / `clampFastConfig` for the reason all six record:
 * hardening only the read path leaves a bad value on disk that reverts to the
 * default on every launch, which presents to the user as "my setting won't
 * stick".
 *
 * `registry` is CLAMPED TO `''` rather than rejected when it is not an
 * `http(s):` URL. `''` means "derive it" (§3.3), which is the safe reading of a
 * typo — the alternative is a background timer that throws on a value the user
 * cannot see it reading.
 */
export function clampUpdateConfig(raw: unknown): UpdateConfig {
  const src = (raw && typeof raw === 'object' ? raw : {}) as Partial<
    Record<keyof UpdateConfig, unknown>
  >;
  const registry = text(src.registry, DEFAULT_UPDATE_CONFIG.registry);
  const distTag = text(src.distTag, DEFAULT_UPDATE_CONFIG.distTag);
  return {
    mode: isUpdateMode(src.mode) ? src.mode : DEFAULT_UPDATE_CONFIG.mode,
    checkIntervalMs: clampInt(
      src.checkIntervalMs,
      DEFAULT_UPDATE_CONFIG.checkIntervalMs,
      UPDATE_INTERVAL_RANGE,
    ),
    registry: isRegistryUrl(registry) ? registry : DEFAULT_UPDATE_CONFIG.registry,
    distTag: DIST_TAG_RE.test(distTag) ? distTag : DEFAULT_UPDATE_CONFIG.distTag,
  };
}

function isRegistryUrl(raw: string): boolean {
  if (raw.length === 0) return false;
  try {
    const url = new URL(raw);
    // `http:` is accepted for a LAN mirror; nothing else is a registry.
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Context compaction (context-auto-compaction §4.2)
//
// The NINTH nested section in the persisted config, after `apiKeys`, `skills`,
// `log`, `team`, `todo`, `retry`, `fast` and `update` — and, like all eight of
// them, SCALARS ONLY, exactly one level deep. `store.ts` merges these sections
// BY HAND, in exactly two places, and that merge is only correct while nesting
// stays flat; a nested field here means replacing both merges first.
//
// BOTH OF `store.ts`'s MERGES MUST LEARN ABOUT THIS SECTION, AND THE OMISSION IS
// SILENT — the trap this file has now recorded four times (`todo` P0-1, `retry`
// R-9, `fast` R-10, `update`). `/compact threshold 0.8` sends
// `{ compaction: { threshold: 0.8 } }`; without the write merge the shallow
// top-level spread REPLACES the whole section, `enabled` is written to disk as
// absent, and a user who turned compaction OFF finds it back on tomorrow.
// ---------------------------------------------------------------------------

export type CompactionFailureMode = 'truncate' | 'stop';

export interface CompactionConfig {
  /**
   * Whether a `ContextManager` is constructed at all. Default TRUE.
   *
   * THE ONLY KEY IN THIS SECTION THAT DEFAULTS ON, AND THE ONLY ONE READ ONCE AT
   * CONSTRUCTION — the `team.enabled` / `todo.enabled` / `fast.enabled` rule.
   *
   * IT DEFAULTS TO `true` UNLIKE EVERY OTHER OPTIONAL SUBSYSTEM HERE, and that is
   * deliberate (D-16): `fast.enabled` and `team.enabled` default off because they
   * ADD behaviour the user did not ask for. This one REMOVES a failure the user
   * did not ask for — without it, the answer to a full context window is a dead
   * run. Byte-identity is still honoured: `--no-compaction` constructs no
   * manager, subscribes nothing, allocates no registry, and leaves the engine
   * loop with `ctx.contextManager === undefined`.
   */
  enabled: boolean;
  /** Occupancy ratio that triggers compaction. Read LIVE. */
  threshold: number;
  /**
   * Where the status-bar gauge turns amber.
   *
   * CLAMPED JOINTLY WITH `threshold`, AND THE ORDER IS FIXED — see
   * `clampCompactionConfig`. "Jointly" is not an instruction.
   */
  warnThreshold: number;
  /** Complete turns kept verbatim in the tail. Read LIVE. */
  keepRecentTurns: number;
  /**
   * Summarize with the fast tier when it resolves. Default TRUE.
   *
   * A PREFERENCE, NOT THE COMMON PATH (P2-8). `resolveFastTier` returns
   * `{ok:false, reason:'disabled'}` on `fast.enabled !== true` alone, and
   * `fast.enabled` defaults to `false` — so out of the box the summarizer is the
   * SESSION'S OWN MODEL, and the first compaction is a ~30 k-token call on it.
   */
  useFastTier: boolean;
  /** What happens when summarization fails outright. See §3.7 rungs 3 / 4. */
  onFailure: CompactionFailureMode;
  /**
   * Give `task` children their own compaction
   * (context-auto-compaction-hardening §3.4 / W3). Default TRUE.
   *
   * IT REVERSES D-15, WHOSE PREMISE IS MEASURABLY FALSE at the configured bounds:
   * `team.maxTurnsPerSubagent` is 24 and `team.dispatchTimeoutMs` is 900 000, and
   * 24 turns over fifteen minutes is the same profile as the lead run this
   * feature exists for. When a child overflows today its history is discarded and
   * the lead receives one partial sentence for the whole dispatch.
   *
   * `false` REPRODUCES ROUND 1 EXACTLY: `subagent.ts` spreads no `contextManager`
   * key at all, so the child's loop gate tests an absent field.
   */
  subagents: boolean;
  /**
   * Write the dropped messages to `<home>/compaction/` before adopting a splice
   * (context-auto-compaction-hardening §3.5 / W4). Default TRUE.
   *
   * NOT UNDO (§12): restoring an over-full history restores the condition that
   * triggered the compaction. This is fidelity on disk, so "the summary is wrong
   * and the agent proceeded on a false record" becomes something a human can
   * check rather than something they must accept.
   */
  archive: boolean;
}

export const DEFAULT_COMPACTION_CONFIG: CompactionConfig = {
  enabled: true,
  threshold: 0.9,
  warnThreshold: 0.75,
  keepRecentTurns: 4,
  useFastTier: true,
  onFailure: 'truncate',
  subagents: true,
  archive: true,
};

const THRESHOLD_RANGE = { min: 0.5, max: 0.95 };
const WARN_THRESHOLD_FLOOR = 0.4;
/** The gap the warn mark must stay below the trigger by. */
const WARN_THRESHOLD_GAP = 0.05;
const KEEP_RECENT_TURNS_RANGE = { min: 1, max: 20 };

const COMPACTION_FAILURE_MODES: CompactionFailureMode[] = ['truncate', 'stop'];

/**
 * Round a ratio to two decimals — the precision a percentage actually has.
 *
 * BINARY FLOATING POINT MAKES `0.95 - 0.05` EQUAL `0.8999999999999999`, and both
 * numbers here are produced by subtraction (`threshold - WARN_THRESHOLD_GAP`) and
 * by division (`parseThresholdInput` turning `90` into `90/100`). Without this,
 * `aragon config list` shows a seventeen-digit value for a setting the user typed
 * as `90%`, and `config.json` records one — which looks like corruption and
 * invites a hand-edit that the clamp then has to defend against.
 *
 * Two decimals is exact for every value the range can hold: the clamp is
 * `[0.5, 0.95]` and the UI reads it as a whole percentage.
 */
function ratio(value: number): number {
  return Math.round(value * 100) / 100;
}

function failureMode(value: unknown, fallback: CompactionFailureMode): CompactionFailureMode {
  return typeof value === 'string' && (COMPACTION_FAILURE_MODES as string[]).includes(value)
    ? (value as CompactionFailureMode)
    : fallback;
}

/**
 * THE single gate for every compaction-config read AND write, mirroring the six
 * clamps above for the reason all of them record: hardening only the read path
 * leaves a bad value on disk that reverts to the default on every launch, which
 * presents to the user as "my setting won't stick".
 *
 * THE ORDER IS FIXED AND IT MATTERS (§4.2 / P2-5). `threshold` is clamped to
 * `[0.5, 0.95]` FIRST, then `warnThreshold` to
 * `[0.4, clampedThreshold - 0.05]`. The other order lets a file holding
 * `{threshold: 0.6, warnThreshold: 0.9}` produce a warn mark ABOVE the trigger —
 * a gauge that turns amber after it has already gone red. Both bounds of the
 * second range stay reachable at the extremes: `threshold` floored at `0.5`
 * gives `warnThreshold` a range of `[0.4, 0.45]`.
 */
export function clampCompactionConfig(raw: unknown): CompactionConfig {
  const src = (raw && typeof raw === 'object' ? raw : {}) as Partial<
    Record<keyof CompactionConfig, unknown>
  >;
  const threshold = ratio(
    clampNumber(src.threshold, DEFAULT_COMPACTION_CONFIG.threshold, THRESHOLD_RANGE),
  );
  const warnCeiling = ratio(threshold - WARN_THRESHOLD_GAP);
  return {
    enabled: bool(src.enabled, DEFAULT_COMPACTION_CONFIG.enabled),
    threshold,
    warnThreshold: ratio(
      clampNumber(src.warnThreshold, DEFAULT_COMPACTION_CONFIG.warnThreshold, {
        min: Math.min(WARN_THRESHOLD_FLOOR, warnCeiling),
        max: warnCeiling,
      }),
    ),
    keepRecentTurns: clampInt(
      src.keepRecentTurns,
      DEFAULT_COMPACTION_CONFIG.keepRecentTurns,
      KEEP_RECENT_TURNS_RANGE,
    ),
    useFastTier: bool(src.useFastTier, DEFAULT_COMPACTION_CONFIG.useFastTier),
    // CLAMPED TO THE DEFAULT, NEVER REJECTED — the discipline every other key in
    // this file follows. `ARAGON_COMPACTION_ON_FAILURE=garbage` resolves to
    // `truncate` and throws nothing.
    onFailure: failureMode(src.onFailure, DEFAULT_COMPACTION_CONFIG.onFailure),
    subagents: bool(src.subagents, DEFAULT_COMPACTION_CONFIG.subagents),
    archive: bool(src.archive, DEFAULT_COMPACTION_CONFIG.archive),
  };
}

// ---------------------------------------------------------------------------
// Background services (background-service-supervision §5.4)
//
// The TENTH nested section in the persisted config, after `apiKeys`, `skills`,
// `log`, `team`, `todo`, `retry`, `fast`, `update` and `compaction` — and, like
// all nine of them, SCALARS ONLY, exactly one level deep. `store.ts` merges
// these sections BY HAND, in exactly two places, and that merge is only correct
// while nesting stays flat; a nested field here means replacing both merges
// first.
//
// BOTH OF `store.ts`'s MERGES MUST LEARN ABOUT THIS SECTION, AND THE OMISSION IS
// SILENT — the trap this file has now recorded five times (`todo` P0-1, `retry`
// R-9, `fast` R-10, `update`, `compaction`). A patch carrying only
// `{ bash: { autoBackground: false } }` would, without the write merge, be
// spread shallowly over the top level and write `background` to disk as absent —
// so turning the CLASSIFIER off would silently unregister `bash_output` and
// `bash_kill` from the next launch onward, with nothing anywhere saying so.
// ---------------------------------------------------------------------------

export interface BashConfig {
  /**
   * Register `bash_output` / `bash_kill`, honour `background`, splice the prompt
   * block, render the chip. Default TRUE.
   *
   * READ ONCE AT CONSTRUCTION, the `team.enabled` / `todo.enabled` /
   * `fast.enabled` rule.
   *
   * IT GOVERNS *SERVICES*, NEVER *INTERRUPTIBILITY* (I-2 / D-9). `Esc`/`Esc`,
   * the foreground child registry and `forceStop()` are unconditional, because
   * "bash always settles" and "Esc twice always works" are promised
   * unconditionally — a user who turned background services off has not asked
   * for a less interruptible agent.
   */
  background: boolean;
  /**
   * Let the classifier decide when the model did not say. Default TRUE.
   *
   * RESOLVES TO `false` WITHOUT AN INTERACTIVE VIEW (D-15 / P1-8), and that is
   * decided at the tool layer rather than here: the value on disk is the user's
   * preference, and headless has no card, no `/bg` and no user to keep a service
   * alive, so the rescue would be a surprise instead. An explicit
   * `background: true` is still honoured there — that one the model asked for.
   */
  autoBackground: boolean;
  /** How long a background launch may block the turn before returning. */
  startupSettleMs: number;
  /** How long a service may stay `starting` before it is called `running`. */
  readyTimeoutMs: number;
}

export const DEFAULT_BASH_CONFIG: BashConfig = {
  background: true,
  autoBackground: true,
  startupSettleMs: 4000,
  readyTimeoutMs: 60_000,
};

const STARTUP_SETTLE_RANGE = { min: 500, max: 30_000 };
const READY_TIMEOUT_RANGE = { min: 5_000, max: 600_000 };

/**
 * THE single gate for every bash-config read AND write, mirroring
 * `clampSkillsConfig` / `clampLogConfig` / `clampTeamConfig` / `clampTodoConfig`
 * for the reason those record: hardening only the read path leaves a bad value
 * on disk that reverts to the default on every launch, which presents to the
 * user as "my setting won't stick".
 *
 * CLAMPED, NEVER REJECTED — the discipline every other key in this file follows.
 * A garbage `startupSettleMs` resolves to 4000 and throws nothing.
 */
export function clampBashConfig(raw: unknown): BashConfig {
  const src = (raw && typeof raw === 'object' ? raw : {}) as Partial<
    Record<keyof BashConfig, unknown>
  >;
  return {
    background: bool(src.background, DEFAULT_BASH_CONFIG.background),
    autoBackground: bool(src.autoBackground, DEFAULT_BASH_CONFIG.autoBackground),
    startupSettleMs: clampInt(
      src.startupSettleMs,
      DEFAULT_BASH_CONFIG.startupSettleMs,
      STARTUP_SETTLE_RANGE,
    ),
    readyTimeoutMs: clampInt(
      src.readyTimeoutMs,
      DEFAULT_BASH_CONFIG.readyTimeoutMs,
      READY_TIMEOUT_RANGE,
    ),
  };
}

/**
 * Parse `0.9`, `90%` or `90` into a ratio, or `null` when it is neither.
 *
 * `null` RATHER THAN A CLAMPED DEFAULT, because this is a COMMAND argument and
 * not a config value: `/compact threshold banana` must say so rather than
 * silently setting 0.9 and reporting success.
 */
export function parseThresholdInput(raw: string): number | null {
  const trimmed = raw.trim().replace(/%$/, '');
  if (trimmed.length === 0) return null;
  const n = Number.parseFloat(trimmed);
  if (!Number.isFinite(n)) return null;
  // `90` means 90 %, `0.9` means 0.9. The ambiguity is only at `1`, which is
  // above the clamp ceiling either way.
  const ratio = n > 1 ? n / 100 : n;
  if (ratio <= 0 || ratio > 1) return null;
  return ratio;
}

// ---------------------------------------------------------------------------
// Persisted config (the JSON file at `<home>/config.json`)
// ---------------------------------------------------------------------------

export interface PersistedConfig {
  version: number;
  provider: string;
  model: string;
  baseUrl: string | null;
  thinkingLevel: ThinkingLevel;
  /**
   * Whether the terminal DRAWS the reasoning that came back
   * (agent-activity-presentation §4.1).
   *
   * ADJACENT TO `thinkingLevel` AND DELIBERATELY NAMED DIFFERENTLY: that key is
   * the effort the provider is asked to SPEND, this one is whether the transcript
   * shows it. They are one word apart in the config file and must never be
   * confused, which is why the flag is `--show-thinking` rather than the shorter
   * `--thinking` the existing key already resembles.
   */
  showThinking: boolean;
  /**
   * Whether a RUNNING tool card draws a bounded tail of its live output
   * (agent-activity-presentation-live §4.1).
   *
   * DEFAULT `true`, unlike `showThinking` next door (D-28). That key hides
   * information by default because reasoning is noise most of the time; this one
   * ADDS the information the requirement asks for, and its cost is bounded by
   * construction -- eight rows per call, sixteen calls, whatever the command
   * emits. It exists as a KILL SWITCH, not as an opt-in: "a build's output
   * redraws the transcript" is exactly the kind of change a user on a slow SSH
   * link may want off.
   */
  liveToolOutput: boolean;
  /**
   * Output token cap.
   *
   *   a number — an explicit cap, clamped to `[256, 200000]` on the way in AND
   *              on the way out, then clamped again at request time down to the
   *              target model's real ceiling when that ceiling is lower.
   *   `null`   — AUTO: use each model's own ceiling, never above 64000.
   *   absent   — the product default, 64000.
   *
   * `null` MEANS AUTO. It used to resolve to 64000 by accident (`pick()` skips
   * `null`), which left the user no way to express "let the model decide".
   */
  maxTokens: number | null;
  /**
   * The context window to measure occupancy against, or `null` for AUTO
   * (context-usage-gauge-accuracy §3.6).
   *
   * `null` MEANS AUTO - the model table's window, or `buildRuntimeModel`'s 128k
   * placeholder for a model the table has never seen. It exists because that
   * placeholder is a FABRICATED denominator: on a custom `baseUrl` or an
   * unlisted model id the gauge is a percentage of a number nobody supplied, and
   * before this key there was no way to correct it. Setting it also removes the
   * `?` marker from the absolute pair (I-6).
   */
  contextWindow: number | null;
  theme: ThemeName;
  /** Replace spinners with a static glyph for calmer, low-motion output. */
  reducedMotion: boolean;
  /** Full-screen TUI (still subject to the automatic downgrades in §4.1). */
  fullscreen: boolean;
  /** Replay a plain-text session summary after leaving the alternate screen. */
  exitTranscript: boolean;
  /** Entries reachable by scrolling; older ones show the "collapsed" line (I-3). */
  transcriptWindow: number;
  /** Entries kept in `ViewState`; older ones are dropped and counted (L1). */
  transcriptRetain: number;
  /** Adaptive coalescing under load (L4). */
  renderGovernor: boolean;
  /** Ceiling of the governor ladder in ms; `33` flattens it (L4). */
  maxRenderIntervalMs: number;
  /** Repaint only the frame rows that changed (tui-input-flicker-fix §5.1). */
  diffRender: boolean;
  /** Wrap each repaint batch in DEC 2026 synchronized update (§5.1). */
  syncOutput: boolean;
  confirmTools: boolean;
  toolTimeoutMs: number;
  idleTimeoutMs: number;
  /** provider -> key. Masked in the UI; the file is written 0600 on POSIX. */
  apiKeys: Record<string, string | null>;
  /**
   * Record submitted prompts to `<home>/prompt-history.jsonl` at all (D-9).
   *
   * A real preference, and the reason it belongs here rather than in
   * `state.json`: the user declares it, and switching it off is a decision they
   * expect to survive. Command-line only, like `log.redactSecrets` — there is
   * no settings-screen entry, because it is set once and then forgotten.
   */
  historyEnabled: boolean;
  /** Entry spacing: `comfortable` keeps a blank line at turn boundaries (§4.3). */
  density: DensityMode;
  /** Show the composer hint row at all. */
  hints: boolean;
  /**
   * Enable SGR mouse reporting in full-screen mode so the wheel scrolls the
   * transcript, whatever row the pointer is on (wheel-scrolls-transcript-only
   * §4.1).
   *
   * A PLAIN BOOLEAN, not a `fullscreen`-style tri-state: there are no
   * heuristics for an explicit `true` to override (D-10).
   */
  mouse: boolean;
  /**
   * Drag-select + copy in full-screen mode (tui-selection-and-scroll-follow
   * §6.1). Ignored when `mouse` is false; also decides whether `?1002h` is
   * written at all, so `false` is byte-identical to a pre-feature session.
   */
  mouseSelect: boolean;
  /**
   * Recognise pasted text and collapse a large paste into a placeholder
   * (tui-paste-handling D-10 / section 7.3).
   *
   * A PLAIN BOOLEAN and the ONLY user-facing key this feature adds: the collapse
   * threshold and every size bound are structural and live in `input/limits.ts`
   * / `ui/composer-limits.ts`. A tunable threshold is a preference nobody has
   * asked for; a kill switch is what a bug report needs.
   */
  paste: boolean;
  /** Idle ms before a paused viewport returns to the newest line; `0` disables. */
  scrollResumeMs: number;
  /** Start every session in PLAN mode (plan-mode §4.4). */
  planModeDefault: boolean;
  /** `ask_user` rounds allowed per user turn; clamped to [1, 10]. */
  planModeMaxAskRounds: number;
  /** Ceiling on a single human wait in ms; clamped to [60_000, 7_200_000]. */
  planModeHumanTimeoutMs: number;
  /** Skill system settings. The SECOND nested object in this file after apiKeys. */
  skills: SkillsConfig;
  /** Logging settings. The THIRD nested object; scalars only (see LogConfig). */
  log: LogConfig;
  /** Team mode. The FOURTH nested object; scalars only (see TeamConfig). */
  team: TeamConfig;
  /** Todo planning. The FIFTH nested object; scalars only (see TodoConfig). */
  todo: TodoConfig;
  /** API retry. The SIXTH nested object; scalars only (see RetryConfig). */
  retry: RetryConfig;
  /** Fast model tier. The SEVENTH nested object; scalars only (see FastConfig). */
  fast: FastConfig;
  /** Auto-update. The EIGHTH nested object; scalars only (see UpdateConfig). */
  update: UpdateConfig;
  /** Context compaction. The NINTH nested object; scalars only (see CompactionConfig). */
  compaction: CompactionConfig;
  /** Background services. The TENTH nested object; scalars only (see BashConfig). */
  bash: BashConfig;
}

export const DEFAULT_CONFIG: PersistedConfig = {
  version: CONFIG_VERSION,
  provider: 'anthropic',
  model: DEFAULT_MODEL,
  baseUrl: null,
  thinkingLevel: 'off',
  // Off by default — the product default this whole round exists to establish
  // (D-1). One config key restores the old behaviour permanently.
  showThinking: false,
  // ON by default (D-28), and the OPPOSITE of the key above it on purpose: this
  // one shows work that is otherwise invisible for the whole duration of the
  // most expensive thing the agent does.
  liveToolOutput: true,
  // The engine owns this number; spelling it here again is how the CLI and the
  // provider adapters end up disagreeing about what "the default" is.
  maxTokens: DEFAULT_MAX_OUTPUT_TOKENS,
  // AUTO. The model table is right for every listed model, and a default number
  // here would be the same fabricated denominator this key exists to correct.
  contextWindow: null,
  theme: 'auto',
  reducedMotion: false,
  fullscreen: true,
  exitTranscript: true,
  transcriptWindow: DEFAULT_TRANSCRIPT_WINDOW,
  transcriptRetain: DEFAULT_TRANSCRIPT_RETAIN,
  renderGovernor: DEFAULT_RENDER_GOVERNOR,
  maxRenderIntervalMs: DEFAULT_MAX_RENDER_INTERVAL_MS,
  diffRender: DEFAULT_DIFF_RENDER,
  syncOutput: DEFAULT_SYNC_OUTPUT,
  confirmTools: false,
  toolTimeoutMs: DEFAULT_TOOL_TIMEOUT_MS,
  idleTimeoutMs: DEFAULT_IDLE_TIMEOUT_MS,
  apiKeys: {},
  historyEnabled: true,
  density: 'comfortable',
  hints: true,
  mouse: true,
  mouseSelect: DEFAULT_MOUSE_SELECT,
  paste: true,
  scrollResumeMs: DEFAULT_SCROLL_RESUME_MS,
  planModeDefault: false,
  planModeMaxAskRounds: DEFAULT_PLAN_MAX_ASK_ROUNDS,
  planModeHumanTimeoutMs: DEFAULT_PLAN_HUMAN_TIMEOUT_MS,
  skills: DEFAULT_SKILLS_CONFIG,
  log: DEFAULT_LOG_CONFIG,
  team: DEFAULT_TEAM_CONFIG,
  // The load path's first spread is what supplies the section to a user with no
  // `todo` key at all, so this line is as required as the two merges in
  // `store.ts` (P0-1).
  todo: DEFAULT_TODO_CONFIG,
  // Same requirement one section later: without this line a user with no `retry`
  // key resolves `config.retry` to `undefined` and `toRetryPolicy` throws.
  retry: DEFAULT_RETRY_CONFIG,
  // And one section later again: the load path's first spread is what supplies
  // `fast` to a user whose `config.json` predates this feature, which is every
  // existing user. Without it `config.fast.enabled` reads `undefined`, which is
  // falsy and so LOOKS correct — right up until `/fast on` writes a section that
  // has no other keys in it (P0-1's shape, one feature later).
  fast: DEFAULT_FAST_CONFIG,
  // And one section later again, for the third time. Without this line a user
  // whose `config.json` predates auto-update resolves `config.update.mode` to
  // `undefined`, which is neither `'auto'` nor `'off'` — so the §3.8 gate
  // (`cfg.update.mode !== 'off'`) would read TRUE and the feature would be on
  // for a reason nobody could point at.
  update: DEFAULT_UPDATE_CONFIG,
  // And one section later again, for the fourth time. Without this line a user
  // whose `config.json` predates compaction resolves `config.compaction.enabled`
  // to `undefined`, which is FALSY — so a feature that is `true` by default would
  // arrive OFF for every existing user, which is the one direction this
  // particular default must never fail in.
  compaction: DEFAULT_COMPACTION_CONFIG,
  // And one section later again, for the fifth time. `bash.background` is `true`
  // by default, so a `config.json` predating this feature resolving it to
  // `undefined` would arrive with background services OFF for every existing
  // user — the same direction the compaction line above must never fail in.
  bash: DEFAULT_BASH_CONFIG,
};

/**
 * Runtime state that used to be stored in `config.json` by mistake
 * (config-state-separation §4.5). Each one now lives in its own file:
 * `promptHistory` → `prompt-history.jsonl`, `submitCount` / `mouseNoticeSeen`
 * → `state.json`, and `recentModels` was dead — nothing ever wrote it.
 */
export const LEGACY_STATE_KEYS = [
  'promptHistory',
  'submitCount',
  'mouseNoticeSeen',
  'recentModels',
] as const;

/**
 * THE single gate that keeps those keys out of `config.json`, and the one thing
 * in this change that cannot be skipped.
 *
 * `loadPersistedConfig()` merges `{ ...DEFAULT_CONFIG, ...partial }` where
 * `partial` is the raw parse of whatever is on disk. Removing the fields from
 * the interface therefore removes NOTHING from the file: the keys ride through
 * the spread and `updatePersistedConfig` writes them straight back. The user
 * deletes `promptHistory` by hand and watches it grow back.
 *
 * Applied on the READ side on purpose, which is what makes it self-healing:
 * every write goes read-strip-merge-write, so a hand-edited file, a downgrade
 * to 0.5.x and back, or a half-finished migration all converge on a clean file
 * at the next write. Same shape as `clampSkillsConfig` / `clampLogConfig` —
 * one door for both directions.
 */
export function stripLegacyStateKeys<T extends object>(raw: T): T {
  const out = { ...raw } as Record<string, unknown>;
  for (const key of LEGACY_STATE_KEYS) delete out[key];
  return out as T;
}

// ---------------------------------------------------------------------------
// Effective in-memory config consumed by the controller and the UI.
// ---------------------------------------------------------------------------

export interface CliConfig {
  provider: string;
  model: string;
  baseUrl?: string;
  thinkingLevel: ThinkingLevel;
  /**
   * Seeds `ViewState.thinkingVisible` on the first frame (§4.1 / P1-2).
   *
   * IT MUST EXIST HERE AND NOT ONLY IN `PersistedConfig`. `App` reads `cfg.*`,
   * where `cfg` is a `CliConfig`; a key added to the persisted shape alone would
   * round-trip through `config set`, appear in `config list` — and never reach
   * `initialViewState`. `--show-thinking` and `ARAGON_SHOW_THINKING` would parse
   * and be discarded. Nothing would fail; the setting would simply do nothing.
   */
  showThinking: boolean;
  /**
   * Whether `AgentController` allocates the live-output store and binds
   * `recordOutput` (agent-activity-presentation-live §4.1).
   *
   * IT MUST EXIST HERE AND NOT ONLY IN `PersistedConfig`, for the reason its
   * neighbour records one comment up: the controller reads `config.*`, where
   * `config` is a `CliConfig`, so a key added to the persisted shape alone would
   * round-trip through `config set`, appear in `config list` -- and never reach
   * the constructor. `--live-tool-output` and `ARAGON_LIVE_TOOL_OUTPUT` would
   * parse and be discarded, with nothing failing.
   */
  liveToolOutput: boolean;
  /** The resolved cap, or `undefined` for AUTO (per-model ceiling, ≤ 64000). */
  maxTokens?: number;
  /**
   * The user's context-window override, or `null` for AUTO.
   *
   * IT MUST EXIST HERE AND NOT ONLY IN `PersistedConfig`, for the reason
   * `showThinking` / `liveToolOutput` / `diffRender` each record above: the
   * runtime reads `config.*`, where `config` is a `CliConfig`, so a key added to
   * the persisted shape alone would round-trip through `config set`, appear in
   * `config list` - and never reach `ContextMeter`. `ARAGON_CONTEXT_WINDOW`
   * would parse and be discarded, with nothing failing.
   */
  contextWindow: number | null;
  theme: ThemeName;
  reducedMotion: boolean;
  /**
   * TRI-STATE, and deliberately so (spec §4.1 vs §6.2):
   *   `false`     — an explicit opt-out from any layer; always inline.
   *   `true`      — an explicit FORCE, only from `--fullscreen` / `ARAGON_FULLSCREEN=1`;
   *                 overrides the TERM/CI/size heuristics.
   *   `undefined` — no explicit choice (including a config file holding the
   *                 default `true`); full-screen with the heuristics live.
   * Folding the persisted default into `true` would turn every user's config
   * file into a permanent "ignore the CI and TERM=dumb downgrades" switch.
   */
  fullscreen?: boolean;
  /** Replay a plain-text summary on exit (full-screen only — see §4.4). */
  exitTranscript: boolean;
  /** Entries reachable by scrolling; older ones show the "collapsed" line (I-3). */
  transcriptWindow: number;
  /**
   * Entries kept in `ViewState` (L1).
   *
   * Resolved to be `>= transcriptWindow`: retaining fewer entries than the
   * window can scroll to would silently make part of the window unreachable.
   */
  transcriptRetain: number;
  /**
   * What the user actually asked `transcriptRetain` to be, present ONLY when
   * that value had to be raised (§5.1).
   *
   * A setting ignored without a word is the one failure mode this feature is
   * not allowed to add: the eco chip, `/perf` and the dropped-entry line all
   * exist so that nothing it does happens unannounced, and a config key
   * overwritten in silence would be the exception. `undefined` means nothing
   * was overridden, which is every default session.
   */
  transcriptRetainRequested?: number;
  /** Adaptive coalescing under load (L4). */
  renderGovernor: boolean;
  /** Ceiling of the governor ladder in ms; `33` flattens it (L4). */
  maxRenderIntervalMs: number;
  /**
   * Repaint only the frame rows that changed (tui-input-flicker-fix §5.1).
   *
   * IT MUST EXIST HERE AND NOT ONLY IN `PersistedConfig`, for the reason
   * `showThinking` / `liveToolOutput` / `update` each record: `runInteractive`
   * reads `config.diffRender`, where `config` is a `CliConfig`, so a key added to
   * the persisted shape alone would round-trip through `config set`, appear in
   * `config list` — and never reach the one gate that constructs the writer.
   * `--no-diff-render` and `ARAGON_DIFF_RENDER=0` would parse and be discarded,
   * with no compile error and no runtime error.
   */
  diffRender: boolean;
  /** Wrap each repaint batch in DEC 2026 synchronized update (§5.1). */
  syncOutput: boolean;
  confirmTools: boolean;
  toolTimeoutMs: number;
  idleTimeoutMs: number;
  /** provider -> resolved key (config-file key ?? provider env var). */
  apiKeys: Record<string, string | undefined>;
  /**
   * Whether submitted prompts are recorded (D-9).
   *
   * The recall LIST is deliberately not here: its only consumer is one
   * `useState` seed in `App.tsx`, and carrying it on `CliConfig` would make
   * every `loadConfig()` — `aragon logs tail` and `aragon skills list`
   * included — read a file it has no use for (D-4).
   */
  historyEnabled: boolean;
  density: DensityMode;
  hints: boolean;
  /**
   * Whether this session may enable SGR mouse reporting (full-screen + TTY
   * only). Resolved by `resolveMouse` in `load.ts`.
   */
  mouse: boolean;
  /**
   * Whether this session may drag-select and copy.
   *
   * IT MUST EXIST HERE AND NOT ONLY IN `PersistedConfig`, for the reason
   * `diffRender` above records at length: `runInteractive` reads
   * `config.mouseSelect` — where `config` is a `CliConfig` — to decide the
   * `?1002h` write, the controller and the `decorate` hook. A key added to the
   * persisted shape alone would round-trip through `config set`, appear in
   * `config list`, and never reach a single one of them.
   */
  mouseSelect: boolean;
  /**
   * Whether this session recognises pastes at all.
   *
   * IT MUST EXIST HERE AND NOT ONLY IN `PersistedConfig`, for the reason
   * `mouseSelect` above records: `runInteractive` reads `config.paste` -- where
   * `config` is a `CliConfig` -- to decide the filter's `paste` feature, the
   * `?2004h` write and the `PasteBridge`. A key added to the persisted shape
   * alone would round-trip through `config set`, appear in `config list`, and
   * reach none of them.
   */
  paste: boolean;
  /** Idle ms before a paused viewport returns to the newest line; `0` disables. */
  scrollResumeMs: number;
  /**
   * Whether this session opens in PLAN mode.
   *
   * Named for what it DOES rather than mirroring the persisted key: after
   * resolution it is a resolved starting posture, not a preference, and the
   * live mode from here on belongs to the controller.
   */
  startInPlanMode: boolean;
  planModeMaxAskRounds: number;
  planModeHumanTimeoutMs: number;
  skills: SkillsConfig;
  /** Flag/env-only skill switches for this run (§7.5). Never persisted. */
  skillsRuntime: SkillsRuntimeOptions;
  /** Resolved logging settings; the authoritative input to `Logger.reconfigure`. */
  log: LogConfig;
  /**
   * Resolved team-mode settings (team-subagents §3.10).
   *
   * `enabled` here decides whether `task` is REGISTERED, which happens once at
   * construction and can never be undone (§4.5 / D-17). The live on/off switch
   * `/team` flips is a separate flag on the controller.
   */
  team: TeamConfig;
  /**
   * Resolved todo-planning settings (todo-plan-execution §4.2).
   *
   * `enabled` here decides whether `todo_write` is REGISTERED, which happens
   * once at construction and can never be undone (C-1). The live on/off switch
   * `/todo` flips is a separate flag on the controller; `panel` is read at
   * RENDER time through `controller.getConfig()`, which is why `/todo panel`
   * must call `setTodoConfig` as well as persisting (P1-2).
   */
  todo: TodoConfig;
  /**
   * Resolved API-retry settings (llm-api-retry-backoff §6.2).
   *
   * Unlike `team.enabled` / `todo.enabled` this decides NOTHING at construction
   * time: the policy lives on the `ProviderRegistry` and `setRetryConfig()`
   * replaces it live, so `/retry off` takes effect in the running session. That is
   * why the controller has no `retryRegistered` twin of the two flags above.
   */
  retry: RetryConfig;
  /**
   * Resolved fast-tier settings (fast-model-tier §4.2).
   *
   * `enabled` here decides `fastRegistered` — whether `task`'s schema carries a
   * `model` property at all — which happens once at construction and can never
   * be undone (C-2). The live on/off switch `/fast` flips is a separate flag on
   * `FastWiring`.
   *
   * THE OTHER NINE KEYS ARE READ LIVE, and that is not the same statement.
   * `provider` / `model` / `baseUrl` feed `resolveFastTier`, which is re-run on
   * every config mutation (§3.2 rule 8 / RV-3) because `''` INHERITS from
   * `config.provider` / `config.baseUrl` and those are rewritten by `/model`,
   * `/provider`, `/reload` and the settings screen.
   */
  fast: FastConfig;
  /**
   * Resolved auto-update settings (cli-auto-update §4.1).
   *
   * `mode` here decides whether `runInteractive` CONSTRUCTS the service at all
   * (§3.8), which is what makes `'off'` byte-identical to a pre-feature build:
   * no timer, no file read, no socket. The other three keys are read by the
   * service on every check, so a `/update off` mid-session stops the next one.
   *
   * IT MUST EXIST HERE AND NOT ONLY IN `PersistedConfig`, for the reason
   * `showThinking` and `liveToolOutput` each record above: the gate reads
   * `cfg.update`, where `cfg` is a `CliConfig`, so a key added to the persisted
   * shape alone would round-trip through `config set`, appear in `config list` —
   * and never reach the gate. `--no-update` and `ARAGON_UPDATE=0` would parse
   * and be discarded, with no compile error and no runtime error.
   */
  update: UpdateConfig;
  /**
   * Resolved context-compaction settings (context-auto-compaction §4.2).
   *
   * `enabled` here decides whether `AgentController` CONSTRUCTS a
   * `CompactionWiring` at all, which is what makes `false` byte-identical to a
   * pre-feature build: no manager is passed to `new Agent({...})`, nothing is
   * subscribed, no registry is allocated, and the loop's checkpoint is one `if`
   * against an absent field. The other five keys are read LIVE on every use, so
   * `/compact threshold 0.8` takes effect in the running session.
   *
   * IT MUST EXIST HERE AND NOT ONLY IN `PersistedConfig`, for the reason
   * `showThinking`, `liveToolOutput`, `diffRender`, `mouseSelect` and `update`
   * each record above: the controller and the compactor read `config.compaction`,
   * where `config` is a `CliConfig`, so a key added to the persisted shape alone
   * would round-trip through `config set`, appear in `config list` — and never
   * reach either of them.
   */
  compaction: CompactionConfig;
  /**
   * Resolved background-service settings (background-service-supervision §5.4).
   *
   * `background` here decides whether `bash`'s schema carries a `background`
   * property, whether `bash_output` / `bash_kill` are REGISTERED and whether
   * `<background_services>` is spliced — all three at construction, and none of
   * them undoable, the `team.enabled` / `todo.enabled` / `fast.enabled` rule.
   * The other three keys are read LIVE.
   *
   * IT DOES NOT GATE THE INTERRUPT LADDER (I-2 / D-9). `ProcSupervisor` is
   * constructed unconditionally, because `Esc`/`Esc` and the foreground registry
   * are what make G2 and G3 true and those are promised whatever this says.
   *
   * IT MUST EXIST HERE AND NOT ONLY IN `PersistedConfig`, for the reason every
   * section above records: the controller and `bash` read `config.bash`, where
   * `config` is a `CliConfig`, so a key added to the persisted shape alone would
   * round-trip through `config set`, appear in `config list` — and never reach
   * either of them.
   */
  bash: BashConfig;

  // Resolved, non-persisted fields.
  /**
   * Lifetime submit count driving the composer hint fade (`HINT_FADE_AFTER`).
   *
   * Read from `<home>/state.json` rather than the config file. It stays on
   * `CliConfig` — unlike the recall list — because it is one scalar that is
   * already plumbed through `controller.getConfig()` / `setSubmitCount()` and
   * read during render (D-4).
   */
  submitCount: number;
  /** Working directory for tools (default `process.cwd()`, overridable). */
  cwd: string;
  /** Whether ANSI color is enabled. */
  color: boolean;
  /** Detected terminal color depth (0 none · 1 16 · 2 256 · 3 truecolor). */
  colorLevel?: 0 | 1 | 2 | 3;
  /** Detected Unicode support (box/round glyphs & spinners). */
  unicode?: boolean;
  /** One-shot `--api-key` override; applies to the active provider only. */
  apiKeyOverride?: string;
}

// ---------------------------------------------------------------------------
// Coercion / validation helpers
// ---------------------------------------------------------------------------

/** Coerce an arbitrary value into a positive integer, or `undefined`. */
function coerceTokenCount(v: unknown): number | undefined {
  if (v === null || v === undefined || v === '') return undefined;
  const n = typeof v === 'number' ? v : Number.parseInt(String(v), 10);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return Math.floor(n);
}

/**
 * Coerce an arbitrary value into a positive integer, or `undefined`.
 *
 * Kept because callers outside this feature still use it, and deliberately
 * WITHOUT the range clamp so its behaviour for in-range values is byte-identical
 * to what it always was. New code wants `clampMaxTokens`.
 */
export function coerceMaxTokens(v: unknown): number | undefined {
  return coerceTokenCount(v);
}

/**
 * The accepted range for an explicit output cap.
 *
 * The floor is the engine's: below it a turn cannot produce a usable tool call.
 * The ceiling is a sanity bound on a hand-edited file, not a model limit — the
 * real per-model ceiling is applied later, by `resolveOutputTokens`.
 */
export const MAX_TOKENS_RANGE = {
  min: MIN_MAX_OUTPUT_TOKENS,
  max: ABSOLUTE_MAX_OUTPUT_TOKENS,
};

/** `auto`, an empty string and `0` all mean AUTO — "let the model decide". */
export function isAutoToken(v: unknown): boolean {
  if (v === 0) return true;
  if (typeof v !== 'string') return false;
  const trimmed = v.trim().toLowerCase();
  return trimmed === '' || trimmed === 'auto' || trimmed === '0';
}

/**
 * THE single gate for every `maxTokens` read AND write, in the shape
 * `clampSkillsConfig` / `clampLogConfig` / `clampTeamConfig` already use.
 *
 * Both directions on purpose: hardening only the read path leaves a bad value on
 * disk that reverts to a default on every launch, which presents to the user as
 * "my setting won't stick".
 *
 * Returns `undefined` for AUTO and for anything unusable — the caller decides
 * which of the two it was, because they mean different things.
 */
export function clampMaxTokens(v: unknown): number | undefined {
  const n = coerceTokenCount(v);
  if (n === undefined) return undefined;
  return Math.min(MAX_TOKENS_RANGE.max, Math.max(MAX_TOKENS_RANGE.min, n));
}

/**
 * Parse text typed into the settings screen, a slash command, or `config set`.
 *
 * Distinguishes AUTO from "the user typed nonsense", which `clampMaxTokens`
 * cannot: both come back as `undefined` there, and treating a typo as AUTO would
 * silently discard the number the user meant to set.
 */
export function parseMaxTokensInput(
  raw: string,
):
  | { kind: 'auto' }
  | { kind: 'value'; value: number; clamped: boolean }
  | { kind: 'invalid' } {
  const trimmed = String(raw ?? '').trim();
  if (isAutoToken(trimmed)) return { kind: 'auto' };
  if (!/^\d+$/.test(trimmed)) return { kind: 'invalid' };
  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return { kind: 'invalid' };
  const value = Math.min(MAX_TOKENS_RANGE.max, Math.max(MAX_TOKENS_RANGE.min, parsed));
  return { kind: 'value', value, clamped: value !== parsed };
}

/** The product default, re-exported so the CLI never spells the number itself. */
export const DEFAULT_MAX_TOKENS = DEFAULT_MAX_OUTPUT_TOKENS;

/** Coerce a value into a positive integer with a fallback (for timeouts). */
export function coercePositiveInt(v: unknown, fallback: number): number {
  if (v === null || v === undefined || v === '') return fallback;
  const n = typeof v === 'number' ? v : Number.parseInt(String(v), 10);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.floor(n);
}

/**
 * Mask a secret for display: keep a short prefix + suffix, redact the middle.
 * A short/empty key is fully redacted so the length is not leaked.
 *
 * The glyphs are parameters with ASCII defaults (spec §4.1 tier B). This module
 * has no terminal capabilities to consult, and the result is rendered in the
 * settings screen — which on a legacy `cmd.exe` used to show two question-mark
 * boxes where the redaction dots belonged. The UI passes its resolved glyphs;
 * every other caller gets output that is safe anywhere.
 */
export function maskSecret(
  key: string | undefined | null,
  opts: { maskChar?: string; ellipsis?: string } = {},
): string {
  const maskChar = opts.maskChar ?? '*';
  const ellipsis = opts.ellipsis ?? '...';
  if (!key) return '(not set)';
  const trimmed = key.trim();
  if (trimmed.length <= 8) return maskChar.repeat(4);
  return `${trimmed.slice(0, 3)}${ellipsis}${trimmed.slice(-4)}`;
}
