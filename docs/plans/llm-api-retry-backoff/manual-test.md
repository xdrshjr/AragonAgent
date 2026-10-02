# LLM API Retry & Backoff — Manual verification

Transcribed from `spec.md` §12. **M-2, M-3, M-5 and M-5b are not skippable** — each
covers a failure no unit test can observe, and M-5b is the one the whole feature
turns on.

Run the CLI from `packages/cli` (`npm run build && node dist/cli.js`, or
`npm run dev:cli` from the repo root).

---

## 0. The local fault-injection server

Ten of the sixteen checks need a provider that fails on demand. This is the whole
harness — save it as `retry-server.mjs` outside the repo and run
`node retry-server.mjs`, then point the CLI at it with
`--base-url http://127.0.0.1:8787`.

```js
// A minimal Anthropic-shaped endpoint with switchable failure modes.
//   MODE=529      -> N 529s, then proxy through to the real API
//   MODE=truncate -> stream some text, then close CLEANLY mid-answer  (M-5b!)
//   MODE=reset    -> stream some text, then destroy the socket        (M-5)
//   MODE=429      -> one 429 carrying `retry-after: 5`
//   MODE=429long  -> one 429 carrying `retry-after: 3600`
import { createServer } from 'node:http';

const MODE = process.env.MODE ?? '529';
const FAILURES = Number(process.env.FAILURES ?? 5);
const UPSTREAM = process.env.UPSTREAM ?? 'https://api.anthropic.com';
let seen = 0;

createServer(async (req, res) => {
  seen += 1;
  const failing = seen <= FAILURES;
  const sse = (body) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(body);
  };

  if (MODE === '429' && failing) {
    res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '5' });
    return res.end('{"error":{"type":"rate_limit_error","message":"slow down"}}');
  }
  if (MODE === '429long' && failing) {
    res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '3600' });
    return res.end('{"error":{"type":"rate_limit_error","message":"come back in an hour"}}');
  }
  if (MODE === '529' && failing) {
    res.writeHead(529, { 'content-type': 'application/json' });
    return res.end('{"error":{"type":"overloaded_error","message":"overloaded"}}');
  }
  if ((MODE === 'truncate' || MODE === 'reset') && failing) {
    sse(
      'event: message_start\ndata: {"message":{"usage":{"input_tokens":5}}}\n\n' +
        'event: content_block_start\ndata: {"index":0,"content_block":{"type":"text"}}\n\n' +
        'event: content_block_delta\ndata: {"index":0,"delta":{"type":"text_delta",' +
        '"text":"This answer is going to stop half way through"}}\n\n',
    );
    // THE DIFFERENCE BETWEEN M-5 AND M-5b, and it is the whole point:
    //   `end()`     -> a graceful FIN. No error is thrown anywhere.
    //   `destroy()` -> an RST. The reader throws ECONNRESET.
    return setTimeout(() => (MODE === 'truncate' ? res.end() : res.destroy()), 400);
  }

  // Proxy through to the real API.
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const upstream = await fetch(`${UPSTREAM}${req.url}`, {
    method: req.method,
    headers: { ...req.headers, host: new URL(UPSTREAM).host },
    body: Buffer.concat(chunks),
  });
  res.writeHead(upstream.status, {
    'content-type': upstream.headers.get('content-type') ?? 'text/event-stream',
  });
  if (upstream.body) for await (const c of upstream.body) res.write(c);
  res.end();
}).listen(8787, () => console.log(`retry-server on 8787 (MODE=${MODE})`));
```

---

## The matrix

