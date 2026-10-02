# Mouse-wheel region routing — design specification

> Feature slug: `mouse-wheel-region-routing`
> Target: `@aragon-agent/cli` only (`packages/cli`). `@aragon-agent/core` is untouched.
> Version: **v2** — design review pass (v1 = solution-architect first draft)
> Status: 有条件通过 — approved with conditions, see [§14](#14-评审结论-review-verdict)
> Author: solution-architect node
> Reviewer: design-review node (design only — no code exists yet)

---

> **⚠️ PARTIALLY SUPERSEDED by `docs/plans/wheel-scrolls-transcript-only/spec.md`.**
> The **composer band** described in §4.5–§4.7 shipped and was then removed: a
> wheel notch no longer steps prompt history at any pointer row, `hitTestWheel` /
> `FrameGeometry` / `regions.ts` and `AppShell`'s `measureElement(bottomRef)`
> layout effect are deleted, and history recall belongs to `↑` / `↓` alone. The
> reason is in §1 of the new spec: the pointer is not an aimed instrument in a
> TUI, so the ordinary "scroll back" gesture landed on the composer and ate the
> user's draft. **Everything else in this document still stands** — the SGR
> parser, the stdin filter, the `--mouse` switch, the one-time selection notice,
> the transcript's 3-rows-per-notch and `Shift`+wheel page, the overlay branch and
> the scroll indicator. Read the band sections as history, not as contract.

---

## 0. 评审记录 (Review Notes)

Held against the code as committed on `master`, not against the design's account
of itself: `packages/cli/src/{cli.tsx, ui/App.tsx, ui/PromptInput.tsx,
ui/Composer.tsx, ui/screen.ts, ui/glyphs.ts, ui/layout/*, config/{load,env,schema}.ts,
__tests__/*}` plus `node_modules/ink@5.2.1/build/{components/App.js, log-update.js}`.

**The architecture is right and the root-cause analysis is verified true.**
Every load-bearing claim in §3 and §4.2 checks out against the actual source:
`PromptInput.tsx:418-425` really is `key.upArrow && !key.shift → verticalOrHistory`;
`isControlSeq` really is `code < 0x20 || code === 0x7f` (`PromptInput.tsx:177-181`),
so `[<64;40;12M` really would be typed into the user's message; Ink 5.2.1 really
does own stdin through `stdin.setEncoding('utf8')` + `ref()` + `setRawMode(true)` +
`addListener('readable', …)` and drain it with `read()` (`ink/build/components/App.js:114-138`),
so a second `'data'` listener really would race it; and `isRawModeSupported()`
really does read `props.stdin.isTTY`, which is why the proxy needs the delegating
getter. The `top: 1` assumption also holds — `TranscriptList` renders **no**
`<Static>` in full-screen (`Transcript.tsx:176-187`) and `log-update` writes
`output + '\n'` for a frame of `rows - 1` lines, so the buffer never scrolls and
the frame sits at rows `1 … rows-1`. Nothing below changes the architecture.

The findings are of three kinds: one place where the design leaves its own
top-priority invariant unowned (P0-1), one place where it sequences the work so
that its single unverifiable assumption is tested last (P0-2), and a set of
seams where a correct-looking implementation would silently do the wrong thing.

### P0

**P0-1 · Enabling mouse reporting and installing the stdin filter are not
ordered and not atomic, so I-1 has no owner.** `cli.tsx` writes the enable pair
inside `enterAltScreen()` (`cli.tsx:277`) and hands Ink its stream 27 lines later
at `render()` (`cli.tsx:304`). §4.2 and §4.3 never state that the filter must
exist first, and never say what happens if `createMouseFilter` throws. In that
window — or permanently, if construction fails — the terminal is reporting and
Ink is reading the real `process.stdin`, so every wheel notch **and every click**
becomes `[<0;12;5M` in the composer. That is precisely the outcome §3-D exists to
warn about, and it is strictly worse than the bug this feature fixes: the current
bug replaces the draft with a previous prompt, this one corrupts it with garbage
the user then has to find and delete. An invariant with no owner in the call
order is not an invariant. **Fixed in §4.2 (build-then-enable ordering, hard
failure fallback), §4.3 (`enterAltScreen` never decides `mouse` for itself),
§2.3 (new invariant I-8) and §8.1 (named test).**

**P0-2 · The one assumption the whole design rests on is scheduled for phase 5
of 7.** R-1 asks whether Node/libuv surfaces SGR mouse reports from a Windows
console at all, rates it *medium* likelihood, and §11 puts the answer at phase 5
— after the parser, the geometry, the stream proxy and the screen sequences are
all written and tested. The primary development and support environment for this
CLI is Windows (`process.platform === 'win32'`). If R-1 fires there, the shipped
result is "the wheel now does nothing", which does not satisfy G1 at all, and
eleven new files plus five test suites were written to find that out. This is not
a risk-acceptance question, it is a sequencing defect: a throwaway 30-line probe
answers it in an afternoon, before anything is committed to. **Fixed in §11
(new Phase 0, a hard gate) and §9 (R-1 restated as a gate, not a mitigation).**

### P1 — fixed in the v2 body

**P1-2 · `aragon config set mouse false` would print success and write
nothing.** §5.7 says to add `'mouse'` to `CONFIG_SET_KEYS`, and stops there.
`runConfigSet` (`cli.tsx:435-547`) is a two-stage function: the `Set` only decides
whether the key is *rejected*, and the `switch` at line 453 is what builds the
patch. A key present in the set but absent from the switch falls through every
case, calls `updatePersistedConfig({})`, and prints `Set mouse = false`. Silent,
confident, and wrong — the same shape as the `density` / `hints` omission the
comment at `cli.tsx:415` records as having already happened once. §5.7 also omits
`RawOpts.mouse` and the `toFlags` line, without which the flag never reaches
`CliFlags` at all. **Fixed in §5.7 and §10.2.**

**P1-3 · The 16 ms transcript coalescer can flush into an unmounted
`ScrollViewport`, re-opening R-P1-7.** `App.tsx:889` swaps the viewport out for
the overlay, so `ScrollViewport` is *unmounted* while an overlay is open, and its
`useEffect([intentNonce])` fires once on **remount** — which is exactly why the
keyboard handler's overlay branch is documented as having to swallow `PgUp` even
for overlays that ignore it (`App.tsx:633-638`). §4.7 arms a 16 ms timer on the
content path and never re-checks the overlay when it fires. Wheel the transcript,
have the agent raise a `confirm` within 16 ms, and the accumulated intent lands on
a component that is not there; the transcript then jumps a page by itself when the
overlay closes. A six-line comment in the codebase exists because someone already
paid for this bug. **Fixed in §4.7 (re-read `stateRef.current.overlay` at flush,
drop the accumulator when the overlay changes) and §8.2 (named test).**

**P1-4 · Nonce-keyed effects also fire on mount, so a remount replays the last
wheel step.** §5.6 specifies `historyIntent` as "an effect keyed on the nonce
alone (same pattern as `ScrollViewport`'s intent effect)". `ScrollViewport` gets
away with it because its parent guarantees a fresh mount starts at nonce 0; a
component that mounts while `App` already holds `{dir:'up', nonce: 7}` will apply
it immediately. `PromptInput` does remount — the terminal-too-small placeholder
at `App.tsx:845` returns before `AppShell` — so shrinking the window mid-wheel
and growing it back recalls a history entry with no gesture behind it. **Fixed in
§5.6 (explicit mount-skip requirement, stated for both effects) and §8.2.**

**P1-5 · `fallbackBottomRows` is declared with no call site, and contradicts the
algorithm that would call it.** §5.4 exports it as "the arithmetic fallback used
when `measureElement` reports 0 (§4.5)", but §4.5's rules never mention it: an
unmeasured frame routes to `'content'` and `bottom` is merely clamped. An
implementer reading §5.4 will wire `chromeBudget`-derived arithmetic into the
hit test; one reading §4.5 will not. They produce different bands for the same
wheel event on the first frame after a resize. The right answer is to delete it
— failing to `'content'` for one frame is invisible, and the arithmetic is wrong
exactly when the popup is open, which is D-5's whole argument. **Fixed in §4.5,
§5.4 and §10.1: `fallbackBottomRows` is removed, and `App` resets the ref to
`UNMEASURED_GEOMETRY` on every path where `AppShell` does not render the frame.**

**P1-6 · The mouse-off path does not restore alternate scroll, it *sets* it.**
§4.3 writes `\x1b[?1007l` on enter and `\x1b[?1007h` on `restore()`. 1007 is
global terminal state that this app does not own, and a user who had it off —
because they configured their terminal that way — gets it switched on by
running `aragon --no-mouse` once. §4.3 already identifies the reason to care
("other TUIs the user runs in the same window depend on it") and then implements
the opposite of it. `XTSAVE` / `XTRESTORE` (`\x1b[?1007s` / `\x1b[?1007r`) say
exactly what is meant, are ignored as a pair by terminals that do not implement
them, and cost one byte each. **Fixed in §4.3.**

**P1-7 · `App.tsx` is exactly 1000 lines — the ceiling `CLAUDE.md` sets — and
§10.2 puts five more responsibilities in it.** Subscribing to the source, owning
`geometryRef`, owning `historyIntent`, the band routing table and the 16 ms
coalescer are ~70 lines that would push the file past a threshold this repo
states as "超过即按职责拆分到新模块". The routing is also the most testable part
of the feature and does not want to be inside a 1000-line component. **Fixed in
§10.1 (new `ui/use-wheel-routing.ts`) and §10.2.**

**P1-8 · Default-on silently changes text selection for every existing user,
with no notice anywhere they will see it.** R-3 rates "native text selection now
needs Shift+drag" at *high* likelihood and mitigates it with a README paragraph
and a help-overlay row — documentation a user consults *after* forming the belief
that copy/paste is broken. This is the one behaviour change that touches people
who never scroll with the wheel at all. §6's "no toast on wheel" reasoning is
about per-notch chatter and does not extend to a single first-run notice.
**Fixed in §6 (one-time notice, `mouseNoticeSeen` persisted flag) and §7.**

**P1-9 · §5.7's resolution-order claim is false, and the env parser is
ambiguous.** "Resolution order matches every other boolean in `load.ts`: flag →
env → file → default" does not describe `hints`, which is `flags.hints !== undefined
? flags.hints : file.hints ?? DEFAULT_CONFIG.hints` (`load.ts:206`) and reads no
env at all. Only `fullscreen` has an env layer, and it has it because
`resolveFullscreen` (`load.ts:88-99`) exists to provide one. Follow `hints` and
`ARAGON_MOUSE` is documented but dead. §5.7 also lists eight accepted env values
without saying which of `env.ts`'s two incompatible parsers applies — the
positive list used for `ARAGON_FULLSCREEN` (`'1'|'true'|'on'|'yes'` ⇒ true, else
false) or the negative-list `envBool` used for the log section (anything not
`'0'|'false'|'off'|'no'` ⇒ true). They disagree on `ARAGON_MOUSE=disable`.
**Fixed in §5.7 and §10.2.**

### P2 — recorded, and applied where it was free

**P2-1 · `Gutter` already means something else in this codebase.**
`ui/layout/Gutter.tsx` is the two-column left rail every transcript entry sits
in, with an invariant of its own (I-2, `flexShrink={0}`). A second component
called a gutter, on the opposite edge, for an unrelated purpose, is how a
codebase loses the ability to say what it means. Renamed throughout to
`ScrollIndicator` / `showScrollIndicator` / `MIN_INDICATOR_COLS`.

**P2-2 · `scrollTrack` / `scrollThumb` duplicate `railVertical` / `gaugeFull`
byte-for-byte in both tiers.** Kept anyway — `glyphs.ts`'s own header mandates
"add a field here instead" and semantic fields are what make the ASCII tier
reviewable — but §4.8 now says so, because the alternative is a future reader
"deduplicating" them and coupling the scroll thumb to the context gauge.

**P2-3 · §4.6's `setOverlayScroll(n ± 3)` drops the clamp the keyboard branch
has.** `App.tsx:645` and `:657` both write `Math.max(0, …)`. Applied in §4.6.

**P2-4 · `top: 1` is asserted rather than derived.** It is true today, and the
reason is not obvious: it holds *because* the full-screen transcript renders no
`<Static>` (`Transcript.tsx:176-187`). Recorded in §4.5 as a named dependency, so
that whoever reintroduces `<Static>` finds out here rather than from a bug report
about the wheel being off by a row.

**P2-5 · §5.1 decodes `dir` before dropping horizontal wheels.** Button 66
(wheel-left) has `b & 1 === 0` and would read as `'up'`. The order is now
explicit.

**P2-6 · §8.2's integration tests rest on `measureElement` working under
`ink-testing-library`,** which no existing test in this package exercises. §8.2
now injects geometry through a test-only seam so a routing regression fails as a
routing failure rather than as a measurement flake.

**P2-7 · The filter never ends its `PassThrough`.** Added to §4.2: `'end'` on the
real stream ends the wrapper, so a closed stdin still terminates Ink's reader.

**P2-8 · "README" is ambiguous in a two-README repo.** The keybindings table is
`packages/cli/README.md:112`, and the full-screen scrolling paragraph is at
`:133`; the root `README.md` has neither. Named in §6 and §10.2.

**P2-9 · I-6's margin is derivable, not merely clamped.** With `popupMaxRows =
max(1, viewportRows(rows) - 4)` (`App.tsx:933`), measured bottom chrome is at
most `rows - 6` against a frame of `rows - 1`, so at least five content rows
survive the worst case. Recorded in §4.5 — a clamp that is never reached is a
much better guard than one that is load-bearing.

---

## 1. Overview

Today, in full-screen mode, **rolling the mouse wheel anywhere on the screen
recalls prompt history into the composer**. Wheel-up over a tool card in the
middle of the transcript silently replaces the message the user was typing with
an old prompt; wheel-down replaces it again, or clears it. Nothing scrolls. The
user's mental model ("the wheel scrolls what is under the pointer") is violated
in the most destructive way a text UI can manage: it edits their draft.

The cause is not a bug in any one file — it is a missing input channel. `aragon`
takes over the alternate screen buffer (`ui/screen.ts::enterAltScreen`,
`\x1b[?1049h`). In the alternate screen there is no native scrollback, so every
modern terminal (xterm, Windows Terminal, VTE, iTerm2, WezTerm, Kitty, Alacritty)
turns on *alternate scroll mode* — DEC private mode **1007** — which translates
each wheel notch into a burst of arrow-key escape sequences, typically three
`\x1b[A` or `\x1b[B` per notch. Ink parses those into `key.upArrow` /
`key.downArrow`, `PromptInput`'s handler claims them
(`ui/PromptInput.tsx:418-425` → `verticalOrHistory` → `recallUp` / `recallDown`),
and history recall happens. The arrow-key channel carries **no pointer
position**, so no amount of re-ordering the keyboard handlers can tell "the
pointer was over the transcript" from "the pointer was over the input box". The
information the requirement asks us to route on simply is not in the stream.

This design adds that channel. In full-screen mode on a TTY the CLI enables SGR
mouse reporting (`\x1b[?1000h\x1b[?1006h`), filters the resulting mouse escape
sequences **out of stdin before Ink ever parses them**, and routes each wheel
event by the row it happened on: rows belonging to the transcript scroll the
transcript (three lines per notch, one page with `Shift`), rows belonging to the
bottom chrome step prompt history exactly as `↑` / `↓` do today, and rows
belonging to an open overlay scroll that overlay. Alongside the routing, the
viewport grows a slim, always-reserved scroll-position indicator so that "where am
I in this conversation" is answerable at a glance rather than only from the status
bar's `↑N` counter. Every failure mode — no SGR support, mouse events dropped by
the platform, `--no-mouse`, a measurement that has not happened yet — degrades to
*the wheel does nothing*, never to *the wheel edits the draft*.

Scope is deliberately narrow. Inline mode (`--no-fullscreen`) is byte-for-byte
untouched: there the terminal's own scrollback already does the right thing and
enabling mouse reporting would take it away. The headless paths (`-p`, piped
stdin, `aragon config …`, `aragon skills …`) never render Ink and never see any
of this.

---

## 2. Goals, non-goals, and the invariants that outrank both

### 2.1 Goals (traceable to the request)

| # | Requirement (verbatim) | Where it is satisfied |
|---|---|---|
| G1 | 在上方 Agent 执行区域，滚动的时候，应该能够正确滚动查看 Agent 历史执行情况和相关内容 | §4.6 `'content'` band → `ScrollViewport` intents |
| G2 | 在输入框区域上下滚动，才是对应的输入框的历史记录查看和切换 | §4.6 `'composer'` band → `PromptInput.historyIntent` |
| G3 | 美观，优雅，顶级设计，符合人机交互最佳实践 | §4.8 scroll indicator, §4.7 wheel physics, §6 UI details + §6.1 first-run notice, §4.4 fail-safe ladder |

### 2.2 Non-goals

- **Clickable UI.** No click-to-focus, click-to-expand-a-tool-card, drag-select,
  or link handling. Non-wheel mouse reports are parsed only so they can be
  *discarded* without leaking into the composer.
- **Horizontal scrolling.** Wheel-left / wheel-right (SGR buttons 66/67) are
  consumed and dropped.
- **Mouse support in inline mode.** Explicitly rejected — see D-2.
- **A settings-screen row for the new toggle.** `--no-mouse`, `ARAGON_MOUSE=0`
  and `aragon config set mouse false` are the three channels; the settings
  overlay stays as it is (it is already at its row budget).
- **Bracketed paste.** Unrelated, and not made harder by anything here.

### 2.3 Invariants (each gets a named test in §8)

| ID | Invariant | Failure if violated |
|---|---|---|
| **I-1** | No byte of a mouse escape sequence ever reaches Ink's key parser. | `[<64;40;12M` is typed into the user's message. |
| **I-2** | Mouse reporting is disabled on **every** exit path, before leaving the alternate screen. | The user's shell prints `[<0;12;5M` garbage on every click, forever, until `reset`. |
| **I-3** | A wheel event over the content band never mutates the composer buffer. | The reported bug, unfixed. |
| **I-4** | A wheel event over the composer band never moves the transcript. | G2 unfixed; the user chases a moving target. |
| **I-5** | With `mouse` disabled or in inline mode, not a single new byte is written to stdout and the real `process.stdin` is handed to Ink unwrapped. | An opt-out that is not an opt-out; regression risk for every existing user. |
| **I-6** | The composer band can never occupy the whole frame; at least one content row always survives a bad measurement. | The transcript becomes unscrollable with no visible cause. |
| **I-7** | `dispose()` removes the filter's stdin listener and unrefs the stream. | `aragon` hangs on exit instead of returning to the shell. |
| **I-8** | Mouse reporting is never enabled unless a live filter is already installed between the real stdin and Ink. | Every wheel notch **and every click** types `[<0;12;5M` into the composer — I-1 violated, and worse than the bug being fixed (P0-1). |
| **I-9** | A nonce-keyed intent effect never applies its intent on the mount that first observes it. | Remounting the composer or the viewport replays the last wheel gesture with nothing behind it (P1-4). |

---

## 3. Root-cause analysis (why the obvious fixes do not work)

Four alternatives were considered and rejected before the design below.

**A. Just stop `PromptInput` from recalling history on bare `↑`/`↓`.**
Rejected: `↑`/`↓` history recall is a keyboard feature users rely on
(`README.md` keybindings table, `HelpOverlay.tsx:33`). Removing it to fix a mouse
problem trades one regression for another, and still leaves the wheel doing
*something wrong* (moving the cursor between draft lines).

**B. Disable alternate scroll only (`\x1b[?1007l`) and stop there.**
This kills the destructive half of the bug in one line, and it is retained as the
**fallback** (§4.4). It cannot be the whole answer: with 1007 off and no mouse
reporting, the wheel does nothing at all, which fails G1 outright.

**C. Heuristically detect wheel bursts** (three `↑` within N ms ⇒ scroll).
Rejected. It is unfalsifiable from inside the app (a user holding `↑` produces the
same shape at the OS key-repeat rate), the burst size is terminal-dependent, and
it *still* cannot answer G2 because it has no pointer position. Guessing wrong
here re-introduces exactly the draft-clobbering the feature exists to remove.

**D. Ask Ink for mouse support.** Ink 5.2.1 has none: `parse-keypress.js` has no
mouse branch at all, and `hooks/use-input.js` hands `keypress.sequence` to the
app after stripping one leading `\x1b`. Traced concretely, an SGR wheel report
`\x1b[<64;40;12M` fails Ink's `fnKeyRe`, arrives at every `useInput` consumer as
the string `[<64;40;12M`, passes `PromptInput`'s `isControlSeq` guard (first char
`[` is 0x5B, ≥ 0x20), and is **inserted into the buffer**. This is why the filter
in §4.2 is not optional polish: enabling mouse reporting without it converts a
draft-clobbering bug into a draft-corrupting one.

---

## 4. Technical design

### 4.1 Data flow

```
                    ┌───────────────────────── full-screen + TTY + mouse enabled ─────────────────────────┐
                    │                                                                                     │
  process.stdin ───▶│  MouseFilter (input/stdin-mouse-filter.ts)                                          │
   (raw, utf8)      │    splitMouseEvents()  ──▶ wheel events ──▶ MouseSource.subscribe()                 │
                    │            │                                        │                               │
                    │            └────────────▶ remaining text ──▶ PassThrough ──▶ render({ stdin })      │
                    └─────────────────────────────────────────────────────┼───────────────────────────────┘
                                                                          ▼
                                                      App: onWheel(e)  ── hitTestWheel(e.y, geometryRef.current)
                                                                          │
                        ┌─────────────────────────────────────────────────┼──────────────────────────────────┐
                        ▼                                                 ▼                                  ▼
              overlay open + 'content'                          'content' (no overlay)                 'composer'
              setOverlayScroll(±3 | ±page)                 setScrollIntent({lineUp|lineDown,           setHistoryIntent({up|down, nonce})
                                                            repeat:3}) / {pageUp|pageDown}                    │
                                                                          │                                  ▼
                                                                          ▼                    PromptInput effect → popup sel ↑↓
                                                                  ScrollViewport                    or verticalOrHistory()
```

Geometry flows the other way, once per layout change and with **zero re-renders**:

```
AppShell (useLayoutEffect, measureElement)  ──writes──▶  geometryRef.current  ──read at event time──▶  App.onWheel
```

### 4.2 Getting mouse events without breaking Ink

Ink 5.2.1 owns stdin in a way that forbids a second reader.
`components/App.js:131-138` subscribes to `'readable'` and drains with
`stdin.read()`. Attaching our own `'data'` listener to the same
`process.stdin` would switch the stream to flowing mode and race Ink's `read()`
for chunks — some keystrokes would reach Ink, some would not, non-deterministically.

Therefore the filter **replaces** the stream Ink is given:

1. `createMouseFilter(process.stdin)` builds a `PassThrough` and copies the
   surface Ink requires onto it: `isTTY` (a getter delegating to the real
   stream — Ink's `isRawModeSupported()` reads it), `setRawMode`, `ref`, `unref`
   (delegating when present, no-op otherwise). Ink calls `setEncoding('utf8')`
   on it itself; we also call `setEncoding('utf8')` on the **real** stream so
   Node's `StringDecoder` handles multi-byte boundaries for us.
2. The filter attaches `real.on('data', …)`, runs `splitMouseEvents` over
   `pending + chunk`, writes the non-mouse remainder into the `PassThrough`, and
   emits wheel events to subscribers.
3. `render(<App/>, { stdin: filter.stdin, … })` in `cli.tsx`.
4. `filter.dispose()` after Ink exits: remove the listener, clear the flush
   timer, `real.pause()` and `real.unref?.()` (**I-7** — a live `'data'`
   listener on stdin keeps the event loop alive and `aragon` would never exit).
   `dispose()` is idempotent and is called from both the `.then()` and the
   `.catch()` of `waitUntilExit()` (`cli.tsx:321-329`) — the two paths Ink can
   leave by. The signal path does not need it: it calls `process.exit()`.
5. `'end'` (or `'close'`) on the real stream ends the `PassThrough`, so a closed
   stdin still terminates Ink's reader instead of leaving it waiting on a stream
   that will never produce another byte (P2-7).

When mouse support is off (config, inline mode, non-TTY) **no filter is
created** and `render` is called exactly as it is today (**I-5**).

#### Ordering: build the filter, then enable reporting (I-8, P0-1)

The two acts are one act, and the order is not negotiable:

```
const filter = mouseEnabled ? tryCreateMouseFilter(process.stdin) : null;
//                       ↑ may return null; nothing has been written to stdout yet
screen = enterAltScreen(process.stdout, { mouse: filter !== null });
//                       ↑ the ONLY place ?1000h/?1006h is written, and it is
//                         now a function of whether the filter exists
const instance = render(<App mouseSource={filter?.source} … />,
                        { stdin: filter?.stdin ?? process.stdin, … });
```

`tryCreateMouseFilter` wraps `createMouseFilter` in a `try/catch` and returns
`null` on any throw, logging `mouse_filter_failed` at `warn`. There is no window
in which the terminal is reporting and Ink is holding the raw stream, and there
is no path on which a construction failure leaves reporting on: the failure
degrades to rung 3 of §4.4, which is a supported, tested state.

`enterAltScreen` must **not** derive `mouse` from config, env or platform on its
own. It is given a boolean whose only meaning is "a filter is installed", and the
`AltScreenOptions` doc comment says so — otherwise a later refactor that moves
the config read into `screen.ts` re-creates the gap this rule closes.

#### Chunk-boundary handling

A wheel report can, in principle, be split across two `'data'` chunks (ConPTY
does split writes). `splitMouseEvents` returns a `pending` tail whenever the
buffer ends in a *strict prefix* of a possible mouse sequence, and the filter
holds it until the next chunk. Two bounded safety valves:

- `MAX_PENDING_MOUSE_CHARS = 32` — anything longer is flushed as text, so a
  malformed sequence can never wedge input.
- A `12 ms` flush timer (`.unref()`-ed) drains the pending tail if no further
  data arrives. This is what stops a lone `\x1b` (the Esc key, which aborts a
  run) from being held hostage: worst-case Esc latency becomes 12 ms.

Because the only prefixes we hold are `\x1b`, `\x1b[`, `\x1b[<…`, and
`\x1b[M…`, ordinary typing and pasted text are never buffered: paste chunks
contain no `\x1b[<`.

### 4.3 Turning reporting on and off

`ui/screen.ts` is already the single owner of screen-control writes and of the
idempotent `restore()` that four independent exit paths call
(`cli.tsx:276-302`: `process.on('exit')`, `setScreenRestore` for the crash
handler, `setSignalTerminator` for signals, and `waitUntilExit().then/catch`).
Mouse enable/disable rides **inside that same handle** — this is the whole of
**I-2**, and it is why the sequences must not be written from `App.tsx`, which
is not on the signal path.

| Situation | Written on enter | Written on `restore()` (before `\x1b[?1049l`) |
|---|---|---|
| full-screen, mouse **on** | `\x1b[?1000h\x1b[?1006h` | `\x1b[?1006l\x1b[?1000l` |
| full-screen, mouse **off** | `\x1b[?1007s\x1b[?1007l` | `\x1b[?1007r` |
| inline / non-TTY | nothing | nothing |

The mouse-off row **saves** alternate scroll before turning it off (`XTSAVE`,
`CSI ? 1007 s`) and **restores** the saved value on the way out (`XTRESTORE`,
`CSI ? 1007 r`) rather than unconditionally writing `?1007h` (P1-6). 1007 is
global terminal state that this app does not own: a user who deliberately turned
it off in their terminal config must not have it switched back on by running
`aragon --no-mouse` once. A terminal that implements neither sequence ignores
both, which leaves it exactly where the previous design's `?1007l` would have —
so the fallback is no worse and the correct case is correct.

The mouse-**on** row deliberately does not touch 1007 at all. Alternate scroll is
defined to translate the wheel only while no application is tracking the mouse,
so `?1000h` already suppresses it; writing `?1007l` as well would be a second
mutation of shared state for no observable gain.

`?1000h` is *normal tracking* (press/release), which is the minimum mode that
reports wheel buttons; `?1006h` selects SGR encoding so coordinates are decimal
text rather than raw bytes above 0x7F (which `setEncoding('utf8')` would mangle).
Motion tracking (`?1002h` / `?1003h`) is deliberately **not** enabled: it floods
stdin on every pointer move and buys nothing we use.

The mouse-off row is the fallback promised in §3-B: a user who opted out still
gets "the wheel is inert" rather than "the wheel eats my draft". `?1007h` is
restored on the way out rather than left off, because 1007 is terminal-global
state and other TUIs the user runs in the same window depend on it.

### 4.4 The fail-safe ladder

Ordered from best to worst, every rung is silent and none of them can reach the
draft-clobbering behaviour:

1. **Mouse events arrive** → full region routing (G1 + G2).
2. **Terminal accepted the mode but the platform drops the events** (see R-1) →
   1007 is off because the terminal believes an app wants mouse data, so the
   wheel is inert; `PgUp`/`PgDn` and `Shift+↑/↓` still scroll.
3. **`--no-mouse` / `ARAGON_MOUSE=0` / `mouse: false`** → 1007 off, wheel inert.
4. **Inline mode / non-TTY** → nothing written, native scrollback as today.

### 4.5 Frame geometry (where is the composer?)

The arithmetic in `layout/budget.ts` describes the *planned* chrome, but the
actual bottom chrome grows and shrinks at run time: the toast row appears and
disappears, the hint row is dropped below `HINT_MIN_ROWS`, and the autocomplete
popup adds up to nine rows. Routing off the plan would put the boundary in the
wrong place exactly when a popup is open — the moment precision matters most.

So the boundary is **measured**, using the mechanism `ScrollViewport` already
uses (`measureElement` inside `useLayoutEffect`, which runs after Ink's yoga pass
in `onRender`). `AppShell` gains a `ref` on its existing bottom-chrome `<Box>`
and writes the measurement into a **mutable ref object** owned by `App`:

```
row 1                    ┌──────────────────────────────┐  header (constant 1 row, §4.2 of the frame spec)
row 2 … 1+viewportRows   │  transcript / overlay        │  ← band 'content'
                         ├──────────────────────────────┤
                         │  toast                       │  ┐
                         │  ╭──────────────────────────╮│  │
                         │  │ > message…               ││  ├─ measured `bottom` → band 'composer'
                         │  ╰──────────────────────────╯│  │
                         │  ⏎ send · / commands · …     │  │
frameHeight(rows)        │  status bar                  │  ┘
row `rows`               └──────────────────────────────┘  (undrawn; frameHeight(rows) = rows - 1)
```

Writing to a ref in a layout effect causes **no re-render**, so this adds zero
frames to the streaming path, and the router reads the freshest value at the
instant the wheel turns. Ordering hazard to respect in `AppShell`: the hook must
be declared *above* the existing `if (mode === 'inline') return …` early return,
or React's hook order changes between modes.

**`top = 1` is a derived fact with a named dependency (P2-4).** It holds because
the full-screen transcript renders **no `<Static>`** (`Transcript.tsx:176-187`),
and Ink's `log-update` writes `output + '\n'` for a frame of `frameHeight(rows) =
rows - 1` lines: `rows` lines are written into a `rows`-row buffer, nothing
scrolls, and the frame occupies rows `1 … rows-1` with the cursor parked on the
undrawn last row. Reintroducing `<Static>` into the full-screen path would push
the frame down the screen and silently bias every hit test; whoever does that must
change `top` here at the same time.

**Staleness is closed by resetting, not by guessing (P1-5).** `AppShell` is not
always what renders: `App.tsx:845` returns a "terminal too small" placeholder
before it whenever `rows < MIN_FULLSCREEN_ROWS`, and the inline branch never
measures anything. `App` therefore writes `UNMEASURED_GEOMETRY` into the ref on
every render path that does not render the full-screen frame, so a shrink-then-wheel
sequence routes to `'content'` (harmless) instead of to a band computed from a
frame that is no longer on the screen. There is no arithmetic fallback: the v1
`fallbackBottomRows` is **removed**, because `budget.ts` arithmetic is wrong
exactly when the autocomplete popup is open, which is the entire argument of D-5.

`hitTestWheel` is pure and lives in `layout/regions.ts`:

- `height <= 0` (nothing measured yet, e.g. the very first frame, or the ref was
  reset) → `'content'`. Fail toward the action that cannot destroy anything
  (**I-3**).
- `y` is clamped into `[top, top + height - 1]`, so the one undrawn bottom row
  and any off-by-one from a terminal that reports 0-based rows still land on a
  real band instead of being dropped.
- `bottom` is clamped to `[0, height - 1]` — at least one content row always
  survives (**I-6**).
- `y >= top + height - bottom` → `'composer'`, else `'content'`.

The `bottom` clamp is a backstop that should never fire, and that is checkable
rather than hopeful (P2-9): the popup is already capped at `viewportRows(rows) - 4`
(`App.tsx:933`), so the measured chrome is at most `1 (toast) + (rows-12) (popup)
+ 4 (composer) + 1 (status) = rows - 6` against a frame of `rows - 1`. At least
five content rows survive the worst case the layout can produce. If a future
change lets the popup grow past that cap, the clamp keeps the wheel usable and
`regions.test.ts`'s I-6 case keeps saying so.

The header row is intentionally part of `'content'`: scrolling over chrome that
sits directly above a scrollable region should scroll that region (the same
convention every GUI list uses), and it is the harmless direction.

### 4.6 Routing table

Read at event time from `stateRef.current.overlay` (which `App` already
maintains for the keyboard handler) plus the band from §4.5:

| Overlay | Band | Modifier | Action |
|---|---|---|---|
| none | `content` | — | `scrollBy('lineUp' \| 'lineDown', repeat = 3)` |
| none | `content` | `Shift` | `scrollBy('pageUp' \| 'pageDown', repeat = 1)` |
| none | `composer` | any | `historyIntent = { dir, nonce+1 }` — one step per notch |
| `help` / `settings` / `plan` | `content` | — | `setOverlayScroll((n) => Math.max(0, n ± 3))` |
| `help` / `settings` / `plan` | `content` | `Shift` | `setOverlayScroll((n) => Math.max(0, n ± OVERLAY_PAGE))` |
| `model` / `confirm` / `question` | `content` | any | ignored (they own their own keys — the same reasoning as `App.tsx:643`) |
| any overlay | `composer` | any | ignored (the composer is inactive behind an overlay; stepping a hidden draft is worse than doing nothing) |

Mirrors of the keyboard handler's two documented ordering rules: the overlay
branch is evaluated **first**, and it returns for every band it recognises.

The `Math.max(0, …)` is not decoration (P2-3): the keyboard branch writes it at
`App.tsx:645` and `:657`, and `OverlayFrame` only reports a clamp *downward*
through `onScrollClamp` (`OverlayFrame.tsx:114-117`). A negative offset is a state
the overlay cannot correct on the user's behalf.

### 4.7 Wheel physics (why 3 lines up but 1 history step down)

A physical notch produces **one** SGR report, whereas alternate-scroll produced
three arrow keys. The two bands therefore need different gains:

- **Transcript:** 3 rows per notch, matching the terminal's own convention and
  the muscle memory users bring from every other full-screen app.
- **Composer:** exactly **one** history step per notch. Multiplying here would
  make a single flick jump three prompts back — unusable, and destructive when
  the draft is in play.

Bursts are handled differently for the same reason. Transcript events are
**coalesced** in a `16 ms` window into one intent carrying `repeat = 3 × notches`
(one `setState`, one render, no matter how fast the wheel spins — the same
technique as the existing `COALESCE_MS = 33` streaming coalescer). Composer
events are **not** coalesced: they are inherently rate-limited by the human, and
each must produce its own visible history step. The accumulator flushes
immediately when the band or the direction changes, so a fast up-then-down never
cancels itself out into a no-op.

#### The flush must re-check the overlay (P1-3)

A deferred `setScrollIntent` is a deferred write to a component that may not be
mounted when the timer fires. `App.tsx:889` swaps `ScrollViewport` out for the
overlay, and `ScrollViewport`'s `useEffect([intentNonce])` fires once on
**remount** — the exact mechanism `App.tsx:633-638` documents as R-P1-7, where a
`PgUp` that fell through to `scrollBy()` while an overlay was open made the
transcript jump a page by itself when the overlay closed. A 16 ms window is more
than wide enough for an agent-raised `confirm` or an `ask_user` to land inside it.

Two rules, both cheap:

1. **The flush re-reads `stateRef.current.overlay` and drops the accumulator if
   an overlay is open.** The decision belongs at flush time, not at event time,
   because the event-time decision is the one that goes stale.
2. **Opening or closing an overlay clears the accumulator and its timer.** `App`
   already has an effect keyed on `state.overlay` (`App.tsx:601-603`, the one
   that resets `overlayScroll`); the reset rides along there rather than adding a
   second subscriber to the same transition.

The same reasoning does not apply to `historyIntent`, which is not deferred — but
it does need I-9; see §5.6.

### 4.8 The scroll indicator (G3)

> **Naming (P2-1).** v1 called this a "gutter". `ui/layout/Gutter.tsx` is already
> the two-column left rail every transcript entry sits in, and it carries an
> invariant of its own. Two components called a gutter, on opposite edges, for
> unrelated purposes, is how a codebase stops being able to say what it means.
> The component is `ScrollIndicator`, the prop is `showScrollIndicator`, and the
> width floor is `MIN_INDICATOR_COLS`.

Wheel scrolling without a position indicator is a half-finished affordance: the
user learns *that* they moved but not *how far* or *how much is left*. The status
bar's `↑N` (`StatusBar.tsx:155-159`) answers neither. `ScrollViewport` therefore
gains a one-column indicator on its right edge, drawn from a pure geometry
function:

```ts
thumbRange(viewportRows, contentRows, offsetFromBottom): { start, size } | null
```

- returns `null` when `contentRows <= viewportRows` (nothing to indicate);
- `size = clamp(round(viewport² / content), 1, viewport)`;
- `start = round(hiddenAbove / overflow × (viewport − size))`, where
  `hiddenAbove = overflow − offset` — the same "offset counts from the bottom"
  convention `scroll.ts` documents at the top, which is exactly the place this
  gets inverted by accident.

**The column is reserved unconditionally** (track glyph when there is no
overflow, thumb when there is). Showing it only while scrolled would change the
content width, re-wrap every line, change the content height, and feed that back
into the measurement that decides whether to show it — a shimmer at the exact
moment the user is reading. Constant width, no feedback loop. The indicator is
suppressed entirely below `MIN_INDICATOR_COLS = 50`, where a column is worth more
than the affordance.

Glyphs go through `ui/glyphs.ts` like every other non-ASCII character in
`src/ui/**` — `glyphs.test.ts` runs a static scan that fails the build on a bare
literal anywhere else:

| field | Unicode | ASCII |
|---|---|---|
| `scrollTrack` | `│` | `|` |
| `scrollThumb` | `█` | `#` |

These two are byte-for-byte identical to the existing `railVertical` and
`gaugeFull` in both tiers, and that is deliberate (P2-2). `glyphs.ts`'s own header
says "adding a third exception means the guard rail stops guarding — add a field
here instead", and semantic field names are what make the ASCII tier reviewable
at a glance. Reusing `gaugeFull` would couple the scroll thumb to the context-window
gauge, so that restyling one silently restyles the other; this note exists so the
duplication is not "cleaned up" later.

### 4.9 Sequence: one wheel-up over a tool card, mid-stream

1. Terminal sends `\x1b[<64;37;9M` (button 64 = wheel up, col 37, row 9).
2. Filter's `'data'` handler runs `splitMouseEvents`; text out is `''`; one
   `WheelEvent { dir: 'up', x: 37, y: 9, shift: false }` is emitted. **Ink sees
   nothing** (I-1).
3. `App.onWheel` reads `geometryRef.current = { top: 1, height: 29, bottom: 7 }`
   → boundary row is `1 + 29 − 7 = 23`; `9 < 23` → band `'content'`.
4. No overlay → accumulator `+3` lines up, `16 ms` timer armed.
5. Timer fires → `setScrollIntent({ kind: 'lineUp', repeat: 3, nonce: n+1 })`.
6. `ScrollViewport`'s effect (keyed on `nonce` only, per its existing comment)
   folds `applyScrollTimes(prev, 'lineUp', metrics, 3)`.
7. `offset` becomes 3 → follow-mode is off, the `↓3 new lines` hint appears, the
   status bar shows `↑3`, and the indicator thumb moves up. Streaming continues to
   append below without yanking the view (that is what counting the offset from
   the bottom already buys).
8. The user presses Enter later → `pinToBottomNonce` bumps → back to the tail.

---

## 5. Interface design

### 5.1 `input/mouse-events.ts` (new, pure)

```ts
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

export interface MouseSplit {
  /** Wheel events, in arrival order. Non-wheel reports are dropped, not returned. */
  readonly events: WheelEvent[];
  /** Everything that was not a mouse report — forward this to Ink verbatim. */
  readonly text: string;
  /** Trailing strict prefix of a possible report; feed it back in with the next chunk. */
  readonly pending: string;
}

export const MAX_PENDING_MOUSE_CHARS = 32;

export function splitMouseEvents(buffer: string): MouseSplit;
/** True when `s` is a proper prefix of a possible mouse report (never a full one). */
export function isMousePrefix(s: string): boolean;
```

Recognised forms:

| Form | Pattern | Notes |
|---|---|---|
| SGR (`?1006`) | `\x1b[<b;x;yM` (press) / `…m` (release) | the only form we request |
| X10 legacy | `\x1b[M` + 3 chars | defensive: consumed so it cannot leak; coords `code − 32`, accepted only when all three codes ∈ [32, 255] |

Button decoding (`b`), **in this order** — the order is the specification, not a
presentation choice (P2-5):

1. not a wheel report (`(b & 64) === 0`) → consume, emit nothing;
2. horizontal wheel (`(b & 3) >= 2`, i.e. 66 = left, 67 = right) → consume, emit
   nothing. This test must precede step 3: button 66 has `b & 1 === 0` and would
   otherwise decode as `'up'`;
3. `dir = (b & 1) ? 'down' : 'up'` (64 = up, 65 = down);
4. modifiers `shift = b & 4`, `alt = b & 8`, `ctrl = b & 16`.

Non-wheel reports (press/release/drag) are consumed and produce no event.

`isMousePrefix` is exactly `/^\x1B(\[(<[\d;]*|M[\s\S]{0,2})?)?$/` — nothing a
keyboard produces matches beyond `\x1b` and `\x1b[`, which is why the 12 ms
timer is a rare path rather than a latency tax on typing.

### 5.2 `input/stdin-mouse-filter.ts` (new)

```ts
export interface MouseSource {
  /** Returns an unsubscribe function. Multiple subscribers are allowed. */
  subscribe(listener: (event: WheelEvent) => void): () => void;
}

export interface MouseFilter {
  /** Hand this to Ink: `render(<App/>, { stdin: filter.stdin })`. */
  readonly stdin: NodeJS.ReadStream;
  readonly source: MouseSource;
  /** Idempotent. Detaches from the real stdin and clears the flush timer (I-7). */
  dispose(): void;
}

export function createMouseFilter(real: NodeJS.ReadStream): MouseFilter;
```

### 5.3 `ui/screen.ts` (modified)

```ts
export interface AltScreenOptions {
  /**
   * TRUE MEANS "A MOUSE FILTER IS ALREADY INSTALLED", NOT "THE USER WANTS MOUSE
   * SUPPORT" (I-8). This module must never derive the value from config, env or
   * platform: enabling reporting without a filter in front of Ink types every
   * click into the composer (§4.2, P0-1). The only caller is
   * `cli.tsx::runInteractive`, and it passes `filter !== null`.
   */
  readonly mouse: boolean;
}

export function enterAltScreen(
  stdout: NodeJS.WriteStream | undefined,
  options?: AltScreenOptions,   // default { mouse: false }
): ScreenHandle;
```

`ScreenHandle.restore()` keeps its "idempotent, safe from every exit path"
contract and now also emits the disable sequences **before** `\x1b[?1049l`.

Note that the default `{ mouse: false }` is **not** byte-identical to v0.5.1: it
writes the `?1007s` / `?1007l` pair on enter and `?1007r` on restore (§4.3). The
existing `screen.test.ts` case *"writes nothing at all on a non-TTY stdout"*
still passes unchanged (the non-TTY early return is untouched), but the three TTY
cases assert with `toContain` and an occurrence count, so they also pass. AC-8
covers this: the only edits to `screen.test.ts` are additive.

### 5.4 `ui/layout/regions.ts` (new, pure)

```ts
export type WheelBand = 'content' | 'composer';

export interface FrameGeometry {
  /** 1-based row of the frame's first row. 1 in the alternate screen. */
  top: number;
  /** Rows the frame occupies — `frameHeight(rows)`. */
  height: number;
  /** Measured rows of the bottom chrome (toast + composer + status). */
  bottom: number;
}

/**
 * The "I do not know where the frame is" value. `App` writes it into the ref on
 * every render path that does not render the full-screen `AppShell` — the
 * terminal-too-small placeholder (`App.tsx:845`) and inline mode — so a stale
 * measurement can never outlive the frame it described (§4.5, P1-5).
 */
export const UNMEASURED_GEOMETRY: FrameGeometry;   // { top: 1, height: 0, bottom: 0 }

export function hitTestWheel(y: number, geometry: FrameGeometry): WheelBand;
```

There is deliberately **no** `fallbackBottomRows`. v1 declared one and never
called it; an arithmetic fallback derived from `budget.ts` is wrong precisely
when the autocomplete popup is open, which is D-5's entire argument, and routing
one frame to `'content'` after a resize is invisible.

### 5.5 `ui/layout/scroll.ts` (modified — additive)

```ts
/** Fold `applyScroll` `times` times. `times` is clamped to [1, 100]. */
export function applyScrollTimes(
  state: ScrollState,
  intent: ScrollIntent,
  metrics: ViewportMetrics,
  times: number,
): ScrollState;
```

Existing exports and their semantics are unchanged, so `scroll.test.ts` keeps
passing untouched. The clamp is not decoration: `repeat` arrives from a coalesced
burst and an unbounded fold is a free CPU-burn primitive.

### 5.6 Component props (modified)

```ts
// ScrollViewport
intent?: { kind: ScrollIntent; nonce: number; repeat?: number };  // repeat defaults to 1
showScrollIndicator?: boolean;                                     // default false

// AppShell
geometryRef?: React.MutableRefObject<FrameGeometry>;

// Composer  (pure pass-through to PromptInput)
// PromptInput
historyIntent?: { dir: 'up' | 'down'; nonce: number };

// App
mouseSource?: MouseSource;
/** Test-only seam (§8.2): when set, `useWheelRouting` reads this instead of the
 *  measured ref, so a routing test never depends on `measureElement`. */
geometryOverride?: FrameGeometry;
```

`PromptInput` applies `historyIntent` in an effect keyed on the nonce alone
(same pattern and same lint suppression as `ScrollViewport`'s intent effect),
guarded by `isActive`, and it mirrors the keyboard branch exactly: when the
completion popup is open the intent moves the popup selection, otherwise it calls
the existing `verticalOrHistory(dir)`. That reuse is deliberate — it means wheel
and `↑`/`↓` can never drift apart, and the "never clobber an in-progress draft"
guard (`PromptInput.tsx:331`) protects the wheel for free.

**Both nonce-keyed effects must skip the mount that first observes a nonce
(I-9, P1-4).** A `useEffect([nonce])` fires on mount as well as on change, so a
component that mounts while `App` already holds `{ dir: 'up', nonce: 7 }` applies
it immediately, with no gesture behind it. `ScrollViewport` gets away with this
today only because its parent happens to mount it at nonce 0; `PromptInput` does
not — `App.tsx:845` returns the terminal-too-small placeholder *before*
`AppShell`, so shrinking the window mid-wheel and growing it back unmounts and
remounts the whole composer. The implementation is a `useRef<number | undefined>`
seeded from the incoming nonce during the first render and compared before
acting:

```ts
const lastApplied = useRef<number | undefined>(historyIntent?.nonce);
useEffect(() => {
  const current = intentRef.current;
  if (!current || current.nonce === lastApplied.current) return;
  lastApplied.current = current.nonce;
  …apply…
}, [historyIntent?.nonce]);
```

Apply the same guard to `ScrollViewport`'s intent effect while adding `repeat`.
It is the general fix for R-P1-7 and it makes the overlay-swallowing rule in
`App.tsx:633-638` a second line of defence rather than the only one.

### 5.7 CLI / config surface

| Channel | Form |
|---|---|
| flag | `--mouse` / `--no-mouse` (positive declared first, keeping the tri-state shape used by `--fullscreen`, `--hints`, `--plan`) |
| env | `ARAGON_MOUSE` — parsed by the **positive** list, exactly as `ARAGON_FULLSCREEN` is (`env.ts`): `'1' \| 'true' \| 'on' \| 'yes'` ⇒ true, any other non-empty value ⇒ false |
| config file | `"mouse": true` (persisted, default `true`) |
| config set | `aragon config set mouse false` |

**The env parser is named on purpose (P1-9).** `env.ts` contains two mutually
incompatible boolean readers: the positive list used inline for
`ARAGON_FULLSCREEN` / `ARAGON_PLAN`, and the negative-list `envBool` used for the
`log` section (anything not `'0' | 'false' | 'off' | 'no'` ⇒ true). They disagree
on `ARAGON_MOUSE=disable`. `mouse` is modelled on `--fullscreen`, so it uses the
same reader `--fullscreen` uses.

**Resolution needs its own resolver; it does not "match every other boolean".**
That v1 claim is wrong: `hints` is `flags.hints !== undefined ? flags.hints :
file.hints ?? DEFAULT_CONFIG.hints` (`load.ts:206`) and reads **no env at all**.
Only `fullscreen` has an env layer, and only because `resolveFullscreen`
(`load.ts:88-99`) was written to give it one. Copying the `hints` line would ship
`ARAGON_MOUSE` as documented-but-dead. `mouse` therefore gets a `resolveMouse`
alongside `resolveFullscreen`:

```
flag (CliFlags.mouse) → env (env.partial.mouse) → file (file.mouse) → DEFAULT_CONFIG.mouse
```

Unlike `fullscreen`, `mouse` is a plain boolean rather than a tri-state: there
are no heuristics for an explicit `true` to override, so `resolveMouse` is a
four-line `??` chain and not a policy function.

**Four edits in `cli.tsx`, not one (P1-2).** `runConfigSet` is a two-stage
function and v1 named only the first stage:

1. `RawOpts.mouse?: boolean` — commander's parse target;
2. `toFlags()` gains `mouse: opts.mouse` — without this the flag never reaches
   `CliFlags` and `--no-mouse` is inert;
3. `'mouse'` in `CONFIG_SET_KEYS` (`cli.tsx:402`) — this only decides that the
   key is not *rejected*;
4. `case 'mouse': patch.mouse = value === 'true' || value === '1'; break;` in the
   `switch` at `cli.tsx:453`.

Omitting (4) is not a compile error and not a runtime error: the switch falls
through every case, `updatePersistedConfig({})` writes nothing, and the command
prints `Set mouse = false`. The comment at `cli.tsx:415` records that this exact
omission has already happened once in this file, for `density` and `hints`.
`config.test.ts` gets a case that reads the value back (§8.1).

---

## 6. UI details

- **Help overlay** (`overlays/HelpOverlay.tsx::keyRows(times)`) gains two rows,
  placed next to the existing scroll bindings:
  `['Wheel', 'Scroll the transcript (over the input box: prompt history)']` and
  `['Shift+Wheel', 'Scroll the transcript a page']`.
- **`packages/cli/README.md`** (P2-8 — the root `README.md` has no keybindings
  table and is not touched): the table at `:112` gains the same two rows, and the
  full-screen scrolling paragraph at `:133` gains what the wheel does per region,
  that `Shift`+drag is how you select text while an app owns the mouse, and how
  to turn it off.
- **Status bar** is unchanged. `↑N` already communicates "you are off the tail";
  the scroll indicator adds the proportional view and the two together are enough.
- **No toast on wheel.** Scrolling is a continuous, self-evident gesture; a toast
  per notch would be noise. The one place a user could be confused — wheeling
  over the composer with a non-empty draft, where the existing guard makes
  history recall a no-op — is left silent, because that is precisely what
  pressing `↑` does today and consistency beats chattiness.

### 6.1 One first-run notice, because selection changes for everyone (P1-8)

R-3 is rated *high* likelihood and it is the only part of this feature that
reaches users who never touch the wheel: once an app owns the mouse, most
terminals require `Shift`+drag to select text. Shipping that default-on with the
explanation living in a README is asking the user to form the belief "aragon
broke copy/paste" and *then* go looking. The §6 argument against toasts is about
per-notch chatter; it does not extend to a single notice.

So: the **first** session in which mouse reporting is actually enabled pushes one
`notice` entry (the `dispatch({ type: 'notice', … })` channel `useStartupNotices`
already uses, so it lands in the transcript and scrolls away rather than
stealing a row):

> Mouse wheel scrolls the transcript. Hold Shift to select text, or turn it off
> with `aragon config set mouse false`.

Gated on a persisted `mouseNoticeSeen: boolean` (default `false`), set to `true`
by the same `persistConfig` path everything else uses. It fires **after** the
filter is confirmed installed, not merely after the config is read — a user on a
terminal where R-1 fires never sees advice about a mode that is not in effect.
Once. Never again. `--no-mouse` never shows it at all.

---

## 7. Data model

No database, no persisted session state, no wire protocol. The complete set of
new shapes is:

| Shape | Lifetime | Owner |
|---|---|---|
| `WheelEvent` | one event | `mouse-events.ts` → subscribers |
| `MouseSplit` | one chunk | `splitMouseEvents` return value |
| `pending: string` | between chunks, ≤ 32 chars | `MouseFilter` closure |
| `FrameGeometry` | per layout | `App` ref, written by `AppShell` |
| `{ kind, nonce, repeat }` scroll intent | per burst | `App` state → `ScrollViewport` |
| `{ dir, nonce }` history intent | per notch | `App` state → `PromptInput` |
| `ThumbRange \| null` | per render | derived in `ScrollViewport` |

Two new persisted keys on `PersistedConfig` + `DEFAULT_CONFIG`
(`config/schema.ts`), the same two-place pattern as `hints`:

| key | default | read by |
|---|---|---|
| `mouse` | `true` | `resolveMouse` in `load.ts` → `CliConfig.mouse` |
| `mouseNoticeSeen` | `false` | `App`, once, for §6.1 |

`mouseNoticeSeen` is deliberately **not** on `CliConfig` and has no flag, no env
var and no `config set` key: it is bookkeeping for a one-shot notice, not a
preference, and giving it a user-facing channel would invite it to be treated as
one. Existing config files without either key read as the defaults via
`?? DEFAULT_CONFIG.<key>`; no migration and no `CONFIG_VERSION` bump.

---

## 8. Testing & acceptance criteria

### 8.1 New unit tests

`packages/cli/src/__tests__/mouse-events.test.ts`
- `parses an SGR wheel-up report and reports 1-based coordinates`
- `maps button 65 to wheel-down and 64 to wheel-up`
- `decodes shift / alt / ctrl modifier bits`
- `drops horizontal wheel buttons 66 and 67`
- `consumes press / release / drag reports without emitting an event` ← **I-1**
- `keeps surrounding keystrokes in the passthrough text, in order`
- `holds a split report as pending and completes it on the next chunk`
- `flushes as text once the pending tail exceeds MAX_PENDING_MOUSE_CHARS`
- `treats a lone ESC as text, not as a mouse prefix that never resolves`
- `consumes a legacy X10 report rather than leaking it`

`packages/cli/src/__tests__/stdin-mouse-filter.test.ts` (fake stdin: a
`PassThrough` with `isTTY`/`setRawMode`/`ref`/`unref` stubs)
- `forwards ordinary keystrokes byte-for-byte to the wrapped stream`
- `never forwards a mouse report to the wrapped stream` ← **I-1**
- `delegates setRawMode / ref / unref to the real stream`
- `dispose removes the data listener and stops holding the stream open` ← **I-7**
- `dispose is idempotent`

`packages/cli/src/__tests__/regions.test.ts`
- `puts the header row in the content band`
- `puts the last chrome row in the composer band`
- `clamps a row below the frame into the composer band`
- `returns content when nothing has been measured yet` ← **I-3**
- `never lets the composer band swallow the whole frame` ← **I-6**

`packages/cli/src/__tests__/scroll-indicator.test.ts`
- `returns null when the content fits`
- `parks the thumb at the bottom when pinned (offset 0)`
- `parks the thumb at the top at maximum offset`
- `never returns a zero-height thumb, however long the transcript`
- `keeps start + size within the viewport for 1..500 rows of content` (property-ish loop)

`packages/cli/src/__tests__/screen.test.ts` (extend the existing suite —
`fakeStdout()` already collects writes)
- `writes the mouse enable pair only when options.mouse is true`
- `disables mouse reporting before leaving the alternate screen` ← **I-2**
- `restore stays idempotent with mouse enabled`
- `saves and restores alternate scroll rather than forcing it on` ← P1-6
- `writes nothing at all for a non-TTY stdout` ← **I-5** (already present; must
  keep passing unedited)

`packages/cli/src/__tests__/scroll.test.ts` (extend)
- `applyScrollTimes folds N line steps into one result`
- `applyScrollTimes clamps an absurd repeat count`

`packages/cli/src/__tests__/config.test.ts` (extend)
- `mouse defaults to true and honours --no-mouse`
- `config set mouse false writes the key` ← **P1-2**; asserts the value read
  back, not the printed line, because the printed line is what a missing switch
  case still produces

### 8.2 Integration tests (`packages/cli/src/__tests__/mouse-routing.test.tsx`)

Rendered with `ink-testing-library`, a hand-rolled `MouseSource` passed as a prop,
and `geometryOverride` supplying the frame geometry (§5.6), so no real terminal,
no raw mode and **no dependency on `measureElement` under a fake stdout** is
involved (P2-6). `measureElement` is exercised in production by `ScrollViewport`
but by no test in this package; a routing suite that silently depends on it fails
as a measurement flake rather than as the routing regression it is meant to catch.
The measurement itself is covered where it belongs — by the §8.4 manual matrix.

- `a wheel event over the transcript does not change the composer buffer` ← **I-3**
- `a wheel event over the composer band recalls prompt history` ← G2
- `a wheel event over the composer band leaves the transcript offset alone` ← **I-4**
- `a wheel event over an open help overlay scrolls the overlay, not the transcript`
- `a wheel event over the composer is ignored while an overlay is open`
- `a coalesced content burst is dropped when an overlay opens inside the window` ← **P1-3**
- `remounting the composer does not replay the last history intent` ← **I-9 / P1-4**
- `shift+wheel scrolls by a page`
- `renders no indicator column below MIN_INDICATOR_COLS`

`packages/cli/src/__tests__/stdin-mouse-filter.test.ts` also carries the I-8
case, because it is the only invariant whose violation is a *wiring* order rather
than a function's behaviour:

- `enterAltScreen is never asked for mouse:true when the filter failed to build`
  ← **I-8 / P0-1**, asserted on a `runInteractive`-shaped harness with
  `createMouseFilter` stubbed to throw

### 8.3 Acceptance criteria

| # | Criterion |
|---|---|
| AC-1 | In full-screen mode on a supporting terminal, wheeling over the transcript scrolls it 3 rows per notch and leaves the composer buffer byte-identical. (G1, I-3) |
| AC-2 | Wheeling over the composer steps prompt history one entry per notch, exactly as `↑`/`↓` do, including the "do not clobber a draft" guard. (G2) |
| AC-3 | Wheeling over the composer never changes `scrolledLines`. (I-4) |
| AC-4 | After `aragon` exits — normally, via `Ctrl+C`, via `SIGTERM`, or after an uncaught crash — clicking in the host shell prints nothing. (I-2) |
| AC-5 | `aragon --no-mouse` writes no `?1000h`/`?1006h`, hands the real stdin to Ink, and the wheel is inert rather than destructive. (I-5) |
| AC-6 | `aragon --no-fullscreen` behaves exactly as it does today, including native scrollback under the wheel. (I-5) |
| AC-7 | No mouse escape sequence can appear in a submitted message. (I-1) |
| AC-8 | `npm test -w packages/cli` passes with **no existing assertion edited** — every §8.1 change to `screen.test.ts` / `scroll.test.ts` / `config.test.ts` is a new `it()`. |
| AC-9 | The scroll indicator is present at ≥ 50 columns, its thumb is at the bottom when pinned, and it never changes the viewport width as a result of scrolling. |
| AC-10 | No build of the CLI can write `?1000h` unless a mouse filter is installed in front of Ink. (I-8) |
| AC-11 | Running `aragon --no-mouse` once and exiting leaves alternate-scroll mode as it was found, not forced on. (P1-6) |
| AC-12 | `aragon config set mouse false` followed by `aragon config get mouse` prints `false`. (P1-2) |
| AC-13 | The §6.1 notice appears exactly once across two consecutive sessions, and not at all under `--no-mouse`. (P1-8) |

### 8.4 Manual smoke matrix

Produced as `docs/plans/mouse-wheel-region-routing/manual-test.md` by the
implementation node. Per terminal: wheel over transcript, wheel over composer,
`Shift`+wheel, wheel over help overlay, text selection with and without `Shift`,
exit and click in the host shell.

| Terminal | Why it is on the list |
|---|---|
| Windows Terminal (PowerShell 7) | the primary dev environment; ConPTY path |
| Legacy `conhost` (`cmd.exe`) | worst case for both mouse input and Unicode glyphs |
| VS Code integrated terminal | xterm.js; different alternate-scroll defaults |
| iTerm2 / Apple Terminal | SGR reference implementations |
| GNOME Terminal (VTE) | Linux reference |
| `tmux` (mouse off **and** mouse on) | R-2 |
| Over SSH from Windows to Linux | escape-sequence round trip |

---

## 9. Risks & mitigations

| # | Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|---|
| **R-1** | **Node/libuv may not surface mouse reports on Windows consoles.** In raw mode libuv reads console input records; VT input translation is what makes arrow keys work, and whether mouse reports survive that path is version- and console-dependent. | medium | G1/G2 unavailable on some Windows setups — i.e. **the feature does not exist** on the primary support platform | **CLOSED — it fires, and the gate shipped.** Phase 0 finally ran under the `shift-tab-and-mouse-wheel-dead-on-some-terminals` diagnosis; see the row rewritten at §11.0 below. **The independent variable is the NODE VERSION, not the terminal and not an environment variable**: mouse reports need `ENABLE_VIRTUAL_TERMINAL_INPUT`, and Node only sets it in `setRawMode(true)` from v22.17.0 / v24.2.0 (`UV_TTY_MODE_RAW_VT`). The gate is `ui/win-vt-input.ts::supportsWindowsVtInput(platform, nodeVersion)`, folded into `cli.tsx::wantMouse`, so an affected console takes rung 3 of §4.4 (`SAVE_ALT_SCROLL_OFF`, wheel inert) and is told why. **§13-Q1's `WT_SESSION` / `TERM_PROGRAM` heuristic is void** — see that answer, rewritten below. |
| **R-2** | `tmux` with `mouse on` consumes the wheel itself; the app sees nothing. | medium | wheel inert under tmux | Documented in README (`set -g mouse off` to hand it back). No code change — intercepting tmux would be wrong. |
| **R-3** | **Native text selection changes.** While an app owns the mouse, most terminals require `Shift`+drag to select. | high | user surprise, for users who never scroll at all | The **one-time in-app notice** of §6.1 — the mitigation has to reach the user before they form the belief that copy/paste is broken, and a README reaches them only after. Backed by the help-overlay wheel row, the README paragraph, and `--no-mouse`. |
| **R-4** | The terminal is left in mouse-reporting mode after an abnormal exit. | low | garbage on click until `reset` | The enable/disable pair lives inside the same `ScreenHandle.restore()` that already covers all four exit paths (§4.3, I-2), including the crash handler via `setScreenRestore`. |
| **R-5** | Wrapping stdin breaks something subtle in Ink (raw mode, paste, Ctrl+C). | medium | broken input | The wrapper delegates rather than reimplements (`setRawMode`/`ref`/`unref`/`isTTY`), the passthrough is byte-exact for non-mouse data (asserted in §8.1), and the wrapper is **only** created on the full-screen + mouse-on path, so every other path is provably unchanged. |
| **R-6** | A mouse report split across chunks leaks `[<64;…` into the composer. | low | one garbage token | Pending-prefix buffering + `MAX_PENDING_MOUSE_CHARS` + 12 ms flush (§4.2). Directly tested. |
| **R-7** | The `measureElement` write causes a re-render loop. | low | frame churn under streaming | The measurement is written to a **ref**, not to state; there is no setState in that path at all. |
| **R-8** | Terminal does not support SGR (`?1006`), falls back to X10 with byte coordinates > 0x7F that `setEncoding('utf8')` mangles. | very low | wrong band for far-right/low rows | X10 reports are consumed regardless (no leak); coordinates are accepted only when plausible, otherwise the event is dropped. Every terminal that implements `?1000` has implemented `?1006` for over a decade. |
| **R-9** | The indicator column changes wrapping and therefore content height. | low | one-time reflow | Width is reserved unconditionally and never changes with scroll state (§4.8), so the reflow happens once at mount/resize like any other layout constant. |
| **R-12** | A deferred scroll intent lands on an unmounted `ScrollViewport` and is replayed on remount. | medium before the fix | the transcript jumps a page with no gesture behind it — R-P1-7, already paid for once | Two independent guards: the flush re-reads the overlay and the accumulator is cleared on overlay change (§4.7), and the intent effect skips the mount that first observes a nonce (I-9, §5.6). |
| **R-13** | The mouse enable pair is written while Ink still holds the raw stdin. | certain if unordered | every click and notch types `[<0;12;5M` into the composer | Build-then-enable ordering with a `null`-returning constructor (§4.2), `AltScreenOptions.mouse` redefined to mean "a filter exists" (§5.3), I-8, AC-10. |
| **R-10** | A user with a high-resolution / free-spinning wheel generates hundreds of events per second. | low | render storm | 16 ms coalescing on the transcript path, `repeat` clamped to 100, one `setState` per window (§4.7). |
| **R-11** | Overlays that own their own keys (`model`, `confirm`, `question`) get scrolled into an inconsistent state. | low | visual glitch | They are explicitly excluded from the routing table (§4.6), matching the keyboard handler's existing exclusion. |

---

## 10. File / module change plan

### 10.1 New files

| File | Intent |
|---|---|
| `packages/cli/src/input/mouse-events.ts` | Pure SGR/X10 mouse-report parser: `splitMouseEvents`, `isMousePrefix`, `WheelEvent`. |
| `packages/cli/src/input/stdin-mouse-filter.ts` | Stdin proxy that strips mouse reports before Ink and publishes wheel events (`createMouseFilter`, `MouseSource`). |
| `packages/cli/src/ui/layout/regions.ts` | Pure band hit-testing: `hitTestWheel`, `FrameGeometry`, `UNMEASURED_GEOMETRY`. |
| `packages/cli/src/ui/use-wheel-routing.ts` | **New in v2 (P1-7).** The subscription, the band routing table (§4.6) and the 16 ms coalescer (§4.7), as a hook. `App.tsx` is *exactly* at the 1000-line ceiling `CLAUDE.md` sets; this is also the most testable part of the feature and does not belong inside a 1000-line component. |
| `packages/cli/src/ui/layout/scroll-indicator.ts` | Pure thumb geometry: `thumbRange`. |
| `packages/cli/src/ui/layout/ScrollIndicator.tsx` | One-column indicator renderer driven by `thumbRange` + glyphs. Named to avoid the collision with `ui/layout/Gutter.tsx` (P2-1). |
| `packages/cli/src/__tests__/mouse-events.test.ts` | §8.1 parser suite. |
| `packages/cli/src/__tests__/stdin-mouse-filter.test.ts` | §8.1 stream suite + the I-8 wiring case. |
| `packages/cli/src/__tests__/regions.test.ts` | §8.1 hit-test suite. |
| `packages/cli/src/__tests__/scroll-indicator.test.ts` | §8.1 thumb geometry suite. |
| `packages/cli/src/__tests__/mouse-routing.test.tsx` | §8.2 end-to-end routing through a synthetic `MouseSource` + `geometryOverride`. |
| `docs/plans/mouse-wheel-region-routing/manual-test.md` | §8.4 terminal matrix (written by the implementation node). |

### 10.2 Modified files

| File | Intent |
|---|---|
| `packages/cli/src/ui/screen.ts` | `AltScreenOptions` (`mouse` = "a filter exists", §5.3); write the enable pair or the `?1007s`/`?1007l` save-and-disable pair on enter, and the matching disable / `?1007r` inside the idempotent `restore()`. |
| `packages/cli/src/cli.tsx` | **Four config edits, not one (P1-2):** `RawOpts.mouse`, `toFlags`, `'mouse'` in `CONFIG_SET_KEYS` (`:402`), `case 'mouse'` in the `runConfigSet` switch (`:453`). Plus: build the filter **before** `enterAltScreen` (§4.2), pass `filter !== null` as `options.mouse`, pass `stdin` to `render` and `mouseSource` to `<App>`, `dispose()` in both `waitUntilExit()` branches, `--mouse` / `--no-mouse`. |
| `packages/cli/src/ui/App.tsx` | Accept `mouseSource` / `geometryOverride`; own `geometryRef` and `historyIntent`; call `useWheelRouting(…)`; reset the ref to `UNMEASURED_GEOMETRY` on the too-small and inline paths; clear the coalescer in the existing `state.overlay` effect (`:601`); pass `showScrollIndicator` down; push the §6.1 notice. Routing logic itself lives in the new hook — this file is at its 1000-line ceiling. |
| `packages/cli/src/ui/layout/AppShell.tsx` | Add the bottom-chrome `ref` + `useLayoutEffect` measurement into `geometryRef` (hook declared **above** the inline early return). |
| `packages/cli/src/ui/layout/ScrollViewport.tsx` | Honour `intent.repeat` via `applyScrollTimes`; add the I-9 mount-skip to the intent effect; render the reserved indicator column. |
| `packages/cli/src/ui/layout/scroll.ts` | Add `applyScrollTimes` (additive; existing exports untouched). |
| `packages/cli/src/ui/Composer.tsx` | Pass `historyIntent` through to `PromptInput`. |
| `packages/cli/src/ui/PromptInput.tsx` | Apply `historyIntent` in a nonce-keyed effect **with the I-9 mount-skip**, reusing the popup-selection / `verticalOrHistory` branches. |
| `packages/cli/src/ui/glyphs.ts` | Add `scrollTrack` / `scrollThumb` to both tiers (required by the static scan). |
| `packages/cli/src/ui/overlays/HelpOverlay.tsx` | Two new keybinding rows in `keyRows(times)`. |
| `packages/cli/src/config/schema.ts` | `mouse: boolean` on `PersistedConfig` / `DEFAULT_CONFIG` / `CliConfig`; `mouseNoticeSeen: boolean` on `PersistedConfig` / `DEFAULT_CONFIG` only (§7). |
| `packages/cli/src/config/load.ts` | `CliFlags.mouse` + a `resolveMouse` next to `resolveFullscreen` — **not** the `hints` one-liner at `:206`, which reads no env (P1-9). |
| `packages/cli/src/config/env.ts` | `ARAGON_MOUSE`, using the same positive-list parser as `ARAGON_FULLSCREEN`, **not** `envBool` (P1-9). |
| `packages/cli/src/__tests__/scroll.test.ts` | Two additive cases for `applyScrollTimes`. |
| `packages/cli/src/__tests__/config.test.ts` | Two additive cases: default + `--no-mouse`, and `config set mouse` round-trip. |
| `packages/cli/src/__tests__/screen.test.ts` | Four additive cases (§8.1); no existing assertion edited. |
| `packages/cli/README.md` | Keybindings rows at `:112` + full-screen scrolling paragraph at `:133` + selection/`--no-mouse` note. |
| `packages/cli/CHANGELOG.md` | New entry under the next version, calling out the selection change explicitly. |

**Not modified, deliberately:** `agent/**` (no engine change), `ui/Transcript.tsx`
(the viewport scrolls, its children do not care), `ui/StatusBar.tsx` (`↑N` already
says the right thing), `overlays/SettingsScreen.tsx` (no new field), and
everything under `packages/core`.

---

## 11. Implementation order

Each phase compiles, passes `npm test -w packages/cli`, and is independently
revertible.

0. **Prove the premise, in a throwaway (P0-2 — a hard gate, not a step).**
   Before any of the eleven files exists, a ~30-line script that is **not
   committed**: put `process.stdin` in raw mode, write `\x1b[?1000h\x1b[?1006h`,
   print every received chunk as escaped bytes, restore on exit. Run it on
   Windows Terminal (PowerShell 7), legacy `conhost`, and the VS Code integrated
   terminal, and spin the wheel.

   | Outcome | Consequence |
   |---|---|
   | `\x1b[<64;…M` arrives everywhere | proceed with §11.1 onward unchanged |
   | arrives in Windows Terminal / VS Code, not in `conhost` | proceed, and adopt §13-Q1's `win32` gate with the observed env-var signature |
   | arrives nowhere on Windows | **stop.** The design's premise does not hold on the primary platform; escalate rather than building eleven files whose fail-safe is "the wheel does nothing" |

   R-1 is the only claim in this document that cannot be settled by reading the
   codebase, and it is the one the whole feature rests on. Half a day here is
   cheaper than five test suites written against an assumption.

   ### 11.0 · Phase 0, run late — the result (2026-08-08)

   **It ran, seven months after the feature shipped, as part of the
   `shift-tab-and-mouse-wheel-dead-on-some-terminals` diagnosis. Full data and
   the probe scripts are in `docs/diagnoses/shift-tab-and-mouse-wheel-dead-on-
   some-terminals/`.**

   **None of the three rows above describes the answer, and the table's shape is
   why.** All three ask which TERMINAL the user is in. The variable turned out to
   be which **Node** they installed the CLI with: on `win32`, both mouse reports
   and `CSI Z` exist only while the console input handle has
   `ENABLE_VIRTUAL_TERMINAL_INPUT`, and `setRawMode(true)` only sets it from Node
   v22.17.0 / v24.2.0 onward, where `src/tty_wrap.cc` switched to
   `UV_TTY_MODE_RAW_VT`. Before that libuv translates console input records into
   ANSI itself and `continue`s past every record that is not a `KEY_EVENT`, so no
   report can reach the process no matter what `?1000h` asked for.

   Same machine, same terminal, same injected keystrokes, only `node.exe`
   swapped: console mode `0x0008` (Node 20.19.0) vs `0x0208` (Node 22.18.0), and
   `Shift+Tab` yields `09` vs `1b 5b 5a`.

   **Consequence taken:** the third row's instruction ("stop") does not apply,
   because the premise holds on every supported Node and fails only below a
   version boundary that can be tested for. `ui/win-vt-input.ts` is that test;
   `cli.tsx::wantMouse` consumes it, so an affected console lands on rung 3 of
   §4.4 by construction and gets a one-shot notice naming the cause. **Node 20 is
   the current Windows default LTS, so the affected population is the majority of
   Windows installs, not a tail.**

1. **Parser first, no wiring.** `mouse-events.ts` + its test. Nothing observable
   changes.
2. **Geometry.** `regions.ts` + test; `scroll.ts::applyScrollTimes` + test.
3. **Stream.** `stdin-mouse-filter.ts` + test, still not wired into `cli.tsx`.
4. **Screen sequences.** `screen.ts` options + test. Enabling still gated off.
5. **Wire it.** `cli.tsx` (build-then-enable ordering, `mouseSource`, all four
   config edits), `AppShell` measurement, `use-wheel-routing.ts`,
   `PromptInput`/`Composer` history intent, `ScrollViewport` repeat + I-9. First
   runnable end-to-end build — run §8.4 rows 1–3 here.
6. **Scroll indicator.** `scroll-indicator.ts` + `ScrollIndicator.tsx` + glyphs +
   test. Independently revertible: G1/G2 stand without it (§13-Q3).
7. **Docs and the first-run notice.** §6.1 notice + `mouseNoticeSeen`, help
   overlay, `packages/cli/README.md`, CHANGELOG, `manual-test.md`; full §8.4
   matrix.

---

## 12. Design decisions (for the review node to argue with)

| ID | Decision | Rationale | Reversal cost |
|---|---|---|---|
| **D-1** | Enable real mouse reporting rather than heuristically interpreting arrow bursts. | Pointer position is the whole requirement and it exists nowhere else in the input stream (§3-C). | High — it is the feature. |
| **D-2** | Full-screen only; inline mode untouched. | Inline mode's wheel already scrolls native scrollback, which is strictly better than anything we can draw. Enabling mouse there would *remove* working behaviour. | Low. |
| **D-3** | Wrap stdin instead of adding a second listener. | Ink drains stdin with `read()` from a `'readable'` handler; a competing `'data'` listener loses keystrokes non-deterministically (§4.2). | Medium. |
| **D-4** | Enable/disable inside `ScreenHandle`, not in `App`. | `App` is not on the signal or crash path; `restore()` is (§4.3, I-2). | Low. |
| **D-5** | Measure the bottom chrome; do not compute it from `budget.ts`. | The popup and the hint row make the plan wrong exactly when precision matters (§4.5). | Low — the degraded path is "route to `'content'`", which is the harmless band (see D-16). |
| **D-6** | The whole bottom chrome — toast, composer box, hint row, status bar — is one `'composer'` band. | Matches "the input area at the bottom" as users describe it, and a coherent band beats a 1-row-accurate boundary that moves with the toast. | Low. |
| **D-7** | Wheel over the composer reuses `verticalOrHistory`, including its "never clobber a draft" guard. | One code path for wheel and `↑`/`↓` means they cannot drift; the guard is the reason the fix is not itself destructive. | Low. |
| **D-8** | 3 rows/notch for the transcript, 1 step/notch for history. | One SGR report per notch, and the two bands have different natural units (§4.7). | Trivial (constants). |
| **D-9** | Indicator column reserved unconditionally above 50 columns. | Show-on-scroll changes content width → re-wrap → height change → feedback into the visibility decision (§4.8). | Low. |
| **D-10** | `mouse` is a plain boolean, not a `fullscreen`-style tri-state. | There are no heuristics for an explicit `true` to override. | Low. |
| **D-11** | Non-wheel mouse reports are parsed and discarded rather than passed through. | Passing them through is precisely how `[<0;12;5M` gets typed into a message (§3-D, I-1). | Trivial. |
| **D-12** *(v2)* | `AltScreenOptions.mouse` means "a filter is installed", not "the user wants mouse support". | The only way to make I-8 a property of the type rather than of the caller's discipline. A later refactor that moves the config read into `screen.ts` would re-open P0-1 silently. | Trivial. |
| **D-13** *(v2)* | The routing lives in `use-wheel-routing.ts`, not in `App.tsx`. | `App.tsx` is at the 1000-line ceiling `CLAUDE.md` sets, and the routing table is the most testable part of the feature. | Trivial. |
| **D-14** *(v2)* | Alternate scroll is saved/restored (`?1007s` / `?1007r`), never forced. | 1007 is global terminal state this app does not own; §4.3 already gave the reason and then did the opposite. | Trivial. |
| **D-15** *(v2)* | One in-app first-run notice about `Shift`+drag selection. | R-3 is rated *high* and reaches users who never scroll; a README is consulted only after the belief "copy/paste is broken" has formed. Not a per-notch toast — §6's argument does not extend to a one-shot. | Trivial (delete the notice and the flag). |
| **D-16** *(v2)* | No `fallbackBottomRows`; unmeasured routes to `'content'` and the ref is reset when the frame is not rendered. | An arithmetic fallback from `budget.ts` is wrong exactly when the popup is open, which is D-5's argument; one invisible frame is a better failure than a wrong band. | Trivial. |

---

## 13. Open questions — resolved in review

The three questions v1 raised are answered here. None required a redesign.

**Q1 · Should `win32` hard-gate `mouse` off on legacy `conhost`?**
**Answer (v2): the question is premature, and Phase 0 (§11) is what makes it
answerable.** Shipping a `WT_SESSION`/`TERM_PROGRAM` heuristic without data is a
guess in the same class as §3-C's rejected burst heuristic — it would silently
disable a working feature for anyone whose terminal sets neither variable
(`tmux`, `mosh`, some SSH clients, JetBrains' terminal). Run the probe first. If
mouse reports arrive in Windows Terminal and VS Code but not in `conhost`, adopt
the gate **with the env signature the probe actually observed** and write the
observation into the code comment; if they arrive everywhere, ship no gate at
all and let rung 2 of §4.4 handle the unknown. Either way the decision is made
from evidence, one afternoon of work earlier than v1 scheduled it.

> **ANSWERED, AND THE ENV-VAR HEURISTIC IS VOID (2026-08-08, §11.0).** The
> instinct to demand data before shipping a heuristic was right, and the data
> killed the heuristic outright rather than refining it: `WT_SESSION`,
> `TERM_PROGRAM` and every other environment variable were **identical** across
> the working and non-working runs of the controlled experiment. The only
> difference was `node.exe`. A gate keyed on the terminal would therefore have
> been wrong in both directions — disabling the wheel on a `conhost` running a
> new Node, and leaving it enabled in Windows Terminal running Node 20, which is
> precisely the configuration users reported. **The gate that shipped keys on
> `process.versions.node`** (`ui/win-vt-input.ts`); no environment variable is
> read. Q1 as posed — "is legacy `conhost` the discriminator" — is answered no.

**Q2 · Page-scroll or horizontal-scroll for `Shift`+wheel?**
**Answer: page-scroll, as designed, and it is explicitly best-effort.** There is
no horizontal axis to scroll, so the alternative is not a trade — it is nothing.
The one condition attached: `Shift`+wheel must never be the *only* route to any
capability, because terminals that reserve `Shift`+wheel for their own scrollback
will swallow it before we see it. That condition is already met — `PgUp`/`PgDn`
page the transcript from the keyboard and are documented in both the help overlay
and the README. The §8.2 case exercises it through an injected `MouseSource`, so
the binding is verified even on a machine whose terminal eats it.

**Q3 · Is the indicator in scope, or a follow-up?**
**Answer: in scope, as phase 6, and it must stay independently revertible.**
G3 is a stated requirement, not decoration, and "the wheel moves something" with
no position feedback is a worse affordance than the keyboard-only status quo:
the user learns *that* they moved and nothing about *how far*. But it is also the
only part of the feature that costs a column of content and a new component, so
if phase 5's smoke run turns up something that needs the schedule, phase 6 is
where the schedule comes from. The two are already separable — `showScrollIndicator`
defaults to `false` and the routing never reads it.

---

## 14. 评审结论 (Review Verdict)

### 有条件通过 — approved with conditions

This is a good design, and it is good for the reason that matters most in a
review: it identifies the actual seam. The requirement asks for behaviour that
depends on pointer position, the input stream carries no pointer position, and
§3 works through four ways of pretending otherwise before rejecting all of them.
The four alternatives are dismissed on grounds that survive re-derivation — in
particular §3-C's refusal to guess from arrow-key burst shape, which is exactly
the kind of heuristic that ships, works for the author, and produces
unreproducible draft loss for everyone else. Every load-bearing claim about the
codebase and about Ink 5.2.1 was checked against source and is true, including
the two that would have been easiest to get wrong: `isControlSeq`'s threshold,
which is what makes an unfiltered mouse report *insertable*, and Ink's
`'readable'`+`read()` drain loop, which is what makes a second listener
unworkable. The fail-safe ladder in §4.4 is the right shape: every rung degrades
toward *inert*, never toward *destructive*.

Nothing in this review changed the architecture. Two P0s and eight P1s are fixed
in the v2 body above; all of them were gaps between the design and how this
particular codebase behaves, not disagreements about the approach.

The verdict is conditional on four things, none of which is a redesign:

1. **Phase 0 runs, and its result is written down before phase 1 starts.**
   R-1 is the single claim in this document that no amount of reading settles,
   and the design's own worst case if it fails — "the wheel does nothing" — is a
   feature that does not exist on the platform this CLI is developed and
   supported on. A throwaway probe answers it in an afternoon. Building eleven
   files and five test suites first, as v1 scheduled, means finding out at the
   most expensive possible moment. If the probe comes back negative on Windows
   Terminal, this design does not proceed as written; escalate instead.

2. **I-8 lands as wiring order in phase 5, with AC-10 asserted, before any
   `?1000h` is ever written by a build anyone can run.** This is the one finding
   whose failure mode is worse than the bug being fixed: enabling reporting
   without the filter in front of Ink does not degrade the feature, it types
   `[<0;12;5M` into the user's message on every click. It also fails *silently*
   in the only way that matters — there is no exception and no log line, just
   garbage appearing in a draft — so a manual smoke pass on a machine where the
   filter happens to construct successfully cannot substitute for the test.

3. **The two intent-replay guards ship together, not one of them.** §4.7's
   overlay re-check at flush and §5.6's I-9 mount-skip cover different windows —
   a deferred flush into an unmounted viewport, and a fresh mount that inherits a
   nonce — and each on its own leaves the other open. `App.tsx:633-638` is a
   six-line comment explaining that this codebase has already paid for one of
   these once, through the keyboard path; the wheel path opens two more doors to
   the same room.

4. **The §6.1 first-run notice ships in the same PR as the default-on switch,
   not as a follow-up.** R-3 is the only part of this change that touches users
   who will never use the feature, and it removes a gesture (drag to select) that
   is more frequently used than the one being added. A mitigation that lives only
   in a README is not a mitigation for a behaviour the user meets before they
   read anything.

Two things are explicitly **out of scope and stay that way**: motion tracking
(`?1002h` / `?1003h`) in any form — §4.3's reasoning is correct and the moment
this feature starts wanting hover states it needs a new design, not a wider mode
string — and any interpretation of arrow-key bursts as scroll intent (§3-C),
including as a "fallback" for terminals where phase 0 comes back negative. If the
pointer position is not in the stream, the honest answer is the keyboard, not a
guess.

No P0 or P1 concern remains unresolved in this document.

---

## 15. 实施过程发现的方案缺陷 (Issues Found During Implementation)

Written by the implementation node. The architecture held: every module in
§10.1 and §10.2 landed as specified, and none of the findings below changed a
routing decision, an invariant or a public shape. They are places where the
design assumed something about *this repository's* tooling that turned out not
to hold, plus one condition of §14 that an automated node cannot discharge.

### IF-1 · Phase 0 could not be run, and §14 condition 1 is still open

**This is the one finding that matters before release.** §11 phase 0 is a hard
gate, and §14 makes "its result is written down before phase 1 starts" the first
condition of the verdict. It requires physically spinning a wheel inside an
interactive TTY, which an automated implementation node cannot do — there is no
pointer and no human hand at the other end of the pipe.

Phases 1–7 were implemented anyway rather than blocking, on the grounds the
design itself supplies: §4.4's fail-safe ladder guarantees that if R-1 fires the
result is *the wheel is inert*, never *the wheel edits the draft*, and rung 3
(`--no-mouse`) is the same code path a negative probe would make the default. So
the downside of building first is wasted work, not a shipped regression.

**What was delivered instead:** the probe script itself, and a results table to
fill in, as section 0 of `manual-test.md`. **Do not treat this feature as
released until that table is filled in.** If reports arrive nowhere on Windows,
§11's own instruction stands — escalate rather than ship, and the eleven files
are reverted or the default is flipped to `mouse: false`, which is a one-line
change in `config/schema.ts`.

### IF-2 · The `config set` round-trip test could not be written as described

§8.1 asks for `config set mouse false writes the key`, "asserting the value read
back, not the printed line". `runConfigSet` is module-private in `cli.tsx`, and
`cli.tsx` calls `main()` at module scope — importing it from a test would parse
`process.argv` and run the CLI. Exporting it, or moving it to
`config/cli-commands.ts`, is a refactor §10.2 does not call for.

**Resolution:** `config.test.ts` gained a source-text guard in the same spirit as
`glyphs.test.ts`'s `borderStyle` scan. It parses `CONFIG_SET_KEYS` out of
`cli.tsx` and asserts that **every** entry has a matching `case '<key>':`, plus
that the `mouse` case really assigns `patch.mouse` and that `toFlags` carries the
flag through. That covers the whole class P1-2 belongs to rather than one key, so
the next `density`/`hints`-shaped omission fails the build — but it is a static
assertion, not an execution.

**AC-12 was verified by hand against the built CLI**, with `ARAGON_HOME` pointed
at a throwaway directory:

```
$ node dist/cli.js config set mouse false
Set mouse = false
$ node dist/cli.js config get mouse
false
```

`manual-test.md` row 11 keeps it in the release checklist.

### IF-3 · `OVERLAY_PAGE` had nowhere to live without a cycle

§4.6's overlay row needs the constant, and `App.tsx`'s keyboard branch already
owned it as a module-local `const`. `App.tsx` imports `use-wheel-routing.ts`, so
importing the constant back out of `App` would be a circular import, and moving
it to a third module (`layout/overlay-window.ts` is the natural home) means
editing a file §10.2 does not list.

**Resolution:** declared and exported from `use-wheel-routing.ts`; `App.tsx`
imports it. Net change to `App.tsx` is one deleted `const` and one added import,
and there is exactly one definition.

### IF-4 · AC-8 could not be met literally — one existing test's *action* changed

`app.test.tsx::scrolls the help overlay itself with PgDn` hard-codes **two**
PgDn presses to reach the tail of the help content. §6's two new keybinding rows
push the overlay from 43 rows to 45 and `/exit` out of reach of two presses, so
the suite went red on a test that has nothing to do with the wheel.

**No assertion was edited.** The fixed press count was replaced with a bounded
loop that pages until `/exit` appears (max 10). That restores AC-8's intent —
the assertions are untouched and still say the same thing — and removes the
coupling between an unrelated test and how many rows the help content happens to
have, which is what made it fragile in the first place. AC-8 should be read as
"no existing assertion edited" rather than "no existing test file edited".

### IF-5 · `App` reads `mouseNoticeSeen` from `readConfigFile()`, not `loadPersistedConfig()`

§7 deliberately keeps `mouseNoticeSeen` off `CliConfig`, so `App` cannot reach it
through `controller.getConfig()` and has to touch `config/store.js` directly.
`loadPersistedConfig` would have been the obvious choice — and would have broken
`app.test.tsx`, whose `vi.mock('../config/store.js')` provides only
`updatePersistedConfig` / `getSessionsDir` / `getConfigPath` / `readConfigFile`.

**Resolution:** `readConfigFile().config?.mouseNoticeSeen`, which is the same
function the sibling `use-startup-notices.ts` already uses for the same kind of
one-shot check, and is already in the mock. No test file needed a new mock entry.

### IF-6 · The `MIN_INDICATOR_COLS` case cannot run under `ink-testing-library`

§8.2 lists `renders no indicator column below MIN_INDICATOR_COLS` among the
`ink-testing-library` cases. That harness's fake stdout declares `columns` as a
prototype **getter returning a literal 100**, with no setter and no option to
override it, so a narrow terminal is unreachable through it.

**Resolution:** that one case (and its positive twin) uses Ink's own `render`
with a hand-rolled stdout whose `columns` is a plain field. This is also the
only place in the suite where `measureElement` is exercised — deliberately, and
only for the indicator, so that P2-6 still holds for the routing cases.

### IF-7 · §5.1's decode rules did not say what to do with a wheel *release*

Steps 1–4 of §5.1 decode the button byte but never mention the final character.
`(b & 64)` is set for both `\x1b[<64;x;yM` and a hypothetical `\x1b[<64;x;ym`, so
a terminal that emitted a release for a wheel button would produce **two** steps
for one physical notch — and the composer band is one history entry per notch by
design (§4.7).

**Resolution:** a fifth rule, applied with the other four in
`mouse-events.ts::decodeWheel`: only `M` emits an event; `m` is consumed and
dropped like any other non-wheel report. No terminal is known to send it — this
is the same class of defensive consumption as the X10 branch, and it costs one
comparison.

### IF-8 · P1-7 was right and its fix was not sufficient — `App.tsx` is 1051 lines

P1-7 observed that `App.tsx` was **exactly** at the 1000-line ceiling and moved
the routing table and the coalescer into `use-wheel-routing.ts` to make room.
That extraction happened as specified (the hook is 187 lines), and the file is
still over: **1051 lines, 51 over the ceiling.**

The reason is that a file already sitting at exactly its limit has *zero*
headroom, so any feature that touches it at all goes over. What is left in
`App.tsx` is irreducible wiring rather than logic: two props, two pieces of
state, one ref, one hook call, one geometry reset, and three JSX attributes.

Two further extractions were made beyond §10.2 to claw back as much as possible:

- **The §6.1 notice moved into `ui/use-startup-notices.ts`** (a file §10.2 does
  not list). That module's own header says it exists because "`App.tsx` is
  already at its size ceiling, and because these two effects share one job —
  surfacing a condition the user could not otherwise see". The mouse notice is
  that same job, so this is the codebase's own documented pattern rather than a
  new one. `useStartupNotices(dispatch, { enabled, onSeen })`; the three
  existing callers' behaviour is unchanged when the second argument is omitted.
- **The wheel-routing callbacks are inline arrows, not `useCallback`s.** The
  hook re-reads its options through a ref on every render, so the memoization
  bought nothing but lines.

**The residual 51 lines were not closed, and should not be closed by deleting
comments.** Every remaining comment in the new code documents an invariant whose
violation is silent (I-8's ordering, P1-5's staleness reset, P1-3's flush-time
overlay re-check). Trading those for a line count would be the wrong side of the
bargain `CLAUDE.md` is trying to strike. The honest next step is a separate
refactor that splits `App.tsx` by responsibility — the keyboard handler and the
overlay-node builder are the two obvious seams, ~150 lines together — and it is
deliberately **not** bundled into this feature's diff.

### IF-9 · The §6.1 notice had no automated coverage in the design

§8.1 and §8.2 list no case for it; AC-13 is a manual criterion only. Given that
§14 makes shipping the notice a *condition of the verdict*, an untested one-shot
that writes a persisted flag is a poor place to have no regression net — the
failure mode ("it fires every single session") is exactly the kind of thing a
manual pass does once and never repeats.

**Added** to `mouse-routing.test.tsx`: the notice appears and persists
`mouseNoticeSeen` when unseen, stays silent once the flag is set, and never
appears when `mouseSource` is absent (`--no-mouse`, inline, or R-1 firing).

> **CORRECTION (2026-08-08).** The last clause was false for its third case, and
> the case it named is the one that mattered. `mouseSource` came from
> `wantMouse`, `wantMouse` never asked whether the platform could report
> anything, and `tryCreateMouseFilter` returns `null` only when construction
> throws — so **when R-1 fired the source was PRESENT**, the affected user got
> the notice, and this assertion's "R-1 firing" branch was unreachable and
> passed vacuously. Both halves are fixed together: `cli.tsx::wantMouse` now
> carries the platform check (`ui/win-vt-input.ts`), and `mouse-routing.test.tsx`
> gained a `runInteractive`-shaped case that drives the real gate, so the branch
> is exercised for the first time.

### Deviations worth naming, that are not defects

- **`showScrollIndicator` is passed `true` unconditionally** from `App`'s
  full-screen viewport. §5.6 gives the prop a `false` default and §13-Q3 requires
  the indicator to stay independently revertible; both still hold — the prop
  defaults to `false`, the routing never reads it, and deleting one JSX attribute
  reverts phase 6.
- **`tryCreateMouseFilter` lives in `stdin-mouse-filter.ts`**, next to
  `createMouseFilter`, rather than in `cli.tsx` where §4.2's pseudocode shows it.
  It is the null-returning half of the same contract and belongs with it; the
  ordering §4.2 specifies is unchanged, and the I-8 test asserts it from a
  `runInteractive`-shaped harness as §8.2 requires.
- **`AppShell` writes `UNMEASURED_GEOMETRY` in inline mode too**, on top of
  `App`'s render-time reset. Redundant by construction, kept because the two
  cover different paths (`App`'s covers the too-small placeholder, where
  `AppShell` is not rendered at all) and neither alone covers both.

---

### Verification actually performed

| Check | Result |
| --- | --- |
| `npx tsc -p packages/cli/tsconfig.json --noEmit` | clean |
| `npm run build -w packages/cli` | clean; `dist/cli.js` has its shebang |
| `npm test -w packages/cli` | **777 passed, 2 skipped, 0 failed** (688 before this feature) |
| `node dist/cli.js --help` | `--mouse` / `--no-mouse` present |
| `config set mouse false` → `config get mouse` | prints `false` (AC-12) |
| §8.4 manual matrix | **NOT RUN** — needs a real terminal and a real wheel |
| §11 phase 0 probe | **NOT RUN at the time** — see IF-1. **RUN on 2026-08-08**; result and consequence in §11.0, R-1 closed, §13-Q1 void |

New test files: `mouse-events.test.ts` (26), `stdin-mouse-filter.test.ts` (14),
`regions.test.ts` (10), `scroll-indicator.test.ts` (8),
`mouse-routing.test.tsx` (26). Additive cases in `screen.test.ts` (6),
`scroll.test.ts` (4), `config.test.ts` (8).

---

## 16. 代码评审修复 (Fixed During Code Review)

Written by the review node, against the working tree the implementation node
produced. Every entry in §10.1 and §10.2 was checked off against the diff; the
architecture, the routing table, the invariants and every public shape landed as
designed, and nothing below changes any of them. Three defects were found and
fixed in place.

### RF-1 · `wantMouse` gated on stdout only, so a piped stdin still got a filter

`cli.tsx` derived `wantMouse` from `mode === 'fullscreen' && config.mouse &&
process.stdout.isTTY`. `stdout.isTTY` is the right test for *whether
`enterAltScreen` writes anything*, but the reports come back on **stdin**, and
the two are not the same stream. The default action guards `runInteractive` with
`!process.stdin.isTTY ⇒ headless` (`cli.tsx:669`), but `aragon config`
(`cli.tsx:705`) calls `runInteractive` directly with no such check — so
`aragon config < file` in a terminal wrapped a stream on which no report can
ever arrive and asked the terminal to start reporting anyway.

Harmless in practice (Ink's `isRawModeSupported()` reads the delegating getter
and declines raw mode, so nothing was ever going to be parsed), but §4.2 is
explicit that a non-TTY creates **no filter**, and I-5's "the real
`process.stdin` is handed to Ink unwrapped" should not depend on which
subcommand you reached the interactive path through. **Fixed:** `wantMouse` now
requires both ends to be terminals.

### RF-2 · `dispose()` ran before `restore()`, leaving a narrow I-2 window

Both `waitUntilExit()` branches disposed the filter and *then* restored the
screen. `dispose()` removes the `'data'` listener and pauses the real stdin;
`restore()` is what writes `?1006l?1000l`. In that order there is an interval —
short, but real — in which the terminal is **still reporting** and nothing is
draining stdin, so a notch taken in that instant survives in the OS input buffer
and is delivered to the shell as `[<64;12;5M` after the process exits. That is
the I-2 failure mode at reduced scale, and it is the one this feature must not
introduce.

**Fixed:** `screen?.restore()` now precedes `disposeMouse()` on both branches.
Reporting stops first, anything already in flight is consumed by a filter that
is still attached, and I-7 is unaffected because `dispose()` still runs on both
paths. `replayTranscript()` keeps its position last — it writes to the normal
screen and must not run before `restore()` leaves the alternate one.

### RF-3 · The coalescer flushed on direction change but not on band change

§4.7: "The accumulator flushes immediately when the band **or** the direction
changes." `use-wheel-routing.ts` implemented only the second half — `accumulate`
compares `kind`, and the `'composer'` branch returned without touching the
accumulator. Because the composer path is deliberately never coalesced, the two
halves of one continuous gesture were applied **out of order**: wheel over the
transcript, move down onto the input box, wheel again, and the history step
lands first with the transcript scroll arriving ~16 ms behind it.

**Fixed:** the `'composer'` branch flushes before stepping history, and
`mouse-routing.test.tsx` gains `flushes immediately when the band changes` next
to the existing direction and granularity cases.

### Accepted as-is

- **IF-8 (`App.tsx` is 1051 lines, 51 over the ceiling) is accepted for this
  commit.** The implementation node's reasoning holds: what remains in the file
  is wiring, not logic, and the two real seams — the `useInput` global-key
  handler (~124 lines) and the `overlayNode` builder (~128 lines) — are
  *keyboard* and *overlay* concerns with no relationship to wheel routing.
  Extracting either here would put a file named after neither this feature nor
  its diff into a commit whose contents are supposed to be traceable to it, and
  would refactor the most behaviour-critical code in the app inside a review
  pass. The follow-up IF-8 names stands, as its own change.
- **`isMousePrefix` has no production caller** — `splitMouseEvents` re-derives
  the same classification through `matchReport`. Kept: it is a §5.1-specified
  export, the two definitions were checked against each other case by case and
  agree, and it is the documented contract behind the 12 ms flush timer.

### Verification performed by the review node

| Check | Result |
| --- | --- |
| `npx tsc -p packages/cli/tsconfig.json --noEmit` | clean |
| `npm run build -w packages/cli` | clean; `dist/cli.js` has its shebang |
| `npm test -w packages/cli` | **781 passed, 2 skipped, 0 failed** |
| §10.1 / §10.2 coverage walk | every listed file present and doing what it says |
| AC-8 (no existing assertion edited) | confirmed by diff — the only non-additive line in the three extended suites is a widened `node:path` import; `app.test.tsx`'s change replaces a press count, not an assertion (IF-4) |
| §11 phase 0 probe / §8.4 matrix | **still NOT RUN** — IF-1 stands, and this feature is not released until `manual-test.md` section 0 is filled in |

**The release gate is unchanged by this review.** §14 condition 1 remains open:
no automated node can spin a physical wheel, so whether Windows delivers SGR
reports at all is still unanswered. Everything below that gate is done.

> **UPDATE (2026-08-08) — condition 1 is now discharged, and it failed.**
> The feature shipped with the gate open, and the predicted cost was paid: users
> on Node 18/20/22.0–22.16/23/24.0–24.1 got a build whose wheel does nothing and
> were told, by the §6.1 notice, how to use it. Phase 0 ran under
> `docs/diagnoses/shift-tab-and-mouse-wheel-dead-on-some-terminals/` and is
> written up in §11.0: R-1 fires, on a majority of Windows installs, and the
> discriminator is the Node version rather than the terminal.
>
> **§8.4's manual matrix is still NOT RUN**, and remains the open item — it is
> now the only way to confirm the positive direction ("on Node ≥ 22.17 the wheel
> really does scroll"), which §11.0's probe cannot answer because injecting a
> `MOUSE_EVENT` record bypasses the window-message path the console's mouse-to-VT
> translation hangs off. Do not read §11.0 as evidence that the wheel WORKS
> anywhere; it is evidence that it CANNOT work below the boundary.
