# Wheel scrolls the transcript only — design specification

> Feature slug: `wheel-scrolls-transcript-only`
> Target: `@aragon-agent/cli` only (`packages/cli`). `@aragon-agent/core` is **untouched** — no engine, provider, tool or event change.
> Version: **v2** — design review applied (P0/P1 resolved in the body)
> Status: reviewed — 有条件通过 (see §13)
> Author: solution-architect node; reviewed by the design-review node
> Supersedes: the composer band of `docs/plans/mouse-wheel-region-routing/spec.md` (§4.5–§4.7). Everything else in that document stands.
> Requirement (原文): 鼠标滚轮滚动，即使是在输入区域滚动，也不应该触发翻动到之前的输入。只有键盘上下键才能翻动之前 / 之后的输入，类似 Claude Code。滚轮滚动时应该让用户查看上方 Agent 执行显示区域的执行记录、思考与输出，上下滚动显示。

---

## 0. 评审记录（Review Notes）

Reviewed against the working tree at `packages/cli@0.5.8`. Every claim below was
checked against source, not inferred from the document. The design itself —
collapse the two bands, make the wheel a pure viewport gesture, delete the
measurement apparatus — is **correct and correctly sized**; the requirement is
met by Stage A alone and the cleanup is genuinely dead code rather than
opportunistic refactoring. The findings are all in the change *plan*: three
sites the file table misses, one acceptance criterion that cannot pass as
written, one instruction that does not compile, and one test-coverage hole.

| ID | Severity | Area | Finding | Resolution |
| --- | --- | --- | --- | --- |
| RV-1 | **P0** | §5 #11, §8.1 Part B | The first-run-notice tests are marked "kept verbatim", but the third of them (`mouse-routing.test.tsx:629-637`) renders `<App … geometryOverride={GEOMETRY} />` directly rather than through `mountApp`. With `AppProps.geometryOverride` removed (§6.2) **and** the `GEOMETRY` const dropped from Part A (§8.1), that block is two compile errors under `tsconfig.test.json` — the plan as written fails its own AC-7/AC-8. | Fixed: §5 #11 and the T-14 row now name the third notice test explicitly. |
| RV-2 | **P1** | §8.2 AC-11 | `grep -rn "over the input box" packages/cli` cannot return nothing. It matches `CHANGELOG.md:312`, a **released 0.5.x entry** that the file's own preamble forbids rewriting, and it matches `packages/cli/dist/**`, a stale build tree that exists in the working copy. The gate is unsatisfiable without falsifying release history. | Fixed: AC-11 rewritten to scope the grep and to assert the CHANGELOG positively instead. |
| RV-3 | **P1** | §4.4, §5 | Three source files outside the change plan justify an invariant **by the deleted mechanism**, and after the change their claim is simply false: `ui/TeamPanel.tsx:13-16` ("the wheel router reads the composer band boundary from `measureElement(bottomRef)`"), `ui/TodoPanel.tsx:11-14` ("would inflate the measurement and start routing transcript scrolls into prompt history"), `config/schema.ts:710-712` ("so the wheel scrolls the region under the pointer"). §4.4 diagnoses exactly this hazard for `AppShell` and then stops there; §5 even lists `config/schema.ts` under "not changed, deliberately so". Violates G6 and `CLAUDE.md` → Clean Code §四. | Fixed: three rows added to §5, §4.4 extended, AC-13 added. |
| RV-4 | **P1** | §8.1 Part B | Part B has no **positive** end-to-end assertion that the wheel scrolls the transcript. T-10/T-11 are both negative (the buffer is unchanged) and T-13 covers only the overlay, so an implementation that dropped wheel handling altogether passes all of Part B. The headline requirement — "滚轮滚动时应该让用户查看上方 Agent 执行显示区域" — is therefore unpinned at the level the user experiences it. | Fixed: T-15 added, modelled on the existing overflow idiom at `app.test.tsx:636-670`; AC-14 added. |
| RV-5 | **P1** | §12 | Q-1 / Q-2 / Q-3 are addressed to the review node and left open; a spec that ships with open questions has no single answer for the implementer. | Fixed: closed as D-9 / D-10 / D-11 and §12 rewritten as the record. |
| RV-6 | P2 | `config/env.ts:108`, `config/load.ts:171` | Both still call the switch "wheel **region** routing". That names the *feature slug*, not the behaviour, so it is drift rather than a false claim. Deliberately **not** changed: the slug is the durable link back to `docs/plans/mouse-wheel-region-routing/`, and renaming it would break that trail for no reader's benefit. | Recorded; deliberate non-change. |
| RV-7 | P2 | §5 #1 | The rewritten `use-wheel-routing.ts` header must not carry over the current claim that `App.tsx` "is exactly at the 1000-line ceiling". It is **1559 lines** today; this change removes roughly ten. Repeating a stale number in a fresh header is how the next reader gets misled. | Noted in §5 #1. |
| RV-8 | P2 | §4.3 | Guard #3 (`ScrollViewport`'s mount-skip, `ScrollViewport.tsx:100`) is what stops a deferred intent replaying when the too-small placeholder unmounts the viewport. §4.3 confirms guard #2 ships but never states that guard #3 is untouched — and M-9 exercises exactly that path. | Noted in §4.3. |
| RV-9 | P2 | §5 #13 | The AC-23 block is `app.test.tsx:1038-1081`, not `1038-1082`, and it reaches `regions.js` through a **dynamic** `await import()` — which `tsc` will not flag once the module is gone. Deleting the block is therefore load-bearing, not tidying. | Noted in §5 #13. |
| RV-10 | P2 | §6.5 | The `Shift+Wheel` help row ("Scroll the transcript a page") becomes incomplete under D-3, since Shift+notch now pages an open overlay too. Left as-is: the row is already terse, and the `Wheel` row directly above it now carries "(or the open overlay)". | Recorded; deliberate non-change. |
| RV-11 | P2 | §8.2 AC-12 | AC-12 forbids staging `.next/`. There is no Next.js in this repo — the clause is inherited from the host `CLAUDE.md`. Harmless, but it should read `dist/`. | Corrected in AC-12. |
| RV-12 | P2 | §8.1 Part A | With `GEOMETRY` gone, the comment on `COMPOSER_ROW` ("`top + height - bottom` = 17") no longer describes anything. §8.1 already asks for a new comment; it must not reproduce the arithmetic. | Noted in §8.1 Part A. |

Checked and found **correct** (recorded so the next reviewer does not re-derive
them): `regions.ts` has exactly one non-test consumer pair (§3); AC-6's grep is
satisfiable because it is scoped to `packages/cli/src` and every remaining hit
lives in a file the plan already edits or deletes; `use-startup-notices.ts:30`
really does already read "Mouse wheel scrolls the transcript."; `npm run
typecheck -w packages/cli` really does run both tsconfigs, so AC-7 is a real
gate; `stdin.write('[A')` is this suite's established idiom for a plain `↑`
(`app.test.tsx:600`), so T-12 is written correctly; `PromptInput` keeps two
other `useEffect` call sites, so removing the nonce effect leaves no orphaned
import; and `AppProps.initialPrompt` exists, so T-15 is buildable.

