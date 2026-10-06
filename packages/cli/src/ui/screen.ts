/**
 * Alternate screen buffer take-over (spec §4.4).
 *
 * Why the alt-screen and not a clear: `\x1b[3J` destroys the user's scrollback
 * (their build log, their stack trace) — an unacceptable side effect for a
 * developer tool. The alt-screen is non-destructive: the main buffer is covered,
 * not erased, and comes back untouched on exit. It also parks the cursor at
 * (1,1), which gives the frame accounting in §4.2 a deterministic origin.
 *
 * CALL SITE IS LOAD-BEARING: only `cli.tsx::runInteractive()` may call this.
 * Hoisting it into `buildProgram()` / `parseAsync` would push `\x1b[?1049h`
 * into `aragon -p "…" > out.txt`, `aragon config set`, and `aragon --version`.
 */

export interface ScreenHandle {
  /** Leave the alternate screen. Idempotent — safe from every exit path. */
  restore(): void;
  /**
   * Hand the mouse back to the terminal for this session, or take it again
   * (tui-selection-and-scroll-follow §4.4.6 / G3). A no-op when this session
   * never had a filter, and idempotent in both directions.
   *
   * This is the honest answer to "a user who wants their terminal's own
   * selection", and it is reversible in one command instead of a restart plus a
   * config edit (D-9).
   */
  setMouseCapture(on: boolean): void;
}

const ENTER_ALT = '\x1b[?1049h';
const LEAVE_ALT = '\x1b[?1049l';
const CURSOR_HOME = '\x1b[H';
const CLEAR_VISIBLE = '\x1b[2J';
/** Ink's log-update hides the cursor; a signal kill never gives it back. */
const SHOW_CURSOR = '\x1b[?25h';

/**
 * `?1000` is NORMAL TRACKING (press / release), the minimum mode that reports
 * wheel buttons; `?1006` selects SGR encoding so coordinates arrive as decimal
 * text rather than raw bytes above 0x7F that `setEncoding('utf8')` would mangle.
 *
 * `?1002` is BUTTON-EVENT TRACKING: motion is reported ONLY WHILE A BUTTON IS
 * HELD, which both scrollbar dragging and text selection need and costs exactly zero reports while the
 * pointer is idle. This comment used to lump it together with `?1003` and
 * dismiss both as "floods stdin on every pointer move" — true of `?1003`
 * (any-event), false of `?1002`, and the sentence had to go in the same commit
 * that started asking for it or it would stand as a documented reason not to
 * (AC-11 / D-10).
 *
 * Motion is enabled with mouse reporting, independently of text selection.
 * Disabling selection must still allow scrollbar gestures. The enable/disable
 * sequences remain paired for both values of this resolved capability.
 */
const enableMouse = (motion: boolean): string =>
  `\x1b[?1000h${motion ? '\x1b[?1002h' : ''}\x1b[?1006h`;
const disableMouse = (motion: boolean): string =>
  `\x1b[?1006l${motion ? '\x1b[?1002l' : ''}\x1b[?1000l`;

/**
 * Alternate scroll (DEC private mode 1007) is what turns a wheel notch into a
 * burst of arrow keys, which `PromptInput` reads as prompt-history recall. With
 * mouse reporting ON we do not touch it at all: 1007 is defined to translate
 * the wheel only while no application is tracking the mouse, so `?1000h`
 * already suppresses it and a second mutation of shared state buys nothing.
 *
 * With mouse reporting OFF we turn it off so the wheel is INERT rather than
 * destructive — the fallback rung of the fail-safe ladder. But 1007 is GLOBAL
 * TERMINAL STATE THIS APP DOES NOT OWN, so it is SAVED and RESTORED (XTSAVE /
 * XTRESTORE) rather than force-set on the way out: a user who deliberately
 * disabled alternate scroll in their terminal config must not have it switched
 * back on by running `aragon --no-mouse` once. A terminal implementing neither
 * sequence ignores both, so the fallback is no worse than writing nothing.
 */
const SAVE_ALT_SCROLL_OFF = '\x1b[?1007s\x1b[?1007l';
const RESTORE_ALT_SCROLL = '\x1b[?1007r';

