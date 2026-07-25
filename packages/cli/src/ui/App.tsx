/**
 * App — the root Ink component. Owns the view reducer, subscribes to the
 * controller's event stream (with a streaming coalescer), wires global
 * keybindings, routes slash commands, and renders the header / transcript /
 * input / toast stack / status bar / overlays.
 */

import React, { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import process from 'node:process';
import { Box, useApp, useInput, useStdout } from 'ink';
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
import { coerceMaxTokens, PROMPT_HISTORY_CAP, type PersistedConfig } from '../config/schema.js';
import { updatePersistedConfig } from '../config/store.js';
import { detectCapabilities, type TermCapabilities } from './capabilities.js';
import { getTheme } from './theme.js';
import { Header } from './Header.js';
import { Welcome } from './Welcome.js';
import { Transcript } from './Transcript.js';
import { PromptInput } from './PromptInput.js';
import { StatusBar } from './StatusBar.js';
import { ToastStack } from './ToastStack.js';
import { HelpOverlay } from './overlays/HelpOverlay.js';
import { ModelPicker } from './overlays/ModelPicker.js';
import { SettingsScreen, type SettingsValues } from './overlays/SettingsScreen.js';
import { ConfirmDialog, type ConfirmState } from './overlays/ConfirmDialog.js';
import { CommandRegistry, runSlashInput, type CommandContext } from '../commands/registry.js';
import { registerBuiltinCommands } from '../commands/builtins.js';

export interface ConfirmBridge {
  handler: ((req: ConfirmRequest) => Promise<boolean>) | null;
}

export interface AppProps {
  controller: AgentController;
  version: string;
  initialOverlay?: Overlay;
  initialPrompt?: string;
  confirmBridge?: ConfirmBridge;
}

/** Merge pending delta actions ~33 ms and flush the coalescer buffer. */
const COALESCE_MS = 33;

export function App({
  controller,
  version,
  initialOverlay,
  initialPrompt,
  confirmBridge,
}: AppProps): React.ReactElement {
  const { exit } = useApp();
  const { stdout } = useStdout();

  const [state, dispatch] = useReducer(viewReducer, undefined, initialViewState);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [confirmState, setConfirmState] = useState<ConfirmState | null>(null);
  const [promptHistory, setPromptHistory] = useState<string[]>(
    () => controller.getConfig().promptHistory ?? [],
  );

  const cfg = controller.getConfig();
  const caps = useMemo<TermCapabilities>(() => {
    const detected = detectCapabilities(process.env, stdout);
    return {
      colorLevel: cfg.color === false ? 0 : cfg.colorLevel ?? detected.colorLevel,
      unicode: cfg.unicode ?? detected.unicode,
    };
  }, [cfg.color, cfg.colorLevel, cfg.unicode, stdout]);
  const theme = useMemo(() => getTheme(cfg.theme, caps), [cfg.theme, caps]);
  const reducedMotion = cfg.reducedMotion ?? false;

  const stateRef = useRef(state);
  stateRef.current = state;
  const confirmRef = useRef<ConfirmState | null>(null);
  confirmRef.current = confirmState;
  const ctrlCArmed = useRef(false);
  const ctrlCTimer = useRef<NodeJS.Timeout | null>(null);
  const runBaselineOut = useRef(0);
  const toastTimers = useRef<Map<string, NodeJS.Timeout>>(new Map());

  const registry = useMemo(() => {
    const r = new CommandRegistry();
    registerBuiltinCommands(r);
    return r;
  }, []);
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

  // --- Confirm bridge (confirmTools mode). -------------------------------
  useEffect(() => {
    if (!confirmBridge) return;
    confirmBridge.handler = (req: ConfirmRequest) =>
      new Promise<boolean>((resolve) => {
        setConfirmState({ summary: req.summary, resolve });
        dispatch({ type: 'setOverlay', overlay: 'confirm' });
      });
    return () => {
      confirmBridge.handler = null;
    };
  }, [confirmBridge]);

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
  });

  const recordPrompt = (text: string) => {
    const next = [...promptHistory.filter((p) => p !== text), text].slice(-PROMPT_HISTORY_CAP);
    setPromptHistory(next);
    persistConfig({ promptHistory: next });
  };

  const handleSubmit = async (raw: string) => {
    const handled = await runSlashInput(registry, raw, makeCtx);
    if (handled) return;

    const message = raw.startsWith('//') ? raw.slice(1) : raw;

    if (state.status === 'running') {
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

    if (key.ctrl && (input === 'l' || input === 'L')) {
      try {
        stdout.write('\x1B[2J\x1B[3J\x1B[H');
      } catch {
        /* ignore */
      }
      return;
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

  return (
    <Box flexDirection="column">
      {empty ? (
        <>
          <Header
            version={version}
            cwd={controller.getCwd()}
            provider={cfg.provider}
            model={cfg.model}
            hasKey={hasKey}
            compact={false}
            theme={theme}
            caps={caps}
          />
          <Welcome provider={cfg.provider} model={cfg.model} hasKey={hasKey} theme={theme} />
        </>
      ) : (
        <Header
          version={version}
          cwd={controller.getCwd()}
          provider={cfg.provider}
          model={cfg.model}
          hasKey={hasKey}
          compact
          theme={theme}
          caps={caps}
        />
      )}

      <Transcript
        entries={state.entries}
        expandedToolIds={state.expandedToolIds}
        thinkingVisible={state.thinkingVisible}
        reducedMotion={reducedMotion}
        theme={theme}
      />

      {overlay === 'help' && <HelpOverlay theme={theme} />}
      {overlay === 'model' && (
        <ModelPicker
          registry={controller.getModelRegistry()}
          currentProvider={cfg.provider}
          currentModel={cfg.model}
          theme={theme}
          onSelect={handleModelSelect}
        />
      )}
      {overlay === 'settings' && (
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
          theme={theme}
          onSave={handleSettingsSave}
        />
      )}
      {overlay === 'confirm' && confirmState && (
        <ConfirmDialog state={confirmState} theme={theme} onClose={closeConfirm} />
      )}

      <Box marginTop={1}>
        <PromptInput
          isActive={overlay === null}
          running={state.status === 'running'}
          history={promptHistory}
          commands={commandOptions}
          cwd={controller.getCwd()}
          theme={theme}
          onSubmit={(text) => void handleSubmit(text)}
          onHelp={() => dispatch({ type: 'setOverlay', overlay: 'help' })}
        />
      </Box>

      <ToastStack toasts={state.toasts} theme={theme} />

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
      />
    </Box>
  );
}
