# The one spinner disappears whenever a toast takes its row

> Diagnosis only. No fix code is written by this node, and nothing is committed.
> Bug slug: `activity-spinner-vanishes-behind-toast`.
> Subject build: `aragon-agent-core` @ `5b05e7ec` (round‑1 change is `64ebe3f9`).

---

## 1. Problem description

**As filed (round 2):**

> 继续修改完善，现在的 小图标的 动画效果消失了，需要小图标有等待输出的动画效果 顶级

Round 1 (`64ebe3f9`, *"one spinner per run, on the row above the composer"*) made the
activity row above the composer the sole owner of animation during a run, and turned the
other seven animated sites into static glyphs. The user now reports that the small icon's
animation is gone and asks for a waiting‑for‑output animation back.

There are two distinguishable claims inside that sentence, and this report separates them
because only one of them is a defect:

| | Claim | Verdict |
|---|---|---|
| **A** | The remaining icon animates **not at all** — the frame is dead while the agent works. | **Confirmed defect**, reproduced and measured. Section 3. |
| **B** | The per‑item icons (`· running`, `●`) are inert dots that no longer signal "waiting for output". | **Working as designed** by `64ebe3f9`, but it is the design the user is pushing back on. Section 4. |

Claim A is real, is a regression introduced by `64ebe3f9`, and it is *intermittent* — which
is exactly how a user ends up describing it as "the animation disappeared" rather than
"the animation is wrong". **A is the root cause this report recommends fixing.**

---

## 2. Reproduction steps

### 2.1 Manual — in a real terminal (30 seconds)

```bash
cd aragon-agent-core
npm run dev:cli -- --fullscreen        # inline reproduces identically
```

1. Ask for something that takes ~15 s, e.g. `run: sleep 15 && echo done`.
2. Wait until the row above the composer reads `⠋ Running bash` and is visibly spinning.
3. **Press `Ctrl+T`** (toggle thinking — `App.tsx:1383`, which pushes a toast).
4. Watch the row above the composer for the next ~2.5 seconds.

**Expected:** something on screen keeps moving while the agent is working.
**Actual:** the spinner is replaced by `ℹ Thinking shown.` and **nothing anywhere in the
frame animates** until the toast expires. The tool badge says `· running`, the assistant
marker is `●`, the todo rail is `▸` — every one of them static. The screen is
indistinguishable from a hung process for 2.5 s.

`Ctrl+T` is just the cheapest trigger. The same hole opens on every mid‑run toast; see
§3.4 for the full list, including **"Steering queued."** — which the composer actively
invites during every run (`⇢ Type to steer the run, Esc to abort…`) — and **"Plan
approved. Implementing."**, which fires at the exact moment the implementation run starts.

### 2.2 Automated — a minimal repro case

Drop this in `packages/cli/src/__tests__/zz-repro.test.tsx`. It reuses the existing
`single-spinner.test.tsx` fixture, so build it by copying that file's header (everything
above its `describe(`) and appending the block below.

```bash
cd packages/cli
node -e "
const fs=require('fs');
const s=fs.readFileSync('src/__tests__/single-spinner.test.tsx','utf8');
const i=s.indexOf(\"describe('single spinner while running'\");
fs.writeFileSync('src/__tests__/zz-repro.test.tsx', s.slice(0,i)+fs.readFileSync('repro-tail.txt','utf8'));
"
npx vitest run src/__tests__/zz-repro.test.tsx
```

`repro-tail.txt`:

```tsx
describe('REPRO: a mid-run toast leaves the frame with zero animations', () => {
  it('braille count goes 1 -> 0 -> 1 around a toast', async () => {
    const fc = toolRunningController();
    const r = mount(fc, { initialPrompt: 'go', mode: 'fullscreen' });
    const n = (s: string) => (s.match(/[⠀-⣿]/g) ?? []).length;

    const before = await settledFrame(r.lastFrame, (x) => x.includes('Running bash'));
    r.stdin.write('\x14'); // Ctrl+T -> App.tsx:1383 pushes a toast
    const during = await settledFrame(r.lastFrame, (x) => /Thinking (shown|hidden)/.test(x));

    let after = during;
    for (let i = 0; i < 120; i += 1) {
      await delay(50);
      after = stripAnsi(r.lastFrame() ?? '');
      if (!/Thinking (shown|hidden)/.test(after)) break;
    }
    r.unmount();

    // THE INVARIANT: while a run is in flight, the frame animates.
    expect({ before: n(before), during: n(during), after: n(after) })
      .toEqual({ before: 1, during: 1, after: 1 });
  });
});
```

**Measured result on `5b05e7ec`:**

```
AssertionError: expected { before: 1, during: 0, after: 1 } to deeply equal { before: 1, during: 1, after: 1 }

+ Received:
{
  "before": 1,
  "during": 0,        <-- zero animations, mid-run
  "after":  1,
  "recoveredAfterMs": 2100,
}
```

