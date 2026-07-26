/**
 * Skill budgets and format constants — the single source of truth (spec §11.1).
 *
 * UNIT DISCIPLINE (D19 / R16): every `*_BYTES` constant below is measured in
 * UTF-8 BYTES, never in JS string length. `ToolExecutor`'s own ceiling
 * (`DEFAULT_MAX_OUTPUT_SIZE = 100_000`) is a byte count and `truncateUtf8()`
 * cuts on byte boundaries, so a "30 000 characters" budget silently becomes
 * 90 000 bytes for CJK text and gets halved by the executor — taking the
 * closing `</skill>` tag with it. Always measure with `Buffer.byteLength`.
 *
 * No magic numbers anywhere else in the skills subsystem.
 */

// ---------------------------------------------------------------------------
// Level 1 — catalog block (system prompt)
// ---------------------------------------------------------------------------

/** Whole `<available_skills>` block ceiling, UTF-8 bytes. */
export const SKILL_CATALOG_MAX_BYTES = 6000;

/** Per-entry description cap (characters — this one is a display width, not a budget). */
export const SKILL_DESC_LINE_MAX = 220;

// ---------------------------------------------------------------------------
// Catalog ranking buckets (§5.2)
// ---------------------------------------------------------------------------

/**
 * INTEGER BUCKETS, NEVER FLOATS. The Level 1 catalog order is a hard
 * determinism requirement (§5.1): a score computed from, say, a decayed
 * timestamp would make truncation depend on when the test ran and leave the
 * byte-budget suites unpinnable. Buckets keep the comparison exact.
 */
export const USAGE_RECENCY_HOUR_MS = 60 * 60 * 1000;
export const USAGE_RECENCY_DAY_MS = 24 * USAGE_RECENCY_HOUR_MS;
export const USAGE_RECENCY_WEEK_MS = 7 * USAGE_RECENCY_DAY_MS;

/** `useCount` thresholds for the frequency bucket (2 / 1 / 0). */
export const USAGE_FREQ_HIGH = 10;
export const USAGE_FREQ_LOW = 3;

/**
 * Scope outweighs every usage signal by construction: a `project` skill was put
 * there FOR THIS REPOSITORY, so even an unused one is closer to the task at hand
 * than a frequently used global. Usage only reorders within one scope.
 */
export const SCOPE_SCORE_WEIGHT = 1000;
export const RECENCY_SCORE_WEIGHT = 10;

// ---------------------------------------------------------------------------
// `skill_find` — the escape hatch for a truncated catalog (§5.4)
// ---------------------------------------------------------------------------

/** Whole `<skill_search_results>` block ceiling, UTF-8 bytes. */
export const SKILL_FIND_MAX_BYTES = 8000;

/** Results returned when the model does not ask for a specific count. */
export const SKILL_FIND_DEFAULT_LIMIT = 10;

/** Hard ceiling on `limit`; a larger request is clamped, not rejected. */
export const SKILL_FIND_MAX_LIMIT = 25;

/** Query tokens honoured. Extra words are dropped rather than failing the call. */
export const SKILL_FIND_MAX_TOKENS = 8;

// ---------------------------------------------------------------------------
// Level 2 — `skill` tool result
// ---------------------------------------------------------------------------

/** SKILL.md body ceiling inside a `skill` tool result, UTF-8 bytes. */
export const SKILL_BODY_MAX_BYTES = 30_000;

/**
 * Hard ceiling on the ENTIRE `skill` tool result, UTF-8 bytes.
 *
 * Deliberately 40 KB below `ToolExecutor`'s 100 000-byte cap so this tool can
 * never trigger upstream truncation — which would append `... [truncated]`
 * after eating the closing tag and hand the model a structurally broken block.
 */
export const SKILL_RESULT_MAX_BYTES = 60_000;

/** Max bundled-file entries listed in `<skill_files>`. */
export const SKILL_FILES_MAX = 50;

/**
 * Hard ceiling on the whole `/<skill-name>` invocation MESSAGE, UTF-8 bytes.
 *
 * Same number as `SKILL_RESULT_MAX_BYTES`, deliberately a SEPARATE name (D-G12).
 * The two ceilings exist for DIFFERENT reasons: the tool-result one dodges
 * `ToolExecutor`'s 100 000-byte cut, which would eat the closing tag; this one
 * exists because one injected reference document must not swallow the context
 * window. Sharing a constant would make "it is safe to raise one" read as "it is
 * safe to raise the other".
 *
 * WHY 60 000 IS ALWAYS ENOUGH TODAY: `skills.bodyMaxBytes` is clamped to at most
 * 50 000 (`cli/src/config/schema.ts::BODY_BYTES_RANGE.max`), which leaves 10 KB
 * for tags, the file list and the guidance. THAT CLAMP IS THE PREMISE — if it is
 * ever raised, this constant has to move with it, and nothing else would go red.
 */