---

## 1. Overview（概述）

`mouse-wheel-region-routing` gave the CLI real SGR mouse reporting and then split
the screen into **two wheel bands**: a notch reported over the transcript scrolls
the transcript, a notch reported over the bottom chrome steps prompt history one
entry per notch. The second half is the behaviour this change removes.

It is wrong for a reason that only shows up in use. The pointer is not a
deliberate instrument in a TUI — it rests wherever the user last left it, and in
a chat-shaped app that is *near the thing they type into*, i.e. inside the
composer band. So the ordinary "scroll back to see what the agent just did"
gesture lands on the composer, and instead of scrolling, the draft is replaced by
a previous prompt. There is no error, no undo, and no visible connection between
the gesture and the outcome; the user's model is "the wheel is broken" or "my
message vanished". The band that fires is also invisible: its boundary is a
*measured* row that moves as the toast row, the hint row and the completion popup
come and go, so the same physical gesture can do two different things one second
apart. Claude Code, Codex and every full-screen terminal app the user brings
muscle memory from treat the wheel as a **pure viewport gesture** and reserve
history recall for `↑` / `↓`. This change adopts that contract.

The result is a strict simplification. Once the wheel no longer needs to know
*where* the pointer is, the whole apparatus that answers that question becomes
dead: `hitTestWheel`, `FrameGeometry`, `UNMEASURED_GEOMETRY`, `AppShell`'s
per-commit `measureElement(bottomRef)` layout effect, `App`'s `geometryRef` /
`geometryOverride`, and the `historyIntent` nonce channel that carried a wheel
notch down through `Composer` into `PromptInput`. Deleting it removes a
measurement from every commit of the streaming path, removes a fragile derived
dependency on "the full-screen transcript renders no `<Static>`", and removes a
nonce-replay guard (I-9) that existed only to make the deleted channel safe on
remount. Roughly 200 lines of production code and one test file go away, and the
behaviour that replaces them is one sentence long: **the wheel scrolls whatever
scrollable region is on screen — the transcript, or the controlled overlay
covering it.**

---

## 2. Goals / Non-goals

### Goals

- **G1** — A wheel notch **never** mutates the composer buffer, the cursor, the
  history index or the completion popup selection, at any pointer row, in any
  app state.
- **G2** — A wheel notch with no overlay open scrolls the transcript by
  `CONTENT_LINES_PER_NOTCH` (3) rows, `Shift`+notch by one page — unchanged from
  today for the transcript band, now also true for every other row.
- **G3** — Prompt history recall keeps working, unchanged, from `↑` / `↓`
  (including the "never clobber an in-progress draft" edge rule and the popup
  branch that turns `↑` / `↓` into selection movement while a popup is open).
- **G4** — With a *controlled* overlay open (`help` / `settings` / `plan`) the
  wheel scrolls that overlay from any row; uncontrolled overlays (`model` /
  `confirm` / `question`) keep owning their own keys and ignore the wheel.
- **G5** — Every artifact that documents the old two-band contract to a user —
  help overlay, CLI flag text, `packages/cli/README.md`, `CHANGELOG.md` — is
  corrected in the same change.
- **G6** — No dead code is left behind: the geometry apparatus is deleted, not
  orphaned (`CLAUDE.md` → Clean Code Guidelines §四 forbids zombie code).

### Non-goals

- **N1** — Horizontal wheel, drag, click-to-position-cursor, click-to-select.
  Non-wheel reports stay consumed-and-dropped in `mouse-events.ts`.
- **N2** — Any change to the SGR parser, the stdin filter, the `--mouse` /
  `ARAGON_MOUSE` / `config.mouse` switch, or the one-time selection notice. The
  notice text (`use-startup-notices.ts`) already reads "Mouse wheel scrolls the
  transcript." and becomes *more* accurate, not less.
- **N3** — Inline mode. It never had a mouse source (`cli.tsx::runInteractive`
  gates `wantMouse` on `mode === 'fullscreen'`), so it is byte-identical.
- **N4** — Changing rows-per-notch, the coalescing window, the page size, or the
  bottom-snap tolerance.
- **N5** — Mouse-driven scrolling of the todo rail or the team panel.

---

## 3. Current behaviour being replaced

Four call sites implement the composer band today:

1. **`ui/layout/regions.ts`** — `hitTestWheel(y, geometry)` returns
   `'content' | 'composer'` from a measured frame; `FrameGeometry` and
   `UNMEASURED_GEOMETRY` are its vocabulary.
2. **`ui/layout/AppShell.tsx`** — a `useLayoutEffect` writes
   `{ top: 1, height: frameHeight(rows), bottom: measureElement(bottomRef).height }`
   into `geometryRef` on **every commit** of the full-screen branch.
3. **`ui/use-wheel-routing.ts`** — `route()` hit-tests the event row, and the
   `band === 'composer'` branch calls `flush()` then `onHistoryStep(event.dir)`.
4. **`ui/App.tsx` → `ui/Composer.tsx` → `ui/PromptInput.tsx`** —
   `onHistoryStep` bumps `historyIntent = { dir, nonce }`, which is passed down
   two levels and applied by a `useEffect([nonce])` inside `PromptInput` through
   `applyHistoryIntent`, guarded on mount by `lastHistoryNonce` (I-9).

All four are removed. `WheelEvent.x` / `.y` stay in the parser: that module's job
is a faithful decode of the report, `x` is already unread today, and deleting
fields would gut `mouse-events.test.ts` for no gain.

---

## 4. Technical design

### 4.1 The routing table after the change

`route()` in `use-wheel-routing.ts` becomes position-independent. In precedence
order:

| # | Condition | Action |
| --- | --- | --- |
| 1 | overlay is `help` / `settings` / `plan` | `onOverlayScroll(±OVERLAY_PAGE)` when `event.shift`, else `onOverlayScroll(±OVERLAY_LINES_PER_NOTCH)` |
| 2 | overlay is `model` / `confirm` / `question` | return; the overlay owns its keys (R-11 of the original spec) |
| 3 | no overlay, `event.shift` | `accumulate(dir === 'up' ? 'pageUp' : 'pageDown', 1)` |
| 4 | no overlay | `accumulate(dir === 'up' ? 'lineUp' : 'lineDown', CONTENT_LINES_PER_NOTCH)` |

`event.y` is not read. `event.alt` / `event.ctrl` remain unread, as today.

The overlay branch is still evaluated **first** and still returns for everything
it recognises, matching the keyboard handler's ordering. Its one behavioural
delta is stated in §4.4 (D-3).