| # | Setup | Expect | Result |
| --- | --- | --- | --- |
| **M-1** | `aragon` with a valid key; ask anything. | No retry card, no chip, no stderr line. Byte-identical to the previous release. | |
| **M-2** ⚠️ | `MODE=529 FAILURES=5 node retry-server.mjs`, then `aragon --base-url http://127.0.0.1:8787`; ask anything. | **ONE** card, counting `retry 1/10` → `retry 5/10`, the countdown visibly decrementing each second, then `recovered after 5 retries · <time>`. The transcript has **one** retry line, not five. The status bar shows `retry n/10 Ns` while waiting. | |
| **M-3** ⚠️ | During M-2's wait, press **Esc**. | The wait ends **within a frame** — not at the end of the 8 s. The card reads `interrupted after N retries`, the prompt is usable, and there is **no** `Network error…` notice (nothing may blame the network for what the user just did). | |
| **M-4** | `aragon --api-key sk-invalid`. | Immediate auth error, **no** retry card, no delay at all. | |
| **M-5** ⚠️ | `MODE=reset FAILURES=1 node retry-server.mjs`, then ask anything. | Partial text streams, then is **discarded**; the card appears and the answer restarts from the top. No duplicated paragraph anywhere. | |
| **M-5b** ⚠️ | `MODE=truncate FAILURES=1 node retry-server.mjs`, then ask anything. | **The same as M-5.** Against a pre-§4.5a build this instead ends the turn with a silently truncated answer and **no card at all** — which is exactly why M-5b is not skippable: M-5 exercises the THROWING path, M-5b the CLEAN-CLOSE path, and only the second one was broken. Do not simulate this by killing the socket. | |
| **M-6** | `aragon --no-retry --base-url http://127.0.0.1:8787` against `MODE=529`. | Fails on the first error, exactly as before this change. No card, no chip, no stderr retry line. | |
| **M-7** | After M-2, read the cost readout / `/cost`. | Cost reflects the **successful attempt only**. The card's retry count is what tells the user more was spent — usage is never fabricated for a discarded attempt. | |
| **M-8** | `/retry off`, then trigger a 529. Then `/retry on` in the SAME session and trigger again. | First: no retry. Then: retries — **without restarting**. This is what proves the live update reaches the `ProviderRegistry` rather than only the config file. | |
| **M-9** | Force a wait at 80 columns (resize, then trigger a 529). | Chip reads `[r3]`; the context gauge is not visibly squeezed. | |
| **M-10** | Run in `cmd.exe` (`caps.unicode === false`) and trigger a wait. | Card renders with `[r]` as its rail marker and `...` / `-` in place of the ellipsis and mid-dot. No mojibake anywhere. | |
| **M-11** | `/save mid-wait.json` during a wait, then `/resume mid-wait.json`. | The card reads `interrupted after N retries`; the transcript does **not** flicker or re-render continuously afterwards. (Watch the CPU: a card that never settles pins the settled boundary and re-renders the tail every frame.) | |
| **M-12** | `aragon -p "hi" --base-url http://127.0.0.1:8787 1>out.txt 2>err.txt` against `MODE=529`. | `out.txt` holds **only** the answer and stays valid for `jq`. `err.txt` holds `[retry n/10] overloaded — waiting Ns` and `[retry] recovered after n retries`. | |
| **M-13** | A team dispatch of 3 children against `MODE=529 FAILURES=9`. | All three retry independently and their waits are visibly **de-correlated** (equal jitter). Each child's row on the team card reads `retry n/10` while it waits. The dispatch never looks hung. *(No countdown on a child row — see the note under "Known deviations".)* | |
| **M-14** | `reducedMotion: true` (or `--no-color`) during a wait. | No spinner. **The countdown still ticks** — reduced motion is about animation, and a frozen number reads as broken. | |
| **M-15** | `/retry max 0`, then trigger a 529. Then `aragon --retry-max 0` and `ARAGON_RETRY_MAX=0 aragon` in fresh sessions. | No retry in any of the three, and `/retry` reports `0` — **not `10`**. This is the coercion trap that made four documented controls set the maximum instead of the minimum. | |
| **M-16** | `MODE=429long FAILURES=1 node retry-server.mjs`, then ask anything. | The turn fails **immediately** with the provider's own message naming an hour. It does **not** wedge the terminal for an hour, and it does not silently wait 60 s instead. | |

---

## Extras worth a minute

| # | Setup | Expect |
| --- | --- | --- |
| M-17 | `MODE=429 FAILURES=1` (the header says 5 s) with `retry.initialDelayMs` at its 1 s default. | The first wait is **at least 5 s**, not 1 s: `Retry-After` is honoured as a FLOOR. |
| M-18 | `aragon config set retry.maxRetries 999` then `aragon config get retry.maxRetries`. | Prints `20` — the echoed value is what was STORED, not what was typed. |
| M-19 | `aragon config set retry.multiplier 2.5` then `config get`. | Prints `2.5`, not `2`: this is the one float key in the section. |
| M-20 | Open `/settings` during a session. | One `API retries` row reading `10` (or `off`). It is read-only; `/retry` is the control. |
| M-21 | `aragon --log-level info` and trigger a 529, then read the log file. | One `llm_retry_scheduled` record at `warn` per retry, carrying `attempt`, `delayMs`, `errorType`, `providerId`, `modelId` — and **no** prompt or answer content. |

---

## Known deviations from the design

Recorded here so a tester does not chase them as bugs. The reasoning lives in
`spec.md` § *实施过程发现的方案缺陷*.

1. **A child's team-card row shows `retry 3/10` with no countdown.** §6.10 sketched
   `retrying 3/10 · 7s`, but nothing re-renders a team row during a child's
   backoff — the row is drawn from `agent_update`, and a child in backoff emits
   exactly one event for the whole wait. A `7s` frozen for thirty seconds is a
   worse readout than none.
2. **`registry.complete()` aborted mid-backoff rejects with `Stream ended without
   a done event`,** not with the abort's own error. AC-5b's headline property — it
   never fabricates a `network_error` — holds; the wrapper returns silently on
   abort, so there is no provider error in hand to re-throw.
3. **OpenAI truncation is keyed on `[DONE]` *or* a `finish_reason`.** §4.5a named
   only `[DONE]`; several OpenAI-compatible endpoints (the ones `--base-url` exists
   for) never send it, and keying on it alone would turn every complete response
   from such a server into ten retries and a failure.
