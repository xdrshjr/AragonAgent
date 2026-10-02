# One spinner per run — the activity line owns the animation

Version: **v2** (design, reviewed)
Status: implemented — §4's file plan landed unchanged; the three findings the build
surfaced are recorded in 「实施过程发现的方案缺陷」at the end of this document.
Scope: `packages/cli/src/ui` only. `packages/core` is not touched. No config key, no CLI
flag, no env var, no persisted state, no protocol change.
Feature slug: `single-spinner-while-running`

---

## 评审记录 (Review Notes)

Reviewed against the tree at `packages/cli/src/**`. Every line number below was re-read, not
inferred. The core of the design — the `reducedMotion` widening (D-2), the `<Static>` safety
proof (§3.5), and the census — **verified sound**; the findings are concentrated in the
acceptance criteria and in two factual claims about which sites survive the overlay carve-out.

### Verified correct (no action)

- The census is **exhaustive**. Exactly eight files under `packages/cli/src` import
  `ink-spinner`, and they are exactly §3.1's eight rows. No source file contains a braille
  literal — only four test files do — so AC-1's counter is sound and there is no ninth site.
- `App.tsx` reads `reducedMotion` at exactly five call sites (`:1732`, `:1752`, `:1815`,
  `:1828`, `:1854`) plus its definition at `:279`. Nothing else consumes it. D-2's premise holds.
- All six `computeSettledCount` break clauses exist as claimed (`Transcript.tsx:84`, `:85`,
  `:91`, `:97`, `:104`, `:109`). §3.5's `<Static>` proof stands.
- `EntryView`'s comparator already carries `a.reducedMotion === b.reducedMotion`
  (`Transcript.tsx:378`), so no comparator term is added — the eleventh-term trap is avoided,
  as claimed.
- `badgeLabel(name, 'running', preview)` returns exactly `running` (`ToolCard.tsx:129-138`);
  AC-4's expected string is literal, not approximate.
- **No information is lost in either panel.** `TeamPanel.tsx:258-263` returns
  `glyphs.spinnerStill` for a running run and a *different* glyph for every other phase;
  `TodoPanel.tsx:72-76` returns `glyphs.todoActive` for `in_progress` alone. A suppressed row
  is still distinguishable from a settled one, so R-5 holds at both sites.
- `caps.unicode` is `cfg.unicode ?? detected.unicode` (`App.tsx:274`), so AC-8 is reachable
  from the test `CONFIG` exactly as §7.2 assumes.
- `app.test.tsx:872-885` is verbatim what §7.3 describes, including the whole-frame
  `toMatch(/[⠀-⣿]/)`. The pass-for-the-wrong-reason analysis is correct.

### P0

| ID | Concern |
|---|---|
| **P0-1** | **AC-5's procedure cannot be executed, so the riskiest decision in the design (D-3) would ship unpinned.** §7.2 tests AC-5 "by writing `?` to stdin mid-run in inline mode" and manual row 6 says "mid-run, press `?`". `PromptInput.tsx:421` gates that shortcut on **`!running`** (`input === '?' && buffer.length === 0 && !running && onHelp`), and `/help` / `/model` / `/settings` are slash commands (`commands/builtins.ts:169-179`) that need a submit — also unreachable mid-run. **No `/help` overlay can exist while `running` is true.** The overlays that *are* reachable mid-run are `confirm` (`App.tsx:879`, `:954`), `question` and `plan` (`App.tsx:905`), all raised from inside tool execution while the agent loop blocks. Left as written, an implementer either fails the test or silently rewrites it into a non-running case, where it passes vacuously — and R-7 names AC-5 as the *only* guard against "someone simplifies D-3 to `running`". **Resolved in v2**: AC-5, §7.2 and manual row 6 now drive a real mid-run overlay through `humanInputBridge`, reusing the harness already proven at `app.test.tsx:548-593`. |

### P1

| ID | Concern |
|---|---|
| **P1-1** | **§3.6 and §6's truth-table row 5 misstate which sites survive the carve-out, in both directions.** `showRail` includes `overlay === null` (`App.tsx:1516-1522`), so `TodoPanel` *never* renders under an overlay — it cannot animate there. `TeamPanel` has **no** overlay guard (`App.tsx:1805-1819`) and `AppShell` renders the `team` slot outside the viewport in both branches (`AppShell.tsx:88-91`, `:119-125`), so up to five team rows animate under an overlay — **including in full-screen**, where §3.6 asserts "nothing animates either way". Row 5's "transcript sites only" is likewise wrong. **Resolved in v2.** |
| **P1-2** | **C-1's code sketch drops `FastCard`'s leading gutter and the spinner/head separator.** Both of today's branches open with `{'  '}` and the animated one renders `<Spinner /> {head}` — a space between (`FastCard.tsx:107-118`). §3.7 specified only "first child is `animate ? <Spinner/> : (live ? '· ' : '')`, followed by `{head}`"; implemented literally that shifts the head two columns left against the `fast` label and glues the spinner to the text. §3.7 also called `wrap="truncate"` on the animated path "the safer of the two behaviours" without noting it is a real rendering change, now observable in the carve-out state. **Resolved in v2.** |
| **P1-3** | **AC-9 does not guard the failure R-2 names.** The scan proves every `ink-spinner` importer *reads* `reducedMotion`; it is blind to `App.tsx` handing one of them the raw `cfg.reducedMotion`. That is precisely R-2's wording ("a future reader threads `cfg.reducedMotion` straight into a new consumer"), it is silent, and it is one identifier's difference. **Resolved in v2** by AC-11: a static assertion on `App.tsx` that `reducedMotion={reducedMotion}` occurs exactly once and `reducedMotion={viewReducedMotion}` exactly four times. |

### P2 (all addressed in v2, none blocking)

| ID | Concern |
|---|---|
| **P2-1** | `TodoPanel` is **full-screen only** (`showRail` requires `fullscreen`, `App.tsx:1517`); inline gets `TodoStrip`, which has no spinner. D-6's "the rail is on screen simultaneously with the composer" and manual row 4 both needed the mode named, else row 4 passes for the wrong reason in inline. |
| **P2-2** | `App.tsx:1826` passes `running={state.status === 'running'}` inline — a third copy of the boolean D-4 has just finished naming, three lines from the edit. Reuse `running`. |
| **P2-3** | §3.3 said "five prop edits", then "six edited lines"; the table has six rows, one of them marked unchanged. Actual count: five edited lines, two new. |
| **P2-4** | `RetryCard` is the one suppressible site with **no** static glyph — it renders the spinner element or nothing (`RetryCard.tsx:99-105`), where the other six substitute `glyphs.spinnerStill`. That matches today's reduced-motion behaviour so it is defensible, but §3.1's "Text lost: none (pre-existing)" reads as if the row is unchanged, and the row does jog two columns when an overlay opens or closes. Stated explicitly rather than fixed, to keep `retry-render.test.tsx` in §7.4. |
| **P2-5** | §3.5's break-clause table lists a "todo (card)" animated kind. The clause exists (`Transcript.tsx:97`) but no todo *card* renders a spinner — only `TodoPanel`, which is chrome. The mapping is over-inclusive, so "total and one-to-one" was too strong; over-inclusive is the safe direction. |

