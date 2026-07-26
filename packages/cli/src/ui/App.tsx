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
  type ToastLevel,
  type ViewAction,
} from '../agent/reducer.js';
import { mergeDeltas } from '../agent/coalesce.js';
import {
  coerceMaxTokens,
  DEFAULT_TRANSCRIPT_WINDOW,
  PROMPT_HISTORY_CAP,
  type PersistedConfig,
} from '../config/schema.js';
import { updatePersistedConfig } from '../config/store.js';
import { detectCapabilities, type TermCapabilities } from './capabilities.js';
import { getTheme } from './theme.js';
import { pickGlyphs } from './glyphs.js';
import { Header } from './Header.js';
import { pickHeaderVariant, pickOpenerVariant } from './Logo.js';
import { SessionOpener } from './SessionOpener.js';
import { Transcript, TranscriptList } from './Transcript.js';
import { PromptInput } from './PromptInput.js';
import { Composer } from './Composer.js';
import { StatusBar } from './StatusBar.js';
import { ToastStack } from './ToastStack.js';
import { AppShell } from './layout/AppShell.js';
import { ScrollViewport } from './layout/ScrollViewport.js';
import { useTerminalSize } from './layout/useTerminalSize.js';
import { frameHeight, MIN_FULLSCREEN_ROWS, type RenderMode } from './layout/frame.js';
import { HINT_MIN_ROWS, viewportRows as computeViewportRows } from './layout/budget.js';
import type { ScrollIntent } from './layout/scroll.js';
import { installConsoleBridge } from './console-bridge.js';
import { publishExitSnapshot } from './exit-snapshot.js';
import { OverlayFrame } from './layout/OverlayFrame.js';
import { helpRows } from './overlays/HelpOverlay.js';
import { ModelPicker } from './overlays/ModelPicker.js';
import { SettingsScreen, type SettingsValues } from './overlays/SettingsScreen.js';
import { ConfirmDialog, type ConfirmState } from './overlays/ConfirmDialog.js';
import { CommandRegistry, runSlashInput, type CommandContext } from '../commands/registry.js';
import { registerBuiltinCommands } from '../commands/builtins.js';
import { makeSkillsCommand, registerSkillCommands } from '../commands/skills.js';

export interface ConfirmBridge {
  handler: ((req: ConfirmRequest) => Promise<boolean>) | null;
}

export interface AppProps {
  controller: AgentController;
  version: string;
  /** Decided once in `cli.tsx::runInteractive()`; never switched at run time. */
  mode: RenderMode;
  initialOverlay?: Overlay;
  initialPrompt?: string;
  confirmBridge?: ConfirmBridge;
}

/** Merge pending delta actions ~33 ms and flush the coalescer buffer. */
const COALESCE_MS = 33;

/** Rows a PgUp/PgDn moves inside a controlled overlay. */
const OVERLAY_PAGE = 8;

