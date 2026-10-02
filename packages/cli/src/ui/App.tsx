/**
 * App — the root Ink component. Owns the view reducer, subscribes to the
 * controller's event stream (with a streaming coalescer), wires global
 * keybindings, routes slash commands, and renders the header / transcript /
 * input / toast stack / status bar / overlays.
 */

import React, { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import process from 'node:process';
import { Box, Text, useApp, useInput, useStdout } from 'ink';
import type { AgentController } from '../agent/controller.js';
import type { ConfirmRequest } from '../tools/index.js';
import {
  initialViewState,
  reduceEvent,
  viewReducer,
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
  setVtInputNoticeVersion,
} from '../config/ui-state.js';
import { getLogger } from '../logging/logger.js';
import { isTerminalStatus, type ServiceSnapshot } from '../proc/types.js';
import { registerSecret } from '../logging/secret-registry.js';
import { detectCapabilities, type TermCapabilities } from './capabilities.js';
import {
  useStartupNotices,
  MOUSE_NOTICE_VERSION,
  VT_INPUT_NOTICE_VERSION,
} from './use-startup-notices.js';
import { getTheme } from './theme.js';
import { pickGlyphs } from './glyphs.js';
import { Header } from './Header.js';
import { pickHeaderVariant, pickOpenerVariant } from './Logo.js';
import { SessionOpener } from './SessionOpener.js';
import { Transcript, TranscriptList } from './Transcript.js';
import { PromptInput } from './PromptInput.js';
import { Composer } from './Composer.js';
import { StatusBar } from './StatusBar.js';
import { secondsLeft } from '../agent/retry-view.js';
import { TeamPanel } from './TeamPanel.js';
import { TodoPanel } from './TodoPanel.js';
import { TodoStrip } from './TodoStrip.js';
import { ActivityLine, liveSpinner } from './ActivityLine.js';
import { BottomStatusRow } from './BottomStatusRow.js';
import { UpdateLine } from './UpdateLine.js';
// The updater's two PURE modules. `shouldRenderUpdateLine` decides the row's
// presence AT THE CALL SITE (C-15), and `UPDATE_LIMITS` owns the width
// threshold - both are values, and both are resolved here rather than inside
// `UpdateLine` so that component's only edge into `update/` stays erasable by
// tsc (cli-auto-update section 3.1 rule 1 / IF-1). Neither module opens a
// socket, spawns a process or creates a timer.
import { shouldRenderUpdateLine } from '../update/types.js';
import { UPDATE_LIMITS } from '../update/limits.js';
import type { UpdateBridge, UpdateSnapshot } from '../update/types.js';
import { AppShell } from './layout/AppShell.js';
import { ScrollViewport } from './layout/ScrollViewport.js';
import { buildTodoRailLayout } from './layout/todo-layout.js';
import { buildTeamPanelLayout } from './layout/team-panel.js';
import {
  advanceBudget,
  decideFollowThrough,
  emptyBudget,
  type FollowThroughBudget,
} from '../todo/follow-through.js';
import { useTerminalSize } from './layout/useTerminalSize.js';
import { useHeightStore } from './use-height-store.js';
import { useRenderGovernor } from './use-render-governor.js';
import { setPerfResetHook, setPerfSnapshotProvider, type PerfSnapshot } from '../commands/perf.js';
import { frameHeight, MIN_FULLSCREEN_ROWS, type RenderMode } from './layout/frame.js';
import { HINT_MIN_ROWS, viewportRows as computeViewportRows } from './layout/budget.js';
import type { ScrollIntent } from './layout/scroll.js';
import { OVERLAY_PAGE, useWheelRouting } from './use-wheel-routing.js';
import type { MouseSource } from '../input/stdin-filter.js';
import type { PasteBridge } from '../input/limits.js';
import { installConsoleBridge } from './console-bridge.js';
import { publishExitSnapshot } from './exit-snapshot.js';
import { OverlayFrame } from './layout/OverlayFrame.js';
import { helpRows } from './overlays/HelpOverlay.js';
import { ModelPicker } from './overlays/ModelPicker.js';
import {
  SettingsScreen,
  compactionSettingsFrom,
  fastSettingsFrom,
  readCompactionSettings,
  readFastSettings,
  type SettingsValues,
} from './overlays/SettingsScreen.js';
import { ConfirmDialog, type ConfirmState } from './overlays/ConfirmDialog.js';
import { QuestionOverlay } from './overlays/QuestionOverlay.js';
import { PlanReviewOverlay, type PlanVerdict } from './overlays/PlanReviewOverlay.js';
import { CommandRegistry, runSlashInput, type CommandContext } from '../commands/registry.js';
import { registerBuiltinCommands } from '../commands/builtins.js';
import { makeSkillsCommand, registerSkillCommands } from '../commands/skills.js';
import { MODE_LABEL, MODE_TOGGLE_KEYS, nextMode, type AgentMode } from '../agent/agent-mode.js';
import type { SelectionBridge } from './selection/selection-controller.js';
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

/**
 * How long rung two of the Esc ladder stays armed after rung one (§5.5).
 *
 * Four seconds: long enough that a user who watched the abort fail can react,
 * short enough that a stray Esc minutes later cannot force-stop a healthy run.
 * `runEnd` / `agent_end` disarm it too, so the window is an upper bound rather
 * than the only protection (R-9).
 */
const ESC_ARM_MS = 4000;

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
  mode: RenderMode;
  initialOverlay?: Overlay;
  initialPrompt?: string;
  confirmBridge?: ConfirmBridge;
  /** The plan-mode human channel; absent in tests that do not exercise it. */
  humanInputBridge?: HumanInputBridge;
  /** Wheel events, already stripped out of stdin. Absent whenever mouse support
   *  is off: inline mode, `--no-mouse`, a non-TTY, or a filter that failed to
   *  build (mouse-wheel-region-routing §4.2). */
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
  /**
   * The terminal-facing services `cli.tsx` owns and this component cannot build
   * (tui-selection-and-scroll-follow §4.4).
   *
   * ONE PROP RATHER THAN FOUR, and every FIELD of it is independently optional,
   * so `--no-mouse`, `--no-diff-render` and inline mode each drop exactly the
   * services they do not have. Absent altogether on a non-TTY and in every test
   * that does not exercise selection, which is what keeps those trees
   * byte-identical.
   */
  terminal?: TerminalBridge;
}

