/**
 * Mouse-report parser (mouse-wheel-region-routing §5.1) — pure, stream-free.
 *
 * The alternate screen has no native scrollback, so every modern terminal turns
 * on DEC private mode 1007 (*alternate scroll*) and translates each wheel notch
 * into a burst of arrow keys. Arrow keys carry NO POINTER POSITION, which is
 * why region routing is impossible from that channel and why the CLI asks for
 * real SGR mouse reporting instead (`\x1b[?1000h\x1b[?1006h`).
 *
 * Asking for it is only half the job. Ink 5.2.1 has no mouse branch at all:
 * `parse-keypress.js` fails to match `\x1b[<64;40;12M`, `use-input.js` strips
 * the leading ESC, and `PromptInput`'s `isControlSeq` guard passes the
 * remainder (`[` is 0x5B, >= 0x20) straight into `insert()`. So an unfiltered
 * mouse report is not ignored — it is TYPED INTO THE USER'S MESSAGE. This
 * module exists so `stdin-mouse-filter.ts` can remove every byte of every
 * report before Ink ever sees the chunk (invariant I-1).
 *
 * Every mouse report is CONSUMED here whatever it turns out to be; what changed
 * with tui-selection-and-scroll-follow is that press / drag / release are now
 * EMITTED as well as consumed, so `SelectionController` can build a selection
 * out of them (§4.4.2). They were previously recognized and thrown away.
 */

export interface WheelEvent {
  readonly kind: 'wheel';
  readonly dir: 'up' | 'down';
  /** 1-based terminal column, as reported. */
  readonly x: number;
  /** 1-based terminal row, as reported. */
  readonly y: number;
  readonly shift: boolean;
  readonly alt: boolean;
  readonly ctrl: boolean;
}

export interface ButtonEvent {
  readonly kind: 'press' | 'drag' | 'release';
  /** 0 = left, 1 = middle, 2 = right. Never 3 — see `decodeReport`. */
  readonly button: 0 | 1 | 2;
  /** 1-based terminal column, as reported. */
  readonly x: number;
  /** 1-based terminal row, as reported. */
  readonly y: number;
  readonly shift: boolean;
  readonly alt: boolean;
  readonly ctrl: boolean;
}

export type MouseEvent = WheelEvent | ButtonEvent;

export interface MouseSplit {
  /** Mouse events, in arrival order. Unrecognized reports are dropped, not returned. */
  readonly events: MouseEvent[];
  /** Everything that was not a mouse report — forward this to Ink verbatim. */
  readonly text: string;
  /** Trailing strict prefix of a possible report; feed it back in with the next chunk. */
  readonly pending: string;
}

/**
 * Which wire encoding a report arrived in. It is a PARAMETER rather than a
 * remembered rule because the rule it expresses is invariant I-11 and the cost
 * of forgetting it is a permanently frozen viewport (see `decodeReport`).
 */
export type MouseEncoding = 'sgr' | 'x10';

/**
 * Ceiling on the held-back tail. A malformed sequence that looks like a prefix
 * forever must never be able to wedge input: past this length the tail is
 * flushed as ordinary text and parsing resumes from the next byte.
 */
export const MAX_PENDING_MOUSE_CHARS = 32;

const ESC = '\x1b';