---

## 1. Overview

### 1.1 The requirement

Verbatim, as filed:

> 这个项目现在 Agent 执行任务的时候，它下方用户输入区域上方有一个显示旋转等待状态，然后以及一个提示的这样的一个显示。
> 但是同时呢，其上方 Agent 执行的地方也有一个旋转等待状态的提示。
> 需要调整一下，只需要用户输入栏上方的这样的一个旋转等待图标，然后上方 Agent 的执行的地方就不再需要显示旋转等待图标了，
> 整个 Agent 的执行的过程中只显示一个旋转等待状态的图标就行。

In the vocabulary of this tree: `ActivityLine` (`ui/ActivityLine.tsx`) — the one row directly
above the composer that carries a braille spinner plus a phrase (`Percolating…`, or
`Running bash` when a tool is in flight) — is the spinner the user wants to keep. Every other
animated spinner on screen during a run is to go still. The end state is an invariant, not a
preference: **while the activity line is on screen, it is the only animated spinner in the
frame.**

### 1.2 Why the screen has more than one today

Nothing is wrong per component. Seven independent call sites each decided, correctly and in
isolation, that "this thing is live, so it gets a spinner", and each guards that decision with
the same `!reducedMotion && caps.unicode` pair. The duplication is emergent: a normal turn puts
the streaming assistant marker (`Transcript.tsx:223-225`) and the activity row on screen at the
same time, and a tool call adds a third (`ToolCard.tsx:227-231`) that says `⠋ running` one row
away from the activity row already saying `⠋ Running bash`. With a `task` dispatch and a todo
plan open, the count reaches five — `team-panel.test.tsx:82` already calls five "the documented
maximum number of simultaneous spinners", which is a fair description of the bug.