### 4.2 Sequence of operations (one notch, no overlay)

1. Terminal emits `\x1b[<64;40;12M`; `stdin-mouse-filter` removes it from the
   chunk before Ink sees a byte (invariant I-1 — unchanged).
2. `mouse-events.ts::decodeWheel` yields `WheelEvent { dir:'up', x:40, y:12, … }`.
3. `MouseSource` fan-out reaches `route()` in `use-wheel-routing.ts`.
4. `optionsRef.current.getOverlay()` returns `null` → rows 3/4 of the table.
5. `accumulate('lineUp', 3)` folds into the 16 ms accumulator; a direction or
   granularity change flushes what is held first.
6. `flush()` re-reads `getOverlay()` (P1-3, unchanged: the *flush-time* decision
   is the authoritative one) and calls `onScroll('lineUp', 3)`.
7. `App::scrollBy` → `ScrollViewport` intent → `applyScrollTimes` folds
   `applyScroll` three times, preserving the clamp and the downward bottom-snap.

Steps 1–3 and 6–7 are untouched by this change; only step 4's branch table
shrinks.

### 4.3 Coalescing

`accumulate` / `flush` / `clearCoalescer` keep their current shape and constants
(`WHEEL_COALESCE_MS = 16`). Two deletions:

- The `flush()` call that used to precede `onHistoryStep` disappears with the
  branch.
- The "flush when the **band** changes" rule disappears: there are no bands. A
  burst that crosses the old boundary now folds into **one** intent, which is
  the correct outcome (it is one gesture) and is pinned by a new positive test
  (§8.1 T-4).

`clearCoalescer` and its contract with `App`'s `state.overlay` effect are
unchanged — guard #2 of the pair described in the original §14 still ships.

Guard #3 — `ScrollViewport`'s mount-skip (`ScrollViewport.tsx:100`) — is also
untouched and still required (RV-8). It is what stops a deferred scroll intent
being replayed when the viewport remounts, and the too-small placeholder
unmounts the viewport on every resize below `MIN_FULLSCREEN_ROWS`. M-9 drives
that path. Only the *history* nonce channel and its I-9 guard are removed here;
the viewport's own intent nonce is a different mechanism with a different owner
and must not be swept up with it.

### 4.4 What is deleted, and the one behaviour delta

| Deleted | Because |
| --- | --- |
| `hitTestWheel`, `WheelBand`, `FrameGeometry`, `UNMEASURED_GEOMETRY` (whole file `regions.ts`) | Sole consumer was the composer branch |
| `AppShellProps.geometryRef` + its `useLayoutEffect` | Measured only to feed `hitTestWheel`; removes a `measureElement` from every commit |
| `AppProps.geometryOverride`, `App`'s `geometryRef`, the `UNMEASURED_GEOMETRY` reset before the too-small placeholder | Same |
| `WheelRoutingOptions.geometryRef` / `.geometryOverride` / `.onHistoryStep` | Same |
| `App`'s `historyIntent` state, `ComposerProps.historyIntent`, `PromptInputProps.historyIntent`, `applyHistoryIntent`, `historyIntentRef`, `lastHistoryNonce`, the nonce `useEffect` | The channel the deleted branch fed |

**D-3 (behaviour delta).** Today a notch over the composer band with an overlay
open is *ignored*. After the change it scrolls the controlled overlay, because
row is no longer consulted. This is intended: the composer is inactive behind an
overlay, the overlay is the only scrollable thing on screen, and "the wheel
scrolls what is on screen" is precisely the contract being adopted. The original
reason for ignoring it — "stepping a hidden draft is worse than doing nothing" —
evaporates once nothing steps a draft.

**Consequence for the doc comments that cite the boundary (RV-3).** The `team`,
`rail` and `strip` prop comments in `AppShell` each justify their position by
"the wheel router reads the composer band boundary from `bottomRef`" (I-10 /
C-6 / I-4). Those justifications are void and must be rewritten, not left in
place — a comment that cites a deleted mechanism is worse than no comment. The
*layout* rules they describe still hold for ordinary reasons (the rail belongs
beside the viewport; the strip is inline-only), so restate them on those
grounds. The regression test that pinned the measurement (`app.test.tsx` →
`AC-23: the rail never inflates the measured bottom box`) is deleted with the
mechanism it measured.

**`AppShell` is not the only place the claim was written down.** Three files
outside it repeat the same justification, and after this change each one asserts
something that is false rather than merely stale:

- `ui/TeamPanel.tsx:13-16` — "IT MUST BE MOUNTED INSIDE `AppShell`'s MEASURED
  BOTTOM BOX (I-10). The wheel router reads the composer band boundary from
  `measureElement(bottomRef)`… and the wheel begins scrolling prompt history over
  the transcript." Nothing measures that box any more and no path scrolls prompt
  history. The *placement* rule survives on ordinary grounds (the roster belongs
  with the bottom chrome, above the status bar); restate it there.
- `ui/TodoPanel.tsx:11-14` — "NEVER INSIDE `bottomRef` (C-6 / I-4)… would inflate
  the measurement and start routing transcript scrolls into prompt history."
  Same treatment: the rail belongs in the middle band because that is where a
  column beside the viewport goes, not because of a measurement.
- `config/schema.ts:710-712` — the `mouse` key's doc comment: "Enable SGR mouse
  reporting in full-screen mode so the wheel scrolls the region under the
  pointer." This one is user-facing in spirit — it is the definition of the only
  switch that turns the feature off — and it must now read *the transcript*.
  §5 previously listed `config/schema.ts` under "not changed"; that was the
  oversight, and it is corrected in the table below.

A grep is not a substitute for reading these three: the tokens in AC-6 do not
appear in any of them, which is exactly why the first pass missed them.

### 4.5 The keyboard path is untouched

`PromptInput`'s `useInput` handler keeps, byte for byte:

- the popup branch (`key.upArrow` / `key.downArrow` move the selection),
- `if (key.upArrow && !key.shift) verticalOrHistory('up')` and its `down` twin —
  the `!key.shift` guard is load-bearing (`Shift+↑`/`↓` is the viewport's
  line-scroll binding) and stays,
- `verticalOrHistory` → `moveVertical` → `recallUp` / `recallDown`, including
  "recall only from an empty buffer or while already stepping through history".

`recallUp` / `recallDown` / `moveVertical` are **not** touched; `input.test.ts`
and `prompt-history.test.ts` must keep passing unmodified. That is a checkable
acceptance criterion (AC-9), not an aspiration.

### 4.6 Implementation staging

Land as one commit, but implement in this order so the behavioural fix is
independently verifiable from the cleanup:

- **Stage A (behaviour)** — `use-wheel-routing.ts` only: drop the `composer`
  branch and the geometry inputs; `App` stops passing `onHistoryStep` /
  geometry. At the end of Stage A the requirement is already met.
