# Context compaction — manual test script

Eleven rows, from spec §8.3. **Rows 1, 2, 3, 5, 9, 10 and 11 are NOT
SKIPPABLE**: each covers a failure that is invisible in a unit test, or invisible
until it has already cost the user something.

Every row states the expected observation. A row that "looked fine" without the
stated observation being seen is a row that did not run.

---

## Status after the hardening round (`context-auto-compaction-hardening` W6)

**Six of the seven ★ rows are now automated** and run offline in CI against a
scripted `LLMProvider`, in
`packages/cli/src/__tests__/compaction-e2e.test.ts`:

| Row | Automated as |
| --- | --- |
| 1 ★ | `row 1 - small-window headroom co-trigger` |
| 2 ★ | `row 2 - resume pressure on the estimate path` |
| 3 ★ | `row 3 - wrong-window recovery through the reactive path` |
| 5 ★ | `row 5 - the failure ladder` |
| 10 ★ | `row 10 - two compactions in one session` |
| 11 ★ | `compaction-render.test.tsx` (the live -> settled card sequence) |

**Row 9 ★ stays manual**: it is about process launch and a real `config.json` on
a real machine, which is what a manual row is for. It moves to this round's
script, `docs/plans/context-auto-compaction-hardening/manual-test.md`.

**Rows 4, 6, 7 and 8 stay manual and stay UNRUN.** They are the whole of the
evidence that this feature works against a live provider, an ASCII terminal and a
60-column window. What the automation above claims is that six rows no longer
depend on a human remembering to run them — **not** that the feature has been
observed in production.

---

## 1. Small-window run — the headroom co-trigger ★ NOT SKIPPABLE

**Why it cannot be a unit test.** The unit test asserts the arithmetic. This
asserts that the arithmetic is reached with a real model's real window, which is
where a wrong `contextWindow` lookup would show up.

```bash
aragon --model <a-32k-model> --max-tokens 8192
```

Ask for four large file reads in one turn (`read_file` on four 40 KB+ files).

**Expected.** Compaction fires **below 90 %** — the status bar shows something in
the high 80s when the activity row switches to `Compacting context…`. The card
reports the before/after counts. Nothing waits for 90 %.

**The failure this catches.** A pure-ratio trigger. It is correct for the 200 k
windows most people run and quietly wrong for the cheap models, which is exactly
the population that hits this first.

---

## 2. Resume pressure — the estimate path ★ NOT SKIPPABLE

**Why it cannot be a unit test.** This is the most dangerous single moment in the
feature's life: a restored 180 k-token conversation where there is no `turn_end`
usage to read and the naive answer is "0 %".

1. Drive a session to a large history. `/save big.json`.
2. Quit. Restart. `/resume big.json`.
3. Look at the status bar **before** sending anything.
4. Send one short message.

**Expected.** Step 3 shows a percentage with a leading `~` — the number is a
guess and says so. Step 4 compacts on the **first** turn.

**The failure this catches.** An occupancy that reads 0 % on a resumed session,
followed by an immediate 400 on the first request.

---

## 3. Wrong-window recovery — the reactive path ★ NOT SKIPPABLE

**Why it cannot be a unit test.** The stub-provider test proves the loop
recovers. This proves a real provider's real 400 is classified as
`context_overflow` and reaches the recovery.

Point `--base-url` at a proxy in front of a model smaller than the CLI's static
table thinks. Drive past that model's real window.

**Expected.** One compaction, one re-send, the run continues. The transcript
shows an **informational** line, not a red banner. See also row 11.

---

## 4. Fast-tier summarizer

```bash
aragon
/fast on
/fast model <a-cheap-model>
```

Drive past the threshold.

**Expected.** The card names the **cheap** model. `/compact status` reports it as
the summarizer. The digest fit its window (no `timeout` / no truncation).

---

## 5. Failure ladder ★ NOT SKIPPABLE

