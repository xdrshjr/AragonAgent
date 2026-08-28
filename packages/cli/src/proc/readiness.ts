/**
 * Readiness detection (background-service-supervision §3.5).
 *
 * Two detectors, raced, first one wins:
 *
 *  - the URL detector, which is PURE and therefore testable without a socket;
 *  - the port probe, which is one TCP connect and only runs when the command
 *    text named a port.
 *
 * ASCII ONLY: `src/proc/**` is inside the glyph scanner's scope.
 *
 * EVERY TIMER AND SOCKET HERE IS `unref()`d (I-3). Readiness detection must
 * never be the reason the CLI does not exit; only the child processes themselves
 * hold the loop open, and they are reaped on exit.
 */

import net from 'node:net';
import { PROC_LIMITS } from './limits.js';

/**
 * A loopback/wildcard `http(s)` URL, with an optional port and path.
 *
 * ONE ANCHORED SOURCE OF TRUTH, and written out rather than assembled, because
 * the obvious shorthand is not a regex at all: `[::1]` inside a pattern is a
 * CHARACTER CLASS matching `:` or `1`, and unescaped dots match any character.
 * Both mistakes read as correct.
 */
export const READY_URL_RE =
  /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|::1)(?::(\d{1,5}))?(\/\S*)?/i;

/**
 * Servers that announce a bare port instead of a URL.
 *
 * A SEPARATE, SMALLER LIST rather than more alternation in the URL pattern: what
 * these produce is a PORT and no URL, which is a different result shape and a
 * different confirmation path (the probe must succeed before anything flips).
 */
const PORT_PHRASES: readonly RegExp[] = Object.freeze([
  /listening on (?:port )?(\d{2,5})\b/i,
  /server running at .*?:(\d{2,5})\b/i,
  /started server on .*?:(\d{2,5})\b/i,
  /\bLocal:\s+\S*?:(\d{2,5})\b/i,
]);

export interface ReadyUrlMatch {
  /** Normalised so a human can click it; absent for a bare-port phrase. */
  url?: string;
  port?: number;
}

/**
 * Normalise a wildcard/IPv6-loopback host to something clickable.
 *
 * `0.0.0.0` means "every interface", which a browser cannot open; `::1` and
 * `[::1]` are correct but unfamiliar. All three become `127.0.0.1`.
 */
export function normalizeHost(url: string): string {
  return url
    .replace(/:\/\/0\.0\.0\.0/i, '://127.0.0.1')
    .replace(/:\/\/\[::1\]/i, '://127.0.0.1')
    .replace(/:\/\/::1/i, '://127.0.0.1');
}

/**
 * The first readiness candidate in `rows`, or `undefined`.
 *
 * A MATCH IS A CANDIDATE, NOT A VERDICT (P2-2). A loopback URL printed in a
 * banner or a `--help` blurb appears BEFORE anything binds, and a bare pattern
 * would call that service ready in the first 40 ms. Two guards make the trade
 * explicit, and neither lives here:
 *
 *   1. only rows emitted AFTER spawn are scanned (the ring starts empty, so this
 *      is free), and
 *   2. when the match yields a PORT, `ReadinessWatcher` confirms with one TCP
 *      connect before the status flips.
 *
 * When the match yields no port the URL is accepted as-is: there is nothing to
 * probe, and a hostname-only loopback URL in a banner is rare enough to trade
 * against the complexity of guessing 80 vs 443.
 */
export function detectReadyUrl(rows: readonly string[]): ReadyUrlMatch | undefined {
  for (const row of rows) {
    const m = READY_URL_RE.exec(row);
    if (m) {
      const url = normalizeHost(m[0]);
      const port = m[1] ? Number.parseInt(m[1], 10) : undefined;
      return port === undefined ? { url } : { url, port };
    }
  }
  for (const row of rows) {
    for (const re of PORT_PHRASES) {
      const m = re.exec(row);
      if (!m || !m[1]) continue;
      const port = Number.parseInt(m[1], 10);
      if (Number.isFinite(port) && port > 0 && port <= 65535) return { port };
    }
  }
  return undefined;
}