Two braille animations on adjacent rows, each on its own 80 ms timer, are not two pieces of
information. They are one piece of information rendered twice and out of phase, which is exactly
the failure `ActivityLine.tsx:8-15` legislates against for text ("duplicated rows are precisely
what the v0.4.0 removal of the status bar's hint cluster was for, and that rule does not
distinguish between a duplicated string and a duplicated number"). This round extends that rule
from strings and numbers to motion.

### 1.3 The shape of the fix

Every one of the seven sites already takes a boolean that means *do not animate here* — it is
called `reducedMotion`, and `App.tsx` is the only place that supplies it, at exactly five call
sites (`:1732`, `:1752`, `:1815`, `:1828`, `:1854`). So the whole change is a derivation at the
`App` boundary: the four **view** consumers (transcript × 2, team panel, todo panel) receive
`reducedMotion || activityVisible`; the activity line itself keeps the raw `cfg.reducedMotion`.
No component below `App` changes its props, its comparator, or its behaviour. The suppressed
form of each site is a static glyph that was already written, already tested, and already
carries the same text — so **no information leaves the screen**, only motion.

---

## 2. Decisions

| ID | Decision | Rationale |
|---|---|---|
| **D-1** | The activity line is the single owner of the animated spinner while it is mounted; every other site falls back to its existing static form. | The requirement, stated as an invariant that a test can assert. |
| **D-2** | The suppression signal is derived once in `App.tsx` and delivered through the **existing** `reducedMotion` prop. No new prop, no new context, no new module singleton. | The prop already means "do not animate" at all seven use sites, and it is already threaded to all of them. A parallel prop would mean eight files, a new `EntryView` comparator term (the trap `Transcript.tsx:384-395` documents in capital letters), and two booleans that have to be `&&`-ed identically at every site forever. |
| **D-3** | Suppression is tied to the **exact** condition that mounts the activity line (`running && !overlayNode`), not to `running` alone. | If it keyed off `running`, then `running && overlay` — the activity line is suppressed there by `App.tsx:1850` / P2-5 — would leave the frame with **zero** life signals. `ActivityLine.tsx:22-23`: "the bar shows state; this row shows life." Never trade one duplicate for one absence. |
| **D-4** | That condition becomes a **named const used in both places** (`activityVisible`). | The invariant is "suppressed ⟺ the line is up". Two copies of the same boolean expression is how that becomes false in six months, silently and in only one of the two branches. |
| **D-5** | `ActivityLine` keeps the raw `cfg.reducedMotion`. | It reads the flag twice — once for the spinner (`:76-77`) and once for phrase rotation (`:67`, `pickActivityPhrase(..., !reducedMotion)`). Feeding it the derived value would freeze the phrase at the first word of every run, which is a second, unrelated regression. |
| **D-6** | The panels (`TodoPanel`, `TeamPanel`) are in scope, not just the transcript. | "整个 Agent 的执行过程中只显示一个旋转等待状态的图标" is unambiguous, and both panels share the frame with the composer — `TeamPanel` in **both** modes, `TodoPanel` in **full-screen only** (`showRail` requires `fullscreen`, `App.tsx:1517`; inline gets the spinner-less `TodoStrip`, P2-1). Their static markers (`▸`, `·`) carry the same state (§3.1). |
| **D-7** | `FastCard` gets a one-branch restructure (C-1, §3.7) so suppression costs motion only, not colour. | It is the single site whose still branch also changes `color` → `theme.muted` and adds `wrap="truncate"`. Left alone, every live fast review during a run would go grey — a real information loss introduced by this round. |
| **D-8** | No config key (`singleSpinner`, `spinnerMode`, …). | Nobody asked for the old behaviour back, `reducedMotion` already exists for users who want *less* motion, and a setting whose only defensible value is `on` is permanent surface area. |

### 2.1 Alternatives rejected

- **A-1 — Drop the spinner from `ActivityLine`, keep the transcript ones.** Inverts the
  requirement; the requirement names the input-adjacent row as the survivor.
- **A-2 — A new `spinnerSuppressed` prop threaded to all seven renderers.** Eight files, a new
  term in the `EntryView` comparator (omit it and `ToolCard` freezes — `Transcript.tsx:384-395`),
  and every site then spells `!reducedMotion && !spinnerSuppressed && caps.unicode`. Strictly
  more code for strictly the same frame.
- **A-3 — A module-level "a run is animating" singleton read inside the components.** Invisible
  to `render-memo.test.tsx`, and `Transcript.tsx:121-128` forbids exactly this pattern by name.
- **A-4 — Keep the transcript spinners and delete the *text* duplication instead.** Does not
  address the requirement, which is about the icon.

---

## 3. Technical design

### 3.1 The spinner census

Every animated site in `src/ui/**`, its trigger, and the static form it already falls back to.
This table is the complete surface this round touches; there is no eighth site (`glyphs.test.ts`
already guarantees no component spells a braille literal of its own).

| # | Site | File:line | Animates when | Static fallback (existing) | Text lost |
|---|---|---|---|---|---|
| 1 | Activity line | `ActivityLine.tsx:76-77` | mounted at all | `glyphs.spinnerStill` (`·` / `*`) | none |
| 2 | Assistant role marker | `Transcript.tsx:223-225` | `entry.streaming` | `glyphs.assistant` (`●` / `*`) | none |
| 3 | Tool card badge | `ToolCard.tsx:227-237` | `status === 'running'` | `· running` (`badgeLabel` = `running`) | none |
| 4 | Team card headline | `TeamCard.tsx:97-106` | `entry.active` | `· <headline>` | none |
| 5 | Fast review head | `FastCard.tsx:107-118` | `entry.live` | `· <head>` **but muted** | colour — see C-1 |
| 6 | Retry card | `RetryCard.tsx:97-105` | `phase ∈ {waiting, retrying}` | line text, **no glyph** — see note | none |
| 7 | Todo panel row | `TodoPanel.tsx:151,166` | `active && running` | `todoActive` (`▸` / `>`) | none |
| 8 | Team panel row | `TeamPanel.tsx:197,202` | `isRunning(run)` | `spinnerStill` (`·` / `*`), distinct from every other phase (`TeamPanel.tsx:258-263`) | none |

(Eight rows, seven of them suppressible; row 1 is the survivor.)

Two notes on the fallbacks, both verified rather than assumed:

- **No panel row loses its identity.** `marker()` returns `glyphs.spinnerStill` for a running
  team run and `toolDone` / `toolError` / `toolPending` for every other phase
  (`TeamPanel.tsx:258-263`); `TodoPanel.tsx:72-76` returns `todoActive` for `in_progress` alone.
  A suppressed running row is still distinguishable from a settled one, which is what R-5 needs.
- **Row 6 is the one asymmetry (P2-4).** `RetryCard` renders the spinner element *or nothing*
  (`RetryCard.tsx:99-105`); it does not substitute `spinnerStill` the way the other six do, so
  suppressing it shifts the row two columns left. No text is lost — the countdown is the
  information and it keeps ticking, which is exactly the trade `RetryCard.tsx:94-96` already
  legislates for reduced motion. It is left alone on purpose: adding a glyph would change a
  component contract and drag `retry-render.test.tsx` out of §7.4 for a cosmetic gain. The
  visible consequence is a two-column jog at an overlay boundary (§3.6) — accepted, recorded
  here so it is not mistaken for a bug.

### 3.2 The single-owner rule

```
activityVisible      := running && !overlayNode          // THE mount condition, named
viewReducedMotion    := cfg.reducedMotion || activityVisible
```

`activityVisible` gates the `<ActivityLine>` element **and** feeds the derivation, so the two
can never disagree. `viewReducedMotion` goes to the four view consumers; `ActivityLine` keeps
`reducedMotion`.

### 3.3 Where it is computed

`App.tsx`, in render scope, after `overlayNode` is assigned (`:1544`–`:1657`) and before the
`viewport` is built (`:1712`). The natural slot is beside the other per-frame derivations at
`:1690-1691` (`density`, `transcriptWindow`). `running` is already in scope from `:1472`.

Then five edited lines:

| Line (today) | Consumer | New value |
|---|---|---|
| `:1732` | `<TranscriptList reducedMotion={…}>` (full-screen) | `viewReducedMotion` |
| `:1752` | `<Transcript reducedMotion={…}>` (inline) | `viewReducedMotion` |
| `:1815` | `<TeamPanel reducedMotion={…}>` | `viewReducedMotion` |
| `:1828` | `<TodoPanel reducedMotion={…}>` | `viewReducedMotion` |
| `:1850` | `activity={running && !overlayNode ? … : null}` | `activity={activityVisible ? … : null}` |
| `:1854` | `<ActivityLine reducedMotion={…}>` | **unchanged** (`reducedMotion`) |

Six rows, one of them marked unchanged: **five edited lines and two new ones**, in one file
(P2-3). That is the entire behavioural change.

One line adjacent to the edit is worth taking while it is open (P2-2): `App.tsx:1826` passes
`running={state.status === 'running'}` to `<TodoPanel>`, re-spelling the boolean that `:1472`
already names `running` and that D-4 is in the middle of arguing should exist once. Pass
`running={running}`. It is a no-op today and it removes the third copy of the expression this
design depends on.

### 3.4 Why the existing prop is the right carrier

`reducedMotion` is read at exactly seven places below `App`, and at every one of them the
expression is `X && !reducedMotion && caps.unicode ? <Spinner/> : <still form>`. It has no other
consumer — it does not colour, size, wrap, or gate content anywhere (verified by exhaustive grep
of `reducedMotion` under `src/ui/**`; `FastCard` is the one place it is entangled with colour,
which is why C-1 exists). Passing a wider "do not animate here" boolean through it is therefore
honest at every use site, and it means:

- `EntryViewProps` is unchanged, so the `React.memo` comparator (`Transcript.tsx:372-396`) is
  unchanged — no eleventh-term trap;
- `ToolCard` / `TeamCard` / `FastCard` / `RetryCard` keep their default comparators;
- every component-level test (`todo-panel.test.tsx`, `team-panel.test.tsx`,
  `retry-render.test.tsx`, `activity-line.test.tsx`, `diff-view.test.tsx`) keeps passing
  untouched, because component contracts do not move.

The one cost is semantic: below `App`, `reducedMotion` now means "this frame does not animate
here" rather than "the user set `reducedMotion`". The derivation site carries a comment saying
so, and `cfg.reducedMotion` remains the sole config source (`App.tsx:279`).

### 3.5 Safety proof — `<Static>` can never be affected

In inline mode a settled prefix is printed once into Ink's `<Static>` and can never be
re-printed or un-printed (`Transcript.tsx:8-10`). If a flip of the derived boolean could change
how an already-printed entry renders, the result would be a duplicated or torn history. It
cannot, and the proof is exhaustive: `computeSettledCount` (`Transcript.tsx:74-113`) breaks on
**every** condition that makes an entry animate.

| Animated entry kind | Animate condition | `computeSettledCount` break clause |
|---|---|---|
| assistant | `entry.streaming` | `:84` |
| tool | `status === 'running'` | `:85` (`!== 'done' && !== 'error'`) |
| team | `entry.active` | `:91` |
| retry | `phase ∈ {waiting, retrying}` | `:104` |
| fast | `entry.live` | `:109` |

The mapping is **total** — every animating entry kind has a break clause. It is not one-to-one
in the other direction, and that is the harmless side: `:97` (`e.kind === 'todo' && e.live`)
guards a live todo *card*, which renders no spinner at all (the rail is `TodoPanel`, chrome, not
an entry — P2-5). An over-inclusive settled boundary keeps entries out of `<Static>` for longer
than strictly required; it can never let an animating one in.

Therefore every animating entry is, by construction, in the live region; and for every entry
that *is* in `<Static>`, `animate` is already `false` on both sides of the change, so its
rendered bytes are identical whatever the derived boolean says.
`TranscriptList` (full-screen) has no `<Static>` at all (`Transcript.tsx:406-410`), so the
question does not arise there.

The panels (`TodoPanel`, `TeamPanel`) are chrome, re-rendered every frame; not a concern.

### 3.6 The overlay carve-out

`App.tsx:1843-1848` suppresses the activity row while an overlay owns the screen. By D-3 the
suppression signal follows it, so during an overlay the other sites animate again.

**Which overlays can be up while `running` is true (P0-1).** Not `/help`, `/model` or
`/settings`: those are slash commands (`commands/builtins.ts:169-179`) that need a submit, and
the `?` shortcut is gated on `!running` (`PromptInput.tsx:421`). The reachable set is exactly the
three raised from *inside* tool execution, while the agent loop blocks on a human:

- `confirm` — tool confirmation and skill-directory approval (`App.tsx:879`, `:954`);
- `question` — `ask_user` (`App.tsx:905`);
- `plan` — `submit_plan` (`App.tsx:905`).

Anything the design says about "an overlay mid-run" means one of these three. AC-5 and manual
row 6 drive one of them.

**What is actually on screen there, per mode (P1-1).** The two panels do not behave alike, and
neither behaves like the transcript:

| Slot | Inline + overlay | Full-screen + overlay |
|---|---|---|
| Transcript | rendered — overlay is in the document flow (`App.tsx:1752-1759`), so its spinners return | **not rendered** — the overlay replaces the viewport (`App.tsx:1713-1716`) |
| `TeamPanel` | rendered, **no overlay guard** (`App.tsx:1805-1819`; `AppShell.tsx:88-91`, `:119-125`) — up to 5 running rows animate | same — rendered and animating |
| `TodoPanel` (rail) | never rendered inline (`showRail` requires `fullscreen`) | **not rendered**: `showRail` includes `overlay === null` (`App.tsx:1516-1522`) |
| Activity row | suppressed | suppressed |

So the carve-out's bound is: **inline** — the transcript's own sites (streaming assistant,
running tool, team/fast/retry cards) plus up to five team-panel rows; **full-screen** — the
team-panel rows and nothing else.

**Where the justification actually applies.** D-3's reason ("never trade one duplicate for one
absence") is fully earned in inline, where the transcript is the thing the user is looking at.
In full-screen the overlay owns the frame, so re-enabling the transcript's spinners buys nothing
visible — the only life signal there is the team roster, and only when one is up. The carve-out
is kept in both modes anyway, because keying it to the mode would mean two conditions where the
invariant needs one (D-4), and because the full-screen case costs nothing: the suppressed
components are not mounted. It is pinned by AC-5 so a future reader does not "fix" it.

### 3.7 C-1 — `FastCard` colour decoupling

`FastCard.tsx:107-118` picks between two whole `<Text>` elements: the animated one is
`color={color}` (`fastCardColor(status, theme)`), the still one is `color={theme.muted}` with
`wrap="truncate"`. So suppressing the spinner would also grey out every live fast review for the
whole run — motion removed *and* status colour removed.

Required change: compute `const animate = live && !reducedMotion && caps.unicode;` and render a
**single** `<Text>` in place of the two. Written out, because the two-space gutter and the space
after the marker are load-bearing and a paraphrase loses them (P1-2):

```tsx
const animate = live && !reducedMotion && caps.unicode;
// ...
<Text color={live ? color : theme.muted} wrap="truncate">
  {'  '}
  {animate ? (
    <>
      <Spinner type="dots" />{' '}
    </>
  ) : live ? (
    `${glyphs.spinnerStill} `
  ) : (
    ''
  )}
  {head}
</Text>
```

Three things must survive verbatim, all of them present in today's two branches
(`FastCard.tsx:107-118`) and all of them silent if dropped:

1. the leading `{'  '}` — it is the gutter that separates the head from the bold `fast` label,
   and it is on **both** branches today. Omit it and every fast card's head jumps two columns
   left;
2. the single space after the spinner (`<Spinner type="dots" />{' '}`) — today's animated branch
   spells it, and the still branch bakes it into `` `${glyphs.spinnerStill} ` ``;
3. `{head}` unchanged.

**`wrap="truncate"` now applies to the animated path too**, which today it does not. That is a
real rendering change, not just a tidy-up: a long head that would have wrapped now truncates.
It is chosen deliberately — it is what the still branch already does, it is the behaviour the
card has in every state this round makes common, and an unbounded wrap inside a one-row headline
is the worse failure — but it is a change, and it stays observable in the carve-out state
(§3.6), which is the only place the animated path still runs during a turn.

Net effect: colour now tracks `live`, motion tracks `animate`, and the two stop being the same
decision.

No other card needs this: `ToolCard`, `TeamCard`, `RetryCard`, `TodoPanel` and `TeamPanel` all
use the same colour in both branches (verified at the line numbers in §3.1).

### 3.8 Sequence of operations — one turn

1. **Idle.** `running === false` → `activityVisible === false` → `viewReducedMotion ===
   cfg.reducedMotion`. Byte-identical to today.
2. **Submit.** `status → 'running'` (`App.tsx:1472`), `runStartedAt` stamped in render scope.
   `activityVisible` flips to `true`; `viewReducedMotion` flips to `true`. `EntryView`'s
   comparator sees `reducedMotion` change → the mounted live entries re-render **once**. The
   activity row mounts and begins animating.
3. **Streaming.** The assistant entry renders its role marker as `●` (`glyphs.assistant`), not a
   spinner. One animation on screen: the activity row.
4. **Tool call.** The tool card badge renders `· running`; `App.tsx:1483-1491` finds the running
   tool and the activity row's label becomes `Running bash`. Still one animation, and the two
   rows no longer say the same thing twice.
5. **Team dispatch / todo plan.** Team card, team panel rows and the todo rail row render their
   static markers. Still one animation.
6. **`agent_end`.** `status → 'ready'`; `activityVisible` → `false`; the activity row unmounts;
   `viewReducedMotion` → `cfg.reducedMotion`; live entries re-render once and settle. Zero
   animations, as today.
7. **Overlay opened mid-run (inline).** `overlayNode` truthy → `activityVisible` → `false` → the
   transcript reverts to its own spinner for as long as the overlay is up (§3.6).

Two extra full re-renders of the live region per turn, at the two transitions. `TranscriptList`
mounts only viewport entries (`Transcript.tsx:23-25`), and the inline live tail is `LIVE_TAIL = 1`
plus the unsettled suffix, so this is bounded by the same set the 200 ms elapsed ticker already
re-renders five times a second.

### 3.9 Effect on render cost

Each `<Spinner>` is an independent component holding its own ~80 ms interval and calling
`setState` on every frame — a re-render of that subtree, a new frame, a diff through
`frame-differ`, and a write through `stdout-frame-writer`. Removing up to four of them during a
run *reduces* commit pressure; the render governor's rung will see fewer forced commits, not
more. No governor, budget or `viewportRows()` arithmetic changes: the activity row's mount
condition is untouched, so `BottomStatusRow` occupancy and `layout/budget.ts` are exactly as
`agent-activity-presentation` P0-1 / AC-8a left them.

---

## 4. File / module change plan

| File | Create/Modify | Intent (one line) |
|---|---|---|
| `packages/cli/src/ui/App.tsx` | Modify | Derive `activityVisible` + `viewReducedMotion`; feed the four view consumers and the activity mount site. |
| `packages/cli/src/ui/entries/FastCard.tsx` | Modify | C-1: split the colour decision from the animation decision so a live review keeps its status colour. |
| `packages/cli/src/ui/ActivityLine.tsx` | Modify (comment only) | Record in the file header that this row is the sole animated spinner while mounted, and why it keeps raw `cfg.reducedMotion` (D-5). |
| `packages/cli/src/ui/Transcript.tsx` | Modify (comment only) | Note at `:220-223` that `reducedMotion` arrives pre-widened from `App` and that the `<Static>` proof (§3.5) is what makes it safe. |
| `packages/cli/src/__tests__/single-spinner.test.tsx` | **Create** | AC-1 … AC-8: the one-spinner invariant, its location, the still forms, the overlay carve-out. |
| `packages/cli/src/__tests__/app.test.tsx` | Modify | Strengthen `does animate when reducedMotion is off` (`:873-885`) so it cannot pass for the wrong reason (§7.3). |
| `packages/cli/src/__tests__/spinner-census.test.ts` | **Create** | Two static scans: AC-9, any file importing `ink-spinner` must also read `reducedMotion` (R-6); and AC-11, `App.tsx` wires exactly one raw `reducedMotion` and four `viewReducedMotion` (R-2 / §7.2b). |
| `docs/plans/single-spinner-while-running/spec.md` | **Create** | This document. |

**Explicitly not touched:** `config/schema.ts`, `config/load.ts`, `ui/layout/budget.ts`,
`ui/layout/AppShell.tsx`, `ui/BottomStatusRow.tsx`, `ui/StatusBar.tsx`, `ui/glyphs.ts`,
`ui/render-governor.ts`, `agent/**`, `team/**`, `todo/**`, `packages/core/**`, and every
component-level test other than the two named above. A diff that touches any of them has left
the design.

---

## 5. Interface design

No REST, no WebSocket, no CLI surface. Nothing is added to `CliConfig`, `PersistedConfig`,
`SettingsValues`, the flag parser, or the env table. The only interfaces that move are React
props, and only in the values passed — no signature changes:

| Component | Prop | Before | After |
|---|---|---|---|
| `Transcript` / `TranscriptList` | `reducedMotion: boolean` | `cfg.reducedMotion ?? false` | `cfg.reducedMotion \|\| activityVisible` |
| `TeamPanel` | `reducedMotion: boolean` | same | same widening |
| `TodoPanel` | `reducedMotion: boolean` | same | same widening |
| `ActivityLine` | `reducedMotion: boolean` | `cfg.reducedMotion ?? false` | **unchanged** |
| `BottomStatusRow` | `activity: React.ReactNode` | `running && !overlayNode ? <ActivityLine/> : null` | `activityVisible ? <ActivityLine/> : null` (same value, named) |

`FastCardProps` is unchanged by C-1; only the body of `FastCardImpl` moves.

---

## 6. Data model

No database, no migration, no persisted field, no session-file field. `session/persist.ts` is
untouched, and a session saved before the change loads identically after it (spinner state was
never serialized — `transcript-text.ts` and `exit-snapshot.ts` render text, never `<Spinner>`).

Two derived render-scope scalars in `App`:

```
activityVisible:   boolean  = running && !overlayNode
viewReducedMotion: boolean  = (cfg.reducedMotion ?? false) || activityVisible
```

Truth table (`R` = `running`, `O` = an overlay is mounted, `M` = `cfg.reducedMotion`):

| R | O | M | `activityVisible` | `viewReducedMotion` | Animations on screen |
|---|---|---|---|---|---|
| 0 | 0 | 0 | 0 | 0 | 0 — nothing is live (see note) |
| 0 | 0 | 1 | 0 | 1 | 0 |
| 1 | 0 | 0 | 1 | 1 | **1** — the activity row |
| 1 | 0 | 1 | 1 | 1 | 0 — user asked for stillness |
| 1 | 1 | 0 | 0 | 0 | carve-out: inline → transcript sites + team-panel rows; full-screen → team-panel rows only (§3.6) |
| 1 | 1 | 1 | 0 | 1 | 0 |
| 0 | 1 | * | 0 | `M` | 0 |

Note on row 1: with `running === false`, every animate condition in §3.1 is false by
construction of the reducer (a settled turn has no streaming assistant, no running tool, no
active team, no live todo/fast card, and `TodoPanel` gates on its own `running` prop). If one is
not, that is a pre-existing reducer bug; this change neither creates nor conceals it.

---

## 7. Testing & acceptance criteria

### 7.1 Acceptance criteria

| ID | Criterion |
|---|---|
| **AC-1** | Inline, `reducedMotion: false`, Unicode caps, mid-stream: the stripped frame contains **exactly one** braille character (`/[⠀-⣿]/g` → length 1). |
| **AC-2** | That character is on the activity row — the line carrying it also carries either an `ACTIVITY_PHRASES` entry or `Running <tool>`. |
| **AC-3** | In the same frame, the assistant entry's role marker is the static `●`, and the streamed text is unchanged. |
| **AC-4** | With a tool in flight, the tool card badge reads `· running` (still glyph + the same `badgeLabel` text) while the activity row reads `Running <tool>`; total braille count is still 1. |
| **AC-5** | Inline, running, with a **mid-run overlay** up — a `plan` or `question` raised through `humanInputBridge`, **not** `/help`, which cannot be opened during a run (§3.6 / P0-1): the activity row is absent and the transcript's own spinner animates (braille count ≥ 1). The screen is never dead while a run is in flight. |
| **AC-6** | After `agent_end`, braille count is 0 and no `·` placeholder is left on a settled entry. |
| **AC-7** | `reducedMotion: true` → braille count 0 in every state above (the existing `app.test.tsx:854` case still passes, unmodified). |
| **AC-8** | ASCII caps (`unicode: false`) → braille count 0; markers are the ASCII tier (`*`), and no layout row is added or removed versus today. |
| **AC-9** | Every file under `src/ui/**` that imports `ink-spinner` also reads `reducedMotion` (static scan). |
| **AC-10** | `git diff --stat` touches only the files in §4. In particular `layout/budget.ts`, `AppShell.tsx` and `BottomStatusRow.tsx` are byte-identical, and `budget.test.ts` passes untouched. |
| **AC-11** | Static scan of `App.tsx`: `reducedMotion={reducedMotion}` occurs **exactly once** (the activity line, D-5) and `reducedMotion={viewReducedMotion}` **exactly four times**. See §7.2a for why AC-9 alone is not enough. |

### 7.2 New unit tests — `single-spinner.test.tsx`

Reuse `app.test.tsx`'s harness verbatim: the `FakeController` + `mount(fc, {mode, initialPrompt})`
helper (`app.test.tsx:365-384`), `stripAnsi` (`:93`), `delay` (`:84`), and the `ACTIVITY_PHRASES`
import (`:81`). The spinner counter is the whole trick:

```
const brailleCount = (frame) => (frame.match(/[⠀-⣿]/g) ?? []).length;
```

Cases: AC-1/AC-2/AC-3 in one streaming fixture; AC-4 with a `tool_execution_start` that never
ends; **AC-5 per §7.2a below**; AC-6 by emitting `agent_end`; AC-7 with
`fc.config = { ...CONFIG, reducedMotion: true }`; AC-8 by forcing `unicode: false` through
`CONFIG` (`caps.unicode` is `cfg.unicode ?? detected.unicode`, `App.tsx:274`, so the config key
reaches the component — this is the App-level equivalent of how `todo-panel.test.tsx:156` builds
its ASCII frame by passing `caps` directly).

### 7.2a AC-5: how to actually open an overlay mid-run (P0-1)

`?` does not work — `PromptInput.tsx:421` gates it on `!running` — and no slash command can be
submitted during a run. Use the harness that already exists for exactly this state, at
`app.test.tsx:548-593`:

```tsx
const fc = runningController();           // app.test.tsx:548 — stuck mid-run, status 'running'
const bridge = makeBridge();
const { lastFrame, unmount } = mount(fc, { initialPrompt: 'go', humanInputBridge: bridge });
await delay(60);

void bridge.handler!({ kind: 'plan', plan: PLAN });   // App.tsx:905 -> overlay 'plan'
await delay(60);

const frame = stripAnsi(lastFrame() ?? '');
expect(frame).toContain('Review plan');               // the overlay is up...
expect(brailleCount(frame)).toBeGreaterThanOrEqual(1); // ...and the screen is not dead
```

`mount()` already forwards `humanInputBridge` (`app.test.tsx:370`, `:380`), so no harness change
is needed. `{ kind: 'questions', questions: [...] }` is the equivalent alternative; a `confirm`
overlay needs `confirmBridge`, which `mount()` does not forward today — prefer the human-input
path rather than widening the helper.

Assert the *inline* case. The full-screen half of the carve-out is not worth a case: the overlay
replaces the viewport, so the only animated site left there is a team roster that this fixture
does not have (§3.6).

### 7.2b AC-11: why AC-9 is not sufficient (P1-3)

AC-9 scans the seven leaf components and proves each still honours `reducedMotion`. It cannot
see the wiring. The failure R-2 describes lives entirely in `App.tsx`: a future consumer added
with `reducedMotion={reducedMotion}` instead of `reducedMotion={viewReducedMotion}` passes AC-9,
passes typecheck, and re-introduces exactly the second spinner this round removes. AC-11 is a
two-line `readFileSync` + count over `App.tsx` — the same shape as the scanner in
`glyphs.test.ts:228-263`, which also guards a whole-file invariant no component test can see.
Put it in `spinner-census.test.ts` next to AC-9.

### 7.3 The test that would pass for the wrong reason

`app.test.tsx:873-885`, *"does animate when reducedMotion is off (so the check above means
something)"*, asserts only `toMatch(/[⠀-⣿]/)` on the whole frame. After this change the frame
still contains braille — from the activity row — so **the test goes on passing while the thing
it was written to protect (the animated assistant marker) is gone.** That is worse than a red
test. It must be rewritten in the same commit to assert what it now actually guards: braille is
present *and* the braille-bearing line is the activity row, with the assistant marker static.
Its sibling at `:854` needs no change.

