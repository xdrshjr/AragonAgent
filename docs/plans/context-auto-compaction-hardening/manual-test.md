# Context compaction, hardening round — manual test script

Three rows, from spec §8.4. Everything else this round touches is covered by an
automated test; these three are not, and each one for a stated reason.

Round 1's script (`docs/plans/context-auto-compaction/manual-test.md`) is **not**
superseded. Rows 4, 6, 7 and 8 there remain the only observation of this feature
against a live provider, an ASCII terminal and a 60-column window, and they are
still unrun. Six of its seven ★ rows are now automated — that file records which.

Every row states the expected observation. A row that "looked fine" without the
stated observation being seen is a row that did not run.

---

## 1. Persisted OFF survives a flagless run ★ NOT SKIPPABLE

*(Row 9, carried forward from round 1 unchanged.)*

**Why it cannot be a unit test.** It is about process launch and a real
`config.json` on a real machine. The unit test asserts that
`resolveCompactionConfig` reads `flags.compaction !== undefined`; this asserts
that the flag really arrives as `undefined` when nobody typed it.

```bash
aragon config set compaction.enabled false
aragon config list | grep compaction.enabled     # false
aragon                                            # no flags at all
```

In the session: `/compact status`.

**Expected.** `Auto-compaction: not registered for this session (started with
--no-compaction).` and `Saved setting: compaction.enabled = false`. Quit, run
`aragon config list` again — still `false`.

**The failure this catches.** Commander materialises a lone `--no-compaction`
declaration as `opts.compaction = true` when the flag is absent, which is
indistinguishable from silence. A truthiness check would overwrite the stored
`false` on **every** run that passed no flag — a kill switch for a feature that
spends money, un-setting itself.

---

## 2. Sub-agent compaction, both ways ★ NOT SKIPPABLE

**Why it cannot be a unit test.** The unit tests assert that the key decides
whether `contextManager` appears in the child's config, and that the child's
bounds are its own. What they cannot assert is that a real child, running a real
dispatch against a real provider, survives its own window and returns useful
work — which is the entire reason D-15 was reversed.

```bash
aragon config set compaction.subagents true
aragon --team
```

Ask for a fan-out whose children each read several large files, e.g.:

> Dispatch three subagents. Each one reads every file under `src/` that is over
> 30 KB, one at a time, and reports what it found.

**Expected.**

- Each child's row in the team panel keeps advancing past the point where its own
  history would have overflowed. No child ends in `failed` with a provider error
  about context length.
- The dispatch report at the end carries each child's summary, not one truncated
  sentence.
- **No transcript card appears for a child compaction** — the lead's transcript
  describes the lead's context, and a card there would be claiming the lead had
  been compacted (DH-7).
- `/cost` (or the session total in the status bar) includes the children's
  summarization spend: it is real money, priced with the summarizer's table.

Now the other direction:

```bash
aragon config set compaction.subagents false
aragon --team
```

Repeat the same fan-out.

**Expected.** Children behave exactly as they did before this round: a child that
fills its window ends with an error, and the lead receives whatever partial text
that child had produced. This is the byte-identical fallback, and observing it is
the only way to know the key really turns the feature off rather than merely
changing its bounds.

**The failure this catches.** A child manager that is constructed but never
reached — the `contextManager` key spread unconditionally, or the factory
returning a manager whose accessors were read eagerly and so measure an empty
history forever. Both produce a session that looks correct and compacts nothing.

---

## 3. The archive, on disk and read back ★ NOT SKIPPABLE

**Why it cannot be a unit test.** The unit tests write into a temp directory and
assert the document. What they cannot assert is that the real path resolves under
a real `ARAGON_HOME`, that a second `aragon` running at the same time does not
disturb this one, and that `/compact history` prints something a human can act
on.

```bash
aragon config set compaction.archive true
aragon
```

Drive one session past 90 % occupancy so at least two compactions run (a long
tool-heavy task, or `/compact` twice on a large conversation). Then:

```
/compact history
/compact show 1
/compact status
```

**Expected.**

- `/compact history` lists the compactions **newest first**, each with its time,
  trigger, `before -> after` tokens, message count and file name, under a heading
  naming the directory — `~/.aragon/compaction` (or `$ARAGON_HOME/compaction`).
- `/compact show 1` prints metadata, the stored summary, and the full path. **It
  prints no message bodies.** A summary of a few thousand characters is expected;
  a page of conversation is a defect.
- `/compact status` gains an `Archive` line naming the file count and directory.
- On disk, `ls ~/.aragon/compaction` shows
  `compaction-<date>-<time>-<runId>-<n>.json`. Open one: `dropped` is an array of
  the real messages, `droppedCount` matches its length, and `runId` inside the
  document equals the one in the file name.

Now the concurrency half, which is the reason the run id exists:

1. Leave that session running.
2. In a second terminal, start another `aragon` and drive it through one
   compaction too.
3. In **each** session, run `/compact history`.

**Expected.** Each session lists only **its own** compactions, and reports the
other's as a count in one muted trailing line —
`(N more archives from earlier runs in this directory)`. Neither session's files
disappear from disk while the other is running.

Finally:

```bash
aragon config set compaction.archive false
```

Run one more compaction.

**Expected.** No new file appears. `/compact history` says
`No compaction archives for this session. (compaction.archive is off)`.

**The failure this catches.** A global, count-based prune. `<home>/compaction/`
is shared by every `aragon` on the machine — `file-sink.ts` already treats
concurrent processes as normal — so a directory-wide "keep the newest 20" deletes
a live session's archives out from under it, and an unscoped listing presents a
neighbour's compactions as yours. Both are invisible in any single-session test.

---

## Sign-off

| Row | Ran | Observed the stated expectation | Notes |
| --- | --- | --- | --- |
| 1 ★ | | | |
| 2 ★ | | | |
| 3 ★ | | | |

**These three rows have not been run.** The implementing node executed the
automated suites only; every row above requires a live provider and a real home
directory.
