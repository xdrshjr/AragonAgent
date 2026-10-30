/**
 * `HostCommand` -> controller calls, with ONE uniform result shape.
 *
 * Every command answers `{ ok: true, value? }` or `{ ok: false, code, message }`; it never
 * throws across the port and never leaves the renderer waiting (the caller also has a 15 s
 * deadline, but a router that always answers makes that deadline a safety net, not a plan).
 * A command the host does not implement answers `unsupported` with its name - an explicit "no"
 * the UI can show - rather than silence.
 *
 * Commands that change the model, thinking or posture are refused while a run is live: the
 * terminal refuses them for the same reason (an answer must not change model half-way).
 */

import type { Entry, ViewAction, ViewState } from '@aragon-agent/tui/model/agent/reducer';
import type { AgentController } from '@aragon-agent/cli/dist/host/controller-factory.js';
import { startIndexBuild, type InteractionCoordinator, type SessionCheckpointWriter } from '@aragon-agent/cli/dist/host/index.js';
import type { CommandResult, HostCommand } from '../shared/port-protocol.js';
import { searchFiles } from './file-search.js';
import { buildSubmission, type BuiltSubmission } from './attachments.js';
import { lookupLedger, sessionAttachmentsDir } from './attachment-ledger.js';
import {
  ATTACHMENT_READ_MAX_BYTES,
  type AttachmentReadValue,
  type SubmitResultValue,
} from '../shared/attachments.js';
import { readFile, stat } from 'node:fs/promises';

export interface RouterDeps {
  controller: AgentController;
  interaction: InteractionCoordinator;
  dispatch(action: ViewAction): void;
  readState(): ViewState;
  cwd(): string;
  reloadConfig(): CommandResult;
  writer: SessionCheckpointWriter;
  sessionId: string;
  /** Needed for attachments; hosts built without it simply refuse them. */
  homeRoot?: string;
}

const ok = (value?: unknown): CommandResult => ({ ok: true, ...(value === undefined ? {} : { value }) });
const fail = (code: Extract<CommandResult, { ok: false }>['code'], message: string): CommandResult =>
  ({ ok: false, code, message });

const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'];

/** Inline image bytes of a message still waiting in the engine queue, so a withdrawal never loses them. */
const MAX_RETAINED_MESSAGES = 16;

export class CommandRouter {
  private readonly retained = new Map<string, { id: string; bytes: Uint8Array }[]>();

  constructor(private readonly deps: RouterDeps) {}

  private get busy(): boolean {
    const { controller, interaction } = this.deps;
    return controller.isRunning() || interaction.phase !== 'idle' || controller.isCompactionBusy?.() === true;
  }

  private refuseWhileBusy(what: string): CommandResult | null {
    return this.busy ? fail('busy', `${what} is not available while a run is in progress.`) : null;
  }

