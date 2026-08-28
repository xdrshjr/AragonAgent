/**
 * One-shot move of the four runtime-state keys out of `config.json`
 * (config-state-separation §4.6).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * WHY THIS EXISTS: the schema change alone would strip `promptHistory`,
 * `submitCount` and `mouseNoticeSeen` from an existing user's config file on
 * the first write after upgrading, with nowhere for the values to go. That is
 * the only path in this feature that can actually LOSE data, which is why the
 * strip and this migration must ship together.
 * ══════════════════════════════════════════════════════════════════════════
 *
 * THE IDEMPOTENCE KEY IS THE SOURCE DATA — "are those keys still in
 * config.json" — not a breadcrumb and not "does prompt-history.jsonl exist".
 * Same reasoning as `migrate-home.ts`: a breadcrumb written before a failed
 * step makes a half-finished migration skip itself forever. Keyed on the source,
 * a failure simply retries next launch, and the two import functions are
 * written so that retrying imports nothing twice.
 *
 * NEVER THROWS (C3) and never prints (D-8). The user sees no difference —
 * history still recalls, the counter still counts — so a line on stderr would
 * be noise, and `aragon config home` names the new files for anyone curious.
 */

import { readConfigFile, updatePersistedConfig } from './store.js';
import { importLegacyPromptHistory } from './prompt-history.js';
import { importLegacyUiState } from './ui-state.js';
import { LEGACY_STATE_KEYS } from './schema.js';
import { getLogger } from '../logging/logger.js';

export interface StateMigrationResult {
  /** The keys actually carried out of the file, e.g. `['promptHistory']`. */
  moved: string[];
  /** History entries imported, for the log record. */
  promptEntries: number;
  /** Returned rather than thrown (C3). */
  error?: string;
}

/** The raw shape on disk — these keys no longer exist on `PersistedConfig`. */
interface LegacyStateShape {
  promptHistory?: unknown;
  submitCount?: unknown;
  mouseNoticeSeen?: unknown;
  recentModels?: unknown;
  historyEnabled?: unknown;
}

export function migrateStateOutOfConfig(): StateMigrationResult {
  const result: StateMigrationResult = { moved: [], promptEntries: 0 };
  try {
    const { config } = readConfigFile();
    // A missing file has nothing to move; an UNPARSEABLE one must be left
    // exactly as it is, or the user's chance to fix their typo is gone.
    if (!config) return result;

    const legacy = config as LegacyStateShape;
    const present = LEGACY_STATE_KEYS.filter((key) => legacy[key] !== undefined);
    if (present.length === 0) return result;

    result.promptEntries = importHistory(legacy);
    importCounters(legacy);

    // An empty patch still goes read-strip-merge-write, so this is what makes
    // the legacy keys leave the file — `stripLegacyStateKeys` does the work.
    updatePersistedConfig({});
    result.moved = [...present];

    getLogger().info('migrate', 'migrate_state_split', {
      moved: result.moved,
      promptEntries: result.promptEntries,
    });
    return result;
  } catch (err) {
    return { moved: [], promptEntries: 0, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Import the recall list, unless the user turned recording off.
 *
 * THE `historyEnabled` CHECK IS NOT REDUNDANT with the one inside
 * `appendPrompt`. This runs before any `loadConfig()`, so the module-level
 * switch is still at its `true` default; the only place the user's real answer
 * exists at this moment is the config object read above. The path that makes it
 * matter: upgrade, switch recording off, downgrade to 0.5.x (which writes
 * `promptHistory` back into config.json), upgrade again. Without this, prompts
 * the user explicitly refused to have recorded get copied into the new file.
 */
function importHistory(legacy: LegacyStateShape): number {
  if (!Array.isArray(legacy.promptHistory) || legacy.promptHistory.length === 0) return 0;
  if (legacy.historyEnabled === false) return 0;
  const entries = legacy.promptHistory.filter((item): item is string => typeof item === 'string');
  return importLegacyPromptHistory(entries);
}

function importCounters(legacy: LegacyStateShape): void {
  const patch: Parameters<typeof importLegacyUiState>[0] = {};
  if (typeof legacy.submitCount === 'number') patch.submitCount = legacy.submitCount;
  if (typeof legacy.mouseNoticeSeen === 'boolean') patch.mouseNoticeSeen = legacy.mouseNoticeSeen;
  if (Object.keys(patch).length === 0) return;
  importLegacyUiState(patch);
}