- **Stage B (cleanup)** — delete `regions.ts`, the `AppShell` prop and effect,
  the `historyIntent` plumbing, and update docs/tests.

If Stage B hits an unforeseen consumer, Stage A alone is a shippable state.

---

## 5. File / module change plan

| # | File | Action | Intent (one line) |
| --- | --- | --- | --- |
| 1 | `packages/cli/src/ui/use-wheel-routing.ts` | modify | Drop the `composer` branch, `hitTestWheel` import and the three geometry/history options; rewrite the file header so it describes one destination instead of "two bands with different physics". The new header must **not** carry over the claim that `App.tsx` "is exactly at the 1000-line ceiling" — it is 1559 lines today (RV-7). The reason the routing table lives outside `App` is that it is the testable part, which is true independently of any line count. |
| 2 | `packages/cli/src/ui/layout/regions.ts` | **delete** | Its only consumer was the deleted branch. |
| 3 | `packages/cli/src/ui/layout/AppShell.tsx` | modify | Remove `geometryRef` prop + the `useLayoutEffect` + the `regions.js` import + `bottomRef`; rewrite the `team` / `rail` / `strip` comments that justified themselves by the wheel boundary. |
| 4 | `packages/cli/src/ui/App.tsx` | modify | Remove `geometryOverride` from `AppProps`/destructuring, the `geometryRef` ref, the `UNMEASURED_GEOMETRY` reset (≈L1325), `historyIntent` state (≈L212), `onHistoryStep` (≈L1011), `geometryRef={…}` on `AppShell` (≈L1487), `historyIntent={…}` on `Composer` (≈L1459), and the `regions.js` import (L67). |
| 5 | `packages/cli/src/ui/Composer.tsx` | modify | Remove `historyIntent` from `ComposerProps`, the destructuring and the pass-through to `PromptInput`. |
| 6 | `packages/cli/src/ui/PromptInput.tsx` | modify | Remove `historyIntent` prop, `applyHistoryIntent`, `historyIntentRef`, `lastHistoryNonce`, `historyNonce` and the nonce `useEffect`; keep every keyboard path. |
| 7 | `packages/cli/src/ui/overlays/HelpOverlay.tsx` | modify | `['Wheel', 'Scroll the transcript (over the input box: prompt history)']` → `['Wheel', 'Scroll the transcript (or the open overlay)']`; keep the row **count** unchanged. |
| 8 | `packages/cli/src/cli.tsx` | modify | `--mouse` help text: "Wheel scrolls the region under the pointer (full-screen mode)" → "Wheel scrolls the transcript (full-screen mode)". |
| 9 | `packages/cli/README.md` | modify | Keybinding table row (L138) and the "**The mouse wheel scrolls whatever is under the pointer.**" paragraph (L155-159) → the new one-destination contract. |
| 10 | `packages/cli/CHANGELOG.md` | modify | Add a `### Changed` bullet under `## Unreleased` describing the behaviour change in user terms. |
| 11 | `packages/cli/src/__tests__/mouse-routing.test.tsx` | modify | Rewrite Parts A/B for the new table; delete Part C (I-9); keep Part D untouched. **The `first-run selection notice` describe block is NOT untouched (RV-1):** its third test (`never shows it when reporting is not actually in effect`, L622-645) renders `<App>` directly with `geometryOverride={GEOMETRY}` instead of going through `mountApp`, so it must lose that prop like everyone else. Its three assertions stay as they are. See §8.1. |
| 12 | `packages/cli/src/__tests__/regions.test.ts` | **delete** | Tests a deleted module. |
| 13 | `packages/cli/src/__tests__/app.test.tsx` | modify | Delete the `AC-23: the rail never inflates the measured bottom box` describe block (L1038-1081) — it asserts a deleted measurement. It reaches `regions.js` through a **dynamic** `await import('../ui/layout/regions.js')`, which `tsc` does not resolve at compile time, so deleting the block is what keeps `npm test` green rather than merely tidy (RV-9). Leave everything else, notably `does not recall prompt history on Shift+Up`. |
| 14 | `packages/cli/src/ui/TeamPanel.tsx` | modify | Rewrite the file-header paragraph at L13-16: the panel still belongs inside the bottom chrome, but for layout reasons, not because a measurement reads it (RV-3). |
| 15 | `packages/cli/src/ui/TodoPanel.tsx` | modify | Same, at L11-14: the rail belongs in the middle band because that is where a column beside the viewport goes (RV-3). |
| 16 | `packages/cli/src/config/schema.ts` | modify | The `mouse` key's doc comment at L710-712: "so the wheel scrolls the region under the pointer" → "so the wheel scrolls the transcript" (RV-3). This is the definition of the only switch that turns the feature off, so it must not describe the superseded contract. |
| 17 | `docs/plans/mouse-wheel-region-routing/spec.md` | modify | Add a one-paragraph superseded banner at the top pointing here; do not rewrite its body. |
| 18 | `docs/plans/mouse-wheel-region-routing/manual-test.md` | modify | Amend the rows that exercise the composer band (rows 2 and 3, L80-81) in place, with a pointer here — see D-11. |
| 19 | `docs/plans/wheel-scrolls-transcript-only/manual-test.md` | create | The small real-terminal matrix in §8.3. |

Not changed, and deliberately so: `input/mouse-events.ts`, `input/stdin-mouse-filter.ts`,
`ui/use-startup-notices.ts`, `ui/layout/scroll.ts`, `ui/layout/ScrollViewport.tsx`,
`config/ui-state.ts`, `config/prompt-history.ts`, and all of `packages/core`.

Also deliberately unchanged, though they mention the wheel: `config/env.ts:108`
and `config/load.ts:171` call the switch "wheel **region** routing" (RV-6). That
phrase names the feature slug, which is still the durable link back to
`docs/plans/mouse-wheel-region-routing/`; unlike the three sites above it makes
no claim about where a notch goes. `todo/panel-rows.ts:9` mentions a "wheel
band" only to explain why the todo rail deliberately has none — still true.

---

## 6. Interface design

No REST, WebSocket or IPC surface exists in this package; the interfaces are
TypeScript props, one CLI flag's help string, and the on-screen help table.

### 6.1 `WheelRoutingOptions` (`ui/use-wheel-routing.ts`)

```ts
// after
export interface WheelRoutingOptions {
  /** Absent when mouse support is off, in inline mode, or on a non-TTY. */
  mouseSource?: MouseSource;
  /** Read at EVENT time for the routing branch, and again at FLUSH time (P1-3). */
  getOverlay: () => Overlay | null;
  onScroll: (kind: ScrollIntent, repeat: number) => void;
  /** Signed row delta; the caller clamps at 0 the way the keyboard branch does. */
  onOverlayScroll: (delta: number) => void;
}

export interface WheelRouting {
  clearCoalescer: () => void;
}
export const OVERLAY_PAGE = 8; // unchanged, still imported by App
```

