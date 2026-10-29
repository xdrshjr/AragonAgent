/**
 * The data plane: what crosses the `MessagePort` between a session host and its window.
 *
 * Everything here must survive `structuredClone` (no functions, no class instances other than
 * `Set`/`Map`), because that is what a `MessagePort` does to it. `structured-clone.test.ts`
 * walks a fixture of every action to keep it that way.
 *
 * Types and constants only: this file is imported by the host, the main process and the
 * renderer, which share nothing else at run time.
 */

import type { ViewAction, ViewState } from '@aragon-agent/tui/model/agent/reducer';
import type { AgentMode } from '@aragon-agent/tui/model/agent/agent-mode';
import type { InvocationCard } from '@aragon-agent/tui/model/agent/invocation-card';
import type { Posture } from '@aragon-agent/tui/model/governance/posture';
import type { NormalizedPlan, NormalizedQuestion } from '@aragon-agent/tui/model/tools/human-input';

export const PROTOCOL_VERSION = 1;

/** A request's deadline on the renderer side; past it the caller sees `{ ok:false, code:'timeout' }`. */
export const COMMAND_TIMEOUT_MS = 15_000;

/** No window attached for this long and an approval is answered "no" (fail closed). */
export const UNATTENDED_REQUEST_TIMEOUT_MS = 30_000;

/** Hard caps the HOST re-applies to anything a renderer answers with. */
export const ANSWER_LIMITS = { denyReason: 500, planFeedback: 2000, freeText: 2000 } as const;

export interface SessionMetaView {
  sessionId: string;
  cwd: string;
  provider: string;
  model: string;
  /** True when this host resumed a saved conversation rather than starting a blank one. */
  resumed: boolean;
  /** Epoch ms of the checkpoint a crash recovery restored, when it did. */
  restoredAt?: number;
  /** Posture cycle the mode chip may step through, and why governance is unavailable. */
  postureCycle: Posture[];
  governanceUnavailable: string | null;
  /** Skill-style slash commands the composer menu should offer. */
  slashCommands: { name: string; description: string; aliases?: string[] }[];
}

export interface ApprovalPreview {
  tool: string;
  /** The complete text the terminal shows after "Allow?": a command, a path, a diff header. */
  summary: string;
}

export type HostRequest =
  | { k: 'tool-approval'; tool: string; summary: string; sessionAllowKey: string }
  | { k: 'skill-install'; source: string; targetPath: string; summary: string }
  | { k: 'ask-user'; questions: NormalizedQuestion[] }
  | { k: 'plan-review'; plan: NormalizedPlan };

/** The renderer's answer. The host validates it against the request it issued. */
export type HostResponse =
  | { k: 'tool-approval'; decision: 'allow' | 'allow-session' | 'deny'; reason?: string }
  | { k: 'skill-install'; approved: boolean }
  | {
      k: 'ask-user';
      cancelled: boolean;
      answers: { id: string; selected: string[]; custom: string | null }[];
    }
  | { k: 'plan-review'; decision: 'approved' | 'revise' | 'dismissed'; feedback: string };

export type ToastLevel = 'info' | 'warn' | 'error';

export type HostEvent =
  | { e: 'config.stale'; pendingReload: boolean }
  | { e: 'config.applied'; revision: string }
  | { e: 'checkpoint.saved'; at: number }
  | { e: 'toast'; level: ToastLevel; text: string }
  | { e: 'pong'; descendants: { pid: number; startedAt: number }[] }
  | { e: 'status'; status: SessionRunStatus };

/** What the sidebar's status dot is derived from. */
export type SessionRunStatus = 'starting' | 'ready' | 'running' | 'waiting-approval' | 'idle';

export type HostMsg =
  | { v: 1; t: 'snap'; epoch: number; seq: number; state: ViewState; meta: SessionMetaView }
  | { v: 1; t: 'act'; seq: number; action: ViewAction }
  | { v: 1; t: 'acts'; seq: number; actions: ViewAction[] }
  | { v: 1; t: 'req'; id: string; req: HostRequest }
  | { v: 1; t: 'evt'; evt: HostEvent }
  | { v: 1; t: 'ack'; id: string; result: CommandResult };

export type RendererMsg =
  | { v: 1; t: 'cmd'; id: string; cmd: HostCommand }
  | { v: 1; t: 'res'; id: string; res: HostResponse }
  | { v: 1; t: 'resync' };

