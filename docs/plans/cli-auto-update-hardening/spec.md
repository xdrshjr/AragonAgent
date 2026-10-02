# CLI auto-update — hardening round (第二轮硬化) — design specification

- **Feature slug**: `cli-auto-update-hardening`
- **Package**: `@aragon-agent/cli` (`packages/cli`), bin `aragon`
- **Builds on**: `docs/plans/cli-auto-update/spec.md` v2, shipped as commit `6d519d11`
- **Status**: designed, not implemented
- **Version**: **v2** (reviewed; every P0 and P1 below is fixed in the body)
- **Baseline read for this document**: `packages/cli` @ `0.5.9`, working tree at `6d519d11`
- **Baseline re-read for the review**: same tree; every finding in 评审记录 names the file and
  line it was verified against, not the line this document claimed.

Every claim below cites the file and line it was read from. Where this document contradicts
the v1 spec it says so explicitly and names the decision it overturns; nothing here is a
silent revision of a decision someone else reasoned through.

---

## 评审记录 (Review Notes)

Reviewed section by section on **feasibility / completeness / consistency / right-sizing**
against the tree at `6d519d11`, not against the v1 document. Every finding below was checked
by opening the file it concerns; where this document's own citation was off, that is noted.

**Verdict: 有条件通过 — see §15.** Two P0s, six P1s, ten P2s. All P0s and P1s are fixed in the
body below, and so are all ten P2s — every one of them turned out to be a one-line correction
rather than a design change.

### P0 — must be fixed before any code is written

| # | Finding | Evidence |
|---|---|---|
| **P0-1** | **The `rolled-back` notice cannot render. H1's entire user-visible half is unreachable, through five independent gaps that all point the same way.** (a) `shouldRenderUpdateLine` returns `false` for `idle` and the v1 source comments call `idle`/`checking` "the two phases the user must never be told about" (`update/types.ts:164-165`); §5.3's replacement only touches the `phase === 'failed'` branch, so an `idle` row is suppressed at the call site. (b) `UpdateLine` has no `idle` branch at all — its fallthrough returns `null` and its own comment says "The CALLER never mounts us here" (`ui/UpdateLine.tsx:120-124`), while §8 says the rows go in the "`failed` and `available` branches", neither of which is where the table puts this one. (c) Nothing ever sets `reason: 'rolled-back'`: `snapshot()` builds `reason` from `this.reason` (`update/service.ts:149`), and no section assigns it. (d) `performRollback`'s latch (§5.1.3 step 1) writes four fields and **`rolledBackFrom` is not among them** — the field §7.1 defines and §8 keys the row on is never written by anything. (e) §8 says `markBootHealthy()` clears it, but §5.1.4's code does not, and could not: after a rollback `autoInstalledVersion` is `''`, so `markBootHealthy` returns on its first line before touching anything. AC-46 would still go **green**, because it renders `UpdateLine` from a hand-built snapshot the product never produces — the identical shape of the two defects iteration 1's own review caught (`update-line.test.tsx` green while `recordFailure` passed `advice: undefined`). | `update/types.ts:153-166`, `ui/UpdateLine.tsx:120-133`, `update/service.ts:143-156`, spec §5.1.3, §5.1.4, §7.1, §8 |
| **P0-2** | **A stale `bootAttempts` from a previous arming cycle silently downgrades a healthy release.** `performInstall`'s arming write (§5.2) sets `autoInstalledVersion` and `lastGoodVersion` but **does not reset `bootAttempts`**, and no other path resets it except a rollback that actually fires. Reachable without anything exotic: 0.6.0 auto-installs, arms, crashes twice (`bootAttempts: 2`), the user gives up and runs `npm i -g @aragon-agent/cli@0.5.9` by hand. The guard now takes its fast path forever (`autoInstalledVersion` 0.6.0 ≠ running 0.5.9), so nothing ever clears the counter. Weeks later 0.7.0 — a perfectly good release — auto-installs and arms **on top of `bootAttempts: 2`**, and its *first* launch satisfies `bootAttempts >= crashesBeforeRollback`. The guard rolls a working version back and latches it into `skippedVersion`, so it is never offered again. Silent, destructive, and the opposite of what the guard is for. | §5.2 vs. §5.1.2; `update/service.ts:522-531` (the write that is being extended) |

### P1 — fixed in the body

| # | Finding | Evidence |
|---|---|---|
| **P1-1** | **§6.2's `updateExitCode` change is dead code as written.** The function tests `if (snapshot.phase === 'failed') return 1;` **first** (`cli.tsx:943-948`), and all three new reasons arrive with `phase: 'failed'` (they come from `recordFailure`). Adding them to the `reason ===` line below changes nothing. The fix has to reorder, and reordering is a **behaviour change** for scripts — `blocked-by-os` moves from exit 1 ("try again later") to exit 2 ("this machine will never auto-update") — which the document must state rather than smuggle. | `cli.tsx:943-948`, spec §6.2 |
| **P1-2** | **§5.1.5's central safety claim is false, and it is false in exactly the case §1.1 names as the primary target.** It says `readUpdateState` / `app-paths` are "two small modules with no dependencies beyond `node:*`". `config/app-paths.ts:66` imports `env-paths`, and calls it at module scope (`:77`). Worse, `launcher.ts` imports the guard **statically**, so a resolution failure anywhere in `guard → update/state → config/app-paths → env-paths` throws during the bin entry's own module evaluation — **outside** the `try` that §5.1.1 wraps around `runBootGuard()`. "An undeclared dependency" is the first example §1.1 gives of how an npm CLI bricks itself, and in that case today's design produces a raw `ERR_MODULE_NOT_FOUND` from the launcher and the guard never runs at all. | `config/app-paths.ts:62-77`, spec §5.1.1, §5.1.5 |
| **P1-3** | **`bootGuardMaxAgeMs` is defined, cited as a mitigation, and never used.** §7.2 introduces it, R-15 leans on it ("prevents a year-old `autoInstalledVersion` from triggering anything"), and the guard algorithm in §5.1.2 never reads it — nor could it: there is no timestamp on the arming, and none of the four new fields is one. A mitigation that does not exist is worse than an acknowledged gap, because the risk table reads as covered. | spec §5.1.2 vs. §7.2 vs. R-15 |
| **P1-4** | **The npm fallback silently queries a different registry than the check it is standing in for.** §5.4 promises the two sources are indistinguishable ("`decideUpdate` cannot tell the two sources apart"), but the HTTP path resolves `update.registry` through `resolveRegistryUrl(this.deps.config.registry, env)` (`update/service.ts:378`) while `npm view` obeys the machine's `.npmrc`. On any machine where `update.registry` points somewhere other than npm's default — the mirror case that is *the same population* as the proxy case H3 exists for — the fallback answers about a different package registry. AC-47 pins the argv **without** `--registry`, so the divergence would be frozen into a passing test. | `update/service.ts:378-394`, `update/registry.ts:41`, spec §5.4, AC-47 |
| **P1-5** | **Concurrent launches race the counter into a spurious rollback.** The guard increments at boot and only zeroes on a healthy mount, with no per-process identity. Three terminals starting within the window between the first process's increment and its `markBootHealthy` (module graph + `render()`, a few hundred ms) walk the counter to the threshold and the third rolls back a release that is running fine in the other two. tmux/VS Code session restore starts terminals exactly that way. R-15 worries about this failure mode but attributes it to sleep/OOM/`taskkill` and mitigates it only by arguing the window is small. Counting **failed exits** instead of **attempted boots** removes both the race and R-15's original concern, and is a smaller mechanism than the one it replaces. | spec §5.1.2, R-15 |
| **P1-6** | **Two of the six new log records cannot be emitted by the module §5.6 assigns them to.** `update_boot_armed` and `update_boot_healthy` are the guard's, and §4 rule 2 restricts `guard.ts` to `node:*`, `config/app-paths.js` and `update/state.js`. `getLogger()` is in `logging/logger.ts` and resolves config on its way to a sink (`logging/install.ts:121`), so wiring it in is both a constraint violation and a direct enlargement of the crash surface P1-2 is about — an implementer who "just imports the logger" undoes the fix two findings up. | spec §4 rule 2 vs. §5.6; `logging/logger.ts:34-53` |

### P2 — all ten fixed

| # | Finding | Disposition |
|---|---|---|
| P2-1 | `rollbackTailChars: 500` duplicates `stderrTailChars: 500` (`update/limits.ts:77`), and the rollback reuses `runNpmInstall`, which already bounds the tail with the existing constant. A second number for one thing is what `limits.ts`'s own header warns against. | **Fixed**: removed from §7.2. |
| P2-2 | `classifyInstallFailure(tail, exitCode)` never reads `exitCode`, and no AC exercises it. | **Fixed**: parameter dropped in §5.3. |
| P2-3 | §5.6 gives `via` to `update_check_start`, where it is always `'http'` — the value is not known until after the fetch. | **Fixed**: `update_check_result` only. |
| P2-4 | `readOwnVersion()` appears in §5.1.2's pseudocode with no home. `selfPackageRoot()` is the obvious source and §4 rule 2 forbids importing it. | **Fixed**: §5.1.2 states where it lives and how it resolves the root. |
| P2-5 | §8's prose says the rows go in the "`failed` and `available` branches"; the table's fourth row is `idle`. | **Fixed** as part of P0-1. |
| P2-6 | §1.2 / §7.1 / manual row 14 assert that after a rollback "we are, by construction, running an older CLI" that erases the new fields. Not so: `lastGoodVersion` is only ever written by H1 code (§5.2 and `markBootHealthy`), so the rollback target **always** has H1 and preserves all four fields. The `skippedVersion` belt-and-braces is still right and stays — it costs one field and covers a hand-rolled state file — but the justification overstates, and manual row 14 tells a tester to *expect* the wrong observation. | **Fixed**: §1.2, §7.1 and row 14 restated. |
| P2-7 | AC-1's invariant ("the updater is not in the headless graph") is weakened transitively: `cli.tsx` gains a static `boot/guard.js` import, which statically pulls `update/state.js`. `update-wiring.test.ts:45-54` filters specifiers for the substring `update/`, so it passes textually while the claim it encodes is no longer quite true. | **Fixed**: AC-53 asserts the launcher's transitive static graph against an allow-list. |
| P2-8 | §6.2 introduces exit code `4`, outside the documented `0/1/2` contract in `cli.tsx:936-942`. | **Fixed**: §6.2 notes the contract extension. |
| P2-9 | §5.1.3 step 5 promises the stderr line lands "before `cli.js` is imported", but `performRollback` is `async` and un-awaited — its first statement is a dynamic `import`, which yields. | **Fixed**: the guard writes the line synchronously before calling the rollback. |
| P2-10 | R-21 assigns an assertion to the `update-state` tests, which §9 does not list as modified. | **Fixed**: added to §9. |

### Reviewed and found correct (no action)

- **The C-17 latch through `skippedVersion` (§1.2, D-28)** is the load-bearing idea in this
  document and it is right. `readUpdateState` really does rebuild from a fixed field list
  (`update/state.ts:75-89`) and really does drop unknown keys on the next write (`:127`).
- **No schema bump (D-27)** is right and the reasoning is exact: `update/state.ts:74` returns
  the whole default object on a schema mismatch, which would discard `skippedVersion` on every
  machine at once.
- **`execFile` for the probe, `spawn` for the installer (D-36 / C-20)** is correct, and C-20's
  distinction is real: `InstallResult` carries `stderrTail` and `exitCode` already
  (`update/installer.ts:53-67`), so §9's "installer.ts UNCHANGED" holds.
- **Top-level `await import()` in the bin entry compiles**: `tsconfig.base.json` is
  `target: ES2022` + `module: NodeNext`, and `packages/cli/package.json` is `"type": "module"`.
- **`bin` / `files` / build plumbing**: `files` already ships all of `dist`, `tsconfig`'s
  `include` is `src/**/*.ts` with `rootDir: ./src`, so `src/launcher.ts` and `src/boot/**`
  compile and ship with no packaging change. C-18 and C-19 are both quoted accurately
  (`scripts/prepend-shebang.mjs:12-17`, `__tests__/glyphs.test.ts:191-194`).
- **No `process.argv[1]` consumer exists** in the package, so moving `bin` cannot disturb path
  resolution; `selfPackageRoot()` derives from `import.meta.url` (`install-source.ts:50-57`).
- **`lock.adoptChild` may be passed unbound** as §5.1.3 does: `makeHandle` returns an object
  literal closing over `released`/`current` with no `this` (`install-lock.ts:166-175`).
- **`installNow` really does share `performInstall`** (`update/service.ts:209`), so D-32's
  `{ arm }` parameter is a two-line change and not a restructuring.
- **`updateUpdateState` is synchronous** (`writeFileSync` + `renameSync`), so a
  `process.on('exit')` hook may legally persist from it.
- **Right-sizing**: three capabilities, zero config keys, zero schema bump, one new bin entry
  and four new source files is proportionate to the three risks being paid down. Non-goals 1
  and 2 decline the two things that would have doubled the surface, and both arguments hold.

---

## 0. Requirement trace (需求映射)

The user requirement has four clauses. Round 1 discharged the first three; this round exists
for the fourth.

| Clause (原文) | Where it is met | Round |
|---|---|---|
| 当识别到 npm 上有对应这个软件的新版本 | `update/registry.ts:115` `fetchLatestManifest`, `update/semver.ts:326` `decideUpdate` | 1 ✅ |
| 静默自动更新 | `update/service.ts:486` `performInstall`, detached child in `update/installer.ts:238` | 1 ✅ |
| 最下方提示用户更新情况 | `ui/UpdateLine.tsx`, third occupant of the budgeted bottom row | 1 ✅ |
| 类似 claudecode / 美观优雅 | one row, glyph-routed, compact tier at 60 cols, one toast per session | 1 ✅ |
| **稳健，可靠，顶级** | **partially** — three named risks were *accepted*, not fixed | **2 (this doc)** |

