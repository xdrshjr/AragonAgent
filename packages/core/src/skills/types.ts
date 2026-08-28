/**
 * Skill data model (spec §10.1).
 *
 * Pure types + one injected port. This module must stay free of `node:*` — the
 * host filesystem is reached only through `SkillHost`, which the CLI implements
 * (D1). `no-host-coupling.test.ts` enforces that red line mechanically.
 */

export type SkillScope = 'bundled' | 'user' | 'project' | 'env';

export type SkillActivation = 'auto' | 'always' | 'manual';

export interface SkillFrontmatter {
  name: string;
  description: string;
  version: string;
  license?: string;
  author?: string;
  homepage?: string;
  keywords: string[];
  allowedTools: string[];
  activation: SkillActivation;
  /** Every parsed key, including unknown ones (forward compat). */
  raw: Record<string, string | string[]>;
}

export interface SkillFileRef {
  /** Path relative to the skill directory, always with `/` separators. */
  path: string;
  bytes: number;
}

export interface SkillValidationIssue {
  level: 'error' | 'warn';
  code: string;
  message: string;
}

export interface SkillManifestFile {
  path: string;
  bytes: number;
  sha256: string;
}

export interface SkillManifestSource {
  kind: 'local-dir' | 'local-file' | 'git' | 'https-md' | 'https-zip' | 'inline';
  url: string;
  ref: string | null;
  subdir: string | null;
  /**
   * The commit sha a git source resolved to at install time; `null` for every
   * other kind and whenever `git rev-parse` did not answer.
   *
   * OPTIONAL ON PURPOSE (F10): `readManifest()` returns `null` for any
   * `schema !== 1`, so bumping the schema would demote every already-installed
   * skill to "no provenance" the moment an older CLI read it. New fields are
   * therefore always additive and always optional.
   */
  resolvedRef?: string | null;
}

export interface SkillManifest {
  schema: number;
  name: string;
  version: string;
  installedAt: number;
  installer: string;
  source: SkillManifestSource;
  files: SkillManifestFile[];
  totalBytes: number;
  /** Set by `skills update`; absent for a skill that was never updated. */
  updatedAt?: number;
  /** The version this skill carried before the last update. */
  previousVersion?: string;
}

/**
 * How a skill's `SKILL.md` compares to what the install manifest recorded (§8).
 *
 *   `unverified` — no manifest, or the check is switched off. Hand-authored,
 *                  bundled and `.claude/skills` skills live here permanently.
 *   `ok`         — byte-identical to the approved copy.
 *   `modified`   — the file on disk is not the one that was approved.
 */
export type SkillIntegrity = 'unverified' | 'ok' | 'modified';

export interface SkillUsageStat {
  useCount: number;
  /** epoch ms; `0` means never used. */
  lastUsedAt: number;
}

/** Skill name → usage counters. Local-only; see `usage.ts`. */
export type SkillUsageMap = Record<string, SkillUsageStat>;

export interface SkillRecord {
  name: string;
  description: string;
  scope: SkillScope;
  /** Absolute skill directory. */
  dir: string;
  /** Absolute path to SKILL.md. */
  entryPath: string;
  frontmatter: SkillFrontmatter;
  /** Lazily filled at Level 2. */
  body: string | null;
  /** Lazily filled at Level 2. */
  files: SkillFileRef[] | null;
  /** Size of SKILL.md in bytes. */
  bytes: number;
  disabled: boolean;
  issues: SkillValidationIssue[];
  invalid: boolean;
  /** Same-name records from lower-precedence roots. */
  shadowed: Array<{ scope: SkillScope; dir: string }>;
  /** Parsed .aragon-skill.json when present. */
  manifest: SkillManifest | null;
  /** False for `bundled`, `env`, and `.claude/skills` roots. */
  writable: boolean;
  /** SKILL.md vs. the manifest, computed during discovery at no extra I/O (§8.1). */
  integrity: SkillIntegrity;
}

/**
 * The injected filesystem port — keeps core free of `node:*`.
 *
 * ERROR CONTRACT (P2-8): every method here MAY THROW (the Node implementation
 * wraps sync fs calls: ENOENT / EACCES / EISDIR / ELOOP all surface as
 * exceptions). Core callers are responsible for try/catch; "never throws" is an
 * obligation of a tool's `execute()` (§5.2), never of this port.
 */
export interface SkillHost {
  readTextFile(path: string): string;
  listDir(path: string): Array<{ name: string; isDirectory: boolean; bytes: number }>;
  exists(path: string): boolean;
  join(...parts: string[]): string;
  relative(from: string, to: string): string;
  isAbsolute(p: string): boolean;
}

export interface SkillCatalogOptions {
  /** UTF-8 byte ceiling for the whole block. */
  maxBytes?: number;
  /** Character cap for a single entry's description. */
  descLineMax?: number;
  /** Append the `Skill tools: …` footer line. Default true. */
  includeToolLine?: boolean;
  /**
   * Usage counters used to rank entries within a scope (§5.2). Omitting this
   * reproduces the pre-ranking order byte for byte (invariant I-A1).
   */
  usage?: SkillUsageMap;
  /** Injected clock for the recency buckets; defaults to `Date.now()`. */
  now?: number;
}