/**
 * One TCP connect. Resolves `true` when something answered.
 *
 * Never rejects, and the socket is destroyed on every path — a probe that leaked
 * a socket would hold the event loop open exactly as long as the service runs.
 */
export function probePort(
  port: number,
  host = '127.0.0.1',
  timeoutMs = PROC_LIMITS.probeSocketTimeoutMs,
): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (answered: boolean): void => {
      if (settled) return;
      settled = true;
      try {
        socket.destroy();
      } catch {
        /* ignore */
      }
      resolve(answered);
    };
    const socket = new net.Socket();
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
    try {
      socket.connect(port, host);
      socket.unref();
    } catch {
      done(false);
    }
  });
}

export interface ReadinessResult {
  url?: string;
  port?: number;
  detectedBy: 'url' | 'probe';
}

export interface ReadinessWatcherOptions {
  /** From `extractPortHint`, and only when the pre-flight probe found it FREE. */
  portHint?: number;
  readyTimeoutMs: number;
  onReady: (result: ReadinessResult) => void;
  /** Alive past `readyTimeoutMs` with nothing detected (`tsc --watch` et al). */
  onTimeout: () => void;
  /** Injected for the tests; production passes nothing. */
  probe?: (port: number) => Promise<boolean>;
}

/**
 * Races the URL detector against the port probe and stops at the first hit.
 *
 * ONE SHOT. `stop()` is idempotent and is called from every terminal path, so a
 * service that exits during the window leaves nothing behind.
 */
export class ReadinessWatcher {
  private timer: ReturnType<typeof setInterval> | undefined;
  private deadline: ReturnType<typeof setTimeout> | undefined;
  private finished = false;
  private probing = false;
  private readonly probeFn: (port: number) => Promise<boolean>;

  constructor(private readonly opts: ReadinessWatcherOptions) {
    this.probeFn = opts.probe ?? ((port: number) => probePort(port));
  }

  start(): void {
    if (this.finished) return;
    this.deadline = setTimeout(() => {
      if (this.finished) return;
      this.stop();
      this.opts.onTimeout();
    }, this.opts.readyTimeoutMs);
    this.deadline.unref?.();

    const hint = this.opts.portHint;
    if (hint === undefined) return;
    this.timer = setInterval(() => {
      if (this.finished || this.probing) return;
      this.probing = true;
      void this.probeFn(hint)
        .then((answered) => {
          this.probing = false;
          if (!answered || this.finished) return;
          this.settle({ port: hint, url: `http://127.0.0.1:${hint}`, detectedBy: 'probe' });
        })
        .catch(() => {
          this.probing = false;
        });
    }, PROC_LIMITS.probeIntervalMs);
    this.timer.unref?.();
  }

  /**
   * Offer the rows emitted since the last call.
   *
   * A MATCH WITH A PORT IS CONFIRMED BY ONE CONNECT before the status flips; a
   * refused connect leaves the service `starting` and the row is simply not
   * re-considered on the next call, because the caller passes only NEW rows.
   */
  offerRows(rows: readonly string[]): void {
    if (this.finished || rows.length === 0) return;
    const hit = detectReadyUrl(rows);
    if (!hit) return;
    if (hit.port === undefined) {
      this.settle({ ...(hit.url ? { url: hit.url } : {}), detectedBy: 'url' });
      return;
    }
    const port = hit.port;
    void this.probeFn(port)
      .then((answered) => {
        if (!answered || this.finished) return;
        this.settle({
          port,
          url: hit.url ?? `http://127.0.0.1:${port}`,
          detectedBy: 'url',
        });
      })
      .catch(() => {
        /* a refused connect is not an error; it just is not ready yet */
      });
  }

  stop(): void {
    this.finished = true;
    if (this.timer) clearInterval(this.timer);
    if (this.deadline) clearTimeout(this.deadline);
    this.timer = undefined;
    this.deadline = undefined;
  }

  private settle(result: ReadinessResult): void {
    if (this.finished) return;
    this.stop();
    this.opts.onReady(result);
  }
}