export function App({
  controller,
  version,
  mode,
  initialOverlay,
  initialPrompt,
  confirmBridge,
}: AppProps): React.ReactElement {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const fullscreen = mode === 'fullscreen';
  const { rows, cols } = useTerminalSize();

  const [state, dispatch] = useReducer(viewReducer, undefined, initialViewState);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [confirmState, setConfirmState] = useState<ConfirmState | null>(null);
  const [promptHistory, setPromptHistory] = useState<string[]>(
    () => controller.getConfig().promptHistory ?? [],
  );
  // Scroll plumbing: intent goes down, one derived display number comes back.
  const [scrollIntent, setScrollIntent] = useState<{ kind: ScrollIntent; nonce: number }>();
  const [pinToBottomNonce, setPinToBottomNonce] = useState(0);
  const [scrolledLines, setScrolledLines] = useState(0);
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

  const cfg = controller.getConfig();
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
  const runBaselineOut = useRef(0);
  const toastTimers = useRef<Map<string, NodeJS.Timeout>>(new Map());

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

  useEffect(() => {
    const unsubscribe = controller.subscribe((event) => {
      const cost = controller.getModelInfo().cost;
      for (const action of reduceEvent(event, cost)) {
        if (action.type === 'textDelta' || action.type === 'thinkingDelta') {
          pending.current.push(action);
          if (!flushTimer.current) {
            flushTimer.current = setTimeout(() => flushPending(), COALESCE_MS);
          }
        } else {
          flushPending();
          dispatch(action);
        }
      }
    });
    return () => {
      flushPending();
      unsubscribe();
    };
  }, [controller, flushPending]);

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

  // --- Exit snapshot: the only way state reaches cli.tsx (§4.4). ----------
  useEffect(() => {
    publishExitSnapshot({
      entries: state.entries,
      usageTotal: state.usageTotal,
      provider: cfg.provider,
      model: cfg.model,
      startedAt: startedAt.current,
    });
  }, [state.entries, state.usageTotal, cfg.provider, cfg.model]);

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

  const persistConfig = (patch: Partial<PersistedConfig>) => {
    try {
      updatePersistedConfig(patch);
    } catch {
      // Best-effort: a failed persist should not break the live session.
    }
  };

  const doExit = () => {
    controller.abort();
    exit();
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
    submit: (text: string) => submitMessage(text),
    refreshSkills: () => setSkillsNonce((n) => n + 1),
  });

  const recordPrompt = (text: string) => {
    const next = [...promptHistory.filter((p) => p !== text), text].slice(-PROMPT_HISTORY_CAP);
    setPromptHistory(next);
    // The submit counter rides along with the history write rather than opening
    // a second I/O path (§4.6). It is read back through `controller.getConfig()`
    // and never enters React state — nothing re-renders on its account.
    const nextCount = (controller.getConfig().submitCount ?? 0) + 1;
    controller.setSubmitCount(nextCount);
    persistConfig({ promptHistory: next, submitCount: nextCount });
  };

  const scrollBy = useCallback((kind: ScrollIntent) => {
    setScrollIntent((prev) => ({ kind, nonce: (prev?.nonce ?? 0) + 1 }));
  }, []);

  /**
   * Send a message to the agent, bypassing slash parsing.
   *
   * Split out of `handleSubmit` so a dynamic skill command can submit the
   * expanded skill body on the user's behalf: routing that text back through
   * `handleSubmit` would re-parse it as input and, for a body that happens to
   * start with `/`, recurse into command dispatch.
   */
  const submitMessage = (message: string) => {
    if (stateRef.current.status === 'running') {
      controller.steer(message);
      toast('info', 'Steering queued.');
      return;
    }

    recordPrompt(message);
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

  const handleSubmit = async (raw: string) => {
    // Submitting is an unconditional "take me to the newest output" (§4.5).
    setPinToBottomNonce((n) => n + 1);
    const handled = await runSlashInput(registry, raw, makeCtx);
    if (handled) return;

    submitMessage(raw.startsWith('//') ? raw.slice(1) : raw);
  };

  const handleSettingsSave = (values: SettingsValues) => {
    const maxTokens = coerceMaxTokens(values.maxTokens);
    controller.setModel(values.provider, values.model, values.baseUrl || undefined);
    controller.setThinkingLevel(values.thinkingLevel);
    controller.setMaxTokens(maxTokens);
    const key = values.apiKey.trim();
    if (key.length > 0) controller.setApiKey(values.provider, key);

    const patch: Partial<PersistedConfig> = {
      provider: values.provider,
      model: values.model,
      baseUrl: values.baseUrl.trim() ? values.baseUrl.trim() : null,
      thinkingLevel: values.thinkingLevel,
      maxTokens: maxTokens ?? null,
    };
    if (key.length > 0) patch.apiKeys = { [values.provider]: key };
    persistConfig(patch);

    dispatch({ type: 'setOverlay', overlay: null });
    toast('success', 'Settings saved.');
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

  // A fresh overlay always opens at the top; carrying the previous overlay's
  // offset over would open Help mid-list for no reason the user can see.
  useEffect(() => {
    setOverlayScroll(0);
  }, [state.overlay]);

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
    if (key.ctrl && (input === 'c' || input === 'C')) {
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
      const controlled = overlay === 'help' || overlay === 'settings';
      if (key.pageUp) {
        if (controlled) setOverlayScroll((n) => Math.max(0, n - OVERLAY_PAGE));
        return;
      }
      if (key.pageDown) {
        if (controlled) setOverlayScroll((n) => n + OVERLAY_PAGE);
        return;
      }
      // `settings` keeps Up/Down for field movement — a high-frequency action
      // worth more than scrolling six fields (§4.9).
      if (overlay === 'help' && (key.upArrow || key.downArrow)) {
        setOverlayScroll((n) => Math.max(0, n + (key.upArrow ? -1 : 1)));
        return;
      }
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
      dispatch({ type: 'toggleThinking' });
      return;
    }

    if (key.ctrl && (input === 'o' || input === 'O')) {
      const last = [...stateRef.current.entries].reverse().find((e) => e.kind === 'tool');
      if (last) dispatch({ type: 'toggleExpand', id: last.id });
      else toast('info', 'No tool output to expand.');
      return;
    }

    if (key.escape) {
      const overlay = stateRef.current.overlay;
      if (overlay) {
        if (overlay === 'confirm' && confirmRef.current) {
          confirmRef.current.resolve(false);
          setConfirmState(null);
        }
        dispatch({ type: 'setOverlay', overlay: null });
        return;
      }
      if (stateRef.current.status === 'running') {
        controller.abort();
        dispatch({ type: 'abortMark' });
        toast('info', 'Run aborted.');
      }
      return;
    }
  });

  // --- Render ------------------------------------------------------------

  const modelInfo = controller.getModelInfo();
  const modelKnown = !!controller.getModelRegistry().getModel(cfg.provider, cfg.model);
  const overlay = state.overlay;
  const hasKey = controller.hasApiKey();
  const empty = state.entries.length === 0;

  const tokPerSec =
    state.status === 'running' && elapsedMs > 500
      ? Math.max(
          0,
          Math.round((state.usageTotal.outputTokens - runBaselineOut.current) / (elapsedMs / 1000)),
        )
      : 0;

  // Row budget for the viewport and everything sized against it (§4.2a). The
  // inline path has no fixed frame, hence no height to fit into: `Infinity`
  // tells `OverlayFrame` to render everything and show no position indicator.
  const viewportBudget = computeViewportRows(rows);
  const overlayMaxRows = fullscreen ? viewportBudget : Number.POSITIVE_INFINITY;

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
          maxTokens: cfg.maxTokens ? String(cfg.maxTokens) : '',
          apiKey: '',
        }}
        apiKeys={cfg.apiKeys}
        maxRows={overlayMaxRows}
        cols={cols}
        scrollOffset={overlayScroll}
        onScrollClamp={setOverlayScroll}
        theme={theme}
        caps={caps}
        onSave={handleSettingsSave}
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
      variant={fullscreen ? pickOpenerVariant(viewportBudget, cols, caps) : 'none'}
      version={version}
      cwd={controller.getCwd()}
      hasKey={hasKey}
      viewportRows={fullscreen ? viewportBudget : Number.POSITIVE_INFINITY}
      theme={theme}
      caps={caps}
    />
  ) : null;

  const density = cfg.density;

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
        theme={theme}
        caps={caps}
      >
        {opener}
        <TranscriptList
          entries={state.entries}
          expandedToolIds={state.expandedToolIds}
          thinkingVisible={state.thinkingVisible}
          reducedMotion={reducedMotion}
          density={density}
          theme={theme}
          caps={caps}
          windowSize={cfg.transcriptWindow ?? DEFAULT_TRANSCRIPT_WINDOW}
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
        reducedMotion={reducedMotion}
        density={density}
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
      popupMaxRows={popupMaxRows}
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
      toast={<ToastStack toasts={state.toasts} theme={theme} mode={mode} />}
      composer={composer}
      status={
        <StatusBar
          model={cfg.model}
          provider={cfg.provider}
          usageTotal={state.usageTotal}
          contextTokens={state.contextTokens}
          contextWindow={modelInfo.contextWindow}
          contextWindowKnown={modelKnown}
          status={state.status}
          elapsedMs={elapsedMs}
          thinkingLevel={cfg.thinkingLevel}
          tokPerSec={tokPerSec}
          theme={theme}
          caps={caps}
          scrolledLines={scrolledLines}
          redrawNonce={redrawNonce}
        />
      }
    />
  );
}