### 7.4 Tests that must NOT change

`activity-line.test.tsx`, `todo-panel.test.tsx`, `team-panel.test.tsx`, `retry-render.test.tsx`,
`bottom-status-row.test.tsx`, `render-memo.test.tsx`, `render-budget.test.tsx`, `budget.test.ts`,
`inline-live-clamp.test.tsx`. They render components directly with explicit props, and no
component contract moves. If one of them needs editing, the implementation has widened past this
design — stop and re-read §3.4.

### 7.5 Manual test

Run `npm run dev:cli` in each row's mode and eyeball the frame.

| # | Steps | Expected |
|---|---|---|
| 1 | Ask a question that streams a long answer (inline). | Exactly one spinning icon, on the row above the input. The answer's `●` marker is still. |
| 2 | Ask for a `bash` command that takes ~10 s. | One spinner; it reads `Running bash`. The card badge shows `· running`, not a second animation. |
| 3 | Same in `--fullscreen`. | Identical. Transcript height does not jump on submit or on `agent_end`. |
| 4 | Start a todo plan, then a run — **in `--fullscreen`**. The rail is full-screen only (`App.tsx:1517`); inline shows `TodoStrip`, which has no spinner and would pass this row for the wrong reason (P2-1). | Rail's active item shows `▸`, not a spinner. One animation total. |
| 5 | Dispatch a `task` (team). | Team panel rows and the team card are static; one animation total. |
| 6 | Mid-run, trigger a **real** mid-run overlay (inline): run in `--confirm-tools` and let a tool ask, or use a prompt that makes the agent call `ask_user` / `submit_plan`. `?` and `/help` do **not** open during a run (§3.6 / P0-1) — if nothing appears, the step did not run. | Activity row gone; the transcript animates again so the screen is not dead. Answer/dismiss the overlay → back to exactly one. |
| 7 | Set `reducedMotion: true`, repeat 1–2. | Zero animations, all text intact. |
| 8 | Run in a legacy `cmd.exe` (ASCII tier). | No mojibake; `*` / `·` markers; zero braille. |
| 9 | Mid-run, press `Ctrl+T` (or type a steer message + Enter). Watch the row above the composer for the ack's full 2.5 s. **This row is the one whose absence shipped `activity-spinner-vanishes-behind-toast`** — rows 1–8 never press a key that acks during a run, and R-1 predicted exactly the hole they left. | The ack takes the row and keeps all its words, with the spinner beside it: ` ⠋ ℹ Thinking shown.`. Exactly one animation before, during and after — never zero (the bug), never two (round 1's). Repeat with `reducedMotion: true` and in the ASCII tier: the toast row must be unchanged from row 7 / row 8, with **no** glyph prefixed. |