  async run(cmd: HostCommand): Promise<CommandResult> {
    const { controller, interaction, dispatch } = this.deps;
    switch (cmd.c) {
      case 'ping':
        return ok();

      case 'submit': {
        if (cmd.attachments?.length) return this.submitWithAttachments(cmd);
        const text = cmd.text.trim();
        if (text.length === 0) return fail('invalid_argument', 'The message is empty.');
        const outcome = interaction.submit(cmd.text);
        return outcome.accepted ? ok() : fail('rejected', outcome.reason ?? 'The message was not accepted.');
      }

      case 'attachment.read':
        return this.readAttachment(cmd.id);

      case 'image.override': {
        if (cmd.key.length === 0 || cmd.key.length > 200 || !cmd.key.includes('/')) {
          return fail('invalid_argument', 'The model key is not valid.');
        }
        if (cmd.value !== null && cmd.value !== 'on' && cmd.value !== 'off') {
          return fail('invalid_argument', 'The override must be on, off or null.');
        }
        controller.setImageSupportOverride?.(cmd.key, cmd.value);
        return ok();
      }

      case 'interrupt':
        return ok({ action: interaction.interrupt() });
      case 'abort':
        controller.abort();
        return ok();
      case 'force-stop':
        controller.forceStop();
        return ok();

      case 'mode.set': {
        const refused = this.refuseWhileBusy('Changing the mode');
        if (refused) return refused;
        const state = controller.setAgentMode(cmd.mode);
        return ok(state);
      }
      case 'posture.set':
      case 'posture.cycle': {
        const cycle = controller.getPostureCycle();
        const current = controller.getPosture();
        const next = cmd.c === 'posture.set' ? cmd.posture : cycle[(cycle.indexOf(current) + 1) % cycle.length];
        if (!next || !cycle.includes(next)) {
          return fail('rejected', controller.getGovernanceUnavailableText() ?? 'That mode is not available.');
        }
        const state = controller.setPosture(next);
        dispatch({
          type: 'setAgentMode', mode: controller.getAgentMode(), pending: null,
          posture: state.effective, pendingPosture: state.pending,
        });
        return ok(state);
      }

      case 'thinking.set': {
        if (!THINKING_LEVELS.includes(cmd.level)) return fail('invalid_argument', `Unknown thinking level "${cmd.level}".`);
        const refused = this.refuseWhileBusy('Changing the thinking level');
        if (refused) return refused;
        controller.setThinkingLevel(cmd.level as never);
        return ok();
      }
      case 'model.patch': {
        const refused = this.refuseWhileBusy('Changing the model');
        if (refused) return refused;
        const result = controller.saveModelSettingsPatch(cmd.patch as never);
        return result.ok ? ok(result) : fail('rejected', `The model could not be changed (${result.code ?? result.status}).`);
      }
      case 'kit.apply': {
        const refused = this.refuseWhileBusy('Applying a kit');
        if (refused) return refused;
        const result = controller.applySessionKit(cmd.kitId);
        return result.ok ? ok(result) : fail('rejected', 'The kit could not be applied.');
      }
      case 'kit.clear': {
        const refused = this.refuseWhileBusy('Clearing the kit');
        if (refused) return refused;
        const result = controller.clearSessionKit();
        return result.ok ? ok(result) : fail('rejected', 'The kit could not be cleared.');
      }
      case 'cwd.set': {
        const refused = this.refuseWhileBusy('Changing the working directory');
        if (refused) return refused;
        controller.setCwd(cmd.path);
        dispatch({
          type: 'notice', level: 'info',
          text: `Working directory is now ${controller.getCwd()}. Earlier messages ran in the previous directory.`,
        });
        return ok({ cwd: controller.getCwd() });
      }

      case 'compact': {
        const result = await controller.compactNow(cmd.instructions);
        return result.ok ? ok() : fail('rejected', result.reason ?? 'Compaction did not run.');
      }
      case 'compact.cancel':
        await controller.cancelCompaction();
        return ok();
      case 'context.get':
        return ok(controller.getContextUsage());

      case 'todo.reopen-acceptance':
        return ok({ reopened: controller.reopenAcceptance() });

      case 'team.arm-forced':
        return ok({ armed: controller.armForcedTeam(cmd.count) });
      case 'team.disarm':
        controller.disarmForcedTeam();
        return ok();

      case 'gov.pause':
        return ok(await controller.requestGovernancePause());
      case 'gov.cancel-pause':
        return ok({ cancelled: controller.cancelGovernancePause() });
      case 'gov.abort-stage':
        controller.abortGovernanceStage();
        return ok();
      case 'gov.runs':
        return ok(controller.listGovernanceRuns());
      case 'gov.report':
        return ok(controller.readGovernanceReport(cmd.runId));

      case 'service.stop':
        return ok(await controller.stopService(cmd.id));
      case 'service.read-log':
        return ok(controller.readServiceLog(cmd.id, cmd.since));

      case 'session.save': {
        const result = this.deps.writer.writeNow({ force: true });
        return result.ok ? ok({ path: result.path }) : fail('internal', `The session could not be saved (${result.reason}).`);
      }
      case 'session.pin': {
        const result = this.deps.writer.writeNow({ pin: cmd.pinned, force: true });
        return result.ok ? ok({ pinned: cmd.pinned }) : fail('internal', `The session could not be pinned (${result.reason}).`);
      }

      case 'files.search':
        return ok(await searchFiles(this.deps.cwd(), cmd.query));
      case 'file-patch.get': {
        const patch = controller.takeFilePatch(cmd.toolCallId);
        return patch ? ok(patch) : fail('rejected', 'That change is no longer available.');
      }
      case 'transcript.page':
        return ok(this.page(cmd.before, cmd.limit));

      case 'reload-config':
        return this.deps.reloadConfig();

      case 'slash':
        return this.slash(cmd.name, cmd.args);

      case 'index.build': {
        const outcome = startIndexBuild(controller, interaction);
        if (outcome.ok) return ok({ rebuild: outcome.rebuild });
        return fail(outcome.code === 'busy' ? 'busy' : 'rejected', outcome.message);
      }

      case 'queue.cancel': {
        // The engine queue is the one authority (spec R-V6): `withdrawn` only when the
        // envelope was still waiting. The text comes from the view's own pending record,
        // read BEFORE the action removes it, so the renderer can put it back in the composer.
        const pending = this.deps.readState().pendingSteering.find((item) => item.queueId === cmd.queueId);
        const text = pending?.text;
        const outcome = controller.withdrawQueuedUserMessage(cmd.queueId);
        if (outcome === 'delivered') return fail('already_delivered', 'The model has already received this message.');
        if (outcome === 'unknown' || text === undefined) return fail('not_found', 'That queued message no longer exists.');
        dispatch({ type: 'steerWithdrawn', queueId: cmd.queueId });
        const attachments = pending?.attachments;
        // Bytes the host kept for this message stay readable (by id) after the withdrawal.
        return ok(attachments?.length
          ? { text, attachmentIds: attachments.map((a) => a.id), attachments }
          : { text });
      }
    }
  }