export interface SkillFindOptions {
  /** Total number of installed skills searched, for the `of="N"` attribute. */
  total?: number;
  /**
   * How many skills matched BEFORE the caller applied its own `limit`. Defaults
   * to `matched.length`. Pass it whenever the array handed in has already been
   * sliced, so the `matched="N"` attribute stays truthful and the overflow line
   * still appears — a silently shortened result list is the same failure this
   * whole tool exists to undo.
   */
  matchedTotal?: number;
  /** UTF-8 byte ceiling for the whole result block. */
  maxBytes?: number;
  /** Character cap for a single entry's description. */
  descLineMax?: number;
  /** Near-miss names offered when nothing matched. */
  suggestions?: string[];
}

// ---------------------------------------------------------------------------
// Tool ceiling (§5) — `allowed-tools` as an executable declaration
// ---------------------------------------------------------------------------

export type SkillToolPolicyMode = 'off' | 'warn' | 'enforce';

/**
 * The host's shell family. Injected by the CLI (D-G14) — core never reads
 * `process`, because that would make the renderers untestable across platforms:
 * a snapshot taken on Windows could never cover the POSIX branch.
 */
export type SkillPlatform = 'win32' | 'posix';

/**
 * One skill's COMPLETE contribution to the ceiling.
 *
 * Not a bare name (evaluated P0-1): the refusal text has to say what THAT skill
 * declared, and a union `allowed` set — which also carries the floor — cannot be
 * reverse-engineered back into per-skill declarations.
 */
export interface ToolPolicySource {
  name: string;
  /** The raw declaration, verbatim and unmapped, so an author can grep for it. */
  declared: string[];
  /** Declared names that resolved to a tool on this host (ascending, deduped). */
  granted: string[];
}

export interface ToolPolicyInput {
  /** Skill records in the current turn's frame (order irrelevant). */
  frame: SkillRecord[];
  /** Tool names actually registered in this session (host-supplied). */
  registered: readonly string[];
  /** Always-permitted tools (host-supplied; D-G6 / D-G7). */
  floor: readonly string[];
  mode: SkillToolPolicyMode;
}

export interface ToolPolicyDecision {
  mode: SkillToolPolicyMode;
  /** `null` = no ceiling at all. Non-null is the permitted set. NEVER empty (I-G2). */
  allowed: ReadonlySet<string> | null;
  /** Skills that contributed, ascending by `name`. */
  sources: ToolPolicySource[];
  /** Convenience mirror of `sources.map(s => s.name)` for display / events. */
  sourceNames: string[];
  /** Skills waived wholesale by D-G4, with the names that could not be resolved. */
  ignored: Array<{ name: string; unresolved: string[] }>;
}

export interface ToolPolicyVerdict {
  allow: boolean;
  /**
   * Present only when `allow === false`: the actionable explanation the MODEL
   * reads. Mutable on purpose — `SkillService` appends the escalation line to it
   * on the Nth refusal rather than emitting a second message (§5.5).
   */
  message?: string;
  /** Present whenever the user should hear about it: one line for the transcript. */
  notice?: string;
}

/** The slice of a decision the renderers need. Kept flat so it can be snapshotted. */
export interface SkillPolicyView {
  mode: SkillToolPolicyMode;
  /** The full permitted set, ascending. */
  allowed: string[];
}

export interface SkillBodyOptions {
  bodyMaxBytes?: number;
  /** Hard ceiling on the whole rendered string. */
  resultMaxBytes?: number;
  filesMax?: number;
  alreadyLoaded?: boolean;
  arguments?: string;
  /** `'digest'` omits the body and points at the earlier copy (§7.2). */
  mode?: 'full' | 'digest';
  /**
   * Drives the one-line tool-ceiling statement.
   *
   * OMITTING IT MEANS "SAY NOTHING" — and that is the default for a reason
   * (P0-2 / D-G18). `activation: always` and `--skill` skills are exempt from the
   * ceiling, so telling the model every single turn that "only these tools are
   * permitted" would impose a restriction that does not exist, invisibly.
   */
  policy?: SkillPolicyView;
  platform?: SkillPlatform;
}

/** Options for the `/<skill-name>` invocation message (§6). */
export interface SkillInvocationOptions {
  bodyMaxBytes?: number;
  /** Defaults to `SKILL_INVOCATION_MAX_BYTES`. */
  resultMaxBytes?: number;
  filesMax?: number;
  platform?: SkillPlatform;
  policy?: SkillPolicyView;
}

/** A staged (not yet installed) file, as seen by `validateStagedSkill`. */
export interface StagedFile {
  /** Path relative to the staging root, `/`-separated. */
  path: string;
  bytes: number;
  /** True for symlinks and any non-regular entry. */
  isSymlink?: boolean;
}

export interface StagedValidationResult {
  ok: boolean;
  issues: SkillValidationIssue[];
  frontmatter: SkillFrontmatter | null;
  fileCount: number;
  totalBytes: number;
}