Round 1's own review verdict says this in as many words
(`docs/plans/cli-auto-update/spec.md:1432-1437`): the supply-chain widening in R-1 "is real,
and the mitigation is honest about being a trade rather than a fix." Round 2 is where the
trade gets paid down.

---

## 1. Overview

### 1.1 What is being built

Round 1 gave `aragon` a background updater that is correct on the happy path and silent on
every unhappy one. That silence is the right default and it is also the reason three failure
modes shipped un-mitigated: a user whose update *breaks the CLI* has no way back, a Windows
user whose install is blocked by the OS is told nothing and retries into an exponential
backoff forever, and a user behind a corporate proxy never updates and never learns why.
Each was written down honestly in §9 of the v1 spec — R-9, R-3 and R-5 — and each was
deferred with a mitigation that depends on somebody *else* acting (the maintainer noticing
and running `npm deprecate`, the user guessing that `npm i -g` will fail the same way,
the administrator configuring a mirror).

This round adds three capabilities, in descending order of what they are worth:

- **H1 · Bad-release recovery.** A **boot guard** in a new, minimal bin entry counts launches
  of a version *this updater installed* that never reached a healthy mount. After two, it
  rolls the machine back to the version that was running before the update and latches the
  bad one so nothing reinstalls it. This is the mitigation R-9 does not have, and it is the
  only one that works when the failure is an import-time crash — the single most common shape
  of a bricked npm CLI (an undeclared dependency, a Node API that moved, a syntax error past
  the transpile target).
- **H2 · Install-failure classification.** The one line a user is ever allowed to see on the
  failure path currently reads `update failed · npm i -g @aragon-agent/cli`
  (`ui/UpdateLine.tsx:80-86`) for *every* cause. For `EPERM`/`EBUSY` — the Windows
  self-replacement case, R-3 — that advice will fail in exactly the same way, so the one
  visible failure is also a wrong instruction. Failures gain a small, pure classifier, three
  of the resulting reasons bypass the three-strike silence threshold because they are
  actionable and will not fix themselves, and each gets a row that names the real remedy.
- **H3 · A proxy-aware fallback probe.** Node's `fetch` (undici) ignores `HTTP_PROXY`, which
  v1 recorded as R-5 and accepted: "The check fails, silently, forever." When the direct
  request returns `null`, the check now retries once through **the npm this machine already
  has**, which honours `proxy`, `https-proxy`, `.npmrc` and any auth the user configured.
  No new dependency, no credential ever read by us, and the fallback runs only on a check
  that has already failed.

### 1.2 Why this shape

**The rollback lives *below* the CLI, not inside it.** The instinct is to put crash recovery
in `cli.tsx::main()`. That covers a crash *after* the module graph loads and misses the class
of failure that actually bricks npm CLIs: `dist/cli.js` statically imports ~60 modules, and a
release that fails to *import* never reaches any line anyone wrote inside `main()`. So `bin`
moves to a new `dist/launcher.js` whose entire body is "read one small JSON file, maybe spawn
a rollback, then `await import('./cli.js')` inside a `try`". The guard is armed **only** for a
version this updater installed and has not yet seen boot healthy, so on every other launch —
which is almost all of them — it is one `readFileSync` of ~300 bytes and a string compare,
with no write at all.

**The guard only cleans up damage we caused.** `state.autoInstalledVersion` gates the whole
mechanism. If a user's own `npm i -g @aragon-agent/cli@broken` crashes, that is their install
and their decision, and an updater that silently reverts it is a worse actor than one that
does nothing. This also bounds the blast radius of the guard itself: the maximum harm a bug
in it can do is one unnecessary reinstall of the version the user was already running an hour
ago.

**Rollback must latch through a field the *old* version understands.** This is the invariant
in this document most likely to be dropped by a reader in a hurry, and dropping it produces an
infinite loop. `readUpdateState` (`update/state.ts:68-93`) rebuilds the object field by field
from a known list, so an *older* `aragon` writing the state file **erases every field it does
not know about** — including `autoInstalledVersion` and `lastGoodVersion`. If the bad version
were latched only in a new field, a CLI that predates that field would not see the latch, would
decide `install` on its very next check, and would reinstall the release that just bricked the
machine — once per interval, forever. The rollback therefore also writes `skippedVersion`, which
is a schema-1 field (`update/state.ts:38`) that every shipped version honours through
`decideUpdate({ skippedVersion })` (`update/service.ts:406-411`).

**How load-bearing that is, stated accurately (P2-6).** The first draft argued that "after a
rollback we are, by construction, running an older CLI" and therefore always in the erasing
case. That overstates it. `lastGoodVersion` — the rollback target — is only ever written by H1
code: §5.2's install-time write and `markBootHealthy`. The target is therefore always a version
that has all four fields and preserves them, and in the ordinary path the new fields survive the
downgrade intact. `skippedVersion` is belt-and-braces rather than the sole channel: it costs one
field in a write that is already happening, and it covers the cases the argument above does not
reach — a hand-edited or partially lost state file, a user who manually installs a pre-H1
version, and any *future* field that turns out to matter across the boundary. It stays, and D-28
stays, for the second reason rather than the first.

**Classification is pure, and the *reporting* rule is the interesting half.** Turning a tail of
npm output into a reason is a twenty-line regex table. The design decision is which reasons
are allowed to break the three-strike silence rule in `shouldRenderUpdateLine`
(`update/types.ts:161-163`). The rule that makes this safe rather than the beginning of
notification fatigue: **a reason may report immediately only if it is (a) actionable by the
user and (b) not self-healing.** `network` fails both halves and stays silent. `blocked-by-os`,
`no-space` and `not-writable` pass both, and each will otherwise repeat identically until the
user does something — which is the definition of a notice worth showing once.

**The fallback delegates to npm rather than re-implementing a proxy.** We do not read
`.npmrc`, we do not parse `HTTP_PROXY`, and we do not attach credentials to anything — D-13's
"NO CREDENTIALS, EVER" (`update/registry.ts:11-15`) is untouched, because we never see them.
We run the command the user could have typed, through the `npm-cli.js` `resolveNpmCli()`
(`update/installer.ts:100-114`) already locates for the installer, and read one version string
out of its JSON.

### 1.3 Non-goals (v2)

All six of v1's non-goals (`docs/plans/cli-auto-update/spec.md:262-277`) carry over unchanged.
Four more are declined here, each because the reasoning against it is stronger than the
reasoning for:

1. **Staged rollout / a soak delay before auto-installing a fresh release.** Tempting, and it
   is what large desktop apps do — but it only works when *somebody else* discovers the bad
   release first, which is the same "a human notices and acts" dependency R-9's v1 mitigation
   already had, plus a mandatory delay on every good release. H1 recovers without needing
   anyone to notice. Adding both is paying twice for one outcome.
2. **Rolling back on anything except a failure to start.** A release that boots and is subtly
   wrong is not detectable from inside itself, and a heuristic that tries ("too many errors
   this session") would eventually revert a working version on a bad network day. The guard's
   trigger is deliberately the one signal that is unambiguous.
3. **Any new `update.*` config key.** D-16 (`config/schema.ts:1022-1024`) — "FOUR KEYS AND NO
   MORE" — survives this round intact. `mode: 'off'` already disables the updater and
   therefore the guard's arming condition; nothing here needs a second switch, and a
   `update.rollback: false` key would be a way to ask for the broken half of a feature.
4. **Retrying a blocked install in-session.** On Windows the handle that blocks the write is
   held for the lifetime of the shell that launched us (§5.4). Retrying at 30-second intervals
   inside that same session cannot succeed and would burn the failure counter; the honest
   move is one accurate line.

---

## 2. What v1 shipped, and the three risks it accepted

Read from the tree, not from the v1 document.

| Area | Shipped behaviour | Evidence |
|---|---|---|
| Check | one `GET <registry>/<pkg>/<distTag>`, never throws, `null` on any failure | `update/registry.ts:115-177` |
| Decision | strictly-newer + stable + non-deprecated + `engines.node` satisfied + not skipped | `update/semver.ts:326`, `update/service.ts:406` |
| Eligibility | auto-install for `npm-global` only; `dev-monorepo` / `npx` / `npm-local` silent | `update/install-source.ts:179-203` |
| Install | detached `node <npm-cli.js> install --global pkg@ver`, output to a real fd, never killed | `update/installer.ts:225-298` |
| Post-install | re-reads `<root>/package.json`; a mismatch is `ineffective` and latches `skippedVersion` | `update/installer.ts:278-287`, `update/service.ts:534-552` |
| Apply | next launch; `pendingRestartVersion` reconciled at `start()` | `update/service.ts:316-322` |
| Failure policy | silent below three consecutive; exponential backoff 30 min → 24 h | `update/limits.ts:57-67`, `update/service.ts:275-284` |
| Row | exactly one row, never `null`, compact below 60 cols | `ui/UpdateLine.tsx:55-143`, `update/types.ts:153-166` |

Three risks were named and accepted:

- **R-9 — "A bad release bricks every user at once."** Mitigation as shipped: the prerelease /
  `deprecated` / `engines.node` gates, plus `aragon update --to <version>` and the maintainer
  running `npm deprecate`. **All three of those require the CLI to still start.** For an
  import-time crash none of them is reachable, and the user's only recovery is to know the
  package name and run `npm i -g @aragon-agent/cli@<some older version>` from memory.
- **R-3 — "EPERM / EBUSY on Windows."** Mitigation as shipped: "Treated as an ordinary install
  failure: logged, backed off, silent until three failures." The consequence, which the row
  does not say, is that the third failure prints advice (`npm i -g @aragon-agent/cli`) that
  will hit the same handle and fail identically.
- **R-5 — "Corporate proxy. Node's `fetch` (undici) ignores `HTTP_PROXY`."** Mitigation as
  shipped: "The check fails, silently, forever, with a log record."

And one **verification debt**: the v1 review's approval condition 3
(`docs/plans/cli-auto-update/spec.md:1419-1424`) requires the first real end-to-end run on
**both Windows and Linux** before the feature is considered done, and `manual-test.md` marks
rows 1, 2, 4 and 11 as "cannot be skipped". Iteration 1's implementation and review nodes
report offline verification, live registry reads and a green suite — not a real global
install. That debt is carried into this round as **H0** and is a gate on H2 (§5.4), because
row 1 on Windows is the experiment that decides whether the `blocked-by-os` path is exotic or
routine.

---

## 3. Constraints inherited (additions to v1's C-1 … C-16)

| # | Constraint | Source |
|---|---|---|
| C-17 | `readUpdateState` rebuilds the object from a **fixed field list**, so any field it does not know is **erased on the next write by that version**. A new field is therefore invisible to — and destroyed by — every already-released CLI. Cross-version signalling must use a field that already exists. | `update/state.ts:75-89`, `:126-130` |
| C-18 | The bin entry is `./dist/cli.js` and its shebang is added **post-build** by `scripts/prepend-shebang.mjs`, which hardcodes that one path and `process.exit(1)`s if it is missing. A second entry point is not just a `package.json` edit. | `packages/cli/package.json` `bin`, `scripts/prepend-shebang.mjs:12-17` |
| C-19 | The glyph scanner's `inScope` is a hardcoded alternation of directory names plus the literal `cli.tsx`. A new top-level tree **and** a new top-level entry file each need a word added, in the same commit, or the "no hardcoded non-ASCII" claim goes vacuous exactly there. This package has paid for it four times. | `__tests__/glyphs.test.ts:191-194` |
| C-20 | `execFile`'s `timeout` is **safe for a read-only probe and forbidden for the installer**. v1's IF-3 and P1-5 are about the installer specifically: a `SIGTERM` mid-`npm install -g` leaves a broken global installation. A `npm view` that is killed has written nothing. | `update/limits.ts:38-47`, v1 IF-3 |
| C-21 | `LogScope` is a closed union; a subsystem that logs adds its member in the same commit or it does not compile. | `logging/logger.ts:34-53` (v1 C-13) |

---

## 4. Module map

```
packages/cli/src/
  launcher.ts            NEW  the bin entry. ~30 lines. Guard, then import('./cli.js').
  boot/
    guard.ts             NEW  runBootGuard(): arm / count / disarm / decide rollback. Pure-ish.
    rollback.ts          NEW  performRollback(): dynamic-imports lock + installer, latches.
  update/
    npm-view.ts          NEW  fetchLatestViaNpm(): the proxy-aware fallback probe.
    classify-failure.ts  NEW  classifyInstallFailure(tail): pure regex table.
    service.ts           MOD  records lastGood/autoInstalled; consumes the rollback
                              notice; wires H2 + H3.
    state.ts             MOD  +4 fields, NO schema bump (C-17 / D-27).
    types.ts             MOD  +2 reasons, +3 snapshot fields, immediate-notice set,
                              rollback clause in shouldRenderUpdateLine.
    limits.ts            MOD  +2 structural numbers.
    installer.ts         UNCHANGED — it already returns `stderrTail` + `exitCode`.
    registry.ts          UNCHANGED.
    semver.ts            UNCHANGED.
    install-source.ts    UNCHANGED.
    install-lock.ts      UNCHANGED — reused by rollback as-is.
```

Two rules from v1 §3.1 carry over and constrain this map:

1. **`ui/**` may import from `update/` only with `import type`.** `ui/UpdateLine.tsx` gains
   rows for the new reasons; it must not gain a value import. The immediate-notice set lives
   in `update/types.ts` beside `shouldRenderUpdateLine`, which `ui/App.tsx` already imports as
   a value — that edge exists and is the only one.
2. **`update/**` must not import `agent/**`.** `boot/**` is stricter still: `guard.ts` imports
   `node:*`, `config/app-paths.js` and `update/state.js` and **nothing else**, because every
   module it pulls in is a module that can crash before the guard has run. In particular it must
   not import `logging/logger.js` — see §5.6 (P1-6), where the temptation is concrete.
   **The chain is not `node:*`-only and the list must not be read as claiming so**: `state.ts`
   imports `config/app-paths.js` (`update/state.ts:24`), which imports and calls `env-paths`
   (`config/app-paths.ts:66`, `:77`). That is a third-party module in the guard's graph, which
   is why `launcher.ts` imports the guard **dynamically** (§5.1.1) and why §5.1.5 names the
   residual gap. The list above is what keeps that graph from growing, not evidence that it is
   already empty.

---

## 5. Technical design

### 5.1 H1 — the boot guard

#### 5.1.1 The new entry point

`package.json`'s `bin.aragon` changes from `./dist/cli.js` to `./dist/launcher.js`.
`src/launcher.ts` compiles to `dist/launcher.js` under the existing `rootDir: ./src` →
`outDir: ./dist` build; `files` already ships all of `dist`.

```ts
// src/launcher.ts — the bin entry. Keep it this small; every import here is a
// module that can crash before the guard that exists to survive crashes.
import process from 'node:process';

try {
  // DYNAMIC, and that is the whole point (P1-2). A STATIC import of the guard
  // would put `boot/guard -> update/state -> config/app-paths -> env-paths` in
  // the bin entry's own module graph, and a resolution failure anywhere in that
  // chain throws during THIS module's evaluation - outside the try below,
  // before any line of it runs. "An undeclared dependency" is the first way
  // section 1.1 says a release bricks itself; a guard whose own import fails in
  // that exact case has to degrade to "no guard", never to "no CLI".
  const { runBootGuard } = await import('./boot/guard.js');
  runBootGuard();
} catch {
  // A guard that throws must never be the reason the CLI will not start. This
  // is the one catch in the package that is allowed to be empty: there is no
  // logger yet, and there is nothing the user could do with the message.
}

await import('./cli.js').catch((err: unknown) => {
  process.stderr.write(`${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  process.exitCode = 1;
});
```

**Why the guard is not made `node:*`-only instead.** The alternative fix is to have `guard.ts`
resolve `<home>/update-state.json` itself and drop `config/app-paths.js`. That buys coverage of
one more case — a release whose `node_modules` lost `env-paths` specifically — at the price of a
second copy of the home-root arithmetic, which is precisely what `config/app-paths.ts`'s own
header exists to prevent ("Two copies of a name is exactly the shape that lets a rename land in
one of them and not the other, and the failure is silent"). One source of truth for the path is
worth more than one more recoverable crash shape, and §5.1.5 now states the residual gap plainly
rather than claiming it away.

`await import(...)` at module top level requires `"type": "module"` — already true
(`packages/cli/package.json`). `cli.js` runs `main()` at module scope and installs its own
`.catch` (`cli.tsx:` last 5 lines); the `.catch` here is for the **import** rejecting, which
is precisely the import-time-crash case the guard exists for and which today produces an
unhandled rejection with a stack the user cannot act on.

`scripts/prepend-shebang.mjs` is generalised from one hardcoded target to a list
(`['cli.js', 'launcher.js']`), keeping its "missing target is a build failure" behaviour per
target. **Both** keep the shebang: `npm start` (`node dist/cli.js`) and any user script that
invokes `dist/cli.js` directly must keep working byte-for-byte.

#### 5.1.2 What the guard does

```
runBootGuard():
  state = readUpdateState()                         // one readFileSync, ~300 bytes
  version = readOwnVersion()                        // <root>/package.json, cached
  if state.autoInstalledVersion !== version: return  // FAST PATH: no write, no work
  if state.bootFailures >= UPDATE_LIMITS.crashesBeforeRollback
     and state.lastGoodVersion
     and state.lastGoodVersion !== version:
        stderr.write("aragon <version> failed to start twice; rolling back to <good>.\n")
        performRollback(version, state.lastGoodVersion)   // spawns, does not wait
        return                                            // and we still boot on
  process.on('exit', (code) => {
    if (code === 0) markBootHealthy(version)
    else            updateUpdateState({ bootFailures: state.bootFailures + 1 })
  })
