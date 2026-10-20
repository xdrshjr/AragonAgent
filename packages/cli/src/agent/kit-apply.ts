/**
 * The session exit: apply a kit WITHOUT writing the config file (§4.2 exit B).
 *
 * ASCII ONLY - `src/agent/**` is inside `glyphs.test.ts::inScope`.
 *
 * WHY A NARROW PORT AND NOT THE CONTROLLER: the same reason
 * `ModelSettingsController` exists next door - a five-method port can be stubbed
 * by one object literal in a test, so every refusal code is reachable without a
 * controller, a provider, or a disk. The controller supplies the real one.
 *
 * EVERY PATH EITHER APPLIES OR CHANGES NOTHING (I-10). There is no partial state
 * to clean up, because the whole thing is one `preview` call: the reused prepare
 * chain builds the snapshot before it touches the live config, exactly as a save
 * does - only the commit is missing.
 */

import type { CliConfig } from '../config/schema.js';
import type { ModelSettingsDraft, ModelSettingsSaveResult } from '../config/model-profile-store.js';
import { emptyModelProfiles } from '../config/model-profiles.js';
import type { HasApiKey } from '../team/model.js';
import { findKit, kitCandidate, kitSlotConnections, type AgentKit, type KitApplyResult,
  type KitNote, type KitSlot } from '../config/model-kits.js';
import { ALL_SLOTS } from '../config/kit-resolution.js';
import { modelSettingsResultMessage } from './model-profile-settings.js';

export interface KitApplyPort {
  getConfig(): CliConfig;
  /** `controller.isModelSettingsBusy` - a run, a team, a review, a compaction. */
  isBusy(): boolean;
  /** `controller.hasApiKey`: two-parameter form, so a role-scoped key is seen. */
  hasKey: HasApiKey;
  /** `controller.createModelSettingsDraft`: already seeded with `sessionKit`. */
  createDraft(): ModelSettingsDraft;
  /** `previewModelSettings`: validate + prepare + apply, never commit. */
  preview(draft: ModelSettingsDraft): ModelSettingsSaveResult;
}

/**
 * Kit-specific wording, layered over `modelSettingsResultMessage` (RV-P1-3).
 *
 * ONLY the codes whose save-screen text would send the user to the wrong screen
 * are overridden. Everything else keeps the wording the settings screen already
 * uses, so a `read_failed` reads the same wherever it appears.
 */
const KIT_CODE_MESSAGES: Record<string, string> = {
  busy: 'Wait for the current run to finish before switching kit.',
  conflict: 'Settings changed elsewhere. Reload before switching kit.',
  write_failed: 'Could not write config. Your settings are unchanged.',
  apply_failed: 'Could not apply the kit to this session. Nothing changed.',
  kit_missing: 'That kit is not in your library. Create it in /settings (Settings > Kit pack).',
  kit_references_missing_profile:
    'That kit points at a profile that no longer exists.'
    + ' Fix it in /settings (Settings > Kit pack).',
};

/**
 * The `KitNote` sentences, verbatim (agent-model-kits §4.2).
 *
 * ONE TABLE, THREE CALLERS: the picker, `/kit use`, and any future surface must
 * say the same thing about the same consequence. `fast_review_enabled` is the
 * one that matters most - it is a recurring charge the user did not ask for by
 * name, only by applying a kit that switches the tier on.
 */
const KIT_NOTE_MESSAGES: Record<KitNote, string> = {
  fast_tier_enabled: 'Fast tier enabled by this kit.',
  fast_review_enabled:
    'Periodic review is on for this tier (/fast review off to stop it).',
  fast_tier_off: 'Fast tier turned off by this kit.',
  restart_required: 'Fast tier needs a restart to take effect.',
  main_key_missing: 'Main profile has no API key; set one in /settings.',
  subagent_key_missing: 'Subagent profile has no API key; children fall back to main.',
  subagent_fast_unavailable:
    'Subagent uses the fast tier, which this kit leaves off; children fall back to main.',
};

/** One note, as the sentence the toast shows. Exhaustive by construction. */
export function kitNoteMessage(note: KitNote): string { return KIT_NOTE_MESSAGES[note]; }

/** Every note for a result, in the order the estimator emitted it. */
export function kitNoteMessages(notes: readonly KitNote[]): string[] {
  return notes.map(kitNoteMessage);
}

/** A non-empty sentence for EVERY code, including the two kit-only ones. */
export function kitApplyMessage(result: KitApplyResult): string {
  if (result.ok) {
    return result.released
      ? 'Kit released; using the config file\'s settings.'
      : 'Kit applied for this session.';
  }
  const code = result.code ?? 'invalid';
  const specific = KIT_CODE_MESSAGES[code];
  if (specific) return specific;
  // NO `apply_failed` BRANCH ABOVE: it is in the table, because a stopped apply
  // must say "nothing changed" rather than repeat the save screen's wording.
  // Every remaining code falls through to the shared table, which is what makes
  // "there is a code with no sentence" unrepresentable instead of merely unlikely.
  return modelSettingsResultMessage({ ok: false, persisted: false, status: 'rejected',
    code: code as ModelSettingsSaveResult['code'] });
}

/** Slots whose referenced profile is gone (I-8 / AC-39). */
function missingSlots(kit: AgentKit, draft: ModelSettingsDraft): KitSlot[] {
  const connections = kitSlotConnections(draft.profiles, kit);
  const missing: KitSlot[] = [];
  if (!connections.main) missing.push('main');
  if (kit.fastProfileId !== null && !connections.fast) missing.push('fast');
  if (kit.subagent.model === 'profile' && !connections.subagent.name) missing.push('subagent');
  return missing;
}