/**
 * Bracketed paste (DEC private mode 2004) — the terminal wraps a paste in
 * `\x1b[200~` / `\x1b[201~`, which makes Tier 1 detection EXACT rather than a
 * heuristic on chunk shape (tui-paste-handling D-6 / L2).
 *
 * WHY THIS IS FORCED OFF ON EXIT RATHER THAN SAVED AND RESTORED (P1-8). DEC 1007
 * above is the same class of state — global, not ours — and gets the OPPOSITE
 * treatment, so the asymmetry has to be written down or the next reader will
 * "fix" the inconsistency:
 *
 *  - `\x1b[?2004r` on a terminal that does not implement XTSAVE is a NO-OP, which
 *    leaves 2004 ON. A shell that does not itself speak bracketed paste then
 *    shows a literal `[200~` on every paste until the user runs `reset` — the
 *    exact I-1 failure, arriving from the restore path.
 *  - Forcing `?2004l` has no such failure mode. Every shell that DOES use
 *    bracketed paste (bash >= 4.4 readline, zsh ZLE, fish, PSReadLine) re-arms it
 *    when it draws its next prompt, so the state the user sees after `aragon`
 *    exits is the state they had. Every shell that does not use it was already
 *    off.
 *
 * So: 1007 is saved because getting it wrong silently changes a preference; 2004
 * is forced because getting it wrong visibly breaks pasting, and the forced value
 * is the one every consumer re-establishes for itself.
 */
const ENABLE_BRACKETED_PASTE = '\x1b[?2004h';
const DISABLE_BRACKETED_PASTE = '\x1b[?2004l';

export interface AltScreenOptions {
  /**
   * TRUE MEANS "A MOUSE FILTER IS ALREADY INSTALLED", NOT "THE USER WANTS MOUSE
   * SUPPORT" (invariant I-8).
   *
   * This module must never derive the value from config, env or platform.
   * Enabling reporting without a filter in front of Ink does not degrade the
   * feature — it types `[<0;12;5M` into the user's message on every click and
   * every notch, which is strictly worse than the bug the feature fixes. The
   * only caller is `cli.tsx::runInteractive`, and it passes `filter !== null`.
   */
  readonly mouse: boolean;
  /**
   * Whether to request motion reporting (`?1002h`) alongside the two modes
   * above — i.e. whether drag-select is on for this session.
   *
   * SAME "ALREADY DECIDED ELSEWHERE" DISCIPLINE AS `mouse`: this module must
   * never derive it from config. `cli.tsx` passes
   * `mouseOn`, after the filter and VT capability have been resolved.
   *
   * Optional, defaulting to `false`, so every pre-existing caller and every
   * pre-existing test emits exactly the bytes it emitted before (AC-8 / T-34).
   */
  readonly motion?: boolean;
  /**
   * TRUE MEANS "A FILTER THAT CONSUMES `\x1b[200~` IS ALREADY INSTALLED", NOT
   * "the user wants paste support" — the same discipline `mouse` carries (I-1 /
   * I-8).
   *
   * Enabling DEC 2004 without a filter in front of Ink does not degrade the
   * feature: it types `[200~` and `[201~` into the user's message on EVERY paste,
   * which is strictly worse than the bug being fixed. `cli.tsx` passes
   * `pasteOn && mode === 'fullscreen'`, and NOT `filter !== null && config.paste`
   * — after the gate widened, the handle no longer answers any question except
   * "is a stream wrapped?" (D-17 / I-11).
   *
   * Optional, defaulting to `false`, so every pre-existing caller and every
   * pre-existing assertion emits exactly the bytes it emitted before.
   */
  readonly bracketedPaste?: boolean;
}

const NOOP_HANDLE: ScreenHandle = { restore() {}, setMouseCapture() {} };

function safeWrite(stdout: NodeJS.WriteStream, data: string): void {
  try {
    stdout.write(data);
  } catch {
    // A closed/broken stdout must never turn into a crash on the exit path.
  }
}

/**
 * Enter the alternate screen. A non-TTY stdout is a hard no-op (tests, pipes,
 * CI) — writing screen-control sequences into a redirected file corrupts it.
 */