```

`readOwnVersion()` lives in `guard.ts` and resolves `<root>/package.json` the way
`install-source.ts:50-57` does — `dirname(fileURLToPath(import.meta.url))` then up two, which
from `dist/boot/` lands on the package root exactly as it does from `dist/update/`. It is
duplicated rather than imported because §4 rule 2 keeps `install-source.js` out of the guard's
graph; it is four lines of `node:*` with no path *name* in it, so it is not the duplication
`config/app-paths.ts`'s header forbids (P2-4).

Read it against the failure it is defending:

- **`state.autoInstalledVersion !== version` is the arming condition, and it is first.**
  `autoInstalledVersion` is written by `performInstall` on success (§5.2) and cleared by
  `markBootHealthy`. So the guard is armed for exactly the window between "we installed X" and
  "X has been seen to start", and for no other launch of any version. Steady state — which is
  every launch on every machine except the first one after an auto-update — is one read and
  one string compare. **Reordering this check after anything else costs a write on every
  `aragon --version`.**
- **The counter counts FAILED EXITS, not attempted boots, and that is a correction to this
  document's first draft (P1-5).** Incrementing at boot and zeroing only on a healthy mount
  leaves the counter with no per-process identity: three terminals starting inside the window
  between the first process's increment and its `markBootHealthy` — module graph plus
  `render()`, a few hundred milliseconds — walk it to the threshold, and the third rolls back a
  release that is running fine in the other two. tmux and VS Code session restore start
  terminals exactly that way. Counting exits instead makes each launch account only for
  itself: a launch that exits `0` never contributes, however many of them overlap.
  It also dissolves the false positive R-15 was written about — a machine that slept, OOMed or
  was `taskkill`ed does not exit with a code at all, so it cannot be mistaken for a crash.
  **The cost is stated rather than hidden**: a release that dies without running exit handlers
  (`SIGKILL`, a native segfault, `process.abort()`) is never counted and is never rolled back.
  For a pure-JS CLI whose failure mode §1.1 names is a *module that will not import* — which
  raises, and therefore exits `1` through the launcher's `.catch` — that is the right side of
  the trade.
- **The threshold is tested *before* this launch can contribute.** `crashesBeforeRollback = 2`
  therefore means "two previous launches of X exited non-zero", and the rollback happens on the
  third. One crash is not enough: a machine that ran out of memory once, or whose session file
  was corrupt, gets a second chance at the release it just installed.
- **The rollback spawn does not abort the boot.** Refusing to start would be the wrong trade:
  if the crash was transient the user is now locked out of a working CLI by our guess. The
  detached child completes regardless (v1 D-10 / U-3), so the worst case is one more crash
  followed by a good launch.
- **The stderr line is written here, synchronously, and not inside `performRollback` (P2-9).**
  §5.1.3 promises it lands above whatever the CLI prints; `performRollback` is `async` and its
  first statement is a dynamic `import`, which yields, so a line written in there races the
  `await import('./cli.js')` that follows. Written by the guard before the call, the ordering
  is a property of the code rather than of the module loader's timing.
- **`process.on('exit')` is now the only bookkeeping site, and both branches matter.** It fires
  on clean exits including `process.exit(0)`, and on an uncaught exception, where the code is
  `1`. `markBootHealthy` from `runInteractive` (§5.1.4) remains the primary disarm, because it
  fires seconds into a session that may then run for hours and be `SIGKILL`ed at the end.

#### 5.1.3 The rollback

```ts
// src/boot/rollback.ts
export async function performRollback(bad: string, good: string): Promise<void> {
  const { tryAcquireInstallLock } = await import('../update/install-lock.js');
  const { runNpmInstall } = await import('../update/installer.js');
  const { classifyInstallSource, selfPackageRoot, readSelfManifest, isAutoInstallable }
    = await import('../update/install-source.js');
  ...
}
```

Dynamic imports, and for a reason that is not the usual one: we are running inside a build we
have concrete evidence is broken, so every one of these can reject. The whole body is inside
one `try`, and the `catch` writes a single stderr line and returns.

Order of operations, and the order is load-bearing:

1. **Latch first, install second.** Write, in one `updateUpdateState` call, all five of:
   `skippedVersion: bad` (C-17 — the field a hand-rolled older CLI would still honour),
   `pendingRestartVersion: ''`, `bootFailures: 0`, `autoInstalledVersion: ''`,
   **`rolledBackFrom: bad`**.
   If the process dies between the latch and the spawn, the machine is left running a broken
   version that will not be reinstalled — recoverable. In the other order, a death between
   spawn and latch leaves a good version installed with no latch, and the next check
   reinstalls the bad one.
   **`rolledBackFrom` is written here and nowhere else (P0-1d).** The first draft of this
   document defined the field in §7.1, keyed the §8 row on it, and never wrote it — so the one
   thing that tells the user their CLI was silently downgraded could not have appeared. It is
   consumed exactly once, by `UpdateService.start()` (§5.2a).
2. **Re-classify before spawning.** `classifyInstallSource(selfPackageRoot())` must still be
   `npm-global` and `probeWritable` must still be true. The machine may have changed since the
   install; we do not run `npm i -g` on a tree we would not have installed into.
3. **Take the ordinary install lock.** `tryAcquireInstallLock()` — one non-blocking attempt
   (v1 U-5b). If another process holds it, return: it is either installing or already rolling
   back, and two concurrent `npm i -g` on one prefix is the one thing the lock exists to stop.
4. **`runNpmInstall({ packageName, version: good, root, onSpawn: lock.adoptChild })`**, reused
   verbatim. It already validates the version against `STRICT_VERSION_RE`
   (`update/installer.ts:183`), spawns detached through `process.execPath`, writes to a real
   fd and verifies the classified root afterwards (U-6). A rollback is an install; it does not
   deserve a second code path.
5. **The stderr line is the guard's, not this function's (P2-9).**
   `aragon <bad> failed to start twice; rolling back to <good>.` is written synchronously by
   `runBootGuard` immediately before it calls this function (§5.1.2), so it is guaranteed to
   land above whatever the CLI prints and to be visible even if the CLI then crashes again.
   This is the **only** user-visible message this feature adds outside the bottom row, and
   C-10 permits it because the TUI is not mounted yet — there is no fixed frame to shift.
6. **Log `update_rolled_back { from, to, attempts }`** under the existing `'update'` scope.

`runNpmInstall`'s promise settles on the child's exit; `performRollback` is invoked without
`await` from the guard, and the guard does not block on it. The child is `unref()`ed, so it
neither delays nor prevents our own exit.

#### 5.1.4 Disarming: `markBootHealthy()`

```ts
// src/boot/guard.ts
export function markBootHealthy(version: string): void {
  const state = readUpdateState();
  if (state.autoInstalledVersion !== version) return;   // idempotent, and the fast path
  updateUpdateState({ autoInstalledVersion: '', bootFailures: 0, lastGoodVersion: version });
}
```

Called from two places:

- **`cli.tsx::runInteractive`, immediately after `render()` returns** — the earliest moment at
  which "this build starts" is proven: the module graph loaded, config resolved, Ink mounted.
  This is the primary, and it is what makes a long session that is later `SIGKILL`ed (terminal
  window closed, machine slept badly, OOM killer) still count as healthy.
- **the `process.on('exit')` hook installed by the guard, when `code === 0`** — the backstop
  for `aragon -p`, `aragon config set`, `aragon --version` and every other path that never
  mounts Ink.

Both are idempotent through the first-line guard. `lastGoodVersion` is set here as well as at
install time (§5.2), which is deliberate belt-and-braces: it means that even a machine whose
state file was deleted between the install and the next launch converges to a correct
`lastGoodVersion` after one healthy run.

**It does not touch `rolledBackFrom`, and it must not (P0-1e).** §8's first draft said this
function clears the rollback notice; it could never have done so, because in the session after a
rollback `autoInstalledVersion` is `''` and this function returns on its first line before
touching anything. The notice is consumed by `UpdateService.start()` instead (§5.2a), which is
also the only place that can decide it has actually been *shown*.

#### 5.1.5 What the guard cannot do

Stated here so nobody has to rediscover it:

- It cannot protect the release that **introduces** it. The currently-installed `bin` points at
  `dist/cli.js`; only after one successful update does the shim point at `dist/launcher.js`.
- **It cannot survive a failure inside its own import chain, and that chain is not
  `node:*`-only (P1-2).** `guard.ts` imports `update/state.js`, which imports
  `config/app-paths.js` (`update/state.ts:24`), which imports **`env-paths`** and calls it at
  module scope (`config/app-paths.ts:66`, `:77`). So a release broken by a `node_modules` that
  lost `env-paths` — one instance of the "undeclared dependency" case §1.1 names — takes the
  guard down with it. The launcher's dynamic import (§5.1.1) contains the damage: the failure
  becomes "no guard, and the CLI reports its own crash normally" rather than
  "`ERR_MODULE_NOT_FOUND` from the bin entry". It is a real hole in H1's coverage and it is
  stated here rather than argued away; the import list in §4 rule 2 is what keeps it from
  growing.
- It cannot recover a machine whose **npm** is broken, because the rollback is an `npm i -g`.
  `resolveNpmCli()` returning `null` degrades to notify-only, as it already does for installs.
- It does not roll back a version the user installed themselves (§1.2).

### 5.2 H1 — the service side

`performInstall` (`update/service.ts:486-565`), success branch, currently writes
`{ pendingRestartVersion: target, consecutiveFailures: 0, lastFailureAt: 0 }`. It gains two
fields in the same call:

```ts
updateUpdateState({
  pendingRestartVersion: target,
  consecutiveFailures: 0,
  lastFailureAt: 0,
  autoInstalledVersion: target,                 // arms the guard for the next launch
  lastGoodVersion: this.deps.currentVersion,    // what we are running RIGHT NOW, by
                                                // definition a version that starts
  bootFailures: 0,                              // P0-2: arming is a FRESH cycle
});
```

`lastGoodVersion` is the version doing the installing. That is the strongest available
evidence of "this one works": it is executing. Reading it from anywhere else — the registry,
a list of published versions — would be a guess.

**`bootFailures: 0` is not defensive tidying; without it the guard downgrades healthy
releases (P0-2).** Arming and the counter are two fields with two lifetimes, and nothing else
resets the counter except a rollback that actually fires. Follow the state through an ordinary
sequence: 0.6.0 auto-installs and arms, crashes twice (`bootFailures: 2`), and the user gives
up and runs `npm i -g @aragon-agent/cli@0.5.9` by hand rather than launching a third time. The
guard now takes its fast path forever — `autoInstalledVersion` is 0.6.0, the running version is
0.5.9 — so the counter is stranded at 2. Weeks later 0.7.0, a perfectly good release, auto-
installs and arms **on top of it**, and its very first launch already satisfies
`bootFailures >= crashesBeforeRollback`. The guard rolls a working version back and latches it
into `skippedVersion`, so it is never offered again. One field in a write that was already
happening; its absence is silent, destructive, and the exact inverse of what H1 is for.

`reconcilePendingRestart()` (`update/service.ts:316-322`) is unchanged. It fires on the launch
*after* the install, which is the same launch the guard arms on; the two do not interact
because `reconcilePendingRestart` runs inside `UpdateService.start()`, long after the guard,
and only clears `pendingRestartVersion`.

One interaction to get right: **`installNow()` from `aragon update --to <version>`** is a
deliberate user action, and it must **not** arm the guard. A user who explicitly asks for
version X and gets a crash has made a decision we should not silently reverse. `performInstall`
therefore takes a new `opts: { arm: boolean }`, `true` from the automatic path and `false`
from `installNow` (`update/service.ts:209` is the single call site to change).

### 5.2a H1 — surfacing the rollback (the half the first draft dropped)

The guard runs before the CLI and writes to a file; the row that tells the user about it is
rendered by a React component reading a snapshot. Nothing in the first draft connected the two,
so `rolledBackFrom` was defined, keyed on, and never written *or* read (P0-1). Three small
pieces close it, and they are deliberately routed around `phase` rather than through it.

**1 · The service consumes the notice once, at `start()`.**

```ts
/** Read the rollback notice, hold it for this session, and clear the file. */
private consumeRollbackNotice(): void {
  const state = readUpdateState();
  if (!state.rolledBackFrom) return;
  this.rolledBackFrom = state.rolledBackFrom;
  this.rolledBackTo = this.deps.currentVersion;   // by definition: we ARE the target
  updateUpdateState({ rolledBackFrom: '' });
  this.log.warn('update_rollback_notice', { from: this.rolledBackFrom, to: this.rolledBackTo });
}
```

Called from `start()` next to `reconcilePendingRestart()` (`update/service.ts:136-141`), which
is the established place for "reconcile what a previous process left in the file". Consuming on
read is what makes D-38's "one session" true without a second timestamp: a launch that never
constructs a service — `update.mode: 'off'`, a non-TTY, CI (`cli.tsx:470-474`) — does not burn
the notice, so it survives to the first session that could actually have shown it.

`rolledBackTo` is the running version and is therefore derived, not stored; §7.1 keeps one
field, not two, and the `requiredNode`/`runningNode` "both or neither" rule (§7.3) is satisfied
by construction rather than by discipline.

**2 · Presence is decided outside `phase`.** The row must not be erased three seconds later
when the first scheduled check moves the phase to `checking`, and it must yield to real news:

```ts
export function shouldRenderUpdateLine(s: UpdateSnapshot): boolean {
  if (s.phase === 'available' || s.phase === 'installing' || s.phase === 'ready') return true;
  if (s.phase === 'failed') {
    if (s.reason && IMMEDIATE_NOTICE_REASONS.has(s.reason)) return true;
    return s.consecutiveFailures >= UPDATE_LIMITS.failuresBeforeNotice;
  }
  // idle | checking: silent, EXCEPT for a rollback this session has not yet
  // reported. Placed last on purpose - any real news above owns the row first,
  // and the budget is one row (C-15).
  return Boolean(s.rolledBackFrom);
}
```

**3 · `UpdateLine` renders it from the branch it already has.** The four existing phase
branches are untouched; the row goes in the fallthrough that today returns `null` — which is
reached for exactly `idle` / `checking` (`ui/UpdateLine.tsx:120-124`). The component still
returns an element and never `null` (C-15 / v1 P0-1); only the `!line` fallback loses one of
its two callers.

There is no new `UpdateReason` for this. `'rolled-back'` as a *reason* was the first draft's
mistake: `reason` is set by `setPhase` on every transition and would be overwritten by the next
check before anyone read it. A snapshot field the state machine does not own is the right shape
for a fact that is true for a whole session.

### 5.3 H2 — install-failure classification

```ts
// src/update/classify-failure.ts — pure, no imports beyond types.
const TABLE: ReadonlyArray<[RegExp, UpdateReason]> = [
  [/\bEPERM\b|\bEBUSY\b|\bETXTBSY\b|operation not permitted|resource busy or locked/i,
     'blocked-by-os'],
  [/\bEACCES\b|permission denied/i,               'not-writable'],
  [/\bENOSPC\b|no space left/i,                   'no-space'],
  [/\bENOTFOUND\b|\bEAI_AGAIN\b|\bECONNRESET\b|\bETIMEDOUT\b|network|proxy|tunneling socket/i,
     'network'],
];