The braille counter is the same instrument `single-spinner.test.tsx` already uses: `dots`
is the only thing in this package that emits braille (`glyphs.ts` carries none in either
tier), so a braille count *is* an animation count, whichever component drew it.

### 2.3 The frames, verbatim

Captured from the run above (ANSI stripped):

```
--- BEFORE  braille=1 ---
◇ AragonAgent  anthropic:m  work  ●
› go                                                                          │
● listing                                                                     │
❯ bash ls· running                                                            │
                                          ... (viewport) ...                  │
 ⠋ Running bash                       <-- the one animation
╭─────────────────────────────────────────────────────────────────────────────╮
│ ⇢ Type to steer the run, Esc to abort…                                      │
╰─────────────────────────────────────────────────────────────────────────────╯
  ⏎ steer · esc abort · ctrl+c×2 exit
 ◍ running  anthropic:m                    [░░░░░░░░░░░░] ~0%  100↑ 20↓  $0.00

--- DURING TOAST  braille=0 ---
◇ AragonAgent  anthropic:m  work  ●
› go                                                                          │
● listing                                                                     │
❯ bash ls· running                                                            │
                                          ... (viewport) ...                  │
 ℹ Thinking shown.                    <-- the toast took the row; NOTHING moves
╭─────────────────────────────────────────────────────────────────────────────╮
│ ⇢ Type to steer the run, Esc to abort…                                      │
╰─────────────────────────────────────────────────────────────────────────────╯
  ⏎ steer · esc abort · ctrl+c×2 exit
 ◍ running  anthropic:m                    [░░░░░░░░░░░░] ~0%  100↑ 20↓  $0.00
```

Note what is *not* wrong in the second frame: the status bar still says `running`, the
tool card still says `running`. **No information left the screen — only life.** That is
precisely the distinction `ActivityLine.tsx:22-23` draws: *"The bar shows state; this row
shows life."*

### 2.4 Independent re-measurement (added by the review node)

Three numbers taken on `5b05e7ec` with a throwaway probe built exactly as §2.2
describes — the fixture header of `single-spinner.test.tsx` plus a fresh
`describe` — run under `packages/cli/vitest.config.ts` and deleted afterwards.
Raw output:

```
R-A {"before":1,"during":0,"after":1,"toastReallyTookTheRow":true}
R-B {"activityRowUp_braille":1,"suppressedWhileRunning_braille":1,
     "overlayReallyUp":true,"activityRowGone":true}
R-C {"todoPanel_braille":1,"toolCard_braille":1,"combinedInOneFrame":2}
```

- **R‑A confirms §2.2 independently.** `1 → 0 → 1`, with the toast verified to
  have actually taken the row. The root cause stands.

- **R‑B answers a question §7 leaves open, in the report's favour.** It measures
  the state fix #1 would create during a toast, reached through the only other
  route into `activityVisible === false && running` that exists today — the D‑3
  overlay carve‑out — with **no** `text_delta` ever emitted, i.e. the shape of
  the frame at the instant `Plan approved. Implementing.` fires. The count is
  **1, not 0**, because `reducer.ts:886-897` (`turnStart`) appends an assistant
  entry with `streaming: true` at the head of *every* turn:

  ```ts
  // packages/cli/src/agent/reducer.ts:886-897
  case 'turnStart': {
    const entry: Entry = { id, kind: 'assistant', text: '', /* … */ streaming: true };
    return { ...state, seq, ...appendEntry(state, state.entries, entry), streamingId: id };
  }
  ```

  So `Transcript.tsx:238` always has something to animate from a turn's first
  frame, and un‑suppression never yields zero in practice. This is what makes
  candidate #1 a real fix rather than a partial one.

- **R‑C contradicts §7's fourth justification.** `TodoPanel` (one `in_progress`
  item, `running`, `reducedMotion={false}`) and `ToolCard` (`status="running"`,
  `reducedMotion={false}`) — the exact props `App` hands them when
  `viewReducedMotion` is `false` — animate **two** spinners between them, in one
  frame. Full‑screen mounts both. `viewReducedMotion === false` mid‑run is
  therefore not a one‑spinner state, and the repo says so in three places:

  ```
  // ActivityLine.tsx:26-30 — "Emergently they put up to five braille animations
  //   on adjacent rows, each on its own 80 ms timer"
  // TeamPanel.tsx:191-193  — "One spinner per RUNNING row, and the row cap is 5
  //   precisely because five is the documented maximum number of simultaneous
  //   spinners."
  // single-spinner.test.tsx:8-10 — "a single ordinary turn put up to five
  //   braille animations on adjacent rows"
  ```

  Consequently `single-spinner.test.tsx:479` asserts
  `expect(brailleCount(frame)).toBeGreaterThanOrEqual(1)` for AC‑5 — **not**
  `toBe(1)`. The looseness is deliberate: the round‑1 authors already knew the
  un‑suppressed state is not single‑valued. §7 reads that same AC‑5 as a guard
  that "fails from the opposite direction" without noticing what its assertion
  concedes.

---

## 3. Root cause analysis