Removed: `geometryRef`, `geometryOverride`, `onHistoryStep`. `WheelRouting` and
`OVERLAY_PAGE` are unchanged, so `App`'s keyboard branch needs no edit.

### 6.2 `AppProps` (`ui/App.tsx`)

`geometryOverride?: FrameGeometry` is removed. Every other member is unchanged.
This is the only externally observable type change; its consumers are
`cli.tsx::runInteractive` (never passed it) and two test files.

### 6.3 `AppShellProps` (`ui/layout/AppShell.tsx`)

`geometryRef?: React.MutableRefObject<FrameGeometry>` is removed, together with
`bottomRef` and the layout effect. The rendered tree is **byte-identical** —
the bottom `<Box flexDirection="column" flexShrink={0}>` stays, it simply loses
its `ref`.

### 6.4 `ComposerProps` / `PromptInputProps`

`historyIntent?: { dir: 'up' | 'down'; nonce: number }` is removed from both.
No other prop changes; `PromptInput`'s exported pure helpers (`applyEdit`,
`moveVertical`, `slashSuggestions`, `fileTokenAt`) keep their signatures.

### 6.5 User-visible strings

| Where | After |
| --- | --- |
| `HelpOverlay` keyRows | `['Wheel', 'Scroll the transcript (or the open overlay)']` |
| `HelpOverlay` keyRows | `['Up / Down', 'Prompt history (empty input)']` — unchanged, now the only history affordance |
| `cli.tsx` `--mouse` | `Wheel scrolls the transcript (full-screen mode)` |
| `cli.tsx` `--no-mouse` | `Leave the mouse to the terminal (the wheel does nothing)` — unchanged |
| README keybinding table | `| Mouse wheel | Scroll the transcript (or the open overlay) |` |

`HelpOverlay`'s row count must not change: `helpRows` is exported so `app.test.tsx`
can count rows and `OverlayFrame` slices by element.

---

## 7. Data model

Nothing is persisted, migrated or added.

- **In-memory, changed** — `WheelRoutingOptions` (§6.1); `App`'s `historyIntent`
  state and `geometryRef` are removed. The accumulator
  `{ kind: ScrollIntent; repeat: number } | null` and its `NodeJS.Timeout` are
  unchanged.
- **In-memory, unchanged** — `WheelEvent { kind, dir, x, y, shift, alt, ctrl }`;
  `ScrollState { offset }`; `PromptInput`'s `buffer` / `cursor` / `historyIndex`
  / `dismissed` / `sel` / `fileMatches`.
- **Deleted type** — `FrameGeometry { top; height; bottom }` and `WheelBand`.
- **On disk, unchanged** — `config.json` key `mouse: boolean`; `state.json` key
  `mouseNoticeSeen: boolean`; the prompt-history file read by
  `loadPromptHistory()` / `appendPrompt()`. **No migration, no new key, no
  removed key** — a user who downgrades after this change loses nothing and a
  user who upgrades needs no action.

---

## 8. Testing & acceptance criteria

### 8.1 Automated — `packages/cli/src/__tests__/mouse-routing.test.tsx`

Part A drops `GEOMETRY` / `geometryOverride` / `FrameGeometry` and the
`history` field of `HostCalls`; `mountRouter` no longer passes geometry.
`COMPOSER_ROW = 17` and `TRANSCRIPT_ROW = 9` are **kept as literals** with a
comment: they are now two arbitrary rows whose only job is to prove the router
does not care which one it gets. That comment must **not** reproduce the old
`top + height - bottom` arithmetic (RV-12) — with `GEOMETRY` deleted it would
describe nothing, and it would imply a boundary that no longer exists.

| ID | Test | Assertion |
| --- | --- | --- |
| T-1 | routes a transcript-row notch to the transcript | `scroll === [{ kind:'lineUp', repeat:3 }]` (existing, kept) |
| T-2 | **routes a composer-row notch to the transcript too** | `scroll === [{ kind:'lineUp', repeat:3 }]` — replaces `steps prompt history exactly once per notch` |
| T-3 | wheel-down / shift+wheel unchanged | `lineDown` repeat 3 / `pageUp` repeat 1 (existing, kept) |
| T-4 | **a burst that crosses the old band boundary folds into one intent** | two notches at `TRANSCRIPT_ROW` then `COMPOSER_ROW` ⇒ `[{ kind:'lineUp', repeat:6 }]` — replaces `flushes immediately when the band changes` |
| T-5 | controlled overlays scroll (`help`/`settings`/`plan`) | `overlayScroll === [-3, 8]` (existing, kept) |
| T-6 | uncontrolled overlays ignore the wheel (`model`/`confirm`/`question`) | both call lists empty (existing, kept) |
| T-7 | **a composer-row notch with an overlay open scrolls the overlay** | `overlayScroll === [-3]` — inverts `ignores a composer-band notch while an overlay is open` (D-3) |
| T-8 | direction / granularity change flushes; overlay-open-inside-window drops; `clearCoalescer` drops | existing three, kept verbatim |
| T-9 | unsubscribes on unmount | existing, kept |

Part B (`App` end-to-end), with `geometryOverride` removed from `mountApp`:

| ID | Test | Assertion |
| --- | --- | --- |
| T-10 | a wheel notch over the transcript does not change the buffer | frame still contains `Send a message` (existing, kept) |
| T-11 | **a wheel notch over the composer row does not recall history** | after two `wheel('up', COMPOSER_ROW)`: frame contains `Send a message`, and **not** `newest prompt` / `older prompt` / `[<` — replaces `a wheel event over the composer band recalls prompt history` |
| T-12 | **keyboard `↑` still recalls history in the same mounted app** | in the same test as T-11, `stdin.write('[A')` then frame contains `newest prompt`; a second `↑` gives `older prompt`; `[B` walks back |
| T-13 | wheel over an open help overlay scrolls it / help advertises the wheel | existing two, kept |
| T-14 | first-run selection notice (3 tests) | Assertions kept verbatim; the **third** test drops `geometryOverride={GEOMETRY}` from its inline `<App>` (RV-1) |
| T-15 | **a wheel burst really scrolls the transcript, end to end** | new — see below |

**T-14 is the P0 (RV-1).** Two of the three notice tests go through `mountApp`
and are fixed by fixing `mountApp`. The third, `never shows it when reporting is
not actually in effect`, deliberately renders `<App>` inline so it can omit
`mouseSource` — and it passes `geometryOverride={GEOMETRY}` while doing so. Once
`AppProps.geometryOverride` is gone (§6.2) *and* `GEOMETRY` is deleted from Part
A, that call is two compile errors, and `npm run typecheck` (AC-7) fails on the
test tree. Drop the prop; change nothing else in the block.