export function classifyInstallFailure(tail: string | undefined): UpdateReason {
  if (!tail) return 'install-failed';
  for (const [re, reason] of TABLE) if (re.test(tail)) return reason;
  return 'install-failed';
}
```

**One parameter, not two (P2-2).** The first draft took `exitCode` and never read it. npm exits
`1` for every one of these, so the code carries no information the tail does not; a parameter
that no branch and no acceptance test consumes is a maintenance liability that reads like a
promise.

**First match wins, and the order is not alphabetical.** `EPERM` is tested before `EACCES`
because npm's Windows output frequently carries both (the `EPERM` on the shim rename plus an
`EACCES` from a retry), and the actionable one is the first. `network` is last because "proxy"
and "network" appear inside unrelated npm advisory text often enough that an earlier position
would swallow the specific cases.

`performInstall`'s generic-failure branch (`update/service.ts:558-564`) changes from
`this.recordFailure('install-failed')` to
`this.recordFailure(classifyInstallFailure(result.stderrTail))`.
`recordFailure` itself is unchanged: it still increments, still persists, still attaches
`adviceFor(...)`, still sets `phase: 'failed'`.

The **reporting** rule moves into `update/types.ts`, next to the predicate it modifies:

```ts
/**
 * Reasons allowed to break the three-strike silence (D-7), because each is both
 * ACTIONABLE and NOT SELF-HEALING. A `network` failure is neither: the user
 * cannot fix the registry and the next check may well succeed, so it stays
 * silent and backs off, which is the whole reason this feature is tolerable.
 */
export const IMMEDIATE_NOTICE_REASONS: ReadonlySet<UpdateReason> =
  new Set(['blocked-by-os', 'no-space', 'not-writable']);
```

§5.2a gives `shouldRenderUpdateLine` in full, including this set and the rollback clause; the
two changes land in one function and are written out once rather than twice.

The three still obey every other silence rule: the row is one row, it does not re-announce, it
disappears when the phase changes, and `/update skip` still silences it.

#### 5.3.1 Why `blocked-by-os` needs its own advice

On Windows the shim that launched us — `%APPDATA%\npm\aragon.cmd` — is being read by the
`cmd.exe` (or PowerShell) that is running it, for as long as our process lives. npm's install
rewrites that shim. The failure is therefore not exotic; on Windows it is **structural**, and
it is the platform the primary maintainer of this package develops on. The advice `npm i -g
@aragon-agent/cli`, run from the same shell, hits the same handle. The correct instruction
names the actual obstacle:

> `update blocked · close other aragon windows, then: npm i -g @aragon-agent/cli`

**H0 gates the strength of the claim, not the work.** Whether the shim is held is an empirical
question about `cmd.exe`, and the answer changes only the *frequency* of this path, never the
correctness of classifying it. `manual-test.md` row 1 on Windows (v1 approval condition 3,
still outstanding) is where the answer comes from, and row 13 (§10.3) records it. If the write
turns out to succeed on Windows, this path becomes rare and the classifier costs twenty lines;
if it fails, this round has just fixed the single most common update failure on the package's
primary platform.

### 5.4 H3 — the proxy-aware fallback

```ts
// src/update/npm-view.ts
export async function fetchLatestViaNpm(
  registry: string, packageName: string, distTag: string, deps: NpmViewDeps = {},
): Promise<LatestManifest | null>
```

- **Command**: `process.execPath` + `[npmCliJs, 'view', `${packageName}@${distTag}`, '--json',
  '--loglevel=error', `--registry=${registry}`]`, via `execFile` with `shell: false`,
  `windowsHide: true`, `timeout: UPDATE_LIMITS.npmViewTimeoutMs` (10 s), `maxBuffer:
  UPDATE_LIMITS.manifestMaxBytes`, and `env: cleanInstallEnv(env)` reused from
  `update/installer.ts:123-130`.
- **`--registry` is not optional, and leaving it out was a real divergence (P1-4).** The HTTP
  path resolves `update.registry` through `resolveRegistryUrl(this.deps.config.registry, env)`
  (`update/service.ts:378`); `npm view` without the flag obeys whatever `.npmrc` says. §5.4's
  first draft promised `decideUpdate` "cannot tell the two sources apart", which is true of the
  *shape* they return and false of the *registry they describe* — and the population where the
  two differ is a mirror-configured corporate machine, which is the same population H3 exists
  for. The `registry` passed in is the already-resolved string `runCheck` computed, so the two
  probes answer about one registry by construction. Auth is unaffected: `--registry` selects a
  URL, and npm still applies whatever `.npmrc` credentials are scoped to it — we neither read
  nor forward any (D-13).
- **`execFile` here, `spawn` there, and that is not an inconsistency.** v1's IF-3 rejected
  `execFile` for the installer because it forwards neither `stdio` nor `detached`. This probe
  wants neither: it wants the buffered stdout `execFile` exists to provide, and it must not be
  detached. `timeout` is likewise safe here and forbidden there (C-20) — a killed `npm view`
  has written nothing.
- **`resolveNpmCli()` returning `null` → return `null`.** No `npm`-on-PATH fallback, for the
  reason `update/installer.ts:92-99` already gives: on Windows that is `npm.cmd`, which U-2
  forbids.
- **Parse**: `JSON.parse(stdout)`, take `{ name, version, engines, deprecated }` through the
  *same* normalisation `fetchLatestManifest` applies (`update/registry.ts:156-171`) so
  `decideUpdate` cannot tell the two sources apart. `npm view pkg@tag --json` on a tag yields
  one object; if an array comes back (a range, which we never send), take the last element.
  Any parse failure, any non-zero exit, any timeout → `null`.
- **Never throws.** Same contract as `fetchLatestManifest`, same reason.

Wiring in `runCheck` (`update/service.ts:386-401`):

```ts
let manifest = await fetchLatestManifest(registry, name, distTag, {...});
let via: 'http' | 'npm' = 'http';
if (!manifest) {
  manifest = await fetchLatestViaNpm(registry, name, distTag, {...});
  if (manifest) via = 'npm';
}
updateUpdateState({ lastCheckAt: this.now() });
if (!manifest) { this.recordFailure('network'); this.scheduleNext(); return this.snapshot(); }
this.probe = via;   // surfaced on the snapshot for `/update status` (section 6.3)
```

**No precondition, no sticky mode, and both were considered.** Gating the fallback on
"three consecutive network failures" would make a proxied machine wait out a 30 min → 60 min →
120 min backoff before its *first* successful check, and a sticky `probeMode` field would be a
fifth thing to keep correct across versions under C-17. The unconditional form costs one
`execFile` on a check that has *already failed*, which on a healthy machine is never. The
`via` value is logged on `update_check_result` (§5.6 / P2-3) so "this machine updates
through npm" is answerable from the log.

`lastCheckAt` is written **once, after both attempts**, exactly as today: it means "somebody
asked", and the throttle it feeds must not fire twice for one check.

### 5.5 End-to-end sequence — a release that does not start

```
day 0   0.6.0 published. aragon 0.5.9 running.
        check -> install -> ok. state: pendingRestart=0.6.0, autoInstalled=0.6.0,
                                        lastGood=0.5.9, bootFailures=0 (reset by the arming)
        row: "0.6.0 installed - restart aragon to apply"

day 0   user restarts. launcher -> guard: autoInstalled(0.6.0) === version(0.6.0) -> ARMED
        bootFailures(0) < 2 -> install the exit hook, write NOTHING, boot on.
        import('./cli.js') THROWS (undeclared dep). launcher prints the stack,
        exitCode 1. exit hook: code !== 0 -> bootFailures 0 -> 1.

day 0   user tries again. guard: bootFailures 1 < 2 -> boot on. crash. hook: 1 -> 2.