### 3.1 The claim `App` makes, and why it is false

`App.tsx:1705` names a constant and documents it as the activity row's mount condition:

```ts
// packages/cli/src/ui/App.tsx:1699-1705
// THE MOUNT CONDITION, NAMED ONCE AND USED TWICE (D-4). This const both gates
// the `<ActivityLine>` element below and feeds the derivation on the next
// line, so "the line is up" and "every other site is still" can never
// disagree.
const activityVisible = running && !overlayNode;
```

```ts
// packages/cli/src/ui/App.tsx:1716
const viewReducedMotion = reducedMotion || activityVisible;
```

`activityVisible` is **not** the mount condition. It is the condition under which `App`
*offers* an `<ActivityLine>` element to `BottomStatusRow` (`App.tsx:1880`). Whether that
element is ever mounted is decided one component down:

```ts
// packages/cli/src/ui/BottomStatusRow.tsx:77-83
// A toast wins the row outright.
if (toasts.length > 0) return <ToastStack toasts={toasts} theme={theme} mode={mode} />;
...
if (activity) return <Box flexShrink={0}>{activity}</Box>;
if (update)   return <Box flexShrink={0}>{update}</Box>;
```

Line 78 returns before line 82 is ever reached. So when `toasts.length > 0` during a run:

| | value | consequence |
|---|---|---|
| `activityVisible` | `true` | `viewReducedMotion === true` → all four view consumers go still |
| `<ActivityLine>` | passed as `activity` | **never mounted** — line 78 returned first |
| frame | — | **zero animations** |

The two halves of D‑4 disagree in exactly the way D‑4 was written to prevent, and they
disagree *silently*: both halves individually look correct, and every component‑level test
stays green because no component is wrong.

### 3.2 Why the four consumers go still — measured, not inferred

`viewReducedMotion` reaches exactly four call sites (`App.tsx:1757`, `:1777`, `:1840`,
`:1853`), and each leaf gates its spinner on it:

```ts
// packages/cli/src/ui/entries/ToolCard.tsx:227-231
const badge =
  status === 'running' && !reducedMotion && caps.unicode ? (
    <Text color={color}><Spinner type="dots" /> running</Text>
  ) : (
    <Text color={color}>{status === 'running' ? `${glyphs.spinnerStill} ` : ''}…</Text>
  );
```

```ts
// packages/cli/src/ui/Transcript.tsx:238
const animate = entry.streaming && !reducedMotion && caps.unicode;
```

Rendering `ToolCard` directly with each value of the prop (`status="running"`,
`caps.unicode = true`) measures the delta:

```
reducedMotionFalse: { braille: 1, row: "bash ls  ⠋ running" }   <-- wiring before 64ebe3f9
reducedMotionTrue:  { braille: 0, row: "bash ls  · running" }   <-- wiring after
```

Before `64ebe3f9` those four sites received the raw `cfg.reducedMotion` (`false` by
default) — the diff hunk is literally `reducedMotion={reducedMotion}` →
`reducedMotion={viewReducedMotion}` at those four lines and nowhere else. So in the toast
window the pre‑change build still had the tool badge and the streaming marker animating.
**The hole is new in `64ebe3f9`.**

### 3.3 What is *not* the cause (ruled out by measurement)

Two plausible stories were tested and eliminated, so the fix node does not re‑walk them:

- **`ActivityLine` itself is broken / frozen.** No. Rendered standalone with
  `reducedMotion={false}` and `caps.unicode = true`, it cycles the full ten‑frame `dots`
  sequence: `⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏` (10 distinct glyphs sampled over 600 ms).
- **Something above it — the render governor, `React.memo`, the frame differ — suppresses
  repaints.** No. The full `App`, mounted with the production‑shaped fixture
  (`renderGovernor: true`, `maxRenderIntervalMs: 320`, `diffRender: true`), cycles all ten
  glyphs with **exactly one** braille per frame over a 1 s sample. `ink-spinner`
  (`node_modules/ink-spinner/build/index.js`) owns its own `setInterval` + `setState`, so
  no ancestor memo boundary can freeze it; and `frame-differ.ts:264` repaints any row whose
  string changed, which a braille change always is.

So the animation is present and correct *whenever the row is mounted*. The bug is purely
that the row sometimes is not.

### 3.4 How often the hole opens

Toast TTL is 2500 ms (`reducer.ts:58`, applied at `:1253`), auto‑dismissed by the effect at
`App.tsx:788-795`. Every one of these pushes a toast and can fire **while `running` is
true**:

| Site | Toast | Trigger |
|---|---|---|
| `App.tsx:1119` | `Steering queued.` | **typing a steer message + Enter — what the composer invites on every run** |
| `App.tsx:1250` | `Plan approved. Implementing.` | approving a plan — fires as the implementation run begins |
| `App.tsx:1252` | `Revision requested.` | plan revision |
| `App.tsx:1391-1393` | `Thinking shown/hidden.` | `Ctrl+T` |
| `App.tsx:1405` | `No tool output to expand.` | `Ctrl+O` |
| `App.tsx:1301` | `Press Ctrl+C again to exit.` | `Ctrl+C` |
| `App.tsx:1050/1052` | `… mode …` | `Shift+Tab` mid‑run |
| `App.tsx:564` | `… mode.` | deferred plan→build applied at `turn_end` |
| `App.tsx:1227` / `:1220` | `Model set to …` / `Settings saved.` | slash commands mid‑run |
| `App.tsx:1010` | `… installed - restart aragon to apply.` | auto‑update lands mid‑run |
| `use-startup-notices.ts:80/92` | `Logging stopped: …` / config parse warning | can land on a `--initial-prompt` boot run |

Consecutive toasts extend the window; the effect at `App.tsx:788` arms one timer per toast,
so three acks in quick succession is a ~7 s dead frame.

### 3.5 Why round 1's own review did not catch it

`spec.md` §7.5 carries eight manual rows, and the implementing commit closes with:

> NOT DONE, and it is a gate rather than a footnote: the manual rows in spec.md 7.5.
> … Nothing in the suite substitutes for eyeballing a frame.