**T-15 (RV-4)** is the test that pins the actual requirement. Everything else in
Part B is negative — "the buffer did not change" — so a build that removed wheel
handling entirely would pass Part B unchallenged. Model it on the existing
overflow idiom at `app.test.tsx:636-670`: give this suite's `FakeController` an
`emit` and an `onPrompt` hook (it has `subscribe` and a listener set already, so
this is a two-method addition), mount with `initialPrompt`, stream ~60 lines,
assert the frame is pinned to the tail and shows no `↑N`, then send three
`wheel('up', COMPOSER_ROW)` notches and assert the frame now matches `/↑\d/` and
no longer contains the last line. Driving it from `COMPOSER_ROW` rather than
`TRANSCRIPT_ROW` makes one test carry both halves of the requirement: the
gesture that used to eat the draft now moves the viewport.

Part C (`I-9: a nonce-keyed intent never fires on the mount that observes it`) is
**deleted** — both tests drive the removed `historyIntent` prop. Part D (scroll
indicator) is untouched.

### 8.2 Acceptance criteria

- **AC-1** No wheel event at any row, in any state, changes `buffer`, `cursor`,
  `historyIndex` or `sel` (T-2, T-7, T-10, T-11).
- **AC-2** A notch over the composer row scrolls the transcript 3 rows (T-2).
- **AC-3** `Shift`+notch scrolls a page from any row (T-3).
- **AC-4** Keyboard `↑`/`↓` still recall history (T-12 + the untouched
  `app.test.tsx::does not recall prompt history on Shift+Up`).
- **AC-5** A controlled overlay scrolls from any row; an uncontrolled one never
  does (T-5, T-6, T-7).
- **AC-6** `grep -rn "hitTestWheel\|FrameGeometry\|historyIntent\|geometryRef\|geometryOverride\|UNMEASURED_GEOMETRY" packages/cli/src` returns **nothing**.
- **AC-7** `npm run typecheck -w packages/cli` is clean (it runs `tsconfig.json`
  **and** `tsconfig.test.json` — a stale test import fails here, not at runtime).
- **AC-8** `npm test -w packages/cli` is green with no `.skip` / `.todo` added.
- **AC-9** `input.test.ts` and `prompt-history.test.ts` pass **unmodified** —
  the diff must not touch them.
- **AC-10** `npm run build -w packages/cli` succeeds and `node packages/cli/dist/cli.js --help` still prints the `--mouse` line, now with the new text.
- **AC-11** Help overlay, README table row and CHANGELOG entry all describe one
  destination. The gate is
  `grep -rn "over the input box" packages/cli/src packages/cli/README.md`
  returning **nothing**, plus a positive check that
  `packages/cli/CHANGELOG.md` contains a new `## Unreleased` → `### Changed`
  bullet naming the wheel.

  *The obvious form of this grep does not work and must not be restored (RV-2).*
  Unscoped, `grep -rn "over the input box" packages/cli` matches two things it
  should not: `CHANGELOG.md:312`, a released 0.5.x entry that the file's own
  preamble says is left as written — rewriting it would falsify the record of
  what shipped — and `packages/cli/dist/**`, a stale build tree that is present
  in a working copy and gitignored. Superseding a released entry is what the new
  bullet is for; editing it is not an option, so the criterion has to be scoped
  to the sources it can actually govern.
- **AC-12** `git status` shows no `dist/` and no temp files staged. (The v1 text
  also named `.next/`; there is no Next.js in this repository — RV-11.)
- **AC-13** The three comment sites in RV-3 no longer claim a measured band:
  `grep -rn "composer band\|band boundary\|region under the pointer" packages/cli/src`
  returns nothing.
- **AC-14** T-15 fails if the wheel is unwired — verify by temporarily stubbing
  `onScroll` to a no-op and confirming T-15 goes red while T-10/T-11 stay green.
  A negative-only suite is not a regression test for a feature whose whole
  purpose is that something moves.

### 8.3 Manual matrix (real terminal — `docs/plans/wheel-scrolls-transcript-only/manual-test.md`)

Build once (`npm run build -w packages/cli`), then run `node packages/cli/dist/cli.js`
and drive a session long enough to overflow the viewport.

| # | Do | Expect |
| --- | --- | --- |
| M-1 | Type `hello` (do **not** submit), park the pointer over the input box, spin the wheel up 5 notches | Draft still reads `hello`, cursor unmoved; transcript scrolled up ~15 rows |
| M-2 | With an empty input, spin up over the input box | No history recalled; transcript scrolls |
| M-3 | Press `↑` | The last prompt appears in the composer (history still works) |
| M-4 | Type `/`, wait for the palette, spin the wheel over the popup | Selection does **not** move; transcript scrolls behind |
| M-5 | Spin down until pinned to the bottom | `↑N` indicator clears, auto-follow resumes |
| M-6 | Open `/help`, spin over the input row | The help overlay scrolls (D-3) |
| M-7 | Trigger a `confirm` / `ask_user` overlay, spin anywhere | Nothing scrolls, nothing is typed |
| M-8 | `Shift`+wheel over the input box | Transcript pages |
| M-9 | Shrink the terminal below 12 rows mid-wheel, grow it back | Placeholder, then a clean frame; no history recalled on the way back (the old I-9 hazard cannot exist any more) |
| M-10 | `aragon --no-mouse`, spin anywhere | Nothing happens; no escape bytes typed into the draft |

M-1, M-4 and M-9 are the three that cannot be skipped: M-1 is the reported bug,
M-4 is the popup path the deleted `applyHistoryIntent` used to mirror, and M-9 is
the remount hazard whose guard is being removed.

---

## 9. Risks & mitigations

| ID | Risk | Likelihood | Impact | Mitigation |
| --- | --- | --- | --- | --- |
| R-1 | A user relied on wheel-over-input as a fast history stepper | Low | Low | It was one release old and never advertised outside the help table. `↑`/`↓` are unchanged, and the CHANGELOG entry names the change explicitly. |
| R-2 | Deleting `AppShell.geometryRef` breaks an unseen consumer | Low | High | AC-6's grep is the gate; `tsconfig.test.json` is in `npm run typecheck`, so a stale test import is a compile error, not a runtime surprise. |
| R-3 | Removing the `measureElement` layout effect changes layout | Very low | Medium | `measureElement` is a read, not a write, and the `<Box>` keeps every layout prop — only its `ref` goes. `render-budget` / `render-memo` / `transcript-virtual` tests cover the frame shape. |
| R-4 | Deleting the AC-23 test loses the "rail must not sit in the bottom box" guard | Medium | Low | The guard's *consumer* is gone; the layout reason survives as a prop comment. Restate it there rather than keeping a test that measures nothing. |
| R-5 | D-3 (wheel over the composer scrolls the overlay) surprises someone | Low | Low | Pinned by T-7 and M-6, and it is strictly more useful than the previous no-op. |
| R-6 | Deleting `historyIntent` silently breaks keyboard history through a shared code path | Low | High | `applyHistoryIntent` was the *only* caller-specific wrapper; `verticalOrHistory` is shared and untouched. AC-9 forbids editing `input.test.ts`; T-12 asserts keyboard recall inside the wheel suite itself. |
| R-7 | Coalescing across the old boundary produces a visibly bigger jump | Very low | Low | Same total rows either way — the difference is one `setState` instead of two. T-4 pins it. |
| R-8 | Docs drift: help text updated, README or CHANGELOG missed | Medium | Low | AC-11's grep for `over the input box` covers all three. |