function missingIssue(slot: KitSlot, kit: AgentKit) {
  const field = slot === 'subagent' ? 'subagent.modelProfileId' : `${slot}ProfileId`;
  return { path: `modelProfiles.kits[${kit.id}].${field}` as string,
    code: 'missing_reference' as const,
    message: `Kit "${kit.name}" references a profile that no longer exists (${slot}).` };
}

function keyMissing(port: KitApplyPort, draft: ModelSettingsDraft, id: string | null,
  role: 'main' | 'fast'): boolean {
  const entry = id ? draft.profiles?.entries.find((candidate) => candidate.id === id) : undefined;
  if (!entry) return false;
  return !entry.apiKey && !port.hasKey(entry.provider, role);
}

/**
 * Everything the user is entitled to know about the apply (§4.2 `KitNote`).
 *
 * Computed from the config AS IT WAS BEFORE, because half of these are about
 * transitions ("the tier just came ON") and the other half are still true after.
 */
function kitNotes(input: {
  before: CliConfig;
  draft: ModelSettingsDraft;
  kit: AgentKit;
  port: KitApplyPort;
  restartRequired?: boolean;
}): KitNote[] {
  const { before, draft, kit, port } = input;
  const notes: KitNote[] = [];
  const wasEnabled = before.fast.enabled;
  if (kit.fastProfileId !== null && !wasEnabled) notes.push('fast_tier_enabled');
  // The honest disclosure of a real cost (F-23): a fast tier with review on
  // spends money on its own, every N turns, without being asked.
  if (kit.fastProfileId !== null && !wasEnabled && before.fast.review) {
    notes.push('fast_review_enabled');
  }
  if (kit.fastProfileId === null && wasEnabled) notes.push('fast_tier_off');
  if (input.restartRequired) notes.push('restart_required');
  if (keyMissing(port, draft, kit.mainProfileId, 'main')) notes.push('main_key_missing');
  if (kit.subagent.model === 'profile'
    && keyMissing(port, draft, kit.subagent.modelProfileId, 'main')) {
    notes.push('subagent_key_missing');
  }
  if (kit.subagent.model === 'fast' && kit.fastProfileId === null) {
    notes.push('subagent_fast_unavailable');
  }
  return notes;
}

/**
 * Apply a kit for THIS SESSION ONLY.
 *
 * `kitId` is a resolved id: the `/kit use` command and the picker may accept a
 * name or an `#id` prefix, but resolving those is the command layer's job, so
 * an ambiguous name is reported once, at the surface that accepted it.
 */
export function applySessionKit(input: { kitId: string; port: KitApplyPort }): KitApplyResult {
  const { kitId, port } = input;
  if (port.isBusy()) return { ok: false, code: 'busy', notes: [] };
  const before = port.getConfig();
  const draft = port.createDraft();
  const library = draft.profiles ?? emptyModelProfiles();
  const kit = findKit(library, kitId);
  if (!kit) return { ok: false, code: 'kit_missing', notes: [] };
  const missing = missingSlots(kit, draft);
  if (missing.length) {
    return { ok: false, code: 'kit_references_missing_profile', notes: [],
      issues: missing.map((slot) => missingIssue(slot, kit)) };
  }
  const patch = kitCandidate({ library, kit });
  draft.profiles = patch.modelProfiles;
  draft.patch = { ...draft.patch, team: patch.team, fast: patch.fast };
  // I-13: a kit that turns the tier OFF must NOT project the fast role, or
  // `projectModelProfiles`'s `continue` would copy the DISK fast endpoint into
  // the live config and the kit would read as "restore, then switch off".
  draft.activateRoles = kit.fastProfileId === null ? ['main'] : ['main', 'fast'];
  draft.sessionKit = { id: kit.id, held: [...ALL_SLOTS] };
  // THE MARKER, not a heuristic: this draft IS the kit, so `releasedSlots` must
  // not read the apply's own writes as user decisions (§4.2 exit B).
  draft.sessionKitFresh = true;
  const result = port.preview(draft);
  if (!result.ok) {
    return { ok: false, code: result.code ?? 'invalid', notes: [],
      ...(result.issues ? { issues: result.issues } : {}) };
  }
  const notes = kitNotes({ before, draft, kit, port,
    ...(result.restartRequired ? { restartRequired: true } : {}) });
  return { ok: true, notes };
}

/**
 * Release the session kit: back to the bindings in the config file (RV-P1-6).
 *
 * WITHOUT THIS the feature is one-way: `ctrl+K` could enter a session kit and
 * nothing could leave it except restarting the process. It shares the session
 * exit's prepare chain, so it inherits every refusal code rather than defining
 * a second set of failure semantics.
 */
export function clearSessionKit(port: KitApplyPort): KitApplyResult {
  if (port.isBusy()) return { ok: false, code: 'busy', notes: [] };
  const before = port.getConfig();
  const draft = port.createDraft();
  const file = draft.baseline;
  draft.sessionKit = null;
  draft.patch = {
    ...draft.patch,
    team: { model: file.team.model, modelProfileId: file.team.modelProfileId },
    // The disk fast section, KEY BY KEY: `enabled` restores the tier state and
    // the other three restore the endpoints the file names, so no trace of the
    // kit's fast choice survives in the live config.
    fast: { enabled: file.fast.enabled, provider: file.fast.provider,
      model: file.fast.model, baseUrl: file.fast.baseUrl },
  };
  draft.activateRoles = ['main', 'fast'];
  const result = port.preview(draft);
  if (!result.ok) return { ok: false, code: result.code ?? 'invalid', notes: [] };
  const notes: KitNote[] = [];
  if (result.restartRequired) notes.push('restart_required');
  if (before.fast.enabled && !file.fast.enabled) notes.push('fast_tier_off');
  return { ok: true, released: true, notes };
}
