/**
 * The two things the user needs to be told about that happened BEFORE the frame
 * existed, and the one that can happen at any moment afterwards.
 *
 * Both arrive as toasts, and that is not a style choice: with the TUI mounted, a
 * toast is the only legal user-visible channel. Any direct write to stdout or
 * stderr shifts the fixed frame by a row and breaks its line accounting for good
 * (invariant I-4).
 *
 * Lives outside `App.tsx` because that file is already at its size ceiling, and
 * because these two effects share one job — surfacing a condition the user could
 * not otherwise see — rather than belonging to the view.
 */

import { useEffect, useRef } from 'react';
import { MODE_TOGGLE_KEYS } from '../agent/agent-mode.js';
import type { ViewAction } from '../agent/reducer.js';
import { readConfigFile } from '../config/store.js';
import { getMouseNoticeVersion, getVtInputNoticeVersion } from '../config/ui-state.js';
import { getLogger } from '../logging/logger.js';

/**
 * The revision of the mouse notice a user must have seen for it to stay quiet
 * (`state.json::mouseNoticeVersion`, `0` when absent).
 *
 * BUMP IT WHENEVER THE ADVICE CHANGES, never for a rewording that leaves the
 * recommended actions alone — the same rule `VT_INPUT_NOTICE_VERSION` below
 * carries, and for the same reason.
 *
 * `1` = the first text that names DRAG-SELECT and `/mouse`. `0` = the 0.6.2 text
 * that taught the Shift bypass, recorded back when this was a boolean.
 */
export const MOUSE_NOTICE_VERSION = 1;

/**
 * The one-shot mouse notice (tui-selection-and-scroll-follow §5.2 row 29).
 *
 * IT NO LONGER TEACHES THE SHIFT WORKAROUND. That text was a workaround told
 * once, in a line that scrolls away, naming a key that is not portable — Shift
 * on xterm / VTE / Windows Terminal, Fn on macOS Terminal, a preference
 * elsewhere — and it collided with our own Shift+wheel binding. The user report
 * this feature exists for is the evidence that it was not enough (D-1).
 *
 * TWO TEXTS, because a `mouseSelect: false` session must not be told about a
 * gesture that is not running — the same rule the vt-input notice follows below,
 * and the reason `MouseNoticeOptions` carries the flag rather than this module
 * re-deriving it.
 */
function mouseNoticeText(selectEnabled: boolean): string {
  if (!selectEnabled) {
    return (
      'Mouse wheel scrolls the transcript. Drag-select is off (mouseSelect); ' +
      '/mouse off hands the mouse back to your terminal for this session.'
    );
  }
  return (
    'Mouse wheel scrolls the transcript, and dragging selects text - releasing ' +
    'copies it. /mouse off hands the mouse back to your terminal for this session.'
  );
}

/**
 * The §5.1 notice (tui-render-performance). Shown once per run, and only when
 * the user's own `transcriptRetain` was below `transcriptWindow`.
 *
 * The raise itself is not negotiable — retaining fewer entries than the horizon
 * can scroll to makes part of that horizon permanently unreachable — but doing
 * it in silence would leave a user staring at a `/perf` line that disagrees with
 * the number in their own config file and no way to connect the two.
 */
function retainRaisedNotice(requested: number, resolved: number): string {
  return (
    `transcriptRetain ${requested} is below transcriptWindow ${resolved}; using ${resolved} ` +
    'so the whole scroll horizon stays reachable. Lower transcriptWindow too if you meant ' +
    'to cap memory.'
  );
}

/**
 * The revision of the text below that a user must have seen for this notice to
 * stay quiet (`state.json::vtInputNoticeVersion`, `0` when absent).
 *
 * BUMP IT WHENEVER THE ADVICE CHANGES, and never for a rewording that leaves
 * the recommended actions alone. The two failure modes sit on either side of
 * this constant: leaving it alone after changing what the user is told to press
 * makes the change inert for everyone who already ran the old build — which is
 * the entire affected population, since the notice only appears on machines
 * where the key has been broken all along — while dropping the gate altogether
 * turns a one-shot into a banner on every launch.
 *
 * `1` = the first text naming `MODE_TOGGLE_KEYS.fallback`. `0` = the 0.6.1 text
 * that offered only `/plan`, recorded back when this was a boolean.
 */