---

## 10. Decision log

| ID | Decision | Why not the alternative |
| --- | --- | --- |
| D-1 | Collapse the bands entirely rather than routing `'composer'` → transcript and keeping `hitTestWheel` | Keeping it leaves a hit-tester nobody calls plus a `measureElement` on every commit — dead code the project's own guidelines forbid, and a trap for the next reader who assumes the boundary still means something. |
| D-2 | Delete `regions.ts` rather than keep it "for future region features" | YAGNI; it is 77 lines and fully recoverable from git if a future feature genuinely needs pointer regions. |
| D-3 | With an overlay open, a wheel notch scrolls the overlay from **any** row | The composer is inactive behind an overlay, so the "protect the draft" rationale for the old no-op is gone; "the wheel scrolls what is on screen" is the contract being adopted. |
| D-4 | Keep `WheelEvent.x` / `.y` in the parser | The parser's contract is a faithful decode; `x` is already unread, and trimming fields would churn `mouse-events.test.ts` for nothing. |
| D-5 | Keep `CONTENT_LINES_PER_NOTCH = 3`, `OVERLAY_PAGE = 8`, `WHEEL_COALESCE_MS = 16` | The complaint is about *destination*, not speed; changing feel in the same change makes a regression impossible to bisect. |
| D-6 | Keep `COMPOSER_ROW` as a test literal | The row must keep being exercised — the whole point is that it now behaves like every other row. Deleting the constant would delete the regression. |
| D-7 | Keep the one-time mouse selection notice | It is about `Shift`+drag selection, not routing, and its text is already correct. |
| D-8 | One commit, two stages (§4.6) | Stage A alone satisfies the requirement, so a problem in the cleanup never blocks the fix. |
| D-9 | `Alt`+wheel and `Ctrl`+wheel stay unbound (closes Q-1) | No requirement asks for them, and both are commonly claimed by the terminal emulator itself (font zoom on Windows Terminal and iTerm2), so a binding here would fire inconsistently across the exact population this change exists to serve. Additive later if asked for. |
| D-10 | The CHANGELOG entry lands under `## Unreleased` (closes Q-2) | Releases are cut by `publish-latest.ps1`, which owns the version bump; a feature commit that also bumps races it. The entry must say plainly that it **supersedes** the 0.5.x "scrolls what is under the pointer" bullet, since a reader working through the file top-down meets the new text first and the old text second (AC-11). |
| D-11 | Amend the old manual-test rows in place rather than deleting them (closes Q-3) | Rows 2 and 3 of `mouse-wheel-region-routing/manual-test.md` record *why* the band existed. Amended in place with a pointer here, they read as history; deleted, the next person to propose a pointer-routed wheel has to rediscover the failure mode. |

---

## 11. Rollback

Single-commit revert. There is no schema, no persisted flag and no protocol
version, so `git revert <sha>` restores the previous behaviour exactly. A user
who wants the wheel to do nothing at all has the pre-existing escape hatches:
`--no-mouse`, `ARAGON_MOUSE=0`, `aragon config set mouse false`.

---

## 12. Questions closed at review (was: open questions)

All three questions the first draft raised for the review node are now settled;
nothing in this spec is left to the implementer's discretion (RV-5).

| Was | Now | Where |
| --- | --- | --- |
| Q-1 — bind `Alt`/`Ctrl`+wheel? | **No.** Left unread. | D-9 |
| Q-2 — CHANGELOG under `## Unreleased`, or with a version bump? | **`## Unreleased`**, and it must name what it supersedes. | D-10, AC-11 |
| Q-3 — amend or delete the old manual-test rows? | **Amend in place**, with a pointer here. | D-11, §5 #18 |

One question the draft did not raise, answered here so it is not rediscovered
during implementation: **the completion popup is not wheel-scrollable, and that
is deliberate.** It is not an `Overlay`, so the router never sees it; a notch
over an open `/` palette scrolls the transcript behind it while `↑`/`↓` keep
moving the selection. That is the same split the rest of this change adopts —
wheel moves the viewport, keys move the selection — and M-4 pins it.

---

## 13. 评审结论（Review Verdict）

### 有条件通过 — approved with conditions

The design is sound and I would ship it. It reads the requirement correctly
(the wheel is a viewport gesture; history belongs to `↑`/`↓`), it picks the
strictly simpler of the two available shapes rather than patching the routing
table, and it is honest about the one behaviour it changes beyond the bug
report (D-3). Feasibility is not in question: every deletion has exactly the
consumers the document claims, the type surface it touches is internal to
`packages/cli`, and `packages/core` really is untouched. Right-sizing is good —
Stage A is a ~20-line diff that already satisfies the user, and Stage B removes
dead weight the project's own guidelines forbid keeping. There is no schema, no
protocol version and no persisted key, so the rollback story is a plain revert.

The conditions are all in the change plan rather than the design, and each is
already written into the body above. **Verdict is conditional on these five
landing together with the code, verifiable by the stated gates:**

1. **RV-1 (was P0)** — `mouse-routing.test.tsx`'s third first-run-notice test
   drops `geometryOverride={GEOMETRY}`. Without it the branch does not
   typecheck, so AC-7 and AC-8 both fail. Gate: `npm run typecheck -w
   packages/cli`.
2. **RV-2** — AC-11 ships in its scoped form. The unscoped grep cannot pass
   without rewriting a released CHANGELOG entry, which the file forbids. Gate:
   AC-11 as now written.
3. **RV-3** — `TeamPanel.tsx`, `TodoPanel.tsx` and `config/schema.ts` are edited
   alongside `AppShell.tsx`. All three currently assert an invariant that this
   change makes false, and the `schema.ts` one defines the user-facing switch.
   Gate: AC-13.
4. **RV-4** — T-15 exists and fails when the wheel is unwired. A suite in which
   every end-to-end assertion is negative does not protect the feature the user
   asked for. Gate: AC-14.
5. **RV-5** — Q-1/Q-2/Q-3 stay closed as D-9/D-10/D-11; the implementer inherits
   decisions, not choices.

The P2 findings (RV-6 … RV-12) are recorded for the implementer's judgement and
are **not** conditions. Two are explicit non-changes with reasons (RV-6, RV-10);
the rest are small precision fixes to line ranges, comments and one inherited
clause.