Commands: `npm run typecheck -w packages/cli`, `npm test -w packages/cli`.

---

## 8. Risks & mitigations

| ID | Risk | Mitigation |
|---|---|---|
| **R-1** | The mount condition and the suppression condition drift apart, leaving a run with zero animations or two. | ~~They are the same named const (D-4), used at both sites. AC-1 and AC-5 fail from opposite directions if it is split.~~ **THIS MITIGATION WAS WRONG AND THE RISK FIRED** (`activity-spinner-vanishes-behind-toast`). They were the same const; the const was not the MOUNT condition — `BottomStatusRow` decides that, and a toast took the row outright, so every mid-run ack gave the frame zero animations for 2.5 s. AC-1 and AC-5 both stayed green because no component was wrong. Closed properly by making the claim true rather than by enumerating pre-emptors: `BottomStatusRow` now carries the bare spinner beside the toast, so the signal is mounted exactly when `activityVisible` is true. Pinned by AC-12/AC-13/AC-14 in `single-spinner.test.tsx` and by manual row 9. |
| **R-2** | `reducedMotion` below `App` no longer means what its name says; a future reader threads `cfg.reducedMotion` straight into a new consumer. | **AC-11** is the guard that actually sees this (§7.2b) — AC-9 cannot, because the mistake is in the wiring, not the leaf. Plus the comment at the derivation naming the two carriers, and §3.1's census as the checklist for any new animated site. |
| **R-3** | The flip re-renders the live region twice per turn. | Bounded and measured: `TranscriptList` mounts only viewport entries, inline keeps `LIVE_TAIL = 1`; the 200 ms elapsed ticker already re-renders the same set 5×/s. `render-budget.test.tsx` remains green. |
| **R-4** | `<Static>` prints an entry, then the flip changes how it would render → torn history. | Impossible; total proof in §3.5. Every animate condition has a matching `computeSettledCount` break clause. |
| **R-5** | Suppression silently removes information (a card stops saying it is running). | Every still form carries the same text (§3.1, `badgeLabel` returns `running` in both branches). The one exception, `FastCard`'s colour, is fixed by C-1. |
| **R-6** | A future feature adds an eighth animated site and re-introduces the duplicate. | AC-9's scan test forces the new site to take `reducedMotion`, which means it is suppressed by construction the moment `App` passes it the derived value. |
| **R-7** | Someone "simplifies" D-3 to `running`, killing the overlay carve-out. | AC-5 pins it — **provided it is written per §7.2a**. An AC-5 that opens `/help` cannot reach `running && overlayNode` at all (P0-1) and would leave this risk entirely unguarded while showing green. §3.6 records the reason, and the reachable overlay set, next to the code. |
| **R-8** | Headless / exit-replay paths regress. | They never mount a TUI component (`agent/headless.ts`, `transcript-text.ts`, `exit-snapshot.ts` emit text). No path in this design reaches them. |