export type CommandResult =
  | { ok: true; value?: unknown }
  | { ok: false; code: CommandErrorCode; message: string };

/** Stable machine codes. The renderer maps these to localized, actionable text. */
export type CommandErrorCode =
  | 'timeout'
  | 'rejected'
  | 'busy'
  | 'invalid_argument'
  | 'unsupported'
  | 'not_applicable'
  | 'conflict'
  /** `queue.cancel`: the engine had already taken the message. */
  | 'already_delivered'
  /** `queue.cancel`: no such queued message (already receipted, withdrawn or never existed). */
  | 'not_found'
  | 'internal'
  | 'port_closed';

export interface ModelPatchDto {
  provider?: string;
  model?: string;
  baseUrl?: string | null;
  thinkingLevel?: string;
  maxTokens?: number | null;
  contextWindow?: number | null;
}

export type HostCommand =
  | { c: 'submit'; text: string; invocation?: InvocationCard }
  | { c: 'slash'; name: string; args: string }
  | { c: 'abort' }
  | { c: 'force-stop' }
  | { c: 'interrupt' }
  | { c: 'queue.cancel'; queueId: string }
  /** Run the bundled project-indexer skill (the desktop's Ctrl+I). The UI confirms first. */
  | { c: 'index.build' }
  | { c: 'mode.set'; mode: AgentMode }
  | { c: 'posture.set'; posture: Posture }
  | { c: 'posture.cycle' }
  | { c: 'model.patch'; patch: ModelPatchDto }
  | { c: 'kit.apply'; kitId: string }
  | { c: 'kit.clear' }
  | { c: 'thinking.set'; level: string }
  | { c: 'cwd.set'; path: string }
  | { c: 'compact'; instructions?: string }
  | { c: 'compact.cancel' }
  | { c: 'context.get' }
  | { c: 'todo.reopen-acceptance' }
  | { c: 'team.arm-forced'; count: number }
  | { c: 'team.disarm' }
  | { c: 'gov.pause' }
  | { c: 'gov.cancel-pause' }
  | { c: 'gov.abort-stage' }
  | { c: 'gov.runs' }
  | { c: 'gov.report'; runId?: string }
  | { c: 'service.stop'; id: string }
  | { c: 'service.read-log'; id: string; since?: number }
  | { c: 'session.save'; name?: string }
  | { c: 'session.pin'; pinned: boolean }
  | { c: 'files.search'; query: string }
  | { c: 'file-patch.get'; toolCallId: string }
  | { c: 'transcript.page'; before: number; limit: number }
  | { c: 'reload-config' }
  | { c: 'ping' };

/** What the main process sends a host over its `parentPort` before any port exists. */
export type HostInit = {
  v: 1;
  kind: 'init';
  sessionId: string | null;
  cwd: string;
  /** Required: the host verifies `getHomeRoot()` equals this and exits otherwise. */
  homeRoot: string;
  epoch: number;
  resume: boolean;
};

/** A message from a host to the main process on `parentPort` (control plane only). */
export type HostControlMsg =
  | { v: 1; kind: 'ready'; sessionId: string; pid: number }
  | { v: 1; kind: 'fatal'; code: string; message: string }
  | { v: 1; kind: 'status'; status: SessionRunStatus; services: number }
  | { v: 1; kind: 'pong'; descendants: { pid: number; startedAt: number }[] }
  /** Answer to `skills-query` from a one-shot `--catalog` process. */
  | { v: 1; kind: 'skills'; skills: SkillInfoDto[] };

/** The main process telling a host what to do on `parentPort`. */
export type MainControlMsg =
  | { v: 1; kind: 'ping' }
  | { v: 1; kind: 'config-changed'; revision: string }
  | { v: 1; kind: 'quit'; flush: boolean }
  | { v: 1; kind: 'attached'; attached: boolean }
  /** Only a `--catalog` process acts on this: list installed skills for `cwd`, answer, exit. */
  | { v: 1; kind: 'skills-query'; cwd: string };

/** One installed skill as the Skills page shows it. */
export interface SkillInfoDto {
  name: string;
  source: 'bundled' | 'user' | 'project' | 'env';
  description: string;
  /** False when the user disabled it or it failed validation. */
  enabled: boolean;
  invalid: boolean;
}