**Why it cannot be a unit test.** The unit test injects a rejecting stub. This
proves a real network failure lands on the same rung, and that the run *keeps
going* afterwards.

Drive to just under the threshold, then kill the network (disable Wi-Fi, or point
`--base-url` at a dead port) during the summarization.

**Expected, in order.** A retry. Then either a successful summary, or a
`truncated` card and an **amber** warn notice saying so. Either way **the run
continues** — it does not wedge and it does not die.

Then set `compaction.onFailure: "stop"` and repeat.

**Expected.** No splice, a **red** error notice naming `/compact`, `/clear` and
`/reset`, and the next request probably fails — which is what that setting asks
for.

---

## 6. ASCII terminal

```cmd
set ARAGON_UNICODE=0
aragon
```

on `cmd.exe`, and drive past the threshold.

**Expected.** The card, the chip and the activity row render with no mojibake.
The arrow is `->`, the rail marker is `[c]`.

---

## 7. Narrow terminal (60 columns)

Resize to 60 columns and drive past the threshold.

**Expected.** The `compacting` chip **drops**. The gauge survives.
`/compact status` still answers in full — it is the guaranteed surface, which is
what makes dropping the chip acceptable.

---

## 8. `--no-compaction`

```bash
aragon --no-compaction
```

**Expected.** `/compact status` says it is not registered for this session. A run
driven to 95 % dies with the same `context_overflow` it would have before this
feature existed — with the banner now naming `/compact` as well as `/reset`.

---

## 9. Persisted OFF, no flags ★ NOT SKIPPABLE

**Why it cannot be a unit test.** It can, and there is one. This row is here
because the failure it catches is **silent and happens on every single run**, and
a unit test that was written against the wrong commander shape would pass while
the CLI did the wrong thing.

```bash
aragon config set compaction.enabled false
aragon              # NO FLAGS AT ALL
/compact status
```

**Expected.** Still off.

**The failure this catches.** Declaring only `--no-compaction` makes commander
default `opts.compaction` to `true`, at which point the flag is indistinguishable
from its own default and silently overwrites the stored `false` on every flagless
run — a kill switch for a feature that spends money, un-setting itself.

---

## 10. Two compactions in one session ★ NOT SKIPPABLE

**Why it cannot be a unit test.** The unit test asserts one anchor and one block
survive. This is the only way to see whether the **second summary is actually
useful** or a thinner paraphrase of the first.

Drive past the threshold **twice** in one session, with real work between them.

**Expected.**

- The second card still shows the **original task** at the top of the history.
- `/compact status` reports `generation 2`.
- The second summary contains **facts the first one recorded** — file paths,
  commands, values — rather than a vaguer restatement of them.

**The failure this catches.** Compounding, silent decay: a per-kind clip would
discard two thirds of the previous summary before re-summarizing it, and every
card would still say `summarized`.

---

## 11. Reactive path, watching the transcript ★ NOT SKIPPABLE

**Why it cannot be a unit test.** The reducer test asserts the rewrite. This is
the only way to see the **frame the user actually sees**, which is the thing the
defect was about.

Same setup as row 3. Watch the transcript closely during the recovery.

**Expected.** The user **never** sees a red *"start a new conversation with
/reset"* banner on a recovery that succeeds. One informational line reading
*"Context window exceeded - compacting and retrying."* instead.

**The failure this catches.** The loop emits `message_update` for every stream
event *before* the `error` branch throws, so the happy path of the entire
reactive recovery ended with a red banner telling the user to throw away the
session — one frame before it was saved.

---

## Recording results

| Row | Ran | Observed the stated expectation | Notes |
| --- | --- | --- | --- |
| 1 ★ | | | |
| 2 ★ | | | |
| 3 ★ | | | |
| 4 | | | |
| 5 ★ | | | |
| 6 | | | |
| 7 | | | |
| 8 | | | |
| 9 ★ | | | |
| 10 ★ | | | |
| 11 ★ | | | |