day 0   user tries a third time. guard: bootFailures(2) >= 2, lastGood=0.5.9 -> ROLLBACK
          stderr -> "aragon 0.6.0 failed to start twice; rolling back to 0.5.9." (synchronous)
          latch  { skippedVersion:0.6.0, pendingRestart:'', bootFailures:0,
                   autoInstalled:'', rolledBackFrom:0.6.0 }
          lock   -> spawn `node npm-cli.js install --global @aragon-agent/cli@0.5.9` (detached)
        boot continues, crashes a third time. The child finishes anyway.
        (The guard is now DISARMED, so this third crash increments nothing.)

day 0   user tries again. 0.5.9 is installed. It boots.
        start() consumes rolledBackFrom -> snapshot { rolledBackFrom:0.6.0, rolledBackTo:0.5.9 }
        and clears the field. Row: "rolled back to 0.5.9 after 0.6.0 failed to start".
        Its updater checks: remote 0.6.0, skippedVersion 0.6.0 -> decision `none`/`skipped`.
        NOTHING REINSTALLS. This is the latch doing its only job.

day 0   user restarts once more. rolledBackFrom is '' -> no row. One session, as promised.

day 3   0.6.1 published. 0.6.1 > skippedVersion -> the latch no longer applies ->
        installs normally, and the arming resets bootFailures to 0 for the new cycle.
        The user was never opted out; only out of the loop.
```

The `skipped` comparison is `decideUpdate`'s existing one
(`update/semver.ts`, `skippedVersion` input) — a *newer* version clears the latch by being
newer, which is exactly the behaviour v1 built for the `install-ineffective` case
(`update/service.ts:534-552`) and is reused here rather than re-derived.

### 5.6 Logging

New records, all under the existing `'update'` scope so `LogScope` (C-21) is untouched:

| Record | Level | Emitted by | Fields |
|---|---|---|---|
| `update_rolled_back` | warn | `boot/rollback.ts` | `from`, `to`, `failures` |
| `update_rollback_failed` | warn | `boot/rollback.ts` | `from`, `to`, `reason` |
| `update_rollback_notice` | warn | `update/service.ts` (§5.2a) | `from`, `to` |
| `update_install_blocked` | warn | `update/service.ts` | `version`, `code`, `stderrTail` (redacted by `Logger.emit`) |
| `update_check_via_npm` | info | `update/npm-view.ts` | `packageName`, `distTag`, `ok` |

`update_check_result` gains `via: 'http' | 'npm'`. **`update_check_start` does not (P2-3)** — the
value is not known until the fetch has failed, so on that record it would be the constant
`'http'`, which is worse than absent.

**The guard emits nothing, and the `Emitted by` column above is the reason (P1-6).** The first
draft listed `update_boot_armed` and `update_boot_healthy` under this scope, which §4 rule 2
makes impossible: `getLogger()` lives in `logging/logger.ts` and resolves config on the way to a
sink, so importing it into `guard.ts` would drag the config graph into the module that has to
survive a broken build. The tempting fix — "just import the logger in the guard" — is the one
change that would undo P1-2. So the guard is silent by construction, and the two facts worth
having after the event are recorded by modules that already have a logger: `rollback.ts` (which
dynamic-imports everything anyway) and the service (`update_rollback_notice`, which fires on the
first session after a rollback and is the record that makes "when did this machine get
downgraded, and from what" answerable).

---

## 6. Interface design

### 6.1 Config

**No new keys.** D-16 stands (§1.3 non-goal 3). `update.mode: 'off'` disables the updater,
which means nothing ever sets `autoInstalledVersion`, which means the guard's arming condition
is never true — the kill switch already covers the new surface.

### 6.2 `aragon update`

One new flag on the existing subcommand (`cli.tsx:980-1022`):

```
aragon update --rollback        Reinstall the version that was running before the last
                                auto-update, and latch the current one so it is not
                                reinstalled. Exit 0 on success, 4 when there is nothing
                                to roll back to.
```

It is the manual form of §5.1.3 and shares `performRollback` verbatim. It exists because a
release can be *bad without failing to start* — the case §1.3 non-goal 2 declines to detect
automatically is exactly the case a human can detect in one second.

**Exit `4` extends a documented contract, so the contract's own comment moves with it (P2-8).**
`cli.tsx:936-942` states `0` / `1` / `2` and what each means to a script; a fourth code added
without amending it is a contract change made in a place nobody reading the contract will see.

`updateExitCode` (`cli.tsx:943-948`) gains mappings for the new reasons — **and the order of the
tests has to change, or the mapping is dead code (P1-1)**:

```ts
function updateExitCode(snapshot: UpdateSnapshot): number {
  // REASON BEFORE PHASE. The three classified failures all arrive with
  // `phase: 'failed'` (they come from `recordFailure`), so leaving the phase
  // test first - as it is today - means this line can never be reached and the
  // change is a silent no-op.
  if (snapshot.reason === 'blocked-by-os' || snapshot.reason === 'no-space') return 2;
  if (snapshot.reason === 'source-ineligible' || snapshot.reason === 'not-writable') return 2;
  if (snapshot.phase === 'failed') return 1;
  if (snapshot.reason === 'install-ineffective') return 1;
  return 0;
}
```

**This is a behaviour change for scripts and is called one.** A `blocked-by-os` install used to
exit `1` ("try again later") and now exits `2` ("this machine will never auto-update, run the
command we printed"). That is the honest answer — on Windows the same `npm i -g` from the same
shell will fail the same way until the user closes something — but a caller with
`aragon update || sleep 300 && retry` changes behaviour, so it belongs in the CHANGELOG under
the version that ships it, not only here. `not-writable` already mapped to `2` and is unmoved;
it appears in the new list only because it now reaches this function from a second path.

### 6.3 `/update`

`/update status` (`commands/builtins.ts`) prints three additional lines when they are
non-empty, from the snapshot fields added in §7.3:

```
  rollback  0.6.0 -> 0.5.9
  lastgood  0.5.9
  probe     npm (proxy fallback)
```

**The key is `rollback`, not `rolledback`, and this block is the corrected one** — see
IF-8. The first draft's sample padded these three to eleven columns while the six they
claim to match pad to ten, and `rolledback` is itself ten characters, so it cannot take a
separating space without pushing its value past every other row in the block.

Two-space indent and a padded key, matching the six lines `formatUpdateStatus` already emits
(`commands/builtins.ts:67-81`), and ASCII with no glyphs for the reason its header gives: this
string goes into a transcript `notice`, not into the bottom row. The rollback line carries no
failure count — `bootFailures` is zeroed by the rollback itself (§5.1.3 step 1), so any number
printed here would be `0`; the count that mattered is in `update_rolled_back`.

No new subcommand. `/update rollback` was considered and declined: it would need the same
"then restart" dance as an install, and the surface already has `aragon update --rollback` for
the case where the user is looking at a broken CLI from a shell.

---

## 7. Data model

### 7.1 `<home>/update-state.json` — four new fields, **no schema bump**

`UPDATE_STATE_SCHEMA` stays `1`. Bumping it would make `readUpdateState` fall back to the
whole default object on the first read after upgrade (`update/state.ts:74`), discarding
`skippedVersion` — and `skippedVersion` is the field that stops an `install-ineffective` loop
(v1 R-12) and, from this round on, a bad-release loop. **A schema bump to add optional fields
would un-latch every latched version on every machine at once.** Per-field tolerance already
handles absence: a missing field reads as its default.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `autoInstalledVersion` | `string` | `''` | The version **this updater** installed and has not yet seen boot healthy. `''` = the guard is disarmed. |
| `lastGoodVersion` | `string` | `''` | The version that was running when the last auto-install ran, or the last version seen to boot healthy. The rollback target. |
| `bootFailures` | `number` | `0` | Launches of `autoInstalledVersion` that **exited non-zero**. Reset by `markBootHealthy`, by a rollback, and by each new arming (§5.2). |
| `rolledBackFrom` | `string` | `''` | The version the last rollback moved away from. Written by `performRollback` (§5.1.3 step 1) and consumed exactly once by `UpdateService.start()` (§5.2a). `''` = nothing to report. |

**`bootFailures`, not `bootAttempts` (P1-5), and the name is the specification.** A counter
named for attempts invites an increment at boot, and an increment at boot has no per-process
identity: concurrent launches of a healthy version reach the threshold between the first one's
increment and its `markBootHealthy`. A counter named for failures can only be incremented where
a failure is observable, which is the exit hook. Renaming it is the cheapest available guard
against the bug coming back.

C-17 consequences, stated once here and once in the source header: a CLI that predates these
fields reading and writing this file **erases all four**. Per §1.2 that is not the ordinary
rollback path — the target always has them — but it is reachable through a hand-installed old
version, and it is why the rollback also writes `skippedVersion` (§1.2, §5.1.3).

### 7.2 `UPDATE_LIMITS` — two structural additions

```ts
/** Non-zero exits of a version WE installed before it is rolled back. Tested
 *  against the count of PREVIOUS launches, so `2` means "the third rolls back". */
crashesBeforeRollback: 2,
/** Bound on the `npm view` fallback probe. Safe here, forbidden for the
 *  installer (C-20): a killed `npm view` has written nothing. */
npmViewTimeoutMs: 10_000,
```

These are **structural**, not policy, and belong here rather than in `config/schema.ts` for the
reason `update/limits.ts:11-23` already states.

**Two constants from the first draft are deleted, not moved:**

- **`rollbackTailChars: 500` (P2-1)** duplicated the existing `stderrTailChars: 500`
  (`update/limits.ts:70-77`), and the rollback reuses `runNpmInstall`, which already bounds its
  tail with that one. Two numbers for one thing is exactly what `limits.ts`'s own header spends
  a paragraph warning against, and the failure mode of the duplicate is that someone raises one
  of them.
- **`bootGuardMaxAgeMs: 604_800_000` (P1-3)** was defined here, cited by R-15 as a mitigation,
  and read by nothing — nor could it be, because none of the four state fields is a timestamp
  and §5.1.2 has nowhere to compare it against. It is deleted rather than implemented because
  the scenario it names cannot arise: the guard is armed only while `autoInstalledVersion`
  equals the *running* version, so "a machine offline for a year" is a machine still running
  the version we installed, and if that version now fails to start, rolling back to
  `lastGoodVersion` is exactly as correct on day 400 as on day 1. A risk-table entry backed by
  a constant nobody reads is worse than an acknowledged gap, because it reads as covered.

### 7.3 Runtime shapes

```ts
export type UpdateReason =
  | ...existing 11...
  | 'blocked-by-os'      // EPERM / EBUSY - something holds the file we must replace
  | 'no-space';          // ENOSPC