/**
 * Terminal-level services, almost all of which exist only in a full-screen TTY
 * session — `writeForeign` is the exception, because `/copy` is available in
 * inline mode too and OSC 52 is what makes it work over SSH (§4.4.5).
 *
 * `selection` is a LATE-BOUND BRIDGE for the reason `updateBridge` above is one:
 * the controller is constructed before `render()` and must not hold React state,
 * while the toast sink and the redraw nonce only exist once this component has
 * mounted. The effect below assigns both and clears them on unmount.
 */
export interface TerminalBridge {
  /** Whether drag-select is on for this session (`mouseSelect` + a filter). */
  mouseSelect: boolean;
  /** Release the mouse to the terminal, or take it back (`/mouse`, G3). */
  setMouseCapture?: (on: boolean) => void;
  /** Whether the mouse is captured right now — read at command time. */
  isMouseCaptured?: () => boolean;
  /**
   * Write bytes that are ours but are not a frame (OSC 52).
   *
   * IT MUST NOT BE `stdout.write` WITH THE DIFFER IN FRONT OF STDOUT (P1-6):
   * that goes through the frame-writer proxy, which does not recognise an OSC 52
   * chunk, counts it as a foreign write and prints `FRAME_FALLBACK_NOTICE` at
   * the user the first time they copy anything. Without a differ — inline mode,
   * `--no-diff-render` — stdout IS the real stream and `cli.tsx` supplies a
   * direct write instead.
   *
   * Absent only when there is no terminal to accept it at all. It is never a
   * function that writes nowhere: `copyText` reports `'osc52'` whenever its door
   * took the text, so a no-op door would make the toast name a mechanism that
   * was never attempted.
   */
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
function seedViewState(thinkingVisible: boolean): ReturnType<typeof initialViewState> {
  return initialViewState({ thinkingVisible });
}

export function App({
  controller,
  version,
  mode,
  initialOverlay,
  initialPrompt,
  confirmBridge,
  humanInputBridge,
  mouseSource,
  vtInputWarning,
  updateBridge,
  pasteBridge,
  terminal,
}: AppProps): React.ReactElement {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const fullscreen = mode === 'fullscreen';
  const { rows, cols } = useTerminalSize();

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
  const [state, dispatch] = useReducer(viewReducer, cfg.showThinking, seedViewState);
  const [elapsedMs, setElapsedMs] = useState(0);
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
  // Bumped whenever the installed skill set changes. The command registry and
  // the completion list are memoized against it, so a skill installed mid-session
  // gets its `/<name>` command and its autocomplete entry immediately.
  const [skillsNonce, setSkillsNonce] = useState(0);

  const caps = useMemo<TermCapabilities>(() => {
    const detected = detectCapabilities(process.env, stdout);
    return {
      colorLevel: cfg.color === false ? 0 : cfg.colorLevel ?? detected.colorLevel,
      unicode: cfg.unicode ?? detected.unicode,
    };
  }, [cfg.color, cfg.colorLevel, cfg.unicode, stdout]);
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
  /**
   * Rung two of Esc is armed (background-service-supervision §3.6).
   *
   * CLEARED BY `runEnd` / `agent_end` AS WELL AS BY ITS OWN TIMER, and both
   * halves matter: a healthy run that ended between the two presses must not be
   * force-stoppable retroactively, and in every healthy run the second press
   * lands on the idle branch and does nothing at all (R-9). Rung two only ever
   * fires while the run is STILL running after rung one - i.e. only when the
   * first press provably failed.
   */
  const escArmed = useRef(false);
  const escArmTimer = useRef<NodeJS.Timeout | null>(null);
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
  const runBaselineOut = useRef(0);
  /**
   * Epoch ms the current run began — the activity phrase's seed.
   *
   * ASSIGNED IN RENDER SCOPE, NOT IN THE ELAPSED EFFECT (P1-7). That effect runs
   * AFTER the render that first sees `status === 'running'`, so a ref it wrote
   * would be one frame late — and the first frame of a run is exactly when the
   * phrase is chosen. `Transcript.tsx` updates `highWater` / `prevLen` during
   * render for the same reason: a value derived from a transition is needed by
   * the very render that observes the transition.
   */
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

  /**
   * Disarm rung two of the Esc ladder.
   *
   * A `useCallback` so the event subscription's dependency list can name it, and
   * so it is one function rather than three copies of "clear the flag and the
   * timer" that can drift.
   */
  const disarmEsc = useCallback(() => {
    escArmed.current = false;
    if (escArmTimer.current) {
      clearTimeout(escArmTimer.current);
      escArmTimer.current = null;
    }
  }, []);

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
  const submitRef = useRef<(text: string, opts?: { userInitiated?: boolean }) => void>(() => {});

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
    // back out of the `idle` rung two just gave them, and stray entries would
    // append to a transcript they believe is finished.
    //
    // A LOCAL `let`, RE-READ RATHER THAN CAPTURED ONCE: the generation this
    // listener considers current advances with every submit, so a force-stop
    // makes stale events inert WITHOUT making the next run's events inert too.
    let generation = controller.runGeneration;
    const unsubscribe = controller.subscribe((event) => {
      if (controller.runGeneration !== generation) {
        // The engine is unwinding a force-stopped run. Adopt the new generation
        // only once it has finished doing so, so a late `agent_end` cannot be
        // mistaken for the next run's.
        if (event.type === 'agent_end') generation = controller.runGeneration;
        return;
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

      // RUNG TWO DISARMS WITH THE RUN (§3.6 / R-9). A healthy run that ended
      // between the two Esc presses must not be force-stoppable retroactively:
      // the second press then lands on the idle branch, which is what makes the
      // ladder free to take rather than a footgun.
      disarmEsc();

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
        // FROM THE CONTROLLER, NOT FROM `cfg` (P1-1). This effect's dependency
        // list never changes, so it closes over the `cfg` object from the render
        // in which it mounted — and `setTodoConfig` builds a NEW object, which
        // that closure will never see. `cfg.todo.followThrough` would therefore
        // be pinned to the launch value for the whole session and
        // `/todo follow auto` would report success and do nothing. Note the
        // asymmetry with `showStrip` further down, which is right to use `cfg`
        // because it runs in render scope where `cfg` is re-read every frame.
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
          if (controller.isRunning()) return;
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
          submitRef.current(decision.message, { userInitiated: false });
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
  }, [controller, patchSource, flushPending, cancelPendingHuman, cancelFollowThrough, disarmEsc]);

  // --- Background services (background-service-supervision §3.8). ---------
  //
  // A SEPARATE SUBSCRIPTION, not a branch in the one above: `ProcEvent` is
  // deliberately not a member of core's `AgentEvent` union (I-5 / D-1), so it
  // cannot arrive through `controller.subscribe`.
  //
  // TWO SINKS PER EVENT, and they are not redundant. `setServices` holds the
  // LIVE state the status chip, the composer hint and the Ctrl+C rung read;
  // `dispatch` writes the TRANSCRIPT, which records events about a service
  // rather than mirroring it (D-11). Feeding one from the other would make the
  // chip lie about a card that has already been printed into `<Static>`.
  //
  // NOT ROUTED THROUGH THE STREAMING COALESCER. `output` is already coalesced at
  // the SOURCE, inside the supervisor, because `/bg` and `bash_output` consume
  // the same event (§6); a second buffer here would only add latency.
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
          const fastTier = event.tier === 'fast' ? controller.getFastStatus().tier : null;
          const ref =
            fastTier && fastTier.ok
              ? fastTier.ref
              : { providerId: live.provider, modelId: live.model };
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
      // Nothing else disposes the runtime on an inline-mode exit or a crash
      // that unmounts the tree, and an orphaned child holds the event loop open
      // (R-15). `cli.tsx` calls this too; `dispose()` is idempotent.
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
          dispatch({
            type: 'compactionStart',
            index: event.index,
            trigger: event.trigger,
            model: event.model,
          });
          break;
        case 'compaction_end':
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
          const ref = controller.getCompactionSummarizerRef();
          const costDelta =
            snapshot.pricingUnknown || !ref
              ? 0
              : computeCost(event.usage, controller.getModelInfoFor(ref).cost);
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

  // --- Elapsed timer + tokens/sec baseline while running. ----------------
  useEffect(() => {
    if (state.status !== 'running') {
      setElapsedMs(0);
      return;
    }
    runBaselineOut.current = stateRef.current.usageTotal.outputTokens;
    const startedAt = Date.now();
    setElapsedMs(0);
    const id = setInterval(() => setElapsedMs(Date.now() - startedAt), 200);
    return () => clearInterval(id);
  }, [state.status]);

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
    },
    [],
  );

