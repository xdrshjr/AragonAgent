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

export interface RouterDeps {
  controller: AgentController;
  interaction: InteractionCoordinator;
  dispatch(action: ViewAction): void;
  readState(): ViewState;
  cwd(): string;
  reloadConfig(): CommandResult;
  writer: SessionCheckpointWriter;
  sessionId: string;
}

const ok = (value?: unknown): CommandResult => ({ ok: true, ...(value === undefined ? {} : { value }) });
const fail = (code: Extract<CommandResult, { ok: false }>['code'], message: string): CommandResult =>
  ({ ok: false, code, message });

const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'];

export class CommandRouter {
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
        const text = cmd.text.trim();
        if (text.length === 0) return fail('invalid_argument', 'The message is empty.');
        const outcome = interaction.submit(cmd.text);
        return outcome.accepted ? ok() : fail('rejected', outcome.reason ?? 'The message was not accepted.');
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
        const text = this.deps.readState().pendingSteering.find((item) => item.queueId === cmd.queueId)?.text;
        const outcome = controller.withdrawQueuedUserMessage(cmd.queueId);
        if (outcome === 'delivered') return fail('already_delivered', 'The model has already received this message.');
        if (outcome === 'unknown' || text === undefined) return fail('not_found', 'That queued message no longer exists.');
        dispatch({ type: 'steerWithdrawn', queueId: cmd.queueId });
        return ok({ text });
      }
    }
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
