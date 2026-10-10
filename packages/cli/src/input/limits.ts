/**
 * Structural bounds for paste handling (tui-paste-handling D-10 / section 8).
 *
 * THESE ARE STRUCTURAL, NOT POLICY. The package convention recorded in
 * `.claude-index/index.md` is that `limits.ts` carries the numbers an
 * implementation needs to stay bounded, while `config/schema.ts` carries the
 * preferences a user is allowed to have. The only user-facing key this feature
 * adds is the boolean `paste`; a tunable collapse threshold is a preference
 * nobody has asked for, and a kill switch is what a bug report actually needs.
 *
 * The two framing constants below are the only bytes that cross from the stdin
 * filter into the composer, so they are load-bearing in a way a threshold is
 * not: see `PASTE_OPEN`.
 */

/**
 * Ceiling on ONE paste. Above it the body is dropped and the user is told,
 * never truncated (D-11): a truncated paste loses data and looks like success.
 */
export const PASTE_MAX_BYTES = 2 * 1024 * 1024;

/** Ceiling on every live payload in one draft, summed. Above it a paste is refused. */
export const PASTE_DRAFT_MAX_BYTES = 8 * 1024 * 1024;

/** Ceiling on collapsed blocks in one draft. Above it a paste is refused. */
export const PASTE_MAX_BLOCKS = 32;

/**
 * Tier 2's single-line rule: a chunk of at least this many printable characters
 * with no line break is a paste.
 *
 * Safe because coalescing a keyboard burst into 25 characters inside one
 * event-loop turn needs roughly 1 500 WPM. It is a statement about what a
 * KEYBOARD can emit, not about what text looks like.
 */
export const PASTE_MIN_BURST_CHARS = 25;

/** Tier 2 coalescing window. Ordinary typing never opens it, so never pays it. */
export const PASTE_BURST_MS = 15;

/**
 * How long an unterminated Tier 1 body is held before it is force-flushed.
 *
 * I-4: an unterminated `\x1b[200~` must never be able to wedge keyboard input,
 * which is the rule `MAX_PENDING_MOUSE_CHARS` already encodes for mouse reports.
 */
export const PASTE_ASSEMBLY_MAX_MS = 2_000;

/**
 * The inline frame the filter writes into the stream Ink reads (D-3 / I-5).
 *
 * ON THE SAME STREAM, NOT A SIDE CHANNEL. `wrapper.write(text)` is delivered
 * asynchronously; a synchronous side-channel emit would apply the paste BEFORE
 * text that preceded it in the same chunk. Framing preserves order by
 * construction.
 *
 * NUL is the delimiter because no terminal delivers it for any key, and because
 * `sanitisePaste` strips every NUL out of every payload -- so a payload can
 * never forge a frame boundary.
 */
export const PASTE_OPEN = '\u0000[';
export const PASTE_CLOSE = '\u0000]';

/**
 * The inline frame that carries ONE newline intent from the stdin filter to the
 * composer (tui-shift-enter-copy-queue 3.2).
 *
 * SAME FAMILY AS `PASTE_OPEN`, with the same guarantee and for the same reason:
 * NUL is the delimiter because no terminal delivers it for any key, and because
 * `sanitisePaste` strips every NUL out of every payload -- so pasted text can
 * never forge this frame either. A newline intent is single, atomic and carries
 * no payload, so one constant replaces the OPEN/CLOSE pair.
 */
export const ENTER_NEWLINE_FRAME = '\u0000n';

/**
 * The inline frame that carries ONE "Ctrl+I was pressed" intent from the stdin
 * filter to `App` (project-indexer Ctrl+I trigger).
 *
 * WHY A FRAME AND NOT `key.ctrl && input === 'i'`. Legacy terminals encode
 * Ctrl+I as the same byte as Tab (0x09), so by the time the stream reaches Ink
 * the two are indistinguishable. Under win32-input-mode (`?9001h`) and kitty
 * CSI-u the modifiers ARE known at translation time, and both translators emit
 * this frame instead of the legacy Tab byte. Same NUL-delimiter guarantee as
 * `ENTER_NEWLINE_FRAME`: no terminal delivers NUL for a key and pasted text is
 * stripped of NUL, so a payload can never forge it. Terminals without keyboard
 * enhancement keep the legacy collapse — Ctrl+I there is Tab, documented in the
 * README keybindings table.
 */
export const INDEX_KEY_FRAME = '\u0000i';

/**
 * The one channel from the stdin filter to `App`'s notice dispatch (P1-3 / I-15).
 *
 * The filter is constructed in `cli.tsx` BEFORE `render()`, so it has no
 * `dispatch`. Its only other outlet is the logger, and a limit that writes only
 * to a log file is indistinguishable -- from the user's chair -- from a paste
 * that silently did nothing, which is exactly what D-11 exists to rule out.
 *
 * Same late-bound shape as `selectionBridge` / `updateBridge` / `terminalBridge`:
 * `cli.tsx` creates the object, `App` assigns `notify` on mount and clears it on
 * unmount, and the filter calls `bridge.notify?.(...)`.
 */
export interface PasteBridge {
  notify: ((level: 'warn' | 'error', text: string) => void) | null;
}

/** Human-readable byte size for the refusal toast (`4.1 MB`, `812.0 KB`, `7 B`). */
export function formatPasteSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}