  // --- Console bridge (fullscreen only, I-4). ----------------------------
  // Ink's own patchConsole writes straight to stdout, which shifts the fixed
  // frame by a row and breaks its line accounting for good.
  useEffect(() => {
    if (!fullscreen) return undefined;
    return installConsoleBridge((level, text) => dispatch({ type: 'notice', level, text }));
  }, [fullscreen]);

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
    // Its own one-shot key, NOT `mouseNoticeSeen`: everyone this notice is for
    // has already run aragon at least once and already has that flag set. That
    // key is now a VERSION for the same reason, one turn later — the audience
    // for the text that finally names the fallback key is, again, exactly the
    // set of users who already have the old flag on disk.
    //
    // `fullscreen` goes with it because only half of the damage is mode-
    // independent: `Shift+Tab` is broken either way, but inline never asked for
    // wheel reports and does not own the scroll keys, so it must not be told
    // about either.
    vtInputWarning
      ? {
          nodeVersion: vtInputWarning.nodeVersion,
          fullscreen,
          onSeen: () => setVtInputNoticeVersion(VT_INPUT_NOTICE_VERSION),
        }
      : undefined,
  );

  // --- Exit snapshot: the only way state reaches cli.tsx (§4.4). ----------
  useEffect(() => {
    publishExitSnapshot({
      entries: state.entries,
      usageTotal: state.usageTotal,
      provider: cfg.provider,
      model: cfg.model,
      startedAt: startedAt.current,
      // Carried so the exit replay can say what the retain ring removed. A
      // transcript that silently omits entries is worse than one that names the
      // count (K-6).
      droppedEntries: state.droppedEntries,
    });
  }, [state.entries, state.usageTotal, state.droppedEntries, cfg.provider, cfg.model]);

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

  // --- The composer's height (tui-paste-handling section 5.5 / D-12). ------
  //
  // GROWTH IS IMMEDIATE, SHRINK IS DEFERRED BY ONE TICK (R-12). Growing late
  // overdraws the frame for a frame; shrinking early makes a `Backspace` that
  // crosses a wrap boundary bounce the whole transcript, and a run of deletions
  // bounce it repeatedly. Deferring coalesces the run into one move.
  //
  // The ref mirrors the state so the decision is made OUTSIDE the updater: React
  // may call an updater more than once, and scheduling a timer from inside one
  // would arm it twice.
  const [draftRows, setDraftRows] = useState(1);
  const [popupRows, setPopupRows] = useState(0);
  const onPopupRowsChange = useCallback((next: number) => {
    setPopupRows(previous => previous === next ? previous : next);
  }, []);
  const draftRowsRef = useRef(1);
  const shrinkTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onDraftRows = useCallback((next: number) => {
    const wanted = Math.max(1, next);
    if (shrinkTimer.current) {
      clearTimeout(shrinkTimer.current);
      shrinkTimer.current = null;
    }
    if (wanted === draftRowsRef.current) return;
    if (wanted > draftRowsRef.current) {
      draftRowsRef.current = wanted;
      setDraftRows(wanted);
      return;
    }
    shrinkTimer.current = setTimeout(() => {
      shrinkTimer.current = null;
      draftRowsRef.current = wanted;
      setDraftRows(wanted);
    }, 0);
  }, []);
  useEffect(
    () => () => {
      if (shrinkTimer.current) clearTimeout(shrinkTimer.current);
    },
    [],
  );

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
  useEffect(() => {
    if (!selectionBridge) return undefined;
    selectionBridge.onCopied = (via, lines, chars) => {
      // IT NAMES THE MECHANISM RATHER THAN CLAIMING SUCCESS (R-7). Neither OSC 52
      // nor a spawned `xclip` is detectable: tmux without `set -g set-clipboard
      // on` swallows the first silently, and the second is best-effort by
      // construction. A toast that said "copied successfully" would be guessing.
      const noun = lines === 1 ? 'line' : 'lines';
      if (via === 'none') {
        toast('warn', 'Nothing could be copied - no clipboard mechanism is available.');
        return;
      }
      const how = via === 'osc52' ? 'terminal clipboard' : 'system clipboard';
      toast('success', `Sent ${lines} ${noun} (${chars} chars) to the ${how}.`);
    };
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
    selectionController.setEnabled(state.overlay === null);
    selectionController.clear();
  }, [selectionController, state.overlay]);

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
    controller,
    state: stateRef.current,
    dispatch,
    setOverlay: (overlay) => dispatch({ type: 'setOverlay', overlay }),
    notify,
    toast,
    persistConfig,
    exit: doExit,
    submit: (text: string, opts?: { userInitiated?: boolean }) => submitMessage(text, opts),
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
  const submitMessage = (message: string, opts: { userInitiated?: boolean } = {}) => {
    // A USER MESSAGE IS A NEW INTENT AND OUTRANKS A QUEUED ONE (AC-19). First
    // line, before the steering branch: a message typed during the grace window
    // must be the one that runs, whichever branch it takes.
    cancelFollowThrough();

    if (stateRef.current.status === 'running') {
      controller.steer(message);
      toast('info', 'Steering queued.');
      return;
    }

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
      notify('error', pre.message ?? 'Configuration error.');
      dispatch({ type: 'runEnd' }); // reset status; nothing was started
      return;
    }
    // Fire-and-forget: events drive the UI. prompt() never rejects.
    void controller.prompt(message);
  };
  submitRef.current = submitMessage;

  const handleSubmit = async (raw: string) => {
    // Submitting is an unconditional "take me to the newest output" (§4.5).
    setPinToBottomNonce((n) => n + 1);
    const handled = await runSlashInput(registry, raw, makeCtx);
    if (handled) return;

    submitMessage(raw.startsWith('//') ? raw.slice(1) : raw);
  };

  const handleSettingsSave = (values: SettingsValues) => {
    // An unusable cap must NOT discard the rest of the form: the same Enter
    // press is often carrying a freshly pasted API key, and losing that to a
    // typo in an unrelated field is the worst outcome available here.
    const cap = resolveSettingsMaxTokens(values.maxTokens, controller.getConfig().maxTokens);
    controller.setModel(values.provider, values.model, values.baseUrl || undefined);
    controller.setThinkingLevel(values.thinkingLevel);
    controller.setMaxTokens(cap.applied);
    // THE SETTER AND THE PERSIST ARE BOTH REQUIRED, the pair `/todo panel`
    // documents: persisting alone reports success and changes nothing until the
    // next launch. `thinkingVisible` lives in `ViewState`, not in the config the
    // controller holds, so the live half is a dispatch rather than a setter —
    // and it is a no-op when the row already agrees with the current state.
    if ((values.showThinking === 'on') !== stateRef.current.thinkingVisible) {
      dispatch({ type: 'toggleThinking' });
    }
    const key = values.apiKey.trim();
    if (key.length > 0) {
      // Registration site 4 (§4.4.3), and the one that matters most: this is how
      // a key most often enters the process, and it happens long after
      // `installLogging()` ran. A startup snapshot would miss it entirely, and
      // the vendor regexes only cover keys that look like a vendor's.
      registerSecret(key);
      controller.setApiKey(values.provider, key);
    }

    const patch: Partial<PersistedConfig> = {
      provider: values.provider,
      model: values.model,
      baseUrl: values.baseUrl.trim() ? values.baseUrl.trim() : null,
      thinkingLevel: values.thinkingLevel,
      showThinking: values.showThinking === 'on',
      // PERSIST ONLY, with no paired live setter — the store is allocated in
      // `AgentController`'s constructor, so this row takes effect on the next
      // launch. That is what manual row 8 asks for, and it is why the seed above
      // reads `cfg` rather than `ViewState`.
      liveToolOutput: values.liveToolOutput === 'on',
      // Omitted entirely when the field was unusable, so the previous value
      // survives instead of being overwritten with a guess.
      ...(cap.persist !== 'skip' ? { maxTokens: cap.persist } : {}),
    };
    if (key.length > 0) patch.apiKeys = { [values.provider]: key };
    // A PARTIAL `log` section, safe only because `updatePersistedConfig` deep-
    // merges it — a shallow merge here would reset `redactSecrets` every time
    // someone touched the level.
    patch.log = { level: values.logLevel } as PersistedConfig['log'];

    // --- Fast tier (fast-model-tier §4.5) ---------------------------------
    //
    // THE SETTER AND THE PERSIST ARE BOTH REQUIRED, and this is the pair `/todo
    // panel` documents (P1-2): `App` reads `controller.getConfig()` at render
    // time, so persisting alone reports success and changes nothing until the
    // next launch, while the setter alone forgets by morning.
    //
    // `setFastConfig` also re-resolves the tier, which matters HERE more than
    // anywhere: this same Enter press may have changed the main provider, the
    // main model or the API key, and `fast.provider: ''` inherits from all
    // three (§3.2 rule 8 / RV-3).
    const fastPatch = readFastSettings(values);
    controller.setFastConfig(fastPatch);
    patch.fast = fastPatch as PersistedConfig['fast'];

    // --- Context compaction (context-auto-compaction §4.5) ------------------
    //
    // THE SAME SETTER-AND-PERSIST PAIR, and the same reason. `setCompactionConfig`
    // additionally re-emits the snapshot, which is what moves the status chip and
    // the gauge's marks without waiting for the next turn.
    //
    // `enabled` here flips the LIVE switch only. Whether the wiring exists at all
    // was decided at construction and cannot be undone in this session (§3.2), so
    // a user who turns it ON in a `--no-compaction` session gets the persisted
    // value for next launch and nothing this session — which is exactly what
    // `/compact on` reports in words.
    const compactionPatch = readCompactionSettings(values);
    controller.setCompactionConfig(compactionPatch);
    if (compactionPatch.enabled !== undefined) {
      controller.setCompactionEnabled(compactionPatch.enabled);
    }
    patch.compaction = compactionPatch as PersistedConfig['compaction'];

    persistConfig(patch);
    getLogger().reconfigure({ ...controller.getConfig().log, level: values.logLevel });

    dispatch({ type: 'setOverlay', overlay: null });
    toast(cap.toast?.[0] ?? 'success', cap.toast?.[1] ?? 'Settings saved.');
  };

  const handleModelSelect = (provider: string, model: string) => {
    controller.setModel(provider, model);
    persistConfig({ provider, model });
    dispatch({ type: 'setOverlay', overlay: null });
    toast('info', `Model set to ${provider}:${model}.`);
  };

  const closeConfirm = () => {
    setConfirmState(null);
    dispatch({ type: 'setOverlay', overlay: null });
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

  // --- Mouse wheel routing (wheel-scrolls-transcript-only §4.1). Table and
  // coalescer live in the hook (D-13); only the wiring it cannot own stays here.
  // Inline arrows are fine — the hook re-reads its options through a ref every
  // render. The `Math.max(0, …)` mirrors the keyboard branch below, and for the
  // same reason: `OverlayFrame` only ever reports a clamp DOWNWARD.
  const { clearCoalescer } = useWheelRouting({
    mouseSource,
    getOverlay: () => stateRef.current.overlay,
    onScroll: scrollBy,
    onOverlayScroll: (delta) => setOverlayScroll((n) => Math.max(0, n + delta)),
  });

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
    // I-9, the third clear trigger, and FIRST IN THE HANDLER so no `return`
    // below can skip it. Any key at all drops the selection: most of them move
    // the rows, and the ones that do not have still ended the gesture. It is
    // also the way out of a `hold` that lost its release (I-11), alongside the
    // watchdog.
    //
    // `Esc` IS DELIBERATELY NOT GIVEN A SECOND MEANING (§4.4.6). It aborts a
    // run, and an emergency exit is the last key that should silently absorb a
    // press; it clears the selection here like every other key and nothing more.
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
      if (ctrlCArmed.current) {
        doExit();
        return;
      }
      ctrlCArmed.current = true;
      toast('warn', 'Press Ctrl+C again to exit.');
      if (ctrlCTimer.current) clearTimeout(ctrlCTimer.current);
      ctrlCTimer.current = setTimeout(() => {
        ctrlCArmed.current = false;
      }, 1500);
      return;
    }

    // R-P1-7: the overlay branch MUST come before the transcript scroll branch
    // and MUST return. `PgUp` used to fall through to `scrollBy()` while an
    // overlay was open; `ScrollViewport` is unmounted then, but its
    // `useEffect([intentNonce])` fires once on REMOUNT, so the stale intent was
    // applied when the overlay closed and the transcript jumped a page on its
    // own. Even overlays that ignore the key must swallow it here.
    if (stateRef.current.overlay) {
      const overlay = stateRef.current.overlay;
      // Modes A only. `model` / `confirm` manage their own keys; registering an
      // arrow handler for them would double every keypress (R-12).
      const controlled = overlay === 'help' || overlay === 'settings' || overlay === 'plan';
      if (key.pageUp) {
        if (controlled) setOverlayScroll((n) => Math.max(0, n - OVERLAY_PAGE));
        return;
      }
      if (key.pageDown) {
        if (controlled) setOverlayScroll((n) => n + OVERLAY_PAGE);
        return;
      }
      // `settings` keeps Up/Down for field movement — a high-frequency action
      // worth more than scrolling six fields (§4.9). `question` keeps them for
      // its option cursor, for the same reason; `plan` has no cursor of its own
      // and scrolls a line at a time.
      if ((overlay === 'help' || overlay === 'plan') && (key.upArrow || key.downArrow)) {
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

    if (key.ctrl && (input === 'l' || input === 'L')) {
      if (fullscreen) {
        // Writing \x1B[2J here would erase the screen and then leave it blank:
        // Ink sees no output change and skips the repaint (ink.js:132 +
        // log-update.js:13), possibly forever on an idle empty session. Bump
        // the nonce instead and let Ink redraw the frame normally (§4.13).
        setRedrawNonce((n) => n + 1);
        return;
      }
      try {
        stdout.write('\x1B[2J\x1B[3J\x1B[H');
      } catch {
        /* ignore */
      }
      return;
    }

    if (fullscreen) {
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
      // THE ACK IS MODE-AWARE FOR THE SAME REASON THE MARKER IS (D-16 / P0-2).
      // Inline mode cannot repaint what `<Static>` has already printed, so the
      // toast says what it DID rather than what the user hoped. The hide
      // direction needs no qualifier: hiding applies to everything drawn from
      // here on, and nothing is claimed about scrollback either way.
      if (!revealing) toast('info', 'Thinking hidden.');
      else if (fullscreen) toast('info', 'Thinking shown.');
      else toast('info', 'Thinking shown for new output.');
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
      const last = [...stateRef.current.entries]
        .reverse()
        .find(
          (e) =>
            e.kind === 'tool' ||
            e.kind === 'team' ||
            e.kind === 'compaction' ||
            (e.kind === 'service' && !e.terminal),
        );
      if (last) dispatch({ type: 'toggleExpand', id: last.id });
      // WIDENED FROM `No tool output to expand.`: with three expandable kinds the
      // old wording would be wrong in two of the three empty cases.
      else toast('info', 'Nothing to expand.');
      return;
    }

    if (key.escape) {
      const overlay = stateRef.current.overlay;
      if (overlay) {
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
      if (stateRef.current.status === 'running') {
        // RUNG TWO (§3.6 / G3). The first press asked the engine to stop; if the
        // run is STILL running when the second arrives, that request provably
        // failed - so this one does not ask, it takes.
        //
        // THREE THINGS HAPPEN, AND THE THIRD IS THE BELT-AND-BRACES.
        // `controller.forceStop()` aborts, hard-kills every tracked foreground
        // `bash` child (which is what actually unblocks a wedged
        // `await tool.execute`) and bumps the run generation so the unwinding
        // engine can no longer move the view. The local `runEnd` is dispatched
        // UNCONDITIONALLY on top: even if the engine is blocked somewhere
        // nothing can reach, the view returns to `idle`, the composer is usable,
        // and the reducer releases every live tail. Making the view's usability
        // conditional on the engine recovering is what produced the reported
        // screenshot (D-6).
        //
        // AND THE NEXT MESSAGE MUST STILL WORK. `AgentController.prompt()` waits
        // a still-running engine out and never rejects (I-8) - without that,
        // "Esc, Esc, then type" would reach `Agent.prompt()`'s synchronous throw,
        // become an unhandled rejection, and EXIT THE PROCESS (P0-1).
        if (escArmed.current) {
          disarmEsc();
          controller.forceStop();
          endReasonRef.current.aborted = true;
          dispatch({ type: 'abortMark' });
          dispatch({ type: 'runEnd' });
          toast('warn', 'Force-stopped.');
          return;
        }
        controller.abort();
        // Next to `abortMark`, in the same callback, for the reason
        // `endReasonRef`'s own comment gives (C-11). D-5 turns this into
        // silence at `agent_end`: the user's Esc is the statement, and
        // restating what they interrupted is the CLI arguing.
        endReasonRef.current.aborted = true;
        dispatch({ type: 'abortMark' });
        escArmed.current = true;
        if (escArmTimer.current) clearTimeout(escArmTimer.current);
        escArmTimer.current = setTimeout(() => {
          escArmed.current = false;
          escArmTimer.current = null;
        }, ESC_ARM_MS);
        toast('info', 'Run aborted. Esc again to force-stop.');
        return;
      }
      // IDLE. Today this branch does nothing at all, which is what makes it free
      // to take (R-4). OVERLAY PRECEDENCE IS UNCHANGED AND DELIBERATE (P2-9):
      // the block above returns while an overlay is open, so with one open the
      // first Esc closes the overlay and the second cancels the continuation.
      // Reaching past it would make "close this dialog" silently also mean
      // "abandon the plan".
      if (followTimer.current) {
        cancelFollowThrough();
        toast('info', 'Auto-continue cancelled.');
      }
      return;
    }
  });

  // --- Render ------------------------------------------------------------

  // `const modelInfo = controller.getModelInfo()` AND ITS `modelKnown` COMPANION
  // USED TO LIVE HERE (context-usage-gauge-accuracy §4.3). They fed the status
  // bar's `contextWindow` / `contextWindowKnown` props, which no longer exist:
  // the denominator and its trustworthiness are resolved inside `ContextMeter`,
  // which is what lets the user's `contextWindow` override reach the gauge at
  // all. Nothing else in this render read them.
  const overlay = state.overlay;
  const hasKey = controller.hasApiKey();
  const empty = state.entries.length === 0;
  // RENDER SCOPE, so the chip and the composer hint agree with what the Ctrl+C
  // handler will do on the very next keystroke.
  const liveServices = liveServiceCount(services);

  const tokPerSec =
    state.status === 'running' && elapsedMs > 500
      ? Math.max(
          0,
          Math.round((state.usageTotal.outputTokens - runBaselineOut.current) / (elapsedMs / 1000)),
        )
      : 0;

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
  if (running) {
    for (let i = state.entries.length - 1; i >= 0; i -= 1) {
      const e = state.entries[i]!;
      if (e.kind === 'tool' && e.status === 'running') {
        runningTool = e.name;
        break;
      }
    }
  }

  // WALL-CLOCK SECONDS, and the 200 ms ticker above is what causes the render
  // that re-reads it — so no timer is added (D-36 / E-15). Seconds rather than
  // milliseconds because `ToolCard` is `React.memo`'d with the default
  // comparator; `Transcript` passes it on only to running tool entries.
  const nowSec = running || compactionLive ? Math.floor(Date.now() / 1000) : undefined;

  // Row budget for the viewport and everything sized against it (§4.2a). The
  // inline path has no fixed frame, hence no height to fit into: `Infinity`
  // tells `OverlayFrame` to render everything and show no position indicator.
  // `draftRows` is the number `PromptInput` just reported for the rows it is
  // ACTUALLY RENDERING (I-8). Defaulting it to 1 is what makes the inline path
  // and every test that never types byte-identical to before.
  const viewportBudget = computeViewportRows(rows, draftRows);
  const overlayMaxRows = fullscreen ? viewportBudget : Number.POSITIVE_INFINITY;

  // Renderers consume these same projections. Team capacity does not depend on
  // popup occupancy, so a menu cannot toggle the team's collapsed state.
  const teamLayout = buildTeamPanelLayout({
    snapshot: state.team, terminalRows: rows, availableRows: viewportBudget,
  });
  const railLayout = buildTodoRailLayout({
    mode, cols, panelEnabled: cfg.todo.panel, overlayOpen: overlay !== null,
    itemCount: state.todos?.items.length ?? 0, viewportBudget,
    teamRows: teamLayout.rowCount, popupRows,
  });
  // Every viewport consumer uses contentCols; header, composer, status and
  // overlays keep the full terminal width. Overlay visibility is in the gate.
  const { visible: showRail, width: railWidth, rows: railRows, contentCols } = railLayout;

  // The inline plan strip (todo-plan-followthrough §3.7 / W2).
  //
  // DELIBERATELY NOT `!showRail`, which is true for FOUR different reasons and
  // three of them mean "do not draw this". `cfg.todo.panel` is included because
  // `--no-todo-panel` means "keep the planning, drop the display" and a strip is
  // a display. Overlays are NOT consulted: inline mode's overlays are part of
  // the document flow, not a modal that owns the screen.
  //
  // `cfg` is the right read here and `controller.getTodoConfig()` would be
  // needless — this runs in RENDER scope, where `cfg` is re-read every frame.
  // The asymmetry with the `agent_end` handler above is the whole of P1-1.
  const showStrip = !fullscreen && cfg.todo.panel && state.todos !== null;

  const overlayNode =
    overlay === 'help' ? (
      <OverlayFrame
        title="Help"
        hint={`Esc close ${glyphs.midDot} PgUp/PgDn scroll`}
        maxRows={overlayMaxRows}
        cols={cols}
        rows={helpRows(theme, caps)}
        scrollOffset={overlayScroll}
        onScrollClamp={setOverlayScroll}
        theme={theme}
        caps={caps}
      />
    ) : overlay === 'model' ? (
      <ModelPicker
        registry={controller.getModelRegistry()}
        currentProvider={cfg.provider}
        currentModel={cfg.model}
        maxRows={overlayMaxRows}
        cols={cols}
        theme={theme}
        caps={caps}
        onSelect={handleModelSelect}
      />
    ) : overlay === 'settings' ? (
      <SettingsScreen
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
          apiKey: '',
          logLevel: cfg.log.level,
          // The four fast rows, seeded through the pure mapper so the screen and
          // the save handler cannot disagree about what `(inherit)` means.
          ...fastSettingsFrom(cfg.fast),
          ...compactionSettingsFrom(cfg.compaction),
        }}
        apiKeys={cfg.apiKeys}
        maxRows={overlayMaxRows}
        cols={cols}
        scrollOffset={overlayScroll}
        onScrollClamp={setOverlayScroll}
        theme={theme}
        caps={caps}
        onSave={handleSettingsSave}
        // Read from `cfg` (render scope, re-read every frame), so `/retry off`
        // while the screen is open shows the new value on the next paint.
        retrySummary={
          cfg.retry.enabled && cfg.retry.maxRetries > 0 ? String(cfg.retry.maxRetries) : 'off'
        }
      />
    ) : overlay === 'confirm' && confirmState ? (
      <ConfirmDialog
        state={confirmState}
        maxRows={overlayMaxRows}
        cols={cols}
        theme={theme}
        caps={caps}
        onClose={closeConfirm}
      />
    ) : overlay === 'question' && humanRequest?.kind === 'questions' ? (
      <QuestionOverlay
        questions={humanRequest.questions}
        maxRows={overlayMaxRows}
        cols={cols}
        theme={theme}
        caps={caps}
        onSubmit={(answers) => resolveHuman({ kind: 'answers', answers, cancelled: false })}
      />
    ) : overlay === 'plan' && humanRequest?.kind === 'plan' ? (
      <PlanReviewOverlay
        plan={humanRequest.plan}
        maxRows={overlayMaxRows}
        cols={cols}
        scrollOffset={overlayScroll}
        onScrollClamp={setOverlayScroll}
        theme={theme}
        caps={caps}
        onVerdict={handlePlanVerdict}
      />
    ) : null;

  // A resize can drop below the usable floor. Do NOT leave the alt-screen —
  // entering and leaving it on every drag is worse than a placeholder — and take
  // the height from `frameHeight()` like everything else, because this is the
  // one path that reaches rows < 12 and a hard-coded height here would land on
  // `outputHeight >= rows` exactly when the user is dragging the window (§4.11).
  if (fullscreen && rows < MIN_FULLSCREEN_ROWS) {
    return (
      <Box flexDirection="column" height={frameHeight(rows)} width={cols} overflow="hidden">
        <Text wrap="truncate" color={theme.noticeWarn}>
          {glyphs.warn} Terminal too small - needs at least {MIN_FULLSCREEN_ROWS} rows.
        </Text>
      </Box>
    );
  }

  // Full-screen: a constant one-row brand bar at every size, which is what makes
  // the viewport monotonic and the first submit jump-free (§4.2). Inline keeps
  // its v0.3.0 ternary and never calls `pickHeaderVariant`.
  const header = (
    <Header
      version={version}
      cwd={controller.getCwd()}
      provider={cfg.provider}
      model={cfg.model}
      hasKey={hasKey}
      variant={fullscreen ? pickHeaderVariant(cols) : empty ? 'banner' : 'bar'}
      theme={theme}
      caps={caps}
    />
  );

  // The wordmark + getting-started card now live INSIDE the viewport, as its
  // first block of content, so they scroll away instead of being yanked out of
  // the header the moment the first message lands.
  const opener = empty ? (
    <SessionOpener
      variant={fullscreen ? pickOpenerVariant(viewportBudget, contentCols, caps) : 'none'}
      version={version}
      cwd={controller.getCwd()}
      hasKey={hasKey}
      viewportRows={fullscreen ? viewportBudget : Number.POSITIVE_INFINITY}
      theme={theme}
      caps={caps}
    />
  ) : null;

  const density = cfg.density;
  const transcriptWindow = cfg.transcriptWindow ?? DEFAULT_TRANSCRIPT_WINDOW;

  // --- One spinner per run (single-spinner-while-running D-1 .. D-5). ------
  //
  // THE MOUNT CONDITION, NAMED ONCE AND USED TWICE (D-4). This const both gates
  // the `<ActivityLine>` element below and feeds the derivation on the next
  // line, so "the line is up" and "every other site is still" can never
  // disagree. Two copies of the same boolean expression is exactly how that
  // invariant becomes false in six months, silently and in only one branch.
  //
  // NOT `running` ALONE (D-3). While an overlay owns the screen the activity row
  // is suppressed, so keying suppression off `running` would leave the frame
  // with ZERO life signals: the bar shows state, this row shows life. Never
  // trade one duplicate for one absence.
  //
  // THE CLAIM ABOVE WAS ONCE FALSE, AND THAT WAS THE WHOLE OF
  // `activity-spinner-vanishes-behind-toast`. `BottomStatusRow` — not this const
  // — decides what the row actually shows, and a toast used to take the row
  // outright, so for its 2.5 s TTL this said "the line is up" while nothing was
  // mounted and all seven other sites sat still. The answer was NOT to enumerate
  // `&& !state.toasts.length` here (the next occupant reopens it, and the seven
  // sites animating out of phase is the defect this whole feature removed):
  // `BottomStatusRow` now carries the bare spinner alongside the toast, so the
  // signal is mounted exactly when this const is true and the claim holds by
  // construction.
  const activityVisible = running && !overlayNode;
  // The FOUR VIEW CONSUMERS (transcript x 2, team panel, todo panel) take this;
  // the activity line keeps the raw config flag (D-5), because it reads that
  // flag a second time to gate phrase rotation and the widened value would
  // freeze the phrase at the first word of every run.
  //
  // So below `App` the prop now means "this frame does not animate here" rather
  // than "the user asked for reduced motion". `cfg.reducedMotion` (`:279`) stays
  // the sole config source, and `spinner-census.test.ts` pins this wiring —
  // threading the raw flag into a fifth consumer is the one silent way back to
  // two spinners (R-2).
  const viewReducedMotion = reducedMotion || activityVisible;

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
    mode: fullscreen ? 'fullscreen' : 'inline',
    viewportRows: fullscreen ? viewportBudget : rows,
    offset: scrolledLines,
  };

  const viewport = fullscreen ? (
    overlayNode ? (
      <Box flexDirection="column" flexGrow={1} overflow="hidden">
        {overlayNode}
      </Box>
    ) : (
      <ScrollViewport
        intent={scrollIntent}
        pinToBottomNonce={pinToBottomNonce}
        onScrolledLinesChange={setScrolledLines}
        onViewportShiftChange={onViewportShiftChange}
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
          entries={state.entries}
          expandedToolIds={state.expandedToolIds}
          thinkingVisible={state.thinkingVisible}
          reducedMotion={viewReducedMotion}
          density={density}
          mode={mode}
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
    )
  ) : (
    <>
      {opener}
      <Transcript
        entries={state.entries}
        expandedToolIds={state.expandedToolIds}
        thinkingVisible={state.thinkingVisible}
        reducedMotion={viewReducedMotion}
        density={density}
        mode={mode}
        nowSec={nowSec}
        theme={theme}
        caps={caps}
      />
      {overlayNode}
    </>
  );

  // The completion popup lives inside the bottom chrome and can add up to 9
  // rows; unbounded, it pushes the status bar past the frame height where
  // `overflow: hidden` clips it away (R-14 / M-14). Cap it against the viewport.
  const popupMaxRows = fullscreen ? Math.max(1, viewportBudget - 4) : undefined;

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

  const composer = fullscreen ? (
    <Composer
      isActive={overlay === null}
      running={state.status === 'running'}
      history={promptHistory}
      commands={commandOptions}
      cwd={controller.getCwd()}
      showHint={rows >= HINT_MIN_ROWS}
      submitCount={cfg.submitCount}
      hintsEnabled={cfg.hints}
      agentMode={state.agentMode}
      services={liveServices}
      modeToggleKey={modeToggleKey}
      popupMaxRows={popupMaxRows}
      popupMaxHeight={railLayout.popupMaxHeight}
      onPopupRowsChange={onPopupRowsChange}
      scrolledLines={scrolledLines}
      onDraftRows={onDraftRows}
      onNotice={notify}
      theme={theme}
      caps={caps}
      onSubmit={(text) => void handleSubmit(text)}
      onHelp={() => dispatch({ type: 'setOverlay', overlay: 'help' })}
    />
  ) : (
    <Box marginTop={1}>
      <PromptInput
        isActive={overlay === null}
        running={state.status === 'running'}
        history={promptHistory}
        commands={commandOptions}
        cwd={controller.getCwd()}
        agentMode={state.agentMode}
        theme={theme}
        caps={caps}
        onSubmit={(text) => void handleSubmit(text)}
        onHelp={() => dispatch({ type: 'setOverlay', overlay: 'help' })}
      />
    </Box>
  );

  return (
    <AppShell
      mode={mode}
      rows={rows}
      cols={cols}
      header={header}
      viewport={viewport}
      team={
        state.team ? (
          <TeamPanel
            snapshot={state.team}
            layout={fullscreen ? teamLayout : undefined}
            rows={rows}
            cols={cols}
            reducedMotion={viewReducedMotion}
            theme={theme}
            caps={caps}
          />
        ) : null
      }
      rail={
        showRail && state.todos ? (
          <TodoPanel
            snapshot={state.todos}
            width={railWidth}
            rows={railRows}
            running={running}
            reducedMotion={viewReducedMotion}
            theme={theme}
            caps={caps}
          />
        ) : null
      }
      strip={
        showStrip && state.todos ? (
          <TodoStrip snapshot={state.todos} cols={cols} theme={theme} caps={caps} />
        ) : null
      }
      toast={
        <BottomStatusRow
          mode={mode}
          toasts={state.toasts}
          // `!overlayNode` suppresses the line while an overlay owns the screen:
          // the full-screen branch replaces the whole viewport with the overlay,
          // and a working line under a settings screen is noise attached to a
          // surface the run is not visible on. (Inline overlays are part of the
          // document flow, so there the suppression is conservative rather than
          // necessary — P2-5.)
          //
          // THE CONDITION IS `activityVisible`, THE SAME CONST THE SUPPRESSION
          // SIGNAL IS DERIVED FROM (D-4): inlining it here again is how the two
          // drift apart, and the drift is silent in whichever branch is not
          // edited.
          activity={
            activityVisible ? (
              <ActivityLine
                startedAt={runStartedAt.current}
                elapsedMs={elapsedMs}
                reducedMotion={reducedMotion}
                runningTool={runningTool}
                // THE ROW MUST NEVER SAY SOMETHING FALSE (§6.1). Compaction runs
                // BEFORE `turn_start`, so `status` is `'running'` with no tool in
                // flight — precisely the window in which the rotating phrase
                // would claim the model is thinking while it is actually waiting
                // on a 30k-token summarization.
                compacting={state.compaction?.inFlight === true}
                theme={theme}
                caps={caps}
              />
            ) : null
          }
          // THE FORM THE LIFE SIGNAL TAKES WHEN A TOAST HAS THE ROW
          // (`activity-spinner-vanishes-behind-toast`). Passed UNCONDITIONALLY:
          // `BottomStatusRow` reads it only when `activity` above is non-null,
          // so `activityVisible` stays the one mount condition and this cannot
          // become a second copy of it that drifts. `null` here means the
          // spinner would be static anyway (ASCII tier, or reduced motion), and
          // those builds must come out unchanged.
          activityGlyph={liveSpinner(reducedMotion, caps)}
          // PRESENCE IS DECIDED HERE, NOT BY `UpdateLine` RETURNING `null`
          // (C-15 / cli-auto-update P0-1 / D-19). `BottomStatusRow` tests this
          // prop for truthiness, and a React element is truthy however it
          // renders - so a component that rendered nothing would give the row
          // ZERO rows and silently unbalance the frame budget. Same rule the
          // activity line above follows with `running && !overlayNode`.
          //
          // `!overlayNode` for the same reason it appears there: the full-screen
          // branch replaces the whole viewport with the overlay, and an update
          // notice under a settings screen is noise attached to a surface it is
          // not visible on.
          update={
            updateSnapshot && !overlayNode && shouldRenderUpdateLine(updateSnapshot) ? (
              <UpdateLine
                snapshot={updateSnapshot}
                compact={cols < UPDATE_LIMITS.statusCompactCols}
                theme={theme}
                caps={caps}
              />
            ) : null
          }
          theme={theme}
        />
      }
      composer={composer}
      status={
        <StatusBar
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
                teamActive: {
                  running: state.team.runs.filter(
                    (r) => r.phase !== 'queued' && r.phase !== 'done' &&
                      r.phase !== 'failed' && r.phase !== 'aborted',
                  ).length,
                  total: state.team.runs.length,
                },
              }
            : {})}
          {...(state.todos && !showRail
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
          // `state.compaction.live` and not merely non-null, for the reason the
          // note above gives one chip over: a session that registered compaction
          // and then turned it off with `/compact off` must stop advertising it.
          //
          // THE GAUGE MARKS NO LONGER RIDE THIS CONDITION (P2-6 / RV-4). They
          // used to, and the spread just below is now their own; see the note
          // there for why colour answers a different question than the chip.
          {...(state.compaction?.live
            ? { compactionActive: { inFlight: state.compaction.inFlight } }
            : {})}
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
      }
    />
  );
}