---

## 9. Non-goals

- Changing the activity row's copy, its phrase table, its width behaviour or its budget slot.
- Changing any static glyph, in either tier (`glyphs.ts` is untouched).
- Adding a user-facing setting for spinner style (D-8).
- Deduplicating the *textual* overlap between the activity row and the status bar — already
  legislated by `agent-activity-presentation` P1-1 and out of scope here.
- Touching `packages/core`, the agent loop, the reducer, or session persistence.

---

## 10. Definition of Done

1. `activityVisible` and `viewReducedMotion` exist in `App.tsx`, each used at exactly the sites
   in §3.3; no other file computes either.
2. C-1 landed in `FastCard.tsx` **with the gutter and the post-spinner space intact** (§3.7); a
   live fast review keeps its status colour with the spinner suppressed.
3. AC-1 … AC-11 all pass. `npm test -w packages/cli` and
   `npm run typecheck -w packages/cli` are green.
4. `app.test.tsx:873-885` rewritten per §7.3; every test named in §7.4 unmodified.
5. AC-5 drives a **real** mid-run overlay through `humanInputBridge` (§7.2a). A version of AC-5
   that opens `/help` or writes `?` is not AC-5 — it cannot reach `running && overlayNode` and
   passes vacuously, which is worse than the missing test (P0-1).