export const SKILL_INVOCATION_MAX_BYTES = 60_000;

/**
 * Ceiling for the repeat-load digest (§7.2), UTF-8 bytes.
 *
 * The digest carries the open tag, the description line, the omitted-body note,
 * `<skill_files>` and the guidance — everything except the body itself. When it
 * still does not fit, `<skill_files>` rows are reclaimed; the structure is never
 * sacrificed, exactly as in `renderSkillBody`.
 */
export const SKILL_DIGEST_MAX_BYTES = 4_000;

/**
 * Refusals of the SAME tool within one turn before the refusal escalates (§5.5).
 *
 * "Do not retry this tool" is a request, not a mechanism. Without a counter a
 * single mis-declared skill can burn an entire turn on one blocked tool.
 */
export const TOOL_POLICY_DENY_ESCALATE_AT = 3;

/**
 * Bundled files that are "something you RUN" rather than "something you READ"
 * (§8.2). Used by `classifyBundledFile()`; a `scripts/` prefix counts too.
 */
export const SKILL_SCRIPT_EXTENSIONS = [
  '.py',
  '.js',
  '.mjs',
  '.cjs',
  '.ts',
  '.sh',
  '.ps1',
  '.bat',
  '.cmd',
] as const;

// ---------------------------------------------------------------------------
// `activation: always` block
// ---------------------------------------------------------------------------

/** Combined ceiling for all always-on skill bodies in the system prompt, UTF-8 bytes. */
export const ALWAYS_SKILLS_MAX_BYTES = 12_000;

// ---------------------------------------------------------------------------
// Disk / parsing limits
// ---------------------------------------------------------------------------

/** Largest SKILL.md the scanner will read, UTF-8 bytes. */
export const SKILL_MD_MAX_BYTES = 512 * 1024;

/** Frontmatter block hard limits (§4.3 rule 8) — defence against malformed files. */
export const FRONTMATTER_MAX_BYTES = 8 * 1024;
export const FRONTMATTER_MAX_LINES = 200;

/** Directories scanned per root before the scanner gives up (§6.2 step 6). */
export const SKILL_SCAN_MAX_DIRS = 500;

/** Soft wall-clock ceiling for one full discovery pass, milliseconds. */
export const SKILL_SCAN_SOFT_TIMEOUT_MS = 1500;

/** Staging leftovers older than this are reclaimed on the next discover() (P2-10). */
export const STAGING_TTL_MS = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Frontmatter field limits (§4.2)
// ---------------------------------------------------------------------------

/** `name` must be kebab-case ASCII. Also the dynamic slash-command name. */
export const SKILL_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const SKILL_NAME_MAX = 64;
export const SKILL_DESC_MAX = 1024;
export const SKILL_META_MAX = 256;
export const SKILL_KEYWORDS_MAX = 16;
export const SKILL_KEYWORD_LEN_MAX = 32;
export const SKILL_ALLOWED_TOOLS_MAX = 32;

// ---------------------------------------------------------------------------
// Staged-install validation limits (§8.3 step 2) — enforced by validateStagedSkill
// ---------------------------------------------------------------------------

export const STAGED_MAX_FILE_BYTES = 5 * 1024 * 1024;
export const STAGED_MAX_TOTAL_BYTES = 20 * 1024 * 1024;
export const STAGED_MAX_FILES = 200;
export const STAGED_MAX_DEPTH = 5;

/** `skill_create` inline file limits (§8.4). */
export const CREATE_MAX_FILE_BYTES = 1024 * 1024;
export const CREATE_MAX_FILES = 20;

/** Windows device names that can never be used as a path segment. */
export const WINDOWS_RESERVED_NAMES = new Set([
  'con',
  'prn',
  'aux',
  'nul',
  'com1',
  'com2',
  'com3',
  'com4',
  'com5',
  'com6',
  'com7',
  'com8',
  'com9',
  'lpt1',
  'lpt2',
  'lpt3',
  'lpt4',
  'lpt5',
  'lpt6',
  'lpt7',
  'lpt8',
  'lpt9',
]);