export interface UpdateSnapshot {
  ...
  /**
   * Set for the WHOLE session after a rollback, and deliberately not a
   * `reason` (section 5.2a): `reason` is rewritten by `setPhase` on every
   * transition, so the first scheduled check three seconds in would erase it
   * before anyone read it. Both, or neither.
   */
  rolledBackFrom?: string;
  rolledBackTo?: string;
  /** Which probe answered the last successful check. */
  probe?: 'http' | 'npm';
}
```

**Two new reasons, not three.** The first draft added `'rolled-back'` as an `UpdateReason`;
§5.2a explains why that shape cannot work and replaces it with the pair of snapshot fields
above. §9's "+3 `UpdateReason` members" is corrected to +2 accordingly.

`rolledBackFrom` / `rolledBackTo` follow the `requiredNode` / `runningNode` precedent
(`update/types.ts:75-86`): both or neither, because half the pair is a notice nobody can read.
Here it holds by construction rather than by discipline — `rolledBackTo` is the running version,
assigned in the same two lines that read `rolledBackFrom` out of the state file (§5.2a).

---

## 8. UI design

Four rows are added to `ui/UpdateLine.tsx`. Every glyph comes from `pickGlyphs(caps)` (C-3); no
literal `+`, `~` or `...` anywhere. Both tiers are specified because the compact tier is where a
careless implementation wraps into a second row and unbalances the frame (v1 R-13).

| Condition | Branch it goes in | Wide (≥ 60 cols) | Compact (< 60 cols) | Colour |
|---|---|---|---|---|
| `failed` / `blocked-by-os` | existing `failed` (`UpdateLine.tsx:82-88`) | `<warn> update blocked <dot> close other aragon windows, then: npm i -g <pkg>` | `<warn> update blocked` | `theme.noticeWarn` |
| `failed` / `no-space` | existing `failed` | `<warn> update failed <dot> no disk space` | `<warn> no disk space` | `theme.noticeWarn` |
| `failed` / `not-writable` | existing `failed` | `<warn> update needs write access <dot> npm i -g <pkg>` | `<warn> update blocked` | `theme.noticeWarn` |
| `rolledBackFrom` set, phase `idle`/`checking` | **the fallthrough that returns `null` today** (`UpdateLine.tsx:120-124`) | `<warn> rolled back to <version> after <bad> failed to start` | `<warn> rolled back` | `theme.noticeWarn` |

**The fourth row's placement is the P0 this section shipped with.** The first draft put the rows
in "the `failed` and `available` branches" and then keyed the fourth on phase `idle` — a phase
neither branch handles, which `shouldRenderUpdateLine` answers `false` for
(`update/types.ts:164-165`), and which `UpdateLine` handles only by returning `null` under a
comment that says "The CALLER never mounts us here". Three independent suppressions, so the one
line telling a user their CLI had been silently downgraded could never appear — while AC-46
stayed green, because it renders the component from a hand-built snapshot rather than from
anything the service produces. That is the same shape as both defects iteration 1's review
caught. §5.2a supplies the missing half: presence comes from `snapshot.rolledBackFrom` in
`shouldRenderUpdateLine`, and the row is rendered from the fallthrough — which is reached for
exactly `idle`/`checking`, so no existing branch changes.

The `rolled-back` row is shown for **one session only**, because `UpdateService.start()` clears
`rolledBackFrom` from the state file the first time it reads it (§5.2a) while keeping it on the
in-memory snapshot for the rest of the session. A permanent one would be the notification
fatigue D-7 exists to prevent; showing it zero times would leave the user with a silently
downgraded CLI, which is worse than a wrong version — it is a wrong version they do not know
about. A launch that constructs no service (`update.mode: 'off'`, non-TTY, CI —
`cli.tsx:470-474`) does not consume the notice, so it survives to a session that could actually
have shown it.

**Precedence, since the row budget is one (C-15).** Any real news — `available`, `installing`,
`ready`, or a `failed` past its threshold — owns the row; the rollback notice is the last test
in `shouldRenderUpdateLine` and is rendered only when the phase is otherwise silent. It is
therefore possible for the notice never to appear on a machine that has an update waiting on the
very next launch. That is the correct trade: the newer fact is the more actionable one, and the
rollback is still in `/update status` and in the log.

`UpdateLine` still returns `React.ReactElement` and never `null` (C-15 / v1 P0-1). The presence
decision stays at the call site in `shouldRenderUpdateLine`.

---

## 9. File / module change plan

### New files

| Path | Intent |
|---|---|
| `packages/cli/src/launcher.ts` | The new bin entry: run the boot guard, then `await import('./cli.js')` inside a catch. ~30 lines, imports two modules. |
| `packages/cli/src/boot/guard.ts` | `runBootGuard()` / `markBootHealthy()` — arm, count, disarm, decide rollback. Imports only `node:*`, `config/app-paths.js`, `update/state.js`. |
| `packages/cli/src/boot/rollback.ts` | `performRollback(bad, good)` — latch first, re-classify, take the lock, reuse `runNpmInstall`, print one stderr line. All dynamic imports, all inside one try. |
| `packages/cli/src/update/npm-view.ts` | `fetchLatestViaNpm()` — the proxy-aware fallback probe. Never throws. Carries `--registry` (P1-4). |
| `packages/cli/src/update/classify-failure.ts` | `classifyInstallFailure(tail)` — pure, ordered regex table. |
| `packages/cli/src/__tests__/boot-guard.test.ts` | Arming condition, threshold-before-increment, disarm idempotence, fast-path writes nothing. |
| `packages/cli/src/__tests__/update-rollback.test.ts` | Latch-before-spawn ordering, the `skippedVersion` cross-version latch, lock contention, re-classification refusal. |
| `packages/cli/src/__tests__/update-classify-failure.test.ts` | Table order, `EPERM` before `EACCES`, unknown tail → `install-failed`. |
| `packages/cli/src/__tests__/update-npm-view.test.ts` | Parse, array form, timeout, non-zero exit, `resolveNpmCli() === null`, argv shape. |

### Modified files

| Path | Change |
|---|---|
| `packages/cli/package.json` | `bin.aragon`: `./dist/cli.js` → `./dist/launcher.js`. |
| `packages/cli/scripts/prepend-shebang.mjs` | One hardcoded target → a list of two; keep the "missing target fails the build" behaviour per target (C-18). |
| `packages/cli/src/update/state.ts` | Four fields with per-field tolerance; **no** schema bump; header records C-17. |
| `packages/cli/src/update/service.ts` | `performInstall` writes `autoInstalledVersion` + `lastGoodVersion` + **`bootFailures: 0`** (P0-2) and takes `{ arm }`; `start()` gains `consumeRollbackNotice()` (§5.2a); generic failure goes through `classifyInstallFailure`; `runCheck` gains the npm fallback and `probe`. |
| `packages/cli/src/update/types.ts` | +2 `UpdateReason` members, +3 snapshot fields, `IMMEDIATE_NOTICE_REASONS`, `shouldRenderUpdateLine` reads it **and the rollback clause** (§5.2a). |
| `packages/cli/src/update/limits.ts` | +2 structural numbers (§7.2). |
| `packages/cli/src/ui/UpdateLine.tsx` | +4 rows, both width tiers (§8): three in the existing `failed` branch, one in the `null` fallthrough. Still `import type` only. |
| `packages/cli/src/cli.tsx` | `markBootHealthy(VERSION)` after `render()`; `--rollback` on `aragon update`; `updateExitCode` **reordered** (P1-1) and its exit-code comment extended for `4` (P2-8). |
| `packages/cli/src/commands/builtins.ts` | `/update status` prints the three new lines when non-empty. |
| `packages/cli/src/__tests__/glyphs.test.ts` | `inScope` alternation gains `boot`, and `rel === 'launcher.ts'` joins `rel === 'cli.tsx'` (C-19). |
| `packages/cli/src/__tests__/update-line.test.tsx` | The four new rows, both tiers, one row each. |
| `packages/cli/src/__tests__/update-service.test.ts` | Arming on auto-install (**including the `bootFailures` reset**), not on `installNow`; the rollback-notice consumption; classified failures; the npm fallback path. |
| `packages/cli/src/__tests__/update-state.test.ts` | R-21's assertion: a file written by the previous shape still reads its `skippedVersion` back (P2-10). |
| `packages/cli/src/__tests__/update-wiring.test.ts` | AC-53: the launcher's transitive static graph against an allow-list (P2-7). |
| `packages/cli/README.md` | Rollback behaviour, `aragon update --rollback`, and the honest note that `mode: 'off'` disables the guard too. |
| `packages/cli/CHANGELOG.md` | New version entry. Historical sections are not rewritten. |
| `docs/plans/cli-auto-update/manual-test.md` | Rows 12–16 (§10.3). |

### Explicitly unmodified

`update/installer.ts` (it already returns `stderrTail` + `exitCode`; classification is the
caller's job), `update/registry.ts`, `update/semver.ts`, `update/install-source.ts`,
`update/install-lock.ts`, `config/schema.ts` (§6.1), `config/store.ts`, `logging/logger.ts`
(§5.6), `ui/BottomStatusRow.tsx`, `ui/App.tsx`.

---

## 10. Testing & acceptance criteria

### 10.1 Unit tests — offline, deterministic, injected `now` / `spawn` / `execFile` / `fetch`

Every new module takes its clock, its spawner and its state path by injection, as the whole
`update/` tree already does (`UpdateServiceDeps`, `InstallDeps`, `InstallLockOptions`). **No
test spawns npm and no test writes to the real `<home>`.**

### 10.2 Acceptance criteria (continuing v1's AC-1 … AC-31)

| # | Criterion |
|---|---|
| AC-32 | With `autoInstalledVersion` empty (the steady state), `runBootGuard()` performs **zero writes** — asserted by a state adapter that throws on write. |
| AC-33 | `runBootGuard()` with `autoInstalledVersion === version` and `bootFailures: 0` performs **zero writes** as well (the counter moves in the exit hook, not at boot — P1-5) and does not roll back. |
| AC-34 | With `bootFailures: 2` and a `lastGoodVersion`, the guard calls the rollback **once** and still returns normally (the boot is not aborted). |
| AC-35 | With `bootFailures: 2` and **no** `lastGoodVersion`, the guard does not roll back and does not throw. |
| AC-36 | `performRollback` writes `skippedVersion: <bad>` **before** the spawn — asserted by a spawn stub that reads the state file and finds the latch already there. This is the C-17 invariant; a test that only checks the final state passes on the broken ordering. |
| AC-37 | After a rollback, a service running the **older** version with the resulting state decides `none` for the bad version — proving the latch survives a version that knows nothing about the other four fields. |
| AC-38 | `performRollback` returns without spawning when `tryAcquireInstallLock` returns `null`. |
| AC-39 | `performRollback` returns without spawning when the source re-classifies to anything but `npm-global`. |
| AC-40 | `markBootHealthy(v)` clears `autoInstalledVersion`, zeroes `bootFailures`, sets `lastGoodVersion: v`, **leaves `rolledBackFrom` untouched** (P0-1e), and is a no-op on the second call. |
| AC-41 | The exit hook disarms on `code === 0` and **increments `bootFailures`** on `code === 1`. |
| AC-42 | A successful automatic install writes `autoInstalledVersion`, `lastGoodVersion` **and `bootFailures: 0`**; `installNow()` (the `--to` path) writes **none of the three**. |
| AC-42b | **P0-2's regression, asserted directly**: starting from `{ bootFailures: 2, autoInstalledVersion: '<old>' }` — the state a user's manual downgrade leaves behind — an automatic install of a new version, followed by one `runBootGuard()` at that version, does **not** roll back. Verified to **fail** with the `bootFailures: 0` reset removed. |
| AC-43 | `classifyInstallFailure` returns `blocked-by-os` for a tail containing both `EPERM` and `EACCES` (order dependence, §5.3). |
| AC-44 | `classifyInstallFailure(undefined)` and an unrecognised tail both return `install-failed`. |
| AC-45 | `shouldRenderUpdateLine` is `true` at `consecutiveFailures: 1` for each of the three immediate reasons, and `false` at `1` for `network` and `install-failed`. |
| AC-46 | `UpdateLine` renders **exactly one row** for each of the four new rows in both width tiers, and contains no non-ASCII byte and no literal `+`, `~` or `...`. |
| AC-46b | **P0-1's regression, asserted where the first draft's version could not see it**: `shouldRenderUpdateLine({ phase: 'idle', rolledBackFrom: '0.6.0', ... })` is `true`, and is `false` once `rolledBackFrom` is `''`. AC-46 alone passes on a design where the row never reaches the screen, because it feeds `UpdateLine` a snapshot by hand; this one asserts on the predicate that actually decides presence. |
| AC-46c | Real news wins the row: with `rolledBackFrom` set **and** `phase: 'available'`, the rendered row is the availability row, not the rollback row (§8 precedence). |
| AC-47 | `fetchLatestViaNpm` builds argv `[npmCliJs, 'view', '<pkg>@<tag>', '--json', '--loglevel=error', '--registry=<resolved>']`, with `shell: false`, and the `<resolved>` value is the **same string** `runCheck` passed to `fetchLatestManifest` (P1-4). |
| AC-48 | `fetchLatestViaNpm` returns `null` on non-zero exit, on unparseable stdout, on timeout, and when `resolveNpmCli()` is `null`; it never rejects. |
| AC-49 | `runCheck` calls the npm fallback **only** when the HTTP fetch returned `null`, and records one `network` failure only when both fail. |
| AC-50 | `dist/launcher.js` exists after `npm run build`, starts with `#!/usr/bin/env node`, and `dist/cli.js` **still** starts with it too (C-18 — `npm start` and `node dist/cli.js` must keep working). |
| AC-51 | `src/launcher.ts` contains **no static import** other than `node:process`, asserted on the source text; the guard and the CLI are both reached through dynamic `import()` (P1-2). The module cannot be imported in vitest — it ends in an import of `cli.js`, which would run the CLI; the AC-4/AC-5 precedent. |
| AC-52 | `glyphs.test.ts`'s `inScope` matches `boot/guard.ts` and `launcher.ts` — asserted directly against the predicate, not implied by the suite passing (C-19; a scanner that silently stops scanning is worse than no scanner). |
| AC-53 | The **transitive** static graph reachable from `launcher.ts` is a subset of `{node:*, boot/**, config/app-paths.ts, update/state.ts}` — walked, not substring-matched (P2-7). v1's `update-wiring.test.ts:45-54` filters specifiers for the literal `update/`, which a `./boot/guard.js` import passes while quietly widening the graph AC-1 exists to bound. |
| AC-54 | `UpdateService.start()` clears `rolledBackFrom` from the state file and keeps it on the snapshot; a second service constructed afterwards reports **no** rollback (D-38's "one session", asserted on the mechanism rather than on the row). |

### 10.3 Manual test rows (appended to `docs/plans/cli-auto-update/manual-test.md`)

Rows 1, 2, 4 and 11 of the existing file are **still outstanding** (v1 approval condition 3)
and are a precondition for this round's DoD, not a duplicate of it.

| # | What | How | Expected |
|---|---|---|---|
| **12** | **A release that cannot start is rolled back.** Cannot be skipped. | Publish a deliberately broken build to a scratch registry (`npm publish --registry`) or hand-corrupt `<global>/node_modules/@aragon-agent/cli/dist/cli.js` after an auto-update. Launch three times. | Launches 1 and 2 print a stack and exit 1. Launch 3 prints `aragon <bad> failed to start twice; rolling back to <good>.`, and a few seconds later `npm ls -g` shows the old version. Launch 4 starts, and `/update status` shows `rolled back`. **Launch 5 shows nothing** — the notice is one session. |
| **13** | **Windows: does `npm i -g` succeed while `aragon` is running?** Cannot be skipped. | On Windows, from `cmd.exe` and again from PowerShell, run row 1's setup and watch `update_install_*`. | Record the answer in this file. If `update_install_blocked` appears, the bottom row must read `update blocked · close other aragon windows, ...` — **not** the generic `update failed`. This row is the empirical input §5.3.1 depends on. |
| **14** | **The latch survives the downgrade.** Cannot be skipped. | After row 12, inspect `<home>/update-state.json`, then let the rolled-back CLI run one full check (`/update now`). | `skippedVersion` equals the bad version. The check decides `none`/`skipped` and **does not reinstall**. The other four fields are **present**, because the rollback target is itself an H1 build (§1.2 / P2-6) — if they are missing, something wrote this file that should not have, and that is a finding, not the expected result. |
| **15** | **A newer release clears the latch.** | Publish `<bad>+1` to the scratch registry and check again. | It installs normally. The user was never opted out. |
| **16** | **Proxy fallback.** | On a machine where the registry is reachable only through a proxy (`npm config set proxy ...`, no `HTTP_PROXY` honoured by undici), run `aragon` and watch the log. | `update_check_via_npm { ok: true }`, and the check completes. `/update status` shows `probe: npm`. Without H3 this machine logs a network failure forever. |

---

## 11. Risks & mitigations

| # | Risk | Mitigation |
|---|---|---|
| R-15 | **The guard rolls back a version that was fine**, because two launches ended before `markBootHealthy` for unrelated reasons (machine sleep, OOM, a hard `taskkill`, or several terminals starting at once). | **Structural after P1-5, not merely narrow.** The counter moves only in the exit hook and only on a non-zero code, so a launch that was killed — which produces no exit code at all — cannot contribute, and neither can a healthy concurrent launch that exits `0`. What remains is a release that genuinely exits non-zero twice, which is the signal the guard is for. Residual blast radius, if it still fires wrongly: one reinstall of a version the user ran an hour ago, latched rather than deleted, so `aragon update --to <newer>` reinstates it in one command. (The first draft mitigated this with `bootGuardMaxAgeMs`, a constant nothing read — see §7.2 / P1-3.) |
| R-16 | **The rollback target is itself broken** (the user's previous version was already bad). | `lastGoodVersion` is the version that was *executing* when it installed the new one, which is the strongest available evidence. If it still fails, the guard does not re-arm — `autoInstalledVersion` was cleared by the rollback — so the machine settles rather than oscillating. Manual `npm i -g` remains. |
| R-17 | **The new bin entry breaks a user's launcher.** Someone invokes `dist/cli.js` directly, or a wrapper script hardcodes it. | `dist/cli.js` is unchanged and keeps its shebang and its `chmod +x` (AC-50). Only the `bin` mapping moves. `npm start` is unchanged. |
| R-18 | **The launcher adds startup latency** to every invocation, including `aragon --version`. | One `readFileSync` of ~300 bytes plus a string compare on the fast path, with no write (AC-32). The dynamic `import('./cli.js')` is the same module graph Node would have loaded anyway. |
| R-19 | **`npm view` leaks into the happy path** and spawns a process on every check. | It runs only after the HTTP fetch returned `null` (AC-49). On a healthy machine that is never. |
| R-20 | **The immediate-notice set becomes the beginning of notification fatigue**, the exact failure D-7 and R-8 exist to prevent. | Membership is governed by a stated rule — actionable *and* not self-healing — and is three reasons, all of which repeat identically until the user acts. `network` and `install-failed`, the two that would actually recur, are excluded. AC-45 pins both directions. |
| R-21 | **A schema bump is added later** by someone adding a fifth state field, silently un-latching every machine at once. | §7.1 states it and the source header repeats it. `update-state` tests assert that a file written by the previous shape still reads its `skippedVersion` back (§9 lists the file — P2-10). |
| R-22 | **The guard's own module graph fails to load**, in the one case H1 exists for: a release whose `node_modules` is incomplete. `guard -> update/state -> config/app-paths -> env-paths` is not `node:*`-only (P1-2). | The launcher imports the guard **dynamically inside a `try`** (§5.1.1), so the failure degrades to "no guard, CLI reports its own crash" instead of an `ERR_MODULE_NOT_FOUND` from the bin entry. AC-51 and AC-53 pin the import shape and the transitive graph so the chain cannot silently grow. The uncovered case is stated in §5.1.5 rather than argued away; closing it fully would need a second copy of the home-root arithmetic, which `config/app-paths.ts`'s header rules out for a stronger reason. |
| R-23 | **The exit-code reorder breaks a caller's retry loop.** `blocked-by-os` moves from `1` to `2` (P1-1 / §6.2). | Stated as a behaviour change in §6.2 and required in the CHANGELOG entry by DoD item 9. The new code is the accurate one — a blocked install does not become unblocked by waiting — and exit `2` is the code v1 already defined for "this machine will never auto-update". |

---

## 12. Decisions (continuing v1's D-1 … D-25)

| # | Decision | Because |
|---|---|---|
| D-26 | The boot guard lives in a **new bin entry**, not in `cli.tsx::main()`. | An import-time crash never reaches `main()`, and that is the most common way an npm CLI release bricks itself. |
| D-27 | Four new state fields, **no schema bump**. | A bump discards the whole object on first read (`update/state.ts:74`), which un-latches every `skippedVersion` on every machine — the exact loop v1's R-12 and this round's R-9 work exists to close. |
| D-28 | The rollback writes **`skippedVersion`** as well as the new fields. | C-17: the CLI it is rolling back to erases fields it does not know. `skippedVersion` is the only channel that reaches it. |
| D-29 | The guard is armed **only for versions this updater installed**. | An updater that reverts a user's own deliberate install is a worse actor than one that does nothing, and the gate is also what keeps the fast path write-free. |
| D-30 | The threshold counts **previous non-zero exits**, so `2` means the third launch rolls back. | One crash can be transient. Two is a pattern. |
| D-30a | The counter is incremented in the **exit hook on a non-zero code**, not at boot (P1-5). | An increment at boot has no per-process identity, so concurrent launches of a healthy release walk it to the threshold; and it counts kills, which are not evidence about the release. The cost — a release that dies without running exit handlers is never counted — is the right side of the trade for a pure-JS CLI whose target failure is a module that will not import, which exits `1` through the launcher's `.catch`. |
| D-30b | Arming resets the counter (P0-2). | Arming and counting have different lifetimes; a counter stranded by a manual downgrade otherwise rolls back the *next* auto-installed release on its first launch and latches it as skipped. |
| D-31 | A rollback **does not abort the boot**. | If the crash was transient, refusing to start locks the user out on our guess. The detached child completes either way. |
| D-32 | `installNow()` (`--to`) does **not** arm the guard. | A user who asked for a specific version has made a decision; silently reversing it is not ours to make. |
| D-33 | Three reasons may bypass the three-strike silence: actionable **and** not self-healing. | Anything else is the notification fatigue the rest of this feature is built to avoid. |
| D-34 | The proxy fallback delegates to `npm view` rather than implementing proxy support. | No new dependency, no `.npmrc` parsing, and D-13's "no credentials, ever" holds trivially because we never see them. |
| D-35 | The fallback is **unconditional on a failed fetch** — no failure precondition, no sticky mode. | A precondition makes a proxied machine wait out hours of backoff for its first success; a sticky field is a fifth thing to keep correct under C-17. |
| D-36 | `execFile` for the probe, `spawn` for the installer. | Opposite requirements: the probe wants buffered stdout and a timeout; the installer needs `detached` + a real fd and must never be signalled (v1 IF-3, C-20). |
| D-37 | **Zero new config keys.** | D-16 stands. `mode: 'off'` already disables the arming condition, so the kill switch covers the new surface. |
| D-38 | The `rolled-back` row shows for **one session**. | Permanent is fatigue; never is a silently downgraded CLI the user does not know about. |
| D-39 | The rollback notice is a pair of **snapshot fields**, not an `UpdateReason`, and its presence is decided outside `phase` (§5.2a / P0-1). | `reason` is rewritten by `setPhase` on every transition, so the first scheduled check would erase it three seconds in. A fact that is true for a whole session needs a carrier the state machine does not own. |
| D-40 | The notice is consumed on **read by the service**, not cleared by `markBootHealthy`. | After a rollback `autoInstalledVersion` is `''`, so `markBootHealthy` returns before touching anything — it could never have cleared it. Consuming on read also means a launch that constructs no service (`mode: 'off'`, non-TTY, CI) does not burn the notice. |
| D-41 | The npm fallback passes **`--registry`** (P1-4). | Otherwise the fallback answers about npm's default registry while the check it replaces used `update.registry`, and the machines where those differ are the same mirror-and-proxy population H3 exists for. |
| D-42 | The guard **emits no log records** (P1-6). | `getLogger()` drags the config graph into the one module that must survive a broken build. The two facts worth keeping are recorded by `rollback.ts` and the service, both of which already have a logger. |

---

## 13. Definition of done

1. `manual-test.md` rows **1, 2, 4 and 11** are run and their results recorded — the v1
   verification debt (H0). Row 1 is run on **both** Windows and Linux.
2. All nine new/modified source files land, plus the four new test files.
3. Every one of AC-32 … AC-54 has a named test, and **six** of them are verified to **fail**
   with their guard removed before the guard is restored — AC-36, AC-41, AC-45, AC-52, and the
   two the review added: **AC-42b** (P0-2's silent downgrade) and **AC-46b** (P0-1's unreachable
   row). Those six are the ones whose absence is silent, and the two new ones are silent in the
   worst way this package has already seen twice: a green test rendering a fixture the product
   never produces.
4. The four one-word wiring edits ship in the same commit as the code they serve: `boot` in
   `glyphs.test.ts`'s `inScope`, `launcher.ts` beside `cli.tsx` in the same predicate,
   `launcher.js` in `prepend-shebang.mjs`, and `bin.aragon` in `package.json`. Each is a single
   token whose omission is silent; this package has an unbroken record of paying for exactly
   this class of edit (v1 approval condition 1).
5. `npm run typecheck` (both tsconfigs) and `npm run build` are clean; `npm run test` is green.
6. `dist/launcher.js` and `dist/cli.js` both carry the shebang and are executable (AC-50).
7. `npm pack` is inspected: `dist/launcher.js` and `dist/boot/` are present in the tarball.
8. Manual rows **12, 13 and 14 cannot be skipped**. Row 13 is the one that decides how common
   the `blocked-by-os` path is, and its answer is written back into §5.3.1 of this document.
9. README states the rollback behaviour and that `update.mode: 'off'` disables it too. The
   CHANGELOG entry records the **exit-code change** (`blocked-by-os`: `1` → `2`, R-23) under
   the version that ships it, because it is the one change here a script can notice.
10. A `## 实施过程发现的方案缺陷` section is appended to this document recording every place
    the implementation had to correct the design, in the form v1 used — that section was the
    most useful thing round 1 produced for round 2.

---

## 14. Open question for a human

`crashesBeforeRollback: 2` and the decision to **continue booting** after spawning the rollback
(D-31) are the two knobs where a reasonable person could choose differently. `3` would be more
conservative at the cost of one more crash in front of the user; aborting the boot would be
more decisive at the cost of locking the user out when the crash was transient. Both are
recorded here rather than buried in a constant so the first release can revisit them with real
data from manual row 12 — the same treatment v1 gave `update.mode: 'auto'`.

**Review note.** After P1-5 the first knob is easier to reason about than it was: `2` now means
"two launches actually exited non-zero", not "two launches did not reach a healthy mount", so
raising it to `3` buys less than it did and costs the user one more crash. The recommendation
is to keep `2` and let row 12 confirm it. The second knob is unchanged and the argument for
D-31 still holds.

---

## 15. 评审结论 (Review Verdict)

### 有条件通过 (Approved with conditions)

The shape is right. H1 is the correct answer to R-9 and the argument for putting it below
`cli.tsx` rather than inside `main()` is the strongest single idea in either round of this
feature: an import-time crash really is how npm CLIs brick themselves, and no amount of care
inside `main()` reaches it. H2 and H3 are both small, both bounded, and both fix a failure the
v1 document was honest about accepting. Zero config keys, zero schema bump, zero protocol
change, four new source files and one new bin entry is the right size for what it buys, and the
two non-goals that decline staged rollout and "roll back on subtle wrongness" are declined for
good reasons rather than for convenience.

What the review found is that the *reporting* half of H1 had not been connected to anything
(P0-1) and that the counter arming it had two ways to fire on a healthy release (P0-2, P1-5).
All three are now fixed in the body, and the two P0s each have an acceptance criterion that is
required to be seen failing first — because both are the shape this package has now been bitten
by three times: a test that renders a fixture the product cannot produce.

**No P0 or P1 remains open.** All ten P2s are fixed as well.

### Conditions

1. **The v1 verification debt is a gate, not a footnote.** `manual-test.md` rows 1, 2, 4 and 11
   are still unrun a full round after they were made an approval condition, and row 1 on Windows
   is what tells us whether §5.3.1's `blocked-by-os` path is the common case or an exotic one.
   Run them **before** writing H2, not after: if the Windows write turns out to succeed while
   `aragon` is running, the advice string in §8 is wrong and three of the four new UI rows are
   worth less than they look.
2. **Manual row 12 is the only real proof H1 works, and it must be run on Windows and Linux.**
   Every unit test in §10.1 stubs the spawner. Nothing in the suite can tell you that a detached
   `npm i -g` launched from a process that is about to die of an import error actually completes
   — that is a property of the OS, not of the code, and it is the whole feature. If row 12 cannot
   be made to pass on both platforms, H1 does not ship; H2 and H3 are independent of it and
   still can.
3. **AC-42b and AC-46b are verified to fail before they are made to pass**, and the verification
   is recorded in the implementation report the way iteration 1 recorded AC-19's. A green
   assertion that was never seen red is not evidence for either P0.
4. **The `## 实施过程发现的方案缺陷` section (DoD 10) is written as the work proceeds, not
   reconstructed afterwards.** Round 1's was the single most useful input to round 2 — three of
   this document's constraints (C-17, C-20, C-21) are lifts from it — and its value came from
   being written while the surprise was fresh.
5. **If P1-2's residual gap turns out to bite** — that is, if a real bad release is ever traced
   to a `node_modules` that lost `env-paths` — revisit the `node:*`-only guard. The trade was
   decided against a duplicated path constant, and that trade is worth re-taking with evidence
   rather than in the abstract.

### Not required, worth knowing

- H0 (the v1 debt) and H1 are the two items with real schedule risk, and they are the same risk:
  both need a machine where a global install can be broken and repaired. Doing them in one
  sitting, on one Windows box, is most of this round's manual cost.
- The `probe: 'npm'` line in `/update status` is the only place a user can learn their machine
  updates through the fallback. Worth watching in support reports: if it shows up often, R-5 was
  a bigger population than v1 assumed and H3 deserves its own row rather than a status line.

---

## 16. 实施过程发现的方案缺陷 (Issues Found During Implementation)

Written as the work proceeded, per verdict condition 4. Round 1's equivalent was
the single most useful input to round 2 — three of this document's constraints
(C-17, C-20, C-21) are lifts from it — and its value came from being written while
the surprise was fresh.

### IF-1 — §6.3 prints a `lastgood` line that §7.3 gives it no field for

**The contradiction.** §6.3 specifies three new `/update status` lines —
`rolledback`, `lastgood`, `probe` — and says they come "from the snapshot fields
added in §7.3". §7.3 adds exactly three fields: `rolledBackFrom`, `rolledBackTo`
and `probe`. The first line consumes two of them and the third consumes one, so
`lastgood` has **no source**. §9's change-plan row for `types.ts` says "+3 snapshot
fields" and §7.3 says "Two new reasons, not three" in the same breath, so the count
is deliberate rather than a slip — which means one of the two sections is wrong.

**Resolved in favour of §6.3, with a fourth field.** `UpdateSnapshot` gains
`lastGoodVersion?: string`, read from the state file in `consumeRollbackNotice()`
and refreshed by the arming write. The reasoning: §6.2 introduces
`aragon update --rollback` as a user-facing command, and without this line there is
**nowhere at all** a user can find out what that command would install before
running it. A rollback command whose target is unknowable is a worse defect than a
fourth optional field on a snapshot that already carries seven. It costs nothing at
runtime — `start()` already reads the state file for the two lines above it.

**What was not done.** `rolledBackTo` stays derived rather than stored, exactly as
§5.2a argues; this is one field, not two, and the "+3" in §7.3 / §9 should read "+4".

### IF-2 — AC-53 as written is vacuous, and vacuous in the way this package has a self-test for

**The criterion.** "The **transitive** static graph reachable from `launcher.ts` is
a subset of `{node:*, boot/**, config/app-paths.ts, update/state.ts}` — walked, not
substring-matched."

**Why it cannot be implemented literally.** AC-51 — one AC above it — requires
`launcher.ts` to have **no static import other than `node:process`**. So the
transitive *static* graph reachable from `launcher.ts` is `{node:process}`, and any
subset assertion over it passes trivially, forever, no matter what the guard chain
grows into. The two ACs are individually right and jointly empty. This is precisely
the failure mode `glyphs.test.ts` keeps a self-test for: a guard that silently stops
guarding reads exactly like a guard that has nothing to complain about.

**Implemented as.** The walk starts at **`boot/guard.ts`** — the module the launcher
actually loads, and the one `cli.tsx` now imports statically, which is the widening
P2-7 was written about. `./cli.js` is out of scope by construction: it is the
application. The test additionally asserts the walk **reached all four modules** (so
a specifier that failed to resolve cannot silently shrink the graph to nothing) and
pins the third-party half to exactly `{env-paths}`, which is §5.1.5's stated residual
gap. That last assertion is the one this document did not ask for and is worth the
most: `env-paths` is the known hole in H1's coverage, and a second entry beside it
would be a second way the guard fails in the case it exists for.

### IF-3 — `performRollback: Promise<void>` cannot answer the question §6.2 asks it

**The mismatch.** §5.1.3 declares `performRollback(bad, good): Promise<void>`. §6.2
specifies `aragon update --rollback` as "Exit 0 on success, 4 when there is nothing
to roll back to" — but with a `void` return the command cannot distinguish "the
reinstall completed" from "the lock was held", "the source re-classified", or "npm
exited 1". Every one of those would exit `0` and print a success line, which is a lie
to a script on the path where the user is *already* stuck.

**Implemented as.** `Promise<RollbackResult>` — `{ ok, failure? }` with a six-member
`RollbackFailure` union. The guard ignores it (it is invoked without `await`, exactly
as specified), and the command maps it onto the **existing** contract rather than
inventing codes: `4` for nothing-to-roll-back-to as §6.2 says, `1` for a rollback
that ran and failed — because `1` already means "the check or the install failed"
and a failed rollback is a failed install. No new exit code beyond §6.2's `4`.

### IF-4 — three wiring edits the change plan does not list

§9's "Modified files" table is otherwise exact. Three edits are load-bearing and
absent from it; DoD item 4's own argument — "each is a single token whose omission
is silent" — applies to all three.

1. **`src/__tests__/package-metadata.test.ts`** asserts
   `expect(packageJson.bin).toEqual({ aragon: './dist/cli.js' })` at line 24. Moving
   `bin` without this makes the suite red immediately, so it is self-announcing
   rather than silent — but it is a *required* edit in the same commit, and the
   table is where someone checks whether they have finished.
2. **`glyphs.test.ts`'s `inScope` had to be extracted into a named exported
   function.** AC-52 requires asserting on the predicate "directly, not implied by
   the suite passing", and it was an inline expression inside `scan()`'s loop body,
   unreachable from a test. The extraction is behaviour-preserving.
3. **`update-wiring.test.ts`'s exhaustive module list** (the "nothing under
   `update/` imports React, Ink, `ui/` or `agent/`" test) enumerates the tree by
   hand, so `npm-view.ts` and `classify-failure.ts` are unchecked until they are
   added to it. Same class of edit as C-19's, one directory over.

### IF-5 — `crashesBeforeRollback` is duplicated in `guard.ts`, deliberately

§7.2 puts the constant in `UPDATE_LIMITS`. §4 rule 2 forbids `guard.ts` from
importing anything outside `node:*`, `config/app-paths.js` and `update/state.js`.
Both cannot hold, and the rule is the more important of the two: `update/limits.ts`
is pure and dependency-free *today*, but it is a shared table anyone may add an
import to, and the guard's import list is what bounds the damage a broken build can
do. The guard therefore carries `const CRASHES_BEFORE_ROLLBACK = 2` with a comment
saying why. It is a bare integer with no path and no name in it, so it is not the
duplication `config/app-paths.ts`'s header forbids.
`UPDATE_LIMITS.crashesBeforeRollback` is still added as §7.2 specifies and is the
value the rest of the subsystem reads.

### IF-6 — `markBootHealthy` needs an empty-version guard the spec's version does not have

§5.1.4's body is `if (state.autoInstalledVersion !== version) return;`. But
`readOwnVersion()` returns `''` when the manifest is unreadable, and `''` is *also*
the DISARMED sentinel for `autoInstalledVersion`. So `markBootHealthy('')` on a
machine whose `package.json` cannot be read matches the sentinel, falls through, and
writes `lastGoodVersion: ''` — turning the rollback target into the empty string on
exactly the machine that is already having trouble. One line
(`if (!version) return;`), one regression test.

### IF-7 — the harness's `readVersionAt` fixture makes the H3 tests look like product bugs

Not a spec defect; recorded because it cost time and will cost it again.
`update-service.test.ts`'s harness derives U-6's post-install re-read from the
`remote` option (`readVersionAt: () => opts.observedAfterInstall ?? target`). Every
H3 test sets `remote: null` — that *is* the failed HTTP probe — so the re-read
answers `null`, U-6 fires, and the install lands on `install-ineffective` rather than
`ready`. The fixture is behaving correctly and the product is fine; the test has to
pass `observedAfterInstall` explicitly, because the version the machine ends up on
came from the *fallback*, which the harness's `target` does not model.

### IF-8 — §6.3's sample block cannot satisfy §6.3's own prose

Found in review, fixed in `commands/builtins.ts`. §6.3 asks for "a padded key,
matching the six lines `formatUpdateStatus` already emits" and then shows a sample
whose keys are padded to **eleven** columns, while all six existing lines pad to
**ten**. Both cannot be true, and the sample is the one that is wrong: `rolledback`
is itself ten characters, so it cannot take a separating space without pushing its
value one column past every other row in the block. Implemented literally, the
readout gains three lines whose values do not line up with the six above them —
in a nine-row block whose only purpose is to be read at a glance, and whose keys
are padded for exactly that reason.

The key is therefore `rollback` (eight characters, padded to ten), and `lastgood`
and `probe` pad to ten with it. The prose is the requirement; the sample was
illustrative. The regression is asserted as a **set of value columns with one
member**, not against the constant `12`, so it stays true if the column is ever
deliberately widened for all nine.

### IF-9 — the manual `--rollback` inherits a notice that says the version crashed

Found in review, fixed in `cli.tsx::runRollbackCommand`. §6.2 gives
`aragon update --rollback` the automatic path's mechanism "verbatim", which is
right for the latch, the re-classification and the lock — and wrong for one thing
nobody costed: `performRollback` writes `rolledBackFrom` (§5.1.3 step 1), and that
field has exactly one rendering, `rolled back to <to> after <bad> failed to start`
(§8). On the manual path that sentence is **false**. The version started fine; the
user simply did not want it, which is the entire case §6.2 says the flag exists for
("a release can be bad *without* failing to start"). The next session's bottom row
would assert a crash that never happened.

`runRollbackCommand` clears the field after a **successful** rollback. D-38's
purpose is preserved exactly — the notice exists so a downgrade the user did *not*
ask for cannot be silent, and this one was typed and answered on stdout in the same
breath. Clearing it at the call site rather than teaching `performRollback` a mode
keeps §6.2's shared mechanism intact and adds no fifth state field under C-17;
`/update status` still shows `lastgood`, and `update_rolled_back` is in the log
either way. It is deliberately **not** cleared on the failure path, where the
guard's own notice may still be owed.

### Verified-to-fail record (DoD item 3 / verdict condition 3)

All six required guards were removed one at a time, the named test observed **red**,
and the guard restored. Each failed for its own reason, not by failing to compile:

| AC | Guard removed | Observed |
| --- | --- | --- |
| **AC-42b** | `bootFailures: 0` from `performInstall`'s arming write | red — the guard rolled back a healthy 0.7.0 on its first launch |
| **AC-46b** | `return Boolean(snapshot.rolledBackFrom)` → `return false` | red — presence `false` at phase `idle` with the field set |
| **AC-36** | the latch deferred until after the spawn | red — `expected '' to be '0.6.0'`; the installer read the state file and found no latch |
| **AC-41** | the exit hook's `code === 0` branch | red — a clean exit counted as a crash instead of disarming |
| **AC-45** | `'network'` added to `IMMEDIATE_NOTICE_REASONS` | red — a network failure spoke at one strike |
| **AC-52** | `boot` removed from `glyphs.test.ts`'s `inScope` | red — the predicate no longer covers `boot/**` |

The two review fixes above were held to the same standard:

| Fix | Guard removed | Observed |
| --- | --- | --- |
| **IF-8** | the keys returned to their eleven-column form | red — `expected [ 12, 13 ] to have a length of 1`, two value columns in one block |
| **IF-9** | the `updateUpdateState({ rolledBackFrom: '' })` line | red — the clearing call is absent from `runRollbackCommand`'s body |

IF-9's test slices the function out of `cli.tsx` by source text (the AC-4 / AC-5 /
AC-22 precedent — that module ends in `main()`, so importing it runs the CLI inside
vitest). **It normalises `\r\n` first, and that is load-bearing**: `cli.tsx` is CRLF
in the working tree, so `'\n}\n'` never matches, the slice silently becomes "the
rest of the file", and the assertion would then pass on a `rolledBackFrom: ''`
written anywhere else in it. The first draft of the test had exactly that bug and
was green; the delimiter is now asserted before it is used.

### Also verified, on the built artefact

- `npm run build` is clean; `dist/launcher.js` and `dist/cli.js` **both** begin
  `#!/usr/bin/env node` (AC-50), and `npm pack --dry-run` carries
  `dist/launcher.js`, `dist/boot/{guard,rollback}.js` and the two new `update/`
  modules (DoD 7).
- `node dist/launcher.js --version` prints the version and exits 0; the real guard
  then **disarmed** through the exit hook (`autoInstalledVersion: ''`,
  `bootFailures: 0`, `lastGoodVersion: '0.5.9'`), and a non-zero exit incremented
  `bootFailures` to 1 — the arm / count / disarm cycle end to end, through the real
  state file and the real `readOwnVersion()`.
- With `bootFailures: 2` and a `lastGoodVersion`, the launcher printed
  `aragon 0.5.9 failed to start twice; rolling back to 0.4.0.` **above** the CLI's own
  output (P2-9's ordering, observed rather than argued), booted anyway (D-31), wrote
  all five latch fields, and the re-classification step (§5.1.3 step 2) correctly
  **refused** to run `npm i -g` because the tree classifies as `dev-monorepo`.
- `aragon update --rollback` with no recorded `lastGoodVersion` exits **4**.
- Both tsconfigs are clean and the full suite is green: **137 files, 1992 tests**
  (1988 at implementation, plus the four the review added for IF-8 and IF-9), and
  `npm run verify:brand` reports 0 legacy-brand hits across 436 scanned files.

### Still outstanding

DoD items **1** and **8** — manual rows 1, 2, 4, 11 (the v1 verification debt, H0)
and rows 12, 13, 14 — are **not** done. They need a machine where a real global
install can be broken and repaired, on both Windows and Linux; nothing in the suite
substitutes for them, and verdict condition 2 is explicit that H1 does not ship
without row 12. The rows are written and are at the end of
`docs/plans/cli-auto-update/manual-test.md`. Row 13's answer must be written back
into §5.3.1 of this document when it is run.
