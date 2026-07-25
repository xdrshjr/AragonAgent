/**
 * Editing keymap (spec §3.10). Pure: maps a raw `useInput` `(input, key)` pair
 * to a line-editing intent. Ink does not surface Home/End/word keys on its
 * `key` object — those arrive as raw escape sequences in `input` — so this
 * recognizer inspects both the parsed `key` flags (for Ctrl/Alt combos) and the
 * raw sequence (for Home/End/word jumps), and returns `null` for anything it
 * does not own so the caller can drop unknown control bytes instead of
 * inserting them into the buffer.
 */

export type EditIntent =
  | 'home'
  | 'end'
  | 'wordLeft'
  | 'wordRight'
  | 'deleteWordBack'
  | 'killToStart'
  | 'killToEnd';

/** Minimal shape of Ink's `Key` we consult (structurally compatible). */
export interface KeyState {
  ctrl?: boolean;
  meta?: boolean;
  shift?: boolean;
  leftArrow?: boolean;
  rightArrow?: boolean;
}

/** Map a Ctrl-modified key to an intent, if any. */
function fromCtrl(input: string, key: KeyState): EditIntent | null {
  if (key.leftArrow) return 'wordLeft';
  if (key.rightArrow) return 'wordRight';
  switch (input) {
    case 'a':
      return 'home';
    case 'e':
      return 'end';
    case 'w':
      return 'deleteWordBack';
    case 'u':
      return 'killToStart';
    case 'k':
      return 'killToEnd';
    default:
      return null;
  }
}

/** Map an Alt/Meta-modified key to an intent, if any. */
function fromMeta(input: string): EditIntent | null {
  if (input === 'b') return 'wordLeft';
  if (input === 'f') return 'wordRight';
  if (input === '\x7f' || input === '\b') return 'deleteWordBack';
  return null;
}

/** Map a raw terminal escape / control sequence to an intent, if any. */
function fromRaw(input: string): EditIntent | null {
  switch (input) {
    case '\x1b[H':
    case '\x1b[1~':
    case '\x1bOH':
    case '\x01': // Ctrl+A (raw)
      return 'home';
    case '\x1b[F':
    case '\x1b[4~':
    case '\x1bOF':
    case '\x05': // Ctrl+E (raw)
      return 'end';
    case '\x1b[1;5D':
    case '\x1bb':
      return 'wordLeft';
    case '\x1b[1;5C':
    case '\x1bf':
      return 'wordRight';
    case '\x17': // Ctrl+W (raw)
    case '\x1b\x7f':
    case '\x1b\b':
      return 'deleteWordBack';
    case '\x15': // Ctrl+U (raw)
      return 'killToStart';
    case '\x0b': // Ctrl+K (raw)
      return 'killToEnd';
    default:
      return null;
  }
}

/** Recognize a line-editing intent, or `null` if this key is not an edit op. */
export function recognize(input: string, key: KeyState): EditIntent | null {
  if (key.ctrl) {
    const hit = fromCtrl(input, key);
    if (hit) return hit;
  }
  if (key.meta) {
    const hit = fromMeta(input);
    if (hit) return hit;
  }
  return fromRaw(input);
}