6. `git diff --stat` matches §4 exactly — no file outside that table, in either direction.
7. Manual rows 1–8 walked on Windows in both inline and full-screen, with row 4 taken in
   full-screen and row 6 taken against a confirm / `ask_user` / `submit_plan` overlay.

---

## 评审结论 (Review Verdict)

**有条件通过 (Approved with conditions).**

The design is sound and correctly sized. Its central claim — that seven independent spinners can
be collapsed to one by widening a boolean that already exists, without moving a single component
contract — was checked against the tree and holds: `reducedMotion` really is read at exactly
seven leaves and supplied from exactly five places in `App.tsx`; the `<Static>` proof in §3.5 is
backed by all six break clauses; the `EntryView` comparator already carries the term, so the trap
the design worries about does not open; and neither panel loses information when suppressed,
because both markers distinguish the running phase. Choosing the existing prop over a new one
(D-2) and refusing a config key (D-8) are both right, and A-2/A-3 are rejected for the right
reasons. Two edited props, one restructured card and two new test files is the correct size for
this requirement.

The conditions are all in the *verification*, not the mechanism. What v1 got wrong was believing
the overlay carve-out could be exercised through `/help`; it cannot, and that single mistaken
premise was load-bearing for AC-5, manual row 6, and R-7's mitigation. Everything else is
accounting.

