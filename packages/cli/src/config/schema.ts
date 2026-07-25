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

export type ThemeName = 'auto' | 'dark' | 'light';

export function clampTheme(v: unknown, fallback: ThemeName): ThemeName {
  return v === 'auto' || v === 'dark' || v === 'light' ? v : fallback;
}

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
  confirmTools: boolean;
  toolTimeoutMs: number;
  idleTimeoutMs: number;
  /** provider -> key. Masked in the UI; the file is written 0600 on POSIX. */
  apiKeys: Record<string, string | null>;
  recentModels: string[];
  promptHistory: string[];
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
  confirmTools: false,
  toolTimeoutMs: DEFAULT_TOOL_TIMEOUT_MS,
  idleTimeoutMs: DEFAULT_IDLE_TIMEOUT_MS,
  apiKeys: {},
  recentModels: [],
  promptHistory: [],
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
  confirmTools: boolean;
  toolTimeoutMs: number;
  idleTimeoutMs: number;
  /** provider -> resolved key (config-file key ?? provider env var). */
  apiKeys: Record<string, string | undefined>;
  recentModels: string[];
  promptHistory: string[];

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
 */
export function maskSecret(key: string | undefined | null): string {
  if (!key) return '(not set)';
  const trimmed = key.trim();
  if (trimmed.length <= 8) return '••••';
  return `${trimmed.slice(0, 3)}…${trimmed.slice(-4)}`;
}
