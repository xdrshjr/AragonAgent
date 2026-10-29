import type { MouseEvent } from '../input/mouse-events.js';
import { offsetForThumb, type ScrollbarGeometry } from './layout/scrollbar-geometry.js';

export interface ScrollbarController {
  handle(event: MouseEvent): boolean;
  cancel(): void;
  dispose(): void;
  isCaptured(): boolean;
}

export interface ScrollbarOptions {
  getGeometry(): ScrollbarGeometry | null;
  setOffset(offset: number): void;
  page(direction: 'pageUp' | 'pageDown'): void;
  onHold(held: boolean): void;
  onStart(): void;
  isEnabled(): boolean;
}

export interface ScrollbarBridge {
  controller: ScrollbarController | null;
  geometry: ScrollbarGeometry | null;
  frameReady: boolean;
  isEnabled(): boolean;
  onStart?: () => void;
  onGeometry?: () => void;
  requestRedraw?: () => void;
  invalidate(): void;
}

/** Build the late-bound terminal bridge; no scroll position is owned here. */
export function createScrollbarBridge(isEnabled: () => boolean): ScrollbarBridge {
  const bridge: ScrollbarBridge = {
    controller: null, geometry: null, frameReady: false, isEnabled,
    invalidate: () => { bridge.frameReady = false; bridge.controller?.cancel(); },
  };
  return bridge;
}

interface Capture {
  kind: 'thumb' | 'track';
  grabRow: number;
  revision: number;
  lastPointerY: number;
  pendingY: number | null;
}

/** Own one pointer gesture and bounded timers; positioning remains in the viewport. */
export function createScrollbarController(options: ScrollbarOptions): ScrollbarController {
  return new ScrollbarGesture(options);
}

class ScrollbarGesture implements ScrollbarController {
  private capture: Capture | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private watchdog: ReturnType<typeof setTimeout> | null = null;
  private swallowLate = false;
  private disposed = false;

  constructor(private readonly options: ScrollbarOptions) {}

  isCaptured(): boolean { return this.capture !== null; }

  cancel(): void {
    if (this.timer) clearTimeout(this.timer);
    if (this.watchdog) clearTimeout(this.watchdog);
    this.timer = this.watchdog = null;
    const held = this.capture !== null;
    this.capture = null;
    if (held) { this.swallowLate = true; this.options.onHold(false); }
  }

  dispose(): void { this.cancel(); this.disposed = true; }

  private armWatchdog(): void {
    if (this.watchdog) clearTimeout(this.watchdog);
    this.watchdog = setTimeout(() => this.cancel(), 30000);
    this.watchdog.unref?.();
  }

  private flush(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const g = this.options.getGeometry();
    if (!this.capture || !g || !this.options.isEnabled() ||
      g.revision !== this.capture.revision) {
      this.cancel();
      return;
    }
    const y = this.capture.pendingY;
    this.capture.pendingY = null;
    if (y !== null) this.options.setOffset(offsetForThumb({ geometry: g,
      pointerY: y, grabRow: this.capture.grabRow }));
  }

  private move(y: number): void {
    if (!this.capture || this.capture.kind !== 'thumb' || y === this.capture.lastPointerY) return;
    this.capture.lastPointerY = y;
    this.capture.pendingY = y;
    if (!this.timer) {
      this.timer = setTimeout(() => this.flush(), 16);
      this.timer.unref?.();
    }
  }

  private press(event: Exclude<MouseEvent, { kind: 'wheel' }>): boolean {
    this.cancel();
    this.swallowLate = false;
    const g = this.options.getGeometry();
    if (!g || !this.canPress(event, g)) return false;
    const row = event.y - g.trackTop;
    const thumb = g.thumb;
    const inside = thumb && row >= thumb.start && row < thumb.start + thumb.size;
    this.capture = { kind: inside && g.trackRows > thumb.size ? 'thumb' : 'track',
      grabRow: inside ? row - thumb.start : 0, revision: g.revision,
      lastPointerY: event.y, pendingY: null };
    this.options.onStart();
    this.options.onHold(true);
    this.armWatchdog();
    if (thumb && !inside) this.options.page(row < thumb.start ? 'pageUp' : 'pageDown');
    return true;
  }

  private canPress(event: Exclude<MouseEvent, { kind: 'wheel' }>, g: ScrollbarGeometry): boolean {
    const plainLeft = event.button === 0 && !event.shift && !event.alt && !event.ctrl;
    const inTrack = event.x === g.trackCol && event.y >= g.trackTop &&
      event.y < g.trackTop + g.trackRows;
    return this.options.isEnabled() && plainLeft && inTrack;
  }

  handle(event: MouseEvent): boolean {
    if (this.disposed) return false;
    if (event.kind === 'wheel') return this.capture !== null;
    if (![event.x, event.y].every(Number.isFinite)) return this.capture !== null;
    if (event.kind === 'press') return this.press(event);
    if (!this.capture) return this.swallowLate;
    if (event.button !== 0) { this.cancel(); return false; }
    if (!this.options.isEnabled()) { this.cancel(); return true; }
    this.move(event.y);
    if (event.kind === 'release') { this.flush(); this.cancel(); }
    else this.armWatchdog();
    return true;
  }
}
