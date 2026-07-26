/**
 * Config schema — the persisted config-file shape, the in-memory effective
 * config, sane defaults, and small validation/masking helpers.
 *
 * See spec §3.5 (resolution pipeline), §6.1 (config file), and §3.8 (timeout
 * invariant).
 */

import type { ThinkingLevel } from '@argon-agent/core';

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

/** Cap on persisted prompt history / recent-model MRU lists. */
export const PROMPT_HISTORY_CAP = 100;
export const RECENT_MODELS_CAP = 10;

/**
 * How many trailing entries the full-screen viewport renders (invariant I-3).
 * Yoga lays out every child even when `overflow: hidden` clips it, so the cost
 * of a long session is linear in the entry count regardless of visibility. The
 * reducer and `/save` keep the full history — this is a render-layer bound only.
 */
export const DEFAULT_TRANSCRIPT_WINDOW = 300;
export const MIN_TRANSCRIPT_WINDOW = 50;
export const MAX_TRANSCRIPT_WINDOW = 2000;

export function clampTranscriptWindow(v: unknown, fallback: number): number {
  const n = coercePositiveInt(v, fallback);
  return Math.min(MAX_TRANSCRIPT_WINDOW, Math.max(MIN_TRANSCRIPT_WINDOW, n));
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
  projectDirs: ['.argon/skills', '.claude/skills'],
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
// Persisted config (the JSON file at `envPaths('argon-agent').config`)
// ---------------------------------------------------------------------------

export interface PersistedConfig {
  version: number;
  provider: string;
  model: string;
  baseUrl: string | null;
  thinkingLevel: ThinkingLevel;
  maxTokens: number | null;
  theme: ThemeName;
  /** Replace spinners with a static glyph for calmer, low-motion output. */
  reducedMotion: boolean;
  /** Full-screen TUI (still subject to the automatic downgrades in §4.1). */
  fullscreen: boolean;
  /** Replay a plain-text session summary after leaving the alternate screen. */
  exitTranscript: boolean;
  /** Trailing entries the full-screen viewport renders (I-3). */
  transcriptWindow: number;
  confirmTools: boolean;
  toolTimeoutMs: number;
  idleTimeoutMs: number;
  /** provider -> key. Masked in the UI; the file is written 0600 on POSIX. */
  apiKeys: Record<string, string | null>;
  recentModels: string[];
  promptHistory: string[];
  /** Entry spacing: `comfortable` keeps a blank line at turn boundaries (§4.3). */
  density: DensityMode;
  /** Show the composer hint row at all. */
  hints: boolean;
  /** Lifetime submit count driving the progressive-disclosure fade (§4.6). */
  submitCount: number;
  /** Skill system settings. The SECOND nested object in this file after apiKeys. */
  skills: SkillsConfig;
}

export const DEFAULT_CONFIG: PersistedConfig = {
  version: CONFIG_VERSION,
  provider: 'anthropic',
  model: DEFAULT_MODEL,
  baseUrl: null,
  thinkingLevel: 'off',
  maxTokens: null,
  theme: 'auto',
  reducedMotion: false,
  fullscreen: true,
  exitTranscript: true,
  transcriptWindow: DEFAULT_TRANSCRIPT_WINDOW,
  confirmTools: false,
  toolTimeoutMs: DEFAULT_TOOL_TIMEOUT_MS,
  idleTimeoutMs: DEFAULT_IDLE_TIMEOUT_MS,
  apiKeys: {},
  recentModels: [],
  promptHistory: [],
  density: 'comfortable',
  hints: true,
  submitCount: 0,
  skills: DEFAULT_SKILLS_CONFIG,
};

// ---------------------------------------------------------------------------
// Effective in-memory config consumed by the controller and the UI.
// ---------------------------------------------------------------------------

export interface CliConfig {
  provider: string;
  model: string;
  baseUrl?: string;
  thinkingLevel: ThinkingLevel;
  maxTokens?: number;
  theme: ThemeName;
  reducedMotion: boolean;
  /**
   * TRI-STATE, and deliberately so (spec §4.1 vs §6.2):
   *   `false`     — an explicit opt-out from any layer; always inline.
   *   `true`      — an explicit FORCE, only from `--fullscreen` / `ARGON_FULLSCREEN=1`;
   *                 overrides the TERM/CI/size heuristics.
   *   `undefined` — no explicit choice (including a config file holding the
   *                 default `true`); full-screen with the heuristics live.
   * Folding the persisted default into `true` would turn every user's config
   * file into a permanent "ignore the CI and TERM=dumb downgrades" switch.
   */
  fullscreen?: boolean;
  /** Replay a plain-text summary on exit (full-screen only — see §4.4). */
  exitTranscript: boolean;
  /** Trailing entries the full-screen viewport renders (I-3). */
  transcriptWindow: number;
  confirmTools: boolean;
  toolTimeoutMs: number;
  idleTimeoutMs: number;
  /** provider -> resolved key (config-file key ?? provider env var). */
  apiKeys: Record<string, string | undefined>;
  recentModels: string[];
  promptHistory: string[];
  density: DensityMode;
  hints: boolean;
  submitCount: number;
  skills: SkillsConfig;
  /** Flag/env-only skill switches for this run (§7.5). Never persisted. */
  skillsRuntime: SkillsRuntimeOptions;

  // Resolved, non-persisted fields.
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
export function coerceMaxTokens(v: unknown): number | undefined {
  if (v === null || v === undefined || v === '') return undefined;
  const n = typeof v === 'number' ? v : Number.parseInt(String(v), 10);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return Math.floor(n);
}

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
