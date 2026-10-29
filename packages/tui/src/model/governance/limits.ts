/**
 * GOV_LIMITS - the single authority on every STRUCTURAL bound governance enforces
 * (governance-mode section 8.5), plus the stable tool-name sets and block versions.
 *
 * ASCII ONLY: `src/governance/**` is inside the glyph scanner's scope
 * (`glyphs.test.ts::inScope`, D-18).
 *
 * TWO KINDS OF NUMBER, exactly like `team/limits.ts`: the entries here are STRUCTURAL
 * (what the store, the digest and the panel can physically carry; a user has no
 * business tuning them) while the `governance.*` config keys (`config/schema.ts`) are
 * POLICY and clamped. `hardMax*` bound a config key and are applied twice: once in
 * `clampGovernanceConfig` and once in the engine, because a clamp that only runs on the
 * read path leaves a bad value on disk.
 */

export const GOV_LIMITS = {
  /** Ceiling for `governance.maxWorkPackages`. */
  hardMaxWorkPackages: 8,
  /** Ceiling for `governance.maxPhases`. */
  hardMaxPhases: 6,
  /** Ceiling for `governance.maxRework`, INCLUDING L3 `retry` grants. */
  hardMaxRework: 5,
  /** Ceiling for `governance.maxFixCycles`, INCLUDING L3 `retry` grants. */
  hardMaxFixCycles: 5,
  /** `gov_dispatch` calls per run. */
  hardMaxDispatches: 120,
  /** At most this many `retry` grants per WP (resolve.disposition). */
  maxReworkGrantsPerWp: 2,
  /** At most this many extra fix cycles may be granted per phase. */
  maxFixGrantsPerPhase: 1,

  // --- Input sizes (tool arguments) ---
  goalChars: 300,
  specChars: 12_000,
  wpIdChars: 16,
  wpTitleChars: 80,
  wpGoalChars: 1_200,
  wpFilesMax: 12,
  wpAcceptanceMax: 8,
  wpAcceptanceChars: 200,
  contractsMax: 12,
  contractNameChars: 80,
  contractDefinitionChars: 800,
  integrationCommandsMax: 6,
  integrationCommandChars: 300,
  noteChars: 600,
  rulingChars: 1_000,
  reasonChars: 300,
  /** `ledger_apply` evidence must carry at least this many characters (D-4). */
  evidenceMinChars: 20,
  evidenceMaxChars: 1_200,

  // --- Storage ---
  submissionBytes: 64_000,
  artifactBytesPerRun: 20_000_000,
  eventsFileBytes: 8_000_000,
  historyPerAgent: 200,
  retentionDays: 30,
  pruneMaxPerPass: 200,
  /** Heartbeat of `run.lock` while a stage runs. */
  lockHeartbeatMs: 15_000,
  /** A lock whose heartbeat is older than this is stale and may be taken over. */
  lockStaleMs: 60_000,

  // --- Reports ---
  digestMaxBytes: 6_000,
  finalReportMaxBytes: 24_000,
  /** Spec excerpt budget inside a child prompt. */
  specExcerptChars: 2_000,

  // --- Ledger parameters (Appendix A fixed parameters) ---
  initialTokens: 100,
  respawnTokens: 80,
  maxSingleReward: 20,
  maxSingleDeduction: -40,
  maxIncidentNegative: -50,
  tailEliminationThreshold: 60,
  healthWarnThreshold: 70,
  labelWarnThreshold: 80,
  labelDangerThreshold: 60,
  /** Active members of a role needed before tail elimination is considered. */
  tailEliminationMinRoleSize: 3,

  // --- Validation ---
  /** A child may fail validation this many times before the submission counts as absent. */
  maxValidationFailures: 3,
  /** Dispatch retries for a child that finished without a required submission. */
  maxAutoRedispatch: 1,
  /** `gov_view` requests per child, and the minimum reason length. */
  viewRequestsPerChild: 1,
  viewReasonMinChars: 20,
  /** `gov_scan` path cap. */
  scanPathsMax: 40,
  /** `gov_read` page size in characters. */
  readPageChars: 6_000,
  /** Budget warning fraction (>= this share of `budgetTokens`). */
  budgetWarnFraction: 0.8,
  /** `skeletonRatio` above this converts D9 into D11. */
  skeletonRatioThreshold: 0.3,
} as const;

/** Version of the schema written to `run.json` / `ledger.json`. */
export const GOV_SCHEMA_VERSION = 1;

/** Block versions: bump on ANY wording change so behavior reports can grep for them. */
export const GOVERNANCE_BLOCK_VERSION = 'v1-2026-10-24';
export const GOVERNANCE_ROLE_BLOCK_VERSION = 'v1-2026-10-24';
export const GOVERNANCE_PLAN_ADDENDUM_VERSION = 'v1-2026-10-24';

/** The two tools registered into the lead's array (NOT in HOST_TOOL_NAMES, D-22b). */
export const GOV_LEAD_TOOL_NAMES: ReadonlySet<string> = new Set(['gov_run', 'gov_dispatch']);

/** Every tool a governed child may be handed. Merged into `policyExempt` (7.1 rule 6). */
export const GOV_CHILD_TOOL_NAMES: ReadonlySet<string> = new Set([
  'gov_submit_work',
  'gov_submit_review',
  'gov_submit_test',
  'ledger_standings',
  'gov_read',
  'gov_scan',
  'gov_view',
  'ledger_apply',
  'ledger_rule',
  'ledger_settle',
]);

/**
 * The lead tools a governed ORCHESTRATOR may not call: the plan-mode blocked set plus
 * `task` (the latter only while the gate mode is `build`). Kept as a literal list so a
 * future change to `PLAN_MODE_BLOCKED_TOOLS` is a deliberate edit, not an accident.
 */
export const GOVERN_ORCHESTRATOR_REFUSED_TOOLS: readonly string[] = [
  'write_file',
  'edit_file',
  'bash',
  'bash_kill',
  'skill_install',
  'skill_create',
  'task',
];

/** Run directory id: "g" + base36(timeMs) + 3 random [a-z0-9]. */
export const RUN_ID_PATTERN = /^g[a-z0-9]{4,12}$/;