One note for whoever implements this, not a condition: the working tree
currently carries a stale `packages/cli/dist/`. It is gitignored and harmless to
the build, but it will pollute any repo-wide grep run while verifying AC-6 and
AC-11 — scope those greps to `src` as the criteria now specify, or remove `dist`
first.


---

## 14. 实施过程发现的方案缺陷（Issues Found During Implementation）

Five findings, recorded per the implementation node's standing instruction not to
deviate silently. IF-1 is the only one that would have shipped a broken test;
the rest are gaps in the change *plan* rather than in the design, which is
exactly where §0 predicted the remaining risk was.

| ID | Severity | Where | Finding | What was done instead |
| --- | --- | --- | --- | --- |
| IF-1 | **P0** | §8.1 T-12, and §0's "checked and found correct" list | **`stdin.write('[A')` is not an `↑`, and the spec verified the wrong thing.** §0 records `stdin.write('[A')` as "this suite's established idiom for a plain `↑` (`app.test.tsx:600`), so T-12 is written correctly". The bytes on disk at that line are `stdin.write('\x1b[A')` — a **raw ESC control byte** that every viewer which hides control characters (including the one used to review this) renders as a bare `[A`. Ink's `parseKeypress` requires the ESC (`fnKeyRe = /^(?:\x1b+)…/`), so the two literal characters `[` and `A` are not an arrow key at all: they fall through to `PromptInput`'s printable branch and are **typed into the draft**. T-12 written as specified fails, and it fails by asserting the frame contains `newest prompt` while the composer shows `❯ [A`. | Added a local `ESC = '\u001B'` with `KEY_UP` / `KEY_DOWN` helpers, following the rationale `app.test.tsx:72-74` already states for its own `ESC` const ("written as an escape, not a raw byte, so an editor that stripped the control character could not leave a test that asserts nothing and still passes") — advice that file gives and then does not follow for its arrow keys. T-12 now passes and genuinely drives the keyboard path. |
| IF-2 | P1 | §8.1 Part A table | The table enumerates T-1…T-9 as the whole of Part A, but the existing test **`puts the header row in the transcript band`** appears in it neither as "kept" nor as "replaced". Left as written it also violates AC-13 (it names a band). | Folded into T-2: that test now loops over `TRANSCRIPT_ROW`, `COMPOSER_ROW` and a new `HEADER_ROW = 1`, mounting fresh for each. Coverage of the top edge is preserved, the "band" vocabulary is gone, and one test now carries the whole position-independence claim. |
| IF-3 | P1 | §8.1 Part B table | Same omission on the other side: Part B's existing **`a wheel event over the composer is ignored while an overlay is open`** is not in the new table. Its premise is precisely what D-3 inverts — the notch is no longer ignored. | Deleted. Its two assertions survive elsewhere: the inverted behaviour is T-7 (Part A, `overlayScroll === [-3]`) and "no history recall from the composer row" is T-11. |
| IF-4 | P2 | AC-11, AC-13 | **Both greps match correct new prose, not just stale claims.** `"over the input box"` is the natural way to write the sentence that now says the *opposite* of the 0.5.x contract ("a notch over the input box scrolls the transcript"), and `"band boundary"` is the natural way to name what a coalescing test deliberately spans. The gates test **vocabulary**, not claims, so a faithful implementation trips them. | Worded around both: the README says "right on top of the composer", the T-4 test is named `folds a burst that spans the transcript and the composer into ONE intent`, and the two Part B comments say "the composer" / "sits on the composer". All three greps now return nothing. **Whoever edits these files next has to keep dodging the substrings** — that is a property of the gate, not of the code. |
| IF-5 | P2 | AC-7, AC-8, AC-10 | **Two other features were being implemented in this same working tree while this one landed**, and they leave the shared gates red for their own reasons: `llm-api-retry-backoff` (adds a required `CliConfig.retry`, plus `toRetryPolicy` / `src/agent/retry-view.ts` / `RetryCard.tsx`) and `fast-model-tier` (adds `src/fast/`, `SubagentRun.tier`, a `model` enum on the team task tool). Neither exists at `HEAD` — verified with `git show HEAD:… \| grep -c toRetryPolicy` = 0 and `… resolveTier` = 0. | Reported scoped rather than claimed clean; see the note below. Nothing in either feature was edited: fixing another node's fixtures would both exceed this change's scope and collide with a node still writing those files. |

### What the gates actually returned

Scoped to what this change can govern:

- **AC-6 / AC-11 / AC-13** — all three greps return nothing. ✅
- **AC-9** — `input.test.ts` and `prompt-history.test.ts` are untouched
  (`git status` shows neither) and pass. ✅
- **AC-1 … AC-5, AC-14** — `mouse-routing.test.tsx` is **24/24 green**. AC-14 was
  performed as specified: stubbing `onScroll` to a no-op turns T-15 red and
  leaves T-10 / T-11 green, so the suite is not negative-only. ✅
- **AC-7** — every remaining `tsc` error is in a file this change does not touch
  (`agent/reducer.ts`, `fast/*`, `team/task-tool.ts`, and the `CliConfig`
  fixtures of `skills-controller` / `todo-session` / `team-*` / `app-follow-through`).
  **Zero errors in any of the 19 files in §5.** ⚠️ blocked by IF-5.
- **AC-8** — `mouse-routing`, `app`, `input` and `prompt-history` are green
  (92 passed / 2 skipped). Repo-wide, 24 failures remain in
  `skills-controller.test.ts` and `todo-session.test.ts`, every one of them
  `TypeError: Cannot read properties of undefined (reading 'enabled')` from
  `toRetryPolicy(cfg.retry)`. No `.skip` or `.todo` was added anywhere. ⚠️
  blocked by IF-5. (`max-tokens-ui` and `stdin-mouse-filter` also flake under
  full-suite load and pass in isolation; neither is touched here.)
- **AC-10** — `npm run build -w packages/cli` cannot go green while IF-5 stands.
  The substance of the criterion was verified instead by running the real entry
  point transpile-only: `npx tsx src/cli.tsx --help` prints
  `--mouse   Wheel scrolls the transcript (full-screen mode)`. ⚠️ partially
  blocked by IF-5.
- **AC-12** — no `dist/` and no temp files are staged. Note that
  `npm run build`'s first act is `rmSync('dist')`, so the stale `packages/cli/dist/`
  the §13 closing note warns about is **gone** as of this change; the greps above
  were run against `src` regardless.

### One deliberate non-change worth naming

`route()`'s `useCallback` dependency array drops `flush` along with the branch
that called it. `accumulate` still closes over `flush` and is itself stable, so
behaviour is identical — but leaving a dependency on a value the callback no
longer reads is the kind of residue `react-hooks/exhaustive-deps` flags and the
next reader has to re-derive.