Row 6 is the closest — it drives a *real* mid‑run overlay to check the D‑3 carve‑out — but
**no row presses a key that acks with a toast during a run**. Risk **R‑1** in the same spec
predicts this exact failure (*"the mount condition and the suppression condition drift
apart, leaving a run with zero animations or two"*) and claims it is mitigated because
"they are the same named const". They are the same const; the const is simply not the mount
condition. The mitigation was reasoning about the wrong boundary, and the manual gate that
would have exposed it was never run.

---

## 4. The second reading — inert per‑item icons (claim B)

Even with the toast hole closed, during a normal run the frame contains one animation and a
set of inert dots:

```
● listing                        <- streaming assistant marker, static
❯ bash ls  · running             <- tool badge, static
 ⠋ Running bash                  <- the one animation
```

`spec.md` §7.5 row 2 asserts this verbatim as the intended outcome (*"The card badge shows
`· running`, not a second animation"*), and §1.1 records the round‑1 request that motivated
it. So it is design, not defect. But it is fair to read "需要小图标有等待输出的动画效果"
(*the small icon needs a waiting‑for‑output animation*) as pushback on precisely that: `·`
is drawn from the same dot vocabulary as settled/idle markers, so a card that is **waiting
for output** and a card that is **done** differ only by a word.

Two facts bound how much of round 1 would have to move to address this:

- `·` (`glyphs.ts:161`, `*` in the ASCII tier at `:232`) is shared by `ToolCard`,
  `FastCard`, `TeamCard` and `TeamPanel` still branches.
- Any second *braille* animation re‑creates the exact complaint round 1 was filed to fix —
  two 80 ms timers on adjacent rows, out of phase. `single-spinner.test.tsx` AC‑1 would go
  red, correctly.

That constrains the design space rather than closing it: a **phase‑locked**, **visually
subordinate** indicator (one shared frame index, non‑braille glyph tier, dimmer colour) is
not the thing round 1 removed. It is out of scope for this report to design it.

---

## 5. Impact surface

| Dimension | Extent |
|---|---|
| **Who** | Every `aragon` CLI user on `0.5.11+` (the round‑1 wiring shipped in `64ebe3f9`), both `--fullscreen` and inline — `BottomStatusRow.tsx:78` is not mode‑gated. |
| **When** | Every mid‑run toast: ~2.5 s per toast, extended by consecutive toasts. Steering and plan approval are routine, so a typical long run hits it several times. |
| **Severity** | Cosmetic but high‑salience: for those seconds the TUI is indistinguishable from a hung process, during long tool calls where "is it stuck?" is the user's actual question. No data loss, no functional break. |
| **Also affected** | The AragonMesh desktop `aragon-agent-cli` agent type runs this same binary in a PTY, so unattended runs show the same dead frames in the embedded terminal. |
| **Not affected** | `reducedMotion: true` users (already zero animations by choice, `load.ts:715`); ASCII‑tier terminals where `caps.unicode === false` (never animated in any build — `ActivityLine.tsx:92-93` and all seven leaves gate on `caps.unicode`); headless / `-p` paths, which mount no TUI. |

---

## 6. Candidate fixes

| # | Fix | Invasiveness | Risk | Effort | Notes |
|---|---|---|---|---|---|
| **1** | Make the signal follow the row's **actual** occupancy: `const activityVisible = running && !overlayNode && state.toasts.length === 0;` (`App.tsx:1705`). One expression, one file. | 1 line | **Low.** Restores exactly the pre‑`64ebe3f9` behaviour inside the toast window and changes nothing outside it. Fails loudly if wrong: AC‑1 (`brailleCount === 1`) and AC‑5 both key off this const. | ~15 min + tests | Extends the spec's own D‑3 rule (*"the signal follows the mount condition, not `running`"*) to the second thing that can pre‑empt the row. Restores `activityVisible`'s comment to being true. |
| **2** | Invert ownership: `BottomStatusRow` reports what it actually rendered (callback or a derived `useMemo` shared by both), so `App` cannot re‑derive it wrongly. | ~2 files, one new contract | **Medium.** A render‑phase callback into a parent is a re‑render hazard; a shared selector is safer but adds an abstraction to a component whose whole design note argues against new slots. | ~1–2 h | Structurally the *correct* fix — it removes the possibility of drift rather than patching one instance. Overkill unless a third occupant is coming. |
| **3** | Let the activity row and the toast **coexist**: render the spinner as a prefix on the toast row while running. | `BottomStatusRow` + layout | **High.** `BottomStatusRow.tsx:5-27` documents at length that this row is budget‑fixed at one row precisely so the viewport never jumps; a prefix competes with toast text for width and `viewportRows()` (`layout/budget.ts`) is not involved in the decision. Would need `budget.test.ts` revisited. | ~half day | Nicest end state visually (the ack *and* the life signal), worst cost/benefit here. |
| **4** | Address claim B: give the per‑item icons a phase‑locked, non‑braille "waiting" animation driven by the existing 200 ms ticker. | 4–5 leaf components + `App` | **Medium‑high.** Must not reintroduce AC‑1's duplicate; needs a new shared frame source and a glyph‑tier story for ASCII. | ~half day+ | **Orthogonal to the defect** — do it only after #1, and only if the user confirms reading B. Requires a design decision, not a bug fix. |

---

## 7. Recommended fix

**Take #1 now; treat #4 as a separate, user‑confirmed follow‑up.**

Justification:

1. **It is the actual defect.** #1 restores a hard invariant the product already committed
   to in writing — *"while a run is in flight, the frame carries a life signal"* — and it
   is the only candidate backed by a reproduced, measured failure (`1 → 0 → 1`).
2. **It matches the spec's own reasoning, so it will survive review.** D‑3 already
   establishes that the suppression signal must track the row's *visibility*, not
   `running`. The authors enumerated one pre‑emptor (`overlayNode`) and missed the other
   (`toasts`); adding it is completing the rule, not amending it.
3. **It is the smallest change with the loudest guard.** Both `activityVisible` consumers
   are one const apart, and AC‑1 / AC‑5 fail from opposite directions if the two ever
   disagree again — so the regression test written for this bug (§2.2, `1 → 0 → 1`) slots
   directly into `single-spinner.test.tsx` next to them.
4. **It leaves the round‑1 outcome intact.** Exactly one animation while the activity row
   is up; exactly one animation while a toast is up (the pre‑existing transcript/tool
   badge). Never two, never zero.

Two things the implementing node must not skip:

- **Add the §2.2 case to `single-spinner.test.tsx`**, not to a new file — R‑1's guard lives
  there, and this bug is R‑1 firing.
- **Run `spec.md` §7.5's manual rows**, which the round‑1 commit explicitly left open as a
  gate. Add a row 9: *"press `Ctrl+T` mid‑run — one animation before, during and after the
  ack."* This bug is what an unexecuted manual gate costs.

Claim B (§4) should go back to the user as a question before any code moves: it is a design
change to something they themselves requested one round earlier, and "顶级" is a quality
bar, not a specification.

---

## 8. Evidence index

| Evidence | Where |
|---|---|
| `1 → 0 → 1` braille count around a mid‑run toast, recovery at ~2100 ms | §2.2, reproducible via the snippet |
| Before/during frames, ANSI‑stripped | §2.3 |
| `ToolCard` badge measured under both prop values (`⠋ running` vs `· running`) | §3.2 |
| `activityVisible` derivation and its comment | `packages/cli/src/ui/App.tsx:1699-1716` |
| Toast pre‑empts activity, unconditionally and in both modes | `packages/cli/src/ui/BottomStatusRow.tsx:77-83` |
| The four widened consumers | `App.tsx:1757`, `:1777`, `:1840`, `:1853` |
| The activity row keeps the raw flag | `App.tsx:1884`, `ActivityLine.tsx:92-93` |
| Leaf gates | `ToolCard.tsx:227-231`, `Transcript.tsx:238` |
| Toast TTL 2500 ms and its auto‑dismiss timer | `agent/reducer.ts:58`, `:1253`; `App.tsx:788-795` |
| `ActivityLine` animates correctly in isolation and inside `App` | §3.3, 10/10 `dots` frames |
| The design rule this bug violates, and the risk that predicted it | `docs/plans/single-spinner-while-running/spec.md` D‑3, R‑1, §7.5 |
| Re‑measured `1 → 0 → 1`; the un‑suppressed state measured at 1 and at 2 | §2.4 (R‑A / R‑B / R‑C) |
| Every turn opens with a `streaming: true` assistant entry, so un‑suppression never yields zero | `agent/reducer.ts:886-897` |
| The un‑suppressed state is documented as up to **five** simultaneous spinners | `ActivityLine.tsx:26-30`, `TeamPanel.tsx:191-193`, `single-spinner.test.tsx:8-10` |
| AC‑5 deliberately asserts `>= 1`, not `=== 1`, for exactly that reason | `single-spinner.test.tsx:479` |
| What is mounted per mode during the D‑3 carve‑out (transcript / panels table) | `spec.md` §3.6 |
| The row's precedence contract, and the assertion a fix must not break | `bottom-status-row.test.tsx:63-88` |
| Toast trigger line numbers in §3.4, spot‑checked | `App.tsx:1010`, `:1119`, `:1250`, `:1252`, `:1301`, `:1391`, `:1405`; `use-startup-notices.ts:78-94` |

---

## 评审结论

### Audit result

**The root cause is correct, and it is the right bug to fix.** Every citation in
§1–§5 was checked against the source on `5b05e7ec` and every one is verbatim
accurate: `App.tsx:1705` / `:1716`, the four consumers at `:1757` / `:1777` /
`:1840` / `:1853`, the raw flag at `:1884`, `BottomStatusRow.tsx:77-83`,
`ToolCard.tsx:227-231`, `Transcript.tsx:238`, `ActivityLine.tsx:22-23` /
`:92-93`, `DEFAULT_TOAST_TTL_MS = 2500` at `reducer.ts:58`, the auto‑dismiss
effect at `App.tsx:788-795`, all eight spot‑checked toast triggers in §3.4, and
`spec.md` D‑3 (`:123`), R‑1 (`:583`), §7.5. The `1 → 0 → 1` failure was
reproduced independently (§2.4 R‑A). The three eliminations in §3.3 hold. §5's
"not affected" set is right.

The report is nevertheless **not adopted as written**, because the justification
for its recommended fix contains one false statement that changes which fix is
correct.

### Corrections

**F‑1 (material). §7's fourth justification is false, and it is the load‑bearing
one.** It claims candidate #1 leaves "exactly one animation while a toast is up
… Never two, never zero." Measured (§2.4 R‑C): a single `in_progress` todo and a
single running tool — the ordinary shape of a full‑screen run — animate **two**
spinners between them once `viewReducedMotion` is `false`. The repo states the
upper bound as **five** in three independent places (`ActivityLine.tsx:26-30`,
`TeamPanel.tsx:191-193`, `single-spinner.test.tsx:8-10`), and `spec.md` §3.6
already tabulates it for the D‑3 carve‑out ("up to five team‑panel rows"). The
proof is in round 1's own test suite: AC‑5 asserts
`toBeGreaterThanOrEqual(1)`, not `toBe(1)` (`single-spinner.test.tsx:479`),
because its authors knew the un‑suppressed state is not single‑valued.

So candidate #1 does not restore one spinner during the toast window. It
restores the **pre‑round‑1 frame** — up to five braille timers on adjacent rows,
out of phase — for the toast's TTL. That is the exact defect round 1 was filed
to remove, and unlike the overlay carve‑out it is fully visible: §3.6 excuses
the carve‑out partly because in full‑screen the overlay *replaces the viewport*,
so the transcript is not mounted. During a toast there is no overlay. Transcript,
todo rail and team panel are all on screen, in both modes. **The carve‑out's
justification does not transfer, and §7 borrows it as if it did.**

**F‑2. The §2.2 regression test cannot detect F‑1.** `toolRunningController`
produces exactly one animating site, so `expect(during).toBe(1)` goes green on
candidate #1 while the invariant is broken in any run that also has a todo rail
or a team roster. A test whose fixture is too thin to express the failure is the
same class of miss as the unexecuted §7.5 manual gate that let this bug ship —
§3.5's own diagnosis, applied to §2.2.

**F‑3. §6 mis‑ranks candidate #2.** It is called "structurally the *correct*
fix". An accurate occupancy signal is still `false` during a toast, so #2
produces the **same frame** as #1 and inherits F‑1 in full, while adding a
render‑phase parent callback. #1 strictly dominates #2 here; #2 is not the safer
option, only the costlier one.

**One correction in the report's favour.** §7 never establishes that
un‑suppression reliably yields ≥ 1, and a reviewer would reasonably suspect a
residual dead window at turn start. There is none: `reducer.ts:886-897` appends a
`streaming: true` assistant entry at the head of every turn, measured at §2.4
R‑B. Candidate #1 is therefore a real fix, not a partial one — which is why it
remains the fallback below rather than being struck out.

### Final recommended fix

> **Compose, don't choose.** Leave `activityVisible` at `App.tsx:1705` exactly as
> it is, and make `BottomStatusRow` render the **spinner glyph alone** next to
> `ToastStack` when `activity` is non‑null — a row‑direction box in the existing
> toast branch, not a second row and not a new `AppShell` slot.

```tsx
// packages/cli/src/ui/BottomStatusRow.tsx — the toast branch, in shape only.
if (toasts.length > 0)
  return (
    <Box flexDirection="row" flexShrink={0}>
      {activityGlyph /* the bare spinner, or nothing when it would be static */}
      <ToastStack toasts={toasts} theme={theme} mode={mode} />
    </Box>
  );
```

Justification, in the order that decides it:

1. **It is the only candidate that satisfies both halves of the invariant.** The
   product committed in writing to *one* life signal while a run is in flight —
   never zero (D‑3) and never two (D‑1 / AC‑1). #1 and #2 buy "never zero" by
   selling "never two" for 2.5 s at a time; #3 keeps both. Given that round 2 is
   already a complaint about round 1's outcome, spending the fix on a transient
   re‑run of round 1's defect is how this becomes round 3.

2. **It fixes the cause rather than enumerating the symptom.** The bug is that
   `activityVisible`'s comment at `App.tsx:1695` — "THE MOUNT CONDITION, NAMED
   ONCE AND USED TWICE" — is a false claim about `BottomStatusRow`. Composing
   makes the claim **true**: the spinner is mounted whenever `activityVisible` is
   true, so D‑4 holds by construction and R‑1 is closed. Candidate #1 leaves the
   comment false and patches the one pre‑emptor we happen to know about; the
   third occupant (the update line is already queued behind two) reopens it.

3. **It survives the tests that exist, which is a checkable claim, not a hope.**
   `bottom-status-row.test.tsx:77-84` asserts that during a toast the frame
   contains the toast text and `hasPhrase(frame) === false`. Composing the
   **glyph only** — never the phrase, never the elapsed clock — keeps that
   assertion green and keeps the toast's full width for its text.
   `:64-75` asserts full‑screen is exactly one row in all four states; a
   row‑direction box holding two one‑row children is still one row, so
   `budget.ts`, `AppShell.tsx` and AC‑8a (`budget.test.ts:93`) stay untouched —
   which is what `BottomStatusRow.tsx:5-27` actually forbids disturbing.

4. **Its blast radius is one component.** No change to the seven leaf gates, no
   change to `viewReducedMotion`, no new prop threaded through `App`'s render.
   `ActivityLine` keeps `reducedMotion={reducedMotion}` raw (D‑5) and its phrase
   rotation is untouched.

5. **It stays compatible with claim B.** If the user confirms §4's reading, a
   phase‑locked per‑item indicator has to reason about one owner of motion. Under
   this fix there is always exactly one. Under #1 the per‑item sites are already
   animating during toasts, and any new scheme would have to special‑case that
   window.

**Boundary the implementer must handle:** when the spinner would be static —
`!caps.unicode || reducedMotion`, the branch at `ActivityLine.tsx:92-93` —
prefix **nothing**. Adding a static `·` in front of every toast is a visible
change to ASCII terminals and to users who asked for stillness, neither of whom
has this bug. Those builds must come out byte‑identical.

**Fallback, if the fix node judges the layout risk too high for this round:**
take candidate #1 (`&& state.toasts.length === 0`), but then (a) the §2.2
regression case must be rebuilt on a fixture that mounts a todo rail *and* a
running tool, asserting the real post‑fix count rather than `1`, and (b) the
transient multi‑spinner window must be recorded in `spec.md` as a knowing
deviation from AC‑1, not left for the next reader to rediscover. Do not take #2:
per F‑3 it costs more and buys nothing over #1.

### Unchanged from the report

- **Candidates #3‑as‑described and #4 are correctly scoped.** The recommendation
  above is the *minimal* form of #3 — glyph‑only composition — and not the
  "spinner as a prefix competing with toast text for width" the §6 table prices
  at half a day; that row's High risk rating is for a fuller variant.
- **Claim B (§4) goes back to the user before any code moves.** It is a design
  change to something they requested one round earlier, and 顶级 is a quality
  bar, not a specification. Concur.
- **`spec.md` §7.5's manual rows are still a gate**, and row 9 — *press `Ctrl+T`
  mid‑run; exactly one animation before, during and after the ack* — must be run
  on a real terminal. Under this fix "exactly one" is assertable during the ack
  as well, which it would not be under #1.

**Definition of done for the next node:** one animation in the frame at every
instant of a run, with a toast up or without one, in full‑screen and inline —
and `App.tsx:1695`'s comment true again when it is finished.

---

## 实施过程发现的方案缺陷

The recommended fix (glyph‑only composition in `BottomStatusRow`) **held as
designed and was implemented unchanged**. Nothing below overturns it. What
follows is the set of traps found while executing it, three of which produce a
result that looks correct and reports nothing.

### IF‑1. `BottomStatusRow` must not import `ink-spinner`, and the sketch implies it does

`spinner-census.test.ts` (AC‑9's second case) asserts the **exact list** of files
under `src/ui/**` that import `ink-spinner`, and calls that list "the CHECKLIST
for §3.1". Writing `<Spinner type="dots" />` inline in the toast branch — the
literal reading of §7's `{activityGlyph}` sketch — adds a ninth entry and turns
that assertion red, for a component that is not a new animated *site* but a
second *renderer* of the one that already exists.

Resolved by exporting a factory from the file that already owns the decision:

```ts
// ActivityLine.tsx
export function liveSpinner(reducedMotion, caps): React.ReactElement | null {
  return caps.unicode && !reducedMotion ? <Spinner type="dots" /> : null;
}
```

`ActivityLine` now renders `liveSpinner(...) ?? glyphs.spinnerStill`, so the row
and the composed glyph cannot disagree about *when* the spinner is live — §7's
boundary ("prefix nothing when it would be static") holds by construction rather
than through a second copy of the condition. A FUNCTION and not a component:
`<LiveSpinner/>` would be truthy even when it rendered `null`, which is exactly
the trap `BottomStatusRow`'s own `update` prop documents.

### IF‑2. A row‑direction wrapper silently destroys the toast's truncation

`ToastStack`'s full‑screen box is `flexShrink={0}`. As a direct child of
`AppShell`'s **column** it is stretched to `cols` on the cross axis, and that is
the width `wrap="truncate"` reads. Moved into a **row** wrapper, width becomes
the main axis, `flexShrink={0}` keeps its full intrinsic width, and the text is
clipped by the frame edge instead of truncated. Measured, a 140‑char toast at
100 columns:

```
composed, row wrapper   len=100, ends 'x'   <-- the ellipsis is GONE
unchanged path          len=100, ends '…'
```

Both are 100 columns and exactly one row, so every existing assertion — including
`bottom-status-row.test.tsx:64-75`, the one §7's third justification leans on —
stays green while the ack quietly loses the marker that says it was cut. Fixed by
making the wrapper `<Box flexDirection="column" flexGrow={1} flexShrink={1}
overflow="hidden">`: inside a column, width is the cross axis again,
`flexShrink` does not apply to it, and the stack stretches to the width
`flexGrow` won. Re‑measured: ends `…`.

This is the concrete form of the "High" risk §6 priced for candidate #3, and it
is the whole of it — one Yoga axis, not half a day.

### IF‑3. §2.2's regression case is vacuous on the fixture the review prescribes

F‑2 correctly requires a fixture thick enough to express the failure, and
`toolRunningController` + a todo rail is that fixture. But the report's own
`hasActivityRow` predicate (`ACTIVITY_PHRASES.some(...)`) is **false in every
frame of that fixture**: with a tool in flight `ActivityLine` takes its L4 branch
and the row reads `Running bash`, carrying no phrase at all. So
`expect(hasActivityRow(during)).toBe(false)` — the assertion that is supposed to
prove the toast really took the row — passes whether or not it did, and the case
measures nothing while reporting green. The shipped AC‑12 uses
`expect(during).not.toContain('Running bash')`, with the reason recorded inline.

### IF‑4. F‑1 confirmed by measurement: candidate #1 reads **3**, not 1

The rejection of candidate #1 rested on R‑C's claim that un‑suppression is not a
one‑spinner state. Verified directly, by temporarily applying candidate #1
(`activityVisible && state.toasts.length === 0`) and running AC‑12 against the
thick fixture:

```
AssertionError: expected 3 to be 1
```

Three braille timers on adjacent rows during the ack — the transcript marker, the
tool badge and the todo rail — i.e. round 1's defect, transiently restored. The
same cases against the **unfixed** build give `expected 0 to be 1` (AC‑12) and
`expected 0 to be greater than 1` (AC‑13). The new cases therefore fail from both
directions and on both rejected states, which is what F‑2 asked for.

### Verification actually performed

- `npm run typecheck -w packages/cli` — clean (both `tsconfig.json` and
  `tsconfig.test.json`).
- `npx vitest run` in `packages/cli` — **145 files, 2075 passed / 5 skipped**.
  Includes the whole of `spec.md` §7.4's "must NOT change" list, unmodified.
- §2.2's reproduction, rebuilt on the thick fixture as **AC‑12** and now reading
  `1 → 1 → 1`. **AC‑13** pins that the glyph beside the toast actually *moves*
  (more than one distinct `dots` frame sampled inside the TTL) — presence is not
  the round‑2 claim, motion is. **AC‑14** pins §7's boundary: `reducedMotion` and
  the ASCII tier prefix nothing.
- Direct frame dumps in every state, confirming the unchanged paths are
  byte‑identical and the composed row is one row:

  ```
  FS toast + run  | ⠋ ℹ Steering queued.|
  FS toast only   | ℹ Steering queued.|      <-- unchanged
  FS run only     | ⠋ Running bash|          <-- unchanged
  FS reducedMotion| ℹ Steering queued.|      <-- no prefix
  FS ascii tier   | ℹ Steering queued.|      <-- no prefix
  INLINE t + run  |⠋ ℹ Steering queued.|     <-- flush with the inline left edge
  ```

**Still open, and it is a gate rather than a footnote:** `spec.md` §7.5's manual
rows, now including the row 9 this bug earned (added in the same change). They
need a real TTY and a live model, which this node does not have — that is the
same gate round 1 left open, and leaving it open is what produced round 2.
Claim B (§4) remains a question for the user; no code was moved for it.
