import { modelSettingsResultMessage } from '../agent/model-profile-settings.js';
import type { ModelSettingsDraft } from '../config/model-profile-store.js';
import { selectTranscriptEntries, mergePendingEntries } from '../agent/queued-messages.js';
/**
 * App — the root Ink component. Owns the view reducer, subscribes to the
 * controller's event stream (with a streaming coalescer), wires global
 * keybindings, routes slash commands, and renders the header / transcript /
 * input / toast stack / status bar / overlays.
 */

import React, { useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from 'react';
import process from 'node:process';
import { Box, Text, useApp, useInput, useStdout } from 'ink';
import type { ScrollbarBridge } from './scrollbar-controller.js';
import type { AgentController } from '../agent/controller.js';
import type { SubmitMessageOptions } from '../agent/prompt-options.js';
import {
  advanceInterruptGesture,
  INTERRUPT_CONFIRM_MS,
  cancelInterruptConfirmation,
  type InterruptGestureState,
} from '../input/interrupt-gesture.js';
import type { ConfirmRequest } from '../tools/index.js';
import {
  initialViewState,
  reduceEvent,
  viewReducer,
  type Entry,
  type Overlay,
  type PatchSource,
  type ToastLevel,
  type ViewAction,
} from '../agent/reducer.js';
import { mergeDeltas } from '../agent/coalesce.js';
import { computeCost } from '../agent/usage.js';
import {
  parseMaxTokensInput,
  DEFAULT_MAX_RENDER_INTERVAL_MS,
  DEFAULT_TRANSCRIPT_RETAIN,
  DEFAULT_TRANSCRIPT_WINDOW,
  type PersistedConfig,
} from '../config/schema.js';
import { updatePersistedConfig } from '../config/store.js';
import { appendPrompt, loadPromptHistory } from '../config/prompt-history.js';
import {
  bumpSubmitCount,
  setMouseNoticeVersion,
  setScrollModeNoticeVersion,
  setVtInputNoticeVersion,
} from '../config/ui-state.js';
import { getLogger } from '../logging/logger.js';
import { isTerminalStatus, type ServiceSnapshot } from '../proc/types.js';
import { getSecrets } from '../logging/secret-registry.js';
import { redactText } from '../logging/redact.js';
import type { ComposerSubmitResult } from './composer-input.js';
import { resolveTuiCapabilities, type TermCapabilities } from './capabilities.js';
import {
  useStartupNotices,
  MOUSE_NOTICE_VERSION,
  SCROLL_MODE_NOTICE_VERSION,
  VT_INPUT_NOTICE_VERSION,
} from './use-startup-notices.js';
import { getTheme } from './theme.js';
import { pickGlyphs } from './glyphs.js';
import { Header } from './Header.js';
import { pickHeaderVariant, pickOpenerVariant } from './Logo.js';
import { SessionOpener } from './SessionOpener.js';
import { TranscriptList } from './Transcript.js';
import { Composer } from './Composer.js';
import { StatusBar } from './StatusBar.js';
import { secondsLeft } from '../agent/retry-view.js';
import { TeamPanel } from './TeamPanel.js';
import { TodoPanel } from './TodoPanel.js';
import { ActivityLine, liveSpinner } from './ActivityLine.js';
import type { RunActivity } from './run-status-row.js';
import { BottomStatusRow } from './BottomStatusRow.js';
// Only the updater's pure visibility predicate enters the status detail plan.
import { shouldRenderUpdateLine } from '../update/types.js';
import type { UpdateBridge, UpdateSnapshot } from '../update/types.js';
import { AppShell } from './layout/AppShell.js';
import { ScrollbackShell } from './ScrollbackShell.js';
import { useScrollbackView, type ScrollbackBridge } from './scrollback/use-scrollback-view.js';
import { buildExitSummary } from './scrollback/exit-summary.js';
import { LiveTail } from './scrollback/LiveTail.js';
import { SCROLLBACK_LIMITS } from './scrollback/limits.js';
import { TODO_LIMITS } from '../todo/limits.js';
import type { ScrollMode } from '../config/schema.js';
import { ScrollViewport } from './layout/ScrollViewport.js';
import { buildTodoRailLayout } from './layout/todo-layout.js';
import { buildTeamPanelLayout } from './layout/team-panel.js';
import { isLiveTeamCard, rosterCounts } from './team-status.js';
import {
  advanceBudget,
  decideFollowThrough,
  emptyBudget,
  type FollowThroughBudget,
} from '../todo/follow-through.js';
import { useTerminalSize } from './layout/useTerminalSize.js';
import { useHeightStore } from './use-height-store.js';
import { useRenderGovernor } from './use-render-governor.js';
import {
  readScrollbarPerf, setPerfResetHook, setPerfSnapshotProvider, type PerfSnapshot,
} from '../commands/perf.js';
import { frameHeight } from './layout/frame.js';
import { buildFrameBudget, POPUP_CAPACITY_SHARE } from './layout/budget.js';
import type { ScrollIntent } from './layout/scroll.js';
import { useWheelRouting } from './use-wheel-routing.js';
import type { MouseSource } from '../input/stdin-filter.js';
import { INDEX_KEY_FRAME, type PasteBridge } from '../input/limits.js';
import {
  INDEX_SKILL_NAME,
  buildIndexConfirmSummary,
  hasProjectIndex,
  indexBuildInvocationArgs,
} from '../commands/index-build.js';
import { installConsoleBridge } from './console-bridge.js';
import { publishExitSnapshot } from './exit-snapshot.js';
import { publishSessionView } from './session-bridge.js';
import type { CheckpointResult } from '../session/checkpoint.js';
// TYPE-ONLY, like the two session imports around it: the App passes the port
// through, it never constructs one (`cli.tsx` does).
import type { BranchCommandPort } from '../commands/branch-command.js';
import type { SessionIdentity } from '../session/startup-session.js';
import { OverlayFrame, overlayPageSize } from './layout/OverlayFrame.js';
import { helpRows } from './overlays/HelpOverlay.js';
import { ModelPicker } from './overlays/ModelPicker.js';
import { KitPicker } from './overlays/KitPicker.js';
import { INACTIVE_KIT, type ActiveKit } from '../config/kit-resolution.js';
import { kitApplyMessage, kitNoteMessages } from '../agent/kit-apply.js';
import { createModelProbe } from '../agent/model-probe.js';
import {
  SettingsScreen,
  compactionSettingsFrom,
  fastSettingsFrom,
} from './overlays/SettingsScreen.js';
import { ConfirmDialog, type ConfirmState } from './overlays/ConfirmDialog.js';
import { QuestionOverlay } from './overlays/QuestionOverlay.js';
import { PlanReviewOverlay, type PlanVerdict } from './overlays/PlanReviewOverlay.js';
import { CommandRegistry, runSlashInput, type CommandContext } from '../commands/registry.js';
import { registerBuiltinCommands } from '../commands/builtins.js';
import { makeSkillsCommand, registerSkillCommands } from '../commands/skills.js';
import { MODE_LABEL, MODE_TOGGLE_KEYS, nextMode, type AgentMode } from '../agent/agent-mode.js';
import type { SelectionBridge } from './selection/selection-controller.js';
import { createClipboardCoordinator } from './clipboard-task.js';
import { QueuePanel } from './QueuePanel.js';
import { QueueOverlay } from './overlays/QueueOverlay.js';
import { buildQueueLayout } from './layout/queue-layout.js';
import { interactionCopy } from './interaction-copy.js';
import { createRunMetrics, updateRunMetrics, freezeRunMetrics, projectRunMetrics } from './run-metrics.js';
import { projectStatusFeedback, type StatusFeedbackInput } from './status-feedback.js';
import { planStatusDetail } from './layout/status-detail-layout.js';
import type { StatusPrimaryInput } from './layout/status-layout.js';
import { emptyTailState, type TailSink } from './layout/follow-state.js';
import type {
  HumanInputBridge,
  HumanRequest,
  HumanResponse,
} from '../tools/human-input.js';

export interface ConfirmBridge {
  handler: ((req: ConfirmRequest) => Promise<boolean>) | null;
}

/** What the settings screen's `Max tokens` field resolved to. */
export interface SettingsMaxTokens {
  /** Pushed into the live controller. `undefined` is AUTO. */
  applied: number | undefined;
  /** Written to the config file, or `'skip'` to leave the stored value alone. */
  persist: number | null | 'skip';
  /** Replaces the generic "Settings saved." acknowledgement when present. */
  toast?: [ToastLevel, string];
}

/**
 * Decide what the `Max tokens` field means, WITHOUT letting a bad value in it
 * discard the rest of the form.
 *
 * The three outcomes are genuinely different and must stay distinguishable:
 * `auto` is a setting, a clamped number is a setting the user should be told
 * about, and nonsense is not a setting at all — it keeps the previous value and
 * says so, rather than silently resolving to a default the user never chose.
 *
 * Exported for the tests; there is no other caller.
 */
export function resolveSettingsMaxTokens(
  raw: string,
  previous: number | undefined,
): SettingsMaxTokens {
  const parsed = parseMaxTokensInput(raw);

  if (parsed.kind === 'auto') {
    return {
      applied: undefined,
      persist: null,
      toast: ['info', 'Max tokens: auto (per-model ceiling).'],
    };
  }
  if (parsed.kind === 'value') {
    return {
      applied: parsed.value,
      persist: parsed.value,
      ...(parsed.clamped
        ? { toast: ['warn', `Max tokens clamped to ${parsed.value}.`] as [ToastLevel, string] }
        : {}),
    };
  }
  return {
    applied: previous,
    persist: 'skip',
    toast: ['warn', 'Max tokens must be a number or "auto".'],
  };
}

/** Services in a non-terminal state, from the live snapshot map. */
function liveServiceCount(services: Record<string, ServiceSnapshot>): number {
  let n = 0;
  for (const service of Object.values(services)) {
    if (!isTerminalStatus(service.status)) n += 1;
  }
  return n;
}

export interface AppProps {
  controller: AgentController;
  version: string;
  /** Decided once in `cli.tsx::runInteractive()`; never switched at run time. */
  initialOverlay?: Overlay;
  initialPrompt?: string;
  confirmBridge?: ConfirmBridge;
  /** The plan-mode human channel; absent in tests that do not exercise it. */
  humanInputBridge?: HumanInputBridge;

  mouseSource?: MouseSource;
  /**
   * Present ONLY on a console that can deliver neither `CSI Z` nor a mouse
   * report — a Windows console whose Node predates `UV_TTY_MODE_RAW_VT`
   * (`ui/win-vt-input.ts`). Absent everywhere else, which is what makes every
   * unaffected machine byte-identical to a build without this prop.
   *
   * DECIDED BY `cli.tsx`, not here, and by the SAME expression that gates
   * `mouseSource`: the two must never disagree about whether this terminal
   * reports anything.
   */
  vtInputWarning?: { nodeVersion: string };
  /**
   * The auto-updater's late-arrival channel (cli-auto-update §3.8).
   *
   * A BRIDGE AND NOT THE SERVICE ITSELF, for the reason `confirmBridge` above is
   * one: the service is built by a DYNAMIC `import()` fired after `render()`, so
   * it does not exist when this component mounts. Absent under `update.mode:
   * 'off'`, on a non-TTY, in CI, and in every test that does not exercise it.
   */
  updateBridge?: UpdateBridge;
  /**
   * The stdin filter's channel for a refused paste (tui-paste-handling section
   * 5.1.2 / I-15).
   *
   * A BRIDGE for the reason `updateBridge` above is one: the filter is built in
   * `cli.tsx` BEFORE `render()`, so it has no `dispatch`. Its only other outlet
   * is the logger, and a limit that writes only to a log file is
   * indistinguishable — from the user's chair — from a paste that silently did
   * nothing, which is what D-11 exists to rule out. Absent under `--no-paste`,
   * on a non-TTY, and in every test that does not exercise it.
   */
  pasteBridge?: PasteBridge;

  terminal?: TerminalBridge;

  /**
   * `'native'` prints settled conversation into the terminal's own scrollback and
   * renders only a bounded live region (tui-native-terminal-scroll). DEFAULTS TO
   * `'app'` so every existing render test and call site is untouched (I-S9).
   */
  scrollMode?: ScrollMode;
  /** The writer / feed channel `cli.tsx` shares with the tree; required for `'native'`. */
  scrollback?: ScrollbackBridge;

  /**
   * The transcript to seed the first frame with, from a resumed session
   * (tui-session-id-resume 3.12).
   *
   * ABSENT IN EVERY ORDINARY LAUNCH, and absent is what keeps the first frame
   * byte-identical to the pre-feature build (I-6).
   */
  initialEntries?: Entry[];
  /** This process's session identity. `undefined` means "no chip, no checkpoint". */
  session?: SessionIdentity;
  /** The two actions `cli.tsx` owns: checkpoint now, and rotate after `/resume`. */
  sessionBridge?: SessionBridge;
  /**
   * One line to show when the identity is NOT the obvious one (D-13): a branch,
   * or a `--save` name. An ordinary new session says nothing - the chip is the
   * affordance, and a notice on every launch trains users to ignore notices.
   */
  sessionNotice?: string;
}

/**
 * `App`'s and `cli.tsx`'s small two-way surface for the session, shaped exactly
 * like `confirmBridge` / `pasteBridge`.
 *
 * `checkpoint` and `rotate` are INSTALLED BY `cli.tsx` because the writer lives
 * outside React (two of its callers are process-level); `onIdentity` is
 * installed by the App so a rotation can move the chip, which is the only piece
 * of the identity the view owns.
 */
export interface SessionBridge {
  /**
   * Write a checkpoint now; `pin` also marks the file as never-prunable, and
   * `force` skips the fingerprint short circuit so `/branch` can guarantee that
   * the file the new process is about to read is current (D-15).
   */
  checkpoint?: (opts?: { pin?: boolean; force?: boolean }) => CheckpointResult;
  /** Adopt another conversation's identity (D-15); `undefined` if it cannot. */
  rotate?: (loadedPath: string) => SessionIdentity | undefined;
  /**
   * Ctrl+L / `/branch`: branch this session into a NEW terminal. Installed by
   * `cli.tsx`, because opening a window is a process-level act the App only asks
   * for (tui-branch-terminal-shortcut 3.11). Absent in a build with no session,
   * which is what lets `/branch` say so instead of throwing.
   */
  branch?: BranchCommandPort;
  /** Installed by `App`; called by `rotate` after the new id is claimed. */
  onIdentity?: (identity: SessionIdentity) => void;
}

export interface TerminalBridge {
  scrollbar?: ScrollbarBridge;
  /** Whether drag-select is on for this session (`mouseSelect` + a filter). */
  mouseSelect: boolean;
  deleteDisambiguated?: boolean;
  /** Release the mouse to the terminal, or take it back (`/mouse`, G3). */
  setMouseCapture?: (on: boolean) => void;
  /** Whether the mouse is captured right now — read at command time. */
  isMouseCaptured?: () => boolean;

  writeForeign?: (text: string) => void;
  selection?: SelectionBridge;
}

/** One outstanding `gate.request()`; see the bridge effect below. */
interface PendingHumanRequest {
  resolve: (value: HumanResponse | null) => void;
  done: boolean;
}

/**
 * The lazy `useReducer` initializer. Module scope, so the reference is stable
 * across renders and React never re-runs it.
 */
function seedViewState(seed: {
  thinkingVisible: boolean;
  entries?: Entry[];
}): ReturnType<typeof initialViewState> {
  const base = initialViewState({ thinkingVisible: seed.thinkingVisible });
  // THE REDUCER'S OWN ADOPTION LOGIC, NOT A COPY OF IT (3.12): `restoreEntries`
  // already lifts `seq` past the restored ids, trims to the retain ring and
  // clears the live-target pointers, and a second implementation of those thirty
  // lines is how the two would drift.
  return seed.entries && seed.entries.length > 0
    ? viewReducer(base, { type: 'restoreEntries', entries: seed.entries })
    : base;
}

export function App({
  controller,
  version,
  initialOverlay,
  initialPrompt,
  confirmBridge,
  humanInputBridge,
  mouseSource,
  vtInputWarning,
  updateBridge,
  pasteBridge,
  terminal,
  scrollMode = 'app',
  scrollback,
  initialEntries,
  session,
  sessionBridge,
  sessionNotice,
}: AppProps): React.ReactElement {
  const native = scrollMode === 'native' && scrollback !== undefined;
  /** Set when the native writer swallowed repeated tall frames; cleared by a resize. */
  const [guardTripped, setGuardTripped] = useState(false);
  const scrollbackViewRef = useRef<ReturnType<typeof useScrollbackView> | null>(null);
  const { exit } = useApp();
  const { stdout } = useStdout();
  const size = useTerminalSize();
  const [draftRows, setDraftRows] = useState(1);
  // Ctrl+C draft ladder (ctrl-c-clear-draft-exit). The nonce ticks when
  // the armed ladder spends its clear rung; the flag marks "clear spent"
  // so the render-time feedback already reads the exit wording at the
  // nonce render (the async clear lands a frame later - see the timing
  // invariant beside the ladder itself).
  const [draftClearNonce, setDraftClearNonce] = useState(0);
  const [draftClearedByCtrlC, setDraftClearedByCtrlC] = useState(false);
  const [popupRows, setPopupRows] = useState(0);
  const [statusExpanded, setStatusExpanded] = useState(false);
  const dimensions = buildFrameBudget({ ...size, draftRows, popupRows, statusExpanded });
  const { rows, cols } = dimensions;
  /**
   * Rows one PgUp/PgDn - and one Shift+wheel notch - turns inside a controlled
   * overlay (defect 11).
   *
   * ONE VALUE FOR BOTH BRANCHES, derived from the overlay's real window: a
   * constant 8 was 42% of `/help`'s 19-row window, so a shortcut list needed
   * twelve keystrokes and overlapped itself by eleven rows on every turn. The
   * wheel branch gets it through `getOverlayPage`, so the two can never disagree.
   *
   * MEASURED FROM THIS BUDGET, NOT `frameBudget` BELOW. The two agree on every
   * frame except the one that opens an overlay with the completion menu still
   * reported (`frameBudget` zeroes `popupRows` there), and that exception only
   * makes the real window LARGER - so this page can under-turn for one frame but
   * can never step past the window and skip content. The unsafe direction is the
   * one that matters, and it is unreachable.
   */
  const overlayPage = overlayPageSize(dimensions.viewportRows + (native ? 1 : 0), cols);
  const tooSmall = dimensions.inactive || (native && guardTripped);
  // --- Render governor (tui-render-performance L4). ------------------------
  //
  // FIRST, BEFORE ANY OTHER WORK IN THIS BODY. The hook stamps
  // `performance.now()` during render and reads it again in a layout effect, so
  // the span it measures is only the whole commit if nothing precedes it here.
  const cfg = controller.getConfig();
  const governor = useRenderGovernor({
    enabled: cfg.renderGovernor,
    maxIntervalMs: cfg.maxRenderIntervalMs,
  });
  /** The transcript height cache, owned here and read by `TranscriptList` (L3). */
  const heights = useHeightStore();

  // SEEDED FROM CONFIG, not dispatched after mount (§3.1.1): a post-mount
  // `toggleThinking` would let `/resume` flash a restored thinking block on
  // frame 1. `seedViewState` is module-scope so the lazy initializer is a stable
  // function reference.
  const [state, dispatch] = useReducer(
    viewReducer,
    { thinkingVisible: cfg.showThinking, ...(initialEntries ? { entries: initialEntries } : {}) },
    seedViewState,
  );
  // THE IDENTITY, SEEDED FROM THE PROP AND REPLACED ON ROTATION (D-15). A ref
  // travels beside it because both readers -- the publish effect and the
  // `/session` port -- must see the CURRENT id, and a rotation can land between
  // two renders.
  const [identity, setIdentity] = useState<SessionIdentity | undefined>(session);
  const identityRef = useRef<SessionIdentity | undefined>(session);
  const sessionId = identity?.id;
  const metrics = useRef(createRunMetrics());
  const manualMetrics = useRef(createRunMetrics());
  const [, setMetricsClock] = useState(0);
  const copyFeedback = useRef<{ result: NonNullable<StatusFeedbackInput['copyResult']>;
    toastId?: string; previousIds: Set<string> } | null>(null);
  /**
   * Forces the render that re-reads `Date.now()` for the live compaction card
   * while the run is IDLE (hardening W5). The value itself is never read - the
   * card's elapsed figure is derived from `nowSec` like the running tool card's.
   */
  const [, setCompactionClock] = useState(0);
  const [confirmState, setConfirmState] = useState<ConfirmState | null>(null);
  /**
   * The updater's latest snapshot, or `null` while there is no service
   * (cli-auto-update section 6.1).
   *
   * `UpdateSnapshot` is a VALUE OBJECT the service replaces wholesale on every
   * transition, so this state can use referential equality and never diff fields.
   */
  const [updateSnapshot, setUpdateSnapshot] = useState<UpdateSnapshot | null>(null);
  /** The request the question / plan overlay is currently rendering. */
  const [humanRequest, setHumanRequest] = useState<HumanRequest | null>(null);
  // Seeded from the history file, not from `CliConfig`: the list is no longer
  // part of the resolved config, so every other `loadConfig()` caller is spared
  // reading it (config-state-separation D-4).
  const [promptHistory, setPromptHistory] = useState<string[]>(() => loadPromptHistory());
  // Scroll plumbing: intent goes down, one derived display number comes back.
  const [scrollIntent, setScrollIntent] = useState<{
    kind: ScrollIntent;
    nonce: number;
    repeat?: number;
  }>();
  const [pinToBottomNonce, setPinToBottomNonce] = useState(0);
  const [scrollResetKey, setScrollResetKey] = useState(0);
  const [scrolledLines, setScrolledLines] = useState(0);
  /**
   * True while a selection drag holds the viewport
   * (tui-selection-and-scroll-follow §4.3.1 / §4.4).
   *
   * REACT STATE RATHER THAN A REF, because `ScrollViewport` has to re-arm its
   * resume timer on both edges and a ref cannot drive an effect. The controller
   * is the owner; this is a mirror, pushed by `onHoldChange`.
   */
  const [selectionHold, setSelectionHold] = useState(false);
  // I-5 (§4.13): Ctrl+L cannot repaint by writing escapes — Ink dedupes
  // identical output twice over — so it bumps this instead, and StatusBar turns
  // it into a one-byte, zero-width change that both dedupe gates let through.
  const [redrawNonce, setRedrawNonce] = useState(0);
  // Overlay scroll offset. Held here rather than inside `OverlayFrame` so that
  // closing an overlay cannot leave a stale offset behind, and reset whenever
  // the active overlay changes.
  const [overlayScroll, setOverlayScroll] = useState(0);
  const [completion, setCompletion] = useState<'none' | 'slash' | 'file'>('none');
  const [copyState, setCopyState] = useState({ busy: false, cleanupPending: false });
  // Bumped whenever the installed skill set changes. The command registry and
  // the completion list are memoized against it, so a skill installed mid-session
  // gets its `/<name>` command and its autocomplete entry immediately.
  const [skillsNonce, setSkillsNonce] = useState(0);

  const caps = useMemo<TermCapabilities>(
    () => resolveTuiCapabilities({}, cfg.color), [cfg.color],
  );
  const theme = useMemo(() => getTheme(cfg.theme, caps), [cfg.theme, caps]);
  const glyphs = useMemo(() => pickGlyphs(caps), [caps]);
  const reducedMotion = cfg.reducedMotion ?? false;

  const stateRef = useRef(state);
  stateRef.current = state;
  const startedAt = useRef(Date.now());
  const confirmRef = useRef<ConfirmState | null>(null);
  confirmRef.current = confirmState;
  const ctrlCArmed = useRef(false);
  const ctrlCTimer = useRef<NodeJS.Timeout | null>(null);
  const interruptGesture = useRef<InterruptGestureState>({ phase: 'ready' });
  const interactionPhase = useRef<'idle' | 'starting' | 'running'>(
    controller.isRunning() ? 'running' : 'idle',
  );
  const submissionSequence = useRef(0);
  const mounted = useRef(true);
  const switchingConversation = useRef(false);
  const drainCompactionQueue = useRef<() => void>(() => {});
  /**
   * Live service snapshots, keyed by id, for the status chip and the Ctrl+C rung.
   *
   * A `useState` MAP rather than a ref, because the chip has to re-render when it
   * changes; and separate from `ViewState`, because a service is not a
   * transcript entry - the transcript records EVENTS about a service (D-11) and
   * this is the live state those events are about.
   */
  const [services, setServices] = useState<Record<string, ServiceSnapshot>>({});
  /**
   * Read by the Ctrl+C handler, which `useInput` registers ONCE.
   *
   * The same reason `stateRef` exists two lines up: a value captured in that
   * closure would be pinned to the mount render, so the key handler would
   * believe there are never any services and Ctrl+C would arm exit while a dev
   * server was up.
   */
  const servicesRef = useRef(services);
  servicesRef.current = services;

  const runStartedAt = useRef(0);
  const toastTimers = useRef<Map<string, NodeJS.Timeout>>(new Map());
  /** Every outstanding `gate.request()`. Held in a ref, never in state: it is
   *  bookkeeping for promises, and re-rendering on it would be noise. */
  const pendingHuman = useRef(new Set<PendingHumanRequest>());
  /**
   * What `/perf` reports. Assigned during render, exactly like `stateRef` above,
   * because a slash command runs outside the render pass and a value captured in
   * an effect closure would be one commit stale on every readout.
   */
  const perfRef = useRef<PerfSnapshot | null>(null);
  /**
   * How many entries `TranscriptList` actually mounted this frame.
   *
   * A ref written during the child's render, not state: this is the number
   * `render-budget.test.tsx` gates on (AC-1 / AC-9), and turning it into state
   * would make reading the render budget cost a render.
   */
  const mountedCount = useRef(0);
  /**
   * Rows the transcript has appended AT ITS TAIL — Rule A's only legal input
   * (tui-selection-and-scroll-follow §4.3.1a).
   *
   * Owned here because it has TWO readers one level down each: `TranscriptList`
   * writes it during its render, and `ScrollViewport` reads it in the layout
   * effect that runs afterwards. A ref rather than state, exactly like
   * `mountedCount` above and for the same reason.
   */
  const tailSink = useRef<TailSink['current']>(emptyTailState());

  // --- Follow-through (todo-plan-followthrough §3.4). ---------------------
  //
  // THREE REFS AND NO VIEW STATE, DELIBERATELY (§5.2). Every field added to
  // `ViewState` is a field `restoreEntries`, `/clear`, `/reset` and the session
  // round-trip each have to have an opinion about, and none of them has an
  // opinion about a 3-second timer.
  /**
   * Whether the one `installing -> ready` toast has already been pushed
   * (cli-auto-update section 6.3).
   *
   * A REF AND NOT STATE: this must survive every re-render without causing one,
   * and it is the whole of AC-19 - ten re-renders while the phase sits at
   * `ready` must still produce exactly one toast.
   */
  const updateToastPushed = useRef(false);
  const budgetRef = useRef<FollowThroughBudget>(emptyBudget());
  const followTimer = useRef<NodeJS.Timeout | null>(null);
  /** True while the run in flight was started by the grace timer, not the user. */
  const autoContinuationRef = useRef(false);
  /**
   * WHY THE END REASON TRAVELS IN A REF THIS FEATURE OWNS (C-11 / D-17).
   *
   * `ViewState.aborted` / `.errorNoticed` are the DEFINITION of the end reason —
   * `runEnd` reads exactly that pair for its own silent-failure guard — but the
   * reducer is not a safe CHANNEL for it, because the answer is needed inside a
   * controller callback rather than during a render.
   *
   * Reading `stateRef.current` there happens to work under Ink 5 only because
   * Ink mounts a LEGACY root (`ink.js`: `createContainer(rootNode, 0 …)`), so a
   * dispatch from a promise context flushes synchronously. Under a concurrent
   * root — an Ink major bump, or its `experimental` renderer — React 18's
   * automatic batching returns, and a provider stream error emitted as
   * `message_update` immediately before `agent_end` (core throws in the loop and
   * emits `agent_end` from `runLoopWithLifecycle`'s `finally`, microtasks apart)
   * would still read `errorNoticed: false`. That auto-continues into a run that
   * just failed authentication: silent, and billable.
   *
   * So this ref is mutated in the SAME SYNCHRONOUS CALLBACK that dispatches the
   * corresponding action, and the reducer fields stay as the cross-check.
   */
  const endReasonRef = useRef<{ aborted: boolean; errored: boolean }>({
    aborted: false,
    errored: false,
  });

  const interruptTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const resetInterrupt = useCallback(() => {
    if (interruptTimer.current) clearTimeout(interruptTimer.current);
    interruptTimer.current = null;
    interruptGesture.current = { phase: 'ready' };
  }, []);
  const cancelConfirmation = useCallback(() => {
    if (interruptGesture.current.phase !== 'armed') return;
    interruptGesture.current = cancelInterruptConfirmation(interruptGesture.current);
    if (interruptTimer.current) clearTimeout(interruptTimer.current);
    interruptTimer.current = null;
    setMetricsClock(Date.now());
  }, []);
  useEffect(() => {
    if (state.overlay) cancelConfirmation();
  }, [state.overlay, cancelConfirmation]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      submissionSequence.current += 1;
      if (interactionPhase.current === 'starting' || controller.isCompactionBusy?.()) controller.abort();
      interactionPhase.current = 'idle';
      resetInterrupt();
    };
  }, [controller, resetInterrupt]);

  useEffect(() => {
    drainCompactionQueue.current = () => {
      // A conversation switch owns the queue until its command has committed.
      void Promise.resolve().then(async () => {
        if (!mounted.current || switchingConversation.current
          || controller.isCompactionBusy() || controller.isRunning()
          || interactionPhase.current !== 'idle' || !controller.hasPendingUserMessages()
          || controller.areModelSettingsBlocked()) return;
        const preflight = controller.preflight();
        if (!preflight.ok) {
          dispatch({ type: 'notice', level: 'error', text: preflight.message ?? 'Configuration error.' });
          return;
        }
        interactionPhase.current = 'starting';
        try { await controller.continue(); }
        finally {
          if (interactionPhase.current === 'starting') interactionPhase.current = 'idle';
        }
      });
    };
    return controller.subscribeCompactionBusy?.((busy) => {
      if (!busy) drainCompactionQueue.current();
    });
  }, [controller]);

  /**
   * Disarm an armed continuation. Idempotent; NEVER touches the budget — a
   * cancelled continuation was never issued, so it must not be charged (AC-18).
   *
   * Three callers and there must be no fourth: `Esc` in the idle branch, the
   * first line of `submitMessage`, and the subscription effect's cleanup.
   */
  const cancelFollowThrough = useCallback((): void => {
    if (followTimer.current) {
      clearTimeout(followTimer.current);
      followTimer.current = null;
    }
  }, []);
  /**
   * `submitMessage` as of the LATEST render, for the grace timer.
   *
   * The subscription effect below never re-runs (its deps are stable by
   * construction), so a direct call would close over the mount render's binding
   * forever. That binding happens to be functionally correct today because
   * `submitMessage` reads everything mutable through refs — which is exactly the
   * kind of "happens to be correct" this feature has already had to unwind once
   * (P1-1, P1-6). Assigned during render, the same discipline `stateRef` uses
   * twenty lines up.
   */
  const submitRef = useRef<(text: string, opts?: SubmitMessageOptions) => void>(() => {});

  /**
   * THE SINGLE SETTLE PATH for a human request. Idempotent per entry, and it
   * clears the overlay as its last act.
   *
   * Exactly four callers, and there must be no fifth: the overlay's own submit,
   * `Esc` in `App`, the `ctx.signal` abort listener, and `cancelPending()`.
   * Every one of them can race the others, which is what `done` is for.
   */
  const settleHuman = useCallback(
    (entry: PendingHumanRequest, value: HumanResponse | null): void => {
      if (entry.done) return;
      entry.done = true;
      pendingHuman.current.delete(entry);
      entry.resolve(value);
      if (pendingHuman.current.size === 0) {
        setHumanRequest(null);
        dispatch({ type: 'setOverlay', overlay: null });
      }
    },
    [],
  );

  const cancelPendingHuman = useCallback((): void => {
    for (const entry of [...pendingHuman.current]) settleHuman(entry, null);
  }, [settleHuman]);

  const registry = useMemo(() => {
    const r = new CommandRegistry();
    // Order matters: built-ins first, so `registerSkillCommands` sees them when
    // it probes for name conflicts and a skill can never displace `/exit` (D6).
    registerBuiltinCommands(r);
    const skills = controller.getSkillService();
    if (cfg.skills.enabled) {
      r.register(makeSkillsCommand(skills, version));
      registerSkillCommands(r, skills);
    }
    return r;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [controller, cfg.skills.enabled, version, skillsNonce]);
  const commandOptions = useMemo(
    () => registry.all().map((c) => ({ name: c.name, description: c.description })),
    [registry],
  );

  // --- Streaming coalescer + controller subscription. --------------------
  const pending = useRef<ViewAction[]>([]);
  const flushTimer = useRef<NodeJS.Timeout | null>(null);
  /** Alias so the subscription effect below reads one stable ref, not a hook. */
  const governorInterval = governor.intervalMs;

  const flushPending = useCallback(() => {
    if (flushTimer.current) {
      clearTimeout(flushTimer.current);
      flushTimer.current = null;
    }
    if (pending.current.length === 0) return;
    const merged = mergeDeltas(pending.current);
    pending.current = [];
    for (const action of merged) dispatch(action);
  }, []);

  /**
   * The CLI-local diff side channel (§3.3.7). Memoized once, beside the `cost`
   * lookup below, because `reduceEvent` TAKES a patch rather than reading one:
   * the store is consume-once, so this object must not be rebuilt per event.
   */
  const patchSource = useMemo<PatchSource>(
    () => ({ take: (id: string) => controller.takeFilePatch(id) }),
    [controller],
  );

  useEffect(() => {
    // CAPTURED AT SUBSCRIBE TIME AND COMPARED ON EVERY EVENT (I-7 / P1-7).
    //
    // `forceStop()` bumps the controller's generation, and everything the engine
    // emits while it unwinds - `turn_start`, `tool_call_start`, `turn_end`,
    // `agent_end` - belongs to the run the user just abandoned. `runStart` /
    // `turnStart` would set `status: 'running'` again, bouncing the view straight
    // back out of the `idle` force-stop just gave them, and stray entries would
    // append to a transcript they believe is finished.
    //
    // A LOCAL `let`, RE-READ RATHER THAN CAPTURED ONCE: the generation this
    // listener considers current advances with every submit, so a force-stop
    // makes stale events inert WITHOUT making the next run's events inert too.
    let generation = controller.runGeneration;
    const unsubscribe = controller.subscribe((event) => {
      // Receipts describe committed history even when force-stop invalidated the run.
      if (event.type === 'steering_accepted') {
        dispatch({ type: 'steeringAccepted', ids: event.ids });
        return;
      }
      if (controller.runGeneration !== generation) {
        // The engine is unwinding a force-stopped run. Adopt the new generation
        // only once it has finished doing so, so a late `agent_end` cannot be
        // mistaken for the next run's.
        if (event.type === 'agent_end') generation = controller.runGeneration;
        return;
      }
      metrics.current = updateRunMetrics(metrics.current, event, Date.now());
      if (event.type === 'agent_start') {
        interactionPhase.current = 'running';
        manualMetrics.current = createRunMetrics();
      }
      if (event.type === 'agent_end') {
        interactionPhase.current = 'idle';
        resetInterrupt();
      }
      const cost = controller.getModelInfo().cost;
      for (const action of reduceEvent(event, cost, patchSource)) {
        // MUTATED HERE, ONE INSTANT BEFORE THE ACTION THAT SETS
        // `ViewState.errorNoticed`, rather than read back from the reducer one
        // commit later (C-11). This is the whole of the batching-independence
        // guarantee: `agent_end` can follow this action in the same tick with no
        // render in between, and AC-40 asserts exactly that sequence.
        if (action.type === 'notice' && action.level === 'error') {
          endReasonRef.current.errored = true;
        }
        if (action.type === 'textDelta' || action.type === 'thinkingDelta') {
          pending.current.push(action);
          if (!flushTimer.current) {
            // READ FROM THE REF AT ARM TIME (L4). This effect's dependency list
            // never changes by construction, so a captured number would be
            // pinned to the mount render and the ladder would move nothing.
            flushTimer.current = setTimeout(() => flushPending(), governorInterval.current);
          }
        } else {
          flushPending();
          dispatch(action);
        }
      }

      if (event.type !== 'agent_end') return;

      // NO OVERLAY OUTLIVES ITS RUN (P1-4). `ctx.signal` already covers the
      // abort path, so this is DELIBERATE REDUNDANCY: it makes "the card cannot
      // survive the run that opened it" a property of the App's lifecycle
      // rather than a consequence of signal plumbing three modules away.
      // Without it, an aborted run leaves a plan card on screen whose `a` key
      // silently flips the session to build, with no visible cause.
      cancelPendingHuman();

      // --- Follow-through (todo-plan-followthrough §3.4). ------------------
      //
      // Round 1 printed one notice here and stopped, under a good argument
      // ("auto-continuation is an unbounded cost loop wearing a helpful hat").
      // That judgement is not overturned: the loop is BOUNDED first, by two
      // structural counters, and only then permitted — opt-in, and off by
      // default, so `followThrough: 'notify'` reproduces the old notice byte for
      // byte (AC-1).
      const todos = controller.getTodoSnapshot();
      budgetRef.current = advanceBudget(budgetRef.current, todos, autoContinuationRef.current);
      autoContinuationRef.current = false;
      const decision = decideFollowThrough({
        mode: controller.getTodoConfig().followThrough,
        snapshot: todos,
        runEnd: { ...endReasonRef.current },
        budget: budgetRef.current,
        interactive: true,
      });
      endReasonRef.current = { aborted: false, errored: false };

      if (decision.kind === 'notify') {
        dispatch({ type: 'notice', level: decision.level, text: decision.text });
      } else if (decision.kind === 'continue') {
        dispatch({ type: 'notice', level: 'info', text: decision.notice });
        // NO LIVE COUNTDOWN (D-10). The notice is written once and does not
        // tick: a 10 Hz re-render of the whole frame to animate a number is the
        // repaint cost this package refuses elsewhere, and Ink's two dedupe
        // gates mean the alternative is not free either.
        cancelFollowThrough(); // I-3: at most one armed continuation, ever
        followTimer.current = setTimeout(() => {
          followTimer.current = null;
          // TWO RE-CHECKS AT FIRE TIME, not only at decision time. The grace
          // window is 3 s and the user can type in it (C-6): without the first,
          // a fired continuation would either be swallowed into
          // `controller.steer()` (the quiet failure) or reach
          // `controller.prompt()`, which REJECTS while running.
          if (controller.isRunning() || controller.isCompactionBusy?.()) return;
          const live = controller.getTodoSnapshot();
          if (!live || live.doneCount >= live.total) return; // the list moved
          budgetRef.current = { ...budgetRef.current, used: budgetRef.current.used + 1 };
          autoContinuationRef.current = true;
          // COUNTS ONLY, NEVER ITEM TEXT (D-19), and only at the fire point —
          // the quiet paths must stay quiet.
          getLogger().debug('agent', 'todo_follow', {
            used: budgetRef.current.used,
            noProgressStreak: budgetRef.current.noProgressStreak,
            total: live.total,
            done: live.doneCount,
            mode: 'auto',
          });
          submitRef.current(decision.message, { userInitiated: false, todoPolicy: 'continue' });
        }, decision.graceMs);
      }

      // A deferred `plan -> build` becomes real here and nowhere else (§3.2).
      const applied = controller.applyPendingMode();
      if (applied) {
        dispatch({ type: 'setAgentMode', mode: applied.effective, pending: null });
        dispatch({
          type: 'pushToast',
          level: 'info',
          text: `${MODE_LABEL[applied.effective]} mode.`,
        });
      }
    });
    return () => {
      flushPending();
      // An armed continuation must not outlive the tree that armed it (AC-21):
      // the timer would fire into an unmounted App and `submitRef.current` would
      // prompt a controller nobody is rendering.
      cancelFollowThrough();
      unsubscribe();
    };
  }, [controller, patchSource, flushPending, cancelPendingHuman, cancelFollowThrough, resetInterrupt]);

  useEffect(() => {
    return controller.subscribeProc((event) => {
      const service = event.service;
      setServices((prev) => ({ ...prev, [service.id]: service }));
      if (event.type === 'started') {
        dispatch({ type: 'serviceStart', service });
        return;
      }
      if (event.type === 'exited' || event.type === 'stopped') {
        dispatch({ type: 'serviceEnd', service });
        return;
      }
      dispatch({ type: 'serviceUpdate', service });
    });
  }, [controller]);

  // --- Team-mode event stream (team-subagents §5.2 / §3.9). --------------
  //
  // A SEPARATE SUBSCRIPTION, not a branch in the one above: `TeamEvent` is
  // deliberately not a member of core's `AgentEvent` union (D-10 / I-5), so it
  // cannot arrive through `controller.subscribe`.
  //
  // These actions are NOT routed through the streaming coalescer. That buffer
  // exists to merge text/thinking deltas; `agent_update` is already coalesced at
  // the source at 120 ms per child (§5.2), and pushing it through a second
  // buffer would only delay the roster.
  useEffect(() => {
    const unsubscribeTeam = controller.subscribeTeam((event) => {
      switch (event.type) {
        case 'dispatch_start':
          dispatch({
            type: 'teamStart',
            dispatchId: event.dispatchId,
            requested: event.requested,
            specs: event.specs,
          });
          break;
        case 'agent_update': {
          const snapshot = controller.getTeamSnapshot();
          if (snapshot) dispatch({ type: 'teamUpdate', snapshot });
          break;
        }
        case 'message': {
          const snapshot = controller.getTeamSnapshot();
          if (snapshot) dispatch({ type: 'teamUpdate', snapshot });
          break;
        }
        case 'overseer': {
          // A supervisor decision was applied (team-overseer). The roster
          // already refreshed through the agent_update the runtime publishes
          // with it; re-read the snapshot so the panel cannot miss the row.
          const snap = controller.getTeamSnapshot();
          if (snap) dispatch({ type: 'teamUpdate', snapshot: snap });
          // G-4 / AC-5 (subagent-overseer-v2): a TERMINAL verdict is the
          // one decision the user must not discover from the final report
          // - it removes work they watched running. wait and nudge stay
          // panel-only so the transcript gains no per-tick noise.
          if (event.decision.action === 'replace' || event.decision.action === 'abandon') {
            const verb = event.decision.action === 'replace' ? 'replaced' : 'abandoned';
            const level = event.decision.action === 'replace' ? 'info' : 'warn';
            const reason = event.decision.reason.slice(0, 120);
            dispatch({
              type: 'notice',
              level,
              text: `team supervisor ${verb} ${event.label} - ${reason}`,
            });
          }
          break;
        }
        case 'usage': {
          // Child spend is REAL SPEND and must reach the status bar, or the
          // session cost readout under-reports by however much the team consumed
          // — the single most misleading possible failure of this feature (R-5).
          //
          // THE COST TABLE IS SELECTED BY TIER (fast-model-tier §3.6 / R-7).
          // Always using the lead's would over-report a Haiku child under a
          // Sonnet lead by roughly an order of magnitude, which is a different
          // way of being wrong about the same number.
          // FROM THE CONTROLLER, NOT FROM `cfg` (the rule the `agent_end`
          // handler above records): this effect's dependency list never changes,
          // so it closes over the `cfg` object of the render it mounted in, and
          // `setModel` builds a NEW one.
          const live = controller.getConfig();
          // Every child runs the lead's own model (main-agent parity), so the
          // lead's live connection IS the tier that billed.
          const ref = { providerId: live.provider, modelId: live.model };
          // Unknown pricing contributes ZERO rather than a fabricated figure
          // (C-11 / RV-4); `/fast status` and the dispatch report say `unknown`.
          const costDelta = controller.isPricedModel(ref)
            ? computeCost(event.usage, controller.getModelInfoFor(ref).cost)
            : 0;
          dispatch({ type: 'teamUsage', usage: event.usage, costDelta });
          break;
        }
        case 'dispatch_end':
          dispatch({ type: 'teamEnd', outcome: event.outcome });
          break;
      }
    });
    return () => {
      unsubscribeTeam();
      controller.dispose();
    };
  }, [controller]);

  // --- Todo event stream (todo-plan-execution §3.8 / §5.2). --------------
  //
  // A THIRD SUBSCRIPTION, for the reason the team one records: `TodoEvent` is
  // deliberately not a member of core's `AgentEvent` union (D-11), so it cannot
  // arrive through `controller.subscribe`.
  //
  // NOT ROUTED THROUGH THE STREAMING COALESCER either. That buffer exists to
  // merge text/thinking deltas; a `todo_write` is one deliberate act per step,
  // and delaying the one surface the user is watching a long task through would
  // be exactly backwards.
  useEffect(() => {
    return controller.subscribeTodos((event) => {
      switch (event.type) {
        case 'updated':
          dispatch({ type: 'todoUpdate', snapshot: event.snapshot });
          break;
        case 'cleared':
          dispatch({ type: 'todoCleared' });
          break;
        case 'rejected':
          // THE COMPENSATING PATH FOR SUPPRESSING THE TOOL CARD (§3.8). Without
          // it, the one case where `todo_write` produces nothing visible would
          // be the case that most needs to be visible.
          dispatch({ type: 'notice', level: 'warn', text: event.reason });
          break;
      }
    });
  }, [controller]);

  // --- Fast-tier event stream (fast-model-tier §5.3). --------------------
  //
  // A FOURTH SUBSCRIPTION, for the reason the team and todo ones record:
  // `FastEvent` is deliberately not a member of core's `AgentEvent` union
  // (D-10), so it cannot arrive through `controller.subscribe`.
  //
  // `subscribeFast` returns a no-op unsubscribe when the tier was off at
  // construction, so this can subscribe unconditionally and an ordinary session
  // pays one closure for the whole run.
  useEffect(() => {
    // Seed the chip from the tier resolved at construction, so a fast-enabled
    // session shows it on the first frame rather than after the first review.
    const initial = controller.getFastStatus();
    if (initial.registered) dispatch({ type: 'fastTier', snapshot: initial.snapshot });

    return controller.subscribeFast((event) => {
      switch (event.type) {
        case 'review_start':
          dispatch({
            type: 'fastStart',
            index: event.index,
            turn: event.turn,
            model: controller.getFastStatus().snapshot.model,
          });
          break;
        case 'review_end':
          dispatch({ type: 'fastEnd', review: event.review });
          // The card settled, so the chip's `inFlight` and the session totals
          // both moved. One dispatch rather than two: `fastTier` carries them.
          dispatch({ type: 'fastTier', snapshot: controller.getFastStatus().snapshot });
          break;
        case 'usage': {
          // Review spend is REAL SPEND at the FAST model's price (§3.6 / AC-18).
          const ref = controller.getFastStatus().tier;
          const costDelta =
            ref.ok && controller.isPricedModel(ref.ref)
              ? computeCost(event.usage, controller.getModelInfoFor(ref.ref).cost)
              : 0;
          dispatch({ type: 'fastUsage', usage: event.usage, costDelta });
          break;
        }
        case 'tier_changed':
          dispatch({ type: 'fastTier', snapshot: event.snapshot });
          break;
      }
    });
  }, [controller]);

  // --- Context occupancy (context-usage-gauge-accuracy §3.3 / I-1). --------
  //
  // A SEVENTH SUBSCRIPTION, AND THE SOLE DISPATCHER OF `contextUsage`. The gauge
  // used to be written from three reducer branches fed by two upstreams, which
  // is what let a stale `snapshot` bounce the bar back to the pre-compaction
  // figure one statement after a compaction correctly dropped it (P0-1). One
  // writer makes that unrepresentable.
  //
  // IT SUBSCRIBES UNCONDITIONALLY. `subscribeContextUsage` is not a compaction
  // forwarder - the meter exists in every session, including one started with
  // `--no-compaction`, which is precisely the session whose gauge previously had
  // one sample per turn and read 0 % after a `/resume`.
  useEffect(() => {
    // SEED ON MOUNT so a resumed session shows a real occupancy on frame 1
    // rather than after its first completed turn. `getContextUsage()` measures
    // on demand, so this works before any event has ever arrived.
    dispatch({ type: 'contextUsage', snapshot: controller.getContextUsage() });
    return controller.subscribeContextUsage((snapshot) => {
      dispatch({ type: 'contextUsage', snapshot });
    });
  }, [controller]);

  // --- Compaction event stream (context-auto-compaction §5.2). -------------
  //
  // A SIXTH SUBSCRIPTION, for the reason the team, todo and fast ones record:
  // `CompactionEvent` is deliberately not a member of core's `AgentEvent` union,
  // so it cannot arrive through `controller.subscribe`.
  //
  // AND IT IS THE **SOLE** DISPATCHER OF THE FIVE COMPACTION ACTIONS (D-20 /
  // P1-6). `reduceEvent` gains no cases for core's `compaction_start` /
  // `compaction_end` — its `default: return []` is already correct for them —
  // because one compaction arriving through two channels is two transcript cards
  // and a doubled `tokensReclaimed`, with nothing naming the authority. This
  // stream is the right authority because it is strictly richer: the wiring IS
  // the `ContextManager`, so it knows the summarizer's model, its cost and the
  // session totals, and it learns `applied` by subscribing to the core event one
  // layer earlier.
  //
  // `subscribeCompaction` returns a no-op unsubscribe when compaction was off at
  // construction, so this can subscribe unconditionally and an ordinary session
  // pays one closure for the whole run.
  useEffect(() => {
    // Seed the chip and the gauge marks from the snapshot resolved at
    // construction, so a compaction-enabled session shows them on the FIRST
    // frame rather than after the first turn.
    if (controller.isCompactionRegistered()) {
      dispatch({ type: 'compactionSnapshot', snapshot: controller.getCompactionSnapshot() });
    }

    return controller.subscribeCompaction((event) => {
      switch (event.type) {
        case 'compaction_start':
          if (interactionPhase.current === 'idle') {
            manualMetrics.current = updateRunMetrics(createRunMetrics(),
              { type: 'agent_start' }, Date.now());
          }
          dispatch({
            type: 'compactionStart',
            index: event.index,
            trigger: event.trigger,
            model: event.model,
          });
          break;
        case 'compaction_end':
          manualMetrics.current = freezeRunMetrics(manualMetrics.current, Date.now());
          // THE CARD, AND NOTHING ELSE (context-usage-gauge-accuracy §3.3).
          //
          // A `contextTokensEstimated` dispatch used to live here, hand-building
          // the post-compaction occupancy out of `record.tokensAfter` plus the
          // snapshot's `estimateOffset`. It is gone because the gauge now has ONE
          // writer: `ContextMeter` learns about the splice from
          // `CompactionWiring.settlePending` itself and re-measures, so the bar
          // falls in the same frame WITHOUT this branch and without the `snapshot`
          // branch below racing it. Those two dispatches were the second and
          // third writers of one number, and the loser of that race was the
          // correct value (P0-1).
          dispatch({ type: 'compactionEnd', record: event.record });
          break;
        case 'usage': {
          // Compaction spend is REAL SPEND at the SUMMARIZER's price (§6.4 /
          // AC-15), which may be neither the lead's nor the fast tier's — so the
          // ref is ASKED FOR rather than assumed. `getModelInfo()` here would
          // price a Haiku summarization at the lead's Opus rates, which is the
          // same class of lie as the `$0.00` `pricingUnknown` exists to prevent,
          // just in the other direction.
          const snapshot = controller.getCompactionSnapshot();
          const ref = event.modelRef ?? controller.getCompactionSummarizerRef();
          const costDelta =
            (event.pricingUnknown ?? snapshot.pricingUnknown)
              ? 0
              : event.costUsd ?? (ref
                ? computeCost(event.usage, controller.getModelInfoFor(ref).cost) : 0);
          dispatch({ type: 'compactionUsage', usage: event.usage, costDelta });
          break;
        }
        case 'snapshot':
          // THE CHIP, THE COUNTS AND THE SUMMARIZER (§3.3). The occupancy that
          // rides along on `snapshot.pressure` is deliberately NOT dispatched
          // here: the meter that produced it publishes it on its own channel, and
          // a second dispatch of the same number is the second writer this
          // feature removed.
          dispatch({ type: 'compactionSnapshot', snapshot: event.snapshot });
          break;
      }
    });
  }, [controller]);

  // --- Live tool output (agent-activity-presentation-live §3.3.2). --------
  //
  // A FIFTH SUBSCRIPTION, and THE ONE THAT DOES GO THROUGH THE STREAMING
  // COALESCER (D-34 / P0-2). The three above each carry a discrete act at human
  // frequency — a roster change, a `todo_write`, a review verdict — and each has
  // a comment refusing the buffer for that reason. This one carries a STREAM at
  // pipe speed: the producer is a child process's stdout, so dispatching per
  // chunk would be one React commit per `read()`.
  //
  // THE EFFECT PUSHES INTO `pending.current` AND ARMS `flushTimer` ITSELF.
  // There is no "buffered path for every other action" to fall into —
  // `App.tsx:436-447` buffers exactly `textDelta` / `thinkingDelta` and
  // dispatches everything else immediately — so writing this the way its three
  // siblings are written leaves `mergeDeltas`'s new clause dead code and R-1
  // with one bound instead of two. AC-38 is the pin, mutation-checked against
  // the direct-dispatch form.
  //
  // `Date.now()` IS READ HERE, in the listener, not in the reducer, which is
  // what keeps `viewReducer` pure.
  useEffect(() => {
    return controller.subscribeToolOutput(({ toolCallId, rows }) => {
      pending.current.push({ type: 'toolOutputDelta', toolCallId, rows, at: Date.now() });
      if (!flushTimer.current) {
        // READ FROM THE REF AT ARM TIME, for the reason `App.tsx:439-441`
        // records: this effect's dependency list never changes, so a captured
        // number would be pinned to the mount render and the governor's ladder
        // would move nothing.
        flushTimer.current = setTimeout(() => flushPending(), governorInterval.current);
      }
    });
  }, [controller, flushPending, governorInterval]);

  // Event boundaries own start/end; ticks only refresh the live projection.
  useEffect(() => {
    if (state.status !== 'running') return;
    const id = setInterval(() => setMetricsClock(Date.now()), 200);
    return () => clearInterval(id);
  }, [state.status]);

  useLayoutEffect(() => {
    if (manualMetrics.current.startedAt === null || !state.compactionEntryId) return;
    const entry = state.entries.find(item => item.id === state.compactionEntryId);
    if (entry?.kind === 'compaction' && entry.startedAt !== undefined) {
      manualMetrics.current = { ...manualMetrics.current, startedAt: entry.startedAt };
    }
  }, [state.compactionEntryId, state.entries]);

  // --- Live compaction elapsed tick (hardening §3.6 / W5). ---------------
  //
  // ONLY WHILE A CARD IS LIVE AND THE RUN IS NOT, so an ordinary session has no
  // timer and an in-loop compaction reuses the 200 ms elapsed ticker rather than
  // adding a second one. 1 Hz, because the card shows whole seconds.
  useEffect(() => {
    if (state.compactionEntryId === undefined || state.status === 'running') return undefined;
    const id = setInterval(() => setCompactionClock(Date.now()), 1000);
    return () => clearInterval(id);
  }, [state.compactionEntryId, state.status]);

  // --- Retry countdown tick (llm-api-retry-backoff §6.5). ----------------
  //
  // ONLY WHILE A BACKOFF IS ACTUALLY WAITING, and the effect's teardown clears it —
  // so an idle session, and even a session that is retrying but has already fired
  // its next attempt, has NO timer at all. 1 Hz rather than the elapsed timer's
  // 200 ms because the card shows whole seconds and a five-times-finer tick would
  // buy four identical frames.
  useEffect(() => {
    if (state.retry?.phase !== 'waiting') return undefined;
    const id = setInterval(() => dispatch({ type: 'retryTick' }), 1000);
    return () => clearInterval(id);
  }, [state.retry?.phase]);

  // --- Toast auto-dismiss (single effect keyed on the toast list). -------
  useEffect(() => {
    for (const t of state.toasts) {
      if (!toastTimers.current.has(t.id)) {
        const id = setTimeout(() => {
          dispatch({ type: 'dismissToast', id: t.id });
          toastTimers.current.delete(t.id);
        }, t.ttlMs);
        toastTimers.current.set(t.id, id);
      }
    }
    for (const [tid, timer] of toastTimers.current) {
      if (!state.toasts.some((t) => t.id === tid)) {
        clearTimeout(timer);
        toastTimers.current.delete(tid);
      }
    }
  }, [state.toasts]);

  useEffect(
    () => () => {
      for (const timer of toastTimers.current.values()) clearTimeout(timer);
      toastTimers.current.clear();
      if (ctrlCTimer.current) clearTimeout(ctrlCTimer.current);
      if (interruptTimer.current) clearTimeout(interruptTimer.current);
    },
    [],
  );

  // --- Console bridge (fullscreen only, I-4). ----------------------------
  // Ink's own patchConsole writes straight to stdout, which shifts the fixed
  // frame by a row and breaks its line accounting for good.
  useEffect(() => {

    return installConsoleBridge((level, text) => dispatch({ type: 'notice', level, text }));
  }, []);

  // `enabled` is `mouseSource`, not `cfg.mouse`: a user whose terminal drops
  // the events must never be shown advice about a mode not in effect (§6.1).
  // `cli.tsx::wantMouse` now folds the platform check into the same expression,
  // so on a console that reports nothing there is no source and no advice.
  useStartupNotices(
    dispatch,
    {
      enabled: !!mouseSource,
      // NOT re-derived here (see `MouseNoticeOptions`): `cli.tsx` computes
      // `mouseFilter !== null && cfg.mouseSelect` once and four things read it,
      // so a second derivation is a second chance for them to disagree.
      selectEnabled: terminal?.mouseSelect ?? false,
      // `state.json`, not `config.json`: whether a one-shot notice has been shown
      // is bookkeeping, and the comment on the old persisted key said so.
      //
      // THE VERSION, NOT `true` (P1-8). The gate compares against
      // `MOUSE_NOTICE_VERSION`, so storing anything else either replays the
      // notice forever or silences a future revision of the text.
      onSeen: () => setMouseNoticeVersion(MOUSE_NOTICE_VERSION),
    },
    // Present only when `loadConfig` had to raise the user's own
    // `transcriptRetain` to `transcriptWindow` (tui-render-performance §5.1).
    cfg.transcriptRetainRequested !== undefined
      ? { requested: cfg.transcriptRetainRequested, resolved: cfg.transcriptRetain }
      : undefined,
    vtInputWarning
      ? {
          nodeVersion: vtInputWarning.nodeVersion,
          onSeen: () => setVtInputNoticeVersion(VT_INPUT_NOTICE_VERSION),
        }
      : undefined,
    native
      ? { onSeen: () => setScrollModeNoticeVersion(SCROLL_MODE_NOTICE_VERSION) }
      : undefined,
  );

  // --- Exit snapshot: the only way state reaches cli.tsx (§4.4). ----------
  useEffect(() => {
    const merged = mergePendingEntries(state.entries, state.pendingSteering);
    publishExitSnapshot({
      entries: merged,
      usageTotal: state.usageTotal,
      provider: cfg.provider,
      model: cfg.model,
      startedAt: startedAt.current,
      // Carried so the exit replay can say what the retain ring removed. A
      // transcript that silently omits entries is worse than one that names the
      // count (K-6).
      droppedEntries: state.droppedEntries,
    });
    // THE SAME `merged`, THE SAME RENDER (D-2 / 3.12). The checkpoint describes
    // exactly what the exit summary would, because it is built from the same
    // array in the same pass - and no second effect or subscription is added.
    //
    // `sessionId` IN THE DEPENDENCY ARRAY IS LOAD-BEARING (R-16): a rotation
    // that leaves the `entries` reference untouched would otherwise never
    // re-publish, and the writer would keep aiming at the OLD id's file - the
    // "A's conversation written into B's file" failure I-5 rules out.
    if (sessionId) {
      publishSessionView({ id: sessionId, entries: merged, usageTotal: state.usageTotal });
    }
  }, [state.entries, state.pendingSteering, state.usageTotal, state.droppedEntries, cfg.provider, cfg.model, sessionId]);

  // --- `/perf` snapshot channel (tui-render-performance §5.4). ------------
  //
  // The deps are the two `useCallback`d members, NOT the handle objects: both
  // hooks return a fresh literal per render, so depending on them would re-run
  // this effect on every frame.
  const governorReset = governor.reset;
  const heightsClear = heights.clear;
  useEffect(() => {
    setPerfSnapshotProvider(() => perfRef.current);
    setPerfResetHook(() => {
      governorReset();
      heightsClear();
    });
    return () => {
      setPerfSnapshotProvider(null);
      setPerfResetHook(null);
    };
  }, [governorReset, heightsClear]);

  // --- Confirm bridge (confirmTools mode + skill approvals). -------------
  useEffect(() => {
    if (!confirmBridge) return;
    confirmBridge.handler = (req: ConfirmRequest) =>
      new Promise<boolean>((resolve) => {
        setConfirmState({ summary: req.summary, resolve });
        dispatch({ type: 'setOverlay', overlay: 'confirm' });
      });
    return () => {
      // The skill ApprovalGate reads `handler !== null` LIVE on every call, so
      // this cleanup is what makes approvals fail closed again once the App
      // unmounts. Caching the probe result anywhere would defeat it (Q7).
      confirmBridge.handler = null;
    };
  }, [confirmBridge]);

  // --- Human-input bridge (ask_user / submit_plan). ----------------------
  useEffect(() => {
    if (!humanInputBridge) return undefined;
    const bridge = humanInputBridge;
    bridge.handler = (req: HumanRequest, signal?: AbortSignal) =>
      new Promise<HumanResponse | null>((resolve) => {
        const entry: PendingHumanRequest = { resolve, done: false };
        pendingHuman.current.add(entry);
        // THE ONLY CEILING THIS WAIT HAS. `ToolExecutor`'s timeout is
        // cooperative — it aborts the context signal and keeps awaiting the
        // tool — and the idle watchdog is deliberately paused for the duration.
        // Without this listener both ceilings are gone at once and the process
        // wedges behind an overlay nobody is going to answer (P0-2).
        signal?.addEventListener('abort', () => settleHuman(entry, null), { once: true });
        setHumanRequest(req);
        dispatch({
          type: 'setOverlay',
          overlay: req.kind === 'plan' ? 'plan' : 'question',
        });
      });
    bridge.cancelPending = cancelPendingHuman;
    return () => {
      // BEFORE nulling the handler, not after: `ConfirmBridge` nulls its handler
      // and leaves in-flight promises dangling forever, which with a wizard the
      // user abandons would hang the tool until its ceiling (R-P4).
      cancelPendingHuman();
      bridge.handler = null;
    };
  }, [humanInputBridge, settleHuman, cancelPendingHuman]);

  // --- Seed the mode mirror from its owner, once, on mount. --------------
  // `--plan` / `planModeDefault` are resolved before the App exists, so the
  // reducer's `'build'` seed would render one wrong frame without this.
  useEffect(() => {
    const current = controller.getAgentMode();
    dispatch({ type: 'setAgentMode', mode: current, pending: null });
  }, [controller]);

  // --- Let the controller drive command-list rebuilds. -------------------
  useEffect(() => {
    controller.setOnSkillsChanged(() => setSkillsNonce((n) => n + 1));
  }, [controller]);

  // --- Project skill-directory trust gate (D13 / §9.3). ------------------
  // Asked once per untrusted root, after the first render so the confirm bridge
  // is attached. Declining does NOT write anything: the root is skipped for this
  // session and the question comes back next time, which is the right default
  // for "I have not looked at this repo yet".
  const trustAsked = useRef(false);
  useEffect(() => {
    if (trustAsked.current || !cfg.skills.enabled) return;
    const service = controller.getSkillService();
    const pending = service.untrustedDirs();
    if (pending.length === 0) return;
    trustAsked.current = true;

    void (async () => {
      for (const dir of pending) {
        const approved = await new Promise<boolean>((resolve) => {
          setConfirmState({
            summary:
              `Load project skills from ${dir}?\n` +
              'Skills in this directory can inject instructions into this session.',
            resolve,
          });
          dispatch({ type: 'setOverlay', overlay: 'confirm' });
        });
        if (approved) {
          service.trustDir(dir);
          service.reload();
          setSkillsNonce((n) => n + 1);
        }
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [controller, cfg.skills.enabled]);

  // --- Helpers -----------------------------------------------------------

  const notify = (level: 'info' | 'warn' | 'error', text: string) =>
    dispatch({ type: 'notice', level, text });

  const toast = (level: ToastLevel, text: string) =>
    dispatch({ type: 'pushToast', level, text });

  // THE BRANCH / `--save` NOTICE (D-13). Once, on mount, and only when the
  // caller supplied one: "the session you branched from is unchanged" is the
  // sentence that makes `--resume` safe to reach for, and it belongs in the
  // transcript where it can be read again rather than in a toast that expires.
  useEffect(() => {
    if (sessionNotice) notify('info', sessionNotice);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // --- Session bridge: identity write-back (D-15 / 3.12). -------------------
  //
  // INSTALLED AND CLEARED EXACTLY LIKE `confirmBridge.handler`: the rotation is
  // performed by `cli.tsx` (which owns the writer's target file), and the only
  // thing the view owns is the id it draws. Clearing on unmount keeps a late
  // rotation from dispatching into a dead reducer.
  useEffect(() => {
    if (!sessionBridge) return undefined;
    const bridge = sessionBridge;
    bridge.onIdentity = (next: SessionIdentity) => {
      identityRef.current = next;
      setIdentity(next);
    };
    return () => {
      bridge.onIdentity = undefined;
    };
  }, [sessionBridge]);

  // --- Paste bridge (tui-paste-handling section 5.1.2 / I-15). -------------
  //
  // The filter exists before this component does, so it holds a slot rather than
  // a callback. Cleared on unmount: a rejection that somehow arrived after the
  // tree came down would otherwise dispatch into a dead reducer.
  useEffect(() => {
    if (!pasteBridge) return undefined;
    const bridge = pasteBridge;
    bridge.notify = (level, text) => dispatch({ type: 'notice', level, text });
    return () => {
      bridge.notify = null;
    };
  }, [pasteBridge]);

  // Synchronous layout reports keep the fixed slot and its contents in one frame.
  const onPopupRowsChange = useCallback((next: number) => {
    setPopupRows(previous => previous === next ? previous : next);
  }, []);
  const onDraftRows = useCallback((next: number) => {
    setDraftRows(previous => previous === next ? previous : next);
  }, []);
  /**
   * Draft presence, written to a REF on purpose (ctrl-c-clear-draft-exit):
   * promoting it to state would re-render the transcript on the first
   * keystroke of every message - the exact cost Composer.tsx documents
   * for keeping `hasDraft` local. The ladder reads the ref inside its key
   * handler, where freshness is guaranteed; the render-time feedback
   * uses `hasDraftRef.current && !draftClearedByCtrlC` instead.
   */
  const hasDraftRef = useRef(false);
  const onDraftPresence = useCallback((hasDraft: boolean) => {
    hasDraftRef.current = hasDraft;
    // A draft that re-appears after a ladder clear re-arms the clear rung.
    if (hasDraft) setDraftClearedByCtrlC(false);
  }, []);

  // --- Auto-update bridge (cli-auto-update section 3.8 / 6.3). ------------
  //
  // TWO ARRIVAL ORDERS, AND BOTH HAPPEN. The service is built by a dynamic
  // `import()` fired after `render()`, so on a warm module cache it can be
  // attached BEFORE this effect runs, and on a cold one long after. Reading
  // `bridge.service` first and installing `onAttach` second covers both without
  // a race - the same shape `confirmBridge` uses one screen up.
  useEffect(() => {
    if (!updateBridge) return undefined;
    const bridge = updateBridge;
    let unsubscribe: (() => void) | null = null;

    const attach = (service: NonNullable<UpdateBridge['service']>): void => {
      setUpdateSnapshot(service.snapshot());
      unsubscribe = service.subscribe(setUpdateSnapshot);
    };

    if (bridge.service) attach(bridge.service);
    else bridge.onAttach = attach;

    return () => {
      bridge.onAttach = null;
      unsubscribe?.();
    };
  }, [updateBridge]);

  // ONE TOAST, ON THE `installing -> ready` EDGE ONLY (section 6.3 / AC-19).
  //
  // It exists because the moment of completion may arrive while the user is
  // reading the transcript with the row occupied by a run: the toast wins the row
  // for its TTL and then hands it back to the persistent line. The ref is what
  // makes ten re-renders at `ready` push exactly one.
  useEffect(() => {
    if (updateSnapshot?.phase !== 'ready') return;
    if (updateToastPushed.current) return;
    updateToastPushed.current = true;
    toast('info', `${updateSnapshot.latestVersion ?? 'Update'} installed - restart aragon to apply.`);
    // `toast` is a stable dispatch wrapper; depending on it would re-run this on
    // every render and defeat the ref guard's purpose rather than its mechanism.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [updateSnapshot?.phase, updateSnapshot?.latestVersion]);

  // --- Selection (tui-selection-and-scroll-follow §4.4). -------------------
  //
  // The controller is built by `cli.tsx` before `render()`, so what it is
  // missing when it starts is exactly the two things that only exist once this
  // component is mounted: somewhere to put a toast, and a way to ask for a React
  // redraw when the frame differ has no cache to repaint from. Both are assigned
  // here and cleared on unmount, the same shape `updateBridge` uses.
  const selectionBridge = terminal?.selection;
  const copyCoordinator = useMemo(() => createClipboardCoordinator({
    clipboard: { write: terminal?.writeForeign },
    onRequest: () => {
      ctrlCArmed.current = false;
      setMetricsClock(Date.now());
      if (ctrlCTimer.current) clearTimeout(ctrlCTimer.current);
      ctrlCTimer.current = null;
    },
    onStateChange: setCopyState,
    onBusy: ({ cleanupPending }) => toast('info', cleanupPending
      ? 'Copy failed; cleaning up' : 'Copying'),
    onResult: (result, request) => {
      selectionBridge?.onCopied?.(result, request.lines, request.text.length);
      const text = result.status === 'confirmed' ? `Copied ${request.lines} lines`
        : result.status === 'sent' ? 'Copy sent to terminal; not confirmed'
        : `${interactionCopy.copyFailed}: ${interactionCopy.copyReasons[result.reason]}`;
      copyFeedback.current = { result: {
        status: result.status === 'confirmed' || result.status === 'sent' ? result.status : 'error',
        text }, previousIds: new Set(stateRef.current.toasts.map(item => item.id)) };
      toast(result.status === 'confirmed' ? 'success' : result.status === 'sent' ? 'info' : 'warn', text);
      if (result.status !== 'confirmed' && result.status !== 'sent') notify('error', text);
    },
  }), []);
  useEffect(() => () => copyCoordinator.dispose(), [copyCoordinator]);

  useEffect(() => {
    if (!selectionBridge) return undefined;
    // I-5 of `frame-differ.ts`: writing escapes here would be a foreign write.
    // The nonce is the carrier Ctrl+L already uses (§4.13).
    selectionBridge.requestRedraw = () => setRedrawNonce((n) => n + 1);
    const unsubscribe = selectionBridge.controller?.onHoldChange(setSelectionHold);
    return () => {
      selectionBridge.onCopied = null;
      selectionBridge.requestRedraw = null;
      unsubscribe?.();
    };
    // `toast` is a stable dispatch wrapper; depending on it would rebuild this
    // subscription on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectionBridge]);

  useLayoutEffect(() => {
    const feedback = copyFeedback.current;
    if (!feedback) return;
    if (!feedback.toastId) {
      feedback.toastId = state.toasts.find(item => !feedback.previousIds.has(item.id)
        && item.text === feedback.result.text)?.id;
    }
    if (feedback.toastId && !state.toasts.some(item => item.id === feedback.toastId)) {
      copyFeedback.current = null;
    }
  }, [state.toasts]);

  const selectionController = selectionBridge?.controller ?? null;

  /**
   * I-9, the DERIVED half — and the one that matters (D-14 / P1-4).
   *
   * `shiftUp` changes exactly when the rows on screen move: a wheel notch, a key,
   * PgDn, the bottom snap, `pinToBottomNonce`, the idle auto-resume, a height
   * correction above the reading position. An enumerated list of gestures was
   * already incomplete on the day it was written — it missed this feature's OWN
   * auto-resume, which would have left a five-second-old highlight sitting over
   * rows that had scrolled out from under it — and a derived condition cannot be
   * forgotten by the next person who adds a way to move the viewport.
   *
   * Rule A holds `shiftUp` CONSTANT while a drag is in progress, which is why a
   * selection survives output streaming in below it and only that.
   *
   * Referentially stable, because `ScrollViewport` publishes it from an effect
   * keyed on the callback.
   */
  const onViewportShiftChange = useCallback(() => {
    selectionController?.clear();
  }, [selectionController]);

  const onGeometryChange = useCallback(() => {
    selectionController?.clear();
    terminal?.scrollbar?.controller?.cancel();
    terminal?.scrollbar?.invalidate();
    setSelectionHold(false);
  }, [selectionController, terminal]);

  // I-9, the ENUMERATED half. `shiftUp` covers every movement of the rows and is
  // wired straight into `ScrollViewport` below; these three are the cases that
  // change the screen while leaving `shiftUp` untouched — a key that scrolls
  // nothing, an overlay swap, and a re-wrap (P1-7).
  useEffect(() => {
    if (!selectionController) return;
    // Screen coordinates stop meaning anything the moment every line re-wraps,
    // and a resize is exactly that (N6).
    selectionController.clear();
  }, [selectionController, rows, cols]);

  useEffect(() => {
    if (!selectionController) return;
    // An overlay replaces the viewport, so a selection over it would be a
    // highlight over rows that are no longer there (N4).
    selectionController.setEnabled(state.overlay === null && !tooSmall);
    selectionController.clear();
  }, [selectionController, state.overlay, tooSmall]);

  const persistConfig = (patch: Partial<PersistedConfig>) => {
    try {
      updatePersistedConfig(patch);
      getLogger().info('config', 'config_write', { keys: Object.keys(patch) });
    } catch (err) {
      // Still best-effort — a failed persist must not break the live session —
      // but no longer SILENT. Swallowing this is the root of "I changed the
      // model in the TUI and it was back to the old one after a restart", a
      // report with nothing anywhere to investigate.
      const reason = err instanceof Error ? err.message : String(err);
      getLogger().error('config', 'config_write_failed', { reason });
      toast('warn', `Could not save settings: ${reason}`);
    }
  };

  const doExit = () => {
    controller.abort();
    // G5. `force: true` means `reapSync()` SEMANTICS - immediate SIGKILL, no
    // grace ladder - because THIS FUNCTION AWAITS NOTHING AND MUST NOT START
    // (§3.6 step 3). An async `stopAll` with a 3 s escalation would still be
    // running when `exit()` tore the tree down, and every child would survive.
    //
    // IT IS DELIBERATELY REDUNDANT with the signal hook the controller
    // registered: a normal quit reaches both, and `reapSync` is idempotent
    // precisely so that is safe. The hook covers SIGINT/SIGTERM and a crash;
    // this covers `/exit` and `Ctrl+C x2`, which are not signals at all.
    void controller.stopAllServices({ force: true });
    exit();
  };

  /**
   * THE SINGLE MODE WRITE PATH (§3.1 / R-P7).
   *
   * `Shift+Tab` and `/plan` both come through here, which is what makes them
   * the same code path rather than two that can drift. Note that the value
   * dispatched into the view is what the controller reports it ADOPTED, never
   * what was requested: dispatching the request is the one way to make the badge
   * claim a permission the gate will not honour.
   */
  const applyMode = (next: AgentMode, opts: { force?: boolean; silent?: boolean } = {}) => {
    const applied = controller.setAgentMode(next, opts.force ? { force: true } : {});
    dispatch({ type: 'setAgentMode', mode: applied.effective, pending: applied.pending });
    if (opts.silent) return applied;
    if (applied.pending) {
      toast('info', `${MODE_LABEL[applied.pending]} mode applies after this run.`);
    } else {
      toast('info', `${MODE_LABEL[applied.effective]} mode.`);
    }
    return applied;
  };

  const makeCtx = (args: string): CommandContext => ({
    args,
    requestCopy: copyCoordinator.requestCopy,
    controller,
    state: stateRef.current,
    // THE ARCHIVE'S ONLY WAY TO SEE THE SCREEN (P0-1 / §3.7), and a thunk for a
    // reason `state` above illustrates: `state` is a snapshot of this render,
    // while `/clear` interrupts a run and then waits for it to unwind, so the last
    // tool cards of the abandoned run are appended AFTER the command starts. A
    // value here would archive the screen minus the part the user was watching.
    transcriptEntries: () => stateRef.current.entries,
    // THE SESSION PORT (D-14 / D-15). `identity()` reads the ref at command time
    // and never a captured value: `/resume` rotates the id under a live tree, and
    // a captured one would report the previous id for the rest of the session.
    // `checkpoint` / `rotate` are the writer's, installed by `cli.tsx`; the port
    // is absent when this build has no session at all, which is what lets
    // `/session` say so honestly instead of throwing.
    ...(sessionBridge
      ? {
          session: {
            identity: () => identityRef.current,
            checkpoint: (opts?: { pin?: boolean }): CheckpointResult =>
              sessionBridge.checkpoint?.(opts) ?? {
                ok: false as const,
                reason: 'no-identity' as const,
                message: 'This session has no id.',
              },
            rotate: (loadedPath: string) => sessionBridge.rotate?.(loadedPath),
          },
        }
      : {}),
    // The branch port is projected from the bridge here rather than captured, so
    // this object stays a view of the current bridge, exactly like `session`
    // above. Absent means `/branch` reports that the build has none.
    ...(sessionBridge?.branch ? { branch: sessionBridge.branch } : {}),
    dispatch: (action) => {
      if (action.type === 'resetConversation' || action.type === 'restoreEntries') {
        scrollbackViewRef.current?.notifyReset(action.type === 'resetConversation' ? 'clear' : 'restore');
        metrics.current = createRunMetrics();
        manualMetrics.current = createRunMetrics();
        setScrollResetKey((n) => n + 1);
        const wasStarting = interactionPhase.current === 'starting';
        submissionSequence.current += 1;
        interactionPhase.current = 'idle';
        resetInterrupt();
        cancelFollowThrough();
        autoContinuationRef.current = false;
        if (wasStarting) {
          dispatch({ type: 'abortMark' });
          dispatch({ type: 'runEnd' });
        }
      }
      dispatch(action);
    },
    setOverlay: (overlay) => dispatch({ type: 'setOverlay', overlay }),
    notify,
    toast,
    persistConfig,
    exit: doExit,
    submit: (text: string, opts?: SubmitMessageOptions) => {
      const result = submitMessage(text, opts);
      if (!result.accepted) throw new Error(result.reason ?? 'Message was not accepted.');
    },
    refreshSkills: () => setSkillsNonce((n) => n + 1),
    applyAgentMode: applyMode,
    // Read at command time, so `/todo status` reports the live count rather than
    // whatever it was when this context was built.
    followBudget: budgetRef.current,
    // Read at command time for the same reason, and additionally because the
    // service ATTACHES LATE (section 3.8): a value captured when this closure was
    // first created would be `undefined` for the whole session on a cold module
    // cache, and `/update` would report "disabled" on a session where it is on.
    // `?? undefined` because the bridge holds `null` and the port is optional.
    update: updateBridge?.service ?? undefined,
    // Read at command time so `/mouse` reports the LIVE state rather than
    // whatever it was when this closure was first built — `/mouse off` followed
    // by a bare `/mouse` has to say "off".
    ...(terminal?.setMouseCapture
      ? {
          mouse: {
            captured: () => terminal.isMouseCaptured?.() ?? true,
            selectEnabled: () => terminal.mouseSelect,
            setCapture: (on: boolean) => terminal.setMouseCapture?.(on),
          },
        }
      : {}),
    ...(terminal?.writeForeign ? { writeForeign: terminal.writeForeign } : {}),
    ...(native ? { nativeScroll: true } : {}),
  });

  /**
   * Submitting a prompt no longer touches `config.json` at all — it appends one
   * line to the history file and bumps one counter in `state.json`.
   *
   * `setPromptHistory` IS NOT OPTIONAL, and deleting it is the single easiest
   * mistake to make here: `appendPrompt` keeps its own module-level array, but
   * the `history` prop the composer recalls from is THIS React state. Without
   * this line `↑` still works after a restart (the file is correct) and fails
   * only for prompts submitted in the current session.
   */
  const recordPrompt = (text: string) => {
    setPromptHistory(appendPrompt(text));
    // Read back through `controller.getConfig()` and never entering React
    // state, exactly as before — nothing re-renders on the counter's account.
    controller.setSubmitCount(bumpSubmitCount());
  };

  /** `repeat` folds a coalesced wheel burst; the keyboard always sends one. */
  const scrollBy = useCallback((kind: ScrollIntent, repeat = 1) => {
    setScrollIntent((prev) => ({ kind, nonce: (prev?.nonce ?? 0) + 1, repeat }));
  }, []);

  /**
   * Send a message to the agent, bypassing slash parsing.
   *
   * Split out of `handleSubmit` so a dynamic skill command can submit the
   * expanded skill body on the user's behalf: routing that text back through
   * `handleSubmit` would re-parse it as input and, for a body that happens to
   * start with `/`, recurse into command dispatch.
   */
  const submitMessage = (
    message: string, opts: SubmitMessageOptions = {},
  ): ComposerSubmitResult => {
    if (controller.getConfig().modelSettingsRestartRequired) {
      return { accepted: false, reason: 'Settings require a restart before sending requests.' };
    }
    if (interactionPhase.current === 'starting') {
      return { accepted: false, reason: 'A run is still starting. Press Esc twice to cancel.' };
    }
    // A USER MESSAGE IS A NEW INTENT AND OUTRANKS A QUEUED ONE (AC-19). First
    // line, before the steering branch: a message typed during the grace window
    // must be the one that runs, whichever branch it takes.
    cancelFollowThrough();

    cancelConfirmation();
    if (interactionPhase.current === 'running' || controller.isCompactionBusy?.()) {
      try {
        const queueId = controller.queueUserMessage(message);
        dispatch({ type: 'steerQueued', queueId, text: message });
        return { accepted: true };
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        notify('error', reason);
        return { accepted: false, reason };
      }
    }
    resetInterrupt();
    const sequence = ++submissionSequence.current;
    interactionPhase.current = 'starting';
    dispatch({ type: 'runStarting' });

    // `userInitiated: false` skips TWO things and both are wanted: the
    // prompt-history append, and the `submitCount` bump that drives the
    // composer's hint fade. An auto-continuation demonstrates nothing about what
    // the user has learned, so suppressing the fade is correct rather than
    // incidental — which is why the parameter is named for the CAUSE (P2-8).
    if (opts.userInitiated !== false) recordPrompt(message);
    // Mirrors where the reducer clears its own copies, in the same action
    // (C-11): a new turn's end reason must not inherit the previous one's.
    endReasonRef.current = { aborted: false, errored: false };
    dispatch({ type: 'submit', text: message });

    const pre = controller.preflight();
    if (!pre.ok) {
      dispatch({ type: 'runError' });
      notify('error', pre.message ?? 'Configuration error.');
      interactionPhase.current = 'idle';
      resetInterrupt();
      autoContinuationRef.current = false;
      dispatch({ type: 'runEnd' }); // reset status; nothing was started
      return { accepted: true };
    }
    // Fire-and-forget: events drive the UI. prompt() never rejects.
    void controller.prompt(message, { todoPolicy: opts.todoPolicy ?? 'new-task' }).then((outcome) => {
      if (!mounted.current || sequence !== submissionSequence.current) return;
      if (outcome?.status !== 'not-started') return;
      if (outcome.reason !== 'cancelled') dispatch({ type: 'runError' });
      interactionPhase.current = 'idle';
      resetInterrupt();
      autoContinuationRef.current = false;
      dispatch({ type: 'runEnd' });
    });
    return { accepted: true };
  };
  submitRef.current = submitMessage;

  const executeSlashInput = async (raw: string): Promise<void> => {
    // A CONVERSATION SWITCH OWNS THE QUEUE FOR THE WHOLE COMMAND (B-6 / §3.7).
    //
    // The guard used to be raised only when a compaction happened to be busy,
    // which left the one window this feature is about unwatched: `/clear` on an
    // IDLE session took the flag nowhere, and `drainCompactionQueue` was still
    // free to `continue()` a message queued in the previous conversation into
    // the one the user had just started. Whether there is work to cancel is a
    // separate question, so the two are now separate values: `switching` decides
    // the lock, `switchWhileBusy` decides the cancellation.
    //
    // `/resume` is still refused mid-run by `handleSubmit` below, so for it the
    // lock only ever matters while idle - that is the minimum this invariant
    // asks for, not a contradiction.
    const switching = /^\s*\/(clear|reset|resume)(?:\s|$)/.test(raw);
    const switchWhileBusy = switching && Boolean(controller.isCompactionBusy?.());
    if (switching) switchingConversation.current = true;
    if (switchWhileBusy) await controller.cancelCompaction();
    // Retain a recoverable command before any asynchronous handler can fail.
    const safe = redactText(raw, getSecrets());
    recordPrompt(safe);
    notify('info', `Command: ${safe}`);
    try {
      await runSlashInput(registry, raw, makeCtx);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      notify('error', `Command failed: ${redactText(reason, getSecrets())}\nInput: ${safe}`);
    } finally {
      if (switching) {
        switchingConversation.current = false;
        drainCompactionQueue.current();
      }
    }
  };

  const handleSubmit = (raw: string): ComposerSubmitResult => {
    const trimmed = raw.trimStart();
    const slash = trimmed.startsWith('/') && !trimmed.startsWith('//');
    if (slash && (interactionPhase.current === 'running' || controller.isRunning()) &&
      /^\/resume(?:\s|$)/.test(trimmed)) {
      return { accepted: false,
        reason: 'Interrupt the current run before switching conversations.' };
    }
    // Submitting is an unconditional "take me to the newest output" (§4.5).
    setPinToBottomNonce((n) => n + 1);
    if (slash) {
      void executeSlashInput(raw);
      return { accepted: true };
    }
    return submitMessage(trimmed.startsWith('//') ? raw.replace('//', '/') : raw);
  };

  const handleProfileSave = (draft: ModelSettingsDraft) => {
    const result = controller.saveModelSettings(draft);
    if (!result.ok) return result;
    if (draft.patch.showThinking !== undefined
      && controller.getConfig().showThinking !== stateRef.current.thinkingVisible) {
      dispatch({ type: 'toggleThinking' });
    }
    dispatch({ type: 'setOverlay', overlay: null });
    toast(result.restartRequired ? 'warn' : 'success', modelSettingsResultMessage(result));
    return result;
  };

  const handleModelSelect = (provider: string, model: string) => {
    const result = controller.saveModelSettingsPatch({ provider, model });
    if (!result.ok) {
      toast('error', modelSettingsResultMessage(result));
      return;
    }
    dispatch({ type: 'setOverlay', overlay: null });
    toast('info', `Model set to ${provider}:${model}.`);
  };

  /**
   * `ctrl+K` chose a row (agent-model-kits §4.7 / AC-25).
   *
   * `null` is `Current setup`, which is the RELEASE action, not a no-op: it runs
   * `clearSessionKit` so the live connections go back to the file's bindings.
   * Both paths close the overlay, and both report through the same toast funnel -
   * including every `KitNote`, because a kit that turns the fast tier on spends
   * money and must never do it silently (§4.2 / F-23).
   */
  const handleKitChoose = (kitId: string | null) => {
    // NO KIT PORT, NO CRASH: a legacy host can still press the key, and the only
    // honest answer is a sentence rather than a stack trace.
    const port = controller as { applySessionKit?: unknown; clearSessionKit?: unknown };
    if (typeof port.applySessionKit !== 'function' || typeof port.clearSessionKit !== 'function') {
      dispatch({ type: 'setOverlay', overlay: null });
      toast('error', 'This build cannot switch kits.');
      return;
    }
    const result = kitId === null
      ? controller.clearSessionKit() : controller.applySessionKit(kitId);
    dispatch({ type: 'setOverlay', overlay: null });
    // The config is already updated synchronously, so this reads the kit that is
    // in effect RIGHT NOW rather than the id the user asked for - if the apply
    // fell back to anything, the toast says so.
    const applied = controller.getActiveKit().name;
    const text = !result.ok ? kitApplyMessage(result)
      : kitId === null ? "Kit released; using the config file's settings."
        : `Kit ${applied} applied for this session.`;
    const notes = kitNoteMessages(result.notes);
    // A NOTE IS A WARNING, NOT A SUCCESS (F-23): the toast colour is the only
    // signal a user gets that applying a kit can start spending money.
    toast(result.ok ? (notes.length ? 'warn' : 'success') : 'error',
      [text, ...notes].join(' '));
  };

  const closeConfirm = () => {
    setConfirmState(null);
    dispatch({ type: 'setOverlay', overlay: null });
  };

  // --- Ctrl+I: run the bundled project-indexer skill. -------------------
  //
  // SAME PATH AS A TYPED COMMAND, ON PURPOSE. After the Yes/No gate (the
  // second confirmation the user asked for) this dispatches
  // `/skill:project-indexer <args>` through `executeSlashInput`, so the
  // load/activate/queue-frame/submit lifecycle and the streaming tool cards
  // in the transcript are the ones every skill command already has. The
  // busy guard refuses rather than queueing: a queued skill body would
  // arrive as steering mid-run, which is not what "build the index" means.
  const requestIndexBuild = (): void => {
    if (controller.isRunning() || interactionPhase.current !== 'idle') {
      // A notice entry, not a toast: the running status row's feedback slot is
      // owned by the activity phrase, and a busy warning nobody can read is
      // the same as no warning.
      notify('warn', 'The agent is busy. Let it finish before building the index (Ctrl+I).');
      return;
    }
    if (cfg.skills.enabled) {
      const record = controller.getSkillService().get(INDEX_SKILL_NAME);
      if (!record || record.disabled || record.invalid) {
        notify('warn', `Skill "${INDEX_SKILL_NAME}" is not available. Check /skills list.`);
        return;
      }
    } else {
      notify('warn', 'Skills are disabled; the project index needs the bundled skill.');
      return;
    }
    const cwd = controller.getCwd();
    const existing = hasProjectIndex(cwd);
    void (async () => {
      const approved = await new Promise<boolean>((resolve) => {
        setConfirmState({ summary: buildIndexConfirmSummary({ cwd, hasExistingIndex: existing }), resolve });
        dispatch({ type: 'setOverlay', overlay: 'confirm' });
      });
      if (approved) {
        await executeSlashInput(`/skill:${INDEX_SKILL_NAME} ${indexBuildInvocationArgs(existing)}`);
      }
    })();
  };

  /** Answer every outstanding request with the same response and close up. */
  const resolveHuman = (response: HumanResponse): void => {
    for (const entry of [...pendingHuman.current]) settleHuman(entry, response);
  };

  const handlePlanVerdict = (verdict: PlanVerdict): void => {
    if (verdict.decision === 'approved') {
      // BEFORE resolving, not after. `submit_plan` also calls
      // `setAgentMode('build', { force: true })` when its wait returns — that is
      // the authoritative act, and it stays because it must work even if the App
      // is gone by then. But it runs a microtask later, so reading the mode back
      // here would read `'plan'` and the badge would lag by a frame. Writing it
      // first through the same single path makes the tool's call an idempotent
      // no-op and keeps the mirror exact (§3.1 / R-P7).
      applyMode('build', { force: true, silent: true });
      toast('success', 'Plan approved. Implementing.');
    } else {
      toast('info', 'Revision requested.');
    }
    resolveHuman({ kind: 'planDecision', decision: verdict.decision, feedback: verdict.feedback });
  };

  const { clearCoalescer } = useWheelRouting({
    mouseSource,
    isPointerCaptured: () => terminal?.scrollbar?.controller?.isCaptured() ?? false,
    isActive: () => !tooSmall,
    getOverlay: () => stateRef.current.overlay,
    getOverlayPage: () => overlayPage,
    onScroll: scrollBy,
    onOverlayScroll: (delta) => setOverlayScroll((n) => Math.max(0, n + delta)),
  });

  const returnToComposer = useCallback(() => {
    clearCoalescer();
    terminal?.scrollbar?.controller?.cancel();
    if (scrolledLines > 0) setPinToBottomNonce((n) => n + 1);
  }, [clearCoalescer, terminal, scrolledLines]);
  useEffect(() => {
    stdout.on('resize', clearCoalescer);
    return () => { stdout.off('resize', clearCoalescer); };
  }, [stdout, clearCoalescer]);
  useEffect(() => {
    const bridge = terminal?.scrollbar;
    if (!bridge) return;
    bridge.onStart = () => { clearCoalescer(); terminal?.selection?.controller?.clear(); };
    bridge.requestRedraw = () => setRedrawNonce((n) => n + 1);
    return () => { bridge.onStart = undefined; bridge.requestRedraw = undefined; };
  }, [terminal, clearCoalescer]);
  useEffect(() => {
    clearCoalescer();
    terminal?.scrollbar?.controller?.cancel();
  }, [rows, cols, tooSmall, state.overlay, clearCoalescer, terminal]);

  // A fresh overlay always opens at the top; carrying the previous overlay's
  // offset over would open Help mid-list for no reason the user can see.
  //
  // `clearCoalescer()` rides along here rather than adding a second subscriber
  // to the same transition (wheel-scrolls-transcript-only §4.3): an
  // accumulated-but-unflushed transcript scroll must not survive an overlay
  // opening.
  useEffect(() => {
    setOverlayScroll(0);
    clearCoalescer();
  }, [state.overlay, clearCoalescer]);

  // --- Initial overlay / prompt (after handlers are defined). ------------
  useEffect(() => {
    if (initialOverlay) dispatch({ type: 'setOverlay', overlay: initialOverlay });
    if (initialPrompt && initialPrompt.trim().length > 0) {
      // Defer so the subscription is live before the first run.
      const id = setTimeout(() => void handleSubmit(initialPrompt), 0);
      return () => clearTimeout(id);
    }
    return undefined;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // --- Global keys -------------------------------------------------------
  useInput((input, key) => {
    if (!key.escape) cancelConfirmation();
    // I-9, the third clear trigger, and FIRST IN THE HANDLER so no `return`
    // below can skip it. Any key at all drops the selection: most of them move
    // the rows, and the ones that do not have still ended the gesture. It is
    // also the way out of a `hold` that lost its release (I-11), alongside the
    // watchdog.
    //
    // `Esc` IS DELIBERATELY NOT GIVEN A SECOND MEANING (§4.4.6). It aborts a
    // run, and an emergency exit is the last key that should silently absorb a
    // press; it clears the selection here like every other key and nothing more.
    //
    // THE ONE EXCEPTION, AND IT SITS AHEAD OF THE UNCONDITIONAL CLEAR
    // (tui-shift-enter-copy-queue 4.3): Ctrl+C over a RELEASED, non-empty
    // selection means COPY. Selecting is browsing; copying is committing,
    // and the commit key is the one a terminal user already reaches for.
    // `takeSelection` runs BEFORE `copyText` because the copy writes OSC
    // 52 through `writeForeign`, which invalidates the differ and would
    // otherwise re-clear this controller a tick later (R7). A failed copy
    // (`via === 'none'`) still reports through the shared toast funnel and
    // returns: the selection is already consumed, and the NEXT Ctrl+C
    // walks the original ladder.
    if (key.ctrl && (input === 'c' || input === 'C') && copyCoordinator.isBusy()) {
      void copyCoordinator.requestCopy({ text: '', lines: 0 });
      return;
    }
    if (
      key.ctrl &&
      (input === 'c' || input === 'C') &&
      (selectionController?.hasPendingSelection() ?? false)
    ) {
      const payload = selectionController!.takeSelection();
      ctrlCArmed.current = false;
      setMetricsClock(Date.now());
      if (ctrlCTimer.current) clearTimeout(ctrlCTimer.current);
      ctrlCTimer.current = null;
      if (payload) {
        void copyCoordinator.requestCopy({ text: payload.text, lines: payload.lines });
      }
      return; // A consumed copy intent never becomes exit or service stop.
    }
    selectionController?.clear();

    if (key.ctrl && (input === 'c' || input === 'C')) {
      // RUNG ONE: Ctrl+C acquires the meaning a terminal user already expects
      // it to have (§3.6 / G4 / D-5). While services are live it stops THEM, and
      // only once nothing is running does it fall through to the existing
      // arm/exit ladder.
      //
      // IT DOES NOT ARM EXIT. Stopping a server and quitting the app are
      // different intentions, and a user who pressed Ctrl+C to kill a dev server
      // must not find themselves one keystroke from losing the session. The
      // composer hint still names an exit clause, so quitting stays discoverable
      // (P1-4).
      //
      // THE GRACEFUL LADDER, not `force`: this path has a live event loop to run
      // the SIGTERM -> SIGKILL escalation on, and a dev server given a chance to
      // shut down cleanly releases its port.
      const live = liveServiceCount(servicesRef.current);
      if (live > 0) {
        void controller.stopAllServices();
        toast('warn', `Stopping ${live} service${live === 1 ? '' : 's'}.`);
        return;
      }
      //
      // RENDER-TIMING INVARIANT (part of this fix, not an implementation
      // detail): the status feedback is evaluated during render, but
      // `hasDraftRef` is a ref that does not itself trigger one. Every
      // rung still lands exactly one render - arm bumps `metricsClock`,
      // the clear rung bumps `draftClearNonce`/`draftClearedByCtrlC` - and
      // the async clear (nonce -> effect -> 'clear' -> the onDraftChange
      // transition) refills the ref within the same tick, far faster than
      // a human's next press. `draftClearedByCtrlC` exists because the
      // nonce render happens BEFORE that chain: without it the feedback
      // would still read hasDraft=true and repeat the clear prompt after
      // clearing. If a future rung ever becomes a pure ref write with no
      // state change, its feedback text will silently go stale.
      //
      // TWO ACCEPTED EDGES (facts drive the ladder, by design):
      // - arm (empty, "to exit") then PASTE a draft within 1.5s: the
      //   second press clears instead of exiting - the cleared text is
      //   still in the clipboard, so nothing is actually lost.
      // - arm (draft, "to clear") then Ctrl+U kills the draft by hand:
      //   the second press falls to the exit branch - with nothing left
      //   to clear, the next rung owns the press (tmux/htop behave the
      //   same way).
      //
      // RUNG TWO/TREE, composed from two existing facts: armed x
      // hasDraft. No new counter, no new timer - clearing the draft
      // flips hasDraftRef to false, so the NEXT press naturally lands on
      // the exit branch: draft present -> x2 clears, x3 exits; empty ->
      // x2 exits, byte-identical to the previous behaviour.
      if (ctrlCArmed.current) {
        if (hasDraftRef.current) {
          setDraftClearNonce(value => value + 1);
          setDraftClearedByCtrlC(true);
          // Stays armed and the 1500ms clock keeps running: the clear
          // rung must not re-arm the whole ladder (that would make
          // exiting a draft x4 presses).
          return;
        }
        doExit();
        return;
      }
      ctrlCArmed.current = true;
      // Gesture feedback follows its live state, without a second toast lifetime.
      setMetricsClock(value => value + 1);
      if (ctrlCTimer.current) clearTimeout(ctrlCTimer.current);
      ctrlCTimer.current = setTimeout(() => {
        ctrlCTimer.current = null;
        ctrlCArmed.current = false;
        setDraftClearedByCtrlC(false);
        setMetricsClock(value => value + 1);
      }, 1500);
      return;
    }

    if (key.ctrl && input.toLowerCase() === 'g') {
      if (tooSmall || stateRef.current.overlay) return;
      setStatusExpanded(value => !value);
      return;
    }
    // Ctrl+K: the Agent-kit picker (agent-model-kits D-15 / §4.7).
    //
    // NOT AN INPUT FRAME, unlike Ctrl+I below. Ctrl+I collides with the Tab byte,
    // so a stdin translator has to disambiguate it; 0x0B is unambiguous in every
    // encoding this app supports (utf8 byte, win32-input-mode's pass-through of
    // control chars, and CSI-u's `ctrlByte` fold), so the raw byte IS the key.
    //
    // `killToEnd` HAS MOVED TO Alt+K FIRST (keymap.ts): `PromptInput`'s
    // recognizer runs before its `key.ctrl` early-return, so leaving the old
    // binding would delete the draft in one listener while this one opened the
    // overlay. Two listeners both see the event; `return` only leaves one.
    const isCtrlK = (key.ctrl && (input === 'k' || input === 'K')) || input === '\x0b';
    if (isCtrlK) {
      if (tooSmall || stateRef.current.overlay) return;
      dispatch({ type: 'setOverlay', overlay: 'kit' });
      return;
    }
    // Ctrl+I arrives as INDEX_KEY_FRAME, never as key.ctrl + 'i': legacy
    // terminals encode it as the Tab byte and the stdin filter's translators
    // are the only layer that can tell them apart (see input/limits.ts).
    // Guarded exactly like Ctrl+G above it.
    if (input.includes(INDEX_KEY_FRAME)) {
      if (tooSmall || stateRef.current.overlay) return;
      requestIndexBuild();
      return;
    }
    // Ctrl+L: branch this session into a NEW terminal (tui-branch-terminal-
    // shortcut D-1 / D-2). Guarded exactly like Ctrl+G and Ctrl+I above it: an
    // overlay owns the keyboard, and on a too-small terminal the feedback has
    // nowhere to go. It has to sit BEFORE the `tooSmall` return below, because
    // after that line the transcript and overlay paging own every key - and
    // "the key did nothing" must stay distinguishable from "the key never
    // arrived".
    //
    // NO `isRunning()` GUARD, unlike Ctrl+I: branching mid-run is the most likely
    // moment to want it (D-22), and the command body is where running decides
    // that the success needs a second, durable channel.
    if (key.ctrl && (input === 'l' || input === 'L')) {
      if (tooSmall || stateRef.current.overlay) return;
      void executeSlashInput('/branch');
      return;
    }
    if (tooSmall) return;

    // R-P1-7: the overlay branch MUST come before the transcript scroll branch
    // and MUST return. `PgUp` used to fall through to `scrollBy()` while an
    // overlay was open. The stable viewport ignores inactive intents, but routing
    // must still give overlays exclusive ownership of their paging keys.
    if (stateRef.current.overlay) {
      const overlay = stateRef.current.overlay;
      // Modes A only. `model` / `confirm` manage their own keys; registering an
      // arrow handler for them would double every keypress (R-12).
      const controlled = overlay === 'help' || overlay === 'settings' || overlay === 'plan'
        || overlay === 'queue' || overlay === 'kit';
      if (key.pageUp) {
        if (controlled) setOverlayScroll((n) => Math.max(0, n - overlayPage));
        return;
      }
      if (key.pageDown) {
        if (controlled) setOverlayScroll((n) => n + overlayPage);
        return;
      }
      // `settings` keeps Up/Down for field movement — a high-frequency action
      // worth more than scrolling six fields (§4.9). `question` keeps them for
      // its option cursor, for the same reason; `plan` has no cursor of its own
      // and scrolls a line at a time.
      if ((overlay === 'help' || overlay === 'plan' || overlay === 'queue') && (key.upArrow || key.downArrow)) {
        setOverlayScroll((n) => Math.max(0, n + (key.upArrow ? -1 : 1)));
        return;
      }
    }

    // AFTER the overlay block, and with an EXPLICIT guard rather than relying on
    // ordering: that block only `return`s for the keys it recognizes, and
    // everything else falls through (AC-P2).
    //
    // TWO KEYS, ONE BRANCH (shift-tab-mode-toggle-still-dead-on-windows, C2).
    // `Ctrl+P` is not a Windows-only alias bolted on beside the real binding: it
    // is the rung that survives when `Shift+Tab` cannot be delivered at all, and
    // it shares this branch precisely so the two can never drift into different
    // behaviour. See `MODE_TOGGLE_KEYS` for why this key and not another.
    if ((key.tab && key.shift) || (key.ctrl && (input === 'p' || input === 'P'))) {
      if (stateRef.current.overlay) return;
      applyMode(nextMode(controller.getAgentMode()));
      return;
    }

    // Moved off Ctrl+L by D-1, because Ctrl+L is the branch key now.
    //
    // Ctrl+R, NOT Ctrl+Shift+L: legacy encodings deliver 0x0c for both, so a
    // Shift binding would exist only behind keyboard enhancement - exactly the
    // terminals least likely to need a recovery key. The overlay guard keeps the
    // settings screen's own Ctrl+R (Test connection) unambiguous.
    //
    // Writing \x1B[2J here would erase the screen and then leave it blank: Ink
    // sees no output change and skips the repaint (ink.js:132 +
    // log-update.js:13), possibly forever on an idle empty session. Bump the
    // nonce instead and let Ink redraw the frame normally (§4.13).
    if (key.ctrl && (input === 'r' || input === 'R')) {
      if (stateRef.current.overlay) return;
      setRedrawNonce((n) => n + 1);
      return;
    }

    // Native mode has no scrollable viewport: the terminal owns scrolling, so these
    // keys are left alone. An open overlay is application content and keeps them.
    if (!native || stateRef.current.overlay) {
      if (key.pageUp) {
        scrollBy('pageUp');
        return;
      }
      if (key.pageDown) {
        scrollBy('pageDown');
        return;
      }
      if (key.shift && key.upArrow) {
        scrollBy('lineUp');
        return;
      }
      if (key.shift && key.downArrow) {
        scrollBy('lineDown');
        return;
      }
    }

    if (key.ctrl && (input === 't' || input === 'T')) {
      const revealing = !stateRef.current.thinkingVisible;
      dispatch({ type: 'toggleThinking' });
      // Printed history never changes, so say what the toggle actually reaches.
      const scope = native ? ' Applies to new messages.' : '';
      if (!revealing) toast('info', `Thinking hidden.${scope}`);
      else toast('info', `Thinking shown.${scope}`);
      return;
    }

    if (key.ctrl && (input === 'o' || input === 'O')) {
      // `team` joins `tool` here (team-subagents §6.3): a dispatch card collapses
      // its per-agent summaries behind the same key, and `toggleExpand` is keyed
      // on entry id so it needs no change.
      // `compaction` joins `tool` and `team` here (context-auto-compaction §6.3 /
      // C-15 / P1-8). `expandedToolIds` is keyed by entry id so the STORAGE was
      // already generic — but both surfaces that CHOOSE a target filter by kind,
      // and without this the compaction card renders its own `ctrl+o to expand`
      // hint, the keystroke silently expands an older tool card instead, and
      // nothing errors. AC-21 is the assertion that the hint does not lie.
      // `service` joins the closed list (P1-3). Omitting it is not a missing
      // feature but an actively wrong one: `ServiceCard` draws its own
      // `ctrl+o log` hint, the keystroke would silently expand AN OLDER TOOL
      // CARD, and nothing would error. The terminal one-row record is skipped -
      // it has nothing to reveal, and expanding it would consume the press.
      //
      // TWO TIERS, AND THE ORDER IS THE WHOLE FIX (tui-final-reply-truncated-
      // unscrollable B1). The closed list above answers "which card is this key for",
      // and it must keep answering it EXACTLY as before: a settled answer is almost
      // always the newest entry, so adding `assistant` to THIS filter would take the
      // press away from the tool card the user just watched finish. Only when no card
      // is asking for the key does it fall through to the Agent's last answer - which
      // is the escape hatch `docs/plans/tui-full-height-live-region/spec.md` §13
      // (known limitation 2) already promised and never wired up.
      const entries = stateRef.current.entries;
      const card = [...entries]
        .reverse()
        .find(
          (e) =>
            // THE LIVE DISPATCH CARD IS NOT EXPANDABLE (tui-subagent-double-roster
            // A-2'): it is suppressed on screen, so expanding it would print a frozen
            // copy of a card that is still being rewritten. Once it settles it becomes
            // an ordinary history card and this key reaches it again.
            !isLiveTeamCard(e) &&
            (e.kind === 'tool' ||
              e.kind === 'team' ||
              e.kind === 'compaction' ||
              (e.kind === 'service' && !e.terminal)),
        );
      // NATIVE MODE ONLY. The fallback exists because native mode cannot scroll inside the
      // frame - the answer's head is reachable only if it is printed. Full-screen mode has a
      // viewport that already reaches it, and it has no `expanded` rendering for an answer,
      // so falling through there would consume the press and show nothing.
      const answer = card === undefined && native
        ? [...entries].reverse().find((e) => e.kind === 'assistant' && !e.streaming)
        : undefined;
      const last = card ?? answer;
      // Native mode cannot rewrite what is already printed, so it PRINTS an expanded
      // copy as a new block instead of toggling the old one (spec 4.7).
      if (last && native) {
        if (!scrollbackViewRef.current?.reprintExpanded(last.id)) toast('info', 'Nothing to expand.');
      } else if (last) dispatch({ type: 'toggleExpand', id: last.id });
      // WIDENED FROM `No tool output to expand.`: with three expandable kinds the
      // old wording would be wrong in two of the three empty cases.
      else toast('info', 'Nothing to expand.');
      return;
    }

    if (key.escape) {
      const overlay = stateRef.current.overlay;
      if (overlay === 'settings') return;
      if (overlay) {
        cancelConfirmation();
        if (overlay === 'confirm' && confirmRef.current) {
          confirmRef.current.resolve(false);
          setConfirmState(null);
        }
        // `App` owns Esc for both plan-mode overlays and they register no
        // handler of their own, so this is the only place a cancellation
        // reaches the waiting tool.
        if (overlay === 'question' || overlay === 'plan') cancelPendingHuman();
        setHumanRequest(null);
        dispatch({ type: 'setOverlay', overlay: null });
        return;
      }
      return;
    }
  });

  const handleComposerEscape = useCallback(() => {
    if (stateRef.current.overlay) return;
    if (controller.isCompactionBusy?.()) {
      controller.abort();
      return;
    }
    if (interactionPhase.current === 'idle') {
      if (followTimer.current) {
        cancelFollowThrough();
        dispatch({ type: 'pushToast', level: 'info', text: 'Auto-continue cancelled.' });
      }
      return;
    }
    const sequence = submissionSequence.current;
    const phase = interactionPhase.current;
    const next = advanceInterruptGesture(interruptGesture.current, performance.now());
    interruptGesture.current = next.state;
    if (next.action === 'hint') {
      if (interruptTimer.current) clearTimeout(interruptTimer.current);
      interruptTimer.current = setTimeout(() => {
        interruptTimer.current = null;
        if (interruptGesture.current.phase !== 'armed') return;
        interruptGesture.current = { phase: 'ready' };
        setMetricsClock(Date.now());
      }, INTERRUPT_CONFIRM_MS + 1);
      setMetricsClock(value => value + 1);
      return;
    }
    endReasonRef.current.aborted = true;
    dispatch({ type: 'abortMark' });
    if (next.action === 'force-stop' || phase === 'starting') {
      submissionSequence.current += 1;
      interactionPhase.current = 'idle';
      resetInterrupt();
      autoContinuationRef.current = false;
      metrics.current = freezeRunMetrics(metrics.current, Date.now());
      if (next.action === 'force-stop') controller.forceStop();
      else controller.abort();
      dispatch({ type: 'runEnd' });
      dispatch({ type: 'pushToast', level: 'warn', text:
        next.action === 'force-stop' ? 'Force-stopped.' : 'Pending run cancelled.' });
      return;
    }
    controller.abort();
    if (sequence === submissionSequence.current && interactionPhase.current === 'running') {
      setMetricsClock(value => value + 1);
    }
  }, [controller, cancelFollowThrough, resetInterrupt]);

  // --- Render ------------------------------------------------------------

  // `const modelInfo = controller.getModelInfo()` AND ITS `modelKnown` COMPANION
  // USED TO LIVE HERE (context-usage-gauge-accuracy §4.3). They fed the status
  // bar's `contextWindow` / `contextWindowKnown` props, which no longer exist:
  // the denominator and its trustworthiness are resolved inside `ContextMeter`,
  // which is what lets the user's `contextWindow` override reach the gauge at
  // all. Nothing else in this render read them.
  const overlay = state.overlay;
  const settingsDraft = useMemo(() => overlay === 'settings'
    ? controller.createModelSettingsDraft() : undefined, [controller, overlay]);
  // THE FILE'S BINDINGS, FOR THE KIT PICKER'S FIRST ROW (§4.6 / D-13). While a
  // session kit is held the live config mirrors the KIT (I-6), so `Current setup`
  // can only describe what choosing it restores by reading the file - one read per
  // opening, the same price `settingsDraft` one line up already pays.
  const kitDiskConfig = useMemo(() => overlay === 'kit'
    ? controller.createModelSettingsDraft().baseline : undefined, [controller, overlay]);
  // ONE PROBE PER APP (model-profile-connection-test 5 row 9): the port needs the
  // controller's provider registry, which the overlay has no business owning.
  // Built only while the settings overlay is open, so no other screen pays for it.
  const probe = useMemo(() => {
    if (overlay !== 'settings') return undefined;
    // A test double or an embedded host may predate this port; absent means the
    // two probe rows read `(unavailable)` rather than the screen crashing.
    if (typeof controller.getProviderRegistry !== 'function') return undefined;
    return createModelProbe({ registry: controller.getProviderRegistry() });
  }, [controller, overlay]);
  const hasKey = controller.hasApiKey();
  // THE ACTIVE KIT, DERIVED PER FRAME (D-5 / F-22): `controller.getActiveKit()` is
  // pure, so it cannot go stale the way a cached copy would after `ctrl+K`,
  // `/model` or a saved default. Absent when no kit is in effect, which is what
  // keeps the status row byte-identical for users who own none (I-9).
  //
  // A TEST DOUBLE OR AN EMBEDDED HOST MAY PREDATE THIS PORT: the same tolerance
  // the probe port gets one screen over ("absent means the rows read
  // unresolved") applies here - no kit, no crash.
  const activeKit: ActiveKit = typeof controller.getActiveKit === 'function'
    ? controller.getActiveKit() : INACTIVE_KIT;
  const kitChip = activeKit.source === 'none' ? undefined : {
    name: activeKit.name,
    modified: activeKit.modified,
    otherNames: (cfg.modelProfiles?.kits ?? [])
      .filter((kit) => kit.id !== activeKit.id).map((kit) => kit.name),
  };
  const empty = state.entries.length === 0;
  // RENDER SCOPE, so the chip and the composer hint agree with what the Ctrl+C
  // handler will do on the very next keystroke.
  const liveServices = liveServiceCount(services);

  const projectedMetrics = projectRunMetrics(manualMetrics.current.startedAt !== null
    && state.status !== 'running' ? manualMetrics.current : metrics.current, Date.now());
  const { elapsedMs, tokPerSec, speedKnown } = projectedMetrics;

  // --- The activity line's seed (§3.2.3 / P1-7). --------------------------
  //
  // RENDER SCOPE. Without this the ref holds `0` on the first run (an arbitrary
  // word) and the PREVIOUS run's start on every run after, so every run opens on
  // a wrong phrase for one frame and then jumps — a flicker at the start of
  // every single turn, which is the one moment this feature exists to make feel
  // calm.
  const running = state.status === 'running';
  // The live compaction card's clock (hardening W5). While the run is going the
  // 200 ms elapsed ticker already causes the render that re-reads this; an IDLE
  // `/compact` has no ticker at all, which is what `compactionClock` is for.
  const compactionLive = state.compactionEntryId !== undefined;
  if (running && runStartedAt.current === 0) runStartedAt.current = Date.now();
  if (!running && runStartedAt.current !== 0) runStartedAt.current = 0;

  // --- The running tool (agent-activity-presentation-live §3.4 / L4). -----
  //
  // A REVERSE LOOP WITH AN EARLY EXIT, NOT `.filter(...).pop()` (P2-3).
  // `state.entries` is bounded by `transcriptRetain`, which DEFAULTS TO 1000,
  // and this runs in render scope at up to 30 fps — an allocating full scan
  // there is the exact cost `tui-render-performance` exists to remove. The
  // running tool, when there is one, is within a few entries of the end.
  let runningTool: string | undefined;
  // THE WAIT PROJECTION (long-task-jobs §4.9 / AC-28). Derived here, in the same
  // reverse loop, because both answers come from the same place: which tool is in
  // flight, and — when that tool is `job_wait` — which job it is waiting for and
  // for how long. The timeout is read from the CALL'S OWN ARGUMENTS rather than
  // from the config, so a `timeoutSeconds` the model chose is what the row says.
  let wait: { jobId: string; upToSeconds: number } | undefined;
  if (running) {
    for (let i = state.entries.length - 1; i >= 0; i -= 1) {
      const e = state.entries[i]!;
      if (e.kind === 'tool' && e.status === 'running') {
        runningTool = e.name;
        if (e.name === 'job_wait' && e.args) {
          const args = e.args as { job?: unknown; timeoutSeconds?: unknown };
          const requested = typeof args.timeoutSeconds === 'number'
            ? args.timeoutSeconds
            : cfg.jobs.waitSeconds;
          wait = {
            jobId: typeof args.job === 'string' ? args.job : 'job',
            upToSeconds: Math.max(0, Math.round(requested)),
          };
        }
        break;
      }
    }
  }

  // WALL-CLOCK SECONDS, and the 200 ms ticker above is what causes the render
  // that re-reads it — so no timer is added (D-36 / E-15). Seconds rather than
  // milliseconds because `ToolCard` is `React.memo`'d with the default
  // comparator; `Transcript` passes it on only to running tool entries.
  const nowSec = running || compactionLive ? Math.floor(Date.now() / 1000) : undefined;

  const frameBudget = buildFrameBudget({ rows, cols, draftRows,
    popupRows: overlay ? 0 : popupRows, statusExpanded });
  const viewportBudget = frameBudget.viewportRows;

  const composerBaseRows = 0;
  const baseRail = buildTodoRailLayout({
    cols: cols - 1, panelEnabled: cfg.todo.panel, overlayOpen: false,
    itemCount: state.todos?.items.length ?? 0, viewportBudget,
    teamRows: 0, popupRows: 0, composerBaseRows,
  });
  const queueLayout = useMemo(() => buildQueueLayout({
    pending: state.pendingSteering, columns: baseRail.contentCols, terminalRows: rows,
    availableRows: Math.max(0, viewportBudget - composerBaseRows - 1), paused: !running,
  }), [state.pendingSteering, baseRail.contentCols, rows, viewportBudget, composerBaseRows, running]);
  // THE POOL, NOT THE VIEWPORT MINUS A QUEUE THAT IS NOT DRAWN
  // (tui-full-height-live-region RV-P1-3). `QueuePanel` only mounts in the full-screen
  // layout, so native mode used to reserve rows for a card nobody paints. And it MUST be
  // `viewportBudget` rather than `nativeBudget.band.*`: `viewportRows === remaining` by
  // construction, and reading the band back here would close a loop with `teamRows`
  // (AC-34, asserted textually by `live-band.test.ts`).
  const teamLayout = buildTeamPanelLayout({
    snapshot: state.team, terminalRows: rows,
    availableRows: native
      ? Math.max(0, viewportBudget - 1)
      : Math.max(0, viewportBudget - composerBaseRows - queueLayout.rows - 1),
  });
  const railLayout = buildTodoRailLayout({
    cols: cols - 1, panelEnabled: cfg.todo.panel, overlayOpen: false,
    itemCount: state.todos?.items.length ?? 0, viewportBudget,
    teamRows: teamLayout.rowCount, queueRows: queueLayout.rows, popupRows: 0, composerBaseRows,
  });
  const { visible: railVisible, width: railWidth, rows: railRows, contentCols } = railLayout;
  // The FULL-SCREEN rail only: native mode draws its rail inside the live region's
  // panel band (`nativeRail` below), because there is no fixed frame to hang a column
  // on. This name says which of the two it is; the old `showRail` read like a global
  // switch and that is how native mode ended up with no rail at all.
  const fullscreenRailVisible = railVisible && !native;
  const transcriptEntries = useMemo(() => selectTranscriptEntries(state.entries,
    state.pendingSteering), [state.entries, state.pendingSteering]);

  // --- Native scroll (tui-native-terminal-scroll). -----------------------------
  //
  // ALWAYS CALLED, INERT WHEN `enabled` IS FALSE: hooks cannot be conditional, and
  // an inert hook is what keeps `scrollMode: 'app'` byte-identical (I-S9).
  const viewCols = native ? Math.max(1, cols - 1) : cols;
  const header = (
    <Header
      columns={viewCols}
      statusExpanded={statusExpanded}
      scrolledLines={scrolledLines}
      overlayOpen={overlay !== null}
      cwd={controller.getCwd()}
      provider={cfg.provider}
      model={cfg.model}
      hasKey={hasKey}
      variant={pickHeaderVariant(cols)}
      theme={theme}
      caps={caps}
      // ALWAYS TRUE (agent-model-kits §4.7 / RV-P1-2): the requirement is that
      // `ctrl+G` reveals `ctrl+K`, and the user with an empty library needs that
      // hint most - the picker itself carries the "create one in /settings" row.
      kitHint
    />
  );

  // The header and the opener are SLOTS OF THE SHELL, not printed bytes (D3/D4): at
  // `H = rows - 1` a printed row is pushed off the screen by the very next frame, so
  // `printBanner()` was a way of making the banner invisible. Neither is passed here.
  // The opener node is built below, because its height now comes from the native band.
  const scrollbackView = useScrollbackView({
    enabled: native, bridge: scrollback, entries: state.entries, runActive: running,
    theme, caps, density: cfg.density, thinkingVisible: state.thinkingVisible,
    reducedMotion, rows, cols,
    overlayOpen: overlay !== null, draftRows, popupRows: overlay ? 0 : popupRows,
    statusExpanded, forceInactive: native && guardTripped,
    // The band's inputs. `teamRowsNatural` is the roster layout computed above, so the
    // band clamps a number this frame already trusts instead of measuring the roster a
    // second time (`buildTeamPanelLayout` stays the single authority).
    itemCount: state.todos?.items.length ?? 0,
    panelEnabled: cfg.todo.panel,
    teamRowsNatural: teamLayout.rowCount,
    // The top give-way measures a window entry's height, and an expanded tool card is a
    // different height from a collapsed one - a forgotten value would print rows the region
    // is not drawing.
    expandedToolIds: state.expandedToolIds,
  });
  scrollbackViewRef.current = scrollbackView;
  // The two hooks `cli.tsx` calls from OUTSIDE React: the exit summary (every exit
  // path, some of which run after this tree is gone, so it reads refs, never state)
  // and the writer's tall-frame guard. A resize clears the degraded state.
  useLayoutEffect(() => {
    if (!native || !scrollback) return undefined;
    scrollback.getSummaryRows = () => {
      const live = controller.getConfig();
      return buildExitSummary({
        entries: stateRef.current.entries, usageTotal: stateRef.current.usageTotal,
        provider: live.provider, model: live.model, elapsedMs: Date.now() - startedAt.current,
        ...(identityRef.current ? { sessionId: identityRef.current.id } : {}), glyphs,
      });
    };
    scrollback.onGuardTrip = () => setGuardTripped(true);
    return () => { scrollback.onGuardTrip = null; };
  }, [native, scrollback, controller, glyphs]);
  useEffect(() => { setGuardTripped(false); }, [rows, cols]);
  const nativeBudget = native ? scrollbackView.budget : null;
  // THE EMPTY-SESSION CARD, ONE NODE FOR BOTH MODES (D4 / RV-P0-1). The wordmark and the
  // getting-started card are the first block of content in `app` mode (they scroll away
  // with the transcript) and the shell's `opener` slot in native mode. Its height used to
  // be a `rows - 8` guess in native mode; the honest input is the band's own pool, which
  // is why this node is built after `nativeBudget`.
  const openerRows = nativeBudget ? nativeBudget.band.bandRows : viewportBudget;
  const openerCols = nativeBudget ? nativeBudget.previewCols : contentCols;
  const opener = empty ? (
    <SessionOpener
      variant={pickOpenerVariant(openerRows, openerCols)}
      version={version}
      cwd={controller.getCwd()}
      hasKey={hasKey}
      viewportRows={openerRows}
      theme={theme}
      caps={caps}
    />
  ) : null;
  const overlayMaxRows = nativeBudget ? nativeBudget.overlayRows : viewportBudget;

  const overlayNode =
    overlay === 'queue' ? (
      <QueueOverlay pending={state.pendingSteering} cols={viewCols} maxRows={overlayMaxRows}
        scrollOffset={overlayScroll} onScrollClamp={setOverlayScroll} theme={theme} caps={caps} />
    ) : overlay === 'help' ? (
      <OverlayFrame
        title="Help"
        hint={`Esc close ${glyphs.midDot} PgUp/PgDn scroll`}
        maxRows={overlayMaxRows}
        cols={viewCols}
        rows={helpRows(theme, caps, native)}
        scrollOffset={overlayScroll}
        onScrollClamp={setOverlayScroll}
        theme={theme}
        caps={caps}
      />
    ) : overlay === 'model' ? (
      <ModelPicker
        isActive={!tooSmall}
        registry={controller.getModelRegistry()}
        currentProvider={cfg.provider}
        currentModel={cfg.model}
        maxRows={overlayMaxRows}
        cols={viewCols}
        theme={theme}
        caps={caps}
        onSelect={handleModelSelect}
      />
    ) : overlay === 'kit' ? (
      <KitPicker
        isActive={!tooSmall}
        library={cfg.modelProfiles}
        config={cfg}
        {...(kitDiskConfig ? { diskConfig: kitDiskConfig } : {})}
        active={activeKit}
        // ONLY THE APPLY IS BLOCKED while work is in flight (§4.7): a list a
        // user cannot even OPEN reads as a broken key.
        busy={controller.isModelSettingsBusy()}
        maxRows={overlayMaxRows}
        cols={viewCols}
        scrollOffset={overlayScroll}
        onScrollClamp={setOverlayScroll}
        theme={theme}
        caps={caps}
        onChoose={handleKitChoose}
        onClose={() => dispatch({ type: 'setOverlay', overlay: null })}
      />
    ) : overlay === 'settings' ? (
      <SettingsScreen
        isActive={!tooSmall}
        initial={{
          provider: cfg.provider,
          model: cfg.model,
          baseUrl: cfg.baseUrl ?? '',
          thinkingLevel: cfg.thinkingLevel,
          // SEEDED AND READ BACK, both halves (§4.3): omitting either is the
          // documented silent half of adding a row — the field renders empty and
          // an untouched save writes a value the user never chose.
          //
          // FROM `ViewState`, NOT FROM `cfg`. `thinkingVisible` is session state
          // that `Ctrl+T` also writes, and there is no controller setter to keep
          // `cfg` in step — so seeding from the config would show the LAUNCH
          // value under a transcript that has been toggled since, and an
          // untouched save would then quietly toggle it back.
          showThinking: state.thinkingVisible ? 'on' : 'off',
          // FROM `cfg`, unlike its neighbour, and the difference is real: the
          // live tail is decided at construction (the store is allocated there
          // and there is no setter), so the config IS the current value and
          // nothing can have toggled it since launch.
          liveToolOutput: cfg.liveToolOutput ? 'on' : 'off',
          // `auto`, not an empty string: an empty field reads as "unset", which
          // is indistinguishable from AUTO and is not a state this can be in.
          maxTokens: cfg.maxTokens ? String(cfg.maxTokens) : 'auto',
          // BOTH HALVES, seeded AND read back (§6.3): the sibling comment above
          // records what omitting either one costs. `auto` mirrors the row's
          // empty-field reading; a bound Main profile hides the row entirely
          // and the profile editor seeds from the entry instead.
          contextWindow: cfg.contextWindow === null ? 'auto' : String(cfg.contextWindow),
          apiKey: '',
          logLevel: cfg.log.level,
          // The four fast rows, seeded through the pure mapper so the screen and
          // the save handler cannot disagree about what `(inherit)` means.
          ...fastSettingsFrom(cfg.fast),
          ...compactionSettingsFrom(cfg.compaction),
        }}
        apiKeys={cfg.apiKeys}
        maxRows={overlayMaxRows}
        cols={viewCols}
        scrollOffset={overlayScroll}
        onScrollClamp={setOverlayScroll}
        theme={theme}
        caps={caps}
        draft={settingsDraft}
        probe={probe}
        onProfileSave={handleProfileSave}
        onReload={() => controller.createModelSettingsDraft()}
        onClose={() => dispatch({ type: 'setOverlay', overlay: null })}
        // Read from `cfg` (render scope, re-read every frame), so `/retry off`
        // while the screen is open shows the new value on the next paint.
        retrySummary={
          cfg.retry.enabled && cfg.retry.maxRetries > 0 ? String(cfg.retry.maxRetries) : 'off'
        }
      />
    ) : overlay === 'confirm' && confirmState ? (
      <ConfirmDialog
        isActive={!tooSmall}
        state={confirmState}
        maxRows={overlayMaxRows}
        cols={viewCols}
        theme={theme}
        caps={caps}
        onClose={closeConfirm}
      />
    ) : overlay === 'question' && humanRequest?.kind === 'questions' ? (
      <QuestionOverlay
        isActive={!tooSmall}
        questions={humanRequest.questions}
        maxRows={overlayMaxRows}
        cols={viewCols}
        theme={theme}
        caps={caps}
        onSubmit={(answers) => resolveHuman({ kind: 'answers', answers, cancelled: false })}
      />
    ) : overlay === 'plan' && humanRequest?.kind === 'plan' ? (
      <PlanReviewOverlay
        isActive={!tooSmall}
        plan={humanRequest.plan}
        maxRows={overlayMaxRows}
        cols={viewCols}
        scrollOffset={overlayScroll}
        onScrollClamp={setOverlayScroll}
        theme={theme}
        caps={caps}
        onVerdict={handlePlanVerdict}
      />
    ) : null;

  const density = cfg.density;
  const transcriptWindow = cfg.transcriptWindow ?? DEFAULT_TRANSCRIPT_WINDOW;

  // The fixed status bar remains visible underneath every overlay and toast.
  const viewReducedMotion = reducedMotion || running || state.runPhase === 'starting' || compactionLive;

  // Assigned during render so `/perf` reads the CURRENT frame (see `perfRef`).
  // `mountedEntries` is the same number `render-budget.test.tsx` asserts (AC-9).
  perfRef.current = {
    rung: governor.rung,
    intervalMs: governor.intervalMs.current,
    lastCommitMs: governor.lastCommitMs(),
    governorEnabled: cfg.renderGovernor,
    totalEntries: state.entries.length,
    retain: cfg.transcriptRetain ?? DEFAULT_TRANSCRIPT_RETAIN,
    droppedEntries: state.droppedEntries,
    mountedEntries: mountedCount.current,
    heightsMeasured: heights.stats().measured,
    heightsEstimated: heights.stats().estimated,
    cols: contentCols,
    mode: native ? 'native' : 'fullscreen',
    viewportRows: nativeBudget ? nativeBudget.liveRows : viewportBudget,
    offset: scrolledLines,
    // `null` outside native mode, and `/perf` prints `n/a` for it: a band row of
    // zeroes in full-screen mode would read like a panel that failed to show.
    band: nativeBudget
      ? {
          ...nativeBudget.band,
          contentCols: nativeBudget.contentCols,
          // The tail window, joined here because it belongs to the VIEW pipeline rather
          // than to the band: `window=<start>/<n>` is what makes the visible-vs-printed
          // gap observable (known limitation 5), and `head=` counts the rows the top
          // give-way printed for it, so the mechanism is never invisible.
          windowStart: scrollbackView.windowStart,
          windowEntries: scrollbackView.tailEntries.length,
          headRows: scrollbackView.headRows,
        }
      : null,
    // A getter: the bridge's `frameReady` and geometry change outside React renders.
    get scrollbar() {
      return readScrollbarPerf({
        bridge: terminal?.scrollbar, diffRender: cfg.diffRender, unicode: caps.unicode,
      });
    },
  };

  // Completion shares the fixed editor slot and its frame budget.
  //
  // THE FRAME BUDGET, NOT A LITERAL 6 (defect 10), BUT NOT ALL OF IT EITHER.
  // `popupMaxHeight` is the capacity `buildFrameBudget` already computed, and a
  // second, smaller constant here is what made 57 commands browsable six at a time
  // on a 30-row terminal. Handing over the WHOLE capacity is wrong in the other
  // direction: `popupCapacity` reserves exactly one message row, so at 20 rows it
  // grants 13, the transcript collapses to a single row and the TODO rail
  // disappears - measured, `todo-app-layout.test.tsx` catches it. Half the granted
  // capacity keeps the menu growing with the terminal (6 rows at 20, 11 at 30, 16
  // at 40) while the conversation and the rail keep theirs.
  const popupMaxRows = Math.floor(frameBudget.popupMaxHeight / POPUP_CAPACITY_SHARE);

  // WHICH KEY THE HINT ROW NAMES (shift-tab-mode-toggle-still-dead-on-windows,
  // C3-1). Derived from `vtInputWarning` rather than from a probe of its own,
  // because that prop is already the single answer to "can this console deliver
  // `CSI Z`?" — `cli.tsx` computes it AFTER trying to force the bit on, so a
  // machine we just repaired is told to press `shift+tab` and a machine we could
  // not repair is told to press the key that provably survives.
  //
  // Both keys always WORK (they share one branch in the input handler); this
  // only decides which one the user is taught.
  const modeToggleKey = vtInputWarning ? MODE_TOGGLE_KEYS.fallback : MODE_TOGGLE_KEYS.primary;

  const pendingCopy = copyFeedback.current;
  const copyResult = pendingCopy && state.toasts.some(item => pendingCopy.toastId
    ? item.id === pendingCopy.toastId
    : !pendingCopy.previousIds.has(item.id) && item.text === pendingCopy.result.text)
    ? pendingCopy.result : undefined;
  const latestToast = state.toasts.at(-1);
  const feedbackProjection = projectStatusFeedback({
    interactionPhase: interactionPhase.current, interruptPhase: interruptGesture.current.phase,
    completion, overlay, copyState, copyResult, ctrlCArmed: ctrlCArmed.current,
    // The flag, not the raw ref: the nonce render precedes the async
    // clear, so the ref alone would repeat the clear wording (see the
    // render-timing invariant beside the ladder).
    hasDraft: hasDraftRef.current && !draftClearedByCtrlC,
    selectionPending: selectionController?.hasPendingSelection() ?? false, liveServices,
    toast: latestToast ? { text: latestToast.text,
      level: latestToast.level === 'success' ? 'info' : latestToast.level } : undefined,
  });
  const statusInput: StatusPrimaryInput = {
    columns: viewCols, phase: state.runPhase, pendingCount: state.pendingSteering.length,
    context: state.context, usageTotal: state.usageTotal, thinkingLevel: cfg.thinkingLevel,
    elapsedMs, tokPerSec, speedKnown, activeTool: state.activeTool, runOutcome: state.runOutcome,
    // The bounded-wait label, when `job_wait` is what is holding the run. Absent
    // for every other tool, which keeps every existing plan byte-identical.
    ...(wait ? { wait } : {}),
    waitingForConfirmation: !!humanRequest || !!confirmState,
    stopping: interruptGesture.current.phase === 'stopping',
    interruptPhase: interruptGesture.current.phase,
    compacting: compactionLive || !!state.compaction?.inFlight,
    mode: state.agentMode, pendingMode: state.pendingAgentMode,
    servicesActive: { live: liveServices }, ecoRung: governor.rung,
    // THE STATUS-DETAIL ROW COUNTS LIKE THE ROSTER AND THE CHIP (A-1): this was the
    // last inline phase filter, left behind when the StatusBar chip converged, and it
    // feeds the `Team n/m` on the second status row.
    teamActive: state.team
      ? { running: rosterCounts(state.team.runs).running, total: state.team.runs.length }
      : undefined,
    todoActive: state.todos ? { done: state.todos.doneCount, total: state.todos.total } : undefined,
    fastActive: state.fast?.live ? { inFlight: state.fast.inFlight } : undefined,
    ...feedbackProjection,
  };
  const details = planStatusDetail({ status: statusInput, model: cfg.model, provider: cfg.provider,
    hints: { interactionPhase: interactionPhase.current, cols: viewCols, completion, overlay,
      selectionPending: selectionController?.hasPendingSelection() ?? false,
      copyInFlight: copyState.busy, copyCleanupPending: copyState.cleanupPending,
      hasDraft: hasDraftRef.current, services: liveServices,
      hintsEnabled: cfg.hints, modeToggleKey,
      interruptPhase: interruptGesture.current.phase,
      updateAvailable: !!updateSnapshot && shouldRenderUpdateLine(updateSnapshot) } });

  const composer = (
    <Composer
      deleteDisambiguated={terminal?.deleteDisambiguated ?? false}
      onCompletionContextChange={setCompletion}
      cols={frameBudget.composerCols}
      terminalRows={rows}
      statusExpanded={statusExpanded}
      onInteraction={returnToComposer}
      reducedMotion={cfg.reducedMotion ?? false}
      onEscape={handleComposerEscape}
      onEscapeDismiss={cancelConfirmation}
      isActive={overlay === null && !tooSmall}
      running={state.status === 'running'}
      history={promptHistory}
      commands={commandOptions}
      cwd={controller.getCwd()}
      showHint={false}
      submitCount={cfg.submitCount}
      hintsEnabled={cfg.hints}
      agentMode={state.agentMode}
      services={liveServices}
      modeToggleKey={modeToggleKey}
      popupMaxRows={popupMaxRows}
      popupMaxHeight={frameBudget.popupMaxHeight}
      onPopupRowsChange={onPopupRowsChange}
      onDraftRows={onDraftRows}
      onDraftPresence={onDraftPresence}
      draftClearNonce={draftClearNonce}
      onNotice={notify}
      theme={theme}
      caps={caps}
      onSubmit={handleSubmit}
      onHelp={() => dispatch({ type: 'setOverlay', overlay: 'help' })}
    />
  );

  const team = state.team ? (
          <TeamPanel
            snapshot={state.team}
            layout={teamLayout}
            rows={rows}
            cols={contentCols}
            reducedMotion={viewReducedMotion}
            theme={theme}
            caps={caps}
          />
        ) : null;

  // --- Native panel band (release-gate-and-native-panels §6.3/§6.4) -------------
  //
  // SEPARATE NODES, NOT THE TWO ABOVE (RV-P1-7). Those carry `cols={contentCols}` for
  // the full-screen layout, which has to stay byte-identical (I-3); reusing them here
  // would silently narrow it. Every number below comes from `budget.band`, and the
  // number that decides whether a panel mounts IS the number it lays out against - a
  // panel that mounts on one value and lays out against another renders nothing and
  // reports nothing (TodoPanel's own I-10 / P1-3 note).
  const nativeBand = nativeBudget ? nativeBudget.band : null;
  const nativeRail = state.todos && nativeBand && nativeBand.railRows >= TODO_LIMITS.panelMinRows
    ? (
      <TodoPanel
        snapshot={state.todos}
        width={nativeBand.railCols}
        rows={nativeBand.railRows}
        running={running}
        reducedMotion={viewReducedMotion}
        theme={theme}
        caps={caps}
      />
    ) : null;
  // `cols` is the band's left column, not `contentCols`: `TeamPanel.activityBudget` is
  // continuous in `cols`, so a roster laid out against a column it is not in is exactly
  // the bug that pushes the elapsed column off an 80-column terminal.
  const nativeTeam = state.team && nativeBand ? (
    <TeamPanel
      snapshot={state.team}
      layout={teamLayout}
      rows={rows}
      cols={nativeBand.previewCols}
      reducedMotion={viewReducedMotion}
      theme={theme}
      caps={caps}
    />
  ) : null;
  const rail = fullscreenRailVisible && state.todos ? (
          <TodoPanel
            snapshot={state.todos}
            width={railWidth}
            rows={railRows}
            running={running}
            reducedMotion={viewReducedMotion}
            theme={theme}
            caps={caps}
          />
        ) : null;

  const viewport = (
      <ScrollViewport
        active={overlay === null && !tooSmall}
        overlay={overlayNode}
        footer={<>{team}<QueuePanel layout={queueLayout} theme={theme} /></>}
        rail={rail}
        scrollbar={terminal?.scrollbar}
        resetKey={scrollResetKey}
        intent={scrollIntent}
        pinToBottomNonce={pinToBottomNonce}
        onScrolledLinesChange={setScrolledLines}
        onViewportShiftChange={onViewportShiftChange}
        onGeometryChange={onGeometryChange}
        geometryKey={`${rows}:${cols}:${viewportBudget}:${frameBudget.composerSlotRows}:${frameBudget.statusRows}:${contentCols}:${overlay}:${tooSmall}`}
        tailRowsRef={tailSink}
        hold={selectionHold}
        resumeMs={cfg.scrollResumeMs}
        showScrollIndicator
        cols={contentCols}
        theme={theme}
        caps={caps}
      >
        {opener}
        <TranscriptList
          entries={transcriptEntries}
          expandedToolIds={state.expandedToolIds}
          thinkingVisible={state.thinkingVisible}
          reducedMotion={viewReducedMotion}
          density={density}
          nowSec={nowSec}
          theme={theme}
          caps={caps}
          windowSize={transcriptWindow}
          cols={contentCols}
          heights={heights}
          mountedSink={mountedCount}
          tailSink={tailSink}
        />
      </ScrollViewport>
  );

  const detailsNode = <BottomStatusRow plan={details} columns={viewCols} theme={theme} />;
  const statusNode = (
    <StatusBar
          columns={viewCols}
          speedKnown={speedKnown}
          {...feedbackProjection}
          interruptPhase={interruptGesture.current.phase}
          pendingSteering={state.pendingSteering}
          runPhase={state.runPhase}
          activeTool={state.activeTool}
          {...(wait ? { wait } : {})}
          runOutcome={state.runOutcome}
          reducedMotion={reducedMotion}
          // AFTER the motion flag DELIBERATELY: `spinner-census.test.ts` pins
          // the `<StatusBar`-then-motion-flag adjacency as a unique site, so this
          // prop is inserted after it rather than before it.
          {...(sessionId ? { sessionId } : {})}
          // THE KIT CHIP (agent-model-kits D-12): present only while a kit is in
          // effect, so a user who owns none renders the row they always did (I-9).
          {...(kitChip ? { kit: kitChip } : {})}
          waitingForConfirmation={!!humanRequest || !!confirmState}
          stopping={interruptGesture.current.phase === 'stopping'}
          interruptHint={interruptGesture.current.phase === 'stopping'
            ? 'Esc force-stop' : 'Esc x2 interrupt'}
          model={cfg.model}
          provider={cfg.provider}
          usageTotal={state.usageTotal}
          // ONE OBJECT INSTEAD OF FOUR PARALLEL PROPS (§4.3). The four were a
          // projection of "many sources of truth" into the props layer, and a
          // caller could update three of them; a single reading cannot be
          // partially stale. The window and its `known` flag now travel INSIDE
          // it, resolved by the meter - which is what makes the user's
          // `contextWindow` override reach the bar.
          context={state.context}
          status={state.status}
          elapsedMs={elapsedMs}
          thinkingLevel={cfg.thinkingLevel}
          tokPerSec={tokPerSec}
          theme={theme}
          caps={caps}
          scrolledLines={scrolledLines}
          redrawNonce={redrawNonce}
          agentMode={state.agentMode}
          pendingAgentMode={state.pendingAgentMode}
          ecoRung={governor.rung}
          {...(state.team
            ? {
                // `rosterCounts`, NOT a fourth inline phase filter (A-1): the chip and
                // the roster header above it must never disagree.
                teamActive: {
                  running: rosterCounts(state.team.runs).running,
                  total: state.team.runs.length,
                },
              }
            : {})}
          // THE CHIP IS THE FALLBACK, NOT THE PANEL'S REPLACEMENT (RV-P2-4). In
          // native mode `fullscreenRailVisible` is always false, so keying off it
          // printed the same count twice the moment the band drew a rail; the question
          // is whether a rail was actually DRAWN (`band.railRows > 0`), which is also
          // the only reading under which "the status chip carries it" is true.
          {...(state.todos && !(native
            ? (nativeBudget?.band.railRows ?? 0) > 0
            : fullscreenRailVisible)
            ? { todoActive: { done: state.todos.doneCount, total: state.todos.total } }
            : {})}
          // `svc N` after the todo chip. It DEGRADES rather than hides below
          // `StatusBar`'s `PROC_LIMITS.statusCompactCols`, which is the `todoActive` ladder
          // rather than `compactionActive`'s hide-below-threshold one: a running
          // server is state the user must be able to see on a narrow terminal,
          // because it is a process on their machine holding a port.
          {...(liveServices > 0 ? { servicesActive: { live: liveServices } } : {})}
          // `state.fast.live` and not merely non-null: a tier that was registered
          // at launch and then switched off with `/fast off` must stop advertising
          // itself (fast-model-tier 3.3).
          //
          // A PLAIN JS COMMENT, not `{/* ... */}`: a JSX expression container is
          // only legal in CHILD position, and in an opening tag's attribute list it
          // is a parse error ("'...' expected") that takes the whole program down.
          {...(state.fast?.live ? { fastActive: { inFlight: state.fast.inFlight } } : {})}
          // Manual compaction starts before its next snapshot is published.
          compactionActive={{ inFlight: statusInput.compacting ?? false }}
          // THE GAUGE MARKS RIDE THEIR OWN CONDITION (P2-6 / RV-4). They used to
          // share the chip's `state.compaction?.live`, and `live` is
          // `enabled && summarizer !== null` - so a session whose summarizer
          // simply fails to resolve lost the correct colour thresholds as well,
          // and coloured by 60/85 while the trigger fired at 90.
          //
          // THE PREDICATE IS `isCompactionEnabled()`, NOT `isCompactionRegistered()`.
          // Colour answers "when will I be rescued", and that is decided by
          // CONFIG, not by whether a summarizer resolves this instant. But
          // `/compact off` means no rescue is coming, and colouring by the
          // compaction thresholds afterwards would be a promise the session
          // cannot keep; `isCompactionEnabled()` is false there and the bar
          // correctly falls back to `gauge.ts`'s 60/85, whose meaning is exactly
          // "nobody is coming".
          //
          // READING A NON-REACTIVE GETTER IN RENDER IS SAFE HERE because both
          // `setEnabled` and `onConfigChanged` emit a `snapshot`, which
          // dispatches and re-renders. A future start/stop path that emits NO
          // snapshot would freeze this colour; the fix then is an `enabled` field
          // on `CompactionSnapshot`, not a polling effect.
          {...(controller.isCompactionEnabled()
            ? {
                gaugeMarks: {
                  warn: cfg.compaction.warnThreshold * 100,
                  high: cfg.compaction.threshold * 100,
                },
              }
            : {})}
          {...(state.retry
            ? {
                retryActive: {
                  attempt: state.retry.attempt,
                  max: state.retry.maxRetries,
                  // Recomputed at RENDER from the absolute `resumeAt`, which is
                  // what keeps the chip and the transcript card showing the same
                  // number without either of them owning a second clock.
                  secondsLeft: secondsLeft(state.retry.resumeAt, Date.now()),
                },
              }
            : {})}
        />
  );

  if (nativeBudget) {
    // THE OPENER IS MOUNTED ON THE SHELL'S TOP-ALIGNED SLOT (D4 / RV-P0-1): it is sized
    // from the band's pool above, and bottom-aligning it would reproduce the reported
    // "blank upper half" INSIDE the region, where the canvas `gap` assertion cannot see it.
    return (
      <ScrollbackShell
        budget={nativeBudget}
        header={header}
        overlay={overlayNode}
        liveTailLines={scrollbackView.liveTailLines}
        {...(opener ? { opener } : {})}
        // Real components for the tail window (I-7); the plain rows above stay as the
        // fallback for a frame with no preview rows. The WHOLE list is passed: the window
        // belongs to `tail-window.ts`, and `prev` must come from the same list.
        tail={nativeBudget.band.previewRows > 0
          ? (
            <LiveTail
              entries={state.entries}
              maxEntries={SCROLLBACK_LIMITS.liveTailMaxEntries}
              rows={nativeBudget.band.previewRows}
              cols={nativeBudget.previewCols}
              expandedToolIds={state.expandedToolIds}
              thinkingVisible={state.thinkingVisible}
              reducedMotion={viewReducedMotion}
              density={cfg.density}
              nowSec={nowSec}
              theme={theme}
              caps={caps}
              measuredRows={scrollbackView.measuredTailRows}
            />
          )
          : undefined}
        team={nativeTeam}
        rail={nativeRail}
        composer={composer}
        status={statusNode}
        details={detailsNode}
        placeholder={<Text wrap="truncate" color={theme.noticeWarn}>
          {glyphs.warn} Terminal too small - needs at least 40 columns and 12 rows.
        </Text>}
        theme={theme}
      />
    );
  }

  return (
    <AppShell
      inactive={tooSmall}
      placeholder={<Text wrap="truncate" color={theme.noticeWarn}>
        {glyphs.warn} Terminal too small - needs at least 40 columns and 12 rows.
      </Text>}
      rows={rows}
      cols={cols}
      header={header}
      viewport={viewport}
      viewportRows={frameBudget.viewportRows}
      composer={composer}
      composerSlotRows={frameBudget.composerSlotRows}
      statusRows={frameBudget.statusRows}
      details={detailsNode}
      status={statusNode}
    />
  );
}
