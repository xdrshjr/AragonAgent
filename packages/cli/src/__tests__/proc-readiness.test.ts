/**
 * Readiness detection (§7.1 / AC-5..AC-7) and the bounded tail (AC-8).
 *
 * The URL detector is pure, so this file needs no processes. `ReadinessWatcher`
 * takes an injected probe for the same reason.
 */

import { describe, expect, it, vi } from 'vitest';
import { detectReadyUrl, normalizeHost, ReadinessWatcher, READY_URL_RE } from '../proc/readiness.js';
import { LogRing } from '../proc/log-ring.js';
import { PROC_LIMITS } from '../proc/limits.js';

describe('detectReadyUrl (AC-5 / AC-6)', () => {
  it('AC-5: recognises what the shipped servers actually print', () => {
    expect(detectReadyUrl(['  - Local:  http://localhost:3000'])?.url).toBe(
      'http://localhost:3000',
    );
    expect(detectReadyUrl(['  Local:   http://localhost:5173/'])?.url).toBe(
      'http://localhost:5173/',
    );
    expect(detectReadyUrl(['INFO:     Uvicorn running on http://127.0.0.1:8000'])?.url).toBe(
      'http://127.0.0.1:8000',
    );
    expect(detectReadyUrl([' * Running on http://127.0.0.1:5000'])?.url).toBe(
      'http://127.0.0.1:5000',
    );
    expect(detectReadyUrl(['PHP 8.2 Development Server (http://127.0.0.1:8080) started'])?.url).toBe(
      'http://127.0.0.1:8080',
    );
  });

  it('AC-5b: a bare port phrase yields a PORT and no URL', () => {
    // A different result SHAPE, and deliberately so: with no URL there is
    // nothing to show the user until a probe confirms the port answers.
    const hit = detectReadyUrl(['Listening on port 4000']);
    expect(hit?.port).toBe(4000);
    expect(hit?.url).toBeUndefined();
  });

  it('AC-6: 0.0.0.0 and [::1] normalise to something a human can click', () => {
    expect(detectReadyUrl(['ready - started server on http://0.0.0.0:3000'])?.url).toBe(
      'http://127.0.0.1:3000',
    );
    expect(detectReadyUrl(['Server listening at http://[::1]:8080'])?.url).toBe(
      'http://127.0.0.1:8080',
    );
    // Without a scheme it is a PHRASE, not a URL - so it yields a port and the
    // probe decides, which is the AC-7 path rather than this one.
    expect(detectReadyUrl(['ready - started server on 0.0.0.0:3000'])).toEqual({ port: 3000 });
    expect(normalizeHost('http://[::1]:8080/')).toBe('http://127.0.0.1:8080/');
    expect(normalizeHost('http://::1:8080')).toBe('http://127.0.0.1:8080');
  });

  it('the pattern is a real regex, not a character class that looks like one', () => {
    // `[::1]` inside a pattern is a CHARACTER CLASS matching `:` or `1`, and
    // unescaped dots match anything. Both mistakes read as correct, so the
    // shape is pinned here rather than trusted.
    expect(READY_URL_RE.source).toContain(String.raw`127\.0\.0\.1`);
    expect(READY_URL_RE.source).toContain(String.raw`\[::1\]`);
    // A host that merely LOOKS like a loopback literal under a sloppy pattern.
    expect(detectReadyUrl(['see http://127x0y0z1:3000/docs'])).toBeUndefined();
  });
});

