# Fast model tier — manual test matrix

Companion to `spec.md` §8.3. Everything a replay test can pin is pinned in
`src/__tests__/fast-*.test.ts`; what is left here is what needs a real provider,
a real terminal, or a human deciding whether the output reads well.

**Setup.** A working main model, plus a key for whatever provider the fast model
lives on. `claude-haiku-4-5` under an `anthropic` main model is the cheapest
useful pairing. Unless a row says otherwise, start from a config with **no
`fast` key at all**.

---

## 1. Off by default is genuinely off (R-d / AC-1 / AC-2 / AC-3)

1. Fresh install, no `fast` key. Start `aragon`.
2. `/debug` (or `/tools`) — confirm the system prompt carries **no**
   `<fast_tier>` block.
3. Ask for anything that dispatches subagents. Confirm the `task` schema shown
   in the model's tool list has no `model` property, and that no `fast` chip
   appears in the status bar at any width.

**Pass:** the session is indistinguishable from a build without the feature.
**Fail is silent**, which is why the byte-identity half is also an automated
test — this row is here to catch a UI element the tests do not render.

## 2. Turning it on from inside a session (§4.4)

1. `/fast` → reports `off for this session (not configured at launch)`.
2. `/fast model claude-haiku-4-5` → success toast.
3. `/fast on` → the honest sentence: *"The fast tier is off for this session
   (not configured at launch). Saved for next launch."*
4. Restart. `/fast` now reports `on`, names `anthropic:claude-haiku-4-5`, and a
   `fast` chip appears in the status bar's right cluster.

**Pass:** step 3 does NOT claim the tier is now live. A session that grew a
`task` schema field mid-flight would change its request payloads between turns.

## 3. A review appears, and the model acts on it (R-g)

1. With the tier on and `fast.reviewEveryTurns: 2`, ask for work that spans six
   or more turns (a small refactor across three files is enough).
2. Watch for a `fast review #1` card in the transcript.
3. Read the **next** assistant turn.

**Pass:** the card renders in at most a few rows, and the lead's next turn either
acts on the advice or says briefly why not. It must never ask *you* to confirm
the review — that would mean the model read it as a message from the user.

## 4. `ok` is cheap and quiet (D-16 / AC-25)

Run a short, obviously-correct task with the review on.

**Pass:** the review cards that say `on track` are ONE muted line each, and the
lead's context is not spending anything on them (no `<fast_review>` appears in
`/debug`'s message list).

## 5. Delegation, and the report's two cost lines (AC-14 / AC-17)

1. Ask for something that splits: *"read src/config, src/agent and src/team, and
   summarize what each one owns"*.
2. If the model does not use `model:"fast"` on its own, say so explicitly:
   *"use the fast model for the reading subagents"*.

**Pass:** the team roster shows `~` after the fast children's labels and `n fast`
in the card footer; the report annotates those rows `[fast]` and carries a
separate `Fast tier: in … out … Cost: …` line whose figure is visibly smaller
per token than the main line's.

## 6. `/fast review off` stops reviews and leaves delegation working

**Pass:** no more review cards; `model:"fast"` still produces `[fast]` rows.

## 7. A deliberately wrong model (AC-5 / §3.3)

Set `fast.model` to something that does not exist, restart.

**Pass:** exactly ONE notice at startup or on the first review, the tier stops
being used, and the run itself completes normally. Three identical stream errors
in the transcript is a fail.

## 8. A busy fast provider must NOT self-disable (AC-36 / D-24)

Hard to force deliberately; the reachable version is to point `fast.baseUrl` at
a local proxy that returns HTTP 429 three times and then succeeds.

**Pass:** no "fast review disabled" notice, and a later review still runs. This
is the one row worth the setup: with retry now inside `complete()`, three
"failures" can arrive from a single busy minute, and a session-long silent
shutdown over a condition that fixed itself is exactly the wrong behaviour.

## 9. Esc during a run with a review in flight (AC-26) — **do not skip**

1. Tier on, `fast.reviewEveryTurns: 1`. Start a long task.
2. Press `Esc` while a tool is executing and a review is in flight (the chip
   reads `fast*`).
3. Ask an **unrelated** question.

**Pass:** the new conversation contains your question and nothing else. A
`<fast_review>` block appearing in it — in the *user* role, about the previous
task — is the P0 this feature was shaped around. The automated pair
(`fast-reviewer.test.ts`, "guard 1" and "guard 2") covers the interleaving that
is impractical to hit by hand; this row is the end-to-end confirmation.

**Also pass:** the interrupted review's card reads `dropped: cancelled`, not
`failed: Stream ended without a done event`. Repeat the whole row three times: no
"fast review disabled" notice may appear. Cancelling a review is not evidence of
a misconfigured tier, and it is the same `controller.abort()` a *timeout* uses —
so the two are told apart by the reason the reviewer records, not by the error,
which is identical for both (the retry layer returns silently on abort, `retry.ts`
G3). The same applies whenever a run simply *ends* with a review still open,
which is the ordinary shape of any run whose last turn answers without tools.

## 10. `/save` mid-review, `/resume` (C-5 / AC-28)

1. `/save` while a review card is still spinning.
2. Restart, `/resume` that file.

**Pass:** the card is settled and reads `dropped: interrupted (session resumed)`;
the transcript does not flicker or re-render continuously. A card that never
settles is re-rendered on every frame for the rest of the session, which shows up
as the whole transcript repainting when you type.

## 11. Headless (D-12 / AC-29)

```bash
aragon -p "summarize the config module" > /tmp/out.txt
```

**Pass:** `/tmp/out.txt` contains the answer and nothing else; stderr carries no
`[fast]` lines; the `[usage]` footer's totals include the review's tokens.

## 12. The settings screen (§4.5)

Open `/settings`, scroll to the four `Fast …` rows.

**Pass:** the derived line under them reports one of the three honest states —
`off`, `off (fast.model is not set)`, or the resolved
`provider:model (key set) review every N turns`. Switching `Fast tier` to `on`
with no model set must show the second, not the third.

## 13. Switching the main provider with an inheriting tier (AC-33)

1. Tier on with `fast.provider` empty and an anthropic main model.
2. `/model` to an OpenAI model for which you have **no** key.
3. Ask for a `model:"fast"` dispatch.

**Pass:** one notice naming the reason, the children run on the main model, and
the report says *"N subagents ran on the main model (fast tier off)."* A child
dying with `No API key available for provider "openai"` is the failure this row
exists to catch.

## 14. `/fast same` (R-e)

`/fast same`, then `/fast`.

**Pass:** the status reports the main model with `(same as main)`, and reviews
still run and still cost — nothing is skipped because the two tiers match.

## 15. Narrow terminal

Resize below 100 columns with the tier live.

**Pass:** the `fast` chip disappears rather than squeezing the context gauge, and
`/fast status` still answers in full.