export const VT_INPUT_NOTICE_VERSION = 1;

export function vtInputDeadNotice(nodeVersion: string): string {
  const cause = `Node ${nodeVersion} on Windows does not turn on the console's VT input mode, so `;
  const cost =
    'it will not switch mode, and with the / palette or an @ popup open it completes that ' +
    'instead, overwriting your draft. ';
  const toggle = `Press ${MODE_TOGGLE_KEYS.fallback} to switch mode instead (or /plan)`;

  return (
    `${cause}two keys never arrive: the wheel sends nothing at all, and Shift+Tab arrives ` +
    `as a PLAIN TAB - ${cost}${toggle}, and Shift+Up / Shift+Down to scroll. ` +
    'Node 22.17.0+ (or 24.2.0+) restores both.'
  );
}

/**
 * `{ requested, resolved }` when the raise happened, `undefined` otherwise —
 * i.e. `cfg.transcriptRetainRequested` and `cfg.transcriptRetain`.
 */
export interface RetainNoticeOptions {
  requested: number;
  resolved: number;
}

export interface MouseNoticeOptions {
  /**
   * Whether reporting is ACTUALLY in effect: a filter was installed AND the
   * platform can deliver the reports it would filter. A user on a terminal
   * where R-1 fires must never be given advice about a mode that is not
   * running.
   *
   * THE TWO HALVES ARE NOT THE SAME CLAIM, and this comment used to define the
   * flag as only the first of them ("i.e. a filter was installed") — which is
   * how the second sentence came to be violated by an implementation that
   * satisfied the first. Constructing the filter proves nothing about whether
   * the terminal will ever send a report; on a Windows console without VT
   * input it succeeds and then sits in front of a stream no report can reach.
   * The caller now derives both from one expression (`cli.tsx::wantMouse`), so
   * re-deriving either one here would put them back out of step.
   */
  enabled: boolean;
  /**
   * Whether DRAG-SELECT is running too, i.e. the resolved `mouseSelect`.
   *
   * A SECOND FLAG RATHER THAN AN INFERENCE, for the reason the field above
   * records about its own two halves: "the mouse is captured" and "dragging
   * selects text" are not the same claim, and a session that turned drag-select
   * off must not be handed advice about a mode that is not running.
   */
  selectEnabled: boolean;
  /**
   * Record that `MOUSE_NOTICE_VERSION` was shown (`state.json`). Called once,
   * after dispatch — and it must write that constant, not `true`: the gate
   * compares against it, so a caller storing anything else either replays the
   * notice forever or silences a future revision of the text.
   */
  onSeen: () => void;
}

export interface VtInputNoticeOptions {
  /** `process.versions.node`, quoted back so the user can act on it. */
  nodeVersion: string;

  /**
   * Record that `VT_INPUT_NOTICE_VERSION` was shown (`state.json`). Called once,
   * after dispatch — and it must write that constant, not `true`: the gate
   * below compares against it, so a caller storing anything else either replays
   * the notice forever or silences a future revision of the text.
   */
  onSeen: () => void;
}

