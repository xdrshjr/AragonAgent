/**
 * A minimal VT screen with a SCROLLBACK, for native-scroll tests
 * (tui-native-terminal-scroll §9.1).
 *
 * `vt-screen.ts` models only a fixed alternate screen. Native mode is about what
 * the host terminal does when output runs past the bottom: the top row moves into
 * scrollback. This model supports exactly the whitelist the writer may emit (SGR,
 * CUU, CUD, CHA, CR, LF, ED0, EL0, DEC private modes) and RECORDS every sequence on
 * the blacklist instead of acting on it, so a test can assert both the resulting
 * screen and that nothing forbidden was ever written (I-S5 / I-S6).
 */

import stringWidth from 'string-width';

export type MiniVtWrapModel = 'at-last-column' | 'virtual-column';

export interface MiniVt {
  write(data: string): void;
  /** Visible rows, right-trimmed. */
  screen(): string[];
  /** Rows that scrolled off the top, oldest first, right-trimmed. */
  readonly scrollback: string[];
  /** scrollback + screen, with trailing blank screen rows removed. */
  history(): string[];
  cursor(): { row: number; col: number };
  /** Blacklisted sequences seen (`ESC[?1049h`, `ESC[3J`, a CUP, ...). */
  readonly forbidden: string[];
}

const FORBIDDEN_PRIVATE = new Set([1049, 1047, 47, 1000, 1002, 1003, 1006, 1007]);

export function createMiniVt(
  rows: number,
  cols: number,
  model: MiniVtWrapModel = 'virtual-column',
): MiniVt {
  const blank = (): string[] => new Array<string>(cols).fill(' ');
  const grid: string[][] = Array.from({ length: rows }, blank);
  const scrollback: string[] = [];
  const forbidden: string[] = [];
  let r = 0;
  let c = 0;
  let pending = false;

  const text = (cells: string[]): string => cells.join('').replace(/\s+$/, '');
  const clamp = (v: number, max: number): number => Math.max(0, Math.min(max, v));

  const lineFeed = (): void => {
    if (r === rows - 1) {
      scrollback.push(text(grid.shift()!));
      grid.push(blank());
    } else r += 1;
  };

  const print = (glyph: string): void => {
    const width = Math.max(1, stringWidth(glyph));
    if (pending) {
      c = 0;
      pending = false;
      lineFeed();
    }
    if (c + width > cols) {
      c = 0;
      lineFeed();
    }
    grid[r]![c] = glyph;
    for (let k = 1; k < width; k += 1) grid[r]![c + k] = '';
    c += width;
    if (c >= cols) {
      pending = true;
      c = model === 'at-last-column' ? cols - 1 : cols;
    }
  };

  const eraseToEol = (): void => {
    const from = model === 'virtual-column' && pending ? cols : c;
    for (let k = from; k < cols; k += 1) grid[r]![k] = ' ';
  };

  const csi = (params: string, final: string, raw: string): void => {
    if (params.startsWith('?')) {
      const modes = params.slice(1).split(';').map(Number);
      if (modes.some((mode) => FORBIDDEN_PRIVATE.has(mode))) forbidden.push(raw);
      return; // 2026 / 25 / 2004: no visible effect
    }
    const first = params === '' ? undefined : Number(params.split(';')[0]);
    switch (final) {
      case 'A': r = clamp(r - (first ?? 1), rows - 1); break;
      case 'B': r = clamp(r + (first ?? 1), rows - 1); break;
      case 'G': c = clamp((first ?? 1) - 1, cols - 1); pending = false; break;
      case 'K':
        if (first === 2) grid[r]!.fill(' ');
        else eraseToEol();
        break;
      case 'J':
        if (first === 2 || first === 3) { forbidden.push(raw); break; }
        eraseToEol();
        for (let row = r + 1; row < rows; row += 1) grid[row]!.fill(' ');
        break;
      case 'H': case 'f': case 'r': case 'S': case 'T':
        forbidden.push(raw);
        break;
      default: break; // SGR and the rest: no cell effect
    }
  };

  const write = (data: string): void => {
    const chars = Array.from(data);
    for (let i = 0; i < chars.length; i += 1) {
      const ch = chars[i]!;
      if (ch === '\x1b') {
        const next = chars[i + 1];
        if (next === '[') {
          let j = i + 2;
          let params = '';
          while (j < chars.length && /[0-?]/.test(chars[j]!)) params += chars[j++];
          while (j < chars.length && /[ -/]/.test(chars[j]!)) j += 1;
          const final = chars[j] ?? '';
          csi(params, final, chars.slice(i, j + 1).join(''));
          i = j;
        } else if (next === ']') {
          let j = i + 2;
          while (j < chars.length && chars[j] !== '\x07' && !(chars[j] === '\x1b' && chars[j + 1] === '\\')) j += 1;
          i = chars[j] === '\x07' ? j : j + 1;
        } else if (next === 'c') {
          forbidden.push('\x1bc');
          i += 1;
        } else i += 1;
      } else if (ch === '\r') {
        c = 0;
        pending = false;
      } else if (ch === '\n') {
        c = 0; // ONLCR, like a real tty
        pending = false;
        lineFeed();
      } else if (ch >= ' ') print(ch);
    }
  };

  const screen = (): string[] => grid.map(text);
  return {
    write,
    screen,
    scrollback,
    history: () => {
      const rowsOut = screen();
      while (rowsOut.length > 0 && rowsOut[rowsOut.length - 1] === '') rowsOut.pop();
      return [...scrollback, ...rowsOut];
    },
    cursor: () => ({ row: r, col: c }),
    forbidden,
  };
}