Conditions on merge:

1. **AC-5 is implemented per §7.2a** — a `plan` or `question` raised through `humanInputBridge`
   on a `runningController()`. If the implementer finds this awkward and reaches for `/help`,
   the test is not AC-5: it cannot enter `running && overlayNode`, it will pass, and D-3 ships
   with nothing holding it. This is the one condition that is not negotiable, because its
   failure mode is a green suite.
2. **AC-11 lands with AC-9** in `spinner-census.test.ts`. AC-9 alone guards the leaves and leaves
   the wiring — where R-2 actually lives — uncovered.
3. **C-1 is written out as in §3.7**, keeping the two-space gutter and the space after the
   spinner. The paraphrase in v1 silently moved the fast card's head two columns.
4. `app.test.tsx:873-885` is rewritten **in the same commit** (§7.3, unchanged from v1 and still
   the sharpest observation in the document).

Not conditions, but worth landing while the file is open: `running={running}` at `App.tsx:1826`
(P2-2), and the full-screen qualifier on manual row 4 (P2-1).

No P0 or P1 remains open. `RetryCard`'s missing static glyph (P2-4) and §3.5's over-inclusive
break-clause table (P2-5) are recorded as accepted, not deferred — both are safe in the
direction they err, and fixing P2-4 would cost a component contract and a §7.4 test for a
two-column cosmetic gain.

---

## 实施过程发现的方案缺陷 (Issues Found During Implementation)

The mechanism landed exactly as designed: §3.3's five edited lines plus two new ones, C-1 as
written out in §3.7, and the two comment-only files. Nothing in §2, §3, §5 or §6 needed
correcting, and no file outside §4 was touched. All three findings below are in **§7, the test
plan** — the same half of the document the review verdict already identified as the weak one.

### IF-1 — §7.2's fixed `delay(80)` sample is not safe, and it fails toward green (P1)

**What the design says.** §7.2 says to reuse `app.test.tsx`'s harness "verbatim", including
`delay` (`:84`), and every case in that harness samples with a single fixed sleep.

**What happens.** The first full-suite run of `single-spinner.test.tsx` failed AC-3 on this
frame, captured after `await delay(80)`:

```
● …
 ⠋ Mulling…
```

The activity row had rendered and the assistant marker was already static, but the streamed word
`partial` had not arrived: with 144 files running in parallel, 80 ms is not enough for the render
governor (`maxRenderIntervalMs: 320` in this fixture) to commit a frame carrying the transcript's
content. In isolation the same case passes; the flake only appears under suite load, which is the
worst place for it to live.

**Why it is a design defect and not a test bug.** The failure that surfaced was a *content*
assertion, so it was loud. The one underneath it is silent and is the exact hazard §7.3 is
written against: `brailleCount(frame) === 1` is an assertion about **what has been mounted**, and
a sample taken before the transcript has rendered its live entry counts the sites that exist at
that instant, not the sites the turn actually has. A frame with the activity row up and the
transcript not yet committed reads `1` whether or not the fix is present. §7.2 hands the
implementer a sampling method that can produce that frame, and nothing in §7 warns about it — so
the design as written could ship an AC-1 that passes vacuously in exactly the way §7.3 spends a
whole subsection forbidding.

**What was implemented instead.** A bounded poll, `settledFrame(lastFrame, ready)`, and every
assertion in a case reads the one frame it returns. The predicate is always the **content the
case is about** (`partial`, `Running bash`, `Review plan`, `idle`) and never the property under
test — polling until the braille count is 1 would assert nothing at all. Bounded at 40 × 40 ms so
a genuine regression fails in under two seconds rather than hanging.

This is the same shape as the bounded paging loop already in `app.test.tsx:828-833`, and for the
same stated reason: the assertion is about reachability, and a hard-coded wait couples the test
to timing it does not control.

**Verified to bite.** With the inline transcript's prop reverted to the raw flag, AC-1, AC-4,
AC-5 and AC-11 all fail (`expected 2 to be 1`), and they pass again when it is restored. Run
after the change, `npm test -w packages/cli` is green twice in a row: 144 files, 2068 passed.

### IF-2 — §7.2a's AC-5 fixture animates an entry with no visible text (P2)

§7.2a builds AC-5 on `runningController()` (`app.test.tsx:548`), which emits `agent_start` and
`turn_start` and nothing else. `turnStart` does create a streaming assistant entry
(`agent/reducer.ts:886-894`), so braille count ≥ 1 does hold under the overlay and the sketch is
not wrong. But the entry it rests on has `text: ''` and renders as a bare marker, so AC-5 would
be asserting that the screen is "not dead" via a glyph attached to nothing the user can read.

Implemented with a controller that also emits one `text_delta`, so the animated site AC-5 finds
is an entry with visible content. Strictly a strengthening; recorded because it is a deviation
from a code block the design spells out, and DoD item 5 is deliberately strict about what
counts as AC-5.

### IF-3 — AC-8's "versus today" cannot be asserted by a test in the new tree (P2)

AC-8 requires "no layout row is added or removed **versus today**". A test only ever runs against
one tree, so it cannot compare against the pre-change frame; taken literally the criterion is
unimplementable, and the likely resolutions are a checked-in golden frame (brittle for a reason
unrelated to this feature) or nothing at all.

Implemented as the assertion that is both checkable and load-bearing: mount the same streaming
fixture at `unicode: true` and `unicode: false` and assert the two frames have the **same number
of rows**. That is what the criterion is actually protecting — the suppressed forms occupy the
columns the spinners used to, in both tiers — and it is what would fail if a still form were ever
replaced by nothing on the ASCII path. The pre/post-change half of the claim is covered instead
by §7.4's untouched suites, of which `budget.test.ts` and `render-budget.test.tsx` are the two
that would move if a row appeared or vanished.