  private attachmentsDir(): string | null {
    const { homeRoot, sessionId } = this.deps;
    return homeRoot ? sessionAttachmentsDir(homeRoot, sessionId) : null;
  }

  /** Forget retained bytes for messages the engine has since accepted. */
  private pruneRetained(): void {
    const live = new Set(this.deps.readState().pendingSteering.map((item) => item.queueId));
    for (const queueId of this.retained.keys()) if (!live.has(queueId)) this.retained.delete(queueId);
  }

  private async submitWithAttachments(
    cmd: Extract<HostCommand, { c: 'submit' }>,
  ): Promise<CommandResult> {
    const { controller, interaction } = this.deps;
    const dir = this.attachmentsDir();
    if (!dir) return fail('unsupported', 'Attachments are not available in this session.');
    let built: BuiltSubmission;
    try {
      built = await buildSubmission(
        { text: cmd.text, attachments: cmd.attachments ?? [], imageMode: cmd.imageMode ?? 'inline' },
        { dir, usage: () => controller.getImageUsageInHistory() },
      );
    } catch (error) {
      const why = error instanceof Error ? error.message : String(error);
      return fail('internal', `The attachments could not be prepared (${why}).`);
    }
    if (cmd.text.trim().length === 0 && built.metas.length === 0) {
      return fail('attachment_rejected', 'None of the attachments could be sent.');
    }
    const outcome = interaction.submit(built.message, {
      attachments: { ...(built.parts ? { parts: built.parts } : {}), metas: built.metas, displayText: cmd.text },
    });
    if (!outcome.accepted) return fail('rejected', outcome.reason ?? 'The message was not accepted.');
    if (outcome.queueId && built.retained.length > 0) {
      this.pruneRetained();
      if (this.retained.size < MAX_RETAINED_MESSAGES) this.retained.set(outcome.queueId, built.retained);
    }
    const value: SubmitResultValue = {
      attachments: built.metas,
      dropped: built.dropped,
      ...(built.downgraded.length > 0 ? { downgraded: built.downgraded } : {}),
    };
    return ok(value);
  }

  /** Bytes (or the user's path) for one attachment id of THIS session; anything else is not_found. */
  private async readAttachment(id: string): Promise<CommandResult> {
    for (const held of this.retained.values()) {
      const hit = held.find((item) => item.id === id);
      if (hit) return this.retainedValue(id, hit.bytes);
    }
    const dir = this.attachmentsDir();
    const entry = dir ? lookupLedger(dir, id) : null;
    if (!entry) return fail('not_found', 'That attachment is no longer available.');
    if (!entry.staged) {
      const value: AttachmentReadValue = { name: entry.name, kind: entry.kind, path: entry.path };
      return ok(value);
    }
    try {
      const info = await stat(entry.path);
      if (info.size > ATTACHMENT_READ_MAX_BYTES) return fail('rejected', 'That attachment is too large to open.');
      const bytes = await readFile(entry.path);
      const value: AttachmentReadValue = {
        name: entry.name, kind: entry.kind,
        ...(entry.mediaType ? { mediaType: entry.mediaType } : {}),
        bytes: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
      };
      return ok(value);
    } catch {
      return fail('not_found', 'That attachment is no longer available.');
    }
  }

  private retainedValue(id: string, bytes: Uint8Array): CommandResult {
    const meta = this.deps.readState().pendingSteering.flatMap((item) => item.attachments ?? [])
      .find((item) => item.id === id);
    const value: AttachmentReadValue = {
      name: meta?.name ?? 'image', kind: 'image',
      bytes: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
    };
    return ok(value);
  }

  /** A page of already-settled entries older than `before` (an index), for long histories. */
  private page(before: number, limit: number): { entries: Entry[]; total: number } {
    const entries = this.deps.readState().entries;
    const end = Math.max(0, Math.min(before, entries.length));
    const size = Math.max(1, Math.min(limit, 200));
    return { entries: entries.slice(Math.max(0, end - size), end), total: entries.length };
  }

  /**
   * The slash commands the composer menu can run directly. The rest of the terminal's
   * commands are covered by dedicated desktop surfaces (see the parity matrix) and answer
   * `not_applicable` so the UI can point at the substitute instead of failing mysteriously.
   */
  private async slash(name: string, args: string): Promise<CommandResult> {
    const { controller, dispatch, readState } = this.deps;
    if (name === 'clear' && args.trim() === '') {
      const result = await controller.resetConversation({
        interrupt: true, readTranscript: () => readState().entries,
      });
      if (!result.ok) return fail('busy', result.message);
      dispatch({ type: 'resetConversation' });
      return ok({ archivedPath: result.archivedPath ?? null });
    }
    if (name === 'compact') {
      const result = await controller.compactNow(args.trim() || undefined);
      return result.ok ? ok() : fail('rejected', result.reason ?? 'Compaction did not run.');
    }
    return fail('not_applicable', `/${name} has a dedicated surface in the desktop app.`);
  }
}