/** `\x1b[<b;x;yM` (press) or `…m` (release) — the only form we request. */
const SGR_REPORT = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])/;
/** A strict prefix of an SGR report: `\x1b[<` plus digits and semicolons. */
const SGR_PREFIX = /^\x1b\[<[\d;]*$/;

/**
 * True when `s` is a PROPER prefix of a possible mouse report (never a full
 * one). Nothing a keyboard produces matches beyond `\x1b` and `\x1b[`, which is
 * why the filter's flush timer is a rare path rather than a latency tax on
 * typing: ordinary text and pasted blocks contain no `\x1b[<`.
 */
export function isMousePrefix(s: string): boolean {
  return /^\x1B(\[(<[\d;]*|M[\s\S]{0,2})?)?$/.test(s);
}

type Match =
  | { kind: 'complete'; length: number; event: MouseEvent | null }
  | { kind: 'partial' }
  | { kind: 'none' };

interface Modifiers {
  readonly shift: boolean;
  readonly alt: boolean;
  readonly ctrl: boolean;
}

function modifiers(b: number): Modifiers {
  return { shift: (b & 4) !== 0, alt: (b & 8) !== 0, ctrl: (b & 16) !== 0 };
}

/**
 * Decode one report, or `null` when it is a report we consume without acting on.
 *
 * THE ORDER OF THESE TESTS IS THE SPECIFICATION, not a presentation choice.
 * Button 66 (wheel-left) has `b & 1 === 0` and would decode as `'up'`, so the
 * horizontal test has to precede the direction decode; and `b & 32` (motion) has
 * to precede the `final` test, because a drag is reported with `M` exactly as a
 * press is.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * I-11 — BUTTON EVENTS COME FROM THE SGR PATH ONLY. X10 stays wheel-only, which
 * is exactly the contract it has today.
 *
 * `matchX10` reconstructs a legacy report and hard-codes `final = 'M'`, because
 * X10 HAS NO SEPARATE RELEASE FORM AT ALL — it encodes a release as button 3 of
 * a press. Fed through the table below, an X10 release would become a `press`
 * that is never followed by a `release`, whose `button` is 3 while the type says
 * `0 | 1 | 2`, and whose consequence is a `hold` that is set and never cleared:
 * content anchoring never lets go, the resume timer's third condition never
 * passes, and the transcript is frozen for the rest of the session with nothing
 * raised anywhere.
 *
 * This costs nothing real (D-16): we never REQUEST X10 — `?1006h` is over a
 * decade old and every terminal that implements `?1000` implements it — and a
 * terminal that ignored the SGR request also has no usable drag coordinates past
 * column 223 (R-2). X10 exists in this parser only so a stray report cannot
 * reach the user's draft.
 * ═══════════════════════════════════════════════════════════════════════════
 */
function decodeReport(
  b: number,
  x: number,
  y: number,
  final: string,
  encoding: MouseEncoding,
): MouseEvent | null {
  // 1. Wheel. Buttons 64-67 in both encodings.
  if ((b & 64) !== 0) {
    // Horizontal wheel (66 = left, 67 = right). Consumed and dropped (non-goal).
    if ((b & 3) >= 2) return null;
    // Wheel buttons are press-only; a terminal that ever sent a release for one
    // must not produce a second step for the same physical notch.
    if (final !== 'M') return null;
    return { kind: 'wheel', dir: (b & 1) === 1 ? 'down' : 'up', x, y, ...modifiers(b) };
  }

  if (encoding !== 'sgr') return null; // I-11

  // 2. Motion while a button is held (`?1002h`). `3` is "no button", which
  //    `?1002` should never send and `?1003` sends constantly — dropping it is
  //    what keeps an any-event terminal from painting a selection with no button
  //    down at all.
  if ((b & 32) !== 0) {
    const button = b & 3;
    if (button === 3) return null;
    return { kind: 'drag', button: button as 0 | 1 | 2, x, y, ...modifiers(b) };
  }

  // 3. Release. In SGR the final byte carries the transition, so this is
  //    unambiguous — unlike X10, which is why step 1's guard exists.
  //
  //    A release whose button field reads `3` is a terminal saying "some button
  //    came up" without naming it. It is mapped to button 0 rather than dropped:
  //    the ONE thing a release must always do is let go of `hold`, and dropping
  //    it would leave the viewport frozen — the exact failure I-11 is about. A
  //    spurious button-0 release is harmless, because a selection can only exist
  //    if button 0 was pressed in the first place.
  if (final === 'm') {
    const button = b & 3;
    return { kind: 'release', button: (button === 3 ? 0 : button) as 0 | 1 | 2, x, y, ...modifiers(b) };
  }

  // 4. Press.
  const button = b & 3;
  if (button === 3) return null;
  return { kind: 'press', button: button as 0 | 1 | 2, x, y, ...modifiers(b) };
}

/**
 * X10 legacy reports (`\x1b[M` + three chars, each `code - 32`).
 *
 * We never request this encoding — `?1006h` is over a decade old and every
 * terminal that implements `?1000` implements it — but a terminal that ignored
 * the SGR request would fall back to it, and a leaked `\x1b[M` + garbage is
 * exactly the draft corruption I-1 exists to prevent. So it is consumed
 * unconditionally; the coordinates are only trusted when all three bytes are
 * plausible, because `setEncoding('utf8')` mangles raw bytes above 0x7F.
 */
function matchX10(s: string): Match {
  if (s.length < 6) return { kind: 'partial' };
  const codes = [s.charCodeAt(3), s.charCodeAt(4), s.charCodeAt(5)];
  if (codes.some((c) => c < 32 || c > 255)) return { kind: 'complete', length: 6, event: null };
  const [b, x, y] = codes as [number, number, number];
  return {
    kind: 'complete',
    length: 6,
    // `'x10'` is what makes I-11 a property of the code rather than of somebody's
    // memory: this encoding yields wheel events or nothing, ever.
    event: decodeReport(b - 32, x - 32, y - 32, 'M', 'x10'),
  };
}

/** Classify the escape sequence starting at `s[0] === ESC`. */
function matchReport(s: string): Match {
  if (s.length === 1) return { kind: 'partial' }; // lone ESC so far
  if (s[1] !== '[') return { kind: 'none' };
  if (s.length === 2) return { kind: 'partial' }; // `\x1b[`

  if (s[2] === '<') {
    const m = SGR_REPORT.exec(s);
    if (m) {
      const b = Number(m[1]);
      const x = Number(m[2]);
      const y = Number(m[3]);
      return { kind: 'complete', length: m[0].length, event: decodeReport(b, x, y, m[4]!, 'sgr') };
    }
    return SGR_PREFIX.test(s) ? { kind: 'partial' } : { kind: 'none' };
  }

  if (s[2] === 'M') return matchX10(s);
  return { kind: 'none' };
}

/**
 * Split a decoded stdin chunk into mouse events, passthrough text, and a
 * trailing prefix to carry into the next chunk.
 *
 * The caller is expected to feed `pending + nextChunk` back in; ConPTY does
 * split writes mid-sequence, and a report torn across two chunks would
 * otherwise leak its tail into the composer (R-6).
 *
 * ONE CHANNEL, NOT TWO (§4.4.2). Widening this list to carry buttons alongside
 * wheel notches is what keeps ARRIVAL ORDER intact between them; a second
 * channel would let a press overtake the notch that preceded it, and the
 * selection would then be anchored against rows that had already scrolled.
 */
export function splitMouseEvents(buffer: string): MouseSplit {
  const events: MouseEvent[] = [];
  let text = '';
  let i = 0;

  while (i < buffer.length) {
    const esc = buffer.indexOf(ESC, i);
    if (esc === -1) {
      text += buffer.slice(i);
      return { events, text, pending: '' };
    }
    text += buffer.slice(i, esc);

    const rest = buffer.slice(esc);
    const m = matchReport(rest);

    if (m.kind === 'complete') {
      if (m.event) events.push(m.event);
      i = esc + m.length;
      continue;
    }
    if (m.kind === 'partial') {
      // A tail that never resolves must not hold input hostage: past the
      // ceiling it is ordinary text, and parsing continues after the ESC.
      if (rest.length > MAX_PENDING_MOUSE_CHARS) {
        text += rest;
        return { events, text, pending: '' };
      }
      return { events, text, pending: rest };
    }
    // Not a mouse report — an arrow key, a paste, anything. Emit the ESC and
    // resume scanning after it so the rest of the sequence reaches Ink intact.
    text += ESC;
    i = esc + 1;
  }

  return { events, text, pending: '' };
}