export function useStartupNotices(
  dispatch: (action: ViewAction) => void,
  mouseNotice?: MouseNoticeOptions,
  retainNotice?: RetainNoticeOptions,
  vtInputNotice?: VtInputNoticeOptions,
): void {
  // The sink gives up after repeated write failures (a read-only log directory,
  // a full disk). Silently logging nothing is exactly the state a user must not
  // discover later, from an empty file, while trying to explain a bug.
  useEffect(() => {
    getLogger().onFailure((reason) =>
      dispatch({ type: 'pushToast', level: 'warn', text: `Logging stopped: ${reason}` }),
    );
  }, [dispatch]);

  // `main()` already wrote this to stderr, but entering the alternate screen
  // wipes it — so full-screen users would be left with the very failure the
  // message exists to prevent: every setting back at its default, and nothing
  // anywhere connecting that to the comma they typed into config.json.
  useEffect(() => {
    const { parseError } = readConfigFile();
    if (!parseError) return;
    dispatch({
      type: 'pushToast',
      level: 'warn',
      text: `Using default settings: could not parse ${parseError}`,
    });
  }, [dispatch]);

  // A `notice`, not a toast: it lands in the transcript and scrolls away
  // instead of stealing a row. §6's argument against toasts is about per-notch
  // chatter and does not extend to a one-shot.
  const noticeRef = useRef(mouseNotice);
  noticeRef.current = mouseNotice;
  const mouseEnabled = mouseNotice?.enabled ?? false;
  const mouseSelectEnabled = mouseNotice?.selectEnabled ?? false;
  const mouseNoticeShown = useRef(false);
  useEffect(() => {
    if (!mouseEnabled || mouseNoticeShown.current) return;
    // A VERSION, NOT THE OLD BOOLEAN (P1-8 / AC-16). The audience for the
    // corrected text is exactly the set of users who already have
    // `mouseNoticeSeen: true` on disk from the text it replaces, so reading that
    // flag would make this change inert for everyone it is for.
    //
    // `>=`, not `!==`: a state file written by a NEWER build (a downgrade, or a
    // shared home directory) has already told this user everything below.
    if (getMouseNoticeVersion() >= MOUSE_NOTICE_VERSION) return;
    mouseNoticeShown.current = true;
    dispatch({ type: 'notice', level: 'info', text: mouseNoticeText(mouseSelectEnabled) });
    noticeRef.current?.onSeen();
  }, [mouseEnabled, mouseSelectEnabled, dispatch]);

  // The R-1 notice. `warn`, not `info`: unlike the one above it reports a
  // capability the user was promised and does not have, plus a key that is
  // actively editing their draft.
  //
  // DEPENDS ON THE SCALAR, never on the options object, for the reason spelled
  // out on the retain effect below — `App` builds that literal during render.
  // Its one-shot key is checked only AFTER the presence test, so a machine that
  // is not affected never touches `state.json` at all.
  //
  // `>=`, not `!==`: a state file written by a NEWER build (a downgrade, or a
  // shared home directory) has already told this user everything the text below
  // says, so re-showing it would be noise rather than news.
  const vtNoticeRef = useRef(vtInputNotice);
  vtNoticeRef.current = vtInputNotice;
  const vtNodeVersion = vtInputNotice?.nodeVersion;
  const vtNoticeShown = useRef(false);
  useEffect(() => {
    if (vtNodeVersion === undefined || vtNoticeShown.current) return;
    if (getVtInputNoticeVersion() >= VT_INPUT_NOTICE_VERSION) return;
    vtNoticeShown.current = true;
    dispatch({
      type: 'notice',
      level: 'warn',
      text: vtInputDeadNotice(vtNodeVersion),
    });
    vtNoticeRef.current?.onSeen();
  }, [vtNodeVersion, dispatch]);

  // A `warn` notice rather than a toast: it is about a value the user typed, so
  // it belongs in the transcript where it can be scrolled back to, not in a row
  // that expires. DEPENDS ON THE TWO SCALARS, never on the options object —
  // `App` builds that literal during render, and depending on it would re-run
  // this effect on every frame of the session.
  const retainRequested = retainNotice?.requested;
  const retainResolved = retainNotice?.resolved;
  const retainNoticeShown = useRef(false);
  useEffect(() => {
    if (retainRequested === undefined || retainResolved === undefined) return;
    if (retainNoticeShown.current) return;
    retainNoticeShown.current = true;
    dispatch({
      type: 'notice',
      level: 'warn',
      text: retainRaisedNotice(retainRequested, retainResolved),
    });
  }, [retainRequested, retainResolved, dispatch]);
}