export function enterAltScreen(
  stdout: NodeJS.WriteStream | undefined,
  options: AltScreenOptions = { mouse: false },
): ScreenHandle {
  if (!stdout || !stdout.isTTY || typeof stdout.write !== 'function') return NOOP_HANDLE;

  const mouse = options.mouse === true;
  const motion = options.motion === true;
  const bracketedPaste = options.bracketedPaste === true;
  safeWrite(
    stdout,
    ENTER_ALT +
      CLEAR_VISIBLE +
      CURSOR_HOME +
      (mouse ? enableMouse(motion) : SAVE_ALT_SCROLL_OFF) +
      (bracketedPaste ? ENABLE_BRACKETED_PASTE : ''),
  );

  /**
   * THE CURRENT capture state, not the one the session started in (I-10).
   *
   * `restore()` used to close over the immutable `mouse` boolean. After
   * `/mouse` exists that boolean is no longer the truth, and the exit path is
   * the one place where being wrong leaves the user's shell broken until they
   * run `reset`.
   */
  let captured = mouse;
  /**
   * Whether OUR `XTSAVE` of DEC 1007 is outstanding.
   *
   * `XTSAVE` HAS ONE SLOT PER MODE, so the save and the restore must stay
   * STRICTLY PAIRED: an `off` that saved while our own disable was already in
   * effect would save OUR value, and the following restore would hand the user
   * back a preference that was never theirs — permanently.
   */
  let savedAltScroll = mouse ? false : true;

  const setMouseCapture = (on: boolean): void => {
    // IT MUST NOT TOUCH DEC 2004 (I-16 / P2-7). `/mouse off` releases the
    // pointer; it says nothing about pasting, and a user who turns the mouse off
    // mid-session to select text with their terminal must not silently lose Tier
    // 1 detection as well. The two modes are written by different call sites and
    // unwound by different flags in `restore()`.
    //
    // A session that never installed a filter has nothing to release, and
    // enabling reporting without one types `[<0;12;5M` into the user's message
    // on every click (I-8). It stays a no-op in both directions.
    if (!mouse || on === captured) return;
    captured = on;
    if (on) {
      // Alternate scroll goes back to the user's own preference BEFORE reporting
      // resumes, so the two never overlap in the "both disabled" state.
      safeWrite(stdout, (savedAltScroll ? RESTORE_ALT_SCROLL : '') + enableMouse(motion));
      savedAltScroll = false;
      return;
    }
    // DEC 1007 IS THE HALF THAT MUST NOT BE DROPPED (P1-1). With reporting off,
    // alternate scroll turns every wheel notch back into a burst of arrow keys,
    // which `PromptInput` reads as prompt-history recall — replacing the user's
    // draft with an old prompt. A `/mouse off` that wrote only the mouse
    // sequences would hand that defect back on request, in the one command whose
    // entire purpose is to make things better. Saved rather than force-set, so a
    // user who deliberately disabled alternate scroll keeps their choice.
    safeWrite(stdout, disableMouse(motion) + SAVE_ALT_SCROLL_OFF);
    savedAltScroll = true;
  };

  let restored = false;
  return {
    restore(): void {
      if (restored) return;
      restored = true;
      // Mouse reporting is disabled BEFORE leaving the alternate screen (I-2).
      // This handle is what all four exit paths converge on — `process.on
      // ('exit')`, the crash handler's `setScreenRestore`, the signal
      // terminator, and `waitUntilExit()` — which is why the sequences live
      // here and not in `App.tsx`, a component that is on none of them.
      // Leaving reporting on prints `[<0;12;5M` in the user's shell on every
      // click, forever, until they run `reset`.
      //
      // IT UNWINDS THE CURRENT STATE (I-10): `captured` and `savedAltScroll` are
      // read here rather than the startup `mouse` flag, so a session that ran
      // `/mouse off` exits with exactly one outstanding save restored and
      // nothing left reporting.
      //
      // DEC 2004 IS UNWOUND FROM THE STARTUP FLAG, not from a runtime one, and
      // that is deliberate: `setMouseCapture` never touches it (I-16), so this
      // session either enabled it at entry or never did.
      const tail =
        (captured ? disableMouse(motion) : '') +
        (bracketedPaste ? DISABLE_BRACKETED_PASTE : '') +
        (savedAltScroll ? RESTORE_ALT_SCROLL : '');
      safeWrite(stdout, tail + SHOW_CURSOR + LEAVE_ALT);
    },
    setMouseCapture,
  };
}

/**
 * Replay the session summary into the normal buffer after `restore()`, so the
 * conversation does not evaporate along with the alternate screen.
 */
export function writeExitTranscript(
  stdout: NodeJS.WriteStream | undefined,
  text: string,
): void {
  if (!stdout || typeof stdout.write !== 'function') return;
  if (text.length === 0) return;
  safeWrite(stdout, text.endsWith('\n') ? text : `${text}\n`);
}