describe('AC-7: a matched URL is a candidate, not a verdict', () => {
  // The real false positive is a LOOPBACK url printed in a banner or a --help
  // blurb BEFORE anything binds. `https://example.com/docs` never matched the
  // host alternation to begin with, so asserting on it proves nothing.
  const bannerRow = 'Docs: http://localhost:3000/docs (once started)';

  it('a refused connect leaves the service starting', async () => {
    const onReady = vi.fn();
    const watcher = new ReadinessWatcher({
      readyTimeoutMs: 60_000,
      onReady,
      onTimeout: () => {},
      probe: async () => false,
    });
    watcher.start();
    watcher.offerRows([bannerRow]);
    await new Promise((r) => setTimeout(r, 20));
    expect(onReady).not.toHaveBeenCalled();
    watcher.stop();
  });

  it('the same row plus an accepted connect flips it to ready', async () => {
    const onReady = vi.fn();
    const watcher = new ReadinessWatcher({
      readyTimeoutMs: 60_000,
      onReady,
      onTimeout: () => {},
      probe: async () => true,
    });
    watcher.start();
    watcher.offerRows([bannerRow]);
    await new Promise((r) => setTimeout(r, 20));
    expect(onReady).toHaveBeenCalledWith(
      expect.objectContaining({ url: 'http://localhost:3000/docs', detectedBy: 'url' }),
    );
    watcher.stop();
  });

  it('a URL with NO port is accepted without a probe - the trade, recorded', async () => {
    // There is nothing to probe, and guessing 80 vs 443 would be worse than
    // accepting it. A hostname-only loopback URL in a banner is rare enough to
    // trade against the complexity; saying so here keeps it a decision.
    const onReady = vi.fn();
    const probe = vi.fn(async () => false);
    const watcher = new ReadinessWatcher({
      readyTimeoutMs: 60_000,
      onReady,
      onTimeout: () => {},
      probe,
    });
    watcher.start();
    watcher.offerRows(['serving on http://localhost']);
    await new Promise((r) => setTimeout(r, 20));
    expect(onReady).toHaveBeenCalledWith(
      expect.objectContaining({ url: 'http://localhost', detectedBy: 'url' }),
    );
    expect(probe).not.toHaveBeenCalled();
    watcher.stop();
  });

  it('a watcher that never listens reaches the timeout branch, not ready', async () => {
    const onTimeout = vi.fn();
    const watcher = new ReadinessWatcher({
      readyTimeoutMs: 20,
      onReady: () => {},
      onTimeout,
      probe: async () => false,
    });
    watcher.start();
    await new Promise((r) => setTimeout(r, 60));
    expect(onTimeout).toHaveBeenCalledOnce();
  });
});

describe('LogRing (AC-8)', () => {
  it('never exceeds the row bound', () => {
    const ring = new LogRing(4);
    for (let i = 0; i < 20; i += 1) ring.append(`row ${i}\n`);
    expect(ring.all()).toHaveLength(4);
    expect(ring.all()[3]).toBe('row 19');
    expect(ring.truncated).toBe(true);
  });

  it('`rowsSeen` is MONOTONIC and is not the tail length', () => {
    // This is the P0-3 property. The ring evicts while appending, so the joined
    // length is unchanged while the content is not - which is exactly why the
    // transcript's revision term reads this and never `rows.length`.
    const ring = new LogRing(2);
    ring.append('a\nb\n');
    const lengthBefore = ring.all().length;
    const seenBefore = ring.rowsSeen;
    ring.append('c\n');
    expect(ring.all().length).toBe(lengthBefore);
    expect(ring.rowsSeen).toBeGreaterThan(seenBefore);
  });

  it('`since` paging returns each row exactly once', () => {
    const ring = new LogRing(100);
    ring.append('one\ntwo\n');
    const first = ring.page();
    expect(first.rows).toEqual(['one', 'two']);
    expect(first.truncated).toBe(false);

    ring.append('three\n');
    const second = ring.page(first.cursor);
    expect(second.rows).toEqual(['three']);
    expect(second.cursor).toBe(3);
  });

  it('reports `truncated` when the cursor fell off the ring', () => {
    const ring = new LogRing(2);
    ring.append('a\nb\n');
    const at = ring.page().cursor;
    ring.append('c\nd\ne\n');
    const page = ring.page(at - 2);
    expect(page.truncated).toBe(true);
  });

  it('carries the in-progress line without counting it as a row', () => {
    // A progress bar is one continuously-rewritten line: counting it would burn
    // the whole ring on one logical line, and dropping it would leave the tail
    // empty for the command's entire run.
    const ring = new LogRing(PROC_LIMITS.serviceTailRows);
    ring.append('building... 40%');
    expect(ring.rowsSeen).toBe(0);
    expect(ring.all()).toEqual(['building... 40%']);
  });
});
